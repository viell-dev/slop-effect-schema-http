import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  flow,
  Option,
  Redacted,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { HttpClientRequest, UrlParams } from "effect/http";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";
import * as UrlEncoding from "./UrlEncoding.js";

/** A lone UTF-16 surrogate: a valid JavaScript string that cannot be percent-encoded. */
const loneSurrogate = String.fromCharCode(0xd800);

const compile = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Request.compile(request, input);

const urlOf = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.map(compile(request, input), (compiled) => compiled.request.url);

/** A compiled request's URL text and fragment, which are separate fields. */
const targetOf = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.map(compile(request, input), (compiled) => ({
    url: compiled.request.url,
    hash: Option.getOrUndefined(compiled.request.hash),
  }));

/** A binding that renders the fixed text `url` followed by the input. */
const rendered = (url: string) =>
  Request.path(Schema.String, (value) => `${url}${value}`);

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

/** The names a refusal lists after its last colon. */
const lostFrom = (message: string) =>
  JSON.parse(`[${message.slice(message.lastIndexOf(": ") + 2, -1)}]`);

/** A literal passed to the result meets the input directly, so a stray key is an error too. */
const takes =
  <S extends Schema.Top>(_schema: S) =>
  (_input: Request.Input<S>) =>
    undefined;

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

/** The body fields of a compiled request. */
const bodyFieldsOf = ({ request }: Request.Compiled) => ({
  type: request.headers["content-type"],
  length: request.headers["content-length"],
});

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

/** The `InvalidRequest` a request fails with. */
const refusal = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.flatMap(Effect.flip(compile(request, input)), (error) =>
    error instanceof Request.InvalidRequest
      ? Effect.succeed(error)
      : Effect.die(error),
  );

/** What a schema said about a caller's value, which comes before any group check. */
const schemaFailure = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.flatMap(Effect.flip(compile(request, input)), (error) =>
    error instanceof Schema.SchemaError
      ? Effect.succeed(error.message)
      : Effect.die(error),
  );

/** A request to `/x` with a query schema bound. */
const queried = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, UrlEncoding.QueryInput, unknown, unknown>,
>(
  schema: S,
) => Request.get("/x").pipe(Request.query(schema));

/** A compiled request's header lines. */
const linesOf = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.map(compile(request, input), (compiled) => compiled.headerLines);

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

// https://github.com/viell-dev/slop-effect-schema-http/issues/85
describe("declaring fields from a plain object", () => {
  describe("Request.setQuery", () => {
    it.effect("applies each value rule, in key order", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.setQuery({
                page: 2,
                sort: "name",
                tag: ["a", "b"],
                flag: null,
                empty: "",
                gone: undefined,
                late: () => "x",
              }),
            ),
            undefined,
          ),
        ).toBe("/x?page=2&sort=name&tag=a&tag=b&flag&empty=&late=x");
      }),
    );

    it.effect.each([
      ["a number", 2, "2"],
      ["a negative number", -1.5, "-1.5"],
      ["a bigint", 90071992547409931n, "90071992547409931"],
      ["true", true, "true"],
      ["false", false, "false"],
    ] as const)("writes %s as text", ([, value, expected]) =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(Request.setQuery({ a: value })),
            undefined,
          ),
        ).toBe(`/x?a=${expected}`);
      }),
    );

    it.effect("replaces each key and leaves other names alone", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?a=%41&b=2&a=3&c=%43").pipe(
              Request.setQuery({ a: "new", d: "added" }),
            ),
            undefined,
          ),
        ).toBe("/x?a=new&b=2&c=%43&d=added");
      }),
    );

    it.effect("keeps a repeated name together at its first position", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?a=1&tag=old&b=2").pipe(
              Request.setQuery({ tag: ["p", "q"] }),
            ),
            undefined,
          ),
        ).toBe("/x?a=1&tag=p&tag=q&b=2");
      }),
    );

    it.effect(
      "removes earlier declarations for undefined or an empty list",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1&b=2&c=3");
          expect(
            yield* urlOf(
              request.pipe(Request.setQuery({ a: undefined })),
              undefined,
            ),
          ).toBe("/x?b=2&c=3");
          expect(
            yield* urlOf(request.pipe(Request.setQuery({ a: [] })), undefined),
          ).toBe("/x?b=2&c=3");
        }),
    );

    it.effect("keeps nulls and drops undefined inside a list", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.setQuery({ a: [null, undefined, "b", 3] }),
            ),
            undefined,
          ),
        ).toBe("/x?a&a=b&a=3");
      }),
    );

    it.effect("runs a function during preparation, once per compilation", () =>
      Effect.gen(function* () {
        let calls = 0;
        const request = Request.get("/x").pipe(
          Request.setQuery({
            n: () => String(++calls),
            nothing: () => undefined,
            bare: () => null,
          }),
        );
        expect(calls).toBe(0);
        expect(yield* urlOf(request, undefined)).toBe("/x?n=1&bare");
        expect(yield* urlOf(request, undefined)).toBe("/x?n=2&bare");
      }),
    );

    it.effect("reads the object when called, not when applied", () =>
      Effect.gen(function* () {
        const fields: Record<string, string> = { a: "1" };
        const edit = Request.setQuery(fields);
        fields["a"] = "2";
        fields["b"] = "3";
        expect(yield* urlOf(Request.get("/x").pipe(edit), undefined)).toBe(
          "/x?a=1",
        );
      }),
    );

    it.effect("takes a name a plain object would inherit", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.setQuery({
                constructor: "a",
                ["__proto__"]: "b",
                toString: "c",
              }),
            ),
            undefined,
          ),
        ).toBe("/x?constructor=a&__proto__=b&toString=c");
      }),
    );

    it.effect("does nothing for an empty object", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?a=%41").pipe(Request.setQuery({})),
            undefined,
          ),
        ).toBe("/x?a=%41");
      }),
    );

    it.effect("is checked against a schema like any other edit", () =>
      Effect.gen(function* () {
        const typed = Request.get("/x").pipe(
          Request.query(
            Schema.Struct({
              page: Schema.FiniteFromString,
              limit: Schema.optional(Schema.FiniteFromString),
            }),
          ),
        );
        const input = { query: { page: 1 } };
        expect(
          yield* urlOf(typed.pipe(Request.setQuery({ limit: 5 })), input),
        ).toBe("/x?page=1&limit=5");
        const stray = yield* Effect.flip(
          compile(typed.pipe(Request.setQuery({ other: "1" })), input),
        );
        expect(stray.message).toContain('"other"');
        for (const value of ["2", undefined]) {
          const required = yield* Effect.flip(
            compile(typed.pipe(Request.setQuery({ page: value })), input),
          );
          expect(required.message).toContain("could never reach the client");
        }
      }),
    );

    it("accepts the values a query schema may encode to, or a function", () => {
      Request.setQuery({
        a: 1,
        b: 1n,
        c: true,
        d: null,
        e: undefined,
        f: "x",
        g: [1, "x", null, undefined],
        h: () => "x",
        i: () => null,
        j: () => undefined,
        k: () => 1,
        l: () => 1n,
        m: () => true,
        n: () => new Date(0),
      });
      // @ts-expect-error: a nested object has no query representation
      Request.setQuery({ a: { b: "1" } });
      // @ts-expect-error: nor does a function's result
      Request.setQuery({ a: () => ({ b: "1" }) });
      // @ts-expect-error: a function supplies one value, so it cannot repeat a name
      Request.setQuery({ a: () => ["x", "y"] });
      // @ts-expect-error: a list holds query values, not functions
      Request.setQuery({ a: [() => "x"] });
      // @ts-expect-error: the two-argument form still takes text
      Request.setQuery("a", 1);
      // @ts-expect-error: and so does its function
      Request.setQuery("a", () => 1);
      // @ts-expect-error: and a `Date`, or a function returning one, stays in the object form
      Request.setQuery("a", () => new Date(0));
    });

    it.effect("writes a function's result as it writes the same value", () =>
      Effect.gen(function* () {
        const date = new Date("2026-11-07T00:00:00.000Z");
        const fixed = {
          a: 2,
          b: 3n,
          c: true,
          d: false,
          e: date,
          f: null,
          g: "",
          h: "x y",
          i: 0,
        };
        const computed = {
          a: () => 2,
          b: () => 3n,
          c: () => true,
          d: () => false,
          e: () => date,
          f: () => null,
          g: () => "",
          h: () => "x y",
          i: () => 0,
        };
        const url = yield* urlOf(
          Request.get("/x").pipe(Request.setQuery(computed)),
          undefined,
        );
        expect(url).toBe(
          yield* urlOf(
            Request.get("/x").pipe(Request.setQuery(fixed)),
            undefined,
          ),
        );
        expect(url).toBe(
          "/x?a=2&b=3&c=true&d=false&e=2026-11-07T00%3A00%3A00.000Z&f&g=&h=x%20y&i=0",
        );
      }),
    );

    it.effect(
      "writes an invalid `Date` from a function as the value form does",
      () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.setQuery({ at: () => new Date(Number.NaN) }),
              ),
              undefined,
            ),
          ).toBe("/x?at=Invalid%20Date");
        }),
    );

    it.effect("takes a function's number as a default under a schema", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.setQuery({ limit: () => 25 }),
          Request.query(
            Schema.Struct({ limit: Schema.optional(Schema.FiniteFromString) }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/x?limit=25");
        expect(yield* urlOf(request, { query: { limit: 5 } })).toBe(
          "/x?limit=5",
        );
      }),
    );
  });

  describe("Request.setHeader", () => {
    it.effect("sets each field, in key order, keeping spelling", () =>
      Effect.gen(function* () {
        expect(
          yield* linesOf(
            Request.get("/x").pipe(
              Request.setHeader({ "X-One": "1", "X-Two": () => "2" }),
            ),
            undefined,
          ),
        ).toEqual([
          ["X-One", "1"],
          ["X-Two", "2"],
        ]);
      }),
    );

    it.effect(
      "replaces each key without case, and leaves other names alone",
      () =>
        Effect.gen(function* () {
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.appendHeader("x-tag", "a"),
                Request.setHeader("X-Kept", "k"),
                Request.appendHeader("X-TAG", "b"),
                Request.setHeader({ "X-Tag": "c" }),
              ),
              undefined,
            ),
          ).toEqual([
            ["X-Tag", "c"],
            ["X-Kept", "k"],
          ]);
        }),
    );

    it.effect("removes earlier declarations of an undefined key", () =>
      Effect.gen(function* () {
        expect(
          yield* linesOf(
            Request.get("/x").pipe(
              Request.setHeader("X-Gone", "1"),
              Request.setHeader("X-Kept", "k"),
              Request.setHeader({ "x-gone": undefined }),
            ),
            undefined,
          ),
        ).toEqual([["X-Kept", "k"]]);
      }),
    );

    it.effect("leaves an automatic value in place for an undefined key", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/x").pipe(
            Request.body(Body.text),
            Request.setHeader({ "Content-Type": undefined }),
          ),
          { body: "b" },
        );
        expect(compiled.request.headers["content-type"]).toBe("text/plain");
        expect(compiled.removedHeaders).toEqual(new Set());
      }),
    );

    it.effect("wins over an automatic value, like the two-argument form", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/x").pipe(
            Request.body(Body.text),
            Request.setHeader({ "Content-Type": "application/weird" }),
          ),
          { body: "b" },
        );
        expect(compiled.request.headers["content-type"]).toBe(
          "application/weird",
        );
      }),
    );

    it.effect("is checked against a schema like any other edit", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.headers(Schema.Struct({ "x-limit": Schema.String })),
          Request.setHeader({ "X-LIMIT": "1" }),
        );
        const error = yield* Effect.flip(
          compile(request, { headers: { "x-limit": "2" } }),
        );
        expect(error.message).toContain("could never reach the client");
      }),
    );

    it("accepts text or a function", () => {
      Request.setHeader({
        a: "1",
        b: () => "2",
        c: () => undefined,
        d: undefined,
      });
      // @ts-expect-error: header values are text
      Request.setHeader({ a: 1 });
      // @ts-expect-error: a header has no bare form
      Request.setHeader({ a: null });
      // @ts-expect-error: use `appendHeader` for repeated lines
      Request.setHeader({ a: ["1", "2"] });
    });
  });

  it("keeps every raw edit one type, so they compose as a list", () => {
    const edits = [
      Request.setQuery({ a: "1" }),
      Request.setQuery("b", "2"),
      Request.appendQuery("c", "3"),
      Request.removeQuery("d"),
      Request.setHeader({ a: "1" }),
      Request.setHeader("b", "2"),
      Request.appendHeader("c", "3"),
      Request.removeHeader("d"),
    ];
    const reduced = edits.reduce(
      (request, edit) => edit(request),
      Request.get("/x"),
    );
    expectTypeOf(reduced).toEqualTypeOf<Request.Request<unknown>>();
  });
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect("refuses a raw header the schema does not allow", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(
          Request.get("https://api.test/").pipe(
            Request.setHeader("X-Raw", "dropped"),
            Request.headers(ApiHeaders),
          ),
          { headers: { "X-Api-Key": "k", "X-Scope": [] } },
        ),
      );
      expect(error).toBeInstanceOf(Request.InvalidRequest);
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it("keeps raw setters and further schemas in the type", () => {
    const bound = Request.get("/").pipe(Request.headers(ApiHeaders));
    bound.pipe(Request.setHeader("X-Optional", "1"));
    bound.pipe(Request.appendHeader("X-Optional", "1"));
    bound.pipe(Request.removeHeader("X-Optional"));
    bound.pipe(Request.headers(ApiHeaders));
  });

  it("requires a schema whose encoded side is header fields", () => {
    const NumericPage = Schema.Struct({ "X-Page": Schema.Number });
    // @ts-expect-error: a plain string is not a set of header fields
    Request.headers(Schema.String);
    // @ts-expect-error: header values encode to strings, not numbers
    Request.headers(NumericPage);
    Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString }));
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/113
  it("takes either side of the schema as input, and nothing else", () => {
    const paged = Request.get("/").pipe(
      Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString })),
    );
    void Request.compile(paged, { headers: { "X-Page": 3 } });
    void Request.compile(paged, { headers: { "X-Page": "3" } });
    // @ts-expect-error: a boolean is on neither side of the schema
    void Request.compile(paged, { headers: { "X-Page": true } });
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/135
  it.effect(
    "currently needs its group in the input with every field optional",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(
            Schema.Struct({ limit: Schema.optional(Schema.FiniteFromString) }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/things");
        const error = yield* Effect.flip(
          // @ts-expect-error the group's key is required
          compile(request, {}),
        );
        expect(error).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect(
    "refuses raw entries the schema does not allow, including the URL's query string",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(
            Request.get("https://api.test/search?legacy=1").pipe(
              Request.setQuery("raw", "dropped"),
              Request.query(Search),
            ),
            { query: { q: "x" } },
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.message).toContain('"legacy", "raw"');
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it("keeps raw setters and further schemas in the type", () => {
    const bound = Request.get("/").pipe(Request.query(Search));
    bound.pipe(Request.setQuery("tag", "1"));
    bound.pipe(Request.appendQuery("tag", "1"));
    bound.pipe(Request.removeQuery("tag"));
    bound.pipe(Request.query(Search));
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/113
  it("takes either side of the schema as input, and nothing else", () => {
    const paged = Request.get("/").pipe(
      Request.query(Schema.Struct({ page: Schema.NumberFromString })),
    );
    void Request.compile(paged, { query: { page: 2 } });
    void Request.compile(paged, { query: { page: "2" } });
    // @ts-expect-error: a boolean is on neither side of the schema
    void Request.compile(paged, { query: { page: true } });
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/110
describe("dates in a query", () => {
  const noon = new Date("2026-11-07T12:00:00.000Z");
  const iso = "2026-11-07T12%3A00%3A00.000Z";
  const noonUtc = DateTime.makeUnsafe(noon);

  describe("the sides of a schema", () => {
    it.effect("`Schema.Date` takes a `Date` and carries ISO text", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.Date })),
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
      }),
    );

    it.effect("`Schema.DateFromString` takes a `Date` or its text", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.DateFromString })),
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
        expect(
          yield* urlOf(request, { query: { from: noon.toISOString() } }),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("a schema from a `Date` to another type takes either", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.DateTimeUtcFromDate })),
        );
        expect(yield* urlOf(request, { query: { from: noonUtc } })).toBe(
          `/slots?from=${iso}`,
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
      }),
    );

    it.effect("takes either side of such a schema beside another field", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(
            Schema.Struct({
              from: Schema.DateTimeUtcFromDate,
              limit: Schema.FiniteFromString,
            }),
          ),
        );
        for (const query of [
          { from: noonUtc, limit: 5 },
          { from: noon, limit: "5" },
          { from: noon, limit: 5 },
          { from: noonUtc, limit: "5" },
        ])
          expect(yield* urlOf(request, { query })).toBe(
            `/slots?from=${iso}&limit=5`,
          );
      }),
    );

    it.effect("mixes with other fields, and repeats in a list", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(
            Schema.Struct({
              at: Schema.Array(Schema.Date),
              limit: Schema.FiniteFromString,
            }),
          ),
        );
        expect(
          yield* urlOf(request, { query: { at: [noon, noon], limit: "5" } }),
        ).toBe(`/slots?at=${iso}&at=${iso}&limit=5`);
      }),
    );

    it.effect("writes a `Date` in a record or a list of pairs", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.query(Schema.Record(Schema.String, Schema.Date)),
            ),
            { query: { from: noon } },
          ),
        ).toBe(`/slots?from=${iso}`);
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.query(
                Schema.Array(Schema.Tuple([Schema.String, Schema.Date])),
              ),
            ),
            { query: [["from", noon]] },
          ),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("still keeps a `null` as a bare key beside a `Date`", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.NullOr(Schema.Date) })),
        );
        expect(yield* urlOf(request, { query: { from: null } })).toBe(
          "/slots?from",
        );
      }),
    );

    it.effect("refuses an invalid `Date` with a schema error", () =>
      Effect.gen(function* () {
        const invalid = new Date(Number.NaN);
        for (const contract of [
          Schema.Date,
          Schema.DateFromString,
          Schema.DateTimeUtcFromDate,
        ]) {
          const error = yield* Effect.flip(
            urlOf(
              Request.get("/slots").pipe(
                Request.query(Schema.Struct({ from: contract })),
              ),
              { query: { from: invalid } } as never,
            ),
          );
          expect(error._tag).toBe("SchemaError");
        }
      }),
    );

    it("takes a `Date` only where a schema says so", () => {
      const request = Request.get("/").pipe(
        Request.query(Schema.Struct({ from: Schema.Date })),
      );
      void Request.compile(request, { query: { from: noon } });
      // @ts-expect-error: `Schema.Date` is a `Date` on both sides, so text is on neither
      void Request.compile(request, { query: { from: "2026-11-07" } });
    });
  });

  describe("a default under a field that encodes to a `Date`", () => {
    const Slots = Schema.Struct({ from: Schema.optional(Schema.Date) });

    it.effect("is read from its text and goes through the schema", () =>
      Effect.gen(function* () {
        const request = Request.get(
          "/slots?from=2026-11-07T12:00:00.000Z",
        ).pipe(Request.query(Slots));
        expect(yield* urlOf(request, { query: {} })).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("loses its exact spelling, as a number's does", () =>
      Effect.gen(function* () {
        for (const written of [
          "2026-11-07",
          "2026-11-07T12:00Z",
          "2026-11-07T14:00:00+02:00",
        ]) {
          const request = Request.get("/slots").pipe(
            Request.setQuery("from", written),
            Request.query(Slots),
          );
          const url = yield* urlOf(request, { query: {} });
          expect(url).toBe(
            `/slots?from=${encodeURIComponent(new Date(written).toISOString())}`,
          );
        }
      }),
    );

    it.effect("gives way to what the caller passes", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=soon").pipe(
          Request.query(Slots),
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
      }),
    );

    it.effect("is refused when it holds no date, and never repeated", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=soon").pipe(
          Request.query(Slots),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"from"');
        expect(error.message).not.toContain("soon");
      }),
    );

    it.effect("is refused under a declaration that accepts any `Date`", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=soon").pipe(
          Request.query(
            Schema.Struct({ from: Schema.optional(Schema.instanceOf(Date)) }),
          ),
        );
        expect((yield* refusal(request, { query: {} })).message).toContain(
          '"from"',
        );
      }),
    );

    it.effect("is refused when a check on the `Date` refuses it", () =>
      Effect.gen(function* () {
        const early = new Date("2026-01-01T00:00:00.000Z");
        const Early = Schema.Date.check(
          Schema.makeFilter((date: Date) => date.getTime() <= early.getTime()),
        );
        const fields = Schema.Struct({ from: Schema.optional(Early) });
        expect(
          yield* urlOf(
            Request.get("/slots?from=2025-01-01").pipe(Request.query(fields)),
            { query: {} },
          ),
        ).toBe("/slots?from=2025-01-01T00%3A00%3A00.000Z");
        yield* refusal(
          Request.get("/slots?from=2026-11-07").pipe(Request.query(fields)),
          { query: {} },
        );
      }),
    );

    it.effect("fits a list, and each repeat is read", () =>
      Effect.gen(function* () {
        const Days = Schema.Struct({
          day: Schema.optional(Schema.Array(Schema.Date)),
        });
        expect(
          yield* urlOf(
            Request.get("/slots?day=2026-11-07").pipe(Request.query(Days)),
            { query: {} },
          ),
        ).toBe("/slots?day=2026-11-07T00%3A00%3A00.000Z");
        expect(
          yield* urlOf(
            Request.get("/slots?day=2026-11-07&day=2026-11-08").pipe(
              Request.query(Days),
            ),
            { query: {} },
          ),
        ).toBe(
          "/slots?day=2026-11-07T00%3A00%3A00.000Z&day=2026-11-08T00%3A00%3A00.000Z",
        );
      }),
    );

    it.effect("works under a schema to another type, and under a record", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots?from=2026-11-07T12:00:00.000Z").pipe(
              Request.query(
                Schema.Struct({
                  from: Schema.optional(Schema.DateTimeUtcFromDate),
                }),
              ),
            ),
            { query: {} },
          ),
        ).toBe(`/slots?from=${iso}`);
        expect(
          yield* urlOf(
            Request.get("/slots?from=2026-11-07T12:00:00.000Z").pipe(
              Request.query(Schema.Record(Schema.String, Schema.Date)),
            ),
            { query: {} },
          ),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("keeps a bare key for a field that also takes `null`", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from").pipe(
          Request.query(
            Schema.Struct({
              from: Schema.optional(Schema.NullOr(Schema.Date)),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/slots?from");
      }),
    );

    it.effect("stays text where the field can hold text", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=2026-11-07").pipe(
          Request.query(
            Schema.Struct({
              from: Schema.optional(Schema.Union([Schema.Date, Schema.String])),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/slots?from=2026-11-07",
        );
      }),
    );

    it.effect("stays text under a declaration of text", () =>
      Effect.gen(function* () {
        const Day = Schema.declare(
          (input): input is string =>
            typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input),
        );
        const request = Request.get("/slots?day=2026-11-07").pipe(
          Request.query(Schema.Struct({ day: Schema.optional(Day) })),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/slots?day=2026-11-07",
        );
      }),
    );

    it.effect("leaves another declaration's field to refuse the text", () =>
      Effect.gen(function* () {
        // A `Moment` is not a query value, so only a cast can get this far.
        const request = Request.get("/slots?from=2026-11-07").pipe(
          Request.query(
            Schema.Struct({ from: Schema.optional(MomentFromSelf) as never }),
          ),
        );
        yield* refusal(request, { query: {} });
      }),
    );
  });

  describe("a raw record", () => {
    it.effect("writes a `Date` as ISO text", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(Request.setQuery({ from: noon })),
            undefined,
          ),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect(
      "writes a computed `Date` as ISO text, each time it is prepared",
      () =>
        Effect.gen(function* () {
          const dates = [noon, new Date("2026-11-08T12:00:00.000Z")];
          const request = Request.get("/slots").pipe(
            Request.setQuery({ from: () => dates.shift() }),
          );
          expect(yield* urlOf(request, undefined)).toBe(`/slots?from=${iso}`);
          expect(yield* urlOf(request, undefined)).toBe(
            "/slots?from=2026-11-08T12%3A00%3A00.000Z",
          );
          expect(yield* urlOf(request, undefined)).toBe("/slots");
        }),
    );

    it.effect("repeats a list of them", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.setQuery({ at: [noon, null, noon] }),
            ),
            undefined,
          ),
        ).toBe(`/slots?at=${iso}&at&at=${iso}`);
      }),
    );

    it.effect("is not changed by a later edit of the `Date`", () =>
      Effect.gen(function* () {
        const date = new Date(noon);
        const request = Request.get("/slots").pipe(
          Request.setQuery({ from: date }),
        );
        date.setTime(0);
        expect(yield* urlOf(request, undefined)).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("goes through a schema like any other default", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.setQuery({ from: noon }),
          Request.query(Schema.Struct({ from: Schema.optional(Schema.Date) })),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("sends an invalid `Date` as its text, with no schema", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.setQuery({ from: new Date(Number.NaN) }),
            ),
            undefined,
          ),
        ).toBe("/slots?from=Invalid%20Date");
      }),
    );

    it.effect("is refused for an invalid `Date` under a schema", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.setQuery({ from: new Date(Number.NaN) }),
          Request.query(Schema.Struct({ from: Schema.optional(Schema.Date) })),
        );
        yield* refusal(request, { query: {} });
      }),
    );

    it("takes a `Date` only in the object form", () => {
      void Request.setQuery({ from: noon });
      void Request.setQuery({ from: [noon, noon] });
      void Request.setQuery({ from: () => noon });
      // @ts-expect-error: the two-argument form takes text, as it always has
      void Request.setQuery("from", noon);
      // @ts-expect-error: as does its function
      void Request.setQuery("from", () => noon);
    });
  });

  // `If-Modified-Since` and its kind use the HTTP date format, which is not ISO.
  describe("headers stay text", () => {
    it("refuses a header schema that encodes to a `Date`", () => {
      void Request.headers(
        // @ts-expect-error: the schema has to write its own text
        Schema.Struct({ "If-Modified-Since": Schema.Date }),
      );
      // @ts-expect-error: header values are text
      void Request.setHeader({ "If-Modified-Since": noon });
    });

    it.effect("writes what a schema's own text says", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.headers(
            Schema.Struct({
              "If-Modified-Since": Schema.DateTimeUtcFromHttpDate,
            }),
          ),
        );
        const compiled = yield* compile(request, {
          headers: { "If-Modified-Since": noonUtc },
        });
        expect(compiled.headerLines).toEqual([
          ["If-Modified-Since", "Sat, 07 Nov 2026 12:00:00 GMT"],
        ]);
      }),
    );
  });
});

