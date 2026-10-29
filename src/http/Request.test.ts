import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted, Result, Schema } from "effect";
import { HttpClientRequest, UrlParams } from "effect/http";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";
import * as UrlEncoding from "./UrlEncoding.js";

/** A lone UTF-16 surrogate: a valid JavaScript string that cannot be percent-encoded. */
const loneSurrogate = String.fromCharCode(0xd800);

const compile = <I, E, R, H extends boolean, Q extends boolean>(
  request: Request.Request<I, E, R, H, Q>,
  input: I,
) => Request.compile(request, input);

const urlOf = <I, E, R, H extends boolean, Q extends boolean>(
  request: Request.Request<I, E, R, H, Q>,
  input: I,
) => Effect.map(compile(request, input), (compiled) => compiled.request.url);

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

  it.effect("discards a fragment", () =>
    Effect.gen(function* () {
      const { request } = yield* compile(
        Request.get("https://api.test/page?x=1#section"),
        undefined,
      );
      expect(request.url).toBe("https://api.test/page?x=1");
      expect(request.hash).toStrictEqual(Option.none());
    }),
  );

  it.effect("re-encodes query values with the URL encoding policy", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/s?q=a%20b&path=%2Froot&sym=%26"),
          undefined,
        ),
      ).toBe("https://api.test/s?q=a%20b&path=%2Froot&sym=%26");
    }),
  );

  // Whether a declared query should keep its original encoding is an open design question. These
  // two tests record the current parsing, not a promise.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/14
  it.effect("currently reads '+' in a declared query as a space", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("https://api.test/s?q=a+b"), undefined),
      ).toBe("https://api.test/s?q=a%20b");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/14
  it.effect("currently drops empty segments of a declared query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("https://api.test/s?&a=1&&b"), undefined),
      ).toBe("https://api.test/s?a=1&b");
    }),
  );
});

describe("Request.baseUrl", () => {
  it.effect("joins the base with a relative URL", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/users?active").pipe(
            Request.baseUrl("https://api.test/v1/"),
          ),
          undefined,
        ),
      ).toBe("https://api.test/v1/users?active");
    }),
  );

  it.effect("is replaced by a later base URL", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("users").pipe(
            Request.baseUrl("https://old.test"),
            Request.baseUrl("https://new.test/api"),
          ),
          undefined,
        ),
      ).toBe("https://new.test/api/users");
    }),
  );

  it.effect("does not apply to an absolute URL", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://legacy.test/cgi-bin/report").pipe(
            Request.baseUrl("https://api.test"),
          ),
          undefined,
        ),
      ).toBe("https://legacy.test/cgi-bin/report");
    }),
  );
});

describe("raw headers", () => {
  it.effect("setHeader replaces every line of a case-insensitive name", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.appendHeader("X-Scope", "read"),
          Request.appendHeader("x-scope", "write"),
          Request.setHeader("X-SCOPE", "admin"),
        ),
        undefined,
      );
      expect(compiled.request.headers["x-scope"]).toBe("admin");
      expect(compiled.headerLines).toEqual([["x-scope", "admin"]]);
    }),
  );

  it.effect(
    "appendHeader keeps repeated lines for providers and joins them natively",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("https://api.test/").pipe(
            Request.appendHeader("X-Scope", "read"),
            Request.setHeader("Accept", "text/xml"),
            Request.appendHeader("X-Scope", "write"),
          ),
          undefined,
        );
        expect(compiled.request.headers["x-scope"]).toBe("read, write");
        expect(compiled.headerLines).toEqual([
          ["x-scope", "read"],
          ["accept", "text/xml"],
          ["x-scope", "write"],
        ]);
      }),
  );

  it.effect(
    "removeHeader removes a name, or only its matching static lines",
    () =>
      Effect.gen(function* () {
        const base = Request.get("https://api.test/").pipe(
          Request.appendHeader("X-Scope", "read"),
          Request.appendHeader("X-Scope", "write"),
          Request.appendHeader("X-Other", "1"),
        );
        const all = yield* compile(
          base.pipe(Request.removeHeader("x-scope")),
          undefined,
        );
        expect(all.headerLines).toEqual([["x-other", "1"]]);
        const one = yield* compile(
          base.pipe(Request.removeHeader("X-SCOPE", "read")),
          undefined,
        );
        expect(one.headerLines).toEqual([
          ["x-scope", "write"],
          ["x-other", "1"],
        ]);
      }),
  );

  it.effect("evaluates computed values once per compilation", () =>
    Effect.gen(function* () {
      let token = 0;
      const request = Request.get("https://api.test/").pipe(
        Request.setHeader("Authorization", () => `Bearer t${++token}`),
      );
      expect(token).toBe(0);
      const first = yield* compile(request, undefined);
      const second = yield* compile(request, undefined);
      expect(first.request.headers.authorization).toBe("Bearer t1");
      expect(second.request.headers.authorization).toBe("Bearer t2");
      expect(token).toBe(2);
    }),
  );

  it.effect(
    "omits a computed value that is undefined instead of sending 'undefined'",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("https://api.test/").pipe(
            Request.setHeader("Authorization", () => undefined),
          ),
          undefined,
        );
        expect(compiled.request.headers.authorization).toBeUndefined();
        expect(compiled.headerLines).toEqual([]);
      }),
  );

  it.effect("fails with InvalidRequest when a computed value throws", () =>
    Effect.gen(function* () {
      const failure = new Error("credential store unavailable");
      const error = yield* Effect.flip(
        compile(
          Request.get("https://api.test/").pipe(
            Request.setHeader("Authorization", () => {
              throw failure;
            }),
          ),
          undefined,
        ),
      );
      expect(error).toBeInstanceOf(Request.InvalidRequest);
      expect(error.message).toBe("Failed to materialize request fields");
      expect(error.cause).toBe(failure);
    }),
  );
});

