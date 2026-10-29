/**
 * Node-only notification scenarios. They need the line-preserving `node:http` provider, or headers a
 * browser forbids scripts to set (`Cookie`, `Origin`, `Access-Control-Request-*`), to show what
 * the service answers when a client controls every line. A browser sends its own preflights and
 * never shows their answers to the page; the two-lane file covers what a browser enforces.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import type { HttpClient } from "effect/http";
import { lane } from "#lane";
import * as Notify from "../clients/notifications/index.js";
import { WarningList } from "../values/notifications.js";
import {
  type Backend,
  header,
  headerValues,
  type Json,
  type Recorded,
} from "../harness/lane.js";

const fixture = {
  token: "ntf_7Hq2xV9pLk4mWs8e",
  secret: "notify-signing-2016-month-end",
  origin: "https://app.example.test",
} as const;

/** The one place this file starts the service. */
const start = (options: { readonly [key: string]: Json } = {}) =>
  lane.backend("notifications", {
    acceptedToken: fixture.token,
    signingSecret: fixture.secret,
    allowedOrigins: [fixture.origin],
    ...options,
  });

/** A Node consumer that sets the XSRF cookie by hand and keeps no cookie jar. */
const connect = (backend: Backend, config: Partial<Notify.Config> = {}) =>
  Notify.make({
    baseUrl: backend.origin,
    token: Effect.succeed(Option.some(fixture.token)),
    secret: fixture.secret,
    csrfCookie: "by-hand",
    ...config,
  });

const lines: Layer.Layer<HttpClient.HttpClient> = (() => {
  if (lane.linesClient === undefined)
    throw new Error("the line-preserving provider exists only in Node");
  return lane.linesClient;
})();

const draft: Notify.AnnouncementDraft = {
  channel: "month-end",
  subject: "October close complete",
  body: "42 tasks written; extract stored.",
};

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

/** Send the preflight a browser would send for `headers`, and predict the browser's verdict. */
const preflight = (
  notify: Notify.Client,
  path: string,
  method: string,
  headers: ReadonlyArray<string>,
) =>
  Effect.map(
    notify.preflight
      .execute({
        path,
        preflight: { origin: fixture.origin, method, headers },
      })
      .pipe(Effect.provide(lines)),
    (answer) => ({
      ...answer,
      verdict: Notify.Cors.verdict(answer.status, answer.answer, {
        origin: fixture.origin,
        method,
        headers,
        credentials: true,
      }),
    }),
  );

const last = (ledger: ReadonlyArray<Recorded>): Recorded => {
  const recorded = ledger.at(-1);
  if (recorded === undefined) throw new Error("empty ledger");
  return recorded;
};

