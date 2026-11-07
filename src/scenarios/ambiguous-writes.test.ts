/**
 * EXT-24: a write that loses its answer, the case the library cannot resolve. A transport error says
 * nothing about whether the server acted, so these pin what really happened on the server: the
 * ledger says what arrived and `GET /v1/bookings` says what was committed, on both regions. Chromium
 * sends a request again by itself when a reused connection ends with no response, so several results
 * differ by lane; the socket listener, which reuses no connection, is the control for that.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Operation, Policy, Request, Response } from "viell-effect-schema-http";
import * as Bookings from "../clients/bookings/index.js";
import {
  type Backend,
  bodyText,
  header,
  type Json,
  type Recorded,
  type StartOptions,
} from "../harness/lane.js";

const inBrowser = lane.name === "browser";
const retrying = Policy.make(Schedule.recurs(1));

/** Long enough for a whole answer on a slow runner, because a retry has to finish inside it. */
const answerLimit = "2 seconds";

/** Long enough for a request to arrive on a slow runner, which is all a hung attempt needs. */
const arrivalLimit = "1 second";

const draft: Bookings.BookingDraft = {
  vessel: "MV Aurora",
  terminal: "rotterdam",
  slot: "2026-11-07T06:00",
};

const bookingRule = (
  fault: string,
  extra: { readonly [key: string]: Json } = {},
) => ({ route: "POST /v1/bookings", fault, ...extra });

const eu = (edge: ReadonlyArray<Json>, start?: StartOptions) =>
  lane.backend("bookings", { region: "eu", edge: [...edge] }, start);

const us = (options: { readonly [key: string]: Json } = {}) =>
  lane.backend("bookings", { region: "us", ...options });

/** What a region says it committed, read through Fetch whatever the test's own provider is. */
const committed = (backend: Backend) =>
  Bookings.bookings({ baseUrl: backend.origin })
    .execute(undefined)
    .pipe(
      Effect.map(({ bookings }) => bookings),
      Effect.provide(lane.fetchClient),
    );

const posts = (ledger: ReadonlyArray<Recorded>) =>
  Bookings.arrivals(ledger, "POST", "/v1/bookings");

const stamps = (ledger: ReadonlyArray<Recorded>) =>
  posts(ledger).map(({ lines }) => header(lines, "x-attempt"));

const ids = (bookings: ReadonlyArray<Bookings.Booking>) =>
  bookings.map(({ id }) => id);

const stamped = (client: HttpClient.HttpClient, attempt: number) =>
  HttpClient.mapRequest(
    client,
    HttpClientRequest.setHeader("X-Attempt", String(attempt)),
  );

/** Stamp each attempt and send it to the region its number picks, the last for any after it. */
const moving =
  (regions: ReadonlyArray<Backend>) =>
  (client: HttpClient.HttpClient, attempt: number) =>
    stamped(
      HttpClient.mapRequest(client, (request) =>
        HttpClientRequest.setUrl(
          request,
          `${regions[Math.min(attempt, regions.length) - 1]?.origin}${request.url}`,
        ),
      ),
      attempt,
    );

/** The same arrivals' keys, for a request that says it repeats one. */
const keysOf = (ledger: ReadonlyArray<Recorded>) =>
  posts(ledger).map(({ lines }) => header(lines, "idempotency-key"));

const key = "repeat-key-1";

/** A repeat key computed as a request field, so once per evaluation. */
const computedKey = () => {
  let computed = 0;
  return {
    computed: () => computed,
    book: (config: Bookings.Config) =>
      Bookings.book(config).pipe(
        Operation.mapRequest(
          Request.setHeader("Idempotency-Key", () => {
            computed += 1;
            return `computed-${computed}`;
          }),
        ),
      ),
  };
};

/** A key written by client middleware, so each attempt has its own. */
const keyPerAttempt: Bookings.Middleware = (http, attempt) =>
  HttpClient.mapRequest(
    http,
    HttpClientRequest.setHeader("Idempotency-Key", `attempt-${attempt}`),
  );

