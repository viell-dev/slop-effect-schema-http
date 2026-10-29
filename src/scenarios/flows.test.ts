import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Cause,
} from "effect";
import { Cookies, FetchHttpClient } from "effect/http";
import { lane } from "#lane";
import {
  Body,
  Interaction,
  Operation,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Ops from "../clients/business/operations.js";
import {
  Credentials,
  Portal,
  Saga,
  Search,
  Services,
  Translate,
} from "../clients/flows/index.js";
import { formGrant } from "../clients/identity/index.js";
import * as Notify from "../clients/notifications/index.js";
import {
  type Backend,
  bodyText,
  header,
  headerValues,
  type Json,
  pathOf,
  queryOf,
  type Recorded,
} from "../harness/lane.js";

// ---------------------------------------------------------------------------------------------
// Fixture values, passed to the backends as options and to the consumer as configuration
// ---------------------------------------------------------------------------------------------

/** The one opaque token. `+`, `/` and `=` tempt every placement to mangle it. */
const TOKEN = "fl0ws+Opaque/7c1e93=";
/** A token no service accepts, as after a revocation. */
const STALE = "revoked+Opaque/0000=";
const SECRET = "notify-signing-month-end";
const CLIENT = { id: "month-end-job", secret: "month-end-secret" } as const;
const PERIOD = "202610";

/** The page's origin: the test page's own in the browser, a synthetic one in Node. */
const pageOrigin =
  lane.name === "browser"
    ? globalThis.location.origin
    : "https://app.example.test";

/** The month-end extract in the gateway's own terms: cents, bare dates and status letters. */
const records = [
  {
    account: "00012345",
    title: "Café Müller",
    cents: 123_450,
    due: "20261115",
    status: "O",
  },
  {
    account: "00012346",
    title: "Bäckerei Groß",
    cents: 9_900,
    due: "00000000",
    status: "O",
  },
  {
    account: "00012347",
    title: "Señor Peña Imports",
    cents: 1_000_000,
    due: "20261130",
    status: "P",
  },
  {
    account: "00012348",
    title: "Øresund Fisk",
    cents: 2_500_000,
    due: "20261120",
    status: "O",
  },
  {
    account: "00012349",
    title: "Ölmühle Ost",
    cents: 50_000,
    due: "20261201",
    status: "X",
  },
] as const;

const extracts = {
  [PERIOD]: {
    runDate: "20261101",
    lastModified: "2026-11-01T02:15:00Z",
    records,
  },
};

/** Tasks already in the business API, for the search box. */
const seededTasks = [
  {
    title: "Reconcile the October ledger",
    assigneeId: "u-ada",
    priority: 2,
    due: null,
    notes: null,
    done: false,
    created: 1_698_796_800_000,
  },
  {
    title: "Archive the ledger exports",
    assigneeId: "u-grace",
    priority: 4,
    due: null,
    notes: "Moved to cold storage",
    done: true,
    created: 1_696_118_400_000,
  },
];

const start = {
  identity: () => lane.backend("identity", { token: TOKEN, clients: [CLIENT] }),
  business: (operations: { readonly [key: string]: Json } = {}) =>
    lane.backend("business", {
      operations: { token: TOKEN, tasks: [], ...operations },
    }),
  gateway: () => lane.backend("gateway", { token: TOKEN, extracts }),
  notifications: (options: { readonly [key: string]: Json } = {}) =>
    lane.backend("notifications", {
      acceptedToken: TOKEN,
      signingSecret: SECRET,
      allowedOrigins: [pageOrigin],
      csrfCookieSameSite: "None",
      ...options,
    }),
  store: (options: { readonly [key: string]: Json } = {}) =>
    lane.backend("soap-store", options),
  portal: (store: Backend) =>
    lane.backend("soap-proxy", { soapOrigin: store.origin }),
};

/**
 * Effect's Fetch provider with `credentials: "include"`, which the browser needs for the
 * notification service's XSRF cookie on another site and Node's fetch ignores.
 */
const viaFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(lane.fetchClient),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  );

/** Narrow a tagged result, failing the test with the actual tag otherwise. */
const narrow = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  if (value._tag !== tag) throw new Error(`expected ${tag}, got ${value._tag}`);
  return value as Extract<A, { readonly _tag: T }>;
};

const authorization = (recorded: Recorded) =>
  headerValues(recorded.lines, "authorization");

/** A source whose reads the test can count, wrapping the application's own. */
const counted = (source: Credentials.Source) => {
  let reads = 0;
  const wrapped: Credentials.Source = {
    read: () => {
      reads++;
      return source.read();
    },
    set: source.set,
  };
  return { source: wrapped, reads: () => reads };
};

/** A notification client over the one source; Node keeps the XSRF cookie in an explicit jar. */
const notifyClient = (backend: Backend, source: Credentials.Source) =>
  Effect.map(Ref.make(Cookies.empty), (jar) =>
    Notify.make({
      baseUrl: backend.origin,
      token: Credentials.notifications(source),
      secret: SECRET,
      csrfCookie: "transport",
      ...(lane.name === "node" ? { jar } : {}),
    }),
  );

/** Every recorded line and target, for searching the wire for a stray spelling. */
const wireText = (ledger: ReadonlyArray<Recorded>) =>
  JSON.stringify(ledger.map((recorded) => [recorded.target, recorded.lines]));

// ---------------------------------------------------------------------------------------------
// AUTH-1: one opaque token, three services
// ---------------------------------------------------------------------------------------------

