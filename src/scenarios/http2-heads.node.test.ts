/**
 * Hostile HTTP/2 request heads, sent to the `https` listener by the HTTP/2 provider, which writes a
 * header block field by field through the host's HTTP/2 client: pseudo-header fields that are
 * repeated, late, missing or unknown, `:authority` against `Host`, split `Cookie` fields, and the
 * shapes of the HTTP/1.1 probe list in `hostile-heads.node.test.ts`. Node-only, because the provider
 * runs the host's client as a child process.
 *
 * Two layers decide before any route runs. Hyper's HTTP/2 implementation, the `h2` crate, refuses a
 * malformed head (RFC 9113 section 8.1.1) with a stream error, RST_STREAM with PROTOCOL_ERROR. A
 * field it cannot turn into the `http` crate's types, such as an uppercase name, a NUL in a value or
 * a path that is not UTF-8, ends the whole connection with GOAWAY and PROTOCOL_ERROR, which RFC 9113
 * section 5.4.1 allows for any stream error. Then the Warded Server checks the host and the
 * whitespace around values with a 400 that says why, and joins split cookies, as its README and
 * `docs/troubleshooting.md` say.
 *
 * The HTTPS listener has no recording proxy. The provider writes each field as a plain literal and
 * records the fields it wrote, so they are what crossed the wire. With the head, the verdict and
 * the dispatch, they are the four records of each exchange.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { lane } from "#lane";
import {
  bodyText,
  type Field,
  type H2Exchange,
  type H2Received,
  values,
} from "../harness/evidence.js";
import type { H2Options } from "../harness/lane.js";
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

const h2 = lane.h2!;

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

interface SentH2 extends Sent {
  /** What the HTTP/2 client wrote, and what came back. */
  readonly h2: H2Exchange;
}

/** Send a request through the HTTP/2 provider to the table's HTTPS listener. */
const sendH2 = <I, E>(
  routes: Table,
  request: Request.Request<I, E>,
  input: I,
  options?: H2Options,
): Effect.Effect<SentH2> =>
  Effect.gen(function* () {
    const provider = h2(routes.origins.https, options);
    const sent = yield* send(
      routes,
      "https",
      provider.layer,
      Operation.make(request, replies),
      input,
    );
    expect(provider.exchanges, JSON.stringify(sent)).toHaveLength(1);
    return { ...sent, h2: provider.exchanges[0]! };
  });

type Rewrite = NonNullable<H2Options["fields"]>;

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

const names = (sent: SentH2) => sent.h2.fields.map(([name]) => name);
const textOf = (received: H2Received) =>
  received.is === "response"
    ? Buffer.from(received.body, "base64").toString("utf8")
    : undefined;

const reset: H2Received = { is: "reset", code: "PROTOCOL_ERROR" };
const goAway: H2Received = { is: "go_away", code: "PROTOCOL_ERROR", debug: "" };

/** The records of a request h2 refused: written, and seen nowhere after. */
const expectRefusedByH2 = (sent: SentH2, received: H2Received) => {
  expect(sent.h2.received, JSON.stringify(sent)).toEqual(received);
  expect(sent.exchanges).toEqual([]);
  expect(sent.outcome).toMatchObject({
    kind: "failure",
    tag: "HttpClientError/TransportError",
  });
};

/** The records of a request the Warded Server refused: through h2, and not to the routes. */
const expectRefusedByServer = (sent: SentH2, reason: string) => {
  expect(sent.h2.received, JSON.stringify(sent)).toMatchObject({
    is: "response",
    status: 400,
  });
  expect(textOf(sent.h2.received)).toBe(`Malformed request: ${reason}.\n`);
  expect(sent.exchanges).toEqual([]);
};

const pseudo = [":method", ":scheme", ":authority", ":path"] as const;

