/**
 * EXT-25: redirect chains that carry state. A redirect is the client's business: the library hands
 * over one request and gets one response, so one attempt covers a whole chain and only the last
 * answer reaches a contract. Each test asserts every recipient's ledger, because what a chain
 * forwards is the point, and `GET /v1/bookings` for what it did to a booking.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Schedule } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Bookings from "../clients/bookings/index.js";
import {
  type Backend,
  bodyText,
  header,
  type Json,
  type Recorded,
} from "../harness/lane.js";

const inNode = lane.name === "node";

/** Long enough for the head of each hop to come back on a slow runner. */
const limit = "1 second";

const draft: Bookings.BookingDraft = {
  vessel: "MV Aurora",
  terminal: "rotterdam",
  slot: "2026-11-07T06:00",
};
const draftText = JSON.stringify(draft);

interface Provider {
  readonly name: string;
  /** How a redirect gets followed: by the client itself, or by Effect's middleware. */
  readonly transformClient?: Bookings.Middleware;
  readonly run: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>>;
}

const through =
  (layer: Layer.Layer<HttpClient.HttpClient>): Provider["run"] =>
  (program) =>
    Effect.provide(program, layer);

const following: Bookings.Middleware = (client) =>
  HttpClient.followRedirects(client);

/** Every way this lane can follow a chain. Chromium's manual mode gives an opaque answer. */
const providers: ReadonlyArray<Provider> = [
  { name: "fetch", run: through(lane.fetchClient) },
  ...(lane.linesClient === undefined
    ? []
    : [
        {
          name: "lines with followRedirects",
          transformClient: following,
          run: through(lane.linesClient),
        },
      ]),
  ...(inNode
    ? [
        {
          name: "fetch with manual redirects and followRedirects",
          transformClient: following,
          run: ((program) =>
            program.pipe(
              Effect.provide(lane.fetchClient),
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "manual",
              }),
            )) satisfies Provider["run"],
        },
      ]
    : []),
];

const usesFollowRedirects = (provider: Provider) =>
  provider.transformClient !== undefined;

/** What a request carries through a chain. Chromium would drop a hand-set `Cookie` (TRN-1). */
const carrying = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(
    Request.setHeader("Authorization", "Bearer secret"),
    Request.setHeader("X-Agent-Key", "agent-1"),
    Request.setHeader("Cookie", inNode ? "session=1" : () => undefined),
  );

const posting = (
  provider: Provider,
  origin: string,
  policy: Policy.Policy = Policy.none,
) =>
  Operation.make(
    Request.post(`${origin}/v1/reserve`).pipe(
      carrying,
      Request.body(Body.jsonSchema(Bookings.BookingDraft)),
    ),
    Response.status(201, Body.jsonSchema(Bookings.Booking)),
    { policy, transformClient: provider.transformClient },
  );

const getting = (
  provider: Provider,
  url: string,
  policy: Policy.Policy = Policy.none,
) =>
  Operation.make(
    Request.get(url).pipe(carrying),
    Response.status(200, Body.text),
    { policy, transformClient: provider.transformClient },
  );

const region = (options: { readonly [key: string]: Json }) =>
  lane.backend("bookings", options);

/** One hop from `from` to `location`. */
const hop = (from: string, status: number, location: string) => ({
  [from]: { status, location },
});

const committed = (backend: Backend) =>
  Bookings.bookings({ baseUrl: backend.origin })
    .execute(undefined)
    .pipe(
      Effect.map(({ bookings }) => bookings.map(({ id }) => id)),
      Effect.provide(lane.fetchClient),
    );

const route = (recorded: Recorded | undefined) =>
  recorded === undefined ? "" : `${recorded.method} ${recorded.target}`;

/** What the ledger holds before the test's own read of the bookings. */
const routes = (ledger: ReadonlyArray<Recorded>) => ledger.map(route);

const credentials = (recorded: Recorded | undefined) => {
  const lines = recorded?.lines ?? [];
  return {
    authorization: header(lines, "authorization"),
    agent: header(lines, "x-agent-key"),
    cookie: header(lines, "cookie"),
  };
};

const allCarried = {
  authorization: "Bearer secret",
  agent: "agent-1",
  cookie: inNode ? "session=1" : undefined,
};

/** What a client drops when a hop leaves the origin. */
const leftOrigin = {
  authorization: undefined,
  agent: "agent-1",
  cookie: undefined,
};

