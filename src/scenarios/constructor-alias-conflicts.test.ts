/**
 * Consumer-authored from the public #143 acceptance and 0.16 migration, using echo's HTTP contract:
 * https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6750236968
 * These are retained conflict limits, not a request to change constructor or decoder priority.
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
const OptionalFilters = Schema.Array(Schema.optional(Filter));
const NullableFilters = Schema.Array(Schema.NullOr(Filter));
const Filters = Schema.Array(Filter);
const response = Response.status(404, Body.text);
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
  return (input: Request.Input<S>) =>
    (binding === "path"
      ? path.execute({ path: input })
      : body.execute({ body: input })
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

// Capture only the fresh test-owned graph through descriptors: no caller iterator or getter runs.
const snapshot = (input: object) => {
  const objects: Array<{
    input: object;
    prototype: object | null;
    keys: ReadonlyArray<PropertyKey>;
    descriptors: PropertyDescriptorMap;
  }> = [];
  const visit = (value: object) => {
    const keys = Reflect.ownKeys(value);
    const descriptors: PropertyDescriptorMap =
      Object.getOwnPropertyDescriptors(value);
    objects.push({
      input: value,
      prototype: Object.getPrototypeOf(value),
      keys,
      descriptors,
    });
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (
        "value" in descriptor &&
        typeof descriptor.value === "object" &&
        descriptor.value !== null
      )
        visit(descriptor.value);
    }
  };
  visit(input);
  return objects;
};
const unchanged = (before: ReturnType<typeof snapshot>) => {
  for (const { input, prototype, keys, descriptors } of before) {
    expect(Object.getPrototypeOf(input)).toBe(prototype);
    expect(Reflect.ownKeys(input)).toEqual(keys);
    for (const key of keys) {
      const expected = descriptors[key]!;
      const actual = Object.getOwnPropertyDescriptor(input, key)!;
      expect(actual.enumerable).toBe(expected.enumerable);
      expect(actual.configurable).toBe(expected.configurable);
      if ("value" in expected) {
        expect(actual.writable).toBe(expected.writable);
        expect(actual.value).toBe(expected.value);
      } else {
        expect(actual.get).toBe(expected.get);
        expect(actual.set).toBe(expected.set);
      }
    }
  }
};
const dense = <T>(items: ReadonlyArray<T>) => items.slice();
const native = <T>(items: ReadonlyArray<T>) => {
  const input = items.slice();
  input[Symbol.iterator] = Array.prototype[Symbol.iterator];
  return input;
};
const sparse = <T>(
  items: ReadonlyArray<T>,
  shape: "ordinary" | "hidden" | "null prototype",
) => {
  const input: Array<T | undefined> = [];
  input.length = items.length + 1;
  for (let index = 0; index < items.length; index++)
    Object.defineProperty(input, index === 0 ? "0" : String(index + 1), {
      value: items[index],
      writable: true,
      configurable: true,
      enumerable: shape !== "hidden",
    });
  if (shape === "null prototype") Object.setPrototypeOf(input, null);
  return input;
};
const fixtures = [
  {
    name: "optional elements",
    id: "[EXT-48a]",
    schema: OptionalFilters,
    arrange: dense,
    sparse: false,
  },
  {
    name: "nullable elements",
    id: "[EXT-48a]",
    schema: NullableFilters,
    arrange: dense,
    sparse: false,
  },
  {
    name: "exact native own iterator",
    id: "[EXT-48b]",
    schema: Filters,
    arrange: native,
    sparse: false,
  },
  ...(["ordinary", "hidden", "null prototype"] as const).map((shape) => ({
    name: `${shape} sparse optional cells`,
    id: "[EXT-48c]",
    schema: OptionalFilters,
    arrange: <T>(items: ReadonlyArray<T>) => sparse(items, shape),
    sparse: true,
  })),
] as const;
const jsonFor = (cells: ReadonlyArray<string>, hasHole: boolean) =>
  `[${hasHole ? [cells[0], "null", ...cells.slice(1)].join(",") : cells.join(",")}]`;

// The nonliteral input is accepted on all three public input types without casts. This is a
// compatibility limit that TypeScript does not prohibit; the ordinary wire pins keep it visible.
const inputTypes = () => {
  const bothNames = [{ limit: 1, page_size: "02" }, { page_size: "25" }];
  const optional: Request.Input<typeof OptionalFilters> = bothNames;
  const nullable: Request.Input<typeof NullableFilters> = bothNames;
  const ownNative: Request.Input<typeof Filters> = bothNames;
  return { optional, nullable, ownNative };
};
void inputTypes;

describe(`constructor alias conflicts (${lane.name})`, () => {
  for (const fixture of fixtures) {
    const { schema } = fixture;
    for (const binding of ["path", "JSON"] as const) {
      it.live(
        `${fixture.id} currently ${binding} ${fixture.name} changes a dual-name item only beside an encoded-only neighbor`,
        () =>
          Effect.gen(function* () {
            const backend = yield* lane.backend("echo", undefined, {
              listener: "socket",
            });
            const execute = operation(backend.origin, schema, binding);
            const bothNames = { limit: 1, page_size: "02" };
            const examples = [
              {
                cells: [{ page_size: "01" }, { page_size: "25" }],
                output: ['{"page_size":"1"}', '{"page_size":"25"}'],
              },
              {
                cells: [{ limit: 1 }, { limit: 25 }],
                output: ['{"page_size":"1"}', '{"page_size":"25"}'],
              },
              { cells: [bothNames], output: ['{"page_size":"1"}'] },
              {
                cells: [bothNames, { limit: 25 }],
                output: ['{"page_size":"1"}', '{"page_size":"25"}'],
              },
              {
                cells: [bothNames, {}],
                output: ['{"page_size":"1"}', '{"page_size":"25"}'],
              },
              {
                cells: [bothNames, { page_size: "25" }],
                output: ['{"page_size":"2"}', '{"page_size":"25"}'],
              },
            ];
            for (const { cells, output } of examples) {
              const input = fixture.arrange(cells);
              const supplied: Request.Input<typeof schema> = input;
              const before = snapshot(input);
              expect(yield* execute(supplied)).toBe("Not Found");
              unchanged(before);
              if (fixture.sparse) expect(Object.hasOwn(input, 1)).toBe(false);
              const ledger = yield* backend.ledger;
              wire(
                ledger[ledger.length - 1]!,
                binding,
                jsonFor(output, fixture.sparse),
              );
            }
            expect(yield* backend.ledger).toHaveLength(6);
          }),
      );
      it.live.fails(
        `[EXT-48d] goal ${binding} ${fixture.name} contradictory aliases refuse before dispatch`,
        () =>
          Effect.gen(function* () {
            const backend = yield* lane.backend("echo", undefined, {
              listener: "socket",
            });
            const execute = operation(backend.origin, schema, binding);
            const bothNames = { limit: 1, page_size: "02" };
            const examples = [
              [bothNames],
              [bothNames, { limit: 25 }],
              [bothNames, {}],
              [bothNames, { page_size: "25" }],
            ];
            const outcomes = [];
            for (const cells of examples) {
              const input = fixture.arrange(cells);
              const supplied: Request.Input<typeof schema> = input;
              const before = snapshot(input);
              outcomes.push(yield* execute(supplied).pipe(result));
              unchanged(before);
              if (fixture.sparse) expect(Object.hasOwn(input, 1)).toBe(false);
            }
            expect({ outcomes, ledger: yield* backend.ledger }).toMatchObject({
              outcomes: Array.from({ length: 4 }, () => ({
                error: { _tag: "SchemaError" },
              })),
              ledger: [],
            });
          }),
      );
    }
  }
});
