/**
 * The same-origin proxy of the browser lane, driven over raw sockets so every request line is
 * under the test's control. Node-only: it opens sockets. The browser-lane scenarios use the proxy
 * from Chromium (`src/scenarios/browser.browser.test.ts`); these tests pin exactly what it changes
 * on the wire, as `proxy.ts` documents.
 */
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { proxyMiddleware } from "./proxy.js";
import { type Reply, serve } from "./server.js";

/** The proxy mounted in a plain Node server, as the browser server mounts it. */
const proxyServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly port: number;
        readonly close: () => Promise<void>;
      }>((resolve) => {
        const server = createServer((request, response) =>
          proxyMiddleware(request, response, () => {
            response.writeHead(404, ["Content-Type", "text/plain"]);
            response.end("not proxied\n");
          }),
        );
        server.listen(0, "127.0.0.1", () =>
          resolve({
            port: (server.address() as AddressInfo).port,
            close: () =>
              new Promise((done) => {
                server.closeAllConnections();
                server.close(() => done());
              }),
          }),
        );
      }),
  ),
  (server) => Effect.promise(() => server.close()),
);

interface RawResponse {
  readonly status: string;
  readonly lines: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
}

/** Decode a chunked body, which is how both Node servers here frame a body of unknown length. */
const unchunk = (raw: string): string => {
  let body = "";
  let rest = raw;
  for (;;) {
    const end = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, end), 16);
    if (!(size > 0)) return body;
    body += rest.slice(end + 2, end + 2 + size);
    rest = rest.slice(end + 2 + size + 2);
  }
};

/** Send one raw request on a fresh connection and read the raw response until the proxy closes. */
const exchange = (port: number, request: string) =>
  Effect.promise(
    () =>
      new Promise<RawResponse>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => socket.write(request));
        const chunks: Array<Buffer> = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", reject);
        socket.on("end", () => {
          const text = Buffer.concat(chunks).toString("latin1");
          const split = text.indexOf("\r\n\r\n");
          const [status = "", ...head] = text.slice(0, split).split("\r\n");
          const lines = head.map((line) => {
            const colon = line.indexOf(":");
            return [
              line.slice(0, colon),
              line.slice(colon + 1).trim(),
            ] as const;
          });
          const chunked = lines.some(
            ([name, value]) =>
              name.toLowerCase() === "transfer-encoding" && value === "chunked",
          );
          const body = text.slice(split + 4);
          resolve({ status, lines, body: chunked ? unchunk(body) : body });
        });
      }),
  );

const names = (lines: RawResponse["lines"]) =>
  lines.map(([name]) => name.toLowerCase());

