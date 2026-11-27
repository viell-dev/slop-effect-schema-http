/**
 * The Warded Server's limit on request heads over HTTP/2 and HTTP/3, at and just past each
 * boundary, with what each listener announces in its SETTINGS; and Warded's own limit on a
 * negotiation field, which the server's default limit hides, over both protocols. Sent by the
 * HTTP/2 and HTTP/3 providers, which write each field as a plain literal and report the size of
 * the encoded block. Node-only, because the providers run the host's clients as child processes.
 *
 * The server's `Limits::head_bytes` (32 KiB by default, its `docs/configuration.md`) is the "size
 * of one request head". Its rustdoc says that HTTP/2 and HTTP/3 count the decoded fields with 32
 * bytes for each, as RFC 9113 section 6.5.2 and RFC 9114 section 4.2.2 define the size of a field
 * section, and `docs/limits.md` that a head above it gets a 431, and that over HTTP/3 one above
 * twice as much while it is still encoded is refused before it arrives, without a response. The
 * server hands the limit to h2 as `SETTINGS_MAX_HEADER_LIST_SIZE` and to h3 as
 * `SETTINGS_MAX_FIELD_SECTION_SIZE`, which each announces and enforces. Under `axum::serve` the
 * router gets Hyper's defaults.
 *
 * The server sets no separate limit on one field or on the number of fields: a large field and
 * many small ones reach the same boundary, the second by the 32 bytes that each field adds. No
 * route runs for a refused head, so its records are the fields the client wrote, their encoded
 * size, and what came back.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { lane } from "#lane";
import {
  type Field,
  type H2Exchange,
  type H3Exchange,
  type Settings,
  values,
} from "../harness/evidence.js";
import type { Listener } from "../harness/lane.js";
import { serve } from "../harness/matrix.js";
import { and, exactPath, path, route, selected } from "../harness/routes.js";
import type { Definition } from "../harness/routes.js";
import { only, type Sent, send } from "../harness/send.js";
import type { OpenOptions, Table } from "../harness/table.js";

const table = { routes: [route("file", path("/files/{name}"))] };

/** Any response, with its status and text. */
const replies = Response.when(() => true, Response.tag("Reply", Body.text));

type Protocol = "h2" | "h3";
interface SentWith extends Sent {
  readonly exchange: H2Exchange | H3Exchange;
}

/** Send a request through the HTTP/2 or HTTP/3 provider; HTTP/3 goes to `https`. */
const sendOver = <I, E>(
  protocol: Protocol,
  routes: Table,
  listener: Listener,
  request: Request.Request<I, E>,
  input: I,
): Effect.Effect<SentWith> =>
  Effect.gen(function* () {
    const provider = lane[protocol]!(routes.origins[listener]);
    const sent = yield* send(
      routes,
      listener,
      provider.layer,
      Operation.make(request, replies),
      input,
    );
    expect(provider.exchanges, JSON.stringify(sent)).toHaveLength(1);
    return { ...sent, exchange: provider.exchanges[0]! };
  });

/** The size of a field section as both protocols' limits count it. */
const sectionSize = (fields: ReadonlyArray<Field>) =>
  fields.reduce(
    (sum, [name, value]) => sum + name.length + value.length + 32,
    0,
  );

/** The bytes of an integer with a prefix of `bits` bits (RFC 7541 section 5.1). */
const integerBytes = (value: number, bits: number) => {
  const max = 2 ** bits - 1;
  if (value < max) return 1;
  let bytes = 2;
  for (let rest = value - max; rest >= 0x80; rest = Math.floor(rest / 0x80))
    bytes += 1;
  return bytes;
};
/** The size of the HTTP/2 client's header block: literals without indexing (RFC 7541 6.2.2). */
const hpackSize = (fields: ReadonlyArray<Field>) =>
  fields.reduce(
    (sum, [name, value]) =>
      sum +
      1 +
      integerBytes(name.length, 7) +
      name.length +
      integerBytes(value.length, 7) +
      value.length,
    0,
  );
