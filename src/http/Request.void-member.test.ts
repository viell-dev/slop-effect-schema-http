import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Option, Schema, SchemaGetter } from "effect";
import { bodyOf, schemaFailure, Tenant, urlOf } from "../../test/request.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

/** What path and JSON body preparation write, or `"refused"` for a `SchemaError`. */
const outcomes = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  input: unknown,
) =>
  Effect.forEach(["path", "body"] as const, (kind) => {
    let path: unknown;
    const prepared =
      kind === "path"
        ? Effect.map(
            Request.compile(
              Request.get("").pipe(
                Request.path(schema, (value) => {
                  path = value;
                  return "/p";
                }),
              ),
              { path: input as Request.Input<S> },
            ),
            () => JSON.stringify(path) ?? "undefined",
          )
        : bodyOf(post(schema), { body: input } as never);
    return Effect.catchIf(
      prepared,
      (error) => error instanceof Schema.SchemaError,
      () => Effect.succeed("refused"),
    );
  });

const post = <S extends Schema.Top>(schema: S) =>
  Request.post("/x").pipe(Request.body(Body.jsonSchema(schema)));

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

const VoidFirst = Schema.Union([Schema.Void, Filter]);
const VoidLast = Schema.Union([Filter, Schema.Void]);
const RenamedSort = Schema.Struct({
  filter: VoidFirst,
  sortBy: Schema.String,
}).pipe(Schema.encodeKeys({ sortBy: "sort_by" }));

const hiddenFilterCell = (page_size: string) =>
  Object.defineProperty([], 0, { value: { page_size } });

