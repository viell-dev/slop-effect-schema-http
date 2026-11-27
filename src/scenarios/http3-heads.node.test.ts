/**
 * Hostile HTTP/3 request heads, sent to the `https` listener's HTTP/3 endpoint by the HTTP/3
 * provider, which writes a field section field by field through the host's HTTP/3 client: the
 * shapes of `http2-heads.node.test.ts` that apply to HTTP/3. Node-only, because the provider runs
 * the host's client as a child process.
 *
 * Two layers decide before any route runs. h3 0.0.8 turns the field section into the `http` crate's
 * types, and refuses what does not fit them, a missing `:method`, and an `:authority` and a `Host`
 * that differ, as a stream error: RESET_STREAM with H3_MESSAGE_ERROR (RFC 9114 section 4.1.2). It
 * takes repeated and late pseudo-header fields, and uses the last of each, which the Warded
 * Server's `docs/limits.md` names among h3's defects, and also `:status` and the `:protocol` values
 * that it knows, which that page does not name. Then the server checks the host, the whitespace
 * around values, fields about the connection and the lengths, and refuses with the same stream
 * error, where HTTP/1.1 and HTTP/2 get a 400 (its `docs/troubleshooting.md`). So the client sees no
 * difference between the two refusals; neither reaches the routes.
 *
 * The HTTPS listener has no recording proxy. The provider writes each field as a plain QPACK
 * literal and records the fields it wrote, so they are what crossed the wire. With the head, the
 * verdict and the dispatch, they are the four records of each exchange.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { lane } from "#lane";
import {
  bodyText,
  type Field,
  type H3Exchange,
  type H3Received,
  values,
} from "../harness/evidence.js";
import type { H3Options } from "../harness/lane.js";
import { serve } from "../harness/matrix.js";
import {
  and,
  connect,
  exactPath,
  get,
  headerAnyEq,
  headerEq,
  host,
  method,
  or,
  path,
  route,
} from "../harness/routes.js";
import { only, type Sent, send } from "../harness/send.js";
import type { Table } from "../harness/table.js";

const h3 = lane.h3!;

const table = {
  routes: [
    route("m-search", and(method("M-SEARCH"), exactPath("*"))),
    route("GET", and(get(), exactPath("/get"))),
    route("get", and(method("get"), exactPath("/get"))),
    route("connect", and(connect(), host("other.test"))),
    route("root", exactPath("/")),
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
    route(
      "cookies",
      and(exactPath("/cookies"), headerEq("cookie", "a=1; b=2; c=3")),
    ),
    route("other", or(exactPath("/latin-1"), exactPath("/cookies"))),
  ],
  fallback: { name: "no route" },
};

const hosts = {
  routes: [
    route("localhost", and(exactPath("/host"), host("localhost"))),
    route("other.test", and(exactPath("/host"), host("other.test"))),
  ],
  fallback: { name: "no host route" },
};

const indexOf = (name: string) =>
  table.routes.findIndex((entry) => entry.name === name);

/** Any response, with its status and text. */
const replies = Response.when(() => true, Response.tag("Reply", Body.text));

interface SentH3 extends Sent {
  /** What the HTTP/3 client wrote, and what came back. */
  readonly h3: H3Exchange;
}

/** Send a request through the HTTP/3 provider to the table's HTTPS listener. */
const sendH3 = <I, E>(
  routes: Table,
  request: Request.Request<I, E>,
  input: I,
  options?: H3Options,
): Effect.Effect<SentH3> =>
  Effect.gen(function* () {
    const provider = h3(routes.origins.https, options);
    const sent = yield* send(
      routes,
      "https",
      provider.layer,
      Operation.make(request, replies),
      input,
    );
    expect(provider.exchanges, JSON.stringify(sent)).toHaveLength(1);
    return { ...sent, h3: provider.exchanges[0]! };
  });

type Rewrite = NonNullable<H3Options["fields"]>;

/** The value of each field named `name` replaced. */
const replace =
  (name: string, value: string): Rewrite =>
  (fields) =>
    fields.map(([key, old]): Field => [key, key === name ? value : old]);
const without =
  (name: string): Rewrite =>
  (fields) =>
    fields.filter(([key]) => key !== name);