/** The size of the HTTP/3 client's field section: its prefix, then literals (RFC 9204 4.5.6). */
const qpackSize = (fields: ReadonlyArray<Field>) =>
  fields.reduce(
    (sum, [name, value]) =>
      sum +
      integerBytes(name.length, 3) +
      name.length +
      integerBytes(value.length, 7) +
      value.length,
    2,
  );
const measures = {
  section: sectionSize,
  h2: hpackSize,
  h3: qpackSize,
} as const;

/**
 * GET /files/a with `count` empty `x` fields and an `x-pad` field that brings the composed head to
 * `size` bytes as `measure` counts them. The provider composes its pseudo-header fields, the
 * declared fields in order, and the `Accept` of the response contract.
 */
const sized = (
  routes: Table,
  listener: Listener,
  size: number,
  measure: keyof typeof measures,
  count = 0,
) => {
  const scheme = listener === "https" ? "https" : "http";
  const extra = Array.from({ length: count }, (): Field => ["x", ""]);
  const composed = (pad: string): ReadonlyArray<Field> => [
    [":method", "GET"],
    [":scheme", scheme],
    [":authority", new URL(routes.origins[listener]).host],
    [":path", "/files/a"],
    ...extra,
    ["x-pad", pad],
    ["accept", "text/plain"],
  ];
  const sizeOf = (length: number) =>
    measures[measure](composed("a".repeat(length)));
  let length = size - sizeOf(0);
  while (sizeOf(length) > size) length -= 1;
  expect(sizeOf(length), `${measure} ${size}`).toBe(size);
  return extra
    .reduce(
      (request) => request.pipe(Request.appendHeader("x", "")),
      Request.get("/files/a"),
    )
    .pipe(Request.setHeader("x-pad", "a".repeat(length)));
};

/**
 * As many empty fields as fit in `size` beside the request's own, which take less than 300 bytes:
 * the rest goes in `x-pad`.
 */
const fieldsFor = (size: number) => Math.floor((size - 300) / 33);

/** The records of a head that reached the route. */
const expectServed = (sent: SentWith, size: number) => {
  expect(sectionSize(sent.exchange.fields)).toBe(size);
  expect(
    sent.exchange.received,
    JSON.stringify(sent.exchange.received),
  ).toMatchObject({
    is: "response",
    status: 200,
  });
  const { seen, dispatched } = only(sent);
  expect(values(seen.headers, "x-pad")).toEqual(
    values(sent.exchange.fields, "x-pad"),
  );
  expect(dispatched?.route).toBe("file");
};

/** The records of a head that got a 431 before any route: no other field, and no content. */
const expectTooLarge = (sent: SentWith, size: number) => {
  expect(sectionSize(sent.exchange.fields)).toBe(size);
  expect(sent.exchange.received).toEqual({
    is: "response",
    status: 431,
    fields: [],
    body: "",
  });
  expect(sent.exchanges).toEqual([]);
  expect(sent.outcome).toEqual({ kind: "value" });
};

/** The records of a head that got no response: refused for its stream or its connection. */
const expectRefused = (sent: SentWith, received: unknown) => {
  expect(sent.exchange.received).toEqual(received);
  expect(sent.exchanges).toEqual([]);
  expect(sent.outcome).toMatchObject({
    kind: "failure",
    tag: "HttpClientError/TransportError",
  });
};

/**
 * What the Warded Server's listeners announce over HTTP/2: Hyper's defaults, with the server's
 * `concurrent_streams` and `head_bytes`.
 */
const warded = (headBytes: number): Settings => ({
  SETTINGS_INITIAL_WINDOW_SIZE: 1_048_576,
  SETTINGS_MAX_CONCURRENT_STREAMS: 128,
  SETTINGS_MAX_FRAME_SIZE: 16_384,
  SETTINGS_MAX_HEADER_LIST_SIZE: headBytes,
});
/** And over HTTP/3: h3's settings, extended CONNECT and WebTransport off, with `head_bytes`. */
const wardedHttp3 = (headBytes: number): Settings => ({
  SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
  SETTINGS_ENABLE_WEBTRANSPORT: 0,
  SETTINGS_H3_DATAGRAM: 0,
  SETTINGS_MAX_FIELD_SECTION_SIZE: headBytes,
  SETTINGS_WEBTRANSPORT_MAX_SESSIONS: 0,
});

