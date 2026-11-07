/**
 * EXT-27: response metadata no server should send, and the edges of decoding text. Each export is
 * read three ways: through the library by every provider of the lane, through bare `fetch` in the
 * same lane as the control, and, for an export the control accepts, with the decoder a contract
 * would really use. Where the library and the control agree the result is the provider's, and the
 * test pins it. Where they differ it would be a suspected library defect.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Option, Schedule, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Bookings from "../clients/bookings/index.js";

const inBrowser = lane.name === "browser";
const retrying = Policy.make(Schedule.recurs(1));

const json = '{"ok":true}';
const Ok = Schema.Struct({ ok: Schema.Boolean });

const region = () => lane.backend("bookings");

/** What bare `fetch` makes of an export, with a decoder of the test's own. */
interface Control {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

const controlRead = (origin: string, name: string) =>
  Effect.tryPromise({
    try: async (): Promise<Control> => {
      const response = await fetch(`${origin}/v1/export/${name}`);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
    catch: (cause) => cause,
  });

const text = (bytes: Uint8Array, options?: TextDecoderOptions) =>
  new TextDecoder("utf-8", options).decode(bytes);

/** The library's read and the control's, which must agree, with the connection seen closed. */
const compared = (name: string, client: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    const backend = yield* region();
    const read = yield* Bookings.exported({ baseUrl: backend.origin })
      .execute(name)
      .pipe(Effect.provide(client));
    yield* Bookings.closed(backend, 0);
    expect(yield* backend.ledger).toHaveLength(1);
    const control = yield* controlRead(backend.origin, name);
    expect(read.status).toBe(control.status);
    expect(read.headers).toEqual(control.headers);
    expect(read.value).toBe(text(control.bytes));
    return { read, control };
  });

/** An export whose body is `J`, read as text and then as a contract would read it. */
const comparedJson = (
  name: string,
  client: Layer.Layer<HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const { read, control } = yield* compared(name, client);
    expect(read.value).toBe(json);
    const backend = yield* region();
    const decoded = yield* Bookings.exportWith(Body.jsonSchema(Ok))({
      baseUrl: backend.origin,
    })
      .execute(name)
      .pipe(Effect.provide(client));
    expect(decoded.value).toEqual({ ok: true });
    return { read, control };
  });

/** A head the client refuses: a `TransportError` for the library and the control alike. */
const refused = (
  name: string,
  client: Layer.Layer<HttpClient.HttpClient>,
  causes: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const first = yield* region();
    const error = yield* Effect.flip(
      Bookings.exported({ baseUrl: first.origin })
        .execute(name)
        .pipe(Effect.provide(client)),
    );
    expect(Bookings.described(error)).toEqual({ kind: "TransportError" });
    expect(Bookings.causes(error)).toEqual(causes);
    yield* Bookings.closed(first, 0);
    expect(yield* first.ledger).toHaveLength(1);
    const control = yield* Effect.flip(controlRead(first.origin, name));
    expect(control).toBeInstanceOf(TypeError);

    const second = yield* region();
    const again = yield* Effect.flip(
      Bookings.exported({ baseUrl: second.origin, policy: retrying })
        .execute(name)
        .pipe(Effect.provide(client)),
    );
    expect(Bookings.described(again)).toEqual({ kind: "TransportError" });
    expect(yield* second.ledger).toHaveLength(2);
  });

/** Node's two parsers of a response, which name the same refusal in different words. */
const refusal = (provider: string, parser: string, fetchCause?: string) =>
  provider === "lines"
    ? [`Parse Error: ${parser}`]
    : [
        "fetch failed",
        fetchCause ??
          `Response does not match the HTTP/1.1 protocol (${parser})`,
      ];

const lengthMismatch =
  "Response body length does not match content-length header";

/** A rule that compares the whole value, as one for a single line would. */
const whole = (type: string) =>
  Response.when(({ headers }) => headers["content-type"] === type, Body.text);

