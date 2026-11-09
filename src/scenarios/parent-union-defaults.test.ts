/**
 * Consumer-authored against the neutral echo contract and accepted parent-union subset:
 * https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6732380757
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaGetter } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Page = Schema.Struct({ filter: Filter });
const Cursor = Schema.Struct({ cursor: Schema.String });
const Parent = Schema.Union([Page, Cursor]);
const Reversed = Schema.Union([Cursor, Page]);
const Shared = Schema.Union([
  Schema.Struct({ filter: Filter, label: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ filter: Filter, cursor: Schema.String }),
]);
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
const result = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ error }),
      onSuccess: (value) => ({ value }),
    }),
  );
const wire = (entry: Recorded, target: string, json?: string) => {
  expect(entry.method).toBe(json === undefined ? "GET" : "POST");
  expect(entry.target).toBe(target);
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "content-type")).toEqual(
    json === undefined ? [] : ["application/json"],
  );
  expect(entry.body).toEqual(new TextEncoder().encode(json ?? ""));
};
const shapes = [
  "ordinary",
  "frozen",
  "null prototype",
  "hidden filter",
  "hidden alias",
] as const;
const input = (value: string | null, shape: (typeof shapes)[number]) => {
  const data = { filter: { page_size: value } };
  if (shape === "frozen") {
    Object.freeze(data.filter);
    Object.freeze(data);
  }
  if (shape === "null prototype") {
    Object.setPrototypeOf(data, null);
    Object.setPrototypeOf(data.filter, null);
  }
  if (shape === "hidden filter")
    Object.defineProperty(data, "filter", { enumerable: false });
  if (shape === "hidden alias")
    Object.defineProperty(data.filter, "page_size", { enumerable: false });
  return data;
};

describe(`parent union defaults (${lane.name})`, () => {
  for (const [name, schema] of [
    ["root", Parent],
    ["reversed", Reversed],
    ["shared declaration", Shared],
  ] as const) {
    it.live(
      `[EXT-43a] ${name} parent union refuses invalid stable path aliases`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(
                schema,
                (value, encode) => `/${encode(JSON.stringify(value))}`,
              ),
            ),
            response,
          );
          const outcomes = [];
          for (const shape of shapes)
            for (const value of ["many", null]) {
              // Runtime-negative values intentionally exercise the public validation boundary.
              outcomes.push(
                yield* operation
                  .execute({
                    path: input(value, shape) as Request.Input<typeof schema>,
                  })
                  .pipe(Effect.provide(lane.fetchClient), result),
              );
            }
          expect({ outcomes, ledger: yield* backend.ledger }).toMatchObject({
            outcomes: Array.from({ length: 10 }, () => ({
              error: { _tag: "SchemaError" },
            })),
            ledger: [],
          });
        }),
    );
    it.live(
      `[EXT-43b] ${name} parent union refuses invalid stable JSON aliases`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(schema)),
            ),
            response,
          );
          const outcomes = [];
          for (const shape of shapes)
            for (const value of ["many", null]) {
              outcomes.push(
                yield* operation
                  .execute({
                    body: input(value, shape) as Request.Input<typeof schema>,
                  })
                  .pipe(Effect.provide(lane.fetchClient), result),
              );
            }
          expect({ outcomes, ledger: yield* backend.ledger }).toMatchObject({
            outcomes: Array.from({ length: 10 }, () => ({
              error: { _tag: "SchemaError" },
            })),
            ledger: [],
          });
        }),
    );
    it.live(
      `[EXT-43c] ${name} preserves encoded decoded default and alternate inputs`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(schema)),
            ),
            response,
          );
          for (const filter of [
            { page_size: "05" },
            { limit: 5 },
            {},
            { limit: 5, page_size: "many" },
          ]) {
            expect(
              yield* operation
                .execute({ body: { filter } })
                .pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(4);
          for (const [index, value] of ["5", "5", "25", "5"].entries())
            wire(ledger[index]!, "/x", `{"filter":{"page_size":"${value}"}}`);
        }),
    );
  }
  const Deep = Schema.Struct({
    envelope: Schema.Union([
      Schema.Struct({ page: Parent }),
      Schema.Struct({ other: Schema.String }),
    ]),
  });
  it.live(
    "[EXT-43d] nested parent unions refuse invalid aliases without dispatch",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Deep)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({
              body: { envelope: { page: { filter: { page_size: "many" } } } },
            })
            .pipe(Effect.provide(lane.fetchClient), result),
        ).toMatchObject({ error: { _tag: "SchemaError" } });
        expect(yield* backend.ledger).toEqual([]);
      }),
  );
  it.live(
    "[EXT-43e] parent cursor and deeper other branches preserve wire bytes",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const path = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              Parent,
              (value, encode) => `/${encode(JSON.stringify(value))}`,
            ),
          ),
          response,
        );
        expect(
          yield* path
            .execute({ path: { cursor: "next/part" } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const body = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Deep)),
          ),
          response,
        );
        expect(
          yield* body
            .execute({ body: { envelope: { other: "other/part" } } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* body
            .execute({
              body: { envelope: { page: { filter: { page_size: "05" } } } },
            })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        wire(ledger[0]!, `/x/${encodeURIComponent('{"cursor":"next/part"}')}`);
        wire(ledger[1]!, "/x", '{"envelope":{"other":"other/part"}}');
        wire(
          ledger[2]!,
          "/x",
          '{"envelope":{"page":{"filter":{"page_size":"5"}}}}',
        );
      }),
  );
  it.live(
    "[EXT-43f] currently distinct filter declarations retain the ambiguous default overwrite",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const distinct = Schema.Union([
          Page,
          Schema.Struct({
            filter: Schema.Struct({
              limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
                Schema.withConstructorDefault(Effect.succeed(41)),
              ),
            }).pipe(Schema.encodeKeys({ limit: "page_size" })),
            cursor: Schema.String,
          }),
        ]);
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(distinct)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({ body: { filter: { page_size: "many" } } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        wire(ledger[0]!, "/x", '{"filter":{"page_size":"25"}}');
      }),
  );
  it.live(
    "[EXT-43g] member fieldwise consumption keeps callback and shared text interpretation",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const reads: string[] = [];
        const observed = Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transform((text) => {
              reads.push(text);
              return text;
            }),
            encode: SchemaGetter.transform((text) => text),
          }),
          Schema.decodeTo(Schema.FiniteFromString),
        );
        const Consumed = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
          gate: Schema.FiniteFromString,
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const member = Schema.Struct({
          filter: Consumed,
          left: observed,
          right: Schema.FiniteFromString,
          shared: Schema.StringFromBase64,
          neighbor: Schema.Option(Schema.Struct({ keep: Schema.String })),
        });
        const schema = Schema.Union([member, Cursor]);
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({
              body: {
                filter: { page_size: "08", gate: "02" },
                left: "06",
                right: 4,
                shared: "eA==",
                neighbor: Option.some({ keep: "ok", stray: "strip" }),
              },
            })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(reads).toEqual(["06", "06", "06", "06", "06", "06"]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        wire(
          ledger[0]!,
          "/x",
          '{"filter":{"page_size":"8","gate":"2"},"left":"6","right":"4","shared":"ZUE9PQ==","neighbor":{"_tag":"Some","value":{"keep":"ok"}}}',
        );
      }),
  );
  it.live(
    "[EXT-43h] whole parent decoding refuses valid mixed aliases and reads shared text on its encoded side",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const Member = Schema.Struct({
          filter: Filter,
          count: Schema.FiniteFromString,
          shared: Schema.StringFromBase64,
          neighbor: Schema.Option(Schema.Struct({ keep: Schema.String })),
        });
        const schema = Schema.Union([Member, Cursor]);
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        const neighbor = Option.some({ keep: "ok", stray: "strip" });
        const mixed = yield* operation
          .execute({
            body: {
              filter: { page_size: "25" },
              count: 3,
              shared: "eA==",
              neighbor,
            },
          })
          .pipe(Effect.provide(lane.fetchClient), result);
        const encoded = yield* operation
          .execute({
            body: {
              filter: { page_size: "25" },
              count: "3",
              shared: "eA==",
              neighbor,
            },
          })
          .pipe(Effect.provide(lane.fetchClient), result);
        const decoded = yield* operation
          .execute({
            body: { filter: { limit: 25 }, count: 3, shared: "eA==", neighbor },
          })
          .pipe(Effect.provide(lane.fetchClient), result);
        const ledger = yield* backend.ledger;
        expect({ mixed, encoded, decoded, count: ledger.length }).toMatchObject(
          {
            mixed: { error: { _tag: "SchemaError" } },
            encoded: { value: "Not Found" },
            decoded: { value: "Not Found" },
            count: 2,
          },
        );
        wire(
          ledger[0]!,
          "/x",
          '{"filter":{"page_size":"25"},"count":"3","shared":"eA==","neighbor":{"_tag":"Some","value":{"keep":"ok"}}}',
        );
        wire(
          ledger[1]!,
          "/x",
          '{"filter":{"page_size":"25"},"count":"3","shared":"ZUE9PQ==","neighbor":{"_tag":"Some","value":{"keep":"ok"}}}',
        );
      }),
  );
  it.live(
    "[EXT-43i] currently a suspended parent retains its unsupported overwrite",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let evaluations = 0;
        const schema = Schema.Struct({
          page: Schema.suspend(() => {
            evaluations++;
            return Parent;
          }),
        });
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({ body: { page: { filter: { page_size: "many" } } } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(evaluations).toBeGreaterThan(0);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        wire(ledger[0]!, "/x", '{"page":{"filter":{"page_size":"25"}}}');
      }),
  );
  it.live(
    "[EXT-43j] equal symbol descriptions retain distinct parent field identities",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const page = Symbol("route");
        const other = Symbol("route");
        const schema = Schema.Union([
          Schema.Struct({ [page]: Filter }),
          Schema.Struct({ [other]: Schema.String }),
        ]);
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(schema, (value, encode) =>
              page in value
                ? `/page/${encode(value[page].page_size ?? "none")}`
                : `/other/${encode(value[other])}`,
            ),
          ),
          response,
        );
        const invalid = yield* operation
          .execute({ path: { [page]: { page_size: "many" } } })
          .pipe(Effect.provide(lane.fetchClient), result);
        const afterInvalid = yield* backend.ledger;
        const valid = yield* operation
          .execute({ path: { [page]: { page_size: "05" } } })
          .pipe(Effect.provide(lane.fetchClient), result);
        const alternate = yield* operation
          .execute({ path: { [other]: "next/part" } })
          .pipe(Effect.provide(lane.fetchClient), result);
        const controls = (yield* backend.ledger).slice(-2);
        wire(controls[0]!, "/x/page/5");
        wire(controls[1]!, "/x/other/next%2Fpart");
        expect({ invalid, afterInvalid, valid, alternate }).toMatchObject({
          invalid: { error: { _tag: "SchemaError" } },
          afterInvalid: [],
          valid: { value: "Not Found" },
          alternate: { value: "Not Found" },
        });
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(2);
        wire(ledger[0]!, "/x/page/5");
        wire(ledger[1]!, "/x/other/next%2Fpart");
      }),
  );
  it.live(
    "[EXT-43k] numeric parent field preserves invalid valid and default paths",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const schema = Schema.Union([Schema.Struct({ 7: Filter }), Cursor]);
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(schema, (value, encode) =>
              7 in value
                ? `/page/${encode(value[7].page_size ?? "none")}`
                : `/cursor/${encode(value.cursor)}`,
            ),
          ),
          response,
        );
        const invalid = yield* operation
          .execute({ path: { 7: { page_size: "many" } } })
          .pipe(Effect.provide(lane.fetchClient), result);
        const afterInvalid = yield* backend.ledger;
        const controls = [];
        for (const filter of [{ page_size: "05" }, { limit: 5 }, {}])
          controls.push(
            yield* operation
              .execute({ path: { 7: filter } })
              .pipe(Effect.provide(lane.fetchClient), result),
          );
        const controlLedger = (yield* backend.ledger).slice(-3);
        for (const [index, target] of [
          "/x/page/5",
          "/x/page/5",
          "/x/page/25",
        ].entries())
          wire(controlLedger[index]!, target);
        expect({ invalid, afterInvalid, controls }).toMatchObject({
          invalid: { error: { _tag: "SchemaError" } },
          afterInvalid: [],
          controls: Array.from({ length: 3 }, () => ({ value: "Not Found" })),
        });
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        for (const [index, target] of [
          "/x/page/5",
          "/x/page/5",
          "/x/page/25",
        ].entries())
          wire(ledger[index]!, target);
      }),
  );
  it.live(
    "[EXT-43l] unknown cyclic nested extras neither hide invalid aliases nor prevent valid paths",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const schema = Parent;
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(schema, (value, encode) =>
              "filter" in value
                ? `/page/${encode(value.filter.page_size ?? "none")}`
                : `/cursor/${encode(value.cursor)}`,
            ),
          ),
          response,
        );
        const extra: { self?: unknown } = {};
        extra.self = extra;
        const invalidInput = { filter: { page_size: "many", extra } };
        const validInput = { filter: { page_size: "05", extra } };
        const invalid = yield* operation
          .execute({ path: invalidInput })
          .pipe(Effect.provide(lane.fetchClient), result);
        const afterInvalid = yield* backend.ledger;
        const valid = yield* operation
          .execute({ path: validInput })
          .pipe(Effect.provide(lane.fetchClient), result);
        expect(extra.self).toBe(extra);
        expect(invalidInput.filter.extra).toBe(extra);
        expect(validInput.filter.extra).toBe(extra);
        wire((yield* backend.ledger).at(-1)!, "/x/page/5");
        expect({ invalid, afterInvalid, valid }).toMatchObject({
          invalid: { error: { _tag: "SchemaError" } },
          afterInvalid: [],
          valid: { value: "Not Found" },
        });
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        wire(ledger[0]!, "/x/page/5");
      }),
  );
  it.live(
    "[EXT-43m] currently normalized numeric and string declarations retain their unproved overwrite",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        // Ordinary public combinators produce distinct declarations for the same JS property.
        // https://github.com/viell-dev/slop-effect-schema-http/pull/186#issuecomment-6733312132
        const Other = Schema.Struct({
          limit: Schema.optionalKey(Schema.Number),
          wire: Schema.optionalKey(Schema.String),
        });
        const Leaf = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "wire" }));
        const member = Schema.StructWithRest(
          Schema.Record(Schema.Literal(1), Other),
          [Schema.Record(Schema.Literal("1"), Leaf)],
        );
        const union = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(Schema.Union([member, Cursor]), (value, encode) =>
              "1" in value
                ? `/limit/${encode(value["1"].wire ?? "none")}`
                : `/cursor/${encode(value.cursor)}`,
            ),
          ),
          response,
        );
        const direct = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              member,
              (value, encode) => `/limit/${encode(value["1"].wire ?? "none")}`,
            ),
          ),
          response,
        );
        const wrapped = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              Schema.Struct({ page: member }),
              (value, encode) =>
                `/limit/${encode(value.page["1"].wire ?? "none")}`,
            ),
          ),
          response,
        );
        // Direct/wrapped forms newly expose the defect; the union retains its old default.
        // https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6733524389
        type FilterInput = { limit?: number; wire?: string };
        const routes = [
          {
            name: "parent union",
            run: (filter: FilterInput) =>
              union.execute({ path: { "1": filter } }),
          },
          {
            name: "direct",
            run: (filter: FilterInput) =>
              direct.execute({ path: { "1": filter } }),
          },
          {
            name: "wrapped",
            run: (filter: FilterInput) =>
              wrapped.execute({ path: { page: { "1": filter } } }),
          },
        ];
        const observations = [];
        for (const route of routes) {
          const before = (yield* backend.ledger).length;
          // Encoded, decoded and omitted controls run before each bad alias.
          for (const filter of [{ wire: "06" }, { limit: 6 }, {}]) {
            expect(
              yield* route.run(filter).pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
          }
          const controls = (yield* backend.ledger).slice(before);
          expect(controls).toHaveLength(3);
          for (const [index, target] of [
            "/x/limit/6",
            "/x/limit/6",
            "/x/limit/25",
          ].entries())
            wire(controls[index]!, target);
          const bad = yield* route
            .run({ wire: "many" })
            .pipe(Effect.provide(lane.fetchClient), result);
          const ledger = (yield* backend.ledger).slice(before + 3);
          observations.push({
            route: route.name,
            bad,
            targets: ledger.map((entry) => entry.target),
          });
          if (ledger.length === 1) wire(ledger[0]!, "/x/limit/25");
        }
        expect(observations).toEqual(
          routes.map((route) => ({
            route: route.name,
            bad: { value: "Not Found" },
            targets: ["/x/limit/25"],
          })),
        );
      }),
  );
});
