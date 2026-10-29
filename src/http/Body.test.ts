import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { HttpBody, HttpClientError, UrlParams } from "effect/http";
import {
  empty as emptyReply,
  probeBody,
  response,
} from "../../test/support.js";
import * as Body from "./Body.js";

const bytesOf = (body: HttpBody.HttpBody): Uint8Array => {
  if (body._tag !== "Uint8Array") throw new Error(`body is ${body._tag}`);
  return body.body;
};

const textOf = (body: HttpBody.HttpBody): string =>
  new TextDecoder().decode(bytesOf(body));

const contentTypeOf = (body: HttpBody.HttpBody): string | undefined =>
  "contentType" in body ? body.contentType : undefined;

const reply = (body: BodyInit | null, contentType?: string) =>
  response(
    new globalThis.Response(body, {
      status: 200,
      ...(contentType === undefined
        ? {}
        : { headers: { "content-type": contentType } }),
    }),
  );

const decodeErrorReason = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined || error._tag !== "Fail")
    throw new Error("expected a typed failure");
  if (!HttpClientError.isHttpClientError(error.error))
    throw new Error("expected an HttpClientError");
  return error.error.reason;
};

describe("Body.json", () => {
  it.effect("encodes JSON with its content type", () =>
    Effect.gen(function* () {
      const body = yield* Body.json.encode({ name: "Ada", tags: ["x"] });
      expect(contentTypeOf(body)).toBe("application/json");
      expect(JSON.parse(textOf(body))).toEqual({ name: "Ada", tags: ["x"] });
    }),
  );

  it.effect("fails encoding a value JSON cannot represent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Body.json.encode({ id: 1n }));
      expect(error).toBeInstanceOf(HttpBody.HttpBodyError);
    }),
  );

  // Body.json delegates to HttpBody.json, whose text step deliberately turns JSON.stringify's
  // `undefined` result into an empty body. Body.jsonSchema is the validated path.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/8
  it.effect(
    "encodes values JSON.stringify omits as HttpBody.json does: an empty JSON body",
    () =>
      Effect.gen(function* () {
        for (const value of [undefined, () => 1, Symbol("x")]) {
          const body = yield* Body.json.encode(value);
          const native = yield* HttpBody.json(value);
          expect(contentTypeOf(body)).toBe("application/json");
          expect(bytesOf(body)).toEqual(bytesOf(native));
          expect(bytesOf(body).length).toBe(0);
        }
      }),
  );

  it.effect("decodes any JSON value, including null", () =>
    Effect.gen(function* () {
      expect(yield* Body.json.decode(reply('{"a":[1,true,null]}'))).toEqual({
        a: [1, true, null],
      });
      expect(yield* Body.json.decode(reply("null"))).toBeNull();
      expect(yield* Body.json.decode(reply("42"))).toBe(42);
    }),
  );

  it.effect("ignores the response content type", () =>
    Effect.gen(function* () {
      expect(
        yield* Body.json.decode(reply('{"ok":true}', "text/html")),
      ).toEqual({ ok: true });
    }),
  );

  it.effect("rejects an empty body as a decode error rather than null", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Body.json.decode(reply("", "application/json")),
      );
      expect(decodeErrorReason(exit)._tag).toBe("DecodeError");
    }),
  );

  it.effect("rejects malformed JSON as a decode error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Body.json.decode(reply(")]}',\n{}", "application/json")),
      );
      const reason = decodeErrorReason(exit);
      expect(reason._tag).toBe("DecodeError");
      expect(reason).toMatchObject({ cause: expect.any(SyntaxError) });
    }),
  );

  it("advertises application/json", () => {
    expect(Body.json.mediaType).toBe("application/json");
  });
});

describe("Body.text", () => {
  it.effect("encodes UTF-8 text/plain", () =>
    Effect.gen(function* () {
      const body = yield* Body.text.encode("Grüße ✓");
      expect(contentTypeOf(body)).toBe("text/plain");
      expect(Array.from(bytesOf(body))).toEqual(
        Array.from(new TextEncoder().encode("Grüße ✓")),
      );
    }),
  );

  it.effect("decodes UTF-8 text", () =>
    Effect.gen(function* () {
      expect(yield* Body.text.decode(reply("Grüße ✓"))).toBe("Grüße ✓");
      expect(yield* Body.text.decode(reply(null))).toBe("");
    }),
  );

  it("advertises text/plain", () => {
    expect(Body.text.mediaType).toBe("text/plain");
  });
});