describe("same-origin proxy", () => {
  it.live(
    "[HDR-7b] forwards the target after its prefix byte for byte, replaces Host in place, drops only hop-by-hop lines, and adds Content-Length for a body that arrived chunked",
    () =>
      Effect.gen(function* () {
        const reply: Reply = {
          status: 201,
          statusText: "Made It",
          lines: [
            ["Set-Cookie", "a=1; Path=/"],
            ["Warning", '299 - "first"'],
            ["Set-Cookie", "b=2; Path=/; HttpOnly"],
            ["Warning", '299 - "second"'],
            ["Location", "/relative"],
            ["Keep-Alive", "timeout=7"],
            ["x-Spelled", "As Sent"],
          ],
          body: "created",
        };
        const backend = yield* serve(() => reply);
        const proxy = yield* proxyServer;
        const authority = new URL(backend.origin).host;
        const page = `localhost:${proxy.port}`;
        const answer = yield* exchange(
          proxy.port,
          [
            `POST /__proxy/${authority}/files/a%2Fb/../c?x=1&x=2&y HTTP/1.1`,
            `Host: ${page}`,
            "X-Trace: one",
            "Connection: close, X-Hop",
            "X-Hop: removed",
            "x-trace: two",
            "Cookie: page=1",
            `Origin: http://${page}`,
            "Keep-Alive: timeout=5",
            "Transfer-Encoding: chunked",
            "Content-Type: text/plain",
            "",
            "5",
            "hello",
            "0",
            "",
            "",
          ].join("\r\n"),
        );
        const [received, ...rest] = backend.ledger;
        expect(rest).toEqual([]);
        expect(received?.method).toBe("POST");
        expect(received?.target).toBe("/files/a%2Fb/../c?x=1&x=2&y");
        expect(received?.lines).toEqual([
          ["Host", authority],
          ["X-Trace", "one"],
          ["x-trace", "two"],
          ["Cookie", "page=1"],
          ["Origin", `http://${page}`],
          ["Content-Type", "text/plain"],
          ["Content-Length", "5"],
          ["Connection", "close"],
        ]);
        expect(new TextDecoder().decode(received?.body)).toBe("hello");

        // Back to the page: status text, lines and body as the backend sent them, without the
        // hop-by-hop lines, which the proxy's server writes for its own connection.
        expect(answer.status).toBe("HTTP/1.1 201 Made It");
        expect(
          answer.lines.filter(
            ([name]) =>
              !["date", "connection", "transfer-encoding"].includes(
                name.toLowerCase(),
              ),
          ),
        ).toEqual(reply.lines?.filter(([name]) => name !== "Keep-Alive"));
        expect(names(answer.lines).filter((name) => name === "date")).toEqual([
          "date",
        ]);
        expect(names(answer.lines)).not.toContain("keep-alive");
        expect(
          names(answer.lines).filter(
            (name) => name.startsWith("access-control-") || name === "vary",
          ),
        ).toEqual([]);
        expect(answer.body).toBe("created");
      }),
  );

  it.live(
    "[HDR-7b] passes other paths and non-loopback targets on, and refuses a foreign Host or Origin before forwarding",
    () =>
      Effect.gen(function* () {
        const backend = yield* serve(() => ({ status: 204 }));
        const proxy = yield* proxyServer;
        const authority = new URL(backend.origin).host;
        const get = (target: string, ...lines: ReadonlyArray<string>) =>
          exchange(
            proxy.port,
            [
              `GET ${target} HTTP/1.1`,
              ...lines,
              "Connection: close",
              "",
              "",
            ].join("\r\n"),
          );
        const page = `Host: localhost:${proxy.port}`;
        const other = yield* get("/index.html", page);
        const remote = yield* get("/__proxy/10.0.0.1:80/", page);
        const rebound = yield* get(
          `/__proxy/${authority}/`,
          "Host: rebind.example.test:80",
        );
        const crossSite = yield* get(
          `/__proxy/${authority}/`,
          page,
          "Origin: https://elsewhere.example.test",
        );
        expect([other.status, other.body]).toEqual([
          "HTTP/1.1 404 Not Found",
          "not proxied\n",
        ]);
        expect(remote.status).toBe("HTTP/1.1 404 Not Found");
        expect([rebound.status, rebound.body]).toEqual([
          "HTTP/1.1 403 Forbidden",
          'proxy: refused Host "rebind.example.test:80"\n',
        ]);
        expect([crossSite.status, crossSite.body]).toEqual([
          "HTTP/1.1 403 Forbidden",
          "proxy: refused cross-origin request from https://elsewhere.example.test\n",
        ]);
        expect(backend.ledger).toEqual([]);
        // A path-less target reaches the backend's root.
        const root = yield* get(`/__proxy/${authority}`, page);
        expect(root.status).toBe("HTTP/1.1 204 No Content");
        expect(backend.ledger.map(({ target }) => target)).toEqual(["/"]);
      }),
  );

  it.live(
    "[HDR-7b] answers 502 for an unreachable backend, and closes the forwarded request when the page aborts",
    () =>
      Effect.gen(function* () {
        const proxy = yield* proxyServer;
        // A port that was just released, so nothing listens on it.
        const closed = yield* Effect.scoped(
          Effect.map(
            serve(() => ({ status: 204 })),
            (server) => new URL(server.origin).host,
          ),
        );
        const unreachable = yield* exchange(
          proxy.port,
          [
            `GET /__proxy/${closed}/ HTTP/1.1`,
            `Host: localhost:${proxy.port}`,
            "Connection: close",
            "",
            "",
          ].join("\r\n"),
        );
        expect(unreachable.status).toBe("HTTP/1.1 502 Bad Gateway");
        expect(unreachable.body).toMatch(
          new RegExp(`^proxy: ${closed.replaceAll(".", "\\.")} unreachable: `),
        );

        const held = yield* serve(
          (_, context) =>
            new Promise<Reply>((resolve) =>
              context.signal.addEventListener("abort", () =>
                resolve({ status: 499 }),
              ),
            ),
        );
        const socket = connect(proxy.port, "127.0.0.1");
        socket.write(
          [
            `GET /__proxy/${new URL(held.origin).host}/hold HTTP/1.1`,
            `Host: localhost:${proxy.port}`,
            "",
            "",
          ].join("\r\n"),
        );
        yield* Effect.promise(() => held.arrived(1));
        socket.destroy();
        const aborted = yield* Effect.sync(
          () => held.ledger[0]?.aborted() === true,
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("25 millis"),
            until: (seen) => seen,
            times: 120,
          }),
        );
        expect(aborted).toBe(true);
      }),
  );
});