/** The head limit each HTTP/2 listener enforces: the server's default, or Hyper's. */
const http2Limits = { https: 32_768, http: 32_768, plain: 16_384 } as const;

/** h2's limit on CONTINUATION frames before the last one, at these list sizes. */
const continuations = 5;
const frameBytes = 16_384;

describe("request head limits over HTTP/2 and HTTP/3", () => {
  it.live("each listener announces its head limit", () =>
    Effect.gen(function* () {
      const settings = (
        protocol: Protocol,
        routes: Table,
        listener: Listener,
      ) =>
        Effect.map(
          sendOver(
            protocol,
            routes,
            listener,
            Request.get("/files/a"),
            undefined,
          ),
          (sent) => {
            expect(only(sent).dispatched?.route).toBe("file");
            return sent.exchange.settings;
          },
        );

      // The Warded Server announces `head_bytes` on both of its listeners and over both
      // protocols, with its `concurrent_streams`, 128. Hyper under `axum::serve` announces its own
      // defaults, a 16 KiB list among them, and extended CONNECT (RFC 8441), which the Warded
      // Server leaves off.
      const routes = yield* serve(table);
      for (const listener of ["https", "http"] as const)
        expect(yield* settings("h2", routes, listener)).toEqual(warded(32_768));
      expect(yield* settings("h2", routes, "plain")).toEqual({
        SETTINGS_ENABLE_CONNECT_PROTOCOL: 1,
        SETTINGS_INITIAL_WINDOW_SIZE: 1_048_576,
        SETTINGS_MAX_CONCURRENT_STREAMS: 200,
        SETTINGS_MAX_FRAME_SIZE: 16_384,
        SETTINGS_MAX_HEADER_LIST_SIZE: 16_384,
      });
      expect(yield* settings("h3", routes, "https")).toEqual(
        wardedHttp3(32_768),
      );

      const configured = yield* serve(table, { headBytes: 20_000 });
      for (const listener of ["https", "http"] as const)
        expect(yield* settings("h2", configured, listener)).toEqual(
          warded(20_000),
        );
      expect(yield* settings("h3", configured, "https")).toEqual(
        wardedHttp3(20_000),
      );
    }).pipe(Effect.scoped),
  );

  for (const listener of ["https", "http", "plain"] as const) {
    const limit = http2Limits[listener];

    it.live(
      `HTTP/2 on ${listener}: one large field and many small ones at ${limit}`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          for (const count of [0, fieldsFor(limit)]) {
            const at = (size: number) =>
              sendOver(
                "h2",
                routes,
                listener,
                sized(routes, listener, size, "section", count),
                undefined,
              );
            const below = yield* at(limit - 1);
            expectServed(below, limit - 1);
            // One field this large spans two frames under the server's limit, and fits one under
            // Hyper's.
            expect((below.exchange as H2Exchange).frames).toBe(
              count === 0 && limit > frameBytes ? 2 : 1,
            );
            expect(values(below.exchange.fields, "x")).toHaveLength(count);

            // RFC 9113 section 6.5.2 announces "the maximum field section size that the sender
            // is prepared to accept", and the server's `head_bytes` is the size of a head. h2
            // 0.4.21 takes a list of exactly that size for one over it (`headers_size >=
            // max_header_list_size`), so a head of the announced size gets the 431 on every
            // listener, where HTTP/3 serves one of `head_bytes` (below). Pinned as observed:
            // https://github.com/viell-dev/slop-warded-server/issues/43.
            expectTooLarge(yield* at(limit), limit);
            expectTooLarge(yield* at(limit + 1), limit + 1);
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `HTTP/2 on ${listener}: far past the limit, h2 ends the connection`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const goAway = (debug: string) => ({
            is: "go_away",
            code: "ENHANCE_YOUR_CALM",
            debug,
          });

          // A list of more than four times the limit, `MAX_HEADER_LIST_ABUSE_MULTIPLIER` in h2,
          // ends the connection, however small the block: these are thousands of empty fields in
          // one frame. The server's `docs/limits.md` names only the 431, as
          // https://github.com/viell-dev/slop-warded-server/issues/43 also reports.
          for (const size of [4 * limit, 4 * limit + 1]) {
            const sent = yield* sendOver(
              "h2",
              routes,
              listener,
              sized(routes, listener, size, "section", fieldsFor(size)),
              undefined,
            );
            expect((sent.exchange as H2Exchange).frames).toBe(1);
            if (size === 4 * limit) expectTooLarge(sent, size);
            else expectRefused(sent, goAway("header_list_way_too_large"));
          }

          // So does a block in more frames than h2 takes for the list size it announced: HEADERS,
          // at most five CONTINUATION frames, and the last one. One field of 7 frames fits that,
          // and is over the server's limit; under Hyper's it is also over four times the limit.
          const most = (continuations + 2) * frameBytes;
          for (const block of [most, most + 1]) {
            const sent = yield* sendOver(
              "h2",
              routes,
              listener,
              sized(routes, listener, block, "h2"),
              undefined,
            );
            const exchange = sent.exchange as H2Exchange;
            expect(exchange.block).toBe(block);
            expect(exchange.frames).toBe(Math.ceil(block / frameBytes));
            if (block > most && listener === "plain") {
              // h2 refuses at the seventh frame, so the last one is still unread when Hyper under
              // `axum::serve` drops the connection, and the kernel resets it: the reset can
              // overtake the GOAWAY. As measured, 14 of 300 requests with five such tests running
              // at once, and none of 30 alone. The Warded Server waits for the client to close, as
              // its `docs/limits.md` says, and its listeners delivered all 600 GOAWAY frames.
              expect([
                goAway("too_many_continuations"),
                { is: "closed" },
              ]).toContainEqual(sent.exchange.received);
              expect(sent.exchanges).toEqual([]);
              expect(sent.outcome).toMatchObject({
                kind: "failure",
                tag: "HttpClientError/TransportError",
              });
            } else if (block > most)
              expectRefused(sent, goAway("too_many_continuations"));
            else if (listener === "plain")
              expectRefused(sent, goAway("header_list_way_too_large"));
            else expectTooLarge(sent, sectionSize(exchange.fields));
          }
        }).pipe(Effect.scoped),
    );
  }

  it.live("HTTP/3: one large field and many small ones at 32768", () =>
    Effect.gen(function* () {
      const routes = yield* serve(table);
      const limit = 32_768;
      for (const count of [0, fieldsFor(limit)]) {
        const at = (size: number) =>
          sendOver(
            "h3",
            routes,
            "https",
            sized(routes, "https", size, "section", count),
            undefined,
          );
        // RFC 9114 section 4.2.2 counts as RFC 9113 does. h3 0.0.8 refuses only a section above
        // its limit (`mem_size > max_size`), so HTTP/3 serves a head of exactly `head_bytes`.
        for (const size of [limit - 1, limit]) {
          const sent = yield* at(size);
          expectServed(sent, size);
          expect(values(sent.exchange.fields, "x")).toHaveLength(count);
        }
        expectTooLarge(yield* at(limit + 1), limit + 1);
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "HTTP/3: an encoded head above twice the limit gets no response",
    () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        // The server reads the length of each HEADERS frame and refuses one above twice
        // `head_bytes` before h3 holds it, with RESET_STREAM and H3_EXCESSIVE_LOAD, as
        // `docs/limits.md` says. Literals decode to more than they take, so the largest frame it
        // takes is still over the limit once decoded, and gets the 431.
        const most = 2 * 32_768;
        for (const block of [most, most + 1]) {
          const sent = yield* sendOver(
            "h3",
            routes,
            "https",
            sized(routes, "https", block, "h3"),
            undefined,
          );
          expect(sent.exchange.block).toBe(block);
          if (block === most)
            expectTooLarge(sent, sectionSize(sent.exchange.fields));
          else expectRefused(sent, { is: "reset", code: "H3_EXCESSIVE_LOAD" });
        }
      }).pipe(Effect.scoped),
  );

  it.live(
    "a configured head_bytes holds on both protocols, apart from its own size",
    () =>
      Effect.gen(function* () {
        const limit = 20_000;
        const routes = yield* serve(table, { headBytes: limit });
        for (const [protocol, listener] of [
          ["h2", "https"],
          ["h2", "http"],
          ["h3", "https"],
        ] as const) {
          const at = (size: number) =>
            sendOver(
              protocol,
              routes,
              listener,
              sized(routes, listener, size, "section"),
              undefined,
            );
          expectServed(yield* at(limit - 1), limit - 1);
          // The head of exactly `head_bytes`: refused over HTTP/2 and served over HTTP/3, as at
          // the default. Pinned as observed:
          // https://github.com/viell-dev/slop-warded-server/issues/43.
          const exact = yield* at(limit);
          if (protocol === "h2") expectTooLarge(exact, limit);
          else expectServed(exact, limit);
          expectTooLarge(yield* at(limit + 1), limit + 1);
        }
      }).pipe(Effect.scoped),
  );

  // Warded's guides limit a negotiation field to 65 536 bytes once combined, and the server's
  // default head limit refuses such a head first, so `limits.test.ts` raises it to reach the
  // router over HTTP/1.1, where undici's HTTP/2 path stops at Node's own limit. These providers
  // reach it over HTTP/2 and HTTP/3. Under `axum::serve` the 16 KiB HTTP/2 limit is Hyper's, and
  // cannot be raised from the suite.
  const json = "application/json";
  const policies = [
    { target: "/accept", strict: false },
    { target: "/strict-accept", strict: true },
  ] as const;
  const negotiation: Definition = {
    offers: { formats: { field: "media_types", values: [json] } },
    routes: policies.map(({ target, strict }) =>
      route("json", and(exactPath(target), selected("formats", json, strict))),
    ),
  };
  const fieldLimit = 64 * 1024;
  const raised: OpenOptions = { headBytes: 128 * 1024 };
  // Two valid media ranges. Vary the length of the range that does not match by one byte.
  const padding = (size: number) => "application/".padEnd(size, "x");

  for (const [protocol, listener] of [
    ["h2", "https"],
    ["h2", "http"],
    ["h3", "https"],
  ] as const) {
    it.live(
      `${protocol} on ${listener}: negotiation handles 65536 and 65537 combined field bytes`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(negotiation, raised);
          for (const { target, strict } of policies) {
            for (const size of [fieldLimit, fieldLimit + 1]) {
              // One field, and two that Warded joins with a comma.
              for (const fields of [
                [json + "," + padding(size - json.length - 1)],
                [json, padding(size - json.length - 1)],
              ]) {
                const [first, ...rest] = fields as [string, ...string[]];
                const request = rest.reduce(
                  (request, field) =>
                    request.pipe(Request.appendHeader("accept", field)),
                  Request.get(target).pipe(Request.setHeader("accept", first)),
                );
                const sent = yield* sendOver(
                  protocol,
                  routes,
                  listener,
                  request,
                  undefined,
                );
                expect(values(sent.exchange.fields, "accept")).toEqual(fields);
                expect(fields.join(",")).toHaveLength(size);
                const { seen, verdict, dispatched, status } = only(sent);
                expect(values(seen.headers, "accept")).toEqual(fields);
                if (size === fieldLimit) {
                  const index = strict ? 1 : 0;
                  expect(verdict).toEqual({
                    is: "selected",
                    index,
                    captures: {},
                  });
                  expect(dispatched).toMatchObject({ index, route: "json" });
                  expect(status).toBe(200);
                } else if (strict) {
                  expect(verdict).toMatchObject({
                    is: "failed",
                    error: expect.stringContaining(
                      'InvalidHeader { name: "accept", detail: "combined field exceeds configured byte limit',
                    ),
                  });
                  expect(dispatched).toBeNull();
                  expect(status).toBe(400);
                } else {
                  expect(verdict).toEqual({ is: "missed" });
                  expect(dispatched).toBeNull();
                  expect(status).toBe(404);
                }
                expect(sent.exchange.received).toMatchObject({
                  is: "response",
                  status,
                });
              }
            }
          }
        }).pipe(Effect.scoped),
    );
  }
});
