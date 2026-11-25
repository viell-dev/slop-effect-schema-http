/**
 * Consumer coverage from PR #235, the public schema-input reference and the echo contract.
 * https://github.com/viell-dev/slop-effect-schema-http/pull/235
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaGetter } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Backend, type Recorded } from "../harness/lane.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const Filters = Schema.Array(Filter);

type WireSchema = Schema.Top &
  Schema.ConstraintCodec<unknown, unknown, never, never>;
type Binding = "path" | "JSON";
type Sample = readonly [input: unknown, json: string];
const bindings = ["path", "JSON"] as const;
const orders = ["alternative first", "filter first"] as const;
type Order = (typeof orders)[number];
const union = (filter: WireSchema, alternative: WireSchema, order: Order) =>
  order === "filter first"
    ? Schema.Union([filter, alternative])
    : Schema.Union([alternative, filter]);
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });

function bind<S extends WireSchema>(
  origin: string,
  schema: S,
  binding: Binding,
) {
  if (binding === "path") {
    const operation = Operation.make(
      Request.get(`${origin}/x`).pipe(
        Request.path(
          schema,
          (value, encode) => `/${encode(JSON.stringify(value))}`,
        ),
      ),
      response,
    );
    return (input: unknown) =>
      operation
        .execute({ path: input as Request.Input<S> })
        .pipe(Effect.provide(lane.fetchClient));
  }
  const operation = Operation.make(
    Request.post(`${origin}/x`).pipe(Request.body(Body.jsonSchema(schema))),
    response,
  );
  return (input: unknown) =>
    operation
      .execute({ body: input as Request.Input<S> })
      .pipe(Effect.provide(lane.fetchClient));
}

// These specifications are literal wire spellings. The path uses a single escaped JSON segment.
const samples = [
  [{ page_size: "05" }, '{"page_size":"5"}'],
  [{ limit: 5 }, '{"page_size":"5"}'],
  [{}, '{"page_size":"25"}'],
] as const satisfies ReadonlyArray<Sample>;
const invalidAliases = [{ page_size: "many" }, { page_size: null }] as const;
const list = (input: unknown) => [input];
const listJson = (json: string) => `[${json}]`;

const assertWire = (entry: Recorded, binding: Binding, json: string) => {
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

const checkWire = (
  schema: WireSchema,
  binding: Binding,
  wireSamples: ReadonlyArray<Sample>,
) =>
  Effect.gen(function* () {
    const backend = yield* start();
    const execute = bind(backend.origin, schema, binding);
    for (const [index, [fixture, json]] of wireSamples.entries()) {
      const input = structuredClone(fixture);
      expect(yield* execute(input)).toBe("Not Found");
      expect(input).toEqual(fixture);
      const ledger = yield* backend.ledger;
      expect(ledger).toHaveLength(index + 1);
      assertWire(ledger[index]!, binding, json);
    }
  });

const refuse = (
  backend: Backend,
  execute: (input: unknown) => Effect.Effect<unknown, unknown>,
  inputs: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const outcomes = [];
    for (const input of inputs) {
      outcomes.push(
        yield* execute(input).pipe(
          Effect.match({
            onFailure: (error) =>
              Schema.isSchemaError(error) ? "SchemaError" : { error },
            onSuccess: (value) => ({ value }),
          }),
        ),
      );
    }
    const ledger = yield* backend.ledger;
    expect({
      outcomes,
      requests: ledger.map(({ target, body }) => ({
        target,
        body: new TextDecoder().decode(body),
      })),
    }).toEqual({ outcomes: inputs.map(() => "SchemaError"), requests: [] });
  });

const checkRefusal = (
  schema: WireSchema,
  binding: Binding,
  fixtures: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const backend = yield* start();
    const inputs = fixtures.map((fixture) => structuredClone(fixture));
    yield* refuse(backend, bind(backend.origin, schema, binding), inputs);
    expect(inputs).toEqual(fixtures);
  });

const Uppercase = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => value.toUpperCase()),
    encode: SchemaGetter.transform((value) => value.toLowerCase()),
  }),
);
const primitives = [
  {
    name: "FiniteFromString",
    alternative: Schema.FiniteFromString,
    own: [
      ["07", '"7"'],
      [8, '"8"'],
    ],
  },
  {
    name: "NumberFromString",
    alternative: Schema.NumberFromString,
    own: [
      ["07", '"7"'],
      [8, '"8"'],
    ],
  },
  {
    name: "String to String",
    alternative: Uppercase,
    own: [["MiXeD", '"mixed"']],
  },
  {
    name: "nested literals and FiniteFromString",
    alternative: Schema.Union([
      Schema.Literals(["all", "none"]),
      Schema.FiniteFromString,
    ]),
    own: [
      ["all", '"all"'],
      ["07", '"7"'],
    ],
  },
] as const;
const objectProfiles = [
  ...primitives.map((entry) => ({ ...entry, profile: "B" })),
  {
    profile: "C1",
    name: "one-or-many",
    alternative: Filters,
    own: [
      [[], "[]"],
      [[{ page_size: "07" }], '[{"page_size":"7"}]'],
    ],
  },
  {
    profile: "C1",
    name: "filter or cursor tuple",
    alternative: Schema.Tuple([Cursor]),
    own: [[[{ cursor: "x/y" }], '[{"cursor":"x/y"}]']],
  },
] as const;

const arrayProfiles = [
  {
    name: "cursor",
    array: Filters,
    alternative: Cursor,
    own: [[{ cursor: "x/y" }, '{"cursor":"x/y"}']],
    input: list,
    json: listJson,
  },
  {
    name: "one-or-many",
    array: Filters,
    alternative: Filter,
    own: samples,
    input: list,
    json: listJson,
  },
  {
    name: "text",
    array: Filters,
    alternative: Schema.String,
    own: [["a/b", '"a/b"']],
    input: list,
    json: listJson,
  },
  {
    name: "encoded number",
    array: Filters,
    alternative: Schema.FiniteFromString,
    own: [["07", '"7"']],
    input: list,
    json: listJson,
  },
  {
    name: "fixed tuple",
    array: Schema.Tuple([Schema.Number, Filter]),
    alternative: Cursor,
    own: [[{ cursor: "x/y" }, '{"cursor":"x/y"}']],
    input: (filter: unknown) => [1, filter],
    json: (json: string) => `[1,${json}]`,
  },
  {
    name: "nested list union",
    array: Schema.Union([Cursor, Filters]),
    alternative: Schema.String,
    own: [
      [[], "[]"],
      [{ cursor: "x/y" }, '{"cursor":"x/y"}'],
      ["a/b", '"a/b"'],
    ],
    input: list,
    json: listJson,
  },
] as const;

const positions = [
  {
    name: "root",
    schema: (schema: WireSchema) => schema,
    input: (value: unknown) => value,
    json: (json: string) => json,
  },
  {
    name: "field",
    schema: (schema: WireSchema) => Schema.Struct({ cell: schema }),
    input: (cell: unknown) => ({ cell }),
    json: (json: string) => `{"cell":${json}}`,
  },
  {
    name: "element",
    schema: (schema: WireSchema) => Schema.Array(schema),
    input: list,
    json: listJson,
  },
] as const;

const DecodedFilters = Schema.Array(
  Schema.Struct({
    limit: Schema.optionalKey(Schema.Number).pipe(
      Schema.withConstructorDefault(Effect.succeed(25)),
    ),
  }),
);
const EncodedArray = Filters.pipe(
  Schema.decodeTo(DecodedFilters, {
    decode: SchemaGetter.transform((value) => value),
    encode: SchemaGetter.transform((value) => value),
  }),
);
class CursorClass extends Schema.Class<CursorClass>("WireCursor")({
  cursor: Schema.String,
}) {}
const arrayAlternatives = [
  { name: "second array reader", schema: Schema.Array(Schema.String) },
  { name: "cursor class", schema: CursorClass },
  { name: "Option declaration", schema: Schema.Option(Schema.String) },
] as const;

const objectEvidence = [
  ["direct Filter", Filter],
  ["singleton union", Schema.Union([Filter])],
  ["Filter before Cursor", Schema.Union([Filter, Cursor])],
  ["Cursor before Filter", Schema.Union([Cursor, Filter])],
] as const;
type ObjectEvidence = (typeof objectEvidence)[number][1];
const bindObjectEvidence = (
  origin: string,
  schema: ObjectEvidence,
  binding: Binding | "query" | "headers",
) => {
  const request = Request.get(`${origin}/x`);
  if (binding === "query") {
    const operation = Operation.make(
      request.pipe(Request.query(schema)),
      response,
    );
    return (input: unknown) =>
      operation
        .execute({ query: input as Request.Input<ObjectEvidence> })
        .pipe(Effect.provide(lane.fetchClient));
  }
  if (binding === "headers") {
    const operation = Operation.make(
      request.pipe(Request.headers(schema)),
      response,
    );
    return (input: unknown) =>
      operation
        .execute({ headers: input as Request.Input<ObjectEvidence> })
        .pipe(Effect.provide(lane.fetchClient));
  }
  return bind(origin, schema, binding);
};
const namedLists = () =>
  ["many", "05"].map((page_size) => {
    const input: unknown[] = [];
    Object.setPrototypeOf(input, null);
    return Object.assign(input, { page_size });
  });

const groupedProfiles = [
  {
    name: "list beside cursor",
    member: Filters,
    companion: Cursor,
    input: list,
    json: listJson,
  },
  {
    name: "object beside string list",
    member: Schema.Struct({ filter: Filter }),
    companion: Schema.Array(Schema.String),
    input: (filter: unknown) => ({ filter }),
    json: (json: string) => `{"filter":${json}}`,
  },
] as const;
const groupings = [
  {
    name: "flat",
    schema: (member: WireSchema, companion: WireSchema, order: Order) =>
      Schema.Union(
        order === "filter first"
          ? [member, companion, Schema.Void]
          : [companion, Schema.Void, member],
      ),
  },
  {
    name: "companion then Void",
    schema: (member: WireSchema, companion: WireSchema, order: Order) =>
      union(member, Schema.Union([companion, Schema.Void]), order),
  },
  {
    name: "Void then companion",
    schema: (member: WireSchema, companion: WireSchema, order: Order) =>
      union(member, Schema.Union([Schema.Void, companion]), order),
  },
] as const;

const hiddenList = (page_size: string) =>
  Object.defineProperty([] as unknown[], "0", { value: { page_size } });

const CursorText = Cursor.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(({ cursor }) => cursor),
    encode: SchemaGetter.transform((cursor) => ({ cursor })),
  }),
);
const cursorOrVoid = () => Schema.Union([CursorText, Schema.Void]);
const guardedList = (shared: boolean) => {
  const inner = cursorOrVoid();
  return Schema.Array(
    Schema.Struct({
      guarded: Schema.optionalKey(Schema.Union([Filters, inner])),
      loose: Schema.optionalKey(
        Schema.Union([Filters, shared ? inner : cursorOrVoid()], {
          mode: "oneOf",
        }),
      ),
      n: Schema.FiniteFromString,
    }),
  );
};

describe(`encoded primitive and array alternatives (${lane.name})`, () => {
  for (const binding of bindings) {
    for (const order of orders) {
      for (const fixture of objectProfiles) {
        for (const position of positions) {
          const schema = position.schema(
            union(Filter, fixture.alternative, order),
          );
          const name = `${binding} ${fixture.profile} ${fixture.name} ${order} ${position.name}`;
          it.live(
            `[EXT-50a] ${name} keeps filter and alternative wire values`,
            () =>
              checkWire(
                schema,
                binding,
                [...samples, ...fixture.own].map(([input, json]) => [
                  position.input(input),
                  position.json(json),
                ]),
              ),
          );
          it.live(
            `[EXT-50b] ${name} refuses invalid object aliases before dispatch`,
            () =>
              checkRefusal(schema, binding, invalidAliases.map(position.input)),
          );
        }
      }

      for (const fixture of arrayProfiles) {
        for (const position of positions) {
          const schema = position.schema(
            union(fixture.array, fixture.alternative, order),
          );
          const name = `${binding} C2 ${fixture.name} ${order} ${position.name}`;
          const values: ReadonlyArray<Sample> = [
            ...samples.map(([input, json]): Sample => [
              fixture.input(input),
              fixture.json(json),
            ]),
            ...fixture.own,
          ];
          it.live(
            `[EXT-50c] ${name} keeps array items and alternative wire values`,
            () =>
              checkWire(
                schema,
                binding,
                values.map(([input, json]) => [
                  position.input(input),
                  position.json(json),
                ]),
              ),
          );
          it.live(
            `[EXT-50d] ${name} refuses invalid array aliases before dispatch`,
            () =>
              checkRefusal(
                schema,
                binding,
                invalidAliases.map((input) =>
                  position.input(fixture.input(input)),
                ),
              ),
          );
        }
      }

      for (const fixture of primitives) {
        const schema = Schema.Struct({
          cell: union(
            Schema.Struct({ filter: Filter }),
            fixture.alternative,
            order,
          ),
        });
        const name = `${binding} B ${fixture.name} ${order} ancestor`;
        it.live(
          `[EXT-50a] ${name} keeps filter and alternative wire values`,
          () =>
            checkWire(schema, binding, [
              ...samples.map(([filter, json]): Sample => [
                { cell: { filter } },
                `{"cell":{"filter":${json}}}`,
              ]),
              ...fixture.own.map(([cell, json]): Sample => [
                { cell },
                `{"cell":${json}}`,
              ]),
            ]),
        );
        it.live(
          `[EXT-50b] ${name} refuses invalid object aliases before dispatch`,
          () =>
            checkRefusal(
              schema,
              binding,
              invalidAliases.map((filter) => ({ cell: { filter } })),
            ),
        );
      }

      const mixedLists = [
        {
          name: "array of B elements",
          schema: Schema.Array(union(Filter, Schema.FiniteFromString, order)),
        },
        { name: "C2 one-or-many", schema: union(Filters, Filter, order) },
        { name: "C2 cursor", schema: union(Filters, Cursor, order) },
      ];
      for (const { name, schema } of mixedLists) {
        it.live(
          `[EXT-50e] ${binding} ${name} ${order} refuses mixed-side items before dispatch`,
          () =>
            checkRefusal(schema, binding, [
              [{ page_size: "05" }, { limit: 5 }],
              [{ limit: 5 }, { page_size: "05" }],
            ]),
        );
        it.live(
          `[EXT-50f] ${binding} ${name} ${order} refuses both names with or without a neighbor`,
          () =>
            checkRefusal(schema, binding, [
              [{ limit: 1, page_size: "02" }],
              [{ limit: 1, page_size: "02" }, { page_size: "25" }],
            ]),
        );
      }

      it.live(
        `[EXT-50g] ${binding} ${order} a middleware-encoded primitive beside a filter refuses an invalid alias`,
        () =>
          checkRefusal(
            union(
              Filter,
              Schema.FiniteFromString.pipe(
                Schema.middlewareEncoding((encoding) => encoding),
              ),
              order,
            ),
            binding,
            [{ page_size: "many" }],
          ),
      );
      for (const { name, schema } of arrayAlternatives) {
        it.live(
          `[EXT-50g] ${binding} ${order} ${name} beside a list refuses an invalid alias`,
          () =>
            checkRefusal(union(Filters, schema, order), binding, [
              [{ page_size: "many" }],
            ]),
        );
      }
      it.live(
        `[EXT-50g] ${binding} ${order} an empty struct keeps the list verbatim`,
        () =>
          checkWire(union(Filters, Schema.Struct({}), order), binding, [
            [[{ page_size: "many" }], '[{"page_size":"many"}]'],
          ]),
      );
      it.live(
        `[EXT-50g] ${binding} ${order} an encoded array member refuses an invalid alias`,
        () =>
          checkRefusal(union(EncodedArray, Cursor, order), binding, [
            [{ page_size: "many" }],
          ]),
      );
    }
  }

  for (const binding of [...bindings, "query", "headers"] as const) {
    for (const [name, schema] of objectEvidence) {
      it.live(
        `[EXT-50h] ${binding} ${name} refuses a named alias on a null-prototype list`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const inputs = namedLists();
            yield* refuse(
              backend,
              bindObjectEvidence(backend.origin, schema, binding),
              inputs,
            );
            for (const [index, input] of inputs.entries()) {
              expect(Object.getPrototypeOf(input)).toBeNull();
              expect(Object.keys(input)).toEqual(["page_size"]);
              expect(input.page_size).toBe(index === 0 ? "many" : "05");
            }
          }),
      );
    }
  }

  for (const binding of bindings) {
    for (const order of orders) {
      it.live(
        `[EXT-50i] ${binding} ${order} a primitive codec beside Filter refuses aliases on a null-prototype list`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const schema = union(Filter, Schema.FiniteFromString, order);
            yield* refuse(
              backend,
              bind(backend.origin, schema, binding),
              namedLists(),
            );
          }),
      );

      for (const fixture of groupedProfiles) {
        for (const grouping of groupings) {
          for (const position of positions) {
            const schema = position.schema(
              grouping.schema(fixture.member, fixture.companion, order),
            );
            const name = `${binding} ${fixture.name} ${grouping.name} ${order} ${position.name}`;
            it.live(
              `[EXT-50j] ${name} preserves encoded decoded and omitted aliases`,
              () =>
                checkWire(
                  schema,
                  binding,
                  samples.map(([input, json]) => [
                    position.input(fixture.input(input)),
                    position.json(fixture.json(json)),
                  ]),
                ),
            );
            it.live(
              `[EXT-50k] ${name} refuses invalid aliases before dispatch`,
              () =>
                checkRefusal(
                  schema,
                  binding,
                  invalidAliases.map((input) =>
                    position.input(fixture.input(input)),
                  ),
                ),
            );
          }
        }
      }

      it.live(
        `[EXT-50l] ${binding} ${order} a list beside Void refuses a hidden invalid alias and sends a hidden valid alias`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const execute = bind(
              backend.origin,
              union(Filters, Schema.Void, order),
              binding,
            );
            const invalid = hiddenList("many");
            yield* refuse(backend, execute, [invalid]);
            const valid = hiddenList("05");
            expect(yield* execute(valid)).toBe("Not Found");
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(1);
            assertWire(ledger[0]!, binding, '[{"page_size":"5"}]');
            for (const [input, page_size] of [
              [invalid, "many"],
              [valid, "05"],
            ] as const) {
              expect(Object.getOwnPropertyDescriptor(input, "0")).toEqual({
                value: { page_size },
                enumerable: false,
                configurable: false,
                writable: false,
              });
              expect(input.length).toBe(1);
            }
          }),
      );
    }

    const input = [{ guarded: [{ page_size: "many" }], n: 2 }];
    it.live(
      `[EXT-50m] ${binding} a reused member union beside Void refuses an invalid alias`,
      () => checkRefusal(guardedList(true), binding, [input]),
    );
    it.live(
      `[EXT-50n] ${binding} separate member unions refuse the same invalid alias`,
      () => checkRefusal(guardedList(false), binding, [input]),
    );
  }
});