/** A field added after the pseudo-header fields the provider composed. */
const withPseudo =
  (field: Field): Rewrite =>
  (fields) => [...fields.slice(0, 4), field, ...fields.slice(4)];
/** The field named `name` moved to the end of the block. */
const last =
  (name: string): Rewrite =>
  (fields) => [
    ...fields.filter(([key]) => key !== name),
    ...fields.filter(([key]) => key === name),
  ];
/** The field named `name` sent twice in a row, the second time with `value` if given. */
const twice =
  (name: string, value?: string): Rewrite =>
  (fields) =>
    fields.flatMap((field): ReadonlyArray<Field> =>
      field[0] === name ? [field, [name, value ?? field[1]]] : [field],
    );

const names = (sent: SentH3) => sent.h3.fields.map(([name]) => name);

const reset: H3Received = { is: "reset", code: "H3_MESSAGE_ERROR" };

/**
 * The records of a request that h3 or the server refused: written, reset, and seen nowhere after.
 * Both refuse with the same stream error.
 */
const expectRefused = (sent: SentH3) => {
  expect(sent.h3.received, JSON.stringify(sent)).toEqual(reset);
  expect(sent.exchanges).toEqual([]);
  expect(sent.outcome).toMatchObject({
    kind: "failure",
    tag: "HttpClientError/TransportError",
  });
};

/** The route that ran for a request that reached the routes, and the path they saw. */
const expectRouted = (
  sent: SentH3,
  expected: { readonly path: string; readonly route: string },
) => {
  const { seen, dispatched } = only(sent);
  expect(seen.path, JSON.stringify(sent)).toBe(expected.path);
  expect(dispatched?.route, JSON.stringify(sent)).toBe(expected.route);
  expect(sent.h3.received).toMatchObject({ is: "response" });
};

const pseudo = [":method", ":scheme", ":authority", ":path"] as const;

