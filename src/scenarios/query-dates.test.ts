/**
 * EXT-22: a `Date` in a query, in both lanes (#110). The library's own tests state each rule;
 * these pin the text that arrives. Each route reaches the same target, because a request carries
 * the schema's encoded side whichever side the caller gave, and `:` goes out as `%3A` in Node and
 * in Chromium alike, because the library encodes it and a URL parser leaves an escape alone.
 *
 * The server's answer is not the point, so these use `echo`, which answers with 404 and the text
 * `Not Found`, and the socket listener, which keeps each target as it arrived.
 */
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const instant = "2026-11-07T12:30:45.678Z";
const target = "/x?since=2026-11-07T12%3A30%3A45.678Z";
const date = () => new Date(instant);

const notFound = Response.status(404, Body.text);

const start = () => lane.backend("echo", undefined, { listener: "socket" });

/** A request to the `echo` at `origin`, which takes its query from `edit`. */
const at = (origin: string) => Request.get(`${origin}/x`);

const fromString = (origin: string) =>
  at(origin).pipe(
    Request.query(Schema.Struct({ since: Schema.DateFromString })),
  );

const fromDate = (origin: string) =>
  at(origin).pipe(
    Request.query(Schema.Struct({ since: Schema.DateTimeUtcFromDate })),
  );

const targetsOf = <I, E>(
  build: (origin: string) => Request.Request<I, E>,
  input: I,
  client: (typeof lane)["fetchClient"] = lane.fetchClient,
) =>
  Effect.gen(function* () {
    const echo = yield* start();
    yield* Operation.make(build(echo.origin), notFound).execute(input);
    return (yield* echo.ledger).map((entry) => entry.target);
  }).pipe(Effect.provide(client));

