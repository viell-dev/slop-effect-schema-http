/**
 * EXT-26: what a failure leaves behind for the next call on the same client: a connection still open,
 * a timer still running, or a stale result. Each test ends with a successful request through the
 * same layer and operation. Waiting for a head means a `Deferred` a client tap completes, and
 * `lines` holds no head until a body ends, so through it a test waits for the arrival instead.
 */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Interaction, Policy } from "viell-effect-schema-http";
import * as Bookings from "../clients/bookings/index.js";
import {
  type Backend,
  header,
  pathOf,
  type Recorded,
} from "../harness/lane.js";

/** The fourth attempt has to finish inside this, so it allows for a slow runner. */
const limit = "1 second";

/** Long enough that a stalled test does not reach its interrupt only after the retry. */
const backoff = "1 second";
const pastBackoff = "1200 millis";

const interrupted = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

/** Client middleware that says when a head came in. */
const headIn =
  (signal: Deferred.Deferred<void>): Bookings.Middleware =>
  (client) =>
    HttpClient.tap(client, () => Deferred.succeed(signal, undefined));

const board = (ledger: ReadonlyArray<Recorded>) =>
  ledger.filter((recorded) => pathOf(recorded) === "/v1/availability");

/**
 * Let a held answer finish. A release can reach the region before the answer it is for starts to
 * wait, so it repeats until `done` has ended, in a bounded loop.
 */
const releaseUntil = <A, E>(
  backend: Backend,
  terminal: string,
  done: Fiber.Fiber<A, E>,
) =>
  Bookings.until(
    Effect.gen(function* () {
      yield* Bookings.release({ baseUrl: backend.origin })
        .execute(terminal)
        .pipe(Effect.orDie);
      return done.pollUnsafe() !== undefined;
    }),
    (finished) => finished,
    `the held answer for ${terminal} finishing`,
  );

