import { connect, createServer } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  Body,
  Operation,
  Request,
  Response,
  Transport,
} from "viell-effect-schema-http";
import { startControl } from "./control.js";
import { pathOf, type Recorded } from "./lane.js";
import { rawLayer } from "./providers.js";
import { router, textReply } from "./route.js";
import {
  type Handler,
  header,
  type Listener,
  path,
  type Received,
  type Reply,
  serve,
} from "./server.js";

/**
 * The raw provider and the socket listener, on their own, with a plain handler in place of any
 * backend. These need Node itself: the provider opens sockets, and most of these requests can only
 * be written by hand.
 */

const ok: Handler = () => textReply(200, "ok", "text/plain");

const hostOf = (origin: string) => new URL(origin).host;

/** Send `request` through the raw provider, and read it back from a socket listener's ledger. */
const sent = (
  build: (origin: string) => Request.Request<unknown>,
  transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
) =>
  Effect.gen(function* () {
    const server = yield* serve(ok, undefined, "socket");
    yield* Operation.make(
      build(server.origin),
      Response.status(200, Body.text),
      transformClient === undefined ? {} : { transformClient },
    )
      .execute(undefined)
      .pipe(Effect.provide(rawLayer(server.origin)));
    const [entry, ...rest] = server.ledger;
    expect(rest).toEqual([]);
    return { entry: entry!, origin: server.origin };
  });

/** Write `message` to a new connection, and return everything the server sends until it closes. */
const exchange = (origin: string, message: string): Promise<string> =>
  new Promise((resolve) => {
    const { hostname, port } = new URL(origin);
    const socket = connect(Number(port), hostname);
    const chunks: Array<Buffer> = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.on("error", () => undefined);
    socket.write(Buffer.from(message, "latin1"));
  });

/** The failure of a plain GET through the raw provider. */
const failure = (origin: string) =>
  Operation.make(Request.get(`${origin}/x`), Response.status(200, Body.text))
    .execute(undefined)
    .pipe(
      Effect.provide(rawLayer(origin)),
      Effect.timeout("2 seconds"),
      Effect.flip,
    );

const listening = (listener: Listener, handler: Handler = ok) =>
  serve(handler, undefined, listener);

const withoutDate = (reply: string) => reply.replace(/Date: .*\r\n/, "");

const at = (target: string) => ({ target }) as Received;

