/**
 * Hostile HTTP/1.1 request heads, sent by the raw provider to the `plain` and `http` listeners: the
 * shapes the server's HTTP parser refuses before any route runs, the shapes that reach the routes
 * as written, the Warded Server's rules for the host, and a handler that declares a false
 * `Content-Length`. Node-only, because the raw provider opens its own sockets.
 *
 * The two listeners differ where the Warded Server checks what Hyper leaves to applications.
 * `plain` is the router under `axum::serve`, which hands the routes whatever Hyper parsed. `http`
 * is the Warded Server, which refuses a malformed host with a 400 before the application sees the
 * request, and sends the true length of a response
 * (https://github.com/viell-dev/slop-warded-server/pull/32, its `docs/requests.md` and
 * `docs/troubleshooting.md`). Hyper's maintainers leave the host rules to applications
 * (https://github.com/hyperium/hyper/issues/3777).
 *
 * The library passes header names, header values and URL text on as written, carriage returns and
 * line feeds included, and leaves refusing them to a provider that writes bytes (its
 * `docs/limits.md`, "Paths and other requests passed on as written", and
 * `docs/modules/transport.md`). The raw provider refuses nothing, so what the parser does with
 * these lines is what each test records.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { lane } from "#lane";
import type { RawOptions } from "../harness/lane.js";
import { bodyText, values } from "../harness/evidence.js";
import { serve } from "../harness/matrix.js";
import {
  and,
  exactPath,
  headerAnyEq,
  headerEq,
  host,
  method,
  path,
  route,
} from "../harness/routes.js";
import { collect, only, type Sent, send } from "../harness/send.js";
import type { Table } from "../harness/table.js";

const raw = lane.raw!;

const table = {
  routes: [
    route("m-search", and(method("M-SEARCH"), exactPath("*"))),
    route("purge", and(method("PURGE"), exactPath("/purge"))),
    // Decoded and normalized spellings come first, so a path that reached them would show it.
    route("decoded-slash", exactPath("/a/b")),
    route("resolved", exactPath("/b")),
    route("backslash", exactPath("/a\\b")),
    route("nul", exactPath("/a%00b")),
    route("slash", exactPath("/a%2Fb")),
    route("dots", exactPath("/a/%2e%2e/b")),
    route("file", path("/files/{name}")),
    route("one-tag", and(exactPath("/tags"), headerEq("x-tag", "a"))),
    route("any-tag", and(exactPath("/tags"), headerAnyEq("x-tag", "b"))),
    route(
      "latin-1",
      and(exactPath("/latin-1"), headerEq("x-latin-1", "\u0080ÿ")),
    ),
    route("other", exactPath("/latin-1")),
  ],
};

const hosts = {
  routes: [
    route("host", and(exactPath("/host"), host("host"))),
    route("localhost", and(exactPath("/host"), host("localhost"))),
    route("other.test", and(exactPath("/host"), host("other.test"))),
    route("[bogus]", and(exactPath("/host"), host("[bogus]"))),
  ],
  fallback: { name: "no host route" },
};

/** A false `Content-Length` beside the content `hello`, too short and too long. */
const lengths = {
  routes: [
    route("short", exactPath("/short"), {
      status: 200,
      headers: [["content-length", "2"]],
      body: "hello",
    }),
    route("long", exactPath("/long"), {
      status: 200,
      headers: [["content-length", "100"]],
      body: "hello",
    }),
  ],
};

/** Any response, with its status, the lines the raw provider read, and its text. */
const replies = Response.when(() => true, Response.tag("Reply", Body.text));

interface Reply {
  readonly status: number;
  readonly lines: ReadonlyArray<readonly [string, string]>;
  readonly text: string;
}

const replyOf = (sent: Sent): Reply => {
  expect(sent.outcome, JSON.stringify(sent)).toEqual({ kind: "value" });
  const { value, metadata } = sent.value as Response.Tagged<"Reply", string>;
  // The raw provider always attaches the lines it read.
  expect(metadata.headerLines._tag).toBe("Some");
  return {
    status: metadata.status,
    lines:
      metadata.headerLines._tag === "Some" ? metadata.headerLines.value : [],
    text: value,
  };
};

