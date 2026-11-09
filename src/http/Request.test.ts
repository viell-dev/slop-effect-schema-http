import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";
import { HttpClientRequest, UrlParams } from "effect/http";
import { compile, urlOf } from "../../test/request.js";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";
import * as UrlEncoding from "./UrlEncoding.js";

describe("Request.make", () => {
  it.effect("keeps the method and URL", () =>
    Effect.gen(function* () {
      const { request } = yield* compile(
        Request.make("PROPFIND", "https://dav.test/files/"),
        undefined,
      );
      expect(request.method).toBe("PROPFIND");
      expect(request.url).toBe("https://dav.test/files/");
    }),
  );

  it.effect.each([
    [Request.get, "GET"],
    [Request.post, "POST"],
    [Request.put, "PUT"],
    [Request.patch, "PATCH"],
    [Request.del, "DELETE"],
    [Request.head, "HEAD"],
    [Request.options, "OPTIONS"],
  ] as const)("has a constructor for %$", ([constructor, method]) =>
    Effect.gen(function* () {
      const { request } = yield* compile(
        constructor("https://api.test/x"),
        undefined,
      );
      expect(request.method).toBe(method);
    }),
  );

  it.effect("keeps a bare key distinct from an empty value", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("https://soap.test/svc?wsdl"), undefined),
      ).toBe("https://soap.test/svc?wsdl");
      expect(
        yield* urlOf(Request.get("https://soap.test/svc?wsdl="), undefined),
      ).toBe("https://soap.test/svc?wsdl=");
    }),
  );

  it.effect("keeps repeated keys and their order", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/s?scope=a&flag&scope=b"),
          undefined,
        ),
      ).toBe("https://api.test/s?scope=a&flag&scope=b");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/93
  it.effect("keeps a fragment on the request, out of the URL text", () =>
    Effect.gen(function* () {
      const { request } = yield* compile(
        Request.get("https://api.test/page?x=1#section"),
        undefined,
      );
      expect(request.url).toBe("https://api.test/page?x=1");
      expect(request.hash).toStrictEqual(Option.some("section"));
    }),
  );

  it.effect("keeps the percent escapes of a constructor query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/s?q=a%20b&path=%2Froot&sym=%26"),
          undefined,
        ),
      ).toBe("https://api.test/s?q=a%20b&path=%2Froot&sym=%26");
    }),
  );

  // A constructor query stays as written; form decoding only names its entries.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/102
  it.effect("keeps '+' in a constructor query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("https://api.test/s?q=a+b"), undefined),
      ).toBe("https://api.test/s?q=a+b");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/102
  it.effect("keeps empty segments of a constructor query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("https://api.test/s?&a=1&&b"), undefined),
      ).toBe("https://api.test/s?&a=1&&b");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/102
  it.effect.each([
    "a=1;b=2",
    "a=b=c",
    "a=%41",
    "a=%7e",
    "a=%zz",
    "a=x%2By",
    "%71=a+b",
  ])("keeps constructor query text, case %s", (query) =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get(`https://api.test/s?${query}`), undefined),
      ).toBe(`https://api.test/s?${query}`);
    }),
  );

  it.effect("edits form-decoded query keys with the raw combinators", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/s?%71=a+b&flag").pipe(
            Request.setQuery("q", "a+b"),
          ),
          undefined,
        ),
      ).toBe("https://api.test/s?q=a%2Bb&flag");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/66
  // https://github.com/viell-dev/slop-effect-schema-http/issues/102
  it.effect.each([
    "?key=value",
    "a=1&?key=value",
    "??key",
    "a=1&?",
    "?key=",
    "%3Fkey=value",
    "a=?value",
  ])("preserves question-mark data in query case %s", (query) =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get(`https://api.test/s?${query}`), undefined),
      ).toBe(`https://api.test/s?${query}`);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/66
  it.effect.each([
    ["?key=value", "?key", "value"],
    ["??key", "??key", null],
    ["%3Fkey=value", "?key", "value"],
  ] as const)("names the question-mark entry in %s", ([query, name, value]) =>
    Effect.gen(function* () {
      const request = Request.get(`https://api.test/s?${query}&b=1`);
      expect(request.declaration.query[0]?.slice(0, 2)).toEqual([name, value]);
      expect(
        yield* urlOf(request.pipe(Request.removeQuery(name)), undefined),
      ).toBe("https://api.test/s?b=1");
    }),
  );

  it.effect("keeps opaque query text supplied by native URL preparation", () =>
    Effect.gen(function* () {
      const query = "q=a+b&&tag=%7e;item=b=c";
      expect(
        yield* urlOf(
          Request.get("svc").pipe(
            Request.baseUrl("https://api.test"),
            Request.mapEffect((native) =>
              Effect.succeed(
                HttpClientRequest.setUrl(native, `${native.url}?${query}`),
              ),
            ),
          ),
          undefined,
        ),
      ).toBe(`https://api.test/svc?${query}`);
    }),
  );
});

