/**
 * EXT-24 where only a browser can show it. Chromium sends a request again by itself when a reused
 * connection ends with no response, a POST included, and a preflight is enough to warm that
 * connection. Node's clients never do, and a page cannot tell, so these run only in the browser
 * project. The rest are what a page can read of a booking under the region's own CORS filter, which
 * exposes no response header.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import * as Bookings from "../clients/bookings/index.js";
import type { Recorded } from "../harness/lane.js";

const client = lane.fetchClient;

const draft: Bookings.BookingDraft = {
  vessel: "MV Aurora",
  terminal: "rotterdam",
  slot: "2026-11-07T06:00",
};

const posts = (ledger: ReadonlyArray<Recorded>) =>
  Bookings.arrivals(ledger, "POST", "/v1/bookings");

const filtered = (edge: ReadonlyArray<{ readonly [key: string]: string }>) =>
  lane.backend(
    "bookings",
    {
      cors: {
        allowHeaders: ["b3", "traceparent", "content-type", "idempotency-key"],
      },
      edge: [...edge],
    },
    { cors: "backend" },
  );

describe("writes seen from a page", () => {
  it.live(
    "[EXT-24b] the browser's own second sending gets a 201, so the library reports a success while an earlier booking also exists",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("bookings", {
          edge: [{ route: "POST /v1/bookings", fault: "closed", times: 1 }],
        });
        const answer = yield* Bookings.book({
          baseUrl: backend.origin,
        }).execute({ draft });
        expect(answer._tag).toBe("Committed");
        expect(answer.value.id).toBe("eu-000002");
        const ledger = posts(yield* backend.ledger);
        expect(ledger).toHaveLength(2);
        expect(ledger[1]?.connection).not.toBe(ledger[0]?.connection);
        const { bookings } = yield* Bookings.bookings({
          baseUrl: backend.origin,
        }).execute(undefined);
        expect(bookings.map(({ id }) => id)).toEqual([
          "eu-000001",
          "eu-000002",
        ]);
      }).pipe(Effect.provide(client)),
  );

  it.live(
    "[EXT-24b] behind the socket listener nothing is reused, so the same rule reaches the caller as a TransportError with one booking",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend(
          "bookings",
          {
            edge: [{ route: "POST /v1/bookings", fault: "closed", times: 1 }],
          },
          { listener: "socket" },
        );
        const error = yield* Effect.flip(
          Bookings.book({ baseUrl: backend.origin }).execute({ draft }),
        );
        expect(Bookings.described(error)).toEqual({ kind: "TransportError" });
        expect(posts(yield* backend.ledger)).toHaveLength(1);
      }).pipe(Effect.provide(client)),
  );

  it.live(
    "[EXT-24f] under the region's own CORS a page reads a replay from the booking alone, because Idempotent-Replay is not exposed",
    () =>
      Effect.gen(function* () {
        const backend = yield* filtered([]);
        const book = Bookings.book({ baseUrl: backend.origin });
        const first = yield* book.execute({ draft, key: "repeat-key-1" });
        expect(first._tag).toBe("Committed");
        expect(first.metadata.headers.location).toBeUndefined();
        const second = yield* book.execute({ draft, key: "repeat-key-1" });
        expect(second._tag).toBe("Replayed");
        expect(second.metadata.headers["idempotent-replay"]).toBeUndefined();
        if (second._tag !== "Replayed") return;
        expect(second.value.replayed).toBe(true);
      }).pipe(Effect.provide(client)),
  );

  it.live(
    "[EXT-24a] under the region's own CORS a preflight warms the connection too, so a lost POST arrives twice",
    () =>
      Effect.gen(function* () {
        const backend = yield* filtered([
          { route: "POST /v1/bookings", fault: "closed" },
        ]);
        const error = yield* Effect.flip(
          Bookings.book({ baseUrl: backend.origin }).execute({ draft }),
        );
        expect(Bookings.described(error)).toEqual({ kind: "TransportError" });
        const ledger = yield* backend.ledger;
        expect(posts(ledger)).toHaveLength(2);
        expect(ledger[0]?.method).toBe("OPTIONS");
        expect(ledger[1]?.connection).toBe(ledger[0]?.connection);
      }).pipe(Effect.provide(client)),
  );
});