describe("raw query", () => {
  it.effect(
    "setQuery replaces every entry of a key at its first position",
    () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("https://api.test/s?a=1&b=2&a=3").pipe(
              Request.setQuery("a", "x"),
            ),
            undefined,
          ),
        ).toBe("https://api.test/s?a=x&b=2");
      }),
  );

  it.effect("appendQuery adds repeated entries, and null is a bare key", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/s").pipe(
            Request.appendQuery("id", "1"),
            Request.appendQuery("debug", null),
            Request.appendQuery("id", "2"),
            Request.appendQuery("empty", ""),
          ),
          undefined,
        ),
      ).toBe("https://api.test/s?id=1&debug&id=2&empty=");
    }),
  );

  it.effect(
    "removeQuery removes a key, or only its matching static entries",
    () =>
      Effect.gen(function* () {
        const base = Request.get("https://api.test/s?k&k=&k=v&j=1");
        expect(
          yield* urlOf(base.pipe(Request.removeQuery("k")), undefined),
        ).toBe("https://api.test/s?j=1");
        expect(
          yield* urlOf(base.pipe(Request.removeQuery("k", null)), undefined),
        ).toBe("https://api.test/s?k=&k=v&j=1");
        expect(
          yield* urlOf(base.pipe(Request.removeQuery("k", "")), undefined),
        ).toBe("https://api.test/s?k&k=v&j=1");
      }),
  );

  it.effect(
    "evaluates computed entries per compilation and omits undefined",
    () =>
      Effect.gen(function* () {
        let bust = 0;
        const request = Request.get("https://cdn.test/asset").pipe(
          Request.setQuery("cb", () => String(++bust)),
          Request.setQuery("absent", () => undefined),
          Request.setQuery("bare", () => null),
        );
        expect(yield* urlOf(request, undefined)).toBe(
          "https://cdn.test/asset?cb=1&bare",
        );
        expect(yield* urlOf(request, undefined)).toBe(
          "https://cdn.test/asset?cb=2&bare",
        );
      }),
  );

  it.effect(
    "fails with InvalidRequest when a value cannot be percent-encoded",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(
            Request.get("https://api.test/s").pipe(
              Request.setQuery("q", loneSurrogate),
            ),
            undefined,
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.message).toBe("Failed to encode request URL");
      }),
  );
});

