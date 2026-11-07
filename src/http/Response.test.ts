import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Effect, flow, identity, Option, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { empty, json, probeBody, response, text } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Response from "./Response.js";
import * as Transport from "./Transport.js";

const metadataOf = (web: globalThis.Response) =>
  Response.metadata(response(web));

/** Read by a decoder, to show which cases a contract's services come from. */
class Prefix extends Context.Service<Prefix, string>()("test/Prefix") {}

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

  it.effect(
    "decodes payload variants under identical metadata through a schema union",
    () =>
      Effect.gen(function* () {
        const Outcome = Schema.Union([
          Schema.TaggedStruct("Accepted", { id: Schema.String }),
          Schema.TaggedStruct("Queued", { position: Schema.Number }),
        ]);
        let fallbacks = 0;
        const contract = Response.status(
          202,
          Body.json.pipe(Body.schema(Outcome)),
        ).pipe(
          Response.orElse(
            Response.when(
              () => true,
              Body.json.pipe(
                Body.map((value) => {
                  fallbacks++;
                  return value;
                }),
              ),
            ),
          ),
        );
        expect(
          yield* Response.decode(
            contract,
            response(json(202, { _tag: "Accepted", id: "a1" })),
          ),
        ).toEqual({ _tag: "Accepted", id: "a1" });
        expect(
          yield* Response.decode(
            contract,
            response(json(202, { _tag: "Queued", position: 3 })),
          ),
        ).toEqual({ _tag: "Queued", position: 3 });
        const error = yield* Effect.flip(
          Response.decode(
            contract,
            response(json(202, { _tag: "Rejected", reason: "quota" })),
          ),
        );
        expect(error._tag).toBe("DecodeError");
        if (error._tag !== "DecodeError") return;
        expect(error.metadata.status).toBe(202);
        expect(Schema.isSchemaError(error.cause)).toBe(true);
        expect(fallbacks).toBe(0);
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

  it.effect("selects an empty 304 by status despite a JSON content type", () =>
    Effect.gen(function* () {
      const contract = Response.status(
        200,
        Response.tag("Fresh", Body.json),
      ).pipe(
        Response.orElse(
          Response.status(304, Response.tag("NotModified", Body.empty)),
        ),
      );
      const result = yield* Response.decode(
        contract,
        response(
          empty(304, { "content-type": "application/json", etag: '"v7"' }),
        ),
      );
      expect(result._tag).toBe("NotModified");
      expect(result.metadata.headers.etag).toBe('"v7"');
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

type ValueOf<T> =
  T extends Response.Response<infer A, unknown, unknown> ? A : never;
type FailureOf<T> =
  T extends Response.Response<unknown, infer E, unknown> ? E : never;
type ServicesOf<T> =
  T extends Response.Response<unknown, unknown, infer R> ? R : never;
type KeysOf<T> =
  T extends Response.Response<unknown, unknown, unknown, infer C>
    ? C extends Response.Case<infer K, unknown, unknown, unknown>
      ? K
      : never
    : never;

const labelled = (label: string) =>
  Body.text.pipe(Body.map((value) => `${label}:${value}`));
const flagged = (metadata: Response.Metadata) =>
  metadata.headers["x-flag"] !== undefined;
const flaggedResponse = () => response(text(200, "x", { "x-flag": "1" }));

describe("Response cases", () => {
  it("lists each case with its key, in priority order", () => {
    const contract = Response.status(200, Body.text).pipe(
      Response.orElse(Response.when(flagged, Body.empty, { key: "flag" })),
      Response.orElse(Response.when(flagged, Body.json)),
    );
    expect(contract.cases.map((entry) => entry.key)).toEqual([
      200,
      "flag",
      undefined,
    ]);
    expectTypeOf<KeysOf<typeof contract>>().toEqualTypeOf<
      200 | "flag" | undefined
    >();
  });

  it("selects and accepts from that list", () => {
    const contract = Response.status(200, Body.json).pipe(
      Response.orElse(Response.status(404, Body.text)),
    );
    expect(contract.accepts).toEqual(["application/json", "text/plain"]);
    const selected = contract.select(metadataOf(empty(404)));
    expect(Option.isSome(selected) && selected.value).toBe(
      contract.cases[1]?.decoder,
    );
  });

  it("keeps a key out of selection", () => {
    const contract = Response.when(() => false, Body.text, { key: 200 });
    expect(Option.isNone(contract.select(metadataOf(empty(200))))).toBe(true);
  });

  it("keeps a plain annotation and explicit type arguments compiling", () => {
    const annotated: Response.Response<
      string,
      HttpClientError.HttpClientError
    > = Response.status<string, HttpClientError.HttpClientError, never>(
      200,
      Body.text,
    );
    expect(annotated.accepts).toEqual(["text/plain"]);
  });
});

describe("Response.replace", () => {
  it.effect("changes one decoder and leaves the other cases alone", () =>
    Effect.gen(function* () {
      const full = Response.status(200, Body.jsonSchema(Schema.Number)).pipe(
        Response.orElse(Response.status(404, labelled("missing"))),
      );
      const short = full.pipe(Response.replace(200, labelled("short")));
      expect(yield* Response.decode(short, response(text(200, "x")))).toBe(
        "short:x",
      );
      expect(yield* Response.decode(short, response(text(404, "y")))).toBe(
        "missing:y",
      );
    }),
  );

  it.effect("leaves the original contract unchanged", () =>
    Effect.gen(function* () {
      const full = Response.status(200, labelled("full"));
      const cases = full.cases;
      full.pipe(Response.replace(200, labelled("short")));
      expect(full.cases).toBe(cases);
      expect(yield* Response.decode(full, response(text(200, "x")))).toBe(
        "full:x",
      );
    }),
  );

  it.effect("keeps the case's position, because order is priority", () =>
    Effect.gen(function* () {
      const contract = Response.when(flagged, labelled("flag"), {
        key: "flag",
      }).pipe(Response.orElse(Response.status(200, labelled("plain"))));

      const later = contract.pipe(Response.replace(200, labelled("new")));
      expect(yield* Response.decode(later, flaggedResponse())).toBe("flag:x");
      expect(yield* Response.decode(later, response(text(200, "y")))).toBe(
        "new:y",
      );

      const earlier = contract.pipe(Response.replace("flag", labelled("new")));
      expect(yield* Response.decode(earlier, flaggedResponse())).toBe("new:x");
      expect(earlier.cases.map((entry) => entry.key)).toEqual(["flag", 200]);
    }),
  );

  it.effect("keeps a when case's match rule", () =>
    Effect.gen(function* () {
      const contract = Response.when(
        (metadata) => metadata.status >= 500,
        labelled("old"),
        { key: "server" },
      );
      const replaced = contract.pipe(
        Response.replace("server", labelled("new")),
      );
      expect(yield* Response.decode(replaced, response(text(503, "x")))).toBe(
        "new:x",
      );
      const error = yield* Effect.flip(
        Response.decode(replaced, response(text(200, "x"))),
      );
      expect(error._tag).toBe("UnexpectedResponse");
    }),
  );

  it.effect(
    "keeps the first position when a key repeats, and drops the others",
    () =>
      Effect.gen(function* () {
        const contract = Response.status(200, labelled("first")).pipe(
          Response.orElse(Response.status(404, labelled("missing"))),
          Response.orElse(Response.status(200, Body.json)),
        );
        const replaced = contract.pipe(Response.replace(200, labelled("new")));
        expect(replaced.cases.map((entry) => entry.key)).toEqual([200, 404]);
        expect(replaced.accepts).toEqual(["text/plain"]);
        expect(yield* Response.decode(replaced, response(text(200, "x")))).toBe(
          "new:x",
        );
        expectTypeOf<ValueOf<typeof replaced>>().toEqualTypeOf<string>();
      }),
  );

  it("moves Accept with the new decoder, in declaration order", () => {
    const contract = Response.status(200, Body.json).pipe(
      Response.orElse(Response.status(400, Body.text)),
      Response.orElse(Response.status(422, Body.json)),
    );
    expect(contract.pipe(Response.replace(200, Body.bytes)).accepts).toEqual([
      "application/octet-stream",
      "text/plain",
      "application/json",
    ]);
    expect(contract.pipe(Response.replace(400, Body.json)).accepts).toEqual([
      "application/json",
    ]);
    expect(contract.pipe(Response.replace(200, Body.empty)).accepts).toEqual([
      "text/plain",
      "application/json",
    ]);
  });

  it("holds only the cases that can still occur in its type", () => {
    const Thing = Schema.Struct({ id: Schema.Number });
    const full = Response.status(
      200,
      Response.tag("Found", Body.jsonSchema(Thing)),
    ).pipe(
      Response.orElse(
        Response.status(404, Response.tag("Missing", Body.empty)),
      ),
    );
    const short = full.pipe(Response.replace(200, Body.text));
    expectTypeOf<ValueOf<typeof short>>().toEqualTypeOf<
      string | Response.Tagged<"Missing", void>
    >();
    expectTypeOf<KeysOf<typeof short>>().toEqualTypeOf<200 | 404>();
  });

  it("drops a replaced case's failures and services from its type", () => {
    const needsPrefix = Body.decoder(() =>
      Effect.flatMap(Prefix, () => Effect.fail("bad" as const)),
    );
    const contract = Response.status(200, needsPrefix).pipe(
      Response.orElse(Response.status(404, Body.empty)),
    );
    expectTypeOf<ServicesOf<typeof contract>>().toEqualTypeOf<Prefix>();
    expectTypeOf<"bad">().toExtend<FailureOf<typeof contract>>();

    const plain = contract.pipe(Response.replace(200, Body.empty));
    expectTypeOf<ServicesOf<typeof plain>>().toEqualTypeOf<never>();
    expectTypeOf<"bad">().not.toExtend<FailureOf<typeof plain>>();
  });
});

describe("Response.remove", () => {
  it.effect("lets a matching response fall through to a later case", () =>
    Effect.gen(function* () {
      const contract = Response.status(404, labelled("missing")).pipe(
        Response.orElse(Response.when(() => true, labelled("other"))),
      );
      const trimmed = contract.pipe(Response.remove(404));
      expect(yield* Response.decode(trimmed, response(text(404, "x")))).toBe(
        "other:x",
      );
    }),
  );

  it.effect("fails with UnexpectedResponse when no case is left to match", () =>
    Effect.gen(function* () {
      const contract = Response.status(200, Body.text).pipe(
        Response.orElse(Response.status(404, Body.text)),
      );
      const trimmed = contract.pipe(Response.remove(404));
      const error = yield* Effect.flip(
        Response.decode(trimmed, response(text(404, "x"))),
      );
      expect(error._tag).toBe("UnexpectedResponse");
      expect(contract.cases).toHaveLength(2);
    }),
  );

  it("removes every case with the key and its media type", () => {
    const contract = Response.status(200, Body.json).pipe(
      Response.orElse(Response.status(404, Body.text)),
      Response.orElse(Response.status(200, Body.bytes)),
    );
    const trimmed = contract.pipe(Response.remove(200));
    expect(trimmed.cases.map((entry) => entry.key)).toEqual([404]);
    expect(trimmed.accepts).toEqual(["text/plain"]);
    expectTypeOf<ValueOf<typeof trimmed>>().toEqualTypeOf<string>();
  });

  it.effect(
    "can remove the last case, leaving a contract that accepts nothing",
    () =>
      Effect.gen(function* () {
        const trimmed = Response.status(200, Body.text).pipe(
          Response.remove(200),
        );
        expect(trimmed.cases).toEqual([]);
        expect(trimmed.accepts).toEqual([]);
        expectTypeOf<ValueOf<typeof trimmed>>().toEqualTypeOf<never>();
        const error = yield* Effect.flip(
          Response.decode(trimmed, response(text(200, "x"))),
        );
        expect(error._tag).toBe("UnexpectedResponse");
      }),
  );

  it("drops a removed case's failures and services from its type", () => {
    const needsPrefix = Body.decoder(() =>
      Effect.map(Prefix, (prefix) => prefix),
    );
    const contract = Response.status(200, needsPrefix).pipe(
      Response.orElse(Response.status(404, Body.empty)),
    );
    const trimmed = contract.pipe(Response.remove(200));
    expectTypeOf<ServicesOf<typeof contract>>().toEqualTypeOf<Prefix>();
    expectTypeOf<ServicesOf<typeof trimmed>>().toEqualTypeOf<never>();
  });
});

/** A call the types refuse has type `never`, so its keys are read through this. */
const keysAfter = (refused: unknown) =>
  (refused as Response.Response<unknown>).cases.map((entry) => entry.key);

describe("Response case keys", () => {
  const contract = Response.status(200, Body.text).pipe(
    Response.orElse(Response.status(404, Body.empty)),
    Response.orElse(Response.when(flagged, Body.json, { key: "flag" })),
  );

  it("refuses a key the contract lacks, at compile time and at run time", () => {
    expect(() =>
      contract.pipe(
        // @ts-expect-error there is no 201 case to replace
        Response.replace(201, Body.text),
      ),
    ).toThrow("no case 201");
    expect(() =>
      contract.pipe(
        // @ts-expect-error there is no 201 case to remove
        Response.remove(201),
      ),
    ).toThrow("no case 201");
    expect(() =>
      contract.pipe(
        // @ts-expect-error a key is not a tag
        Response.remove("Found"),
      ),
    ).toThrow('no case "Found"');
  });

  it("treats a status and a string spelling it as different keys", () => {
    expect(() =>
      contract.pipe(
        // @ts-expect-error keys compare exactly
        Response.remove("200"),
      ),
    ).toThrow('no case "200"');
    expect(keysAfter(contract.pipe(Response.remove(200)))).toEqual([
      404,
      "flag",
    ]);
    const named = Response.when(flagged, Body.text, { key: "200" });
    expect(() =>
      named.pipe(
        // @ts-expect-error the same the other way round
        Response.remove(200),
      ),
    ).toThrow(/no case 200$/);
    expect(keysAfter(named.pipe(Response.remove("200")))).toEqual([]);
  });

  it("refuses a widened key passed in, however it arrives", () => {
    const code = 200 as number;
    const name = "flag" as string;
    expect(
      keysAfter(
        contract.pipe(
          // @ts-expect-error a widened number proves nothing about which case this is
          Response.replace(code, Body.empty),
        ),
      ),
    ).toEqual([200, 404, "flag"]);
    expect(
      keysAfter(
        contract.pipe(
          // @ts-expect-error a widened string proves nothing either
          Response.remove(name),
        ),
      ),
    ).toEqual([200, 404]);
  });

  it("refuses a case whose own key is not a literal", () => {
    const code = 200 as number;
    const widened = Response.status(code, Body.text);
    expect(
      keysAfter(
        widened.pipe(
          // @ts-expect-error a widened case proves nothing about which case this is
          Response.replace(200, Body.empty),
        ),
      ),
    ).toEqual([200]);
    expect(() =>
      widened.pipe(
        // @ts-expect-error the same for removing, and here the value differs too
        Response.remove(201),
      ),
    ).toThrow("no case 201");

    const pattern = Response.when(flagged, Body.text, {
      key: "x-a" as `x-${string}`,
    });
    expect(() =>
      pattern.pipe(
        // @ts-expect-error a pattern is not a literal
        Response.remove("x-b"),
      ),
    ).toThrow('no case "x-b"');

    type Branded = string & { readonly brand: unique symbol };
    const branded = Response.when(flagged, Body.text, { key: "a" as Branded });
    expect(() =>
      branded.pipe(
        // @ts-expect-error a brand is not a literal
        Response.remove("b"),
      ),
    ).toThrow('no case "b"');
  });

  it("refuses a union of keys passed in", () => {
    const key = 200 as 200 | 404;
    // A union is refused because only the value passed is touched at run time.
    expect(
      keysAfter(
        contract.pipe(
          // @ts-expect-error the type would drop both cases, and only one would go
          Response.remove(key),
        ),
      ),
    ).toEqual([404, "flag"]);
    expect(
      keysAfter(
        contract.pipe(
          // @ts-expect-error the same for replacing
          Response.replace(key, Body.empty),
        ),
      ),
    ).toEqual([200, 404, "flag"]);
  });

  it("refuses a case whose own key is a union", () => {
    const code = 404 as 200 | 404;
    const either = Response.status(code, Body.text);
    expect(() =>
      either.pipe(
        // @ts-expect-error the case's key does not say which status it is
        Response.remove(200),
      ),
    ).toThrow("no case 200");

    const name = "a" as "a" | undefined;
    const optional = Response.when(flagged, Body.text, { key: name });
    expect(
      keysAfter(
        optional.pipe(
          // @ts-expect-error the key may be absent
          Response.remove("a"),
        ),
      ),
    ).toEqual([]);
  });

  it("cannot address a when case with no key", () => {
    const unkeyed = Response.when(flagged, Body.text);
    expect(() =>
      unkeyed.pipe(
        // @ts-expect-error an unkeyed case has no key to address
        Response.remove("flag"),
      ),
    ).toThrow('no case "flag"');
    expect(() =>
      (Response.remove(undefined as never) as (self: unknown) => unknown)(
        unkeyed,
      ),
    ).toThrow("no case undefined");
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/125
  it("currently refuses flow over edits with no contract to check the keys against", () => {
    const trimmed = flow(
      identity<typeof contract>,
      Response.remove(404),
      Response.replace(200, Body.empty),
    );
    expect(keysAfter(trimmed(contract))).toEqual([200, "flag"]);

    const noMissing = Response.remove(404);
    const emptied = Response.replace(200, Body.empty);
    expect(() =>
      // @ts-expect-error a key can only be checked against a known contract
      flow(noMissing, emptied),
    ).toBeTypeOf("function");
  });

  it("loses the keys of a contract annotated without them", () => {
    const annotated: Response.Response<string> = Response.status(
      200,
      Body.decoder(() => Effect.succeed("x")),
    );
    expect(
      keysAfter(
        annotated.pipe(
          // @ts-expect-error the annotation dropped the keys, which seals the contract
          Response.replace(200, Body.empty),
        ),
      ),
    ).toEqual([200]);
  });
});