describe(`flows: one token, three services (AUTH-1, ${lane.name})`, () => {
  for (const [provider, layer] of lane.clients)
    it.live(
      `[AUTH-1] the identity grant's token travels as Bearer, as Token and as the session parameter (${provider})`,
      () =>
        Effect.gen(function* () {
          const identity = yield* start.identity();
          const business = yield* start.business();
          const notifications = yield* start.notifications();
          const gateway = yield* start.gateway();
          const source = yield* Credentials.source();
          // Every operation is built before any token exists.
          const search = Ops.searchTasks(
            Credentials.business(source, `${business.origin}/v2`),
          );
          const notify = yield* notifyClient(notifications, source);
          const download = Services.extract(gateway.origin, source);

          const tokens = narrow(
            yield* formGrant(identity.origin).execute({
              body: {
                grantType: "client_credentials",
                clientId: CLIENT.id,
                clientSecret: Redacted.make(CLIENT.secret),
                scope: ["directory:read"],
              },
            }),
            "Tokens",
          );
          yield* source.set(Redacted.value(tokens.accessToken));

          narrow(yield* search.execute({ query: { q: "ledger" } }), "Results");
          narrow(yield* notify.announcements.execute(undefined), "Listed");
          narrow(yield* download.execute({ period: PERIOD }), "Extract");

          const [grant, ...noMoreGrants] = yield* identity.ledger;
          expect(noMoreGrants).toEqual([]);
          // The issuer authenticates the client by its secret; no token goes to the token endpoint.
          expect(grant!.target).toBe("/oauth/token");
          expect(authorization(grant!)).toEqual([]);
          expect(new URLSearchParams(bodyText(grant!)).get("grant_type")).toBe(
            "client_credentials",
          );

          const [searched] = yield* business.ledger;
          expect(searched!.target).toBe("/v2/search?q=ledger");
          expect(authorization(searched!)).toEqual([`Bearer ${TOKEN}`]);

          const [listed] = yield* notifications.ledger;
          expect(pathOf(listed!)).toBe("/v2/announcements");
          expect(authorization(listed!)).toEqual([`Token token="${TOKEN}"`]);

          const [downloaded] = yield* gateway.ledger;
          // The session is the token, percent-encoded after the request's own query.
          expect(downloaded!.target).toBe(
            `/cgi-bin/extract.cgi?period=${PERIOD}&session=${encodeURIComponent(TOKEN)}`,
          );
          expect(queryOf(downloaded!).getAll("session")).toEqual([TOKEN]);
          expect(authorization(downloaded!)).toEqual([]);
          // Each placement stays with its service.
          expect(searched!.target).not.toContain("session");
          expect(header(listed!.lines, "authorization")).not.toContain(
            "Bearer",
          );
        }).pipe(Effect.provide(layer)),
    );

  it.live(
    '[AUTH-1] credentials resolve at send time from the one source, and an absent token is omitted, never "undefined"',
    () =>
      Effect.gen(function* () {
        const business = yield* start.business();
        const notifications = yield* start.notifications();
        const gateway = yield* start.gateway();
        const { source, reads } = counted(yield* Credentials.source());
        const search = Ops.searchTasks(
          Credentials.business(source, `${business.origin}/v2`),
        );
        const notify = yield* notifyClient(notifications, source);
        const download = Services.extract(gateway.origin, source);
        // Building operations reads nothing.
        expect(reads()).toBe(0);

        const round = Effect.all({
          search: search.execute({ query: { q: "ledger" } }),
          listed: notify.announcements.execute(undefined),
          download: download.execute({ period: PERIOD }),
        });

        // Signed out: each service sees no credential and answers with its own refusal.
        const out = yield* round;
        const outSearch = narrow(out.search, "Unauthorized");
        expect(outSearch.value.error).toBe("invalid_request");
        expect(outSearch.metadata.headers["www-authenticate"]).toBe(
          'Bearer realm="business-v2"',
        );
        narrow(out.listed, "TokenRejected");
        expect(narrow(out.download, "Refused").value.code).toBe("E_SESSION");
        expect(reads()).toBe(3);

        // Signed in: the same operation values send the token now in the source.
        yield* source.set(TOKEN);
        const signedIn = yield* round;
        narrow(signedIn.search, "Results");
        narrow(signedIn.listed, "Listed");
        narrow(signedIn.download, "Extract");

        // Revoked: the same operations send the new value, which every service refuses.
        yield* source.set(STALE);
        const revoked = yield* round;
        expect(narrow(revoked.search, "Unauthorized").value.error).toBe(
          "invalid_token",
        );
        narrow(revoked.listed, "TokenRejected");
        expect(narrow(revoked.download, "Refused").value.code).toBe(
          "E_SESSION",
        );
        // One read per operation evaluation.
        expect(reads()).toBe(9);

        const businessLedger = yield* business.ledger;
        const notifyLedger = yield* notifications.ledger;
        const gatewayLedger = yield* gateway.ledger;
        expect(businessLedger.map(authorization)).toEqual([
          [],
          [`Bearer ${TOKEN}`],
          [`Bearer ${STALE}`],
        ]);
        expect(notifyLedger.map(authorization)).toEqual([
          [],
          [`Token token="${TOKEN}"`],
          [`Token token="${STALE}"`],
        ]);
        expect(gatewayLedger.map((recorded) => recorded.target)).toEqual([
          `/cgi-bin/extract.cgi?period=${PERIOD}`,
          `/cgi-bin/extract.cgi?period=${PERIOD}&session=${encodeURIComponent(TOKEN)}`,
          `/cgi-bin/extract.cgi?period=${PERIOD}&session=${encodeURIComponent(STALE)}`,
        ]);
        for (const ledger of [businessLedger, notifyLedger, gatewayLedger])
          expect(wireText(ledger)).not.toContain("undefined");

        // The control: a template literal over the same signed-out source sends the word.
        yield* source.set(undefined);
        const naive = yield* Operation.make(
          Request.get("search").pipe(
            Request.setHeader("Authorization", () => `Bearer ${source.read()}`),
            Request.setQuery("q", "ledger"),
            Request.baseUrl(`${business.origin}/v2`),
          ),
          Response.status(401, Body.json),
        ).execute(undefined);
        expect(naive).toEqual({
          error: "invalid_token",
          error_description: "the token is not valid",
        });
        const naiveRequest = (yield* business.ledger).at(-1)!;
        expect(authorization(naiveRequest)).toEqual(["Bearer undefined"]);
      }).pipe(viaFetch),
  );

  it.live(
    "[AUTH-1] endpoints that must not carry the token opt out explicitly, and the source is not even read",
    () =>
      Effect.gen(function* () {
        const business = yield* start.business();
        const notifications = yield* start.notifications();
        const { source, reads } = counted(yield* Credentials.source(TOKEN));
        const connection = Credentials.business(
          source,
          `${business.origin}/v2`,
        );
        const notify = yield* notifyClient(notifications, source);

        // The operational endpoint, with the shared transform's credential removed.
        const anonymous = yield* Services.abandoned(connection).execute(0);
        expect(anonymous).toEqual({ abandoned: [] });
        expect(reads()).toBe(0);
        // The control: the area contract, which does not opt out, sends the token there.
        yield* Ops.abandonedRequests(connection).execute({
          query: { atLeast: 0 },
        });
        expect(reads()).toBe(1);
        // A credentialed route on the same connection still carries it.
        narrow(
          yield* Ops.searchTasks(connection).execute({
            query: { q: "ledger" },
          }),
          "Results",
        );

        // The notification contract leaves its CSRF bootstrap anonymous by construction.
        const csrf = yield* notify.csrf.execute(undefined);
        narrow(
          yield* notify.announce().execute({
            csrf,
            announcement: {
              channel: "month-end",
              subject: "Opt-out check",
              body: "The bootstrap carries no token.",
            },
          }),
          "Announced",
        );

        expect(
          (yield* business.ledger).map((recorded) => [
            recorded.target,
            authorization(recorded),
          ]),
        ).toEqual([
          ["/v2/ops/abandoned?atLeast=0", []],
          ["/v2/ops/abandoned?atLeast=0", [`Bearer ${TOKEN}`]],
          ["/v2/search?q=ledger", [`Bearer ${TOKEN}`]],
        ]);
        expect(
          (yield* notifications.ledger).map((recorded) => [
            recorded.method,
            pathOf(recorded),
            authorization(recorded),
          ]),
        ).toEqual([
          ["GET", "/v2/session/csrf", []],
          ["POST", "/v2/announcements", [`Token token="${TOKEN}"`]],
        ]);
      }).pipe(viaFetch),
  );
});

