/**
 * A page on one origin calling the services on others, in Chromium: HDR-7b, and the cookie
 * behaviour of TRN-1 through the same-origin proxy. These tests are about the browser itself, so
 * they run only in the browser project (`*.browser.test.ts`); Node enforces no CORS, and its view of
 * the same allowlists is HDR-7a in the notification scenarios.
 *
 * The page is the test page, `http://localhost:<port>`; each backend has its own origin,
 * `http://127.0.0.<n>:<port>`, so every call to a backend is cross-origin and cross-site. The
 * same-origin proxy lives in the test page's server (`src/harness/proxy.ts`). CORS sits outside the
 * library: these tests assert what Chromium sends and allows, and which typed outcome the library
 * reports, not a library feature.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Option,
  Redacted,
  type Result,
  Schedule,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { TestContext } from "vitest";
import { lane } from "#lane";
import { Body, Operation, Policy, Response } from "viell-effect-schema-http";
import { proxyBase, routeThroughProxy } from "../clients/browser/proxy.js";
import { transportSettings } from "../clients/browser/transport.js";
import * as Identity from "../clients/identity/index.js";
import * as Notify from "../clients/notifications/index.js";
import {
  bodyText,
  header,
  headerValues,
  type Json,
  type Recorded,
} from "../harness/lane.js";

/** Fixture values, passed to the backends as options and to the consumer as configuration. */
const fixture = {
  token: "ntf_browserLane_Q4z8Wd",
  secret: "notify-signing-browser-lane",
  identityToken: "idp.browser-lane.Zm9vYmFy",
  client: { id: "page-reports", secret: "page-reports-secret" },
} as const;

const page = globalThis.location.origin;

/** Every hostile CORS behaviour off; each test switches on the ones it is about. */
const calm = {
  subscriptionsOmitContentType: false,
  strictAnnouncements: false,
  v1ContainerOptions: false,
  v1ExposeWarningOnly: false,
} as const;

/**
 * The notification service answering CORS itself (`cors: "backend"`) for this page's origin. The
 * page and the service are on different sites, so the XSRF cookie is issued with `SameSite=None`,
 * the service's setting for cross-site deployments. `cors` lists the hostile behaviours; any left
 * out are on, as in production.
 */
const notifications = (
  cors: { readonly [key: string]: Json },
  options: { readonly [key: string]: Json } = {},
) =>
  lane.backend(
    "notifications",
    {
      acceptedToken: fixture.token,
      signingSecret: fixture.secret,
      allowedOrigins: [page],
      csrfCookieSameSite: "None",
      cors,
      ...options,
    },
    { cors: "backend" },
  );

/** A notification client for one base URL, with the service's cookie left to the browser. */
const notify = (baseUrl: string, config: Partial<Notify.Config> = {}) =>
  Notify.make({
    baseUrl,
    token: Effect.succeed(Option.some(fixture.token)),
    secret: fixture.secret,
    csrfCookie: "transport",
    ...config,
  });

/** Fetch with `credentials: "include"`: cross-origin calls carry and store cookies only so. */
const included = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(lane.fetchClient),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  );

/**
 * Fetch with its default credentials (`same-origin`): no cookies across origins, and the page's own
 * cookies on a same-origin call through the proxy.
 */
const fetched = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(lane.fetchClient));

/**
 * Cookies set through the proxy belong to the page's host, so they would reach every later proxied
 * call. Expire the XSRF cookie when the test ends; it is not `HttpOnly`, so the page can.
 */
const forgetPageCookie = Effect.addFinalizer(() =>
  Effect.sync(() => {
    document.cookie = "XSRF-TOKEN=; Max-Age=0; Path=/; Secure; SameSite=None";
  }),
);

const subscription: Notify.SubscriptionDraft = {
  channel: "month-end",
  address: "close@example.test",
};

const draft: Notify.AnnouncementDraft = {
  channel: "month-end",
  subject: "October close complete",
  body: "42 tasks written; extract stored.",
};

