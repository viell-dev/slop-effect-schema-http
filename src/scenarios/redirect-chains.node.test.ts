/**
 * EXT-25h: what an attempt's scope releases after a redirect. This needs Node: only a client that
 * hands a redirect back can be followed by `HttpClient.followRedirects`, and Chromium's manual mode
 * gives an opaque answer with no `Location`.
 *
 * The library promises that no live response crosses a failure boundary, because the attempt's scope
 * closes first. Effect 4.1.3 attaches every executed request to that scope, including redirect hops.
 * These check each abort signal when the outcome is classified, then require the last hop's socket
 * to close before test cleanup. On Effect 4.1.2 the redirected signal stayed false and the connection
 * remained open; the retained baseline is tracked in issue #142.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
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

const chain = {
  redirects: {
    "/v1/reports/today": { status: 302, location: "/v1/manifest" },
    "/v1/gone": { status: 302, location: "/v1/bookings/missing" },
  },
  edge: [
    { route: "GET /v1/manifest", fault: "trickle" },
    { route: "GET /v1/bookings/missing", fault: "trickle" },
  ],
};

/** A decoder that refuses an answer without reading a byte of it. */
const refusing = Body.decoder(() => Effect.fail("refused"));

/** Each request's abort signal, in order, as `fetch` receives them. */
const watching = () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchWatched: typeof globalThis.fetch = (input, init) => {
    signals.push(init?.signal);
    return fetch(input, init);
  };
  return {
    aborted: () => signals.map((signal) => signal?.aborted),
    run: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      program.pipe(
        Effect.provide(lane.fetchClient),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
        Effect.provideService(FetchHttpClient.Fetch, fetchWatched),
      ),
  };
};

const following: Bookings.Middleware = (client) =>
  HttpClient.followRedirects(client);

/** A policy that records what each request's signal says when its outcome is classified. */
const classifying = (aborted: () => ReadonlyArray<boolean | undefined>) => {
  const seen: Array<ReadonlyArray<boolean | undefined>> = [];
  return {
    seen,
    policy: Policy.make(Schedule.recurs(0), {
      while: (reason) => {
        seen.push(aborted());
        return Policy.transient(reason);
      },
    }),
  };
};

describe("what an attempt releases after a redirect (node)", () => {
  it.live(
    "[EXT-25h] with no redirect a refused answer's request is aborted by the time its outcome is classified",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("bookings", chain);
        const watched = watching();
        const { seen, policy } = classifying(watched.aborted);
        const error = yield* watched.run(
          Effect.flip(
            Operation.make(
              Request.get(`${backend.origin}/v1/manifest`),
              Response.status(200, refusing),
              { policy },
            ).execute(undefined),
          ),
        );
        expect(Bookings.described(error)).toMatchObject({
          kind: "DecodeError",
          status: 200,
        });
        expect(seen).toEqual([[true]]);
        yield* Bookings.aborted(backend, 0);
      }),
  );

  it.live(
    "[EXT-25h] a redirected answer refused unread is aborted before its outcome is classified",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("bookings", chain);
        const watched = watching();
        const { seen, policy } = classifying(watched.aborted);
        const error = yield* watched.run(
          Effect.flip(
            Operation.make(
              Request.get(`${backend.origin}/v1/reports/today`),
              Response.status(200, refusing),
              { policy, transformClient: following },
            ).execute(undefined),
          ),
        );
        expect(Bookings.described(error)).toMatchObject({
          kind: "DecodeError",
          status: 200,
        });
        expect(seen).toEqual([[true, true]]);
        yield* Bookings.aborted(backend, 1);
        expect((yield* backend.ledger).map(({ target }) => target)).toEqual([
          "/v1/reports/today",
          "/v1/manifest",
        ]);
      }),
  );

  it.live(
    "[EXT-25h] filterStatusOk releases a rejected redirected answer before its outcome is classified",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("bookings", chain);
        const watched = watching();
        const { seen, policy } = classifying(watched.aborted);
        const error = yield* watched.run(
          Effect.flip(
            Operation.make(
              Request.get(`${backend.origin}/v1/gone`),
              Response.status(200, Body.text),
              {
                policy,
                transformClient: (client) =>
                  HttpClient.filterStatusOk(HttpClient.followRedirects(client)),
              },
            ).execute(undefined),
          ),
        );
        expect(Bookings.described(error)).toEqual({ kind: "StatusCodeError" });
        expect(seen).toEqual([[true, true]]);
        yield* Bookings.aborted(backend, 1);
        expect((yield* backend.ledger).map(({ target }) => target)).toEqual([
          "/v1/gone",
          "/v1/bookings/missing",
        ]);
      }),
  );

  it.live(
    "[EXT-25h] Effect alone releases every redirect hop when withScope closes",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("bookings", chain);
        const watched = watching();
        yield* watched.run(
          Effect.scoped(
            Effect.gen(function* () {
              const client = HttpClient.withScope(
                HttpClient.followRedirects(yield* HttpClient.HttpClient),
              );
              const response = yield* client.get(
                `${backend.origin}/v1/reports/today`,
              );
              expect(response.status).toBe(200);
            }),
          ),
        );
        expect(watched.aborted()).toEqual([true, true]);
        yield* Bookings.aborted(backend, 1);
        expect((yield* backend.ledger).map(({ target }) => target)).toEqual([
          "/v1/reports/today",
          "/v1/manifest",
        ]);
      }),
  );

  it.live(
    "[EXT-25h] an attempt timeout still ends a redirected answer, because interruption reaches its body",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("bookings", chain);
        const watched = watching();
        const error = yield* watched.run(
          Effect.flip(
            Operation.make(
              Request.get(`${backend.origin}/v1/reports/today`),
              Response.status(200, Body.text),
              {
                policy: Policy.make(Schedule.recurs(0), {
                  attemptTimeout: "1 second",
                }),
                transformClient: following,
              },
            ).execute(undefined),
          ),
        );
        expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
        yield* Bookings.aborted(backend, 1);
      }),
  );
});
