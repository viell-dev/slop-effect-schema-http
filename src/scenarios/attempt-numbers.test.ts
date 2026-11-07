/**
 * EXT-21: the attempt number `transformClient` receives, across real retries and timeouts, in both
 * lanes (#99). Each attempt writes its number into a header, so the number a test asserts is the
 * one that arrived, not the one a callback saw.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Operation, Policy } from "viell-effect-schema-http";
import * as Ops from "../clients/business/operations.js";
import { type Backend, header, type Recorded } from "../harness/lane.js";

const token = "attempts-token";

const start = (options: { readonly longPollHold?: number } = {}) =>
  lane.backend("business", { operations: { token, ...options } });

const connect = (backend: Backend): Ops.Connection => ({
  baseUrl: `${backend.origin}/v2`,
  credential: () => token,
});

const stamped = (client: HttpClient.HttpClient, attempt: number) =>
  HttpClient.mapRequest(
    client,
    HttpClientRequest.setHeader("X-Attempt", String(attempt)),
  );

/** Middleware with an optional second parameter of its own, which is not an attempt number. */
const labelled = (
  client: HttpClient.HttpClient,
  label: string | number = "unlabelled",
) =>
  HttpClient.mapRequest(
    client,
    HttpClientRequest.setHeader("X-Attempt", String(label)),
  );

/** Stamp each attempt with its number, and send every attempt after the first to `standby`. */
const moving =
  (first: Backend, standby: Backend) =>
  (client: HttpClient.HttpClient, attempt: number) =>
    stamped(
      attempt === 1
        ? client
        : HttpClient.mapRequest(client, (request) =>
            HttpClientRequest.setUrl(
              request,
              request.url.replace(first.origin, standby.origin),
            ),
          ),
      attempt,
    );

const attempts = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map(({ lines }) => header(lines, "x-attempt"));

const pair = { path: { pair: "EURUSD" } };

describe(`attempt numbers (${lane.name})`, () => {
  for (const [provider, client] of lane.clients)
    it.live(
      `[EXT-21a] ${provider}: three real attempts arrive numbered 1, 2 and 3, and the next evaluation starts at 1`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const quote = Ops.quote(
            connect(backend),
            Policy.make(Schedule.recurs(2), { while: Ops.transientOrCalm }),
          ).pipe(
            Operation.mapOptions((options) => ({
              ...options,
              transformClient: stamped,
            })),
          );
          yield* quote.execute(pair);
          expect(attempts(yield* backend.ledger)).toEqual(["1", "2", "3"]);
          yield* quote.execute(pair);
          expect(attempts(yield* backend.ledger)).toEqual(["1", "2", "3", "1"]);
        }).pipe(Effect.provide(client)),
    );

  it.live(
    "[EXT-21b] an attempt that timed out counts, so the one after it arrives numbered 2",
    () =>
      Effect.gen(function* () {
        const held = yield* start({ longPollHold: 10_000 });
        const standby = yield* start({ longPollHold: 10 });
        const answer = yield* Ops.pollEvents(
          connect(held),
          Policy.make(Schedule.recurs(1), { attemptTimeout: "300 millis" }),
        )
          .pipe(
            Operation.mapOptions((options) => ({
              ...options,
              transformClient: moving(held, standby),
            })),
          )
          .execute(undefined);
        expect(answer._tag).toBe("Events");
        // The number on an attempt that was answered: a request aborted by a timeout need not have
        // reached the socket, so the held server's ledger proves nothing either way.
        expect(attempts(yield* standby.ledger)).toEqual(["2"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-21c] a retry moves off a dead server by its number, which a base URL cannot do",
    () =>
      Effect.gen(function* () {
        const gone = yield* Effect.scoped(start());
        const standby = yield* start({ longPollHold: 10 });
        // A reused port would send the first attempt to the standby.
        expect(standby.origin).not.toBe(gone.origin);
        const answer = yield* Ops.pollEvents(
          connect(gone),
          Policy.make(Schedule.recurs(1)),
        )
          .pipe(
            Operation.mapOptions((options) => ({
              ...options,
              transformClient: moving(gone, standby),
            })),
          )
          .execute(undefined);
        expect(answer._tag).toBe("Events");
        expect(attempts(yield* standby.ledger)).toEqual(["2"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-21d] a function with an optional second parameter of its own receives the number there",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const quote = Ops.quote(connect(backend), Policy.none);
        const passed = quote.pipe(
          Operation.mapOptions((options) => ({
            ...options,
            transformClient: labelled,
          })),
        );
        const wrapped = quote.pipe(
          Operation.mapOptions((options) => ({
            ...options,
            transformClient: (client: HttpClient.HttpClient) =>
              labelled(client),
          })),
        );
        yield* Effect.flip(passed.execute(pair));
        yield* Effect.flip(wrapped.execute(pair));
        expect(attempts(yield* backend.ledger)).toEqual(["1", "unlabelled"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});
