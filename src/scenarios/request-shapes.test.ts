/**
 * EXT-11: the shapes of EXT-10 through `fetch`, in both lanes; the letters match. Whatever the
 * platform then does, the client received the request as declared, so a regression that changed a
 * shape in the library before the platform saw it, in one lane or the other, fails here.
 *
 * The server's answer is not the point. `echo`'s socket listener takes what `node:http` would
 * refuse or reshape, and it answers these paths with 404.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { watching } from "../clients/received.js";
import { bodyText, header, headerValues } from "../harness/lane.js";

const notFound = Response.status(404, Body.text);

/** Send one request through `fetch` to a fresh `echo`, and return all that came of it. */
const attemptWith = <I, E, R>(
  build: (origin: string) => Request.Request<I, E, R>,
  input: I,
) =>
  Effect.gen(function* () {
    const echo = yield* lane.backend("echo", undefined, { listener: "socket" });
    const watched = watching();
    const exit = yield* Operation.make(build(echo.origin), notFound, {
      transformClient: watched.last,
    })
      .execute(input)
      .pipe(Effect.provide(lane.fetchClient), Effect.exit);
    expect(watched.received).toHaveLength(1);
    return {
      exit,
      ledger: yield* echo.ledger,
      received: watched.received[0]!,
      details: watched.details[0]!,
      origin: echo.origin,
      host: new URL(echo.origin).host,
    };
  });

const attempt = <E, R>(
  build: (origin: string) => Request.Request<unknown, E, R>,
) => attemptWith(build, undefined);

/** A request `fetch` delivers: `echo` saw exactly one, and answered it. */
const delivered = <I, E, R>(
  build: (origin: string) => Request.Request<I, E, R>,
  input: I,
) =>
  Effect.gen(function* () {
    const { exit, ledger, ...rest } = yield* attemptWith(build, input);
    expect(yield* exit).toBe("Not Found");
    expect(ledger).toHaveLength(1);
    return { ...rest, entry: ledger[0]! };
  });

/** An entry that compares what the client received with the method and target that arrived. */
const arrives = (
  title: string,
  declare: (url: string) => Request.Request<unknown>,
  method: string,
  path: string,
  target: string,
  arrivedMethod: string = method,
) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const { entry, received, origin } = yield* delivered(
        (base) => declare(`${base}${path}`),
        undefined,
      );
      expect(received).toEqual({
        method,
        url: `${origin}${path}`,
        hash: undefined,
      });
      expect(entry.method).toBe(arrivedMethod);
      expect(entry.target).toBe(target);
    }),
  );

/** An entry `fetch` refuses as `reason`, with nothing reaching `echo`. */
const refuses = (
  title: string,
  build: (origin: string) => Request.Request<unknown>,
  method: string,
  url: (origin: string) => string,
  reason: "TransportError" | "InvalidUrlError",
) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const { exit, ledger, received, origin } = yield* attempt(build);
      expect(received).toEqual({ method, url: url(origin), hash: undefined });
      expect(ledger).toEqual([]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = exit.cause.reasons[0];
      expect(error?._tag).toBe("Fail");
      if (error?._tag !== "Fail") return;
      expect(error.error._tag).toBe("HttpClientError");
      if (error.error._tag !== "HttpClientError") return;
      expect(error.error.reason._tag).toBe(reason);
    }),
  );

const withMethod = (method: string) => (url: string) =>
  Request.make(method, url);

/** An entry whose body `fetch` refuses on this method, after the client received all of it. */
const refusesBody = (
  title: string,
  method: string,
  declare: (url: string) => Request.Request<unknown>,
) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const { exit, ledger, received, details, origin } = yield* attemptWith(
        (base) => declare(`${base}/shape`).pipe(Request.body(Body.text)),
        { body: "hello" },
      );
      expect(received).toEqual({
        method,
        url: `${origin}/shape`,
        hash: undefined,
      });
      expect(details.body).toBe("hello");
      expect(details.headers).toEqual({
        "content-type": "text/plain",
        "content-length": "5",
        accept: "text/plain",
      });
      expect(ledger).toEqual([]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = exit.cause.reasons[0];
      expect(error?._tag).toBe("Fail");
      if (error?._tag !== "Fail") return;
      expect(error.error._tag).toBe("HttpClientError");
      if (error.error._tag !== "HttpClientError") return;
      expect(error.error.reason._tag).toBe("TransportError");
      if (error.error.reason._tag !== "TransportError") return;
      // Each platform words it in its own way around the same sentence.
      expect(String(error.error.reason.cause)).toContain(
        "GET/HEAD method cannot have body",
      );
    }),
  );