describe("Request.headers", () => {
  const ApiHeaders = Schema.Struct({
    "X-Api-Key": Schema.NonEmptyString,
    "X-Scope": Schema.Array(Schema.String),
    "X-Optional": Schema.optional(Schema.String),
  });

  it.effect(
    "encodes input into ordered lines, keeping spelling and repetition",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("https://api.test/").pipe(Request.headers(ApiHeaders)),
          { headers: { "X-Api-Key": "k", "X-Scope": ["read", "write"] } },
        );
        expect(compiled.headerLines).toEqual([
          ["X-Api-Key", "k"],
          ["X-Scope", "read"],
          ["X-Scope", "write"],
        ]);
        expect(compiled.request.headers["x-scope"]).toBe("read, write");
        expect(compiled.request.headers["x-optional"]).toBeUndefined();
      }),
  );

  it.effect("replaces raw header declarations made before it", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.setHeader("X-Raw", "dropped"),
          Request.headers(ApiHeaders),
        ),
        { headers: { "X-Api-Key": "k", "X-Scope": [] } },
      );
      expect(compiled.request.headers["x-raw"]).toBeUndefined();
      expect(compiled.headerLines).toEqual([["X-Api-Key", "k"]]);
    }),
  );

  it.effect(
    "refuses invalid input before materialization with a SchemaError",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(
            Request.get("https://api.test/").pipe(Request.headers(ApiHeaders)),
            { headers: { "X-Api-Key": "", "X-Scope": [] } },
          ),
        );
        expect(Schema.isSchemaError(error)).toBe(true);
      }),
  );

  it.effect("applies the schema's encoding transformation", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.head("https://api.test/").pipe(
          Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString })),
        ),
        { headers: { "X-Page": 3 } },
      );
      expect(compiled.headerLines).toEqual([["X-Page", "3"]]);
    }),
  );

  it("removes the raw header setters from the type", () => {
    const bound = Request.get("/").pipe(Request.headers(ApiHeaders));
    // @ts-expect-error: the schema owns the header group
    bound.pipe(Request.setHeader("x", "1"));
    // @ts-expect-error: the schema owns the header group
    bound.pipe(Request.headers(ApiHeaders));
    expectTypeOf(bound.declaration.headersBound).toEqualTypeOf<true>();
  });
});

describe("Request.query", () => {
  const Search = Schema.Struct({
    q: Schema.String,
    page: Schema.optional(Schema.NumberFromString),
    tag: Schema.optional(Schema.Array(Schema.String)),
    wsdl: Schema.optional(Schema.Null),
  });

  it.effect("encodes a record into ordered entries", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/search").pipe(Request.query(Search)),
          { query: { q: "a b", page: 2, tag: ["x", "y"], wsdl: null } },
        ),
      ).toBe("https://api.test/search?q=a%20b&page=2&tag=x&tag=y&wsdl");
    }),
  );

  it.effect("omits absent optional entries", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/search").pipe(Request.query(Search)),
          { query: { q: "" } },
        ),
      ).toBe("https://api.test/search?q=");
    }),
  );

  it.effect(
    "replaces raw query declarations, including the URL's query string",
    () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("https://api.test/search?legacy=1").pipe(
              Request.setQuery("raw", "dropped"),
              Request.query(Search),
            ),
            { query: { q: "x" } },
          ),
        ).toBe("https://api.test/search?q=x");
      }),
  );

  it.effect(
    "replaces native parameters of the same key and keeps the others",
    () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("https://api.test/search").pipe(
              Request.mapEffect((request) =>
                Effect.succeed(
                  request.pipe(
                    HttpClientRequest.appendUrlParam("q", "native"),
                    HttpClientRequest.appendUrlParam("trace", "1"),
                  ),
                ),
              ),
              Request.query(Search),
            ),
            { query: { q: "schema" } },
          ),
        ).toBe("https://api.test/search?trace=1&q=schema");
      }),
  );

  it.effect("accepts ordered pairs from the schema", () =>
    Effect.gen(function* () {
      const Pairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
      expect(
        yield* urlOf(
          Request.get("https://api.test/s").pipe(Request.query(Pairs)),
          {
            query: [
              ["b", "1"],
              ["a", "2"],
              ["b", "3"],
            ],
          },
        ),
      ).toBe("https://api.test/s?b=1&a=2&b=3");
    }),
  );

  it("removes the raw query setters from the type", () => {
    const bound = Request.get("/").pipe(Request.query(Search));
    // @ts-expect-error: the schema owns the query group
    bound.pipe(Request.setQuery("x", "1"));
    expectTypeOf(bound.declaration.queryBound).toEqualTypeOf<true>();
  });
});

