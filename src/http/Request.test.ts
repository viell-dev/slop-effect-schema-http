import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Option,
  Redacted,
  Schema,
  SchemaTransformation,
} from "effect";
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

/** A compiled request's URL text and fragment, which are separate fields. */
const targetOf = <I, E, R, H extends boolean, Q extends boolean>(
  request: Request.Request<I, E, R, H, Q>,
  input: I,
) =>
  Effect.map(compile(request, input), (compiled) => ({
    url: compiled.request.url,
    hash: Option.getOrUndefined(compiled.request.hash),
  }));

/** Read while encoding a header. */
class Tenant extends Context.Service<Tenant, string>()("test/Tenant") {}

/** A point that each of `parties` fibers passes only once all of them have reached it. */
const meeting = (parties: number) =>
  Effect.map(Deferred.make<void>(), (everyone) => {
    let arrived = 0;
    return Effect.suspend(() =>
      ++arrived === parties
        ? Deferred.succeed(everyone, undefined)
        : Effect.void,
    ).pipe(Effect.andThen(Deferred.await(everyone)));
  });

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

  // A declared URL's query is shorthand for form-decoded fields, rendered by UrlEncoding.query.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/14
  it.effect("reads '+' in a declared query as a space", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("https://api.test/s?q=a+b"), undefined),
      ).toBe("https://api.test/s?q=a%20b");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/14
  it.effect("drops empty segments of a declared query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("https://api.test/s?&a=1&&b"), undefined),
      ).toBe("https://api.test/s?a=1&b");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/14
  it.effect.each([
    ["a=1;b=2", "a=1%3Bb%3D2"],
    ["a=b=c", "a=b%3Dc"],
    ["a=%41", "a=A"],
    ["a=%7e", "a=~"],
    ["a=%zz", "a=%25zz"],
    ["a=x%2By", "a=x%2By"],
    ["%71=a+b", "q=a%20b"],
  ] as const)(
    "form-decodes and renders declared query case %$",
    ([input, output]) =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get(`https://api.test/s?${input}`), undefined),
        ).toBe(`https://api.test/s?${output}`);
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
  it.effect.each([
    ["?key=value", "%3Fkey=value"],
    ["a=1&?key=value", "a=1&%3Fkey=value"],
    ["??key", "%3F%3Fkey"],
    ["a=1&?", "a=1&%3F"],
    ["?key=", "%3Fkey="],
    ["%3Fkey=value", "%3Fkey=value"],
    ["a=?value", "a=%3Fvalue"],
  ] as const)(
    "preserves question-mark data in query case %$",
    ([input, output]) =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get(`https://api.test/s?${input}`), undefined),
        ).toBe(`https://api.test/s?${output}`);
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

