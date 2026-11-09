import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Schedule,
  Schema,
  SchemaTransformation,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";
import { failureOf, getItem, Nonce, retries } from "../../test/operation.js";
import {
  type BodyProbe,
  bodyText,
  empty,
  json,
  probeBody,
  synthetic,
  text,
} from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import * as Transport from "./Transport.js";
import * as UrlEncoding from "./UrlEncoding.js";

/** Read while decoding a response. */
class Prefix extends Context.Service<Prefix, string>()("test/Prefix") {}

/** Read while encoding a request. */
class Suffix extends Context.Service<Suffix, string>()("test/Suffix") {}

/** A label whose decoding reads `Prefix` and whose encoding reads `Suffix`. */
const Label = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (wire: string) =>
        Effect.map(Prefix, (prefix) => `${prefix}${wire}`),
      encode: (label: string) =>
        Effect.map(Suffix, (suffix) => `${label}${suffix}`),
    }),
  ),
);

describe("Operation.make", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/24
  it.effect(
    "client URL parameters reserialize the compiled query as form data",
    () =>
      Effect.gen(function* () {
        const request = Request.get("https://api.test/svc").pipe(
          Request.setQuery("wsdl", null),
          Request.setQuery("q", "a b"),
        );
        for (const useParameter of [true, false]) {
          const server = synthetic(() => empty(204));
          yield* Operation.make(request, Response.status(204, Body.empty), {
            transformClient: (client) =>
              client.pipe(
                HttpClient.mapRequest((native) =>
                  useParameter
                    ? HttpClientRequest.appendUrlParam(native, "key", "abc")
                    : HttpClientRequest.setUrl(native, `${native.url}&key=abc`),
                ),
              ),
          })
            .execute(undefined)
            .pipe(Effect.provide(server.layer));
          const exchange = server.exchanges[0]!;
          expect(exchange.url).toBe(
            useParameter
              ? "https://api.test/svc?wsdl&q=a%20b"
              : "https://api.test/svc?wsdl&q=a%20b&key=abc",
          );
          expect(exchange.href).toBe(
            useParameter
              ? "https://api.test/svc?wsdl=&q=a+b&key=abc"
              : "https://api.test/svc?wsdl&q=a%20b&key=abc",
          );
        }
      }),
  );

  it.effect(
    "dispatches the compiled request and decodes the selected response",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => json(200, { id: 1 }));
        const value = yield* getItem
          .execute(undefined)
          .pipe(Effect.provide(server.layer));
        expect(value).toEqual({ id: 1 });
        expect(server.exchanges).toHaveLength(1);
        expect(server.exchanges[0]?.request.method).toBe("GET");
        expect(server.exchanges[0]?.url).toBe("https://api.test/items/1");
      }),
  );

  it.effect(
    "stays cold until the returned effect runs, and reruns per evaluation",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => json(200, {}));
        const execution = getItem.execute(undefined);
        expect(server.exchanges).toHaveLength(0);
        yield* execution.pipe(Effect.provide(server.layer));
        yield* execution.pipe(Effect.provide(server.layer));
        expect(server.exchanges).toHaveLength(2);
      }),
  );

  it.effect("sets Accept from the response contract's media types", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, {}));
      yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.json).pipe(
          Response.orElse(Response.status(400, Body.text)),
        ),
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges[0]?.request.headers.accept).toBe(
        "application/json, text/plain",
      );
      expect(server.exchanges[0]?.headerLines).toContainEqual([
        "accept",
        "application/json, text/plain",
      ]);
    }),
  );

  it.effect("keeps a declared Accept header", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, {}));
      yield* Operation.make(
        Request.get("https://api.test/").pipe(
          Request.headers(Schema.Struct({ Accept: Schema.String })),
        ),
        Response.status(200, Body.json),
      )
        .execute({ headers: { Accept: "application/vnd.legacy+json" } })
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges[0]?.request.headers.accept).toBe(
        "application/vnd.legacy+json",
      );
      expect(server.exchanges[0]?.headerLines).toEqual([
        ["Accept", "application/vnd.legacy+json"],
      ]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/102
  it.effect("gives a client constructor query text as written", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      yield* Operation.make(
        Request.get("https://api.test/x?a=1;b=2&&q=a+b&c=%41"),
        Response.status(204, Body.empty),
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      const exchange = server.exchanges[0]!;
      expect(exchange.url).toBe("https://api.test/x?a=1;b=2&&q=a+b&c=%41");
      expect(exchange.href).toBe("https://api.test/x?a=1;b=2&&q=a+b&c=%41");
    }),
  );

  // Text passes to the client as written; what the client then does with it is its own affair.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/102
  it.effect("leaves normalizing written text to the client", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      yield* Operation.make(
        Request.get("https://api.test/x?q=a b"),
        Response.status(204, Body.empty),
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      const exchange = server.exchanges[0]!;
      expect(exchange.url).toBe("https://api.test/x?q=a b");
      expect(exchange.href).toBe("https://api.test/x?q=a%20b");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/83
  it.effect("gives a client the query before the fragment", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      yield* Operation.make(
        Request.get("").pipe(
          Request.path(Schema.String, (value) => `https://api.test/${value}`),
          Request.setQuery("q", "1"),
        ),
        Response.status(204, Body.empty),
      )
        .execute({ path: "users#top" })
        .pipe(Effect.provide(server.layer));
      const exchange = server.exchanges[0]!;
      expect(exchange.url).toBe("https://api.test/users?q=1");
      expect(exchange.request.hash).toStrictEqual(Option.some("top"));
      expect(exchange.href).toBe("https://api.test/users?q=1#top");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/93
  it.effect.each([
    ["a?b=1#top", "https://api.test/a?b=1#top", "top"],
    ["a#b c", "https://api.test/a#b%20c", "b c"],
    ["a#", "https://api.test/a", ""],
  ] as const)(
    "gives a client a constructor fragment, %s",
    ([url, href, hash]) =>
      Effect.gen(function* () {
        const server = synthetic(() => empty(204));
        yield* Operation.make(
          Request.get(`https://api.test/${url}`),
          Response.status(204, Body.empty),
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer));
        const exchange = server.exchanges[0]!;
        expect(exchange.href).toBe(href);
        expect(exchange.request.hash).toStrictEqual(Option.some(hash));
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/83
  it.effect("leaves the fragment text to a client built with makeWith", () =>
    Effect.gen(function* () {
      const seen: Array<HttpClientRequest.HttpClientRequest> = [];
      const raw = HttpClient.makeWith<
        HttpClientError.HttpClientError,
        never,
        HttpClientError.HttpClientError,
        never
      >(
        Effect.map((request: HttpClientRequest.HttpClientRequest) => {
          seen.push(request);
          return HttpClientResponse.fromWeb(request, empty(204));
        }),
        Effect.succeed,
      );
      yield* Operation.make(
        Request.get("").pipe(Request.baseUrl("https://x.test/a#b c")),
        Response.status(204, Body.empty),
      )
        .execute(undefined)
        .pipe(Effect.provideService(HttpClient.HttpClient, raw));
      expect(seen[0]?.url).toBe("https://x.test/a");
      expect(seen[0]?.hash).toStrictEqual(Option.some("b c"));
    }),
  );

  it.effect("sends no Accept header when no case declares a media type", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      yield* Operation.make(
        Request.del("https://api.test/items/1"),
        Response.status(204, Body.empty),
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges[0]?.request.headers.accept).toBeUndefined();
    }),
  );

  it.effect("passes custom methods and unregistered statuses through", () =>
    Effect.gen(function* () {
      const server = synthetic(() =>
        text(207, "<multistatus/>", { "content-type": "application/xml" }),
      );
      const value = yield* Operation.make(
        Request.make("PROPFIND", "https://dav.test/files/").pipe(
          Request.setHeader("Depth", "1"),
          Request.body(Body.text),
        ),
        Response.status(207, Body.text),
      )
        .execute({ body: "<propfind/>" })
        .pipe(Effect.provide(server.layer));
      expect(value).toBe("<multistatus/>");
      expect(server.exchanges[0]?.request.method).toBe("PROPFIND");
      expect(bodyText(server.exchanges[0]!.request)).toBe("<propfind/>");
    }),
  );

  it.effect(
    "provides the original header lines to a line-preserving provider",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => empty(204));
        yield* Operation.make(
          Request.get("https://api.test/").pipe(
            Request.headers(
              Schema.Struct({ "X-Scope": Schema.Array(Schema.String) }),
            ),
          ),
          Response.status(204, Body.empty),
        )
          .execute({ headers: { "X-Scope": ["read", "write"] } })
          .pipe(Effect.provide(server.layer));
        const exchange = server.exchanges[0]!;
        expect(exchange.request.headers["x-scope"]).toBe("read, write");
        expect(exchange.headerLines).toEqual([
          ["X-Scope", "read"],
          ["X-Scope", "write"],
        ]);
      }),
  );

  it.effect(
    "reconciles header lines with fields added by native middleware",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => empty(204));
        yield* Operation.make(
          Request.get("https://api.test/").pipe(
            Request.appendHeader("X-Scope", "read"),
            Request.appendHeader("X-Scope", "write"),
          ),
          Response.status(204, Body.empty),
        )
          .execute(undefined)
          .pipe(
            Effect.provideService(HttpClient.HttpClient, server.client),
            Effect.provideService(HttpClient.TracerPropagationEnabled, true),
          );
        const lines = server.exchanges[0]!.headerLines;
        expect(lines.filter(([name]) => name === "X-Scope")).toEqual([
          ["X-Scope", "read"],
          ["X-Scope", "write"],
        ]);
        expect(lines.map(([name]) => name)).toContain("traceparent");
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect(
    "gives middleware lowercase headers and a provider the written lines",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => empty(204));
        const seen: Array<Readonly<Record<string, string>>> = [];
        yield* Operation.make(
          Request.get("https://api.test/").pipe(
            Request.setHeader("X-API-Key", "k"),
            Request.appendHeader("X-Tag", "a"),
            Request.appendHeader("x-tag", "b"),
          ),
          Response.status(204, Body.empty),
          {
            transformClient: HttpClient.mapRequest((request) => {
              seen.push({ ...request.headers });
              return request;
            }),
          },
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer));
        expect(seen).toEqual([{ "x-api-key": "k", "x-tag": "a, b" }]);
        expect(server.exchanges[0]?.headerLines).toEqual([
          ["X-API-Key", "k"],
          ["X-Tag", "a"],
          ["x-tag", "b"],
        ]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("replaces a spelled line when middleware changes its value", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      yield* Operation.make(
        Request.get("https://api.test/").pipe(
          Request.setHeader("X-API-Key", "k"),
          Request.setHeader("X-Kept", "1"),
        ),
        Response.status(204, Body.empty),
        {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader("x-api-key", "rotated"),
          ),
        },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges[0]?.headerLines).toEqual([
        ["X-Kept", "1"],
        ["x-api-key", "rotated"],
      ]);
    }),
  );

  it.effect("exposes provider-attached response lines in metadata", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          Transport.withResponseHeaders(
            HttpClientResponse.fromWeb(
              request,
              new globalThis.Response(null, {
                status: 204,
                headers: { "x-scope": "a, b" },
              }),
            ),
            [
              ["X-Scope", "a"],
              ["X-Scope", "b"],
            ],
          ),
        ),
      );
      const result = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Response.tag("NoContent", Body.empty)),
      )
        .execute(undefined)
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(result.metadata.headers["x-scope"]).toBe("a, b");
      expect(result.metadata.headerLines).toStrictEqual(
        Option.some([
          ["X-Scope", "a"],
          ["X-Scope", "b"],
        ]),
      );
    }),
  );
});