describe("raw provider", () => {
  it.live(
    "writes the request line and header lines as written, adding only Host",
    () =>
      Effect.gen(function* () {
        const { entry, origin } = yield* sent((base) =>
          Request.get(`${base}/a/../b`).pipe(Request.setHeader("x-one", "1")),
        );
        expect(entry.head).toBe(
          [
            "GET /a/../b HTTP/1.1",
            `host: ${hostOf(origin)}`,
            "x-one: 1",
            "accept: text/plain",
          ].join("\r\n"),
        );
      }),
  );

  for (const spelling of [
    "/a/%2e%2e/b",
    "/a\\b",
    "/a b",
    "/a\tb",
    "/a//b",
    "/a;v=1/b",
    "/a%2Fb",
  ])
    it.live(`sends the path ${JSON.stringify(spelling)} unchanged`, () =>
      Effect.gen(function* () {
        const { entry } = yield* sent((base) =>
          Request.get(`${base}${spelling}`),
        );
        expect(entry.target).toBe(spelling);
      }),
    );

  it.live("writes a non-ASCII target as UTF-8", () =>
    Effect.gen(function* () {
      const { entry } = yield* sent((base) => Request.get(`${base}/ä`));
      // One character per byte: the two bytes of UTF-8's ä.
      expect(entry.target).toBe("/\u00c3\u00a4");
    }),
  );

  for (const [method, url] of [
    ["OPTIONS", "*"],
    ["GET", "http://[bad/x"],
    ["GET", "no-scheme"],
  ] as const)
    it.live(`needs no valid URL: ${method} ${url}`, () =>
      Effect.gen(function* () {
        const { entry, origin } = yield* sent(() => Request.make(method, url));
        expect(entry.method).toBe(method);
        expect(entry.target).toBe(url);
        expect(header(entry.lines, "host")).toBe(hostOf(origin));
      }),
    );

  it.live("keeps the method as given, however odd", () =>
    Effect.gen(function* () {
      const { entry } = yield* sent((base) =>
        Request.make("get", `${base}/shape`),
      );
      expect(entry.head?.split("\r\n")[0]).toBe("get /shape HTTP/1.1");
      const spaced = yield* sent((base) =>
        Request.make("BAD METHOD", `${base}/shape`),
      );
      expect(spaced.entry.head?.split("\r\n")[0]).toBe(
        "BAD METHOD /shape HTTP/1.1",
      );
    }),
  );

  it.live(
    "writes any other origin's URL whole, even one that starts with its own",
    () =>
      Effect.gen(function* () {
        const longer = yield* sent((base) => Request.get(`${base}0/x`));
        expect(longer.entry.target).toBe(`${longer.origin}0/x`);
        const elsewhere = yield* sent(() =>
          Request.get("http://other.example/x"),
        );
        expect(elsewhere.entry.target).toBe("http://other.example/x");
        expect(header(elsewhere.entry.lines, "host")).toBe(
          hostOf(elsewhere.origin),
        );
      }),
  );

  it.live("keeps user info in the URL, as an absolute-form target", () =>
    Effect.gen(function* () {
      const { entry, origin } = yield* sent((base) =>
        Request.get(`${base.replace("http://", "http://user:pw@")}/u`),
      );
      expect(entry.target).toBe(`http://user:pw@${hostOf(origin)}/u`);
    }),
  );

  it.live("writes `#` and the hash after the URL, and after any query", () =>
    Effect.gen(function* () {
      const fragment = HttpClient.mapRequest(HttpClientRequest.setHash("top"));
      const bare = yield* sent(
        (base) => Request.get(`${base}/users/1`),
        fragment,
      );
      expect(bare.entry.target).toBe("/users/1#top");
      const query = yield* sent(
        (base) =>
          Request.get(`${base}/users/1`).pipe(Request.setQuery("f", "xml")),
        fragment,
      );
      expect(query.entry.target).toBe("/users/1?f=xml#top");
    }),
  );

  it.live("leaves a `#` in the URL's own text where it was written", () =>
    Effect.gen(function* () {
      const { entry } = yield* sent((base) =>
        Request.get("").pipe(Request.baseUrl(`${base}/users/1#top`)),
      );
      expect(entry.target).toBe("/users/1#top");
    }),
  );

  it.live("appends parameters set by client middleware, so none is lost", () =>
    Effect.gen(function* () {
      const parameter = HttpClient.mapRequest(
        HttpClientRequest.setUrlParam("key", "a b"),
      );
      const bare = yield* sent((base) => Request.get(`${base}/q`), parameter);
      expect(bare.entry.target).toBe("/q?key=a+b");
      const query = yield* sent(
        (base) => Request.get(`${base}/q`).pipe(Request.setQuery("x", "1")),
        parameter,
      );
      expect(query.entry.target).toBe("/q?x=1&key=a+b");
      const fragment = yield* sent(
        (base) => Request.get("").pipe(Request.baseUrl(`${base}/q#top`)),
        parameter,
      );
      expect(fragment.entry.target).toBe("/q?key=a+b#top");
    }),
  );

  it.live(
    "keeps a declared Host, and frames a body with Content-Length after the request's lines",
    () =>
      Effect.gen(function* () {
        const server = yield* serve(ok, undefined, "socket");
        yield* Operation.make(
          Request.del(`${server.origin}/doc`).pipe(
            Request.setHeader("host", "other.example:8080"),
            Request.body(Body.text),
          ),
          Response.status(200, Body.text),
        )
          .execute({ body: "gone" })
          .pipe(Effect.provide(rawLayer(server.origin)));
        const [entry] = server.ledger;
        expect(entry!.head).toBe(
          [
            "DELETE /doc HTTP/1.1",
            "host: other.example:8080",
            "content-type: text/plain",
            "content-length: 4",
            "accept: text/plain",
          ].join("\r\n"),
        );
        expect(new TextDecoder().decode(entry!.body)).toBe("gone");
      }),
  );

  it.live(
    "writes a header line as Latin-1, or as UTF-8 if it does not fit",
    () =>
      Effect.gen(function* () {
        const latin1 = yield* sent((base) =>
          Request.get(`${base}/x`).pipe(Request.setHeader("x-name", "Müller")),
        );
        expect(header(latin1.entry.lines, "x-name")).toBe("Müller");
        const wider = yield* sent((base) =>
          Request.get(`${base}/x`).pipe(Request.setHeader("x-name", "1 €")),
        );
        // One character per byte: the three bytes of UTF-8's euro sign.
        expect(header(wider.entry.lines, "x-name")).toBe(
          "1 \u00e2\u0082\u00ac",
        );
      }),
  );

  it.live("writes an empty header value as an empty value", () =>
    Effect.gen(function* () {
      const { entry } = yield* sent((base) =>
        Request.get(`${base}/x`).pipe(Request.setHeader("x-empty", "")),
      );
      expect(entry.head).toContain("\r\nx-empty: \r\n");
      expect(header(entry.lines, "x-empty")).toBe("");
    }),
  );

  it.live("refuses nothing: CR and LF end the line they are written on", () =>
    Effect.gen(function* () {
      const value = yield* sent((base) =>
        Request.get(`${base}/x`).pipe(
          Request.setHeader("x-name", "a\r\nx-added: b"),
        ),
      );
      expect(header(value.entry.lines, "x-name")).toBe("a");
      expect(header(value.entry.lines, "x-added")).toBe("b");
      const target = yield* sent((base) => Request.get(`${base}/a\r\nb`));
      expect(target.entry.head?.split("\r\n").slice(0, 2)).toEqual([
        "GET /a",
        "b HTTP/1.1",
      ]);
    }),
  );

  it.live("adds no trace headers, unlike a client built with make", () =>
    Effect.gen(function* () {
      const { entry } = yield* sent((base) => Request.get(`${base}/x`));
      expect(entry.lines.map(([name]) => name)).toEqual(["host", "accept"]);
    }),
  );

  it.live(
    "reads a chunked reply on a connection the server keeps open, and reports its raw lines",
    () =>
      Effect.gen(function* () {
        const server = yield* serve(() => ({
          status: 200,
          lines: [
            ["X-Scope", "a"],
            ["X-Scope", "b"],
          ],
          body: "ok",
        }));
        const lines = yield* Operation.make(
          Request.get(`${server.origin}/x`),
          Response.status(
            200,
            Body.decoder((response) =>
              Effect.succeed(Transport.responseHeaderLines(response)),
            ),
          ),
        )
          .execute(undefined)
          .pipe(
            Effect.provide(rawLayer(server.origin)),
            Effect.timeout("2 seconds"),
          );
        expect(Option.getOrThrow(lines)).toEqual(
          expect.arrayContaining([
            ["X-Scope", "a"],
            ["X-Scope", "b"],
            ["Transfer-Encoding", "chunked"],
          ]),
        );
      }),
  );

  it.live("closes its connection once it has read the reply", () =>
    Effect.gen(function* () {
      let closed!: () => void;
      const hungUp = new Promise<void>((resolve) => (closed = resolve));
      // A server that replies and keeps the connection open, so only the client can end it.
      const listener = createServer((socket) => {
        socket.on("error", () => undefined);
        socket.on("close", closed);
        socket.on("data", () =>
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"),
        );
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          listener.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () => Effect.sync(() => listener.close()),
      );
      const { port } = listener.address() as { readonly port: number };
      const origin = `http://127.0.0.1:${port}`;
      const text = yield* Operation.make(
        Request.get(`${origin}/x`),
        Response.status(200, Body.text),
      )
        .execute(undefined)
        .pipe(Effect.provide(rawLayer(origin)));
      expect(text).toBe("ok");
      yield* Effect.promise(() => hungUp).pipe(Effect.timeout("2 seconds"));
    }),
  );

  it.live("reads a reply to HEAD without waiting for a body", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => ({
        status: 200,
        lines: [["Content-Length", "1000"]],
      }));
      const outcome = yield* Operation.make(
        Request.head(`${server.origin}/x`),
        Response.status(200, Body.empty),
      )
        .execute(undefined)
        .pipe(
          Effect.provide(rawLayer(server.origin)),
          Effect.timeout("2 seconds"),
        );
      expect(outcome).toBeUndefined();
    }),
  );

  it.live("fails as a transport error when nothing listens", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const closed = yield* serve(ok).pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      const error = yield* failure(closed.origin);
      expect(error._tag).toBe("HttpClientError");
      if (error._tag !== "HttpClientError") return;
      expect(error.reason._tag).toBe("TransportError");
    }),
  );

  it.live(
    "fails as a transport error when the server hangs up without a reply",
    () =>
      Effect.gen(function* () {
        const listener = createServer((socket) => {
          socket.on("error", () => undefined);
          socket.on("data", () => socket.destroy());
        });
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => {
            listener.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () => Effect.sync(() => listener.close()),
        );
        const { port } = listener.address() as { readonly port: number };
        const error = yield* failure(`http://127.0.0.1:${port}`);
        expect(error._tag).toBe("HttpClientError");
        if (error._tag !== "HttpClientError") return;
        expect(error.reason._tag).toBe("TransportError");
      }),
  );

  it.live("fails a response Fetch cannot represent as a transport error", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => ({ status: 600, body: "beyond" }));
      const error = yield* failure(server.origin);
      expect(error._tag).toBe("HttpClientError");
      if (error._tag !== "HttpClientError") return;
      expect(error.reason._tag).toBe("TransportError");
      expect(String(error.reason.cause)).toMatch(/RangeError/);
    }),
  );

  it.live("closes the connection on interruption, seen by the server", () =>
    Effect.gen(function* () {
      let observe!: () => void;
      const observed = new Promise<void>((resolve) => (observe = resolve));
      const server = yield* serve(
        (_, context) =>
          new Promise((resolve) =>
            context.signal.addEventListener("abort", () => {
              observe();
              resolve({ status: 500 });
            }),
          ),
      );
      const fiber = yield* Operation.make(
        Request.get(`${server.origin}/hold`),
        Response.status(200, Body.empty),
      )
        .execute(undefined)
        .pipe(Effect.provide(rawLayer(server.origin)), Effect.forkChild);
      yield* Effect.promise(() => server.arrived(1));
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => observed);
      expect(server.ledger[0]?.aborted()).toBe(true);
    }),
  );

  it.live(
    "follows a redirect through followRedirects, writing the Location's fragment from the hash",
    () =>
      Effect.gen(function* () {
        const server = yield* serve(
          router([
            {
              method: "GET",
              path: "/old",
              handle: (_, context) => ({
                status: 302,
                lines: [["Location", `${context.origin}/new#top`]],
              }),
            },
            {
              method: "GET",
              path: "/new",
              handle: () => textReply(200, "moved", "text/plain"),
            },
          ]),
        );
        const text = yield* Operation.make(
          Request.get(`${server.origin}/old`),
          Response.status(200, Body.text),
          { transformClient: (client) => HttpClient.followRedirects(client) },
        )
          .execute(undefined)
          .pipe(Effect.provide(rawLayer(server.origin)));
        expect(text).toBe("moved");
        expect(server.ledger.map((entry) => entry.target)).toEqual([
          "/old",
          "/new#top",
        ]);
      }),
  );
});

