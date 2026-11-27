/**
 * Parcels: the library against a hostile API built on Warded, the table in `src/apis/parcels.ts`,
 * through every provider of the lane on every listener.
 *
 * Its answers come from three layers with conventions of their own, so one status arrives in
 * several shapes and one response carries lines that only make sense apart. The judge is the
 * library's documentation: a contract selects on metadata alone, in declaration order; a selected
 * decoder's failure is final; an unconventional status is no reason to reject an answer; and the
 * metadata holds the cookies the response set, as far as the provider shows them. Each exchange
 * also keeps the request's records and the status the handler answered, which the server can
 * replace before the client sees it.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Cookies } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { lane } from "#lane";
import {
  diagnostics,
  knownParcels,
  parcels,
  sessionCookies,
} from "../apis/parcels.js";
import {
  byStatusAlone,
  cacheOf,
  diagnostic,
  getDiagnostic,
  getParcel,
  login,
  parcel,
} from "../apis/parcels-client.js";
import { type Exchange, values } from "../harness/evidence.js";
import type { Listener } from "../harness/lane.js";
import { cases, serve } from "../harness/matrix.js";
import { only, type Sent, send } from "../harness/send.js";

/**
 * The exchange that served a call. Chromium on `https` starts on HTTP/2 and moves to HTTP/3 once
 * it has learned the server's `Alt-Svc`, and at the move it can send one request over both, so
 * there the call can make two exchanges that the same route served alike.
 */
const served = (sent: Sent, listener: Listener): Exchange => {
  const context = JSON.stringify(sent);
  if (
    lane.name === "browser" &&
    listener === "https" &&
    sent.exchanges.length === 2
  ) {
    const [first, second] = sent.exchanges as [Exchange, Exchange];
    expect(first.dispatched?.route, context).toBe(second.dispatched?.route);
    expect(first.dispatched?.captures, context).toEqual(
      second.dispatched?.captures,
    );
    expect(first.status, context).toBe(second.status);
    expect(["HTTP/2", "HTTP/3"], context).toContain(first.seen.version);
    expect(["HTTP/2", "HTTP/3"], context).toContain(second.seen.version);
    return second;
  }
  return only(sent);
};

const indexOf = (name: string) =>
  parcels.routes.findIndex((candidate) => candidate.name === name);

/**
 * Check the request's records for a call that a route served: the request line on a cleartext
 * wire, the head the server saw, the route `select` chose with its captures, the handler that ran
 * with the captures the server decoded, and the status that handler answered.
 */
const expectServed = (
  sent: Sent,
  listener: Listener,
  expected: {
    readonly route: string;
    readonly path: string;
    readonly status: number;
    readonly captures?: Readonly<Record<string, string>>;
    readonly method?: string;
  },
): Exchange => {
  const { route, path, status, captures = {}, method = "GET" } = expected;
  const context = JSON.stringify(sent);
  const exchange = served(sent, listener);
  if (listener !== "https")
    expect(
      sent.wire.map((request) => [request.method, request.target]),
      context,
    ).toEqual([[method, path]]);
  expect(exchange.seen, context).toMatchObject({ method, path });
  expect(exchange.verdict, context).toEqual({
    is: "selected",
    index: indexOf(route),
    captures,
  });
  expect(exchange.dispatched, context).toMatchObject({
    route,
    captures,
    params: { Ok: captures },
  });
  expect(exchange.status, context).toBe(status);
  return exchange;
};

/** A cookie as the tests compare it. */
const cookie = ({ value, options }: Cookies.Cookie) => ({
  value,
  path: options?.path,
  expires: options?.expires?.toISOString(),
});

