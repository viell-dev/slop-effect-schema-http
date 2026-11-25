/**
 * Transport: the HTTP version and HTTPS context a request arrives with, against Warded's `version`,
 * `secured` and `unsecure` conditions and the custom host condition from Warded's guide.
 *
 * The library chooses neither: the base URL's scheme and the provider decide. So one definition
 * reaches different routes depending on where and through what it is sent, and the router must see
 * what the server stack really used. `plain` is the router under `axum::serve`, which says nothing
 * about security; `http` and `https` are the Warded Server, which says what it knows.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Request } from "viell-effect-schema-http";
import { lane } from "#lane";
import { cases, serve } from "../harness/matrix.js";
import {
  and,
  exactPath,
  get,
  head,
  host,
  or,
  post,
  route,
  secured,
  securedGetAndHead,
  securedPost,
  unsecure,
  version,
} from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";

const at = exactPath("/v");
const versions = {
  routes: [
    route("http/3", and(at, version("HTTP/3"))),
    route("http/2", and(at, version("HTTP/2"))),
    route("https", and(at, secured(true))),
    route("cleartext", and(at, unsecure(true))),
    route("unknown", at),
  ],
};

/** Strict `secured()`: without trusted context it is an error, which stops selection. */
const strict = {
  routes: [
    route("secured", and(exactPath("/s"), secured())),
    route("anything", exactPath("/s")),
    route("secured-post", and(exactPath("/p"), securedPost())),
    route("secured-read", and(exactPath("/p"), securedGetAndHead())),
    route("cleartext-post", and(exactPath("/p"), unsecure(), post())),
    route(
      "cleartext-read",
      and(exactPath("/p"), unsecure(), or(get(), head())),
    ),
  ],
};

const vhosts = {
  routes: [
    route("localhost", and(exactPath("/vhost"), host("localhost"))),
    route("loopback", and(exactPath("/vhost"), host("127.0.0.1"))),
    route("neither", exactPath("/vhost")),
  ],
};

describe("transport", () => {
  for (const { client, listener, title } of cases()) {
    it.live(
      `${title}: the route matches the version and security that arrived`,
      () =>
        Effect.gen(function* () {
          const table = yield* serve(versions);
          const sent = yield* send(
            table,
            listener,
            client,
            operation(Request.get("/v")),
            undefined,
          );
          const { seen } = only(sent);
          const expected =
            seen.version === "HTTP/3"
              ? "http/3"
              : seen.version === "HTTP/2"
                ? "http/2"
                : { plain: "unknown", http: "cleartext", https: "https" }[
                    listener
                  ];
          expect(sent.outcome).toMatchObject({ route: expected });
          expect(seen.security).toBe(
            { plain: "unknown", http: "unsecure", https: "https" }[listener],
          );
          // Each provider's choice of protocol, as measured: undici negotiates HTTP/2 over TLS, and
          // Chromium uses it for a new HTTPS origin; Node's fetch and node:http stay on HTTP/1.1.
          const http2 =
            listener === "https" &&
            (client.name === "undici" || lane.name === "browser");
          expect(seen.version).toBe(http2 ? "HTTP/2" : "HTTP/1.1");
        }).pipe(Effect.scoped),
    );

    it.live(`${title}: strict security conditions on ${listener}`, () =>
      Effect.gen(function* () {
        const table = yield* serve(strict);
        const reached = (request: Request.Request<unknown>) =>
          send(table, listener, client, operation(request), undefined).pipe(
            Effect.map((sent) => sent.outcome),
          );
        if (listener === "plain") {
          // No security context: `secured()` fails, `warded_server::app` answers 500, and the
          // route after it is never tried.
          expect(yield* reached(Request.get("/s"))).toMatchObject({
            kind: "answered",
            status: 500,
          });
          expect(yield* reached(Request.post("/p"))).toMatchObject({
            status: 500,
          });
          return;
        }
        const https = listener === "https";
        expect(yield* reached(Request.get("/s"))).toMatchObject({
          route: https ? "secured" : "anything",
        });
        expect(yield* reached(Request.post("/p"))).toMatchObject({
          route: https ? "secured-post" : "cleartext-post",
        });
        expect(yield* reached(Request.get("/p"))).toMatchObject({
          route: https ? "secured-read" : "cleartext-read",
        });
      }).pipe(Effect.scoped),
    );

    it.live(`${title}: the base URL's host is the host the route sees`, () =>
      Effect.gen(function* () {
        const table = yield* serve(vhosts);
        const origin = new URL(table.origins[listener]);
        const named = (hostname: string) =>
          send(
            table,
            listener,
            // An absolute URL bypasses the origin that `send` puts in front of the base.
            client,
            operation(
              Request.get(
                `${origin.protocol}//${hostname}:${origin.port}/vhost`,
              ),
            ),
            undefined,
          );
        expect((yield* named("localhost")).outcome).toMatchObject({
          route: "localhost",
        });
        expect((yield* named("127.0.0.1")).outcome).toMatchObject({
          route: "loopback",
        });
      }).pipe(Effect.scoped),
    );
  }
});