describe(`a Date in a query (${lane.name})`, () => {
  for (const [provider, client] of lane.clients)
    it.live(
      `[EXT-22a] ${provider}: Schema.Date takes a Date and sends ISO text`,
      () =>
        Effect.gen(function* () {
          const targets = yield* targetsOf(
            (origin) =>
              at(origin).pipe(
                Request.query(Schema.Struct({ since: Schema.Date })),
              ),
            { query: { since: date() } },
            client,
          );
          expect(targets).toEqual([target]);
        }),
    );

  it.live("[EXT-22a] a list of Dates repeats the name, in order", () =>
    Effect.gen(function* () {
      const later = new Date("2026-11-08T00:00:00.000Z");
      const repeated = `${target}&since=2026-11-08T00%3A00%3A00.000Z`;
      expect(
        yield* targetsOf(
          (origin) =>
            at(origin).pipe(
              Request.query(
                Schema.Struct({ since: Schema.Array(Schema.Date) }),
              ),
            ),
          { query: { since: [date(), later] } },
        ),
      ).toEqual([repeated]);
      expect(
        yield* targetsOf(
          (origin) =>
            at(origin).pipe(Request.setQuery({ since: [date(), later] })),
          undefined,
        ),
      ).toEqual([repeated]);
    }),
  );

  it.live(
    "[EXT-22a] Schema.DateFromString takes a Date or its text, and sends the same",
    () =>
      Effect.gen(function* () {
        expect(
          yield* targetsOf(fromString, { query: { since: date() } }),
        ).toEqual([target]);
        expect(
          yield* targetsOf(fromString, { query: { since: instant } }),
        ).toEqual([target]);
      }),
  );

  it.live(
    "[EXT-22a] a schema from Date to an application's type takes that type or a Date, and sends the same",
    () =>
      Effect.gen(function* () {
        expect(
          yield* targetsOf(fromDate, {
            query: { since: DateTime.makeUnsafe(instant) },
          }),
        ).toEqual([target]);
        expect(
          yield* targetsOf(fromDate, { query: { since: date() } }),
        ).toEqual([target]);
      }),
  );

  it.live("[EXT-22a] a raw Date in the object form sends the same", () =>
    Effect.gen(function* () {
      const targets = yield* targetsOf(
        (origin) => at(origin).pipe(Request.setQuery({ since: date() })),
        undefined,
      );
      expect(targets).toEqual([target]);
    }),
  );

  for (const [name, schema] of [
    ["Schema.Date", Schema.Date],
    ["Schema.DateFromString", Schema.DateFromString],
    ["Schema.DateTimeUtcFromDate", Schema.DateTimeUtcFromDate],
  ] as const)
    it.live(
      `[EXT-22b] an invalid Date under ${name} is a SchemaError, with nothing sent`,
      () =>
        Effect.gen(function* () {
          const echo = yield* start();
          const request = at(echo.origin).pipe(
            Request.query(Schema.Struct({ since: schema })),
          ) as Request.Request<
            { readonly query: { readonly since: Date } },
            unknown
          >;
          const error = yield* Effect.flip(
            Operation.make(request, notFound).execute({
              query: { since: new Date(Number.NaN) },
            }),
          );
          expect(Schema.isSchemaError(error)).toBe(true);
          expect(yield* echo.ledger).toEqual([]);
        }).pipe(Effect.provide(lane.fetchClient)),
    );

  it.live(
    "[EXT-22b] a raw invalid Date has no ISO text, and goes out as Invalid Date",
    () =>
      Effect.gen(function* () {
        const targets = yield* targetsOf(
          (origin) =>
            at(origin).pipe(Request.setQuery({ since: new Date(Number.NaN) })),
          undefined,
        );
        expect(targets).toEqual(["/x?since=Invalid%20Date"]);
      }),
  );

  it.live(
    "[EXT-22c] a raw Date is read when the request is defined, so changing it later changes nothing",
    () =>
      Effect.gen(function* () {
        const echo = yield* start();
        const mutable = date();
        const request = at(echo.origin).pipe(
          Request.setQuery({ since: mutable }),
        );
        mutable.setUTCFullYear(1999);
        yield* Operation.make(request, notFound).execute(undefined);
        expect((yield* echo.ledger).map((entry) => entry.target)).toEqual([
          target,
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-22c] a computation is read on each evaluation, so its text reaches the next request",
    () =>
      Effect.gen(function* () {
        const echo = yield* start();
        const mutable = date();
        const operation = Operation.make(
          at(echo.origin).pipe(
            Request.setQuery({ since: () => mutable.toISOString() }),
          ),
          notFound,
        );
        yield* operation.execute(undefined);
        mutable.setUTCFullYear(1999);
        yield* operation.execute(undefined);
        expect((yield* echo.ledger).map((entry) => entry.target)).toEqual([
          target,
          "/x?since=1999-11-07T12%3A30%3A45.678Z",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-22c] a computation that returns a Date is a compile error",
    () =>
      Effect.sync(() => {
        // @ts-expect-error a computation returns text, so a `Date` needs its `toISOString()` here
        const edit = Request.setQuery({ since: () => date() });
        expect(edit).toBeDefined();
      }),
  );

  it.live(
    "[EXT-22c] currently a computed Date past the types goes out as String(date), in the time zone of whatever runs it",
    () =>
      Effect.gen(function* () {
        const computed = date as unknown as () => string;
        const [sent, ...rest] = yield* targetsOf(
          (origin) => at(origin).pipe(Request.setQuery({ since: computed })),
          undefined,
        );
        expect(rest).toEqual([]);
        expect(decodeURIComponent(sent!)).toBe(`/x?since=${String(date())}`);
      }),
  );

  for (const [name, schema] of [
    ["Schema.Date", Schema.Date],
    ["Schema.DateFromString", Schema.DateFromString],
    ["Schema.DateTimeUtcFromDate", Schema.DateTimeUtcFromDate],
  ] as const) {
    const request = (origin: string) =>
      at(origin).pipe(
        Request.setQuery({ since: date() }),
        Request.query(Schema.Struct({ since: Schema.optionalKey(schema) })),
      ) as Request.Request<
        { readonly query: { readonly since?: Date } },
        unknown
      >;
    it.live(
      `[EXT-22d] a raw Date under ${name} is a default, which the schema writes and a caller's value replaces`,
      () =>
        Effect.gen(function* () {
          expect(yield* targetsOf(request, { query: {} })).toEqual([target]);
          expect(
            yield* targetsOf(request, {
              query: { since: new Date("2001-02-03T04:05:06.000Z") },
            }),
          ).toEqual(["/x?since=2001-02-03T04%3A05%3A06.000Z"]);
        }),
    );
  }

  it.live(
    "[EXT-22e] an offset in written text stays as written, and only a Date is rewritten to UTC",
    () =>
      Effect.gen(function* () {
        const written = yield* targetsOf(
          (origin) =>
            Request.get(`${origin}/x?since=2026-11-07T13:30:45+01:00`),
          undefined,
        );
        expect(written).toEqual(["/x?since=2026-11-07T13:30:45+01:00"]);
        const rewritten = yield* targetsOf(
          (origin) =>
            at(origin).pipe(
              Request.query(Schema.Struct({ since: Schema.DateFromString })),
            ),
          { query: { since: "2026-11-07T13:30:45+01:00" } },
        );
        expect(rewritten).toEqual(["/x?since=2026-11-07T12%3A30%3A45.000Z"]);
      }),
  );
});
