import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schedule } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues } from "./lane.js";

/** Smoke tests of the portable harness, run in every lane against the neutral echo backend. */
describe(`lane harness (${lane.name})`, () => {
  for (const [client, layer] of lane.clients)
    it.live(`dispatches through ${client} and records the request`, () =>
      Effect.gen(function* () {
        const echo = yield* lane.backend("echo");
        const text = yield* Operation.make(
          Request.get(`${echo.origin}/text`),
          Response.status(200, Body.text),
        )
          .execute(undefined)
          .pipe(Effect.provide(layer));
        expect(text).toBe("ok");
        const [received, ...rest] = yield* echo.ledger;
        expect(rest).toEqual([]);
        expect(received?.method).toBe("GET");
        expect(received?.target).toBe("/text");
      }),
    );

  it.live(
    "joins repeated request lines through fetch, so the strict server rejects them",
    () =>
      Effect.gen(function* () {
        const echo = yield* lane.backend("echo");
        const exit = yield* Operation.make(
          Request.get(`${echo.origin}/scopes`).pipe(
            Request.appendHeader("X-Scope", "read"),
            Request.appendHeader("X-Scope", "write"),
          ),
          Response.status(200, Body.text),
        )
          .execute(undefined)
          .pipe(Effect.provide(lane.fetchClient), Effect.exit);
        expect(exit._tag).toBe("Failure");
        const [received] = yield* echo.ledger;
        expect(headerValues(received!.lines, "x-scope")).toEqual([
          "read, write",
        ]);
      }),
  );

  it.live("observes an abort when an in-flight operation is interrupted", () =>
    Effect.gen(function* () {
      const echo = yield* lane.backend("echo");
      const fiber = yield* Operation.make(
        Request.get(`${echo.origin}/hold`),
        Response.status(200, Body.empty),
      )
        .execute(undefined)
        .pipe(Effect.provide(lane.fetchClient), Effect.forkChild);
      yield* echo.arrived(1);
      yield* Fiber.interrupt(fiber);
      // The server learns of the abort when the socket closes; read the ledger until it has.
      const aborted = yield* echo.ledger.pipe(
        Effect.map((ledger) => ledger[0]?.aborted === true),
        Effect.repeat({
          schedule: Schedule.spaced("25 millis"),
          until: (seen) => seen,
          times: 120,
        }),
      );
      expect(aborted).toBe(true);
    }),
  );
});
