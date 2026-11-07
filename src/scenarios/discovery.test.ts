/**
 * EXT-28, from #97: a client that finds its API when it starts. One build can be served from any
 * domain, so it tries its own candidates in order and goes on with the first that decodes. Each
 * case here starts one region per candidate, and the last is healthy. A row a browser refuses
 * because of CORS starts with the region's own filter, and the rest run under harness CORS.
 */
import { describe, expect, it } from "@effect/vitest";
import { Context, Data, Effect, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
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
  header,
  type Json,
  type Recorded,
} from "../harness/lane.js";

const inBrowser = lane.name === "browser";
const retrying = Policy.make(Schedule.recurs(1));

/** Long enough for a whole answer on a slow runner, because a healthy region has to fit inside it. */
const limit = "2 seconds";

const draft: Bookings.BookingDraft = {
  vessel: "MV Aurora",
  terminal: "rotterdam",
  slot: "2026-11-07T06:00",
};

/** A region, with a name so that a test can tell which one answered. */
const region = (name: string, options: { readonly [key: string]: Json } = {}) =>
  lane.backend("bookings", { region: name, ...options });

/** A region answering CORS itself, in a browser, with the list a page needs for its trace lines. */
const filtered = (
  name: string,
  options: { readonly [key: string]: Json } = {},
  allowHeaders: ReadonlyArray<string> = ["b3", "traceparent"],
) =>
  lane.backend(
    "bookings",
    {
      region: name,
      cors: { allowHeaders: [...allowHeaders] },
      ...options,
    },
    { cors: "backend" },
  );

/** A region with no filter behind `{ cors: "backend" }`: nothing answers CORS at all. */
const unfiltered = (name: string) =>
  lane.backend("bookings", { region: name }, { cors: "backend" });

/** An origin nothing listens on: a region started in a scope of its own that has ended. */
const closedPort = Effect.gen(function* () {
  const gone = yield* Effect.scoped(lane.backend("bookings"));
  return gone.origin;
});

const onEveryRoute = (fault: string) => ({
  edge: [{ route: "*", fault }],
});

const search = (...candidates: ReadonlyArray<string>) =>
  Bookings.discover({ candidates, attemptTimeout: limit });

const origins = (...backends: ReadonlyArray<Backend>) =>
  backends.map(({ origin }) => origin);

const passedAs = (found: Bookings.Discovered) =>
  found.passed.map(({ error }) => Bookings.described(error));

const healthArrivals = (ledger: ReadonlyArray<Recorded>) =>
  Bookings.arrivals(ledger, "GET", "/v1/health");

const tracing = (enabled: boolean) =>
  Effect.provideService(HttpClient.TracerPropagationEnabled, enabled);

const stamped = (client: HttpClient.HttpClient, attempt: number) =>
  HttpClient.mapRequest(
    client,
    HttpClientRequest.setHeader("X-Attempt", String(attempt)),
  );

/**
 * The client route: each attempt goes to the candidate its number picks, the last for any after it.
 * A definition's base URL cannot do this, because it runs once per evaluation.
 */
const byAttempt =
  (candidates: ReadonlyArray<string>): Bookings.Middleware =>
  (client, attempt) =>
    stamped(
      Bookings.inRegion(candidates[Math.min(attempt, candidates.length) - 1]!)(
        client,
      ),
      attempt,
    );

const committed = (backend: Backend) =>
  Bookings.bookings({ baseUrl: backend.origin })
    .execute(undefined)
    .pipe(Effect.map(({ bookings }) => bookings.map(({ id }) => id)));

const stamps = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map(({ lines }) => header(lines, "x-attempt"));

const posts = (ledger: ReadonlyArray<Recorded>) =>
  Bookings.arrivals(ledger, "POST", "/v1/bookings");

class ChosenRegion extends Context.Service<ChosenRegion, string>()(
  "suite/ChosenRegion",
) {}

