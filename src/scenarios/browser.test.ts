/**
 * TRN-1: explicit cookie and credential behaviour, run in both lanes. Cookies belong to the
 * transport, and the transports differ: Node's Fetch and the line-preserving provider keep no
 * cookies at all, while Chromium keeps its own cookie store under rules a script cannot change.
 * Each test records the transport settings in effect (as a test annotation, read from the Effect
 * context) before asserting anything about cookies, then asserts each lane's own observed
 * behaviour. Nothing is extrapolated from one lane to the other.
 *
 * In the browser lane the page is `http://localhost:<port>` and each backend has its own address,
 * `http://127.0.0.<n>:<port>`, so every call is cross-origin and cross-site, and backends do not
 * share a cookie jar. The harness answers CORS here (the backends' own CORS is HDR-7b), allowing
 * credentials and listing every response header, `Set-Cookie` included, as exposed.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Ref } from "effect";
import { Cookies, FetchHttpClient, HttpClient } from "effect/http";
import type { TestContext } from "vitest";
import { lane } from "#lane";
import { transportSettings } from "../clients/browser/transport.js";
import * as Identity from "../clients/identity/index.js";
import * as Notify from "../clients/notifications/index.js";
import { headerValues, type Json, type Recorded } from "../harness/lane.js";

/** Fixture values, passed to the backends as options and to the consumer as configuration. */
const fixture = {
  token: "ntf_transportLane_8Kd3Pq",
  secret: "notify-signing-transport-lane",
} as const;

/** The page's origin: the test page's own in the browser, a synthetic one in Node. */
const pageOrigin =
  lane.name === "browser"
    ? globalThis.location.origin
    : "https://app.example.test";

/**
 * The notification service with the harness's CORS. Its XSRF cookie is `SameSite=None; Secure`,
 * the setting of its cross-site deployment, unless a test asks for the default `Lax`.
 */
const notifications = (options: { readonly [key: string]: Json } = {}) =>
  lane.backend("notifications", {
    acceptedToken: fixture.token,
    signingSecret: fixture.secret,
    allowedOrigins: [pageOrigin],
    csrfCookieSameSite: "None",
    ...options,
  });

const notify = (baseUrl: string, config: Partial<Notify.Config> = {}) =>
  Notify.make({
    baseUrl,
    token: Effect.succeed(Option.some(fixture.token)),
    secret: fixture.secret,
    csrfCookie: "transport",
    ...config,
  });

/**
 * The identity provider's JSON grant, which also sets the web SSO's cookies:
 * `IDPSESSION=<random>; Path=/; HttpOnly; SameSite=Lax` and
 * `IDPLB=node-3; Path=/; Expires=…`, without a `SameSite` attribute.
 */
const grantInput = {
  headers: { scopes: ["directory:read"] },
  body: {
    grantType: "password" as const,
    username: "alovelace",
    password: Redacted.make("analytical-engine"),
  },
};

const subscription: Notify.SubscriptionDraft = {
  channel: "billing",
  address: "ledger@example.test",
};

/** Record the transport settings in effect as a test annotation, and return them. */
const record = (
  context: TestContext,
  provider: string,
  notes: Readonly<Record<string, string>>,
) =>
  Effect.tap(
    transportSettings(provider, { lane: lane.name, ...notes }),
    (settings) =>
      Effect.promise(() =>
        context.annotate(JSON.stringify(settings), "transport"),
      ),
  );

const fetchDefault = "unset: Fetch's default, same-origin";

/** Fetch with `credentials: "include"`, set through Effect's `FetchHttpClient.RequestInit`. */
const include: RequestInit = { credentials: "include" };

/** Narrow a tagged result, failing the test with the actual tag otherwise. */
const expectTag = <
  A extends { readonly _tag: string },
  const T extends A["_tag"],
>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  if (value._tag !== tag) throw new Error(`expected ${tag}, got ${value._tag}`);
  return value as Extract<A, { readonly _tag: T }>;
};

const cookiePairs = (recorded: Recorded): ReadonlyArray<string> =>
  headerValues(recorded.lines, "cookie").flatMap((line) =>
    line.split(";").map((pair) => pair.trim()),
  );

const xsrf = (token: string) => `XSRF-TOKEN=${encodeURIComponent(token)}`;

