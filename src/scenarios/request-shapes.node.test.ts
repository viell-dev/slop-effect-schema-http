/**
 * EXT-10: request shapes no standard client sends, through the raw client. These run in the Node
 * lane only, because only Node has the raw client: a page has no socket to write a request on. The
 * same shapes through `fetch`, in both lanes, are in `request-shapes.test.ts`; the letters match.
 *
 * The server's answer is not the point. `echo`'s socket listener refuses nothing and records
 * `head`, the request as it arrived, which is the proof here, and it answers these paths with 404.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { watching } from "../clients/received.js";
import { bodyText, header, headerValues } from "../harness/lane.js";

const notFound = Response.status(404, Body.text);

/** Send one request through the raw client to a fresh `echo`, which must see exactly that one. */
const sentWith = <I, E, R>(
  build: (origin: string) => Request.Request<I, E, R>,
  input: I,
) =>
  Effect.gen(function* () {
    const echo = yield* lane.backend("echo", undefined, { listener: "socket" });
    const watched = watching();
    const text = yield* Operation.make(build(echo.origin), notFound, {
      transformClient: watched.last,
    })
      .execute(input)
      .pipe(Effect.provide(lane.rawClient!(echo.origin)));
    expect(text).toBe("Not Found");
    const [entry, ...rest] = yield* echo.ledger;
    expect(rest).toEqual([]);
    expect(watched.received).toHaveLength(1);
    return {
      entry: entry!,
      received: watched.received[0]!,
      origin: echo.origin,
      host: new URL(echo.origin).host,
    };
  });

const sent = <E, R>(
  build: (origin: string) => Request.Request<unknown, E, R>,
) => sentWith(build, undefined);

const headOf = (...lines: ReadonlyArray<string>) => lines.join("\r\n");

/** An entry whose `head` is its request line, then `host` and `accept`, and nothing more. */
const sends = (
  title: string,
  declare: (url: string) => Request.Request<unknown>,
  method: string,
  path: string,
  target: string = path,
) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const { entry, received, origin, host } = yield* sent((base) =>
        declare(`${base}${path}`),
      );
      expect(received).toEqual({
        method,
        url: `${origin}${path}`,
        hash: undefined,
      });
      expect(entry.method).toBe(method);
      expect(entry.target).toBe(target);
      expect(entry.head).toBe(
        headOf(
          `${method} ${target} HTTP/1.1`,
          `host: ${host}`,
          "accept: text/plain",
        ),
      );
    }),
  );

const withMethod = (method: string) => (url: string) =>
  Request.make(method, url);

