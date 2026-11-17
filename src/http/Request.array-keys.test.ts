import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, SchemaTransformation } from "effect";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

const prepare = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  binding: "path" | "body",
) => {
  if (binding === "path") {
    let rendered: unknown;
    return Request.compile(
      Request.get("/probe").pipe(
        Request.path(schema, (value) => {
          rendered = value;
          return "/ok";
        }),
      ),
      { path: input as Request.Input<S> },
    ).pipe(Effect.map(() => rendered));
  }
  return Request.compile(
    Request.post("/probe").pipe(Request.body(Body.jsonSchema(schema))),
    { body: input as Request.Input<S> },
  ).pipe(
    Effect.map(({ request }) => {
      expect(request.body._tag).toBe("Uint8Array");
      return request.body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
        : undefined;
    }),
  );
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/189
// https://github.com/viell-dev/slop-effect-schema-http/issues/191
describe("array key normalization during request preparation", () => {
  for (const binding of ["path", "body"] as const) {
    for (const key of [Symbol.iterator, Symbol.toStringTag, Symbol("audit")]) {
      it.effect(`${binding} reads valid cells beside ${String(key)}`, () =>
        Effect.gen(function* () {
          let iterations = 0;
          const metadata =
            key === Symbol.iterator
              ? function* () {
                  iterations++;
                  yield { limit: 99 };
                }
              : "metadata";
          for (const leaf of [
            { page_size: "05" },
            { limit: 5 },
            { page_size: "05", stray: "ignored" },
          ]) {
            const input = [leaf];
            Object.defineProperty(input, key, {
              value: metadata,
              enumerable: true,
            });
            expect(
              yield* prepare(Schema.Array(Filter), input, binding),
            ).toEqual([{ page_size: "5" }]);
            expect(input).toHaveLength(1);
            expect(Object.getOwnPropertyDescriptor(input, key)?.value).toBe(
              metadata,
            );
          }
          expect(iterations).toBe(0);
        }),
      );

      // https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6737040870
      it.effect(`${binding} refuses invalid cells beside ${String(key)}`, () =>
        Effect.gen(function* () {
          for (const invalid of ["many", null]) {
            const input = [{ page_size: invalid, stray: "ignored" }];
            Object.defineProperty(input, key, {
              value:
                key === Symbol.iterator ? Array.prototype[Symbol.iterator] : 7,
              enumerable: true,
            });
            expect(
              yield* Effect.flip(prepare(Schema.Array(Filter), input, binding)),
            ).toBeInstanceOf(Schema.SchemaError);
          }
        }),
      );
    }

    it.effect(`${binding} retains sparse, hidden and inherited positions`, () =>
      Effect.gen(function* () {
        for (const layout of ["sparse", "hidden", "inherited"] as const) {
          const input: Array<object> = [];
          input.length = layout === "sparse" ? 4 : 2;
          input[1] = { page_size: "05", stray: "ignored" };
          const first = { page_size: "07" };
          if (layout === "hidden")
            Object.defineProperty(input, "0", { value: first });
          if (layout === "inherited")
            Object.setPrototypeOf(
              input,
              Object.create(Array.prototype, { "0": { value: first } }),
            );
          const schema =
            layout === "sparse"
              ? Schema.Array(Schema.optional(Filter))
              : Schema.Array(Filter);
          const output = yield* prepare(schema, input, binding);
          // JSON serializes array holes as null; path rendering retains the schema's undefined.
          expect(output).toEqual(
            layout === "sparse"
              ? binding === "body"
                ? [null, { page_size: "5" }, null, null]
                : [undefined, { page_size: "5" }, undefined, undefined]
              : [{ page_size: "7" }, { page_size: "5" }],
          );
          expect(input).toHaveLength(layout === "sparse" ? 4 : 2);
          expect(Object.hasOwn(input, "0")).toBe(layout === "hidden");
          expect(input[1]).toHaveProperty("stray", "ignored");
        }
      }),
    );
  }

  it.effect("retains an original getter defect", () =>
    Effect.gen(function* () {
      const defect = new Error("metadata getter failed");
      const input = [{ page_size: "05" }];
      Object.defineProperty(input, Symbol("audit"), {
        enumerable: true,
        get() {
          throw defect;
        },
      });
      const exit = yield* Effect.exit(
        prepare(Schema.Array(Filter), input, "body"),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toMatchObject([{ _tag: "Die", defect }]);
    }),
  );

  it.effect("keeps dense proxy input whose prototype inspection fails", () =>
    Effect.gen(function* () {
      for (const binding of ["path", "body"] as const)
        for (const stray of [false, true]) {
          const leaf = stray
            ? { page_size: "05", stray: "ignored" }
            : { page_size: "05" };
          const input = new Proxy([leaf], {
            getPrototypeOf() {
              throw new Error("prototype inspection failed");
            },
          });
          expect(yield* prepare(Schema.Array(Filter), input, binding)).toEqual([
            { page_size: "5" },
          ]);
        }
    }),
  );

  it.effect("leaves an opaque array's layout to its schema", () =>
    Effect.gen(function* () {
      const input = new Proxy(["opaque"], {
        get(target, key, receiver) {
          if (key === "length") throw new Error("opaque length inspected");
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf() {
          throw new Error("opaque prototype inspected");
        },
      });
      const schema = Schema.Struct({
        values: Schema.Unknown,
        count: Schema.FiniteFromString,
        tag: Schema.optionalKey(Schema.String),
      }).pipe(Schema.encodeKeys({ tag: "TAG" }));
      let rendered: unknown;
      yield* Request.compile(
        Request.get("/opaque").pipe(
          Request.path(schema, (value) => {
            rendered = value.values;
            return "/ok";
          }),
        ),
        { path: { values: input, count: "05" } },
      );
      expect(rendered).toBe(input);
    }),
  );

  it.effect("keeps opaque union winners' hidden and inherited cells", () =>
    Effect.gen(function* () {
      const cellSchema = Schema.Struct({ value: Schema.Number }).pipe(
        Schema.encodeKeys({ value: "VALUE" }),
      );
      const array = Schema.Array(cellSchema);
      for (const child of [
        Schema.Union([Schema.Unknown, array]),
        Schema.Union([Schema.Any, array]),
        Schema.Union([Schema.ObjectKeyword, array]),
        Schema.Union([Schema.declare(Array.isArray), array]),
        Schema.Union([array, Schema.Unknown]),
      ]) {
        const parent = Schema.Struct({
          values: child,
          count: Schema.FiniteFromString,
          tag: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ tag: "TAG" }));
        for (const inherited of [false, true]) {
          const cell = { VALUE: 5, additional: "retain" };
          const values: Array<object> = [];
          values.length = 1;
          if (inherited)
            Object.setPrototypeOf(
              values,
              Object.create(Array.prototype, { "0": { value: cell } }),
            );
          else Object.defineProperty(values, "0", { value: cell });
          const rendered = (yield* prepare(
            parent,
            { values, count: "05" },
            "path",
          )) as { readonly values: ReadonlyArray<unknown> };
          expect(rendered.values).toBe(values);
          expect(rendered.values[0]).toBe(cell);
        }
      }
    }),
  );

  it.effect(
    "retains a mixed view's old length-getter boundary during a rewrite",
    () =>
      Effect.gen(function* () {
        const cell = Schema.Struct({ value: Schema.Number }).pipe(
          Schema.encodeKeys({ value: "VALUE" }),
        );
        for (const stray of [false, true]) {
          let lengthReads = 0;
          const input = new Proxy(
            [stray ? { VALUE: 5, extra: "ignored" } : { VALUE: 5 }],
            {
              get(target, key, receiver) {
                if (key === "length") {
                  lengthReads++;
                  throw new Error("opaque length inspected");
                }
                return Reflect.get(target, key, receiver);
              },
            },
          );
          const schema = Schema.Struct({
            values: Schema.Union([Schema.Unknown, Schema.Array(cell)]),
            count: Schema.FiniteFromString,
            tag: Schema.optionalKey(Schema.String),
          }).pipe(Schema.encodeKeys({ tag: "TAG" }));
          const rendered = (yield* prepare(
            schema,
            { values: input, count: "05" },
            "path",
          )) as { readonly values: ReadonlyArray<unknown> };
          if (stray) {
            expect(rendered.values.length).toBe(1);
            expect(rendered.values[0]).toEqual({ VALUE: 5 });
          } else expect(rendered.values).toBe(input);
          expect(lengthReads).toBe(0);
        }
      }),
  );

  it.effect(
    "still validates an array after an opaque alternative rejects",
    () =>
      Effect.gen(function* () {
        const cell = Schema.Struct({ value: Schema.Number }).pipe(
          Schema.encodeKeys({ value: "VALUE" }),
        );
        for (const declaration of [false, true]) {
          let checks = 0;
          const reject = () => {
            checks++;
            return false;
          };
          const opaque = declaration
            ? Schema.declare((_value: unknown): _value is unknown => reject())
            : Schema.Unknown.check(Schema.makeFilter(reject));
          const schema = Schema.Struct({
            values: Schema.Union([opaque, Schema.Array(cell)]),
            count: Schema.FiniteFromString,
            tag: Schema.optionalKey(Schema.String),
          }).pipe(Schema.encodeKeys({ tag: "TAG" }));
          for (const binding of ["path", "body"] as const) {
            const valid = [{ VALUE: 5, extra: "ignored" }];
            Object.defineProperty(valid, "audit", {
              value: "metadata",
              enumerable: true,
            });
            expect(
              yield* prepare(schema, { values: valid, count: "05" }, binding),
            ).toEqual({ values: [{ VALUE: 5 }], count: "5" });
            const invalid = [{ VALUE: "invalid", extra: "ignored" }];
            Object.defineProperty(invalid, "audit", {
              value: "metadata",
              enumerable: true,
            });
            expect(
              yield* Effect.flip(
                prepare(schema, { values: invalid, count: "05" }, binding),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
          }
          expect(checks).toBeGreaterThan(0);
        }
      }),
  );

  it.effect(
    "does not inspect prototypes through an array-backed declaration",
    () =>
      Effect.gen(function* () {
        type Values = ReadonlyArray<{ readonly value: number }>;
        const cell = Schema.Struct({ value: Schema.Number }).pipe(
          Schema.encodeKeys({ value: "VALUE" }),
        );
        const child = Schema.Array(cell).pipe(
          Schema.decodeTo(
            Schema.declare((value: unknown): value is Values =>
              Array.isArray(value),
            ),
            SchemaTransformation.transform<Values, Values>({
              decode: (value) => value,
              encode: () => [{ value: 9 }],
            }),
          ),
        );
        const target: Array<object> = [];
        target.length = 2;
        target[1] = { VALUE: 5 };
        const values = new Proxy(target, {
          getPrototypeOf() {
            throw new Error("opaque prototype inspected");
          },
        });
        const schema = Schema.Struct({
          values: child,
          count: Schema.FiniteFromString,
          tag: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ tag: "TAG" }));
        expect(yield* prepare(schema, { values, count: "05" }, "path")).toEqual(
          { values: [{ VALUE: 9 }], count: "5" },
        );
      }),
  );

  it.effect(
    "refuses an incoherent virtual position instead of enlarging input",
    () =>
      Effect.gen(function* () {
        const ghost = { page_size: "07" };
        const input = new Proxy([{ page_size: "05", stray: "ignored" }], {
          ownKeys(target) {
            return [...Reflect.ownKeys(target), "1000"];
          },
          getOwnPropertyDescriptor(target, key) {
            return key === "1000"
              ? {
                  value: ghost,
                  enumerable: true,
                  configurable: true,
                  writable: true,
                }
              : Reflect.getOwnPropertyDescriptor(target, key);
          },
          get(target, key, receiver) {
            return key === "1000" ? ghost : Reflect.get(target, key, receiver);
          },
        });
        for (const binding of ["path", "body"] as const)
          expect(
            yield* Effect.flip(
              prepare(Schema.Array(Schema.optional(Filter)), input, binding),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
        expect(input.length).toBe(1);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses an invalid sparse alias after an inner rewrite", () =>
    Effect.gen(function* () {
      const input: Array<object> = [];
      input.length = 2;
      input[1] = { page_size: "many", stray: "ignored" };
      expect(
        yield* Effect.flip(
          prepare(Schema.Array(Schema.optional(Filter)), input, "body"),
        ),
      ).toBeInstanceOf(Schema.SchemaError);
      expect(Object.hasOwn(input, "0")).toBe(false);
    }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/237
describe("a caller's list beside a record member", () => {
  const Plain = Schema.Struct({ limit: Schema.optionalKey(Schema.String) });
  const Open = Schema.Record(Schema.String, Schema.Unknown);
  const plainUnions = [
    Schema.Union([Schema.Array(Plain), Open]),
    Schema.Union([Open, Schema.Array(Plain)]),
  ];
  const filterUnions = [
    Schema.Union([Schema.Array(Filter), Open]),
    Schema.Union([Open, Schema.Array(Filter)]),
  ];
  /** A success's value, or the refusal; anything else stays a failure of the test. */
  const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.match(effect, {
      onFailure: (error) =>
        error instanceof Schema.SchemaError ? ("refused" as const) : error,
      onSuccess: (value) => ({ value }),
    });
  // The types refuse a list for a record and each invalid item, so these come in wider values.
  const prepared = (schema: Schema.Top, input: unknown) =>
    Effect.forEach(["path", "body"] as const, (binding) =>
      outcome(prepare(schema, input, binding)),
    );
  const refused = ["refused", "refused"];
  const kept = (value: unknown) => [{ value }, { value }];

  it.effect("refuses an item its list member refuses, in either order", () =>
    Effect.gen(function* () {
      for (const [unions, list, input] of [
        [plainUnions, Schema.Array(Plain), [{ limit: 5 }]],
        [filterUnions, Schema.Array(Filter), [{ limit: "x" }]],
        [filterUnions, Schema.Array(Filter), [{ limit: "05" }]],
      ] as const) {
        expect(yield* prepared(list, input)).toEqual(refused);
        for (const schema of unions)
          expect(yield* prepared(schema, input)).toEqual(refused);
      }
    }),
  );

  it.effect("refuses a key that only the record's open values state", () =>
    Effect.gen(function* () {
      // Alone, the list member strips a key it does not state. Beside a record of unknown values
      // the key is stated, so the list member would lose it, and a field no member keeps refuses.
      for (const input of [[{ page_size: "05" }], [{ page_size: "many" }]]) {
        expect(yield* prepared(Schema.Array(Plain), input)).toEqual(kept([{}]));
        for (const schema of plainUnions)
          expect(yield* prepared(schema, input)).toEqual(refused);
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "currently retains the default for an invalid alias in the list",
    () =>
      Effect.gen(function* () {
        expect(
          yield* prepared(Schema.Array(Filter), [{ page_size: "many" }]),
        ).toEqual(refused);
        for (const schema of filterUnions)
          expect(yield* prepared(schema, [{ page_size: "many" }])).toEqual(
            kept([{ page_size: "25" }]),
          );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect.fails("refuses an invalid alias in the list", () =>
    Effect.gen(function* () {
      for (const schema of filterUnions)
        expect(yield* prepared(schema, [{ page_size: "many" }])).toEqual(
          refused,
        );
    }),
  );

  it.effect("keeps valid lists, and objects with index-like keys", () =>
    Effect.gen(function* () {
      const objects = [Open, ...plainUnions, ...filterUnions];
      for (const [schemas, input, output] of [
        [
          [Schema.Array(Plain), ...plainUnions],
          [{ limit: "x" }],
          [{ limit: "x" }],
        ],
        [
          [Schema.Array(Filter), ...filterUnions],
          [{ page_size: "05" }],
          [{ page_size: "5" }],
        ],
        [
          [Schema.Array(Filter), ...filterUnions],
          [{ limit: 5 }],
          [{ page_size: "5" }],
        ],
        [objects, { 0: { page_size: "05" } }, { 0: { page_size: "05" } }],
        [objects, { 0: { limit: 5 }, 1: [] }, { 0: { limit: 5 }, 1: [] }],
      ] as const)
        for (const schema of schemas)
          expect(yield* prepared(schema, input)).toEqual(kept(output));
    }),
  );

  it.effect("reads a nested list the same way", () =>
    Effect.gen(function* () {
      const union = filterUnions[0]!;
      for (const schema of [
        Schema.Struct({ items: union }),
        Schema.Union([
          Schema.Struct({ items: Schema.Array(Filter) }),
          Schema.Struct({ items: Open }),
        ]),
      ]) {
        expect(yield* prepared(schema, { items: [{ limit: "x" }] })).toEqual(
          refused,
        );
        expect(yield* prepared(schema, { items: [{ limit: 5 }] })).toEqual(
          kept({ items: [{ page_size: "5" }] }),
        );
        expect(yield* prepared(schema, { items: { 0: { limit: 5 } } })).toEqual(
          kept({ items: { 0: { limit: 5 } } }),
        );
      }
      const elements = Schema.Array(union);
      expect(yield* prepared(elements, [[{ limit: "x" }]])).toEqual(refused);
      expect(
        yield* prepared(elements, [[{ limit: 5 }], { 0: { limit: 5 } }]),
      ).toEqual(kept([[{ page_size: "5" }], { 0: { limit: 5 } }]));
    }),
  );

  it.effect("refuses a list given to a record", () =>
    Effect.gen(function* () {
      // Effect's record refuses an actual array, as the types do.
      expect(
        Exit.isFailure(Schema.decodeUnknownExit(Open)([{ limit: "x" }])),
      ).toBe(true);
      for (const input of [[{ limit: "x" }], []])
        expect(yield* prepared(Open, input)).toEqual(refused);
    }),
  );

  it.effect("refuses such a list as a query or header group", () =>
    Effect.gen(function* () {
      const Pairs = Schema.Union([
        Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
        Schema.Record(Schema.String, Schema.Array(Schema.String)),
      ]);
      const query = (value: unknown) =>
        outcome(
          Effect.map(
            Request.compile(Request.get("/q").pipe(Request.query(Pairs)), {
              query: value as never,
            }),
            ({ request }) => request.url,
          ),
        );
      const headers = (value: unknown) =>
        outcome(
          Effect.map(
            Request.compile(Request.get("/h").pipe(Request.headers(Pairs)), {
              headers: value as never,
            }),
            ({ headerLines }) => headerLines,
          ),
        );
      expect(yield* query([["a", "b", "c"]])).toBe("refused");
      expect(yield* query([["a", "b"]])).toEqual({ value: "/q?a=b" });
      expect(yield* query({ a: ["x", "y"] })).toEqual({ value: "/q?a=x&a=y" });
      expect(yield* headers([["x-a", "1", "2"]])).toBe("refused");
      expect(yield* headers([["x-a", "1"]])).toEqual({
        value: [["x-a", "1"]],
      });
      expect(yield* headers({ "x-a": ["1", "2"] })).toEqual({
        value: [
          ["x-a", "1"],
          ["x-a", "2"],
        ],
      });
    }),
  );

  it.effect("decides by the list itself, without reading its contents", () =>
    Effect.gen(function* () {
      const union = plainUnions[0]!;
      let iterations = 0;
      const lists = (item: object) => {
        const sparse: Array<object> = [];
        sparse.length = 2;
        sparse[1] = item;
        return {
          extra: Object.assign([item], { extra: "metadata" }),
          sparse,
          bare: Object.setPrototypeOf([item], null) as Array<object>,
          iterable: Object.defineProperty([item], Symbol.iterator, {
            value: function* () {
              iterations++;
              yield item;
            },
            enumerable: true,
          }),
        };
      };
      for (const [name, input] of Object.entries(lists({ limit: 5 })))
        expect(yield* prepared(union, input), name).toEqual(refused);
      for (const [name, input] of Object.entries(lists({ limit: "x" })))
        expect(yield* prepared(union, input), name).toEqual(
          yield* prepared(Schema.Array(Plain), input),
        );
      expect(iterations).toBe(0);
    }),
  );
});