describe("Request.path", () => {
  const Id = Schema.String;

  it.effect("renders the schema-encoded value with the path encoder", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("").pipe(
            Request.path(Id, (id, encode) => `/files/${encode(id)}/meta`),
            Request.baseUrl("https://api.test"),
          ),
          { path: "a/b c" },
        ),
      ).toBe("https://api.test/files/a%2Fb%20c/meta");
    }),
  );

  it.effect("adds to the constructor's path and keeps its query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/items?format=xml").pipe(
            Request.path(Id, (id, encode) => `/${encode(id)}`),
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
            Request.get("https://api.test").pipe(
              Request.setQuery("b", "2"),
              Request.path(Id, (id) => `/x?a=${id}`),
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

// https://github.com/viell-dev/slop-effect-schema-http/issues/82
describe("the path is joined exactly", () => {
  it.effect.each([
    ["/users", "/42", "/users/42"],
    ["", "/users/1", "/users/1"],
    ["https://api.test/v1", "/users/1", "https://api.test/v1/users/1"],
    ["/things/42", ":archive", "/things/42:archive"],
    ["/users/", "/42", "/users//42"],
    ["/users", "42", "/users42"],
    ["/things", ".json", "/things.json"],
    ["/fetch/", "https://other.test/x", "/fetch/https://other.test/x"],
  ] as const)("%s followed by %s", ([start, added, url]) =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get(start).pipe(rendered(added)), { path: "" }),
      ).toBe(url);
    }),
  );

  it.effect("follows the same rule for a template", () =>
    Effect.gen(function* () {
      const id = Request.pathValue("id");
      const input = { path: { id: "42" } };
      expect(
        yield* urlOf(Request.get("/users").pipe(Request.path`/${id}`), input),
      ).toBe("/users/42");
      expect(
        yield* urlOf(Request.get("/users").pipe(Request.path`${id}`), input),
      ).toBe("/users42");
      expect(
        yield* urlOf(Request.get("/users/").pipe(Request.path`/${id}`), input),
      ).toBe("/users//42");
      expect(
        yield* urlOf(
          Request.get("/things/42").pipe(Request.path`:archive`),
          undefined,
        ),
      ).toBe("/things/42:archive");
      expect(
        yield* urlOf(Request.get("").pipe(Request.path`/users/1`), undefined),
      ).toBe("/users/1");
    }),
  );

  it.effect("adds repeated calls in order, of either form", () =>
    Effect.gen(function* () {
      const id = Request.pathValue("id");
      const request = Request.get("/a").pipe(
        Request.path`/b`,
        Request.path(
          Schema.Struct({ section: Schema.String }),
          ({ section }, encode) => `/${encode(section)}`,
        ),
        Request.path`/c/${id}`,
        Request.path`/d`,
      );
      expect(yield* urlOf(request, { path: { section: "s t", id: "x" } })).toBe(
        "/a/b/s%20t/c/x/d",
      );
    }),
  );

  it.effect("no longer drops the constructor's path", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/users").pipe(
            Request.path(Schema.String, (id, encode) => `/users/${encode(id)}`),
          ),
          { path: "1" },
        ),
      ).toBe("/users/users/1");
    }),
  );

  it.effect("starts again on each evaluation", () =>
    Effect.gen(function* () {
      const request = Request.get("/a").pipe(Request.path`/b`);
      expect(yield* urlOf(request, undefined)).toBe("/a/b");
      expect(yield* urlOf(request, undefined)).toBe("/a/b");
    }),
  );

  it.effect("leaves the parent as it was", () =>
    Effect.gen(function* () {
      const parent = Request.get("/a");
      const child = parent.pipe(Request.path`/b`);
      expect(yield* urlOf(child.pipe(Request.path`/c`), undefined)).toBe(
        "/a/b/c",
      );
      expect(yield* urlOf(child, undefined)).toBe("/a/b");
      expect(yield* urlOf(parent, undefined)).toBe("/a");
    }),
  );

  it.effect("reads a # as a fragment for all that follows it", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/a").pipe(Request.path`/b#x`, Request.path`/c`),
          undefined,
        ),
      ).toEqual({ url: "/a/b", hash: "x/c" });
    }),
  );

  it.effect("leaves a ? in the text as URL text", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/a?wsdl").pipe(
            Request.path`/b?x=1`,
            Request.path`/c`,
            Request.setQuery("y", "2"),
          ),
          undefined,
        ),
      ).toBe("/a/b?x=1/c&wsdl&y=2");
    }),
  );

  it.effect("keeps the constructor's query, bare flags and fragment", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/x?wsdl&a=%41#top").pipe(Request.path`/y`),
          undefined,
        ),
      ).toEqual({ url: "/x/y?wsdl&a=%41", hash: "top" });
    }),
  );

  it.effect("lets a whole URL bypass the base only from an empty start", () =>
    Effect.gen(function* () {
      const whole = Request.path(Schema.String, (href) => href);
      const input = { path: "https://other.test/x" };
      const api = Request.baseUrl("https://api.test/v1");
      expect(yield* urlOf(Request.get("").pipe(api, whole), input)).toBe(
        "https://other.test/x",
      );
      expect(yield* urlOf(Request.get("/fetch/").pipe(api, whole), input)).toBe(
        "https://api.test/v1/fetch/https://other.test/x",
      );
    }),
  );

  it.effect("joins the base at its slash boundary, as it always did", () =>
    Effect.gen(function* () {
      for (const base of ["https://api.test/v1", "https://api.test/v1/"]) {
        const api = Request.baseUrl(base);
        expect(
          yield* urlOf(Request.get("").pipe(api, Request.path`/a`), undefined),
        ).toBe("https://api.test/v1/a");
        expect(
          yield* urlOf(Request.get("").pipe(api, Request.path`a`), undefined),
        ).toBe("https://api.test/v1/a");
      }
    }),
  );

  it.effect(
    "keeps a query on its own beside a base, where a template adds /",
    () =>
      Effect.gen(function* () {
        const base = Request.baseUrl("https://api.test/svc");
        expect(yield* urlOf(Request.get("?wsdl").pipe(base), undefined)).toBe(
          "https://api.test/svc?wsdl",
        );
        expect(
          yield* urlOf(
            Request.get("").pipe(base, Request.path`?wsdl`),
            undefined,
          ),
        ).toBe("https://api.test/svc/?wsdl");
      }),
  );

  it.effect("lets a native edit see the path so far, and adds to it", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const record = Request.mapEffect(
        (request: HttpClientRequest.HttpClientRequest) => {
          seen.push(request.url);
          return Effect.succeed(request);
        },
      );
      const moved = Request.mapEffect(
        (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(HttpClientRequest.setUrl(request, "/moved")),
      );
      expect(
        yield* urlOf(
          Request.get("/a").pipe(
            record,
            Request.path`/b`,
            record,
            moved,
            Request.path`/c`,
          ),
          undefined,
        ),
      ).toBe("/moved/c");
      expect(seen).toEqual(["/a", "/a/b"]);
    }),
  );
});

/** A generic helper: a template whose name its caller chooses. */
const atName =
  <const K extends string>(name: K) =>
  <I, E, R>(self: Request.Request<I, E, R>) =>
    self.pipe(Request.path`/${Request.pathValue(name)}`);

/** A generic helper: a renderer for any schema that encodes to text. */
const taskPath = <S extends Schema.Top & { readonly Encoded: string }>(
  schema: S,
  suffix = "",
) =>
  Request.path(schema, (id: string, encode) => `/tasks/${encode(id)}${suffix}`);