describe("hostile HTTP/2 request heads", () => {
  it.live("the provider's own head reaches the routes as undici's does", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const authority = new URL(routes.origins.https).host;
      const sent = yield* sendH2(routes, Request.get("/files/a"), undefined);
      expect(sent.h2.fields).toEqual([
        [":method", "GET"],
        [":scheme", "https"],
        [":authority", authority],
        [":path", "/files/a"],
        ["accept", "text/plain"],
      ]);
      const { seen, verdict, dispatched } = only(sent);
      expect(seen).toEqual({
        method: "GET",
        version: "HTTP/2",
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
      expect(sent.h2.received).toMatchObject({ is: "response", status: 200 });

      // Undici is the lane's HTTP/2 client. It adds fields of its own, and the routes see the same
      // version, target and choice.
      const undici = lane.clients.find((client) => client.name === "undici")!;
      const standard = yield* send(
        routes,
        "https",
        undici,
        Operation.make(Request.get("/files/a"), replies),
        undefined,
      );
      expect(only(standard).seen).toMatchObject({
        version: "HTTP/2",
        uri: seen.uri,
        path: seen.path,
      });
      expect(only(standard).verdict).toEqual(verdict);
    }).pipe(Effect.scoped),
  );

  it.live(
    "h2 refuses repeated, late, missing and unknown pseudo-header fields",
    () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const at = Request.get("/files/a");
        const block = (fields: Rewrite) =>
          sendH2(routes, at, undefined, { fields });

        // RFC 9113 section 8.3: each pseudo-header field once, before every other field, and
        // `:method`, `:scheme` and a non-empty `:path` in every request but CONNECT.
        const [m, s, a, p] = pseudo;
        for (const [fields, wire] of [
          [twice(":path"), [m, s, a, p, p, "accept"]],
          [twice(":path", "/files/b"), [m, s, a, p, p, "accept"]],
          [twice(":method"), [m, m, s, a, p, "accept"]],
          [twice(":scheme"), [m, s, s, a, p, "accept"]],
          [twice(":authority"), [m, s, a, a, p, "accept"]],
          [last(":path"), [m, s, a, "accept", p]],
          [last(":authority"), [m, s, p, "accept", a]],
          [without(":method"), [s, a, p, "accept"]],
          [without(":scheme"), [m, a, p, "accept"]],
          [without(":path"), [m, s, a, "accept"]],
          [replace(":path", ""), [m, s, a, p, "accept"]],
          // Only responses have `:status`, and `:protocol` belongs to extended CONNECT.
          [withPseudo([":status", "200"]), [m, s, a, p, ":status", "accept"]],
          [
            withPseudo([":protocol", "websocket"]),
            [m, s, a, p, ":protocol", "accept"],
          ],
        ] as const) {
          const sent = yield* block(fields);
          expect(names(sent)).toEqual(wire);
          expectRefusedByH2(sent, reset);
        }

        // An unknown pseudo-header field fails h2's decoding of the block, a connection error.
        const unknown = yield* block(withPseudo([":foo", "bar"]));
        expect(names(unknown)).toEqual([...pseudo, ":foo", "accept"]);
        expectRefusedByH2(unknown, goAway);

        // The library passes on a header name as written, and asks a provider that writes bytes to
        // refuse one that is not a token, as `:path` is not (its transport guide, and
        // https://github.com/viell-dev/slop-effect-schema-http/issues/302). This provider refuses
        // nothing, so the declared field follows the provider's own `:path` and a regular field:
        // repeated and late.
        const declared = yield* sendH2(
          routes,
          at.pipe(
            Request.setHeader("x-a", "1"),
            Request.setHeader(":path", "/b"),
          ),
          undefined,
        );
        expect(declared.h2.fields.slice(4)).toEqual([
          ["x-a", "1"],
          [":path", "/b"],
          ["accept", "text/plain"],
        ]);
        expectRefusedByH2(declared, reset);
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
      const expectRouted = (
        sent: SentH2,
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

      // RFC 9113 section 8.3.1: a `Host` beside `:authority` names the same host. The Warded
      // Server refuses one that names another (its `docs/requests.md`); as measured, it compares
      // them without case and with the scheme's default port, as RFC 3986 section 6.2.3 does. The
      // guide's host condition reads the URI first.
      for (const [authority, field] of [
        [`localhost:${port}`, `localhost:${port}`],
        ["LOCALHOST:443", "localhost"],
        ["localhost", "localhost"],
      ] as const) {
        const sent = yield* sendH2(routes, withHosts(field), undefined, {
          fields: replace(":authority", authority),
        });
        expect(sent.h2.fields).toContainEqual([":authority", authority]);
        expect(values(sent.h2.fields, "host")).toEqual([field]);
        expectRouted(sent, {
          route: "localhost",
          uri: `https://${authority}/host`,
          hosts: [field],
        });
      }
      const another = "the Host field names another host than :authority";
      for (const field of ["other.test", "localhost:1"])
        expectRefusedByServer(
          yield* sendH2(routes, withHosts(field), undefined, {
            fields: replace(":authority", `localhost:${port}`),
          }),
          another,
        );

      // Without `:authority` the target has no host, and the condition reads `Host`. HTTP/2 needs
      // neither (the server's `docs/requests.md`), so a request with none falls through.
      const fieldOnly = yield* sendH2(
        routes,
        withHosts("other.test"),
        undefined,
        {
          fields: without(":authority"),
        },
      );
      expect(names(fieldOnly)).toEqual([
        ":method",
        ":scheme",
        ":path",
        "host",
        "accept",
      ]);
      expectRouted(fieldOnly, {
        route: "other.test",
        uri: "/host",
        hosts: ["other.test"],
      });
      const neither = yield* sendH2(routes, atHost, undefined, {
        fields: without(":authority"),
      });
      expectRouted(neither, {
        route: "no host route",
        uri: "/host",
        hosts: [],
      });

      // Two `:authority` fields are h2's to refuse, two `Host` fields the server's.
      expectRefusedByH2(
        yield* sendH2(routes, atHost, undefined, {
          fields: twice(":authority", "other.test"),
        }),
        reset,
      );
      const several = "the request has several Host fields";
      expectRefusedByServer(
        yield* sendH2(routes, withHosts("localhost", "localhost"), undefined, {
          fields: replace(":authority", "localhost"),
        }),
        several,
      );
      expectRefusedByServer(
        yield* sendH2(routes, withHosts("localhost", "localhost"), undefined, {
          fields: without(":authority"),
        }),
        several,
      );

      // An `:authority` that `http::uri::Authority` cannot parse, an empty one among them, is h2's
      // to refuse. One that it parses but is no `host [ ":" port ]` is the server's.
      for (const authority of ["not a host/x", "localhost/x", ""])
        expectRefusedByH2(
          yield* sendH2(routes, atHost, undefined, {
            fields: replace(":authority", authority),
          }),
          reset,
        );
      for (const authority of ["user@localhost", "localhost:abc", "[bogus]"])
        expectRefusedByServer(
          yield* sendH2(routes, atHost, undefined, {
            fields: replace(":authority", authority),
          }),
          "the request target names an invalid host",
        );

      // An invalid `Host`, with `:authority` or without. Over HTTP/1.1 an empty `Host` says that
      // the target has none, which `hostile-heads.node.test.ts` shows; over HTTP/2 it is no host.
      for (const [field, fields] of [
        ["not a host/x", undefined],
        ["", undefined],
        ["", without(":authority")],
        ["user@host", without(":authority")],
      ] as const)
        expectRefusedByServer(
          yield* sendH2(
            routes,
            withHosts(field),
            undefined,
            fields === undefined ? undefined : { fields },
          ),
          "the Host field is not a valid host",
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

      // RFC 9113 section 8.2.3 lets an HTTP/2 client split `Cookie`, and requires joining the
      // fields with `; ` before an application sees them. Hyper leaves that to the server.
      const split = yield* sendH2(
        routes,
        cookies("a=1", "b=2; c=3"),
        undefined,
      );
      expect(values(split.h2.fields, "cookie")).toEqual(["a=1", "b=2; c=3"]);
      const { seen, dispatched } = only(split);
      expect(values(seen.headers, "cookie")).toEqual(["a=1; b=2; c=3"]);
      expect(dispatched?.route).toBe("cookies");

      // HTTP/1.1 has one `Cookie` field (RFC 6265 section 5.4), so the server joins nothing there,
      // and `header_eq` refuses the repeated field.
      const lines = yield* send(
        routes,
        "http",
        lane.raw!(routes.origins.http),
        Operation.make(cookies("a=1", "b=2; c=3"), replies),
        undefined,
      );
      expect(values(lines.wire[0]!.lines, "cookie")).toEqual([
        "a=1",
        "b=2; c=3",
      ]);
      expect(values(only(lines).seen.headers, "cookie")).toEqual([
        "a=1",
        "b=2; c=3",
      ]);
      expect(only(lines).dispatched?.route).toBe("other");

      // Each crumb is a field value, and the server checks it before joining.
      expectRefusedByServer(
        yield* sendH2(routes, cookies("a=1", " b=2"), undefined),
        "a field value begins or ends with whitespace",
      );
      const empty = yield* sendH2(routes, cookies(""), undefined);
      expect(values(only(empty).seen.headers, "cookie")).toEqual([""]);

      // An empty crumb passes that check, and joining it leaves `; ` at the end: a value that
      // ends with whitespace, which the server refuses when a client sends it, and HTTP/1.1
      // removes. Pinned as observed: https://github.com/viell-dev/slop-warded-server/issues/40.
      const crumb = yield* sendH2(routes, cookies("a=1", ""), undefined);
      expect(values(crumb.h2.fields, "cookie")).toEqual(["a=1", ""]);
      expect(values(only(crumb).seen.headers, "cookie")).toEqual(["a=1; "]);
      expect(only(crumb).dispatched?.route).toBe("other");
      const trimmed = yield* send(
        routes,
        "http",
        lane.raw!(routes.origins.http),
        Operation.make(
          Request.get("/cookies").pipe(Request.setHeader("cookie", "a=1; ")),
          replies,
        ),
        undefined,
      );
      expect(values(trimmed.wire[0]!.lines, "cookie")).toEqual(["a=1;"]);
      expect(values(only(trimmed).seen.headers, "cookie")).toEqual(["a=1;"]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "h2 refuses what HTTP/1.1 parsers refuse, some for the connection",
    () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const at = Request.get("/files/a");
        const header = (name: string, value: string) =>
          sendH2(routes, at.pipe(Request.setHeader(name, value)), undefined);

        // Hyper's HTTP/1.1 parser answers most of these with a 400 (`hostile-heads.node.test.ts`).
        // h2 refuses a space in `:path`, which `http::uri::PathAndQuery` does not take, for the
        // stream; and for the connection, a name that is not a lowercase token (RFC 9113 section
        // 8.2.1) and a value or `:path` that `http` cannot hold.
        const spaced = yield* sendH2(
          routes,
          Request.get("/files/a b"),
          undefined,
        );
        expect(spaced.h2.fields[3]).toEqual([":path", "/files/a b"]);
        expectRefusedByH2(spaced, reset);
        const latin1Path = yield* sendH2(routes, at, undefined, {
          fields: replace(":path", "/files/aÿb"),
        });
        expectRefusedByH2(latin1Path, goAway);
        for (const [name, value] of [
          ["x-a", "a\u0000b"],
          ["x-a", "a\r\nb"],
          ["x a", "b"],
          ["", "b"],
          // Over HTTP/1.1 the colon ends the name, and the routes see `x` (the HTTP/1.1 tests).
          ["x:a", "b"],
          // A standard HTTP/2 client lowercases names; this provider writes them as declared.
          ["X-A", "b"],
        ] as const) {
          const sent = yield* header(name, value);
          expect(sent.h2.fields[4]).toEqual([name, value]);
          expectRefusedByH2(sent, goAway);
        }

        // Fields about an HTTP/1.1 connection make an HTTP/2 message malformed, apart from
        // `te: trailers` (RFC 9113 section 8.2.2).
        for (const [name, value] of [
          ["connection", "close"],
          ["keep-alive", "5"],
          ["proxy-connection", "close"],
          ["upgrade", "h2c"],
          ["transfer-encoding", "chunked"],
          ["te", "gzip"],
        ] as const)
          expectRefusedByH2(yield* header(name, value), reset);
        const te = yield* header("te", "trailers");
        expect(values(only(te).seen.headers, "te")).toEqual(["trailers"]);
        expect(only(te).dispatched?.route).toBe("file");

        // A `:path` that is not origin-form: h2 refuses a relative or absolute one.
        for (const target of ["files/a", "https://other.test/files/a"])
          expectRefusedByH2(
            yield* sendH2(routes, at, undefined, {
              fields: replace(":path", target),
            }),
            reset,
          );
      }).pipe(Effect.scoped),
  );

  it.live("what reaches the routes as written over HTTP/2", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const authority = new URL(routes.origins.https).host;
      const routed = (
        sent: SentH2,
        expected: { readonly path: string; readonly route: string },
      ) => {
        const { seen, dispatched } = only(sent);
        expect(seen.path, JSON.stringify(sent)).toBe(expected.path);
        expect(dispatched?.route, JSON.stringify(sent)).toBe(expected.route);
      };

      // Extension and lowercase methods. `get()` is GET, so `get` needs `method("get")`.
      const search = yield* sendH2(
        routes,
        Request.make("M-SEARCH", "/"),
        undefined,
        { fields: replace(":path", "*") },
      );
      expect(search.h2.fields.slice(0, 4)).toEqual([
        [":method", "M-SEARCH"],
        [":scheme", "https"],
        [":authority", authority],
        [":path", "*"],
      ]);
      expect(only(search).seen.method).toBe("M-SEARCH");
      routed(search, { path: "*", route: "m-search" });
      const lower = yield* sendH2(
        routes,
        Request.make("get", "/get"),
        undefined,
      );
      expect(only(lower).seen.method).toBe("get");
      routed(lower, { path: "/get", route: "get" });
      routed(yield* sendH2(routes, Request.get("/get"), undefined), {
        path: "/get",
        route: "GET",
      });

      // The raw path, as over HTTP/1.1: nothing is decoded or resolved, and a fragment is dropped.
      for (const [target, path, expected] of [
        ["/a\\b", "/a\\b", "backslash"],
        ["/a%00b", "/a%00b", "nul"],
        ["/a%2Fb", "/a%2Fb", "slash"],
        ["/a/%2e%2e/b", "/a/%2e%2e/b", "dots"],
        ["/a/../b", "/a/../b", "no route"],
        ["/files/a#frag", "/files/a", "file"],
      ] as const) {
        const sent = yield* sendH2(routes, Request.get(target), undefined);
        expect(sent.h2.fields[3]).toEqual([":path", target]);
        routed(sent, { path, route: expected });
      }

      // A `:path` of only a query is not origin-form either, since it has no absolute path (RFC
      // 9113 section 8.3.1), and Hyper's HTTP/1.1 parser answers `GET ?q=1` with a 400. h2 passes
      // it on, `http::Uri::path` gives `/`, and the route for `/` runs. Pinned as observed:
      // https://github.com/viell-dev/slop-warded-server/issues/39.
      const query = yield* sendH2(routes, Request.get("/"), undefined, {
        fields: replace(":path", "?q=1"),
      });
      expect(query.h2.fields[3]).toEqual([":path", "?q=1"]);
      expect(only(query).seen).toMatchObject({
        uri: `https://${authority}/?q=1`,
        path: "/",
        query: "q=1",
      });
      routed(query, { path: "/", route: "root" });

      // `:scheme` is not limited to `http` and `https` (RFC 9113 section 8.3.1). The routes see the
      // scheme that the client named; transport security is still the listener's.
      for (const scheme of ["http", "foo"]) {
        const sent = yield* sendH2(routes, Request.get("/files/a"), undefined, {
          fields: replace(":scheme", scheme),
        });
        expect(only(sent).seen).toMatchObject({
          uri: `${scheme}://${authority}/files/a`,
          security: "https",
        });
        routed(sent, { path: "/files/a", route: "file" });
      }

      // Repeated fields keep their values in order, and bytes beyond ASCII stay bytes.
      const tags = yield* sendH2(
        routes,
        Request.get("/tags").pipe(
          Request.appendHeader("x-tag", "a"),
          Request.appendHeader("x-tag", "b"),
        ),
        undefined,
      );
      expect(values(only(tags).seen.headers, "x-tag")).toEqual(["a", "b"]);
      routed(tags, { path: "/tags", route: "any-tag" });
      const latin1 = yield* sendH2(
        routes,
        Request.get("/latin-1").pipe(Request.setHeader("x-latin-1", "\u0080ÿ")),
        undefined,
      );
      expect(values(latin1.h2.fields, "x-latin-1")).toEqual(["\u0080ÿ"]);
      expect(values(only(latin1).seen.headers, "x-latin-1")).toEqual([
        "\u0080ÿ",
      ]);
      routed(latin1, { path: "/latin-1", route: "latin-1" });
      const utf8 = Buffer.from("é€").toString("latin1");
      const beyond = yield* sendH2(
        routes,
        Request.get("/latin-1").pipe(Request.setHeader("x-latin-1", "é€")),
        undefined,
      );
      expect(values(beyond.h2.fields, "x-latin-1")).toEqual([utf8]);
      expect(values(only(beyond).seen.headers, "x-latin-1")).toEqual([utf8]);
      routed(beyond, { path: "/latin-1", route: "other" });

      // CONNECT names only `:method` and `:authority` (RFC 9113 section 8.5), and the target is
      // the authority. A successful response opens the tunnel, so the client stops at its head.
      const tunnel = yield* sendH2(routes, Request.get("/"), undefined, {
        fields: () => [
          [":method", "CONNECT"],
          [":authority", "other.test:443"],
        ],
      });
      expect(only(tunnel).seen).toMatchObject({
        method: "CONNECT",
        uri: "other.test:443",
        path: "",
      });
      routed(tunnel, { path: "", route: "connect" });
      expect(tunnel.h2.received).toEqual({
        is: "response",
        status: 200,
        fields: expect.any(Array),
        body: "",
      });
      expectRefusedByH2(
        yield* sendH2(routes, Request.get("/"), undefined, {
          fields: () => [
            [":method", "CONNECT"],
            [":authority", "other.test:443"],
            [":path", "/"],
          ],
        }),
        reset,
      );
    }).pipe(Effect.scoped),
  );

  it.live("h2 checks lengths against the content", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const posted = (...lengths: ReadonlyArray<string>) =>
        sendH2(
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
      expect(values(plain.h2.fields, "content-length")).toEqual(["5"]);
      expect(bodyText(only(plain).dispatched)).toBe("hello");

      // Different lengths are h2's to refuse before routing (RFC 9110 section 8.6).
      expectRefusedByH2(yield* posted("5", "6"), reset);

      // A length the DATA frames do not have makes the message malformed (RFC 9113 section 8.1.1),
      // which h2 finds only as the content arrives: the route has run, the handler could not read
      // the body, and the client sees the stream reset.
      for (const length of ["4", "6"]) {
        const sent = yield* posted(length);
        expect(values(sent.h2.fields, "content-length")).toEqual([length]);
        expect(sent.h2.received).toEqual(reset);
        expect(only(sent).dispatched?.route).toBe("file");
        expect(only(sent).dispatched?.body).toHaveProperty("Err");
      }

      // RFC 9110 section 8.6 lets a recipient refuse equal lengths, or take them as one, which
      // Hyper's HTTP/1.1 parser does (`hostile-heads.node.test.ts`). Over HTTP/2 the head keeps
      // both. Pinned as observed: https://github.com/viell-dev/slop-warded-server/issues/41.
      const equal = yield* posted("5", "5");
      expect(values(equal.h2.fields, "content-length")).toEqual(["5", "5"]);
      expect(values(only(equal).seen.headers, "content-length")).toEqual([
        "5",
        "5",
      ]);
      expect(bodyText(only(equal).dispatched)).toBe("hello");
    }).pipe(Effect.scoped),
  );
});
