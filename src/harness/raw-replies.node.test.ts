/**
 * Raw replies on the wire, read over a plain socket so every byte and the way a connection ends are
 * under the test's eye. Node-only: it opens sockets. `raw-replies.test.ts` shows what each shape
 * does to a real client in both lanes; `fixtures/raw-replies.ts` serves those shapes by name.
 */
import { connect } from "node:net";
import { constants, gunzipSync } from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { startControl } from "./control.js";
import {
  chunk,
  gzip,
  type GzipDamage,
  lastChunk,
  noReply,
  rawHead,
  rawRouter,
  textReply,
  trickled,
  truncated,
} from "./route.js";
import { type Listener, type RawHandler, serve } from "./server.js";

/** What a client's socket saw: every byte, as one character each, and how the connection ended. */
interface Seen {
  readonly bytes: string;
  readonly ending: "closed" | "reset";
}

const request = (origin: string, method = "GET", path = "/", lines = "") =>
  `${method} ${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n${lines}\r\n`;

/** Send `text` on a new connection and read until the connection ends. */
const exchange = (origin: string, text: string) =>
  Effect.promise(
    () =>
      new Promise<Seen>((resolve) => {
        const { hostname, port } = new URL(origin);
        const socket = connect(Number(port), hostname);
        const chunks: Array<Buffer> = [];
        let ending: Seen["ending"] = "closed";
        socket.on("data", (data: Buffer) => chunks.push(data));
        socket.on("error", () => {
          ending = "reset";
        });
        socket.on("close", () =>
          resolve({ bytes: Buffer.concat(chunks).toString("latin1"), ending }),
        );
        socket.write(text);
      }),
  ).pipe(Effect.timeout("2 seconds"));

/** A client that stays connected, for replies that do not end. */
const staying = (origin: string, text: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const { hostname, port } = new URL(origin);
      const socket = connect(Number(port), hostname);
      const chunks: Array<Buffer> = [];
      socket.on("data", (data: Buffer) => chunks.push(data));
      socket.on("error", () => undefined);
      socket.write(text);
      return {
        socket,
        received: () => Buffer.concat(chunks).toString("latin1"),
      };
    }),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );

/** Re-check `condition` every 10 ms until it holds, failing after two seconds. */
const eventually = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (held) => held,
      times: 200,
    }),
    Effect.flatMap((held) =>
      held ? Effect.void : Effect.die(new Error("condition never held")),
    ),
  );

const listeners: ReadonlyArray<Listener> = ["http", "socket"];

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** Read a stream as a browser does, taking what decompressed as the whole of it. */
const lenient = (bytes: Uint8Array) =>
  gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).toString();

const plain = [["Content-Type", "text/plain"]] as const;