/** What a template writes for one value under `schema`. */
const written = <S extends Request.PathSchema>(
  schema: S,
  value: Request.Input<S>,
) =>
  urlOf(
    Request.get("").pipe(Request.path`/${Request.pathValue("value", schema)}`),
    { path: { value } } as never,
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/80
describe("a path template", () => {
  const base = "https://api.example.test/v1";
  const api = Request.baseUrl(base);
  const customer = Request.pathValue("customer");
  const calendar = Request.pathValue("calendar", Schema.FiniteFromString);
  const event = Request.pathValue("event");
  const thing = Request.pathValue("id");

  const getCalendar = Request.get("").pipe(
    api,
    Request.path`/customers/${customer}/calendars/${calendar}`,
  );

  describe("writes the path", () => {
    it.effect("renders a nested resource", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(getCalendar, {
            path: { customer: "a/b", calendar: 7 },
          }),
        ).toBe(`${base}/customers/a%2Fb/calendars/7`);
      }),
    );

    it.effect("lets a child add to a parent, stating only its own part", () =>
      Effect.gen(function* () {
        const getEvent = getCalendar.pipe(Request.path`/events/${event}`);
        expect(
          yield* urlOf(getEvent, {
            path: { customer: "a/b", calendar: 7, event: "c d" },
          }),
        ).toBe(`${base}/customers/a%2Fb/calendars/7/events/c%20d`);
      }),
    );

    it.effect("starts from a constructor's path", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/customers").pipe(api, Request.path`/${customer}`),
            { path: { customer: "x" } },
          ),
        ).toBe(`${base}/customers/x`);
      }),
    );

    it.effect("puts a value inside a segment", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("").pipe(api, Request.path`/Customers('${customer}')`),
            { path: { customer: "x y" } },
          ),
        ).toBe(`${base}/Customers('x%20y')`);
      }),
    );

    it.effect("keeps a trailing slash, a literal colon and a suffix", () =>
      Effect.gen(function* () {
        const input = { path: { id: "x" } };
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/things/${thing}/orders/`),
            input,
          ),
        ).toBe("/things/x/orders/");
        expect(
          yield* urlOf(
            Request.post("").pipe(Request.path`/things/${thing}:archive`),
            input,
          ),
        ).toBe("/things/x:archive");
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/things/${thing}.json`),
            input,
          ),
        ).toBe("/things/x.json");
      }),
    );

    it.effect("takes no input when it has no values", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get("/a").pipe(Request.path`/b`), undefined),
        ).toBe("/a/b");
      }),
    );

    it.effect("can be only values, or start or end with one", () =>
      Effect.gen(function* () {
        const first = Request.pathValue("first");
        const second = Request.pathValue("second");
        const input = { path: { first: "a b", second: "c" } };
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`${first}${second}`),
            input,
          ),
        ).toBe("a%20bc");
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`${first}/x/${second}`),
            input,
          ),
        ).toBe("a%20b/x/c");
      }),
    );

    it.effect("gives every use of a name the one value", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/a/${thing}/b/${thing}`),
            { path: { id: "x" } },
          ),
        ).toBe("/a/x/b/x");
      }),
    );

    it.effect("uses text exactly as written, even a backslash", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/a\b/${thing}\n/%2F/ c\`\${d}`),
            { path: { id: "x" } },
          ),
        ).toBe("/a\\b/x\\n/%2F/ c\\`\\${d}");
      }),
    );

    it.effect(
      "uses fixed text exactly as written, even an invalid escape",
      () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(
              Request.get("").pipe(Request.path`/a\b/\u`),
              undefined,
            ),
          ).toBe("/a\\b/\\u");
        }),
    );

    it.effect("adds nothing when it is empty", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get("/a").pipe(Request.path``), undefined),
        ).toBe("/a");
      }),
    );

    it.effect("can be a named transform that definitions share", () =>
      Effect.gen(function* () {
        const atThing = Request.path`/things/${thing}`;
        const input = { path: { id: "1" } };
        expect(yield* urlOf(Request.get("").pipe(api, atThing), input)).toBe(
          `${base}/things/1`,
        );
        expect(yield* urlOf(Request.post("/x").pipe(api, atThing), input)).toBe(
          `${base}/x/things/1`,
        );
      }),
    );

    it.effect("works through a generic helper", () =>
      Effect.gen(function* () {
        const tenant = Request.pathValue("tenant");
        const underTenant = <I, E, R>(self: Request.Request<I, E, R>) =>
          self.pipe(Request.path`/tenants/${tenant}`);
        const reports = Request.get("").pipe(
          api,
          underTenant,
          Request.path`/reports`,
          atName("report"),
        );
        expect(
          yield* urlOf(reports, { path: { tenant: "t/1", report: "r" } }),
        ).toBe(`${base}/tenants/t%2F1/reports/r`);
      }),
    );

    it.effect("works in a composed function", () =>
      Effect.gen(function* () {
        const toThing = flow(
          Request.path`/things/${thing}`,
          Request.path`/parts`,
        );
        expect(
          yield* urlOf(toThing(Request.get("")), { path: { id: "x" } }),
        ).toBe("/things/x/parts");
      }),
    );

    it.effect("works under Request.mapInput", () =>
      Effect.gen(function* () {
        const byId = Request.get("").pipe(
          Request.path`/things/${thing}`,
          Request.mapInput((id: string) => ({ path: { id } })),
        );
        expect(yield* urlOf(byId, "x")).toBe("/things/x");
      }),
    );
  });

  describe("reads each value through its schema", () => {
    it.effect("takes either side of the schema", () =>
      Effect.gen(function* () {
        const invoice = Request.pathValue("id", Schema.FiniteFromString);
        const request = Request.get("").pipe(
          Request.path`/invoices/${invoice}`,
        );
        for (const id of [42, "42", "042"]) {
          expect(yield* urlOf(request, { path: { id } })).toBe("/invoices/42");
        }
      }),
    );

    it.effect("takes a mix by value", () =>
      Effect.gen(function* () {
        const page = Request.pathValue("page", Schema.FiniteFromString);
        const size = Request.pathValue("size", Schema.FiniteFromString);
        expect(
          yield* urlOf(Request.get("").pipe(Request.path`/${page}/${size}`), {
            path: { page: 1, size: "2" },
          }),
        ).toBe("/1/2");
      }),
    );

    it.effect("is a string without a schema", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: 7 },
          } as never),
        );
        expect(error).toBeInstanceOf(Schema.SchemaError);
      }),
    );

    it.effect("keeps a schema failure a SchemaError that names the value", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(getCalendar, { path: { customer: "x", calendar: "many" } }),
        );
        expect(error).toBeInstanceOf(Schema.SchemaError);
        expect(error.message).toContain('["calendar"]');
      }),
    );

    it.effect.each([
      ["no field", { path: {} }],
      ["no group", {}],
      ["a scalar group", { path: 7 }],
      ["a null group", { path: null }],
    ] as const)("refuses %s with a SchemaError", ([, input]) =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(Request.path`/${thing}`);
        const error = yield* Effect.flip(compile(request, input as never));
        expect(error).toBeInstanceOf(Schema.SchemaError);
      }),
    );

    it.effect("ignores the other names under path", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: "x", other: 1 },
          } as never),
        ).toBe("/x");
      }),
    );

    it.effect("writes every scalar a schema can encode to", () =>
      Effect.gen(function* () {
        expect(yield* written(Schema.Number, 0)).toBe("/0");
        expect(yield* written(Schema.Number, 1e21)).toBe("/1e%2B21");
        expect(yield* written(Schema.Boolean, false)).toBe("/false");
        expect(yield* written(Schema.BigInt, 7n)).toBe("/7");
        expect(yield* written(Schema.String, "")).toBe("/");
        expect(yield* written(Schema.Literals(["a", "b"]), "b")).toBe("/b");
        expect(
          yield* written(Schema.Union([Schema.String, Schema.Number]), 7),
        ).toBe("/7");
        expect(yield* written(Schema.DateFromString, new Date(0))).toBe(
          "/1970-01-01T00%3A00%3A00.000Z",
        );
      }),
    );

    it.effect("takes a plain value in a branded schema", () =>
      Effect.gen(function* () {
        const branded = Request.pathValue(
          "id",
          Schema.String.pipe(Schema.brand("ThingId")),
        );
        expect(
          yield* urlOf(Request.get("").pipe(Request.path`/${branded}`), {
            path: { id: "x" },
          }),
        ).toBe("/x");
      }),
    );

    it.effect("reads a name that JavaScript objects already have", () =>
      Effect.gen(function* () {
        for (const name of ["__proto__", "constructor", "toString", ""]) {
          const value = Request.pathValue(name);
          const request = Request.get("").pipe(Request.path`/${value}`);
          expect(yield* urlOf(request, { path: { [name]: "v" } })).toBe("/v");
          const error = yield* Effect.flip(compile(request, { path: {} }));
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }
      }),
    );

    it.effect("needs the schema's services", () =>
      Effect.gen(function* () {
        const Tenanted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (wire: string) =>
                Effect.gen(function* () {
                  return `${yield* Tenant}:${wire}`;
                }),
              encode: (value: string) => Effect.succeed(value),
            }),
          ),
        );
        const tenanted = Request.pathValue("who", Tenanted);
        const request = Request.get("").pipe(Request.path`/${tenanted}`);
        type Needs = Effect.Services<ReturnType<typeof request.prepare>>;
        expectTypeOf<Needs>().toEqualTypeOf<Tenant>();
        expect(
          yield* urlOf(request, { path: { who: "me" } }).pipe(
            Effect.provideService(Tenant, "t1"),
          ),
        ).toBe("/me");
      }),
    );

    it.effect("refuses a value a schema lets past its type", () =>
      Effect.gen(function* () {
        const loose = Request.pathValue("id", Schema.Any);
        const optional = Request.pathValue(
          "id",
          Schema.optionalKey(Schema.String),
        );
        const cases = [
          [Request.get("").pipe(Request.path`/${loose}`), { id: { a: 1 } }],
          [Request.get("").pipe(Request.path`/${optional}`), {}],
        ] as const;
        for (const [request, path] of cases) {
          const error = yield* Effect.flip(
            compile(request as Request.Request<unknown, unknown>, { path }),
          );
          expect(error).toBeInstanceOf(Request.InvalidRequest);
          expect(error).toHaveProperty(
            "message",
            'The path value "id" did not encode to one value',
          );
        }
      }),
    );
  });

  describe("encodes each value", () => {
    it.effect("with the active path encoder, and never the text", () =>
      Effect.gen(function* () {
        const url = yield* urlOf(
          Request.get("").pipe(Request.path`/a b/${thing}/c d`),
          { path: { id: "x" } },
        ).pipe(
          Effect.provide(
            UrlEncoding.layer({
              ...UrlEncoding.defaults,
              path: (value) => `[${value}]`,
            }),
          ),
        );
        expect(url).toBe("/a b/[x]/c d");
      }),
    );

    it.effect("keeps a value from adding URL syntax of its own", () =>
      Effect.gen(function* () {
        expect(
          yield* targetOf(Request.get("").pipe(Request.path`/${thing}/x`), {
            path: { id: "a/b?c=1#d%20" },
          }),
        ).toEqual({ url: "/a%2Fb%3Fc%3D1%23d%2520/x", hash: undefined });
      }),
    );

    it.effect("fails with InvalidRequest when a value cannot be encoded", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: loneSurrogate },
          }),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.cause).toBeInstanceOf(URIError);
      }),
    );

    it.effect("fails with InvalidRequest when a replaced encoder throws", () =>
      Effect.gen(function* () {
        const refused = new Error("segment refused");
        const error = yield* Effect.flip(
          compile(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: "x" },
          }).pipe(
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
        expect(error.cause).toBe(refused);
      }),
    );

    it.effect(
      "keeps .., an empty value and a quote, which it cannot help",
      () =>
        Effect.gen(function* () {
          const request = Request.get("").pipe(
            Request.path`/Customers('${thing}')`,
          );
          expect(yield* urlOf(request, { path: { id: ".." } })).toBe(
            "/Customers('..')",
          );
          expect(yield* urlOf(request, { path: { id: "" } })).toBe(
            "/Customers('')",
          );
          expect(yield* urlOf(request, { path: { id: "O'Brien" } })).toBe(
            "/Customers('O'Brien')",
          );
          expect(
            yield* urlOf(
              Request.get("").pipe(Request.path`/customers/${thing}/orders/`),
              { path: { id: ".." } },
            ),
          ).toBe("/customers/../orders/");
          expect(
            yield* urlOf(
              Request.get("").pipe(Request.path`/customers/${thing}/orders/`),
              { path: { id: "" } },
            ),
          ).toBe("/customers//orders/");
        }),
    );

    it.effect("leaves constraining a value to its schema", () =>
      Effect.gen(function* () {
        const invoice = Request.pathValue(
          "invoice",
          Schema.TemplateLiteral(["inv-", Schema.Int]),
        );
        const slug = Request.pathValue(
          "slug",
          Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)),
        );
        const request = Request.get("").pipe(
          Request.path`/invoices/${invoice}/${slug}`,
        );
        expect(
          yield* urlOf(request, { path: { invoice: "inv-7", slug: "a-b" } }),
        ).toBe("/invoices/inv-7/a-b");
        for (const path of [
          { invoice: "..", slug: "a-b" },
          { invoice: "inv-7", slug: ".." },
          { invoice: "inv-7", slug: "" },
        ]) {
          const error = yield* Effect.flip(
            compile(request, { path: path as never }),
          );
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }
      }),
    );
  });

  describe("shares the path input with other bindings", () => {
    it.effect("mixes with a struct renderer", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path`/a/${thing}`,
          Request.path(
            Schema.Struct({ rest: Schema.String }),
            ({ rest }, encode) => `/${rest.split("/").map(encode).join("/")}`,
          ),
        );
        expect(
          yield* urlOf(request, { path: { id: "x", rest: "b c/d" } }),
        ).toBe("/a/x/b%20c/d");
      }),
    );

    it.effect("mixes with a class renderer", () =>
      Effect.gen(function* () {
        class Rest extends Schema.Class<Rest>("Rest")({
          rest: Schema.String,
        }) {}
        const request = Request.get("").pipe(
          Request.path(Rest, ({ rest }, encode) => `/${encode(rest)}`),
          Request.path`/a/${thing}`,
        );
        expect(yield* urlOf(request, { path: { id: "x", rest: "b" } })).toBe(
          "/b/a/x",
        );
      }),
    );

    it.effect("gives one value to the same name at two levels", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path`/a/${thing}`,
          Request.path`/b/${thing}`,
        );
        expect(yield* urlOf(request, { path: { id: "x" } })).toBe("/a/x/b/x");
      }),
    );

    it.effect(
      "fails at run time on one name with two schemas in a template",
      () =>
        Effect.gen(function* () {
          const asText = Request.pathValue("id");
          const asNumber = Request.pathValue("id", Schema.Finite);
          const request = Request.get("").pipe(
            Request.path`/a/${asText}/b/${asNumber}`,
          );
          const error = yield* Effect.flip(
            compile(request, { path: { id: 7 } }),
          );
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }),
    );

    it.effect("shares one value between two scalar renderers", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path(Schema.String, (id, encode) => `/a/${encode(id)}`),
          Request.path(Schema.String, (id, encode) => `/b/${encode(id)}`),
        );
        expect(yield* urlOf(request, { path: "x" })).toBe("/a/x/b/x");
      }),
    );
  });

  describe("stays with the renderer for a shape that depends on the value", () => {
    it.effect("a whole URL", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          api,
          Request.path(Schema.String, (href) => href),
        );
        expect(yield* urlOf(request, { path: "https://other.test/x" })).toBe(
          "https://other.test/x",
        );
      }),
    );

    it.effect("a value holding several segments", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path(Schema.String, (value, encode) =>
            value.split("/").map(encode).join("/"),
          ),
        );
        expect(yield* urlOf(request, { path: "/a b/c" })).toBe("/a%20b/c");
      }),
    );

    it.effect("a path that branches on the value", () =>
      Effect.gen(function* () {
        const request = Request.get("/dav").pipe(
          Request.path(Schema.String, (name, encode) =>
            name === "" ? "/" : `/${encode(name)}/`,
          ),
        );
        expect(yield* urlOf(request, { path: "" })).toBe("/dav/");
        expect(yield* urlOf(request, { path: "a b" })).toBe("/dav/a%20b/");
      }),
    );
  });

  describe("types", () => {
    type InputOf<Q> =
      Q extends Request.Request<infer I, infer _E, infer _R> ? I : never;

    it("infers named values, either side of each schema", () => {
      expectTypeOf<InputOf<typeof getCalendar>>().toEqualTypeOf<{
        readonly path: {
          readonly customer: string;
          readonly calendar: string | number;
        };
      }>();
    });

    it("adds a child's names to its parent's", () => {
      const getEvent = getCalendar.pipe(Request.path`/events/${event}`);
      void Request.compile(getEvent, {
        path: { customer: "a", calendar: 7, event: "e" },
      });
      // @ts-expect-error: the parent's names are still required
      void Request.compile(getEvent, { path: { event: "e" } });
      // @ts-expect-error: the child's name is required
      void Request.compile(getEvent, { path: { customer: "a", calendar: 7 } });
    });

    it("keeps the type of a request given only fixed text", () => {
      const request = Request.get("/a").pipe(Request.path`/b`);
      expectTypeOf(request).toEqualTypeOf<Request.Request<unknown>>();
    });

    it("adds its failures to a request with values", () => {
      expectTypeOf<
        Effect.Error<ReturnType<typeof getCalendar.prepare>>
      >().toEqualTypeOf<Schema.SchemaError | Request.InvalidRequest>();
    });

    it("compiles in a generic helper", () => {
      const request = Request.get("").pipe(atName("tenant"));
      void Request.compile(request, { path: { tenant: "a" } });
      // @ts-expect-error: the helper's name is what the input needs
      void Request.compile(request, { path: { tenent: "a" } });
    });

    it("rejects a misspelt or missing name", () => {
      void Request.compile(getCalendar, {
        // @ts-expect-error: the value is named `customer`
        path: { custmer: "a", calendar: 7 },
      });
      // @ts-expect-error: `calendar` is missing
      void Request.compile(getCalendar, { path: { customer: "a" } });
      // @ts-expect-error: the path group is missing
      void Request.compile(getCalendar, {});
      // @ts-expect-error: a template's input is named, not positional
      void Request.compile(getCalendar, { path: ["a", 7] });
    });

    it("rejects a value on neither side of its schema", () => {
      void Request.compile(getCalendar, {
        // @ts-expect-error: a boolean is on neither side of the schema
        path: { customer: "a", calendar: true },
      });
    });

    // These never run, because a definition that does not compile also throws.
    it("rejects anything but a path value in a template", () => {
      const id: string = "a/b";
      const count: number = 7;
      void (() => {
        // @ts-expect-error: a raw string would miss the schema and the encoder
        void Request.path`/x/${id}`;
        // @ts-expect-error: the same with another value next to it
        void Request.path`/x/${id}/y/${customer}`;
        // @ts-expect-error: a number is no more a path value than a string
        void Request.path`/x/${count}`;
        // @ts-expect-error: a schema needs a name, through `Request.pathValue`
        void Request.path`/x/${Schema.String}`;
      });
    });

    it("rejects parentheses in place of a template", () => {
      const id: string = "a/b";
      void (() => {
        // @ts-expect-error: a call with one string is not a template
        void Request.path(`/x/${id}`);
        // @ts-expect-error: a renderer needs its schema
        void Request.path((value: string) => `/x/${value}`);
        // @ts-expect-error: a schema needs its renderer
        void Request.path(Schema.String);
      });
    });

    it("rejects a schema that is not one scalar value", () => {
      // @ts-expect-error: a struct is several values
      void Request.pathValue("a", Schema.Struct({ b: Schema.String }));
      // @ts-expect-error: a list is several values
      void Request.pathValue("a", Schema.Array(Schema.String));
      // @ts-expect-error: a tuple is several values
      void Request.pathValue("a", Schema.Tuple([Schema.String]));
      // @ts-expect-error: a `Date` has no obvious URL text
      void Request.pathValue("a", Schema.Date);
      // @ts-expect-error: `null` is not a value in a path
      void Request.pathValue("a", Schema.NullOr(Schema.String));
      // @ts-expect-error: a path value is never absent
      void Request.pathValue("a", Schema.optional(Schema.String));
      // @ts-expect-error: an unknown value may be anything
      void Request.pathValue("a", Schema.Unknown);
      // @ts-expect-error: a name is text
      void Request.pathValue(7);
    });

    it("rejects a scalar renderer stacked with a template", () => {
      const request = Request.get("").pipe(
        Request.path(Schema.String, (id, encode) => `/${encode(id)}`),
        Request.path`/${thing}`,
      );
      // @ts-expect-error: the input cannot be text and fields at once
      void Request.compile(request, { path: "x" });
      // @ts-expect-error: the input cannot be fields and text at once
      void Request.compile(request, { path: { id: "x" } });
    });

    it("rejects one name with incompatible types at two levels", () => {
      const asNumber = Request.pathValue("id", Schema.Finite);
      const request = Request.get("").pipe(
        Request.path`/a/${thing}`,
        Request.path`/b/${asNumber}`,
      );
      // @ts-expect-error: no value is both a string and a number
      void Request.compile(request, { path: { id: "x" } });
      // @ts-expect-error: no value is both a number and a string
      void Request.compile(request, { path: { id: 7 } });
    });

    it("still compiles a renderer in a generic helper", () => {
      const request = Request.get("").pipe(taskPath(Schema.String, "/history"));
      void Request.compile(request, { path: "a" });
      // @ts-expect-error: the schema takes text
      void Request.compile(request, { path: 7 });
    });

    it("still infers a renderer's value from its schema", () => {
      const request = Request.get("").pipe(
        Request.path(Schema.Struct({ a: Schema.String }), ({ a }, encode) =>
          encode(a),
        ),
      );
      void Request.compile(request, { path: { a: "x" } });
      void Request.get("").pipe(
        // @ts-expect-error: the schema has no `b`
        Request.path(Schema.Struct({ a: Schema.String }), ({ b }) => b),
      );
    });
  });
});

describe("Request.setPath", () => {
  const id = Request.pathValue("id");

  it.effect("replaces the constructor's path and keeps the bindings", () =>
    Effect.gen(function* () {
      const current = Request.get("/customers").pipe(Request.path`/${id}/a`);
      const moved = current.pipe(Request.setPath("/people"));
      const input = { path: { id: "x" } };
      expect(yield* urlOf(moved, input)).toBe("/people/x/a");
      expect(yield* urlOf(current, input)).toBe("/customers/x/a");
    }),
  );

  it.effect("keeps the constructor's query and fragment", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/a?wsdl#top").pipe(Request.setPath("/b")),
          undefined,
        ),
      ).toEqual({ url: "/b?wsdl", hash: "top" });
    }),
  );

  it.effect("treats a ? or # as URL text, as a template does", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/a?q=1").pipe(Request.setPath("/b?x=1#y")),
          undefined,
        ),
      ).toEqual({ url: "/b?x=1&q=1", hash: "y" });
    }),
  );

  it.effect("wins over an earlier call, and can empty the path", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/a").pipe(Request.setPath("/b"), Request.setPath("/c")),
          undefined,
        ),
      ).toBe("/c");
      expect(
        yield* urlOf(
          Request.get("/a").pipe(
            Request.baseUrl("https://api.test/v1"),
            Request.setPath(""),
          ),
          undefined,
        ),
      ).toBe("https://api.test/v1");
    }),
  );

  it("keeps the request's type", () => {
    const request = Request.get("/a").pipe(Request.path`/${id}`);
    expectTypeOf(request.pipe(Request.setPath("/b"))).toEqualTypeOf(request);
  });
});

describe("Request.unbind and the path", () => {
  const api = Request.baseUrl("https://api.test/v1");
  const id = Request.pathValue("id");
  const count = Request.pathValue("count", Schema.FiniteFromString);
  const parent = Request.get("/customers").pipe(
    api,
    Request.path`/${id}/calendars/${count}`,
  );

  it.effect("removes the values and the text a template added", () =>
    Effect.gen(function* () {
      const request = parent.pipe(Request.unbind("path"));
      expectTypeOf(request).toEqualTypeOf<
        Request.Request<unknown, Schema.SchemaError | Request.InvalidRequest>
      >();
      expect(yield* urlOf(request, undefined)).toBe(
        "https://api.test/v1/customers",
      );
    }),
  );

  it.effect("removes fixed text and a renderer's text in order", () =>
    Effect.gen(function* () {
      const request = Request.get("/a").pipe(
        Request.path`/b`,
        Request.path(
          Schema.Struct({ c: Schema.String }),
          ({ c }, encode) => `/${encode(c)}`,
        ),
        Request.path`/d`,
        Request.unbind("path"),
        Request.path`/e`,
      );
      expect(yield* urlOf(request, undefined)).toBe("/a/e");
    }),
  );

  it.effect("leaves the input of what comes after it", () =>
    Effect.gen(function* () {
      const request = parent.pipe(
        Request.unbind("path"),
        Request.path`/legacy/${count}`,
      );
      expect(yield* urlOf(request, { path: { count: 7 } })).toBe(
        "https://api.test/v1/customers/legacy/7",
      );
    }),
  );

  it.effect("needs setPath to change the constructor's text", () =>
    Effect.gen(function* () {
      for (const request of [
        parent.pipe(
          Request.unbind("path"),
          Request.setPath("/legacy"),
          Request.path`/${count}`,
        ),
        parent.pipe(
          Request.setPath("/legacy"),
          Request.unbind("path"),
          Request.path`/${count}`,
        ),
      ]) {
        expect(yield* urlOf(request, { path: { count: 7 } })).toBe(
          "https://api.test/v1/legacy/7",
        );
      }
    }),
  );

  it.effect("skips a template under Request.mapInput", () =>
    Effect.gen(function* () {
      const request = Request.get("/a").pipe(
        Request.path`/${id}`,
        Request.mapInput((value: string) => ({ path: { id: value } })),
        Request.unbind("path"),
      );
      expect(yield* urlOf(request, "x")).toBe("/a");
    }),
  );

  it.effect("makes a variant from a named transform", () =>
    Effect.gen(function* () {
      const toLegacyPath = flow(
        Request.unbind("path"),
        Request.setPath(""),
        Request.path`/legacy/calendars/${count}`,
      );
      expect(yield* urlOf(toLegacyPath(parent), { path: { count: 7 } })).toBe(
        "https://api.test/v1/legacy/calendars/7",
      );
    }),
  );
});

/** A time of day, which an application keeps as a value of its own. */
class Moment {
  constructor(readonly minutes: number) {}
}
const MomentFromSelf = Schema.declare(
  (input): input is Moment => input instanceof Moment,
);
const notMoment = (input: string | number) =>
  Effect.fail(
    new SchemaIssue.InvalidValue({ message: `not a moment: ${input}` }),
  );
const twoDigits = (value: number) => String(value).padStart(2, "0");
/** Reads `t1530` and `15:30`, and always writes `15:30:00`. */
const MomentFromString = Schema.String.pipe(
  Schema.decodeTo(MomentFromSelf, {
    decode: SchemaGetter.transformEffect((text: string) => {
      const match = /^t?(\d\d):?(\d\d)/i.exec(text);
      return match === null
        ? notMoment(text)
        : Effect.succeed(new Moment(Number(match[1]) * 60 + Number(match[2])));
    }),
    encode: SchemaGetter.transform(
      (moment: Moment) =>
        `${twoDigits(Math.floor(moment.minutes / 60))}:${twoDigits(moment.minutes % 60)}:00`,
    ),
  }),
);
/** Encodes to a number, so a default written as text is read as one first. */
const MomentFromNumber = Schema.Number.pipe(
  Schema.decodeTo(MomentFromSelf, {
    decode: SchemaGetter.transformEffect((minutes: number) =>
      Number.isInteger(minutes) && minutes >= 0
        ? Effect.succeed(new Moment(minutes))
        : notMoment(minutes),
    ),
    encode: SchemaGetter.transform((moment: Moment) => moment.minutes),
  }),
);

/** A generic path binding, a form that must keep compiling. */
const pathOf = <S extends Schema.Top>(schema: S) =>
  Request.path(schema, () => "/x");

/** The same bound by `Schema.Constraint`, which has no constructor. */
const pathOfConstraint = <S extends Schema.Constraint>(schema: S) =>
  // @ts-expect-error: only `Schema.Top` has `makeEffect`
  Request.path(schema, () => "/x");