/** Send a request through the raw provider, to the listener's origin or to its own target. */
const rawly = <I, E>(
  routes: Table,
  listener: "plain" | "http",
  request: Request.Request<I, E>,
  input: I,
  options?: RawOptions,
  ownTarget = false,
) => {
  const layer = raw(routes.origins[listener], options);
  const definition = Operation.make(request, replies);
  return ownTarget
    ? collect(routes, definition.execute(input).pipe(Effect.provide(layer)))
    : send(routes, listener, layer, definition, input);
};

/** The four records of a request Hyper refused: on the wire, and nowhere after it. */
const expectRefusedByHyper = (sent: Sent) => {
  expect(sent.wire, JSON.stringify(sent)).toHaveLength(1);
  expect(sent.exchanges).toEqual([]);
  const reply = replyOf(sent);
  expect(reply.status).toBe(400);
  expect(reply.text).toBe("");
  expect(values(reply.lines, "connection")).toEqual(["close"]);
};

/** The records of a request the Warded Server refused for its host: nothing reached the routes. */
const expectRefusedByServer = (sent: Sent, reason: string) => {
  expect(sent.wire, JSON.stringify(sent)).toHaveLength(1);
  expect(sent.exchanges).toEqual([]);
  const reply = replyOf(sent);
  expect(reply.status).toBe(400);
  expect(reply.text).toBe(`Malformed request: ${reason}.\n`);
};

const name = Request.pathValue("name", Schema.String);

