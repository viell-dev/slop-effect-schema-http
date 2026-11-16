import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as Body from "./Body.js";
import { encodedInput } from "./internal/encoded-input.js";
import { nestedEncodedInput } from "./internal/nested-input.js";
import * as Request from "./Request.js";

const limit = Schema.optionalKey(Schema.FiniteFromString).pipe(
  Schema.withConstructorDefault(Effect.succeed(25)),
);
const Filter = Schema.Struct({ limit }).pipe(
  Schema.encodeKeys({ limit: "page_size" }),
);
const Cursor = Schema.Struct({ cursor: Schema.String });

const prepare = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  kind: "path" | "body",
) => {
  if (kind === "path") {
    let output: unknown;
    return Request.compile(
      Request.get("").pipe(
        Request.path(schema, (value) => {
          output = value;
          return "/prepared";
        }),
      ),
      { path: input as Request.Input<S> },
    ).pipe(Effect.map(() => output));
  }
  return Request.compile(
    Request.post("/x").pipe(Request.body(Body.jsonSchema(schema))),
    { body: input as Request.Input<S> },
  ).pipe(
    Effect.map(({ request }) => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON");
      return JSON.parse(new TextDecoder().decode(request.body.body)) as unknown;
    }),
  );
};

const shapes = [
  {
    name: "optional array",
    schema: Schema.Array(Schema.optional(Filter)),
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "nullable array",
    schema: Schema.Array(Schema.NullOr(Filter)),
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "nullish array",
    schema: Schema.Array(Schema.NullishOr(Filter)),
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "optional tuple",
    schema: Schema.Tuple([Schema.optional(Filter)]),
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "optional object ancestor",
    schema: Schema.Struct({
      cell: Schema.optional(Schema.Struct({ filter: Filter })),
    }),
    wrap: (leaf: object) => ({ cell: { filter: leaf } }),
  },
  {
    name: "nullable field",
    schema: Schema.Struct({ filter: Schema.NullOr(Filter) }),
    wrap: (leaf: object) => ({ filter: leaf }),
  },
  {
    name: "closed object alternatives beside null",
    schema: Schema.Array(Schema.Union([Filter, Cursor, Schema.Null])),
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "nullable root",
    schema: Schema.NullOr(Filter),
    wrap: (leaf: object) => leaf,
  },
] as const;

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("constructor defaults beside transparent primitive alternatives", () => {
  for (const kind of ["path", "body"] as const) {
    for (const { name, schema, wrap } of shapes) {
      it.effect(`${kind} refuses invalid aliases through ${name}`, () =>
        Effect.gen(function* () {
          for (const page_size of ["many", null])
            expect(
              yield* Effect.flip(prepare(schema, wrap({ page_size }), kind)),
            ).toBeInstanceOf(Schema.SchemaError);
        }),
      );
      it.effect(
        `${kind} retains valid and omitted controls through ${name}`,
        () =>
          Effect.gen(function* () {
            for (const leaf of [{ page_size: "05" }, { limit: 5 }])
              expect(yield* prepare(schema, wrap(leaf), kind)).toEqual(
                wrap({ page_size: "5" }),
              );
            expect(yield* prepare(schema, wrap({}), kind)).toEqual(
              wrap({ page_size: "25" }),
            );
          }),
      );
    }
  }

  const primitives = [
    ["String", Schema.String, true],
    ["Number", Schema.Number, true],
    ["Boolean", Schema.Boolean, true],
    ["BigInt", Schema.BigInt, true],
    ["Symbol", Schema.Symbol, false],
    [
      "UniqueSymbol",
      Schema.UniqueSymbol(Symbol.for("primitive-default")),
      false,
    ],
    ["Literal", Schema.Literal("x"), true],
    ["Enum", Schema.Enum({ Apple: "apple", Pear: 1 }), true],
    ["TemplateLiteral", Schema.TemplateLiteral(["a", Schema.String]), true],
    ["Null", Schema.Null, true],
    ["Undefined", Schema.Undefined, true],
    ["Never", Schema.Never, true],
  ] as const;
  for (const [name, primitive, json] of primitives) {
    const schema = Schema.Array(Schema.Union([primitive, Filter]));
    // Symbols have no JSON codec; path preparation exercises those alternatives.
    for (const kind of json
      ? (["path", "body"] as const)
      : (["path"] as const)) {
      it.effect(
        `${kind} refuses an invalid alias below a first ${name} alternative`,
        () =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(
                prepare(schema, [{ page_size: "many" }], kind),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
          }),
      );
      it.effect(
        `${kind} keeps controls below a first ${name} alternative`,
        () =>
          Effect.gen(function* () {
            for (const leaf of [{ page_size: "05" }, { limit: 5 }])
              expect(yield* prepare(schema, [leaf], kind)).toEqual([
                { page_size: "5" },
              ]);
            expect(yield* prepare(schema, [{}], kind)).toEqual([
              { page_size: "25" },
            ]);
          }),
      );
    }
  }

  it.effect(
    "preserves scalar and absent cells without inventing object fields",
    () =>
      Effect.gen(function* () {
        const mixed = Schema.Array(
          Schema.Union([
            Schema.String,
            Schema.Number,
            Schema.Null,
            Schema.Undefined,
            Filter,
          ]),
        );
        expect(
          yield* prepare(mixed, ["x", 3, null, undefined], "path"),
        ).toEqual(["x", 3, null, undefined]);
        expect(
          yield* prepare(
            Schema.Array(Schema.optional(Filter)),
            [undefined],
            "path",
          ),
        ).toEqual([undefined]);
        expect(
          yield* prepare(
            Schema.Tuple([Schema.optionalKey(Filter)]),
            [],
            "path",
          ),
        ).toEqual([]);
        for (const kind of ["path", "body"] as const) {
          expect(
            yield* prepare(mixed, [{ page_size: "05" }, "x"], kind),
          ).toEqual([{ page_size: "5" }, "x"]);
          expect(yield* prepare(shapes[4].schema, {}, kind)).toEqual({});
        }
      }),
  );

  const Gated = Schema.Struct({
    limit,
    gate: Schema.FiniteFromString,
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));

  it.effect(
    "keeps the successful nullable member's actual fieldwise reading",
    () =>
      Effect.gen(function* () {
        const schema = Schema.NullOr(
          Schema.Struct({
            filter: Filter,
            count: Schema.FiniteFromString,
            shared: Schema.StringFromBase64,
          }),
        );
        for (const kind of ["path", "body"] as const)
          expect(
            yield* prepare(
              schema,
              { filter: { page_size: "05" }, count: 7, shared: "eA==" },
              kind,
            ),
          ).toEqual({
            filter: { page_size: "5" },
            count: "7",
            shared: "ZUE9PQ==",
          });
      }),
  );

  for (const kind of ["path", "body"] as const) {
    it.effect(
      `${kind} refuses an invalid alias on a nullable root fieldwise route`,
      () =>
        Effect.gen(function* () {
          expect(
            yield* Effect.flip(
              prepare(
                Schema.NullOr(Gated),
                { page_size: "many", gate: "03" },
                kind,
              ),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(
            yield* Effect.flip(
              prepare(Gated, { page_size: "many", gate: "03" }, kind),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
        }),
    );
  }

  it.effect(
    "does not execute primitive checks during capture or replay constructor defaults",
    () =>
      Effect.gen(function* () {
        let checks = 0;
        let defaults = 0;
        const primitive = Schema.String.check(
          Schema.makeFilter(() => {
            checks++;
            return true;
          }),
        );
        const Counted = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                defaults++;
                return 25;
              }),
            ),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Array(Schema.Union([primitive, Counted]));
        const input = [{ page_size: "many" }];
        expect(
          nestedEncodedInput(schema.ast)!(input)
            ?.select([{ page_size: "25" }])
            ?.matches(),
        ).toBe(true);
        expect(checks).toBe(0);
        expect(defaults).toBe(0);
        for (const kind of ["path", "body"] as const) {
          defaults = 0;
          expect(
            yield* Effect.flip(prepare(schema, input, kind)),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(defaults).toBe(1);
          expect(checks).toBe(0);
        }
      }),
  );

  it("does not classify Void, encoded primitives or opaque alternatives as transparent", () => {
    const Count = Schema.Struct({ page_size: Schema.String }).pipe(
      Schema.decodeTo(
        Schema.Number,
        SchemaTransformation.transform({
          decode: (value) => value.page_size.length,
          encode: (value) => ({ page_size: "x".repeat(value) }),
        }),
      ),
    );
    for (const other of [
      Schema.Void,
      Schema.Unknown,
      Schema.Any,
      Schema.ObjectKeyword,
      Schema.Record(Schema.String, Schema.Unknown),
      Schema.Option(Schema.String),
      Schema.Date,
      Schema.suspend(() => Schema.String),
      Schema.FiniteFromString,
      Count,
      Schema.Array(Filter),
    ]) {
      const schema = Schema.Union([Filter, other]);
      expect(encodedInput(schema.ast)).toBeUndefined();
      expect(nestedEncodedInput(Schema.Array(schema).ast)).toBeUndefined();
    }
    expect(
      nestedEncodedInput(Schema.Array(Schema.fromJsonString(Filter)).ast),
    ).toBeUndefined();
  });

  // Effect's own Literals, NullOr and NullishOr build these nested unions.
  const nestedPrimitives = [
    ["Union(String, Number)", Schema.Union([Schema.String, Schema.Number])],
    ["Literals", Schema.Literals(["all", "none"])],
    ["NullOr(String)", Schema.NullOr(Schema.String)],
    ["NullishOr(Number)", Schema.NullishOr(Schema.Number)],
    [
      "doubly nested",
      Schema.Union([Schema.Literals(["all"]), Schema.NullOr(Schema.Boolean)]),
    ],
    [
      "checked Literals",
      Schema.Literals(["all", "none"]).check(Schema.makeFilter(() => true)),
    ],
    ["oneOf", Schema.Union([Schema.String, Schema.Number], { mode: "oneOf" })],
    ["empty Literals", Schema.Literals([])],
  ] as const;
  for (const [name, primitive] of nestedPrimitives) {
    const root = Schema.Union([primitive, Filter]);
    const objectFirst = Schema.Union([Filter, primitive]);
    const terminal = Schema.Array(root);
    const ancestor = Schema.Struct({
      cell: Schema.Union([primitive, Schema.Struct({ filter: Filter })]),
    });
    for (const kind of ["path", "body"] as const) {
      it.effect(
        `${kind} refuses invalid aliases beside a nested ${name} alternative at every level`,
        () =>
          Effect.gen(function* () {
            for (const page_size of ["many", null]) {
              for (const schema of [root, objectFirst])
                expect(
                  yield* Effect.flip(prepare(schema, { page_size }, kind)),
                ).toBeInstanceOf(Schema.SchemaError);
              expect(
                yield* Effect.flip(prepare(terminal, [{ page_size }], kind)),
              ).toBeInstanceOf(Schema.SchemaError);
              expect(
                yield* Effect.flip(
                  prepare(ancestor, { cell: { filter: { page_size } } }, kind),
                ),
              ).toBeInstanceOf(Schema.SchemaError);
            }
          }),
      );
      it.effect(
        `${kind} keeps controls beside a nested ${name} alternative at every level`,
        () =>
          Effect.gen(function* () {
            for (const [leaf, expected] of [
              [{ page_size: "05" }, "5"],
              [{ limit: 5 }, "5"],
              [{}, "25"],
            ] as const) {
              for (const schema of [root, objectFirst])
                expect(yield* prepare(schema, leaf, kind)).toEqual({
                  page_size: expected,
                });
              expect(yield* prepare(terminal, [leaf], kind)).toEqual([
                { page_size: expected },
              ]);
              expect(
                yield* prepare(ancestor, { cell: { filter: leaf } }, kind),
              ).toEqual({ cell: { filter: { page_size: expected } } });
            }
          }),
      );
    }
  }

  it.effect(
    "keeps scalar values of a nested primitive alternative unchanged",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Array(
          Schema.Union([Schema.Literals(["all", "none"]), Filter]),
        );
        for (const kind of ["path", "body"] as const)
          expect(
            yield* prepare(schema, ["all", { page_size: "05" }, "none"], kind),
          ).toEqual(["all", { page_size: "5" }, "none"]);
        expect(
          yield* prepare(
            Schema.Array(Schema.Union([Schema.NullOr(Schema.String), Filter])),
            [null, "x", {}],
            "path",
          ),
        ).toEqual([null, "x", { page_size: "25" }]);
      }),
  );

  // An encoded union can read an object on its encoded side, so encoding alone excludes it.
  const ObjectToText = Schema.Struct({ page_size: Schema.String }).pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.String),
      SchemaTransformation.transform<
        string | null,
        { readonly page_size: string }
      >({
        decode: (value) => value.page_size,
        encode: (value) => ({ page_size: value ?? "" }),
      }),
    ),
  );
  const TextToText = Schema.String.pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.String),
      SchemaTransformation.transform<string | null, string>({
        decode: (value) => (value === "" ? null : value),
        encode: (value) => value ?? "",
      }),
    ),
  );

  it("keeps a nested union outside the rule unless every member qualifies unencoded", () => {
    for (const other of [
      Schema.Union([Schema.String, Schema.Void]),
      Schema.Union([Schema.String, Schema.FiniteFromString]),
      Schema.NullOr(Schema.Unknown),
      Schema.Union([Schema.String, Schema.suspend(() => Schema.Number)]),
      ObjectToText,
      TextToText,
    ]) {
      const schema = Schema.Union([Filter, other]);
      expect(encodedInput(schema.ast)).toBeUndefined();
      expect(nestedEncodedInput(Schema.Array(schema).ast)).toBeUndefined();
    }
    for (const primitive of nestedPrimitives.map(([, schema]) => schema)) {
      // A union of primitives alone is still no object view at either level.
      expect(encodedInput(primitive.ast)).toBeUndefined();
      expect(
        encodedInput(Schema.Union([primitive, Schema.Null]).ast),
      ).toBeUndefined();
      expect(
        nestedEncodedInput(Schema.Array(Schema.Union([primitive])).ast),
      ).toBeUndefined();
    }
    // A closed empty object is an object alternative, even though it declares no fields.
    expect(
      nestedEncodedInput(
        Schema.Struct({
          cell: Schema.Union([
            Schema.Struct({}),
            Schema.Struct({ filter: Filter }),
          ]),
        }).ast,
      ),
    ).toBeDefined();
  });

  it("declines a mutated primitive union cycle and visits shared members once", () => {
    const loop = new SchemaAST.Union([Schema.String.ast]);
    Object.assign(loop, { types: [Schema.String.ast, loop] });
    expect(
      encodedInput(new SchemaAST.Union([Filter.ast, loop])),
    ).toBeUndefined();
    expect(
      nestedEncodedInput(
        new SchemaAST.Union([Schema.Struct({ filter: Filter }).ast, loop]),
      ),
    ).toBeUndefined();
    // Forty levels of shared members would take 2^40 visits without the memo.
    let shared: SchemaAST.AST = Schema.Literal("x").ast;
    for (let level = 0; level < 40; level++)
      shared = new SchemaAST.Union([shared, Schema.Null.ast, shared]);
    expect(
      encodedInput(new SchemaAST.Union([Filter.ast, shared])),
    ).toBeDefined();
  });

  it.effect(
    "lets an object-reading encoded union alternative keep the alias it reads",
    () =>
      Effect.gen(function* () {
        // The second member reads { page_size } on its encoded side, so it can hold invalid
        // text that Filter refuses. Its own reading applies, as it did before.
        const schema = Schema.Array(Schema.Union([Filter, ObjectToText]));
        for (const kind of ["path", "body"] as const) {
          expect(yield* prepare(schema, [{ page_size: "05" }], kind)).toEqual([
            { page_size: "5" },
          ]);
          expect(yield* prepare(schema, [{ page_size: "many" }], kind)).toEqual(
            [{ page_size: "many" }],
          );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "currently substitutes defaults beside encoded primitive alternatives",
    () =>
      Effect.gen(function* () {
        for (const other of [TextToText, Schema.FiniteFromString])
          for (const kind of ["path", "body"] as const) {
            const schema = Schema.Array(Schema.Union([Filter, other]));
            expect(
              yield* prepare(schema, [{ page_size: "many" }], kind),
            ).toEqual([{ page_size: "25" }]);
            expect(yield* prepare(schema, [{ page_size: "05" }], kind)).toEqual(
              [{ page_size: "5" }],
            );
          }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect.fails(
    "refuses invalid aliases beside encoded primitive alternatives",
    () =>
      Effect.gen(function* () {
        for (const other of [TextToText, Schema.FiniteFromString])
          expect(
            yield* Effect.flip(
              prepare(
                Schema.Array(Schema.Union([Filter, other])),
                [{ page_size: "many" }],
                "path",
              ),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  it.effect(
    "validates an alias through a nullable closed object encoding view",
    () =>
      Effect.gen(function* () {
        const schema = Schema.NullOr(
          Schema.Struct({ page_size: Schema.String }),
        ).pipe(
          Schema.decodeTo(
            Schema.Struct({
              limit: Schema.optionalKey(Schema.Number).pipe(
                Schema.withConstructorDefault(Effect.succeed(25)),
              ),
            }),
            SchemaTransformation.transformEffect<
              { readonly limit?: number },
              { readonly page_size: string } | null
            >({
              decode: (value) =>
                value === null || Number.isNaN(Number(value.page_size))
                  ? Effect.fail(
                      new SchemaIssue.InvalidValue({ message: "not a number" }),
                    )
                  : Effect.succeed({ limit: Number(value.page_size) }),
              encode: (value) =>
                Effect.succeed({ page_size: String(value.limit) }),
            }),
          ),
        );
        expect(encodedInput(schema.ast)).toBeDefined();
        for (const kind of ["path", "body"] as const) {
          expect(
            yield* Effect.flip(prepare(schema, { page_size: "many" }, kind)),
          ).toBeInstanceOf(Schema.SchemaError);
          for (const [input, expected] of [
            [{ page_size: "05" }, "5"],
            [{ limit: 5 }, "5"],
            [{}, "25"],
          ] as const)
            expect(yield* prepare(schema, input, kind)).toEqual({
              page_size: expected,
            });
        }
      }),
  );

  it.effect(
    "validates an alias through a closed object encoding view beside nested literals",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Union([
          Schema.Struct({ page_size: Schema.String }),
          Schema.Literals(["none"]),
        ]).pipe(
          Schema.decodeTo(
            Schema.Struct({
              limit: Schema.optionalKey(Schema.Number).pipe(
                Schema.withConstructorDefault(Effect.succeed(25)),
              ),
            }),
            SchemaTransformation.transformEffect<
              { readonly limit?: number },
              { readonly page_size: string } | "none"
            >({
              decode: (value) =>
                value === "none" || Number.isNaN(Number(value.page_size))
                  ? Effect.fail(
                      new SchemaIssue.InvalidValue({ message: "not a number" }),
                    )
                  : Effect.succeed({ limit: Number(value.page_size) }),
              encode: (value) =>
                Effect.succeed({ page_size: String(value.limit) }),
            }),
          ),
        );
        expect(encodedInput(schema.ast)).toBeDefined();
        for (const kind of ["path", "body"] as const) {
          expect(
            yield* Effect.flip(prepare(schema, { page_size: "many" }, kind)),
          ).toBeInstanceOf(Schema.SchemaError);
          for (const [input, expected] of [
            [{ page_size: "05" }, "5"],
            [{ limit: 5 }, "5"],
            [{}, "25"],
          ] as const)
            expect(yield* prepare(schema, input, kind)).toEqual({
              page_size: expected,
            });
        }
      }),
  );

  it.effect(
    "keeps a primitive-only union encoding intermediate outside the object proof",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({ page_size: Schema.String }).pipe(
          Schema.decodeTo(
            Schema.NullOr(Schema.String),
            SchemaTransformation.transform<
              string | null,
              { readonly page_size: string }
            >({
              decode: (value) => value.page_size,
              encode: (value) => ({ page_size: value ?? "" }),
            }),
          ),
          Schema.decodeTo(
            Schema.Struct({
              limit: Schema.optionalKey(Schema.Number).pipe(
                Schema.withConstructorDefault(Effect.succeed(25)),
              ),
            }),
            SchemaTransformation.transformEffect<
              { readonly limit?: number },
              string | null
            >({
              decode: (value) =>
                value === null || Number.isNaN(Number(value))
                  ? Effect.fail(
                      new SchemaIssue.InvalidValue({ message: "not a number" }),
                    )
                  : Effect.succeed({ limit: Number(value) }),
              encode: (value) => Effect.succeed(String(value.limit)),
            }),
          ),
        );
        expect(encodedInput(schema.ast)).toBeUndefined();
        expect(nestedEncodedInput(Schema.Array(schema).ast)).toBeUndefined();
        for (const kind of ["path", "body"] as const)
          for (const [input, expected] of [
            [{ page_size: "many" }, "25"],
            [{ page_size: "05" }, "5"],
            [{}, "25"],
          ] as const)
            expect(yield* prepare(schema, input, kind)).toEqual({
              page_size: expected,
            });
      }),
  );

  it.effect(
    "keeps the schema's own reading for Void, open and object-encoded primitive alternatives",
    () =>
      Effect.gen(function* () {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        expect(
          yield* prepare(
            Schema.Array(Schema.Union([Filter, Schema.Void])),
            [{ page_size: "many" }],
            "path",
          ),
        ).toEqual([undefined]);
        for (const other of [
          Schema.Unknown,
          Schema.Any,
          Schema.ObjectKeyword,
          Schema.Record(Schema.String, Schema.Unknown),
        ])
          expect(
            yield* prepare(
              Schema.Array(Schema.Union([other, Filter])),
              [{ page_size: "many" }],
              "path",
            ),
          ).toEqual([{ page_size: "many" }]);
        const Count = Schema.Struct({ page_size: Schema.String }).pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transform({
              decode: (value) => value.page_size.length,
              encode: (value) => ({ page_size: "x".repeat(value) }),
            }),
          ),
        );
        expect(
          yield* prepare(
            Schema.Array(Schema.Union([Filter, Count])),
            [{ page_size: "many" }],
            "path",
          ),
        ).toEqual([{ page_size: "xxxx" }]);
      }),
  );
});