/** The retirement headers of `/v1/subscriptions`, as the HDR-4 header schema reads them. */
const retirement = {
  deprecation: new Date("2025-12-31T23:59:59Z"),
  sunset: new Date("2027-01-31T23:59:59Z"),
  warning: [
    {
      code: 299,
      agent: "-",
      text: 'Deprecated API: "/v1" retires 2026-06-30; use /v2',
      date: new Date("2025-12-31T23:59:59Z"),
    },
    {
      code: 299,
      agent: "notify-gw.example.test:8443",
      text: "v1 traffic is metered, billed per call",
    },
  ],
};

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

/** Chromium's CORS refusal reaches the library as Fetch's rejection: a transport error. */
const expectTransportError = <A, E extends { readonly _tag: string }>(
  result: Result.Result<A, E>,
): void => {
  if (result._tag !== "Failure")
    throw new Error("expected a transport error, got a success");
  const error = result.failure as E & { readonly reason?: { _tag: string } };
  expect(error._tag).toBe("HttpClientError");
  expect(error.reason?._tag).toBe("TransportError");
};

const seen = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map((recorded) => `${recorded.method} ${recorded.target}`);

const cookiePairs = (recorded: Recorded): ReadonlyArray<string> =>
  headerValues(recorded.lines, "cookie").flatMap((line) =>
    line.split(";").map((pair) => pair.trim()),
  );

const xsrf = (token: string) => `XSRF-TOKEN=${encodeURIComponent(token)}`;

const encoder = new TextEncoder();

