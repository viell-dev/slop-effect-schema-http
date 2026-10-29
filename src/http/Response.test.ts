import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { empty, json, probeBody, response, text } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Response from "./Response.js";
import * as Transport from "./Transport.js";

const metadataOf = (web: globalThis.Response) =>
  Response.metadata(response(web));

describe("Response.metadata", () => {
  it("exposes status, normalized headers and cookies", () => {
    const metadata = metadataOf(
      text(201, "", [
        ["X-Request-Id", "r1"],
        ["Set-Cookie", "session=abc; Path=/"],
        ["Set-Cookie", "csrf=xyz; Path=/"],
      ]),
    );
    expect(metadata.status).toBe(201);
    expect(metadata.headers["x-request-id"]).toBe("r1");
    expect(metadata.cookies.cookies["session"]?.value).toBe("abc");
    expect(metadata.cookies.cookies["csrf"]?.value).toBe("xyz");
    expect(metadata.headerLines).toStrictEqual(Option.none());
  });

  it("includes provider-attached header lines", () => {
    const native = Transport.withResponseHeaders(response(empty(200)), [
      ["X-Scope", "a"],
      ["X-Scope", "b"],
    ]);
    expect(Response.metadata(native).headerLines).toStrictEqual(
      Option.some([
        ["X-Scope", "a"],
        ["X-Scope", "b"],
      ]),
    );
  });
});

describe("Response.when and Response.status", () => {
  it("select their decoder only when the metadata matches", () => {
    const created = Response.status(201, Body.json);
    expect(Option.isSome(created.select(metadataOf(empty(201))))).toBe(true);
    expect(Option.isNone(created.select(metadataOf(empty(200))))).toBe(true);

    const flagged = Response.when(
      (metadata) => metadata.headers["x-error-code"] !== undefined,
      Body.text,
    );
    expect(
      Option.isSome(
        flagged.select(metadataOf(empty(200, { "x-error-code": "E1" }))),
      ),
    ).toBe(true);
    expect(Option.isNone(flagged.select(metadataOf(empty(200))))).toBe(true);
  });

  it("accept any numeric status, including unregistered ones", () => {
    const enhanceYourCalm = Response.status(420, Body.empty);
    expect(Option.isSome(enhanceYourCalm.select(metadataOf(empty(420))))).toBe(
      true,
    );
  });

  it("contribute their decoder's media type to Accept", () => {
    expect(Response.status(200, Body.json).accepts).toEqual([
      "application/json",
    ]);
    expect(Response.status(204, Body.empty).accepts).toEqual([]);
  });
});

describe("Response.orElse", () => {
  const first = Body.text.pipe(Body.map((value) => `first:${value}`));
  const second = Body.text.pipe(Body.map((value) => `second:${value}`));

  it.effect("prefers the earlier declaration when both match", () =>
    Effect.gen(function* () {
      const contract = Response.when(
        (metadata) => metadata.headers["x-error-code"] !== undefined,
        first,
      ).pipe(Response.orElse(Response.status(200, second)));
      expect(
        yield* Response.decode(
          contract,
          response(text(200, "x", { "x-error-code": "E1" })),
        ),
      ).toBe("first:x");
      expect(yield* Response.decode(contract, response(text(200, "y")))).toBe(
        "second:y",
      );
    }),
  );

  it.effect("keeps declaration order when the fallback is declared first", () =>
    Effect.gen(function* () {
      const contract = Response.status(200, second).pipe(
        Response.orElse(
          Response.when(
            (metadata) => metadata.headers["x-error-code"] !== undefined,
            first,
          ),
        ),
      );
      expect(
        yield* Response.decode(
          contract,
          response(text(200, "x", { "x-error-code": "E1" })),
        ),
      ).toBe("second:x");
    }),
  );

  it("merges accepted media types in order without duplicates", () => {
    const contract = Response.status(200, Body.json).pipe(
      Response.orElse(Response.status(400, Body.text)),
      Response.orElse(Response.status(422, Body.json)),
      Response.orElse(Response.status(204, Body.empty)),
    );
    expect(contract.accepts).toEqual(["application/json", "text/plain"]);
  });
});