describe("socket listener", () => {
  for (const [what, message] of [
    ["a space in the target", "GET /a b HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["a raw non-ASCII byte", "GET /\u00e4 HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["a tab in the target", "GET /a\tb HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["a lower-case method", "get /a HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["an unknown method", "BAD METHOD /a HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["CONNECT", "CONNECT /a HTTP/1.1\r\nHost: x\r\n\r\n"],
    ["a broken request line", "GET /a\r\nb HTTP/1.1\r\nHost: x\r\n\r\n"],
  ] as const)
    it.live(`records ${what}, which node:http stops before any handler`, () =>
      Effect.gen(function* () {
        const http = yield* listening("http");
        yield* Effect.promise(() => exchange(http.origin, message));
        expect(http.ledger).toEqual([]);
        const socket = yield* listening("socket");
        const reply = yield* Effect.promise(() =>
          exchange(socket.origin, message),
        );
        expect(reply).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
        expect(`${socket.ledger[0]!.head}\r\n\r\n`).toBe(message);
      }),
    );

  it.live(
    "reads the method, target and lines of a head that refuses nothing",
    () =>
      Effect.gen(function* () {
        const server = yield* listening("socket");
        yield* Effect.promise(() =>
          exchange(
            server.origin,
            [
              "BAD METHOD /a b HTTP/1.1",
              "Host: x",
              "X-Padded: \t one two \t",
              "no colon here",
              "X-Empty:",
              "",
              "",
            ].join("\r\n"),
          ),
        );
        const [entry] = server.ledger;
        expect(entry!.method).toBe("BAD");
        expect(entry!.target).toBe("METHOD /a b");
        expect(entry!.lines).toEqual([
          ["Host", "x"],
          ["X-Padded", "one two"],
          ["no colon here", ""],
          ["X-Empty", ""],
        ]);
      }),
  );

  it.live("reads a request line that has lost its version", () =>
    Effect.gen(function* () {
      const server = yield* listening("socket");
      yield* Effect.promise(() =>
        exchange(server.origin, "GET /a\r\nb HTTP/1.1\r\nHost: x\r\n\r\n"),
      );
      const [entry] = server.ledger;
      expect(entry!.method).toBe("GET");
      expect(entry!.target).toBe("/a");
      expect(entry!.lines).toEqual([
        ["b HTTP/1.1", ""],
        ["Host", "x"],
      ]);
    }),
  );

  it.live("reads a target and header lines one character per byte", () =>
    Effect.gen(function* () {
      const message =
        "GET /\u00c3\u00a4 HTTP/1.1\r\nHost: x\r\nX-Name: M\u00fcller\r\n\r\n";
      const server = yield* listening("socket");
      yield* Effect.promise(() => exchange(server.origin, message));
      const [entry] = server.ledger;
      expect(entry!.target).toBe("/\u00c3\u00a4");
      expect(header(entry!.lines, "x-name")).toBe("M\u00fcller");
    }),
  );

  for (const [what, reply] of [
    ["a text reply", textReply(200, "ok", "text/plain")],
    ["an empty reply", { status: 204 }],
    ["a reply with its own status text", { status: 299, statusText: "Odd" }],
    [
      "a reply with its own length",
      { status: 200, lines: [["Content-Length", "2"]], body: "ok" },
    ],
  ] as ReadonlyArray<readonly [string, Reply]>)
    it.live(`writes ${what} as node:http does`, () =>
      Effect.gen(function* () {
        const message =
          "GET /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
        const replies = yield* Effect.forEach(
          ["http", "socket"] as const,
          (listener) =>
            Effect.gen(function* () {
              const server = yield* listening(listener, () => reply);
              return withoutDate(
                yield* Effect.promise(() => exchange(server.origin, message)),
              );
            }),
        );
        expect(replies[1]).toBe(replies[0]);
      }),
    );

  it.live("answers HEAD without the reply's body", () =>
    Effect.gen(function* () {
      const server = yield* listening("socket", () =>
        textReply(200, "ok", "text/plain"),
      );
      const reply = yield* Effect.promise(() =>
        exchange(server.origin, "HEAD /x HTTP/1.1\r\nHost: x\r\n\r\n"),
      );
      expect(reply.endsWith("\r\n\r\n")).toBe(true);
    }),
  );

  it.live(
    "closes the connection after one request, with Connection: close",
    () =>
      Effect.gen(function* () {
        const server = yield* listening("socket");
        const reply = yield* Effect.promise(() =>
          exchange(
            server.origin,
            "GET /one HTTP/1.1\r\nHost: x\r\n\r\nGET /two HTTP/1.1\r\nHost: x\r\n\r\n",
          ),
        );
        expect(reply).toContain("\r\nConnection: close\r\n");
        expect(server.ledger.map((entry) => entry.target)).toEqual(["/one"]);
      }),
  );

  it.live("waits for a head and a body that arrive in pieces", () =>
    Effect.gen(function* () {
      let handled: Received | undefined;
      const server = yield* listening("socket", (request) => {
        handled = request;
        return { status: 204 };
      });
      const { hostname, port } = new URL(server.origin);
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => connect(Number(port), hostname)),
        (opened) => Effect.sync(() => opened.destroy()),
      );
      socket.on("error", () => undefined);
      const write = (text: string) =>
        Effect.promise(
          () => new Promise((done) => socket.write(text, () => done(null))),
        ).pipe(Effect.andThen(Effect.sleep("20 millis")));
      yield* write("POST /upload HTTP/1.1\r\nContent-");
      expect(server.ledger).toEqual([]);
      yield* write("Length: 6\r\n\r\nab");
      yield* Effect.promise(() => server.arrived(1));
      expect(new TextDecoder().decode(server.ledger[0]!.body)).toBe("ab");
      expect(handled).toBeUndefined();
      yield* write("cd");
      expect(handled).toBeUndefined();
      yield* write("ef and more");
      expect(new TextDecoder().decode(handled!.body)).toBe("abcdef");
    }),
  );

  for (const declared of ["Content-Length: abc\r\n", ""])
    it.live(
      `ignores bytes after the head without a whole-number length (${JSON.stringify(declared)})`,
      () =>
        Effect.gen(function* () {
          const server = yield* listening("socket");
          const reply = yield* Effect.promise(() =>
            exchange(
              server.origin,
              `POST /x HTTP/1.1\r\nHost: x\r\n${declared}\r\nbytes`,
            ),
          );
          expect(reply).toMatch(/^HTTP\/1\.1 200 OK/);
          expect(server.ledger[0]!.body).toEqual(new Uint8Array());
        }),
    );

  it.live(
    "records an upload at arrival, and one cut off mid-body as aborted, without running the handler",
    () =>
      Effect.gen(function* () {
        let handled = 0;
        const server = yield* listening("socket", () => {
          handled++;
          return { status: 200 };
        });
        const { hostname, port } = new URL(server.origin);
        const socket = connect(Number(port), hostname);
        socket.on("error", () => undefined);
        socket.write(
          "POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\npart",
        );
        yield* Effect.promise(() => server.arrived(1));
        const [entry] = server.ledger;
        expect(entry!.aborted()).toBe(false);
        socket.destroy();
        yield* Effect.promise(
          () =>
            new Promise<void>((done) => {
              const check = () =>
                entry!.aborted() ? done() : setTimeout(check, 5);
              check();
            }),
        ).pipe(Effect.timeout("2 seconds"));
        expect(new TextDecoder().decode(entry!.body)).toBe("part");
        expect(handled).toBe(0);
      }),
  );

  it.live(
    "signals an abort to a held request, and closes it with the scope",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const server = yield* listening(
          "socket",
          (_, context) =>
            new Promise((resolve) =>
              context.signal.addEventListener("abort", () =>
                resolve({ status: 500 }),
              ),
            ),
        ).pipe(Scope.provide(scope));
        const reply = exchange(
          server.origin,
          "GET /x HTTP/1.1\r\nHost: x\r\n\r\n",
        );
        yield* Effect.promise(() => server.arrived(1));
        yield* Scope.close(scope, Exit.void);
        expect(yield* Effect.promise(() => reply)).toBe("");
        expect(server.ledger[0]!.aborted()).toBe(true);
      }),
  );

  it.live("answers a failing handler with the fixture failure", () =>
    Effect.gen(function* () {
      const server = yield* listening("socket", () => {
        throw new Error("broken fixture");
      });
      const reply = yield* Effect.promise(() =>
        exchange(server.origin, "GET /x HTTP/1.1\r\nHost: x\r\n\r\n"),
      );
      expect(reply).toMatch(/^HTTP\/1\.1 599 Fixture Failure/);
      expect(reply).toContain("broken fixture");
    }),
  );

  it.live("is what the control server starts when asked", () =>
    Effect.gen(function* () {
      const control = yield* Effect.acquireRelease(
        Effect.promise(() => startControl()),
        (running) => Effect.promise(() => running.close()),
      );
      const backend = yield* Effect.promise(async () => {
        const response = await fetch(`${control.url}/backends`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "echo", listener: "socket" }),
        });
        return (await response.json()) as {
          readonly id: string;
          readonly origin: string;
        };
      });
      const message = "GET /a b HTTP/1.1\r\nHost: x\r\n\r\n";
      yield* Effect.promise(() => exchange(backend.origin, message));
      const entries = yield* Effect.promise(async () => {
        const response = await fetch(
          `${control.url}/backends/${backend.id}/ledger`,
        );
        return (await response.json()) as ReadonlyArray<{
          readonly target: string;
          readonly head: string;
        }>;
      });
      expect(entries[0]?.target).toBe("/a b");
      expect(`${entries[0]?.head}\r\n\r\n`).toBe(message);
    }),
  );
});