describe(`transport and credentials (${lane.name})`, () => {
  describe("TRN-1 cookies and credentials", () => {
    for (const [provider, layer] of lane.clients)
      it.live(
        `[TRN-1] default credentials through ${provider}: the XSRF cookie does not come back, so the POST is refused as cookie-missing`,
        (context: TestContext) =>
          Effect.gen(function* () {
            const settings = yield* record(context, provider, {
              jar: "none",
              cookieHeader: "not set",
            });
            if (provider === "fetch")
              expect(settings.credentials).toBe(fetchDefault);
            const backend = yield* notifications();
            const service = notify(backend.origin);
            const session = yield* service.csrf.execute(undefined);
            const refused = yield* service.subscribe.execute({
              csrf: session,
              subscription,
            });
            expect(expectTag(refused, "CsrfRejected").value).toBe(
              "cookie-missing",
            );
            const [bootstrap, post, ...rest] = yield* backend.ledger;
            expect(rest).toEqual([]);
            expect(headerValues(bootstrap!.lines, "cookie")).toEqual([]);
            expect(headerValues(post!.lines, "cookie")).toEqual([]);
            if (lane.name === "node") {
              // Node's providers show Set-Cookie to the consumer, and keep nothing.
              expect(session.cookie).toBe(encodeURIComponent(session.token));
            } else {
              // Chromium hides Set-Cookie from scripts, and under `same-origin` credentials it
              // neither sends cookies across origins nor stores the ones a cross-origin response
              // sets: a later request with `include` still lacks this session's cookie.
              expect(session.cookie).toBeUndefined();
              const later = yield* service.subscribe
                .execute({ csrf: session, subscription })
                .pipe(
                  Effect.provideService(FetchHttpClient.RequestInit, include),
                );
              expectTag(later, "CsrfRejected");
              const [, , retried, ...more] = yield* backend.ledger;
              expect(more).toEqual([]);
              expect(cookiePairs(retried!)).not.toContain(xsrf(session.token));
            }
          }).pipe(Effect.provide(layer)),
      );

    it.live(
      '[TRN-1] credentials: "include" through FetchHttpClient.RequestInit: Chromium stores and returns the SameSite=None cookie but never the Lax ones; Node\'s fetch keeps none',
      (context: TestContext) =>
        Effect.gen(function* () {
          const settings = yield* record(context, "fetch", {
            jar: "none",
            cookieHeader: "not set",
          });
          expect(settings.credentials).toBe("include");
          const backend = yield* notifications();
          const identity = yield* lane.backend("identity");
          const service = notify(backend.origin);
          const session = yield* service.csrf.execute(undefined);
          const result = yield* service.subscribe.execute({
            csrf: session,
            subscription,
          });
          const granted = expectTag(
            yield* Identity.jsonGrant(identity.origin).execute(grantInput),
            "Granted",
          );
          const entry = yield* Identity.profile(identity.origin).execute({
            headers: granted.value.tokens,
          });
          expect(entry).toMatchObject({ _tag: "Entry", uid: "alovelace" });
          const [, post, ...late] = yield* backend.ledger;
          const [, me, ...later] = yield* identity.ledger;
          expect([late, later]).toEqual([[], []]);
          const { cookies } = granted.metadata;
          if (lane.name === "node") {
            // Node's fetch accepts the option and has no cookie store to apply it to.
            expect(session.cookie).toBe(encodeURIComponent(session.token));
            expect(expectTag(result, "CsrfRejected").value).toBe(
              "cookie-missing",
            );
            expect(headerValues(post!.lines, "cookie")).toEqual([]);
            expect(Object.keys(cookies.cookies)).toEqual([
              "IDPSESSION",
              "IDPLB",
            ]);
            expect(Option.isSome(granted.value.session)).toBe(true);
            expect(headerValues(me!.lines, "cookie")).toEqual([]);
          } else {
            // Chromium keeps the SameSite=None cookie and sends it back across sites.
            expect(session.cookie).toBeUndefined();
            expectTag(result, "Created");
            expect(cookiePairs(post!)).toContain(xsrf(session.token));
            // Set-Cookie stays hidden although the CORS answer lists it as exposed.
            expect(granted.metadata.headers["set-cookie"]).toBeUndefined();
            expect(Cookies.isEmpty(cookies)).toBe(true);
            expect(granted.value.session).toEqual(Option.none());
            // Lax cookies, explicit or by default, never travel on a cross-site fetch.
            expect(
              cookiePairs(me!).filter((pair) => pair.startsWith("IDP")),
            ).toEqual([]);
          }
        }).pipe(
          Effect.provide(lane.fetchClient),
          Effect.provideService(FetchHttpClient.RequestInit, include),
        ),
    );

    it.live(
      "[TRN-1] HttpClient.withCookiesRef, one jar for every service: Node's jar keeps every cookie and sends each service's cookies to the other; in Chromium it never sees one",
      (context: TestContext) =>
        Effect.gen(function* () {
          const jar = yield* Ref.make(Cookies.empty);
          // The application's one HttpClient, with an explicit cookie jar over Effect's Fetch.
          const jarred = Layer.effect(
            HttpClient.HttpClient,
            Effect.map(HttpClient.HttpClient, (client) =>
              HttpClient.withCookiesRef(client, jar),
            ),
          ).pipe(Layer.provide(lane.fetchClient));
          yield* Effect.gen(function* () {
            const settings = yield* record(context, "fetch", {
              jar: "HttpClient.withCookiesRef, shared by both services",
              cookieHeader: "not set",
            });
            expect(settings.credentials).toBe(fetchDefault);
            const identity = yield* lane.backend("identity");
            // The service's default Lax cookie: Effect's jar is not a browser and ignores SameSite.
            const backend = yield* notifications({ csrfCookieSameSite: "Lax" });
            const service = notify(backend.origin);
            const granted = expectTag(
              yield* Identity.jsonGrant(identity.origin).execute(grantInput),
              "Granted",
            );
            const csrf = yield* service.csrf.execute(undefined);
            const result = yield* service.subscribe.execute({
              csrf,
              subscription,
            });
            expectTag(
              yield* Identity.profile(identity.origin).execute({
                headers: granted.value.tokens,
              }),
              "Entry",
            );
            const kept = yield* Ref.get(jar);
            const [grant, me, ...late] = yield* identity.ledger;
            const [bootstrap, post, ...later] = yield* backend.ledger;
            expect([late, later]).toEqual([[], []]);
            expect(headerValues(grant!.lines, "cookie")).toEqual([]);
            if (lane.name === "node") {
              expect(Object.keys(kept.cookies)).toEqual([
                "IDPSESSION",
                "IDPLB",
                "XSRF-TOKEN",
              ]);
              const sso = `IDPSESSION=${Option.getOrThrow(granted.value.session)}; IDPLB=node-3`;
              const all = `${sso}; ${xsrf(csrf.token)}`;
              // The jar is not scoped by origin: the identity provider's cookies go to the
              // notification service, and its XSRF cookie back to the identity provider.
              expect(headerValues(bootstrap!.lines, "cookie")).toEqual([sso]);
              expect(headerValues(post!.lines, "cookie")).toEqual([all]);
              expect(headerValues(me!.lines, "cookie")).toEqual([all]);
              expectTag(result, "Created");
            } else {
              // Chromium hides Set-Cookie from the jar, and under `same-origin` credentials sends
              // no cookie of its own across origins.
              expect(Cookies.isEmpty(kept)).toBe(true);
              for (const recorded of [bootstrap!, post!, me!])
                expect(headerValues(recorded.lines, "cookie")).toEqual([]);
              expect(expectTag(result, "CsrfRejected").value).toBe(
                "cookie-missing",
              );
            }
          }).pipe(Effect.provide(jarred));
        }),
    );

    for (const [provider, layer] of lane.clients)
      it.live(
        `[TRN-1] a Cookie header set by hand through ${provider}: Node sends it verbatim; Chromium drops it without an error and, under credentials: "include", sends its own stored cookie`,
        (context: TestContext) =>
          Effect.gen(function* () {
            const settings = yield* record(context, provider, {
              jar: "none",
              cookieHeader: "set by hand: an earlier session's XSRF cookie",
            });
            if (provider === "fetch")
              expect(settings.credentials).toBe("include");
            const backend = yield* notifications();
            const service = notify(backend.origin, { csrfCookie: "by-hand" });
            const earlier = yield* service.csrf.execute(undefined);
            const current = yield* service.csrf.execute(undefined);
            // The current token in the header, an earlier session's cookie by hand.
            const result = yield* service.subscribe.execute({
              csrf: {
                token: current.token,
                cookie: encodeURIComponent(earlier.token),
              },
              subscription,
            });
            const [, , post, ...rest] = yield* backend.ledger;
            expect(rest).toEqual([]);
            if (lane.name === "node") {
              expect(headerValues(post!.lines, "cookie")).toEqual([
                xsrf(earlier.token),
              ]);
              expect(expectTag(result, "CsrfRejected").value).toBe(
                "token-incorrect",
              );
            } else {
              expect(cookiePairs(post!)).not.toContain(xsrf(earlier.token));
              expect(cookiePairs(post!)).toContain(xsrf(current.token));
              expectTag(result, "Created");
            }
          }).pipe(
            Effect.provide(layer),
            Effect.provideService(FetchHttpClient.RequestInit, include),
          ),
      );
  });
});