/** What a client receives for a request whose response declares JSON. */
const sent = <I, E>(
  request: Request.Request<I, E>,
  input: I,
  options?: Operation.Options,
) =>
  Effect.gen(function* () {
    const server = synthetic(() => json(200, {}));
    yield* Operation.make(request, Response.status(200, Body.json), options)
      .execute(input)
      .pipe(Effect.provide(server.layer));
    return server.exchanges[0]!;
  });

// https://github.com/viell-dev/slop-effect-schema-http/issues/100
describe("automatic Accept", () => {
  const get = Request.get("https://api.test/");

  it.effect("stops with removeHeader, in any spelling", () =>
    Effect.gen(function* () {
      for (const name of ["accept", "Accept", "ACCEPT"]) {
        const exchange = yield* sent(
          get.pipe(Request.removeHeader(name)),
          undefined,
        );
        expect(exchange.request.headers.accept).toBeUndefined();
        expect(exchange.headerLines).toEqual([]);
      }
    }),
  );

  it.effect("gives way to a raw value, keeping its spelling", () =>
    Effect.gen(function* () {
      const exchange = yield* sent(
        get.pipe(Request.setHeader("Accept", "text/weird")),
        undefined,
      );
      expect(exchange.request.headers.accept).toBe("text/weird");
      expect(exchange.headerLines).toEqual([["Accept", "text/weird"]]);
    }),
  );

  it.effect("gives way to an empty value", () =>
    Effect.gen(function* () {
      const exchange = yield* sent(
        get.pipe(Request.setHeader("accept", "")),
        undefined,
      );
      expect(exchange.request.headers.accept).toBe("");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect("gives way to a default under an omitted schema field", () =>
    Effect.gen(function* () {
      const Optional = Schema.Struct({
        Accept: Schema.optional(Schema.String),
      });
      const exchange = yield* sent(
        get.pipe(
          Request.setHeader("accept", "text/weird"),
          Request.headers(Optional),
        ),
        { headers: {} },
      );
      expect(exchange.request.headers.accept).toBe("text/weird");
      expect(exchange.headerLines).toEqual([["Accept", "text/weird"]]);
      const automatic = yield* sent(get.pipe(Request.headers(Optional)), {
        headers: {},
      });
      expect(automatic.request.headers.accept).toBe("application/json");
    }),
  );

  it.effect("removes a declaration and the automatic value together", () =>
    Effect.gen(function* () {
      const exchange = yield* sent(
        get.pipe(
          Request.setHeader("accept", "text/weird"),
          Request.removeHeader("accept"),
        ),
        undefined,
      );
      expect(exchange.request.headers.accept).toBeUndefined();
    }),
  );

  it.effect("returns after a removal limited to one value", () =>
    Effect.gen(function* () {
      const exchange = yield* sent(
        get.pipe(
          Request.setHeader("accept", "text/weird"),
          Request.removeHeader("accept", "text/weird"),
        ),
        undefined,
      );
      expect(exchange.request.headers.accept).toBe("application/json");
    }),
  );

  it.effect("lets a later declaration end a removal", () =>
    Effect.gen(function* () {
      const exchange = yield* sent(
        get.pipe(
          Request.removeHeader("accept"),
          Request.setHeader("Accept", "text/weird"),
        ),
        undefined,
      );
      expect(exchange.request.headers.accept).toBe("text/weird");
    }),
  );

  it.effect("sends what a native edit or a schema declares", () =>
    Effect.gen(function* () {
      const removed = get.pipe(Request.removeHeader("accept"));
      const edited = yield* sent(
        removed.pipe(
          Request.mapEffect((request) =>
            Effect.succeed(
              HttpClientRequest.setHeader(request, "accept", "text/weird"),
            ),
          ),
        ),
        undefined,
      );
      expect(edited.request.headers.accept).toBe("text/weird");
      const schema = yield* sent(
        removed.pipe(Request.headers(Schema.Struct({ Accept: Schema.String }))),
        { headers: { Accept: "text/weird" } },
      );
      expect(schema.headerLines).toEqual([["Accept", "text/weird"]]);
    }),
  );

  it.effect("applies when an optional schema field is left out", () =>
    Effect.gen(function* () {
      const Optional = Schema.Struct({
        Accept: Schema.optional(Schema.String),
      });
      const omitted = yield* sent(get.pipe(Request.headers(Optional)), {
        headers: {},
      });
      expect(omitted.request.headers.accept).toBe("application/json");
      const removed = yield* sent(
        get.pipe(Request.removeHeader("accept"), Request.headers(Optional)),
        { headers: {} },
      );
      expect(removed.request.headers.accept).toBeUndefined();
    }),
  );

  it.effect("still gives way to client middleware", () =>
    Effect.gen(function* () {
      const exchange = yield* sent(get, undefined, {
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.removeHeader("accept"),
        ),
      });
      expect(exchange.request.headers.accept).toBeUndefined();
    }),
  );
});

describe("Operation failures", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect("refuses an incompatible shape before anything is sent", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, {}));
      const operation = Operation.make(
        Request.get("https://api.test/x?stray=1").pipe(
          Request.query(Schema.Struct({ q: Schema.String })),
        ),
        Response.status(200, Body.json),
      );
      const error = yield* Effect.flip(
        operation.execute({ query: { q: "a" } }),
      ).pipe(Effect.provide(server.layer));
      expect(error).toBeInstanceOf(Request.InvalidRequest);
      expect(server.exchanges).toEqual([]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect("leaves a client's own edit outside the check", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, {}));
      const operation = Operation.make(
        Request.get("https://api.test/x").pipe(
          Request.headers(Schema.Struct({ "X-Trace": Schema.String })),
        ),
        Response.status(200, Body.json),
        {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader("authorization", "Bearer client"),
          ),
        },
      );
      yield* operation
        .execute({ headers: { "X-Trace": "t" } })
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges[0]!.request.headers.authorization).toBe(
        "Bearer client",
      );
    }),
  );

  it.effect("refuses invalid input before any dispatch", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, {}));
      const exit = yield* Operation.make(
        Request.post("https://api.test/users").pipe(
          Request.body(
            Body.jsonSchema(Schema.Struct({ name: Schema.NonEmptyString })),
          ),
        ),
        Response.status(201, Body.json),
        { policy: retries(3) },
      )
        .execute({ body: { name: "" } })
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(Schema.isSchemaError(failureOf(exit))).toBe(true);
      expect(server.exchanges).toHaveLength(0);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/96
  it.effect("passes a GET body to the client", () =>
    Effect.gen(function* () {
      const server = synthetic(() => text(200, "stored"));
      const stored = yield* Operation.make(
        Request.get("https://soap.test/download").pipe(Request.body(Body.text)),
        Response.status(200, Body.text),
      )
        .execute({ body: "<Envelope/>" })
        .pipe(Effect.provide(server.layer));
      expect(stored).toBe("stored");
      expect(server.exchanges).toHaveLength(1);
      expect(server.exchanges[0]?.request.method).toBe("GET");
      expect(bodyText(server.exchanges[0]!.request)).toBe("<Envelope/>");
    }),
  );

  it.effect(
    "drains an unmodelled response and fails with UnexpectedResponse",
    () =>
      Effect.gen(function* () {
        const probe = probeBody(["<html>", "error page", "</html>"]);
        const server = synthetic(
          () =>
            new globalThis.Response(probe.body, {
              status: 404,
              headers: { "content-type": "text/html" },
            }),
        );
        const exit = yield* getItem
          .execute(undefined)
          .pipe(Effect.provide(server.layer), Effect.exit);
        const error = failureOf(exit);
        expect(error).toBeInstanceOf(Response.UnexpectedResponse);
        if (!(error instanceof Response.UnexpectedResponse)) return;
        expect(error.metadata.status).toBe(404);
        expect(probe.finished()).toBe(true);
      }),
  );

  it.effect("drains each unmatched body before the next attempt", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const probes: Array<BodyProbe> = [];
      const server = synthetic((_, index) => {
        events.push(`send ${index + 1}`);
        const probe = probeBody(["<html>", "busy", "</html>"]);
        probes.push(probe);
        return new globalThis.Response(probe.body, {
          status: 503,
          headers: { "content-type": "text/html" },
        });
      });
      const exit = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.json),
        {
          policy: Policy.make(Schedule.recurs(1), {
            // The classifier runs after each attempt and before the next one.
            while: (reason) => {
              const probe = probes.at(-1);
              events.push(
                `${probe?.finished() === true ? "drained" : "unread"} ${probes.length}`,
              );
              return Policy.transient(reason);
            },
          }),
        },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(failureOf(exit)).toBeInstanceOf(Response.UnexpectedResponse);
      expect(events).toEqual(["send 1", "drained 1", "send 2", "drained 2"]);
      expect(probes.map((probe) => probe.cancelled())).toEqual([false, false]);
    }),
  );

  it.effect("keeps provider response lines on UnexpectedResponse", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          Transport.withResponseHeaders(
            HttpClientResponse.fromWeb(
              request,
              new globalThis.Response("<html>bad gateway</html>", {
                status: 502,
                headers: { "x-trace": "edge-1, origin-2" },
              }),
            ),
            [
              ["X-Trace", "edge-1"],
              ["X-Trace", "origin-2"],
            ],
          ),
        ),
      );
      const exit = yield* getItem
        .execute(undefined)
        .pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.exit,
        );
      const error = failureOf(exit);
      expect(error).toBeInstanceOf(Response.UnexpectedResponse);
      if (!(error instanceof Response.UnexpectedResponse)) return;
      expect(error.metadata.status).toBe(502);
      expect(error.metadata.headers["x-trace"]).toBe("edge-1, origin-2");
      expect(error.metadata.headerLines).toStrictEqual(
        Option.some([
          ["X-Trace", "edge-1"],
          ["X-Trace", "origin-2"],
        ]),
      );
    }),
  );

  it.effect("reads an unmodelled response through an explicit fallback", () =>
    Effect.gen(function* () {
      const server = synthetic(() => text(418, "short and stout"));
      const value = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Response.tag("Ok", Body.json)).pipe(
          Response.orElse(
            Response.when(() => true, Response.tag("Other", Body.text)),
          ),
        ),
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(value).toMatchObject({ _tag: "Other", value: "short and stout" });
    }),
  );

  it.effect("reports a body that fails its schema as a DecodeError", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, { id: "not a number" }));
      const exit = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(
          200,
          Body.json.pipe(Body.schema(Schema.Struct({ id: Schema.Number }))),
        ),
        { policy: retries(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      const error = failureOf(exit);
      expect(error).toBeInstanceOf(Response.DecodeError);
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect("surfaces transport failures as HttpClientError", () =>
    Effect.gen(function* () {
      const server = synthetic((exchange) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: exchange.request,
              description: "connection refused",
            }),
          }),
        ),
      );
      const exit = yield* getItem
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      const error = failureOf(exit);
      expect(HttpClientError.isHttpClientError(error)).toBe(true);
      expect(
        HttpClientError.isHttpClientError(error) && error.reason._tag,
      ).toBe("TransportError");
    }),
  );

  it.effect(
    "reports a Body.mapEffect failure as a DecodeError with its cause",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => text(200, "x"));
        const refused = Body.text.pipe(
          Body.mapEffect(() => Effect.fail("refused" as const)),
        );
        const error = yield* Operation.make(
          Request.get("https://api.test/"),
          Response.status(200, refused),
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer), Effect.flip);
        expect(error).toBeInstanceOf(Response.DecodeError);
        expect(error).toMatchObject({ cause: "refused" });
      }),
  );

  it.effect("treats an exception in a custom decoder as a defect", () =>
    Effect.gen(function* () {
      const server = synthetic(() => text(200, "x"));
      const broken = Body.decoder((): Effect.Effect<string> => {
        throw new Error("decoder bug");
      });
      const exit = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, broken),
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect("keeps the response on a client error, with what it read", () =>
    Effect.gen(function* () {
      const malformed = synthetic(() => text(200, "not json"));
      const decoding = yield* getItem
        .execute(undefined)
        .pipe(Effect.provide(malformed.layer), Effect.flip);
      expect(decoding).toBeInstanceOf(Response.DecodeError);
      expect(decoding).toMatchObject({ cause: { response: { status: 200 } } });

      const refusing = synthetic(() => text(500, "refused"));
      const rejected = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.text),
        { transformClient: HttpClient.filterStatusOk },
      )
        .execute(undefined)
        .pipe(Effect.provide(refusing.layer), Effect.flip);
      expect(rejected).toMatchObject({ response: { status: 500 } });
    }),
  );

  it("keeps mapped errors in the result and failure unions", () => {
    class Missing extends Data.TaggedError("Missing") {}
    const operation = Operation.make(
      Request.get("/"),
      Response.status(
        200,
        Response.tag(
          "Ok",
          Body.json.pipe(Body.schema(Schema.Struct({ id: Schema.Number }))),
        ),
      ).pipe(
        Response.orElse(
          Response.status(401, Response.tag("Unauthorized", Body.text)),
        ),
      ),
    );
    type Result = Effect.Success<ReturnType<typeof operation.execute>>;
    expectTypeOf<Result["_tag"]>().toEqualTypeOf<"Ok" | "Unauthorized">();
    const read = (result: Result): { readonly id: number } => {
      // @ts-expect-error: the body is a string for Unauthorized; narrow first
      const unnarrowed: { readonly id: number } = result.value;
      void unnarrowed;
      if (result._tag === "Ok") {
        expectTypeOf(result.value).toEqualTypeOf<{ readonly id: number }>();
        return result.value;
      }
      expectTypeOf(result.value).toEqualTypeOf<string>();
      return { id: 0 };
    };
    void read;
    type Failure = Effect.Error<ReturnType<typeof operation.execute>>;
    expectTypeOf<Response.UnexpectedResponse>().toExtend<Failure>();
    expectTypeOf<Request.InvalidRequest>().toExtend<Failure>();
    expectTypeOf<Cause.TimeoutError>().toExtend<Failure>();
    expectTypeOf<HttpClientError.HttpClientError>().toExtend<Failure>();

    const found = operation.pipe(
      Operation.mapEffect((result) =>
        result._tag === "Ok"
          ? Effect.succeed(result.value)
          : Effect.fail(new Missing()),
      ),
    );
    type Found = ReturnType<typeof found.execute>;
    expectTypeOf<Effect.Success<Found>>().toEqualTypeOf<{
      readonly id: number;
    }>();
    expectTypeOf<Effect.Error<Found>>().toEqualTypeOf<Failure | Missing>();
  });
});

