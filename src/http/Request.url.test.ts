import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  Data,
  Effect,
  Exit,
  flow,
  Option,
  Schema,
} from "effect";
import { HttpClientRequest } from "effect/http";
import {
  compile,
  loneSurrogate,
  refusal,
  rendered,
  targetOf,
  urlOf,
} from "../../test/request.js";
import * as Request from "./Request.js";
import * as UrlEncoding from "./UrlEncoding.js";

/** The target of a request under a join that adds a fragment of its own. */
const joinedTarget = (base: string, path: string) =>
  targetOf(Request.get("").pipe(Request.baseUrl(base), rendered("")), {
    path,
  }).pipe(
    Effect.provide(
      UrlEncoding.layer({
        ...UrlEncoding.defaults,
        join: (start, end) => `${start}${end}#from-join`,
      }),
    ),
  );

/** A policy that records each query call and marks the text it renders. */
const recording = () => {
  const calls: Array<UrlEncoding.Query> = [];
  return {
    calls,
    layer: UrlEncoding.layer({
      ...UrlEncoding.defaults,
      query: (entries) => {
        calls.push(entries);
        return entries
          .map(([key, value]) => `custom-${key}=${value}`)
          .join("&");
      },
    }),
  };
};

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

  // A later call replaces the base, so a relative one cannot extend it. `mapBaseUrl` does that.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/81
  it.effect("loses the origin when a relative base replaces it", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/users").pipe(
            Request.baseUrl("https://api.test"),
            Request.baseUrl("/api/v1"),
          ),
          undefined,
        ),
      ).toBe("/api/v1/users");
    }),
  );
});

/** Supplies the location of an API once the program runs. */
class ApiBase extends Context.Service<ApiBase, string>()("test/ApiBase") {}

class BaseUnavailable extends Data.TaggedError("BaseUnavailable") {}

const inEurope = Effect.provideService(ApiBase, "https://eu.test");

/** Supply configuration from a plain object. */
const configured = (root: unknown) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(root),
  );

/** A request with a query, under a base in either form. */
const withBase = (base: string | Effect.Effect<string>) =>
  Request.get("/things").pipe(
    Request.setQuery("q", "1"),
    Request.baseUrl(base),
  );

const toAdmin = (url: string) => `${url}/admin`;

const toV2 = (url: string) => url.replace(/\/v1$/, "/v2");

