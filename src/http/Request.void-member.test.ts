import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect";
import {
  bodyOf,
  linesOf,
  schemaFailure,
  Tenant,
  urlOf,
} from "../../test/request.js";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
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
  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("refuses a fieldless oneOf beside Void in either order", () =>
    Effect.gen(function* () {
      const ambiguous = "Expected exactly one member to match";
      for (const [member, inputs] of [
        [Filter, [{}, { x: undefined }, { extra: true }]],
        [Schema.Struct({}), [{}, { x: undefined }, []]],
        [Schema.Array(Schema.FiniteFromString), [[]]],
      ] as const) {
        for (const members of [
          [member, Schema.Void],
          [Schema.Void, member],
        ] as const) {
          const schema = Schema.Union(members, { mode: "oneOf" });
          const path = Request.get("").pipe(Request.path(schema, () => "/p"));
          for (const input of inputs) {
            expect
              .soft(yield* outcomes(schema, input), JSON.stringify(input))
              .toEqual(["refused", "refused"]);
          }
          expect
            .soft(yield* outcomes(schema, undefined))
            .toEqual(["undefined", "null"]);
          expect
            .soft(yield* outcomes(schema, null))
            .toEqual(["undefined", "null"]);
          for (const prepared of [
            Request.compile(post(schema), { body: inputs[0] }),
            Request.compile(path, { path: inputs[0] }),
          ]) {
            const result = yield* Effect.result(prepared);
            expect
              .soft(
                result._tag === "Failure" &&
                  Schema.isSchemaError(result.failure) &&
                  result.failure.message,
              )
              .toBe(ambiguous);
          }
        }
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "keeps the oneOf ambiguity through grouped and suspended Void",
    () =>
      Effect.gen(function* () {
        for (const empty of [
          Schema.NullOr(Schema.Void),
          Schema.suspend(() => Schema.Void),
          Schema.NullOr(Schema.suspend(() => Schema.Void)),
        ]) {
          for (const members of [
            [Filter, empty],
            [empty, Filter],
          ] as const) {
            const schema = Schema.Union(members, { mode: "oneOf" });
            expect(yield* outcomes(schema, {})).toEqual(["refused", "refused"]);
            expect(yield* outcomes(schema, { limit: 5 })).toEqual([
              '{"page_size":"5"}',
              '{"page_size":"5"}',
            ]);
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("refuses fieldless oneOf values without Void in either order", () =>
    Effect.gen(function* () {
      const first = Schema.Struct({
        a: Schema.optionalKey(Schema.String).pipe(
          Schema.withConstructorDefault(Effect.succeed("x")),
        ),
      });
      const second = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
      for (const members of [
        [first, second],
        [second, first],
      ] as const) {
        const schema = Schema.Union(members, { mode: "oneOf" });
        const request = post(schema);
        const path = Request.get("").pipe(Request.path(schema, () => "/p"));
        for (const extra of [{}, { extra: true }, { a: undefined }]) {
          const input = extra as Request.Input<typeof schema>;
          expect
            .soft(yield* schemaFailure(request, { body: input }))
            .toBe("Expected exactly one member to match");
          expect
            .soft(yield* schemaFailure(path, { path: input }))
            .toBe("Expected exactly one member to match");
        }
        expect(yield* bodyOf(request, { body: { b: "y" } })).toBe('{"b":"y"}');
        expect(yield* bodyOf(post(Schema.Union(members)), { body: {} })).toBe(
          members[0] === first ? '{"a":"x"}' : "{}",
        );
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "refuses a three-member oneOf before and after reading suspended Void",
    () =>
      Effect.gen(function* () {
        const other = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
        for (const order of ["last", "first"] as const) {
          const empty = Schema.suspend(() => Schema.Void);
          const members =
            order === "last"
              ? ([Filter, other, empty] as const)
              : ([empty, Filter, other] as const);
          const request = post(Schema.Union(members, { mode: "oneOf" }));
          const ambiguous = "Expected exactly one member to match";
          expect
            .soft(yield* schemaFailure(request, { body: {} }))
            .toBe(ambiguous);
          expect(yield* bodyOf(request, { body: undefined })).toBe("null");
          expect
            .soft(yield* schemaFailure(request, { body: {} }))
            .toBe(ambiguous);
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("keeps internal input reporting out of request refusals", () =>
    Effect.gen(function* () {
      const login = post(
        Schema.Struct({
          password: Schema.String.check(Schema.isMinLength(20)),
          filter: Schema.Union([Filter, Schema.Void], { mode: "oneOf" }),
        }),
      );
      const password = "too-short-secret";
      const message = yield* schemaFailure(login, {
        body: { password, filter: {} },
      });
      expect
        .soft(message)
        .toBe(
          'Expected a value with a length of at least 20\n  at ["password"]',
        );
      expect.soft(message).not.toContain("got");
      expect.soft(message).not.toContain(password);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "omits input from the ambiguity even when parse options request it",
    () =>
      Effect.gen(function* () {
        const f = Schema.Union([Filter, Schema.Void], { mode: "oneOf" });
        const decode = Inputs.toDecoded(Schema.Struct({ f }), {
          errors: "all",
          reportInput: true,
        });
        const failure = yield* Effect.flip(decode({ f: {} }));
        expect(failure.message).toBe(
          'Expected exactly one member to match\n  at ["f"]',
        );
        if (
          failure.issue._tag !== "Pointer" ||
          failure.issue.issue._tag !== "OneOf"
        )
          throw failure;
        expect(failure.issue.issue.input).toBeUndefined();
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "names the ambiguous field at its full path in mixed-side input",
    () =>
      Effect.gen(function* () {
        for (const members of [
          [Filter, Schema.Void],
          [Schema.Void, Filter],
        ] as const) {
          const request = post(
            Schema.Struct({
              a: Schema.FiniteFromString,
              b: Schema.FiniteFromString,
              f: Schema.Struct({ g: Schema.Union(members, { mode: "oneOf" }) }),
              g: Schema.optionalKey(Schema.Struct({})),
            }),
          );
          for (const decoy of [{}, { g: {} }]) {
            const message = yield* schemaFailure(request, {
              body: { a: "5", b: 6, f: { g: {} }, ...decoy },
            });
            expect
              .soft(message)
              .toBe('Expected exactly one member to match\n  at ["f"]["g"]');
            expect.soft(message).not.toContain("got");
            expect.soft(message).not.toContain("the input");
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("keeps populated values for oneOf and first fit for anyOf", () =>
    Effect.gen(function* () {
      for (const members of [
        [Filter, Schema.Void],
        [Schema.Void, Filter],
      ] as const) {
        const schema = Schema.Union(members, { mode: "oneOf" });
        for (const input of [{ limit: 5 }, { page_size: "05" }])
          expect(yield* outcomes(schema, input)).toEqual([
            '{"page_size":"5"}',
            '{"page_size":"5"}',
          ]);
        expect(yield* outcomes(Schema.Union(members), {})).toEqual(
          members[0] === Filter
            ? ['{"page_size":"25"}', '{"page_size":"25"}']
            : ["undefined", "null"],
        );
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("refuses the ambiguous field in a struct and in a class", () =>
    Effect.gen(function* () {
      for (const members of [
        [Filter, Schema.Void],
        [Schema.Void, Filter],
      ] as const) {
        const filter = Schema.Union(members, { mode: "oneOf" });
        class Search extends Schema.Class<Search>("Search")({ filter }) {}
        for (const schema of [Schema.Struct({ filter }), Search]) {
          const request = post(schema);
          const result = yield* Effect.result(
            Request.compile(request, { body: { filter: {} } }),
          );
          expect
            .soft(
              result._tag === "Failure" &&
                Schema.isSchemaError(result.failure) &&
                result.failure.message,
            )
            .toBe('Expected exactly one member to match\n  at ["filter"]');
          expect(
            yield* bodyOf(request, { body: { filter: { limit: 5 } } }),
          ).toBe('{"filter":{"page_size":"5"}}');
        }
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "refuses ambiguous query and header groups before group validation",
    () =>
      Effect.gen(function* () {
        const other = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
        for (const members of [
          [Filter, Schema.Void],
          [Schema.Void, Filter],
          [Filter, other],
          [other, Filter],
        ] as const) {
          const schema = Schema.Union(members, { mode: "oneOf" });
          // The public group types require every member to encode a field record or pairs.
          const group = schema as unknown as typeof Filter;
          const query = Request.get("/x").pipe(Request.query(group));
          const headers = Request.get("/x").pipe(Request.headers(group));
          for (const result of [
            yield* Effect.result(Request.compile(query, { query: {} })),
            yield* Effect.result(Request.compile(headers, { headers: {} })),
          ]) {
            expect
              .soft(
                result._tag === "Failure" &&
                  Schema.isSchemaError(result.failure) &&
                  result.failure.message,
              )
              .toBe("Expected exactly one member to match");
          }
          expect(yield* urlOf(query, { query: { limit: 5 } })).toBe(
            "/x?page_size=5",
          );
          expect(yield* linesOf(headers, { headers: { limit: 5 } })).toEqual([
            ["page_size", "5"],
          ]);
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "refuses an ambiguous omitted or stacked query or header group",
    () =>
      Effect.gen(function* () {
        const other = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
        const f = Schema.Union([Filter, other], { mode: "oneOf" });
        const z = Schema.Struct({ z: Schema.String });
        const root = Request.get("/x");
        const message = "Expected exactly one member to match";
        for (const failure of [
          schemaFailure(root.pipe(Request.query(f)), {} as never),
          schemaFailure(root.pipe(Request.headers(f)), {} as never),
          schemaFailure(root.pipe(Request.query(f), Request.query(z)), {
            query: { z: "given" },
          }),
          schemaFailure(root.pipe(Request.query(z), Request.query(f)), {
            query: { z: "given" },
          }),
          schemaFailure(root.pipe(Request.headers(f), Request.headers(z)), {
            headers: { z: "given" },
          }),
          schemaFailure(root.pipe(Request.headers(z), Request.headers(f)), {
            headers: { z: "given" },
          }),
        ])
          expect(yield* failure).toBe(message);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "refuses fieldless oneOf through enclosing unions and list positions",
    () =>
      Effect.gen(function* () {
        const message = "Expected exactly one member to match";
        for (const members of [
          [Filter, Schema.Void],
          [Schema.Void, Filter],
        ] as const) {
          const union = Schema.Union(members, { mode: "oneOf" });
          for (const wrapped of [
            Schema.optional(union),
            Schema.NullOr(union),
            Schema.UndefinedOr(union),
            Schema.Union([union, Schema.String]),
            Schema.Union([Schema.String, union]),
            Schema.suspend(() => Schema.NullOr(union)),
          ]) {
            const record = post(Schema.Struct({ f: wrapped }));
            const listSchema = Schema.Array(wrapped);
            const list = post(listSchema);
            for (const f of [
              {},
              { extra: "synthetic-unused" },
              { limit: undefined },
            ]) {
              const input = f as Request.Input<typeof wrapped>;
              expect(yield* schemaFailure(record, { body: { f: input } })).toBe(
                message + '\n  at ["f"]',
              );
              expect(
                yield* schemaFailure(list, {
                  body: [{ limit: 5 }, input] as Request.Input<
                    typeof listSchema
                  >,
                }),
              ).toBe(message + "\n  at [1]");
            }
            for (const f of [{ limit: 5 }, { page_size: "05" }]) {
              expect(yield* bodyOf(record, { body: { f } })).toBe(
                '{"f":{"page_size":"5"}}',
              );
              expect(yield* bodyOf(list, { body: [f] })).toBe(
                '[{"page_size":"5"}]',
              );
            }
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("still takes a successful enclosing anyOf member", () =>
    Effect.gen(function* () {
      const f = Schema.Union([Filter, Schema.Void], { mode: "oneOf" });
      const ambiguous = Schema.Struct({ f, n: Schema.Finite });
      const keeping = Schema.Struct({
        f: Schema.Unknown,
        n: Schema.FiniteFromString,
      });
      for (const members of [
        [ambiguous, keeping],
        [keeping, ambiguous],
      ] as const) {
        const request = post(Schema.Union(members));
        expect(yield* bodyOf(request, { body: { f: {}, n: "05" } })).toBe(
          members[0] === ambiguous ? '{"f":{},"n":5}' : '{"f":{},"n":"5"}',
        );
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "still reads an encoded-only alternative of an enclosing union",
    () =>
      Effect.gen(function* () {
        const union = Schema.Union([Filter, Schema.Void], { mode: "oneOf" });
        const alternative = Schema.Struct({}).pipe(
          Schema.decodeTo(Schema.Literal("encoded"), {
            decode: SchemaGetter.transform(() => "encoded" as const),
            encode: SchemaGetter.transform(() => ({})),
          }),
        );
        for (const members of [
          [union, alternative],
          [alternative, union],
        ] as const) {
          expect(yield* bodyOf(post(Schema.Union(members)), { body: {} })).toBe(
            "{}",
          );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "still reads a distinct enclosing union member field by field",
    () =>
      Effect.gen(function* () {
        const f = Schema.Union([Filter, Schema.Void], { mode: "oneOf" });
        const ambiguous = Schema.Struct({
          f,
          n: Schema.Finite,
          m: Schema.String,
        });
        const keeping = Schema.Struct({
          f: Schema.Unknown,
          n: Schema.FiniteFromString,
          m: Schema.FiniteFromString,
        });
        for (const members of [
          [ambiguous, keeping],
          [keeping, ambiguous],
        ] as const) {
          const request = post(Schema.Union(members));
          expect(
            yield* bodyOf(request, { body: { f: {}, n: "5", m: 6 } }),
          ).toBe('{"f":{},"n":"5","m":"6"}');
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("takes the complete fieldwise reading in either anyOf order", () =>
    Effect.gen(function* () {
      const n = Schema.FiniteFromString;
      const m = Schema.FiniteFromString;
      const f = Schema.Union([Filter, Schema.Void], { mode: "oneOf" });
      const ambiguous = Schema.Struct({ f, n, m });
      const keeping = Schema.Struct({ f: Schema.Unknown, n, m });
      const body = { f: {}, n: "5", m: 6 };
      const first = post(Schema.Union([ambiguous, keeping]));
      const last = post(Schema.Union([keeping, ambiguous]));
      expect(yield* bodyOf(first, { body })).toBe('{"f":{},"n":"5","m":"6"}');
      expect(yield* bodyOf(last, { body })).toBe('{"f":{},"n":"5","m":"6"}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "retains the ambiguity when the enclosing alternative would lose a field",
    () =>
      Effect.gen(function* () {
        const f = Schema.Union([Filter, Schema.Void], { mode: "oneOf" });
        const n = Schema.FiniteFromString;
        const ambiguous = Schema.Struct({ f, n, m: n, kept: Schema.String });
        const strips = Schema.Struct({ f: Schema.Unknown, n, m: n });
        const body = { f: {}, n: "5", m: 6, kept: "given" };
        for (const order of [
          [ambiguous, strips],
          [strips, ambiguous],
        ] as const)
          expect(
            yield* schemaFailure(post(Schema.Union(order)), { body }),
          ).toBe('Expected exactly one member to match\n  at ["f"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("reads past an ambiguous candidate that fails elsewhere", () =>
    Effect.gen(function* () {
      const F = Schema.FiniteFromString;
      const defaulting = Schema.Struct({
        a: Schema.optionalKey(Schema.String).pipe(
          Schema.withConstructorDefault(Effect.succeed("x")),
        ),
      });
      const other = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
      for (const members of [
        [Filter, Schema.Void],
        [Schema.Void, Filter],
        [defaulting, other],
        [other, defaulting],
      ] as const) {
        const one = Schema.Union(members, { mode: "oneOf" });
        for (const f of [
          one,
          Schema.optional(one),
          Schema.NullOr(one),
          Schema.Union([one, Schema.String]),
        ] as const) {
          const cases = [
            [
              Schema.Struct({ f, n: Schema.Finite, m: Schema.String }),
              Schema.Struct({ f: Schema.Unknown, n: F, m: F }),
              { f: {}, n: "5", m: 6 },
              '{"f":{},"n":"5","m":"6"}',
            ],
            [
              Schema.Struct({ f, required: Schema.String, n: F, m: F }),
              Schema.Struct({ f: Schema.Unknown, n: F, m: F }),
              { f: {}, n: "5", m: 6 },
              '{"f":{},"n":"5","m":"6"}',
            ],
            [
              Schema.Struct({ f, required: Schema.String, n: F, m: F }),
              Schema.Struct({ f: Schema.Unknown, n: F, m: F }),
              { f: {}, required: undefined, n: "5", m: 6 },
              '{"f":{},"n":"5","m":"6"}',
            ],
            [
              Schema.Struct({
                g: Schema.Struct({ f, required: Schema.String }),
                n: F,
                m: F,
              }),
              Schema.Struct({ g: Schema.Unknown, n: F, m: F }),
              { g: { f: {} }, n: "5", m: 6 },
              '{"g":{"f":{}},"n":"5","m":"6"}',
            ],
            [
              Schema.Struct({
                g: Schema.Struct({ f, required: Schema.String }),
                n: F,
                m: F,
              }),
              Schema.Struct({ g: Schema.Unknown, n: F, m: F }),
              { g: { f: {}, required: 7 }, n: "5", m: 6 },
              '{"g":{"f":{},"required":7},"n":"5","m":"6"}',
            ],
          ] as const;
          for (const [ambiguous, keeping, body, output] of cases)
            for (const order of [
              [ambiguous, keeping],
              [keeping, ambiguous],
            ] as const)
              expect(
                yield* bodyOf(post(Schema.Union(order)), { body } as never),
              ).toBe(output);
        }
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "judges the empty field independently of excess keys in an opaque neighbour",
    () =>
      Effect.gen(function* () {
        const Inner = Schema.Struct({ a: Schema.String });
        const O = Schema.Option(Inner);
        const defaulting = Schema.Struct({
          a: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("x")),
          ),
        });
        const other = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
        for (const members of [
          [Filter, Schema.Void],
          [Schema.Void, Filter],
          [defaulting, other],
          [other, defaulting],
        ] as const) {
          const u = Schema.Union(members, { mode: "oneOf" });
          for (const [schema, input, path] of [
            [
              Schema.Struct({ o: O, f: u }),
              (o: unknown, f: unknown) => ({ o, f }),
              '["f"]',
            ],
            [
              Schema.Struct({ f: u, o: O }),
              (o: unknown, f: unknown) => ({ f, o }),
              '["f"]',
            ],
            [
              Schema.Struct({ o: O, f: Schema.optional(u) }),
              (o: unknown, f: unknown) => ({ o, f }),
              '["f"]',
            ],
            [
              Schema.Struct({ o: O, g: Schema.Struct({ f: u }) }),
              (o: unknown, f: unknown) => ({ o, g: { f } }),
              '["g"]["f"]',
            ],
            [
              Schema.Struct({ o: O, r: Schema.Record(Schema.String, u) }),
              (o: unknown, f: unknown) => ({ o, r: { k: f } }),
              '["r"]["k"]',
            ],
            [Schema.Tuple([O, u]), (o: unknown, f: unknown) => [o, f], "[1]"],
          ] as const) {
            for (const o of [
              Option.some({ a: "x" }),
              Option.some({ a: "x", extra: 1 }),
            ])
              for (const f of [
                {},
                { extra: true },
                { limit: undefined, a: undefined, b: undefined },
              ])
                expect(
                  yield* schemaFailure(post(schema), {
                    body: input(o, f),
                  } as never),
                ).toBe("Expected exactly one member to match\n  at " + path);
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "keeps the caller's named array field in view during reassembly",
    () =>
      Effect.gen(function* () {
        const list = Schema.Array(Schema.Unknown);
        const tuple = Schema.Tuple([Schema.optionalKey(Schema.String)]);
        const n = Schema.FiniteFromString;
        for (const members of [
          [list, tuple],
          [tuple, list],
        ] as const) {
          const f = Schema.Union(members, { mode: "oneOf" });
          const schema = Schema.Union([
            Schema.Struct({ f, n, m: n }),
            Schema.Struct({ f: Schema.Unknown, n, m: n }),
          ]);
          const input = {
            f: Object.assign([], { tag: "named" }),
            n: "5",
            m: 6,
          };
          const path = Request.get("").pipe(
            Request.path(schema, (value) =>
              Array.isArray(value.f) && Reflect.get(value.f, "tag") === "named"
                ? "/kept"
                : "/missing",
            ),
          );
          expect(yield* urlOf(path, { path: input })).toBe("/kept");
          const failure = yield* Effect.flip(
            bodyOf(post(schema), { body: input }),
          );
          expect(failure).toMatchObject({
            _tag: "HttpBodyError",
            message:
              'JSON body at $["f"]["tag"] cannot encode an extra array field',
          });
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "uses the field's constructor when only its encoded side is ambiguous",
    () =>
      Effect.gen(function* () {
        const n = Schema.FiniteFromString;
        const A = Schema.Struct({
          a: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("x")),
          ),
        });
        const B = Schema.Struct({
          marker: Schema.optionalKey(Schema.String),
        }).pipe(
          Schema.decodeTo(Schema.Struct({ code: Schema.String }), {
            decode: SchemaGetter.transform(() => ({ code: "decoded" })),
            encode: SchemaGetter.transform(() => ({})),
          }),
        );
        for (const members of [
          [A, B],
          [B, A],
        ] as const) {
          const f = Schema.Union(members, { mode: "oneOf" });
          for (const schema of [
            Schema.Struct({ f, n, m: n }),
            Schema.Struct({ n, m: n, f }),
          ])
            for (const [a, b] of [
              [5, 6],
              ["5", "6"],
              ["5", 6],
              [5, "6"],
            ] as const)
              expect(
                JSON.parse(
                  (yield* bodyOf(post(schema), {
                    body: { f: {}, n: a, m: b },
                  }))!,
                ),
              ).toEqual({
                f: { a: "x" },
                n: "5",
                m: "6",
              });
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/307
  it.effect(
    "writes an all-undefined field beside an opaque neighbour with excess keys",
    () =>
      Effect.gen(function* () {
        const o = Schema.Option(Schema.Struct({ a: Schema.String }));
        const C = Schema.Struct({ c: Schema.String });
        for (const mode of ["anyOf", "oneOf"] as const) {
          const f = Schema.Union([C, Schema.Unknown], { mode });
          for (const schema of [
            Schema.Struct({ f, o }),
            Schema.Struct({ o, f }),
          ]) {
            const request = post(schema);
            for (const option of [
              Option.some({ a: "x" }),
              Option.some({ a: "x", extra: 1 }),
            ])
              expect(
                JSON.parse(
                  (yield* bodyOf(request, {
                    body: { f: { limit: undefined }, o: option },
                  }))!,
                ),
              ).toEqual({
                f: {},
                o: { _tag: "Some", value: { a: "x" } },
              });
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/307
  it.effect(
    "reads an encoded tuple item after dropping its undefined keys",
    () =>
      Effect.gen(function* () {
        const C = Schema.Struct({ c: Schema.String });
        const encoded = Schema.Struct({
          marker: Schema.optionalKey(Schema.String),
        }).pipe(
          Schema.decodeTo(Schema.Struct({ code: Schema.String }), {
            decode: SchemaGetter.transform(() => ({ code: "read" })),
            encode: SchemaGetter.transform(() => ({})),
          }),
        );
        const option = Schema.Option(Schema.Struct({ a: Schema.String }));
        const input = { c: undefined, marker: undefined };
        for (const members of [
          [C, encoded],
          [encoded, C],
        ] as const) {
          const item = Schema.Union(members, { mode: "oneOf" });
          const schema = Schema.Tuple([option, item]);
          const request = Request.get("").pipe(
            Request.path(schema, ([, value]) =>
              Object.keys(value).length === 0 ? "/empty" : "/unexpected",
            ),
          );
          for (const o of [
            Option.some({ a: "x" }),
            Option.some({ a: "x", extra: 1 }),
          ])
            expect(yield* urlOf(request, { path: [o, input] } as never)).toBe(
              "/empty",
            );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "retains the ambiguity when the alternative cannot write JSON",
    () =>
      Effect.gen(function* () {
        const n = Schema.FiniteFromString;
        const keeping = Schema.Struct({ f: Schema.Unknown, n, m: n });
        for (const shape of [Schema.Struct({}), Schema.Unknown]) {
          const one = Schema.Union([Schema.Void, shape], { mode: "oneOf" });
          for (const f of [one, Schema.optional(one)]) {
            const ambiguous = Schema.Struct({ f, n, m: n });
            for (const order of [
              [ambiguous, keeping],
              [keeping, ambiguous],
            ] as const)
              for (const list of [[undefined], Array<undefined>(1)])
                expect(
                  yield* schemaFailure(post(Schema.Union(order)), {
                    body: { f: list, n: "5", m: 6 },
                  }),
                ).toBe('Expected exactly one member to match\n  at ["f"]');
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("keeps an exposed field beside an opaque neighbour", () =>
    Effect.gen(function* () {
      const one = Schema.Union([Filter, Schema.Void], { mode: "oneOf" });
      const o = Schema.Option(Schema.Struct({ a: Schema.String }));
      const request = post(Schema.Struct({ o, f: one }));
      const f = Object.defineProperty({}, "limit", { value: 5 });
      expect(
        yield* bodyOf(request, {
          body: { f, o: Option.some({ a: "x", extra: 1 }) },
        }),
      ).toBe('{"o":{"_tag":"Some","value":{"a":"x"}},"f":{"page_size":"5"}}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "treats an explicitly undefined field as empty during a direct read",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Union([Schema.Unknown, Schema.Void], {
          mode: "oneOf",
        });
        const decode = Inputs.toDecoded(schema);
        const failure = yield* Effect.flip(decode({ limit: undefined }));
        expect(failure.message).toBe("Expected exactly one member to match");
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "keeps a strict ambiguity without repeating constructor defaults",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const a = Schema.Struct({
          a: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                calls++;
                return "x";
              }),
            ),
          ),
        });
        const b = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
        const one = Schema.Union([a, b], { mode: "oneOf" });
        expect(yield* schemaFailure(post(one), { body: {} })).toBe(
          "Expected exactly one member to match",
        );
        expect(calls).toBe(1);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("keeps a loose read's ambiguity after a strict write fails", () =>
    Effect.gen(function* () {
      const wire = Schema.Struct({ marker: Schema.optionalKey(Schema.String) });
      const application = Schema.Struct({
        a: Schema.optionalKey(Schema.String).pipe(
          Schema.withConstructorDefault(Effect.succeed("x")),
        ),
      });
      const transforming = wire.pipe(
        Schema.decodeTo(application, {
          decode: SchemaGetter.transform(() => ({})),
          encode: SchemaGetter.transform(() => ({ marker: "x", extra: true })),
        }),
      );
      const looselyEmpty = Schema.declareConstructor<object>()(
        [],
        () => (value, ast, options) =>
          options.onExcessProperty !== "error" &&
          typeof value === "object" &&
          value !== null &&
          Reflect.ownKeys(value).length === 0
            ? Effect.succeed(value)
            : Effect.fail(new SchemaIssue.InvalidType(ast, value, options)),
      );
      const schema = Schema.Union([transforming, looselyEmpty], {
        mode: "oneOf",
      });
      const path = Request.get("").pipe(Request.path(schema, () => "/wrote"));
      expect(yield* schemaFailure(path, { path: {} })).toBe(
        "Expected exactly one member to match",
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "does not retry fieldwise after a loose whole read finds ambiguity",
    () =>
      Effect.gen(function* () {
        const first = Schema.Struct({
          marker: Schema.optionalKey(Schema.String),
        }).pipe(
          Schema.decodeTo(Schema.Struct({ code: Schema.Literal("strict") }), {
            decode: SchemaGetter.transform(() => ({ code: "strict" as const })),
            encode: SchemaGetter.transform(() => ({})),
          }),
        );
        const second = Schema.declareConstructor<object>()(
          [],
          () => (value, ast, options) =>
            options.onExcessProperty !== "error" &&
            typeof value === "object" &&
            value !== null &&
            Reflect.ownKeys(value).length === 0
              ? Effect.succeed(value)
              : Effect.fail(new SchemaIssue.InvalidType(ast, value, options)),
        ).pipe(
          Schema.decodeTo(Schema.Struct({ code: Schema.Literal("loose") }), {
            decode: SchemaGetter.transform(() => ({ code: "loose" as const })),
            encode: SchemaGetter.transform(() => ({})),
          }),
        );
        const o = Schema.Option(Schema.Struct({ a: Schema.String }));
        const f = Schema.Union([first, second], { mode: "oneOf" });
        const request = post(Schema.Struct({ o, f }));
        const body = { o: Option.some({ a: "x", extra: 1 }), f: {} };
        expect(yield* schemaFailure(request, { body })).toBe(
          'Expected exactly one member to match\n  at ["f"]',
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("cannot evade encoded ambiguity by dropping an aliased field", () =>
    Effect.gen(function* () {
      const coded = (code: string) =>
        Schema.Struct({ marker: Schema.optionalKey(Schema.String) }).pipe(
          Schema.decodeTo(Schema.Struct({ code: Schema.Literal(code) }), {
            decode: SchemaGetter.transform(() => ({ code })),
            encode: SchemaGetter.transform(() => ({})),
          }),
        );
      const o = Schema.Option(Schema.Struct({ a: Schema.String }));
      const neighbour = Option.some({ a: "x", extra: true });
      const a = coded("first");
      const b = coded("second");
      const f = Schema.optionalKey(Schema.Union([a, b], { mode: "oneOf" }));
      const request = post(
        Schema.Struct({ o, f }).pipe(Schema.encodeKeys({ f: "wire" })),
      );
      expect(
        yield* schemaFailure(request, { body: { o: neighbour, wire: {} } }),
      ).toBe('Expected exactly one member to match\n  at ["wire"]');

      const defaulting = Schema.Struct({
        a: Schema.optionalKey(Schema.String).pipe(
          Schema.withConstructorDefault(Effect.succeed("x")),
        ),
      });
      const mixed = post(
        Schema.Struct({
          o,
          f: Schema.Union([a, defaulting], { mode: "oneOf" }),
          n: Schema.FiniteFromString,
          note: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ note: "wire" })),
      );
      expect(
        yield* schemaFailure(mixed, {
          body: { o: neighbour, f: {}, n: "5", wire: "supplied" },
        }),
      ).toBe('Expected exactly one member to match\n  at ["f"]');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "retains the list item's ambiguity when a relaxed path write fails",
    () =>
      Effect.gen(function* () {
        const item = Schema.Union([Filter, Schema.Unknown], { mode: "oneOf" });
        const path = Request.get("").pipe(
          Request.path(Schema.Array(Schema.optional(item)), () => "/p"),
        );
        const filter = Object.defineProperty({}, "limit", { value: 5 });
        expect(yield* schemaFailure(path, { path: [filter] })).toBe(
          "Expected exactly one member to match\n  at [0]",
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "reports the diagnostic ambiguity beside a valid encoded sibling",
    () =>
      Effect.gen(function* () {
        const f = Schema.optional(
          Schema.Union([Filter, Schema.Void], { mode: "oneOf" }),
        );
        const request = post(
          Schema.Struct({ count: Schema.FiniteFromString, f }).pipe(
            Schema.encodeKeys({ count: "count_text" }),
          ),
        );
        expect(
          yield* schemaFailure(request, {
            body: { count_text: "05", f: { extra: "synthetic-unused" } },
          } as never),
        ).toBe('Expected exactly one member to match\n  at ["f"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect(
    "names the ambiguous field in nested query and header bindings",
    () =>
      Effect.gen(function* () {
        const a = Schema.Struct({ a: Schema.optionalKey(Schema.String) });
        const b = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
        for (const members of [
          [a, b],
          [b, a],
        ] as const) {
          const union = Schema.Union(members, { mode: "oneOf" });
          const group = Schema.Struct({
            f: Schema.optional(union),
          }) as unknown as typeof Filter;
          const query = Request.get("/x").pipe(Request.query(group));
          const headers = Request.get("/x").pipe(Request.headers(group));
          for (const refusal of [
            schemaFailure(query, {
              query: { f: { extra: "synthetic-unused" } },
            } as never),
            schemaFailure(headers, {
              headers: { f: { extra: "synthetic-unused" } },
            } as never),
          ]) {
            expect(yield* refusal).toBe(
              'Expected exactly one member to match\n  at ["f"]',
            );
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/276
  it.effect("counts matches on the side the reader reached", () =>
    Effect.gen(function* () {
      const empty = Schema.Struct({ a: Schema.optionalKey(Schema.String) });
      const required = Schema.Struct({ c: Schema.String });
      const encodedOnly = Schema.Struct({
        marker: Schema.optionalKey(Schema.String),
      }).pipe(
        Schema.decodeTo(required, {
          decode: SchemaGetter.transform(() => ({ c: "decoded" })),
          encode: SchemaGetter.transform(() => ({})),
        }),
      );
      for (const members of [
        [empty, encodedOnly],
        [encodedOnly, empty],
      ] as const) {
        // The constructor sees only the optional-field struct match; no encoded read is needed.
        expect(
          yield* bodyOf(post(Schema.Union(members, { mode: "oneOf" })), {
            body: {},
          }),
        ).toBe("{}");
      }
      for (const members of [
        [encodedOnly, encodedOnly.pipe(Schema.brand("Alternate"))],
        [encodedOnly.pipe(Schema.brand("Alternate")), encodedOnly],
      ] as const) {
        // Neither constructor accepts {}; the encoded reader finds two matches.
        const request = post(Schema.Union(members, { mode: "oneOf" }));
        expect(yield* schemaFailure(request, { body: {} })).toBe(
          "Expected exactly one member to match",
        );
      }
    }),
  );

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
  it.effect("keeps fields in an empty struct member, in either order", () =>
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
        '{"tag":"a"}',
        '{"tag":"a"}',
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/275
  it.effect(
    "names a member's own error beside a valid alias, not the alias",
    () =>
      Effect.gen(function* () {
        const A = Schema.Struct({ a: Schema.Number });
        const member = 'Expected number\n  at ["extra"]["a"]';
        // The wire name is read under the decoded one, so only its name is lost to a comparison. The
        // decoded name is stripped where the whole value is read as encoded, and nothing shows that
        // the decoded side would keep it, so it is still named.
        for (const [filter, beside] of [
          [{ page_size: "05" }, ""],
          [
            { limit: 5 },
            '\nThe schema cannot keep this field with the rest of the value\n  at ["filter"]["limit"]',
          ],
        ] as const)
          for (const extra of [
            Schema.Union([Schema.Void, A]),
            Schema.Union([A, Schema.Void]),
          ]) {
            const schema = Schema.Struct({ extra, filter: Filter });
            const path = Request.get("").pipe(
              Request.path(schema, () => "/sent"),
            );
            const value = { extra: { a: "x" }, filter };
            const expected = member + beside;
            expect(
              yield* schemaFailure(post(schema), { body: value } as never),
            ).toBe(expected);
            expect(yield* schemaFailure(path, { path: value } as never)).toBe(
              expected,
            );
            // Where only the Void is tried, its own error names the field.
            expect(
              yield* schemaFailure(post(schema), {
                body: { extra: "x", filter },
              } as never),
            ).toBe('Expected void\n  at ["extra"]' + beside);
            expect(
              yield* bodyOf(post(schema), {
                body: { extra: { a: 1 }, filter },
              } as never),
            ).toBe('{"extra":{"a":1},"filter":{"page_size":"5"}}');
          }
        // Under a renamed key only the strict read reports the Void's error, so the field keeps the
        // generic message.
        const Renamed = Schema.Struct({ v: Schema.Void }).pipe(
          Schema.encodeKeys({ v: "w" }),
        );
        expect(
          yield* schemaFailure(post(Renamed), {
            body: { w: { a: 1 } },
          } as never),
        ).toBe(
          'The schema cannot keep this field with the rest of the value\n  at ["w"]',
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/275
  it.effect(
    "names a field given under both names beside a member's own error",
    () =>
      Effect.gen(function* () {
        const A = Schema.Struct({ a: Schema.Number });
        const twice =
          'This field is given under both "limit" and "page_size"; give it under one name\n  at ["filter"]["page_size"]';
        for (const extra of [
          Schema.Union([Schema.Void, A]),
          Schema.Union([A, Schema.Void]),
        ]) {
          const schema = Schema.Struct({ extra, filter: Filter });
          const path = Request.get("").pipe(
            Request.path(schema, () => "/sent"),
          );
          const filter = { limit: 5, page_size: "6" };
          // Correcting `extra` alone would not keep the filter, so both faults are named.
          for (const [value, expected] of [
            [
              { extra: { a: "x" }, filter },
              `Expected number\n  at ["extra"]["a"]\n${twice}`,
            ],
            [{ extra: { a: 1 }, filter }, twice],
          ] as const) {
            expect(
              yield* schemaFailure(post(schema), { body: value } as never),
            ).toBe(expected);
            expect(yield* schemaFailure(path, { path: value } as never)).toBe(
              expected,
            );
          }
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
        ).toContain('["page_filter"]');
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
  it.effect("names the invalid fields where a Void branch declines", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        extra: Schema.Union([Schema.Void, Schema.Struct({ a: Schema.Number })]),
        filter: Filter,
      });
      expect(
        yield* schemaFailure(post(schema), {
          body: { extra: { a: "x" }, filter: { page_size: "many" } },
        } as never),
      ).toContain('["extra"]["a"]');
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
      // A named field is content, not a cell, so Void declines the list. The list member then
      // leaves the field out as a key it does not state.
      expect(
        yield* bodyOf(request, { body: Object.assign([], { extra: true }) }),
      ).toBe("[]");
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
  it.effect("fills a populated struct constructor default beside Void", () =>
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
  it.effect("treats undefined-valued fields as absent before first fit", () =>
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
      expect(yield* bodyOf(optional, { body: { a: undefined } } as never)).toBe(
        "{}",
      );
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

describe("Void wherever a schema shows it", () => {
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
  it.effect("refuses a list beside a oneOf grouping of Void", () =>
    Effect.gen(function* () {
      const schema = Schema.Union([
        Schema.Array(Filter),
        Schema.Union([Schema.Struct({ cursor: Schema.String }), Schema.Void], {
          mode: "oneOf",
        }),
      ]);
      expect(yield* outcomes(schema, [{ page_size: "many" }])).toEqual([
        "refused",
        "refused",
      ]);
      expect(yield* outcomes(schema, [{ page_size: "05" }])).toEqual([
        '[{"page_size":"5"}]',
        '[{"page_size":"5"}]',
      ]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("refuses a hidden-cell list no member beside Void can read", () =>
    Effect.gen(function* () {
      // The struct cannot read a list, and since #237 it cannot take an index-keyed copy of one.
      for (const schema of [VoidLast, VoidFirst]) {
        const list = Object.defineProperty([1], 0, { enumerable: false });
        expect(yield* outcomes(schema, list)).toEqual(["refused", "refused"]);
      }
    }),
  );

  class FilterClass extends Schema.Class<FilterClass>("FilterClass")({
    limit: Schema.FiniteFromString,
  }) {}
  class ParentClass extends Schema.Class<ParentClass>("ParentClass")({
    filter: VoidFirst,
  }) {}

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps a class member beside Void, in either order", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Union([Schema.Void, FilterClass]),
        Schema.Union([FilterClass, Schema.Void]),
      ]) {
        expect(yield* bodyOf(post(schema), { body: { limit: 5 } })).toBe(
          '{"limit":"5"}',
        );
        expect(
          yield* schemaFailure(post(schema), {
            body: { limit: "many" },
          } as never),
        ).toContain('["limit"]');
        expect(yield* bodyOf(post(schema), { body: undefined })).toBe("null");
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps or refuses beside a Void in a class's field", () =>
    Effect.gen(function* () {
      class Acked extends Schema.Class<Acked>("Acked")({ ack: Schema.Void }) {}
      const Listed = Schema.Struct({ rows: Schema.Array(ParentClass) });
      for (const filter of [{ limit: 5 }, { page_size: "05" }])
        for (const [schema, body, sent] of [
          [ParentClass, { filter }, '{"filter":{"page_size":"5"}}'],
          [
            Listed,
            { rows: [{ filter: {} }, { filter }] },
            '{"rows":[{"filter":null},{"filter":{"page_size":"5"}}]}',
          ],
        ] as const)
          expect(
            yield* outcomes(schema as Schema.Codec<unknown, unknown>, body),
          ).toContain(sent);
      for (const [schema, body, at] of [
        [ParentClass, { filter: { page_size: "many" } }, 'at ["filter"]'],
        [Acked, { ack: { id: 1 } }, 'at ["ack"]'],
      ] as const)
        expect(
          yield* schemaFailure(post(schema as Schema.Codec<unknown>), {
            body: body as never,
          }),
        ).toContain(at);
      // A class with a Void is still built from nothing, as its own constructor does.
      class Optional extends Schema.Class<Optional>("Optional")({
        v: Schema.optionalKey(Schema.Void),
      }) {}
      for (const input of [undefined, {}, new Optional({})])
        expect(yield* outcomes(Optional, input)).toEqual(["{}", "{}"]);
      for (const body of [
        { filter: undefined },
        new ParentClass({ filter: undefined }),
      ])
        expect(yield* bodyOf(post(ParentClass), { body })).toBe(
          '{"filter":null}',
        );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps the one member beside Void that fits under oneOf", () =>
    Effect.gen(function* () {
      const OneOf = Schema.Union([Schema.Void, Filter], { mode: "oneOf" });
      for (const body of [{ page_size: "05" }, { limit: 5 }])
        expect(yield* bodyOf(post(OneOf), { body })).toBe('{"page_size":"5"}');
      expect(
        yield* schemaFailure(post(OneOf), { body: { page_size: "many" } }),
      ).toContain('["page_size"]');
      const oneOf = { mode: "oneOf" } as const;
      const Empty = Schema.Struct({});
      const nested = Schema.Union(
        [
          Schema.Union(
            [Schema.Void, Schema.Union([Empty, Schema.Struct({})])],
            oneOf,
          ),
          Schema.Void,
        ],
        oneOf,
      );
      expect(yield* outcomes(nested, ["x"])).toEqual(['["x"]', '["x"]']);
      const ambiguous = Schema.Union(
        [
          Schema.Void,
          Schema.Union(
            [Schema.Unknown, Schema.Struct({ t: Schema.Literal("A") })],
            oneOf,
          ),
        ],
        oneOf,
      );
      expect(yield* outcomes(ambiguous, { t: "A" })).toEqual([
        "refused",
        "refused",
      ]);
    }),
  );

  const Discard = Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Undefined, {
      decode: SchemaGetter.transform((_input: unknown) => undefined),
      encode: SchemaGetter.transform((_value: undefined): unknown => undefined),
    }),
  );
  const Custom = Schema.Union([Discard, Filter]);

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
  it.effect("keeps or refuses fields inside a suspended schema", () =>
    Effect.gen(function* () {
      interface Tree {
        readonly next: Tree | void;
        readonly limit?: number;
      }
      const Tree = Schema.Struct({
        next: Schema.Union([
          Schema.Void,
          Schema.suspend((): Schema.Codec<Tree, unknown> => Tree as never),
        ]),
        limit: Schema.optionalKey(Schema.FiniteFromString),
      }) as unknown as Schema.Codec<Tree, unknown>;
      expect(
        yield* bodyOf(post(Schema.suspend((): typeof VoidFirst => VoidFirst)), {
          body: { limit: 5 },
        }),
      ).toBe('{"page_size":"5"}');
      for (const schema of [
        Schema.Union([Schema.Void, Schema.suspend(() => Filter)]),
        Schema.Union([Schema.suspend(() => VoidFirst), Schema.Null]),
      ]) {
        expect(yield* bodyOf(post(schema), { body: { limit: 5 } })).toBe(
          '{"page_size":"5"}',
        );
        expect(
          yield* schemaFailure(post(schema), { body: { page_size: "many" } }),
        ).toContain('["page_size"]');
      }
      const tree = { next: { next: undefined, limit: 2 }, limit: 1 };
      expect(yield* bodyOf(post(Tree), { body: tree })).toBe(
        '{"next":{"next":null,"limit":"2"},"limit":"1"}',
      );
      expect(
        yield* schemaFailure(post(Tree), {
          body: { next: { next: { next: undefined, limit: "many" } } },
        } as never),
      ).toContain('["next"]');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("reads inside an opaque declaration as Effect does", () =>
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
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps an object beside an encoded member that holds Void", () =>
    Effect.gen(function* () {
      const member = Schema.Union([Schema.Void, Schema.Literal("a")]).pipe(
        Schema.encodeTo(Schema.Literal("a"), {
          decode: SchemaGetter.transform(() => undefined),
          encode: SchemaGetter.transform(() => "a" as const),
        }),
      );
      expect(
        yield* bodyOf(post(Schema.Union([member, Filter])), {
          body: { limit: 5 },
        }),
      ).toBe('{"page_size":"5"}');
    }),
  );

  it.effect("keeps or refuses a scalar or a built-in beside Void", () =>
    Effect.gen(function* () {
      const text = Schema.Union([Schema.Void, Schema.String]);
      const finite = Schema.Union([Schema.Void, Schema.FiniteFromString]);
      for (const [schema, value, sent] of [
        [text, "hello", '"hello"'],
        [text, "", '""'],
        [finite, "05", '"5"'],
        [finite, 5, '"5"'],
        [Schema.Union([Schema.Void, Schema.Boolean]), false, "false"],
        [
          Schema.Union([Filter, Schema.Void]),
          { page_size: "05" },
          '{"page_size":"5"}',
        ],
      ] as const) {
        expect(
          yield* outcomes(schema as Schema.Codec<unknown, unknown>, value),
        ).toEqual([sent, sent]);
        expect(
          yield* bodyOf(
            post(Schema.Struct({ v: schema }) as Schema.Codec<unknown>),
            { body: { v: value } },
          ),
        ).toBe(`{"v":${sent}}`);
      }
      for (const value of [
        5,
        0,
        "hello",
        false,
        1n,
        new Date(0),
        new Map([["a", 1]]),
        new Set([1]),
        /x/u,
      ])
        for (const schema of [
          Schema.Void,
          Schema.Union([Schema.Void, Schema.Null]),
          Schema.Union([Schema.Void, Schema.Struct({ a: Schema.String })]),
        ]) {
          expect(
            yield* outcomes(schema as Schema.Codec<unknown, unknown>, value),
          ).toEqual(["refused", "refused"]);
          expect(
            yield* schemaFailure(
              post(Schema.Struct({ v: schema }) as Schema.Codec<unknown>),
              { body: { v: value } },
            ),
          ).toContain('["v"]');
        }
    }),
  );

  it.effect("keeps or refuses a list's named field beside Void", () =>
    Effect.gen(function* () {
      const named = () => Object.assign([], { keep: 1 });
      // An open member holds the field, so the JSON writer refuses it rather than Void erasing it.
      for (const schema of [
        Schema.Union([Schema.Void, Schema.Unknown]),
        Schema.Union([Schema.Void, Schema.Struct({})]),
      ]) {
        const error = yield* Effect.flip(
          Request.compile(post(schema as Schema.Codec<unknown>), {
            body: named(),
          }),
        );
        expect(error._tag).toBe("HttpBodyError");
        expect(String(error)).toContain('$["keep"]');
      }
      expect(
        yield* schemaFailure(
          post(Schema.Struct({ ack: Schema.Void }) as Schema.Codec<unknown>),
          { body: { ack: named() } },
        ),
      ).toContain('["ack"]');
      expect(
        yield* schemaFailure(
          post(Schema.Struct({ ack: Schema.Void }) as Schema.Codec<unknown>),
          { body: { ack: Object.assign([], { [Symbol("s")]: 1 }) } },
        ),
      ).toContain('["ack"]');
      // An undefined named field holds nothing, and a list member leaves a key it does not state.
      expect(
        yield* bodyOf(
          post(Schema.Struct({ ack: Schema.Void }) as Schema.Codec<unknown>),
          { body: { ack: Object.assign([], { keep: undefined }) } },
        ),
      ).toBe('{"ack":null}');
      expect(
        yield* bodyOf(
          post(
            Schema.Union([
              Schema.Void,
              Schema.Array(Schema.Number),
            ]) as Schema.Codec<unknown>,
          ),
          { body: named() },
        ),
      ).toBe("[]");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("takes no other name or member for a Void's", () =>
    Effect.gen(function* () {
      // The output's `a` comes from the input's `b`, so nothing was erased.
      const swapped = Schema.Struct({
        a: Schema.Union([Schema.Struct({ x: Schema.Number }), Schema.Void]),
        b: Schema.Null,
      }).pipe(Schema.encodeKeys({ a: "b", b: "a" }));
      expect(
        yield* bodyOf(post(swapped), { body: { a: { x: 1 }, b: null } }),
      ).toBe('{"b":{"x":1},"a":null}');
      // A transformation that discards its input is the schema's own.
      let rendered: unknown = "nothing";
      yield* Request.compile(
        Request.get("").pipe(
          Request.path(Schema.Union([Discard, Schema.Void]), (value) => {
            rendered = value;
            return "/x";
          }),
        ),
        { path: { x: 1 } as never },
      );
      expect(rendered).toBeUndefined();
    }),
  );

  const RenamedVoid = Schema.Struct({ v: Schema.Void }).pipe(
    Schema.encodeKeys({ v: "w" }),
  );
  class RenamedAck extends Schema.Class<RenamedAck>("RenamedAck")(
    RenamedVoid as unknown as Schema.Struct<{ readonly v: typeof Schema.Void }>,
  ) {}

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("refuses an object or list no Void can keep, anywhere", () =>
    Effect.gen(function* () {
      const held = { limit: 5 };
      for (const [schema, body, at] of [
        [Schema.Void, held, "Expected void"],
        [Schema.Void, [1], "Expected void"],
        [Schema.Struct({ v: Schema.Void }), { v: held }, 'at ["v"]'],
        [Schema.Struct({ v: Schema.Void }), { v: [1] }, 'at ["v"]'],
        [Schema.Tuple([Schema.Void]), [held], "at [0]"],
        [Schema.Record(Schema.String, Schema.Void), { k: held }, 'at ["k"]'],
        [
          Schema.Record(
            Schema.String,
            Schema.Union([Schema.Void, Schema.Null]),
          ),
          { k: held },
          'at ["k"]',
        ],
        [RenamedVoid, { v: held }, 'at ["v"]'],
        [RenamedVoid, { w: held }, 'at ["w"]'],
        [RenamedAck, { w: held }, 'at ["w"]'],
      ] as const) {
        expect(yield* outcomes(schema as Schema.Codec<unknown>, body)).toEqual([
          "refused",
          "refused",
        ]);
        expect(
          yield* schemaFailure(post(schema as Schema.Codec<unknown>), {
            body: body as never,
          }),
        ).toContain(at);
      }
      // What holds nothing reads as Void reads it.
      for (const body of [undefined, null, {}, [], { a: undefined }])
        expect(yield* bodyOf(post(Schema.Void), { body } as never)).toBe(
          "null",
        );
    }),
  );
});