describe(`redirect chains with state (${lane.name})`, () => {
  for (const provider of providers) {
    const { name } = provider;

    for (const status of [301, 302, 303])
      it.live(
        `[EXT-25a] ${name}: a POST through ${status} arrives as a GET of the list, so a contract of 201 gets an UnexpectedResponse and the booking is lost`,
        () =>
          provider.run(
            Effect.gen(function* () {
              const backend = yield* region({
                redirects: hop("/v1/reserve", status, "/v1/bookings"),
              });
              const error = yield* Effect.flip(
                posting(provider, backend.origin).execute({ body: draft }),
              );
              expect(Bookings.described(error)).toEqual({
                kind: "UnexpectedResponse",
                status: 200,
              });
              const ledger = yield* backend.ledger;
              expect(routes(ledger)).toEqual([
                "POST /v1/reserve",
                "GET /v1/bookings",
              ]);
              expect(bodyText(ledger[0]!)).toBe(draftText);
              const last = ledger[1]!;
              expect(bodyText(last)).toBe("");
              expect(header(last.lines, "content-length")).toBeUndefined();
              expect(header(last.lines, "content-type")).toBeUndefined();
              expect(credentials(ledger[0])).toEqual(allCarried);
              expect(credentials(last)).toEqual(allCarried);
              expect(yield* committed(backend)).toEqual([]);
            }),
          ),
      );

    for (const status of [307, 308])
      it.live(
        `[EXT-25b] ${name}: a POST through ${status} keeps its method, body and every header, and one booking is committed`,
        () =>
          provider.run(
            Effect.gen(function* () {
              const backend = yield* region({
                redirects: hop("/v1/reserve", status, "/v1/bookings"),
              });
              const booking = yield* posting(provider, backend.origin).execute({
                body: draft,
              });
              expect(booking.id).toBe("eu-000001");
              const ledger = yield* backend.ledger;
              expect(routes(ledger)).toEqual([
                "POST /v1/reserve",
                "POST /v1/bookings",
              ]);
              for (const recorded of ledger) {
                expect(bodyText(recorded)).toBe(draftText);
                expect(header(recorded.lines, "content-type")).toBe(
                  "application/json",
                );
                expect(credentials(recorded)).toEqual(allCarried);
              }
              expect(yield* committed(backend)).toEqual(["eu-000001"]);
            }),
          ),
      );

    it.live(
      `[EXT-25c] ${name}: a same-origin hop then a cross-origin hop by 307 keeps the body and X-Agent-Key throughout, and Authorization stops at the origin`,
      () =>
        provider.run(
          Effect.gen(function* () {
            const us = yield* region({ region: "us" });
            const eu = yield* region({
              redirects: {
                ...hop("/v1/reserve", 307, "/v1/transfer"),
                ...hop("/v1/transfer", 307, `${us.origin}/v1/bookings`),
              },
            });
            const booking = yield* posting(provider, eu.origin).execute({
              body: draft,
            });
            expect(booking.id).toBe("us-000001");
            const [atEu, atUs] = [yield* eu.ledger, yield* us.ledger];
            expect(routes(atEu)).toEqual([
              "POST /v1/reserve",
              "POST /v1/transfer",
            ]);
            expect(routes(atUs)).toEqual(["POST /v1/bookings"]);
            for (const recorded of [...atEu, ...atUs])
              expect(bodyText(recorded)).toBe(draftText);
            expect(credentials(atEu[0])).toEqual(allCarried);
            expect(credentials(atEu[1])).toEqual(allCarried);
            expect(credentials(atUs[0])).toEqual(leftOrigin);
            if (!inNode) expect(header(atUs[0]!.lines, "origin")).toBe("null");
            expect(yield* committed(eu)).toEqual([]);
            expect(yield* committed(us)).toEqual(["us-000001"]);
          }),
        ),
    );

    it.live(
      `[EXT-25d] ${name}: the same chain by 302 reaches the other region as a GET, with X-Agent-Key and without Authorization, and nothing is committed anywhere`,
      () =>
        provider.run(
          Effect.gen(function* () {
            const us = yield* region({ region: "us" });
            const eu = yield* region({
              redirects: {
                ...hop("/v1/reserve", 302, "/v1/transfer"),
                ...hop("/v1/transfer", 302, `${us.origin}/v1/bookings`),
              },
            });
            const error = yield* Effect.flip(
              posting(provider, eu.origin).execute({ body: draft }),
            );
            expect(Bookings.described(error)).toEqual({
              kind: "UnexpectedResponse",
              status: 200,
            });
            const [atEu, atUs] = [yield* eu.ledger, yield* us.ledger];
            expect(routes(atEu)).toEqual([
              "POST /v1/reserve",
              "GET /v1/transfer",
            ]);
            expect(routes(atUs)).toEqual(["GET /v1/bookings"]);
            expect(bodyText(atUs[0]!)).toBe("");
            expect(credentials(atEu[1])).toEqual(allCarried);
            expect(credentials(atUs[0])).toEqual(leftOrigin);
            expect(yield* committed(eu)).toEqual([]);
            expect(yield* committed(us)).toEqual([]);
          }),
        ),
    );

    const loop = {
      ...hop("/v1/a", 302, "/v1/b"),
      ...hop("/v1/b", 302, "/v1/a"),
    };

    it.live(
      `[EXT-25e] ${name}: a loop ${usesFollowRedirects(provider) ? "stops after 11 arrivals and hands back the last 302" : "is a TransportError after 21 arrivals"}`,
      () =>
        provider.run(
          Effect.gen(function* () {
            const backend = yield* region({ redirects: loop });
            const error = yield* Effect.flip(
              getting(provider, `${backend.origin}/v1/a`).execute(undefined),
            );
            const ledger = yield* backend.ledger;
            if (usesFollowRedirects(provider)) {
              expect(Bookings.described(error)).toEqual({
                kind: "UnexpectedResponse",
                status: 302,
              });
              expect(ledger).toHaveLength(11);
            } else {
              expect(Bookings.described(error)).toEqual({
                kind: "TransportError",
              });
              expect(Bookings.causes(error)).toEqual(
                inNode
                  ? ["fetch failed", "redirect count exceeded"]
                  : ["Failed to fetch"],
              );
              expect(ledger).toHaveLength(21);
            }
            expect(routes(ledger.slice(0, 3))).toEqual([
              "GET /v1/a",
              "GET /v1/b",
              "GET /v1/a",
            ]);
          }),
        ),
    );

    it.live(
      `[EXT-25f] ${name}: a loop of POSTs by 307 carries the body on every arrival and commits nothing`,
      () =>
        provider.run(
          Effect.gen(function* () {
            const backend = yield* region({
              redirects: {
                ...hop("/v1/reserve", 307, "/v1/transfer"),
                ...hop("/v1/transfer", 307, "/v1/reserve"),
              },
            });
            const error = yield* Effect.flip(
              posting(provider, backend.origin).execute({ body: draft }),
            );
            expect(Bookings.described(error)).toEqual(
              usesFollowRedirects(provider)
                ? { kind: "UnexpectedResponse", status: 307 }
                : { kind: "TransportError" },
            );
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(
              usesFollowRedirects(provider) ? 11 : 21,
            );
            for (const recorded of ledger) {
              expect(recorded.method).toBe("POST");
              expect(bodyText(recorded)).toBe(draftText);
            }
            expect(yield* committed(backend)).toEqual([]);
          }),
        ),
    );

    it.live(
      `[EXT-25g] ${name}: one attempt covers a chain, so a timeout in the redirected body retries from the first URL`,
      () =>
        provider.run(
          Effect.gen(function* () {
            const backend = yield* region({
              redirects: hop("/v1/reports/today", 302, "/v1/manifest"),
              edge: [{ route: "GET /v1/manifest", fault: "trickle" }],
            });
            const error = yield* Effect.flip(
              getting(
                provider,
                `${backend.origin}/v1/reports/today`,
                Policy.make(Schedule.recurs(1), { attemptTimeout: limit }),
              ).execute(undefined),
            );
            expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
            yield* Bookings.aborted(backend, 1);
            const ledger = yield* Bookings.aborted(backend, 3);
            expect(routes(ledger)).toEqual([
              "GET /v1/reports/today",
              "GET /v1/manifest",
              "GET /v1/reports/today",
              "GET /v1/manifest",
            ]);
            expect(ledger[0]?.aborted).toBe(false);
            expect(ledger[2]?.aborted).toBe(false);
          }),
        ),
    );
  }
});