describe("Operation services", () => {
  // A request needs both, because an input on the encoded side goes through the decoder.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/113
  it.effect("asks a request for both services and a response for one", () =>
    Effect.gen(function* () {
      const send = Operation.make(
        Request.post("https://api.test/labels").pipe(
          Request.body(Body.jsonSchema(Label)),
        ),
        Response.status(204, Body.empty),
      );
      const receive = Operation.make(
        Request.get("https://api.test/labels/1"),
        Response.status(200, Body.jsonSchema(Label)),
      );
      expectTypeOf<
        Effect.Services<ReturnType<typeof send.execute>>
      >().toEqualTypeOf<Suffix | Prefix | HttpClient.HttpClient>();
      expectTypeOf<
        Effect.Services<ReturnType<typeof receive.execute>>
      >().toEqualTypeOf<Prefix | HttpClient.HttpClient>();

      const server = synthetic((exchange) =>
        exchange.request.method === "POST" ? empty(204) : json(200, "wire"),
      );
      yield* send
        .execute({ body: "label" })
        .pipe(
          Effect.provide(server.layer),
          Effect.provideService(Suffix, "!"),
          Effect.provideService(Prefix, ">"),
        );
      expect(bodyText(server.exchanges[0]!.request)).toBe('"label!"');
      expect(
        yield* receive
          .execute(undefined)
          .pipe(
            Effect.provide(server.layer),
            Effect.provideService(Prefix, ">"),
          ),
      ).toBe(">wire");
    }),
  );

  it.effect(
    "requires client middleware services and runs the middleware in each attempt's scope",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const signals: Array<AbortSignal> = [];
        const server = synthetic((exchange, index) => {
          if (index > 0)
            events.push(
              `attempt ${index} ${signals[index - 1]!.aborted ? "aborted" : "open"}`,
            );
          signals.push(exchange.signal);
          events.push(`send ${exchange.request.headers["x-nonce"]}`);
          return index === 0 ? text(503, "busy") : text(200, "done");
        });
        // Body.text reads through response.text, which aborts the request only on interruption,
        // unlike draining response.stream. Only the attempt's scope can abort these signals.
        const operation = Operation.make(
          Request.get("https://api.test/"),
          Response.when(() => true, Body.text),
          {
            policy: retries(1),
            transformClient: (client) =>
              client.pipe(
                HttpClient.mapRequestEffect((request) =>
                  Effect.gen(function* () {
                    const nonce = (yield* Nonce)();
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => events.push(`release ${nonce}`)),
                    );
                    return HttpClientRequest.setHeader(
                      request,
                      "x-nonce",
                      nonce,
                    );
                  }),
                ),
              ),
          },
        );
        expectTypeOf<
          Effect.Services<ReturnType<typeof operation.execute>>
        >().toEqualTypeOf<Nonce | HttpClient.HttpClient>();

        let issued = 0;
        const value = yield* operation.execute(undefined).pipe(
          Effect.provide(server.layer),
          Effect.provideService(Nonce, () => `n${++issued}`),
        );
        expect(value).toBe("done");
        expect(events).toEqual([
          "send n1",
          "release n1",
          "attempt 1 aborted",
          "send n2",
          "release n2",
        ]);
        expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
      }),
  );
});

