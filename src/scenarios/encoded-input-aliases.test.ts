/**
 * EXT-38: public input types retain encoded names in partly renamed structs.
 * Acceptance: https://github.com/viell-dev/slop-effect-schema-http/issues/169
 * Wire evidence uses only the README's neutral echo contract and physical socket ledgers.
 * This is a typing repair; invalid encoded-value replacement in #170 remains unresolved.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const fields = {
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
};
const Filters = Schema.Struct(fields).pipe(
  Schema.encodeKeys({ limit: "page_size" }),
);
const HeaderFilters = Schema.Struct(fields).pipe(
  Schema.encodeKeys({ limit: "x-page-size" }),
);
const FilterUnion = Schema.Union([
  Filters,
  Schema.Struct({ cursor: Schema.String }),
]);
const HeaderUnion = Schema.Union([
  HeaderFilters,
  Schema.Struct({ cursor: Schema.String }),
]);
const Singleton = Schema.Union([Filters]);
const ExchangedAliases = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("a"),
    term: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ limit: "page_size" })),
  Schema.Struct({
    kind: Schema.Literal("b"),
    term: Schema.optionalKey(Schema.String),
    page_size: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ page_size: "limit" })),
]);

// Kept unevaluated: these assignments check the actual public type without dispatch or casts.
const inputExamples = () => {
  const encoded: Request.Input<typeof Filters> = { page_size: "05" };
  const decoded: Request.Input<typeof Filters> = { limit: 5 };
  const omitted: Request.Input<typeof Filters> = {};
  const union: Request.Input<typeof FilterUnion> = { page_size: "05" };
  const singleton: Request.Input<typeof Singleton> = { page_size: "05" };
  const headers: Request.Input<typeof HeaderFilters> = { "x-page-size": "05" };
  const headerUnion: Request.Input<typeof HeaderUnion> = {
    "x-page-size": "05",
  };
  const Strings = Schema.Struct({
    term: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const strings: Request.Input<typeof Strings> = { page_size: "05" };
  const Required = Schema.Struct({
    term: Schema.String,
    limit: Schema.optionalKey(Schema.FiniteFromString),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const required: Request.Input<typeof Required> = {
    term: "needle",
    page_size: "05",
  };
  const exchangedA: Request.Input<typeof ExchangedAliases> = {
    kind: "a",
    page_size: "05",
  };
  const exchangedB: Request.Input<typeof ExchangedAliases> = {
    kind: "b",
    limit: "07",
  };
  // @ts-expect-error The discriminant still requires a declared member.
  const wrongKind: Request.Input<typeof ExchangedAliases> = { kind: "c" };
  // @ts-expect-error The encoded alias still requires a string value.
  const wrongExchangedValue: Request.Input<typeof ExchangedAliases> = {
    kind: "a",
    page_size: 5,
  };
  const wrongExchangedName: Request.Input<typeof ExchangedAliases> = {
    kind: "b",
    // @ts-expect-error Unknown names remain unavailable in an exchanged-alias member.
    pageCount: "07",
  };
  // @ts-expect-error An unchanged required sibling cannot be omitted.
  const missing: Request.Input<typeof Required> = { page_size: "05" };
  // @ts-expect-error Encoded aliases still require the encoded value's type.
  const wrongValue: Request.Input<typeof Filters> = { page_size: 5 };
  // @ts-expect-error Unknown keys remain unavailable.
  const wrongName: Request.Input<typeof Filters> = { pageCount: "05" };
  return {
    encoded,
    decoded,
    omitted,
    union,
    singleton,
    headers,
    headerUnion,
    strings,
    required,
    exchangedA,
    exchangedB,
    wrongKind,
    wrongExchangedValue,
    wrongExchangedName,
    missing,
    wrongValue,
    wrongName,
  };
};
void inputExamples;

const response = Response.status(404, Body.text);
const expectWire = (
  entry: Recorded,
  target: string,
  pageSize: string | undefined,
) => {
  expect(entry.method).toBe("GET");
  expect(entry.target).toBe(target);
  expect(headerValues(entry.lines, "x-page-size")).toEqual(
    pageSize === undefined ? [] : [pageSize],
  );
  expect(headerValues(entry.lines, "limit")).toEqual([]);
  expect(entry.body.byteLength).toBe(0);
};

describe(`encoded input aliases (${lane.name})`, () => {
  it.live(
    "[EXT-38a] a direct query accepts encoded aliases and retains decoded and omitted controls",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(Request.query(Filters)),
          response,
        );
        const encoded = yield* operation
          .execute({ query: { term: "needle", page_size: "05" } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ query: { term: "needle", limit: 5 } })
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
        expectWire(ledger[0]!, "/x?term=needle&page_size=5", undefined);
        expectWire(ledger[1]!, "/x?term=needle&page_size=5", undefined);
        expectWire(ledger[2]!, "/x?page_size=25", undefined);
      }),
  );

  it.live(
    "[EXT-38b] a query union accepts encoded aliases and retains decoded and omitted controls",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(Request.query(FilterUnion)),
          response,
        );
        const encoded = yield* operation
          .execute({ query: { term: "needle", page_size: "05" } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ query: { term: "needle", limit: 5 } })
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
        expectWire(ledger[0]!, "/x?term=needle&page_size=5", undefined);
        expectWire(ledger[1]!, "/x?term=needle&page_size=5", undefined);
        expectWire(ledger[2]!, "/x?page_size=25", undefined);
      }),
  );

  it.live(
    "[EXT-38c] direct headers accept encoded aliases and retain decoded and omitted controls",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.headers(HeaderFilters),
          ),
          response,
        );
        const encoded = yield* operation
          .execute({ headers: { term: "needle", "x-page-size": "05" } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ headers: { term: "needle", limit: 5 } })
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
        expectWire(ledger[0]!, "/x", "5");
        expectWire(ledger[1]!, "/x", "5");
        expectWire(ledger[2]!, "/x", "25");
        expect(headerValues(ledger[0]!.lines, "term")).toEqual(["needle"]);
        expect(headerValues(ledger[1]!.lines, "term")).toEqual(["needle"]);
        expect(headerValues(ledger[2]!.lines, "term")).toEqual([]);
      }),
  );

  it.live(
    "[EXT-38d] a header union accepts encoded aliases and retains decoded and omitted controls",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(Request.headers(HeaderUnion)),
          response,
        );
        const encoded = yield* operation
          .execute({ headers: { term: "needle", "x-page-size": "05" } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ headers: { term: "needle", limit: 5 } })
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
        expectWire(ledger[0]!, "/x", "5");
        expectWire(ledger[1]!, "/x", "5");
        expectWire(ledger[2]!, "/x", "25");
        expect(headerValues(ledger[0]!.lines, "term")).toEqual(["needle"]);
        expect(headerValues(ledger[1]!.lines, "term")).toEqual(["needle"]);
        expect(headerValues(ledger[2]!.lines, "term")).toEqual([]);
      }),
  );

  it.live(
    "[EXT-38e] a query union retains encoded aliases exchanged between discriminated members",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.query(ExchangedAliases),
          ),
          response,
        );
        const first = yield* operation
          .execute({ query: { kind: "a", page_size: "05" } })
          .pipe(Effect.provide(lane.fetchClient));
        const second = yield* operation
          .execute({ query: { kind: "b", limit: "07" } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([first, second]).toEqual(["Not Found", "Not Found"]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(2);
        expectWire(ledger[0]!, "/x?kind=a&page_size=05", undefined);
        expectWire(ledger[1]!, "/x?kind=b&limit=07", undefined);
      }),
  );

  it.live(
    "[EXT-38f] a header union retains encoded aliases exchanged between discriminated members",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.headers(ExchangedAliases),
          ),
          response,
        );
        const first = yield* operation
          .execute({ headers: { kind: "a", page_size: "05" } })
          .pipe(Effect.provide(lane.fetchClient));
        const second = yield* operation
          .execute({ headers: { kind: "b", limit: "07" } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([first, second]).toEqual(["Not Found", "Not Found"]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(2);
        for (const entry of ledger) {
          expect(entry.method).toBe("GET");
          expect(entry.target).toBe("/x");
          expect(entry.body.byteLength).toBe(0);
          expect(headerValues(entry.lines, "term")).toEqual([]);
          expect(headerValues(entry.lines, "x-page-size")).toEqual([]);
        }
        expect(headerValues(ledger[0]!.lines, "kind")).toEqual(["a"]);
        expect(headerValues(ledger[0]!.lines, "page_size")).toEqual(["05"]);
        expect(headerValues(ledger[0]!.lines, "limit")).toEqual([]);
        expect(headerValues(ledger[1]!.lines, "kind")).toEqual(["b"]);
        expect(headerValues(ledger[1]!.lines, "limit")).toEqual(["07"]);
        expect(headerValues(ledger[1]!.lines, "page_size")).toEqual([]);
      }),
  );
});
