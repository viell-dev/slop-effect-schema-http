import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
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