describe(`ambiguous completion of writes (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    const inFetch = provider !== "lines";

    if (inBrowser)
      it.live(
        `[EXT-24a] ${provider}: Chromium sends a lost POST twice on two connections, so one attempt makes two bookings and one TransportError`,
        () =>
          Effect.gen(function* () {
            const backend = yield* eu([bookingRule("closed")]);
            const error = yield* Effect.flip(
              Bookings.book({
                baseUrl: backend.origin,
                transformClient: stamped,
              }).execute({ draft }),
            );
            expect(Bookings.described(error)).toEqual({
              kind: "TransportError",
            });
            const ledger = yield* backend.ledger;
            expect(stamps(ledger)).toEqual(["1", "1"]);
            expect(posts(ledger)[1]?.connection).not.toBe(
              posts(ledger)[0]?.connection,
            );
            expect(bodyText(posts(ledger)[1]!)).toBe(
              bodyText(posts(ledger)[0]!),
            );
            expect(ids(yield* committed(backend))).toEqual([
              "eu-000001",
              "eu-000002",
            ]);
            yield* Bookings.closed(backend, 1);
          }).pipe(Effect.provide(client)),
      );
    else
      it.live(
        `[EXT-24a] ${provider}: the write happened and the caller was told it failed: one arrival, one booking and a TransportError`,
        () =>
          Effect.gen(function* () {
            const backend = yield* eu([bookingRule("closed")]);
            const error = yield* Effect.flip(
              Bookings.book({ baseUrl: backend.origin }).execute({ draft }),
            );
            expect(Bookings.described(error)).toEqual({
              kind: "TransportError",
            });
            yield* Bookings.closed(backend, 0);
            expect(posts(yield* backend.ledger)).toHaveLength(1);
            expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
          }).pipe(Effect.provide(client)),
      );

    if (!inBrowser)
      it.live(
        `[EXT-24a] ${provider}: on a connection already used it stays one arrival, because Node's clients do not send a request again`,
        () =>
          Effect.gen(function* () {
            const backend = yield* eu([bookingRule("closed")]);
            yield* Bookings.health({ baseUrl: backend.origin }).execute(
              undefined,
            );
            // Node's `fetch` frees a connection just after a body ends, and a request sent in that
            // moment opens another. The test asserts below that this one really was reused.
            yield* Effect.sleep("50 millis");
            const error = yield* Effect.flip(
              Bookings.book({ baseUrl: backend.origin }).execute({ draft }),
            );
            expect(Bookings.described(error)).toEqual({
              kind: "TransportError",
            });
            const ledger = yield* Bookings.closed(backend, 1);
            expect(posts(ledger)).toHaveLength(1);
            expect(ledger[1]?.connection).toBe(ledger[0]?.connection);
            expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
          }).pipe(Effect.provide(client)),
      );

    it.live(
      `[EXT-24a] ${provider}: behind the socket listener no connection is reused, so one arrival and one booking`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([bookingRule("closed")], {
            listener: "socket",
          });
          const error = yield* Effect.flip(
            Bookings.book({ baseUrl: backend.origin }).execute({ draft }),
          );
          expect(Bookings.described(error)).toEqual({ kind: "TransportError" });
          expect(posts(yield* backend.ledger)).toHaveLength(1);
          expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24c] ${provider}: with the fault before the region the caller sees the same failure, and nothing is committed`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([
            bookingRule("closed", { phase: "before" }),
          ]);
          const error = yield* Effect.flip(
            Bookings.book({ baseUrl: backend.origin }).execute({ draft }),
          );
          expect(Bookings.described(error)).toEqual({ kind: "TransportError" });
          yield* Bookings.closed(backend, 0);
          expect(posts(yield* backend.ledger)).toHaveLength(inBrowser ? 2 : 1);
          expect(yield* committed(backend)).toEqual([]);
        }).pipe(Effect.provide(client)),
    );

    if (inBrowser)
      it.live(
        `[EXT-24d] ${provider}: Chromium's own second sending gets the 201, so the policy never retries and two bookings exist`,
        () =>
          Effect.gen(function* () {
            const backend = yield* eu([bookingRule("closed", { times: 1 })]);
            const answer = yield* Bookings.book({
              baseUrl: backend.origin,
              policy: retrying,
              transformClient: stamped,
            }).execute({ draft });
            expect(answer._tag).toBe("Committed");
            expect(answer.value.id).toBe("eu-000002");
            expect(stamps(yield* backend.ledger)).toEqual(["1", "1"]);
            expect(ids(yield* committed(backend))).toEqual([
              "eu-000001",
              "eu-000002",
            ]);
          }).pipe(Effect.provide(client)),
      );
    it.live(
      `[EXT-24d] ${provider}: a retry with no key makes two bookings with two ids and the same fields, and the caller sees the second as a success`,
      () =>
        Effect.gen(function* () {
          // The socket listener keeps Chromium out of this: the second arrival is the policy's.
          const backend = yield* eu([bookingRule("closed", { times: 1 })], {
            listener: "socket",
          });
          const answer = yield* Bookings.book({
            baseUrl: backend.origin,
            policy: retrying,
            transformClient: stamped,
          }).execute({ draft });
          expect(answer._tag).toBe("Committed");
          expect(answer.value.id).toBe("eu-000002");
          const ledger = yield* Bookings.closed(backend, 0);
          expect(stamps(ledger)).toEqual(["1", "2"]);
          expect(bodyText(posts(ledger)[1]!)).toBe(bodyText(posts(ledger)[0]!));
          const bookings = yield* committed(backend);
          expect(ids(bookings)).toEqual(["eu-000001", "eu-000002"]);
          expect(bookings.map(({ vessel, slot }) => [vessel, slot])).toEqual([
            [draft.vessel, draft.slot],
            [draft.vessel, draft.slot],
          ]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24e] ${provider}: a retry that moves region with no key leaves a booking at each, so the first server did not do nothing`,
      () =>
        Effect.gen(function* () {
          const first = yield* eu([bookingRule("closed")], {
            listener: "socket",
          });
          const second = yield* us();
          const answer = yield* Bookings.book({
            policy: retrying,
            transformClient: moving([first, second]),
          }).execute({ draft });
          expect(answer.value.id).toBe("us-000001");
          expect(stamps(yield* first.ledger)).toEqual(["1"]);
          expect(stamps(yield* second.ledger)).toEqual(["2"]);
          expect(ids(yield* committed(first))).toEqual(["eu-000001"]);
          expect(ids(yield* committed(second))).toEqual(["us-000001"]);
        }).pipe(Effect.provide(client)),
    );

    if (inBrowser)
      it.live(
        `[EXT-24e] ${provider}: on a reused connection Chromium commits twice at the first region before the attempt fails and moves`,
        () =>
          Effect.gen(function* () {
            const first = yield* eu([bookingRule("closed")]);
            const second = yield* us();
            const answer = yield* Bookings.book({
              policy: retrying,
              transformClient: moving([first, second]),
            }).execute({ draft });
            expect(answer.value.id).toBe("us-000001");
            expect(stamps(yield* first.ledger)).toEqual(["1", "1"]);
            expect(stamps(yield* second.ledger)).toEqual(["2"]);
            expect(ids(yield* committed(first))).toEqual([
              "eu-000001",
              "eu-000002",
            ]);
            expect(ids(yield* committed(second))).toEqual(["us-000001"]);
          }).pipe(Effect.provide(client)),
      );

    it.live(
      `[EXT-24f] ${provider}: a key computed as a request field is computed once, so a retry replays: two arrivals, one key and one booking`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([bookingRule("closed", { times: 1 })]);
          const keying = computedKey();
          const answer = yield* keying
            .book({ baseUrl: backend.origin, policy: retrying })
            .execute({ draft });
          expect(keying.computed()).toBe(1);
          expect(answer._tag).toBe("Replayed");
          if (answer._tag !== "Replayed") return;
          expect(answer.metadata.status).toBe(200);
          expect(answer.metadata.headers["idempotent-replay"]).toBe("true");
          expect(answer.value.replayed).toBe(true);
          expect(answer.value.id).toBe("eu-000001");
          expect(keysOf(yield* backend.ledger)).toEqual([
            "computed-1",
            "computed-1",
          ]);
          expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24f] ${provider}: a key the schema refuses is a SchemaError before dispatch, with nothing sent`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([]);
          const error = yield* Effect.flip(
            Bookings.book({ baseUrl: backend.origin }).execute({
              draft,
              key: "not a key",
            }),
          );
          expect(error._tag).toBe("SchemaError");
          expect(yield* backend.ledger).toEqual([]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24g] ${provider}: a key written per attempt changes between attempts, so the retry makes a second booking`,
      () =>
        Effect.gen(function* () {
          // Chromium's own second sending repeats an attempt's key, so the listener keeps it out.
          const backend = yield* eu([bookingRule("closed", { times: 1 })], {
            listener: "socket",
          });
          const answer = yield* Bookings.book({
            baseUrl: backend.origin,
            policy: retrying,
            transformClient: keyPerAttempt,
          }).execute({ draft });
          expect(answer._tag).toBe("Committed");
          expect(answer.value.key).toBe("attempt-2");
          expect(keysOf(yield* backend.ledger)).toEqual([
            "attempt-1",
            "attempt-2",
          ]);
          expect(ids(yield* committed(backend))).toEqual([
            "eu-000001",
            "eu-000002",
          ]);
        }).pipe(Effect.provide(client)),
    );

    if (inBrowser)
      it.live(
        `[EXT-24g] ${provider}: on a reused connection Chromium's own second sending repeats the attempt's key, so that sending replays`,
        () =>
          Effect.gen(function* () {
            const backend = yield* eu([bookingRule("closed", { times: 1 })]);
            const answer = yield* Bookings.book({
              baseUrl: backend.origin,
              policy: retrying,
              transformClient: keyPerAttempt,
            }).execute({ draft });
            expect(answer._tag).toBe("Replayed");
            expect(keysOf(yield* backend.ledger)).toEqual([
              "attempt-1",
              "attempt-1",
            ]);
            expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
          }).pipe(Effect.provide(client)),
      );

    it.live(
      `[EXT-24h] ${provider}: with a working link a retry that moves region gets back the booking committed at the first`,
      () =>
        Effect.gen(function* () {
          const first = yield* eu([bookingRule("closed")]);
          const second = yield* us({ peer: first.origin });
          const answer = yield* Bookings.book({
            policy: retrying,
            transformClient: moving([first, second]),
          }).execute({ draft, key });
          expect(answer._tag).toBe("Replayed");
          expect(answer.value).toMatchObject({
            id: "eu-000001",
            region: "eu",
            key,
            replayed: true,
          });
          const [atFirst, atSecond] = [
            yield* first.ledger,
            yield* second.ledger,
          ];
          expect(
            Bookings.arrivals(atFirst, "GET", `/v1/keys/${key}`),
          ).toHaveLength(1);
          // Chromium's own second sending is a replay at the first region.
          expect(posts(atFirst)).toHaveLength(inBrowser ? 2 : 1);
          expect(posts(atSecond)).toHaveLength(1);
          expect(yield* committed(second)).toEqual([]);
          expect(ids(yield* committed(first))).toEqual(["eu-000001"]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24i] ${provider}: with the link down the key protects nothing, and each region has a booking under it`,
      () =>
        Effect.gen(function* () {
          const gone = yield* Effect.scoped(lane.backend("bookings"));
          const first = yield* eu([bookingRule("closed")]);
          const second = yield* us({ peer: gone.origin });
          const answer = yield* Bookings.book({
            policy: retrying,
            transformClient: moving([first, second]),
          }).execute({ draft, key });
          expect(answer._tag).toBe("Committed");
          expect(answer.value).toMatchObject({ id: "us-000001", key });
          expect(posts(yield* first.ledger)).toHaveLength(inBrowser ? 2 : 1);
          expect(posts(yield* second.ledger)).toHaveLength(1);
          const [atFirst, atSecond] = [
            yield* committed(first),
            yield* committed(second),
          ];
          expect(ids(atFirst)).toEqual(["eu-000001"]);
          expect(ids(atSecond)).toEqual(["us-000001"]);
          expect(atFirst[0]?.key).toBe(key);
          expect(atSecond[0]?.key).toBe(key);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24j] ${provider}: a committed write whose body is cut ${inFetch ? "is a DecodeError with status 201, not retried, so one booking" : "is a TransportError, retried, so two bookings"}`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([bookingRule("cut-body", { times: 1 })]);
          const book = Bookings.book({
            baseUrl: backend.origin,
            policy: retrying,
          });
          if (inFetch) {
            const error = yield* Effect.flip(book.execute({ draft }));
            expect(Bookings.described(error)).toEqual({
              kind: "DecodeError",
              status: 201,
              inner: "DecodeError",
            });
            expect(posts(yield* backend.ledger)).toHaveLength(1);
            expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
          } else {
            const answer = yield* book.execute({ draft });
            expect(answer.value.id).toBe("eu-000002");
            expect(posts(yield* backend.ledger)).toHaveLength(2);
            expect(ids(yield* committed(backend))).toEqual([
              "eu-000001",
              "eu-000002",
            ]);
          }
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24k] ${provider}: an attempt timeout on a committed write makes a second booking, though the caller sees one success`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([bookingRule("hang", { times: 1 })]);
          const answer = yield* Bookings.book({
            baseUrl: backend.origin,
            policy: Policy.make(Schedule.recurs(1), {
              attemptTimeout: answerLimit,
            }),
          }).execute({ draft });
          expect(answer.value.id).toBe("eu-000002");
          const ledger = yield* Bookings.aborted(backend, 0);
          expect(posts(ledger)).toHaveLength(2);
          expect(ids(yield* committed(backend))).toEqual([
            "eu-000001",
            "eu-000002",
          ]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24k] ${provider}: a caller's timeout around one attempt leaves one booking and a TimeoutError`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([bookingRule("hang", { times: 1 })]);
          const error = yield* Effect.flip(
            Bookings.book({ baseUrl: backend.origin })
              .execute({ draft })
              .pipe(Effect.timeout(arrivalLimit)),
          );
          expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
          yield* Bookings.aborted(backend, 0);
          expect(posts(yield* backend.ledger)).toHaveLength(1);
          expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24l] ${provider}: reading the key answers the booking a lost answer left behind`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([bookingRule("closed")]);
          const failed = yield* Effect.flip(
            Bookings.book({ baseUrl: backend.origin }).execute({ draft, key }),
          );
          expect(Bookings.described(failed)).toEqual({
            kind: "TransportError",
          });
          yield* Bookings.closed(backend, 0);
          const found = yield* Bookings.keyed({
            baseUrl: backend.origin,
          }).execute(key);
          expect(found._tag).toBe("Found");
          if (found._tag !== "Found") return;
          expect(found.value).toMatchObject({
            id: "eu-000001",
            key,
            replayed: false,
          });
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24l] ${provider}: the same read after a fault before the region is a 404, so it was not committed`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([
            bookingRule("closed", { phase: "before" }),
          ]);
          const failed = yield* Effect.flip(
            Bookings.book({ baseUrl: backend.origin }).execute({ draft, key }),
          );
          expect(Bookings.described(failed)).toEqual({
            kind: "TransportError",
          });
          const found = yield* Bookings.keyed({
            baseUrl: backend.origin,
          }).execute(key);
          expect(found._tag).toBe("Missing");
          if (found._tag !== "Missing") return;
          expect(found.value).toEqual({ error: "unknown_key" });
          expect(found.metadata.status).toBe(404);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-24m] ${provider}: a key reused with another body is a 409, commits nothing and is not retried`,
      () =>
        Effect.gen(function* () {
          const backend = yield* eu([]);
          const book = Bookings.bookOrRefuse({
            baseUrl: backend.origin,
            policy: retrying,
          });
          yield* book.execute({ draft, key });
          const answer = yield* book.execute({
            draft: { ...draft, slot: "2026-11-07T07:00" },
            key,
          });
          expect(answer._tag).toBe("KeyReused");
          if (answer._tag !== "KeyReused") return;
          expect(answer.value).toEqual({ error: "key_reused" });
          expect(answer.metadata.status).toBe(409);
          expect(posts(yield* backend.ledger)).toHaveLength(2);
          expect(ids(yield* committed(backend))).toEqual(["eu-000001"]);
        }).pipe(Effect.provide(client)),
    );
  }

  it.live(
    "[EXT-24f] a contract of 201 alone reads a replay as unexpected, so a caller has to declare both",
    () =>
      Effect.gen(function* () {
        const backend = yield* eu([]);
        const book = Bookings.book({ baseUrl: backend.origin });
        yield* book.execute({ draft, key });
        const error = yield* Effect.flip(
          book
            .pipe(Operation.mapResponse(Response.remove(200)))
            .execute({ draft, key }),
        );
        expect(Bookings.described(error)).toEqual({
          kind: "UnexpectedResponse",
          status: 200,
        });
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});
