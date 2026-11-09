import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { compile } from "../../test/request.js";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

/** The body fields of a compiled request. */
const bodyFieldsOf = ({ request }: Request.Compiled) => ({
  type: request.headers["content-type"],
  length: request.headers["content-length"],
});

/** A deliberate native relabelling of the body, reusable on any request. */
const relabel = <I, E, R>(self: Request.Request<I, E, R>) =>
  self.pipe(
    Request.mapEffect((request) =>
      Effect.succeed(
        HttpClientRequest.setHeader(
          request,
          "content-type",
          "application/merge-patch+json",
        ),
      ),
    ),
  );

describe("Request.body", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.effect("keeps a raw Content-Type declared before the body", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.post("https://api.test/items").pipe(
          Request.setHeader("Content-Type", "text/plain"),
          Request.body(Body.json),
        ),
        { body: { name: "x" } },
      );
      expect(compiled.request.headers["content-type"]).toBe("text/plain");
      expect(compiled.request.headers["content-length"]).toBe("12");
      expect(bodyText(compiled.request)).toBe('{"name":"x"}');
      expect(compiled.headerLines).toContainEqual([
        "Content-Type",
        "text/plain",
      ]);
      expect(compiled.headerLines).not.toContainEqual([
        "content-type",
        "application/json",
      ]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.effect("keeps a raw Content-Type declared after the body", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.post("https://api.test/items").pipe(
          Request.body(Body.json),
          Request.setHeader("Content-Type", "text/plain"),
        ),
        { body: { name: "x" } },
      );
      expect(compiled.request.headers["content-type"]).toBe("text/plain");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.effect(
    "keeps a header schema's Content-Type declared before the body",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("https://api.test/items").pipe(
            Request.headers(Schema.Struct({ "Content-Type": Schema.String })),
            Request.body(Body.json),
          ),
          { body: { name: "x" }, headers: { "Content-Type": "text/plain" } },
        );
        expect(compiled.request.headers["content-type"]).toBe("text/plain");
        expect(compiled.headerLines).toContainEqual([
          "Content-Type",
          "text/plain",
        ]);
      }),
  );

  const Framing = Schema.Struct({
    "Content-Type": Schema.String,
    "Content-Length": Schema.String,
    "X-Trace": Schema.String,
  });
  const framing = {
    "Content-Type": "text/plain",
    "Content-Length": "999",
    "X-Trace": "t1",
  };
  const Trace = Schema.Struct({ "X-Trace": Schema.String });
  // https://github.com/viell-dev/slop-effect-schema-http/issues/6
  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.effect(
    "keeps a header schema's body fields when it follows the body",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("https://api.test/items").pipe(
            Request.body(Body.json),
            Request.headers(Framing),
          ),
          { body: { name: "x" }, headers: framing },
        );
        expect(compiled.request.headers["content-type"]).toBe("text/plain");
        expect(compiled.request.headers["content-length"]).toBe("999");
        expect(compiled.request.headers["x-trace"]).toBe("t1");
        expect(bodyText(compiled.request)).toBe('{"name":"x"}');
        expect(compiled.headerLines).toEqual([
          ["Content-Type", "text/plain"],
          ["Content-Length", "999"],
          ["X-Trace", "t1"],
        ]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.effect("lets a header schema replace multipart framing", () =>
    Effect.gen(function* () {
      const form = new FormData();
      form.append("file", "x");
      const compiled = yield* compile(
        Request.post("https://api.test/upload").pipe(
          Request.body(Body.formData),
          Request.headers(Framing),
        ),
        {
          body: form,
          headers: { ...framing, "Content-Type": "multipart/form-data" },
        },
      );
      expect(compiled.request.body._tag).toBe("FormData");
      expect(compiled.headerLines).toEqual([
        ["Content-Type", "multipart/form-data"],
        ["Content-Length", "999"],
        ["X-Trace", "t1"],
      ]);
    }),
  );

  it.effect("leaves multipart framing to the transport otherwise", () =>
    Effect.gen(function* () {
      const form = new FormData();
      form.append("file", "x");
      const compiled = yield* compile(
        Request.post("https://api.test/upload").pipe(
          Request.body(Body.formData),
          Request.headers(Trace),
        ),
        { body: form, headers: { "X-Trace": "t1" } },
      );
      expect(compiled.request.headers["content-type"]).toBeUndefined();
      expect(compiled.request.headers["content-length"]).toBeUndefined();
      expect(compiled.headerLines).toEqual([["X-Trace", "t1"]]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.effect("keeps a native body-header edit unless a later step sets it", () =>
    Effect.gen(function* () {
      const input = { body: { name: "x" }, headers: framing };
      // The edit survives a schema that never mentions Content-Type.
      const unrelated = yield* compile(
        Request.post("https://api.test/items").pipe(
          Request.body(Body.json),
          relabel,
          Request.headers(Trace),
        ),
        { body: input.body, headers: { "X-Trace": "t1" } },
      );
      expect(unrelated.request.headers["content-type"]).toBe(
        "application/merge-patch+json",
      );
      expect(unrelated.headerLines).toContainEqual([
        "content-type",
        "application/merge-patch+json",
      ]);
      // A later schema that sets the field declares it, so it wins.
      const conflicting = yield* compile(
        Request.post("https://api.test/items").pipe(
          Request.body(Body.json),
          relabel,
          Request.headers(Framing),
        ),
        input,
      );
      expect(conflicting.request.headers["content-type"]).toBe("text/plain");
      expect(conflicting.headerLines).toContainEqual([
        "Content-Type",
        "text/plain",
      ]);
      // An edit applied after the schema is simply the last word.
      const after = yield* compile(
        Request.post("https://api.test/items").pipe(
          Request.body(Body.json),
          Request.headers(Framing),
          relabel,
        ),
        input,
      );
      expect(after.request.headers["content-type"]).toBe(
        "application/merge-patch+json",
      );
    }),
  );

  it.effect(
    "keeps a header schema's body fields on a request without a body",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.del("https://api.test/items/1").pipe(
            Request.headers(Framing),
          ),
          { headers: { ...framing, "Content-Type": "application/json" } },
        );
        expect(compiled.request.headers["content-type"]).toBe(
          "application/json",
        );
        expect(compiled.headerLines).toEqual([
          ["Content-Type", "application/json"],
          ["Content-Length", "999"],
          ["X-Trace", "t1"],
        ]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.effect("keeps a header schema's body fields around Body.empty", () =>
    Effect.gen(function* () {
      const input = { body: undefined, headers: framing };
      const emptyFirst = yield* compile(
        Request.del("https://api.test/items/1").pipe(
          Request.body(Body.empty),
          Request.headers(Framing),
        ),
        input,
      );
      const emptyLast = yield* compile(
        Request.del("https://api.test/items/1").pipe(
          Request.headers(Framing),
          Request.body(Body.empty),
        ),
        input,
      );
      for (const compiled of [emptyFirst, emptyLast]) {
        expect(compiled.request.body._tag).toBe("Empty");
        expect(compiled.request.headers["content-type"]).toBe("text/plain");
        expect(compiled.request.headers["content-length"]).toBe("999");
      }
    }),
  );

  it.effect("lets Request.mapEffect relabel the body deliberately", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.post("https://api.test/items").pipe(
          Request.body(Body.json),
          Request.mapEffect((request) =>
            Effect.succeed(
              HttpClientRequest.setHeader(
                request,
                "content-type",
                "application/merge-patch+json",
              ),
            ),
          ),
        ),
        { body: { name: "x" } },
      );
      expect(compiled.request.headers["content-type"]).toBe(
        "application/merge-patch+json",
      );
    }),
  );

  it.effect("encodes once per compilation", () =>
    Effect.gen(function* () {
      let encoded = 0;
      const counting = Body.encoder((value: string) =>
        Effect.flatMap(
          Effect.sync(() => encoded++),
          () => Body.text.encode(value),
        ),
      );
      yield* compile(
        Request.put("https://api.test/x").pipe(Request.body(counting)),
        { body: "a" },
      );
      expect(encoded).toBe(1);
    }),
  );

  it.effect("propagates the codec's encoding failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(
          Request.post("https://api.test/items").pipe(
            Request.body(Body.jsonSchema(Schema.Struct({ n: Schema.Finite }))),
          ),
          { body: { n: Number.POSITIVE_INFINITY } },
        ),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/96
  it.effect.each(["GET", "HEAD"])("keeps a body on %s", (method) =>
    Effect.gen(function* () {
      const { request } = yield* compile(
        Request.make(method, "https://soap.test/download").pipe(
          Request.body(Body.text),
        ),
        { body: "<Envelope/>" },
      );
      expect(request.method).toBe(method);
      expect(bodyText(request)).toBe("<Envelope/>");
      expect(request.headers["content-type"]).toBe("text/plain");
      expect(request.headers["content-length"]).toBe("11");
    }),
  );

  it("takes a body as input on the GET and HEAD helpers", () => {
    for (const helper of [Request.get, Request.head]) {
      expectTypeOf(helper("/").pipe(Request.body(Body.text))).toEqualTypeOf<
        Request.Request<{ readonly body: string }>
      >();
    }
  });

  it.effect("allows a body on DELETE and custom methods", () =>
    Effect.gen(function* () {
      for (const method of ["DELETE", "PROPFIND", "REPORT"]) {
        const compiled = yield* compile(
          Request.make(method, "https://dav.test/").pipe(
            Request.body(Body.text),
          ),
          { body: "<propfind/>" },
        );
        expect(bodyText(compiled.request)).toBe("<propfind/>");
      }
    }),
  );

  it.effect("allows an empty body on GET", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(Request.body(Body.empty)),
        { body: undefined },
      );
      expect(compiled.request.body._tag).toBe("Empty");
    }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/100
describe("automatic body fields", () => {
  type Edit = <I, E, R>(
    self: Request.Request<I, E, R>,
  ) => Request.Request<I, E, R>;

  const post = Request.post("https://api.test/items");
  const hello = { body: "hello" };
  /** A request with `edit` applied before the body, and one with it applied after. */
  const eitherOrder = (edit: Edit) => [
    post.pipe(edit, Request.body(Body.text)),
    post.pipe(Request.body(Body.text), edit),
  ];

  it.effect("uses the encoder's values when nothing is declared", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(Request.body(Body.text)),
        hello,
      );
      expect(bodyFieldsOf(compiled)).toEqual({
        type: "text/plain",
        length: "5",
      });
    }),
  );

  it.effect("lets a declared Content-Type win in either order", () =>
    Effect.gen(function* () {
      for (const request of eitherOrder(
        Request.setHeader("content-type", "application/weird"),
      )) {
        const compiled = yield* compile(request, hello);
        expect(bodyFieldsOf(compiled)).toEqual({
          type: "application/weird",
          length: "5",
        });
      }
    }),
  );

  it.effect("lets a declared Content-Length win in either order", () =>
    Effect.gen(function* () {
      for (const request of eitherOrder(
        Request.setHeader("content-length", "3"),
      )) {
        const compiled = yield* compile(request, hello);
        expect(bodyFieldsOf(compiled)).toEqual({
          type: "text/plain",
          length: "3",
        });
      }
    }),
  );

  it.effect("lets an empty declared value win", () =>
    Effect.gen(function* () {
      for (const request of eitherOrder(
        Request.setHeader("content-type", ""),
      )) {
        const compiled = yield* compile(request, hello);
        expect(bodyFieldsOf(compiled)).toEqual({ type: "", length: "5" });
      }
    }),
  );

  it.effect("lets a computed value win, evaluated once", () =>
    Effect.gen(function* () {
      let calls = 0;
      const compiled = yield* compile(
        post.pipe(
          Request.setHeader("content-type", () => `computed-${++calls}`),
          Request.body(Body.text),
        ),
        hello,
      );
      expect(bodyFieldsOf(compiled).type).toBe("computed-1");
      expect(calls).toBe(1);
    }),
  );

  it.effect("keeps the spelling and lines of a declared field", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.body(Body.text),
          Request.appendHeader("Content-Type", "a"),
          Request.appendHeader("content-TYPE", "b"),
        ),
        hello,
      );
      expect(bodyFieldsOf(compiled).type).toBe("a, b");
      expect(compiled.headerLines).toEqual([
        ["Content-Type", "a"],
        ["content-TYPE", "b"],
        ["content-length", "5"],
      ]);
    }),
  );

  it.effect("stops an automatic value with removeHeader, in either order", () =>
    Effect.gen(function* () {
      for (const request of eitherOrder(Request.removeHeader("Content-TYPE"))) {
        const compiled = yield* compile(request, hello);
        expect(bodyFieldsOf(compiled)).toEqual({
          type: undefined,
          length: "5",
        });
        expect(compiled.headerLines).toEqual([["content-length", "5"]]);
      }
      for (const request of eitherOrder(
        Request.removeHeader("content-length"),
      )) {
        const compiled = yield* compile(request, hello);
        expect(bodyFieldsOf(compiled)).toEqual({
          type: "text/plain",
          length: undefined,
        });
      }
    }),
  );

  it.effect("removes a declaration along with the automatic value", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.setHeader("content-type", "application/weird"),
          Request.body(Body.text),
          Request.removeHeader("content-type"),
        ),
        hello,
      );
      expect(bodyFieldsOf(compiled).type).toBeUndefined();
    }),
  );

  it.effect("records nothing for a removal limited to one value", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.setHeader("content-type", "application/weird"),
          Request.removeHeader("content-type", "application/weird"),
          Request.body(Body.text),
        ),
        hello,
      );
      expect(bodyFieldsOf(compiled).type).toBe("text/plain");
      expect(compiled.removedHeaders).toEqual(new Set());
    }),
  );

  it.effect("keeps a removal when a later one is limited to a value", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.removeHeader("content-type", "application/weird"),
          Request.body(Body.text),
        ),
        hello,
      );
      expect(bodyFieldsOf(compiled).type).toBeUndefined();
    }),
  );

  it.effect("lets a later declaration win over a removal", () =>
    Effect.gen(function* () {
      const set = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.setHeader("Content-Type", "application/weird"),
          Request.body(Body.text),
        ),
        hello,
      );
      expect(bodyFieldsOf(set).type).toBe("application/weird");
      const appended = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.body(Body.text),
          Request.appendHeader("Content-Type", "application/weird"),
        ),
        hello,
      );
      expect(bodyFieldsOf(appended).type).toBe("application/weird");
    }),
  );

  it.effect("keeps a removal when a computed value declares nothing", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.setHeader("Content-Type", () => undefined),
          Request.body(Body.text),
        ),
        hello,
      );
      expect(bodyFieldsOf(compiled).type).toBeUndefined();
    }),
  );

  it.effect("treats a computed undefined as nothing declared", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.setHeader("content-type", () => undefined),
          Request.body(Body.text),
        ),
        hello,
      );
      expect(bodyFieldsOf(compiled).type).toBe("text/plain");
    }),
  );

  it.effect("never discards what a header schema produces", () =>
    Effect.gen(function* () {
      const Type = Schema.Struct({ "Content-Type": Schema.String });
      const input = {
        ...hello,
        headers: { "Content-Type": "application/weird" },
      };
      const removed = post.pipe(Request.removeHeader("content-type"));
      for (const request of [
        removed.pipe(Request.headers(Type), Request.body(Body.text)),
        removed.pipe(Request.body(Body.text), Request.headers(Type)),
      ]) {
        const compiled = yield* compile(request, input);
        expect(bodyFieldsOf(compiled).type).toBe("application/weird");
      }
    }),
  );

  it.effect("treats an omitted optional schema field as nothing declared", () =>
    Effect.gen(function* () {
      const Type = Schema.Struct({
        "Content-Type": Schema.optional(Schema.String),
      });
      const input = { ...hello, headers: {} };
      for (const request of [
        post.pipe(Request.headers(Type), Request.body(Body.text)),
        post.pipe(Request.body(Body.text), Request.headers(Type)),
      ]) {
        const compiled = yield* compile(request, input);
        expect(bodyFieldsOf(compiled)).toEqual({
          type: "text/plain",
          length: "5",
        });
      }
      const removed = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.headers(Type),
          Request.body(Body.text),
        ),
        input,
      );
      expect(bodyFieldsOf(removed).type).toBeUndefined();
    }),
  );

  it.effect("gives a later Request.mapEffect the last word", () =>
    Effect.gen(function* () {
      const declared = yield* compile(
        post.pipe(
          Request.setHeader("content-type", "application/weird"),
          Request.body(Body.text),
          relabel,
        ),
        hello,
      );
      expect(bodyFieldsOf(declared).type).toBe("application/merge-patch+json");
      const removed = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.body(Body.text),
          relabel,
        ),
        hello,
      );
      expect(bodyFieldsOf(removed).type).toBe("application/merge-patch+json");
    }),
  );

  it.effect("replaces an earlier native edit, unless the name is removed", () =>
    Effect.gen(function* () {
      const replaced = yield* compile(
        post.pipe(relabel, Request.body(Body.text)),
        hello,
      );
      expect(bodyFieldsOf(replaced).type).toBe("text/plain");
      const kept = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          relabel,
          Request.body(Body.text),
        ),
        hello,
      );
      expect(bodyFieldsOf(kept).type).toBe("application/merge-patch+json");
    }),
  );

  it.effect("keeps a declared field on an empty body", () =>
    Effect.gen(function* () {
      for (const request of [
        Request.get("https://api.test/").pipe(
          Request.setHeader("content-type", "application/weird"),
          Request.body(Body.empty),
        ),
        Request.get("https://api.test/").pipe(
          Request.body(Body.empty),
          Request.setHeader("content-type", "application/weird"),
        ),
      ]) {
        const compiled = yield* compile(request, { body: undefined });
        expect(compiled.request.body._tag).toBe("Empty");
        expect(bodyFieldsOf(compiled)).toEqual({
          type: "application/weird",
          length: undefined,
        });
      }
    }),
  );

  it.effect("replaces the transport's multipart type with a declared one", () =>
    Effect.gen(function* () {
      const form = new FormData();
      form.append("file", "x");
      for (const request of [
        post.pipe(
          Request.setHeader("Content-Type", "multipart/form-data"),
          Request.body(Body.formData),
        ),
        post.pipe(
          Request.body(Body.formData),
          Request.setHeader("Content-Type", "multipart/form-data"),
        ),
      ]) {
        const compiled = yield* compile(request, { body: form });
        expect(compiled.request.body._tag).toBe("FormData");
        expect(compiled.headerLines).toEqual([
          ["Content-Type", "multipart/form-data"],
        ]);
      }
    }),
  );

  it.effect("leaves the request it was derived from unchanged", () =>
    Effect.gen(function* () {
      const original = post.pipe(Request.body(Body.text));
      const variant = original.pipe(Request.removeHeader("content-type"));
      expect(bodyFieldsOf(yield* compile(variant, hello)).type).toBeUndefined();
      expect(bodyFieldsOf(yield* compile(original, hello)).type).toBe(
        "text/plain",
      );
    }),
  );

  it.effect("reports the removed names in lowercase", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.removeHeader("Accept"),
          Request.removeHeader("X-Other"),
        ),
        undefined,
      );
      expect(compiled.removedHeaders).toEqual(new Set(["accept", "x-other"]));
    }),
  );

  it("carries the removed names through each stage", () => {
    expectTypeOf<Request.Compiled["removedHeaders"]>().toEqualTypeOf<
      ReadonlySet<string>
    >();
    expectTypeOf<Request.Draft["removedHeaders"]>().toEqualTypeOf<
      ReadonlySet<string>
    >();
    expectTypeOf<Request.Declaration["removedHeaders"]>().toEqualTypeOf<
      ReadonlySet<string>
    >();
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect(
    "refuses a removal after a schema that always writes the name",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(
            post.pipe(
              Request.headers(Schema.Struct({ "Content-Type": Schema.String })),
              Request.removeHeader("content-type"),
            ),
            { headers: { "Content-Type": "application/weird" } },
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect("still stops an automatic value a schema leaves alone", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        post.pipe(
          Request.body(Body.text),
          Request.headers(Schema.Struct({ "X-Trace": Schema.String })),
          Request.removeHeader("content-type"),
        ),
        { ...hello, headers: { "X-Trace": "t1" } },
      );
      expect(bodyFieldsOf(compiled)).toEqual({ type: undefined, length: "5" });
    }),
  );
});
