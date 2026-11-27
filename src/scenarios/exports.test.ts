/**
 * Exports: the library against an export service built on Warded, the table in
 * `src/apis/exports.ts`, through every provider of the lane on every listener.
 *
 * The service streams its content after the head, and it can be slow, stall, end before its
 * `Content-Length`, fail halfway or never end; its files carry a `Content-Encoding` that need not
 * describe their bytes. The judge is the library's documentation: bodies are finite, and an
 * attempt timeout covers dispatch and decoding, so a body that never ends is bounded by one; the
 * attempt's scope closes, ending the request, before the outcome is returned; interruption never
 * retries; an unmatched body is drained first; a body cut off after its head is a `DecodeError`
 * through a client that hands the response over at its head, and a transport failure through one
 * that reads it whole first; and a body is what the client gives the library. The Warded Server's
 * guides are the judge of what reached the client: a stream the client left is dropped, over
 * HTTP/1.1 and HTTP/2 at once and over HTTP/3 when something is sent next or the connection ends,
 * and a stream that fails is a failed response on every protocol.
 *
 * Each exchange keeps the request's records, the status the handler answered, and how far the
 * server took the streamed content: the host records the chunks it took and how the content
 * ended, and the test waits, for at most `settle`, for each stream to end before reading them.
 */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Schedule } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import { lane } from "#lane";
import {
  exportService,
  files,
  gzipped,
  orders,
  ordersCsv,
} from "../apis/exports.js";
import {
  archive,
  feed,
  file,
  firstPage,
  ledger,
  ordersCsv as downloadCsv,
  progressAsJson,
  progressAsText,
} from "../apis/exports-client.js";
import { type Progress, values } from "../harness/evidence.js";
import type { Client, Listener } from "../harness/lane.js";
import { cases, onHttp3, serve } from "../harness/matrix.js";
import {
  collect,
  execute,
  expectHops,
  type Hop,
  type Sent,
  send,
} from "../harness/send.js";
import type { Table } from "../harness/table.js";

/** How long a test waits for the server to end a stream: the wait ends as soon as it has. */
const settle = "1 second";

const csv = ordersCsv.join("");

/**
 * The protocol that carries a provider's requests to a listener. Node's `fetch` and `node:http`
 * use HTTP/1.1 over TLS, and undici negotiates HTTP/2. Chromium has moved to HTTP/3 on `https`
 * before these tests count requests, as `onHttp3` describes.
 */
const versionOf = (client: Client, listener: Listener) =>
  listener !== "https"
    ? "HTTP/1.1"
    : lane.name === "browser"
      ? "HTTP/3"
      : client.name === "undici"
        ? "HTTP/2"
        : "HTTP/1.1";

/**
 * Whether a provider hands the response over at its head and reads the body as the decoder asks.
 * Fetch and Effect's undici and `node:http` clients do; the line-preserving provider reads the
 * whole response first, as the library's guide to cut bodies describes.
 */
const handsOverAtHead = (client: Client) => client.name !== "lines";

/**
 * How a stalled stream ends once its client has left: dropped at once over HTTP/1.1 and HTTP/2,
 * and over HTTP/3 only when something is sent next, which a stall never does, or the connection
 * ends, which Chromium keeps open. So it is still open when the wait ends.
 */
const leftStalled = (version: string): Progress["ended"] =>
  version === "HTTP/3" ? null : "dropped";

/** A request for a file the store does not have, which answers at once. */
const probe = Operation.make(
  Request.get("/exports/files/missing.csv").pipe(Request.baseUrl("/v1")),
  Response.when(() => true, Response.tag("Missing", Body.text)),
);

/** Open the table, and in a browser on `https`, move to HTTP/3 first. */
const open = (client: Client, listener: Listener) =>
  Effect.gen(function* () {
    const routes = yield* serve(exportService);
    yield* onHttp3(routes, listener, client, probe);
    return routes;
  });

/**
 * Check the request's records for each request of a call, as `expectHops` does, and that each
 * went over the provider's protocol; then answer how far the server took each streamed reply.
 */