describe("Request.InputOf", () => {
  const Sorted = Schema.Struct({ sort: Schema.String });
  const Authorized = Schema.Struct({ authorization: Schema.String });
  const listThings = Request.get("/things").pipe(
    Request.query(Sorted),
    Request.headers(Authorized),
  );
  type ListInput = Request.InputOf<typeof listThings>;

  it("is the object a request's call takes", () => {
    expectTypeOf<ListInput>().toEqualTypeOf<
      { readonly query: { readonly sort: string } } & {
        readonly headers: { readonly authorization: string };
      }
    >();
    expectTypeOf<ListInput>().toEqualTypeOf<
      Parameters<typeof listThings.prepare>[0]
    >();
  });

  it("differs from `Request.Input`, which takes a schema", () => {
    expectTypeOf<ListInput["query"]>().toEqualTypeOf<
      Request.Input<typeof Sorted>
    >();
    // @ts-expect-error: a request is not a schema
    expectTypeOf<Request.Input<typeof listThings>>();
  });

  it("is `unknown` until a binding adds a field", () => {
    const fixed = Request.get("/things");
    expectTypeOf<Request.InputOf<typeof fixed>>().toEqualTypeOf<unknown>();
  });

  it("is `never` for anything but a request", () => {
    expectTypeOf<Request.InputOf<string>>().toEqualTypeOf<never>();
  });

  it("follows a transform that changes the input", () => {
    const mapped = listThings.pipe(
      Request.mapInput((id: number): ListInput => ({
        query: { sort: `${id}` },
        headers: { authorization: "fixed" },
      })),
    );
    expectTypeOf<Request.InputOf<typeof mapped>>().toEqualTypeOf<number>();
    const unbound = listThings.pipe(Request.unbind("headers"));
    expectTypeOf<Request.InputOf<typeof unbound>>().toEqualTypeOf<
      Omit<ListInput, "headers">
    >();
  });

  it.effect("names what `Request.mapInput` returns to fix a value", () =>
    Effect.gen(function* () {
      const withToken = listThings.pipe(
        Request.mapInput((input: Omit<ListInput, "headers">): ListInput => ({
          ...input,
          headers: { authorization: "Bearer token" },
        })),
      );
      const compiled = yield* compile(withToken, { query: { sort: "name" } });
      expect(compiled.request.url).toBe("/things?sort=name");
      expect(compiled.headerLines).toEqual([["authorization", "Bearer token"]]);
      expectTypeOf<
        keyof Request.InputOf<typeof withToken>
      >().toEqualTypeOf<"query">();
    }),
  );
});