// https://github.com/viell-dev/slop-effect-schema-http/issues/83
describe("fragments in the URL", () => {
  const rendered = (url: string) =>
    Request.path(Schema.String, (value) => `${url}${value}`);

  it.effect("puts the query before a fragment in path output", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("https://api.example.test/placeholder?f=xml").pipe(
            rendered("https://api.example.test/users/"),
          ),
          { path: "1#top" },
        ),
      ).toEqual({ url: "https://api.example.test/users/1?f=xml", hash: "top" });
    }),
  );

  it.effect("puts the query before a fragment in the base URL", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("").pipe(
            Request.baseUrl("https://x.test/a#top"),
            Request.setQuery("q", "1"),
          ),
          undefined,
        ),
      ).toEqual({ url: "https://x.test/a?q=1", hash: "top" });
    }),
  );

  it.effect("joins the path to a base URL that has a fragment", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/u").pipe(
            Request.baseUrl("https://x.test/a#top"),
            Request.setQuery("q", "1"),
          ),
          undefined,
        ),
      ).toEqual({ url: "https://x.test/a/u?q=1", hash: "top" });
    }),
  );

  it.effect.each([
    ["a question mark", "/a#b?c", "b?c"],
    ["a query-like text", "/a#b?c=1&d", "b?c=1&d"],
    ["another hash", "/a#b#c", "b#c"],
    ["spaces and escapes", "/a#b c%20d", "b c%20d"],
    ["nothing", "/a#", ""],
  ] as const)("keeps a fragment that contains %s", ([, url, hash]) =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("").pipe(
            Request.baseUrl("https://x.test"),
            rendered(url),
            Request.setQuery("q", "1"),
          ),
          { path: "" },
        ),
      ).toEqual({ url: "https://x.test/a?q=1", hash });
    }),
  );

  it.effect("uses '&' only for a query before the fragment", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("").pipe(
            rendered("https://x.test/a?b=1#c?d"),
            Request.setQuery("q", "1"),
          ),
          { path: "" },
        ),
      ).toEqual({ url: "https://x.test/a?b=1&q=1", hash: "c?d" });
    }),
  );

  it.effect("leaves a request with no fragment without a hash", () =>
    Effect.gen(function* () {
      const { request } = yield* compile(
        Request.get("/u").pipe(Request.baseUrl("https://x.test")),
        undefined,
      );
      expect(request.hash).toStrictEqual(Option.none());
    }),
  );

  it.effect("prefers path output to the base URL, and either to a join", () =>
    Effect.gen(function* () {
      const join = (base: string, path: string) => `${base}${path}#from-join`;
      const target = (base: string, path: string) =>
        targetOf(Request.get("").pipe(Request.baseUrl(base), rendered("")), {
          path,
        }).pipe(
          Effect.provide(UrlEncoding.layer({ ...UrlEncoding.defaults, join })),
        );
      expect(yield* target("https://x.test#base", "/a#path")).toEqual({
        url: "https://x.test/a",
        hash: "path",
      });
      expect(yield* target("https://x.test#base", "/a")).toEqual({
        url: "https://x.test/a",
        hash: "base",
      });
      expect(yield* target("https://x.test", "/a")).toEqual({
        url: "https://x.test/a",
        hash: "from-join",
      });
    }),
  );

  it.effect("prefers a native hash to any fragment in the text", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("").pipe(
            Request.baseUrl("https://x.test#base"),
            rendered("/a"),
            Request.mapEffect((request) =>
              Effect.succeed(HttpClientRequest.setHash(request, "native")),
            ),
          ),
          { path: "#path" },
        ),
      ).toEqual({ url: "https://x.test/a", hash: "native" });
    }),
  );

  it.effect("gives a custom join the base and path without fragments", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string]> = [];
      const target = yield* targetOf(
        Request.get("").pipe(
          Request.baseUrl("https://x.test/a#base"),
          rendered("/u#path"),
          Request.setQuery("q", "1"),
        ),
        { path: "" },
      ).pipe(
        Effect.provide(
          UrlEncoding.layer({
            ...UrlEncoding.defaults,
            join: (base, path) => {
              calls.push([base, path]);
              return UrlEncoding.defaults.join(base, path);
            },
          }),
        ),
      );
      expect(calls).toEqual([["https://x.test/a", "/u"]]);
      expect(target.url).toBe("https://x.test/a/u?q=1");
    }),
  );

  it.effect("places the query before a fragment a custom join returned", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/u").pipe(
            Request.baseUrl("https://x.test"),
            Request.setQuery("q", "1"),
          ),
          undefined,
        ).pipe(
          Effect.provide(
            UrlEncoding.layer({
              ...UrlEncoding.defaults,
              join: (base, path) => `${base}${path}#joined?x`,
            }),
          ),
        ),
      ).toEqual({ url: "https://x.test/u?q=1", hash: "joined?x" });
    }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/93