describe("Request.path", () => {
  const Id = Schema.String;

  it.effect("renders the schema-encoded value with the path encoder", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("ignored").pipe(
            Request.path(Id, (id, encode) => `/files/${encode(id)}/meta`),
            Request.baseUrl("https://api.test"),
          ),
          { path: "a/b c" },
        ),
      ).toBe("https://api.test/files/a%2Fb%20c/meta");
    }),
  );

  it.effect("replaces the constructor URL but keeps its query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/placeholder?format=xml").pipe(
            Request.path(
              Id,
              (id, encode) => `https://api.test/items/${encode(id)}`,
            ),
          ),
          { path: "7" },
        ),
      ).toBe("https://api.test/items/7?format=xml");
    }),
  );

  it.effect("passes encoded fields of a struct", () =>
    Effect.gen(function* () {
      const Key = Schema.Struct({
        org: Schema.String,
        n: Schema.NumberFromString,
      });
      expect(
        yield* urlOf(
          Request.get("").pipe(
            Request.path(
              Key,
              ({ org, n }, encode) => `/orgs/${encode(org)}/items/${encode(n)}`,
            ),
          ),
          { path: { org: "acme", n: 12 } },
        ),
      ).toBe("/orgs/acme/items/12");
    }),
  );

  it.effect("uses the current URL encoding service", () =>
    Effect.gen(function* () {
      const url = yield* urlOf(
        Request.get("").pipe(
          Request.path(Id, (id, encode) => `/raw/${encode(id)}`),
        ),
        { path: "a/b" },
      ).pipe(
        Effect.provide(
          UrlEncoding.layer({
            ...UrlEncoding.defaults,
            path: (value) => value,
          }),
        ),
      );
      expect(url).toBe("/raw/a/b");
    }),
  );

  it.effect(
    "joins query entries with '&' when the rendered URL already has a query",
    () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("https://api.test/").pipe(
              Request.setQuery("b", "2"),
              Request.path(Id, (id) => `https://api.test/x?a=${id}`),
            ),
            { path: "1" },
          ),
        ).toBe("https://api.test/x?a=1&b=2");
      }),
  );

  it.effect("leaves dot segments unencoded at the library boundary", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("").pipe(
            Request.path(
              Id,
              (id, encode) => `https://api.test/files/${encode(id)}`,
            ),
          ),
          { path: ".." },
        ),
      ).toBe("https://api.test/files/..");
    }),
  );

  const unencodable = Request.get("").pipe(
    Request.path(Id, (id, encode) => `https://api.test/files/${encode(id)}`),
  );

  // Known defect: the path render step is not mapped to InvalidRequest. This pins the current
  // outcome; remove it when the issue is fixed.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/5
  it.effect("currently dies when a path value cannot be percent-encoded", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        compile(unencodable, { path: loneSurrogate }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.hasFails(exit.cause)).toBe(false);
      const defect = Cause.findDefect(exit.cause);
      expect(
        Result.isSuccess(defect) ? defect.success : undefined,
      ).toBeInstanceOf(URIError);
    }),
  );

  // Known defect: the intended outcome is a typed InvalidRequest. Remove `.fails` when the issue is
  // fixed. https://github.com/viell-dev/slop-effect-schema-http/issues/5
  it.effect.fails(
    "fails with InvalidRequest when a path value cannot be percent-encoded",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          compile(unencodable, { path: loneSurrogate }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(
          Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        ).toBeInstanceOf(Request.InvalidRequest);
      }),
  );
});

