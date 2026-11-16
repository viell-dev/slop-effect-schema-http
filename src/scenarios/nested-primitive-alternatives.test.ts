/**
 * Independently consumer-authored from the accepted nested primitive alternative scope under
 * https://github.com/viell-dev/slop-effect-schema-http/issues/170, the library's public
 * schema-input guide and the echo HTTP contract in README.md. Expected outcomes outside that scope
 * (EXT-49d to EXT-49f) were observed over the wire before being pinned.
 * No library implementation, library source tests, backend or conformance code was read.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

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

// Boundary members the public guide excludes from the rule, each with its flat counterpart.
const voidAlternatives = [
  [
    "nested Literals and Void",
    Schema.Union([Schema.Literals(["all"]), Schema.Void]),
  ],
  ["flat Void", Schema.Void],
] as const satisfies ReadonlyArray<readonly [string, WireSchema]>;
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
        // https://github.com/viell-dev/slop-effect-schema-http/issues/170
        it.live(
          `[EXT-49d] currently ${binding} ${level.name} ${order} a Void-containing alternative consumes invalid aliases like flat Void`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              let sent = 0;
              for (const [, alternative] of voidAlternatives) {
                const execute = operation(
                  backend.origin,
                  level.schema(alternative, order),
                  binding,
                );
                const inputs: ReadonlyArray<object> =
                  order === "alternative first"
                    ? [
                        ...invalid.map((page_size) => ({ page_size })),
                        ...controls.map(([leaf]) => ({ ...leaf })),
                      ]
                    : invalid.map((page_size) => ({ page_size }));
                for (const leaf of inputs) {
                  expect(yield* execute(level.input(leaf))).toBe("Not Found");
                  const ledger = yield* backend.ledger;
                  expect(ledger).toHaveLength(++sent);
                  wire(ledger[sent - 1]!, binding, voidJson(level, binding));
                }
              }
              expect(sent).toBe(order === "alternative first" ? 10 : 4);
            }),
        );
      }
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.live(
        `[EXT-49e] currently ${binding} ${level.name} a Void-containing alternative after the object captures a valid encoded alias like flat Void`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            for (const [, alternative] of voidAlternatives) {
              const execute = operation(
                backend.origin,
                level.schema(alternative, "object first"),
                binding,
              );
              for (const [leaf, json] of [
                [{ page_size: "05" }, voidJson(level, binding)],
                [{ limit: 5 }, level.json('{"page_size":"5"}')],
                [{}, level.json('{"page_size":"25"}')],
              ] as const) {
                expect(yield* execute(level.input({ ...leaf }))).toBe(
                  "Not Found",
                );
                const ledger = yield* backend.ledger;
                wire(ledger[ledger.length - 1]!, binding, json);
              }
            }
            expect(yield* backend.ledger).toHaveLength(6);
          }),
      );
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
  }
});
