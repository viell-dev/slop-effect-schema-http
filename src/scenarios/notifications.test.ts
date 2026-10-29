import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Option, Ref, Schedule } from "effect";
import {
  Cookies,
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Policy, Request } from "viell-effect-schema-http";
import * as Notify from "../clients/notifications/index.js";
import {
  type Backend,
  bodyText,
  header,
  headerValues,
  type Json,
  pathOf,
  type Recorded,
} from "../harness/lane.js";

/** Fixture values, passed to the backend as options and to the consumer as configuration. */
const fixture = {
  token: "ntf_7Hq2xV9pLk4mWs8e",
  secret: "notify-signing-2016-month-end",
} as const;

/** The page's origin: the test page's own in the browser, a synthetic one in Node. */
const pageOrigin =
  lane.name === "browser"
    ? globalThis.location.origin
    : "https://app.example.test";

/**
 * The one place this file starts the service. The browser lane's page and the backend are on
 * different sites (`localhost` and a loopback address), so the XSRF cookie is issued with
 * `SameSite=None`, the service's setting for cross-site deployments, unless a test overrides it.
 */
const start = (
  options: { readonly [key: string]: Json } = {},
  cors?: "backend",
) =>
  lane.backend(
    "notifications",
    {
      acceptedToken: fixture.token,
      signingSecret: fixture.secret,
      allowedOrigins: [pageOrigin],
      csrfCookieSameSite: "None",
      ...options,
    },
    cors === undefined ? undefined : { cors },
  );

/**
 * A consumer for `backend`. The XSRF cookie travels with the transport's own cookie handling:
 * Node's fetch keeps no cookies, so Node uses an explicit jar (`HttpClient.withCookiesRef`); the
 * browser uses its cookie store, which `credentials: "include"` (see {@link viaFetch}) enables for
 * cross-origin requests.
 */
const connect = (backend: Backend, config: Partial<Notify.Config> = {}) =>
  Effect.map(Ref.make(Cookies.empty), (jar) =>
    Notify.make({
      baseUrl: backend.origin,
      token: Effect.succeed(Option.some(fixture.token)),
      secret: fixture.secret,
      csrfCookie: "transport",
      ...(lane.name === "node" ? { jar } : {}),
      ...config,
    }),
  );

/** One cookie jar for several Node clients of the same page; the browser's store is shared anyway. */
const sharedCookies = Effect.map(Ref.make(Cookies.empty), (jar) =>
  lane.name === "node" ? { jar } : {},
);

/** Effect's Fetch provider with `credentials: "include"`, which Node's fetch ignores. */
const viaFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(lane.fetchClient),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  );

const draft: Notify.AnnouncementDraft = {
  channel: "month-end",
  subject: "October close complete",
  body: "42 tasks written; extract stored.",
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

/**
 * Every `name=value` pair of a recorded request's cookies.
 */
const cookiePairs = (recorded: Recorded): ReadonlyArray<string> =>
  headerValues(recorded.lines, "cookie").flatMap((line) =>
    line.split(";").map((pair) => pair.trim()),
  );

const encoder = new TextEncoder();

const stamp = (recorded: Recorded): number =>
  Number(header(recorded.lines, "x-notify-timestamp"));

/** The test's own check of a recorded signature, independent of the client's signer. */
const signatureVerifies = (recorded: Recorded) =>
  Effect.promise(async () => {
    const timestamp = header(recorded.lines, "x-notify-timestamp") ?? "";
    const signature = header(recorded.lines, "x-notify-signature") ?? "";
    const head = encoder.encode(
      `${recorded.method}\n${pathOf(recorded)}\n${timestamp}\n`,
    );
    const message = new Uint8Array([...head, ...recorded.body]);
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
      (await crypto.subtle.verify("HMAC", key, digest, message))
    );
  });

/** The pieces of the announce request, for declarations composed in a different order. */
const announceBody = Request.body(Body.jsonSchema(Notify.AnnouncementDraft));
const csrfHeaderGroup = Request.headers(Notify.CsrfHeaders);
const announceInput = (notify: Notify.Client) =>
  Request.mapInput(
    (input: {
      readonly csrf: Notify.CsrfSession;
      readonly announcement: Notify.AnnouncementDraft;
    }) => ({
      headers: notify.csrfHeaders(input.csrf),
      body: input.announcement,
    }),
  );