describe(`request shapes through fetch (${lane.name})`, () => {
  arrives(
    "[EXT-11a] fetch resolves /a/../b to /b after the client received it as written",
    Request.get,
    "GET",
    "/a/../b",
    "/b",
  );
  arrives(
    "[EXT-11b] fetch resolves /a/%2e%2e/b to /b after the client received it as written",
    Request.get,
    "GET",
    "/a/%2e%2e/b",
    "/b",
  );
  arrives(
    "[EXT-11c] fetch turns a backslash in a path into a slash after the client received it as written",
    Request.get,
    "GET",
    "/a\\b",
    "/a/b",
  );
  arrives(
    "[EXT-11d] fetch percent-encodes a space in a path after the client received it as written",
    Request.get,
    "GET",
    "/a b",
    "/a%20b",
  );
  arrives(
    "[EXT-11e] fetch percent-encodes /ä after the client received it as written",
    Request.get,
    "GET",
    "/ä",
    "/%C3%A4",
  );
  arrives(
    "[EXT-11f] fetch removes a tab from a path after the client received it as written",
    Request.get,
    "GET",
    "/a\tb",
    "/ab",
  );
  for (const path of ["/a//b", "/a;v=1/b", "/a%2Fb"])
    arrives(
      `[EXT-11g] fetch sends ${path} unchanged`,
      Request.get,
      "GET",
      path,
      path,
    );
  arrives(
    "[EXT-11h] fetch normalizes the method get to GET after the client received it as written",
    withMethod("get"),
    "get",
    "/shape",
    "/shape",
    "GET",
  );
  arrives(
    "[EXT-11i] fetch sends the method patch in lower case",
    withMethod("patch"),
    "patch",
    "/shape",
    "/shape",
  );

  for (const method of ["TRACE", "CONNECT"])
    refuses(
      `[EXT-11j] fetch refuses ${method} as a transport error after the client received it`,
      (origin) => Request.make(method, `${origin}/shape`),
      method,
      (origin) => `${origin}/shape`,
      "TransportError",
    );

  refuses(
    "[EXT-11k] fetch refuses the method BAD METHOD as a transport error after the client received it",
    (origin) => Request.make("BAD METHOD", `${origin}/shape`),
    "BAD METHOD",
    (origin) => `${origin}/shape`,
    "TransportError",
  );

  arrives(
    "[EXT-11l] fetch sends OPTIONS on the path /*",
    Request.options,
    "OPTIONS",
    "/*",
    "/*",
  );

  it.live("[EXT-11m] fetch ignores the host header the request set", () =>
    Effect.gen(function* () {
      const { entry, received, origin, host } = yield* delivered(
        (base) =>
          Request.get(`${base}/shape`).pipe(
            Request.setHeader("host", "other.example:8080"),
          ),
        undefined,
      );
      expect(received.url).toBe(`${origin}/shape`);
      expect(headerValues(entry.lines, "host")).toEqual([host]);
    }),
  );

  it.live("[EXT-11n] fetch sends an empty header value", () =>
    Effect.gen(function* () {
      const { entry, received, origin } = yield* delivered(
        (base) =>
          Request.get(`${base}/shape`).pipe(Request.setHeader("x-empty", "")),
        undefined,
      );
      expect(received.url).toBe(`${origin}/shape`);
      expect(header(entry.lines, "x-empty")).toBe("");
    }),
  );

  it.live("[EXT-11o] fetch sends a Latin-1 header value as Latin-1 bytes", () =>
    Effect.gen(function* () {
      const { entry, received, origin } = yield* delivered(
        (base) =>
          Request.get(`${base}/shape`).pipe(
            Request.setHeader("x-name", "Müller"),
          ),
        undefined,
      );
      expect(received.url).toBe(`${origin}/shape`);
      // The ledger reads one character per byte, so `ü` arrived as the single byte 0xFC.
      expect(header(entry.lines, "x-name")).toBe("Müller");
    }),
  );

  refuses(
    "[EXT-11p] fetch refuses a header value with CR and LF as a transport error after the client received it",
    (origin) =>
      Request.get(`${origin}/shape`).pipe(
        Request.setHeader("x-name", "a\r\nx-added: b"),
      ),
    "GET",
    (origin) => `${origin}/shape`,
    "TransportError",
  );

  arrives(
    "[EXT-11q] fetch removes CR and LF from a path after the client received it as written",
    Request.get,
    "GET",
    "/a\r\nb",
    "/ab",
  );

  refuses(
    "[EXT-11r] fetch refuses a URL with user info as a transport error after the client received it",
    (origin) =>
      Request.get(`${origin.replace("http://", "http://user:pw@")}/shape`),
    "GET",
    (origin) => `${origin.replace("http://", "http://user:pw@")}/shape`,
    "TransportError",
  );

  it.live("[EXT-11s] fetch sends a DELETE with its body", () =>
    Effect.gen(function* () {
      const { entry, received, origin } = yield* delivered(
        (base) => Request.del(`${base}/shape`).pipe(Request.body(Body.text)),
        { body: "gone" },
      );
      expect(received).toEqual({
        method: "DELETE",
        url: `${origin}/shape`,
        hash: undefined,
      });
      expect(entry.method).toBe("DELETE");
      expect(entry.target).toBe("/shape");
      expect(bodyText(entry)).toBe("gone");
    }),
  );

  it.live(
    "[EXT-11t] OPTIONS * never reaches the backend through fetch: Node refuses the URL, and Chromium sends it to the page's own origin",
    () =>
      Effect.gen(function* () {
        const { exit, ledger, received } = yield* attempt(() =>
          Request.options("*"),
        );
        expect(received).toEqual({
          method: "OPTIONS",
          url: "*",
          hash: undefined,
        });
        expect(ledger).toEqual([]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = exit.cause.reasons[0];
        expect(error?._tag).toBe("Fail");
        if (error?._tag !== "Fail") return;
        if (lane.name === "node") {
          expect(error.error._tag).toBe("HttpClientError");
          if (error.error._tag !== "HttpClientError") return;
          expect(error.error.reason._tag).toBe("InvalidUrlError");
        } else {
          // The test server's own status, which is not this suite's to pin.
          expect(error.error._tag).toBe("UnexpectedResponse");
        }
      }),
  );

  refuses(
    "[EXT-11u] fetch refuses an unparseable URL as an invalid URL after the client received it",
    () => Request.get("http://[bad/x"),
    "GET",
    () => "http://[bad/x",
    "InvalidUrlError",
  );

  for (const query of ["?a=1;b=2", "?a=1&&b=2", "?", "?a=%2f", "?q=a|b[1]{x}"])
    it.live(`[EXT-11v] fetch sends the opaque query ${query} unchanged`, () =>
      Effect.gen(function* () {
        const { entry, received, origin } = yield* delivered(
          (base) =>
            Request.get(`${base}/shape`).pipe(
              Request.mapEffect((request) =>
                Effect.succeed(
                  HttpClientRequest.setUrl(request, `${request.url}${query}`),
                ),
              ),
            ),
          undefined,
        );
        expect(received.url).toBe(`${origin}/shape${query}`);
        expect(entry.target).toBe(`/shape${query}`);
      }),
    );

  refusesBody(
    "[EXT-11w] fetch refuses a GET with a body as a transport error after the client received it",
    "GET",
    Request.get,
  );
  refusesBody(
    "[EXT-11x] fetch refuses a HEAD with a body as a transport error after the client received it",
    "HEAD",
    Request.head,
  );
});
