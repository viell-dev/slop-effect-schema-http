/**
 * Exports over the host's HTTP/2 and HTTP/3 clients, whose exchanges hold the response as the
 * server wrote it: its fields, its content, or the reset that ended it. They show what the server
 * made of a streamed reply before the library saw it, which `exports.test.ts` can only infer, and
 * reach HTTP/2 with prior knowledge, which no standard provider of the lane speaks.
 *
 * Over HTTP/2 the comparison has three servers: the Warded Server over TLS on `https` and with
 * prior knowledge on `http`, and Hyper under `axum::serve` on `plain`, which runs none of the
 * Warded Server's finishing. Over HTTP/3 there is only `https`. These clients read the whole
 * response before the provider hands it over.
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Policy } from "viell-effect-schema-http";
import { lane } from "#lane";
import { exportService, files, gzipped, ordersCsv } from "../apis/exports.js";
import {
  archive,
  feed,
  file,
  ledger,
  ordersCsv as downloadCsv,
} from "../apis/exports-client.js";
import type { H2Received, H3Received } from "../harness/evidence.js";
import type { H2Provider, H3Provider } from "../harness/lane.js";
import { serve } from "../harness/matrix.js";
import { only, type Sent, send } from "../harness/send.js";
import type { Table } from "../harness/table.js";

const { h2, h3 } = lane;

const settle = "1 second";

const csv = ordersCsv.join("");

/** The received content, one character for each byte. */
const content = (received: H2Received | H3Received) =>
  received.is === "response"
    ? Buffer.from(received.body, "base64").toString("latin1")
    : undefined;

/** A received field's values, by name. */
const field = (received: H2Received | H3Received, name: string) =>
  received.is === "response"
    ? received.fields
        .filter(([candidate]) => candidate === name)
        .map(([, value]) => value)
    : undefined;

const protocols = [
  { name: "HTTP/2", listener: "https", server: "warded" },
  { name: "HTTP/2", listener: "http", server: "warded" },
  { name: "HTTP/2", listener: "plain", server: "hyper" },
  { name: "HTTP/3", listener: "https", server: "warded" },
] as const;