describe("Operation flows", () => {
  it.effect("polls a pending resource by re-executing a cold operation", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index < 2
          ? empty(202, { location: "/jobs/7", "retry-after": "1" })
          : json(200, { done: true }),
      );
      const status = Operation.make(
        Request.get("/jobs/7").pipe(Request.baseUrl("https://api.test")),
        Response.status(202, Response.tag("Pending", Body.empty)).pipe(
          Response.orElse(
            Response.status(200, Response.tag("Done", Body.json)),
          ),
        ),
        { policy: retries(5) },
      );
      const poll = Effect.gen(function* () {
        while (true) {
          const result = yield* status.execute(undefined);
          if (result._tag === "Done") return result.value;
        }
      });
      expect(yield* poll.pipe(Effect.provide(server.layer))).toEqual({
        done: true,
      });
      expect(server.exchanges).toHaveLength(3);
    }),
  );

  it.effect(
    "answers a declared challenge by executing again with an added header",
    () =>
      Effect.gen(function* () {
        const server = synthetic((exchange) =>
          exchange.request.headers.authorization === "Digest nonce=n1"
            ? text(200, "secret report")
            : empty(401, { "www-authenticate": 'Digest nonce="n1"' }),
        );
        const report = Operation.make(
          Request.get("https://legacy.test/report").pipe(
            Request.headers(
              Schema.Struct({ Authorization: Schema.optional(Schema.String) }),
            ),
          ),
          Response.status(200, Response.tag("Ok", Body.text)).pipe(
            Response.orElse(
              Response.status(401, Response.tag("Challenge", Body.empty)),
            ),
          ),
        );
        const program = Effect.gen(function* () {
          const first = yield* report.execute({ headers: {} });
          if (first._tag === "Ok") return first.value;
          const nonce = /nonce="([^"]*)"/.exec(
            first.metadata.headers["www-authenticate"] ?? "",
          )?.[1];
          const second = yield* report.execute({
            headers: { Authorization: `Digest nonce=${nonce}` },
          });
          return second._tag === "Ok" ? second.value : "denied";
        });
        expect(yield* program.pipe(Effect.provide(server.layer))).toBe(
          "secret report",
        );
        expect(server.exchanges).toHaveLength(2);
        expect(
          server.exchanges[0]?.request.headers.authorization,
        ).toBeUndefined();
      }),
  );
});

