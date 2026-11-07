/**
 * EXT-23 from a page, where what a failure looks like depends on who wrote its CORS lines. These are
 * about the browser itself, so they run only in the browser project. Under the region's own filter a
 * head the edge wrote has no CORS lines and a page never sees it, and a head that kept the filter's
 * lines fails only at its body. Through the same-origin proxy no CORS applies, and `node:http` reads
 * every answer before the page does.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Bookings from "../clients/bookings/index.js";
import { proxyBase } from "../clients/browser/proxy.js";

const retrying = Policy.make(Schedule.recurs(1));
const client = lane.fetchClient;

/** A region answering CORS itself, for the trace headers Effect adds. */
const filtered = (fault: string) =>
  lane.backend(
    "bookings",
    {
      cors: { allowHeaders: ["b3", "traceparent"] },
      edge: [{ route: "GET /v1/manifest", fault, times: 1 }],
    },
    { cors: "backend" },
  );

const faulted = (fault: string) =>
  lane.backend("bookings", {
    edge: [{ route: "GET /v1/manifest", fault, times: 1 }],
  });

const proxied = (origin: string, policy: Policy.Policy = Policy.none) =>
  Bookings.manifest({ baseUrl: proxyBase(origin), policy });

const bad = { kind: "UnexpectedResponse", status: 502 };
const failedBody = { kind: "DecodeError", status: 200, inner: "DecodeError" };

/** The manifest under a contract that also declares the 503. */
const declaring = (origin: string, policy: Policy.Policy) =>
  Operation.make(
    Request.get(`${origin}/v1/manifest`),
    Response.status(200, Body.text).pipe(
      Response.orElse(Response.status(503, Body.text)),
    ),
    { policy },
  );