describe("hostile request heads", () => {
  for (const listener of ["plain", "http"] as const) {
    it.live(
      `${listener}: Hyper refuses malformed lines before any route runs`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const at = Request.get("/files/a");
          const refused = (
            request: Request.Request<void, never>,
            options?: RawOptions,
          ) => rawly(routes, listener, request, undefined, options);

          // An obs-folded line: RFC 9112 section 5.2 lets a server refuse it with a 400.
          const folded = yield* refused(
            at.pipe(Request.setHeader("x-a", "one\r\n two")),
          );
          expect(folded.wire[0]!.head).toContain("x-a: one\r\n two\r\n");
          expectRefusedByHyper(folded);

          // A NUL is no field-vchar (RFC 9110 section 5.5).
          const nul = yield* refused(
            at.pipe(Request.setHeader("x-a", "a\u0000b")),
          );
          expect(values(nul.wire[0]!.lines, "x-a")).toEqual(["a\u0000b"]);
          expectRefusedByHyper(nul);

          // A space in a name, and an empty name, are no token (RFC 9110 section 5.1).
          const spaced = yield* refused(at.pipe(Request.setHeader("x a", "b")));
          expect(spaced.wire[0]!.head).toContain("\r\nx a: b\r\n");
          expectRefusedByHyper(spaced);
          const unnamed = yield* refused(at.pipe(Request.setHeader("", "b")));
          expect(unnamed.wire[0]!.head).toContain("\r\n: b\r\n");
          expectRefusedByHyper(unnamed);

          // A colon in a name ends the name instead: the line is a field `x` with the value `a: b`,
          // which the routes see. The library passes the name on as written, and its transport
          // guide asks providers that write bytes to refuse CR and LF only.
          const colon = yield* refused(at.pipe(Request.setHeader("x:a", "b")));
          expect(colon.wire[0]!.head).toContain("\r\nx:a: b\r\n");
          expect(values(only(colon).seen.headers, "x")).toEqual(["a: b"]);
          expect(values(only(colon).seen.headers, "x:a")).toEqual([]);
          expect(only(colon).dispatched?.route).toBe("file");

          // Hyper's HTTP/1 parser takes HTTP/1.0 and HTTP/1.1 only; HTTP/2 has no request line.
          const http2 = yield* refused(Request.get("/files/a"), {
            protocol: "HTTP/2.0",
          });
          expect(http2.wire[0]!.protocol).toBe("HTTP/2.0");
          expectRefusedByHyper(http2);

          // Two different lengths leave the body's end unclear (RFC 9112 section 6.3).
          const lengths = yield* rawly(
            routes,
            listener,
            Request.post("/files/a").pipe(
              Request.appendHeader("content-length", "5"),
              Request.appendHeader("content-length", "6"),
              Request.body(Body.text),
            ),
            { body: "hello" },
          );
          expect(values(lengths.wire[0]!.lines, "content-length")).toEqual([
            "5",
            "6",
          ]);
          expectRefusedByHyper(lengths);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${listener}: the library composes no target byte that is not UTF-8`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          // A request target is text to the library. Its path values and query entries are
          // percent-encoded with `encodeURIComponent` (the library's `docs/design.md`), which
          // throws for a lone surrogate, so the library fails with `InvalidRequest` before
          // anything is sent, as its `docs/limits.md` lists for URL rendering.
          const value = yield* rawly(
            routes,
            listener,
            Request.get("").pipe(Request.path`/files/${name}`),
            { path: { name: "\ud800" } },
          );
          expect(value.wire).toEqual([]);
          expect(value.outcome).toMatchObject({
            kind: "failure",
            tag: "InvalidRequest",
            message: "Failed to render the request path",
          });
          const query = yield* rawly(
            routes,
            listener,
            Request.get("/files/a").pipe(Request.setQuery("q", "\ud800")),
            undefined,
          );
          expect(query.wire).toEqual([]);
          expect(query.outcome).toMatchObject({
            kind: "failure",
            tag: "InvalidRequest",
            message: "Failed to encode request URL",
          });

          // Literal URL text is passed on as written. The raw provider writes the request line as
          // UTF-8, which turns a lone surrogate into U+FFFD, so the server receives valid UTF-8
          // and the routes see the replacement character, in the path and in the query.
          const literal = yield* rawly(
            routes,
            listener,
            Request.get("/files/a\ud800b?q=\ud800"),
            undefined,
          );
          const replacement = Buffer.from("�").toString("latin1");
          expect(literal.wire.map((request) => request.target)).toEqual([
            `/files/a${replacement}b?q=${replacement}`,
          ]);
          expect(only(literal).seen).toMatchObject({
            path: "/files/a�b",
            query: "q=�",
          });
          expect(only(literal).verdict).toEqual({
            is: "selected",
            index: table.routes.findIndex((entry) => entry.name === "file"),
            captures: { name: "a�b" },
          });
          expect(only(literal).dispatched?.params).toEqual({
            Ok: { name: "a�b" },
          });

          // The nearest the library comes is a percent-escape of a byte that is not UTF-8. It is
          // ASCII on the wire and reaches the route as written; the server's `Params` refuses to
          // decode it, as its rustdoc says.
          const escaped = yield* rawly(
            routes,
            listener,
            Request.get("/files/%FF"),
            undefined,
          );
          expect(escaped.wire.map((request) => request.target)).toEqual([
            "/files/%FF",
          ]);
          expect(only(escaped).verdict).toMatchObject({
            captures: { name: "%FF" },
          });
          expect(only(escaped).dispatched?.params).toEqual({
            Err: "invalid path: `name` is not UTF-8",
          });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${listener}: extension methods and encoded path characters reach the routes as written`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const search = yield* rawly(
            routes,
            listener,
            Request.make("M-SEARCH", "*"),
            undefined,
            undefined,
            true,
          );
          expect(search.wire.map((request) => request.head)).toEqual([
            `M-SEARCH * HTTP/1.1\r\nhost: ${new URL(routes.origins[listener]).host}\r\naccept: text/plain\r\n`,
          ]);
          expect(only(search).seen).toMatchObject({
            method: "M-SEARCH",
            path: "*",
          });
          expect(only(search).dispatched?.route).toBe("m-search");
          const purge = yield* rawly(
            routes,
            listener,
            Request.make("PURGE", "/purge"),
            undefined,
          );
          expect(only(purge).seen.method).toBe("PURGE");
          expect(only(purge).dispatched?.route).toBe("purge");

          // `exact_path` compares the raw path: nothing is decoded or resolved
          // (Warded's guide to paths, "Raw paths").
          for (const [target, expected] of [
            ["/a\\b", "backslash"],
            ["/a%00b", "nul"],
            ["/a%2Fb", "slash"],
            ["/a/%2e%2e/b", "dots"],
          ] as const) {
            const sent = yield* rawly(
              routes,
              listener,
              Request.get(target),
              undefined,
            );
            expect(sent.wire.map((request) => request.target)).toEqual([
              target,
            ]);
            expect(only(sent).seen.path).toBe(target);
            expect(only(sent).dispatched?.route, target).toBe(expected);
          }

          // `path` captures the raw segment, and the server's `Params` percent-decodes it, so a
          // handler sees a NUL, a `/` and `..` that the route never did.
          for (const [segment, decoded] of [
            ["a\\b", "a\\b"],
            ["%00", "\u0000"],
            ["a%2Fb", "a/b"],
            ["%2e%2e", ".."],
          ] as const) {
            const sent = yield* rawly(
              routes,
              listener,
              Request.get(`/files/${segment}`),
              undefined,
            );
            expect(only(sent).verdict, segment).toMatchObject({
              is: "selected",
              captures: { name: segment },
            });
            expect(only(sent).dispatched?.params, segment).toEqual({
              Ok: { name: decoded },
            });
          }
        }).pipe(Effect.scoped),
    );

    for (const provider of ["raw", "lines"] as const) {
      it.live(
        `${listener}: ${provider} keeps repeated lines and their spelling apart`,
        () =>
          Effect.gen(function* () {
            const routes = yield* serve(table);
            const layer =
              provider === "raw" ? raw(routes.origins[listener]) : lane.lines!;
            const tags = yield* send(
              routes,
              listener,
              layer,
              Operation.make(
                Request.get("/tags").pipe(
                  Request.appendHeader("X-Tag", "a"),
                  Request.appendHeader("x-tag", "b"),
                ),
                replies,
              ),
              undefined,
            );
            const wire = tags.wire[0]!.lines.filter(
              ([field]) => field.toLowerCase() === "x-tag",
            );
            expect(wire).toEqual([
              ["X-Tag", "a"],
              ["x-tag", "b"],
            ]);
            // The header map keeps both values in order, under the lowercase name, so `header_eq`
            // refuses the repeated field and `header_any_eq` finds one of its lines.
            expect(values(only(tags).seen.headers, "x-tag")).toEqual([
              "a",
              "b",
            ]);
            expect(only(tags).dispatched?.route).toBe("any-tag");
          }).pipe(Effect.scoped),
      );
    }

    it.live(
      `${listener}: two equal lengths are one, and bytes beyond ASCII stay bytes`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          // RFC 9112 section 6.3 lets a recipient take repeated equal lengths as one.
          const twice = yield* rawly(
            routes,
            listener,
            Request.post("/files/a").pipe(
              Request.appendHeader("content-length", "5"),
              Request.appendHeader("content-length", "5"),
              Request.body(Body.text),
            ),
            { body: "hello" },
          );
          expect(values(twice.wire[0]!.lines, "content-length")).toEqual([
            "5",
            "5",
          ]);
          expect(values(only(twice).seen.headers, "content-length")).toEqual([
            "5",
          ]);
          expect(bodyText(only(twice).dispatched)).toBe("hello");

          // A value up to U+00FF goes out one byte for each character, here the ends of obs-text,
          // and `header_eq` compares those bytes.
          const latin1 = yield* rawly(
            routes,
            listener,
            Request.get("/latin-1").pipe(
              Request.setHeader("x-latin-1", "\u0080ÿ"),
            ),
            undefined,
          );
          expect(values(latin1.wire[0]!.lines, "x-latin-1")).toEqual([
            "\u0080ÿ",
          ]);
          expect(values(only(latin1).seen.headers, "x-latin-1")).toEqual([
            "\u0080ÿ",
          ]);
          expect(only(latin1).dispatched?.route).toBe("latin-1");

          // A value beyond U+00FF does not fit in a byte each. The raw provider then writes the
          // whole line as UTF-8 (`headerLineBytes` in `providers.ts`), and the route sees those
          // bytes, so `é` arrives as two.
          const beyond = yield* rawly(
            routes,
            listener,
            Request.get("/latin-1").pipe(Request.setHeader("x-latin-1", "é€")),
            undefined,
          );
          const utf8 = Buffer.from("é€").toString("latin1");
          expect(values(beyond.wire[0]!.lines, "x-latin-1")).toEqual([utf8]);
          expect(values(only(beyond).seen.headers, "x-latin-1")).toEqual([
            utf8,
          ]);
          expect(only(beyond).dispatched?.route).toBe("other");
        }).pipe(Effect.scoped),
    );

    it.live(
      `${listener}: Transfer-Encoding wins over Content-Length, and the connection closes`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          // The body is the chunked encoding of `hello`, and the raw provider adds its length.
          const chunked = "5\r\nhello\r\n0\r\n\r\n";
          const sent = yield* rawly(
            routes,
            listener,
            Request.post("/files/a").pipe(
              Request.setHeader("transfer-encoding", "chunked"),
              Request.body(Body.text),
            ),
            { body: chunked },
          );
          const [wire] = sent.wire;
          expect(values(wire!.lines, "transfer-encoding")).toEqual(["chunked"]);
          expect(values(wire!.lines, "content-length")).toEqual([
            String(chunked.length),
          ]);
          // RFC 9112 section 6.3: the length is ignored, and Hyper takes it out of the head. RFC
          // 9112 section 6.1: a server that processes such a request closes the connection after
          // the response, which Hyper announces with `Connection: close`.
          const { seen, dispatched } = only(sent);
          expect(values(seen.headers, "transfer-encoding")).toEqual([
            "chunked",
          ]);
          expect(values(seen.headers, "content-length")).toEqual([]);
          expect(bodyText(dispatched)).toBe("hello");
          const reply = replyOf(sent);
          expect(reply.status).toBe(200);
          expect(values(reply.lines, "connection")).toEqual(["close"]);
        }).pipe(Effect.scoped),
    );

    it.live(`${listener}: the host rules`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(hosts);
        const port = new URL(routes.origins[listener]).port;
        const atHost = Request.get("/host");
        const absolute = Request.get("http://other.test/host");

        /**
         * One request, and what each listener does with it: the route that ran and the `Host`
         * values its head had, or the Warded Server's reason for refusing it.
         */
        const expectHost = (
          sent: Sent,
          plain: { readonly route: string; readonly hosts: Array<string> },
          http:
            | { readonly route: string; readonly hosts: Array<string> }
            | { readonly refused: string },
        ) => {
          const expected = listener === "plain" ? plain : http;
          if ("refused" in expected)
            return expectRefusedByServer(sent, expected.refused);
          const { seen, dispatched } = only(sent);
          expect(values(seen.headers, "host"), JSON.stringify(sent)).toEqual(
            expected.hosts,
          );
          expect(dispatched?.route, JSON.stringify(sent)).toBe(expected.route);
        };
        const fallback = "no host route";

        // RFC 9112 section 3.2: one Host field at most, on every version, and one on HTTP/1.1.
        // The guide's host condition takes two fields as no match, so they fall through.
        for (const protocol of ["HTTP/1.1", "HTTP/1.0"]) {
          const twice = yield* rawly(
            routes,
            listener,
            atHost.pipe(
              Request.appendHeader("host", "host"),
              Request.appendHeader("host", "host"),
            ),
            undefined,
            { protocol },
          );
          expect(values(twice.wire[0]!.lines, "host")).toEqual([
            "host",
            "host",
          ]);
          expectHost(
            twice,
            { route: fallback, hosts: ["host", "host"] },
            { refused: "the request has several Host fields" },
          );
        }
        const missing = yield* rawly(routes, listener, atHost, undefined, {
          host: false,
        });
        expect(values(missing.wire[0]!.lines, "host")).toEqual([]);
        expectHost(
          missing,
          { route: fallback, hosts: [] },
          { refused: "the HTTP/1.1 request has no Host field" },
        );
        const old = yield* rawly(routes, listener, atHost, undefined, {
          host: false,
          protocol: "HTTP/1.0",
        });
        expect(values(old.wire[0]!.lines, "host")).toEqual([]);
        expectHost(
          old,
          { route: fallback, hosts: [] },
          { route: fallback, hosts: [] },
        );

        // A value that is no `host [ ":" port ]`. `http::uri::Authority`, which the guide's
        // condition parses with, takes user information, any text as a port and brackets
        // around anything, so under `axum::serve` these reach the routes for `host` and
        // `[bogus]`. The guide does not say that the condition relies on the server to refuse
        // them: https://github.com/viell-dev/slop-warded-router/issues/48.
        for (const [value, route] of [
          ["not a host/x", fallback],
          ["user@host", "host"],
          ["host:abc", "host"],
          ["[bogus]", "[bogus]"],
        ] as const) {
          const sent = yield* rawly(
            routes,
            listener,
            atHost.pipe(Request.setHeader("host", value)),
            undefined,
          );
          expect(values(sent.wire[0]!.lines, "host")).toEqual([value]);
          expectHost(
            sent,
            { route, hosts: [value] },
            { refused: "the Host field is not a valid host" },
          );
        }
        // An empty Host says that the target has no host: valid, and no host route's.
        const empty = yield* rawly(
          routes,
          listener,
          atHost.pipe(Request.setHeader("host", "")),
          undefined,
        );
        expectHost(
          empty,
          { route: fallback, hosts: [""] },
          { route: fallback, hosts: [""] },
        );

        // An absolute-form target names the host (RFC 9112 section 3.2.2). The guide's condition
        // reads the URI first, so both listeners select the target's host. The Warded Server
        // also replaces the field with the target's host, so a handler that reads `Host` agrees;
        // the field still has to be valid, and present on HTTP/1.1.
        const viaTarget = (declared: string | undefined) =>
          rawly(
            routes,
            listener,
            declared === undefined
              ? absolute
              : absolute.pipe(Request.setHeader("host", declared)),
            undefined,
            { host: declared !== undefined },
            true,
          );
        for (const declared of ["localhost", ""]) {
          const sent = yield* viaTarget(declared);
          expect(sent.wire[0]!.target).toBe("http://other.test/host");
          expect(values(sent.wire[0]!.lines, "host")).toEqual([declared]);
          expect(only(sent).seen.uri).toBe("http://other.test/host");
          expectHost(
            sent,
            { route: "other.test", hosts: [declared] },
            { route: "other.test", hosts: ["other.test"] },
          );
        }
        expectHost(
          yield* viaTarget("not a host/x"),
          { route: "other.test", hosts: ["not a host/x"] },
          { refused: "the Host field is not a valid host" },
        );
        expectHost(
          yield* viaTarget(undefined),
          { route: "other.test", hosts: [] },
          { refused: "the HTTP/1.1 request has no Host field" },
        );

        // User information in a target (RFC 9110 section 4.2.1). `Authority::host` leaves it
        // out, so the guide's condition takes the request for `localhost` (router issue 48 too).
        const user = yield* rawly(
          routes,
          listener,
          Request.get(`http://user@localhost:${port}/host`),
          undefined,
          undefined,
          true,
        );
        expect(user.wire[0]!.target).toBe(`http://user@localhost:${port}/host`);
        expectHost(
          user,
          { route: "localhost", hosts: [`127.0.0.1:${port}`] },
          { refused: "the request target names an invalid host" },
        );
      }).pipe(Effect.scoped),
    );

    it.live(`${listener}: a handler's false Content-Length`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(lengths);
        for (const target of ["/short", "/long"]) {
          const sent = yield* rawly(
            routes,
            listener,
            Request.get(target),
            undefined,
          );
          // The handler ran and answered, with its false length, on both listeners.
          expect(sent.wire.map((request) => request.target)).toEqual([target]);
          expect(only(sent).dispatched?.route).toBe(target.slice(1));
          expect(only(sent).status).toBe(200);
          if (listener === "plain") {
            // Hyper trusts a length beside content of known length
            // (https://github.com/hyperium/hyper/issues/2152). The host is a debug build, where
            // Hyper's debug assertion panics in the connection's task and closes the connection
            // with nothing sent, so the library reads a transport failure. A release build
            // sends the false length instead (slop-warded-server#28).
            expect(sent.outcome, target).toMatchObject({
              kind: "failure",
              tag: "HttpClientError/TransportError",
            });
          } else {
            // The Warded Server replaces the length with the content's
            // (https://github.com/viell-dev/slop-warded-server/issues/28, fixed by #32).
            const reply = replyOf(sent);
            expect(values(reply.lines, "content-length"), target).toEqual([
              "5",
            ]);
            expect(reply.text).toBe("hello");
          }
        }
      }).pipe(Effect.scoped),
    );
  }
});
