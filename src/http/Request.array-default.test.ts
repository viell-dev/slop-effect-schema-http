import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import * as Body from "./Body.js";
import * as Request from "./Request.js";
import { refusesConstruction, refusesDecoding } from "../../test/request.js";

const Inner = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const shapes = [
  {
    name: "root array",
    schema: Schema.Array(Inner),
    wrap: (value: object) => [value],
  },
  {
    name: "wrapped array",
    schema: Schema.Struct({ filters: Schema.Array(Inner) }),
    wrap: (value: object) => ({ filters: [value] }),
  },
  {
    name: "nested arrays",
    schema: Schema.Array(Schema.Array(Inner)),
    wrap: (value: object) => [[value]],
  },
  {
    name: "object parent union",
    schema: Schema.Union([
      Schema.Struct({ filters: Schema.Array(Inner) }),
      Cursor,
    ]),
    wrap: (value: object) => ({ filters: [value] }),
  },
  {
    name: "element union",
    schema: Schema.Array(Schema.Union([Inner, Cursor])),
    wrap: (value: object) => [value],
  },
  {
    name: "fixed tuple",
    schema: Schema.Tuple([Inner]),
    wrap: (value: object) => [value],
  },
  {
    name: "prefix tuple",
    schema: Schema.Tuple([Schema.Number, Inner]),
    wrap: (value: object) => [3, value],
  },
  {
    name: "rest tuple",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.Number]), [Inner]),
    wrap: (value: object) => [3, value],
  },
  {
    name: "post-rest tuple",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.Number,
      Inner,
    ]),
    wrap: (value: object) => ["prefix", 3, value],
  },
] as const;
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

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("nested aliases below unchanged array positions", () => {
  for (const kind of ["path", "body"] as const)
    for (const { name, schema, wrap } of shapes) {
      it.effect(`refuses invalid ${kind} input through a ${name}`, () =>
        Effect.gen(function* () {
          for (const page_size of ["many", null])
            expect(
              yield* Effect.flip(prepare(schema, wrap({ page_size }), kind)),
            ).toBeInstanceOf(Schema.SchemaError);
        }),
      );
      it.effect(`retains ${kind} controls through a ${name}`, () =>
        Effect.gen(function* () {
          for (const value of [{ page_size: "05" }, { limit: 5 }])
            expect(yield* prepare(schema, wrap(value), kind)).toEqual(
              wrap({ page_size: "5" }),
            );
          expect(yield* prepare(schema, wrap({}), kind)).toEqual(
            wrap({ page_size: "25" }),
          );
        }),
      );
    }

  it.effect(
    "does not replay construction when validating a positional alias",
    () =>
      Effect.gen(function* () {
        let defaults = 0;
        const inner = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                defaults++;
                return 25;
              }),
            ),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Array(inner);
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(
            yield* Effect.flip(
              prepare(schema, [{ page_size: "many" }], "path"),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(defaults).toBe(attempt + 1);
        }
        expect(yield* prepare(schema, [{ page_size: "05" }], "path")).toEqual([
          { page_size: "5" },
        ]);
        expect(defaults).toBe(2);
      }),
  );

  it.effect("keeps visible union siblings or refuses the complete array", () =>
    Effect.gen(function* () {
      const schema = Schema.Array(
        Schema.Struct({
          filter: Inner,
          choice: Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ a: Schema.String, b: Schema.String }),
          ]),
          opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
        }),
      );
      for (const kind of ["path", "body"] as const) {
        const result = yield* Effect.result(
          prepare(
            schema,
            [
              {
                filter: { page_size: "05" },
                choice: { a: "a", b: "kept" },
                opaque: Option.some({ keep: "x", extra: "opaque" }),
              },
            ],
            kind,
          ),
        );
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(Schema.SchemaError);
        else
          expect(result.success).toMatchObject([
            { choice: { a: "a", b: "kept" } },
          ]);
      }
    }),
  );

  it.effect("retains frozen, null-prototype and hidden own positions", () =>
    Effect.gen(function* () {
      for (const kind of ["path", "body"] as const)
        for (const profile of ["frozen", "null prototype", "hidden"] as const)
          for (const page_size of ["many", "05"]) {
            const input = [{ page_size }];
            if (profile === "frozen") {
              Object.freeze(input[0]);
              Object.freeze(input);
            }
            if (profile === "null prototype")
              Object.setPrototypeOf(input, null);
            if (profile === "hidden")
              Object.defineProperty(input, "0", { enumerable: false });
            if (page_size === "many")
              expect(
                yield* Effect.flip(prepare(Schema.Array(Inner), input, kind)),
              ).toBeInstanceOf(Schema.SchemaError);
            else
              expect(yield* prepare(Schema.Array(Inner), input, kind)).toEqual([
                { page_size: "5" },
              ]);
          }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses conflicting aliases beside an encoded-only array item",
    () =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            prepare(
              Schema.Array(Inner),
              [{ limit: 1, page_size: "02" }, { page_size: "25" }],
              "path",
            ),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  const aliasProfiles = [
    {
      name: "optional elements",
      schema: Schema.Array(Schema.optional(Inner)),
      input: (values: ReadonlyArray<object>) => [...values],
      sparse: false,
    },
    {
      name: "nullable elements",
      schema: Schema.Array(Schema.NullOr(Inner)),
      input: (values: ReadonlyArray<object>) => [...values],
      sparse: false,
    },
    {
      name: "native own iterator",
      schema: Schema.Array(Inner),
      input: (values: ReadonlyArray<object>) =>
        Object.defineProperty([...values], Symbol.iterator, {
          value: Array.prototype[Symbol.iterator],
          enumerable: true,
        }),
      sparse: false,
    },
    {
      name: "sparse optional elements",
      schema: Schema.Array(Schema.optional(Inner)),
      input: (values: ReadonlyArray<object>) => {
        const input: object[] = [];
        input.length = values.length + 1;
        values.forEach((value, index) => {
          input[index + 1] = value;
        });
        return input;
      },
      sparse: true,
    },
  ] as const;
  for (const kind of ["path", "body"] as const)
    for (const profile of aliasProfiles) {
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.effect(
        `refuses conflicting aliases through ${profile.name} in ${kind}`,
        () =>
          Effect.gen(function* () {
            const both = { limit: 1, page_size: "02" };
            for (const items of [
              [both],
              [both, {}],
              [both, { limit: 25 }],
              [both, { page_size: "25" }],
            ])
              expect(
                yield* Effect.flip(
                  prepare(profile.schema, profile.input(items), kind),
                ),
              ).toBeInstanceOf(Schema.SchemaError);
            for (const [items, expected] of [
              [
                [{ page_size: "02" }, { page_size: "25" }],
                [{ page_size: "2" }, { page_size: "25" }],
              ],
              [
                [{ limit: 1 }, { limit: 25 }],
                [{ page_size: "1" }, { page_size: "25" }],
              ],
            ] as const)
              expect(
                yield* prepare(profile.schema, profile.input(items), kind),
              ).toEqual(
                profile.sparse
                  ? [kind === "body" ? null : undefined, ...expected]
                  : expected,
              );
          }),
      );
    }
});

const OneOrMany = Schema.Union([Schema.Array(Inner), Inner]);
const ManyOrOne = Schema.Union([Inner, Schema.Array(Inner)]);
const ListOrCursor = Schema.Union([Schema.Array(Inner), Cursor]);
const ListOrText = Schema.Union([Schema.Array(Inner), Schema.String]);
const CountOrList = Schema.Union([
  Schema.FiniteFromString,
  Schema.Array(Inner),
]);
// An object cell cannot be read by an array member.
const objectCells = [
  { name: "one-or-many root", schema: OneOrMany, wrap: (leaf: object) => leaf },
  { name: "many-or-one root", schema: ManyOrOne, wrap: (leaf: object) => leaf },
  {
    name: "one-or-many field",
    schema: Schema.Struct({ filter: OneOrMany }),
    wrap: (leaf: object) => ({ filter: leaf }),
  },
  {
    name: "many-or-one element",
    schema: Schema.Array(ManyOrOne),
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "one-or-many beside a cursor",
    schema: Schema.Union([Schema.Array(Inner), Inner, Cursor]),
    wrap: (leaf: object) => leaf,
  },
] as const;
// An array cell reaches the union's one array member when every other member refuses arrays.
const arrayCells = [
  {
    name: "array beside a cursor",
    schema: ListOrCursor,
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "cursor beside an array",
    schema: Schema.Union([Cursor, Schema.Array(Inner)]),
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "one-or-many list",
    schema: OneOrMany,
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "many-or-one list",
    schema: ManyOrOne,
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "array beside text",
    schema: ListOrText,
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "array beside encoded text",
    schema: CountOrList,
    wrap: (leaf: object) => [leaf],
  },
  {
    name: "one-or-many field list",
    schema: Schema.Struct({ filter: OneOrMany }),
    wrap: (leaf: object) => ({ filter: [leaf] }),
  },
  {
    name: "many-or-one element list",
    schema: Schema.Array(ManyOrOne),
    wrap: (leaf: object) => [[leaf]],
  },
  {
    name: "tuple beside a cursor",
    schema: Schema.Union([Schema.Tuple([Schema.Number, Inner]), Cursor]),
    wrap: (leaf: object) => [3, leaf],
  },
  {
    name: "nested array union",
    schema: Schema.Union([
      Schema.Union([Schema.Array(Inner), Cursor]),
      Schema.Struct({ token: Schema.String }),
    ]),
    wrap: (leaf: object) => [leaf],
  },
] as const;
const arrayShaped = [
  ...objectCells.map((shape) => ({ ...shape, cell: "object" })),
  ...arrayCells.map((shape) => ({ ...shape, cell: "array" })),
] as const;

// A list hidden behind an ordinary prototype is still an array to `Array.isArray`.
const disguisedList = (items: Array<unknown>) =>
  new Proxy(items, { getPrototypeOf: () => Object.prototype });

const nonArrayInputs = () => [
  {},
  { length: 0 },
  { 0: {}, length: 1 },
  Object.assign(Object.create(null), { 0: {}, length: 1 }),
];

const listInputs = () => [
  [],
  [1],
  [{}],
  [{ page_size: "05" }],
  Object.setPrototypeOf([{}], null),
  disguisedList([{}]),
];

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("nested aliases beside array-shaped union members", () => {
  // The proofs below rest on these parser facts; the peer-floor lane runs them on Effect 4.0.7.
  it.effect("Effect's array parser refuses every non-array object", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Array(Inner),
        Schema.Tuple([]),
        Schema.Tuple([Schema.Number, Inner]),
      ])
        for (const input of nonArrayInputs()) {
          expect(yield* refusesDecoding(schema, input)).toBe(true);
          expect(yield* refusesConstruction(schema, input)).toBe(true);
        }
    }),
  );

  it.effect(
    "Effect's object parser refuses arrays once it states a property or index",
    () =>
      Effect.gen(function* () {
        for (const schema of [
          Inner,
          Cursor,
          Schema.Struct({ a: Schema.optionalKey(Schema.String) }),
          Schema.Struct({ length: Schema.Number }),
          Schema.Record(Schema.String, Schema.Unknown),
        ])
          for (const input of listInputs()) {
            expect(yield* refusesDecoding(schema, input)).toBe(true);
            expect(yield* refusesConstruction(schema, input)).toBe(true);
          }
      }),
  );

  it.effect(
    "Effect's empty struct reads any value but null and undefined",
    () =>
      Effect.gen(function* () {
        const Empty = Schema.Struct({});
        for (const input of [...listInputs(), "x", 3, true]) {
          expect(yield* Schema.decodeUnknownEffect(Empty)(input)).toBe(input);
          expect(yield* Empty.makeEffect(input)).toBe(input);
        }
        for (const input of [null, undefined]) {
          expect(yield* refusesDecoding(Empty, input)).toBe(true);
          expect(yield* refusesConstruction(Empty, input)).toBe(true);
        }
      }),
  );

  it.effect("Effect reads a disguised list with its array member", () =>
    Effect.gen(function* () {
      expect(
        yield* Schema.decodeUnknownEffect(OneOrMany)(
          disguisedList([{ page_size: "05" }]),
        ),
      ).toEqual([{ limit: 5 }]);
    }),
  );

  for (const kind of ["path", "body"] as const)
    for (const { name, schema, wrap, cell } of arrayShaped) {
      // https://github.com/viell-dev/slop-effect-schema-http/issues/170
      it.effect(
        `refuses invalid ${kind} input for an ${cell} cell through a ${name}`,
        () =>
          Effect.gen(function* () {
            for (const page_size of ["many", null])
              expect(
                yield* Effect.flip(prepare(schema, wrap({ page_size }), kind)),
              ).toBeInstanceOf(Schema.SchemaError);
          }),
      );
      it.effect(
        `retains ${kind} controls for an ${cell} cell through a ${name}`,
        () =>
          Effect.gen(function* () {
            for (const value of [{ page_size: "05" }, { limit: 5 }])
              expect(yield* prepare(schema, wrap(value), kind)).toEqual(
                wrap({ page_size: "5" }),
              );
            expect(yield* prepare(schema, wrap({}), kind)).toEqual(
              wrap({ page_size: "25" }),
            );
          }),
      );
    }

  it.effect("keeps the alternatives' own values and valid lists", () =>
    Effect.gen(function* () {
      for (const kind of ["path", "body"] as const) {
        expect(yield* prepare(ListOrText, "text", kind)).toBe("text");
        expect(yield* prepare(CountOrList, "07", kind)).toBe("7");
        expect(yield* prepare(ListOrCursor, { cursor: "a/b" }, kind)).toEqual({
          cursor: "a/b",
        });
        for (const schema of [OneOrMany, ManyOrOne]) {
          expect(yield* prepare(schema, [], kind)).toEqual([]);
          // A strict whole decode succeeds and, as for any list, applies no constructor default.
          expect(
            yield* prepare(schema, [{ page_size: "05" }, {}], kind),
          ).toEqual([{ page_size: "5" }, {}]);
          expect(yield* prepare(schema, [{ limit: 5 }, {}], kind)).toEqual([
            { page_size: "5" },
            { page_size: "25" },
          ]);
        }
      }
    }),
  );

  // Whole decoding reads the decoded item by its encoded name and loses it.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses a list mixing encoded-only and decoded items in an array-shaped union",
    () =>
      Effect.gen(function* () {
        for (const kind of ["path", "body"] as const)
          for (const schema of [OneOrMany, ListOrCursor])
            expect(
              yield* Effect.flip(
                prepare(schema, [{ page_size: "05" }, { limit: 5 }], kind),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  // Its decoded side is a list, but its encoded side reads an object.
  // An array-to-array codec: an encoded array member, which reads only lists.
  const ListCodec = Schema.Array(Schema.toEncoded(Inner)).pipe(
    Schema.decodeTo(Schema.Array(Inner)),
  );

  it.effect("refuses an object cell beside an array-to-array codec", () =>
    Effect.gen(function* () {
      for (const kind of ["path", "body"] as const)
        for (const schema of [
          Schema.Union([ListCodec, Inner]),
          Schema.Union([Inner, ListCodec]),
        ]) {
          expect(
            yield* Effect.flip(prepare(schema, { page_size: "many" }, kind)),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(yield* prepare(schema, { page_size: "05" }, kind)).toEqual({
            page_size: "5",
          });
        }
    }),
  );

  it.effect("refuses an invalid alias on a one-or-many fieldwise root", () =>
    Effect.gen(function* () {
      const Gated = Schema.Struct({
        limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
        gate: Schema.FiniteFromString,
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      for (const kind of ["path", "body"] as const)
        for (const schema of [
          Schema.Union([Schema.Array(Gated), Gated]),
          Schema.Union([Gated, Schema.Array(Gated)]),
        ]) {
          expect(
            yield* Effect.flip(
              prepare(schema, { page_size: "many", gate: "03" }, kind),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(
            yield* prepare(schema, { page_size: "05", gate: "03" }, kind),
          ).toEqual({ page_size: "5", gate: "3" });
        }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "currently keeps the default for a list behind a custom prototype",
    () =>
      Effect.gen(function* () {
        for (const kind of ["path", "body"] as const)
          expect(
            yield* prepare(
              OneOrMany,
              disguisedList([{ page_size: "many" }]),
              kind,
            ),
          ).toEqual([{ page_size: "25" }]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses conflicting aliases beside an encoded-only item in an array-shaped union",
    () =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            prepare(
              OneOrMany,
              [{ limit: 1, page_size: "02" }, { page_size: "25" }],
              "path",
            ),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );
});