describe("notification service (node only)", () => {
  it.live(
    "[AUTH-5] the lines provider sends a hand-set Cookie line verbatim and keeps no cookies; a pair the service never issued is refused",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const notify = connect(backend);
        const session = yield* notify.csrf
          .execute(undefined)
          .pipe(Effect.provide(lines));
        // The provider reports the Set-Cookie line, and the consumer reads it as set.
        expect(session.cookie).toBe(encodeURIComponent(session.token));
        const subscription = {
          channel: "month-end",
          address: "close@example.test",
        };
        expectTag(
          yield* notify.subscribe
            .execute({ csrf: session, subscription })
            .pipe(Effect.provide(lines)),
          "Created",
        );
        // A consistent pair the service never issued: cookie and header agree, and still fail.
        const forged = yield* notify.subscribe
          .execute({
            csrf: {
              token: "Zm9yZ2VkLXRva2VuLTEyMw==",
              cookie: "Zm9yZ2VkLXRva2VuLTEyMw%3D%3D",
            },
            subscription,
          })
          .pipe(Effect.provide(lines));
        expect(expectTag(forged, "CsrfRejected").value).toBe(
          "token-unrecognised",
        );
        const [bootstrap, post, forgedPost] = yield* backend.ledger;
        expect(headerValues(bootstrap!.lines, "cookie")).toEqual([]);
        // The library's lines go out as declared: spelling, order, one Cookie line.
        expect(
          post!.lines
            .map(([name]) => name)
            .filter((name) => name !== "host" && name !== "Connection"),
        ).toEqual([
          "X-XSRF-TOKEN",
          "Cookie",
          "content-type",
          "content-length",
          "authorization",
          "accept",
        ]);
        expect(headerValues(post!.lines, "Cookie")).toEqual([
          `XSRF-TOKEN=${session.cookie}`,
        ]);
        expect(header(forgedPost!.lines, "cookie")).toBe(
          "XSRF-TOKEN=Zm9yZ2VkLXRva2VuLTEyMw%3D%3D",
        );
      }),
  );

  it.live(
    "[HDR-4] the lines provider reports both Warning lines, which the normalized header map joins",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const listed = expectTag(
          yield* connect(backend)
            .legacySubscriptions.execute(undefined)
            .pipe(Effect.provide(lines)),
          "Listed",
        );
        const observed = Option.getOrThrow(listed.metadata.headerLines);
        const warnings = observed
          .filter(([name]) => name.toLowerCase() === "warning")
          .map(([, value]) => value);
        expect(warnings).toHaveLength(2);
        expect(listed.metadata.headers["warning"]).toBe(warnings.join(", "));
        // Each line decodes on its own to the same values the joined field yields.
        const decode = Schema.decodeUnknownSync(WarningList);
        expect(warnings.flatMap((line) => decode(line))).toEqual(
          listed.value.retirement.warning,
        );
        expect(
          observed.filter(([name]) =>
            ["deprecation", "sunset"].includes(name.toLowerCase()),
          ),
        ).toEqual([
          ["Deprecation", "@1767225599"],
          ["Sunset", "Sun, 31 Jan 2027 23:59:59 GMT"],
        ]);
      }),
  );

  it.live(
    "[HDR-7a] the subscriptions preflight omits Content-Type: a browser would refuse the JSON POST that Node sends unchecked",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const notify = connect(backend);
        const session = yield* notify.csrf
          .execute(undefined)
          .pipe(Effect.provide(lines));
        expectTag(
          yield* notify.subscribe
            .execute({
              csrf: session,
              subscription: { channel: "billing", address: "a@example.test" },
            })
            .pipe(Effect.provide(lines)),
          "Created",
        );
        // The headers a browser would list for the request Node just sent.
        const requested = Notify.Cors.requestedHeaders(
          last(yield* backend.ledger).lines,
        );
        expect(requested).toEqual([
          "authorization",
          "content-type",
          "x-xsrf-token",
        ]);
        const answer = yield* preflight(
          notify,
          "v2/subscriptions",
          "POST",
          requested,
        );
        expect(answer.status).toBe(204);
        expect(answer.answer).toEqual({
          allowOrigin: fixture.origin,
          allowCredentials: "true",
          allowMethods: ["GET", "POST", "OPTIONS"],
          allowHeaders: ["Authorization", "X-XSRF-TOKEN", "X-Requested-With"],
        });
        expect(answer.verdict).toEqual({
          allowed: false,
          reasons: ["header content-type not allowed"],
        });
        const sent = last(yield* backend.ledger);
        expect([sent.method, sent.target]).toEqual([
          "OPTIONS",
          "/v2/subscriptions",
        ]);
        expect(header(sent.lines, "Origin")).toBe(fixture.origin);
        expect(header(sent.lines, "Access-Control-Request-Method")).toBe(
          "POST",
        );
        expect(header(sent.lines, "Access-Control-Request-Headers")).toBe(
          "authorization,content-type,x-xsrf-token",
        );
        // Switched off for the browser lane, the same preflight is allowed.
        const relaxed = yield* start({
          cors: { subscriptionsOmitContentType: false },
        });
        const allowed = yield* preflight(
          connect(relaxed),
          "v2/subscriptions",
          "POST",
          requested,
        );
        expect(allowed.verdict).toEqual({ allowed: true, reasons: [] });
      }),
  );

  it.live(
    "[HDR-7a] the announcement preflight refuses trace headers; disabling propagation for this service removes them",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const traced = connect(backend, { tracePropagation: true });
        const quiet = connect(backend);
        const session = yield* quiet.csrf
          .execute(undefined)
          .pipe(Effect.provide(lines));
        const requestedBy = (notify: Notify.Client) =>
          Effect.gen(function* () {
            expectTag(
              yield* notify
                .announce()
                .execute({ csrf: session, announcement: draft })
                .pipe(Effect.provide(lines)),
              "Announced",
            );
            return Notify.Cors.requestedHeaders(
              last(yield* backend.ledger).lines,
            );
          });
        const withTraces = yield* requestedBy(traced);
        const withoutTraces = yield* requestedBy(quiet);
        expect(withTraces).toEqual([
          "authorization",
          "b3",
          "content-type",
          "traceparent",
          "x-notify-signature",
          "x-notify-timestamp",
          "x-xsrf-token",
        ]);
        expect(withoutTraces).toEqual(
          withTraces.filter((name) => name !== "b3" && name !== "traceparent"),
        );
        const refused = yield* preflight(
          quiet,
          "v2/announcements",
          "POST",
          withTraces,
        );
        expect(refused.status).toBe(403);
        expect(refused.text).toBe('CORS request header "b3" is not allowed\n');
        expect(refused.answer).toEqual({});
        expect(refused.verdict.allowed).toBe(false);
        expect(refused.verdict.reasons).toContain(
          "preflight status 403 is not ok",
        );
        const allowed = yield* preflight(
          quiet,
          "v2/announcements",
          "POST",
          withoutTraces,
        );
        expect(allowed.status).toBe(204);
        expect(allowed.verdict).toEqual({ allowed: true, reasons: [] });
        // Switched off, the filter lists the trace headers instead of refusing them.
        const relaxed = yield* start({ cors: { strictAnnouncements: false } });
        const listed = yield* preflight(
          connect(relaxed),
          "v2/announcements",
          "POST",
          withTraces,
        );
        expect(listed.verdict).toEqual({ allowed: true, reasons: [] });
      }),
  );

  it.live(
    "[HDR-7a] v1 OPTIONS is answered by the container without the application's headers, unlike the v1 GET",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const notify = connect(backend, { origin: fixture.origin });
        const answer = yield* preflight(notify, "v1/subscriptions", "GET", [
          "authorization",
        ]);
        expect(answer.status).toBe(200);
        expect(answer.answer).toEqual({ allow: ["GET", "OPTIONS"] });
        expect(answer.text).toBe("");
        expect(answer.verdict.allowed).toBe(false);
        expect(answer.verdict.reasons).toContain(
          "no Access-Control-Allow-Origin",
        );
        // The GET itself reaches the application, which adds its CORS and retirement headers.
        const listed = expectTag(
          yield* notify.legacySubscriptions
            .execute(undefined)
            .pipe(Effect.provide(lines)),
          "Listed",
        );
        expect(
          Schema.decodeUnknownSync(Notify.CorsAnswer)(listed.metadata.headers),
        ).toEqual({
          allowOrigin: fixture.origin,
          allowCredentials: "true",
          exposeHeaders: ["Warning"],
        });
        const [options, get] = yield* backend.ledger;
        expect([options?.method, get?.method]).toEqual(["OPTIONS", "GET"]);
        expect(header(get!.lines, "origin")).toBe(fixture.origin);
        // Switched off, the CORS filter answers v1 preflights and exposes the retirement headers.
        const relaxed = yield* start({
          cors: { v1ContainerOptions: false, v1ExposeWarningOnly: false },
        });
        const relaxedClient = connect(relaxed, { origin: fixture.origin });
        const allowed = yield* preflight(
          relaxedClient,
          "v1/subscriptions",
          "GET",
          ["authorization"],
        );
        expect(allowed.verdict).toEqual({ allowed: true, reasons: [] });
        const exposed = expectTag(
          yield* relaxedClient.legacySubscriptions
            .execute(undefined)
            .pipe(Effect.provide(lines)),
          "Listed",
        );
        expect(exposed.metadata.headers["access-control-expose-headers"]).toBe(
          "Warning, Deprecation, Sunset, Link",
        );
      }),
  );
});