/** A deliberate native relabelling of the body, reusable on any request. */
const relabel = <I, E, R, H extends boolean, Q extends boolean>(
  self: Request.Request<I, E, R, H, Q>,
) =>
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
  it.effect("encodes the body and lets the codec own Content-Type", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.post("https://api.test/items").pipe(
          Request.setHeader("Content-Type", "text/plain"),
          Request.body(Body.json),
        ),
        { body: { name: "x" } },
      );
      expect(compiled.request.headers["content-type"]).toBe("application/json");
      expect(bodyText(compiled.request)).toBe('{"name":"x"}');
      expect(compiled.headerLines).toContainEqual([
        "content-type",
        "application/json",
      ]);
      expect(compiled.headerLines).not.toContainEqual([
        "content-type",
        "text/plain",
      ]);
    }),
  );

  it.effect(
    "keeps the codec's Content-Type over a raw header declared after the body",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("https://api.test/items").pipe(
            Request.body(Body.json),
            Request.setHeader("Content-Type", "text/plain"),
          ),
          { body: { name: "x" } },
        );
        expect(compiled.request.headers["content-type"]).toBe(
          "application/json",
        );
      }),
  );

  it.effect(
    "keeps the codec's Content-Type over a header schema declared before the body",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("https://api.test/items").pipe(
            Request.headers(Schema.Struct({ "Content-Type": Schema.String })),
            Request.body(Body.json),
          ),
          { body: { name: "x" }, headers: { "Content-Type": "text/plain" } },
        );
        expect(compiled.request.headers["content-type"]).toBe(
          "application/json",
        );
        expect(compiled.headerLines).not.toContainEqual([
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
  it.effect(
    "keeps the codec's Content-Type and Content-Length when a header schema follows the body",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("https://api.test/items").pipe(
            Request.body(Body.json),
            Request.headers(Framing),
          ),
          { body: { name: "x" }, headers: framing },
        );
        expect(compiled.request.headers["content-type"]).toBe(
          "application/json",
        );
        expect(compiled.request.headers["content-length"]).toBe("12");
        expect(compiled.request.headers["x-trace"]).toBe("t1");
        expect(bodyText(compiled.request)).toBe('{"name":"x"}');
        expect(compiled.headerLines).toEqual([
          ["X-Trace", "t1"],
          ["content-type", "application/json"],
          ["content-length", "12"],
        ]);
      }),
  );

  it.effect(
    "leaves multipart framing to the transport when a header schema follows the body",
    () =>
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
        expect(compiled.request.headers["content-type"]).toBeUndefined();
        expect(compiled.request.headers["content-length"]).toBeUndefined();
        expect(compiled.headerLines).toEqual([["X-Trace", "t1"]]);
      }),
  );

  it.effect(
    "keeps a native body-header edit across a later header schema",
    () =>
      Effect.gen(function* () {
        const input = { body: { name: "x" }, headers: framing };
        // The edit survives a schema that never mentions Content-Type, and one that sets it.
        const unrelated = yield* compile(
          Request.post("https://api.test/items").pipe(
            Request.body(Body.json),
            relabel,
            Request.headers(Trace),
          ),
          { body: input.body, headers: { "X-Trace": "t1" } },
        );
        const conflicting = yield* compile(
          Request.post("https://api.test/items").pipe(
            Request.body(Body.json),
            relabel,
            Request.headers(Framing),
          ),
          input,
        );
        for (const compiled of [unrelated, conflicting]) {
          expect(compiled.request.headers["content-type"]).toBe(
            "application/merge-patch+json",
          );
          expect(compiled.headerLines).toContainEqual([
            "content-type",
            "application/merge-patch+json",
          ]);
        }
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

  it.effect(
    "lets Body.empty applied after a header schema remove its body fields",
    () =>
      Effect.gen(function* () {
        const input = { body: undefined, headers: framing };
        const emptyFirst = yield* compile(
          Request.del("https://api.test/items/1").pipe(
            Request.body(Body.empty),
            Request.headers(Framing),
          ),
          input,
        );
        expect(emptyFirst.request.headers["content-type"]).toBe("text/plain");
        const emptyLast = yield* compile(
          Request.del("https://api.test/items/1").pipe(
            Request.headers(Framing),
            Request.body(Body.empty),
          ),
          input,
        );
        expect(emptyLast.request.headers["content-type"]).toBeUndefined();
        expect(emptyLast.request.headers["content-length"]).toBeUndefined();
        expect(emptyLast.headerLines).toEqual([["X-Trace", "t1"]]);
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

  it.effect.each(["GET", "HEAD"])("rejects a body on %s", (method) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(
          Request.make(method, "https://soap.test/download").pipe(
            Request.body(Body.text),
          ),
          { body: "<Envelope/>" },
        ),
      );
      expect(error).toBeInstanceOf(Request.InvalidRequest);
      expect(error).toMatchObject({
        message: `${method} cannot carry a request body`,
      });
    }),
  );

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
});

describe("Request.mapEffect", () => {
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

/** A method-override tunnel for gateways that strip PUT and DELETE. */
const tunnel = <I, E, R, H extends boolean, Q extends boolean>(
  self: Request.Request<I, E, R, H, Q>,
) =>
  self.pipe(
    Request.mapEffect((request) =>
      Effect.succeed(
        request.pipe(
          HttpClientRequest.setHeader("x-http-method-override", request.method),
          HttpClientRequest.setMethod("POST"),
        ),
      ),
    ),
  );

describe("reusable request transforms", () => {
  it.effect("applies a reusable transform through a generic wrapper", () =>
    Effect.gen(function* () {
      const rollback = yield* compile(
        Request.del("https://api.test/items").pipe(
          Request.body(Body.text),
          tunnel,
        ),
        { body: "id=7" },
      );
      expect(rollback.request.method).toBe("POST");
      expect(rollback.request.headers["x-http-method-override"]).toBe("DELETE");
      expect(bodyText(rollback.request)).toBe("id=7");
      const plain = yield* compile(
        Request.put("https://api.test/items/7").pipe(tunnel),
        undefined,
      );
      expect(plain.request.headers["x-http-method-override"]).toBe("PUT");
    }),
  );

  it("does not yet accept an input-independent mapEffect on requests with input", () => {
    const direct = Request.mapEffect((request) =>
      Effect.succeed(HttpClientRequest.setMethod(request, "POST")),
    );
    // Known limitation. When it is fixed, this directive becomes unused and the type check fails;
    // replace it with an ordinary assertion.
    // https://github.com/viell-dev/slop-effect-schema-http/issues/9
    // @ts-expect-error: the transform's input type was fixed to `unknown` when it was created
    Request.del("/").pipe(Request.body(Body.text), direct);
  });
});

describe("Request.compile", () => {
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
