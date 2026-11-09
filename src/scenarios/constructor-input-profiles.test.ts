/**
 * Independently consumer-authored from the accepted #170 combined batch and echo HTTP contract:
 * https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6749956596
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
const Filters = Schema.Array(Filter);
const OptionalFilters = Schema.Array(Schema.optional(Filter));
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
type Binding = "path" | "JSON";
type WireSchema = Schema.Top &
  Schema.ConstraintCodec<unknown, unknown, never, never>;
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
const result = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ error }),
      onSuccess: (value) => ({ value }),
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
// Only test-owned ordinary input graphs are inspected. Own descriptors avoid calling an
// iterator/getter, and retain hidden cells and nested iterator flags in the caller assertions.
const snapshot = (root: object) => {
  const seen = new Set<object>();
  const objects: Array<{
    input: object;
    prototype: object | null;
    properties: Array<{ key: PropertyKey; descriptor: PropertyDescriptor }>;
  }> = [];
  const visit = (input: object) => {
    if (seen.has(input)) return;
    seen.add(input);
    const properties = Reflect.ownKeys(input).map((key) => ({
      key,
      descriptor: Object.getOwnPropertyDescriptor(input, key)!,
    }));
    objects.push({
      input,
      prototype: Object.getPrototypeOf(input),
      properties,
    });
    for (const { descriptor } of properties)
      if (
        "value" in descriptor &&
        typeof descriptor.value === "object" &&
        descriptor.value !== null
      )
        visit(descriptor.value);
  };
  visit(root);
  return objects;
};
const unchanged = (root: object, before: ReturnType<typeof snapshot>) => {
  expect(before[0]!.input).toBe(root);
  for (const { input, prototype, properties } of before) {
    expect(Object.getPrototypeOf(input)).toBe(prototype);
    expect(Reflect.ownKeys(input)).toEqual(properties.map(({ key }) => key));
    for (const { key, descriptor } of properties) {
      const actual = Object.getOwnPropertyDescriptor(input, key)!;
      expect(actual.enumerable).toBe(descriptor.enumerable);
      expect(actual.configurable).toBe(descriptor.configurable);
      if ("value" in descriptor) {
        expect(actual.writable).toBe(descriptor.writable);
        expect(actual.value).toBe(descriptor.value);
      } else {
        expect(actual.get).toBe(descriptor.get);
        expect(actual.set).toBe(descriptor.set);
      }
    }
  }
};
type Fixture = {
  readonly name: string;
  readonly schema: WireSchema;
  readonly input: (leaf: object) => object;
  readonly json: (leaf: string) => string;
};
const wrappers = [
  {
    name: "dense optional elements",
    schema: OptionalFilters,
    input: (leaf) => [undefined, leaf],
    json: (leaf) => `[null,${leaf}]`,
  },
  {
    name: "fixed optional tuple",
    schema: Schema.Tuple([Schema.String, Schema.optional(Filter)]),
    input: (leaf) => ["head/end", leaf],
    json: (leaf) => `["head/end",${leaf}]`,
  },
  {
    name: "optional object ancestor",
    schema: Schema.Struct({ filter: Schema.optional(Filter) }),
    input: (leaf) => ({ filter: leaf }),
    json: (leaf) => `{"filter":${leaf}}`,
  },
  {
    name: "nullable object ancestor",
    schema: Schema.Struct({ filter: Schema.NullOr(Filter) }),
    input: (leaf) => ({ filter: leaf }),
    json: (leaf) => `{"filter":${leaf}}`,
  },
  {
    name: "nullish object ancestor",
    schema: Schema.Struct({ filter: Schema.NullishOr(Filter) }),
    input: (leaf) => ({ filter: leaf }),
    json: (leaf) => `{"filter":${leaf}}`,
  },
  {
    name: "root nullable filter",
    schema: Schema.NullOr(Filter),
    input: (leaf) => leaf,
    json: (leaf) => leaf,
  },
  {
    name: "object then string alternative",
    schema: Schema.Union([Filter, Schema.String]),
    input: (leaf) => leaf,
    json: (leaf) => leaf,
  },
  {
    name: "boolean then wrapped object alternative",
    schema: Schema.Union([
      Schema.Boolean,
      Schema.Struct({ filters: Schema.Array(Schema.NullOr(Filter)) }),
    ]),
    input: (leaf) => ({ filters: [null, leaf] }),
    json: (leaf) => `{"filters":[null,${leaf}]}`,
  },
] satisfies ReadonlyArray<Fixture>;

const sparse = (
  leaf: object,
  shape: "ordinary" | "hidden" | "null prototype",
) => {
  const input: unknown[] = [];
  input.length = 4;
  Object.defineProperty(input, "1", {
    value: leaf,
    configurable: true,
    writable: true,
    enumerable: shape !== "hidden",
  });
  if (shape === "null prototype") Object.setPrototypeOf(input, null);
  return input;
};
const sparseFixtures: ReadonlyArray<Fixture> = [
  ...(["ordinary", "hidden", "null prototype"] as const).map((shape) => ({
    name: `${shape} sparse own cell`,
    schema: OptionalFilters,
    input: (leaf: object) => sparse(leaf, shape),
    json: (leaf: string) => `[null,${leaf},null,null]`,
  })),
  {
    name: "optional tuple own cell between holes",
    schema: Schema.Tuple([
      Schema.optional(Filter),
      Schema.optional(Filter),
      Schema.optional(Schema.String),
    ]),
    input: (leaf) => {
      const input: unknown[] = [];
      input.length = 3;
      input[1] = leaf;
      return input;
    },
    json: (leaf) => `[null,${leaf},null]`,
  },
  {
    name: "post-rest own cell after holes",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.optional(Schema.Boolean),
      Filter,
    ]),
    input: (leaf) => {
      const input: unknown[] = ["head/end"];
      input.length = 4;
      input[3] = leaf;
      return input;
    },
    json: (leaf) => `["head/end",null,null,${leaf}]`,
  },
];
const nativeIterator = (
  input: unknown[],
  shape: "enumerable" | "hidden" | "frozen" | "null prototype",
) => {
  Object.defineProperty(input, Symbol.iterator, {
    value: Array.prototype[Symbol.iterator],
    enumerable: shape !== "hidden",
    writable: true,
    configurable: true,
  });
  if (shape === "null prototype") Object.setPrototypeOf(input, null);
  if (shape === "frozen") Object.freeze(input);
  return input;
};
const iterators: ReadonlyArray<Fixture> = [
  ...(["enumerable", "hidden", "frozen", "null prototype"] as const).map(
    (shape) => ({
      name: `${shape} native own iterator`,
      schema: Filters,
      input: (leaf: object) => nativeIterator([leaf], shape),
      json: (leaf: string) => `[${leaf}]`,
    }),
  ),
  {
    name: "nested native iterators with inner stray",
    schema: Schema.Array(Filters),
    input: (leaf) =>
      nativeIterator(
        [nativeIterator([{ ...leaf, stray: "ignored" }], "hidden")],
        "enumerable",
      ),
    json: (leaf) => `[[${leaf}]]`,
  },
  {
    name: "wrapped native iterator with inner stray",
    schema: Schema.Struct({ filters: Filters }),
    input: (leaf) => ({
      filters: nativeIterator([{ ...leaf, stray: "ignored" }], "enumerable"),
    }),
    json: (leaf) => `{"filters":[${leaf}]}`,
  },
];
const controls = [
  [{ page_size: "05" }, '{"page_size":"5"}'],
  [{ limit: 5 }, '{"page_size":"5"}'],
  [{}, '{"page_size":"25"}'],
] as const;

const inputTypes = () => {
  const encoded: Request.Input<typeof OptionalFilters> = [
    undefined,
    { page_size: "05" },
  ];
  const decoded: Request.Input<typeof OptionalFilters> = [
    undefined,
    { limit: 5 },
  ];
  const invalid: Request.Input<typeof OptionalFilters> = [
    // @ts-expect-error A nullable/optional wrapper does not admit a boolean finite-number alias.
    { page_size: true },
  ];
  return { encoded, decoded, invalid };
};
void inputTypes;

describe(`constructor input profiles (${lane.name})`, () => {
  for (const binding of ["path", "JSON"] as const) {
    for (const [fixtures, ids] of [
      [wrappers, ["[EXT-47a]", "[EXT-47b]", "[EXT-47c]"]],
      [sparseFixtures, ["[EXT-47d]", "[EXT-47e]", "[EXT-47f]"]],
      [iterators, ["[EXT-47g]", "[EXT-47h]", "[EXT-47i]"]],
    ] as const) {
      for (const fixture of fixtures) {
        it.live(
          `${ids[0]} ${binding} ${fixture.name} retains encoded decoded and omitted bytes`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              const execute = operation(
                backend.origin,
                fixture.schema,
                binding,
              );
              for (const [leaf, json] of controls) {
                const input = fixture.input({ ...leaf });
                const before = snapshot(input);
                expect(yield* execute(input)).toBe("Not Found");
                unchanged(input, before);
                const ledger = yield* backend.ledger;
                wire(ledger[ledger.length - 1]!, binding, fixture.json(json));
              }
              expect(yield* backend.ledger).toHaveLength(3);
            }),
        );
        it.live(
          `${ids[1]} ${binding} ${fixture.name} refuses invalid aliases without default dispatch`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              const execute = operation(
                backend.origin,
                fixture.schema,
                binding,
              );
              for (const page_size of ["many", null]) {
                const input = fixture.input({ page_size });
                const before = snapshot(input);
                expect(yield* execute(input).pipe(result)).toMatchObject({
                  error: { _tag: "SchemaError" },
                });
                unchanged(input, before);
              }
              const ledger = yield* backend.ledger;
              expect(ledger).toEqual([]);
            }),
        );
        it.live(
          `${ids[2]} ${binding} ${fixture.name} refuses invalid aliases before dispatch`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              const execute = operation(
                backend.origin,
                fixture.schema,
                binding,
              );
              const outcomes = [];
              for (const page_size of ["many", null]) {
                const input = fixture.input({ page_size });
                const before = snapshot(input);
                outcomes.push(yield* execute(input).pipe(result));
                unchanged(input, before);
              }
              expect({ outcomes, ledger: yield* backend.ledger }).toMatchObject(
                {
                  outcomes: [
                    { error: { _tag: "SchemaError" } },
                    { error: { _tag: "SchemaError" } },
                  ],
                  ledger: [],
                },
              );
            }),
        );
      }
    }

    it.live(
      `[EXT-47j] ${binding} scalar null absent and empty alternatives retain their own bytes`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          for (const [schema, input, json] of [
            [OptionalFilters, [], "[]"],
            [OptionalFilters, [undefined], "[null]"],
            [
              Schema.Tuple([Schema.String, Schema.optionalKey(Filter)]),
              ["head/end"],
              '["head/end"]',
            ],
            [Schema.Struct({ filter: Schema.optionalKey(Filter) }), {}, "{}"],
            [
              Schema.Struct({ filter: Schema.NullishOr(Filter) }),
              { filter: undefined },
              binding === "path" ? "{}" : '{"filter":null}',
            ],
            [
              Schema.Struct({ filter: Schema.NullOr(Filter) }),
              { filter: null },
              '{"filter":null}',
            ],
            [Schema.NullOr(Filter), null, "null"],
            [
              Schema.Union([Filter, Schema.String]),
              "literal/end",
              '"literal/end"',
            ],
            [
              Schema.Union([
                Schema.Boolean,
                Schema.Struct({ filters: Filters }),
              ]),
              false,
              "false",
            ],
          ] as const) {
            expect(
              yield* operation(backend.origin, schema, binding)(input),
            ).toBe("Not Found");
            const ledger = yield* backend.ledger;
            wire(ledger[ledger.length - 1]!, binding, json);
          }
          expect(yield* backend.ledger).toHaveLength(9);
        }),
    );

    for (const shape of [
      "wrapper",
      "entries",
      "bound",
      "accessor",
      "subclass",
    ] as const) {
      it.live(
        `[EXT-47k] currently ${binding} ${shape} iterator profiles remain excluded without iteration`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const input = [{ page_size: "many" }];
            let calls = 0;
            let gets = 0;
            const wrapper = () => {
              calls++;
              return Array.prototype[Symbol.iterator].call(input);
            };
            if (shape === "subclass") {
              class ConsumerArray extends Array<{ page_size: string }> {}
              Object.setPrototypeOf(input, ConsumerArray.prototype);
            } else if (shape === "accessor") {
              Object.defineProperty(input, Symbol.iterator, {
                configurable: true,
                get: () => {
                  gets++;
                  return wrapper;
                },
              });
            } else {
              Object.defineProperty(input, Symbol.iterator, {
                configurable: true,
                enumerable: true,
                value:
                  shape === "entries"
                    ? Array.prototype.entries
                    : shape === "bound"
                      ? Array.prototype[Symbol.iterator].bind(input)
                      : wrapper,
              });
            }
            const before = snapshot(input);
            expect(
              yield* operation(backend.origin, Filters, binding)(input),
            ).toBe("Not Found");
            expect({ calls, gets }).toEqual({ calls: 0, gets: 0 });
            unchanged(input, before);
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(1);
            wire(ledger[0]!, binding, '[{"page_size":"25"}]');
          }),
      );
    }

    it.live(
      `[EXT-47l] currently ${binding} Void and open alternatives preserve their own member behavior`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const voidSchema = Schema.Struct({
            filter: Schema.Union([Schema.Void, Filter]),
          });
          const openSchema = Schema.Struct({
            filter: Schema.Union([Schema.Unknown, Filter]),
          });
          expect(
            yield* operation(
              backend.origin,
              voidSchema,
              binding,
            )({ filter: { page_size: "many" } }),
          ).toBe("Not Found");
          expect(
            yield* operation(
              backend.origin,
              openSchema,
              binding,
            )({ filter: { page_size: "many" } }),
          ).toBe("Not Found");
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(2);
          wire(
            ledger[0]!,
            binding,
            binding === "path" ? "{}" : '{"filter":null}',
          );
          wire(ledger[1]!, binding, '{"filter":{"page_size":"many"}}');
        }),
    );

    it.live(
      `[EXT-47m] ${binding} optionalKey ancestors retain their existing refusal and omission behavior`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const execute = operation(
            backend.origin,
            Schema.Struct({ filter: Schema.optionalKey(Filter) }),
            binding,
          );
          for (const page_size of ["many", null])
            expect(
              yield* execute({ filter: { page_size } }).pipe(result),
            ).toMatchObject({
              error: { _tag: "SchemaError" },
            });
          expect(yield* backend.ledger).toEqual([]);
          expect(yield* execute({})).toBe("Not Found");
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          wire(ledger[0]!, binding, "{}");
        }),
    );

    const gated = Schema.NullOr(
      Schema.Struct({
        limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
        count: Schema.FiniteFromString,
        shared: Schema.StringFromBase64,
      }).pipe(Schema.encodeKeys({ limit: "page_size" })),
    );
    it.live(
      `[EXT-47n] ${binding} a nullable root mixed-side gate refuses after complete-side controls`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const execute = operation(backend.origin, gated, binding);
          for (const [input, json] of [
            [
              { limit: 5, count: 7, shared: "eA==" },
              '{"page_size":"5","count":"7","shared":"ZUE9PQ=="}',
            ],
            [
              { page_size: "05", count: "07", shared: "eA==" },
              '{"page_size":"5","count":"7","shared":"eA=="}',
            ],
          ] as const) {
            expect(yield* execute(input)).toBe("Not Found");
            const ledger = yield* backend.ledger;
            wire(ledger[ledger.length - 1]!, binding, json);
          }
          expect(
            yield* execute({ page_size: "05", count: 7, shared: "eA==" }).pipe(
              result,
            ),
          ).toMatchObject({ error: { _tag: "SchemaError" } });
          expect(yield* backend.ledger).toHaveLength(2);
        }),
    );
    it.live(
      `[EXT-47o] ${binding} a nullable root mixed-side gate refuses without fieldwise reinterpretation`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const execute = operation(backend.origin, gated, binding);
          const actual = yield* execute({
            page_size: "05",
            count: 7,
            shared: "eA==",
          }).pipe(result);
          expect({ actual, ledger: yield* backend.ledger }).toMatchObject({
            actual: { error: { _tag: "SchemaError" } },
            ledger: [],
          });
        }),
    );

    it.live(
      `[EXT-47p] currently ${binding} an inherited-only alias supplies no own-cell witness`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const input: Array<{ page_size: string }> = [];
          input.length = 1;
          Object.setPrototypeOf(
            input,
            Object.create(Array.prototype, {
              "0": { value: { page_size: "many" }, enumerable: true },
            }),
          );
          const before = snapshot(input);
          const inherited = input[0];
          expect(
            yield* operation(backend.origin, Filters, binding)(input),
          ).toBe("Not Found");
          unchanged(input, before);
          expect(Object.hasOwn(input, 0)).toBe(false);
          expect(input[0]).toBe(inherited);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          wire(ledger[0]!, binding, '[{"page_size":"25"}]');
        }),
    );

    it.live(
      `[EXT-47q] ${binding} native iterator refusal preserves the original default callback count`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          let defaults = 0;
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
          const execute = operation(
            backend.origin,
            Schema.Array(Counted),
            binding,
          );
          expect(
            yield* execute(
              nativeIterator([{ page_size: "many" }], "enumerable"),
            ).pipe(result),
          ).toMatchObject({ error: { _tag: "SchemaError" } });
          expect(defaults).toBe(1);
          const ledger = yield* backend.ledger;
          expect(ledger).toEqual([]);
        }),
    );

    it.live(
      `[EXT-47r] ${binding} actual nested fieldwise consumption retains shared decoded text`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const schema = Schema.NullOr(
            Schema.Struct({
              filter: Filter,
              count: Schema.FiniteFromString,
              shared: Schema.StringFromBase64,
            }),
          );
          expect(
            yield* operation(
              backend.origin,
              schema,
              binding,
            )({
              filter: { page_size: "05" },
              count: 7,
              shared: "eA==",
            }),
          ).toBe("Not Found");
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          wire(
            ledger[0]!,
            binding,
            '{"filter":{"page_size":"5"},"count":"7","shared":"ZUE9PQ=="}',
          );
        }),
    );

    it.live(
      `[EXT-47s] currently ${binding} a private array prototype with own and inherited aliases retains defaults`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const input: Array<{ page_size: string } | undefined> = [];
          input.length = 2;
          input[1] = { page_size: "05" };
          Object.setPrototypeOf(
            input,
            Object.create(Array.prototype, {
              "0": { value: { page_size: "many" }, enumerable: true },
            }),
          );
          const before = snapshot(input);
          const inherited = input[0];
          const actual = yield* operation(
            backend.origin,
            OptionalFilters,
            binding,
          )(input).pipe(result);
          unchanged(input, before);
          expect(Object.hasOwn(input, 0)).toBe(false);
          expect(input[0]).toBe(inherited);
          const ledger = yield* backend.ledger;
          expect(actual).toEqual({ value: "Not Found" });
          expect(ledger).toHaveLength(1);
          wire(ledger[0]!, binding, '[{"page_size":"25"},{"page_size":"25"}]');
        }),
    );
  }
});