// ---------------------------------------------------------------------------------------------
// APP-1: interaction gates over the business search
// ---------------------------------------------------------------------------------------------

/** The business API with the seeded tasks and per-query search latency. */
const searchService = (latency: { readonly [query: string]: number } = {}) =>
  start.business({ tasks: seededTasks, searchLatency: latency });

const connectionTo = (backend: Backend, source: Credentials.Source) =>
  Credentials.business(source, `${backend.origin}/v2`);

const searches = (ledger: ReadonlyArray<Recorded>) =>
  ledger.filter((recorded) => pathOf(recorded) === "/v2/search");

/** Whether a forked caller ended interrupted, as a superseded waiter does. */
const interrupted = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.map(
    Fiber.await(fiber),
    (exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
  );

const titles = (outcome: Search.Outcome) =>
  narrow(outcome, "Results").value.hits.map((hit) => hit.title);

/** A search whose finalizer takes a while, to show that disposal waits for it. */
const slowlyFinalized = (connection: Ops.Connection, done: () => void) => {
  const search = Search.search(connection);
  return (text: string) =>
    search(text).pipe(
      Effect.onExit(() =>
        Effect.sleep("150 millis").pipe(Effect.andThen(Effect.sync(done))),
      ),
    );
};

describe(`flows: the search box (APP-1, ${lane.name})`, () => {
  it.live(
    "[APP-1] new input interrupts the search in flight, and the service records the abandoned request",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService({ ledger: 5_000 });
        const connection = connectionTo(
          business,
          yield* Credentials.source(TOKEN),
        );
        const box = yield* Search.searchBox(connection);
        const first = yield* Effect.forkChild(box.run("ledger"));
        yield* business.arrived(1);
        expect(titles(yield* box.run("archive"))).toEqual([
          "Archive the ledger exports",
        ]);
        // The superseded caller ends interrupted; it does not receive the newer result.
        expect(yield* interrupted(first)).toBe(true);
        // The service's own record of clients that went away, waiting until it has noticed.
        expect(yield* Services.abandoned(connection).execute(1)).toEqual({
          abandoned: [{ route: "search", target: "/v2/search?q=ledger" }],
        });
        expect(
          searches(yield* business.ledger).map((recorded) => [
            recorded.target,
            recorded.aborted,
          ]),
        ).toEqual([
          ["/v2/search?q=ledger", true],
          ["/v2/search?q=archive", false],
        ]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] equal input joins the active search: two callers, one request, one value",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService({ ledger: 300 });
        const box = yield* Search.searchBox(
          connectionTo(business, yield* Credentials.source(TOKEN)),
        );
        const one = yield* Effect.forkChild(box.run("ledger"));
        yield* business.arrived(1);
        const two = yield* Effect.forkChild(box.run("ledger"));
        const first = yield* Fiber.join(one);
        const second = yield* Fiber.join(two);
        expect(second).toBe(first);
        expect(titles(first)).toEqual([
          "Reconcile the October ledger",
          "Archive the ledger exports",
        ]);
        expect(searches(yield* business.ledger)).toHaveLength(1);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] equal input reuses the one retained success without a request; other input replaces it",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService();
        const box = yield* Search.searchBox(
          connectionTo(business, yield* Credentials.source(TOKEN)),
        );
        const first = yield* box.run("archive");
        expect(yield* box.run("archive")).toBe(first);
        expect(searches(yield* business.ledger)).toHaveLength(1);
        titles(yield* box.run("ledger"));
        // One retained success: the ledger search replaced the archive one.
        const again = yield* box.run("archive");
        expect(again).not.toBe(first);
        expect(titles(again)).toEqual(titles(first));
        expect(
          searches(yield* business.ledger).map((recorded) => recorded.target),
        ).toEqual([
          "/v2/search?q=archive",
          "/v2/search?q=ledger",
          "/v2/search?q=archive",
        ]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] force re-executes, yields the new value, and supersedes an equal search in flight",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService({ ledger: 400 });
        const connection = connectionTo(
          business,
          yield* Credentials.source(TOKEN),
        );
        const box = yield* Search.searchBox(connection);
        const before = yield* box.run("archive");
        narrow(
          yield* Ops.createTask(connection).execute({
            body: {
              title: "Archive the November extract",
              assigneeId: "u-ada",
              priority: 3,
            },
          }),
          "Created",
        );
        // Without force, the retained success answers, stale as it now is.
        expect(yield* box.run("archive")).toBe(before);
        const fresh = yield* box.run("archive", { force: true });
        expect(fresh).not.toBe(before);
        expect(titles(fresh)).toEqual([
          "Archive the ledger exports",
          "Archive the November extract",
        ]);
        expect(yield* box.run("archive")).toBe(fresh);

        // Force also supersedes active work for the same input.
        const held = yield* Effect.forkChild(box.run("ledger"));
        yield* business.arrived(4);
        const forced = yield* box.run("ledger", { force: true });
        expect(titles(forced)).toEqual([
          "Reconcile the October ledger",
          "Archive the ledger exports",
        ]);
        expect(yield* interrupted(held)).toBe(true);
        expect(
          (yield* Services.abandoned(connection).execute(1)).abandoned,
        ).toEqual([{ route: "search", target: "/v2/search?q=ledger" }]);
        expect(
          searches(yield* business.ledger).map((recorded) => [
            recorded.target,
            recorded.aborted,
          ]),
        ).toEqual([
          ["/v2/search?q=archive", false],
          ["/v2/search?q=archive", false],
          ["/v2/search?q=ledger", true],
          ["/v2/search?q=ledger", false],
        ]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] navigation disposes: close aborts the search in flight and waits for its finalizers",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService({ ledger: 5_000 });
        const connection = connectionTo(
          business,
          yield* Credentials.source(TOKEN),
        );
        let finalized = false;
        const box = yield* Interaction.make(
          slowlyFinalized(connection, () => {
            finalized = true;
          }),
          { retain: Search.retainResults },
        );
        const waiting = yield* Effect.forkChild(box.run("ledger"));
        yield* business.arrived(1);
        yield* box.close;
        // close returned only after the slow finalizer of the work it interrupted.
        expect(finalized).toBe(true);
        expect(yield* interrupted(waiting)).toBe(true);
        expect((yield* Effect.flip(box.run("archive")))._tag).toBe(
          "InteractionClosed",
        );
        yield* box.close;
        expect(
          (yield* Services.abandoned(connection).execute(1)).abandoned,
        ).toEqual([{ route: "search", target: "/v2/search?q=ledger" }]);
        // The closed interaction sent nothing more.
        expect(searches(yield* business.ledger)).toHaveLength(1);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] navigation disposes: closing the acquiring scope aborts the search and waits for finalizers",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService({ ledger: 5_000 });
        const connection = connectionTo(
          business,
          yield* Credentials.source(TOKEN),
        );
        let finalized = false;
        const waiting = yield* Effect.scoped(
          Effect.gen(function* () {
            const box = yield* Interaction.make(
              slowlyFinalized(connection, () => {
                finalized = true;
              }),
              { retain: Search.retainResults },
            );
            const fiber = yield* Effect.forkChild(box.run("ledger"));
            yield* business.arrived(1);
            return fiber;
          }),
        );
        expect(finalized).toBe(true);
        expect(yield* interrupted(waiting)).toBe(true);
        expect(
          (yield* Services.abandoned(connection).execute(1)).abandoned,
        ).toEqual([{ route: "search", target: "/v2/search?q=ledger" }]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] empty input supersedes through the same gate without a request; the service would refuse it",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService({ ledger: 5_000 });
        const connection = connectionTo(
          business,
          yield* Credentials.source(TOKEN),
        );
        const box = yield* Search.searchBox(connection);
        const waiting = yield* Effect.forkChild(box.run("ledger"));
        yield* business.arrived(1);
        expect(yield* box.run("")).toEqual(Search.cleared);
        expect(yield* box.run("   ")).toEqual(Search.cleared);
        expect(yield* interrupted(waiting)).toBe(true);
        expect(
          (yield* Services.abandoned(connection).execute(1)).abandoned,
        ).toEqual([{ route: "search", target: "/v2/search?q=ledger" }]);
        expect(
          searches(yield* business.ledger).map((recorded) => recorded.target),
        ).toEqual(["/v2/search?q=ledger"]);
        // Fixture fact: a blank query that did reach the service is refused there.
        const blank = narrow(
          yield* Ops.searchTasks(connection).execute({ query: { q: "   " } }),
          "BadRequest",
        );
        expect(blank.value.error).toBe("query_required");
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] updating the credential does not unmount the search box: later runs use the new token",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService();
        const source = yield* Credentials.source(STALE);
        const box = yield* Search.searchBox(connectionTo(business, source));
        const refused = narrow(yield* box.run("ledger"), "Unauthorized");
        expect(refused.value.error).toBe("invalid_token");
        yield* source.set(TOKEN);
        // The same input runs again: a refusal is a success in Effect's terms, but not retained.
        const results = yield* box.run("ledger");
        expect(titles(results)).toHaveLength(2);
        expect(yield* box.run("ledger")).toBe(results);
        yield* source.set(undefined);
        expect(
          narrow(yield* box.run("archive"), "Unauthorized").value.error,
        ).toBe("invalid_request");
        expect(searches(yield* business.ledger).map(authorization)).toEqual([
          [`Bearer ${STALE}`],
          [`Bearer ${TOKEN}`],
          [],
        ]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-1] a credential provided around run does not reach the interaction: services were captured at acquisition",
    () =>
      Effect.gen(function* () {
        const business = yield* searchService();
        const SessionToken = Context.Reference<string | undefined>(
          "flows-test/SessionToken",
          { defaultValue: () => undefined },
        );
        const box = yield* Interaction.make((text: string) =>
          Effect.gen(function* () {
            const token = yield* SessionToken;
            return yield* Ops.searchTasks({
              baseUrl: `${business.origin}/v2`,
              credential: () => token,
            }).execute({ query: { q: text } });
          }),
        ).pipe(Effect.provideService(SessionToken, STALE));
        const outcome = yield* box
          .run("ledger")
          .pipe(Effect.provideService(SessionToken, TOKEN));
        expect(narrow(outcome, "Unauthorized").value.error).toBe(
          "invalid_token",
        );
        expect(searches(yield* business.ledger).map(authorization)).toEqual([
          [`Bearer ${STALE}`],
        ]);
      }).pipe(viaFetch),
  );
});

