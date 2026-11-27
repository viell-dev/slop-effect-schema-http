/**
 * Independently consumer-authored from the accepted nested primitive alternative scope under
 * https://github.com/viell-dev/slop-effect-schema-http/issues/170, the library's public
 * schema-input guide and the echo HTTP contract in README.md. Expected outcomes outside that scope
 * (EXT-49f, EXT-49j, EXT-49o, EXT-49p) were observed over the wire before being pinned. The Void
 * cases (EXT-49d, EXT-49e, EXT-49g to EXT-49i, EXT-49k to EXT-49n) follow the Void rule of #143
 * as the library's guide and design page state it, checked against observed HTTP behaviour.
 * No library implementation, library source tests, backend or conformance code was read.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaTransformation } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { type Backend, headerValues, type Recorded } from "../harness/lane.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
type Binding = "path" | "JSON";
type WireSchema = Schema.Top &
  Schema.ConstraintCodec<unknown, unknown, never, never>;
// The path template writes the encoded value as JSON text. `JSON.stringify(undefined)` is not a
// string, so a root that encodes to undefined reaches the path as the text `undefined`; that is
// this consumer's template, not a library spelling.
const operation = <S extends WireSchema>(
  origin: string,
  schema: S,
  binding: Binding,
) => {
  const path = Operation.make(
    Request.get(`${origin}/x`).pipe(
      Request.path(
        schema,
        (value, encode) => `/${encode(JSON.stringify(value))}`,
      ),
    ),
    response,
  );
  const body = Operation.make(
    Request.post(`${origin}/x`).pipe(Request.body(Body.jsonSchema(schema))),
    response,
  );
  return (input: unknown) =>
    (binding === "path"
      ? path.execute({ path: input as Request.Input<S> })
      : body.execute({ body: input as Request.Input<S> })
    ).pipe(Effect.provide(lane.fetchClient));
};
type Outcome = { readonly error: unknown } | { readonly value: unknown };
const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error): Outcome => ({ error }),
      onSuccess: (value): Outcome => ({ value }),
    }),
  );
const refusesBeforeDispatch = (
  backend: Backend,
  execute: (input: unknown) => Effect.Effect<unknown, unknown>,
  inputs: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const outcomes: Outcome[] = [];
    for (const input of inputs) {
      const before = structuredClone(input);
      outcomes.push(yield* execute(input).pipe(outcome));
      expect(input).toEqual(before);
    }
    expect({ outcomes, ledger: yield* backend.ledger }).toMatchObject({
      outcomes: inputs.map(() => ({ error: { _tag: "SchemaError" } })),
      ledger: [],
    });
    for (const actual of outcomes)
      expect("error" in actual && Schema.isSchemaError(actual.error)).toBe(
        true,
      );
  });
const wire = (entry: Recorded, binding: Binding, json: string) => {
  expect(entry.method).toBe(binding === "path" ? "GET" : "POST");
  expect(entry.target).toBe(
    binding === "path" ? `/x/${encodeURIComponent(json)}` : "/x",
  );
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "content-type")).toEqual(
    binding === "path" ? [] : ["application/json"],
  );
  expect(entry.body).toEqual(
    new TextEncoder().encode(binding === "path" ? "" : json),
  );
};

// A query parameter or header that holds the union as JSON text, the form in which a union with a
// Void member is representable in those groups.
type TextBinding = "query" | "header";
const textField = (
  origin: string,
  schema: WireSchema,
  binding: TextBinding,
) => {
  const field = Schema.Struct({ filter: Schema.fromJsonString(schema) });
  const query = Operation.make(
    Request.get(`${origin}/x`).pipe(Request.query(field)),
    response,
  );
  const headers = Operation.make(
    Request.get(`${origin}/x`).pipe(Request.headers(field)),
    response,
  );
  return (filter: unknown) => {
    const input = { filter } as Request.Input<typeof field>;
    return (
      binding === "query"
        ? query.execute({ query: input })
        : headers.execute({ headers: input })
    ).pipe(Effect.provide(lane.fetchClient));
  };
};
const textWire = (entry: Recorded, binding: TextBinding, json: string) => {
  expect(entry.method).toBe("GET");
  expect(entry.target).toBe(
    binding === "query" ? `/x?filter=${encodeURIComponent(json)}` : "/x",
  );
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "filter")).toEqual(
    binding === "query" ? [] : [json],
  );
  expect(entry.body.byteLength).toBe(0);
};

type Order = "alternative first" | "object first";
const orders = ["alternative first", "object first"] as const;
const pair = (alternative: WireSchema, object: WireSchema, order: Order) =>
  order === "alternative first"
    ? Schema.Union([alternative, object])
    : Schema.Union([object, alternative]);

type Level = {
  readonly name: string;
  readonly schema: (alternative: WireSchema, order: Order) => WireSchema;
  readonly input: (leaf: unknown) => unknown;
  readonly json: (leaf: string) => string;
};
const levels: ReadonlyArray<Level> = [
  {
    name: "root",
    schema: (alternative, order) => pair(alternative, Filter, order),
    input: (leaf) => leaf,
    json: (leaf) => leaf,
  },
  {
    name: "terminal element",
    schema: (alternative, order) =>
      Schema.Array(pair(alternative, Filter, order)),
    input: (leaf) => [leaf],
    json: (leaf) => `[${leaf}]`,
  },
  {
    name: "ancestor",
    schema: (alternative, order) =>
      Schema.Struct({
        cell: pair(alternative, Schema.Struct({ filter: Filter }), order),
      }),
    input: (leaf) => ({ cell: { filter: leaf } }),
    json: (leaf) => `{"cell":{"filter":${leaf}}}`,
  },
];

type Alternative = {
  readonly name: string;
  readonly schema: WireSchema;
  readonly scalars: ReadonlyArray<readonly [value: unknown, json: string]>;
};
// Effect builds each of the first five as an unencoded union of primitive members. The flat
// Literal is the reference the nested forms are promised to behave like.
const alternatives: ReadonlyArray<Alternative> = [
  {
    name: "Literals all/none",
    schema: Schema.Literals(["all", "none"]),
    scalars: [
      ["all", '"all"'],
      ["none", '"none"'],
    ],
  },
  {
    name: "NullOr String",
    schema: Schema.NullOr(Schema.String),
    scalars: [
      [null, "null"],
      ["x", '"x"'],
    ],
  },
  {
    name: "NullishOr Number",
    schema: Schema.NullishOr(Schema.Number),
    scalars: [
      [null, "null"],
      [7, "7"],
    ],
  },
  {
    name: "String or Number union",
    schema: Schema.Union([Schema.String, Schema.Number]),
    scalars: [
      ["x", '"x"'],
      [7, "7"],
    ],
  },
  {
    name: "doubly nested Literals and NullOr Boolean",
    schema: Schema.Union([
      Schema.Literals(["all"]),
      Schema.NullOr(Schema.Boolean),
    ]),
    scalars: [
      ["all", '"all"'],
      [null, "null"],
      [true, "true"],
    ],
  },
  {
    name: "flat Literal reference",
    schema: Schema.Literal("all"),
    scalars: [["all", '"all"']],
  },
];

const controls = [
  [{ page_size: "05" }, '{"page_size":"5"}'],
  [{ limit: 5 }, '{"page_size":"5"}'],
  [{}, '{"page_size":"25"}'],
] as const;
const invalid = ["many", null] as const;

// Void inside an unencoded any-of union of primitives that sits beside the object member. The rule
// follows such member unions, so these behave like a direct Void (EXT-49g).
const nestedVoidAlternatives = [
  ["nested Void and Literal", Schema.Union([Schema.Void, Schema.Literal("a")])],
  [
    "nested Literals and Void",
    Schema.Union([Schema.Literals(["all"]), Schema.Void]),
  ],
  [
    "nested NullOr String and Void",
    Schema.Union([Schema.NullOr(Schema.String), Schema.Void]),
  ],
  ["NullOr Void", Schema.NullOr(Schema.Void)],
] as const satisfies ReadonlyArray<readonly [string, WireSchema]>;
const five = '{"page_size":"5"}';
const defaulted = '{"page_size":"25"}';
const valid = [{ page_size: "05" }, { limit: 5 }] as const;
// Union inputs that supply no field: an empty object and a key that holds undefined. At the
// ancestor, `{ filter: {} }` supplies `filter`, so it is a field there, not one of these.
const fieldless = (level: Level): ReadonlyArray<unknown> =>
  level.name === "ancestor"
    ? [{ cell: {} }, { cell: { filter: undefined } }]
    : [level.input({}), level.input({ page_size: undefined })];
// The object member's output for a fieldless input, when it is tried first. At the ancestor the
// object member requires `filter`, so a fieldless cell falls through to Void in either order.
const fieldlessObjectJson = (level: Level, binding: Binding) =>
  level.name === "ancestor" ? voidJson(level, binding) : level.json(defaulted);
// A direct Void member after an object member that holds Filter one field down, at the ancestor
// level's cell, at the root and as an array element (EXT-49k, EXT-49l).
const HoldsFilter = Schema.Struct({ filter: Filter });
const objectThenVoid: ReadonlyArray<{
  readonly schema: WireSchema;
  readonly input: (leaf: unknown) => unknown;
  readonly json: (leaf: string) => string;
}> = [
  {
    schema: Schema.Struct({ cell: Schema.Union([HoldsFilter, Schema.Void]) }),
    input: (leaf) => ({ cell: { filter: leaf } }),
    json: (leaf) => `{"cell":{"filter":${leaf}}}`,
  },
  {
    schema: Schema.Union([HoldsFilter, Schema.Void]),
    input: (leaf) => ({ filter: leaf }),
    json: (leaf) => `{"filter":${leaf}}`,
  },
  {
    schema: Schema.Array(Schema.Union([HoldsFilter, Schema.Void])),
    input: (leaf) => [{ filter: leaf }],
    json: (leaf) => `[{"filter":${leaf}}]`,
  },
];
const encodedAlternatives = [
  [
    "nested Literals and FiniteFromString",
    Schema.Union([Schema.Literals(["all"]), Schema.FiniteFromString]),
  ],
  ["flat FiniteFromString", Schema.FiniteFromString],
] as const satisfies ReadonlyArray<readonly [string, WireSchema]>;
// What Void writes in place of the caller's object at each level, as observed: JSON writes
// undefined as null; the path template omits an undefined property and spells a bare undefined
// root `undefined`.
const voidJson = (level: Level, binding: Binding) =>
  level.name === "root"
    ? binding === "path"
      ? "undefined"
      : "null"
    : level.name === "terminal element"
      ? "[null]"
      : binding === "path"
        ? "{}"
        : '{"cell":null}';

// The direct Void rule's refusal and its kept and first-fit outputs for one Void-holding
// alternative, at one level and order (EXT-49d, EXT-49e, EXT-49g).
const voidRefuses = (
  level: Level,
  order: Order,
  binding: Binding,
  alternative: WireSchema,
) =>
  Effect.gen(function* () {
    const backend = yield* start();
    yield* refusesBeforeDispatch(
      backend,
      operation(backend.origin, level.schema(alternative, order), binding),
      invalid.map((page_size) => level.input({ page_size })),
    );
  });
const voidKeeps = (
  level: Level,
  order: Order,
  binding: Binding,
  alternative: WireSchema,
) =>
  Effect.gen(function* () {
    const backend = yield* start();
    const execute = operation(
      backend.origin,
      level.schema(alternative, order),
      binding,
    );
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      ...valid.map(
        (leaf) => [level.input({ ...leaf }), level.json(five)] as const,
      ),
      // An empty filter in the ancestor's cell is a supplied field of the union's input.
      ...(level.name === "ancestor"
        ? [{}, { page_size: undefined }].map(
            (leaf) => [level.input(leaf), level.json(defaulted)] as const,
          )
        : []),
      ...fieldless(level).map(
        (input) =>
          [
            input,
            order === "alternative first"
              ? voidJson(level, binding)
              : fieldlessObjectJson(level, binding),
          ] as const,
      ),
    ];
    for (const [input, json] of cases) {
      const before = structuredClone(input);
      expect(yield* execute(input)).toBe("Not Found");
      expect(input).toEqual(before);
      const ledger = yield* backend.ledger;
      wire(ledger[ledger.length - 1]!, binding, json);
    }
    expect(yield* backend.ledger).toHaveLength(cases.length);
  });

// Void reached through a parent's encoding or a fieldwise read: a renamed parent field, a renamed
// sibling, and a mixed-side parent (decoded `n` beside an encoded alias) holding Void in a nested
// struct or an array (EXT-49m). `fieldless` gives the first-fit outputs for an input with no
// field at the Void-holding union.
type Route = {
  readonly name: string;
  readonly schema: (union: WireSchema) => WireSchema;
  readonly kept: ReadonlyArray<readonly [unknown, string]>;
  readonly refused: (order: Order) => ReadonlyArray<unknown>;
  readonly fieldless: (
    order: Order,
    binding: Binding,
  ) => ReadonlyArray<readonly [unknown, string]>;
};
const routes: ReadonlyArray<Route> = [
  {
    name: "renamed parent field",
    schema: (union) =>
      Schema.Struct({ pageFilter: union }).pipe(
        Schema.encodeKeys({ pageFilter: "page_filter" }),
      ),
    kept: [
      [{ page_filter: { page_size: "05" } }, `{"page_filter":${five}}`],
      [{ pageFilter: { limit: 5 } }, `{"page_filter":${five}}`],
    ],
    refused: () => invalid.map((page_size) => ({ page_filter: { page_size } })),
    fieldless: (order, binding) =>
      order === "alternative first"
        ? [{ pageFilter: {} }, { page_filter: {} }].map(
            (input) =>
              [
                input,
                binding === "path" ? "{}" : '{"page_filter":null}',
              ] as const,
          )
        : [
            // The decoded parent constructs the default; the encoded parent reads `{}` as given.
            [{ pageFilter: {} }, `{"page_filter":${defaulted}}`],
            [{ page_filter: {} }, '{"page_filter":{}}'],
          ],
  },
  {
    name: "renamed sibling",
    schema: (union) =>
      Schema.Struct({ filter: union, sortBy: Schema.String }).pipe(
        Schema.encodeKeys({ sortBy: "sort_by" }),
      ),
    kept: [
      [
        { filter: { page_size: "05" }, sort_by: "a" },
        `{"filter":${five},"sort_by":"a"}`,
      ],
      [
        { filter: { limit: 5 }, sortBy: "a" },
        `{"filter":${five},"sort_by":"a"}`,
      ],
    ],
    // A decoded filter beside the encoded sibling mixes the sides, which the library refuses.
    refused: (order) => [
      ...invalid.map((page_size) => ({ filter: { page_size }, sort_by: "a" })),
      ...(order === "alternative first"
        ? [{ filter: { limit: 5 }, sort_by: "a" }]
        : []),
    ],
    fieldless: (order, binding) => [
      [
        { filter: {}, sort_by: "a" },
        order === "object first"
          ? '{"filter":{},"sort_by":"a"}'
          : binding === "path"
            ? '{"sort_by":"a"}'
            : '{"filter":null,"sort_by":"a"}',
      ],
    ],
  },
  {
    name: "fieldwise nested struct",
    schema: (union) =>
      Schema.Struct({
        n: Schema.FiniteFromString,
        mid: Schema.Struct({ inner: union }),
      }),
    kept: [
      [
        { n: 1, mid: { inner: { page_size: "05" } } },
        `{"n":"1","mid":{"inner":${five}}}`,
      ],
      [
        { n: "1", mid: { inner: { page_size: "05" } } },
        `{"n":"1","mid":{"inner":${five}}}`,
      ],
    ],
    refused: () =>
      invalid.map((page_size) => ({ n: 1, mid: { inner: { page_size } } })),
    fieldless: (order, binding) => [
      [
        { n: 1, mid: { inner: {} } },
        order === "object first"
          ? `{"n":"1","mid":{"inner":${defaulted}}}`
          : binding === "path"
            ? '{"n":"1","mid":{}}'
            : '{"n":"1","mid":{"inner":null}}',
      ],
    ],
  },
  {
    name: "fieldwise array",
    schema: (union) =>
      Schema.Struct({ n: Schema.FiniteFromString, items: Schema.Array(union) }),
    kept: [
      [{ n: 1, items: [{ page_size: "05" }] }, `{"n":"1","items":[${five}]}`],
      [{ n: "1", items: [{ page_size: "05" }] }, `{"n":"1","items":[${five}]}`],
    ],
    refused: () =>
      invalid.map((page_size) => ({ n: 1, items: [{ page_size }] })),
    fieldless: (order) => [
      [
        { n: 1, items: [{}] },
        order === "object first"
          ? `{"n":"1","items":[${defaulted}]}`
          : '{"n":"1","items":[null]}',
      ],
    ],
  },
];
// Void annotated or given a check builds a new encoding for it (EXT-49n).
const voidVariants = [
  ["annotated Void", Schema.Void.annotate({ description: "nothing" })],
  ["checked Void", Schema.Void.check(Schema.makeFilter(() => true))],
] as const satisfies ReadonlyArray<readonly [string, WireSchema]>;
// The root text Void's undefined has in each binding.
const voidRoot = (binding: Binding) =>
  binding === "path" ? "undefined" : "null";
class FilterClass extends Schema.Class<FilterClass>("FilterClass")({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}) {}
class VoidFirstParent extends Schema.Class<VoidFirstParent>("VoidFirstParent")({
  filter: Schema.Union([Schema.Void, Filter]),
}) {}
// A field whose encoded null decodes to undefined, so a supplied object or list holds only
// undefined once read (EXT-49q).
const NullAsUndefined = Schema.Null.pipe(
  Schema.decodeTo(
    Schema.Undefined,
    SchemaTransformation.transform({
      decode: () => undefined,
      encode: () => null,
    }),
  ),
);
// Cast-only groups: these schemas do not type as query or header groups (EXT-49i, EXT-49p).
type GroupKind = "query" | "headers";
const Sort = Schema.Struct({ sort: Schema.String });
const group = (origin: string, schema: unknown, kind: GroupKind) => {
  const query = Operation.make(
    Request.get(`${origin}/x`).pipe(Request.query(schema as typeof Sort)),
    response,
  );
  const headers = Operation.make(
    Request.get(`${origin}/x`).pipe(Request.headers(schema as typeof Sort)),
    response,
  );
  return (input: unknown) =>
    (kind === "query"
      ? query.execute({ query: input as Request.Input<typeof Sort> })
      : headers.execute({ headers: input as Request.Input<typeof Sort> })
    ).pipe(Effect.provide(lane.fetchClient));
};
const invalidRequestBeforeDispatch = (
  backend: Backend,
  execute: (input: unknown) => Effect.Effect<unknown, unknown>,
  inputs: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const outcomes: Outcome[] = [];
    for (const input of inputs)
      outcomes.push(yield* execute(input).pipe(outcome));
    expect({ outcomes, ledger: yield* backend.ledger }).toMatchObject({
      outcomes: inputs.map(() => ({ error: { _tag: "InvalidRequest" } })),
      ledger: [],
    });
    for (const actual of outcomes)
      expect(
        "error" in actual && actual.error instanceof Request.InvalidRequest,
      ).toBe(true);
  });

const openMembers = [
  ["Unknown", Schema.Unknown],
  ["Any", Schema.Any],
] as const satisfies ReadonlyArray<readonly [string, WireSchema]>;
// Open members keep the caller's value as given. Placed after the object, they still take what
// the object would strip or refuse.
const openCases = (order: Order) =>
  [
    [{ page_size: "05" }, '{"page_size":"05"}'],
    [{ page_size: "many" }, '{"page_size":"many"}'],
    [{ page_size: null }, '{"page_size":null}'],
    [{ limit: 5 }, order === "alternative first" ? '{"limit":5}' : five],
    [{}, order === "alternative first" ? "{}" : defaulted],
    [
      { page_size: undefined },
      order === "alternative first" ? "{}" : defaulted,
    ],
    [{ other: "x" }, '{"other":"x"}'],
  ] as const;

describe(`nested primitive alternatives (${lane.name})`, () => {
  for (const binding of ["path", "JSON"] as const) {
    for (const level of levels) {
      for (const alternative of alternatives) {
        for (const order of orders) {
          const schema = level.schema(alternative.schema, order);
          it.live(
            `[EXT-49a] ${binding} ${level.name} ${alternative.name} ${order} retains encoded decoded and omitted bytes`,
            () =>
              Effect.gen(function* () {
                const backend = yield* start();
                const execute = operation(backend.origin, schema, binding);
                for (const [leaf, json] of controls) {
                  const input = level.input({ ...leaf });
                  const before = structuredClone(input);
                  expect(yield* execute(input)).toBe("Not Found");
                  expect(input).toEqual(before);
                  const ledger = yield* backend.ledger;
                  wire(ledger[ledger.length - 1]!, binding, level.json(json));
                }
                expect(yield* backend.ledger).toHaveLength(3);
              }),
          );
          it.live(
            `[EXT-49b] ${binding} ${level.name} ${alternative.name} ${order} refuses invalid aliases before dispatch`,
            () =>
              Effect.gen(function* () {
                const backend = yield* start();
                const execute = operation(backend.origin, schema, binding);
                const outcomes: Outcome[] = [];
                for (const page_size of invalid) {
                  const input = level.input({ page_size });
                  const before = structuredClone(input);
                  outcomes.push(yield* execute(input).pipe(outcome));
                  expect(input).toEqual(before);
                }
                expect({
                  outcomes,
                  ledger: yield* backend.ledger,
                }).toMatchObject({
                  outcomes: [
                    { error: { _tag: "SchemaError" } },
                    { error: { _tag: "SchemaError" } },
                  ],
                  ledger: [],
                });
                for (const actual of outcomes)
                  expect(
                    "error" in actual && Schema.isSchemaError(actual.error),
                  ).toBe(true);
              }),
          );
        }
      }
    }

    for (const alternative of alternatives) {
      for (const order of orders) {
        it.live(
          `[EXT-49c] ${binding} ${alternative.name} ${order} scalars pass through beside filter objects`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              const array = operation(
                backend.origin,
                Schema.Array(pair(alternative.schema, Filter, order)),
                binding,
              );
              // Interleave every scalar with filter objects in one array. Each array keeps its
              // filters on one side: an encoded-only item beside a decoded-only item is a separate
              // side-mixing refusal that would hide the scalars.
              for (const filters of [
                [
                  [{ page_size: "05" }, '{"page_size":"5"}'],
                  [{ page_size: "12" }, '{"page_size":"12"}'],
                ],
                [
                  [{ limit: 5 }, '{"page_size":"5"}'],
                  [{}, '{"page_size":"25"}'],
                ],
              ] as const) {
                const items = alternative.scalars.flatMap(
                  (scalar, index): Array<readonly [unknown, string]> => {
                    const [filter, json] = filters[index % filters.length]!;
                    return [scalar, [{ ...filter }, json]];
                  },
                );
                const input = items.map(([value]) => value);
                const before = structuredClone(input);
                expect(yield* array(input)).toBe("Not Found");
                expect(input).toEqual(before);
                const ledger = yield* backend.ledger;
                wire(
                  ledger[ledger.length - 1]!,
                  binding,
                  `[${items.map(([, json]) => json).join(",")}]`,
                );
              }
              const root = operation(
                backend.origin,
                pair(alternative.schema, Filter, order),
                binding,
              );
              const ancestor = operation(
                backend.origin,
                Schema.Struct({
                  cell: pair(
                    alternative.schema,
                    Schema.Struct({ filter: Filter }),
                    order,
                  ),
                }),
                binding,
              );
              for (const [value, json] of alternative.scalars) {
                expect(yield* root(value)).toBe("Not Found");
                const afterRoot = yield* backend.ledger;
                wire(afterRoot[afterRoot.length - 1]!, binding, json);
                expect(yield* ancestor({ cell: value })).toBe("Not Found");
                const afterAncestor = yield* backend.ledger;
                wire(
                  afterAncestor[afterAncestor.length - 1]!,
                  binding,
                  `{"cell":${json}}`,
                );
              }
              expect(yield* backend.ledger).toHaveLength(
                2 + 2 * alternative.scalars.length,
              );
            }),
        );
      }
    }

    for (const level of levels) {
      for (const order of orders) {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        it.live(
          `[EXT-49d] ${binding} ${level.name} ${order} a direct Void member refuses invalid aliases before dispatch`,
          () => voidRefuses(level, order, binding, Schema.Void),
        );
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        it.live(
          `[EXT-49e] ${binding} ${level.name} ${order} a direct Void member keeps valid aliases and leaves fieldless input first-fit`,
          () => voidKeeps(level, order, binding, Schema.Void),
        );
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        it.live(
          `[EXT-49g] ${binding} ${level.name} ${order} a Void nested in a primitive union keeps valid aliases and refuses invalid ones`,
          () =>
            Effect.gen(function* () {
              for (const [, alternative] of nestedVoidAlternatives) {
                yield* voidRefuses(level, order, binding, alternative);
                yield* voidKeeps(level, order, binding, alternative);
              }
            }),
        );
      }
      for (const order of orders) {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/170
        it.live(
          `[EXT-49f] ${binding} ${level.name} ${order} nested and flat FiniteFromString refuse invalid aliases and preserve valid bytes`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              for (const [, alternative] of encodedAlternatives) {
                const execute = operation(
                  backend.origin,
                  level.schema(alternative, order),
                  binding,
                );
                for (const page_size of invalid) {
                  const actual = yield* execute(
                    level.input({ page_size }),
                  ).pipe(outcome);
                  expect(
                    "error" in actual && Schema.isSchemaError(actual.error),
                  ).toBe(true);
                }
              }
              expect(yield* backend.ledger).toEqual([]);
              for (const [, alternative] of encodedAlternatives) {
                const execute = operation(
                  backend.origin,
                  level.schema(alternative, order),
                  binding,
                );
                for (const [leaf, json] of controls) {
                  expect(yield* execute(level.input({ ...leaf }))).toBe(
                    "Not Found",
                  );
                  const ledger = yield* backend.ledger;
                  wire(ledger[ledger.length - 1]!, binding, level.json(json));
                }
              }
              expect(yield* backend.ledger).toHaveLength(6);
            }),
        );
      }
    }

    // https://github.com/viell-dev/slop-effect-schema-http/issues/143
    it.live(
      `[EXT-49k] ${binding} Void after an object holding the filter refuses invalid aliases before dispatch`,
      () =>
        Effect.gen(function* () {
          for (const shape of objectThenVoid) {
            const backend = yield* start();
            yield* refusesBeforeDispatch(
              backend,
              operation(backend.origin, shape.schema, binding),
              invalid.map((page_size) => shape.input({ page_size })),
            );
          }
        }),
    );
    // https://github.com/viell-dev/slop-effect-schema-http/issues/143
    it.live(
      `[EXT-49l] ${binding} Void after an object holding the filter keeps valid aliases and an empty filter`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          let sent = 0;
          for (const shape of objectThenVoid) {
            const execute = operation(backend.origin, shape.schema, binding);
            for (const [leaf, json] of [
              ...valid.map((given) => [{ ...given }, five] as const),
              [{}, defaulted],
            ] as const) {
              const input = shape.input(leaf);
              const before = structuredClone(input);
              expect(yield* execute(input)).toBe("Not Found");
              expect(input).toEqual(before);
              const ledger = yield* backend.ledger;
              expect(ledger).toHaveLength(++sent);
              wire(ledger[sent - 1]!, binding, shape.json(json));
            }
          }
          expect(sent).toBe(9);
        }),
    );
  }

  for (const binding of ["query", "header"] as const) {
    for (const order of orders) {
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.live(
        `[EXT-49h] ${binding} JSON text field ${order} a direct Void member keeps valid aliases and refuses invalid ones before dispatch`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const execute = textField(
              backend.origin,
              pair(Schema.Void, Filter, order),
              binding,
            );
            // Void writes undefined, which has no JSON text, so a fieldless input it takes first is
            // refused too.
            yield* refusesBeforeDispatch(backend, execute, [
              ...invalid.map((page_size) => ({ page_size })),
              ...(order === "alternative first"
                ? [{}, { page_size: undefined }]
                : []),
            ]);
            const kept: ReadonlyArray<readonly [object, string]> = [
              ...valid.map((leaf) => [{ ...leaf }, five] as const),
              ...(order === "object first"
                ? ([
                    [{}, defaulted],
                    [{ page_size: undefined }, defaulted],
                  ] as const)
                : []),
            ];
            for (const [input, json] of kept) {
              expect(yield* execute(input)).toBe("Not Found");
              const ledger = yield* backend.ledger;
              textWire(ledger[ledger.length - 1]!, binding, json);
            }
            expect(yield* backend.ledger).toHaveLength(kept.length);
          }),
      );
    }
  }

  it("[EXT-49i] a union with a direct Void member is not a query or header group", () => {
    // Void encodes to undefined, which is neither a query nor a header group. The type refuses it,
    // so the group bindings are not representable for this rule; EXT-49h covers the text fields.
    for (const order of orders) {
      const schema = pair(Schema.Void, Filter, order) as Schema.Union<
        readonly [typeof Schema.Void, typeof Filter]
      >;
      // @ts-expect-error A Void member's undefined is not a query group's input.
      expect(typeof Request.query(schema)).toBe("function");
      // @ts-expect-error A Void member's undefined is not a header group's input.
      expect(typeof Request.headers(schema)).toBe("function");
    }
  });

  for (const [name, member] of openMembers) {
    for (const order of orders) {
      it.live(
        `[EXT-49j] ${name} ${order} keeps its own reading at the root and in JSON text fields`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const schema = pair(member, Filter, order);
            let sent = 0;
            for (const binding of ["path", "JSON"] as const) {
              const execute = operation(backend.origin, schema, binding);
              for (const [input, json] of openCases(order)) {
                const given = structuredClone(input);
                expect(yield* execute(given)).toBe("Not Found");
                expect(given).toEqual(input);
                const ledger = yield* backend.ledger;
                expect(ledger).toHaveLength(++sent);
                wire(ledger[sent - 1]!, binding, json);
              }
            }
            for (const binding of ["query", "header"] as const) {
              const execute = textField(backend.origin, schema, binding);
              for (const [input, json] of openCases(order)) {
                expect(yield* execute(structuredClone(input))).toBe(
                  "Not Found",
                );
                const ledger = yield* backend.ledger;
                expect(ledger).toHaveLength(++sent);
                textWire(ledger[sent - 1]!, binding, json);
              }
            }
            expect(sent).toBe(28);
          }),
      );
    }
  }

  for (const binding of ["path", "JSON"] as const) {
    for (const order of orders) {
      const union = pair(Schema.Void, Filter, order);
      for (const route of routes) {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        it.live(
          `[EXT-49m] ${binding} ${route.name} ${order} keeps valid aliases through the parent and refuses invalid ones`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              const execute = operation(
                backend.origin,
                route.schema(union),
                binding,
              );
              yield* refusesBeforeDispatch(
                backend,
                execute,
                route.refused(order),
              );
              const cases = [...route.kept, ...route.fieldless(order, binding)];
              for (const [input, json] of cases) {
                const before = structuredClone(input);
                expect(yield* execute(input)).toBe("Not Found");
                expect(input).toEqual(before);
                const ledger = yield* backend.ledger;
                wire(ledger[ledger.length - 1]!, binding, json);
              }
              expect(yield* backend.ledger).toHaveLength(cases.length);
            }),
        );
      }
    }

    for (const level of levels) {
      for (const order of orders) {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        it.live(
          `[EXT-49n] ${binding} ${level.name} ${order} annotated and checked Void members keep valid aliases and refuse invalid ones`,
          () =>
            Effect.gen(function* () {
              for (const [, variant] of voidVariants) {
                yield* voidRefuses(level, order, binding, variant);
                yield* voidKeeps(level, order, binding, variant);
              }
            }),
        );
      }
    }

    // https://github.com/viell-dev/slop-effect-schema-http/issues/143
    it.live(
      `[EXT-49n] ${binding} a Void member yields supplied fields to an open member or a list`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const cases: ReadonlyArray<readonly [WireSchema, unknown, string]> = [
            [
              Schema.Union([Schema.Void, Schema.Unknown]),
              { page_size: "05" },
              '{"page_size":"05"}',
            ],
            [
              Schema.Union([Schema.Void, Schema.Unknown]),
              { limit: 5 },
              '{"limit":5}',
            ],
            [
              Schema.Union([Schema.Void, Schema.Unknown]),
              {},
              voidRoot(binding),
            ],
            [
              Schema.Union([Schema.Void, Schema.Any]),
              { page_size: "05" },
              '{"page_size":"05"}',
            ],
            [Schema.Union([Schema.Void, Schema.Any]), {}, voidRoot(binding)],
            [
              Schema.Union([
                Schema.Void,
                Schema.Array(Schema.FiniteFromString),
              ]),
              [1],
              '["1"]',
            ],
            [
              Schema.Union([
                Schema.Void,
                Schema.Array(Schema.FiniteFromString),
              ]),
              [],
              voidRoot(binding),
            ],
          ];
          for (const [schema, input, json] of cases) {
            expect(
              yield* operation(backend.origin, schema, binding)(input),
            ).toBe("Not Found");
            const ledger = yield* backend.ledger;
            wire(ledger[ledger.length - 1]!, binding, json);
          }
          expect(yield* backend.ledger).toHaveLength(cases.length);
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/143
    it.live(
      `[EXT-49o] ${binding} class-backed and oneOf unions keep populated objects beside Void`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const cases: ReadonlyArray<readonly [WireSchema, unknown, string]> = [
            [
              Schema.Union([Schema.Void, FilterClass]),
              { limit: 5 },
              '{"limit":"5"}',
            ],
            [
              Schema.Union([FilterClass, Schema.Void]),
              { limit: 5 },
              '{"limit":"5"}',
            ],
            [
              VoidFirstParent,
              { filter: { limit: 5 } },
              '{"filter":{"page_size":"5"}}',
            ],
            [
              VoidFirstParent,
              { filter: { page_size: "05" } },
              '{"filter":{"page_size":"5"}}',
            ],
            [
              Schema.Union([Schema.Void, Filter], { mode: "oneOf" }),
              { page_size: "05" },
              five,
            ],
            [
              Schema.Union([Filter, Schema.Void], { mode: "oneOf" }),
              { page_size: "05" },
              five,
            ],
            [
              Schema.Union([Filter, Schema.Void], { mode: "oneOf" }),
              { limit: 5 },
              five,
            ],
          ];
          for (const [schema, input, json] of cases) {
            const before = structuredClone(input);
            expect(
              yield* operation(backend.origin, schema, binding)(input),
            ).toBe("Not Found");
            expect(input).toEqual(before);
            const ledger = yield* backend.ledger;
            wire(ledger[ledger.length - 1]!, binding, json);
          }
          expect(yield* backend.ledger).toHaveLength(cases.length);
          for (const [name, schema, input] of [
            [
              "class invalid alias",
              Schema.Union([FilterClass, Schema.Void]),
              { limit: "many" },
            ],
            [
              "oneOf invalid alias",
              Schema.Union([Schema.Void, Filter], { mode: "oneOf" }),
              { page_size: "many" },
            ],
            [
              "standalone Void with an object",
              Schema.Void,
              { page_size: "05" },
            ],
          ] as const) {
            const refusing = yield* start();
            const actual = yield* operation(
              refusing.origin,
              schema,
              binding,
            )(input).pipe(outcome);
            const ledger = yield* refusing.ledger;
            expect(
              {
                error: "error" in actual && Schema.isSchemaError(actual.error),
                requests: ledger.map(({ target, body }) => ({
                  target,
                  body: new TextDecoder().decode(body),
                })),
              },
              name,
            ).toEqual({ error: true, requests: [] });
          }
        }),
    );
    for (const [order, schema] of [
      ["object first", Schema.Union([Filter, Schema.Void], { mode: "oneOf" })],
      ["Void first", Schema.Union([Schema.Void, Filter], { mode: "oneOf" })],
    ] as const) {
      // https://github.com/viell-dev/slop-effect-schema-http/issues/276
      it.live(
        `[EXT-49o] a fieldless oneOf that both members read is refused before dispatch (${binding}, ${order})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const input = {};
            expect(Schema.decodeUnknownExit(schema)(input)._tag).toBe(
              "Failure",
            );
            const actual = yield* operation(
              backend.origin,
              schema,
              binding,
            )(input).pipe(outcome);
            expect(input).toEqual({});
            expect(yield* backend.ledger).toEqual([]);
            expect(
              "error" in actual && Schema.isSchemaError(actual.error),
            ).toBe(true);
            expect(String((actual as { error: unknown }).error)).toContain(
              "Expected exactly one member to match",
            );
          }),
      );
    }
  }

  for (const kind of ["query", "headers"] as const) {
    // https://github.com/viell-dev/slop-effect-schema-http/issues/236
    it.live(
      `[EXT-49i] ${kind} cast-only Void and open groups fail as InvalidRequest before dispatch and keep valid fields`,
      () =>
        Effect.gen(function* () {
          const refusing = yield* start();
          const VoidSort = Schema.Union([Schema.Void, Sort]);
          for (const [schema, inputs] of [
            [Schema.Void, [{}]],
            [pair(Schema.Void, Filter, "alternative first"), [{}]],
            [VoidSort, [{}]],
            ...(kind === "headers"
              ? ([
                  [Schema.Any, [{ "x-count": 5 }, { "x-count": null }]],
                  [Schema.Unknown, [{ "x-count": 5 }]],
                ] as const)
              : []),
          ] as const)
            yield* invalidRequestBeforeDispatch(
              refusing,
              group(refusing.origin, schema, kind),
              inputs,
            );
          const backend = yield* start();
          const sent: ReadonlyArray<
            readonly [unknown, unknown, string, string]
          > = [
            [
              pair(Schema.Void, Filter, "alternative first"),
              { page_size: "05" },
              "page_size",
              "5",
            ],
            [pair(Schema.Void, Filter, "object first"), {}, "page_size", "25"],
            [VoidSort, { sort: "a" }, "sort", "a"],
            ...(kind === "headers"
              ? ([[Schema.Any, { "x-count": "5" }, "x-count", "5"]] as const)
              : []),
          ];
          for (const [schema, input, name, value] of sent) {
            expect(yield* group(backend.origin, schema, kind)(input)).toBe(
              "Not Found",
            );
            const ledger = yield* backend.ledger;
            const entry = ledger[ledger.length - 1]!;
            expect(entry.method).toBe("GET");
            expect(entry.target).toBe(
              kind === "query" ? `/x?${name}=${value}` : "/x",
            );
            expect(headerValues(entry.lines, name)).toEqual(
              kind === "query" ? [] : [value],
            );
            expect(entry.body.byteLength).toBe(0);
          }
          expect(yield* backend.ledger).toHaveLength(sent.length);
        }),
    );
    // https://github.com/viell-dev/slop-effect-schema-http/issues/236
    it.live(
      `[EXT-49p] ${kind} a cast-only Void-first group refuses an invalid alias as a field SchemaError`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const execute = group(
            backend.origin,
            pair(Schema.Void, Filter, "alternative first"),
            kind,
          );
          const outcomes: Outcome[] = [];
          for (const page_size of invalid)
            outcomes.push(yield* execute({ page_size }).pipe(outcome));
          expect(yield* backend.ledger).toEqual([]);
          for (const actual of outcomes) {
            expect(
              "error" in actual && Schema.isSchemaError(actual.error),
            ).toBe(true);
            expect(String((actual as { error: unknown }).error)).toContain(
              '["page_size"]',
            );
          }
        }),
    );
  }

  for (const binding of ["path", "JSON"] as const) {
    for (const order of orders) {
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.live(
        `[EXT-49q] ${binding} ${order} Void keeps an object or list whose contents decode to undefined`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const Flagged = Schema.Struct({ flag: NullAsUndefined });
            const Cells = Schema.Array(NullAsUndefined);
            const cases: ReadonlyArray<readonly [WireSchema, unknown, string]> =
              [
                [
                  pair(Schema.Void, Flagged, order),
                  { flag: null },
                  '{"flag":null}',
                ],
                [pair(Schema.Void, Cells, order), [null], "[null]"],
                [pair(Schema.Void, Cells, order), [null, null], "[null,null]"],
                [
                  Schema.Struct({ x: pair(Schema.Void, Flagged, order) }),
                  { x: { flag: null } },
                  '{"x":{"flag":null}}',
                ],
                // Without a field or cell the first member that fits still wins.
                [pair(Schema.Void, Flagged, order), {}, voidRoot(binding)],
                [
                  pair(Schema.Void, Cells, order),
                  [],
                  order === "alternative first" ? voidRoot(binding) : "[]",
                ],
              ];
            for (const [schema, input, json] of cases) {
              const before = structuredClone(input);
              expect(
                yield* operation(backend.origin, schema, binding)(input),
              ).toBe("Not Found");
              expect(input).toEqual(before);
              const ledger = yield* backend.ledger;
              wire(ledger[ledger.length - 1]!, binding, json);
            }
            expect(yield* backend.ledger).toHaveLength(cases.length);
          }),
      );
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.live(
        `[EXT-49r] currently a refusal names the outer invalid field and the valid alias beside it (${binding}, ${order})`,
        () =>
          Effect.gen(function* () {
            const refusing = yield* start();
            const schema = Schema.Struct({
              extra: pair(
                Schema.Void,
                Schema.Struct({ a: Schema.Number }),
                order,
              ),
              filter: Filter,
            });
            const actual = yield* operation(
              refusing.origin,
              schema,
              binding,
            )({ extra: { a: "x" }, filter: { page_size: "05" } }).pipe(outcome);
            expect(yield* refusing.ledger).toEqual([]);
            expect(
              "error" in actual && Schema.isSchemaError(actual.error),
            ).toBe(true);
            const message = String((actual as { error: unknown }).error);
            const backend = yield* start();
            expect(
              yield* operation(
                backend.origin,
                schema,
                binding,
              )({ extra: { a: 1 }, filter: { page_size: "05" } }),
            ).toBe("Not Found");
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(1);
            wire(ledger[0]!, binding, `{"extra":{"a":1},"filter":${five}}`);
            expect(message).toContain('at ["extra"]\n');
            expect(message).toContain('at ["filter"]["page_size"]');
            expect(message).not.toContain('["extra"]["a"]');
          }),
      );
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.live(
        `[EXT-49t] ${binding} ${order} an optional Void union field keeps its populated constructor default`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const schema = Schema.Struct({
              g: Schema.optionalKey(
                pair(
                  Schema.Void,
                  Schema.Struct({ a: Schema.optionalKey(Schema.Number) }),
                  order,
                ),
              ).pipe(Schema.withConstructorDefault(Effect.succeed({ a: 1 }))),
            });
            // An all-undefined object has no field: Void's output first, the object as read last.
            const empty =
              order === "object first"
                ? '{"g":{}}'
                : binding === "path"
                  ? "{}"
                  : '{"g":null}';
            const cases = [
              [{}, '{"g":{"a":1}}'],
              [{ g: {} }, empty],
              [{ g: { a: undefined } }, empty],
              [{ g: { a: 2 } }, '{"g":{"a":2}}'],
            ] as const;
            for (const [input, json] of cases) {
              expect(
                yield* operation(backend.origin, schema, binding)(input),
              ).toBe("Not Found");
              const ledger = yield* backend.ledger;
              wire(ledger[ledger.length - 1]!, binding, json);
            }
            expect(yield* backend.ledger).toHaveLength(cases.length);
          }),
      );
    }
    for (const order of orders) {
      it.live(
        `[EXT-49s] ${binding} ${order} an array beside Void refuses invalid aliases and preserves valid lists`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const execute = operation(
              backend.origin,
              pair(Schema.Void, Schema.Array(Filter), order),
              binding,
            );
            yield* refusesBeforeDispatch(
              backend,
              execute,
              invalid.map((page_size) => [{ page_size }]),
            );
            const cases: ReadonlyArray<readonly [unknown, string]> = [
              [[{ page_size: "05" }], `[${five}]`],
              [[{ limit: 5 }], `[${five}]`],
              [[{}], `[${defaulted}]`],
              [[], order === "object first" ? "[]" : voidRoot(binding)],
            ];
            for (const [input, json] of cases) {
              expect(yield* execute(input)).toBe("Not Found");
              const ledger = yield* backend.ledger;
              wire(ledger[ledger.length - 1]!, binding, json);
            }
            expect(yield* backend.ledger).toHaveLength(cases.length);
          }),
      );
    }
  }
});