describe("raw replies", () => {
  for (const listener of listeners) {
    const start = (handler: RawHandler) => serve(handler, undefined, listener);

    it.live(`writes a reply byte for byte and adds nothing (${listener})`, () =>
      Effect.gen(function* () {
        const head = "HTTP/1.1 299 Odd\r\nX-Bad: a\0b\r\nno colon here\r\n\r\n";
        const server = yield* start(() => ({ head, body: ["body", "\xff"] }));
        const seen = yield* exchange(server.origin, request(server.origin));
        expect(seen).toEqual({ bytes: `${head}body\xff`, ending: "closed" });
      }),
    );

    it.live(
      `a reply may be cut anywhere, even inside its head (${listener})`,
      () =>
        Effect.gen(function* () {
          const server = yield* start(() => ({
            head: "HTTP/1.1 200 OK\r\nContent-Ty",
          }));
          expect(
            yield* exchange(server.origin, request(server.origin)),
          ).toEqual({
            bytes: "HTTP/1.1 200 OK\r\nContent-Ty",
            ending: "closed",
          });
        }),
    );

    it.live(
      `truncated declares the whole body, sends part of it and closes (${listener})`,
      () =>
        Effect.gen(function* () {
          const server = yield* start(() =>
            truncated(200, plain, "hello world", 5),
          );
          expect(
            yield* exchange(server.origin, request(server.origin)),
          ).toEqual({
            bytes:
              "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 11\r\n\r\nhello",
            ending: "closed",
          });
        }),
    );

    it.live(`a reset ends the connection abruptly (${listener})`, () =>
      Effect.gen(function* () {
        const server = yield* start(() => noReply("reset"));
        expect(yield* exchange(server.origin, request(server.origin))).toEqual({
          bytes: "",
          ending: "reset",
        });
      }),
    );

    it.live(
      `noReply writes nothing, after the handler has acted (${listener})`,
      () =>
        Effect.gen(function* () {
          let acted = 0;
          const server = yield* start(() => {
            acted++;
            return noReply();
          });
          const seen = yield* exchange(
            server.origin,
            request(server.origin, "POST", "/", "Content-Length: 2\r\n") + "hi",
          );
          expect(seen).toEqual({ bytes: "", ending: "closed" });
          expect(acted).toBe(1);
          expect(new TextDecoder().decode(server.ledger[0]!.body)).toBe("hi");
        }),
    );

    it.live(
      `a server's own close is not the client aborting, and the ledger shows it closed (${listener})`,
      () =>
        Effect.gen(function* () {
          const server = yield* start(() =>
            truncated(200, plain, "hello world", 5),
          );
          yield* exchange(server.origin, request(server.origin));
          yield* eventually(() => !server.ledger[0]!.connectionOpen());
          // Give the close's remaining events time to reach the reply they would abort.
          yield* Effect.sleep("50 millis");
          expect(server.ledger[0]!.aborted()).toBe(false);
        }),
    );

    it.live(
      `a trickle goes on until the client goes, and stops there (${listener})`,
      () =>
        Effect.gen(function* () {
          const server = yield* start(() =>
            trickled(200, [["Content-Length", "1000"]], "x", 5),
          );
          const client = yield* staying(server.origin, request(server.origin));
          yield* eventually(() => client.received().endsWith("xxx"));
          expect(server.ledger[0]!.aborted()).toBe(false);
          expect(server.ledger[0]!.connectionOpen()).toBe(true);
          client.socket.destroy();
          yield* eventually(() => server.ledger[0]!.aborted());
          expect(server.ledger[0]!.connectionOpen()).toBe(false);
        }),
    );

    it.live(
      `steps run in order: bytes, a pause, a limited repeat, and a wait for a later request (${listener})`,
      () =>
        Effect.gen(function* () {
          let release!: () => void;
          const released = new Promise<void>((done) => (release = done));
          const server = yield* start(
            rawRouter([
              {
                method: "GET",
                path: "/slow",
                handle: () => ({
                  head: rawHead(200, [["Connection", "close"]]),
                  body: [
                    "a",
                    { wait: 5 },
                    { repeat: "b", every: 1, times: 3 },
                    { until: released },
                    "c",
                  ],
                }),
              },
              {
                method: "POST",
                path: "/release",
                handle: () => {
                  release();
                  return textReply(200, "released", "text/plain");
                },
              },
            ]),
          );
          const client = yield* staying(
            server.origin,
            request(server.origin, "GET", "/slow"),
          );
          yield* eventually(() => client.received().endsWith("abbb"));
          yield* Effect.sleep("30 millis");
          expect(client.received()).toMatch(/abbb$/);
          yield* exchange(
            server.origin,
            request(server.origin, "POST", "/release", "Connection: close\r\n"),
          );
          yield* eventually(() => client.received().endsWith("abbbc"));
        }),
    );

    it.live(
      `a character that is not one byte fails the fixture before anything is written (${listener})`,
      () =>
        Effect.gen(function* () {
          const server = yield* start(() => ({
            head: rawHead(200, plain),
            body: ["written first", "ä is one byte, € is not"],
          }));
          const seen = yield* exchange(
            server.origin,
            request(server.origin, "GET", "/", "Connection: close\r\n"),
          );
          expect(seen.bytes).toMatch(/^HTTP\/1\.1 599 Fixture Failure\r\n/);
          expect(seen.bytes).toContain("above U+00FF");
          expect(seen.bytes).not.toContain("written first");
        }),
    );

    it.live(
      `an ordinary reply still answers beside a raw one (${listener})`,
      () =>
        Effect.gen(function* () {
          const server = yield* start(
            rawRouter([
              {
                method: "GET",
                path: "/cut",
                handle: () => truncated(200, plain, "hello world", 5),
              },
              {
                method: "GET",
                path: "/whole",
                handle: () => textReply(200, "whole", "text/plain"),
              },
            ]),
          );
          yield* exchange(server.origin, request(server.origin, "GET", "/cut"));
          const whole = yield* exchange(
            server.origin,
            request(server.origin, "GET", "/whole", "Connection: close\r\n"),
          );
          expect(whole.bytes).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
          expect(whole.bytes).toContain("whole");
        }),
    );
  }

  it("chunk writes a size line, its data and a terminator, and lastChunk ends a body", () => {
    expect(text(chunk("hello"))).toBe("5\r\nhello\r\n");
    expect(text(chunk("a".repeat(26)))).toBe(`1a\r\n${"a".repeat(26)}\r\n`);
    expect(text(chunk("hello", "XX"))).toBe("5\r\nhelloXX");
    expect(text(chunk(new Uint8Array([0xc3])))).toBe("1\r\n\xc3\r\n");
    expect(lastChunk).toBe("0\r\n\r\n");
  });

  it("rawHead adds nothing beyond its status line, its lines and the blank line", () => {
    expect(rawHead(200)).toBe("HTTP/1.1 200 OK\r\n\r\n");
    expect(rawHead(404, [["X-A", "1"]])).toBe(
      "HTTP/1.1 404 Not Found\r\nX-A: 1\r\n\r\n",
    );
    expect(rawHead(299, [], "Odd")).toBe("HTTP/1.1 299 Odd\r\n\r\n");
    expect(rawHead(299)).toBe("HTTP/1.1 299 \r\n\r\n");
  });

  const damaged: ReadonlyArray<readonly [GzipDamage, RegExp]> = [
    ["magic", /incorrect header check/],
    ["block", /invalid block type/],
    ["checksum", /incorrect data check/],
    ["truncated", /unexpected end of file/],
    ["trailer", /unexpected end of file/],
  ];

  it("gzip gives a stream any reader takes", () => {
    expect(gunzipSync(gzip("hello world")).toString()).toBe("hello world");
    expect(gunzipSync(gzip(new Uint8Array([0, 255]))).toString("latin1")).toBe(
      "\0\xff",
    );
  });

  for (const [damage, failure] of damaged)
    it(`gzip's ${damage} damage is found where its comment says`, () => {
      expect(() => gunzipSync(gzip("hello world", damage))).toThrow(failure);
    });

  it("gzip's truncated and trailer damage differ in what a lenient reader can recover", () => {
    expect(lenient(gzip("hello world", "trailer"))).toBe("hello world");
    expect(lenient(gzip("hello world", "truncated"))).not.toBe("hello world");
  });

  it.live("numbers each connection, so a reused one shows in the ledger", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => textReply(200, "ok", "text/plain"));
      const client = yield* staying(server.origin, request(server.origin));
      yield* Effect.promise(() => server.arrived(1));
      yield* eventually(() => client.received().includes("ok"));
      client.socket.write(request(server.origin));
      yield* Effect.promise(() => server.arrived(2));
      yield* exchange(
        server.origin,
        request(server.origin, "GET", "/", "Connection: close\r\n"),
      );
      expect(server.ledger.map(({ connection }) => connection)).toEqual([
        1, 1, 2,
      ]);
    }),
  );

  describe("through the control server", () => {
    const started = Effect.gen(function* () {
      const control = yield* Effect.acquireRelease(
        Effect.promise(() => startControl()),
        (running) => Effect.promise(() => running.close()),
      );
      const { origin } = (yield* Effect.promise(() =>
        fetch(`${control.url}/backends`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "raw-replies" }),
        }).then((response) => response.json()),
      )) as { readonly origin: string };
      return origin;
    });
    const page = "Origin: http://page.test\r\n";

    it.live(
      "harness CORS goes after the status line and exposes the reply's own lines",
      () =>
        Effect.gen(function* () {
          const origin = yield* started;
          const { bytes } = yield* exchange(
            origin,
            request(origin, "GET", "/truncated-length", page),
          );
          expect(bytes).toBe(
            [
              "HTTP/1.1 200 OK",
              "Access-Control-Allow-Origin: http://page.test",
              "Access-Control-Allow-Credentials: true",
              "Access-Control-Expose-Headers: Content-Type, Content-Length",
              "Vary: Origin",
              "Content-Type: text/plain",
              "Content-Length: 11",
              "",
              "hello",
            ].join("\r\n"),
          );
        }),
    );

    it.live(
      "a head with no line end, and no head at all, go out as they are",
      () =>
        Effect.gen(function* () {
          const origin = yield* started;
          expect(
            (yield* exchange(origin, request(origin, "GET", "/no-reply", page)))
              .bytes,
          ).toBe("");
        }),
    );

    it.live("a request from no page gets no CORS lines", () =>
      Effect.gen(function* () {
        const origin = yield* started;
        const { bytes } = yield* exchange(
          origin,
          request(origin, "GET", "/truncated-length"),
        );
        expect(bytes).not.toContain("Access-Control");
      }),
    );
  });
});