describe("Operation combinators", () => {
  it.effect("fromEffect suspends each execution", () =>
    Effect.gen(function* () {
      let calls = 0;
      const operation = Operation.fromEffect((input: number) => {
        calls++;
        return Effect.succeed(input * 2);
      });
      const execution = operation.execute(2);
      expect(calls).toBe(0);
      expect(yield* execution).toBe(4);
      expect(yield* execution).toBe(4);
      expect(calls).toBe(2);
    }),
  );

  it.effect("execute supports data-first and data-last forms", () =>
    Effect.gen(function* () {
      const double = Operation.fromEffect((input: number) =>
        Effect.succeed(input * 2),
      );
      expect(yield* Operation.execute(double, 3)).toBe(6);
      expect(yield* double.pipe(Operation.execute(4))).toBe(8);
    }),
  );

  it.effect("map and mapEffect interpret the successful result", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, { id: 1 }));
      const operation = Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Response.tag("Ok", Body.json)).pipe(
          Response.orElse(
            Response.status(404, Response.tag("Missing", Body.empty)),
          ),
        ),
      );
      const found = operation.pipe(
        Operation.mapEffect((result) =>
          result._tag === "Missing"
            ? Effect.fail("missing" as const)
            : Effect.succeed(result.value),
        ),
        Operation.map((value) => ({ found: value })),
      );
      expect(
        yield* found.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual({ found: { id: 1 } });

      const missing = synthetic(() => empty(404));
      expect(
        yield* Effect.flip(
          found.execute(undefined).pipe(Effect.provide(missing.layer)),
        ),
      ).toBe("missing");
    }),
  );
});