// https://github.com/viell-dev/slop-effect-schema-http/issues/91
describe("a schema's value is built before it is encoded", () => {
  class Filter extends Schema.Class<Filter>("Filter")({
    page: Schema.NumberFromString,
  }) {}
  class Trace extends Schema.Class<Trace>("Trace")({
    "X-Trace": Schema.String,
  }) {}
  class Key extends Schema.Class<Key>("Key")({ id: Schema.NumberFromString }) {
    get path() {
      return `/things/${this.id}`;
    }
  }
  const byKey = Request.path(Key, ({ id }, encode) => `/things/${encode(id)}`);

  it.effect("takes a plain object for a class in each binding", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("/x").pipe(Request.query(Filter)), {
          query: { page: 2 },
        }),
      ).toBe("/x?page=2");
      expect(
        yield* linesOf(Request.get("/x").pipe(Request.headers(Trace)), {
          headers: { "X-Trace": "t" },
        }),
      ).toEqual([["X-Trace", "t"]]);
      expect(
        yield* urlOf(Request.get("").pipe(byKey), { path: { id: 7 } }),
      ).toBe("/things/7");
    }),
  );

  it.effect("takes an existing instance in each binding", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("/x").pipe(Request.query(Filter)), {
          query: new Filter({ page: 2 }),
        }),
      ).toBe("/x?page=2");
      expect(
        yield* linesOf(Request.get("/x").pipe(Request.headers(Trace)), {
          headers: new Trace({ "X-Trace": "t" }),
        }),
      ).toEqual([["X-Trace", "t"]]);
      expect(
        yield* urlOf(Request.get("").pipe(byKey), {
          path: new Key({ id: 7 }),
        }),
      ).toBe("/things/7");
    }),
  );

  it.effect("takes a plain object for a class nested in a struct", () =>
    Effect.gen(function* () {
      const request = Request.post("/x").pipe(
        Request.body(
          Body.jsonSchema(
            Schema.Struct({ filter: Filter, size: Schema.Number }),
          ),
        ),
      );
      const compiled = yield* compile(request, {
        body: { filter: { page: 2 }, size: 1 },
      });
      expect(bodyText(compiled.request)).toBe(
        '{"filter":{"page":"2"},"size":1}',
      );
    }),
  );

  it.effect("fails with SchemaError before anything else happens", () =>
    Effect.gen(function* () {
      let prepared = 0;
      const request = Request.get("/x").pipe(
        Request.mapEffect((native) =>
          Effect.sync(() => {
            prepared++;
            return native;
          }),
        ),
        Request.query(Filter),
      );
      const error = yield* Effect.flip(
        compile(request, { query: { page: true as never } }),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
      expect(prepared).toBe(0);
    }),
  );

  it.effect("fills in a field with a constructor default", () =>
    Effect.gen(function* () {
      const Paging = Schema.Struct({
        limit: Schema.FiniteFromString.pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
      });
      const request = Request.get("/x").pipe(Request.query(Paging));
      expect(yield* urlOf(request, { query: {} })).toBe("/x?limit=25");
      expect(yield* urlOf(request, { query: { limit: 5 } })).toBe("/x?limit=5");
    }),
  );

  it.effect("stacks classes and structs on one input", () =>
    Effect.gen(function* () {
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ a: Schema.String })),
        Request.query(Filter),
      );
      expect(yield* urlOf(request, { query: { a: "1", page: 2 } })).toBe(
        "/x?a=1&page=2",
      );
    }),
  );

  it("takes the constructor's input in the type", () => {
    const query = Request.get("/x").pipe(Request.query(Filter));
    expectTypeOf<{ readonly page: number }>().toExtend<
      Parameters<typeof query.prepare>[0]["query"]
    >();
    const path = Request.get("/x").pipe(byKey);
    void Request.compile(path, { path: { id: 7 } });
    // @ts-expect-error: the field is missing
    void Request.compile(path, { path: {} });
  });

  it("needs a full schema, so a generic helper is bound by Schema.Top", () => {
    void pathOf(Schema.String);
    void pathOfConstraint;
  });
});

const reverse = (text: string) => Array.from(text).toReversed().join("");

/** A generic helper that names the input of its schema, a form that must keep compiling. */
const encodeBody = <S extends Schema.Top>(schema: S, value: Request.Input<S>) =>
  Body.jsonSchema(schema).encode(value);

// https://github.com/viell-dev/slop-effect-schema-http/issues/113
describe("a schema-backed input takes either side of its schema", () => {
  const MomentFromDate = Schema.Date.pipe(
    Schema.decodeTo(MomentFromSelf, {
      decode: SchemaGetter.transform(
        (date: Date) => new Moment(date.getTime()),
      ),
      encode: SchemaGetter.transform(
        (moment: Moment) => new Date(moment.minutes),
      ),
    }),
  );
  const Limit = Schema.Struct({ limit: Schema.FiniteFromString });
  const limited = Request.get("/things").pipe(Request.query(Limit));
  /** Both sides are text, so its two readings of a value cannot be told apart. */
  const Reversed = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform(reverse),
      encode: SchemaGetter.transform(reverse),
    }),
  );

  it.effect(
    "gives the same request from the decoded and the encoded side",
    () =>
      Effect.gen(function* () {
        expect(yield* urlOf(limited, { query: { limit: 5 } })).toBe(
          "/things?limit=5",
        );
        expect(yield* urlOf(limited, { query: { limit: "5" } })).toBe(
          "/things?limit=5",
        );
      }),
  );

  it.effect("takes a mix by field", () =>
    Effect.gen(function* () {
      const Picked = Schema.Struct({
        at: MomentFromString,
        limit: Schema.FiniteFromString,
        name: Schema.optional(Schema.String),
      });
      const request = Request.get("/slots").pipe(Request.query(Picked));
      const expected = "/slots?at=15%3A30%3A00&limit=5";
      expect(
        yield* urlOf(request, { query: { at: new Moment(930), limit: 5 } }),
      ).toBe(expected);
      expect(
        yield* urlOf(request, { query: { at: "15:30", limit: "5" } }),
      ).toBe(expected);
      expect(yield* urlOf(request, { query: { at: "t1530", limit: 5 } })).toBe(
        expected,
      );
      expect(
        yield* urlOf(request, { query: { at: new Moment(930), limit: "5" } }),
      ).toBe(expected);
    }),
  );

  it.effect("takes a schema's own type on either side, such as a Date", () =>
    Effect.gen(function* () {
      const noon = new Date("2026-11-07T12:00:00.000Z");
      const request = Request.post("/slots").pipe(
        Request.body(Body.jsonSchema(Schema.Struct({ from: MomentFromDate }))),
      );
      for (const from of [noon, new Moment(noon.getTime())]) {
        const compiled = yield* compile(request, { body: { from } });
        expect(bodyText(compiled.request)).toBe(
          '{"from":"2026-11-07T12:00:00.000Z"}',
        );
      }
    }),
  );

  it.effect("takes a value a decoder accepts and writes what it writes", () =>
    Effect.gen(function* () {
      expect(yield* urlOf(limited, { query: { limit: "05" } })).toBe(
        "/things?limit=5",
      );
      const Loose = Schema.Union([Schema.String, Schema.Number]).pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value: string | number) =>
            String(value),
          ),
          encode: SchemaGetter.passthrough(),
        }),
      );
      const request = Request.get("/things").pipe(
        Request.query(Schema.Struct({ id: Loose })),
      );
      expect(yield* urlOf(request, { query: { id: 7 } })).toBe("/things?id=7");
      expect(yield* urlOf(request, { query: { id: "7" } })).toBe(
        "/things?id=7",
      );
    }),
  );

  it.effect("validates both routes, so text cannot get past a schema", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(limited, { query: { limit: "many" } }),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  it.effect("reports the decoded side's error when every route fails", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(limited, { query: { limit: "many" } }),
      );
      expect(String(error)).toContain("Expected number");
      expect(String(error)).toContain('"limit"');
    }),
  );

  it.effect(
    "lets a weak schema through, as that is the definition's choice",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Schema.Struct({ limit: Schema.NumberFromString })),
        );
        expect(yield* urlOf(request, { query: { limit: "many" } })).toBe(
          "/things?limit=NaN",
        );
      }),
  );

  describe("when both sides share a type", () => {
    const Coded = Schema.Struct({ code: Reversed });
    const coded = Request.get("/things").pipe(Request.query(Coded));

    it.effect("reads a value as decoded, so it is encoded once", () =>
      Effect.gen(function* () {
        expect(yield* urlOf(coded, { query: { code: "abc" } })).toBe(
          "/things?code=cba",
        );
      }),
    );

    it.effect("encodes an already encoded value again, with no error", () =>
      Effect.gen(function* () {
        expect(yield* urlOf(coded, { query: { code: "cba" } })).toBe(
          "/things?code=abc",
        );
      }),
    );

    it.effect(
      "reads the value as encoded when the group only fits that way",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things").pipe(
            Request.query(
              Schema.Struct({ code: Reversed, limit: Schema.FiniteFromString }),
            ),
          );
          expect(
            yield* urlOf(request, { query: { code: "cba", limit: 5 } }),
          ).toBe("/things?code=abc&limit=5");
          expect(
            yield* urlOf(request, { query: { code: "cba", limit: "5" } }),
          ).toBe("/things?code=cba&limit=5");
        }),
    );

    it.effect(
      "keeps a default on its encoded side, as it is written text",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things?code=cba").pipe(
            Request.query(Schema.Struct({ code: Schema.optional(Reversed) })),
          );
          expect(yield* urlOf(request, { query: {} })).toBe("/things?code=cba");
        }),
    );
  });

  describe("the forms of a schema", () => {
    it.effect("takes a renamed field by its encoded name, with the rest", () =>
      Effect.gen(function* () {
        const Paging = Schema.Struct({
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
        }).pipe(Schema.encodeKeys({ page: "page_number" }));
        const request = Request.get("/things").pipe(Request.query(Paging));
        const expected = "/things?page_number=2&size=5";
        expect(yield* urlOf(request, { query: { page: 2, size: 5 } })).toBe(
          expected,
        );
        expect(
          yield* urlOf(request, { query: { page_number: "2", size: "5" } }),
        ).toBe(expected);
        expect(yield* urlOf(request, { query: { page: 2, size: "5" } })).toBe(
          expected,
        );
      }),
    );

    it.effect("takes each side of a class, and a mix by field", () =>
      Effect.gen(function* () {
        class Filter extends Schema.Class<Filter>("Filter")({
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
        }) {}
        const request = Request.get("/things").pipe(Request.query(Filter));
        const expected = "/things?page=2&size=5";
        for (const query of [
          new Filter({ page: 2, size: 5 }),
          { page: 2, size: 5 },
          { page: "2", size: "5" },
          { page: 2, size: "5" },
        ]) {
          expect(yield* urlOf(request, { query })).toBe(expected);
        }
      }),
    );

    it.effect("takes each side of a union, and a mix within one member", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("page"),
            page: Schema.FiniteFromString,
            size: Schema.FiniteFromString,
          }),
          Schema.Struct({
            kind: Schema.Literal("cursor"),
            cursor: Schema.String,
          }),
        ]);
        const request = Request.get("/things").pipe(Request.query(Either));
        const expected = "/things?kind=page&page=2&size=5";
        for (const query of [
          { kind: "page", page: 2, size: 5 },
          { kind: "page", page: "2", size: "5" },
          { kind: "page", page: 2, size: "5" },
        ] as const) {
          expect(yield* urlOf(request, { query })).toBe(expected);
        }
        expect(
          yield* urlOf(request, { query: { kind: "cursor", cursor: "c" } }),
        ).toBe("/things?kind=cursor&cursor=c");
      }),
    );

    it.effect("takes a field that is a class on either of its sides", () =>
      Effect.gen(function* () {
        class Stamp extends Schema.Class<Stamp>("Stamp")({
          at: Schema.DateFromString,
        }) {}
        const request = Request.post("/things").pipe(
          Request.body(
            Body.jsonSchema(
              Schema.Struct({ stamp: Stamp, size: Schema.FiniteFromString }),
            ),
          ),
        );
        const at = "2026-11-07T12:00:00.000Z";
        const expected = `{"stamp":{"at":"${at}"},"size":"5"}`;
        for (const body of [
          { stamp: new Stamp({ at: new Date(at) }), size: 5 },
          { stamp: { at }, size: "5" },
          { stamp: { at }, size: 5 },
        ]) {
          const compiled = yield* compile(request, { body });
          expect(bodyText(compiled.request)).toBe(expected);
        }
      }),
    );

    it.effect("fills in a tagged class's tag on a mix", () =>
      Effect.gen(function* () {
        class Tagged extends Schema.TaggedClass<Tagged>()("Tagged", {
          page: Schema.FiniteFromString,
        }) {}
        const request = Request.get("/things").pipe(Request.query(Tagged));
        for (const query of [
          { page: 1 },
          { _tag: "Tagged", page: "1" },
        ] as const) {
          expect(yield* urlOf(request, { query })).toBe(
            "/things?_tag=Tagged&page=1",
          );
        }
      }),
    );

    it.effect("fills in a constructor default on a mix", () =>
      Effect.gen(function* () {
        const Paging = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
        });
        const request = Request.get("/things").pipe(Request.query(Paging));
        expect(yield* urlOf(request, { query: { page: "2", size: 5 } })).toBe(
          "/things?limit=25&page=2&size=5",
        );
      }),
    );

    it.effect("leaves out an optional field a mix leaves undefined", () =>
      Effect.gen(function* () {
        const Paging = Schema.Struct({
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
          name: Schema.optional(Schema.FiniteFromString),
        });
        const request = Request.get("/things").pipe(Request.query(Paging));
        expect(
          yield* urlOf(request, {
            query: { page: "2", size: 5, name: undefined },
          }),
        ).toBe("/things?page=2&size=5");
      }),
    );
  });

  it.effect("applies to headers, paths and path structs", () =>
    Effect.gen(function* () {
      const headers = Request.get("/a").pipe(
        Request.headers(Schema.Struct({ "x-limit": Schema.FiniteFromString })),
      );
      for (const value of [5, "5"]) {
        expect(
          yield* linesOf(headers, { headers: { "x-limit": value } }),
        ).toEqual([["x-limit", "5"]]);
      }
      const scalar = Request.get("").pipe(
        Request.path(
          Schema.FiniteFromString,
          (id, encode) => `/things/${encode(id)}`,
        ),
      );
      const struct = Request.get("").pipe(
        Request.path(
          Schema.Struct({ id: Schema.FiniteFromString }),
          ({ id }, encode) => `/things/${encode(id)}`,
        ),
      );
      for (const id of [7, "7", "07"]) {
        expect(yield* urlOf(scalar, { path: id })).toBe("/things/7");
        expect(yield* urlOf(struct, { path: { id } })).toBe("/things/7");
      }
    }),
  );

  it.effect("reaches every stacked schema from one input", () =>
    Effect.gen(function* () {
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ a: Schema.FiniteFromString })),
        Request.query(Schema.Struct({ b: Schema.FiniteFromString })),
      );
      expect(yield* urlOf(request, { query: { a: 1, b: "2" } })).toBe(
        "/x?a=1&b=2",
      );
    }),
  );

  it.effect(
    "meets a default the same way, whichever side the caller gives",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/x?size=2").pipe(
          Request.query(
            Schema.Struct({
              page: Schema.FiniteFromString,
              size: Schema.optional(Schema.FiniteFromString),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: { page: 1 } })).toBe(
          "/x?page=1&size=2",
        );
        expect(yield* urlOf(request, { query: { page: "1" } })).toBe(
          "/x?page=1&size=2",
        );
      }),
  );

  it.effect(
    "needs decoding services only for a value that takes that route",
    () =>
      Effect.gen(function* () {
        const Tenanted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (wire: string) =>
                Effect.gen(function* () {
                  return `${yield* Tenant}:${wire}`;
                }),
              encode: (value: string) => Effect.succeed(value),
            }),
          ),
        );
        const Who = Schema.Struct({
          who: Tenanted,
          limit: Schema.FiniteFromString,
        });
        const request = Request.get("/x").pipe(Request.query(Who));
        type Needs = Effect.Services<ReturnType<typeof request.prepare>>;
        expectTypeOf<Needs>().toEqualTypeOf<Tenant>();
        expect(
          yield* urlOf(request, { query: { who: "me", limit: "1" } }).pipe(
            Effect.provideService(Tenant, "t1"),
          ),
        ).toBe("/x?who=t1%3Ame&limit=1");
      }),
  );

  describe("types", () => {
    const Paged = Schema.Struct({
      page: Schema.FiniteFromString,
      name: Schema.String,
    });
    const paged = Request.get("/x").pipe(Request.query(Paged));

    it("accepts each side and a mix", () => {
      void Request.compile(paged, { query: { page: 1, name: "a" } });
      void Request.compile(paged, { query: { page: "1", name: "a" } });
    });

    it("rejects a value on neither side", () => {
      // @ts-expect-error: a boolean is on neither side of the schema
      void Request.compile(paged, { query: { page: true, name: "a" } });
      // @ts-expect-error: a field is missing on every side
      void Request.compile(paged, { query: { page: 1 } });
      void Request.compile(
        Request.get("/x").pipe(Request.path(Schema.Date, () => "/x")),
        // @ts-expect-error: `Schema.Date` encodes to a `Date`, so text is on neither side
        { path: "2026-11-07" },
      );
    });

    it("stays the plain shape when both sides are the same", () => {
      expectTypeOf<
        Request.Input<typeof Schema.String>
      >().toEqualTypeOf<string>();
      const Same = Schema.Struct({ a: Schema.String });
      expectTypeOf<Request.Input<typeof Same>>().toEqualTypeOf<{
        readonly a: string;
      }>();
    });

    it("is either side for a scalar", () => {
      expectTypeOf<
        Request.Input<typeof Schema.FiniteFromString>
      >().toEqualTypeOf<number | string>();
    });

    it("has no mix for a list, which has no fields", () => {
      const Ids = Schema.Array(Schema.FiniteFromString);
      expectTypeOf<Request.Input<typeof Ids>>().toEqualTypeOf<
        ReadonlyArray<number> | ReadonlyArray<string>
      >();
    });

    it("lets a generic helper name the input of a schema", () => {
      void encodeBody(Schema.FiniteFromString, "5");
      // @ts-expect-error: a boolean is on neither side of the schema
      void encodeBody(Schema.FiniteFromString, true);
    });

    it("lets a plain value into a branded field, on the encoded side", () => {
      const Id = Schema.String.pipe(Schema.brand("Id"));
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ id: Id })),
      );
      void Request.compile(request, { query: { id: Id.make("a") } });
      void Request.compile(request, { query: { id: "a" } });
    });

    describe("what each schema takes", () => {
      const Optional = Schema.Struct({
        limit: Schema.optional(Schema.FiniteFromString),
      });

      it("is one object where the mix takes all that each side does", () => {
        expectTypeOf<Request.Input<typeof Optional>>().toEqualTypeOf<{
          readonly limit?: string | number | undefined;
        }>();
        const Group = Schema.Struct({
          page: Schema.FiniteFromString,
          from: Schema.optional(Schema.DateFromString),
          name: Schema.String,
        });
        expectTypeOf<Request.Input<typeof Group>>().toEqualTypeOf<{
          readonly page: string | number;
          readonly from?: string | Date | undefined;
          readonly name: string;
        }>();
        const Defaulted = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        });
        expectTypeOf<Request.Input<typeof Defaulted>>().toEqualTypeOf<{
          readonly limit?: string | number;
        }>();
      });

      it("keeps each side where the mix does not take all that it does", () => {
        const Renamed = Schema.Struct({
          page: Schema.optional(Schema.FiniteFromString),
          size: Schema.optional(Schema.FiniteFromString),
        }).pipe(Schema.encodeKeys({ page: "page_number" }));
        expectTypeOf<{
          readonly page_number?: string | undefined;
          readonly size?: string | undefined;
        }>().toExtend<Request.Input<typeof Renamed>>();
        expectTypeOf<Request.Input<typeof Renamed>>().toEqualTypeOf<
          | {
              readonly page?: number | undefined;
              readonly size?: number | undefined;
            }
          | {
              readonly page_number?: string | undefined;
              readonly size?: string | undefined;
            }
          | {
              readonly page?: number | undefined;
              readonly size?: string | number | undefined;
            }
        >();
        const Defaulted = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("25")),
          ),
        });
        expectTypeOf<Request.Input<typeof Defaulted>>().toEqualTypeOf<
          | { readonly limit: number }
          | { readonly limit?: string }
          | { readonly limit: string | number | undefined }
        >();
      });

      it("takes each side of an optional field", () => {
        const input = takes(Optional);
        input({});
        input({ limit: 1 });
        input({ limit: "1" });
        input({ limit: undefined });
        // @ts-expect-error: a boolean is on neither side
        input({ limit: true });
        // @ts-expect-error: no side has this field
        input({ other: 1 });
        // @ts-expect-error: no side has this field, whatever else is there
        input({ limit: 1, other: 1 });
      });

      it("takes each side of a required field, and a mix", () => {
        const input = takes(
          Schema.Struct({
            a: Schema.FiniteFromString,
            b: Schema.FiniteFromString,
          }),
        );
        input({ a: 1, b: 2 });
        input({ a: "1", b: "2" });
        input({ a: 1, b: "2" });
        input({ a: "1", b: 2 });
        // @ts-expect-error: `b` is required on both sides
        input({ a: 1 });
        // @ts-expect-error: a boolean is on neither side
        input({ a: 1, b: true });
      });

      it("takes a renamed field under one name per side", () => {
        const input = takes(
          Schema.Struct({
            page: Schema.FiniteFromString,
            size: Schema.FiniteFromString,
          }).pipe(Schema.encodeKeys({ page: "page_number" })),
        );
        input({ page: 1, size: 2 });
        input({ page: 1, size: "2" });
        input({ page_number: "1", size: "2" });
        // @ts-expect-error: a mix cannot use an encoded name
        input({ page_number: "1", size: 2 });
        // @ts-expect-error: the decoded name takes only the decoded value
        input({ page: "1", size: 2 });
        // @ts-expect-error: the encoded name takes only the encoded value
        input({ page_number: 1, size: "2" });
      });

      it("takes an encoded name when every field is optional", () => {
        const input = takes(
          Schema.Struct({
            page: Schema.optional(Schema.FiniteFromString),
            size: Schema.optional(Schema.FiniteFromString),
          }).pipe(Schema.encodeKeys({ page: "page_number" })),
        );
        input({});
        input({ page: 1 });
        input({ size: 2 });
        input({ size: "2" });
        input({ page_number: "1" });
        input({ page_number: "1", size: "2" });
        // @ts-expect-error: the encoded name takes only the encoded value
        input({ page_number: 1 });
        // @ts-expect-error: no side has this field
        input({ other: "1" });
      });

      it("keeps the encoded side where a decoding default leaves a field out", () => {
        const input = takes(
          Schema.Struct({
            limit: Schema.FiniteFromString.pipe(
              Schema.withDecodingDefaultKey(Effect.succeed("25")),
            ),
          }),
        );
        input({});
        input({ limit: 1 });
        input({ limit: "1" });
        // @ts-expect-error: a boolean is on neither side
        input({ limit: true });
      });

      it("lets a constructor default leave a field out", () => {
        const input = takes(
          Schema.Struct({
            limit: Schema.FiniteFromString.pipe(
              Schema.withConstructorDefault(Effect.succeed(25)),
            ),
          }),
        );
        input({});
        input({ limit: 1 });
        input({ limit: "1" });
        // @ts-expect-error: a boolean is on neither side
        input({ limit: true });
      });

      it("takes a class's fields, or an instance of it", () => {
        class Filter extends Schema.Class<Filter>("Filter")({
          page: Schema.FiniteFromString,
          tag: Schema.optional(Schema.String),
        }) {
          get first() {
            return this.page === 1;
          }
        }
        const input = takes(Filter);
        input({ page: 1 });
        input({ page: "1", tag: "a" });
        input(new Filter({ page: 1 }));
        // @ts-expect-error: `page` is required on both sides
        input({});
        // @ts-expect-error: a boolean is on neither side
        input({ page: true });
        // @ts-expect-error: no side has this field
        input({ page: 1, other: 1 });
      });

      it("takes a `Date` or its text only where the encoded side is text", () => {
        const text = takes(Schema.Struct({ from: Schema.DateFromString }));
        text({ from: new Date(0) });
        text({ from: "2026-11-07" });
        // @ts-expect-error: a number is on neither side
        text({ from: 1 });
        const value = takes(Schema.Struct({ from: Schema.Date }));
        value({ from: new Date(0) });
        // @ts-expect-error: `Schema.Date` encodes to a `Date`, so text is on neither side
        value({ from: "2026-11-07" });
        const scalar = takes(Schema.DateFromString);
        scalar(new Date(0));
        scalar("2026-11-07");
        // @ts-expect-error: a number is on neither side
        scalar(1);
      });

      it("takes an application type, or the `Date` it encodes to", () => {
        const input = takes(
          Schema.Struct({ from: Schema.DateTimeUtcFromDate }),
        );
        input({ from: DateTime.makeUnsafe(0) });
        input({ from: new Date(0) });
        // @ts-expect-error: text is on neither side
        input({ from: "2026-11-07" });
      });

      it("takes each member of a union, on either side", () => {
        const input = takes(
          Schema.Union([
            Schema.Struct({
              kind: Schema.Literal("a"),
              n: Schema.FiniteFromString,
            }),
            Schema.Struct({
              kind: Schema.Literal("b"),
              m: Schema.optional(Schema.FiniteFromString),
            }),
          ]),
        );
        input({ kind: "a", n: 1 });
        input({ kind: "a", n: "1" });
        input({ kind: "b" });
        input({ kind: "b", m: "1" });
        // @ts-expect-error: a boolean is on neither side
        input({ kind: "a", n: true });
        // @ts-expect-error: no member has this field
        input({ kind: "b", other: 1 });
      });

      it("takes a member's encoded name under a union", () => {
        const input = takes(
          Schema.Union([
            Schema.Struct({ a: Schema.optional(Schema.FiniteFromString) }),
            Schema.Struct({
              b: Schema.optional(Schema.FiniteFromString),
              c: Schema.optional(Schema.FiniteFromString),
            }).pipe(Schema.encodeKeys({ b: "encoded_b" })),
          ]),
        );
        input({ a: "1" });
        input({ b: 1 });
        input({ encoded_b: "1" });
        input({ encoded_b: "1", c: "2" });
        // @ts-expect-error: no member has this field
        input({ other: "1" });
      });

      it("takes each side of a record and of a struct with rest", () => {
        const record = takes(
          Schema.Record(Schema.String, Schema.FiniteFromString),
        );
        record({ a: 1 });
        record({ a: "1" });
        record({ a: 1, b: "2" });
        // @ts-expect-error: a boolean is on neither side
        record({ a: true });
        const rest = takes(
          Schema.StructWithRest(Schema.Struct({ a: Schema.FiniteFromString }), [
            Schema.Record(
              Schema.String,
              Schema.Union([Schema.Number, Schema.String]),
            ),
          ]),
        );
        rest({ a: 1, b: 2 });
        rest({ a: "1", b: "2" });
        // @ts-expect-error: `a` is required on both sides
        rest({ b: 2 });
      });

      it("takes a nested struct's fields, side by side", () => {
        const input = takes(
          Schema.Struct({
            nested: Schema.Struct({ n: Schema.FiniteFromString }),
          }),
        );
        input({ nested: { n: 1 } });
        input({ nested: { n: "1" } });
        // @ts-expect-error: a boolean is on neither side
        input({ nested: { n: true } });
        // @ts-expect-error: no side has this field
        input({ nested: { n: 1, other: 1 } });
      });
    });
  });
});