/** The once-per-evaluation control: signed by a request transform, not per attempt. */
const signedOnce = (
  notify: Notify.Client,
  policy: Policy.Policy = Policy.none,
) =>
  Operation.make(
    Request.post("v2/announcements").pipe(
      csrfHeaderGroup,
      announceBody,
      announceInput(notify),
      notify.authorization,
      Request.baseUrl(notify.config.baseUrl),
      Notify.signOncePerEvaluation({
        secret: fixture.secret,
        baseUrl: notify.config.baseUrl,
      }),
    ),
    Notify.announceResponse,
    { transformClient: notify.service, policy },
  );

const retries = Policy.make(Schedule.recurs(2));

describe(`notification service (${lane.name})`, () => {
  describe("double-submit CSRF", () => {
    it.live(
      "[AUTH-5] fetches the token first and echoes it, with the cookie carried by the transport's own cookie handling",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const jar = yield* Ref.make(Cookies.empty);
          const notify = yield* connect(
            backend,
            lane.name === "node" ? { jar } : {},
          );
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          // The token arrives in the body; the cookie value is the same token, percent-encoded.
          expect(session.token).toMatch(/^[A-Za-z0-9+/]{22}==$/);
          if (lane.name === "node") {
            // Node's fetch shows Set-Cookie to the consumer, and the explicit jar keeps it.
            expect(session.cookie).toBe(encodeURIComponent(session.token));
            const kept = Option.getOrUndefined(
              Cookies.get(yield* Ref.get(jar), "XSRF-TOKEN"),
            );
            expect(kept?.valueEncoded).toBe(session.cookie);
          } else {
            // A browser hides Set-Cookie from scripts; its own store keeps the cookie.
            expect(session.cookie).toBeUndefined();
          }
          const created = yield* viaFetch(
            notify.subscribe.execute({
              csrf: session,
              subscription: {
                channel: "month-end",
                address: "close@example.test",
              },
            }),
          );
          expect(expectTag(created, "Created").value).toEqual({
            id: "sub_3",
            channel: "month-end",
            address: "close@example.test",
          });
          const [bootstrap, post, ...rest] = yield* backend.ledger;
          expect(rest).toEqual([]);
          expect([bootstrap?.method, bootstrap?.target]).toEqual([
            "GET",
            "/v2/session/csrf",
          ]);
          if (lane.name === "node")
            expect(headerValues(bootstrap!.lines, "cookie")).toEqual([]);
          expect([post?.method, post?.target]).toEqual([
            "POST",
            "/v2/subscriptions",
          ]);
          // Both lanes send the cookie as the server set it, and the decoded token in the header.
          const xsrf = cookiePairs(post!).filter((pair) =>
            pair.startsWith("XSRF-TOKEN="),
          );
          expect(xsrf).toEqual([
            `XSRF-TOKEN=${encodeURIComponent(session.token)}`,
          ]);
          expect(headerValues(post!.lines, "x-xsrf-token")).toEqual([
            session.token,
          ]);
          expect(headerValues(post!.lines, "authorization")).toEqual([
            `Token token="${fixture.token}"`,
          ]);
          expect(bodyText(post!)).toBe(
            '{"channel":"month-end","address":"close@example.test"}',
          );
        }),
    );

    it.live(
      "[AUTH-5] a SameSite=Lax cookie never returns to a cross-site page, while Node's explicit jar ignores SameSite",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({ csrfCookieSameSite: "Lax" });
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const result = yield* viaFetch(
            notify.subscribe.execute({
              csrf: session,
              subscription: { channel: "billing", address: "a@example.test" },
            }),
          );
          const [, post] = yield* backend.ledger;
          const issued = `XSRF-TOKEN=${encodeURIComponent(session.token)}`;
          if (lane.name === "node") {
            // Effect's cookie jar is not a browser: it sends the Lax cookie back regardless.
            expectTag(result, "Created");
            expect(cookiePairs(post!)).toEqual([issued]);
          } else {
            // Chromium refuses to store a Lax cookie from a cross-site response. Each backend has
            // its own loopback address, so no cookie from another test can ride along either.
            expect(cookiePairs(post!)).toEqual([]);
            expect(expectTag(result, "CsrfRejected").value).toBe(
              "cookie-missing",
            );
          }
        }),
    );

    it.live(
      "[AUTH-5] a Cookie header set by hand reaches the service from Node and is dropped by the browser",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          // By hand, with no jar and Fetch's default credentials ("same-origin").
          const notify = yield* connect(backend, {
            csrfCookie: "by-hand",
            jar: undefined,
          });
          const issued = yield* notify.csrf
            .execute(undefined)
            .pipe(Effect.provide(lane.fetchClient));
          // A browser script never sees Set-Cookie, so it can only rebuild the cookie value.
          const session = {
            token: issued.token,
            cookie: issued.cookie ?? encodeURIComponent(issued.token),
          };
          const result = yield* notify.subscribe
            .execute({
              csrf: session,
              subscription: { channel: "billing", address: "a@example.test" },
            })
            .pipe(Effect.provide(lane.fetchClient));
          const [, post] = yield* backend.ledger;
          if (lane.name === "node") {
            expectTag(result, "Created");
            expect(headerValues(post!.lines, "cookie")).toEqual([
              `XSRF-TOKEN=${session.cookie}`,
            ]);
          } else {
            // `Cookie` is a forbidden request header: the browser drops it without an error.
            expect(expectTag(result, "CsrfRejected").value).toBe(
              "cookie-missing",
            );
            expect(headerValues(post!.lines, "cookie")).toEqual([]);
          }
        }),
    );

    it.live(
      "[AUTH-5] echoing the cookie's percent-encoded spelling instead of the body token is refused as incorrect",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const result = yield* viaFetch(
            notify.subscribe.execute({
              csrf: { token: encodeURIComponent(session.token) },
              subscription: { channel: "billing", address: "a@example.test" },
            }),
          );
          expect(expectTag(result, "CsrfRejected").value).toBe(
            "token-incorrect",
          );
          const [, post] = yield* backend.ledger;
          expect(header(post!.lines, "x-xsrf-token")).toMatch(/%3D%3D$/);
        }),
    );
  });

  describe("HMAC-signed announcements", () => {
    it.live(
      "[AUTH-6] signs each attempt in client middleware after body encoding, over method, path, timestamp and the exact body bytes",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const before = Date.now();
          const result = yield* viaFetch(
            notify.announce().execute({ csrf: session, announcement: draft }),
          );
          const after = Date.now();
          expect(expectTag(result, "Announced").value).toMatchObject({
            id: "ann_1",
            ...draft,
          });
          const [, post, ...rest] = yield* backend.ledger;
          expect(rest).toEqual([]);
          expect([post?.method, post?.target]).toEqual([
            "POST",
            "/v2/announcements",
          ]);
          expect(bodyText(post!)).toBe(JSON.stringify(draft));
          expect(header(post!.lines, "content-type")).toBe("application/json");
          const stamped = Number(header(post!.lines, "x-notify-timestamp"));
          expect(stamped).toBeGreaterThanOrEqual(before);
          expect(stamped).toBeLessThanOrEqual(after);
          expect(yield* signatureVerifies(post!)).toBe(true);
          // Trace propagation is off for this service (its preflight refuses the headers).
          expect(headerValues(post!.lines, "traceparent")).toEqual([]);
          expect(headerValues(post!.lines, "b3")).toEqual([]);
          const listed = yield* viaFetch(
            notify.announcements.execute(undefined),
          );
          expect(
            expectTag(listed, "Listed").value.announcements.map(
              (announcement) => announcement.id,
            ),
          ).toEqual(["ann_1"]);
        }),
    );

    it.live(
      "[AUTH-6] the signature does not depend on where the body sits in the declaration pipeline",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const signed = Notify.signAttempts({ secret: fixture.secret });
          const operation = <I, E, R>(
            declaration: Request.Request<I, E, R, true, false>,
          ) =>
            Operation.make(declaration, Notify.announceResponse, {
              transformClient: (client) => signed(notify.service(client)),
            });
          const bodyFirst = Request.post("v2/announcements").pipe(
            announceBody,
            csrfHeaderGroup,
            announceInput(notify),
            notify.authorization,
            Request.baseUrl(backend.origin),
          );
          const bodyLast = Request.post("v2/announcements").pipe(
            Request.baseUrl(backend.origin),
            notify.authorization,
            csrfHeaderGroup,
            announceBody,
            announceInput(notify),
          );
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          for (const declaration of [bodyFirst, bodyLast])
            expectTag(
              yield* viaFetch(
                operation(declaration).execute({
                  csrf: session,
                  announcement: draft,
                }),
              ),
              "Announced",
            );
          const [, first, last] = yield* backend.ledger;
          expect(first!.body).toEqual(last!.body);
          expect(yield* signatureVerifies(first!)).toBe(true);
          expect(yield* signatureVerifies(last!)).toBe(true);
        }),
    );

    it.live(
      "[AUTH-6] once-per-evaluation signing depends on its position: before the body it signs an empty body",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const early = Operation.make(
            Request.post("v2/announcements").pipe(
              Notify.signOncePerEvaluation({
                secret: fixture.secret,
                baseUrl: backend.origin,
              }),
              csrfHeaderGroup,
              announceBody,
              announceInput(notify),
              notify.authorization,
              Request.baseUrl(backend.origin),
            ),
            Notify.announceResponse,
            { transformClient: notify.service },
          );
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const input = { csrf: session, announcement: draft };
          const refused = yield* viaFetch(early.execute(input));
          expect(expectTag(refused, "SignatureRejected").value.error.code).toBe(
            "signature_mismatch",
          );
          // Placed after the body, the same transform succeeds on a single attempt.
          expectTag(
            yield* viaFetch(signedOnce(notify).execute(input)),
            "Announced",
          );
          const [, earlyPost, latePost] = yield* backend.ledger;
          expect(bodyText(earlyPost!)).toBe(JSON.stringify(draft));
          expect(yield* signatureVerifies(earlyPost!)).toBe(false);
          expect(yield* signatureVerifies(latePost!)).toBe(true);
        }),
    );

    it.live(
      "[AUTH-6] a retry after a 503 with Retry-After re-signs the attempt beyond the validity window",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({
            windowMs: 500,
            announce: { unavailable: { times: 1, retryAfter: "1" } },
          });
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const result = yield* viaFetch(
            notify
              .announce({ policy: retries })
              .execute({ csrf: session, announcement: draft }),
          );
          expectTag(result, "Announced");
          const [, first, second, ...rest] = yield* backend.ledger;
          expect(rest).toEqual([]);
          // Retry-After held the retry for a second, twice the window, and it was signed afresh.
          expect(stamp(second!) - stamp(first!)).toBeGreaterThanOrEqual(1000);
          expect(header(second!.lines, "x-notify-signature")).not.toBe(
            header(first!.lines, "x-notify-signature"),
          );
          expect(second!.body).toEqual(first!.body);
          expect(yield* signatureVerifies(first!)).toBe(true);
          expect(yield* signatureVerifies(second!)).toBe(true);
        }),
    );

    it.live(
      "[AUTH-6] once-per-evaluation signing replays its signature on an immediate retry, refused as replayed",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({
            announce: { unavailable: { times: 1 } },
          });
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const result = yield* viaFetch(
            signedOnce(notify, retries).execute({
              csrf: session,
              announcement: draft,
            }),
          );
          expect(expectTag(result, "SignatureRejected").value.error.code).toBe(
            "signature_replayed",
          );
          const [, first, second, ...rest] = yield* backend.ledger;
          expect(rest).toEqual([]);
          for (const name of ["x-notify-timestamp", "x-notify-signature"])
            expect(header(second!.lines, name)).toBe(
              header(first!.lines, name),
            );
          const listed = yield* viaFetch(
            notify.announcements.execute(undefined),
          );
          expect(expectTag(listed, "Listed").value.announcements).toEqual([]);
        }),
    );

    it.live(
      "[AUTH-6] once-per-evaluation signing goes stale when the retry waits out the window",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({
            windowMs: 500,
            announce: { unavailable: { times: 1, retryAfter: "1" } },
          });
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const result = yield* viaFetch(
            signedOnce(notify, retries).execute({
              csrf: session,
              announcement: draft,
            }),
          );
          const { error } = expectTag(result, "SignatureRejected").value;
          if (error.code !== "timestamp_out_of_window")
            throw new Error(`expected a stale timestamp, got ${error.code}`);
          const [, first, second] = yield* backend.ledger;
          const stamped = Number(header(second!.lines, "x-notify-timestamp"));
          expect(header(first!.lines, "x-notify-timestamp")).toBe(
            String(stamped),
          );
          expect(error.windowMs).toBe(500);
          expect(error.serverTime - stamped).toBeGreaterThan(500);
        }),
    );

    it.live(
      "[AUTH-6] a tampered body, a stale timestamp and a missing CSRF token are three distinct typed responses",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const input = { csrf: session, announcement: draft };
          // Middleware after the signer rewrites the body, as a meddling proxy would.
          const tampered = yield* viaFetch(
            notify
              .announce({
                transformClient: HttpClient.mapRequest((request) =>
                  HttpClientRequest.setBody(
                    request,
                    HttpBody.text(
                      JSON.stringify({ ...draft, subject: "Close FAILED" }),
                      "application/json",
                    ),
                  ),
                ),
              })
              .execute(input),
          );
          // @ts-expect-error The result is a union: narrow it before reading a signature failure.
          void tampered.value.error;
          // The same client against a service whose clock runs ten minutes ahead.
          const skewed = yield* start({ clockOffsetMs: 600_000 });
          const skewedClient = yield* connect(skewed);
          const stale = yield* viaFetch(
            skewedClient.announce().execute({
              csrf: yield* viaFetch(skewedClient.csrf.execute(undefined)),
              announcement: draft,
            }),
          );
          // A declaration that forgot the CSRF header; the transport still carries the cookie.
          const missing = yield* viaFetch(
            Operation.make(
              Request.post("v2/announcements").pipe(
                announceBody,
                Request.mapInput(
                  (given: {
                    readonly announcement: Notify.AnnouncementDraft;
                  }) => ({
                    body: given.announcement,
                  }),
                ),
                notify.authorization,
                Request.baseUrl(backend.origin),
              ),
              Notify.announceResponse,
              {
                transformClient: (client) =>
                  Notify.signAttempts({ secret: fixture.secret })(
                    notify.service(client),
                  ),
              },
            ).execute({ announcement: draft }),
          );
          expect(
            expectTag(tampered, "SignatureRejected").value.error.code,
          ).toBe("signature_mismatch");
          expect(expectTag(stale, "SignatureRejected").value.error.code).toBe(
            "timestamp_out_of_window",
          );
          expect(expectTag(missing, "CsrfRejected").value).toBe(
            "token-missing",
          );
          const [, tamperedPost, missingPost] = yield* backend.ledger;
          expect(bodyText(tamperedPost!)).toContain("Close FAILED");
          expect(headerValues(missingPost!.lines, "x-xsrf-token")).toEqual([]);
          expect(
            cookiePairs(missingPost!).filter((pair) =>
              pair.startsWith("XSRF-TOKEN="),
            ),
          ).toHaveLength(1);
        }),
    );

    it.live(
      "[AUTH-6] a refused Token credential is its own typed response, selected by its challenge ahead of the plain 401 rule",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          // Three clients of one page share its cookies: one jar in Node, the store in a browser.
          const shared = yield* sharedCookies;
          const wrong = yield* connect(backend, {
            ...shared,
            token: Effect.succeed(Option.some("ntf_revoked")),
          });
          const session = yield* viaFetch(wrong.csrf.execute(undefined));
          const input = { csrf: session, announcement: draft };
          const refused = expectTag(
            yield* viaFetch(wrong.announce().execute(input)),
            "TokenRejected",
          );
          expect(refused.value).toBe("HTTP Token: Access denied.\n");
          expect(refused.metadata.headers["www-authenticate"]).toBe(
            'Token realm="Application"',
          );
          // An absent credential omits the header rather than sending "undefined".
          const absent = yield* connect(backend, {
            ...shared,
            token: Effect.succeed(Option.none()),
          });
          expectTag(
            yield* viaFetch(absent.announce().execute(input)),
            "TokenRejected",
          );
          // A token that cannot be written as a quoted value fails before dispatch.
          const unsafe = yield* connect(backend, {
            ...shared,
            token: Effect.succeed(Option.some('ntf_"quoted"')),
          });
          const error = yield* viaFetch(unsafe.announce().execute(input)).pipe(
            Effect.flip,
          );
          expect(error._tag).toBe("SchemaError");
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(3);
          expect(headerValues(ledger[1]!.lines, "authorization")).toEqual([
            'Token token="ntf_revoked"',
          ]);
          expect(headerValues(ledger[2]!.lines, "authorization")).toEqual([]);
          expect(
            ledger.some((recorded) =>
              recorded.lines.some(([, value]) => value.includes("undefined")),
            ),
          ).toBe(false);
        }),
    );

    it.live(
      "[AUTH-6] an empty subject is refused before dispatch; a blank one reaches the service and is refused there",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const error = yield* viaFetch(
            notify.announce().execute({
              csrf: session,
              announcement: { ...draft, subject: "" },
            }),
          ).pipe(Effect.flip);
          expect(error._tag).toBe("SchemaError");
          expect(yield* backend.ledger).toHaveLength(1);
          const blank = yield* viaFetch(
            notify.announce().execute({
              csrf: session,
              announcement: { ...draft, subject: "   " },
            }),
          );
          expect(expectTag(blank, "Invalid").value.error).toEqual({
            code: "invalid_announcement",
            field: "subject",
          });
          expect(yield* backend.ledger).toHaveLength(2);
        }),
    );

    it.live(
      "[AUTH-6] a held announcement under a caller's timeout fails as a TimeoutError; the service sees the abort and records nothing",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({ announce: { holdMs: 5000 } });
          const notify = yield* connect(backend);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const error = yield* viaFetch(
            notify.announce().execute({ csrf: session, announcement: draft }),
          ).pipe(Effect.timeout("300 millis"), Effect.flip);
          expect(Cause.isTimeoutError(error)).toBe(true);
          yield* backend.arrived(2);
          const aborted = yield* backend.ledger.pipe(
            Effect.map((ledger) => ledger[1]?.aborted === true),
            Effect.repeat({
              schedule: Schedule.spaced("25 millis"),
              until: (seen) => seen,
              times: 120,
            }),
          );
          expect(aborted).toBe(true);
          const listed = yield* viaFetch(
            notify.announcements.execute(undefined),
          );
          expect(expectTag(listed, "Listed").value.announcements).toEqual([]);
        }),
    );

    it.live(
      "[AUTH-6] the failure points: an unretried 503 and a 500 page are unexpected responses, a frozen channel is a typed refusal",
      () =>
        Effect.gen(function* () {
          const outcome = (options: { readonly [key: string]: Json }) =>
            Effect.gen(function* () {
              const backend = yield* start({ announce: options });
              const notify = yield* connect(backend);
              const session = yield* viaFetch(notify.csrf.execute(undefined));
              const result = yield* viaFetch(
                notify
                  .announce()
                  .execute({ csrf: session, announcement: draft }),
              ).pipe(Effect.result);
              const listed = yield* viaFetch(
                notify.announcements.execute(undefined),
              );
              expect(expectTag(listed, "Listed").value.announcements).toEqual(
                [],
              );
              expect(yield* backend.ledger).toHaveLength(3);
              return result;
            });
          const unavailable = yield* outcome({
            unavailable: { times: 1, retryAfter: "1" },
          });
          const failed = yield* outcome({ fail: "error" });
          const frozen = yield* outcome({ fail: "frozen" });
          for (const [result, status] of [
            [unavailable, 503],
            [failed, 500],
          ] as const) {
            if (result._tag !== "Failure")
              throw new Error("expected an unexpected response");
            const error = result.failure;
            if (error._tag !== "UnexpectedResponse")
              throw new Error(`expected UnexpectedResponse, got ${error._tag}`);
            expect(error.metadata.status).toBe(status);
          }
          if (frozen._tag !== "Success")
            throw new Error("expected a typed refusal");
          expect(expectTag(frozen.success, "Frozen").value.error).toEqual({
            code: "channel_frozen",
            channel: "month-end",
          });
        }),
    );
  });

  describe("retirement headers", () => {
    it.live(
      "[HDR-4] reads Deprecation, Sunset and both Warning values from one response through a header schema",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const listed = expectTag(
            yield* viaFetch(notify.legacySubscriptions.execute(undefined)),
            "Listed",
          );
          expect(listed.value.retirement).toEqual({
            deprecation: new Date("2025-12-31T23:59:59Z"),
            sunset: new Date("2027-01-31T23:59:59Z"),
            // The Warning text still names the first planned date; Sunset has the agreed one.
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
          });
          expect(listed.value.value.subscriptions.map(({ id }) => id)).toEqual([
            "sub_1",
            "sub_2",
          ]);
          // Fetch joins the two Warning lines into one normalized value and reports no lines.
          expect(listed.metadata.headers["warning"]).toContain('", 299 ');
          expect(Option.isNone(listed.metadata.headerLines)).toBe(true);
          const [get] = yield* backend.ledger;
          expect([get?.method, get?.target]).toEqual([
            "GET",
            "/v1/subscriptions",
          ]);
        }),
    );

    it.live(
      "[HDR-4] the draft-era `Deprecation: true` fails the strict header schema as a DecodeError",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const notify = yield* connect(backend);
          const error = yield* viaFetch(
            notify.legacyChannels.execute(undefined),
          ).pipe(Effect.flip);
          if (error._tag !== "DecodeError")
            throw new Error(`expected DecodeError, got ${error._tag}`);
          expect(error.metadata.status).toBe(200);
          expect(error.metadata.headers["deprecation"]).toBe("true");
          expect(String(error.cause)).toContain("Structured Field Date");
          expect(yield* backend.ledger).toHaveLength(1);
        }),
    );

    it.live(
      "[HDR-4] under the service's own CORS, a page can read only Warning, so the header schema fails there",
      () =>
        Effect.gen(function* () {
          // The v1 preflight must reach the application for the request to be sent at all.
          const backend = yield* start(
            { cors: { v1ContainerOptions: false } },
            "backend",
          );
          const notify = yield* connect(backend);
          const result = yield* viaFetch(
            notify.legacySubscriptions.execute(undefined),
          ).pipe(Effect.result);
          if (lane.name === "node") {
            // Node exposes every response header.
            if (result._tag !== "Success") throw new Error("expected success");
            expectTag(result.success, "Listed");
          } else {
            // `Access-Control-Expose-Headers: Warning` hides Deprecation and Sunset from the page.
            if (result._tag !== "Failure") throw new Error("expected failure");
            const error = result.failure;
            if (error._tag !== "DecodeError")
              throw new Error(`expected DecodeError, got ${error._tag}`);
            expect(error.metadata.headers["deprecation"]).toBeUndefined();
            expect(error.metadata.headers["warning"]).toBeDefined();
          }
          const ledger = yield* backend.ledger;
          expect(ledger.map(({ method }) => method)).toEqual(
            lane.name === "node" ? ["GET"] : ["OPTIONS", "GET"],
          );
        }),
    );
  });

  describe("CORS allowlists", () => {
    it.live(
      "[HDR-7a] the service's own CORS answers decide what a page may send; Node sends everything unchecked",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({}, "backend");
          // Two clients of one page: one with Effect's default trace propagation, one without.
          const shared = yield* sharedCookies;
          const notify = yield* connect(backend, shared);
          const traced = yield* connect(backend, {
            ...shared,
            tracePropagation: true,
          });
          const attempt = <A, E>(
            effect: Effect.Effect<A, E, HttpClient.HttpClient>,
          ) => viaFetch(effect).pipe(Effect.result);
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          const subscribed = yield* attempt(
            notify.subscribe.execute({
              csrf: session,
              subscription: { channel: "billing", address: "a@example.test" },
            }),
          );
          const quiet = yield* attempt(
            notify.announce().execute({ csrf: session, announcement: draft }),
          );
          const loud = yield* attempt(
            traced.announce().execute({ csrf: session, announcement: draft }),
          );
          const legacy = yield* attempt(
            notify.legacySubscriptions.execute(undefined),
          );
          // Without trace propagation, the announcement passes the strict filter in both lanes.
          expect(quiet._tag).toBe("Success");
          const ledger = yield* backend.ledger;
          const seen = ledger.map(
            (recorded) => `${recorded.method} ${recorded.target}`,
          );
          if (lane.name === "node") {
            for (const result of [subscribed, loud, legacy])
              expect(result._tag).toBe("Success");
            expect(seen).toEqual([
              "GET /v2/session/csrf",
              "POST /v2/subscriptions",
              "POST /v2/announcements",
              "POST /v2/announcements",
              "GET /v1/subscriptions",
            ]);
            // The traced client's announcement carried both trace headers; the quiet one neither.
            expect(headerValues(ledger[3]!.lines, "traceparent")).toHaveLength(
              1,
            );
            expect(headerValues(ledger[3]!.lines, "b3")).toHaveLength(1);
            expect(headerValues(ledger[2]!.lines, "traceparent")).toEqual([]);
          } else {
            // Each blocked request fails as a transport error after its preflight; nothing follows.
            for (const result of [subscribed, loud, legacy]) {
              if (result._tag !== "Failure")
                throw new Error("expected failure");
              const error = result.failure;
              expect(error._tag).toBe("HttpClientError");
              if (error._tag === "HttpClientError")
                expect(error.reason._tag).toBe("TransportError");
            }
            expect(seen).toEqual([
              "GET /v2/session/csrf",
              "OPTIONS /v2/subscriptions",
              "OPTIONS /v2/announcements",
              "POST /v2/announcements",
              "OPTIONS /v2/announcements",
              "OPTIONS /v1/subscriptions",
            ]);
            const requested = (index: number) =>
              header(ledger[index]!.lines, "access-control-request-headers");
            expect(requested(1)).toBe(
              "authorization,content-type,x-xsrf-token",
            );
            expect(requested(2)).toBe(
              "authorization,content-type,x-notify-signature,x-notify-timestamp,x-xsrf-token",
            );
            expect(requested(4)).toBe(
              "authorization,b3,content-type,traceparent,x-notify-signature,x-notify-timestamp,x-xsrf-token",
            );
          }
        }),
    );

    it.live(
      "[HDR-7a] with each hostile CORS behaviour switched off, a page reaches every endpoint",
      () =>
        Effect.gen(function* () {
          const backend = yield* start(
            {
              cors: {
                subscriptionsOmitContentType: false,
                strictAnnouncements: false,
                v1ContainerOptions: false,
                v1ExposeWarningOnly: false,
              },
            },
            "backend",
          );
          // Trace propagation only where the switched-off filter lists the trace headers.
          const shared = yield* sharedCookies;
          const notify = yield* connect(backend, shared);
          const traced = yield* connect(backend, {
            ...shared,
            tracePropagation: true,
          });
          const session = yield* viaFetch(notify.csrf.execute(undefined));
          expectTag(
            yield* viaFetch(
              notify.subscribe.execute({
                csrf: session,
                subscription: { channel: "billing", address: "a@example.test" },
              }),
            ),
            "Created",
          );
          expectTag(
            yield* viaFetch(
              traced.announce().execute({ csrf: session, announcement: draft }),
            ),
            "Announced",
          );
          const listed = expectTag(
            yield* viaFetch(notify.legacySubscriptions.execute(undefined)),
            "Listed",
          );
          expect(listed.value.retirement.sunset).toEqual(
            new Date("2027-01-31T23:59:59Z"),
          );
          const posts = (yield* backend.ledger).filter(
            ({ method }) => method !== "OPTIONS",
          );
          expect(posts.map(({ target }) => target)).toEqual([
            "/v2/session/csrf",
            "/v2/subscriptions",
            "/v2/announcements",
            "/v1/subscriptions",
          ]);
          expect(headerValues(posts[2]!.lines, "traceparent")).toHaveLength(1);
        }),
    );
  });
});
