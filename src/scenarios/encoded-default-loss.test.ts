/**
 * EXT-39: invalid encoded aliases must not turn into constructor defaults (#170).
 * Consumer-authored from the public report, design and README neutral echo contract.
 * Every dispatch uses Fetch and is checked in the physical socket ledger in both lanes.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const Renamed = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  term: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ limit: "page_size", term: "search_term" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const choices = [
  ["direct", Renamed],
  ["union", Schema.Union([Renamed, Cursor])],
] as const;
const Whole = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  token: Schema.StringFromBase64,
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ kind: "failure" as const, error }),
      onSuccess: (value) => ({ kind: "success" as const, value }),
    }),
  );
const expectRequest = (entry: Recorded, target: string) => {
  expect(entry.method).toBe("GET");
  expect(entry.target).toBe(target);
  expect(entry.body.byteLength).toBe(0);
  expect(headerValues(entry.lines, "limit")).toEqual([]);
  expect(headerValues(entry.lines, "term")).toEqual([]);
};
const expectPage = (
  entry: Recorded,
  page: string,
  term: string | undefined = undefined,
) => {
  expectRequest(entry, "/x");
  expect(headerValues(entry.lines, "page_size")).toEqual([page]);
  expect(headerValues(entry.lines, "search_term")).toEqual(
    term === undefined ? [] : [term],
  );
};

describe(`encoded aliases and optional constructor defaults (${lane.name})`, () => {
  for (const [shape, schema] of choices) {
    it.live(
      `[EXT-39a] a ${shape} query refuses invalid encoded aliases before dispatch`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.query(schema)),
            response,
          );
          const text = yield* operation
            .execute({ query: { page_size: "many" } })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          const nil = yield* operation
            // Deliberate runtime-negative input: null is outside either schema side.
            // @ts-expect-error The encoded alias requires a string, including in a union.
            .execute({ query: { page_size: null } })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          const ledger = yield* backend.ledger;
          expect({
            text,
            nil,
            targets: ledger.map(({ target }) => target),
          }).toMatchObject({
            text: { kind: "failure", error: { _tag: "SchemaError" } },
            nil: { kind: "failure", error: { _tag: "SchemaError" } },
            targets: [],
          });
        }),
    );

    it.live(
      `[EXT-39b] ${shape} headers refuse invalid encoded aliases before dispatch`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.headers(schema)),
            response,
          );
          const text = yield* operation
            .execute({ headers: { page_size: "many" } })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          const nil = yield* operation
            // Deliberate runtime-negative input: a header schema still validates null.
            // @ts-expect-error The encoded alias requires a string, including in a union.
            .execute({ headers: { page_size: null } })
            .pipe(Effect.provide(lane.fetchClient), outcome);
          const ledger = yield* backend.ledger;
          expect({
            text,
            nil,
            pages: ledger.map(({ lines }) => headerValues(lines, "page_size")),
          }).toMatchObject({
            text: { kind: "failure", error: { _tag: "SchemaError" } },
            nil: { kind: "failure", error: { _tag: "SchemaError" } },
            pages: [],
          });
        }),
    );

    it.live(
      `[EXT-39c] a ${shape} query retains valid aliases, decoded input and omitted defaults`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.query(schema)),
            response,
          );
          const encoded = yield* operation
            .execute({ query: { page_size: "05", search_term: "needle" } })
            .pipe(Effect.provide(lane.fetchClient));
          const decoded = yield* operation
            .execute({ query: { limit: 5, term: "needle" } })
            .pipe(Effect.provide(lane.fetchClient));
          const omitted = yield* operation
            .execute({})
            .pipe(Effect.provide(lane.fetchClient));
          expect([encoded, decoded, omitted]).toEqual([
            "Not Found",
            "Not Found",
            "Not Found",
          ]);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(3);
          expectRequest(ledger[0]!, "/x?page_size=5&search_term=needle");
          expectRequest(ledger[1]!, "/x?page_size=5&search_term=needle");
          expectRequest(ledger[2]!, "/x?page_size=25");
        }),
    );

    it.live(
      `[EXT-39d] ${shape} headers retain valid aliases, decoded input and omitted defaults`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(Request.headers(schema)),
            response,
          );
          const encoded = yield* operation
            .execute({ headers: { page_size: "05", search_term: "needle" } })
            .pipe(Effect.provide(lane.fetchClient));
          const decoded = yield* operation
            .execute({ headers: { limit: 5, term: "needle" } })
            .pipe(Effect.provide(lane.fetchClient));
          const omitted = yield* operation
            .execute({})
            .pipe(Effect.provide(lane.fetchClient));
          expect([encoded, decoded, omitted]).toEqual([
            "Not Found",
            "Not Found",
            "Not Found",
          ]);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(3);
          expectPage(ledger[0]!, "5", "needle");
          expectPage(ledger[1]!, "5", "needle");
          expectPage(ledger[2]!, "25");
        }),
    );
  }

  it.live(
    "[EXT-39e] a stacked cursor binding preserves a valid encoded query alias",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.query(Schema.Union([Renamed, Cursor])),
            Request.query(Cursor),
          ),
          response,
        );
        const value = yield* operation
          .execute({ query: { page_size: "05", cursor: "next" } })
          .pipe(Effect.provide(lane.fetchClient));
        expect(value).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expectRequest(ledger[0]!, "/x?page_size=5&cursor=next");
      }),
  );

  it.live(
    "[EXT-39f] a stacked cursor binding preserves a valid encoded header alias",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.headers(Schema.Union([Renamed, Cursor])),
            Request.headers(Cursor),
          ),
          response,
        );
        const value = yield* operation
          .execute({ headers: { page_size: "05", cursor: "next" } })
          .pipe(Effect.provide(lane.fetchClient));
        expect(value).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expectPage(ledger[0]!, "5");
        expect(headerValues(ledger[0]!.lines, "cursor")).toEqual(["next"]);
      }),
  );

  it.live(
    "[EXT-39g] a whole encoded query keeps shared-type codec decoding priority",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(Request.query(Whole)),
          response,
        );
        const encoded = yield* operation
          .execute({ query: { page_size: "05", token: "aGk=" } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ query: { limit: 5, token: "hi" } })
          .pipe(Effect.provide(lane.fetchClient));
        const ambiguous = yield* operation
          .execute({ query: { limit: 5, token: "aGk=" } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([encoded, decoded, ambiguous]).toEqual([
          "Not Found",
          "Not Found",
          "Not Found",
        ]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectRequest(ledger[0]!, "/x?page_size=5&token=aGk%3D");
        expectRequest(ledger[1]!, "/x?page_size=5&token=aGk%3D");
        expectRequest(ledger[2]!, "/x?page_size=5&token=YUdrPQ%3D%3D");
      }),
  );

  it.live(
    "[EXT-39h] whole encoded headers keep shared-type codec decoding priority",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(Request.headers(Whole)),
          response,
        );
        const encoded = yield* operation
          .execute({ headers: { page_size: "05", token: "aGk=" } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ headers: { limit: 5, token: "hi" } })
          .pipe(Effect.provide(lane.fetchClient));
        const ambiguous = yield* operation
          .execute({ headers: { limit: 5, token: "aGk=" } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([encoded, decoded, ambiguous]).toEqual([
          "Not Found",
          "Not Found",
          "Not Found",
        ]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        for (const entry of ledger) expectPage(entry, "5");
        expect(headerValues(ledger[0]!.lines, "token")).toEqual(["aGk="]);
        expect(headerValues(ledger[1]!.lines, "token")).toEqual(["aGk="]);
        expect(headerValues(ledger[2]!.lines, "token")).toEqual(["YUdrPQ=="]);
      }),
  );
});