describe("request preparation beside Void", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses unencodable JSON metadata in both Void orders and at each placement",
    () =>
      Effect.gen(function* () {
        const Note = Schema.Struct({
          title: Schema.String,
          meta: Schema.Unknown,
        });
        // A later member that strips `meta` cannot take the value either.
        // https://github.com/viell-dev/slop-effect-schema-http/issues/250
        const Title = Schema.Struct({ title: Schema.String });
        for (const [schema, input, field] of [
          [Note, (note: unknown) => note, '["meta"]'],
          [
            Schema.Union([Note, Schema.Void]),
            (note: unknown) => note,
            '["meta"]',
          ],
          [
            Schema.Union([Note, Schema.Void, Title]),
            (note: unknown) => note,
            '["meta"]',
          ],
          [
            Schema.Union([Note, Title, Schema.Void]),
            (note: unknown) => note,
            '["meta"]',
          ],
          [
            Schema.Struct({ note: Schema.Union([Note, Schema.Void]) }),
            (note: unknown) => ({ note }),
            '["note"]["meta"]',
          ],
          [
            Schema.Union([Schema.Array(Note), Schema.Void]),
            (note: unknown) => [note],
            '[0]["meta"]',
          ],
        ] as const) {
          const request = post(schema);
          for (const meta of [
            new Date(0),
            1n,
            new Map(),
            () => 0,
            NaN,
            Symbol("local"),
          ]) {
            const error = yield* schemaFailure(request, {
              body: input({ title: "a", meta }),
            } as never);
            expect(error).toContain("Expected JSON value");
            expect(error).toContain(field);
          }
        }
        const voidFirst = post(Schema.Union([Schema.Void, Note]));
        expect(
          yield* schemaFailure(voidFirst, {
            body: { title: "a", meta: new Date(0) },
          }),
        ).toContain('["meta"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("refuses a member whose encoded check fails beside Void", () =>
    Effect.gen(function* () {
      const Count = Schema.Number.pipe(
        Schema.encodeTo(Schema.Number.check(Schema.isGreaterThan(0)), {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.passthrough(),
        }),
      );
      const Rest = Schema.Struct({ count: Count });
      const schema = Schema.Union([Rest, Schema.Void]);
      expect(yield* bodyOf(post(schema), { body: { count: 1 } })).toBe(
        '{"count":1}',
      );
      const error = yield* schemaFailure(post(schema), { body: { count: 0 } });
      expect(error).toContain('["count"]');
      expect(error).toContain("greater than 0");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "keeps fields in an empty struct member and retains Void-first selection",
    () =>
      Effect.gen(function* () {
        const Empty = Schema.Struct({});
        expect(yield* bodyOf(post(Empty), { body: { tag: "a" } })).toBe(
          '{"tag":"a"}',
        );
        const structFirst = Schema.Union([Empty, Schema.Void]);
        const voidFirst = Schema.Union([Schema.Void, Empty]);
        expect(yield* outcomes(structFirst, { tag: "a" })).toEqual([
          '{"tag":"a"}',
          '{"tag":"a"}',
        ]);
        expect(yield* outcomes(voidFirst, { tag: "a" })).toEqual([
          "undefined",
          "null",
        ]);
        for (const schema of [structFirst, voidFirst]) {
          expect(yield* outcomes(schema, [1])).toEqual(["[1]", "[1]"]);
          expect(yield* outcomes(schema, null)).toEqual(["undefined", "null"]);
        }
        expect(yield* outcomes(structFirst, {})).toEqual(["{}", "{}"]);
        expect(yield* outcomes(structFirst, [])).toEqual(["[]", "[]"]);
        expect(yield* outcomes(voidFirst, {})).toEqual(["undefined", "null"]);
        expect(yield* outcomes(voidFirst, { tag: undefined })).toEqual([
          "undefined",
          "null",
        ]);
        expect(yield* outcomes(voidFirst, [])).toEqual(["undefined", "null"]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "names an invalid alias beside a valid decoded sibling when Void is last",
    () =>
      Effect.gen(function* () {
        for (const [member, filter, field] of [
          [Filter, { page_size: "many" }, '["filter"]["page_size"]'],
          [
            Schema.Array(Filter),
            [{ page_size: "many" }],
            '["filter"][0]["page_size"]',
          ],
        ] as const) {
          const schema = Schema.Struct({
            n: Schema.FiniteFromString,
            filter: Schema.Union([member, Schema.Void]),
          });
          const path = Request.get("").pipe(
            Request.path(schema, () => "/sent"),
          );
          const value = { n: 1, filter };
          const expected =
            "The schema cannot keep this field with the rest of the value\n  at " +
            field;
          expect(
            yield* schemaFailure(post(schema), { body: value } as never),
          ).toBe(expected);
          expect(yield* schemaFailure(path, { path: value } as never)).toBe(
            expected,
          );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "keeps a read object or array whose cells decode to undefined",
    () =>
      Effect.gen(function* () {
        const NullAsUndefined = Schema.Null.pipe(
          Schema.decodeTo(Schema.Undefined, {
            decode: SchemaGetter.transform(() => undefined),
            encode: SchemaGetter.transform(() => null),
          }),
        );
        const object = post(
          Schema.Union([Schema.Void, Schema.Struct({ flag: NullAsUndefined })]),
        );
        const array = post(
          Schema.Union([Schema.Void, Schema.Array(NullAsUndefined)]),
        );
        expect(yield* bodyOf(object, { body: { flag: null } })).toBe(
          '{"flag":null}',
        );
        expect(yield* bodyOf(array, { body: [null] })).toBe("[null]");
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("reports the invalid sibling beside a valid encoded alias", () =>
    Effect.gen(function* () {
      const Extra = Schema.Struct({ a: Schema.Number });
      const wire = { extra: { a: "x" }, filter: { page_size: "05" } };
      for (const members of [
        [Schema.Void, Extra],
        [Extra, Schema.Void],
      ] as const) {
        const extra = Schema.Union(members);
        const nested = Schema.Struct({ filter: Filter, extra });
        const root = Schema.Struct({
          extra,
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        for (const [prepared, path] of [
          [schemaFailure(post(nested), { body: wire } as never), '["extra"]'],
          [
            schemaFailure(post(Schema.Array(nested)), {
              body: [wire],
            } as never),
            '[0]["extra"]',
          ],
          [
            schemaFailure(post(root), {
              body: { extra: wire.extra, page_size: "05" },
            } as never),
            '["extra"]',
          ],
        ] as const) {
          const error = yield* prepared;
          expect(error).toContain(path);
        }
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps an encoded field beneath a renamed parent key", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ pageFilter: VoidFirst }).pipe(
        Schema.encodeKeys({ pageFilter: "page_filter" }),
      );
      expect(
        yield* bodyOf(post(schema), {
          body: { page_filter: { page_size: "05" } },
        }),
      ).toBe('{"page_filter":{"page_size":"5"}}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses an invalid encoded field beneath a renamed parent key",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({ pageFilter: VoidLast }).pipe(
          Schema.encodeKeys({ pageFilter: "page_filter" }),
        );
        expect(
          yield* schemaFailure(post(schema), {
            body: { page_filter: { page_size: "many" } },
          }),
        ).toContain('["page_filter"]["page_size"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps an encoded filter beside a renamed sibling", () =>
    Effect.gen(function* () {
      expect(
        yield* bodyOf(post(RenamedSort), {
          body: { filter: { page_size: "05" }, sort_by: "a" },
        }),
      ).toBe('{"filter":{"page_size":"5"},"sort_by":"a"}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps encoded filters inside a fieldwise object and array", () =>
    Effect.gen(function* () {
      const object = Schema.Struct({
        n: Schema.FiniteFromString,
        mid: Schema.Struct({ inner: VoidFirst }),
      });
      const array = Schema.Struct({
        n: Schema.FiniteFromString,
        items: Schema.Array(VoidFirst),
      });
      expect(
        yield* bodyOf(post(object), {
          body: { n: 1, mid: { inner: { page_size: "05" } } },
        } as never),
      ).toBe('{"n":"1","mid":{"inner":{"page_size":"5"}}}');
      expect(
        yield* bodyOf(post(array), {
          body: { n: 1, items: [{ page_size: "05" }] },
        } as never),
      ).toBe('{"n":"1","items":[{"page_size":"5"}]}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "keeps fields when the JSON writer encounters annotated or checked Void",
    () =>
      Effect.gen(function* () {
        const checkedInputs: Array<unknown> = [];
        const checked = Schema.Void.check(
          Schema.makeFilter((value) => {
            checkedInputs.push(value);
            return true;
          }),
        );
        for (const empty of [
          Schema.Void.annotate({ description: "none" }),
          checked,
        ]) {
          const schema = Schema.Union([empty, Filter]);
          for (const body of [{ limit: 5 }, { page_size: "05" }])
            expect(yield* bodyOf(post(schema), { body })).toBe(
              '{"page_size":"5"}',
            );
          expect(yield* bodyOf(post(schema), { body: {} })).toBe("null");
        }
        const request = Request.get("").pipe(
          Request.path(Schema.Union([checked, Filter]), (value) =>
            value ? "/kept" : "/empty",
          ),
        );
        expect(yield* urlOf(request, { path: {} })).toBe("/empty");
        expect(checkedInputs.length).toBeGreaterThan(0);
        expect(checkedInputs.every((value) => value === undefined)).toBe(true);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps fields past Void in nested any-of alternatives", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Union([Filter, Schema.NullOr(Schema.Void)]),
        Schema.Union([
          Schema.Union([Schema.Void, Schema.Literal("a")]),
          Filter,
        ]),
        Schema.Union([
          Schema.Union([Schema.Literals(["all"]), Schema.Void]),
          Filter,
        ]),
        Schema.Union([
          Schema.Union([Schema.NullOr(Schema.String), Schema.Void]),
          Filter,
        ]),
      ]) {
        expect(yield* bodyOf(post(schema), { body: { page_size: "05" } })).toBe(
          '{"page_size":"5"}',
        );
        expect(
          yield* schemaFailure(post(schema), { body: { page_size: "many" } }),
        ).toContain('["page_size"]');
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses an encoded alias a nested default would replace beside Void",
    () =>
      Effect.gen(function* () {
        const struct = Schema.Struct({ filter: Filter });
        const union = Schema.Union([struct, Schema.Void]);
        const nestedChoice = Schema.Union([struct, Schema.NullOr(Schema.Void)]);
        for (const [schema, wrap, field] of [
          [union, (input: unknown) => input, '["filter"]'],
          [
            Schema.Struct({ value: union }),
            (input: unknown) => ({ value: input }),
            '["value"]',
          ],
          [Schema.Array(union), (input: unknown) => [input], "[0]"],
          [nestedChoice, (input: unknown) => input, '["filter"]'],
        ] as const) {
          const path = Request.get("").pipe(
            Request.path(schema, () => "/sent"),
          );
          for (const page_size of ["many", null]) {
            const input = wrap({ filter: { page_size } });
            expect(
              yield* schemaFailure(post(schema), { body: input } as never),
            ).toContain(field);
            expect(
              yield* schemaFailure(path, { path: input } as never),
            ).toContain(field);
          }
        }
        expect(
          yield* bodyOf(post(union), { body: { filter: { page_size: "05" } } }),
        ).toBe('{"filter":{"page_size":"5"}}');
        expect(yield* bodyOf(post(union), { body: { filter: {} } })).toBe(
          '{"filter":{"page_size":"25"}}',
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "names the invalid field when an unrelated Void branch declines",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          extra: Schema.Union([
            Schema.Void,
            Schema.Struct({ a: Schema.Number }),
          ]),
          filter: Filter,
        });
        expect(
          yield* schemaFailure(post(schema), {
            body: { extra: { a: "x" }, filter: { page_size: "many" } },
          } as never),
        ).toContain('["filter"]["page_size"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses mixed sides when a whole read would discard the filter",
    () =>
      Effect.gen(function* () {
        expect(
          yield* schemaFailure(post(RenamedSort), {
            body: { filter: { limit: 5 }, sort_by: "a" },
          } as never),
        ).toContain('["filter"]');
      }),
  );

  it.effect("keeps first fit for fields that are undefined or unstated", () =>
    Effect.gen(function* () {
      for (const body of [
        {},
        { limit: undefined, page_size: undefined },
        { extra: true },
      ])
        expect(yield* bodyOf(post(VoidFirst), { body } as never)).toBe("null");
    }),
  );

  it.effect("uses defined own cells rather than array metadata", () =>
    Effect.gen(function* () {
      const request = post(
        Schema.Union([Schema.Void, Schema.Array(Schema.FiniteFromString)]),
      );
      const hidden = Object.defineProperty([5], 0, { enumerable: false });
      expect(yield* bodyOf(request, { body: hidden })).toBe('["5"]');
      expect(yield* bodyOf(request, { body: ["05"] })).toBe('["5"]');
      expect(
        yield* bodyOf(request, { body: Object.assign([], { extra: true }) }),
      ).toBe("null");
    }),
  );

  it.effect("keeps generated values in ordinary schemas", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        generated: Schema.optionalKey(Schema.Struct({ a: Schema.Number })).pipe(
          Schema.withConstructorDefault(Effect.succeed({ a: 1 })),
        ),
        empty: Schema.optionalKey(
          Schema.Union([
            Schema.Void,
            Schema.Struct({ a: Schema.optionalKey(Schema.Number) }),
          ]),
        ).pipe(Schema.withConstructorDefault(Effect.succeed({}))),
      });
      expect(yield* bodyOf(post(schema), { body: {} })).toBe(
        '{"generated":{"a":1},"empty":null}',
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently keeps a populated struct constructor default beside Void",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          g: Schema.optionalKey(
            Schema.Union([
              Schema.Void,
              Schema.Struct({ a: Schema.optionalKey(Schema.Number) }),
            ]),
          ).pipe(Schema.withConstructorDefault(Effect.succeed({ a: 1 }))),
        });
        expect(yield* bodyOf(post(schema), { body: {} })).toBe('{"g":{"a":1}}');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently treats undefined-valued fields as absent before first fit",
    () =>
      Effect.gen(function* () {
        const required = post(
          Schema.Union([
            Schema.Struct({ inner: Schema.UndefinedOr(Schema.String) }),
            Schema.Void,
          ]),
        );
        const optional = post(
          Schema.Union([
            Schema.Struct({ a: Schema.optionalKey(Schema.Number) }),
            Schema.Void,
          ]),
        );
        expect(yield* bodyOf(required, { body: { inner: undefined } })).toBe(
          "null",
        );
        expect(
          yield* bodyOf(optional, { body: { a: undefined } } as never),
        ).toBe("{}");
      }),
  );

  it.effect(
    "uses winning schema services once and propagates defects and interruption",
    () =>
      Effect.gen(function* () {
        const trace: Array<string> = [];
        const defect = new Error("defective filter decoder");
        const Counted = Schema.String.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transformEffect((text) =>
              Effect.flatMap(Tenant, (tenant) => {
                trace.push("decode:" + tenant);
                return text === "die"
                  ? Effect.die(defect)
                  : text === "interrupt"
                    ? Effect.interrupt
                    : Effect.succeed(Number(text));
              }),
            ),
            encode: SchemaGetter.transformEffect((value) =>
              Effect.map(Tenant, (tenant) => {
                trace.push("encode:" + tenant);
                return String(value);
              }),
            ),
          }),
        );
        const schema = Schema.Struct({
          filter: Schema.Union([
            Schema.Void,
            Schema.Struct({ limit: Counted }).pipe(
              Schema.encodeKeys({ limit: "page_size" }),
            ),
          ]),
        }).pipe(Schema.encodeKeys({ filter: "page_filter" }));
        const run = (page_size: string) =>
          Request.compile(post(schema), {
            body: { page_filter: { page_size } },
          }).pipe(Effect.provideService(Tenant, "request"));
        yield* run("05");
        expect(trace).toEqual(["decode:request", "encode:request"]);
        for (const mode of ["die", "interrupt"] as const) {
          const result = yield* Effect.exit(run(mode));
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(
              mode === "die"
                ? Cause.hasDies(result.cause)
                : Cause.hasInterrupts(result.cause),
            ).toBe(true);
        }
      }),
  );

  // A guarded Void declines a list with a defined cell, so the list's one array reader is followed.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses an invalid array member alias beside Void", () =>
    Effect.gen(function* () {
      for (const [schema, path] of [
        [Schema.Union([Schema.Array(Filter), Schema.Void]), '[0]["page_size"]'],
        [Schema.Union([Schema.Void, Schema.Array(Filter)]), "[0]"],
      ] as const) {
        const request = post(schema);
        expect(
          yield* schemaFailure(request, { body: [{ page_size: "many" }] }),
        ).toContain(path);
        for (const [list, written] of [
          [[{ page_size: "05" }], '[{"page_size":"5"}]'],
          [[{ limit: 5 }], '[{"page_size":"5"}]'],
          [[{}], '[{"page_size":"25"}]'],
        ] as const)
          expect(yield* bodyOf(request, { body: list } as never)).toBe(written);
      }
    }),
  );

  // A cell that is not enumerable is still an own cell: the guarded Void declines the list.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses a hidden invalid list cell beside Void", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Union([Schema.Array(Filter), Schema.Void]),
        Schema.Union([Schema.Void, Schema.Array(Filter)]),
      ]) {
        expect(yield* outcomes(schema, hiddenFilterCell("many"))).toEqual([
          "refused",
          "refused",
        ]);
        expect(yield* outcomes(schema, hiddenFilterCell("05"))).toEqual([
          '[{"page_size":"5"}]',
          '[{"page_size":"5"}]',
        ]);
      }
    }),
  );

  const Cursor = Schema.Struct({ cursor: Schema.String });
  const Parent = Schema.Struct({ filter: Filter });
  // Each grouping reads like its flat union: the guard of the union holding Void decides it.
  const grouped = [
    {
      name: "a list beside a grouped cursor and Void",
      schemas: [
        Schema.Union([
          Schema.Array(Filter),
          Schema.Union([Cursor, Schema.Void]),
        ]),
        Schema.Union([
          Schema.Array(Filter),
          Schema.Union([Schema.Void, Cursor]),
        ]),
        Schema.Union([Schema.Array(Filter), Cursor, Schema.Void]),
      ],
      leaf: (filter: object) => [filter],
    },
    {
      name: "an object beside a grouped list and Void",
      schemas: [
        Schema.Union([
          Parent,
          Schema.Union([Schema.Array(Schema.String), Schema.Void]),
        ]),
        Schema.Union([
          Parent,
          Schema.Union([Schema.Void, Schema.Array(Schema.String)]),
        ]),
        Schema.Union([Parent, Schema.Array(Schema.String), Schema.Void]),
      ],
      leaf: (filter: object) => ({ filter }),
    },
  ] as const;
  for (const { name, schemas, leaf } of grouped)
    // https://github.com/viell-dev/slop-effect-schema-http/issues/170
    it.effect(`refuses an invalid alias in ${name}`, () =>
      Effect.gen(function* () {
        for (const union of schemas)
          for (const [schema, wrap] of [
            [union, (value: unknown) => value],
            [
              Schema.Struct({ cell: union }),
              (value: unknown) => ({ cell: value }),
            ],
            [Schema.Array(union), (value: unknown) => [value]],
          ] as const) {
            expect(
              yield* outcomes(schema, wrap(leaf({ page_size: "many" }))),
            ).toEqual(["refused", "refused"]);
            for (const [filter, written] of [
              [{ page_size: "05" }, "5"],
              [{ limit: 5 }, "5"],
              [{}, "25"],
            ] as const) {
              const expected = JSON.stringify(
                wrap(leaf({ page_size: written })),
              );
              expect(yield* outcomes(schema, wrap(leaf(filter)))).toEqual([
                expected,
                expected,
              ]);
            }
          }
      }),
    );
});

// One member union used both where its Void is guarded and where it is not. Its string member reads
// an object on its encoded side.
const reusedGrouping = (sharing: boolean) => {
  const cursorText = Schema.Struct({ cursor: Schema.String }).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform(() => "x"),
      encode: SchemaGetter.transform(() => ({ cursor: "x" })),
    }),
  );
  const inner = () => Schema.Union([cursorText, Schema.Void]);
  const first = inner();
  const second = sharing ? first : inner();
  const list = Schema.Array(Filter);
  return Schema.Array(
    Schema.Struct({
      guarded: Schema.optionalKey(Schema.Union([list, first])),
      loose: Schema.optionalKey(
        Schema.Union([list, second], { mode: "oneOf" }),
      ),
      n: Schema.FiniteFromString,
    }),
  );
};
const reusedInput = [{ guarded: [{ page_size: "many" }], n: 2 }];

describe("known Void selection limits", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "refuses an invalid alias where a member union is also used unguarded",
    () =>
      Effect.gen(function* () {
        for (const sharing of [true, false])
          expect(yield* outcomes(reusedGrouping(sharing), reusedInput)).toEqual(
            ["refused", "refused"],
          );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently lets Void take a list beside a oneOf grouping of Void",
    () =>
      Effect.gen(function* () {
        expect(
          yield* outcomes(
            Schema.Union([
              Schema.Array(Filter),
              Schema.Union(
                [Schema.Struct({ cursor: Schema.String }), Schema.Void],
                {
                  mode: "oneOf",
                },
              ),
            ]),
            [{ page_size: "many" }],
          ),
        ).toEqual(["undefined", "null"]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently discards a hidden-cell list beside a struct-only alternative",
    () =>
      Effect.gen(function* () {
        // The struct cannot read a list, and since #237 it cannot take an index-keyed copy of one,
        // so Void takes the list in either order. The field-loss check does not see the cell.
        for (const schema of [VoidLast, VoidFirst]) {
          const list = Object.defineProperty([1], 0, { enumerable: false });
          expect(yield* bodyOf(post(schema), { body: list } as never)).toBe(
            "null",
          );
        }
      }),
  );

  class FilterClass extends Schema.Class<FilterClass>("FilterClass")({
    limit: Schema.FiniteFromString,
  }) {}
  class ParentClass extends Schema.Class<ParentClass>("ParentClass")({
    filter: VoidFirst,
  }) {}
  const ClassMember = Schema.Union([Schema.Void, FilterClass]);
  const OneOf = Schema.Union([Schema.Void, Filter], { mode: "oneOf" });
  const Discard = Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Undefined, {
      decode: SchemaGetter.transform((_input: unknown) => undefined),
      encode: SchemaGetter.transform((_value: undefined): unknown => undefined),
    }),
  );
  const Custom = Schema.Union([Discard, Filter]);

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently loses a class member or a union field inside a class",
    () =>
      Effect.gen(function* () {
        expect(yield* bodyOf(post(ClassMember), { body: { limit: 5 } })).toBe(
          "null",
        );
        expect(
          yield* bodyOf(post(ParentClass), { body: { filter: { limit: 5 } } }),
        ).toBe('{"filter":null}');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect.fails("keeps the visible class member beside Void", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(post(ClassMember), { body: { limit: 5 } })).toBe(
        '{"limit":"5"}',
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect.fails("keeps the visible union field in a class", () =>
    Effect.gen(function* () {
      expect(
        yield* bodyOf(post(ParentClass), { body: { filter: { limit: 5 } } }),
      ).toBe('{"filter":{"page_size":"5"}}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("currently discards an encoded field through oneOf", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(post(OneOf), { body: { page_size: "05" } })).toBe(
        "null",
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps what a custom transformation would discard", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(post(Custom), { body: { page_size: "05" } })).toBe(
        '{"page_size":"5"}',
      );
      expect(
        yield* schemaFailure(post(Custom), { body: { page_size: "many" } }),
      ).toContain('["page_size"]');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently discards fields inside opaque or suspended schemas",
    () =>
      Effect.gen(function* () {
        const opaque = Request.get("").pipe(
          Request.path(Schema.Option(VoidFirst), (value) =>
            Option.isSome(value) && value.value === undefined
              ? "/empty"
              : "/kept",
          ),
        );
        expect(yield* urlOf(opaque, { path: Option.some({ limit: 5 }) })).toBe(
          "/empty",
        );
        const suspended = post(
          Schema.suspend((): typeof VoidFirst => VoidFirst),
        );
        expect(yield* bodyOf(suspended, { body: { limit: 5 } })).toBe("null");
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently discards fields through an encoded member union or standalone Void",
    () =>
      Effect.gen(function* () {
        const member = Schema.Union([Schema.Void, Schema.Literal("a")]).pipe(
          Schema.encodeTo(Schema.Literal("a"), {
            decode: SchemaGetter.transform(() => undefined),
            encode: SchemaGetter.transform(() => "a" as const),
          }),
        );
        const request = post(Schema.Union([member, Filter]));
        expect(yield* bodyOf(request, { body: { limit: 5 } })).toBe('"a"');
        expect(
          yield* bodyOf(post(Schema.Void), { body: { limit: 5 } } as never),
        ).toBe("null");
      }),
  );
});