describe("Response.tag", () => {
  it.effect("records the case, value and metadata", () =>
    Effect.gen(function* () {
      const contract = Response.status(200, Response.tag("Ok", Body.json)).pipe(
        Response.orElse(
          Response.status(404, Response.tag("Missing", Body.text)),
        ),
      );
      const ok = yield* Response.decode(
        contract,
        response(json(200, { id: 1 })),
      );
      expect(ok._tag).toBe("Ok");
      expect(ok.value).toEqual({ id: 1 });
      expect(ok.metadata.status).toBe(200);
      const missing = yield* Response.decode(
        contract,
        response(text(404, "gone")),
      );
      expect(missing).toMatchObject({ _tag: "Missing", value: "gone" });
      expect(missing.metadata.status).toBe(404);
      expect(contract.accepts).toEqual(["application/json", "text/plain"]);
    }),
  );
});

describe("Response.decode", () => {
  it.effect("selects from metadata before reading any body bytes", () =>
    Effect.gen(function* () {
      const probe = probeBody(['{"ok"', ":true}"]);
      const readAtSelection: Array<number> = [];
      const contract = Response.when((metadata) => {
        readAtSelection.push(probe.chunksRead());
        return metadata.status === 200;
      }, Body.json);
      const value = yield* Response.decode(
        contract,
        response(new globalThis.Response(probe.body, { status: 200 })),
      );
      expect(value).toEqual({ ok: true });
      expect(readAtSelection).toEqual([0]);
    }),
  );

  it.effect("drains an unmatched body and fails with its metadata", () =>
    Effect.gen(function* () {
      const probe = probeBody(["<html>", "maintenance", "</html>"]);
      const error = yield* Effect.flip(
        Response.decode(
          Response.status(200, Body.json),
          response(
            new globalThis.Response(probe.body, {
              status: 503,
              headers: { "retry-after": "5" },
            }),
          ),
        ),
      );
      expect(error).toBeInstanceOf(Response.UnexpectedResponse);
      expect(error._tag).toBe("UnexpectedResponse");
      expect(error.metadata.status).toBe(503);
      expect(error.metadata.headers["retry-after"]).toBe("5");
      expect(probe.finished()).toBe(true);
    }),
  );

  it.effect(
    "reports a failure to drain an unmatched body as a DecodeError",
    () =>
      Effect.gen(function* () {
        const broken = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        });
        const error = yield* Effect.flip(
          Response.decode(
            Response.status(200, Body.json),
            response(new globalThis.Response(broken, { status: 500 })),
          ),
        );
        expect(error._tag).toBe("DecodeError");
        if (error._tag !== "DecodeError") return;
        expect(error.metadata.status).toBe(500);
        expect(HttpClientError.isHttpClientError(error.cause)).toBe(true);
      }),
  );

  it.effect("wraps the selected decoder's typed error with metadata", () =>
    Effect.gen(function* () {
      const contract = Response.status(
        200,
        Body.json.pipe(Body.schema(Schema.Struct({ id: Schema.Number }))),
      );
      const error = yield* Effect.flip(
        Response.decode(contract, response(json(200, { id: "1" }))),
      );
      expect(error._tag).toBe("DecodeError");
      if (error._tag !== "DecodeError") return;
      expect(error.metadata.status).toBe(200);
      expect(Schema.isSchemaError(error.cause)).toBe(true);
    }),
  );

  it.effect("never falls through to a later case after a decode failure", () =>
    Effect.gen(function* () {
      const strict = Body.json.pipe(
        Body.schema(Schema.Struct({ id: Schema.Number })),
      );
      const loose = Body.json.pipe(
        Body.schema(Schema.Struct({ id: Schema.String })),
      );
      const contract = Response.status(200, strict).pipe(
        Response.orElse(Response.status(200, loose)),
      );
      const error = yield* Effect.flip(
        Response.decode(contract, response(json(200, { id: "1" }))),
      );
      expect(error._tag).toBe("DecodeError");
    }),
  );

  it.effect("decodes an honestly empty 204 and a zero-length 200", () =>
    Effect.gen(function* () {
      const contract = Response.status(204, Body.empty).pipe(
        Response.orElse(Response.status(200, Body.empty)),
      );
      yield* Response.decode(contract, response(empty(204)));
      yield* Response.decode(
        contract,
        response(text(200, "", { "content-type": "application/json" })),
      );
    }),
  );

  it.effect("rejects a zero-length body declared as JSON", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Response.decode(
          Response.status(200, Body.json),
          response(text(200, "", { "content-type": "application/json" })),
        ),
      );
      expect(error._tag).toBe("DecodeError");
    }),
  );

  it.effect("defers selection until the effect runs", () =>
    Effect.gen(function* () {
      let selected = 0;
      const contract = Response.when(() => {
        selected++;
        return true;
      }, Body.empty);
      const decoding = Response.decode(contract, response(empty(204)));
      expect(selected).toBe(0);
      yield* decoding;
      expect(selected).toBe(1);
    }),
  );
});