describe("constructor fragments", () => {
  it.effect.each([
    ["a question mark", "b?c"],
    ["a query-like text", "b?c=1&d"],
    ["another hash", "b#c"],
    ["spaces and escapes", "b c%20d"],
    ["nothing", ""],
  ] as const)("keeps a fragment that contains %s", ([, hash]) =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(Request.get(`https://x.test/a#${hash}`), undefined),
      ).toEqual({ url: "https://x.test/a", hash });
    }),
  );

  it.effect("reads a question mark after the fragment as fragment text", () =>
    Effect.gen(function* () {
      const request = Request.get("https://x.test/a#b?c=1");
      expect(request.declaration.query).toEqual([]);
      expect(
        yield* targetOf(request.pipe(Request.setQuery("q", "1")), undefined),
      ).toEqual({ url: "https://x.test/a?q=1", hash: "b?c=1" });
    }),
  );

  it.effect("survives query edits and a path binding", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("https://x.test/a?q=1#top").pipe(
            Request.setQuery("r", "2"),
            Request.path(Schema.String, (id) => `https://x.test/${id}`),
          ),
          { path: "b" },
        ),
      ).toEqual({ url: "https://x.test/b?q=1&r=2", hash: "top" });
    }),
  );

  it.effect("stays on a relative URL joined to a base", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/u?q=1#top").pipe(Request.baseUrl("https://x.test/a")),
          undefined,
        ),
      ).toEqual({ url: "https://x.test/a/u?q=1", hash: "top" });
    }),
  );

  it.effect("wins over path output and the base URL", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("#constructor").pipe(
            Request.baseUrl("https://x.test#base"),
            Request.path(Schema.String, (path) => path),
          ),
          { path: "/a#path" },
        ),
      ).toEqual({ url: "https://x.test/a", hash: "constructor" });
    }),
  );

  it.effect("counts as a fragment even when it is empty", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/a#").pipe(Request.baseUrl("https://x.test#base")),
          undefined,
        ),
      ).toEqual({ url: "https://x.test/a", hash: "" });
    }),
  );

  it.effect("is visible to Request.mapEffect, which can remove it", () =>
    Effect.gen(function* () {
      const seen: Array<Option.Option<string>> = [];
      expect(
        yield* targetOf(
          Request.get("https://x.test/a#top").pipe(
            Request.mapEffect((request) => {
              seen.push(request.hash);
              return Effect.succeed(HttpClientRequest.removeHash(request));
            }),
          ),
          undefined,
        ),
      ).toEqual({ url: "https://x.test/a", hash: undefined });
      expect(seen).toStrictEqual([Option.some("top")]);
    }),
  );

  it("records the fragment on the declaration", () => {
    expectTypeOf(Request.get("/").declaration.hash).toEqualTypeOf<
      string | undefined
    >();
    expect(Request.get("/a#b?c").declaration.hash).toBe("b?c");
    expect(Request.get("/a#").declaration.hash).toBe("");
    expect(Request.get("/a").declaration.hash).toBeUndefined();
  });
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
      expect(compiled.headerLines).toEqual([["X-SCOPE", "admin"]]);
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
          ["X-Scope", "read"],
          ["Accept", "text/xml"],
          ["X-Scope", "write"],
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
        expect(all.headerLines).toEqual([["X-Other", "1"]]);
        const one = yield* compile(
          base.pipe(Request.removeHeader("X-SCOPE", "read")),
          undefined,
        );
        expect(one.headerLines).toEqual([
          ["X-Scope", "write"],
          ["X-Other", "1"],
        ]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("keeps each line of a repeated name in its own spelling", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.appendHeader("X-Tag", "a"),
          Request.appendHeader("x-tag", "b"),
          Request.appendHeader("X-TAG", "c"),
        ),
        undefined,
      );
      expect(compiled.headerLines).toEqual([
        ["X-Tag", "a"],
        ["x-tag", "b"],
        ["X-TAG", "c"],
      ]);
      expect(compiled.request.headers["x-tag"]).toBe("a, b, c");
      expect(compiled.request.headers["X-Tag"]).toBeUndefined();
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("replaces at the first position and takes the new spelling", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.appendHeader("x-thing", "old"),
          Request.setHeader("X-Kept", "k"),
          Request.appendHeader("X-THING", "older"),
          Request.setHeader("X-Thing", "new"),
        ),
        undefined,
      );
      expect(compiled.headerLines).toEqual([
        ["X-Thing", "new"],
        ["X-Kept", "k"],
      ]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("removes across spellings, with or without a value", () =>
    Effect.gen(function* () {
      const base = Request.get("https://api.test/").pipe(
        Request.appendHeader("X-Tag", "a"),
        Request.appendHeader("x-tag", "b"),
        Request.appendHeader("X-TAG", "a"),
      );
      const all = yield* compile(
        base.pipe(Request.removeHeader("x-TaG")),
        undefined,
      );
      expect(all.headerLines).toEqual([]);
      const value = yield* compile(
        base.pipe(Request.removeHeader("x-TaG", "a")),
        undefined,
      );
      expect(value.headerLines).toEqual([["x-tag", "b"]]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("keeps a spelling through a computed value", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.setHeader("X-API-Key", () => "k"),
        ),
        undefined,
      );
      expect(compiled.headerLines).toEqual([["X-API-Key", "k"]]);
      expect(compiled.request.headers["x-api-key"]).toBe("k");
    }),
  );

  it("records the spelling on the declaration", () => {
    expect(
      Request.get("/").pipe(Request.setHeader("X-Thing", "1")).declaration
        .headers,
    ).toEqual([["X-Thing", "1"]]);
  });

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

  it("requires a schema whose encoded side is header fields", () => {
    const NumericPage = Schema.Struct({ "X-Page": Schema.Number });
    // @ts-expect-error: a plain string is not a set of header fields
    Request.headers(Schema.String);
    // @ts-expect-error: header values encode to strings, not numbers
    Request.headers(NumericPage);
    Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString }));
  });

  it("takes the schema's application type as input, not its encoded type", () => {
    const paged = Request.get("/").pipe(
      Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString })),
    );
    void Request.compile(paged, { headers: { "X-Page": 3 } });
    // @ts-expect-error: the input is the application value, a number
    void Request.compile(paged, { headers: { "X-Page": "3" } });
  });

  it.effect(
    "encodes through an effectful schema without sharing state between compilations",
    () =>
      Effect.gen(function* () {
        // Both compilations meet while encoding, and again between encoding and the header merge,
        // so each step runs with the other compilation in flight.
        const encoding = yield* meeting(2);
        const merging = yield* meeting(2);
        const Signed = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (wire: string) => Effect.succeed(wire),
              encode: (value: string) =>
                Effect.gen(function* () {
                  const tenant = yield* Tenant;
                  yield* encoding;
                  return `${tenant}:${value}`;
                }),
            }),
          ),
        );
        const request = Request.get("https://api.test/").pipe(
          Request.mapEffect((native) => Effect.as(merging, native)),
          Request.headers(Schema.Struct({ "X-Signed": Signed })),
        );
        const compiling = (value: string) =>
          compile(request, { headers: { "X-Signed": value } });
        expectTypeOf<
          Effect.Services<ReturnType<typeof compiling>>
        >().toEqualTypeOf<Tenant>();
        const [a, b] = yield* Effect.all([compiling("a"), compiling("b")], {
          concurrency: "unbounded",
        }).pipe(Effect.provideService(Tenant, "t1"));
        expect(a.headerLines).toEqual([["X-Signed", "t1:a"]]);
        expect(a.request.headers["x-signed"]).toBe("t1:a");
        expect(b.headerLines).toEqual([["X-Signed", "t1:b"]]);
        expect(b.request.headers["x-signed"]).toBe("t1:b");
      }),
  );
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

  it("requires a schema whose encoded side is flat query entries", () => {
    const Nested = Schema.Struct({
      filter: Schema.Struct({ owner: Schema.String }),
    });
    // @ts-expect-error: a nested struct has no query representation
    Request.query(Nested);
    Request.query(
      Schema.Struct({ page: Schema.Number, tag: Schema.Array(Schema.String) }),
    );
  });

  it("takes the schema's application type as input, not its encoded type", () => {
    const paged = Request.get("/").pipe(
      Request.query(Schema.Struct({ page: Schema.NumberFromString })),
    );
    void Request.compile(paged, { query: { page: 2 } });
    // @ts-expect-error: the input is the application value, a number
    void Request.compile(paged, { query: { page: "2" } });
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

  it("renders the schema's encoded value, not its application value", () => {
    Request.path(Schema.NumberFromString, (page: string, encode) =>
      encode(page),
    );
    // @ts-expect-error: render receives the encoded string
    Request.path(Schema.NumberFromString, (page: number) => String(page));
  });

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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/5
  it.effect(
    "fails with InvalidRequest when a path value cannot be percent-encoded",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          compile(unencodable, { path: loneSurrogate }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(Cause.hasDies(exit.cause)).toBe(false);
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(
          error instanceof Request.InvalidRequest ? error.cause : undefined,
        ).toBeInstanceOf(URIError);
      }),
  );

  it.effect(
    "fails with InvalidRequest when a replaced path encoder throws",
    () =>
      Effect.gen(function* () {
        const refused = new Error("segment refused");
        const error = yield* Effect.flip(
          compile(unencodable, { path: ".." }).pipe(
            Effect.provide(
              UrlEncoding.layer({
                ...UrlEncoding.defaults,
                path: () => {
                  throw refused;
                },
              }),
            ),
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(
          error instanceof Request.InvalidRequest ? error.cause : undefined,
        ).toBe(refused);
      }),
  );

  it("adds InvalidRequest to the request's error type", () => {
    expectTypeOf<
      Effect.Error<ReturnType<typeof unencodable.prepare>>
    >().toEqualTypeOf<Schema.SchemaError | Request.InvalidRequest>();
  });
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
  type Edit = <I, E, R, Q extends boolean>(
    self: Request.Request<I, E, R, false, Q>,
  ) => Request.Request<I, E, R, false, Q>;

  const post = Request.post("https://api.test/items");
  const hello = { body: "hello" };
  const fields = ({ request }: Request.Compiled) => ({
    type: request.headers["content-type"],
    length: request.headers["content-length"],
  });
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
      expect(fields(compiled)).toEqual({ type: "text/plain", length: "5" });
    }),
  );

  it.effect("lets a declared Content-Type win in either order", () =>
    Effect.gen(function* () {
      for (const request of eitherOrder(
        Request.setHeader("content-type", "application/weird"),
      )) {
        const compiled = yield* compile(request, hello);
        expect(fields(compiled)).toEqual({
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
        expect(fields(compiled)).toEqual({ type: "text/plain", length: "3" });
      }
    }),
  );

  it.effect("lets an empty declared value win", () =>
    Effect.gen(function* () {
      for (const request of eitherOrder(
        Request.setHeader("content-type", ""),
      )) {
        const compiled = yield* compile(request, hello);
        expect(fields(compiled)).toEqual({ type: "", length: "5" });
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
      expect(fields(compiled).type).toBe("computed-1");
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
      expect(fields(compiled).type).toBe("a, b");
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
        expect(fields(compiled)).toEqual({ type: undefined, length: "5" });
        expect(compiled.headerLines).toEqual([["content-length", "5"]]);
      }
      for (const request of eitherOrder(
        Request.removeHeader("content-length"),
      )) {
        const compiled = yield* compile(request, hello);
        expect(fields(compiled)).toEqual({
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
      expect(fields(compiled).type).toBeUndefined();
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
      expect(fields(compiled).type).toBe("text/plain");
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
      expect(fields(compiled).type).toBeUndefined();
    }),
  );

  it.effect("ends a removal with a later declaration", () =>
    Effect.gen(function* () {
      const set = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.setHeader("Content-Type", "application/weird"),
          Request.body(Body.text),
        ),
        hello,
      );
      expect(fields(set).type).toBe("application/weird");
      const appended = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.body(Body.text),
          Request.appendHeader("Content-Type", "application/weird"),
        ),
        hello,
      );
      expect(fields(appended).type).toBe("application/weird");
      expect(appended.removedHeaders).toEqual(new Set());
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
      expect(fields(compiled).type).toBe("text/plain");
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
        expect(fields(compiled).type).toBe("application/weird");
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
        expect(fields(compiled)).toEqual({ type: "text/plain", length: "5" });
      }
      const removed = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.headers(Type),
          Request.body(Body.text),
        ),
        input,
      );
      expect(fields(removed).type).toBeUndefined();
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
      expect(fields(declared).type).toBe("application/merge-patch+json");
      const removed = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          Request.body(Body.text),
          relabel,
        ),
        hello,
      );
      expect(fields(removed).type).toBe("application/merge-patch+json");
    }),
  );

  it.effect("replaces an earlier native edit, unless the name is removed", () =>
    Effect.gen(function* () {
      const replaced = yield* compile(
        post.pipe(relabel, Request.body(Body.text)),
        hello,
      );
      expect(fields(replaced).type).toBe("text/plain");
      const kept = yield* compile(
        post.pipe(
          Request.removeHeader("content-type"),
          relabel,
          Request.body(Body.text),
        ),
        hello,
      );
      expect(fields(kept).type).toBe("application/merge-patch+json");
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
        expect(fields(compiled)).toEqual({
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
      expect(fields(yield* compile(variant, hello)).type).toBeUndefined();
      expect(fields(yield* compile(original, hello)).type).toBe("text/plain");
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

  it("keeps removeHeader out of the type once a schema owns the group", () => {
    const bound = post.pipe(
      Request.headers(Schema.Struct({ "Content-Type": Schema.String })),
    );
    // @ts-expect-error: the schema owns the header group
    bound.pipe(Request.removeHeader("content-type"));
  });
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
const wrapped = <I, E, R, H extends boolean, Q extends boolean>(
  self: Request.Request<I, E, R, H, Q>,
) => self.pipe(tunnel);

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

  it("keeps the request's input, errors, services and binding flags", () => {
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
        Schema.SchemaError | "refused",
        never,
        true,
        false
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