// ---------------------------------------------------------------------------------------------
// APP-2: the month-end saga
// ---------------------------------------------------------------------------------------------

/** Six backends: the five services and the portal facade in front of the store. */
const sixServices = (
  options: {
    readonly store?: { readonly [key: string]: Json };
    readonly notifications?: { readonly [key: string]: Json };
  } = {},
) =>
  Effect.gen(function* () {
    const identity = yield* start.identity();
    const business = yield* start.business();
    const gateway = yield* start.gateway();
    const store = yield* start.store(options.store);
    const portal = yield* start.portal(store);
    const notifications = yield* start.notifications(options.notifications);
    const credentials = yield* Credentials.source(TOKEN);
    const jar = yield* Ref.make(Cookies.empty);
    const saga = Saga.make({
      origins: {
        identity: identity.origin,
        business: business.origin,
        gateway: gateway.origin,
        store: store.origin,
        portal: portal.origin,
        notifications: notifications.origin,
      },
      credentials,
      signingSecret: SECRET,
      csrfCookie: "transport",
      ...(lane.name === "node" ? { jar } : {}),
    });
    const connection = connectionTo(business, credentials);
    return {
      identity,
      business,
      gateway,
      store,
      portal,
      notifications,
      saga,
      connection,
    };
  });

const monthEnd: Saga.Input = { period: PERIOD, assignee: "alovelace" };

