/**
 * EXT-25h: what an attempt's scope releases after a redirect. This needs Node: only a client that
 * hands a redirect back can be followed by `HttpClient.followRedirects`, and Chromium's manual mode
 * gives an opaque answer with no `Location`.
 *
 * The library promises that no live response crosses a failure boundary, because the attempt's scope
 * closes first. Effect keeps that with an abort controller tied to the request an attempt starts
 * with, and `followRedirects` makes a new request for each hop without carrying it over. A decoder
 * or client middleware that refuses the last hop's answer without reading it therefore leaves that
 * request running. A server cannot show this in a bounded time, since the response is released when
 * it is garbage collected, so these read each request's own abort signal at the moment the outcome
 * is classified, which is when the design says it is already over.
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
    "[EXT-25h] currently, a redirected answer refused unread is still running when its outcome is classified, against the design's promise",
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
        expect(seen).toEqual([[true, false]]);
      }),
  );

  it.live(
    "[EXT-25h] currently, so is one that filterStatusOk rejects after a redirect, the same thing through ordinary middleware",
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
        expect(seen).toEqual([[true, false]]);
      }),
  );

  it.live(
    "[EXT-25h] currently, Effect alone does the same: withScope over followRedirects does not abort the last hop when its scope closes",
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
        expect(watched.aborted()).toEqual([true, false]);
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