describe("targets with a fragment", () => {
  for (const [target, expected] of [
    ["/users/1", "/users/1"],
    ["/users/1?f=xml", "/users/1"],
    ["/users/1#top", "/users/1"],
    ["/users/1?f=xml#top", "/users/1"],
    ["/users/1#top?f=xml", "/users/1"],
    ["*", "*"],
  ] as const)
    it(`the path of ${target} is ${expected}`, () => {
      expect(path(at(target))).toBe(expected);
      expect(pathOf(at(target) as unknown as Recorded)).toBe(expected);
    });

  it.live(
    "a route matches a target with a fragment, which the ledger keeps",
    () =>
      Effect.gen(function* () {
        const server = yield* serve(
          router([
            {
              method: "GET",
              path: "/users/1",
              handle: (request) => textReply(200, request.target, "text/plain"),
            },
          ]),
        );
        const text = yield* Operation.make(
          Request.get(`${server.origin}/users/1`),
          Response.status(200, Body.text),
          {
            transformClient: HttpClient.mapRequest(
              HttpClientRequest.setHash("top"),
            ),
          },
        )
          .execute(undefined)
          .pipe(Effect.provide(rawLayer(server.origin)));
        expect(text).toBe("/users/1#top");
        expect(server.ledger[0]?.target).toBe("/users/1#top");
      }),
  );
});