const midnight = (year: number, month: number, day: number) =>
  Date.UTC(year, month - 1, day);

/** The task bodies the saga must write, in the business's wire terms, written out by hand. */
const expectedTaskBodies = [
  {
    title: "[00012345] Café Müller",
    assigneeId: "idp:alovelace",
    priority: 2,
    due: `/Date(${midnight(2026, 11, 15)})/`,
    notes: "Month-end 202610: $1,234.50 open",
  },
  {
    title: "[00012346] Bäckerei Groß",
    assigneeId: "idp:alovelace",
    priority: 4,
    notes: "Month-end 202610: $99.00 open",
  },
  {
    title: "[00012348] Øresund Fisk",
    assigneeId: "idp:alovelace",
    priority: 1,
    due: `/Date(${midnight(2026, 11, 20)})/`,
    notes: "Month-end 202610: $25,000.00 open",
  },
];

const UPLOAD = "ME202610-20261101T021500Z.DAT";

const override = (recorded: Recorded) =>
  header(recorded.lines, "x-http-method-override");

/** The tunnelled deletes the business API received, in order. */
const deletes = (ledger: ReadonlyArray<Recorded>) =>
  ledger
    .filter(
      (recorded) =>
        recorded.method === "POST" && override(recorded) === "DELETE",
    )
    .map((recorded) => recorded.target);

/** The tasks left in the business API, read past the saga. */
const remainingTasks = (connection: Ops.Connection) =>
  Effect.map(
    Ops.listTasks(connection).execute({ query: {} }),
    (listed) => narrow(listed, "Tasks").value.count,
  );

/** One element's text in a recorded XML body. */
const xmlField = (recorded: Recorded, name: string) =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(bodyText(recorded))?.[1];

const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/** Read the ledger until the request at `index` shows the client's abort. */
const abortedAt = (backend: Backend, index: number) =>
  backend.ledger.pipe(
    Effect.map((ledger) => ledger[index]?.aborted === true),
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: (seen) => seen,
      times: 120,
    }),
  );

/** The checks every compensated failure shares: one tunnelled delete per task, none left. */
const compensatedOnce = (
  services: Effect.Success<ReturnType<typeof sixServices>>,
) =>
  Effect.gen(function* () {
    const ledger = yield* services.business.ledger;
    expect(
      ledger.filter((recorded) => recorded.target === "/v2/tasks"),
    ).toHaveLength(3);
    expect(deletes(ledger)).toEqual([
      "/v2/tasks/T-1003",
      "/v2/tasks/T-1002",
      "/v2/tasks/T-1001",
    ]);
    // A raw DELETE never left the client: the gateway in front of the service strips it.
    expect(ledger.some((recorded) => recorded.method === "DELETE")).toBe(false);
    expect(yield* remainingTasks(services.connection)).toBe(0);
  });

const allDeleted = [
  { id: "T-1003", outcome: "deleted" },
  { id: "T-1002", outcome: "deleted" },
  { id: "T-1001", outcome: "deleted" },
];