const expectStreamed = (
  routes: Table,
  sent: Sent,
  client: Client,
  listener: Listener,
  hops: ReadonlyArray<Hop>,
): ReadonlyArray<Progress | null | undefined> => {
  const context = JSON.stringify(sent);
  return expectHops(routes, sent, listener, hops).map((exchange) => {
    expect(exchange.seen.version, context).toBe(versionOf(client, listener));
    return exchange.dispatched?.streamed;
  });
};

const hop = (route: string, path: string): Hop => ({
  route,
  path,
  status: 200,
});

/** Bytes as base64, to compare them in either lane. */
const base64Of = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

describe("exports", () => {
  for (const { client, listener, title } of cases()) {
    it.live(
      `${title}: a slow CSV export decodes whole within its attempt timeout`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          const sent = yield* send(
            routes,
            listener,
            client,
            downloadCsv(Policy.timeout("5 seconds")),
            undefined,
            { settle },
          );
          expect(sent.value, JSON.stringify(sent)).toMatchObject({
            _tag: "Csv",
            value: csv,
            metadata: { status: 200 },
          });
          const [streamed] = expectStreamed(routes, sent, client, listener, [
            hop("orders-csv", "/v1/exports/orders.csv"),
          ]);
          expect(streamed, JSON.stringify(sent)).toEqual({
            chunks: ordersCsv.length,
            ended: "finished",
          });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: an attempt timeout shorter than the export ends it, and the server drops the rest`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          // The rows come 100 milliseconds apart, so the export takes 300 in all: the head and
          // the first row arrive within the limit, and the attempt still times out, since its
          // timeout covers decoding.
          const sent = yield* send(
            routes,
            listener,
            client,
            downloadCsv(Policy.timeout("150 millis")),
            undefined,
            { settle },
          );
          const context = JSON.stringify(sent);
          expect(sent.outcome, context).toMatchObject({
            kind: "failure",
            tag: "TimeoutError",
          });
          const [streamed] = expectStreamed(routes, sent, client, listener, [
            hop("orders-csv", "/v1/exports/orders.csv"),
          ]);
          // The rows the server took before the client left depend on timing; never all of them.
          expect(streamed?.ended, context).toBe("dropped");
          expect(streamed?.chunks, context).toBeGreaterThanOrEqual(1);
          expect(streamed?.chunks, context).toBeLessThan(ordersCsv.length);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a feed that stalls mid-body fails at each attempt's timeout, and retries as transient`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          const version = versionOf(client, listener);
          const once = yield* send(
            routes,
            listener,
            client,
            feed(Policy.timeout("300 millis")),
            undefined,
            { settle },
          );
          expect(once.outcome, JSON.stringify(once)).toMatchObject({
            kind: "failure",
            tag: "TimeoutError",
          });
          expect(
            expectStreamed(routes, once, client, listener, [
              hop("feed", "/v1/exports/feed"),
            ]),
            JSON.stringify(once),
          ).toEqual([{ chunks: 1, ended: leftStalled(version) }]);

          // A timed-out attempt is transient, so a policy with one retry makes a second attempt,
          // on a request of its own, and ends with its timeout.
          const twice = yield* send(
            routes,
            listener,
            client,
            feed(
              Policy.make(Schedule.recurs(1), { attemptTimeout: "200 millis" }),
            ),
            undefined,
            { settle },
          );
          expect(twice.outcome, JSON.stringify(twice)).toMatchObject({
            kind: "failure",
            tag: "TimeoutError",
          });
          expect(
            expectStreamed(routes, twice, client, listener, [
              hop("feed", "/v1/exports/feed"),
              hop("feed", "/v1/exports/feed"),
            ]),
            JSON.stringify(twice),
          ).toEqual([
            { chunks: 1, ended: leftStalled(version) },
            { chunks: 1, ended: leftStalled(version) },
          ]);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: interrupting a stalled read ends the operation as interrupted, without a retry`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          const sent = yield* collect(
            routes,
            Effect.gen(function* () {
              // A policy that would retry anything transient, and no timeout: only the
              // interruption ends the attempt.
              const fiber = yield* Effect.forkChild(
                execute(
                  routes,
                  listener,
                  client,
                  feed(Policy.make(Schedule.recurs(2))),
                  undefined,
                ),
              );
              // The feed's first chunk goes out at once, and by now every provider waits for
              // the rest: a client that hands the response over at its head, in the decoder.
              yield* Effect.sleep("300 millis");
              yield* Fiber.interrupt(fiber);
              return yield* Fiber.await(fiber);
            }),
            { settle },
          );
          const context = JSON.stringify(sent);
          const exit = sent.value!;
          expect(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
            context,
          ).toBe(true);
          expect(
            expectStreamed(routes, sent, client, listener, [
              hop("feed", "/v1/exports/feed"),
            ]),
            context,
          ).toEqual([
            { chunks: 1, ended: leftStalled(versionOf(client, listener)) },
          ]);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: an endless event stream holds the attempt while unmatched, until a timeout ends it`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          // No case matches the event stream, so the library drains it before it could fail
          // with `UnexpectedResponse`. It never ends, and the attempt timeout ends the drain.
          const unmatched = yield* send(
            routes,
            listener,
            client,
            progressAsJson(Policy.timeout("300 millis")),
            undefined,
            { settle },
          );
          // The stream sends something every 50 milliseconds, so the server notices the client
          // leaving on every protocol.
          const [drained] = expectStreamed(
            routes,
            unmatched,
            client,
            listener,
            [hop("events", "/v1/exports/events")],
          );
          expect(unmatched.outcome, JSON.stringify(unmatched)).toMatchObject({
            kind: "failure",
            tag: "TimeoutError",
          });
          expect(drained?.ended, JSON.stringify(unmatched)).toBe("dropped");
          expect(drained?.chunks, JSON.stringify(unmatched)).toBeGreaterThan(0);

          // Read whole as text with no attempt timeout, the caller's own deadline ends it.
          const read = yield* collect(
            routes,
            execute(routes, listener, client, progressAsText, undefined).pipe(
              Effect.timeout("300 millis"),
            ),
            { settle },
          );
          expect(read.outcome, JSON.stringify(read)).toMatchObject({
            kind: "failure",
            tag: "TimeoutError",
          });
          const [whole] = expectStreamed(routes, read, client, listener, [
            hop("events", "/v1/exports/events"),
          ]);
          expect(whole?.ended, JSON.stringify(read)).toBe("dropped");
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a decoder that reads the first records of an NDJSON export ends the response there`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          const sent = yield* send(
            routes,
            listener,
            client,
            firstPage(2, Policy.timeout("5 seconds")),
            undefined,
            { settle },
          );
          const context = JSON.stringify(sent);
          expect(sent.value, context).toMatchObject({
            _tag: "Page",
            value: orders.slice(0, 2),
            metadata: { status: 200 },
          });
          const [streamed] = expectStreamed(routes, sent, client, listener, [
            hop("orders-ndjson", "/v1/exports/orders.ndjson"),
          ]);
          if (handsOverAtHead(client)) {
            // The decoder returned after the second record, and the attempt's scope ended the
            // response, so the server dropped the rest.
            expect(streamed?.ended, context).toBe("dropped");
            expect(streamed?.chunks, context).toBeGreaterThanOrEqual(2);
            expect(streamed?.chunks, context).toBeLessThan(orders.length);
          } else {
            // The provider read the whole export before the decoder saw a record.
            expect(streamed, context).toEqual({
              chunks: orders.length,
              ended: "finished",
            });
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: content that ends before its Content-Length, or fails, is not taken for the whole`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          // https://github.com/viell-dev/slop-effect-schema-http/issues/369
          // Effect's undici and `node:http` clients hand the response over at its head, as Fetch
          // does, so the cut body is a `DecodeError` through them too. The library's guides put
          // "a provider on Node's `http`" with the clients that give a `TransportError`, which
          // only the line-preserving provider does here.
          const cut = (sent: Sent) => {
            const context = JSON.stringify(sent);
            if (handsOverAtHead(client))
              expect(sent.outcome, context).toEqual({
                kind: "failure",
                tag: "DecodeError",
                message:
                  "The body of the status 200 response could not be read; see cause",
              });
            else
              expect(sent.outcome, context).toMatchObject({
                kind: "failure",
                tag: "HttpClientError/TransportError",
              });
          };

          // The handler ended the content early, so the server took its one chunk to the end,
          // and the protocol fails the response that does not match its length.
          const short = yield* send(
            routes,
            listener,
            client,
            archive(Policy.timeout("5 seconds")),
            undefined,
            { settle },
          );
          expect(
            expectStreamed(routes, short, client, listener, [
              hop("archive", "/v1/exports/archive.csv"),
            ]),
            JSON.stringify(short),
          ).toEqual([{ chunks: 1, ended: "finished" }]);
          cut(short);

          // The handler's stream failed after two rows.
          const failed = yield* send(
            routes,
            listener,
            client,
            ledger(Policy.timeout("5 seconds")),
            undefined,
            { settle },
          );
          expect(
            expectStreamed(routes, failed, client, listener, [
              hop("ledger", "/v1/exports/ledger.csv"),
            ]),
            JSON.stringify(failed),
          ).toEqual([{ chunks: 2, ended: "failed" }]);
          cut(failed);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a file's bytes are what the provider gives for its Content-Encoding`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open(client, listener);
          const plain = btoa(csv);
          // Fetch decodes the codings it knows, in Node and in Chromium, and leaves an unknown
          // one alone. Effect's undici and `node:http` clients and the line-preserving provider
          // decode nothing, so their bytes are the file's as stored.
          const decodes = client.name === "fetch";
          const expected: Record<keyof typeof files, string | "refused"> = {
            "orders-2026-11-27.csv": decodes ? plain : gzipped.once,
            "orders-2026-11-26.csv": decodes ? "refused" : plain,
            "orders-2026-11-25.csv": gzipped.once,
            "orders-2026-11-24.csv": plain,
            "orders-2026-11-23.csv": decodes ? plain : gzipped.twice,
          };
          for (const [name, bytes] of Object.entries(expected)) {
            const sent = yield* send(routes, listener, client, file, {
              path: { name },
            });
            const context = `${name}: ${JSON.stringify(sent)}`;
            const [exchange] = expectHops(routes, sent, listener, [
              {
                route: "file",
                path: `/v1/exports/files/${name}`,
                status: 200,
                captures: { name },
              },
            ]);
            expect(
              values(exchange!.seen.headers, "accept-encoding"),
              context,
            ).toEqual(acceptEncoding(client, listener));
            if (bytes === "refused") {
              // Fetch hands the response over at its head, and the gzip decoder fails on the
              // first bytes: a body that does not decode.
              expect(sent.outcome, context).toEqual({
                kind: "failure",
                tag: "DecodeError",
                message:
                  "The body of the status 200 response could not be read; see cause",
              });
              continue;
            }
            const value = sent.value as
              { readonly _tag: "File"; readonly value: Uint8Array } | undefined;
            expect(value?._tag, context).toBe("File");
            expect(base64Of(value!.value), context).toBe(bytes);
          }
        }).pipe(Effect.scoped),
    );
  }
});

/**
 * The `Accept-Encoding` a provider writes: the library declares none, so it is the client's own.
 * Node's `fetch` asks for Brotli over TLS only, as undici does. Chromium also asks for Zstandard,
 * and on every listener, since it treats loopback as a secure origin. The others ask for nothing.
 */
const acceptEncoding = (
  client: Client,
  listener: Listener,
): ReadonlyArray<string> => {
  if (client.name !== "fetch") return [];
  if (lane.name === "browser") return ["gzip, deflate, br, zstd"];
  return [listener === "https" ? "br, gzip, deflate" : "gzip, deflate"];
};