describe(`malformed response metadata and decoding boundaries (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    const inLines = provider === "lines";

    it.live(
      `[EXT-27a] ${provider}: conflicting Content-Type lines are joined, and only lines still has them apart`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("two-types", client);
          expect(read.headers["content-type"]).toBe(
            "text/plain, application/json",
          );
          expect(Option.getOrUndefined(read.lines)).toEqual(
            inLines
              ? [
                  ["Content-Type", "text/plain"],
                  ["Content-Type", "application/json"],
                  ["Content-Length", "11"],
                ]
              : undefined,
          );
        }),
    );

    it.live(
      `[EXT-27a] ${provider}: a rule that compares the whole value matches neither type, and one that reads the list has to say so`,
      () =>
        Effect.gen(function* () {
          const backend = yield* region();
          const request = Request.get(`${backend.origin}/v1/export/two-types`);
          const error = yield* Effect.flip(
            Operation.make(
              request,
              whole("application/json").pipe(
                Response.orElse(whole("text/plain")),
              ),
            ).execute(undefined),
          );
          expect(Bookings.described(error)).toEqual({
            kind: "UnexpectedResponse",
            status: 200,
          });
          const listed = Response.when(
            ({ headers }) =>
              (headers["content-type"] ?? "")
                .split(", ")
                .includes("application/json"),
            Body.text,
          );
          expect(
            yield* Operation.make(request, listed).execute(undefined),
          ).toBe(json);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-27b] ${provider}: one Content-Type twice is joined as well`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("same-type-twice", client);
          expect(read.headers["content-type"]).toBe(
            "application/json, application/json",
          );
        }),
    );

    it.live(
      `[EXT-27c] ${provider}: no Content-Type gives UTF-8 text, and Body.jsonSchema decodes it because it reads no content type`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("no-type", client);
          expect(read.headers["content-type"]).toBeUndefined();
        }),
    );

    it.live(
      `[EXT-27c] ${provider}: an unknown charset is ignored, so the bytes are UTF-8 text`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("odd-charset", client);
          expect(read.headers["content-type"]).toBe(
            "text/plain; charset=no-such-charset",
          );
        }),
    );

    it.live(
      `[EXT-27d] ${provider}: byte FC in a value reads as Latin-1, a u with two dots`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("latin1-value", client);
          expect(read.headers["x-vessel"]).toBe("Müller");
        }),
    );

    it.live(
      `[EXT-27d] ${provider}: UTF-8 in a value also reads as Latin-1, unchanged by the library, and repair is the consumer's`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("utf8-value", client);
          const value = read.headers["x-vessel"] ?? "";
          expect(value).toBe("MÃ¼ller");
          expect(
            text(Uint8Array.from(value, (char) => char.charCodeAt(0))),
          ).toBe("Müller");
        }),
    );

    for (const [name, parser, fetchCause] of [
      ["nul-value", "Invalid header value char", undefined],
      ["two-lengths", "Duplicate Content-Length", lengthMismatch],
      ["no-version", "Expected HTTP/, RTSP/ or ICE/", undefined],
    ] as const)
      it.live(
        `[EXT-27e] ${provider}: ${name} is refused by every client, a TransportError that a retry repeats`,
        () =>
          refused(
            name,
            client,
            inBrowser
              ? ["Failed to fetch"]
              : refusal(provider, parser, fetchCause),
          ),
      );

    if (!inBrowser)
      for (const [name, parser, fetchCause] of [
        ["ctl-value", "Invalid header value char", undefined],
        ["folded-value", "Unexpected whitespace after header value", undefined],
        ["bare-lf", "Missing expected CR after response line", undefined],
        ["no-colon", "Invalid header token", undefined],
        ["same-length-twice", "Duplicate Content-Length", lengthMismatch],
        [
          "length-and-chunked",
          "Transfer-Encoding can't be present with Content-Length",
          lengthMismatch,
        ],
        ["bad-status", "Invalid status code", undefined],
        ["status-99", "Invalid status code", undefined],
      ] as const)
        it.live(
          `[EXT-27f] ${provider}: Node refuses ${name}, with a cause naming the rule`,
          () => refused(name, client, refusal(provider, parser, fetchCause)),
        );

    it.live(
      `[EXT-27g] ${provider}: a status line with no reason is accepted, with empty status text`,
      () =>
        Effect.gen(function* () {
          const { read, control } = yield* comparedJson("no-reason", client);
          expect(read.status).toBe(200);
          expect(control.statusText).toBe("");
        }),
    );

    it.live(
      `[EXT-27g] ${provider}: an HTTP/1.0 answer with no length ends with its connection`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("http10", client);
          expect(read.status).toBe(200);
          expect(read.headers["content-length"]).toBeUndefined();
        }),
    );

    for (const [name, expected] of [
      ["split-utf8", "Grüße"],
      ["split-emoji", "ship \u{1f6a2} ok"],
    ] as const)
      it.live(
        `[EXT-27h] ${provider}: ${name} gives the text whole, as a decoder of all the bytes at once does`,
        () =>
          Effect.gen(function* () {
            const { read, control } = yield* compared(name, client);
            expect(read.value).toBe(expected);
            expect(text(control.bytes, { fatal: true })).toBe(expected);
          }),
      );

    it.live(
      `[EXT-27i] ${provider}: Body.text strips a byte-order mark split across chunks, and Body.bytes and the control keep it`,
      () =>
        Effect.gen(function* () {
          const { read, control } = yield* compared("split-bom", client);
          expect(read.value).toBe("ok");
          expect(text(control.bytes, { ignoreBOM: true })).toBe("﻿ok");
          const backend = yield* region();
          const bytes = yield* Bookings.exportWith(Body.bytes)({
            baseUrl: backend.origin,
          })
            .execute("split-bom")
            .pipe(Effect.provide(client));
          expect([...bytes.value]).toEqual([0xef, 0xbb, 0xbf, 0x6f, 0x6b]);
        }),
    );

    it.live(
      `[EXT-27j] ${provider}: Body.text gives U+FFFD for a character cut at the end of a body, with no failure`,
      () =>
        Effect.gen(function* () {
          const { read } = yield* compared("cut-utf8", client);
          expect(read.value).toBe("Gr�");
        }),
    );

    it.live(
      `[EXT-27j] ${provider}: a strict decoder over Body.bytes fails the same answer as a DecodeError`,
      () =>
        Effect.gen(function* () {
          const backend = yield* region();
          const strict = Body.bytes.pipe(
            Body.mapEffect((bytes) =>
              Effect.try({
                try: () => text(bytes, { fatal: true }),
                catch: (cause) => cause as TypeError,
              }),
            ),
          );
          const error = yield* Effect.flip(
            Bookings.exportWith(strict)({
              baseUrl: backend.origin,
              policy: retrying,
            }).execute("cut-utf8"),
          );
          expect(Bookings.described(error)).toEqual({
            kind: "DecodeError",
            status: 200,
            inner: "TypeError",
          });
          expect(yield* backend.ledger).toHaveLength(1);
        }).pipe(Effect.provide(client)),
    );
  }

  if (inBrowser) {
    const client = lane.fetchClient;

    it.live(
      "[EXT-27f] Chromium keeps a control character in a value, which Node refuses",
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("ctl-value", client);
          expect(read.headers["x-vessel"]).toBe("a\u0001b");
        }),
    );

    it.live("[EXT-27f] Chromium unfolds a folded value into a b", () =>
      Effect.gen(function* () {
        const { read } = yield* comparedJson("folded-value", client);
        expect(read.headers["x-vessel"]).toBe("a b");
      }),
    );

    it.live("[EXT-27f] Chromium accepts a head that ends its lines in LF", () =>
      Effect.gen(function* () {
        const { read } = yield* comparedJson("bare-lf", client);
        expect(read.headers["x-vessel"]).toBe("a");
      }),
    );

    it.live("[EXT-27f] Chromium ignores a line with no colon", () =>
      Effect.gen(function* () {
        const { read } = yield* comparedJson("no-colon", client);
        expect(Object.keys(read.headers).toSorted()).toEqual([
          "content-length",
          "content-type",
        ]);
      }),
    );

    it.live("[EXT-27f] Chromium shows one length twice as 11, 11", () =>
      Effect.gen(function* () {
        const { read } = yield* comparedJson("same-length-twice", client);
        expect(read.headers["content-length"]).toBe("11, 11");
      }),
    );

    it.live(
      "[EXT-27f] Chromium goes by the chunks when a length and chunks disagree",
      () =>
        Effect.gen(function* () {
          const { read } = yield* comparedJson("length-and-chunked", client);
          expect(read.headers["content-length"]).toBe("3");
          expect(read.headers["transfer-encoding"]).toBe("chunked");
        }),
    );

    it.live(
      "[EXT-27f] Chromium reads a status of abc as 200 with empty status text",
      () =>
        Effect.gen(function* () {
          const { read, control } = yield* comparedJson("bad-status", client);
          expect(read.status).toBe(200);
          expect(control.statusText).toBe("");
        }),
    );

    it.live(
      "[EXT-27f] Chromium hands over a status of 99, which matches no declared case",
      () =>
        Effect.gen(function* () {
          const { read, control } = yield* comparedJson("status-99", client);
          expect(read.status).toBe(99);
          expect(control.statusText).toBe("Odd");
          const backend = yield* region();
          const error = yield* Effect.flip(
            Operation.make(
              Request.get(`${backend.origin}/v1/export/status-99`),
              Response.status(200, Body.text),
            )
              .execute(undefined)
              .pipe(Effect.provide(client)),
          );
          expect(Bookings.described(error)).toEqual({
            kind: "UnexpectedResponse",
            status: 99,
          });
        }),
    );
  }
});