describe("request shapes through the raw client (node)", () => {
  sends(
    "[EXT-10a] the raw client sends /a/../b with its dot segments",
    Request.get,
    "GET",
    "/a/../b",
  );
  sends(
    "[EXT-10b] the raw client sends /a/%2e%2e/b unchanged",
    Request.get,
    "GET",
    "/a/%2e%2e/b",
  );
  sends(
    "[EXT-10c] the raw client sends a backslash in a path unchanged",
    Request.get,
    "GET",
    "/a\\b",
  );
  sends(
    "[EXT-10d] the raw client sends a raw space in a path",
    Request.get,
    "GET",
    "/a b",
  );
  // The ledger reads bytes as characters one for one: these two are UTF-8's `ä`, C3 A4.
  sends(
    "[EXT-10e] the raw client sends /ä as its raw UTF-8 bytes",
    Request.get,
    "GET",
    "/ä",
    "/Ã¤",
  );
  sends(
    "[EXT-10f] the raw client sends a tab in a path",
    Request.get,
    "GET",
    "/a\tb",
  );
  for (const path of ["/a//b", "/a;v=1/b", "/a%2Fb"])
    sends(
      `[EXT-10g] the raw client sends ${path} unchanged`,
      Request.get,
      "GET",
      path,
    );
  sends(
    "[EXT-10h] the raw client sends the method get in lower case",
    withMethod("get"),
    "get",
    "/shape",
  );
  sends(
    "[EXT-10i] the raw client sends the method patch in lower case",
    withMethod("patch"),
    "patch",
    "/shape",
  );
  for (const method of ["TRACE", "CONNECT"])
    sends(
      `[EXT-10j] the raw client sends ${method}`,
      withMethod(method),
      method,
      "/shape",
    );

  it.live(
    "[EXT-10k] the raw client sends the method BAD METHOD, which the server splits at its space",
    () =>
      Effect.gen(function* () {
        const { entry, received, origin, host } = yield* sent((base) =>
          Request.make("BAD METHOD", `${base}/shape`),
        );
        expect(received).toEqual({
          method: "BAD METHOD",
          url: `${origin}/shape`,
          hash: undefined,
        });
        expect(entry.method).toBe("BAD");
        expect(entry.target).toBe("METHOD /shape");
        expect(entry.head).toBe(
          headOf(
            "BAD METHOD /shape HTTP/1.1",
            `host: ${host}`,
            "accept: text/plain",
          ),
        );
      }),
  );

  sends(
    "[EXT-10l] the raw client sends OPTIONS on the path /*",
    Request.options,
    "OPTIONS",
    "/*",
  );

  it.live(
    "[EXT-10m] the raw client sends the host header the request set",
    () =>
      Effect.gen(function* () {
        const { entry, received, origin } = yield* sent((base) =>
          Request.get(`${base}/shape`).pipe(
            Request.setHeader("host", "other.example:8080"),
          ),
        );
        expect(received.url).toBe(`${origin}/shape`);
        expect(headerValues(entry.lines, "host")).toEqual([
          "other.example:8080",
        ]);
        expect(entry.head).toBe(
          headOf(
            "GET /shape HTTP/1.1",
            "host: other.example:8080",
            "accept: text/plain",
          ),
        );
      }),
  );

  it.live("[EXT-10n] the raw client sends an empty header value", () =>
    Effect.gen(function* () {
      const { entry, received, origin, host } = yield* sent((base) =>
        Request.get(`${base}/shape`).pipe(Request.setHeader("x-empty", "")),
      );
      expect(received.url).toBe(`${origin}/shape`);
      expect(entry.head).toBe(
        headOf(
          "GET /shape HTTP/1.1",
          `host: ${host}`,
          "x-empty: ",
          "accept: text/plain",
        ),
      );
      expect(entry.lines).toContainEqual(["x-empty", ""]);
    }),
  );

  it.live(
    "[EXT-10o] the raw client sends a Latin-1 header value as Latin-1 bytes",
    () =>
      Effect.gen(function* () {
        const { entry, received, origin, host } = yield* sent((base) =>
          Request.get(`${base}/shape`).pipe(
            Request.setHeader("x-name", "Müller"),
          ),
        );
        expect(received.url).toBe(`${origin}/shape`);
        // One character per byte, so `ü` is the single byte 0xFC, not UTF-8's C3 BC.
        expect(header(entry.lines, "x-name")).toBe("Müller");
        expect(entry.head).toBe(
          headOf(
            "GET /shape HTTP/1.1",
            `host: ${host}`,
            "x-name: Müller",
            "accept: text/plain",
          ),
        );
      }),
  );

  it.live(
    "[EXT-10p] a header value with CR and LF becomes two header lines through the raw client",
    () =>
      Effect.gen(function* () {
        const { entry, received, origin, host } = yield* sent((base) =>
          Request.get(`${base}/shape`).pipe(
            Request.setHeader("x-name", "a\r\nx-added: b"),
          ),
        );
        expect(received.url).toBe(`${origin}/shape`);
        expect(entry.head).toBe(
          headOf(
            "GET /shape HTTP/1.1",
            `host: ${host}`,
            "x-name: a",
            "x-added: b",
            "accept: text/plain",
          ),
        );
        expect(header(entry.lines, "x-name")).toBe("a");
        expect(header(entry.lines, "x-added")).toBe("b");
      }),
  );

  it.live(
    "[EXT-10q] a path with CR and LF breaks the request line through the raw client",
    () =>
      Effect.gen(function* () {
        const { entry, received, origin, host } = yield* sent((base) =>
          Request.get(`${base}/a\r\nb`),
        );
        expect(received.url).toBe(`${origin}/a\r\nb`);
        expect(entry.head).toBe(
          headOf("GET /a", "b HTTP/1.1", `host: ${host}`, "accept: text/plain"),
        );
        expect(entry.method).toBe("GET");
        expect(entry.target).toBe("/a");
        expect(entry.lines[0]).toEqual(["b HTTP/1.1", ""]);
      }),
  );

  it.live("[EXT-10r] the raw client sends a URL with user info whole", () =>
    Effect.gen(function* () {
      const { entry, received, host } = yield* sent((base) =>
        Request.get(`${base.replace("http://", "http://user:pw@")}/shape`),
      );
      const url = `http://user:pw@${host}/shape`;
      expect(received.url).toBe(url);
      expect(entry.target).toBe(url);
      expect(entry.head).toBe(
        headOf(`GET ${url} HTTP/1.1`, `host: ${host}`, "accept: text/plain"),
      );
    }),
  );

  it.live("[EXT-10s] the raw client sends a DELETE with its body", () =>
    Effect.gen(function* () {
      const { entry, received, origin, host } = yield* sentWith(
        (base) => Request.del(`${base}/shape`).pipe(Request.body(Body.text)),
        { body: "gone" },
      );
      expect(received).toEqual({
        method: "DELETE",
        url: `${origin}/shape`,
        hash: undefined,
      });
      expect(entry.head).toBe(
        headOf(
          "DELETE /shape HTTP/1.1",
          `host: ${host}`,
          "content-type: text/plain",
          "content-length: 4",
          "accept: text/plain",
        ),
      );
      expect(bodyText(entry)).toBe("gone");
    }),
  );

  it.live("[EXT-10t] the raw client sends OPTIONS *", () =>
    Effect.gen(function* () {
      const { entry, received, host } = yield* sent(() => Request.options("*"));
      expect(received).toEqual({
        method: "OPTIONS",
        url: "*",
        hash: undefined,
      });
      expect(entry.target).toBe("*");
      expect(entry.head).toBe(
        headOf("OPTIONS * HTTP/1.1", `host: ${host}`, "accept: text/plain"),
      );
    }),
  );

  it.live("[EXT-10u] the raw client sends an unparseable URL whole", () =>
    Effect.gen(function* () {
      const { entry, received, host } = yield* sent(() =>
        Request.get("http://[bad/x"),
      );
      expect(received.url).toBe("http://[bad/x");
      expect(entry.target).toBe("http://[bad/x");
      expect(entry.head).toBe(
        headOf(
          "GET http://[bad/x HTTP/1.1",
          `host: ${host}`,
          "accept: text/plain",
        ),
      );
    }),
  );

  for (const query of ["?a=1;b=2", "?a=1&&b=2", "?", "?a=%2f", "?q=a|b[1]{x}"])
    it.live(
      `[EXT-10v] the raw client sends the opaque query ${query} unchanged`,
      () =>
        Effect.gen(function* () {
          const { entry, received, origin, host } = yield* sent((base) =>
            Request.get(`${base}/shape`).pipe(
              Request.mapEffect((request) =>
                Effect.succeed(
                  HttpClientRequest.setUrl(request, `${request.url}${query}`),
                ),
              ),
            ),
          );
          expect(received.url).toBe(`${origin}/shape${query}`);
          expect(entry.target).toBe(`/shape${query}`);
          expect(entry.head).toBe(
            headOf(
              `GET /shape${query} HTTP/1.1`,
              `host: ${host}`,
              "accept: text/plain",
            ),
          );
        }),
    );
});