describe("parcels", () => {
  for (const { client, listener, title } of cases()) {
    it.live(
      `${title}: each layer's answer decodes by its status and media type`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          const read = (id: string) =>
            send(routes, listener, client, getParcel, { path: { id } });

          const found = yield* read("1001");
          expect(found.value, JSON.stringify(found)).toMatchObject({
            _tag: "Parcel",
            value: knownParcels["1001"],
            metadata: { status: 200 },
          });
          const exchange = expectServed(found, listener, {
            route: "parcel",
            path: "/v2/parcels/1001",
            status: 200,
            captures: { id: "1001" },
          });
          // The decoders' media types, in declaration order and without repeats.
          expect(values(exchange.seen.headers, "accept")).toEqual([
            "application/json, text/plain",
          ]);

          // The application's own error object for an id it does not know.
          const unknown = yield* read("9999");
          expect(unknown.value, JSON.stringify(unknown)).toMatchObject({
            _tag: "NotFound",
            value: {
              error: {
                code: "parcel_not_found",
                message: "No parcel has this id",
              },
            },
            metadata: { status: 404 },
          });
          expectServed(unknown, listener, {
            route: "parcel",
            path: "/v2/parcels/9999",
            status: 404,
            captures: { id: "9999" },
          });

          // Problem details from the application, for a record it no longer keeps.
          const expired = yield* read("1410");
          expect(expired.value, JSON.stringify(expired)).toMatchObject({
            _tag: "Problem",
            value: {
              status: 410,
              title: "Parcel record expired",
              detail: "Records are kept for 90 days after delivery.",
            },
            metadata: { status: 410 },
          });

          // Problem details from validation, for an id the refined route does not take.
          const invalid = yield* read("P-1");
          expect(invalid.value, JSON.stringify(invalid)).toMatchObject({
            _tag: "Problem",
            value: {
              status: 422,
              title: "Invalid parcel id",
              "invalid-params": [{ name: "id", reason: "must be a number" }],
            },
            metadata: { status: 422 },
          });
          expectServed(invalid, listener, {
            route: "parcel-id",
            path: "/v2/parcels/P-1",
            status: 422,
            captures: { id: "P-1" },
          });

          // A consumer still on v1's base meets the edge, whose 404 is a page.
          const retired = getParcel.pipe(
            Operation.mapRequest(Request.baseUrl("/v1")),
          );
          const outside = yield* send(routes, listener, client, retired, {
            path: { id: "1001" },
          });
          expect(outside.value, JSON.stringify(outside)).toMatchObject({
            _tag: "EdgePage",
            value:
              "<!doctype html><title>Not Found</title><h1>Not Found</h1>\n",
            metadata: { status: 404 },
          });
          const edge = served(outside, listener);
          expect(edge.verdict).toEqual({ is: "missed" });
          expect(edge.dispatched).toMatchObject({
            route: "edge-not-found",
            index: null,
          });
          expect(edge.status).toBe(404);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a 404 selected by status alone fails on the edge's page, and no later case is tried`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          const naive = Operation.make(parcel, byStatusAlone);
          const own = yield* send(routes, listener, client, naive, {
            path: { id: "9999" },
          });
          expect(own.value, JSON.stringify(own)).toMatchObject({
            _tag: "NotFound",
            metadata: { status: 404 },
          });
          // The status selects the 404 case, whose JSON decoder cannot read HTML. That failure is
          // final, so the catch-all after it never sees the page.
          const page = yield* send(
            routes,
            listener,
            client,
            naive.pipe(Operation.mapRequest(Request.baseUrl("/v1"))),
            { path: { id: "1001" } },
          );
          expect(page.outcome).toEqual({
            kind: "failure",
            tag: "DecodeError",
            message:
              "The body of the status 404 response could not be read; see cause",
          });
          expect(served(page, listener).dispatched?.route).toBe(
            "edge-not-found",
          );
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: unregistered statuses and those past 599 decode as declared`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          for (const status of [299, 420, 499, 520, 599, 600, 999]) {
            const declared = Operation.make(
              diagnostic,
              Response.status(status, Response.tag("Declared", Body.text)),
            );
            const sent = yield* send(routes, listener, client, declared, {
              path: { code: String(status) },
            });
            const context = `${status}: ${JSON.stringify(sent)}`;
            expectServed(sent, listener, {
              route: "diagnostics",
              path: `/v2/diagnostics/${status}`,
              status,
              captures: { code: String(status) },
            });
            if (client.name === "lines" && status > 599) {
              // The line-preserving provider builds a Fetch `Response`, which takes 200 to 599
              // only, so it fails these as transport errors (`providers.ts`). Every other client,
              // Node's `fetch` and Chromium's included, hands them over.
              expect(sent.outcome, context).toMatchObject({
                kind: "failure",
                tag: "HttpClientError/TransportError",
              });
            } else {
              expect(sent.value, context).toMatchObject({
                _tag: "Declared",
                value: diagnostics[String(status)]!.body,
                metadata: { status },
              });
            }
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a handler's informational status reaches the client as a 500`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          for (const status of [100, 103, 199]) {
            const sent = yield* send(routes, listener, client, getDiagnostic, {
              path: { code: String(status) },
            });
            const context = `${status}: ${JSON.stringify(sent)}`;
            // The handler's own status is in the record. No final response can be informational, so
            // the Warded Server answers a 500 in its place, as its troubleshooting guide says, and
            // Hyper does the same under `axum::serve`.
            expectServed(sent, listener, {
              route: "diagnostics",
              path: `/v2/diagnostics/${status}`,
              status,
              captures: { code: String(status) },
            });
            if (lane.name === "browser") {
              // That 500 keeps none of the response's fields, the CORS ones included
              // (`parcels.node.test.ts` shows them), so Chromium withholds it from the page as a
              // network error.
              expect(sent.outcome, context).toMatchObject({
                kind: "failure",
                tag: "HttpClientError/TransportError",
              });
            } else {
              expect(sent.value, context).toMatchObject({
                _tag: "Answer",
                value: "",
                metadata: { status: 500 },
              });
            }
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a 101 without an upgrade is up to the client over HTTP/1.1`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          const sent = yield* send(routes, listener, client, getDiagnostic, {
            path: { code: "101" },
          });
          expectServed(sent, listener, {
            route: "diagnostics",
            path: "/v2/diagnostics/101",
            status: 101,
            captures: { code: "101" },
          });
          // Over HTTP/1.1 the Warded Server lets a 101 out, since it is how Hyper upgrades a
          // connection, and Hyper does under `axum::serve`. What the library then receives is the
          // client's: Effect's `node:http` client hands it over as an answer with no content, while
          // Chromium, undici's `fetch` and `request`, and the line-preserving provider, which takes
          // no change of protocol, fail it. HTTP/2 and HTTP/3 have no 101, so undici and Chromium on
          // `https` get the server's 500, which Chromium withholds from the page for its missing
          // CORS fields.
          if (client.name === "node-http") {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Answer",
              value: "",
              metadata: { status: 101 },
            });
          } else if (
            lane.name === "node" &&
            client.name === "undici" &&
            listener === "https"
          ) {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Answer",
              value: "",
              metadata: { status: 500 },
            });
          } else {
            expect(sent.outcome, JSON.stringify(sent)).toMatchObject({
              kind: "failure",
              tag: "HttpClientError/TransportError",
            });
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: 204, 205 and 304 arrive without the handler's content`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          for (const status of [204, 205, 304]) {
            const sent = yield* send(routes, listener, client, getDiagnostic, {
              path: { code: String(status) },
            });
            const context = `${status}: ${JSON.stringify(sent)}`;
            expectServed(sent, listener, {
              route: "diagnostics",
              path: `/v2/diagnostics/${status}`,
              status,
              captures: { code: String(status) },
            });
            // The Warded Server takes content off a response whose status rules it out. Hyper under
            // `axum::serve` does for 204 and 304, and sends a 205's content with its length, which
            // the clients that read content for a 205 pass on; Fetch and the line-preserving
            // provider give a 205 no body.
            const passedOn =
              listener === "plain" &&
              status === 205 &&
              (client.name === "undici" || client.name === "node-http");
            expect(sent.value, context).toMatchObject({
              _tag: "Answer",
              value: passedOn ? "reset" : "",
              metadata: { status },
            });
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: each Set-Cookie line of a login reaches the metadata`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          const sent = yield* send(routes, listener, client, login, undefined);
          const context = JSON.stringify(sent);
          expectServed(sent, listener, {
            route: "session",
            path: "/v2/session",
            status: 200,
            method: "POST",
          });
          expect(sent.value, context).toMatchObject({
            _tag: "Session",
            value: { user: "user-1" },
          });
          const { metadata } = sent.value!;
          if (lane.name === "browser") {
            // Chromium hides `Set-Cookie` from the page, as the library documents.
            expect(metadata.cookies.cookies, context).toEqual({});
            expect(metadata.headers["set-cookie"], context).toBeUndefined();
            expect(metadata.headerLines._tag, context).toBe("None");
            return;
          }
          // The normalized view joins the lines with ", ", which the comma in `Expires` keeps
          // from being split back.
          expect(metadata.headers["set-cookie"], context).toBe(
            sessionCookies.join(", "),
          );
          if (client.name === "lines") {
            expect(
              metadata.headerLines._tag === "Some"
                ? values(metadata.headerLines.value, "set-cookie")
                : undefined,
              context,
            ).toEqual(sessionCookies);
          } else {
            expect(metadata.headerLines._tag, context).toBe("None");
          }
          // Every provider shows all three lines, and the metadata parses each, but keeps one cookie
          // for each name: the later `sid`, which clears v1's cookie on its own path, takes the
          // place of the session. Pinned as observed: the documentation promises the cookies the
          // response set, https://github.com/viell-dev/slop-effect-schema-http/issues/356.
          expect(
            Object.fromEntries(
              Object.entries(metadata.cookies.cookies).map(([name, value]) => [
                name,
                cookie(value),
              ]),
            ),
            context,
          ).toEqual({
            sid: {
              value: "",
              path: "/v1",
              expires: "1970-01-01T00:00:00.000Z",
            },
            csrf: {
              value: "c-2",
              path: "/",
              expires: "2027-12-01T08:00:00.000Z",
            },
          });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: PURGE reaches its route, and another method gets the 405 that names it`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          const purged = yield* send(
            routes,
            listener,
            client,
            cacheOf("PURGE"),
            {
              path: { id: "1001" },
            },
          );
          expect(purged.value, JSON.stringify(purged)).toMatchObject({
            _tag: "Purged",
            value: { purged: true },
          });
          expectServed(purged, listener, {
            route: "purge",
            path: "/v2/parcels/1001/cache",
            status: 200,
            captures: { id: "1001" },
            method: "PURGE",
          });
          const refused = yield* send(
            routes,
            listener,
            client,
            cacheOf("DELETE"),
            {
              path: { id: "1001" },
            },
          );
          expect(refused.value, JSON.stringify(refused)).toMatchObject({
            _tag: "NotAllowed",
            metadata: { status: 405, headers: { allow: "PURGE" } },
          });
          expectServed(refused, listener, {
            route: "cache-methods",
            path: "/v2/parcels/1001/cache",
            status: 405,
            captures: { id: "1001" },
            method: "DELETE",
          });
        }).pipe(Effect.scoped),
    );
  }
});