describe(`failures that threaten later calls (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    const inFetch = provider !== "lines";

    /** Wait until the request numbered `arrival` from 1 is as far as this provider shows. */
    const reached = (
      backend: Backend,
      signal: Deferred.Deferred<void>,
      arrival: number,
    ) => (inFetch ? Deferred.await(signal) : backend.arrived(arrival));

    it.live(
      `[EXT-26a] ${provider}: three calls interrupted ${inFetch ? "once their heads are in" : "on arrival"} each leave a closed connection, and the fourth gets the whole manifest`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("bookings", {
            edge: [{ route: "GET /v1/manifest", fault: "trickle", times: 3 }],
          });
          for (const index of [0, 1, 2]) {
            const signal = yield* Deferred.make<void>();
            const call = yield* Effect.forkChild(
              Bookings.manifest({
                baseUrl: backend.origin,
                transformClient: headIn(signal),
              }).execute(undefined),
            );
            yield* reached(backend, signal, index + 1);
            yield* Fiber.interrupt(call);
            expect(interrupted(yield* Fiber.await(call))).toBe(true);
            yield* Bookings.aborted(backend, index);
          }
          expect(
            yield* Bookings.manifest({ baseUrl: backend.origin }).execute(
              undefined,
            ),
          ).toBe(Bookings.manifestText);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(4);
          expect(new Set(ledger.map(({ connection }) => connection)).size).toBe(
            4,
          );
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-26b] ${provider}: an interrupt during retry backoff leaves no timer to fire a late attempt, and a new evaluation starts at attempt 1`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("bookings", {
            edge: [
              { route: "GET /v1/manifest", fault: "unavailable", times: 1 },
            ],
          });
          let classified = false;
          const manifest = Bookings.manifest({
            baseUrl: backend.origin,
            transformClient: (stamped, attempt) =>
              HttpClient.mapRequest(
                stamped,
                HttpClientRequest.setHeader("X-Attempt", String(attempt)),
              ),
            policy: Policy.make(Schedule.spaced(backoff), {
              retryAfter: false,
              while: (reason) => {
                classified = true;
                return Policy.transient(reason);
              },
            }),
          });
          const call = yield* Effect.forkChild(manifest.execute(undefined));
          yield* Bookings.until(
            Effect.sync(() => classified),
            (done) => done,
            "the first outcome classified",
          );
          yield* Fiber.interrupt(call);
          expect(interrupted(yield* Fiber.await(call))).toBe(true);
          // Nothing can signal that a timer did not fire, so this waits past the delay.
          yield* Effect.sleep(pastBackoff);
          expect(yield* backend.ledger).toHaveLength(1);
          expect(yield* manifest.execute(undefined)).toBe(
            Bookings.manifestText,
          );
          const ledger = yield* backend.ledger;
          expect(ledger.map(({ lines }) => header(lines, "x-attempt"))).toEqual(
            ["1", "1"],
          );
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-26c] ${provider}: superseding an interaction during a held body ends the old caller and its connection, and a later run is a new arrival`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("bookings", {
            held: ["rotterdam"],
          });
          const signal = yield* Deferred.make<void>();
          const read = Bookings.availability({
            baseUrl: backend.origin,
            transformClient: headIn(signal),
          });
          const box = yield* Interaction.make((terminal: string) =>
            read.execute(terminal),
          );
          const first = yield* Effect.forkChild(box.run("rotterdam"));
          yield* reached(backend, signal, 1);
          const hamburg = yield* box.run("hamburg");
          expect(hamburg.terminal).toBe("hamburg");
          expect(interrupted(yield* Fiber.await(first))).toBe(true);
          yield* Bookings.aborted(backend, 0);
          expect(yield* box.run("hamburg")).toBe(hamburg);
          expect(board(yield* backend.ledger)).toHaveLength(2);

          const later = yield* Effect.forkChild(box.run("rotterdam"));
          yield* backend.arrived(3);
          yield* releaseUntil(backend, "rotterdam", later);
          expect((yield* Fiber.join(later)).terminal).toBe("rotterdam");
          expect(board(yield* backend.ledger)).toHaveLength(3);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-26c] ${provider}: closing the interaction during a held body ends its caller and its connection`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("bookings", {
            held: ["rotterdam"],
          });
          const signal = yield* Deferred.make<void>();
          const read = Bookings.availability({
            baseUrl: backend.origin,
            transformClient: headIn(signal),
          });
          const box = yield* Interaction.make((terminal: string) =>
            read.execute(terminal),
          );
          const held = yield* Effect.forkChild(box.run("rotterdam"));
          yield* reached(backend, signal, 1);
          yield* box.close;
          expect(interrupted(yield* Fiber.await(held))).toBe(true);
          yield* Bookings.aborted(backend, 0);
          const later = yield* Effect.flip(box.run("hamburg"));
          expect(later).toBeInstanceOf(Interaction.Closed);
          expect((yield* read.execute("hamburg")).terminal).toBe("hamburg");
        }).pipe(Effect.provide(client)),
    );

    for (const [order, supersede] of [
      [
        "beside the new run",
        <A, E, R, B, F, S>(
          run: Effect.Effect<A, E, R>,
          release: Effect.Effect<B, F, S>,
        ) =>
          Effect.map(
            Effect.all([run, release], { concurrency: 2 }),
            ([answer]) => answer,
          ),
      ],
      [
        "before the new run",
        <A, E, R, B, F, S>(
          run: Effect.Effect<A, E, R>,
          release: Effect.Effect<B, F, S>,
        ) => Effect.andThen(release, run),
      ],
    ] as const)
      it.live(
        `[EXT-26d] ${provider}: with the release ${order} the new caller gets hamburg and keeps it, the old one gets nothing later, and no held answer stays open`,
        () =>
          Effect.gen(function* () {
            const backend = yield* lane.backend("bookings", {
              held: ["rotterdam"],
            });
            const signal = yield* Deferred.make<void>();
            const read = Bookings.availability({
              baseUrl: backend.origin,
              transformClient: headIn(signal),
            });
            const box = yield* Interaction.make((terminal: string) =>
              read.execute(terminal),
            );
            const finished: Array<string> = [];
            const first = yield* Effect.forkChild(
              box
                .run("rotterdam")
                .pipe(
                  Effect.tap(({ terminal }) =>
                    Effect.sync(() => finished.push(terminal)),
                  ),
                ),
            );
            yield* reached(backend, signal, 1);
            const hamburg = yield* supersede(
              box.run("hamburg"),
              Bookings.release({ baseUrl: backend.origin }).execute(
                "rotterdam",
              ),
            );
            finished.push(hamburg.terminal);
            const old = yield* Fiber.await(first);
            expect(hamburg.terminal).toBe("hamburg");
            expect(finished.at(-1)).toBe("hamburg");
            expect(Exit.isSuccess(old) || interrupted(old)).toBe(true);
            expect(yield* box.run("hamburg")).toBe(hamburg);
            yield* Bookings.closed(backend, 0);
            expect(board(yield* backend.ledger)).toHaveLength(2);
          }).pipe(Effect.provide(client)),
      );

    it.live(
      `[EXT-26e] ${provider}: a failed body under force reaches the caller and leaves the retained success, so the next run needs no request`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("bookings", {
            edge: [
              {
                route: "GET /v1/availability",
                fault: "cut-body",
                after: 1,
                times: 1,
              },
            ],
          });
          const read = Bookings.availability({ baseUrl: backend.origin });
          const box = yield* Interaction.make((terminal: string) =>
            read.execute(terminal),
          );
          const retained = yield* box.run("rotterdam");
          const error = yield* Effect.flip(
            box.run("rotterdam", { force: true }),
          );
          expect(Bookings.described(error)).toEqual(
            inFetch
              ? { kind: "DecodeError", status: 200, inner: "DecodeError" }
              : { kind: "TransportError" },
          );
          yield* Bookings.closed(backend, 1);
          expect(yield* box.run("rotterdam")).toBe(retained);
          expect(yield* backend.ledger).toHaveLength(2);
          const fresh = yield* box.run("rotterdam", { force: true });
          expect(fresh).toEqual(retained);
          expect(yield* backend.ledger).toHaveLength(3);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-26f] ${provider}: attempts that time out in a row leave four arrivals on four connections, and the fourth is whole`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("bookings", {
            edge: [{ route: "GET /v1/manifest", fault: "trickle", times: 3 }],
          });
          const manifest = Bookings.manifest({
            baseUrl: backend.origin,
            policy: Policy.make(Schedule.recurs(3), { attemptTimeout: limit }),
          });
          expect(yield* manifest.execute(undefined)).toBe(
            Bookings.manifestText,
          );
          for (const index of [0, 1, 2])
            yield* Bookings.aborted(backend, index);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(4);
          expect(new Set(ledger.map(({ connection }) => connection)).size).toBe(
            4,
          );
          expect(ledger[3]?.aborted).toBe(false);
          expect(yield* manifest.execute(undefined)).toBe(
            Bookings.manifestText,
          );
        }).pipe(Effect.provide(client)),
    );
  }
});