describe(`flows: the month-end saga (APP-2, ${lane.name})`, () => {
  it.live(
    "[APP-2] the saga extracts, translates, writes, archives, publishes, announces and confirms across six services",
    () =>
      Effect.gen(function* () {
        const services = yield* sixServices();
        const report = yield* services.saga.run(monthEnd);

        expect(report).toMatchObject({
          period: PERIOD,
          assignee: "alovelace",
          tasks: ["T-1001", "T-1002", "T-1003"],
          skipped: [
            { account: "00012347", status: "paid" },
            { account: "00012349", status: "cancelled" },
          ],
          archived: { id: "DOC-000001", name: UPLOAD },
          published: { id: "DOC-000002", name: `portal.${UPLOAD}` },
        });

        // 1. The gateway: one download, the session placed by the source.
        const [download, ...noMoreDownloads] = yield* services.gateway.ledger;
        expect(noMoreDownloads).toEqual([]);
        expect(download!.target).toBe(
          `/cgi-bin/extract.cgi?period=${PERIOD}&session=${encodeURIComponent(TOKEN)}`,
        );

        // 2. The directory: one lookup with the same token as a bearer.
        const [lookup, ...noMoreLookups] = yield* services.identity.ledger;
        expect(noMoreLookups).toEqual([]);
        expect(lookup!.target).toBe("/directory/users/alovelace");
        expect(authorization(lookup!)).toEqual([`Bearer ${TOKEN}`]);

        // 3 and 7. The business API: the open items as tasks, then the confirming search.
        const businessLedger = yield* services.business.ledger;
        expect(
          businessLedger.map((recorded) => [recorded.method, recorded.target]),
        ).toEqual([
          ["POST", "/v2/tasks"],
          ["POST", "/v2/tasks"],
          ["POST", "/v2/tasks"],
          ["GET", "/v2/search?q=Month-end%20202610%3A"],
        ]);
        expect(
          businessLedger
            .slice(0, 3)
            .map((recorded) => JSON.parse(bodyText(recorded))),
        ).toEqual(expectedTaskBodies);
        expect(deletes(businessLedger)).toEqual([]);

        // 4 and 5. The store: the saga's own SOAP call, then the facade's forwarded one.
        const [archived, forwarded, ...noMoreStores] =
          yield* services.store.ledger;
        expect(noMoreStores).toEqual([]);
        expect(header(archived!.lines, "soapaction")).toBe(
          '"urn:docvault:store:2003#StoreDocument"',
        );
        expect(xmlField(archived!, "Name")).toBe(UPLOAD);
        expect(xmlField(forwarded!, "Name")).toBe(`portal.${UPLOAD}`);
        // The upload has no size: the store counts its own.
        expect(bodyText(archived!)).not.toMatch(/Size|Length/);

        const [published] = yield* services.portal.ledger;
        const publication = JSON.parse(bodyText(published!)) as {
          readonly document: {
            readonly Name: string;
            readonly Content: ReadonlyArray<number>;
          };
        };
        expect(publication.document.Name).toBe(UPLOAD);

        // The re-encoded bytes are the gateway's bytes, in every copy.
        const original = yield* Operation.make(
          Request.get(download!.target).pipe(
            Request.baseUrl(services.gateway.origin),
          ),
          Response.status(200, Body.bytes),
        ).execute(undefined);
        expect(original).toHaveLength(7 * 64);
        expect(fromBase64(xmlField(archived!, "Content")!)).toEqual(original);
        expect(Uint8Array.from(publication.document.Content)).toEqual(original);
        expect(fromBase64(xmlField(forwarded!, "Content")!)).toEqual(original);

        // 6. The notification service: an anonymous bootstrap, then the signed announcement.
        const notifyLedger = yield* services.notifications.ledger;
        expect(
          notifyLedger.map((recorded) => [
            recorded.method,
            pathOf(recorded),
            authorization(recorded),
          ]),
        ).toEqual([
          ["GET", "/v2/session/csrf", []],
          ["POST", "/v2/announcements", [`Token token="${TOKEN}"`]],
        ]);
        const announcement = notifyLedger[1]!;
        expect(header(announcement.lines, "x-notify-signature")).toMatch(
          /^v1=[0-9a-f]{64}$/,
        );
        expect(JSON.parse(bodyText(announcement))).toEqual({
          channel: "month-end",
          subject: "Month-end 202610 closed",
          body:
            "3 task(s) for idp:alovelace (T-1001, T-1002, T-1003); 2 item(s) were not open. " +
            `Extract archived as DOC-000001 (${UPLOAD}) and published as portal.${UPLOAD}.`,
        });
        expect(report.announcement).toMatch(/\S/);

        // 7. Every hit reads back to the item it was written from.
        expect(
          report.confirmed.map((assignment) => assignment.item.account),
        ).toEqual(["00012345", "00012346", "00012348"]);
        expect(report.confirmed[0]).toEqual(
          Schema.decodeUnknownSync(Translate.Assignment)({
            item: {
              period: PERIOD,
              account: "00012345",
              title: "Café Müller",
              amount: 123_450,
              due: Option.some(DateTime.makeUnsafe(midnight(2026, 11, 15))),
              status: "open",
            },
            assignee: "alovelace",
          }),
        );
        expect(yield* remainingTasks(services.connection)).toBe(3);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-2] a store fault at the archive step compensates the created tasks exactly once",
    () =>
      Effect.gen(function* () {
        const services = yield* sixServices({
          store: { failStore: { calls: [1] } },
        });
        const failure = yield* Effect.flip(services.saga.run(monthEnd));
        expect(failure.step).toBe("archive");
        expect(failure.reason).toMatchObject({
          _tag: "Refused",
          code: 5003,
        });
        expect(failure.compensated).toEqual(allDeleted);
        yield* compensatedOnce(services);
        expect(yield* services.portal.ledger).toEqual([]);
        expect(yield* services.notifications.ledger).toEqual([]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-2] a store fault relayed by the portal facade at the publish step compensates exactly once",
    () =>
      Effect.gen(function* () {
        const services = yield* sixServices({
          store: { failStore: { calls: [2] } },
        });
        const failure = yield* Effect.flip(services.saga.run(monthEnd));
        expect(failure.step).toBe("publish");
        expect(failure.reason).toMatchObject({
          _tag: "Fault",
          value: { _tag: "StoreFault", code: 5003 },
          metadata: { status: 500 },
        });
        expect(failure.compensated).toEqual(allDeleted);
        yield* compensatedOnce(services);
        expect(yield* services.portal.ledger).toHaveLength(1);
        expect(yield* services.notifications.ledger).toEqual([]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-2] an error page at the announce step is an unexpected response, and compensation runs exactly once",
    () =>
      Effect.gen(function* () {
        const services = yield* sixServices({
          notifications: { announce: { fail: "error" } },
        });
        const failure = yield* Effect.flip(services.saga.run(monthEnd));
        expect(failure.step).toBe("announce");
        expect(failure.reason).toMatchObject({
          _tag: "UnexpectedResponse",
          metadata: { status: 500 },
        });
        expect(failure.compensated).toEqual(allDeleted);
        yield* compensatedOnce(services);
        // The documents stay archived and published; only the tasks are compensated.
        expect(yield* services.store.ledger).toHaveLength(2);
        expect((yield* services.notifications.ledger).map(pathOf)).toEqual([
          "/v2/session/csrf",
          "/v2/announcements",
        ]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-2] interrupting the saga mid-archive aborts the store call and compensates exactly once",
    () =>
      Effect.gen(function* () {
        const services = yield* sixServices({
          store: { hold: ["StoreDocument"] },
        });
        const running = yield* Effect.forkChild(services.saga.run(monthEnd));
        yield* services.store.arrived(1);
        yield* Fiber.interrupt(running);
        const exit = yield* Fiber.await(running);
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true);
        expect(yield* abortedAt(services.store, 0)).toBe(true);
        yield* compensatedOnce(services);
        expect(yield* services.portal.ledger).toEqual([]);
        expect(yield* services.notifications.ledger).toEqual([]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-2] the portal facade's rejections: a duplicate as a jsonerror fault, base64 content as its HTML page, an absent store",
    () =>
      Effect.gen(function* () {
        const store = yield* start.store();
        const portal = yield* start.portal(store);
        const publish = Portal.publish(portal.origin);
        const document: Portal.Publication = {
          name: "notes.txt",
          title: "Notes",
          contentType: "text/plain",
          content: new TextEncoder().encode("month-end"),
        };
        expect(yield* publish.execute(document)).toMatchObject({
          _tag: "Published",
          id: "DOC-000001",
          name: "portal.notes.txt",
        });
        const duplicate = narrow(yield* publish.execute(document), "Fault");
        expect(duplicate.value).toEqual({
          _tag: "StoreFault",
          code: 1002,
          message: "A document named portal.notes.txt already exists",
        });
        expect(duplicate.metadata.headers["jsonerror"]).toBe("true");

        // What a client that assumed base64 would send: the formatter refuses it as a page.
        const untyped = Operation.make(
          Request.post("DocumentService.svc/Publish").pipe(
            Request.body(Body.json),
            Request.baseUrl(portal.origin),
          ),
          Portal.publishResponse,
        );
        const base64 = narrow(
          yield* untyped.execute({
            body: {
              document: {
                Name: "base64.txt",
                Title: "",
                ContentType: "text/plain",
                Content: "bW9udGgtZW5k",
              },
            },
          }),
          "RequestError",
        );
        expect(base64.metadata.status).toBe(400);
        expect(base64.value).toBe(
          "The data contract member 'Content' of type 'System.Byte[]' is required.",
        );
        // The same JSON as text/plain: the codec owns the content type, and the facade wants JSON.
        const asText = narrow(
          yield* Operation.make(
            Request.post("DocumentService.svc/Publish").pipe(
              Request.body(Body.text),
              Request.baseUrl(portal.origin),
            ),
            Portal.publishResponse,
          ).execute({ body: JSON.stringify({ document: {} }) }),
          "RequestError",
        );
        expect(asText.metadata.status).toBe(415);
        expect(asText.value).toContain(
          "was not the expected type 'application/json",
        );

        // A facade whose store is gone: the exception type says so, still as a jsonerror fault.
        const orphan = yield* lane.backend("soap-proxy", {
          soapOrigin: "http://127.0.0.1:9",
        });
        const absent = narrow(
          yield* Portal.publish(orphan.origin).execute(document),
          "Fault",
        );
        expect(absent.value).toMatchObject({
          _tag: "ServiceFault",
          type: "System.ServiceModel.EndpointNotFoundException",
        });

        const [first, second, third, fourth] = yield* portal.ledger;
        expect(JSON.parse(bodyText(first!))).toEqual({
          document: {
            Name: "notes.txt",
            Title: "Notes",
            ContentType: "text/plain",
            Content: [109, 111, 110, 116, 104, 45, 101, 110, 100],
          },
        });
        expect(header(second!.lines, "content-type")).toBe("application/json");
        expect(header(third!.lines, "content-type")).toBe("application/json");
        expect(header(fourth!.lines, "content-type")).toMatch(/^text\/plain/);
        // The facade forwarded only the readable bodies, with its own SOAP code, under its prefix.
        expect(
          (yield* store.ledger).map((recorded) => xmlField(recorded, "Name")),
        ).toEqual(["portal.notes.txt", "portal.notes.txt"]);
      }).pipe(viaFetch),
  );
});

// ---------------------------------------------------------------------------------------------
// APP-3: translation between services, against the services
// ---------------------------------------------------------------------------------------------

describe(`flows: translation between services (APP-3, ${lane.name})`, () => {
  it.live(
    "[APP-3] inactive and missing directory entries are refused as assignees through identity, before any task is written",
    () =>
      Effect.gen(function* () {
        const services = yield* sixServices();
        for (const [uid, reason] of [
          ["cbabbage", "the directory entry is inactive"],
          ["nobody", "the directory has no such user"],
        ] as const) {
          const failure = yield* Effect.flip(
            services.saga.run({ period: PERIOD, assignee: uid }),
          );
          expect(failure.step).toBe("assignee");
          expect(failure.reason).toMatchObject({
            _tag: "NotAssignable",
            uid,
            reason,
          });
          expect(failure.compensated).toEqual([]);
        }
        // The directory answered both lookups with 200: the refusal is the consumer's schema.
        expect(
          (yield* services.identity.ledger).map((recorded) => [
            recorded.target,
            authorization(recorded),
          ]),
        ).toEqual([
          ["/directory/users/cbabbage", [`Bearer ${TOKEN}`]],
          ["/directory/users/nobody", [`Bearer ${TOKEN}`]],
        ]);
        expect(yield* services.business.ledger).toEqual([]);
        expect(yield* services.store.ledger).toEqual([]);
      }).pipe(viaFetch),
  );

  it.live(
    "[APP-3] a task written from an extract item reads back through the service to the same item",
    () =>
      Effect.gen(function* () {
        const business = yield* start.business();
        const connection = connectionTo(
          business,
          yield* Credentials.source(TOKEN),
        );
        const written = Schema.decodeUnknownSync(Translate.Assignment)({
          item: {
            period: PERIOD,
            account: "00012348",
            title: "Øresund Fisk",
            amount: 2_500_000,
            due: Option.some(DateTime.makeUnsafe(Date.UTC(2026, 10, 20))),
            status: "open",
          },
          assignee: "ghopper",
        });
        const created = narrow(
          yield* Ops.createTask(connection).execute({
            body: yield* Translate.newTask(written),
          }),
          "Created",
        );
        const read = narrow(
          yield* Ops.readTask(connection).execute({ path: created.value.id }),
          "Task",
        ).value;
        // The service's id is its own; the gateway account is only in the title.
        expect(read.id).toBe("T-1001");
        expect(read.title).toBe("[00012348] Øresund Fisk");
        const back = yield* Schema.decodeEffect(Translate.AssignmentFromTask)({
          title: read.title,
          assigneeId: read.assigneeId,
          priority: read.priority,
          ...(read.due === null ? {} : { due: read.due }),
          ...(read.notes === undefined ? {} : { notes: read.notes }),
          done: read.done,
        });
        expect(back).toEqual(written);
        // The service wrote the date with its escaped slashes; the value is the same instant.
        const [, readRequest] = yield* business.ledger;
        expect(readRequest!.target).toBe("/v2/tasks/T-1001");
      }).pipe(viaFetch),
  );
});

// ---------------------------------------------------------------------------------------------
// APP-6: narrowing across services
// ---------------------------------------------------------------------------------------------

describe(`flows: narrowing (APP-6, ${lane.name})`, () => {
  it.live(
    "[APP-6] a mapped 401 is a member of each service's success union, so no body is readable before narrowing",
    () =>
      Effect.gen(function* () {
        const business = yield* start.business();
        const notifications = yield* start.notifications();
        const gateway = yield* start.gateway();
        const source = yield* Credentials.source(STALE);
        const searched = yield* Ops.searchTasks(
          connectionTo(business, source),
        ).execute({ query: { q: "ledger" } });
        const listed = yield* (yield* notifyClient(
          notifications,
          source,
        )).announcements.execute(undefined);
        const downloaded = yield* Services.extract(
          gateway.origin,
          source,
        ).execute({ period: PERIOD });

        expectTypeOf(searched._tag).toEqualTypeOf<
          | "Results"
          | "Unauthorized"
          | "NotFound"
          | "Invalid"
          | "BadRequest"
          | "MethodNotAllowed"
        >();
        expectTypeOf(listed._tag).toEqualTypeOf<"Listed" | "TokenRejected">();
        expectTypeOf(downloaded._tag).toEqualTypeOf<"Extract" | "Refused">();
        // @ts-expect-error The hits are unreachable until the 401 is ruled out.
        expect(searched.value.hits).toBeUndefined();
        // @ts-expect-error The list is unreachable until the Token challenge is ruled out.
        expect(listed.value.announcements).toBeUndefined();
        // @ts-expect-error The extract is unreachable until the refusal is ruled out.
        expect(downloaded.value.extract).toBeUndefined();

        // The error paths are real: each refusal arrived from its service and was decoded.
        expect(searched).toMatchObject({
          _tag: "Unauthorized",
          value: { error: "invalid_token" },
          metadata: { status: 401 },
        });
        expect(listed).toMatchObject({
          _tag: "TokenRejected",
          value: "HTTP Token: Access denied.\n",
          metadata: { status: 401 },
        });
        expect(downloaded).toMatchObject({
          _tag: "Refused",
          value: { _tag: "GatewayError", code: "E_SESSION" },
          metadata: { status: 403 },
        });
        if (searched._tag === "Results")
          expectTypeOf(searched.value.hits).toEqualTypeOf<
            ReadonlyArray<Ops.Task>
          >();

        // Across services: one check narrows each service's own union, and nothing else.
        type Signed = typeof searched | typeof listed | typeof downloaded;
        const credentialRefused = (outcome: Signed): boolean =>
          outcome._tag === "Unauthorized" ||
          outcome._tag === "TokenRejected" ||
          (outcome._tag === "Refused" && outcome.value.code === "E_SESSION");
        expect([searched, listed, downloaded].map(credentialRefused)).toEqual([
          true,
          true,
          true,
        ]);
        const unnarrowed = (outcome: Signed) =>
          // @ts-expect-error No member's value is readable across services without its tag.
          outcome.value.error;
        expect(unnarrowed(searched)).toBe("invalid_token");
      }).pipe(viaFetch),
  );

  it("[APP-6] the saga's failure keeps each step's own union: its reason is unknown until narrowed", () => {
    expectTypeOf<Saga.StepFailed["reason"]>().toBeUnknown();
    expectTypeOf<Saga.StepFailed["step"]>().toEqualTypeOf<Saga.Step>();
    const failure = new Saga.StepFailed({
      step: "archive",
      reason: {
        _tag: "Refused",
        code: 5003,
        message: "Storage backend unavailable",
      },
      compensated: [],
    });
    // @ts-expect-error A reason cannot be read as any one service's refusal without narrowing.
    expect(failure.reason.code).toBe(5003);
  });
});