describe("Body.bytes", () => {
  it.effect("encodes the exact bytes as application/octet-stream", () =>
    Effect.gen(function* () {
      const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x00, 0xff]);
      const body = yield* Body.bytes.encode(input);
      expect(contentTypeOf(body)).toBe("application/octet-stream");
      expect(Array.from(bytesOf(body))).toEqual(Array.from(input));
    }),
  );

  it.effect("decodes the exact bytes, keeping a BOM and invalid UTF-8", () =>
    Effect.gen(function* () {
      const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xe4, 0xff]);
      const decoded = yield* Body.bytes.decode(reply(input, "text/csv"));
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(Array.from(decoded)).toEqual(Array.from(input));
    }),
  );

  it("advertises application/octet-stream", () => {
    expect(Body.bytes.mediaType).toBe("application/octet-stream");
  });
});

describe("Body.formData", () => {
  it.effect(
    "encodes FormData and leaves its Content-Type to the transport",
    () =>
      Effect.gen(function* () {
        const form = new FormData();
        form.append("label", "report");
        const body = yield* Body.formData.encode(form);
        expect(body._tag).toBe("FormData");
        expect(contentTypeOf(body)).toBeUndefined();
      }),
  );

  it.effect("decodes a multipart response", () =>
    Effect.gen(function* () {
      const form = new FormData();
      form.append("meta", '{"id":1}');
      form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "data.bin");
      const decoded = yield* Body.formData.decode(
        response(new globalThis.Response(form)),
      );
      expect(decoded.get("meta")).toBe('{"id":1}');
      const file = decoded.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect(
        Array.from(
          new Uint8Array(
            yield* Effect.promise(() => (file as Blob).arrayBuffer()),
          ),
        ),
      ).toEqual([1, 2, 3]);
    }),
  );
});

describe("Body.urlEncoded", () => {
  it.effect("encodes ordered parameters as form-urlencoded", () =>
    Effect.gen(function* () {
      const body = yield* Body.urlEncoded.encode(
        UrlParams.fromInput([
          ["grant_type", "password"],
          ["scope", "a b"],
          ["scope", "c"],
        ]),
      );
      expect(contentTypeOf(body)).toBe("application/x-www-form-urlencoded");
      expect(textOf(body)).toBe("grant_type=password&scope=a+b&scope=c");
    }),
  );

  it.effect(
    "decodes a form-urlencoded response with every value as a string",
    () =>
      Effect.gen(function* () {
        const params = yield* Body.urlEncoded.decode(
          reply("access_token=t&expires_in=3600&scope=a&scope=b"),
        );
        expect(params.params).toEqual([
          ["access_token", "t"],
          ["expires_in", "3600"],
          ["scope", "a"],
          ["scope", "b"],
        ]);
      }),
  );
});

describe("Body.empty", () => {
  it.effect("encodes no body", () =>
    Effect.gen(function* () {
      expect((yield* Body.empty.encode())._tag).toBe("Empty");
    }),
  );

  it.effect("accepts a response without a body", () =>
    Effect.gen(function* () {
      yield* Body.empty.decode(response(emptyReply(204)));
      yield* Body.empty.decode(reply(null, "application/json"));
    }),
  );

  it.effect("drains an unexpected body completely", () =>
    Effect.gen(function* () {
      const probe = probeBody(["debug ", "output ", "that nobody declared"]);
      yield* Body.empty.decode(response(new globalThis.Response(probe.body)));
      expect(probe.chunksRead()).toBe(3);
      expect(probe.finished()).toBe(true);
    }),
  );

  it("contributes no media type", () => {
    expect(Body.empty.mediaType).toBeUndefined();
  });
});