describe("Request.mapInput", () => {
  it.effect("adapts the invocation argument, including defaults", () =>
    Effect.gen(function* () {
      const search = Request.get("https://api.test/search").pipe(
        Request.query(
          Schema.Struct({ q: Schema.String, limit: Schema.NumberFromString }),
        ),
        Request.mapInput(
          (input: { readonly q: string; readonly limit?: number }) => ({
            query: { q: input.q, limit: input.limit ?? 20 },
          }),
        ),
      );
      expect(yield* urlOf(search, { q: "x" })).toBe(
        "https://api.test/search?q=x&limit=20",
      );
      expect(yield* urlOf(search, { q: "x", limit: 5 })).toBe(
        "https://api.test/search?q=x&limit=5",
      );
    }),
  );

  it.effect("calls the adapter only when compiled", () =>
    Effect.gen(function* () {
      let calls = 0;
      const request = Request.get("https://api.test/").pipe(
        Request.mapInput((input: number) => {
          calls++;
          return input;
        }),
      );
      const compiling = compile(request, 1);
      expect(calls).toBe(0);
      yield* compiling;
      yield* compiling;
      expect(calls).toBe(2);
    }),
  );

  it.effect("makes an exception from the mapping a defect", () =>
    Effect.gen(function* () {
      const request = Request.get("https://api.test/").pipe(
        Request.mapInput((): unknown => {
          throw new Error("mapping bug");
        }),
      );
      const exit = yield* Effect.exit(compile(request, 1));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );
});

describe("Request.mapEffect", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/25
  it.effect("sees the path and separate query before final URL rendering", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly query: unknown }> = [];
      const compiled = yield* compile(
        Request.get("items").pipe(
          Request.baseUrl("https://api.test/v1"),
          Request.setQuery("wsdl", null),
          Request.setQuery("q", "a b"),
          Request.mapEffect((request) => {
            seen.push({ url: request.url, query: request.urlParams.params });
            return Effect.succeed(request);
          }),
        ),
        undefined,
      );
      expect(seen).toEqual([
        {
          url: "items",
          query: [
            ["wsdl", ""],
            ["q", "a b"],
          ],
        },
      ]);
      expect(compiled.request.url).toBe(
        "https://api.test/v1/items?wsdl&q=a%20b",
      );
      expect(compiled.request.urlParams.params).toEqual([]);
    }),
  );

  it.effect(
    "prepares the native request after the declared fields, with the input",
    () =>
      Effect.gen(function* () {
        const signed = Request.post("https://api.test/items").pipe(
          Request.body(Body.text),
          Request.mapEffect((request, input: { readonly body: string }) =>
            Effect.succeed(
              HttpClientRequest.setHeader(
                request,
                "x-signature",
                `${request.method}:${input.body}:${request.headers["content-type"]}`,
              ),
            ),
          ),
        );
        const compiled = yield* compile(signed, { body: "payload" });
        expect(compiled.request.headers["x-signature"]).toBe(
          "POST:payload:text/plain",
        );
        expect(compiled.headerLines).toContainEqual([
          "x-signature",
          "POST:payload:text/plain",
        ]);
      }),
  );

  it.effect("propagates its typed failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(
          Request.get("https://api.test/").pipe(
            Request.mapEffect(() => Effect.fail("no credential" as const)),
          ),
          undefined,
        ),
      );
      expect(error).toBe("no credential");
    }),
  );

  it.effect("keeps bare keys when native edits touch other parameters", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/s?wsdl&a=1").pipe(
            Request.mapEffect((request) =>
              Effect.succeed(
                request.pipe(
                  HttpClientRequest.appendUrlParam("sig", "abc"),
                  HttpClientRequest.setUrlParam("a", "2"),
                ),
              ),
            ),
          ),
          undefined,
        ),
      ).toBe("https://api.test/s?wsdl&sig=abc&a=2");
    }),
  );

  it.effect("honours a native edit that gives a bare key an empty value", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://soap.test/svc?wsdl").pipe(
            Request.mapEffect((request) =>
              Effect.succeed(
                HttpClientRequest.setUrlParam(request, "wsdl", ""),
              ),
            ),
          ),
          undefined,
        ),
      ).toBe("https://soap.test/svc?wsdl=");
    }),
  );

  it.effect("sends redacted native parameters unwrapped", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://legacy.test/session").pipe(
            Request.mapEffect((request) =>
              Effect.succeed(
                HttpClientRequest.setUrlParams(
                  request,
                  UrlParams.fromInput({ password: Redacted.make("s3cret") }),
                ),
              ),
            ),
          ),
          undefined,
        ),
      ).toBe("https://legacy.test/session?password=s3cret");
    }),
  );
});

/** A method-override tunnel for gateways that strip PUT and DELETE, created once. */
const tunnel = Request.mapEffect((request) =>
  Effect.succeed(
    request.pipe(
      HttpClientRequest.setHeader("x-http-method-override", request.method),
      HttpClientRequest.setMethod("POST"),
    ),
  ),
);

/** A transform that reads a string body, created once. */
const bodySize = Request.mapEffect(
  (request, input: { readonly body: string }) =>
    Effect.succeed(
      HttpClientRequest.setHeader(request, "x-size", `${input.body.length}`),
    ),
);

/** The tunnel inside a generic function, a form that must keep compiling. */
const wrapped = <I, E, R>(self: Request.Request<I, E, R>) => self.pipe(tunnel);