describe("hostile HTTP/3 request heads", () => {
  it.live("the provider's own head reaches the routes over HTTP/3", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const authority = new URL(routes.origins.https).host;
      const sent = yield* sendH3(routes, Request.get("/files/a"), undefined);
      expect(sent.h3.fields).toEqual([
        [":method", "GET"],
        [":scheme", "https"],
        [":authority", authority],
        [":path", "/files/a"],
        ["accept", "text/plain"],
      ]);
      const { seen, verdict, dispatched } = only(sent);
      expect(seen).toEqual({
        method: "GET",
        version: "HTTP/3",
        uri: `https://${authority}/files/a`,
        path: "/files/a",
        query: null,
        headers: [["accept", "text/plain"]],
        security: "https",
      });
      expect(verdict).toEqual({
        is: "selected",
        index: indexOf("file"),
        captures: { name: "a" },
      });
      expect(dispatched?.params).toEqual({ Ok: { name: "a" } });
      expect(sent.h3.received).toMatchObject({ is: "response", status: 200 });
      expect(sent.outcome).toMatchObject({ kind: "value" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "h3 takes repeated and late pseudo-header fields, the last of each",
    () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const at = Request.get("/files/a");
        const block = (fields: Rewrite) =>
          sendH3(routes, at, undefined, { fields });

        // RFC 9114 section 4.3 makes a request with a repeated pseudo-header field, or one after
        // a regular field, malformed, as RFC 9113 does for HTTP/2, where h2 refuses them. h3 takes
        // them and keeps the last of each, as the Warded Server's `docs/limits.md` says, so the
        // routes see the last value.
        const [m, s, a, p] = pseudo;
        for (const [fields, wire, expected] of [
          [twice(":path"), [m, s, a, p, p, "accept"], ["GET", "/files/a"]],
          [
            twice(":path", "/files/b"),
            [m, s, a, p, p, "accept"],
            ["GET", "/files/b"],
          ],
          [twice(":method"), [m, m, s, a, p, "accept"], ["GET", "/files/a"]],
          [
            twice(":method", "POST"),
            [m, m, s, a, p, "accept"],
            ["POST", "/files/a"],
          ],
          [twice(":scheme"), [m, s, s, a, p, "accept"], ["GET", "/files/a"]],
          [twice(":authority"), [m, s, a, a, p, "accept"], ["GET", "/files/a"]],
          [last(":path"), [m, s, a, "accept", p], ["GET", "/files/a"]],
          [last(":authority"), [m, s, p, "accept", a], ["GET", "/files/a"]],
          [last(":method"), [s, a, p, "accept", m], ["GET", "/files/a"]],
        ] as const) {
          const sent = yield* block(fields);
          expect(names(sent)).toEqual(wire);
          const [method, path] = expected;
          expect(only(sent).seen.method).toBe(method);
          expectRouted(sent, { path, route: "file" });
        }

        // The library passes on a header name as written (its transport guide, and
        // https://github.com/viell-dev/slop-effect-schema-http/issues/302); this provider refuses
        // nothing. So the declared field follows the provider's own `:path` and a regular field,
        // and replaces the provider's: h2 refuses this head, and h3 routes it to `/b`.
        const declared = yield* sendH3(
          routes,
          at.pipe(
            Request.setHeader("x-a", "1"),
            Request.setHeader(":path", "/b"),
          ),
          undefined,
        );
        expect(declared.h3.fields.slice(4)).toEqual([
          ["x-a", "1"],
          [":path", "/b"],
          ["accept", "text/plain"],
        ]);
        expectRouted(declared, { path: "/b", route: "no route" });
        expect(values(only(declared).seen.headers, "x-a")).toEqual(["1"]);
      }).pipe(Effect.scoped),
  );

  it.live("h3 refuses missing, unknown and invalid pseudo-header fields", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const at = Request.get("/files/a");
      const block = (fields: Rewrite) =>
        sendH3(routes, at, undefined, { fields });

      // RFC 9114 section 4.3.1: `:method`, `:scheme` and `:path` in every request but CONNECT. h3
      // refuses a request without `:method`, and the `http` crate a URI with an authority and
      // without a scheme or a path.
      const [m, s, a, p] = pseudo;
      for (const [fields, wire] of [
        [without(":method"), [s, a, p, "accept"]],
        [without(":scheme"), [m, a, p, "accept"]],
        [without(":path"), [m, s, a, "accept"]],
        // An unknown pseudo-header field, which h2 refuses for the whole connection.
        [withPseudo([":foo", "bar"]), [m, s, a, p, ":foo", "accept"]],
        // A `:protocol` that h3 does not know; the ones it knows reach the routes, below.
        [
          withPseudo([":protocol", "websocket"]),
          [m, s, a, p, ":protocol", "accept"],
        ],
      ] as const) {
        const sent = yield* block(fields);
        expect(names(sent)).toEqual(wire);
        expectRefused(sent);
      }

      // `http::uri::PathAndQuery` takes a path that begins with `/`, `?` or `#`, or is `*`, so h3
      // refuses an empty, a relative and an absolute `:path`, as h2 does.
      for (const target of ["", "files/a", "https://other.test/files/a"]) {
        const sent = yield* block(replace(":path", target));
        expect(sent.h3.fields[3]).toEqual([":path", target]);
        expectRefused(sent);
      }
    }).pipe(Effect.scoped),
  );

  it.live(":authority against Host", () =>
    Effect.gen(function* () {
      const routes = yield* serve(hosts);
      const port = new URL(routes.origins.https).port;
      const atHost = Request.get("/host");
      const withHosts = (...values: ReadonlyArray<string>) =>
        values.reduce(
          (request, value) => request.pipe(Request.appendHeader("host", value)),
          atHost,
        );

      /** The route that ran, the target the head had, and its `Host` values. */
      const expectHost = (
        sent: SentH3,
        expected: {
          readonly route: string;
          readonly uri: string;
          readonly hosts: ReadonlyArray<string>;
        },
      ) => {
        const { seen, dispatched } = only(sent);
        expect(seen.uri, JSON.stringify(sent)).toBe(expected.uri);
        expect(values(seen.headers, "host")).toEqual(expected.hosts);
        expect(dispatched?.route).toBe(expected.route);
      };

      // RFC 9114 section 4.3.1: a `Host` beside `:authority` contains the same value. h3 compares
      // the two as bytes, where the Warded Server's check over HTTP/2 ignores case and the
      // scheme's default port (`http2-heads.node.test.ts`), and puts the `Host` field's in the
      // target.
      for (const [authority, field] of [
        [`localhost:${port}`, `localhost:${port}`],
        ["localhost", "localhost"],
      ] as const) {
        const sent = yield* sendH3(routes, withHosts(field), undefined, {
          fields: replace(":authority", authority),
        });
        expect(sent.h3.fields).toContainEqual([":authority", authority]);
        expect(values(sent.h3.fields, "host")).toEqual([field]);
        expectHost(sent, {
          route: "localhost",
          uri: `https://${field}/host`,
          hosts: [field],
        });
      }
      for (const [authority, field] of [
        ["LOCALHOST:443", "localhost"],
        [`localhost:${port}`, "other.test"],
        [`localhost:${port}`, "localhost:1"],
      ] as const)
        expectRefused(
          yield* sendH3(routes, withHosts(field), undefined, {
            fields: replace(":authority", authority),
          }),
        );

      // Without `:authority`, h3 puts the `Host` field's host in the target, which over HTTP/2
      // has none. HTTP/3 requires one of them, so a request with neither is refused, where over
      // HTTP/2 it falls through.
      const fieldOnly = yield* sendH3(
        routes,
        withHosts("other.test"),
        undefined,
        { fields: without(":authority") },
      );
      expect(names(fieldOnly)).toEqual([
        ":method",
        ":scheme",
        ":path",
        "host",
        "accept",
      ]);
      expectHost(fieldOnly, {
        route: "other.test",
        uri: "https://other.test/host",
        hosts: ["other.test"],
      });
      expectRefused(
        yield* sendH3(routes, atHost, undefined, {
          fields: without(":authority"),
        }),
      );

      // Two `:authority` fields: h3 keeps the last, as `docs/limits.md` says, so a second one
      // chooses the host that the routes see. h2 refuses them.
      const authorities = yield* sendH3(routes, atHost, undefined, {
        fields: twice(":authority", "other.test"),
      });
      expect(values(authorities.h3.fields, ":authority")).toEqual([
        `127.0.0.1:${port}`,
        "other.test",
      ]);
      expectHost(authorities, {
        route: "other.test",
        uri: "https://other.test/host",
        hosts: [],
      });

      // Two `Host` fields are the server's to refuse, with `:authority` or without; h3 compares
      // the first one only.
      for (const fields of [
        replace(":authority", "localhost"),
        without(":authority"),
      ])
        expectRefused(
          yield* sendH3(
            routes,
            withHosts("localhost", "localhost"),
            undefined,
            {
              fields,
            },
          ),
        );

      // An `:authority` that `http::uri::Authority` cannot parse, an empty one among them, is h3's
      // to refuse. One that it parses but is no `host [ ":" port ]` is the server's.
      for (const authority of [
        "not a host/x",
        "localhost/x",
        "",
        "user@localhost",
        "localhost:abc",
        "[bogus]",
      ])
        expectRefused(
          yield* sendH3(routes, atHost, undefined, {
            fields: replace(":authority", authority),
          }),
        );

      // An invalid `Host`, with `:authority` or without.
      for (const [field, fields] of [
        ["not a host/x", undefined],
        ["", undefined],
        ["", without(":authority")],
        ["user@host", without(":authority")],
      ] as const)
        expectRefused(
          yield* sendH3(
            routes,
            withHosts(field),
            undefined,
            fields === undefined ? undefined : { fields },
          ),
        );
    }).pipe(Effect.scoped),
  );

  it.live("the server joins split Cookie fields", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const cookies = (...crumbs: ReadonlyArray<string>) =>
        crumbs.reduce(
          (request, crumb) =>
            request.pipe(Request.appendHeader("cookie", crumb)),
          Request.get("/cookies"),
        );

      // RFC 9114 section 4.2.1 lets an HTTP/3 client split `Cookie`, and requires joining the
      // fields with `; ` before an application sees them. h3 leaves that to the server.
      const split = yield* sendH3(
        routes,
        cookies("a=1", "b=2; c=3"),
        undefined,
      );
      expect(values(split.h3.fields, "cookie")).toEqual(["a=1", "b=2; c=3"]);
      const { seen, dispatched } = only(split);
      expect(values(seen.headers, "cookie")).toEqual(["a=1; b=2; c=3"]);
      expect(dispatched?.route).toBe("cookies");

      // Each crumb is a field value, and the server checks it before joining.
      expectRefused(yield* sendH3(routes, cookies("a=1", " b=2"), undefined));
      const empty = yield* sendH3(routes, cookies(""), undefined);
      expect(values(only(empty).seen.headers, "cookie")).toEqual([""]);

      // An empty crumb passes that check, and joining it leaves `; ` at the end, as over HTTP/2.
      // Pinned as observed: https://github.com/viell-dev/slop-warded-server/issues/40.
      const crumb = yield* sendH3(routes, cookies("a=1", ""), undefined);
      expect(values(crumb.h3.fields, "cookie")).toEqual(["a=1", ""]);
      expect(values(only(crumb).seen.headers, "cookie")).toEqual(["a=1; "]);
      expect(only(crumb).dispatched?.route).toBe("other");
    }).pipe(Effect.scoped),
  );

  it.live("h3 and the server refuse what HTTP/1.1 parsers refuse", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const at = Request.get("/files/a");
      const header = (name: string, value: string) =>
        sendH3(routes, at.pipe(Request.setHeader(name, value)), undefined);

      // Hyper's HTTP/1.1 parser answers most of these with a 400 (`hostile-heads.node.test.ts`),
      // and h2 refuses some of them for the whole connection. h3 refuses each for its stream: a
      // space in `:path`, which `http::uri::PathAndQuery` does not take, a `:path` that is not
      // UTF-8, a name that is not a lowercase token (RFC 9114 section 4.2), and a value that
      // `http` cannot hold.
      const spaced = yield* sendH3(
        routes,
        Request.get("/files/a b"),
        undefined,
      );
      expect(spaced.h3.fields[3]).toEqual([":path", "/files/a b"]);
      expectRefused(spaced);
      expectRefused(
        yield* sendH3(routes, at, undefined, {
          fields: replace(":path", "/files/aÿb"),
        }),
      );
      for (const [name, value] of [
        ["x-a", "a\u0000b"],
        ["x-a", "a\r\nb"],
        ["x a", "b"],
        ["", "b"],
        ["x:a", "b"],
        ["X-A", "b"],
      ] as const) {
        const sent = yield* header(name, value);
        expect(sent.h3.fields[4]).toEqual([name, value]);
        expectRefused(sent);
      }

      // Fields about an HTTP/1.1 connection make an HTTP/3 message malformed, apart from
      // `te: trailers` (RFC 9114 section 4.2). h3 leaves them to the server.
      for (const [name, value] of [
        ["connection", "close"],
        ["keep-alive", "5"],
        ["proxy-connection", "close"],
        ["upgrade", "h3"],
        ["transfer-encoding", "chunked"],
        ["te", "gzip"],
      ] as const)
        expectRefused(yield* header(name, value));
      const te = yield* header("te", "trailers");
      expect(values(only(te).seen.headers, "te")).toEqual(["trailers"]);
      expect(only(te).dispatched?.route).toBe("file");
    }).pipe(Effect.scoped),
  );

  it.live("what reaches the routes as written over HTTP/3", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const authority = new URL(routes.origins.https).host;

      // Extension and lowercase methods. `get()` is GET, so `get` needs `method("get")`.
      const search = yield* sendH3(
        routes,
        Request.make("M-SEARCH", "/"),
        undefined,
        { fields: replace(":path", "*") },
      );
      expect(search.h3.fields.slice(0, 4)).toEqual([
        [":method", "M-SEARCH"],
        [":scheme", "https"],
        [":authority", authority],
        [":path", "*"],
      ]);
      expect(only(search).seen.method).toBe("M-SEARCH");
      expectRouted(search, { path: "*", route: "m-search" });
      const lower = yield* sendH3(
        routes,
        Request.make("get", "/get"),
        undefined,
      );
      expect(only(lower).seen.method).toBe("get");
      expectRouted(lower, { path: "/get", route: "get" });
      expectRouted(yield* sendH3(routes, Request.get("/get"), undefined), {
        path: "/get",
        route: "GET",
      });

      // The raw path, as over HTTP/1.1 and HTTP/2: nothing is decoded or resolved, and a fragment
      // is dropped.
      for (const [target, path, expected] of [
        ["/a\\b", "/a\\b", "backslash"],
        ["/a%00b", "/a%00b", "nul"],
        ["/a%2Fb", "/a%2Fb", "slash"],
        ["/a/%2e%2e/b", "/a/%2e%2e/b", "dots"],
        ["/a/../b", "/a/../b", "no route"],
        ["/files/a#frag", "/files/a", "file"],
      ] as const) {
        const sent = yield* sendH3(routes, Request.get(target), undefined);
        expect(sent.h3.fields[3]).toEqual([":path", target]);
        expectRouted(sent, { path, route: expected });
      }

      // A `:path` of only a query has no absolute path (RFC 9114 section 4.3.1), and HTTP/1.1
      // refuses `GET ?q=1`. As over HTTP/2, the routes see `/`. Pinned as observed:
      // https://github.com/viell-dev/slop-warded-server/issues/39.
      const query = yield* sendH3(routes, Request.get("/"), undefined, {
        fields: replace(":path", "?q=1"),
      });
      expect(query.h3.fields[3]).toEqual([":path", "?q=1"]);
      expect(only(query).seen).toMatchObject({
        uri: `https://${authority}/?q=1`,
        path: "/",
        query: "q=1",
      });
      expectRouted(query, { path: "/", route: "root" });
      // So does a `:path` of only `?`, or only a fragment, which over HTTP/2 also reaches `/`
      // (`http2-heads.node.test.ts`), and the same issue.
      for (const [target, uri, query] of [
        ["?", `https://${authority}/?`, ""],
        ["#x", `https://${authority}/`, null],
      ] as const) {
        const sent = yield* sendH3(routes, Request.get("/"), undefined, {
          fields: replace(":path", target),
        });
        expect(sent.h3.fields[3]).toEqual([":path", target]);
        expect(only(sent).seen).toMatchObject({ uri, path: "/", query });
        expectRouted(sent, { path: "/", route: "root" });
      }

      // `:scheme` is not limited to `http` and `https`. The routes see the scheme that the client
      // named; transport security is still the listener's.
      for (const scheme of ["http", "foo"]) {
        const sent = yield* sendH3(routes, Request.get("/files/a"), undefined, {
          fields: replace(":scheme", scheme),
        });
        expect(only(sent).seen).toMatchObject({
          uri: `${scheme}://${authority}/files/a`,
          security: "https",
        });
        expectRouted(sent, { path: "/files/a", route: "file" });
      }

      // Repeated fields keep their values in order, and bytes beyond ASCII stay bytes.
      const tags = yield* sendH3(
        routes,
        Request.get("/tags").pipe(
          Request.appendHeader("x-tag", "a"),
          Request.appendHeader("x-tag", "b"),
        ),
        undefined,
      );
      expect(values(only(tags).seen.headers, "x-tag")).toEqual(["a", "b"]);
      expectRouted(tags, { path: "/tags", route: "any-tag" });
      const latin1 = yield* sendH3(
        routes,
        Request.get("/latin-1").pipe(Request.setHeader("x-latin-1", "\u0080ÿ")),
        undefined,
      );
      expect(values(latin1.h3.fields, "x-latin-1")).toEqual(["\u0080ÿ"]);
      expect(values(only(latin1).seen.headers, "x-latin-1")).toEqual([
        "\u0080ÿ",
      ]);
      expectRouted(latin1, { path: "/latin-1", route: "latin-1" });
      const utf8 = Buffer.from("é€").toString("latin1");
      const beyond = yield* sendH3(
        routes,
        Request.get("/latin-1").pipe(Request.setHeader("x-latin-1", "é€")),
        undefined,
      );
      expect(values(beyond.h3.fields, "x-latin-1")).toEqual([utf8]);
      expect(values(only(beyond).seen.headers, "x-latin-1")).toEqual([utf8]);
      expectRouted(beyond, { path: "/latin-1", route: "other" });

      // CONNECT names only `:method` and `:authority` (RFC 9114 section 4.4). The server does not
      // support CONNECT over HTTP/3 (its `docs/limits.md`) and answers it with a 501 itself, so
      // the routes never see it, where over HTTP/2 the route for CONNECT runs. So does an extended
      // CONNECT (RFC 9220), with `:protocol`, `:scheme` and `:path`. A CONNECT with `:path` and
      // without `:scheme` is h3's to refuse.
      for (const fields of [
        [
          [":method", "CONNECT"],
          [":authority", "other.test:443"],
        ],
        [
          [":method", "CONNECT"],
          [":protocol", "webtransport"],
          [":scheme", "https"],
          [":authority", authority],
          [":path", "/files/a"],
        ],
      ] satisfies ReadonlyArray<ReadonlyArray<Field>>) {
        const tunnel = yield* sendH3(routes, Request.get("/"), undefined, {
          fields: () => fields,
        });
        expect(tunnel.h3.fields).toEqual(fields);
        expect(tunnel.h3.received).toMatchObject({
          is: "response",
          status: 501,
        });
        expect(tunnel.exchanges).toEqual([]);
      }
      expectRefused(
        yield* sendH3(routes, Request.get("/"), undefined, {
          fields: () => [
            [":method", "CONNECT"],
            [":authority", "other.test:443"],
            [":path", "/"],
          ],
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("malformed pseudo-header fields that reach the routes", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const at = Request.get("/files/a");
      const block = (fields: Rewrite) =>
        sendH3(routes, at, undefined, { fields });

      // RFC 9114 section 4.3 makes each of these requests malformed: `:status` belongs to
      // responses, and `:protocol` to an extended CONNECT (RFC 9220), which a client may send only
      // after the server's SETTINGS_ENABLE_CONNECT_PROTOCOL, and the server does not send it. h2
      // refuses both with RST_STREAM (`http2-heads.node.test.ts`). h3 drops `:status`, and keeps a
      // `:protocol` that it knows in the request's extensions, so the routes see a plain GET. The
      // server's `docs/limits.md` names only repeated and late pseudo-header fields among what h3
      // lets through. Pinned as observed:
      // https://github.com/viell-dev/slop-warded-server/issues/42.
      for (const field of [
        [":status", "200"],
        [":protocol", "webtransport"],
        [":protocol", "connect-udp"],
      ] as const) {
        const sent = yield* block(withPseudo(field));
        expect(sent.h3.fields[4]).toEqual(field);
        expect(only(sent).seen).toMatchObject({
          method: "GET",
          version: "HTTP/3",
          headers: [["accept", "text/plain"]],
        });
        expectRouted(sent, { path: "/files/a", route: "file" });
        expect(sent.h3.received).toMatchObject({ status: 200 });
      }
    }).pipe(Effect.scoped),
  );

  it.live("the server checks lengths against the content", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const posted = (...lengths: ReadonlyArray<string>) =>
        sendH3(
          routes,
          lengths.reduce(
            (request, length) =>
              request.pipe(Request.appendHeader("content-length", length)),
            Request.post("/files/a").pipe(Request.body(Body.text)),
          ),
          { body: "hello" },
        );

      // The provider adds the length of the content when the request declares none.
      const plain = yield* posted();
      expect(values(plain.h3.fields, "content-length")).toEqual(["5"]);
      expect(bodyText(only(plain).dispatched)).toBe("hello");

      // Different lengths are the server's to refuse before routing (RFC 9110 section 8.6).
      expectRefused(yield* posted("5", "6"));

      // A length the DATA frames do not have makes the message malformed (RFC 9114 section
      // 4.1.2), which the server finds only as the content arrives: the route has run, and the
      // handler could not read the body. The server then stops reading with H3_MESSAGE_ERROR, and
      // the handler's response still goes out, which section 4.1.2 allows. This handler ignores
      // the failed body and answers 200, so the client sees that, where over HTTP/2 h2 resets the
      // stream.
      for (const [length, error] of [
        ["4", "the request body is longer than its Content-Length"],
        ["6", "the request body is shorter than its Content-Length"],
      ] as const) {
        const sent = yield* posted(length);
        expect(values(sent.h3.fields, "content-length")).toEqual([length]);
        expect(sent.h3.received).toMatchObject({ is: "response", status: 200 });
        expect(only(sent).dispatched?.route).toBe("file");
        expect(only(sent).dispatched?.body).toEqual({ Err: error });
      }

      // Equal lengths stay repeated, as over HTTP/2. Pinned as observed:
      // https://github.com/viell-dev/slop-warded-server/issues/41.
      const equal = yield* posted("5", "5");
      expect(values(equal.h3.fields, "content-length")).toEqual(["5", "5"]);
      expect(values(only(equal).seen.headers, "content-length")).toEqual([
        "5",
        "5",
      ]);
      expect(bodyText(only(equal).dispatched)).toBe("hello");
    }).pipe(Effect.scoped),
  );
});