describe("Body.map and Body.mapEffect", () => {
  it.effect("transform the decoded value and keep the media type", () =>
    Effect.gen(function* () {
      const length = Body.text.pipe(Body.map((value) => value.length));
      expect(length.mediaType).toBe("text/plain");
      expect(yield* length.decode(reply("abcd"))).toBe(4);

      const checked = Body.text.pipe(
        Body.mapEffect((value) =>
          value === "ok"
            ? Effect.succeed(true)
            : Effect.fail("not ok" as const),
        ),
      );
      expect(checked.mediaType).toBe("text/plain");
      expect(yield* checked.decode(reply("ok"))).toBe(true);
      expect(yield* Effect.flip(checked.decode(reply("no")))).toBe("not ok");
    }),
  );
});

describe("Body.decoder, encoder and make", () => {
  it.effect("build pipeable codecs from functions", () =>
    Effect.gen(function* () {
      const decoder = Body.decoder(
        (res) => Effect.map(res.text, (value) => value.toUpperCase()),
        "text/x-shout",
      );
      expect(decoder.mediaType).toBe("text/x-shout");
      expect(
        yield* decoder
          .pipe(Body.map((value) => `${value}!`))
          .decode(reply("hi")),
      ).toBe("HI!");
      expect(Body.decoder(() => Effect.void).mediaType).toBeUndefined();

      const encoder = Body.encoder((value: number) =>
        Effect.succeed(HttpBody.text(String(value), "text/x-number")),
      );
      expect(contentTypeOf(yield* encoder.encode(7))).toBe("text/x-number");

      const codec = Body.make({
        encode: (value: number) => Effect.succeed(HttpBody.text(String(value))),
        decode: (res) => Effect.map(res.text, Number),
      });
      expect(codec.mediaType).toBeUndefined();
      expect(yield* codec.decode(reply("12"))).toBe(12);
    }),
  );
});

describe("Body.schema", () => {
  const User = Schema.Struct({
    id: Schema.Number,
    name: Schema.NonEmptyString,
  });
  const users = Body.json.pipe(Body.schema(User));

  it.effect("validates the decoded value", () =>
    Effect.gen(function* () {
      expect(yield* users.decode(reply('{"id":1,"name":"Ada"}'))).toEqual({
        id: 1,
        name: "Ada",
      });
      expect(users.mediaType).toBe("application/json");
    }),
  );

  it.effect("fails with a SchemaError for an invalid value", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        users.decode(reply('{"id":1,"name":""}')),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  it.effect("applies the schema's decoding transformation", () =>
    Effect.gen(function* () {
      const count = Body.text.pipe(Body.schema(Schema.FiniteFromString));
      expect(yield* count.decode(reply("42"))).toBe(42);
      expect(
        Schema.isSchemaError(yield* Effect.flip(count.decode(reply("x")))),
      ).toBe(true);
    }),
  );
});

describe("Body.encodeSchema", () => {
  it.effect("encodes through the schema before the wire encoder", () =>
    Effect.gen(function* () {
      const count = Body.text.pipe(Body.encodeSchema(Schema.NumberFromString));
      expect(textOf(yield* count.encode(42))).toBe("42");
    }),
  );

  it.effect(
    "fails with a SchemaError before wire encoding for invalid input",
    () =>
      Effect.gen(function* () {
        let encoded = 0;
        const wire = Body.encoder((value: string) =>
          Effect.sync(() => {
            encoded++;
            return HttpBody.text(value);
          }),
        );
        const name = wire.pipe(Body.encodeSchema(Schema.NonEmptyString));
        const error = yield* Effect.flip(name.encode(""));
        expect(Schema.isSchemaError(error)).toBe(true);
        expect(encoded).toBe(0);
      }),
  );
});

describe("Body.jsonSchema", () => {
  const Event = Schema.Struct({
    id: Schema.BigInt,
    at: Schema.Date,
    note: Schema.optional(Schema.String),
  });
  const events = Body.jsonSchema(Event);

  it.effect("encodes through the schema's canonical JSON codec", () =>
    Effect.gen(function* () {
      const body = yield* events.encode({
        id: 9007199254740993n,
        at: new Date(Date.UTC(2026, 9, 29)),
      });
      expect(contentTypeOf(body)).toBe("application/json");
      expect(JSON.parse(textOf(body))).toEqual({
        id: "9007199254740993",
        at: "2026-10-29T00:00:00.000Z",
      });
    }),
  );

  it.effect("round-trips values that plain JSON would lose", () =>
    Effect.gen(function* () {
      const value = {
        id: 9007199254740993n,
        at: new Date(Date.UTC(2026, 9, 29, 1, 2, 3)),
        note: "",
      };
      const body = yield* events.encode(value);
      const decoded = yield* events.decode(reply(textOf(body)));
      expect(decoded).toEqual(value);
      expect(decoded.id).toBe(9007199254740993n);
    }),
  );

  it.effect("rejects invalid input on both sides with SchemaError", () =>
    Effect.gen(function* () {
      const encodeError = yield* Effect.flip(
        events.encode({ id: 1n, at: new Date(Number.NaN) }),
      );
      expect(Schema.isSchemaError(encodeError)).toBe(true);
      const decodeError = yield* Effect.flip(
        events.decode(reply('{"id":"not a number","at":"2026-10-29"}')),
      );
      expect(Schema.isSchemaError(decodeError)).toBe(true);
    }),
  );

  it.effect("keeps decode errors from the wire as client errors", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(events.decode(reply("")));
      expect(HttpClientError.isHttpClientError(error)).toBe(true);
    }),
  );

  it("advertises application/json", () => {
    expect(events.mediaType).toBe("application/json");
  });
});