describe("failures seen from a page", () => {
  it.live(
    "[EXT-23e] under the region's own CORS a cut head is a TransportError, because no CORS line arrived, and it is retried",
    () =>
      Effect.gen(function* () {
        const first = yield* filtered("cut-head");
        const once = Bookings.manifest({ baseUrl: first.origin });
        const error = yield* Effect.flip(once.execute(undefined));
        expect(Bookings.described(error)).toEqual({ kind: "TransportError" });
        expect(Bookings.causes(error)).toEqual(["Failed to fetch"]);
        yield* Bookings.closed(first, 0);
        expect(yield* once.execute(undefined)).toBe(Bookings.manifestText);

        const second = yield* filtered("cut-head");
        expect(
          yield* Bookings.manifest({
            baseUrl: second.origin,
            policy: retrying,
          }).execute(undefined),
        ).toBe(Bookings.manifestText);
        expect(
          Bookings.arrivals(yield* second.ledger, "GET", "/v1/manifest"),
        ).toHaveLength(2);
      }).pipe(Effect.provide(client)),
  );

  it.live(
    "[EXT-23a] under the region's own CORS cut-body keeps the filter's lines, so it is a failed body and not a CORS refusal",
    () =>
      Effect.gen(function* () {
        const backend = yield* filtered("cut-body");
        const error = yield* Effect.flip(
          Bookings.manifest({
            baseUrl: backend.origin,
            policy: retrying,
          }).execute(undefined),
        );
        expect(Bookings.described(error)).toEqual(failedBody);
        expect(
          Bookings.arrivals(yield* backend.ledger, "GET", "/v1/manifest"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(client)),
  );

  it.live(
    "[EXT-23o] under the region's own CORS a cut 503 has no CORS lines, so a page gets a TransportError with no status, retried all the same",
    () =>
      Effect.gen(function* () {
        const first = yield* filtered("cut-unavailable");
        const error = yield* Effect.flip(
          declaring(first.origin, Policy.none).execute(undefined),
        );
        expect(Bookings.described(error)).toEqual({ kind: "TransportError" });

        const second = yield* filtered("cut-unavailable");
        expect(
          yield* declaring(second.origin, retrying).execute(undefined),
        ).toBe(Bookings.manifestText);
        expect(
          Bookings.arrivals(yield* second.ledger, "GET", "/v1/manifest"),
        ).toHaveLength(2);
      }).pipe(Effect.provide(client)),
  );

  for (const [id, fault] of [
    ["[EXT-23f]", "closed"],
    ["[EXT-23f]", "reset"],
    ["[EXT-23e]", "cut-head"],
  ] as const)
    it.live(
      `${id} through the same-origin proxy ${fault} is a 502 from the proxy, an ordinary response a retry repeats`,
      () =>
        Effect.gen(function* () {
          const first = yield* faulted(fault);
          const error = yield* Effect.flip(
            proxied(first.origin).execute(undefined),
          );
          expect(Bookings.described(error)).toEqual(bad);
          expect(yield* first.ledger).toHaveLength(1);

          const second = yield* faulted(fault);
          expect(
            yield* proxied(second.origin, retrying).execute(undefined),
          ).toBe(Bookings.manifestText);
          expect(yield* second.ledger).toHaveLength(2);
        }).pipe(Effect.provide(client)),
    );

  for (const [id, fault] of [
    ["[EXT-23a]", "cut-body"],
    ["[EXT-23c]", "cut-chunked"],
    ["[EXT-23d]", "bad-chunk"],
    ["[EXT-23i]", "gzip-magic"],
    ["[EXT-23i]", "gzip-block"],
  ] as const)
    it.live(
      `${id} through the same-origin proxy ${fault} fails at the body as it does for a page reaching the region directly`,
      () =>
        Effect.gen(function* () {
          const backend = yield* faulted(fault);
          const error = yield* Effect.flip(
            proxied(backend.origin, retrying).execute(undefined),
          );
          expect(Bookings.described(error)).toEqual(failedBody);
          expect(Bookings.causes(error)).toEqual(["Failed to fetch"]);
          expect(yield* backend.ledger).toHaveLength(1);
        }).pipe(Effect.provide(client)),
    );

  it.live(
    "[EXT-23g] through the same-origin proxy an answer with no framing that stops half-way is still a success",
    () =>
      Effect.gen(function* () {
        const backend = yield* faulted("cut-unframed");
        expect(yield* proxied(backend.origin).execute(undefined)).toBe(
          Bookings.manifestText.slice(0, 450),
        );
      }).pipe(Effect.provide(client)),
  );

  for (const [id, fault] of [
    ["[EXT-23h]", "gzip"],
    ["[EXT-23j]", "gzip-checksum"],
    ["[EXT-23k]", "gzip-trailer"],
  ] as const)
    it.live(
      `${id} through the same-origin proxy ${fault} gives the manifest, as it does for a page`,
      () =>
        Effect.gen(function* () {
          const backend = yield* faulted(fault);
          expect(yield* proxied(backend.origin).execute(undefined)).toBe(
            Bookings.manifestText,
          );
        }).pipe(Effect.provide(client)),
    );

  it.live(
    "[EXT-23k] through the same-origin proxy gzip-truncated gives part of the manifest as a success",
    () =>
      Effect.gen(function* () {
        const backend = yield* faulted("gzip-truncated");
        const text = yield* proxied(backend.origin).execute(undefined);
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThan(Bookings.manifestText.length);
        expect(Bookings.manifestText.startsWith(text)).toBe(true);
      }).pipe(Effect.provide(client)),
  );

  for (const [id, fault] of [
    ["[EXT-23l]", "trickle"],
    ["[EXT-23m]", "hang"],
  ] as const)
    it.live(
      `${id} through the same-origin proxy ${fault} under an attempt timeout is a TimeoutError`,
      () =>
        Effect.gen(function* () {
          const backend = yield* faulted(fault);
          const error = yield* Effect.flip(
            proxied(
              backend.origin,
              Policy.make(Schedule.recurs(0), {
                attemptTimeout: "1 second",
              }),
            ).execute(undefined),
          );
          expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
          yield* Bookings.aborted(backend, 0);
        }).pipe(Effect.provide(client)),
    );
});
