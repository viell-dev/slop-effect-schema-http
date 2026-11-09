/**
 * EXT-41: the bounded fieldwise encoded-alias refusal accepted under #170.
 * Consumer-authored from the public reports and the README's neutral echo contract.
 * No assertion here extends the repair to nested defaults or arbitrary mixed-alias preservation.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const common = {
  count: Schema.FiniteFromString,
  offset: Schema.FiniteFromString,
};
const Filters = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  ...common,
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const NoDefault = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString),
  ...common,
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const Choice = Schema.Union([Filters, Cursor]);
const shapes = [
  ["direct", Filters],
  ["root-union", Choice],
] as const;
const refusals = [
  [
    "invalid alias with mixed common fields",
    { page_size: "many", count: "07", offset: 9 },
  ],
  [
    "valid alias with mixed common fields",
    { page_size: "05", count: "07", offset: 9 },
  ],
  [
    "same-default alias with mixed common fields",
    { page_size: "25", count: "07", offset: 9 },
  ],
  [
    "invalid alias with encoded common fields",
    { page_size: "many", count: "07", offset: "09" },
  ],
] as const;
const controls = [
  { page_size: "05", count: "07", offset: "09" },
  { limit: 5, count: 7, offset: 9 },
  { limit: 5, count: "07", offset: 9 },
  { count: "07", offset: 9 },
  { page_size: undefined, count: "07", offset: 9 },
] as const;
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ kind: "failure" as const, error }),
      onSuccess: (value) => ({ kind: "success" as const, value }),
    }),
  );

// Check the public input helpers without dispatch, casts or broader annotations on calls.
const inputChecks = () => {
  const direct: Request.Input<typeof Filters> = {
    page_size: "05",
    count: "07",
    offset: 9,
  };
  const union: Request.Input<typeof Choice> = {
    page_size: "05",
    count: "07",
    offset: 9,
  };
  const undefinedAlias: Request.Input<typeof Filters> = {
    page_size: undefined,
    count: "07",
    offset: 9,
  };
  const wrongName: Request.Input<typeof Filters> = {
    count: 7,
    offset: 9,
    // @ts-expect-error Unknown names do not become declared by fieldwise input typing.
    page_count: "05",
  };
  const wrongValue: Request.Input<typeof Filters> = {
    count: "07",
    offset: "09",
    // @ts-expect-error The encoded numeric alias requires text, not boolean.
    page_size: false,
  };
  // @ts-expect-error Required common fields remain required despite the limit default.
  const missing: Request.Input<typeof Filters> = {
    page_size: "05",
    count: "07",
  };
  return { direct, union, undefinedAlias, wrongName, wrongValue, missing };
};
void inputChecks;

const wire = (entry: Recorded) => ({
  method: entry.method,
  target: entry.target,
  page: headerValues(entry.lines, "page_size"),
  count: headerValues(entry.lines, "count"),
  offset: headerValues(entry.lines, "offset"),
  cursor: headerValues(entry.lines, "cursor"),
  body: Array.from(entry.body),
});
const expectQuery = (entry: Recorded, target: string) => {
  expect(wire(entry)).toEqual({
    method: "GET",
    target,
    page: [],
    count: [],
    offset: [],
    cursor: [],
    body: [],
  });
  expect(headerValues(entry.lines, "limit")).toEqual([]);
};
const expectHeaders = (entry: Recorded, page: string, cursor?: string) => {
  expect(wire(entry)).toEqual({
    method: "GET",
    target: "/x",
    page: [page],
    count: ["7"],
    offset: ["9"],
    cursor: cursor === undefined ? [] : [cursor],
    body: [],
  });
  expect(headerValues(entry.lines, "limit")).toEqual([]);
};

describe(`fieldwise encoded-alias loss (${lane.name})`, () => {
  for (const [shape, schema] of shapes) {
    it.live(
      `[EXT-41a] a ${shape} query refuses supplied aliases lost by fieldwise preparation`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.query(schema)),
            response,
          );
          const outcomes = [];
          for (const [label, input] of refusals) {
            const result = yield* operation
              .execute({ query: input })
              .pipe(Effect.provide(lane.fetchClient), outcome);
            outcomes.push({ label, result });
          }
          expect({
            outcomes,
            wire: (yield* backend.ledger).map(wire),
          }).toMatchObject({
            outcomes: refusals.map(([label]) => ({
              label,
              result: { kind: "failure", error: { _tag: "SchemaError" } },
            })),
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-41b] ${shape} headers refuse supplied aliases lost by fieldwise preparation`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.headers(schema)),
            response,
          );
          const outcomes = [];
          for (const [label, input] of refusals) {
            const result = yield* operation
              .execute({ headers: input })
              .pipe(Effect.provide(lane.fetchClient), outcome);
            outcomes.push({ label, result });
          }
          expect({
            outcomes,
            wire: (yield* backend.ledger).map(wire),
          }).toMatchObject({
            outcomes: refusals.map(([label]) => ({
              label,
              result: { kind: "failure", error: { _tag: "SchemaError" } },
            })),
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-41c] control: a ${shape} query keeps complete sides, decoded-name mixing and defaults`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.query(schema)),
            response,
          );
          for (const input of controls) {
            const value = yield* operation
              .execute({ query: input })
              .pipe(Effect.provide(lane.fetchClient));
            expect(value).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(5);
          for (let i = 0; i < ledger.length; i++) {
            expectQuery(
              ledger[i]!,
              `/x?page_size=${i < 3 ? "5" : "25"}&count=7&offset=9`,
            );
          }
        }),
    );

    it.live(
      `[EXT-41d] control: ${shape} headers keep complete sides, decoded-name mixing and defaults`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.headers(schema)),
            response,
          );
          for (const input of controls) {
            const value = yield* operation
              .execute({ headers: input })
              .pipe(Effect.provide(lane.fetchClient));
            expect(value).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(5);
          for (let i = 0; i < ledger.length; i++) {
            expectHeaders(ledger[i]!, i < 3 ? "5" : "25");
          }
        }),
    );
  }

  for (const order of ["cursor first", "filters first"] as const) {
    it.live(
      `[EXT-41e] query siblings with ${order} cannot excuse the fieldwise alias loss`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const base = Request.get(`${backend.origin}/x`);
          const request =
            order === "cursor first"
              ? base.pipe(Request.query(Cursor), Request.query(Filters))
              : base.pipe(Request.query(Filters), Request.query(Cursor));
          const result = yield* Operation.make(request, response)
            .execute({
              query: {
                page_size: "many",
                count: "07",
                offset: 9,
                cursor: "next",
              },
            })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          expect({
            result,
            wire: (yield* backend.ledger).map(wire),
          }).toMatchObject({
            result: { kind: "failure", error: { _tag: "SchemaError" } },
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-41f] header siblings with ${order} cannot excuse the fieldwise alias loss`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const base = Request.get(`${backend.origin}/x`);
          const request =
            order === "cursor first"
              ? base.pipe(Request.headers(Cursor), Request.headers(Filters))
              : base.pipe(Request.headers(Filters), Request.headers(Cursor));
          const result = yield* Operation.make(request, response)
            .execute({
              headers: {
                page_size: "many",
                count: "07",
                offset: 9,
                cursor: "next",
              },
            })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          expect({
            result,
            wire: (yield* backend.ledger).map(wire),
          }).toMatchObject({
            result: { kind: "failure", error: { _tag: "SchemaError" } },
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-41g] control: query siblings with ${order} retain decoded and mixed decoded-name values`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const base = Request.get(`${backend.origin}/x`);
          const request =
            order === "cursor first"
              ? base.pipe(Request.query(Cursor), Request.query(Filters))
              : base.pipe(Request.query(Filters), Request.query(Cursor));
          const operation = Operation.make(request, response);
          for (const input of [
            { limit: 5, count: 7, offset: 9, cursor: "next" },
            { limit: 5, count: "07", offset: 9, cursor: "next" },
          ] as const) {
            const value = yield* operation
              .execute({ query: input })
              .pipe(Effect.provide(lane.fetchClient));
            expect(value).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(2);
          for (const entry of ledger) {
            expectQuery(
              entry,
              order === "cursor first"
                ? "/x?cursor=next&page_size=5&count=7&offset=9"
                : "/x?page_size=5&count=7&offset=9&cursor=next",
            );
          }
        }),
    );

    it.live(
      `[EXT-41h] control: header siblings with ${order} retain decoded and mixed decoded-name values`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const base = Request.get(`${backend.origin}/x`);
          const request =
            order === "cursor first"
              ? base.pipe(Request.headers(Cursor), Request.headers(Filters))
              : base.pipe(Request.headers(Filters), Request.headers(Cursor));
          const operation = Operation.make(request, response);
          for (const input of [
            { limit: 5, count: 7, offset: 9, cursor: "next" },
            { limit: 5, count: "07", offset: 9, cursor: "next" },
          ] as const) {
            const value = yield* operation
              .execute({ headers: input })
              .pipe(Effect.provide(lane.fetchClient));
            expect(value).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(2);
          for (const entry of ledger) expectHeaders(entry, "5", "next");
        }),
    );
  }

  it.live(
    "[EXT-41i] control: earlier raw query defaults remain distinct from supplied aliases",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const plain = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.setQuery("page_size", "05"),
            Request.query(NoDefault),
          ),
          response,
        );
        const value = yield* plain
          .execute({ query: { count: "07", offset: 9 } })
          .pipe(Effect.provide(lane.fetchClient));
        expect(value).toBe("Not Found");
        const invalid = yield* Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.setQuery("page_size", "many"),
            Request.query(NoDefault),
          ),
          response,
        )
          .execute({ query: { count: "07", offset: 9 } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        expect(invalid).toMatchObject({ _tag: "InvalidRequest" });
        expect(yield* backend.ledger).toHaveLength(1);
        for (const raw of ["05", "many"]) {
          const generated = yield* Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.setQuery("page_size", raw),
              Request.query(Filters),
            ),
            response,
          )
            .execute({ query: { count: "07", offset: 9 } })
            .pipe(Effect.provide(lane.fetchClient));
          expect(generated).toBe("Not Found");
        }
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectQuery(ledger[0]!, "/x?page_size=5&count=7&offset=9");
        expectQuery(ledger[1]!, "/x?page_size=25&count=7&offset=9");
        expectQuery(ledger[2]!, "/x?page_size=25&count=7&offset=9");
      }),
  );

  it.live(
    "[EXT-41j] control: earlier raw header defaults remain distinct from supplied aliases",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const plain = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.setHeader("page_size", "05"),
            Request.headers(NoDefault),
          ),
          response,
        );
        const value = yield* plain
          .execute({ headers: { count: "07", offset: 9 } })
          .pipe(Effect.provide(lane.fetchClient));
        expect(value).toBe("Not Found");
        const invalid = yield* Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.setHeader("page_size", "many"),
            Request.headers(NoDefault),
          ),
          response,
        )
          .execute({ headers: { count: "07", offset: 9 } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        expect(invalid).toMatchObject({ _tag: "InvalidRequest" });
        expect(yield* backend.ledger).toHaveLength(1);
        for (const raw of ["05", "many"]) {
          const generated = yield* Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.setHeader("page_size", raw),
              Request.headers(Filters),
            ),
            response,
          )
            .execute({ headers: { count: "07", offset: 9 } })
            .pipe(Effect.provide(lane.fetchClient));
          expect(generated).toBe("Not Found");
        }
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectHeaders(ledger[0]!, "5");
        expectHeaders(ledger[1]!, "25");
        expectHeaders(ledger[2]!, "25");
      }),
  );

  it.live(
    "[EXT-41k] limit: a root union beside a cursor still refuses whole encoded query input",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const base = Request.get(`${backend.origin}/x`);
        for (const request of [
          base.pipe(Request.query(Cursor), Request.query(Choice)),
          base.pipe(Request.query(Choice), Request.query(Cursor)),
        ]) {
          const result = yield* Operation.make(request, response)
            .execute({
              query: {
                page_size: "05",
                count: "07",
                offset: "09",
                cursor: "next",
              },
            })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          expect(result).toMatchObject({
            kind: "failure",
            error: { _tag: "SchemaError" },
          });
          expect(yield* backend.ledger).toEqual([]);
        }
      }),
  );

  it.live(
    "[EXT-41l] limit: a root union beside a cursor still refuses whole encoded header input",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const base = Request.get(`${backend.origin}/x`);
        for (const request of [
          base.pipe(Request.headers(Cursor), Request.headers(Choice)),
          base.pipe(Request.headers(Choice), Request.headers(Cursor)),
        ]) {
          const result = yield* Operation.make(request, response)
            .execute({
              headers: {
                page_size: "05",
                count: "07",
                offset: "09",
                cursor: "next",
              },
            })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          expect(result).toMatchObject({
            kind: "failure",
            error: { _tag: "SchemaError" },
          });
          expect(yield* backend.ledger).toEqual([]);
        }
      }),
  );

  for (const [shape, schema] of shapes) {
    it.live(
      `[EXT-41m] a ${shape} path refuses a supplied alias lost by fieldwise preparation`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const request = Request.get(`${backend.origin}/x`).pipe(
            Request.path(schema, (value, encode) =>
              "cursor" in value
                ? `/cursor/${encode(value.cursor)}`
                : `/page/${encode(value.page_size ?? "none")}/${encode(value.count)}/${encode(value.offset)}`,
            ),
          );
          const result = yield* Operation.make(request, response)
            .execute({
              path: { page_size: "many", count: "07", offset: 9 },
            })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          expect({
            result,
            wire: (yield* backend.ledger).map(wire),
          }).toMatchObject({
            result: { kind: "failure", error: { _tag: "SchemaError" } },
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-41n] a ${shape} JSON body refuses a supplied alias lost by fieldwise preparation`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const request = Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          );
          const result = yield* Operation.make(request, response)
            .execute({
              body: { page_size: "many", count: "07", offset: 9 },
            })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          expect({
            result,
            wire: (yield* backend.ledger).map(wire),
          }).toMatchObject({
            result: { kind: "failure", error: { _tag: "SchemaError" } },
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-41o] control: a ${shape} path retains complete encoded and decoded values`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const request = Request.get(`${backend.origin}/x`).pipe(
            Request.path(schema, (value, encode) =>
              "cursor" in value
                ? `/cursor/${encode(value.cursor)}`
                : `/page/${encode(value.page_size ?? "none")}/${encode(value.count)}/${encode(value.offset)}`,
            ),
          );
          const operation = Operation.make(request, response);
          for (const input of [
            { page_size: "05", count: "07", offset: "09" },
            { limit: 5, count: 7, offset: 9 },
          ] as const) {
            const value = yield* operation
              .execute({ path: input })
              .pipe(Effect.provide(lane.fetchClient));
            expect(value).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(2);
          for (const entry of ledger) expectQuery(entry, "/x/page/5/7/9");
        }),
    );

    it.live(
      `[EXT-41p] control: a ${shape} JSON body retains complete encoded and decoded values`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const request = Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          );
          const operation = Operation.make(request, response);
          for (const input of [
            { page_size: "05", count: "07", offset: "09" },
            { limit: 5, count: 7, offset: 9 },
          ] as const) {
            const value = yield* operation
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient));
            expect(value).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(2);
          for (const entry of ledger) {
            expect(entry.method).toBe("POST");
            expect(entry.target).toBe("/x");
            expect(headerValues(entry.lines, "content-type")).toEqual([
              "application/json",
            ]);
            expect(entry.body).toEqual(
              new TextEncoder().encode(
                '{"page_size":"5","count":"7","offset":"9"}',
              ),
            );
            for (const name of [
              "limit",
              "page_size",
              "count",
              "offset",
              "cursor",
            ]) {
              expect(headerValues(entry.lines, name)).toEqual([]);
            }
          }
        }),
    );
  }
});