// https://github.com/viell-dev/slop-effect-schema-http/issues/9
describe("reusable request transforms", () => {
  it.effect(
    "applies one input-free transform to requests with and without input",
    () =>
      Effect.gen(function* () {
        const rollback = yield* compile(
          Request.del("https://api.test/items").pipe(
            Request.body(Body.text),
            tunnel,
          ),
          { body: "id=7" },
        );
        expect(rollback.request.method).toBe("POST");
        expect(rollback.request.headers["x-http-method-override"]).toBe(
          "DELETE",
        );
        expect(bodyText(rollback.request)).toBe("id=7");
        const plain = yield* compile(
          Request.put("https://api.test/items/7").pipe(tunnel),
          undefined,
        );
        expect(plain.request.headers["x-http-method-override"]).toBe("PUT");
        const viaWrapper = yield* compile(
          Request.del("https://api.test/items").pipe(
            Request.body(Body.text),
            wrapped,
          ),
          { body: "id=7" },
        );
        expect(viaWrapper.request.method).toBe("POST");
      }),
  );

  it("keeps the request's input, errors and services", () => {
    const afterBody = Request.del("/").pipe(Request.body(Body.text), tunnel);
    expectTypeOf(afterBody).toEqualTypeOf<
      Request.Request<{ readonly body: string }>
    >();
    expectTypeOf(Request.get("/").pipe(tunnel)).toEqualTypeOf<
      Request.Request<unknown>
    >();
    const bound = Request.get("/").pipe(
      Request.headers(Schema.Struct({ a: Schema.String })),
      Request.mapEffect(() => Effect.fail("refused" as const)),
    );
    expectTypeOf(bound).toEqualTypeOf<
      Request.Request<
        { readonly headers: { readonly a: string } },
        Schema.SchemaError | Request.InvalidRequest | "refused"
      >
    >();
  });

  it("infers an inline transform's input from the request", () => {
    Request.post("/").pipe(
      Request.body(Body.text),
      Request.mapEffect((request, input) => {
        expectTypeOf(input).toEqualTypeOf<{ readonly body: string }>();
        return Effect.succeed(
          HttpClientRequest.setHeader(
            request,
            "x-size",
            `${input.body.length}`,
          ),
        );
      }),
    );
  });

  it.effect(
    "applies a transform to requests whose input includes what it reads",
    () =>
      Effect.gen(function* () {
        const request = Request.post("").pipe(
          Request.path(Schema.String, (id) => `https://api.test/items/${id}`),
          Request.body(Body.text),
          bodySize,
        );
        expectTypeOf<Parameters<typeof request.prepare>[0]>().toEqualTypeOf<
          { readonly path: string } & { readonly body: string }
        >();
        const compiled = yield* compile(request, { path: "7", body: "abc" });
        expect(compiled.request.headers["x-size"]).toBe("3");
        // A request without input gains the requirement the transform reads.
        expectTypeOf(Request.get("/").pipe(bodySize)).toEqualTypeOf<
          Request.Request<{ readonly body: string }>
        >();
        Request.post("/").pipe(
          Request.body(Body.json.pipe(Body.encodeSchema(Schema.Number))),
          // @ts-expect-error: the transform reads a string body, not a number
          bodySize,
        );
      }),
  );
});

describe("Request.compile", () => {
  it.effect("adds no check of its own for a carriage return or line feed", () =>
    Effect.gen(function* () {
      const { request, headerLines } = yield* compile(
        Request.get("/a\r\nb").pipe(
          Request.setHeader("x-value", "1\r\nInjected: 2"),
          Request.setHeader("x-name\r\nInjected", "1"),
        ),
        undefined,
      );
      expect(request.url).toBe("/a\r\nb");
      expect(headerLines).toEqual([
        ["x-value", "1\r\nInjected: 2"],
        ["x-name\r\nInjected", "1"],
      ]);
    }),
  );

  it.effect("returns a request with every query entry in the URL", () =>
    Effect.gen(function* () {
      const { request } = yield* compile(
        Request.get("https://api.test/s?a=1"),
        undefined,
      );
      expect(request.urlParams.params).toEqual([]);
    }),
  );

  it.effect(
    "fails with InvalidRequest when the URL encoding service throws",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(Request.get("/x"), undefined).pipe(
            Effect.provide(
              UrlEncoding.layer({
                ...UrlEncoding.defaults,
                join: () => {
                  throw new Error("bad join");
                },
              }),
            ),
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.message).toBe("Failed to encode request URL");
      }),
  );

  it.effect("materialize returns only the native request", () =>
    Effect.gen(function* () {
      const request = yield* Request.materialize(
        Request.get("https://api.test/s?x").pipe(Request.setHeader("A", "1")),
        undefined,
      );
      expect(request.url).toBe("https://api.test/s?x");
      expect(request.headers.a).toBe("1");
    }),
  );

  it("describes the complete invocation input in its type", () => {
    const request = Request.post("/").pipe(
      Request.path(Schema.String, (id) => id),
      Request.query(Schema.Struct({ q: Schema.String })),
      Request.headers(Schema.Struct({ "X-Key": Schema.String })),
      Request.body(Body.text),
    );
    expectTypeOf<Parameters<typeof request.prepare>[0]>().toEqualTypeOf<
      unknown & { readonly path: string } & {
        readonly query: { readonly q: string };
      } & { readonly headers: { readonly "X-Key": string } } & {
        readonly body: string;
      }
    >();
    void Request.compile(
      request,
      // @ts-expect-error: the body is required
      { path: "", query: { q: "" }, headers: { "X-Key": "" } },
    );
  });
});
