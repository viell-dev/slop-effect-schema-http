/**
 * Independently consumer-authored from the accepted nested primitive alternative scope under
 * https://github.com/viell-dev/slop-effect-schema-http/issues/170, the library's public
 * schema-input guide and the echo HTTP contract in README.md. Expected outcomes outside that scope
 * (EXT-49f, EXT-49g, EXT-49j, EXT-49k) were observed over the wire before being pinned. The direct
 * Void cases (EXT-49d, EXT-49e, EXT-49h, EXT-49l) follow the Void field-preservation rule of #143
 * as the library's guide and design page state it, checked against observed HTTP behaviour.
 * No library implementation, library source tests, backend or conformance code was read.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
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

// A Void nested inside a union of primitives is not a direct member of the union that holds the
// object, so the direct Void rule (EXT-49d, EXT-49e) does not reach it (EXT-49g).
const nestedVoidAlternatives = [
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
        const schema = level.schema(Schema.Void, order);
        // The object member holds Filter one level down, and Void follows it (EXT-49k, EXT-49l).
        const deferred = level.name === "ancestor" && order === "object first";
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        if (!deferred)
          it.live(
            `[EXT-49d] ${binding} ${level.name} ${order} a direct Void member refuses invalid aliases before dispatch`,
            () =>
              Effect.gen(function* () {
                const backend = yield* start();
                yield* refusesBeforeDispatch(
                  backend,
                  operation(backend.origin, schema, binding),
                  invalid.map((page_size) => level.input({ page_size })),
                );
              }),
          );
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        it.live(
          `[EXT-49e] ${binding} ${level.name} ${order} a direct Void member keeps valid aliases and leaves fieldless input first-fit`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              const execute = operation(backend.origin, schema, binding);
              const cases: ReadonlyArray<readonly [unknown, string]> = [
                ...valid.map(
                  (leaf) =>
                    [level.input({ ...leaf }), level.json(five)] as const,
                ),
                // An empty filter in the ancestor's cell is a supplied field of the union's input.
                ...(level.name === "ancestor"
                  ? [{}, { page_size: undefined }].map(
                      (leaf) =>
                        [level.input(leaf), level.json(defaulted)] as const,
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
            }),
        );
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143
        it.live(
          `[EXT-49g] currently ${binding} ${level.name} ${order} a Void nested in a primitive union consumes supplied fields`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              let sent = 0;
              for (const [, alternative] of nestedVoidAlternatives) {
                const execute = operation(
                  backend.origin,
                  level.schema(alternative, order),
                  binding,
                );
                const cases: ReadonlyArray<readonly [object, string]> =
                  order === "alternative first"
                    ? [
                        ...invalid.map((page_size) => ({ page_size })),
                        ...controls.map(([leaf]) => ({ ...leaf })),
                      ].map((leaf) => [leaf, voidJson(level, binding)] as const)
                    : [
                        ...[
                          { page_size: "05" },
                          ...invalid.map((page_size) => ({ page_size })),
                        ].map(
                          (leaf) => [leaf, voidJson(level, binding)] as const,
                        ),
                        [{ limit: 5 }, level.json(five)],
                        [{}, level.json(defaulted)],
                      ];
                for (const [leaf, json] of cases) {
                  expect(yield* execute(level.input(leaf))).toBe("Not Found");
                  const ledger = yield* backend.ledger;
                  expect(ledger).toHaveLength(++sent);
                  wire(ledger[sent - 1]!, binding, json);
                }
              }
              expect(sent).toBe(15);
            }),
        );
      }
      for (const order of orders) {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/170
        it.live(
          `[EXT-49f] currently ${binding} ${level.name} ${order} an encoded-primitive alternative lets the default replace invalid aliases like flat FiniteFromString`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              for (const [, alternative] of encodedAlternatives) {
                const execute = operation(
                  backend.origin,
                  level.schema(alternative, order),
                  binding,
                );
                for (const [leaf, json] of [
                  ...controls,
                  ...invalid.map(
                    (page_size) =>
                      [{ page_size }, '{"page_size":"25"}'] as const,
                  ),
                ]) {
                  expect(yield* execute(level.input({ ...leaf }))).toBe(
                    "Not Found",
                  );
                  const ledger = yield* backend.ledger;
                  wire(ledger[ledger.length - 1]!, binding, level.json(json));
                }
              }
              expect(yield* backend.ledger).toHaveLength(10);
            }),
        );
      }
    }

    // https://github.com/viell-dev/slop-effect-schema-http/issues/143
    it.live(
      `[EXT-49k] currently ${binding} Void after an object holding the filter lets the default replace invalid aliases`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          let sent = 0;
          for (const shape of objectThenVoid) {
            const execute = operation(backend.origin, shape.schema, binding);
            for (const page_size of invalid) {
              const input = shape.input({ page_size });
              const before = structuredClone(input);
              expect(yield* execute(input)).toBe("Not Found");
              expect(input).toEqual(before);
              const ledger = yield* backend.ledger;
              expect(ledger).toHaveLength(++sent);
              wire(ledger[sent - 1]!, binding, shape.json(defaulted));
            }
          }
          expect(sent).toBe(6);
        }),
    );
    // The guide and design page promise that a supplied field no member keeps is refused.
    // https://github.com/viell-dev/slop-effect-schema-http/issues/143
    it.live.fails(
      `[EXT-49l] goal ${binding} Void after an object holding the filter refuses invalid aliases before dispatch`,
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
});