const latin1 = new TextDecoder("iso-8859-1");

const bigEndianUint64 = (bytes: Uint8Array): bigint =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
    0,
  );

describe("non-text payloads through Body.bytes and a schema", () => {
  it.effect("reads Latin-1 text that UTF-8 text decoding would garble", () =>
    Effect.gen(function* () {
      const city = Body.bytes.pipe(
        Body.map((bytes) => latin1.decode(bytes)),
        Body.schema(Schema.NonEmptyString),
      );
      // "Köln" in ISO-8859-1; 0xf6 alone is not valid UTF-8.
      const encoded = new Uint8Array([0x4b, 0xf6, 0x6c, 0x6e]);
      expect(
        yield* city.decode(reply(encoded, "text/plain; charset=iso-8859-1")),
      ).toBe("Köln");
      expect(yield* Body.text.decode(reply(encoded))).toBe("K\uFFFDln");
    }),
  );

  it.effect("reads 64-bit integers without losing precision", () =>
    Effect.gen(function* () {
      const exceedsDouble = 9007199254740993n;
      const binary = new Uint8Array(8);
      new DataView(binary.buffer).setBigUint64(0, exceedsDouble);
      const counter = Body.bytes.pipe(
        Body.map(bigEndianUint64),
        Body.schema(Schema.BigInt),
      );
      expect(yield* counter.decode(reply(binary))).toBe(exceedsDouble);

      const textual = Body.text.pipe(Body.schema(Schema.BigIntFromString));
      expect(yield* textual.decode(reply(String(exceedsDouble)))).toBe(
        exceedsDouble,
      );
    }),
  );

  it.effect("reads HEAD facts from headers after draining the body", () =>
    Effect.gen(function* () {
      const facts = Body.decoder((res) =>
        Effect.as(Body.empty.decode(res), res.headers),
      ).pipe(
        Body.schema(
          Schema.Struct({
            "content-length": Schema.NumberFromString,
            etag: Schema.String,
          }),
        ),
      );
      const head = response(
        new globalThis.Response(null, {
          status: 200,
          headers: { "content-length": "1048576", etag: '"v7"' },
        }),
      );
      expect(yield* facts.decode(head)).toEqual({
        "content-length": 1048576,
        etag: '"v7"',
      });
    }),
  );
});

describe("Body.text and Body.bytes", () => {
  // The BOM stripping comes from the platform's Response.text(), not from this library.
  it.effect(
    "text decoding inherits the platform's BOM stripping; bytes keep it",
    () =>
      Effect.gen(function* () {
        const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x3b, 0x62]);
        const asText = yield* Body.text.decode(reply(withBom));
        const asBytes = yield* Body.bytes.decode(reply(withBom));
        expect(asText).toBe("a;b");
        expect(asBytes.length).toBe(6);
      }),
  );
});