/** A native edit under a name, outside any schema's check. */
const appendTrace = (value: string) =>
  Request.mapEffect((request) =>
    Effect.succeed(HttpClientRequest.appendUrlParam(request, "trace", value)),
  );

/** Shared raw fields inside a generic function, a form that must keep compiling. */
const withService = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(
    Request.setQuery("key", "abc"),
    Request.setHeader("X-Key", "abc"),
    Request.baseUrl("https://api.test"),
  );

/** `Request.unbind` inside a generic function, a form that must keep compiling. */
const withoutQuery = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(Request.unbind("query"));

// https://github.com/viell-dev/slop-effect-schema-http/issues/87
// https://github.com/viell-dev/slop-effect-schema-http/issues/134
describe("a caller's field under a union", () => {
  const text = Schema.String;
  const NarrowFirst = Schema.Union([
    Schema.Struct({ a: text }),
    Schema.Struct({ a: text, b: text }),
  ]);
  const Apart = Schema.Union([
    Schema.Struct({ a: text }),
    Schema.Struct({ b: text }),
  ]);
  const Numbers = Schema.Union([
    Schema.Struct({ n: Schema.FiniteFromString }),
    Schema.Struct({ n: Schema.FiniteFromString, d: Schema.FiniteFromString }),
  ]);

  describe("a member that keeps every field wins", () => {
    it.effect("over an earlier member that strips one", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(queried(NarrowFirst), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("whatever the order of the members", () =>
      Effect.gen(function* () {
        const WideFirst = Schema.Union([
          Schema.Struct({ a: text, b: text }),
          Schema.Struct({ a: text }),
        ]);
        for (const query of [{ a: "x", b: "y" }, { a: "x" }])
          expect(yield* urlOf(queried(WideFirst), { query })).toBe(
            yield* urlOf(queried(NarrowFirst), { query }),
          );
      }),
    );

    it.effect("so a default no longer takes the caller's place", () =>
      Effect.gen(function* () {
        const request = Request.get("/x?b=1").pipe(Request.query(NarrowFirst));
        expect(yield* urlOf(request, { query: { a: "x", b: "y" } })).toBe(
          "/x?a=x&b=y",
        );
        expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x&b=1");
      }),
    );

    it.effect("on the decoded side, the encoded side, and a mix", () =>
      Effect.gen(function* () {
        for (const query of [
          { n: 1, d: 2 },
          { n: "1", d: "2" },
          { n: 1, d: "2" },
          { n: "1", d: 2 },
        ])
          expect(yield* urlOf(queried(Numbers), { query })).toBe("/x?n=1&d=2");
      }),
    );

    it.effect("when the encoded step alone would strip it", () =>
      Effect.gen(function* () {
        class Base extends Schema.Class<Base>("Base")({ a: text }) {}
        class Derived extends Base.extend<Derived>("Derived")({ b: text }) {}
        const request = queried(Schema.Union([Base, Derived]));
        // A `Derived` is a `Base`, so a value already built fits the first member as it stands.
        expect(
          yield* urlOf(request, { query: new Derived({ a: "x", b: "y" }) }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("when that member is a record", () =>
      Effect.gen(function* () {
        const Open = Schema.Union([
          Schema.Struct({ a: text }),
          Schema.Record(text, text),
        ]);
        expect(yield* urlOf(queried(Open), { query: { a: "x", b: "y" } })).toBe(
          "/x?a=x&b=y",
        );
      }),
    );

    it.effect("inside a union of unions", () =>
      Effect.gen(function* () {
        const Nested = Schema.Union([NarrowFirst, Schema.Struct({ c: text })]);
        expect(
          yield* urlOf(queried(Nested), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=x&b=y");
        expect(yield* urlOf(queried(Nested), { query: { c: "z" } })).toBe(
          "/x?c=z",
        );
      }),
    );

    it.effect("inside text that holds JSON", () =>
      Effect.gen(function* () {
        const request = queried(
          Schema.Struct({ filter: Schema.fromJsonString(NarrowFirst) }),
        );
        const expected = `/x?filter=${encodeURIComponent('{"a":"x","b":"y"}')}`;
        for (const filter of [{ a: "x", b: "y" }, '{"a":"x","b":"y"}'])
          expect(yield* urlOf(request, { query: { filter } })).toBe(expected);
      }),
    );

    it.effect("in headers", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({ "x-a": text }),
          Schema.Struct({ "x-a": text, "x-b": text }),
        ]);
        const request = Request.get("/x").pipe(
          Request.setHeader("X-B", "default"),
          Request.headers(Either),
        );
        expect(
          yield* linesOf(request, { headers: { "x-a": "1", "x-b": "2" } }),
        ).toEqual([
          ["x-a", "1"],
          ["x-b", "2"],
        ]);
      }),
    );

    it.effect("in a path renderer", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path(NarrowFirst, (value) =>
            "b" in value ? `/${value.a}/${value.b}` : `/${value.a}`,
          ),
        );
        expect(yield* urlOf(request, { path: { a: "x", b: "y" } })).toBe(
          "/x/y",
        );
        expect(yield* urlOf(request, { path: { a: "x" } })).toBe("/x");
      }),
    );

    it.effect("in a template value that encodes to text", () =>
      Effect.gen(function* () {
        const filter = Request.pathValue(
          "filter",
          Schema.fromJsonString(NarrowFirst),
        );
        const request = Request.get("").pipe(Request.path`/f/${filter}`);
        expect(
          yield* urlOf(request, { path: { filter: { a: "x", b: "y" } } }),
        ).toBe(`/f/${encodeURIComponent('{"a":"x","b":"y"}')}`);
      }),
    );

    it("takes every field in the type", () => {
      void takes(NarrowFirst)({ a: "x", b: "y" });
      void takes(NarrowFirst)({ a: "x" });
      void takes(Numbers)({ n: 1, d: "2" });
    });
  });

  describe("beside a stacked schema", () => {
    const Sibling = Schema.Struct({ c: text });

    it.effect("a sibling's field does not stop the choice", () =>
      Effect.gen(function* () {
        const input = { query: { a: "x", b: "y", c: "z" } };
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(NarrowFirst),
              Request.query(Sibling),
            ),
            input,
          ),
        ).toBe("/x?a=x&b=y&c=z");
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(Sibling),
              Request.query(NarrowFirst),
            ),
            input,
          ),
        ).toBe("/x?c=z&a=x&b=y");
      }),
    );

    it.effect("two unions each make their own choice", () =>
      Effect.gen(function* () {
        const Other = Schema.Union([
          Schema.Struct({ c: text }),
          Schema.Struct({ c: text, d: text }),
        ]);
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(NarrowFirst),
              Request.query(Other),
            ),
            { query: { a: "x", b: "y", c: "z", d: "w" } },
          ),
        ).toBe("/x?a=x&b=y&c=z&d=w");
      }),
    );

    it.effect("a sibling's field stays out of a member's encoded names", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Union([
          Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ a: text, b: text }).pipe(
            Schema.encodeKeys({ a: "A", b: "B" }),
          ),
        ]);
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(Renamed),
              Request.query(Sibling),
            ),
            { query: { A: "x", B: "y", c: "z" } },
          ),
        ).toBe("/x?A=x&B=y&c=z");
      }),
    );

    it.effect("a field the union cannot hold is still refused", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.query(Apart),
          Request.query(Sibling),
        );
        expect(
          yield* schemaFailure(request, { query: { a: "x", b: "y", c: "z" } }),
        ).toContain('["b"]');
        expect(yield* urlOf(request, { query: { a: "x", c: "z" } })).toBe(
          "/x?a=x&c=z",
        );
      }),
    );

    it.effect("works for headers too", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.headers(
            Schema.Union([
              Schema.Struct({ "x-a": text }),
              Schema.Struct({ "x-a": text, "x-b": text }),
            ]),
          ),
          Request.headers(Schema.Struct({ "x-c": text })),
        );
        expect(
          yield* linesOf(request, {
            headers: { "x-a": "1", "x-b": "2", "x-c": "3" },
          }),
        ).toEqual([
          ["x-a", "1"],
          ["x-b", "2"],
          ["x-c", "3"],
        ]);
      }),
    );

    // A union sees the whole input and cannot tell that a sibling holds a name it states too.
    // https://github.com/viell-dev/slop-effect-schema-http/issues/134
    it.effect("currently refuses a name a sibling also states", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.query(Apart),
          Request.query(Schema.Struct({ b: text })),
        );
        expect(
          yield* schemaFailure(request, { query: { a: "x", b: "y" } }),
        ).toContain('["b"]');
      }),
    );
  });

  describe("a field no member can keep", () => {
    it.effect("is refused before anything is sent, and named", () =>
      Effect.gen(function* () {
        const message = yield* schemaFailure(queried(Apart), {
          query: { a: "secret-a", b: "secret-b" },
        });
        expect(message).toContain("No union member holds this field");
        expect(message).toContain('["b"]');
        expect(message).not.toContain("secret");
      }),
    );

    it.effect("is refused in headers and in a path", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({ "x-a": text }),
          Schema.Struct({ "x-b": text }),
        ]);
        const headers = Request.get("/x").pipe(Request.headers(Either));
        expect(
          yield* schemaFailure(headers, {
            headers: { "x-a": "1", "x-b": "2" },
          }),
        ).toContain('["x-b"]');
        const path = Request.get("").pipe(Request.path(Apart, () => "/x"));
        expect(
          yield* schemaFailure(path, { path: { a: "1", b: "2" } }),
        ).toContain('["b"]');
      }),
    );

    it.effect("is refused on the encoded side, by its encoded name", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Union([
          Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ b: text }).pipe(Schema.encodeKeys({ b: "B" })),
        ]);
        expect(
          yield* schemaFailure(queried(Renamed), {
            query: { A: "x", B: "y" },
          }),
        ).toContain('["B"]');
      }),
    );

    it.effect("is refused in a mix by field", () =>
      Effect.gen(function* () {
        const Mixed = Schema.Union([
          Schema.Struct({
            n: Schema.FiniteFromString,
            d: Schema.FiniteFromString,
            a: text,
          }),
          Schema.Struct({
            n: Schema.FiniteFromString,
            d: Schema.FiniteFromString,
            b: text,
          }),
        ]);
        expect(
          yield* schemaFailure(queried(Mixed), {
            query: { n: 1, d: "2", a: "x", b: "y" },
          }),
        ).toContain('["b"]');
      }),
    );

    it.effect("is refused where only the encoded side shows the member", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({ a: text }),
          Schema.Struct({ b: text }).pipe(Schema.encodeKeys({ b: "k" })),
        ]);
        expect(
          yield* schemaFailure(queried(Either), {
            query: { a: "x", k: "y" },
          }),
        ).toContain('["k"]');
      }),
    );

    it.effect("is refused inside a union of unions", () =>
      Effect.gen(function* () {
        const Nested = Schema.Union([NarrowFirst, Schema.Struct({ c: text })]);
        expect(
          yield* schemaFailure(queried(Nested), {
            query: { a: "x", c: "z" },
          }),
        ).toContain('["c"]');
      }),
    );

    it.effect("is refused where a wider member refuses its value", () =>
      Effect.gen(function* () {
        const Wider = Schema.Union([
          Schema.Struct({ a: text }),
          Schema.Struct({ a: text, b: Schema.FiniteFromString }),
        ]);
        expect(
          yield* schemaFailure(queried(Wider), {
            query: { a: "x", b: "many" },
          }),
        ).toContain('["b"]');
      }),
    );

    it.effect("reads as any other failure if no member fits at all", () =>
      Effect.gen(function* () {
        const message = yield* schemaFailure(queried(Numbers), {
          query: { n: "many" },
        });
        expect(message).toContain("Expected number");
        expect(message).not.toContain("No union member holds");
      }),
    );
  });

  describe("a field the schema never held is not this refusal", () => {
    it.effect("stripping a key no member states, as a struct does", () =>
      Effect.gen(function* () {
        const query = { a: "x", z: "stray" };
        expect(yield* urlOf(queried(Apart), { query })).toBe("/x?a=x");
        expect(
          yield* urlOf(queried(Schema.Struct({ a: text })), { query }),
        ).toBe("/x?a=x");
      }),
    );

    it.effect("keeping the rest of the fields beside such a key", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(queried(NarrowFirst), {
            query: { a: "x", b: "y", z: "stray" },
          }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("taking `undefined` as no field", () =>
      Effect.gen(function* () {
        const query = { a: "x", b: undefined };
        expect(yield* urlOf(queried(Apart), { query })).toBe("/x?a=x");
        expect(yield* urlOf(queried(NarrowFirst), { query })).toBe("/x?a=x");
      }),
    );

    it.effect(
      "reading a decoded name beside its encoded twin, as a struct does",
      () =>
        Effect.gen(function* () {
          const Renamed = Schema.Struct({ a: text }).pipe(
            Schema.encodeKeys({ a: "A" }),
          );
          const Choice = Schema.Union([Renamed, Schema.Struct({ b: text })]);
          for (const query of [
            { a: "1", A: "2" },
            { a: "1", A: "1" },
          ]) {
            expect(yield* urlOf(queried(Renamed), { query })).toBe("/x?A=1");
            expect(yield* urlOf(queried(Choice), { query })).toBe("/x?A=1");
          }
          const InBody = Schema.Struct({ f: NarrowFirst }).pipe(
            Schema.encodeKeys({ f: "F" }),
          );
          const body = { f: { a: "1" }, F: { a: "2" } };
          const compiled = yield* compile(
            Request.post("/x").pipe(Request.body(Body.jsonSchema(InBody))),
            { body },
          );
          expect(bodyText(compiled.request)).toBe('{"F":{"a":"1"}}');
        }),
    );

    it.effect("leaving a tag to choose", () =>
      Effect.gen(function* () {
        const Tagged = Schema.Union([
          Schema.Struct({ kind: Schema.Literal("a"), x: text }),
          Schema.Struct({ kind: Schema.Literal("b") }),
        ]);
        // The tag has already ruled out the member that states `x`, and the types refuse it in a
        // literal, so it comes in a wider value.
        const query = { kind: "b", x: "y" } as const;
        expect(yield* urlOf(queried(Tagged), { query })).toBe("/x?kind=b");
      }),
    );
  });

  describe("input that must keep working", () => {
    it.effect("a transformation of a member's field", () =>
      Effect.gen(function* () {
        const Shout = text.pipe(
          Schema.decodeTo(
            text,
            SchemaTransformation.transform({
              decode: (value) => value.toLowerCase(),
              encode: (value) => value.toUpperCase(),
            }),
          ),
        );
        const Either = Schema.Union([
          Schema.Struct({ a: Shout }),
          Schema.Struct({ a: Shout, b: Shout }),
        ]);
        expect(
          yield* urlOf(queried(Either), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=X&b=Y");
      }),
    );

    it.effect("a renamed field, on each side", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Union([
          Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ a: text, b: text }).pipe(
            Schema.encodeKeys({ a: "A", b: "B" }),
          ),
        ]);
        for (const query of [
          { a: "x", b: "y" },
          { A: "x", B: "y" },
        ])
          expect(yield* urlOf(queried(Renamed), { query })).toBe("/x?A=x&B=y");
        expect(yield* urlOf(queried(Renamed), { query: { A: "x" } })).toBe(
          "/x?A=x",
        );
      }),
    );

    it.effect("`Option.none()`, which writes no key", () =>
      Effect.gen(function* () {
        const Maybe = Schema.OptionFromOptionalKey(text);
        const Either = Schema.Union([
          Schema.Struct({ a: Maybe }),
          Schema.Struct({ a: Maybe, b: text }),
        ]);
        expect(
          yield* urlOf(queried(Either), { query: { a: Option.none() } }),
        ).toBe("/x");
        expect(
          yield* urlOf(queried(Either), {
            query: { a: Option.none(), b: "y" },
          }),
        ).toBe("/x?b=y");
        expect(
          yield* urlOf(queried(Either), {
            query: { a: Option.some("x"), b: "y" },
          }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("a class, as an instance and as a plain value", () =>
      Effect.gen(function* () {
        class First extends Schema.Class<First>("First")({ a: text }) {}
        class Second extends Schema.Class<Second>("Second")({ b: text }) {}
        const request = queried(Schema.Union([First, Second]));
        for (const query of [{ a: "x" }, new First({ a: "x" })])
          expect(yield* urlOf(request, { query })).toBe("/x?a=x");
        for (const query of [{ b: "y" }, new Second({ b: "y" })])
          expect(yield* urlOf(request, { query })).toBe("/x?b=y");
      }),
    );

    it.effect("a class with a property of its own", () =>
      Effect.gen(function* () {
        class Counted extends Schema.Class<Counted>("Counted")({ a: text }) {
          readonly reads = 1;
        }
        class Other extends Schema.Class<Other>("Other")({ b: text }) {}
        expect(
          yield* urlOf(queried(Schema.Union([Counted, Other])), {
            query: new Counted({ a: "x" }),
          }),
        ).toBe("/x?a=x");
      }),
    );

    it.effect("a member that drops a field by design", () =>
      Effect.gen(function* () {
        const Legacy = Schema.Struct({
          a: text,
          legacy: Schema.optionalKey(text),
        }).pipe(
          Schema.decodeTo(
            Schema.Struct({ a: text }),
            SchemaTransformation.transform({
              decode: ({ a }) => ({ a }),
              encode: ({ a }) => ({ a }),
            }),
          ),
        );
        const request = queried(
          Schema.Union([Legacy, Schema.Struct({ legacy: text, c: text })]),
        );
        expect(
          yield* urlOf(request, { query: { a: "x", legacy: "old" } }),
        ).toBe("/x?a=x");
      }),
    );

    it.effect(
      "a member whose transformation hands on more than it states",
      () =>
        Effect.gen(function* () {
          const Spread = Schema.Struct({ a: text }).pipe(
            Schema.decodeTo(
              Schema.Struct({ b: text }),
              SchemaTransformation.transform({
                decode: (value): { readonly b: string } => ({
                  ...value,
                  b: value.a,
                }),
                encode: (value): { readonly a: string } => ({
                  ...value,
                  a: value.b,
                }),
              }),
            ),
          );
          const request = queried(
            Schema.Union([Spread, Schema.Struct({ a: text, c: text })]),
          );
          expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x");
        }),
    );

    it.effect("a schema with the same type on both sides", () =>
      Effect.gen(function* () {
        const Coded = Schema.StringFromBase64;
        const Either = Schema.Union([
          Schema.Struct({ s: Coded }),
          Schema.Struct({ s: Coded, t: text }),
        ]);
        expect(yield* urlOf(queried(Either), { query: { s: "hi" } })).toBe(
          "/x?s=aGk%3D",
        );
        expect(
          yield* urlOf(queried(Either), { query: { s: "hi", t: "y" } }),
        ).toBe("/x?s=aGk%3D&t=y");
      }),
    );

    it.effect(
      "a schema's encoder, which runs once where nothing is stripped",
      () =>
        Effect.gen(function* () {
          let writes = 0;
          const Counted = text.pipe(
            Schema.decodeTo(
              text,
              SchemaTransformation.transform({
                decode: (value) => value,
                encode: (value) => {
                  writes += 1;
                  return value;
                },
              }),
            ),
          );
          const Wide = Schema.Union([
            Schema.Struct({ a: Counted }),
            Schema.Struct({ a: Counted, b: text }),
          ]);
          yield* urlOf(queried(Wide), { query: { a: "x", b: "y" } });
          expect(writes).toBe(1);
          writes = 0;
          yield* urlOf(queried(Schema.Struct({ a: Counted })), {
            query: { a: "x" },
          });
          expect(writes).toBe(1);
        }),
    );

    it.effect("a union with no choice between objects", () =>
      Effect.gen(function* () {
        const Nullable = Schema.Struct({
          a: Schema.NullOr(text),
          b: Schema.optional(Schema.Union([text, Schema.Array(text)])),
        });
        expect(
          yield* urlOf(queried(Nullable), {
            query: { a: null, b: ["x", "y"], z: "stray" } as never,
          }),
        ).toBe("/x?a&b=x&b=y");
      }),
    );

    it.effect("a schema that suspends", () =>
      Effect.gen(function* () {
        interface Tree {
          readonly a: string;
          readonly next?: Tree;
        }
        const Tree: Schema.Codec<Tree> = Schema.Struct({
          a: text,
          next: Schema.optionalKey(Schema.suspend(() => Tree)),
        });
        const body = Request.post("/x").pipe(
          Request.body(Body.jsonSchema(Tree)),
        );
        const compiled = yield* compile(body, {
          body: { a: "1", next: { a: "2" } },
        });
        expect(bodyText(compiled.request)).toBe('{"a":"1","next":{"a":"2"}}');
      }),
    );

    it.effect("a schema whose steps take time", () =>
      Effect.gen(function* () {
        const Later = text.pipe(
          Schema.decodeTo(
            text,
            SchemaTransformation.transformEffect({
              decode: (value) => Effect.as(Effect.yieldNow, value),
              encode: (value) => Effect.as(Effect.yieldNow, value),
            }),
          ),
        );
        const Either = Schema.Union([
          Schema.Struct({ a: Later }),
          Schema.Struct({ a: Later, b: text }),
        ]);
        expect(
          yield* urlOf(queried(Either), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=x&b=y");
        expect(
          yield* urlOf(queried(Either), { query: { a: "x", z: "stray" } }),
        ).toBe("/x?a=x");
      }),
    );
  });
});

describe("a schema states the shape of its group", () => {
  const Authorization = { Authorization: Schema.optional(Schema.String) };
  const shared = Request.setHeader("Authorization", "Bearer shared");
  const Limit = Schema.Struct({
    limit: Schema.optional(Schema.FiniteFromString),
  });

  describe("a raw value under a name the schema allows", () => {
    it.effect("stays in place when an optional field is left out", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          shared,
          Request.headers(
            Schema.Struct({ ...Authorization, "If-Match": Schema.String }),
          ),
        );
        expect(
          yield* linesOf(request, { headers: { "If-Match": "*" } }),
        ).toEqual([
          ["Authorization", "Bearer shared"],
          ["If-Match", "*"],
        ]);
      }),
    );

    it.effect("gives way to what the caller passes", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          shared,
          Request.headers(Schema.Struct(Authorization)),
        );
        expect(
          yield* linesOf(request, {
            headers: { Authorization: "Bearer mine" },
          }),
        ).toEqual([["Authorization", "Bearer mine"]]);
      }),
    );

    it.effect("gives way to a required field, set before the schema", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          shared,
          Request.headers(Schema.Struct({ Authorization: Schema.String })),
        );
        expect(
          yield* linesOf(request, {
            headers: { Authorization: "Bearer mine" },
          }),
        ).toEqual([["Authorization", "Bearer mine"]]);
      }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/112
    it.effect(
      "currently leaves a required field to the caller regardless",
      () =>
        Effect.gen(function* () {
          const request = Request.put("/things").pipe(
            shared,
            Request.headers(Schema.Struct({ Authorization: Schema.String })),
          );
          const error = yield* Effect.flip(
            // @ts-expect-error the input comes from the schema alone
            compile(request, { headers: {} }),
          );
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }),
    );

    it.effect("stays when the caller passes undefined for it", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?limit=5").pipe(
          Request.query(Limit),
        );
        expect(yield* urlOf(request, { query: { limit: undefined } })).toBe(
          "/things?limit=5",
        );
      }),
    );

    it.effect("gives way to an empty list, which writes no entries", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?tag=x").pipe(
          Request.query(
            Schema.Struct({
              tag: Schema.optional(Schema.Array(Schema.String)),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: { tag: [] } })).toBe("/things");
      }),
    );

    it.effect("gives way to a value the schema supplies itself", () =>
      Effect.gen(function* () {
        const Constructed = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        });
        expect(
          yield* urlOf(
            Request.get("/things?limit=5").pipe(Request.query(Constructed)),
            { query: {} },
          ),
        ).toBe("/things?limit=25");
        const Decoded = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("25")),
          ),
        });
        expect(
          yield* urlOf(
            Request.get("/things?limit=5").pipe(Request.query(Decoded)),
            { query: {} },
          ),
        ).toBe("/things?limit=25");
      }),
    );

    it.effect("stays under a field that encodes to nothing when left out", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?limit=5").pipe(
          Request.query(
            Schema.Struct({
              limit: Schema.OptionFromOptionalKey(Schema.FiniteFromString),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/things?limit=5");
      }),
    );

    it.effect("is evaluated as a computed value, once", () =>
      Effect.gen(function* () {
        let calls = 0;
        const request = Request.get("/things").pipe(
          Request.setQuery("limit", () => `${++calls}`),
          Request.query(Limit),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/things?limit=1");
        expect(calls).toBe(1);
      }),
    );

    it.effect("wins over an automatic body field, in either order", () =>
      Effect.gen(function* () {
        const Type = Schema.Struct({
          "Content-Type": Schema.optional(Schema.String),
        });
        const declared = Request.post("/things").pipe(
          Request.setHeader("content-type", "application/weird"),
        );
        for (const request of [
          declared.pipe(Request.headers(Type), Request.body(Body.text)),
          declared.pipe(Request.body(Body.text), Request.headers(Type)),
        ]) {
          const compiled = yield* compile(request, { body: "b", headers: {} });
          expect(compiled.request.headers["content-type"]).toBe(
            "application/weird",
          );
          expect(compiled.headerLines).toContainEqual([
            "Content-Type",
            "application/weird",
          ]);
        }
      }),
    );
  });

  describe("a default goes through the schema", () => {
    it.effect("takes the form the schema writes", () =>
      Effect.gen(function* () {
        const Slot = Schema.Struct({ at: Schema.optional(MomentFromString) });
        const request = Request.get("/slots?at=t1530").pipe(
          Request.query(Slot),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/slots?at=15%3A30%3A00",
        );
        expect(yield* urlOf(request, { query: { at: new Moment(930) } })).toBe(
          "/slots?at=15%3A30%3A00",
        );
      }),
    );

    it.effect("loses its exact text, as `?page=02` becomes `page=2`", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?page=02&q=a+b").pipe(
          Request.query(
            Schema.Struct({
              page: Schema.optional(Schema.FiniteFromString),
              q: Schema.optional(Schema.String),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/things?page=2&q=a%20b",
        );
      }),
    );

    it.effect("reads a written entry under its decoded name", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/things?%6Cimit=5").pipe(Request.query(Limit)),
            { query: {} },
          ),
        ).toBe("/things?limit=5");
        const Named = Schema.Struct({
          "first name": Schema.optional(Schema.String),
        });
        expect(
          yield* urlOf(
            Request.get("/x?first+name=Ada").pipe(Request.query(Named)),
            { query: {} },
          ),
        ).toBe("/x?first%20name=Ada");
      }),
    );

    it.effect("is refused when it does not fit", () =>
      Effect.gen(function* () {
        const bad = Request.get("/things?limit=many").pipe(
          Request.query(Limit),
        );
        const error = yield* refusal(bad, { query: {} });
        expect(error.message).toContain('"limit"');
        // The caller's value replaces it, so the default never comes into it.
        expect(yield* urlOf(bad, { query: { limit: 3 } })).toBe(
          "/things?limit=3",
        );
      }),
    );

    it.effect("is refused without its value, which may be a credential", () =>
      Effect.gen(function* () {
        const secret = "sk-not-a-real-secret";
        const Short = Schema.String.check(Schema.isMaxLength(5));
        const header = yield* refusal(
          Request.get("/things").pipe(
            Request.setHeader("X-Key", secret),
            Request.headers(Schema.Struct({ "X-Key": Schema.optional(Short) })),
          ),
          { headers: {} },
        );
        const query = yield* refusal(
          Request.get(`/things?key=${secret}`).pipe(
            Request.query(Schema.Struct({ key: Schema.optional(Short) })),
          ),
          { query: {} },
        );
        for (const error of [header, query]) {
          expect(error.cause).toBeUndefined();
          expect(`${error.message} ${String(error)}`).not.toContain(secret);
          expect(JSON.stringify(error)).not.toContain(secret);
        }
        expect(header.message).toContain('"X-Key"');
        expect(query.message).toContain('"key"');
      }),
    );

    it.effect(
      "is refused if the schema would not write it, so nothing is lost",
      () =>
        Effect.gen(function* () {
          const dropped = Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.optionalKey(Schema.String), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.omit(),
            }),
          );
          const query = Request.get("/things?gone=1").pipe(
            Request.query(Schema.Struct({ gone: dropped })),
          );
          expect((yield* refusal(query, { query: {} })).message).toContain(
            '"gone"',
          );
          const headers = Request.get("/things").pipe(
            Request.setHeader("X-Gone", "1"),
            Request.headers(Schema.Struct({ "X-Gone": dropped })),
          );
          expect((yield* refusal(headers, { headers: {} })).message).toContain(
            '"X-Gone"',
          );
        }),
    );

    it.effect(
      "is refused if the caller picks a union member that leaves it out",
      () =>
        Effect.gen(function* () {
          const Either = Schema.Union([
            Schema.Struct({ kind: Schema.Literal("a"), a: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("b"), b: Schema.String }),
          ]);
          const request = Request.get("/things?b=1").pipe(
            Request.query(Either),
          );
          const error = yield* refusal(request, {
            query: { kind: "a", a: "x" },
          });
          expect(error.message).toContain('"b"');
          expect(yield* urlOf(request, { query: { kind: "b", b: "2" } })).toBe(
            "/things?kind=b&b=2",
          );
        }),
    );

    describe("under a union that a default and the caller split", () => {
      const Either = Schema.Union([
        Schema.Struct({ "x-a": Schema.String }),
        Schema.Struct({ "x-b": Schema.String }),
      ]);
      const AOrB = Schema.Union([
        Schema.Struct({ a: Schema.String }),
        Schema.Struct({ b: Schema.String }),
      ]);
      const Paged = Schema.Union([
        Schema.Struct({
          page: Schema.String,
          size: Schema.optional(Schema.String),
        }),
        Schema.Struct({ cursor: Schema.String }),
      ]);
      const PagedHeaders = Schema.Union([
        Schema.Struct({
          "x-page": Schema.String,
          "x-size": Schema.optional(Schema.String),
        }),
        Schema.Struct({ "x-cursor": Schema.String }),
      ]);

      it.effect("is refused for the header the caller would lose", () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(
            Request.setHeader("x-a", "default-a"),
            Request.headers(Either),
          );
          const error = yield* refusal(request, {
            headers: { "x-b": "from-caller" },
          });
          expect(lostFrom(error.message)).toEqual(["x-b"]);
          expect(error.message).toContain("header group");
          expect(`${error.message} ${String(error)}`).not.toContain(
            "default-a",
          );
          expect(`${error.message} ${String(error)}`).not.toContain(
            "from-caller",
          );
          expect(JSON.stringify(error)).not.toContain("from-caller");
          // The same call that fits the default's member still goes through.
          const compiled = yield* compile(request, {
            headers: { "x-a": "from-caller" },
          });
          expect(compiled.headerLines).toEqual([["x-a", "from-caller"]]);
        }),
      );

      it.effect("is refused for the query field the caller would lose", () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1").pipe(Request.query(AOrB));
          const error = yield* refusal(request, { query: { b: "secret" } });
          expect(lostFrom(error.message)).toEqual(["b"]);
          expect(error.message).toContain("query group");
          expect(`${error.message} ${String(error)}`).not.toContain("secret");
          expect(JSON.stringify(error)).not.toContain("secret");
          expect(yield* urlOf(request, { query: { a: "2" } })).toBe("/x?a=2");
        }),
      );

      it.effect("names a header in the spelling the schema wrote it", () =>
        Effect.gen(function* () {
          const Spelled = Schema.Union([
            Schema.Struct({ "X-A": Schema.String }),
            Schema.Struct({ "X-B": Schema.String }),
          ]);
          const error = yield* refusal(
            Request.get("/x").pipe(
              Request.setHeader("x-a", "1"),
              Request.headers(Spelled),
            ),
            { headers: { "X-B": "2" } },
          );
          expect(lostFrom(error.message)).toEqual(["X-B"]);
        }),
      );

      it.effect(
        "names the default when the union keeps the caller's field",
        () =>
          Effect.gen(function* () {
            const Reversed = Schema.Union([
              Schema.Struct({ cursor: Schema.String }),
              Schema.Struct({ page: Schema.String }),
            ]);
            const error = yield* refusal(
              Request.get("/x?page=1").pipe(Request.query(Reversed)),
              { query: { cursor: "c" } },
            );
            expect(lostFrom(error.message)).toEqual(["page"]);
            const ReversedHeaders = Schema.Union([
              Schema.Struct({ "x-cursor": Schema.String }),
              Schema.Struct({ "x-page": Schema.String }),
            ]);
            const header = yield* refusal(
              Request.get("/x").pipe(
                Request.setHeader("x-page", "1"),
                Request.headers(ReversedHeaders),
              ),
              { headers: { "x-cursor": "c" } },
            );
            expect(lostFrom(header.message)).toEqual(["x-page"]);
          }),
      );

      it.effect(
        "does not blame shared query defaults for a caller's cursor",
        () =>
          Effect.gen(function* () {
            const one = Request.get("/x?page=1").pipe(Request.query(Paged));
            const two = Request.get("/x?page=1&size=9").pipe(
              Request.query(Paged),
            );
            for (const request of [one, two]) {
              const error = yield* refusal(request, {
                query: { cursor: "c" },
              });
              expect(lostFrom(error.message)).toEqual(["cursor"]);
              expect(error.message).not.toContain('"page"');
              expect(error.message).not.toContain('"size"');
            }
            // A caller on the default's own member is unaffected.
            expect(yield* urlOf(one, { query: { page: "2" } })).toBe(
              "/x?page=2",
            );
            expect(yield* urlOf(one, { query: { page: "2", size: "5" } })).toBe(
              "/x?page=2&size=5",
            );
            expect(yield* urlOf(two, { query: { page: "2" } })).toBe(
              "/x?page=2&size=9",
            );
            // A variant without the default takes the other member.
            const scrolling = one.pipe(Request.removeQuery("page"));
            expect(yield* urlOf(scrolling, { query: { cursor: "c" } })).toBe(
              "/x?cursor=c",
            );
          }),
      );

      it.effect(
        "does not blame shared header defaults for a caller's cursor",
        () =>
          Effect.gen(function* () {
            const request = Request.get("/x").pipe(
              Request.setHeader("x-page", "1"),
              Request.setHeader("x-size", "9"),
              Request.headers(PagedHeaders),
            );
            const error = yield* refusal(request, {
              headers: { "x-cursor": "c" },
            });
            expect(lostFrom(error.message)).toEqual(["x-cursor"]);
            const compiled = yield* compile(request, {
              headers: { "x-page": "2" },
            });
            expect(compiled.headerLines).toEqual([
              ["x-page", "2"],
              ["x-size", "9"],
            ]);
          }),
      );

      it.effect("names a default the caller's member cannot hold", () =>
        Effect.gen(function* () {
          const error = yield* refusal(
            Request.get("/x?size=9").pipe(Request.query(Paged)),
            { query: { cursor: "c" } },
          );
          expect(lostFrom(error.message)).toEqual(["size"]);
          const header = yield* refusal(
            Request.get("/x").pipe(
              Request.setHeader("x-size", "9"),
              Request.headers(PagedHeaders),
            ),
            { headers: { "x-cursor": "c" } },
          );
          expect(lostFrom(header.message)).toEqual(["x-size"]);
        }),
      );

      it.effect("names every field that would go, and only those", () =>
        Effect.gen(function* () {
          const Wide = Schema.Union([
            Schema.Struct({ a: Schema.String, b: Schema.String }),
            Schema.Struct({ c: Schema.String, d: Schema.String }),
          ]);
          const error = yield* refusal(
            Request.get("/x?a=1&b=2").pipe(Request.query(Wide)),
            { query: { c: "3", d: "4" } },
          );
          expect(lostFrom(error.message)).toEqual(["c", "d"]);
        }),
      );

      it.effect("takes a later member that holds the whole group", () =>
        Effect.gen(function* () {
          const Later = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({
              a: Schema.optional(Schema.String),
              b: Schema.String,
            }),
          ]);
          expect(
            yield* urlOf(Request.get("/x?a=1").pipe(Request.query(Later)), {
              query: { b: "2" },
            }),
          ).toBe("/x?a=1&b=2");
          const Overlap = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ a: Schema.String, b: Schema.String }),
          ]);
          expect(
            yield* urlOf(Request.get("/x?b=1").pipe(Request.query(Overlap)), {
              query: { a: "x" },
            }),
          ).toBe("/x?a=x&b=1");
          const LaterHeaders = Schema.Union([
            Schema.Struct({ "x-a": Schema.String }),
            Schema.Struct({
              "x-a": Schema.optional(Schema.String),
              "x-b": Schema.String,
            }),
          ]);
          const compiled = yield* compile(
            Request.get("/x").pipe(
              Request.setHeader("x-a", "1"),
              Request.headers(LaterHeaders),
            ),
            { headers: { "x-b": "2" } },
          );
          expect(compiled.headerLines).toEqual([
            ["x-a", "1"],
            ["x-b", "2"],
          ]);
        }),
      );

      it.effect("is decided per call, not when the request is defined", () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1").pipe(Request.query(AOrB));
          expect(yield* urlOf(request, { query: { a: "2" } })).toBe("/x?a=2");
          yield* refusal(request, { query: { b: "2" } });
          expect(yield* urlOf(request, { query: { a: "3" } })).toBe("/x?a=3");
        }),
      );

      it.effect("leaves a union alone when there is no default", () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(Request.query(AOrB));
          expect(yield* urlOf(request, { query: { b: "2" } })).toBe("/x?b=2");
        }),
      );

      it.effect("still takes a default that fits a discriminated union", () =>
        Effect.gen(function* () {
          const Tagged = Schema.Union([
            Schema.Struct({
              kind: Schema.Literal("a"),
              a: Schema.optional(Schema.String),
            }),
            Schema.Struct({
              kind: Schema.Literal("b"),
              b: Schema.optional(Schema.String),
            }),
          ]);
          const request = Request.get("/x?b=1").pipe(Request.query(Tagged));
          expect(yield* urlOf(request, { query: { kind: "b" } })).toBe(
            "/x?kind=b&b=1",
          );
          const error = yield* refusal(request, { query: { kind: "a" } });
          expect(lostFrom(error.message)).toEqual(["b"]);
        }),
      );

      it.effect("applies to a list of pairs and an open member too", () =>
        Effect.gen(function* () {
          const Pairs = Schema.Array(
            Schema.Tuple([Schema.String, Schema.String]),
          );
          expect(
            yield* urlOf(Request.get("/x?b=1").pipe(Request.query(Pairs)), {
              query: [["a", "2"]],
            }),
          ).toBe("/x?a=2&b=1");
          const Open = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Record(Schema.String, Schema.String),
          ]);
          expect(
            yield* urlOf(Request.get("/x?a=1").pipe(Request.query(Open)), {
              query: { b: "2" },
            }),
          ).toBe("/x?b=2&a=1");
        }),
      );
    });

    it.effect("is decoded with the rest of the group", () =>
      Effect.gen(function* () {
        const Range = Schema.Struct({
          from: Schema.FiniteFromString,
          to: Schema.optional(Schema.FiniteFromString),
        }).check(
          Schema.makeFilter(({ from, to }) =>
            to === undefined || from <= to ? undefined : "from comes after to",
          ),
        );
        const request = Request.get("/range?to=5").pipe(Request.query(Range));
        expect(yield* urlOf(request, { query: { from: 1 } })).toBe(
          "/range?from=1&to=5",
        );
        const error = yield* refusal(request, { query: { from: 9 } });
        expect(error.message).toContain('"to"');
      }),
    );

    it.effect(
      "is as strict as the schema, so a weak one lets text through",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things?limit=two").pipe(
            Request.query(
              Schema.Struct({
                limit: Schema.optional(Schema.NumberFromString),
              }),
            ),
          );
          expect(yield* urlOf(request, { query: {} })).toBe(
            "/things?limit=NaN",
          );
        }),
    );

    it.effect("needs the schema's decoding services", () =>
      Effect.gen(function* () {
        const Tenanted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (wire: string) =>
                Effect.gen(function* () {
                  return `${yield* Tenant}:${wire}`;
                }),
              encode: (value: string) => Effect.succeed(value),
            }),
          ),
        );
        const request = Request.get("/things?who=me").pipe(
          Request.query(Schema.Struct({ who: Schema.optional(Tenanted) })),
        );
        type Needs = Effect.Services<ReturnType<typeof request.prepare>>;
        expectTypeOf<Needs>().toEqualTypeOf<Tenant>();
        expect(
          yield* urlOf(request, { query: {} }).pipe(
            Effect.provideService(Tenant, "t1"),
          ),
        ).toBe("/things?who=t1%3Ame");
      }),
    );

    it.effect.each([
      ["a number", Schema.Number, "5", "5"],
      ["a negative number", Schema.Number, "-1.5", "-1.5"],
      ["NaN", Schema.Number, "NaN", "NaN"],
      ["infinity", Schema.Number, "Infinity", "Infinity"],
      ["true", Schema.Boolean, "true", "true"],
      ["false", Schema.Boolean, "false", "false"],
      ["a bigint", Schema.BigInt, "90071992547409931", "90071992547409931"],
      ["a literal number", Schema.Literal(25), "25", "25"],
      ["a literal boolean", Schema.Literal(true), "true", "true"],
      ["a choice of numbers", Schema.Literals([10, 25]), "25", "25"],
      ["a number or null", Schema.NullOr(Schema.Number), "5", "5"],
      [
        "a number or a word",
        Schema.Union([Schema.Number, Schema.Literal("all")]),
        "all",
        "all",
      ],
      [
        "a number or a boolean",
        Schema.Union([Schema.Number, Schema.Boolean]),
        "true",
        "true",
      ],
      ["a list of numbers", Schema.Array(Schema.Number), "5", "5"],
    ] as const)("reads text as %s", ([, field, text, expected]) =>
      Effect.gen(function* () {
        const request = Request.get(`/things?a=${text}`).pipe(
          Request.query(Schema.Struct({ a: Schema.optional(field) })),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          `/things?a=${expected}`,
        );
      }),
    );

    it.effect.each([
      ["a number", Schema.Number, "many"],
      ["a number, from nothing", Schema.Number, ""],
      ["a boolean", Schema.Boolean, "yes"],
      ["a bigint", Schema.BigInt, "1.5"],
      ["a literal number", Schema.Literal(25), "26"],
    ] as const)("refuses text that is not %s", ([, field, text]) =>
      Effect.gen(function* () {
        const request = Request.get(`/things?a=${text}`).pipe(
          Request.query(Schema.Struct({ a: Schema.optional(field) })),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"a"');
      }),
    );

    it.effect(
      "reads text for a schema of its own that encodes to a number",
      () =>
        Effect.gen(function* () {
          const Slot = Schema.Struct({ at: Schema.optional(MomentFromNumber) });
          expect(
            yield* urlOf(
              Request.get("/slots?at=930").pipe(Request.query(Slot)),
              { query: {} },
            ),
          ).toBe("/slots?at=930");
          const error = yield* refusal(
            Request.get("/slots?at=-1").pipe(Request.query(Slot)),
            { query: {} },
          );
          expect(error.message).toContain('"at"');
        }),
    );

    it.effect("keeps a bare key for a field that holds null", () =>
      Effect.gen(function* () {
        const Flag = Schema.Struct({ wsdl: Schema.optional(Schema.Null) });
        expect(
          yield* urlOf(Request.get("/svc?wsdl").pipe(Request.query(Flag)), {
            query: {},
          }),
        ).toBe("/svc?wsdl");
        const refused = yield* refusal(
          Request.get("/svc?wsdl=1").pipe(Request.query(Flag)),
          { query: {} },
        );
        expect(refused.message).toContain('"wsdl"');
      }),
    );

    it.effect("takes one value or several under a list field", () =>
      Effect.gen(function* () {
        const Tags = Schema.Struct({
          tag: Schema.optional(Schema.Array(Schema.String)),
        });
        const one = Request.get("/x?tag=a").pipe(Request.query(Tags));
        expect(yield* urlOf(one, { query: {} })).toBe("/x?tag=a");
        const two = Request.get("/x?tag=a&tag=b").pipe(Request.query(Tags));
        expect(yield* urlOf(two, { query: {} })).toBe("/x?tag=a&tag=b");
        const lines = yield* linesOf(
          Request.get("/x").pipe(
            Request.appendHeader("X-Tag", "a"),
            Request.appendHeader("x-tag", "b"),
            Request.headers(
              Schema.Struct({
                "x-TAG": Schema.optional(Schema.Array(Schema.String)),
              }),
            ),
          ),
          { headers: {} },
        );
        expect(lines).toEqual([
          ["x-TAG", "a"],
          ["x-TAG", "b"],
        ]);
      }),
    );

    it.effect("refuses several values under a single field", () =>
      Effect.gen(function* () {
        const request = Request.get("/x?limit=1&limit=2").pipe(
          Request.query(Limit),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"limit"');
      }),
    );
  });

  describe("a raw value under a name no schema allows", () => {
    const Etag = Schema.Struct({ "If-Match": Schema.String });

    it.effect("is an incompatible shape, in either order", () =>
      Effect.gen(function* () {
        const typed = Request.headers(Etag);
        const input = { headers: { "If-Match": "*" } };
        for (const request of [
          Request.put("/things").pipe(shared, typed),
          Request.put("/things").pipe(typed, shared),
        ]) {
          const error = yield* refusal(request, input);
          expect(error.message).toContain('"Authorization"');
          expect(error.message).toContain('Request.unbind("headers")');
          expect(error.message).not.toContain("Bearer shared");
        }
      }),
    );

    it.effect("is refused whatever the input, before any encoding", () =>
      Effect.gen(function* () {
        let encoded = 0;
        const Counted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: (wire: string) => wire,
              encode: (value: string) => {
                encoded++;
                return value;
              },
            }),
          ),
        );
        const error = yield* refusal(
          Request.get("/things?stray=1").pipe(
            Request.query(Schema.Struct({ q: Counted })),
          ),
          { query: { q: "x" } },
        );
        expect(error.message).toContain('"stray"');
        expect(encoded).toBe(0);
      }),
    );

    it.effect("names every field of both groups in one message", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          Request.get("/things?a=1&b=2&a=3").pipe(
            Request.setHeader("X-One", "1"),
            Request.query(Limit),
            Request.headers(Etag),
          ),
          { query: {}, headers: { "If-Match": "*" } },
        );
        expect(error.message).toContain('"a", "b"');
        expect(error.message).toContain('"X-One"');
      }),
    );

    it.effect("covers what is written in the constructor", () =>
      Effect.gen(function* () {
        const raw = Request.get("/things?page=1&limit=25");
        const Cursor = Schema.Struct({ cursor: Schema.String });
        const error = yield* refusal(raw.pipe(Request.query(Cursor)), {
          query: { cursor: "c" },
        });
        expect(error.message).toContain('"page", "limit"');
        // Typing part of a raw group takes the schema allowing the rest, or their removal.
        expect(
          yield* urlOf(
            raw.pipe(
              Request.removeQuery("page"),
              Request.removeQuery("limit"),
              Request.query(Cursor),
            ),
            { query: { cursor: "c" } },
          ),
        ).toBe("/things?cursor=c");
      }),
    );

    it.effect(
      "leaves a written empty segment behind the entries a schema covers",
      () =>
        Effect.gen(function* () {
          const Both = Schema.Struct({
            page: Schema.optional(Schema.FiniteFromString),
            tail: Schema.optional(Schema.String),
          });
          expect(
            yield* urlOf(
              Request.get("/things?page=02&&tail=1").pipe(Request.query(Both)),
              { query: {} },
            ),
          ).toBe("/things?&page=2&tail=1");
          expect(
            yield* urlOf(
              Request.get("/things?page=02&&&tail=1").pipe(Request.query(Both)),
              { query: {} },
            ),
          ).toBe("/things?&&page=2&tail=1");
        }),
    );

    it.effect(
      "leaves a written empty segment alone, because it names no field",
      () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(Request.get("/things?&&").pipe(Request.query(Limit)), {
              query: {},
            }),
          ).toBe("/things?&&");
          const open = Request.get("/things?a=1&").pipe(
            Request.query(Schema.Record(Schema.String, Schema.String)),
          );
          expect(yield* urlOf(open, { query: {} })).toContain("a=1");
        }),
    );

    it.effect("still counts an empty name that was written with a value", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          Request.get("/things?=1").pipe(Request.query(Limit)),
          { query: {} },
        );
        expect(error.message).toContain('""');
      }),
    );

    it.effect("does not count a computed value that declares nothing", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.setQuery("stray", () => undefined),
          Request.query(Limit),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/things");
      }),
    );

    it.effect("compares header names without case", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          Request.setHeader("if-MATCH", "raw"),
          Request.headers(
            Schema.Struct({ "If-Match": Schema.optional(Schema.String) }),
          ),
        );
        expect(yield* linesOf(request, { headers: {} })).toEqual([
          ["If-Match", "raw"],
        ]);
      }),
    );

    it.effect("compares query names with case", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          Request.get("/things?LIMIT=5").pipe(Request.query(Limit)),
          { query: {} },
        );
        expect(error.message).toContain('"LIMIT"');
      }),
    );

    it.effect("leaves text in the URL alone, as that is not a field", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/things").pipe(
              Request.baseUrl("https://api.test/v1?key=abc"),
              Request.query(Limit),
            ),
            { query: { limit: 5 } },
          ),
        ).toBe("https://api.test/v1?key=abc/things&limit=5");
        expect(
          yield* urlOf(
            Request.get("").pipe(
              Request.path(Schema.String, (id) => `/things?id=${id}`),
              Request.query(Limit),
            ),
            { path: "7", query: {} },
          ),
        ).toBe("/things?id=7");
      }),
    );
  });

  describe("a raw edit of a required field", () => {
    const Paged = Schema.Struct({
      page: Schema.FiniteFromString,
      limit: Schema.optional(Schema.FiniteFromString),
    });
    const typed = Request.get("/things").pipe(Request.query(Paged));
    const input = { query: { page: 1 } };

    it.effect.each([
      ["setQuery", Request.setQuery("page", "2")],
      ["appendQuery", Request.appendQuery("page", "2")],
      ["removeQuery", Request.removeQuery("page")],
      ["removeQuery with a value", Request.removeQuery("page", "2")],
    ] as const)("is refused from %s, after the schema", ([, edit]) =>
      Effect.gen(function* () {
        const error = yield* refusal(typed.pipe(edit), input);
        expect(error.message).toContain('"page"');
        expect(error.message).toContain("could never reach the client");
        expect(error.message).toContain('Request.unbind("query")');
      }),
    );

    it.effect.each([
      ["setHeader", Request.setHeader("X-LIMIT", "1")],
      ["appendHeader", Request.appendHeader("x-limit", "1")],
      ["removeHeader", Request.removeHeader("X-Limit")],
    ] as const)("is refused from %s, after the schema", ([, edit]) =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.headers(Schema.Struct({ "x-limit": Schema.String })),
          edit,
        );
        const error = yield* refusal(request, {
          headers: { "x-limit": "2" },
        });
        expect(error.message).toContain("could never reach the client");
        expect(error.message).toContain('Request.unbind("headers")');
      }),
    );

    it.effect("is allowed for an optional field, and still checked", () =>
      Effect.gen(function* () {
        const set = typed.pipe(Request.setQuery("limit", "5"));
        expect(yield* urlOf(set, input)).toBe("/things?page=1&limit=5");
        expect(yield* urlOf(set, { query: { page: 1, limit: 9 } })).toBe(
          "/things?page=1&limit=9",
        );
        const error = yield* refusal(
          typed.pipe(Request.setQuery("limit", "many")),
          input,
        );
        expect(error.message).toContain('"limit"');
      }),
    );

    it.effect("clears the default of an optional field on removal", () =>
      Effect.gen(function* () {
        const defaulted = typed.pipe(Request.setQuery("limit", "25"));
        expect(
          yield* urlOf(defaulted.pipe(Request.removeQuery("limit")), input),
        ).toBe("/things?page=1");
      }),
    );

    it.effect("is not caught for a field the schema may leave out", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(
            Schema.Struct({ a: Schema.UndefinedOr(Schema.String) }),
          ),
          Request.setQuery("a", "default"),
        );
        expect(yield* urlOf(request, { query: { a: undefined } })).toBe(
          "/things?a=default",
        );
      }),
    );

    it.effect("covers a required field with a default in its schema", () =>
      Effect.gen(function* () {
        const Defaulted = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        });
        const request = Request.get("/things").pipe(Request.query(Defaulted));
        const error = yield* refusal(
          request.pipe(Request.removeQuery("limit")),
          { query: { limit: 5 } },
        );
        expect(error.message).toContain('"limit"');
      }),
    );

    it.effect("is refused for a class's field", () =>
      Effect.gen(function* () {
        class Filter extends Schema.Class<Filter>("Filter")({
          page: Schema.FiniteFromString,
        }) {}
        const error = yield* refusal(
          Request.get("/things").pipe(
            Request.query(Filter),
            Request.setQuery("page", "1"),
          ),
          { query: new Filter({ page: 1 }) },
        );
        expect(error.message).toContain("could never reach the client");
      }),
    );

    it.effect("is a problem of the group, so an unbind lifts it", () =>
      Effect.gen(function* () {
        const lifted = typed.pipe(
          Request.setQuery("page", "abc"),
          Request.unbind("query"),
        );
        expect(yield* urlOf(lifted, undefined)).toBe("/things?page=abc");
      }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/120
    describe("under a field with a decoding default", () => {
      const twentyFive = Effect.succeed("25");
      const Limited = Schema.Struct({
        limit: Schema.FiniteFromString.pipe(
          Schema.withDecodingDefaultKey(twentyFive),
        ),
      });
      const limited = Request.get("/things").pipe(Request.query(Limited));

      it.effect("is refused, because the schema always writes it", () =>
        Effect.gen(function* () {
          const set = limited.pipe(Request.setQuery("limit", "5"));
          for (const query of [{ limit: 1 }, { limit: "1" }, {}]) {
            const error = yield* refusal(set, { query });
            expect(error.message).toContain("could never reach the client");
            expect(error.message).toContain('"limit"');
            expect(error.message).not.toContain("5");
          }
        }),
      );

      it.effect("is refused for every way of editing the group", () =>
        Effect.gen(function* () {
          for (const edit of [
            Request.setQuery({ limit: 5 }),
            Request.appendQuery("limit", "5"),
            Request.removeQuery("limit"),
            Request.removeQuery("limit", "5"),
          ]) {
            const error = yield* refusal(limited.pipe(edit), { query: {} });
            expect(error.message).toContain('"limit"');
          }
          const Header = Schema.Struct({
            "x-limit": Schema.String.pipe(
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          });
          const headers = Request.get("/x").pipe(Request.headers(Header));
          for (const edit of [
            Request.setHeader("X-Limit", "5"),
            Request.setHeader({ "x-limit": "5" }),
            Request.appendHeader("x-limit", "5"),
            Request.removeHeader("x-limit"),
          ]) {
            const error = yield* refusal(headers.pipe(edit), { headers: {} });
            expect(error.message.toLowerCase()).toContain('"x-limit"');
            expect(error.message).toContain("headers group");
          }
        }),
      );

      it.effect("is refused under each form of decoding default", () =>
        Effect.gen(function* () {
          const text = Effect.succeed("25");
          for (const field of [
            Schema.String.pipe(Schema.withDecodingDefaultKey(text)),
            Schema.String.pipe(Schema.withDecodingDefault(text)),
            Schema.String.pipe(Schema.withDecodingDefaultTypeKey(text)),
            Schema.String.pipe(Schema.withDecodingDefaultType(text)),
          ]) {
            const error = yield* refusal(
              Request.get("/x").pipe(
                Request.query(Schema.Struct({ limit: field })),
                Request.setQuery("limit", "5"),
              ),
              { query: {} },
            );
            expect(error.message).toContain("could never reach the client");
          }
        }),
      );

      it.effect("is refused for a class's field", () =>
        Effect.gen(function* () {
          class Capped extends Schema.Class<Capped>("Capped")({
            limit: Schema.String.pipe(
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          }) {}
          const error = yield* refusal(
            Request.get("/x").pipe(
              Request.query(Capped),
              Request.setQuery("limit", "5"),
            ),
            { query: new Capped({ limit: "1" }) },
          );
          expect(error.message).toContain("could never reach the client");
        }),
      );

      it.effect("is refused only if every union member writes the name", () =>
        Effect.gen(function* () {
          const defaulted = Schema.String.pipe(
            Schema.withDecodingDefaultKey(twentyFive),
          );
          const Every = Schema.Union([
            Schema.Struct({ a: Schema.String, limit: defaulted }),
            Schema.Struct({ b: Schema.String, limit: Schema.String }),
          ]);
          const every = yield* refusal(
            Request.get("/x").pipe(
              Request.query(Every),
              Request.setQuery("limit", "5"),
            ),
            { query: { a: "x" } },
          );
          expect(every.message).toContain("could never reach the client");
          const Some = Schema.Union([
            Schema.Struct({ a: Schema.String, limit: defaulted }),
            Schema.Struct({
              b: Schema.String,
              limit: Schema.optionalKey(Schema.String),
            }),
          ]);
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.query(Some),
                Request.setQuery("limit", "5"),
              ),
              { query: { b: "x" } },
            ),
          ).toBe("/x?b=x&limit=5");
        }),
      );

      it.effect("stays a default before the schema", () =>
        Effect.gen(function* () {
          const before = Request.get("/things?limit=5").pipe(
            Request.query(Limited),
          );
          expect(yield* urlOf(before, { query: {} })).toBe("/things?limit=25");
          expect(yield* urlOf(before, { query: { limit: 1 } })).toBe(
            "/things?limit=1",
          );
        }),
      );

      it.effect("is lifted by an unbind", () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(
              limited.pipe(
                Request.setQuery("limit", "5"),
                Request.unbind("query"),
              ),
              undefined,
            ),
          ).toBe("/things?limit=5");
        }),
      );

      it.effect("is not refused where the schema may write nothing", () =>
        Effect.gen(function* () {
          const Maybe = Schema.Struct({
            limit: Schema.OptionFromOptionalKey(Schema.String),
          });
          const maybe = Request.get("/x").pipe(
            Request.query(Maybe),
            Request.setQuery("limit", "5"),
          );
          expect(yield* urlOf(maybe, { query: { limit: Option.none() } })).toBe(
            "/x?limit=5",
          );
          const Sometimes = Schema.Struct({
            limit: Schema.UndefinedOr(Schema.String).pipe(
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          });
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.query(Sometimes),
                Request.setQuery("limit", "5"),
              ),
              { query: { limit: undefined } },
            ),
          ).toBe("/x?limit=5");
          // Optional on the decoded side too, so a caller's `{}` is built with no such field.
          for (const limit of [
            Schema.String.pipe(
              Schema.optional,
              Schema.withDecodingDefault(twentyFive),
            ),
            Schema.String.pipe(
              Schema.optionalKey,
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          ])
            expect(
              yield* urlOf(
                Request.get("/x").pipe(
                  Request.query(Schema.Struct({ limit })),
                  Request.setQuery("limit", "5"),
                ),
                { query: {} },
              ),
            ).toBe("/x?limit=5");
        }),
      );

      it.effect("is not this refusal under the omit strategy", () =>
        Effect.gen(function* () {
          const Omitted = Schema.Struct({
            limit: Schema.String.pipe(
              Schema.withDecodingDefaultKey(twentyFive, {
                encodingStrategy: "omit",
              }),
            ),
          });
          // The schema reads the name and never writes it, so the value goes either way.
          const error = yield* refusal(
            Request.get("/x").pipe(
              Request.query(Omitted),
              Request.setQuery("limit", "5"),
            ),
            { query: {} },
          );
          expect(error.message).toContain("would be lost");
          expect(error.message).not.toContain("could never reach the client");
        }),
      );

      // A struct-level transformation replaces the fields with their encoded forms, so the
      // encoding that shows the default is out of sight. The design page states the limit.
      // https://github.com/viell-dev/slop-effect-schema-http/issues/120
      it.effect("currently misses a field that a struct renames", () =>
        Effect.gen(function* () {
          const Renamed = Limited.pipe(
            Schema.encodeKeys({ limit: "page_size" }),
          );
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.query(Renamed),
                Request.setQuery("page_size", "5"),
              ),
              { query: {} },
            ),
          ).toBe("/x?page_size=25");
        }),
      );
    });

    it.effect("is told apart from a field no schema allows", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          typed.pipe(
            Request.setQuery("page", "2"),
            Request.setQuery("fields", "id"),
          ),
          input,
        );
        expect(error.message).toContain("could never reach the client");
        expect(error.message).toContain('"fields"');
      }),
    );
  });

  describe("schemas stack", () => {
    const Paging = Schema.Struct({
      page: Schema.optional(Schema.FiniteFromString),
    });
    const Sorting = Schema.Struct({ sort: Schema.optional(Schema.String) });
    const paged = Request.query(Paging);
    const sorted = Request.query(Sorting);

    it.effect("each adds its fields, and together they state the shape", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?sort=name&page=2").pipe(
          paged,
          sorted,
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/things?page=2&sort=name",
        );
        expect(yield* urlOf(request, { query: { page: 3, sort: "age" } })).toBe(
          "/things?page=3&sort=age",
        );
      }),
    );

    it.effect("each takes its own fields from one input", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Schema.Struct({ a: Schema.String })),
          Request.query(Schema.Struct({ b: Schema.NumberFromString })),
        );
        expect(yield* urlOf(request, { query: { a: "1", b: 2 } })).toBe(
          "/things?a=1&b=2",
        );
      }),
    );

    it.effect("work for headers", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          shared,
          Request.headers(Schema.Struct(Authorization)),
          Request.headers(Schema.Struct({ "X-Trace": Schema.String })),
        );
        expect(
          yield* linesOf(request, { headers: { "X-Trace": "t" } }),
        ).toEqual([
          ["Authorization", "Bearer shared"],
          ["X-Trace", "t"],
        ]);
      }),
    );

    it.effect("let a later schema allow what an earlier one does not", () =>
      Effect.gen(function* () {
        const halfway = Request.get("/things?sort=name").pipe(paged);
        const error = yield* refusal(halfway, { query: {} });
        expect(error.message).toContain('"sort"');
        expect(yield* urlOf(halfway.pipe(sorted), { query: {} })).toBe(
          "/things?sort=name",
        );
      }),
    );

    it.effect("widen a typed group in two steps", () =>
      Effect.gen(function* () {
        const typed = Request.get("/things").pipe(
          Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
        );
        const widened = typed.pipe(
          Request.query(
            Schema.Struct({ fields: Schema.optional(Schema.String) }),
          ),
          Request.setQuery("fields", "id,name"),
        );
        expect(yield* urlOf(widened, { query: { page: 1 } })).toBe(
          "/things?page=1&fields=id%2Cname",
        );
      }),
    );

    it.effect(
      "show an open schema every field, so its values have to fit",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(
            Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
            Request.query(Schema.Record(Schema.String, Schema.String)),
          );
          expect(
            yield* urlOf(request, { query: { page: "2", extra: "x" } }),
          ).toBe("/x?page=2&extra=x");
          const refused = { query: { page: 2 } } as never;
          expect(yield* Effect.flip(compile(request, refused))).toBeInstanceOf(
            Schema.SchemaError,
          );
        }),
    );

    it.effect("send a default through every schema that allows its name", () =>
      Effect.gen(function* () {
        const Short = Schema.Struct({
          limit: Schema.optional(Schema.String.check(Schema.isMaxLength(2))),
        });
        const request = Request.get("/things?limit=123").pipe(
          Request.query(Limit),
          Request.query(Short),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"limit"');
      }),
    );

    it.effect("keep a required field required under a later schema", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
          sorted,
          Request.setQuery("page", "2"),
        );
        const error = yield* refusal(request, { query: { page: 1 } });
        expect(error.message).toContain('"page"');
      }),
    );

    it.effect("share a constant for shared names", () =>
      Effect.gen(function* () {
        const ApiHeaders = { Authorization: Schema.optional(Schema.String) };
        const list = Request.get("https://api.test/things").pipe(
          Request.setHeader("Authorization", "Bearer token"),
          Request.setQuery("limit", "25"),
          Request.headers(
            Schema.Struct({ ...ApiHeaders, "x-trace": Schema.String }),
          ),
          Request.query(Limit),
          sorted,
        );
        const input = {
          headers: { "x-trace": "t" },
          query: { sort: "name" },
        };
        const compiled = yield* compile(list, input);
        expect(compiled.request.url).toBe(
          "https://api.test/things?limit=25&sort=name",
        );
        expect(compiled.headerLines).toEqual([
          ["Authorization", "Bearer token"],
          ["x-trace", "t"],
        ]);
        expect(
          yield* urlOf(list.pipe(Request.setQuery("limit", "5")), input),
        ).toBe("https://api.test/things?limit=5&sort=name");
        expect(
          yield* urlOf(list.pipe(Request.removeQuery("limit")), input),
        ).toBe("https://api.test/things?sort=name");
        const error = yield* refusal(
          list.pipe(Request.setQuery("fields", "id")),
          input,
        );
        expect(error.message).toContain('"fields"');
      }),
    );
  });

  describe("reading names from a schema", () => {
    it.effect(
      "uses wire names, so a renamed field goes by its encoded name",
      () =>
        Effect.gen(function* () {
          const Paging = Schema.Struct({
            page: Schema.optional(Schema.FiniteFromString),
          }).pipe(Schema.encodeKeys({ page: "page_number" }));
          expect(
            yield* urlOf(
              Request.get("/things?page_number=2").pipe(Request.query(Paging)),
              { query: {} },
            ),
          ).toBe("/things?page_number=2");
          const error = yield* refusal(
            Request.get("/things?page=2").pipe(Request.query(Paging)),
            { query: {} },
          );
          expect(error.message).toContain('"page"');
        }),
    );

    it.effect("reads a class's fields", () =>
      Effect.gen(function* () {
        class Filter extends Schema.Class<Filter>("Filter")({
          limit: Schema.optional(Schema.FiniteFromString),
        }) {}
        const allowed = Request.get("/things?limit=2").pipe(
          Request.query(Filter),
        );
        expect(yield* urlOf(allowed, { query: new Filter({}) })).toBe(
          "/things?limit=2",
        );
        const error = yield* refusal(
          Request.get("/things?other=2").pipe(Request.query(Filter)),
          { query: new Filter({}) },
        );
        expect(error.message).toContain('"other"');
      }),
    );

    it.effect("allows what any member of a union allows", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({
            a: Schema.String,
            b: Schema.optional(Schema.String),
          }),
          Schema.Struct({
            a: Schema.String,
            c: Schema.optional(Schema.String),
          }),
        ]);
        const request = Request.get("/x?b=1").pipe(Request.query(Either));
        expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x&b=1");
        const error = yield* refusal(
          Request.get("/x?d=1").pipe(Request.query(Either)),
          { query: { a: "x" } },
        );
        expect(error.message).toContain('"d"');
        // Every member writes `a`, so it is required; `b` is not.
        const required = yield* refusal(
          Request.get("/x").pipe(
            Request.query(Either),
            Request.setQuery("a", "1"),
          ),
          { query: { a: "x" } },
        );
        expect(required.message).toContain("could never reach the client");
      }),
    );

    it.effect("does not require what only some members of a union write", () =>
      Effect.gen(function* () {
        const Some = Schema.Union([
          Schema.Struct({ a: Schema.String, b: Schema.String }),
          Schema.Struct({
            a: Schema.String,
            b: Schema.String,
            d: Schema.String,
          }),
          Schema.Struct({
            a: Schema.String,
            c: Schema.optional(Schema.String),
          }),
        ]);
        const request = Request.get("/x").pipe(
          Request.query(Some),
          Request.setQuery("b", "1"),
        );
        expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x&b=1");
      }),
    );

    it.effect("states literal record keys as names", () =>
      Effect.gen(function* () {
        const Named = Schema.Record(Schema.Literals(["a", "b"]), Schema.String);
        const error = yield* refusal(
          Request.get("/x?c=1").pipe(Request.query(Named)),
          { query: { a: "1", b: "2" } },
        );
        expect(error.message).toContain('"c"');
      }),
    );
  });

  describe("a schema that allows other names", () => {
    const Open = Schema.Record(Schema.String, Schema.String);

    it.effect("allows any name from a record, in either order", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.setQuery("a", "raw"),
          Request.query(Open),
          Request.setQuery("b", "raw"),
        );
        expect(yield* urlOf(request, { query: { a: "typed" } })).toBe(
          "/x?a=typed&b=raw",
        );
      }),
    );

    it.effect("still checks each value", () =>
      Effect.gen(function* () {
        const Short = Schema.Record(
          Schema.String,
          Schema.String.check(Schema.isMaxLength(2)),
        );
        const error = yield* refusal(
          Request.get("/x?a=123").pipe(Request.query(Short)),
          { query: {} },
        );
        expect(error.message).toContain('"a"');
      }),
    );

    it.effect("reads text and lists under a record's value type", () =>
      Effect.gen(function* () {
        const Counts = Schema.Record(Schema.String, Schema.Number);
        expect(
          yield* urlOf(Request.get("/x?a=5").pipe(Request.query(Counts)), {
            query: {},
          }),
        ).toBe("/x?a=5");
        const Lists = Schema.Record(Schema.String, Schema.Array(Schema.String));
        expect(
          yield* urlOf(Request.get("/x?a=5").pipe(Request.query(Lists)), {
            query: {},
          }),
        ).toBe("/x?a=5");
      }),
    );

    it.effect("allows any name from Schema.StructWithRest", () =>
      Effect.gen(function* () {
        const Rest = Schema.StructWithRest(
          Schema.Struct({ "If-Match": Schema.optional(Schema.String) }),
          [Open],
        );
        const request = Request.put("/x").pipe(
          shared,
          Request.setHeader("if-match", "raw"),
          Request.headers(Rest),
        );
        expect(
          yield* linesOf(request, { headers: { "X-Other": "1" } }),
        ).toEqual([
          ["If-Match", "raw"],
          ["X-Other", "1"],
          ["Authorization", "Bearer shared"],
        ]);
      }),
    );

    // Defaults are added as pairs, which only a list of pairs reads. The design page states the limit.
    // https://github.com/viell-dev/slop-effect-schema-http/issues/120
    it.effect(
      "currently cannot take a default under a schema encoded as a Map",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1").pipe(
            Request.query(Schema.ReadonlyMap(Schema.String, Schema.String)),
          );
          const input = { query: new Map([["b", "2"]]) };
          const error = yield* refusal(request, input);
          expect(error.message).toContain('"a"');
          expect(
            yield* urlOf(request.pipe(Request.removeQuery("a")), input),
          ).toBe("/x?b=2");
        }),
    );

    it.effect("allows any name from a list of pairs", () =>
      Effect.gen(function* () {
        const Pairs = Schema.Array(
          Schema.Tuple([Schema.String, Schema.String]),
        );
        const request = Request.get("/x?a=raw&b=raw").pipe(
          Request.query(Pairs),
        );
        expect(yield* urlOf(request, { query: [["a", "typed"]] })).toBe(
          "/x?a=typed&b=raw",
        );
      }),
    );

    it.effect("takes fields a plain object would inherit", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?constructor=1&toString=2&__proto__=3").pipe(
              Request.query(Open),
            ),
            { query: {} },
          ),
        ).toBe("/x?constructor=1&toString=2&__proto__=3");
        expect(
          yield* urlOf(
            Request.get("/x?constructor=1&constructor=2").pipe(
              Request.query(
                Schema.Record(Schema.String, Schema.Array(Schema.String)),
              ),
            ),
            { query: {} },
          ),
        ).toBe("/x?constructor=1&constructor=2");
      }),
    );
  });

  describe("outside the check", () => {
    const Trace = Schema.Struct({
      trace: Schema.optional(Schema.FiniteFromString),
    });

    it.effect("leaves a native query edit before the schema alone", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(appendTrace("many"), Request.query(Trace)),
            { query: {} },
          ),
        ).toBe("/x?trace=many");
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              appendTrace("many"),
              Request.query(Schema.Struct({ q: Schema.String })),
            ),
            { query: { q: "1" } },
          ),
        ).toBe("/x?trace=many&q=1");
      }),
    );

    it.effect("leaves a native query edit after the schema alone", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(Request.query(Trace), appendTrace("many")),
            { query: {} },
          ),
        ).toBe("/x?trace=many");
      }),
    );

    it.effect("leaves a native header edit alone", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("/x").pipe(
            Request.mapEffect((request) =>
              Effect.succeed(
                HttpClientRequest.setHeader(request, "x-stray", "1"),
              ),
            ),
            Request.headers(Schema.Struct({ "X-Trace": Schema.String })),
          ),
          { headers: { "X-Trace": "t" } },
        );
        expect(compiled.request.headers["x-stray"]).toBe("1");
      }),
    );
  });

  describe("Request.unbind", () => {
    const Paging = Schema.Struct({ page: Schema.FiniteFromString });
    const typed = Request.get("/things").pipe(
      Request.setQuery("locale", "sv"),
      Request.query(Paging),
      Request.query(Schema.Struct({ locale: Schema.optional(Schema.String) })),
    );

    it.effect("removes the bindings, their input and the shape", () =>
      Effect.gen(function* () {
        const raw = typed.pipe(Request.unbind("query"));
        expectTypeOf(raw).toEqualTypeOf<
          Request.Request<unknown, Schema.SchemaError | Request.InvalidRequest>
        >();
        expect(yield* urlOf(raw, undefined)).toBe("/things?locale=sv");
        expect(
          yield* urlOf(raw.pipe(Request.setQuery("any", "name")), undefined),
        ).toBe("/things?locale=sv&any=name");
      }),
    );

    it.effect("replaces a binding when followed by a new one", () =>
      Effect.gen(function* () {
        const variant = typed.pipe(
          Request.unbind("query"),
          Request.removeQuery("locale"),
          Request.query(Schema.Struct({ sort: Schema.String })),
        );
        expect(yield* urlOf(variant, { query: { sort: "name" } })).toBe(
          "/things?sort=name",
        );
        void (() =>
          // @ts-expect-error: the earlier schema's input is gone
          compile(variant, { query: { page: 1 } }));
      }),
    );

    it.effect("leaves the request it was derived from unchanged", () =>
      Effect.gen(function* () {
        void typed.pipe(Request.unbind("query"));
        expect(yield* urlOf(typed, { query: { page: 1 } })).toBe(
          "/things?page=1&locale=sv",
        );
      }),
    );

    it.effect("clears headers, and leaves other groups' input in place", () =>
      Effect.gen(function* () {
        const request = Request.post("/things").pipe(
          Request.setHeader("X-Raw", "1"),
          Request.headers(
            Schema.Struct({ "X-Raw": Schema.optional(Schema.String) }),
          ),
          Request.body(Body.text),
          Request.unbind("headers"),
        );
        expectTypeOf<Parameters<typeof request.prepare>[0]>().toEqualTypeOf<
          Omit<
            { readonly headers: { readonly "X-Raw"?: string | undefined } } & {
              readonly body: string;
            },
            "headers"
          >
        >();
        const compiled = yield* compile(request, { body: "b" });
        expect(compiled.headerLines).toContainEqual(["X-Raw", "1"]);
        expect(bodyText(compiled.request)).toBe("b");
      }),
    );

    it.effect("clears a path binding, leaving the constructor's path", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.path(Schema.String, (id) => `/other/${id}`),
          Request.unbind("path"),
        );
        expect(yield* urlOf(request, undefined)).toBe("/things");
      }),
    );

    it.effect("clears a body binding and its automatic fields", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/things").pipe(
            Request.body(Body.text),
            Request.unbind("body"),
          ),
          undefined,
        );
        expect(compiled.request.body._tag).toBe("Empty");
        expect(compiled.request.headers["content-type"]).toBeUndefined();
      }),
    );

    it.effect("replaces a body with another of a different type", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/things").pipe(
            Request.body(Body.text),
            Request.unbind("body"),
            Request.body(Body.json),
          ),
          { body: { id: 1 } },
        );
        expect(bodyText(compiled.request)).toBe('{"id":1}');
        expect(compiled.request.headers["content-type"]).toBe(
          "application/json",
        );
      }),
    );

    it.effect("affects only the bindings before it", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Paging),
          Request.unbind("query"),
          Request.query(Paging),
          Request.setQuery("stray", "1"),
        );
        const error = yield* refusal(request, { query: { page: 1 } });
        expect(error.message).toContain('"stray"');
      }),
    );

    it.effect("leaves a mapEffect that reads the removed input nothing", () =>
      Effect.gen(function* () {
        const seen: Array<unknown> = [];
        const noteQuery = Request.mapEffect(
          (native, input: { readonly query: unknown }) =>
            Effect.sync(() => {
              seen.push(input.query);
              return native;
            }),
        );
        const noted = Request.get("/things").pipe(
          Request.query(Paging),
          noteQuery,
        );
        yield* compile(
          noted.pipe(
            Request.headers(Schema.Struct({ "x-a": Schema.String })),
            Request.unbind("query"),
          ),
          { headers: { "x-a": "1" } },
        );
        expect(seen).toEqual([undefined]);

        const exit = yield* Effect.exit(
          compile(noted.pipe(Request.unbind("query")), undefined),
        );
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }),
    );

    it.effect(
      "skips a binding that mapInput feeds, keeping what it requires",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things").pipe(
            Request.query(Paging),
            Request.mapInput((input: { readonly page: number }) => ({
              query: { page: input.page },
            })),
            Request.unbind("query"),
          );
          expectTypeOf<Parameters<typeof request.prepare>[0]>().toEqualTypeOf<{
            readonly page: number;
          }>();
          expect(yield* urlOf(request, { page: 1 })).toBe("/things");
        }),
    );

    it("keeps an input it cannot reach", () => {
      const scalar = Request.get("/").pipe(
        Request.mapInput((input: number) => input),
        Request.unbind("query"),
      );
      expectTypeOf<
        Parameters<typeof scalar.prepare>[0]
      >().toEqualTypeOf<number>();
    });

    it("refuses anything that is not a group", () => {
      // @ts-expect-error: fragments are not a group
      void Request.unbind("fragment");
    });
  });

  describe("what a caller can pass", () => {
    // https://github.com/viell-dev/slop-effect-schema-http/issues/111
    it.effect("replaces a value a schema allows", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          shared,
          Request.headers(Schema.Struct(Authorization)),
        );
        expect(
          yield* linesOf(request, {
            headers: { Authorization: "Bearer mine" },
          }),
        ).toEqual([["Authorization", "Bearer mine"]]);
      }),
    );

    it.effect("is limited by Request.mapInput, which fixes the value", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.headers(Schema.Struct({ Authorization: Schema.String })),
          Request.mapInput(() => ({
            headers: { Authorization: "Bearer shared" },
          })),
        );
        expect(yield* linesOf(request, undefined)).toEqual([
          ["Authorization", "Bearer shared"],
        ]);
      }),
    );
  });

  describe("types", () => {
    it("lets a generic helper accept any request", () => {
      const typed = withService(Request.get("/x").pipe(Request.query(Limit)));
      expectTypeOf(typed).toEqualTypeOf<
        Request.Request<
          { readonly query: Request.Input<typeof Limit> },
          Schema.SchemaError | Request.InvalidRequest
        >
      >();
      expectTypeOf(withoutQuery(Request.get("/x"))).toEqualTypeOf<
        Request.Request<unknown>
      >();
    });

    it("lets a shared transform compose before or after a schema", () => {
      const localized = flow(
        Request.setQuery("locale", "sv"),
        Request.setHeader("X-Locale", "sv"),
      );
      void Request.get("/x").pipe(localized, Request.query(Limit));
      void Request.get("/x").pipe(Request.query(Limit), localized);
    });

    it("requires the input of every stacked schema", () => {
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ a: Schema.String })),
        Request.query(Schema.Struct({ b: Schema.String })),
      );
      void Request.compile(request, { query: { a: "1", b: "2" } });
      // @ts-expect-error: the second schema's field is missing
      void Request.compile(request, { query: { a: "1" } });
    });

    it("no longer takes the two binding parameters", () => {
      // @ts-expect-error: `Request` takes input, errors and services
      expectTypeOf<Request.Request<unknown, never, never, false, false>>();
    });
  });
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