describe("exports: what the server wrote", () => {
  it("the stored gzip files hold the orders CSV, compressed once and twice", () => {
    const once = Buffer.from(gzipped.once, "base64");
    const twice = Buffer.from(gzipped.twice, "base64");
    expect(gunzipSync(once).toString("latin1")).toBe(csv);
    expect(gunzipSync(gunzipSync(twice)).toString("latin1")).toBe(csv);
  });

  for (const { name, listener } of protocols) {
    const title = `${name} on ${listener}`;
    const provider = (routes: Table): H2Provider | H3Provider =>
      name === "HTTP/2"
        ? h2!(routes.origins[listener])
        : h3!(routes.origins[listener]);
    /** The one exchange of a call, over this protocol, with what came back for it. */
    const received = (
      sent: Sent,
      exchanges: ReadonlyArray<{ readonly received: H2Received | H3Received }>,
    ) => {
      expect(exchanges, JSON.stringify(sent)).toHaveLength(1);
      const exchange = only(sent);
      expect(exchange.seen.version, JSON.stringify(sent)).toBe(name);
      return { exchange, received: exchanges[0]!.received };
    };

    it.live(`${title}: a slow export arrives whole and without a length`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(exportService);
        const { layer, exchanges } = provider(routes);
        const sent = yield* send(
          routes,
          listener,
          layer,
          downloadCsv(Policy.timeout("5 seconds")),
          undefined,
          { settle },
        );
        const context = JSON.stringify({ sent, exchanges });
        const { exchange, received: back } = received(sent, exchanges);
        expect(exchange.dispatched?.streamed, context).toEqual({
          chunks: ordersCsv.length,
          ended: "finished",
        });
        expect(back, context).toMatchObject({ is: "response", status: 200 });
        expect(content(back), context).toBe(csv);
        // Neither server knows the length of streamed content, and neither invents one.
        expect(field(back, "content-length"), context).toEqual([]);
        expect(sent.value, context).toMatchObject({ _tag: "Csv", value: csv });
      }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: content that ends before its Content-Length, or fails, ends the stream`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(exportService);

          const short = provider(routes);
          const cut = yield* send(
            routes,
            listener,
            short.layer,
            archive(Policy.timeout("5 seconds")),
            undefined,
            { settle },
          );
          const cutContext = JSON.stringify({
            cut,
            exchanges: short.exchanges,
          });
          const ended = received(cut, short.exchanges);
          expect(ended.exchange.dispatched?.streamed, cutContext).toEqual({
            chunks: 1,
            ended: "finished",
          });
          if (name === "HTTP/3") {
            // The Warded Server's HTTP/3 bridge checks the content against the length it
            // declared, and resets the stream that falls short.
            expect(ended.received, cutContext).toEqual({
              is: "reset",
              code: "H3_INTERNAL_ERROR",
            });
            expect(cut.outcome, cutContext).toMatchObject({
              kind: "failure",
              tag: "HttpClientError/TransportError",
            });
          } else {
            // https://github.com/viell-dev/slop-warded-server/issues/44
            // Over HTTP/2 the stream ends normally after the part, under the length the head
            // declared: Hyper and h2 check no response against its `Content-Length`. The
            // Warded Server's design says that every protocol fails such a response; Hyper under
            // `axum::serve` promises nothing.
            expect(ended.received, cutContext).toMatchObject({
              is: "response",
              status: 200,
            });
            expect(content(ended.received), cutContext).toBe(
              ordersCsv.slice(0, 2).join(""),
            );
            expect(field(ended.received, "content-length"), cutContext).toEqual(
              [String(csv.length)],
            );
            // The provider gives what came back, and the library returns the part.
            expect(cut.value, cutContext).toMatchObject({
              _tag: "Csv",
              value: ordersCsv.slice(0, 2).join(""),
            });
          }

          const failing = provider(routes);
          const failed = yield* send(
            routes,
            listener,
            failing.layer,
            ledger(Policy.timeout("5 seconds")),
            undefined,
            { settle },
          );
          const failedContext = JSON.stringify({
            failed,
            exchanges: failing.exchanges,
          });
          const reset = received(failed, failing.exchanges);
          expect(reset.exchange.dispatched?.streamed, failedContext).toEqual({
            chunks: 2,
            ended: "failed",
          });
          // A stream that fails is reset on both protocols, by both servers.
          expect(reset.received, failedContext).toEqual({
            is: "reset",
            code: name === "HTTP/3" ? "H3_INTERNAL_ERROR" : "INTERNAL_ERROR",
          });
          expect(failed.outcome, failedContext).toMatchObject({
            kind: "failure",
            tag: "HttpClientError/TransportError",
          });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: stored files go out with their bytes and codings as the handler wrote them`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(exportService);
          for (const [key, stored] of Object.entries(files)) {
            const { layer, exchanges } = provider(routes);
            const sent = yield* send(routes, listener, layer, file, {
              path: { name: key },
            });
            const context = `${key}: ${JSON.stringify({ sent, exchanges })}`;
            const { received: back } = received(sent, exchanges);
            expect(back, context).toMatchObject({
              is: "response",
              status: 200,
              body: stored.bytes,
            });
            expect(field(back, "content-encoding"), context).toEqual(
              stored.headers
                .filter(([header]) => header === "content-encoding")
                .map(([, value]) => value),
            );
            // The servers know the length of fixed content, and declare it.
            expect(field(back, "content-length"), context).toEqual([
              String(Buffer.from(stored.bytes, "base64").length),
            ]);
          }
        }).pipe(Effect.scoped),
    );

    // The host's clients end with their process when the provider is interrupted. That closes an
    // HTTP/2 connection's socket, as a client does that goes away; a QUIC connection gets no
    // CONNECTION_CLOSE that way, so HTTP/3 is left to Chromium in `exports.test.ts`.
    if (name === "HTTP/2")
      it.live(
        `${title}: a stalled feed's stream is dropped when its client goes away`,
        () =>
          Effect.gen(function* () {
            const routes = yield* serve(exportService);
            const { layer, exchanges } = provider(routes);
            const sent = yield* send(
              routes,
              listener,
              layer,
              feed(Policy.timeout("300 millis")),
              undefined,
              { settle },
            );
            const context = JSON.stringify({ sent, exchanges });
            expect(sent.outcome, context).toMatchObject({
              kind: "failure",
              tag: "TimeoutError",
            });
            // The client went before it could report what came back.
            expect(exchanges, context).toEqual([]);
            const exchange = only(sent);
            expect(exchange.seen.version, context).toBe(name);
            expect(exchange.dispatched?.streamed, context).toEqual({
              chunks: 1,
              ended: "dropped",
            });
          }).pipe(Effect.scoped),
      );
  }
});