/** Dispatch through a fresh provider; report the exit, the composed URLs and the resolved URLs. */
const dispatch = <I, E, R>(
  operation: Operation.Operation<I, void, E, R>,
  input: I,
) =>
  Effect.gen(function* () {
    const server = synthetic(() => empty(204));
    const exit = yield* operation
      .execute(input)
      .pipe(Effect.provide(server.layer), Effect.exit);
    return {
      exit,
      urls: server.exchanges.map((exchange) => exchange.url),
      hrefs: server.exchanges.map((exchange) => exchange.href),
    };
  });

/** A shared transform that every request of a service applies. */
const withKey = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(
    Request.setQuery("key", "abc"),
    Request.baseUrl("https://api.test/v1"),
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/89
describe("Operation with a base URL from an Effect", () => {
  class ApiBase extends Context.Service<ApiBase, string>()("test/ApiBase") {}
  class BaseUnavailable extends Data.TaggedError("BaseUnavailable") {}

  const contract = Response.status(204, Body.empty);

  it.effect(
    "needs the service, and fails with what the base can fail with",
    () =>
      Effect.gen(function* () {
        const located = Operation.make(
          Request.get("/things").pipe(Request.baseUrl(ApiBase)),
          contract,
        );
        expectTypeOf<
          Effect.Services<ReturnType<typeof located.execute>>
        >().toEqualTypeOf<ApiBase | HttpClient.HttpClient>();
        const failing = Operation.make(
          Request.get("/things").pipe(
            Request.baseUrl(Effect.fail(new BaseUnavailable())),
          ),
          contract,
        );
        expectTypeOf<
          Extract<
            Effect.Error<ReturnType<typeof failing.execute>>,
            BaseUnavailable
          >
        >().toEqualTypeOf<BaseUnavailable>();

        const server = synthetic(() => empty(204));
        yield* located
          .execute(undefined)
          .pipe(
            Effect.provide(server.layer),
            Effect.provideService(ApiBase, "https://eu.test/v1"),
          );
        expect(server.exchanges.map(({ url }) => url)).toEqual([
          "https://eu.test/v1/things",
        ]);
      }),
  );

  it.effect("resolves it once, so every retry goes to the same base", () =>
    Effect.gen(function* () {
      let runs = 0;
      const base = Effect.sync(() => `https://region-${++runs}.test`);
      const server = synthetic((_, index) =>
        index < 2 ? empty(503) : empty(204),
      );
      yield* Operation.make(
        Request.get("/things").pipe(Request.baseUrl(base)),
        contract,
        { policy: retries(5) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(runs).toBe(1);
      expect(server.exchanges.map(({ url }) => url)).toEqual([
        "https://region-1.test/things",
        "https://region-1.test/things",
        "https://region-1.test/things",
      ]);
    }),
  );

  it.effect("resolves it again on each evaluation", () =>
    Effect.gen(function* () {
      let runs = 0;
      const base = Effect.sync(() => `https://region-${++runs}.test`);
      const server = synthetic(() => empty(204));
      const operation = Operation.make(
        Request.get("/things").pipe(Request.baseUrl(base)),
        contract,
      );
      yield* operation.execute(undefined).pipe(Effect.provide(server.layer));
      yield* operation.execute(undefined).pipe(Effect.provide(server.layer));
      expect(server.exchanges.map(({ url }) => url)).toEqual([
        "https://region-1.test/things",
        "https://region-2.test/things",
      ]);
    }),
  );

  it.effect("sends nothing and retries nothing when the base fails", () =>
    Effect.gen(function* () {
      let runs = 0;
      const failure = new BaseUnavailable();
      const base = Effect.suspend(() => {
        runs++;
        return Effect.fail(failure);
      });
      const server = synthetic(() => empty(204));
      const error = yield* Effect.flip(
        Operation.make(
          Request.get("/things").pipe(Request.baseUrl(base)),
          contract,
          { policy: retries(5) },
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      );
      expect(error).toBe(failure);
      expect(runs).toBe(1);
      expect(server.exchanges).toHaveLength(0);
    }),
  );

  it.effect("runs before the attempt timeout starts", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      const fiber = yield* Operation.make(
        Request.get("/things").pipe(
          Request.baseUrl(
            Effect.as(Effect.sleep("1 minute"), "https://slow.test"),
          ),
        ),
        contract,
        {
          policy: Policy.make(Schedule.recurs(0), {
            attemptTimeout: "1 second",
          }),
        },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(fiber);
      expect(server.exchanges.map(({ url }) => url)).toEqual([
        "https://slow.test/things",
      ]);
    }),
  );
});

describe("Operation URL composition", () => {
  const contract = Response.status(204, Body.empty);

  const file = Operation.make(
    Request.get("").pipe(
      Request.path(Schema.String, (id, encode) => `/v1/files/${encode(id)}`),
      Request.baseUrl("https://api.test"),
    ),
    contract,
  );

  const meta = Operation.make(
    Request.get("").pipe(
      Request.path(
        Schema.String,
        (id, encode) => `/v1/files/${encode(id)}/meta`,
      ),
      Request.baseUrl("https://api.test"),
    ),
    contract,
  );

  // The library keeps dot segments (UrlEncoding.defaults). Effect's HttpClient.make wrapper parses
  // the composed URL with the WHATWG URL parser, which resolves them; a provider also receives the
  // unparsed request. A consumer that must never send `..` validates it in the path schema or
  // replaces UrlEncoding.path. https://github.com/viell-dev/slop-effect-schema-http/issues/7
  it.effect(
    "hands a '..' path value to the client unchanged, and Effect's URL parser resolves it",
    () =>
      Effect.gen(function* () {
        const outcome = yield* dispatch(file, { path: ".." });
        expect(Exit.isSuccess(outcome.exit)).toBe(true);
        expect(outcome.urls).toEqual(["https://api.test/v1/files/.."]);
        expect(outcome.hrefs).toEqual(["https://api.test/v1/"]);
      }),
  );

  it.effect("keeps an empty path value as an empty segment", () =>
    Effect.gen(function* () {
      const outcome = yield* dispatch(meta, { path: "" });
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      expect(outcome.urls).toEqual(["https://api.test/v1/files//meta"]);
      expect(outcome.hrefs).toEqual(["https://api.test/v1/files//meta"]);
    }),
  );

  it.effect("renders an empty path value with a replaced path encoder", () =>
    Effect.gen(function* () {
      const outcome = yield* dispatch(meta, { path: "" }).pipe(
        Effect.provide(
          UrlEncoding.layer({
            ...UrlEncoding.defaults,
            path: (value) => (value === "" ? "-" : encodeURIComponent(value)),
          }),
        ),
      );
      expect(outcome.urls).toEqual(["https://api.test/v1/files/-/meta"]);
    }),
  );

  // The default join is a string join at the slash boundary: a base URL is an origin plus a path
  // prefix, so a query in it ends up before the path. Shared parameters belong in Request.setQuery,
  // as the next test shows. https://github.com/viell-dev/slop-effect-schema-http/issues/7
  it.effect("joins a base URL that has a query as a plain string prefix", () =>
    Effect.gen(function* () {
      const outcome = yield* dispatch(
        Operation.make(
          Request.get("users").pipe(
            Request.baseUrl("https://api.test/v1?key=abc"),
          ),
          contract,
        ),
        undefined,
      );
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      expect(outcome.urls).toEqual(["https://api.test/v1?key=abc/users"]);
    }),
  );

  it.effect("adds a shared query parameter through Request.setQuery", () =>
    Effect.gen(function* () {
      const outcome = yield* dispatch(
        Operation.make(withKey(Request.get("users")), contract),
        undefined,
      );
      expect(outcome.hrefs).toEqual(["https://api.test/v1/users?key=abc"]);
    }),
  );

  it.effect(
    "percent-encodes '%' with the default path encoder, so '%2e%2e' stays literal",
    () =>
      Effect.gen(function* () {
        const outcome = yield* dispatch(file, { path: "%2e%2e" });
        expect(Exit.isSuccess(outcome.exit)).toBe(true);
        expect(outcome.hrefs).toEqual(["https://api.test/v1/files/%252e%252e"]);
      }),
  );
});