/** A base that counts how often it runs. */
const counted = (url: string) => {
  const base = {
    runs: 0,
    effect: Effect.sync(() => {
      base.runs++;
      return url;
    }),
  };
  return base;
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/89
describe("a base URL from an Effect", () => {
  const discovered = Effect.gen(function* () {
    const base = yield* ApiBase;
    return `${base}/v1`;
  });

  it.effect("joins what a service supplies", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(Request.baseUrl(discovered));
      expect(yield* urlOf(request, undefined).pipe(inEurope)).toBe(
        "https://eu.test/v1/things",
      );
    }),
  );

  it.effect("takes a service or a Config value, as both are Effects", () =>
    Effect.gen(function* () {
      const fromService = Request.get("/things").pipe(Request.baseUrl(ApiBase));
      expect(yield* urlOf(fromService, undefined).pipe(inEurope)).toBe(
        "https://eu.test/things",
      );

      const fromConfig = Request.get("/things").pipe(
        Request.baseUrl(Config.String("API_BASE")),
      );
      expect(
        yield* urlOf(fromConfig, undefined).pipe(
          configured({ API_BASE: "https://config.test" }),
        ),
      ).toBe("https://config.test/things");
      const error = yield* Effect.flip(
        urlOf(fromConfig, undefined).pipe(configured({})),
      );
      expect(error).toBeInstanceOf(Config.ConfigError);
    }),
  );

  it.effect("runs once per evaluation, and not when it is defined", () =>
    Effect.gen(function* () {
      const base = counted("https://x.test");
      const request = Request.get("/things").pipe(Request.baseUrl(base.effect));
      expect(base.runs).toBe(0);
      yield* urlOf(request, undefined);
      expect(base.runs).toBe(1);
      yield* urlOf(request, undefined);
      expect(base.runs).toBe(2);
    }),
  );

  it.effect("runs after computed fields and the other preparation steps", () =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const request = Request.get("/things").pipe(
        Request.baseUrl(
          Effect.sync(() => {
            order.push("base");
            return "https://x.test";
          }),
        ),
        Request.setHeader("x-computed", () => {
          order.push("computed");
          return "1";
        }),
        Request.mapEffect((native) =>
          Effect.sync(() => {
            order.push("edit");
            return native;
          }),
        ),
      );
      yield* urlOf(request, undefined);
      expect(order).toEqual(["computed", "edit", "base"]);
    }),
  );

  it.effect("does not run when the input is refused", () =>
    Effect.gen(function* () {
      const base = counted("https://x.test");
      const request = Request.get("/things").pipe(
        Request.baseUrl(base.effect),
        Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
      );
      const error = yield* Effect.flip(
        urlOf(request, { query: { page: "many" } }),
      );
      expect(error._tag).toBe("SchemaError");
      expect(base.runs).toBe(0);
    }),
  );

  it.effect("fails with its own failure, not an InvalidRequest", () =>
    Effect.gen(function* () {
      const failure = new BaseUnavailable();
      const request = Request.get("/things").pipe(
        Request.baseUrl(Effect.fail(failure)),
      );
      expect(yield* Effect.flip(urlOf(request, undefined))).toBe(failure);
    }),
  );

  it.effect("keeps a defect a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        urlOf(
          Request.get("/things").pipe(Request.baseUrl(Effect.die("broken"))),
          undefined,
        ),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect("treats what it supplies exactly as text", () =>
    Effect.gen(function* () {
      for (const base of [
        "https://x.test",
        "https://x.test/v1/",
        "https://x.test/v1#top",
        "https://x.test/v1?key=abc",
        "https://x.test/a b",
        "/shared",
        "",
      ])
        expect(
          yield* targetOf(withBase(Effect.succeed(base)), undefined),
        ).toEqual(yield* targetOf(withBase(base), undefined));
    }),
  );

  it.effect("moves a fragment to the request, with the query before it", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(
        Request.baseUrl(Effect.succeed("https://x.test/v1#top")),
        Request.setQuery("q", "1"),
      );
      expect(yield* targetOf(request, undefined)).toEqual({
        url: "https://x.test/v1/things?q=1",
        hash: "top",
      });
    }),
  );

  it.effect("leaves a query in the base where the join puts it", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(
        Request.baseUrl(Effect.succeed("https://x.test/v1?key=abc")),
        Request.setQuery("q", "1"),
      );
      expect(yield* urlOf(request, undefined)).toBe(
        "https://x.test/v1?key=abc/things&q=1",
      );
    }),
  );

  it.effect("goes through a replaced UrlEncoding.join", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(
        Request.baseUrl(Effect.succeed("https://x.test")),
      );
      expect(
        yield* urlOf(request, undefined).pipe(
          Effect.provide(
            UrlEncoding.layer({
              ...UrlEncoding.defaults,
              join: (base, path) => `${base}/joined${path}`,
            }),
          ),
        ),
      ).toBe("https://x.test/joined/things");
    }),
  );

  // The join decides whether a base applies, so it has to receive one.
  it.effect("still runs under an absolute URL, which bypasses it", () =>
    Effect.gen(function* () {
      const absolute = Request.get("https://legacy.test/report");
      const base = counted("https://x.test");
      expect(
        yield* urlOf(absolute.pipe(Request.baseUrl(base.effect)), undefined),
      ).toBe("https://legacy.test/report");
      expect(base.runs).toBe(1);
      const error = yield* Effect.flip(
        urlOf(
          absolute.pipe(Request.baseUrl(Effect.fail(new BaseUnavailable()))),
          undefined,
        ),
      );
      expect(error._tag).toBe("BaseUnavailable");
    }),
  );

  it.effect("never runs once a later base replaces it", () =>
    Effect.gen(function* () {
      const base = counted("https://old.test");
      const request = Request.get("/things").pipe(
        Request.baseUrl(base.effect),
        Request.baseUrl("https://new.test"),
      );
      expect(yield* urlOf(request, undefined)).toBe("https://new.test/things");
      expect(base.runs).toBe(0);
      expect(
        yield* urlOf(
          Request.get("/things").pipe(
            Request.baseUrl("https://old.test"),
            Request.baseUrl(Effect.succeed("https://new.test")),
          ),
          undefined,
        ),
      ).toBe("https://new.test/things");
    }),
  );

  it.effect("survives later edits to the request", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(
        Request.baseUrl(ApiBase),
        Request.setQuery("a", "1"),
        Request.setPath("/items"),
        Request.path`/more`,
        Request.mapInput<unknown, "input">(() => undefined),
      );
      expect(yield* urlOf(request, "input").pipe(inEurope)).toBe(
        "https://eu.test/items/more?a=1",
      );
    }),
  );

  it("adds its failures and services to the request's type", () => {
    const start = Request.get("/");
    expectTypeOf(start.pipe(Request.baseUrl("https://x.test"))).toEqualTypeOf<
      Request.Request<unknown>
    >();
    expectTypeOf(start.pipe(Request.baseUrl(ApiBase))).toEqualTypeOf<
      Request.Request<unknown, never, ApiBase>
    >();
    expectTypeOf(
      start.pipe(Request.baseUrl(Effect.fail(new BaseUnavailable()))),
    ).toEqualTypeOf<Request.Request<unknown, BaseUnavailable>>();
    expectTypeOf(
      start.pipe(Request.baseUrl(Config.String("API_BASE"))),
    ).toEqualTypeOf<Request.Request<unknown, Config.ConfigError>>();
    expectTypeOf(
      Request.get("/").pipe(
        Request.query(Schema.Struct({ page: Schema.String })),
        Request.baseUrl(ApiBase),
      ),
    ).toEqualTypeOf<
      Request.Request<
        { readonly query: { readonly page: string } },
        Schema.SchemaError | Request.InvalidRequest,
        ApiBase
      >
    >();
  });

  it("keeps what a replaced base added, as the types cannot forget it", () => {
    expectTypeOf(
      Request.get("/").pipe(
        Request.baseUrl(ApiBase),
        Request.baseUrl("https://x.test"),
      ),
    ).toEqualTypeOf<Request.Request<unknown, never, ApiBase>>();
  });

  it("is a compile error to leave out the service", () => {
    const request = Request.get("/").pipe(Request.baseUrl(ApiBase));
    // @ts-expect-error: nothing has provided `ApiBase`
    const unprovided: Effect.Effect<unknown, unknown> = Request.compile(
      request,
      undefined,
    );
    const provided: Effect.Effect<unknown, unknown> = Request.compile(
      request,
      undefined,
    ).pipe(inEurope);
    void [unprovided, provided];
  });

  it("composes in a shared transform", () => {
    const shared = flow(
      Request.setHeader("accept-language", "en"),
      Request.baseUrl(ApiBase),
    );
    expectTypeOf(Request.get("/").pipe(shared)).toEqualTypeOf<
      Request.Request<unknown, never, ApiBase>
    >();
  });

  it("takes only text or an Effect of text", () => {
    // @ts-expect-error: a plain function says what `Effect.sync` already says
    void Request.baseUrl(() => "https://x.test");
    // @ts-expect-error: a base URL is text
    void Request.baseUrl(Effect.succeed(1));
    expectTypeOf<Request.Declaration["baseUrl"]>().toEqualTypeOf<
      string | Effect.Effect<string, unknown, unknown>
    >();
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/81
describe("Request.mapBaseUrl", () => {
  const api = Request.baseUrl("https://api.test/v1");
  const admin = Request.mapBaseUrl(toAdmin);

  it.effect("extends a text base", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("/users").pipe(api, admin), undefined),
      ).toBe("https://api.test/v1/admin/users");
    }),
  );

  it.effect("extends a base from an Effect, keeping what that needs", () =>
    Effect.gen(function* () {
      const request = Request.get("/users").pipe(
        Request.baseUrl(ApiBase),
        admin,
      );
      expect(yield* urlOf(request, undefined).pipe(inEurope)).toBe(
        "https://eu.test/admin/users",
      );
    }),
  );

  it.effect("changes a prefix rather than extending it", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/users").pipe(api, Request.mapBaseUrl(toV2)),
          undefined,
        ),
      ).toBe("https://api.test/v2/users");
    }),
  );

  it.effect("stacks, each call seeing what the last one made", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/users").pipe(
            api,
            admin,
            Request.mapBaseUrl((url) => `${url}/eu`),
          ),
          undefined,
        ),
      ).toBe("https://api.test/v1/admin/eu/users");
    }),
  );

  it.effect("leaves the request it came from alone", () =>
    Effect.gen(function* () {
      const users = Request.get("/users").pipe(api);
      const adminUsers = users.pipe(admin);
      expect(yield* urlOf(adminUsers, undefined)).toBe(
        "https://api.test/v1/admin/users",
      );
      expect(yield* urlOf(users, undefined)).toBe("https://api.test/v1/users");
      expect(users.declaration.baseUrl).toBe("https://api.test/v1");
    }),
  );

  it("leaves an Effect on the declaration, so reading it cannot extend a base", () => {
    const users = Request.get("/users").pipe(api, admin);
    expect(Effect.isEffect(users.declaration.baseUrl)).toBe(true);
  });

  it.effect("is replaced by a later base URL", () =>
    Effect.gen(function* () {
      let calls = 0;
      const request = Request.get("/users").pipe(
        api,
        Request.mapBaseUrl((url) => {
          calls++;
          return `${url}/admin`;
        }),
        Request.baseUrl("https://new.test"),
      );
      expect(yield* urlOf(request, undefined)).toBe("https://new.test/users");
      expect(calls).toBe(0);
    }),
  );

  it.effect("starts from nothing when no base is set", () =>
    Effect.gen(function* () {
      expect(yield* urlOf(Request.get("/users").pipe(admin), undefined)).toBe(
        "/admin/users",
      );
    }),
  );

  it.effect("runs its function once per evaluation, whichever the form", () =>
    Effect.gen(function* () {
      for (const base of ["https://x.test", Effect.succeed("https://x.test")]) {
        let calls = 0;
        const request = Request.get("/users").pipe(
          Request.baseUrl(base),
          Request.mapBaseUrl((url) => {
            calls++;
            return url;
          }),
        );
        expect(calls).toBe(0);
        yield* urlOf(request, undefined);
        yield* urlOf(request, undefined);
        expect(calls).toBe(2);
      }
    }),
  );

  it.effect("makes an exception an InvalidRequest, whichever the form", () =>
    Effect.gen(function* () {
      const cause = new Error("no prefix to change");
      const broken = Request.mapBaseUrl(() => {
        throw cause;
      });
      for (const base of ["https://x.test", Effect.succeed("https://x.test")]) {
        const error = yield* refusal(
          Request.get("/users").pipe(Request.baseUrl(base), broken),
          undefined,
        );
        expect(error.cause).toBe(cause);
      }
    }),
  );

  it.effect("does not run its function when the base fails", () =>
    Effect.gen(function* () {
      let calls = 0;
      const failure = new BaseUnavailable();
      const request = Request.get("/users").pipe(
        Request.baseUrl(Effect.fail(failure)),
        Request.mapBaseUrl((url) => {
          calls++;
          return url;
        }),
      );
      expect(yield* Effect.flip(urlOf(request, undefined))).toBe(failure);
      expect(calls).toBe(0);
    }),
  );

  it.effect("receives the whole text, including a fragment or query", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const request = Request.get("/users").pipe(
        Request.baseUrl("https://x.test/v1?key=abc#top"),
        Request.mapBaseUrl((url) => {
          seen.push(url);
          return `${url}/admin`;
        }),
      );
      // A fragment ends a URL, so text added after one stays in the fragment.
      expect(yield* targetOf(request, undefined)).toEqual({
        url: "https://x.test/v1?key=abc/users",
        hash: "top/admin",
      });
      expect(seen).toEqual(["https://x.test/v1?key=abc#top"]);
    }),
  );

  it.effect("goes through a replaced UrlEncoding.join", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("/users").pipe(api, admin), undefined).pipe(
          Effect.provide(
            UrlEncoding.layer({
              ...UrlEncoding.defaults,
              join: (base, path) => `${base}|${path}`,
            }),
          ),
        ),
      ).toBe("https://api.test/v1/admin|/users");
    }),
  );

  it("keeps the request's type", () => {
    expectTypeOf(Request.get("/").pipe(api, admin)).toEqualTypeOf<
      Request.Request<unknown>
    >();
    expectTypeOf(
      Request.get("/").pipe(Request.baseUrl(ApiBase), admin),
    ).toEqualTypeOf<Request.Request<unknown, never, ApiBase>>();
    // @ts-expect-error: a base URL is text
    void Request.mapBaseUrl((url) => url.length);
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/102
describe("constructor query text", () => {
  it.effect.each([
    "/x?a=1;b=2",
    "/x?a=1&&b=2",
    "/x?",
    "/x?q=a+b",
    "/x?a=%41&wsdl",
  ])("passes on %s as written", (url) =>
    Effect.gen(function* () {
      expect(yield* urlOf(Request.get(url), undefined)).toBe(url);
    }),
  );

  it.effect("re-renders only the entry an edit touched", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41&b=1;2").pipe(
            Request.setQuery("a", "new value"),
          ),
          undefined,
        ),
      ).toBe("/x?a=new%20value&b=1;2");
    }),
  );

  it.effect("lets an added field replace a lone '?'", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?").pipe(Request.setQuery("b", "1")),
          undefined,
        ),
      ).toBe("/x?b=1");
    }),
  );

  it.effect("keeps a written empty segment when a field is added", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=1&").pipe(Request.setQuery("b", "1")),
          undefined,
        ),
      ).toBe("/x?a=1&&b=1");
    }),
  );

  it.effect.each(["/x?&", "/x?a=1&", "/x?&a=1", "/x?&&", "/x?=", "/x?=&="])(
    "keeps the empty parts of %s",
    (url) =>
      Effect.gen(function* () {
        expect(yield* urlOf(Request.get(url), undefined)).toBe(url);
      }),
  );

  it.effect("keeps text the default policy would have escaped", () =>
    Effect.gen(function* () {
      const url = "/x?q=a b&n=\u00e4&s=" + loneSurrogate;
      expect(yield* urlOf(Request.get(url), undefined)).toBe(url);
    }),
  );

  it.effect("keeps a '?' after the first as text", () =>
    Effect.gen(function* () {
      expect(yield* urlOf(Request.get("/x?a?b=c?d"), undefined)).toBe(
        "/x?a?b=c?d",
      );
    }),
  );

  it.effect("adds entries after the written text, in order", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41&a=b+c").pipe(
            Request.appendQuery("a", "d e"),
            Request.appendQuery("f", null),
          ),
          undefined,
        ),
      ).toBe("/x?a=%41&a=b+c&a=d%20e&f");
    }),
  );

  it.effect("replaces every written entry of a name at the first", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41&b=c+d&a=e;f").pipe(Request.setQuery("a", "g")),
          undefined,
        ),
      ).toBe("/x?a=g&b=c+d");
    }),
  );

  it.effect("addresses an entry by its decoded name and value", () =>
    Effect.gen(function* () {
      const request = Request.get("/x?%71=a+b&q=c&r=a%20b");
      expect(
        yield* urlOf(request.pipe(Request.removeQuery("q", "a b")), undefined),
      ).toBe("/x?q=c&r=a%20b");
      expect(
        yield* urlOf(request.pipe(Request.removeQuery("q")), undefined),
      ).toBe("/x?r=a%20b");
      expect(
        yield* urlOf(request.pipe(Request.setQuery("r", "a b")), undefined),
      ).toBe("/x?%71=a+b&q=c&r=a%20b");
    }),
  );

  it.effect("removes an entry and keeps the text around it", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41&b=2;3&c=%43").pipe(Request.removeQuery("b")),
          undefined,
        ),
      ).toBe("/x?a=%41&c=%43");
    }),
  );

  it.effect("removes every written entry, leaving no '?'", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41").pipe(Request.removeQuery("a")),
          undefined,
        ),
      ).toBe("/x");
    }),
  );

  it.effect("names an empty segment with the empty string", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=1&&b=2").pipe(Request.removeQuery("")),
          undefined,
        ),
      ).toBe("/x?a=1&b=2");
    }),
  );

  it.effect("evaluates a computed value that replaces written text", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41&b=c+d").pipe(
            Request.setQuery("a", () => "e f"),
          ),
          undefined,
        ),
      ).toBe("/x?a=e%20f&b=c+d");
    }),
  );

  it.effect("omits an edited entry whose computed value is undefined", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41&b=c+d").pipe(
            Request.setQuery("a", () => undefined),
          ),
          undefined,
        ),
      ).toBe("/x?b=c+d");
    }),
  );

  it.effect("leaves the request it was derived from unchanged", () =>
    Effect.gen(function* () {
      const original = Request.get("/x?a=%41");
      const variant = original.pipe(Request.setQuery("a", "b"));
      expect(yield* urlOf(variant, undefined)).toBe("/x?a=b");
      expect(yield* urlOf(original, undefined)).toBe("/x?a=%41");
      expect(yield* urlOf(original, undefined)).toBe("/x?a=%41");
    }),
  );

  it.effect("survives a path binding and a base URL", () =>
    Effect.gen(function* () {
      for (const query of ["?a=1;b=2", "?"]) {
        expect(
          yield* urlOf(
            Request.get(`/x${query}`).pipe(
              Request.baseUrl("https://x.test/v1"),
              rendered("/"),
            ),
            { path: "y" },
          ),
        ).toBe(`https://x.test/v1/x/y${query}`);
      }
    }),
  );

  it.effect("goes before a fragment", () =>
    Effect.gen(function* () {
      expect(yield* targetOf(Request.get("/x?a=1;b#top"), undefined)).toEqual({
        url: "/x?a=1;b",
        hash: "top",
      });
      expect(yield* targetOf(Request.get("/x?#top"), undefined)).toEqual({
        url: "/x?",
        hash: "top",
      });
      expect(yield* targetOf(Request.get("/x#a?b"), undefined)).toEqual({
        url: "/x",
        hash: "a?b",
      });
    }),
  );

  it.effect("adds no marker to a URL that already has a query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?").pipe(
            Request.path(Schema.String, (query) => `/y?${query}`),
          ),
          { path: "z=1" },
        ),
      ).toBe("/x/y?z=1");
    }),
  );

  it.effect("appends an entry to a rendered URL with '&'", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41").pipe(
            Request.path(Schema.String, (query) => `/y?${query}`),
          ),
          { path: "z=1" },
        ),
      ).toBe("/x/y?z=1&a=%41");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect("keeps a lone '?' until a query schema writes an entry", () =>
    Effect.gen(function* () {
      const request = Request.get("/x?").pipe(
        Request.query(Schema.Struct({ q: Schema.optional(Schema.String) })),
      );
      expect(yield* urlOf(request, { query: {} })).toBe("/x?");
      expect(yield* urlOf(request, { query: { q: "1" } })).toBe("/x?q=1");
    }),
  );

  it.effect("keeps text when a native edit touches another entry", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/x?a=%41&b=c+d").pipe(
            Request.mapEffect((request) =>
              Effect.succeed(
                request.pipe(
                  HttpClientRequest.appendUrlParam("e", "f g"),
                  HttpClientRequest.setUrlParam("b", "h i"),
                ),
              ),
            ),
          ),
          undefined,
        ),
      ).toBe("/x?a=%41&e=f%20g&b=h%20i");
    }),
  );

  it.effect("shows a native step the decoded entries", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      yield* compile(
        Request.get("/x?a=b+c&d").pipe(
          Request.mapEffect((request) => {
            seen.push(request.urlParams.params);
            return Effect.succeed(request);
          }),
        ),
        undefined,
      );
      expect(seen).toEqual([
        [
          ["a", "b c"],
          ["d", ""],
        ],
      ]);
    }),
  );

  it.effect("gives a custom encoder only entries not kept as written", () =>
    Effect.gen(function* () {
      const policy = recording();
      const url = yield* urlOf(
        Request.get("/x?a=%41&b=c+d").pipe(
          Request.setQuery("a", "e f"),
          Request.appendQuery("g", null),
        ),
        undefined,
      ).pipe(Effect.provide(policy.layer));
      expect(url).toBe("/x?custom-a=e f&b=c+d&custom-g=null");
      expect(policy.calls).toEqual([[["a", "e f"]], [["g", null]]]);
    }),
  );

  it.effect("gives a custom encoder an unbroken run in one call", () =>
    Effect.gen(function* () {
      const policy = recording();
      const url = yield* urlOf(
        Request.get("/x?a=%41").pipe(
          Request.appendQuery("b", "1"),
          Request.appendQuery("c", "2"),
        ),
        undefined,
      ).pipe(Effect.provide(policy.layer));
      expect(url).toBe("/x?a=%41&custom-b=1&custom-c=2");
      expect(policy.calls).toEqual([
        [
          ["b", "1"],
          ["c", "2"],
        ],
      ]);
    }),
  );

  it.effect("does not call a custom encoder for written text", () =>
    Effect.gen(function* () {
      const policy = recording();
      const url = yield* urlOf(Request.get("/x?a=%41&b"), undefined).pipe(
        Effect.provide(policy.layer),
      );
      expect(url).toBe("/x?a=%41&b");
      expect(policy.calls).toEqual([]);
    }),
  );

  it.effect("still asks a custom encoder when there are no entries", () =>
    Effect.gen(function* () {
      const url = yield* urlOf(Request.get("/x"), undefined).pipe(
        Effect.provide(
          UrlEncoding.layer({
            ...UrlEncoding.defaults,
            query: (entries) =>
              UrlEncoding.defaults.query([...entries, ["key", "abc"]]),
          }),
        ),
      );
      expect(url).toBe("/x?key=abc");
    }),
  );

  it.effect("leaves no empty part for an encoder that renders nothing", () =>
    Effect.gen(function* () {
      const url = yield* urlOf(
        Request.get("/x?a=%41").pipe(Request.appendQuery("b", "1")),
        undefined,
      ).pipe(
        Effect.provide(
          UrlEncoding.layer({ ...UrlEncoding.defaults, query: () => "" }),
        ),
      );
      expect(url).toBe("/x?a=%41");
    }),
  );

  it("records the marker and the written text in its types", () => {
    expectTypeOf(
      Request.get("/").declaration.emptyQuery,
    ).toEqualTypeOf<boolean>();
    expectTypeOf<Request.Draft["queryText"]>().toEqualTypeOf<
      ReadonlyMap<Request.UrlParam, string>
    >();
    expect(Request.get("/x?").declaration.emptyQuery).toBe(true);
    expect(Request.get("/x?#top").declaration.emptyQuery).toBe(true);
    expect(Request.get("/x").declaration.emptyQuery).toBe(false);
    expect(Request.get("/x?a").declaration.emptyQuery).toBe(false);
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/83
describe("fragments in the URL", () => {
  it.effect("puts the query before a fragment in path output", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("https://api.example.test/users?f=xml").pipe(
            rendered("/"),
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
      expect(yield* joinedTarget("https://x.test#base", "/a#path")).toEqual({
        url: "https://x.test/a",
        hash: "path",
      });
      expect(yield* joinedTarget("https://x.test#base", "/a")).toEqual({
        url: "https://x.test/a",
        hash: "base",
      });
      expect(yield* joinedTarget("https://x.test", "/a")).toEqual({
        url: "https://x.test/a",
        hash: "from-join",
      });
    }),
  );

  it.effect("uses a base URL's fragment when an absolute URL bypasses it", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("https://y.test/z").pipe(
            Request.baseUrl("https://x.test/a#top"),
          ),
          undefined,
        ),
      ).toEqual({ url: "https://y.test/z", hash: "top" });
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
            Request.path(Schema.String, (id) => `/${id}`),
          ),
          { path: "b" },
        ),
      ).toEqual({ url: "https://x.test/a/b?q=1&r=2", hash: "top" });
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