/** The test's own check of a recorded signature over `path`, independent of the client's signer. */
const signedOver = (recorded: Recorded, path: string) =>
  Effect.promise(async () => {
    const timestamp = header(recorded.lines, "x-notify-timestamp") ?? "";
    const signature = header(recorded.lines, "x-notify-signature") ?? "";
    const head = encoder.encode(`${recorded.method}\n${path}\n${timestamp}\n`);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(fixture.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const digest = Uint8Array.from(
      signature.replace(/^v1=/, "").match(/../g) ?? [],
      (pair) => Number.parseInt(pair, 16),
    );
    return (
      /^v1=[0-9a-f]{64}$/.test(signature) &&
      (await crypto.subtle.verify(
        "HMAC",
        key,
        digest,
        new Uint8Array([...head, ...recorded.body]),
      ))
    );
  });

const bearer = () => ({
  tokenType: "Bearer" as const,
  accessToken: Schema.decodeSync(Identity.AccessToken)(fixture.identityToken),
});

describe(`a page calling the services across origins (${lane.name})`, () => {
  describe("HDR-7b: each hostile allowlist in Chromium, and its escape", () => {
    it.live(
      "[HDR-7b] the subscriptions allowlist omits Content-Type: Chromium refuses the JSON POST after its preflight, and the same-origin proxy delivers it",
      () =>
        Effect.gen(function* () {
          yield* forgetPageCookie;
          const backend = yield* notifications({
            ...calm,
            subscriptionsOmitContentType: true,
          });
          const direct = notify(backend.origin);
          const session = yield* included(direct.csrf.execute(undefined));
          const refused = yield* included(
            direct.subscribe.execute({ csrf: session, subscription }),
          ).pipe(Effect.result);
          expectTransportError(refused);

          const proxied = notify(proxyBase(backend.origin));
          const pageSession = yield* fetched(proxied.csrf.execute(undefined));
          const created = yield* fetched(
            proxied.subscribe.execute({ csrf: pageSession, subscription }),
          );
          expect(expectTag(created, "Created").value).toEqual({
            id: "sub_3",
            ...subscription,
          });

          const ledger = yield* backend.ledger;
          // The refused POST never left the browser; the proxied one needed no preflight.
          expect(seen(ledger)).toEqual([
            "GET /v2/session/csrf",
            "OPTIONS /v2/subscriptions",
            "GET /v2/session/csrf",
            "POST /v2/subscriptions",
          ]);
          const [, preflight, , post] = ledger;
          expect(header(preflight!.lines, "origin")).toBe(page);
          expect(
            header(preflight!.lines, "access-control-request-method"),
          ).toBe("POST");
          expect(
            header(preflight!.lines, "access-control-request-headers"),
          ).toBe("authorization,content-type,x-xsrf-token");
          // Through the proxy: the same JSON request, now same-origin to the page.
          expect(header(post!.lines, "host")).toBe(
            new URL(backend.origin).host,
          );
          expect(header(post!.lines, "sec-fetch-site")).toBe("same-origin");
          expect(header(post!.lines, "content-type")).toBe("application/json");
          expect(bodyText(post!)).toBe(JSON.stringify(subscription));
          expect(cookiePairs(post!)).toEqual([xsrf(pageSession.token)]);
        }),
    );

    it.live(
      "[HDR-7b] the announcements allowlist refuses trace headers: with propagation off for that service alone, the page announces while another service keeps its trace headers",
      () =>
        Effect.gen(function* () {
          const backend = yield* notifications({
            ...calm,
            strictAnnouncements: true,
          });
          // Another service of the same page, behind CORS that allows any requested header.
          const identity = yield* lane.backend("identity", {
            token: fixture.identityToken,
          });
          const quiet = notify(backend.origin);
          const traced = notify(backend.origin, { tracePropagation: true });
          const session = yield* included(quiet.csrf.execute(undefined));
          const loud = yield* included(
            traced.announce().execute({ csrf: session, announcement: draft }),
          ).pipe(Effect.result);
          expectTransportError(loud);
          const announced = yield* included(
            quiet.announce().execute({ csrf: session, announcement: draft }),
          );
          expect(expectTag(announced, "Announced").value).toMatchObject(draft);
          // The same page and HttpClient layer, with Effect's default propagation for this service.
          const entry = yield* included(
            Identity.lookupUser(identity.origin).execute({
              path: "alovelace",
              headers: bearer(),
            }),
          );
          expect(entry).toMatchObject({ _tag: "Entry", uid: "alovelace" });

          const ledger = yield* backend.ledger;
          expect(seen(ledger)).toEqual([
            "GET /v2/session/csrf",
            "OPTIONS /v2/announcements",
            "OPTIONS /v2/announcements",
            "POST /v2/announcements",
          ]);
          const requested = (index: number) =>
            header(ledger[index]!.lines, "access-control-request-headers");
          expect(requested(1)).toBe(
            "authorization,b3,content-type,traceparent,x-notify-signature,x-notify-timestamp,x-xsrf-token",
          );
          expect(requested(2)).toBe(
            "authorization,content-type,x-notify-signature,x-notify-timestamp,x-xsrf-token",
          );
          for (const name of ["traceparent", "b3"])
            expect(headerValues(ledger[3]!.lines, name)).toEqual([]);
          const [lookup, ...others] = yield* identity.ledger;
          expect(others).toEqual([]);
          expect(seen([lookup!])).toEqual(["GET /directory/users/alovelace"]);
          for (const name of ["traceparent", "b3"])
            expect(headerValues(lookup!.lines, name)).toHaveLength(1);
        }),
    );

    it.live(
      "[HDR-7b] the v1 OPTIONS is answered by the servlet container: Chromium never sends the GET, the exposed-header list hides the retirement headers, and through the proxy the page reads them all",
      () =>
        Effect.gen(function* () {
          const container = yield* notifications({
            ...calm,
            v1ContainerOptions: true,
          });
          const exposing = yield* notifications({
            ...calm,
            v1ExposeWarningOnly: true,
          });
          const blocked = yield* included(
            notify(container.origin).legacySubscriptions.execute(undefined),
          ).pipe(Effect.result);
          expectTransportError(blocked);
          // With the application answering OPTIONS, the GET is sent, but the page may read only
          // Warning, so the header schema fails on the missing Deprecation.
          const hidden = yield* included(
            notify(exposing.origin).legacySubscriptions.execute(undefined),
          ).pipe(Effect.flip);
          if (hidden._tag !== "DecodeError")
            throw new Error(`expected DecodeError, got ${hidden._tag}`);
          expect(hidden.metadata.status).toBe(200);
          expect(hidden.metadata.headers["deprecation"]).toBeUndefined();
          expect(hidden.metadata.headers["sunset"]).toBeUndefined();
          expect(hidden.metadata.headers["warning"]).toBeDefined();
          const listed = yield* fetched(
            notify(proxyBase(container.origin)).legacySubscriptions.execute(
              undefined,
            ),
          );
          expect(expectTag(listed, "Listed").value.retirement).toEqual(
            retirement,
          );

          const [preflight, get, ...rest] = yield* container.ledger;
          expect(rest).toEqual([]);
          expect(seen([preflight!, get!])).toEqual([
            "OPTIONS /v1/subscriptions",
            "GET /v1/subscriptions",
          ]);
          expect(
            header(preflight!.lines, "access-control-request-headers"),
          ).toBe("authorization");
          // The GET came through the proxy: same-origin, so no Origin and no preflight.
          expect(header(get!.lines, "origin")).toBeUndefined();
          expect(header(get!.lines, "sec-fetch-site")).toBe("same-origin");
          expect(seen(yield* exposing.ledger)).toEqual([
            "OPTIONS /v1/subscriptions",
            "GET /v1/subscriptions",
          ]);
        }),
    );

    it.live(
      "[HDR-7b] a service with no CORS at all: a simple form POST still reaches it and counts, though Chromium withholds the answer; the page reads it only through the proxy",
      () =>
        Effect.gen(function* () {
          const identity = yield* lane.backend(
            "identity",
            {
              token: fixture.identityToken,
              clients: [fixture.client],
              rateLimit: { limit: 2 },
            },
            { cors: "backend" },
          );
          const grant = {
            body: {
              grantType: "client_credentials" as const,
              clientId: fixture.client.id,
              clientSecret: Redacted.make(fixture.client.secret),
              scope: ["directory:read"],
            },
          };
          // Effect's default trace headers make the form POST need a preflight, which the provider
          // answers 405 without any CORS header.
          const traced = yield* fetched(
            Identity.formGrant(identity.origin).execute(grant),
          ).pipe(Effect.result);
          expectTransportError(traced);
          // Without them it is a CORS simple request: sent at once, and only the answer withheld.
          const quiet = yield* fetched(
            Identity.formGrant(identity.origin).execute(grant),
          ).pipe(
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.result,
          );
          expectTransportError(quiet);
          const proxied = Identity.formGrant(proxyBase(identity.origin));
          const tokens = yield* fetched(proxied.execute(grant));
          if (tokens._tag !== "Tokens")
            throw new Error(`expected Tokens, got ${tokens._tag}`);
          expect(Redacted.value(tokens.accessToken)).toBe(
            fixture.identityToken,
          );
          // The withheld POST spent one of the window's two requests.
          expect(yield* fetched(proxied.execute(grant))).toEqual({
            _tag: "MessageError",
            message: "Rate limit exceeded for 10.20.0.5",
          });

          const ledger = yield* identity.ledger;
          expect(seen(ledger)).toEqual([
            "OPTIONS /oauth/token",
            "POST /oauth/token",
            "POST /oauth/token",
            "POST /oauth/token",
          ]);
          const [preflight, simple, viaProxy] = ledger;
          expect(
            header(preflight!.lines, "access-control-request-headers"),
          ).toBe("b3,traceparent");
          expect(header(simple!.lines, "origin")).toBe(page);
          expect(header(simple!.lines, "sec-fetch-site")).toBe("cross-site");
          expect(header(simple!.lines, "content-type")).toBe(
            "application/x-www-form-urlencoded",
          );
          expect(headerValues(simple!.lines, "traceparent")).toEqual([]);
          expect(bodyText(simple!)).toBe(bodyText(viaProxy!));
        }),
    );

    it.live(
      "[HDR-7b] a withheld answer is a transport error, which Policy.transient retries: every attempt of the simple POST reaches the service",
      () =>
        Effect.gen(function* () {
          const identity = yield* lane.backend(
            "identity",
            { token: fixture.identityToken, clients: [fixture.client] },
            { cors: "backend" },
          );
          // The default classification retries transport errors, and the page cannot tell a
          // request that never arrived from an answer it may not read.
          const retried = Operation.make(
            Identity.requests.formGrant(identity.origin),
            Response.status(200, Body.json),
            { policy: Policy.make(Schedule.recurs(2)) },
          );
          const result = yield* fetched(
            retried.execute({
              body: {
                grantType: "client_credentials",
                clientId: fixture.client.id,
                clientSecret: Redacted.make(fixture.client.secret),
                scope: ["directory:read"],
              },
            }),
          ).pipe(
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.result,
          );
          expectTransportError(result);
          const ledger = yield* identity.ledger;
          expect(seen(ledger)).toEqual([
            "POST /oauth/token",
            "POST /oauth/token",
            "POST /oauth/token",
          ]);
          expect(
            new Set(ledger.map((recorded) => bodyText(recorded))).size,
          ).toBe(1);
        }),
    );

    it.live(
      "[HDR-7b] one page reaches every endpoint with every hostile allowlist on: the announcement across origins without trace propagation, the rest through the proxy",
      () =>
        Effect.gen(function* () {
          yield* forgetPageCookie;
          const backend = yield* notifications({});
          // The page's routing, per endpoint: the origin each call can reach.
          const direct = notify(backend.origin);
          // Same-origin calls need no preflight, so this client keeps Effect's trace headers.
          const proxied = notify(proxyBase(backend.origin), {
            tracePropagation: true,
          });
          const crossSession = yield* included(direct.csrf.execute(undefined));
          const announced = yield* included(
            direct
              .announce()
              .execute({ csrf: crossSession, announcement: draft }),
          );
          const pageSession = yield* fetched(proxied.csrf.execute(undefined));
          const created = yield* fetched(
            proxied.subscribe.execute({ csrf: pageSession, subscription }),
          );
          const listed = yield* fetched(
            proxied.legacySubscriptions.execute(undefined),
          );
          expect(expectTag(announced, "Announced").value).toMatchObject(draft);
          expect(expectTag(created, "Created").value).toMatchObject(
            subscription,
          );
          const { headers } = expectTag(listed, "Listed").metadata;
          expect(expectTag(listed, "Listed").value.retirement).toEqual(
            retirement,
          );
          // The same-origin answer carries every header, and none that the proxy or the page's
          // server would have added for CORS: the GET sent no Origin, so the service added none.
          expect(headers["link"]).toBe(
            '</v2/subscriptions>; rel="successor-version"',
          );
          expect(
            Object.keys(headers).filter(
              (name) => name.startsWith("access-control-") || name === "vary",
            ),
          ).toEqual([]);

          const ledger = yield* backend.ledger;
          expect(seen(ledger)).toEqual([
            "GET /v2/session/csrf",
            "OPTIONS /v2/announcements",
            "POST /v2/announcements",
            "GET /v2/session/csrf",
            "POST /v2/subscriptions",
            "GET /v1/subscriptions",
          ]);
          const traces = ledger.map(
            (recorded) => headerValues(recorded.lines, "traceparent").length,
          );
          expect(traces).toEqual([0, 0, 0, 1, 1, 1]);
          expect(yield* signedOver(ledger[2]!, "/v2/announcements")).toBe(true);
          expect(cookiePairs(ledger[2]!)).toContain(xsrf(crossSession.token));
          expect(cookiePairs(ledger[4]!)).toEqual([xsrf(pageSession.token)]);
        }),
    );

    it.live(
      "[HDR-7b] the proxy removes its prefix from the target: an announcement signed over the page's path is refused, and routing after signing keeps the signature valid",
      () =>
        Effect.gen(function* () {
          yield* forgetPageCookie;
          const backend = yield* notifications({});
          const base = proxyBase(backend.origin);
          // Base URL routing: the signer sees, and signs, the page's path.
          const naive = notify(base);
          const session = yield* fetched(naive.csrf.execute(undefined));
          const refused = yield* fetched(
            naive.announce().execute({ csrf: session, announcement: draft }),
          );
          expect(expectTag(refused, "SignatureRejected").value).toEqual({
            error: { code: "signature_mismatch" },
          });
          // Transport routing as the outermost middleware: signed over the service's own path.
          const routed = notify(backend.origin).announce({
            transformClient: routeThroughProxy(backend.origin),
          });
          const announced = yield* fetched(
            routed.execute({ csrf: session, announcement: draft }),
          );
          expect(expectTag(announced, "Announced").value).toMatchObject(draft);

          const ledger = yield* backend.ledger;
          expect(seen(ledger)).toEqual([
            "GET /v2/session/csrf",
            "POST /v2/announcements",
            "POST /v2/announcements",
          ]);
          const [, signedForPage, signedForService] = ledger;
          const pagePath = `${new URL(base).pathname}/v2/announcements`;
          expect(yield* signedOver(signedForPage!, pagePath)).toBe(true);
          expect(yield* signedOver(signedForPage!, "/v2/announcements")).toBe(
            false,
          );
          expect(
            yield* signedOver(signedForService!, "/v2/announcements"),
          ).toBe(true);
          for (const recorded of [signedForPage!, signedForService!])
            expect(header(recorded.lines, "host")).toBe(
              new URL(backend.origin).host,
            );
        }),
    );
  });

  describe("TRN-1: cookies through the same-origin proxy", () => {
    it.live(
      "[TRN-1] through the proxy, Fetch's default credentials carry a SameSite=Lax cookie, which is first-party to the page",
      (context: TestContext) =>
        Effect.gen(function* () {
          yield* forgetPageCookie;
          const settings = yield* transportSettings("fetch", {
            lane: lane.name,
            route: "same-origin proxy",
            jar: "none",
            cookieHeader: "not set",
          });
          yield* Effect.promise(() =>
            context.annotate(JSON.stringify(settings), "transport"),
          );
          expect(settings.credentials).toBe(
            "unset: Fetch's default, same-origin",
          );
          expect(document.cookie).not.toContain("XSRF-TOKEN=");
          // The service's default, Lax, which never travels on a cross-site fetch.
          const backend = yield* lane.backend("notifications", {
            acceptedToken: fixture.token,
            signingSecret: fixture.secret,
            allowedOrigins: [page],
          });
          const proxied = notify(proxyBase(backend.origin));
          const session = yield* proxied.csrf.execute(undefined);
          // Set-Cookie stays hidden from scripts even on a same-origin response...
          expect(session.cookie).toBeUndefined();
          // ...but the cookie is the page's own now, readable as the double-submit pattern intends.
          expect(document.cookie.split("; ")).toContain(xsrf(session.token));
          const created = yield* proxied.subscribe.execute({
            csrf: session,
            subscription,
          });
          expectTag(created, "Created");
          const [bootstrap, post, ...rest] = yield* backend.ledger;
          expect(rest).toEqual([]);
          expect(cookiePairs(bootstrap!)).toEqual([]);
          expect(cookiePairs(post!)).toEqual([xsrf(session.token)]);
        }).pipe(Effect.provide(lane.fetchClient)),
    );
  });
});