class Undiscovered extends Data.TaggedError("Undiscovered")<{
  readonly reason: string;
}> {}

describe(`a client that finds its API at runtime (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    it.live(
      `[EXT-28a] ${provider}: a closed port and a reset are each a TransportError, and the last candidate is chosen`,
      () =>
        Effect.gen(function* () {
          const closed = yield* closedPort;
          const resets = yield* region("reset", onEveryRoute("reset"));
          const healthy = yield* region("us");
          expect(healthy.origin).not.toBe(closed);
          const found = yield* search(closed, resets.origin, healthy.origin);
          expect(found.region).toBe("us");
          expect(found.base).toBe(healthy.origin);
          expect(passedAs(found)).toEqual([
            { kind: "TransportError" },
            { kind: "TransportError" },
          ]);
          // Chromium sends the GET again on a new connection, as EXT-23f pins.
          const ledger = yield* Bookings.closed(resets, inBrowser ? 1 : 0);
          expect(healthArrivals(ledger)).toHaveLength(inBrowser ? 2 : 1);
          expect(healthArrivals(yield* healthy.ledger)).toHaveLength(1);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28a] ${provider}: when no candidate counts the search fails as NoRegion, saying what each did`,
      () =>
        Effect.gen(function* () {
          const closed = yield* closedPort;
          const parked = yield* region("parked", onEveryRoute("parked"));
          const error = yield* Effect.flip(search(closed, parked.origin));
          expect(error).toBeInstanceOf(Bookings.NoRegion);
          expect(
            error.passed.map(({ candidate, error: failure }) => [
              candidate,
              Bookings.described(failure).kind,
            ]),
          ).toEqual([
            [closed, "TransportError"],
            [parked.origin, "DecodeError"],
          ]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28b] ${provider}: a candidate that hangs is a TimeoutError under its limit, and the search moves on`,
      () =>
        Effect.gen(function* () {
          const hangs = yield* region("hang", onEveryRoute("hang"));
          const healthy = yield* region("us");
          const found = yield* search(hangs.origin, healthy.origin);
          expect(found.region).toBe("us");
          expect(passedAs(found)).toEqual([{ kind: "TimeoutError" }]);
          const ledger = yield* Bookings.aborted(hangs, 0);
          expect(healthArrivals(ledger)).toHaveLength(1);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28c] ${provider}: an edge's 502 is ${inBrowser ? "a TransportError, because its page has no CORS lines" : "an UnexpectedResponse with its status"}, and the search moves on`,
      () =>
        Effect.gen(function* () {
          const failing = yield* filtered("bad", onEveryRoute("bad-gateway"));
          const healthy = yield* region("us");
          const found = yield* search(failing.origin, healthy.origin);
          expect(found.region).toBe("us");
          expect(passedAs(found)).toEqual([
            inBrowser
              ? { kind: "TransportError" }
              : { kind: "UnexpectedResponse", status: 502 },
          ]);
          expect(healthArrivals(yield* failing.ledger)).toHaveLength(1);
        }).pipe(Effect.provide(client)),
    );

    for (const [fault, inner] of [
      ["parked", "DecodeError"],
      ["other-service", "SchemaError"],
    ] as const)
      it.live(
        `[EXT-28d] ${provider}: ${fault} answers 200 with something else, ${inBrowser ? "a TransportError for want of CORS lines" : "a DecodeError"}, and the search moves on`,
        () =>
          Effect.gen(function* () {
            const lapsed = yield* filtered(fault, onEveryRoute(fault));
            const healthy = yield* region("us");
            const found = yield* search(lapsed.origin, healthy.origin);
            expect(found.region).toBe("us");
            expect(passedAs(found)).toEqual([
              inBrowser
                ? { kind: "TransportError" }
                : { kind: "DecodeError", status: 200, inner },
            ]);
            expect(healthArrivals(yield* lapsed.ledger)).toHaveLength(1);
          }).pipe(Effect.provide(client)),
      );

    it.live(
      `[EXT-28d] ${provider}: under harness CORS a page reads both, so each is a DecodeError in either lane`,
      () =>
        Effect.gen(function* () {
          const parked = yield* region("parked", onEveryRoute("parked"));
          const other = yield* region("other", onEveryRoute("other-service"));
          const healthy = yield* region("us");
          const found = yield* search(
            parked.origin,
            other.origin,
            healthy.origin,
          );
          expect(passedAs(found)).toEqual([
            { kind: "DecodeError", status: 200, inner: "DecodeError" },
            { kind: "DecodeError", status: 200, inner: "SchemaError" },
          ]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28e] ${provider}: a correct answer without CORS lines ${inBrowser ? "is refused at its preflight, so the search moves on" : "is accepted"}`,
      () =>
        Effect.gen(function* () {
          const bare = yield* unfiltered("eu");
          const healthy = yield* region("us");
          const found = yield* search(bare.origin, healthy.origin);
          const ledger = yield* bare.ledger;
          if (inBrowser) {
            expect(found.region).toBe("us");
            expect(passedAs(found)).toEqual([{ kind: "TransportError" }]);
            expect(ledger.map(({ method }) => method)).toEqual(["OPTIONS"]);
          } else {
            expect(found.region).toBe("eu");
            expect(ledger.map(({ method }) => method)).toEqual(["GET"]);
          }
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28e] ${provider}: with trace propagation off the GET needs no preflight and ${inBrowser ? "arrives and is answered, and the browser withholds a good answer" : "is accepted"}`,
      () =>
        Effect.gen(function* () {
          const bare = yield* unfiltered("eu");
          const healthy = yield* region("us");
          const found = yield* search(bare.origin, healthy.origin).pipe(
            tracing(false),
          );
          expect(found.region).toBe(inBrowser ? "us" : "eu");
          if (inBrowser)
            expect(passedAs(found)).toEqual([{ kind: "TransportError" }]);
          expect((yield* bare.ledger).map(({ method }) => method)).toEqual([
            "GET",
          ]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28f] ${provider}: a region that does not allow the trace lines ${inBrowser ? "looks dead to a page" : "is accepted"}`,
      () =>
        Effect.gen(function* () {
          const narrow = yield* filtered("eu", {}, ["content-type"]);
          const healthy = yield* region("us");
          const found = yield* search(narrow.origin, healthy.origin);
          expect(found.region).toBe(inBrowser ? "us" : "eu");
          expect(healthArrivals(yield* narrow.ledger)).toHaveLength(
            inBrowser ? 0 : 1,
          );
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28f] ${provider}: with trace propagation off the same region is chosen`,
      () =>
        Effect.gen(function* () {
          const narrow = yield* filtered("eu", {}, ["content-type"]);
          const healthy = yield* region("us");
          const found = yield* search(narrow.origin, healthy.origin).pipe(
            tracing(false),
          );
          expect(found.region).toBe("eu");
          expect(found.passed).toEqual([]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28g] ${provider}: parallel calls before a base is known make one discovery`,
      () =>
        Effect.gen(function* () {
          const gone = yield* region("gone", onEveryRoute("bad-gateway"));
          const healthy = yield* region("us");
          const found = yield* Effect.cached(
            search(gone.origin, healthy.origin),
          );
          const calls = yield* Effect.all(
            [0, 1, 2, 3].map(() =>
              Effect.flatMap(found, ({ base }) =>
                Bookings.manifest({ baseUrl: base }).execute(undefined),
              ),
            ),
            { concurrency: "unbounded" },
          );
          expect(calls).toEqual(Array(4).fill(Bookings.manifestText));
          expect(healthArrivals(yield* gone.ledger)).toHaveLength(1);
          expect(healthArrivals(yield* healthy.ledger)).toHaveLength(1);
          expect(
            Bookings.arrivals(yield* healthy.ledger, "GET", "/v1/manifest"),
          ).toHaveLength(4);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28h] ${provider}: when the chosen region resets, a read and a booking move on by their attempt number, and the write stands at both regions`,
      () =>
        Effect.gen(function* () {
          const first = yield* region("eu", {
            edge: [
              { route: "GET /v1/manifest", fault: "reset", after: 1 },
              { route: "POST /v1/bookings", fault: "reset" },
            ],
          });
          const second = yield* region("us");
          const candidates = origins(first, second);
          const found = yield* search(...candidates);
          expect(found.region).toBe("eu");
          const session = {
            policy: retrying,
            transformClient: byAttempt(candidates),
          };
          const read = Bookings.manifest(session);
          expect(yield* read.execute(undefined)).toBe(Bookings.manifestText);
          expect(yield* read.execute(undefined)).toBe(Bookings.manifestText);
          const answer = yield* Bookings.book(session).execute({ draft });
          expect(answer.value.id).toBe("us-000001");

          const [atFirst, atSecond] = [
            yield* Bookings.closed(first, 2),
            yield* second.ledger,
          ];
          // Chromium's own second sending commits again, as EXT-24a pins.
          expect(stamps(posts(atFirst))).toEqual(
            inBrowser ? ["1", "1"] : ["1"],
          );
          expect(stamps(posts(atSecond))).toEqual(["2"]);
          expect(
            stamps(Bookings.arrivals(atSecond, "GET", "/v1/manifest")),
          ).toEqual(["2"]);
          expect(yield* committed(first)).toEqual(
            inBrowser ? ["eu-000001", "eu-000002"] : ["eu-000001"],
          );
          expect(yield* committed(second)).toEqual(["us-000001"]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28i] ${provider}: when the chosen region hangs, each hung arrival ends aborted and closed, and the attempt moves on`,
      () =>
        Effect.gen(function* () {
          const first = yield* region("eu", {
            edge: [
              { route: "GET /v1/manifest", fault: "hang" },
              { route: "POST /v1/bookings", fault: "hang" },
            ],
          });
          const second = yield* region("us");
          const candidates = origins(first, second);
          const session = {
            policy: Policy.make(Schedule.recurs(1), { attemptTimeout: limit }),
            transformClient: byAttempt(candidates),
          };
          expect(yield* Bookings.manifest(session).execute(undefined)).toBe(
            Bookings.manifestText,
          );
          yield* Bookings.aborted(first, 0);
          const answer = yield* Bookings.book(session).execute({ draft });
          expect(answer.value.id).toBe("us-000001");
          const ledger = yield* Bookings.aborted(first, 1);
          expect(stamps(ledger)).toEqual(["1", "1"]);
          expect(yield* committed(first)).toEqual(["eu-000001"]);
          expect(yield* committed(second)).toEqual(["us-000001"]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28j] ${provider}: a fixed base under prependUrl goes to a wrong URL with no error from the library`,
      () =>
        Effect.gen(function* () {
          const wanted = yield* region("eu");
          const chosen = yield* region("us");
          const error = yield* Effect.flip(
            Bookings.health({
              baseUrl: wanted.origin,
              transformClient: Bookings.inRegion(chosen.origin),
            }).execute(undefined),
          );
          expect(Bookings.described(error)).toEqual({
            kind: "UnexpectedResponse",
            status: 404,
          });
          expect(yield* wanted.ledger).toEqual([]);
          expect((yield* chosen.ledger).map(({ target }) => target)).toEqual([
            `/${wanted.origin}/v1/health`,
          ]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28k] ${provider}: no base at all ${inBrowser ? "resolves against the page, so the call reaches the page's own server" : "is an InvalidUrlError"}, and no region hears of it`,
      () =>
        Effect.gen(function* () {
          const backend = yield* region("eu");
          const error = yield* Effect.flip(
            Bookings.health().execute(undefined),
          );
          expect(Bookings.described(error)).toEqual(
            inBrowser
              ? { kind: "UnexpectedResponse", status: 404 }
              : { kind: "InvalidUrlError" },
          );
          expect(yield* backend.ledger).toEqual([]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28l] ${provider}: a base from a service runs once, so every retry uses it and a call cannot move between attempts`,
      () =>
        Effect.gen(function* () {
          const first = yield* region("eu", {
            edge: [{ route: "GET /v1/health", fault: "bad-gateway", times: 2 }],
          });
          const second = yield* region("us");
          let lookups = 0;
          const chosen = Effect.gen(function* () {
            lookups += 1;
            return yield* ChosenRegion;
          });
          const healthAt = Operation.make(
            Request.get("/v1/health").pipe(Request.baseUrl(chosen)),
            Response.status(200, Body.jsonSchema(Bookings.Health)),
            { policy: Policy.make(Schedule.recurs(1), { retryAfter: false }) },
          );
          const error = yield* Effect.flip(
            healthAt
              .execute(undefined)
              .pipe(Effect.provideService(ChosenRegion, first.origin)),
          );
          expect(Bookings.described(error)).toEqual({
            kind: "UnexpectedResponse",
            status: 502,
          });
          expect(lookups).toBe(1);
          expect(yield* first.ledger).toHaveLength(2);
          expect(yield* second.ledger).toEqual([]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28l] ${provider}: a lookup that fails comes back as itself, with nothing sent`,
      () =>
        Effect.gen(function* () {
          const backend = yield* region("eu");
          const error = yield* Effect.flip(
            Operation.make(
              Request.get(`${backend.origin}/v1/health`).pipe(
                Request.baseUrl(
                  Effect.fail(new Undiscovered({ reason: "no candidate" })),
                ),
              ),
              Response.status(200, Body.jsonSchema(Bookings.Health)),
              { policy: retrying },
            ).execute(undefined),
          );
          expect(error).toBeInstanceOf(Undiscovered);
          expect(yield* backend.ledger).toEqual([]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28m] ${provider}: a write moves between attempts by its number alone, with no state in a classifier`,
      () =>
        Effect.gen(function* () {
          const lost = {
            edge: [{ route: "POST /v1/bookings", fault: "closed" }],
          };
          const first = yield* region("eu", lost);
          const second = yield* region("us");
          const answer = yield* Bookings.book({
            policy: retrying,
            transformClient: byAttempt(origins(first, second)),
          }).execute({ draft });
          expect(answer.value.id).toBe("us-000001");
          expect(stamps(posts(yield* first.ledger))).toEqual(
            inBrowser ? ["1", "1"] : ["1"],
          );
          expect(stamps(posts(yield* second.ledger))).toEqual(["2"]);
          expect(yield* committed(second)).toEqual(["us-000001"]);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-28m] ${provider}: a retry after two failures reaches a third candidate`,
      () =>
        Effect.gen(function* () {
          const lost = {
            edge: [{ route: "POST /v1/bookings", fault: "closed" }],
          };
          const first = yield* region("eu", lost);
          const second = yield* region("us", lost);
          const third = yield* region("ap");
          const answer = yield* Bookings.book({
            policy: Policy.make(Schedule.recurs(2)),
            transformClient: byAttempt(origins(first, second, third)),
          }).execute({ draft });
          expect(answer.value.id).toBe("ap-000001");
          expect(stamps(posts(yield* third.ledger))).toEqual(["3"]);
          expect(yield* committed(third)).toEqual(["ap-000001"]);
          expect(yield* committed(first)).toHaveLength(inBrowser ? 2 : 1);
          expect(yield* committed(second)).toHaveLength(inBrowser ? 2 : 1);
        }).pipe(Effect.provide(client)),
    );
  }
});
