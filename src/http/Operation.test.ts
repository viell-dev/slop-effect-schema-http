import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  flow,
  identity,
  Layer,
  Logger,
  Option,
  References,
  Schedule,
  Schema,
  SchemaTransformation,
  type Scope,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";
import {
  type BodyProbe,
  bodyText,
  empty,
  type Exchange,
  json,
  probeBody,
  synthetic,
  text,
} from "../../test/support.js";
import * as Interaction from "../concurrency/Interaction.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import * as Transport from "./Transport.js";
import * as UrlEncoding from "./UrlEncoding.js";

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) throw new Error(`expected a typed failure`);
  return error.value;
};

/** Up to `retries` immediate retries. */
const retries = (count: number) => Policy.make(Schedule.recurs(count));

/** Up to `retries` retries, at least one second apart. */
const spaced = (count: number, options?: Parameters<typeof Policy.make>[1]) =>
  Policy.make(
    Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(count)]),
    options,
  );

const getItem = Operation.make(
  Request.get("https://api.test/items/1"),
  Response.status(200, Body.json),
);

/** Read while decoding a response. */
class Prefix extends Context.Service<Prefix, string>()("test/Prefix") {}

/** Read while encoding a request. */
class Suffix extends Context.Service<Suffix, string>()("test/Suffix") {}

/** Read by client middleware on each attempt. */
class Nonce extends Context.Service<Nonce, () => string>()("test/Nonce") {}

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

interface LogRecord {
  readonly message: unknown;
  readonly level: string;
  readonly annotations: Record<string, unknown>;
  readonly spans: ReadonlyArray<string>;
  /** The complete record as JSON, including every annotation and span. */
  readonly json: string;
}

/** A logger that keeps each record in structured form. */
const recording = () => {
  const records: Array<LogRecord> = [];
  const logger = Logger.make((options) => {
    const structured = Logger.formatStructured.log(options);
    records.push({
      message: structured.message,
      level: structured.level,
      annotations: structured.annotations,
      spans: Object.keys(structured.spans),
      json: Logger.formatJson.log(options),
    });
  });
  return { records, layer: Logger.layer([logger]) };
};

/** A provider reply: a transient 503, then success. */
const flaky = (_: unknown, index: number) =>
  index === 0 ? empty(503) : json(200, {});

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

describe("Operation retries", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/26
  it.effect("retries a decoded POST fault unless its classifier declines", () =>
    Effect.gen(function* () {
      for (const allowRetry of [true, false]) {
        const server = synthetic(() => text(500, "already locked"));
        const value = yield* Operation.make(
          Request.post("https://api.test/lock"),
          Response.status(500, Body.text),
          {
            policy: allowRetry
              ? retries(2)
              : Policy.make(Schedule.recurs(2), { while: () => false }),
          },
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer));
        expect(value).toBe("already locked");
        expect(server.exchanges).toHaveLength(allowRetry ? 3 : 1);
        expect(
          server.exchanges.every(
            (exchange) => exchange.request.method === "POST",
          ),
        ).toBe(true);
      }
    }),
  );

  it.effect("performs a single attempt without a policy", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(503));
      const exit = yield* getItem
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(failureOf(exit)).toBeInstanceOf(Response.UnexpectedResponse);
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect("retries transient responses until one succeeds", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index < 2 ? empty(503) : json(200, { ok: true }),
      );
      const value = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.json),
        { policy: retries(5) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(value).toEqual({ ok: true });
      expect(server.exchanges).toHaveLength(3);
    }),
  );

  it.effect("returns the last outcome when the budget is exhausted", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(503));
      const exit = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.json),
        { policy: retries(2) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      const error = failureOf(exit);
      expect(error).toBeInstanceOf(Response.UnexpectedResponse);
      expect(server.exchanges).toHaveLength(3);
    }),
  );

  it.effect("returns a declared transient response after the budget", () =>
    Effect.gen(function* () {
      const server = synthetic(() => text(503, "maintenance"));
      const value = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(503, Body.text),
        { policy: retries(1) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(value).toBe("maintenance");
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect("does not retry final responses", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(404));
      yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.json),
        { policy: retries(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect(
    "retries an unregistered status only when the classifier adds it",
    () =>
      Effect.gen(function* () {
        const contract = Response.status(200, Body.json);
        const plain = synthetic((_, index) =>
          index === 0 ? empty(420) : json(200, {}),
        );
        yield* Operation.make(Request.get("https://api.test/"), contract, {
          policy: retries(1),
        })
          .execute(undefined)
          .pipe(Effect.provide(plain.layer), Effect.exit);
        expect(plain.exchanges).toHaveLength(1);

        const extended = synthetic((_, index) =>
          index === 0 ? empty(420) : index === 1 ? empty(503) : json(200, {}),
        );
        yield* Operation.make(Request.get("https://api.test/"), contract, {
          policy: Policy.make(Schedule.recurs(3), {
            while: (reason) =>
              Policy.transient(reason) || reason.metadata?.status === 420,
          }),
        })
          .execute(undefined)
          .pipe(Effect.provide(extended.layer));
        expect(extended.exchanges).toHaveLength(3);
      }),
  );

  it.effect(
    "replays one materialization: computed fields and body are evaluated once",
    () =>
      Effect.gen(function* () {
        let credential = 0;
        let encoded = 0;
        const counting = Body.encoder((value: string) =>
          Effect.flatMap(
            Effect.sync(() => encoded++),
            () => Body.text.encode(value),
          ),
        );
        const server = synthetic((_, index) =>
          index < 2 ? empty(503) : empty(204),
        );
        const operation = Operation.make(
          Request.post("https://api.test/").pipe(
            Request.setHeader("Authorization", () => `Bearer t${++credential}`),
            Request.body(counting),
          ),
          Response.status(204, Body.empty),
          { policy: retries(3) },
        );
        yield* operation
          .execute({ body: "payload" })
          .pipe(Effect.provide(server.layer));
        expect(
          server.exchanges.map((e) => e.request.headers.authorization),
        ).toEqual(["Bearer t1", "Bearer t1", "Bearer t1"]);
        expect(server.exchanges.map((e) => bodyText(e.request))).toEqual([
          "payload",
          "payload",
          "payload",
        ]);
        expect(encoded).toBe(1);

        yield* operation
          .execute({ body: "payload" })
          .pipe(Effect.provide(server.layer));
        expect(server.exchanges[3]?.request.headers.authorization).toBe(
          "Bearer t2",
        );
        expect(encoded).toBe(2);
      }),
  );

  it.effect("runs client middleware per attempt, after encoding", () =>
    Effect.gen(function* () {
      let nonce = 0;
      const server = synthetic((exchange) =>
        exchange.request.headers["x-nonce"] === "3" ? empty(204) : empty(503),
      );
      yield* Operation.make(
        Request.post("https://api.test/").pipe(Request.body(Body.text)),
        Response.status(204, Body.empty),
        {
          policy: retries(5),
          transformClient: (client) =>
            client.pipe(
              HttpClient.mapRequest((request) =>
                request.pipe(
                  HttpClientRequest.setHeader("x-nonce", String(++nonce)),
                  HttpClientRequest.setHeader(
                    "x-signature",
                    `${nonce}:${bodyText(request)}`,
                  ),
                ),
              ),
            ),
        },
      )
        .execute({ body: "payload" })
        .pipe(Effect.provide(server.layer));
      expect(
        server.exchanges.map((e) => [
          e.request.headers["x-nonce"],
          e.request.headers["x-signature"],
        ]),
      ).toEqual([
        ["1", "1:payload"],
        ["2", "2:payload"],
        ["3", "3:payload"],
      ]);
      expect(server.exchanges[2]?.headerLines).toContainEqual(["x-nonce", "3"]);
    }),
  );

  it.effect(
    "turns a replay-rejected nonce into a permanent failure without per-attempt middleware",
    () =>
      Effect.gen(function* () {
        const used = new Set<string>();
        const server = synthetic((exchange) => {
          const nonce = new URL(exchange.href).searchParams.get("nonce") ?? "";
          if (used.has(nonce)) return text(409, "replayed nonce");
          used.add(nonce);
          return used.size <= 2 ? empty(503) : empty(204);
        });
        let counter = 0;
        const request = Request.post("https://api.test/").pipe(
          Request.setQuery("nonce", () => String(++counter)),
        );
        const contract = Response.status(204, Body.empty);

        const replayed = yield* Operation.make(request, contract, {
          policy: retries(5),
        })
          .execute(undefined)
          .pipe(Effect.provide(server.layer), Effect.exit);
        expect(failureOf(replayed)).toBeInstanceOf(Response.UnexpectedResponse);
        expect(server.exchanges.map((e) => e.request.url)).toEqual([
          "https://api.test/?nonce=1",
          "https://api.test/?nonce=1",
        ]);

        used.clear();
        const fresh = synthetic((exchange) => {
          const nonce = new URL(exchange.href).searchParams.get("nonce") ?? "";
          if (used.has(nonce)) return text(409, "replayed nonce");
          used.add(nonce);
          return used.size <= 2 ? empty(503) : empty(204);
        });
        yield* Operation.make(Request.post("https://api.test/"), contract, {
          policy: retries(5),
          transformClient: (client) =>
            client.pipe(
              HttpClient.mapRequest(
                HttpClientRequest.setUrlParam("nonce", String(++counter)),
              ),
            ),
        })
          .execute(undefined)
          .pipe(Effect.provide(fresh.layer));
        expect(fresh.exchanges).toHaveLength(3);
      }),
  );

  it.effect("classifies a middleware status rejection by its status", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? empty(503) : index === 1 ? empty(404) : empty(200),
      );
      const exit = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.empty),
        { policy: retries(5), transformClient: HttpClient.filterStatusOk },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      const error = failureOf(exit);
      expect(
        HttpClientError.isHttpClientError(error) && error.reason._tag,
      ).toBe("StatusCodeError");
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect(
    "honours Retry-After on a response that client middleware rejected",
    () =>
      Effect.gen(function* () {
        const reasons: Array<Policy.Reason> = [];
        const server = synthetic((_, index) =>
          index === 0 ? empty(503, { "retry-after": "60" }) : empty(200),
        );
        const fiber = yield* Operation.make(
          Request.get("https://api.test/"),
          Response.status(200, Body.empty),
          {
            policy: Policy.make(Schedule.recurs(3), {
              while: (reason) => {
                reasons.push(reason);
                return Policy.transient(reason);
              },
            }),
            transformClient: HttpClient.filterStatusOk,
          },
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer), Effect.forkChild);
        yield* TestClock.adjust("59 seconds");
        expect(server.exchanges).toHaveLength(1);
        expect(reasons).toHaveLength(1);
        const rejected = reasons[0];
        expect(rejected?._tag).toBe("Failure");
        expect(rejected?.metadata?.status).toBe(503);
        expect(rejected?.metadata?.headers["retry-after"]).toBe("60");
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        expect(server.exchanges).toHaveLength(2);
      }),
  );

  it.effect("fails with the schedule's error when the schedule fails", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(503));
      const operation = Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        {
          policy: Policy.make(
            Schedule.recurs(3).pipe(
              Schedule.tap(() =>
                Effect.fail("retry budget unavailable" as const),
              ),
            ),
          ),
        },
      );
      // The schedule's exact error is the only string member of the error union.
      expectTypeOf<
        Extract<Effect.Error<ReturnType<typeof operation.execute>>, string>
      >().toEqualTypeOf<"retry budget unavailable">();
      const exit = yield* operation
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(failureOf(exit)).toBe("retry budget unavailable");
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect("waits for the schedule's delay between attempts", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? empty(503) : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: spaced(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("999 millis");
      expect(server.exchanges).toHaveLength(1);
      yield* TestClock.adjust("1 milli");
      yield* Fiber.join(fiber);
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect("waits for a longer Retry-After in seconds", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? empty(503, { "retry-after": "10" }) : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: spaced(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("9999 millis");
      expect(server.exchanges).toHaveLength(1);
      yield* TestClock.adjust("1 milli");
      yield* Fiber.join(fiber);
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect("waits for a Retry-After HTTP date on 429 and 503", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 9, 29, 12, 0, 0));
      const server = synthetic((_, index) =>
        index === 0
          ? empty(429, { "retry-after": "Thu, 29 Oct 2026 12:00:30 GMT" })
          : index === 1
            ? empty(503, { "retry-after": "Thu, 29 Oct 2026 12:01:00 GMT" })
            : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: retries(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("29 seconds");
      expect(server.exchanges).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      expect(server.exchanges).toHaveLength(2);
      yield* TestClock.adjust("29 seconds");
      expect(server.exchanges).toHaveLength(2);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(server.exchanges).toHaveLength(3);
    }),
  );

  it.effect("keeps the schedule's delay when Retry-After is shorter", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? empty(503, { "retry-after": "0" }) : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: spaced(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("999 millis");
      expect(server.exchanges).toHaveLength(1);
      yield* TestClock.adjust("1 milli");
      yield* Fiber.join(fiber);
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect("ignores Retry-After when the policy opts out", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? empty(503, { "retry-after": "60" }) : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: spaced(3, { retryAfter: false }) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect("closes each attempt's scope before the retry delay", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? empty(503) : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: spaced(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      expect(server.exchanges).toHaveLength(1);
      expect(server.exchanges[0]?.signal.aborted).toBe(true);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(fiber);
    }),
  );

  it.effect(
    "finishes each attempt's cleanup before classifying it and before the retry delay",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const cleaning = yield* Deferred.make<void>();
        // The first attempt's cleanup waits for the test; the second finishes at once.
        const releases = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ];
        yield* Deferred.succeed(releases[1]!, undefined);
        let attempt = 0;
        const tracked = Body.decoder((response) =>
          Effect.gen(function* () {
            const n = ++attempt;
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(releases[n - 1]!)),
                Effect.andThen(Effect.sync(() => events.push(`released ${n}`))),
              ),
            );
            yield* Body.empty.decode(response);
            events.push(`decoded ${n}`);
          }),
        );
        const server = synthetic((_, index) => {
          events.push(`send ${index + 1}`);
          return index === 0 ? empty(503) : empty(204);
        });
        const fiber = yield* Operation.make(
          Request.get("https://api.test/"),
          Response.when(() => true, tracked),
          {
            policy: Policy.make(Schedule.spaced("1 second"), {
              while: (reason) => {
                events.push(`classify ${reason.metadata?.status}`);
                return Policy.transient(reason);
              },
            }),
          },
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer), Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(cleaning);
        // A delay that began during cleanup would elapse within this minute.
        yield* TestClock.adjust("1 minute");
        expect(events).toEqual(["send 1", "decoded 1"]);
        yield* Deferred.succeed(releases[0]!, undefined);
        yield* TestClock.adjust("999 millis");
        expect(events).toEqual([
          "send 1",
          "decoded 1",
          "released 1",
          "classify 503",
        ]);
        yield* TestClock.adjust("1 milli");
        yield* Fiber.join(fiber);
        expect(events).toEqual([
          "send 1",
          "decoded 1",
          "released 1",
          "classify 503",
          "send 2",
          "decoded 2",
          "released 2",
          "classify 204",
        ]);
      }),
  );

  it.effect("propagates a defect without retrying", () =>
    Effect.gen(function* () {
      const server = synthetic(() => Effect.die(new Error("provider bug")));
      const exit = yield* getItem
        .pipe(Operation.map((value) => value))
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(server.exchanges).toHaveLength(1);

      const retried = synthetic(() => Effect.die(new Error("provider bug")));
      const retriedExit = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.json),
        { policy: retries(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(retried.layer), Effect.exit);
      expect(
        Exit.isFailure(retriedExit) && Cause.hasDies(retriedExit.cause),
      ).toBe(true);
      expect(retried.exchanges).toHaveLength(1);
    }),
  );
});

describe("Operation timeouts and interruption", () => {
  it.effect(
    "times out a hanging attempt, aborts it, and retries within the budget",
    () =>
      Effect.gen(function* () {
        const server = synthetic((_, index) =>
          index < 2 ? Effect.never : empty(204),
        );
        const fiber = yield* Operation.make(
          Request.get("https://api.test/"),
          Response.status(204, Body.empty),
          {
            policy: Policy.make(Schedule.recurs(3), {
              attemptTimeout: "5 seconds",
            }),
          },
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer), Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        expect(server.exchanges).toHaveLength(2);
        expect(server.exchanges[0]?.signal.aborted).toBe(true);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(fiber);
        expect(server.exchanges).toHaveLength(3);
        expect(server.exchanges[1]?.signal.aborted).toBe(true);
      }),
  );

  it.effect("surfaces the final attempt timeout as a TimeoutError", () =>
    Effect.gen(function* () {
      const server = synthetic(() => Effect.never);
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        {
          policy: Policy.make(Schedule.recurs(1), {
            attemptTimeout: "1 second",
          }),
        },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const exit = yield* Fiber.await(fiber);
      expect(Cause.isTimeoutError(failureOf(exit))).toBe(true);
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect("times out a long body read within the attempt", () =>
    Effect.gen(function* () {
      const server = synthetic(
        () =>
          new globalThis.Response(
            new ReadableStream<Uint8Array>({
              pull: () => new Promise(() => {}),
            }),
            { status: 200 },
          ),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(200, Body.text),
        {
          policy: Policy.make(Schedule.recurs(0), {
            attemptTimeout: "1 second",
          }),
        },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const exit = yield* Fiber.await(fiber);
      expect(Cause.isTimeoutError(failureOf(exit))).toBe(true);
      expect(server.exchanges[0]?.signal.aborted).toBe(true);
    }),
  );

  it.effect(
    "lets a caller's whole-operation timeout surface as a timeout, not a response",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => Effect.never);
        const fiber = yield* getItem
          .execute(undefined)
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.provide(server.layer),
            Effect.forkChild,
          );
        yield* TestClock.adjust("30 seconds");
        const exit = yield* Fiber.await(fiber);
        expect(Cause.isTimeoutError(failureOf(exit))).toBe(true);
        expect(server.exchanges[0]?.signal.aborted).toBe(true);
      }),
  );

  it.effect(
    "aborts the in-flight request on interruption and does not retry",
    () =>
      Effect.gen(function* () {
        const server = synthetic(() => Effect.never);
        const fiber = yield* Operation.make(
          Request.get("https://api.test/"),
          Response.status(200, Body.json),
          { policy: retries(3) },
        )
          .execute(undefined)
          .pipe(Effect.provide(server.layer), Effect.forkChild);
        yield* Effect.yieldNow;
        expect(server.exchanges).toHaveLength(1);
        expect(server.exchanges[0]?.signal.aborted).toBe(false);
        const exit = yield* Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
        );
        expect(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true);
        expect(server.exchanges[0]?.signal.aborted).toBe(true);
        expect(server.exchanges).toHaveLength(1);
      }),
  );

  it.effect("stops during a retry delay when interrupted", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(503));
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: spaced(3) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("10 seconds");
      expect(server.exchanges).toHaveLength(1);
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

describe("Operation logging", () => {
  it.effect(
    "logs outcome categories without request or response contents",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = [];
        const capture = Logger.make((options) => {
          lines.push(Logger.formatJson.log(options));
        });
        const server = synthetic((_, index) =>
          index === 0
            ? text(503, "body-secret", { "x-leak": "header-secret" })
            : json(200, { token: "response-secret" }),
        );
        yield* Operation.make(
          Request.post("https://api.test/login?password=query-secret").pipe(
            Request.setHeader("Authorization", "Bearer header-credential"),
            Request.body(Body.json),
          ),
          Response.status(200, Body.json),
          { policy: retries(1) },
        )
          .execute({ body: { password: "body-credential" } })
          .pipe(
            Effect.provide(server.layer),
            Effect.provide(Logger.layer([capture])),
            Effect.provideService(References.MinimumLogLevel, "All"),
          );
        const output = lines.join("\n");
        expect(output).toContain("HTTP attempt completed");
        expect(output).toContain("HTTP operation completed");
        for (const secret of [
          "query-secret",
          "header-credential",
          "body-credential",
          "body-secret",
          "header-secret",
          "response-secret",
        ])
          expect(output).not.toContain(secret);
      }),
  );

  it.effect("records nothing at Effect's default minimum log level", () =>
    Effect.gen(function* () {
      const log = recording();
      const server = synthetic(flaky);
      yield* Operation.make(
        Request.get("https://api.test/items"),
        Response.status(200, Body.json),
        { policy: retries(1) },
      )
        .execute(undefined)
        .pipe(
          // A control entry at the default level shows that the logger records.
          Effect.andThen(Effect.logInfo("control")),
          Effect.provide(server.layer),
          Effect.provide(log.layer),
        );
      expect(server.exchanges).toHaveLength(2);
      expect(log.records.map((record) => record.message)).toEqual(["control"]);
    }),
  );

  it.effect(
    "records the attempt sequence at Debug with outcome annotations only",
    () =>
      Effect.gen(function* () {
        const log = recording();
        yield* Operation.make(
          Request.post("https://hidden-host.test/hidden-path"),
          Response.status(200, Body.json),
          { policy: retries(1) },
        )
          .execute(undefined)
          .pipe(
            Effect.provide(synthetic(flaky).layer),
            Effect.provide(log.layer),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
          );
        expect(
          log.records.map(({ message, level, annotations }) => ({
            message,
            level,
            annotations,
          })),
        ).toEqual([
          {
            message: "HTTP attempt started",
            level: "DEBUG",
            annotations: { "http.method": "POST", "http.attempt": 1 },
          },
          {
            message: "HTTP attempt completed",
            level: "DEBUG",
            annotations: {
              "http.method": "POST",
              "http.attempt": 1,
              "http.outcome": "failure",
              "http.status": 503,
            },
          },
          {
            message: "HTTP retrying",
            level: "DEBUG",
            annotations: { "http.attempt": 2 },
          },
          {
            message: "HTTP attempt started",
            level: "DEBUG",
            annotations: { "http.method": "POST", "http.attempt": 2 },
          },
          {
            message: "HTTP attempt completed",
            level: "DEBUG",
            annotations: {
              "http.method": "POST",
              "http.attempt": 2,
              "http.outcome": "success",
              "http.status": 200,
            },
          },
          {
            message: "HTTP operation completed",
            level: "DEBUG",
            annotations: { "http.outcome": "success" },
          },
        ]);
        for (const record of log.records) {
          expect(record.spans).toEqual(["schema-http.operation"]);
          expect(record.json).not.toContain("hidden-host");
          expect(record.json).not.toContain("hidden-path");
        }
      }),
  );

  it.effect("records only the completion when preparation fails", () =>
    Effect.gen(function* () {
      const log = recording();
      const server = synthetic(flaky);
      const exit = yield* Operation.make(
        Request.post("https://api.test/items").pipe(
          Request.body(Body.jsonSchema(Schema.Struct({ n: Schema.Finite }))),
        ),
        Response.status(200, Body.json),
        { policy: retries(1) },
      )
        .execute({ body: { n: Number.POSITIVE_INFINITY } })
        .pipe(
          Effect.provide(server.layer),
          Effect.provide(log.layer),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.exit,
        );
      expect(Schema.isSchemaError(failureOf(exit))).toBe(true);
      expect(server.exchanges).toHaveLength(0);
      expect(
        log.records.map(({ message, annotations }) => ({
          message,
          annotations,
        })),
      ).toEqual([
        {
          message: "HTTP operation completed",
          annotations: { "http.outcome": "failure" },
        },
      ]);
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

/** Options that record the attempt number each call of `transformClient` receives. */
const noting = () => {
  const attempts: Array<number> = [];
  return {
    attempts,
    transformClient: (client: HttpClient.HttpClient, attempt: number) => {
      attempts.push(attempt);
      return client;
    },
  };
};

/** Middleware that sends how many retries came before this attempt. */
const countAttempt = (attempt: number) =>
  HttpClient.mapRequest(
    HttpClientRequest.setHeader("x-retry-count", String(attempt - 1)),
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/99
describe("transformClient and the attempt number", () => {
  const contract = Response.status(204, Body.empty);

  it.effect("counts each attempt from 1", () =>
    Effect.gen(function* () {
      const { attempts, transformClient } = noting();
      const server = synthetic((_, index) =>
        index < 2 ? empty(503) : empty(204),
      );
      yield* Operation.make(Request.get("https://api.test/"), contract, {
        policy: retries(5),
        transformClient,
      })
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(attempts).toEqual([1, 2, 3]);
    }),
  );

  it.effect("is 1 on a single attempt", () =>
    Effect.gen(function* () {
      const { attempts, transformClient } = noting();
      yield* Operation.make(Request.get("https://api.test/"), contract, {
        transformClient,
      })
        .execute(undefined)
        .pipe(Effect.provide(synthetic(() => empty(204)).layer));
      expect(attempts).toEqual([1]);
    }),
  );

  it.effect("goes on counting after a timeout", () =>
    Effect.gen(function* () {
      const { attempts, transformClient } = noting();
      const server = synthetic((_, index) =>
        index === 0 ? Effect.never : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        contract,
        {
          policy: Policy.make(Schedule.recurs(1), {
            attemptTimeout: "1 second",
          }),
          transformClient,
        },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(attempts).toEqual([1, 2]);
      expect(server.exchanges).toHaveLength(2);
    }),
  );

  it.effect("goes on counting after a transport failure", () =>
    Effect.gen(function* () {
      const { attempts, transformClient } = noting();
      const server = synthetic((exchange, index) =>
        index === 0
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: exchange.request,
                }),
              }),
            )
          : empty(204),
      );
      yield* Operation.make(Request.get("https://api.test/"), contract, {
        policy: retries(1),
        transformClient,
      })
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(attempts).toEqual([1, 2]);
    }),
  );

  it.effect("starts again at 1 on each evaluation", () =>
    Effect.gen(function* () {
      const { attempts, transformClient } = noting();
      const operation = Operation.make(
        Request.get("https://api.test/"),
        contract,
        { transformClient },
      );
      const server = synthetic(() => empty(204));
      yield* operation.execute(undefined).pipe(Effect.provide(server.layer));
      yield* operation.execute(undefined).pipe(Effect.provide(server.layer));
      expect(attempts).toEqual([1, 1]);
    }),
  );

  it.effect("matches the http.attempt log annotation", () =>
    Effect.gen(function* () {
      const { attempts, transformClient } = noting();
      const log = recording();
      const server = synthetic((_, index) =>
        index === 0 ? Effect.never : empty(204),
      );
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        contract,
        {
          policy: Policy.make(Schedule.recurs(1), {
            attemptTimeout: "1 second",
          }),
          transformClient,
        },
      )
        .execute(undefined)
        .pipe(
          Effect.provide(server.layer),
          Effect.provide(log.layer),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.forkChild,
        );
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(
        log.records
          .filter(({ message }) => message === "HTTP attempt started")
          .map(({ annotations }) => annotations["http.attempt"]),
      ).toEqual(attempts);
    }),
  );

  it.effect("moves to the next server on a retry", () =>
    Effect.gen(function* () {
      const servers = ["https://eu.test", "https://ap.test"];
      const onServer = (attempt: number) =>
        HttpClient.mapRequest(
          HttpClientRequest.prependUrl(
            servers[(attempt - 1) % servers.length]!,
          ),
        );
      const server = synthetic((exchange) =>
        exchange.url.startsWith("https://ap.test") ? empty(204) : empty(503),
      );
      yield* Operation.make(Request.get("/things"), contract, {
        policy: retries(1),
        transformClient: (client, attempt) => onServer(attempt)(client),
      })
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges.map(({ url }) => url)).toEqual([
        "https://eu.test/things",
        "https://ap.test/things",
      ]);
    }),
  );

  it.effect("adds a retry-count header without touching the request", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? empty(503) : empty(204),
      );
      yield* Operation.make(Request.get("https://api.test/"), contract, {
        policy: retries(1),
        transformClient: (client, attempt) => countAttempt(attempt)(client),
      })
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(
        server.exchanges.map(({ request }) => request.headers["x-retry-count"]),
      ).toEqual(["0", "1"]);
    }),
  );

  it("keeps taking a function of the client alone", () => {
    void Operation.make(Request.get("/"), contract, {
      transformClient: HttpClient.filterStatusOk,
    });
    void Operation.make(Request.get("/"), contract, {
      transformClient: (client) => client,
    });
    void Operation.make(Request.get("/"), contract, {
      // @ts-expect-error: the attempt number is a number
      transformClient: (client: HttpClient.HttpClient, attempt: string) => {
        void attempt;
        return client;
      },
    });
  });

  // It compiles with or without the attempt number, so only the arrow function keeps the default.
  it.effect("gives a function's own second parameter the number", () =>
    Effect.gen(function* () {
      const limits: Array<number> = [];
      const limited = (client: HttpClient.HttpClient, limit = 10) => {
        limits.push(limit);
        return client;
      };
      const server = synthetic(() => empty(204));
      yield* Operation.make(Request.get("https://api.test/"), contract, {
        transformClient: limited,
      })
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      yield* Operation.make(Request.get("https://api.test/"), contract, {
        transformClient: (client) => limited(client),
      })
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(limits).toEqual([1, 10]);
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

const Thing = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.String,
});
const ThingOption = Schema.Struct({ id: Schema.Number, name: Schema.String });
const Problem = Schema.Struct({ title: Schema.String, detail: Schema.String });
const pageOf = <S extends Schema.Top>(data: S) =>
  Schema.Struct({ data, page: Schema.Number, total: Schema.Number });
const ThingPage = pageOf(Schema.Array(Thing));
const OptionPage = pageOf(Schema.Array(ThingOption));

/** Needed by a mapping, to show a step's services. */
class Audit extends Context.Service<
  Audit,
  { readonly record: (count: number) => Effect.Effect<void> }
>()("test/Audit") {}

class NotFound extends Data.TaggedError("NotFound")<{
  readonly detail: string;
}> {}

class ServerProblem extends Data.TaggedError("ServerProblem")<{
  readonly title: string;
}> {}

const thing = (id: number) => ({
  id,
  name: `thing ${id}`,
  description: "synthetic",
});
const option = (id: number) => ({ id, name: `thing ${id}` });
const page = (data: ReadonlyArray<unknown>) => ({
  data,
  page: 1,
  total: data.length,
});
const things = [thing(1), thing(2)];
const reply = () => json(200, page(things));
const gone = () => json(404, { title: "gone", detail: "no such thing" });

const api = Request.baseUrl("https://api.example.test/v1");
const firstFive = Request.setQuery("limit", "5");
const withoutPaging = Request.removeQuery("page");
const idAndNameOnly = Request.setQuery({ limit: "all", fields: "id,name" });
const retryTwice = retries(2);

const pagedThings = Operation.make(
  Request.get("/things?page=1&limit=25").pipe(api),
  Response.status(200, Body.jsonSchema(ThingPage)),
);
/** A definition that unwraps its envelope. */
const getThings = pagedThings.pipe(Operation.map((value) => value.data));

const found = Response.status(
  200,
  Response.tag("Found", Body.jsonSchema(ThingPage)),
);
const missing = Response.status(
  404,
  Response.tag("Missing", Body.jsonSchema(Problem)),
);
const serverProblem = Response.when(
  (info) => info.status >= 500,
  Response.tag("Server", Body.jsonSchema(Problem)),
  { key: "server" },
);
const contract = found.pipe(
  Response.orElse(missing),
  Response.orElse(serverProblem),
);
/** A definition that turns recognized outcomes into failures. */
const search = Operation.make(Request.get("/search").pipe(api), contract).pipe(
  Operation.mapEffect((result) =>
    Effect.gen(function* () {
      switch (result._tag) {
        case "Found":
          return result.value.data;
        case "Missing":
          return yield* new NotFound({ detail: result.value.detail });
        case "Server":
          return yield* new ServerProblem({ title: result.value.title });
      }
    }),
  ),
);

type Input<T> =
  T extends Operation.Operation<infer I, unknown, unknown, unknown> ? I : never;
type Success<T> =
  T extends Operation.Operation<never, infer A, unknown, unknown> ? A : never;
type Failures<T> =
  T extends Operation.Operation<never, unknown, infer E, unknown> ? E : never;
type Services<T> =
  T extends Operation.Operation<never, unknown, unknown, infer R> ? R : never;

const urlsOf = (provider: { readonly exchanges: ReadonlyArray<Exchange> }) =>
  provider.exchanges.map((exchange) => exchange.url);

/** Statements only the compiler reads: they are refused, so they must never run. */
/** `any`, named through the schema that holds it. */
type Anything = (typeof Schema.Any)["Type"];

const compileOnly = (statements: (...values: ReadonlyArray<never>) => void) =>
  expect(statements).toBeTypeOf("function");

const wholeNewResponse = () => Response.status(200, Body.text);
const otherInput = (value: { readonly other: number }) => value;
const pageResponse = Response.status(200, Body.jsonSchema(ThingPage));
const pageOperation = Operation.make(
  Request.get("/things").pipe(api),
  pageResponse,
);
type WithoutKeys<T> =
  T extends Response.Response<infer A, infer E, infer R, infer _C>
    ? Response.Response<A, E, R>
    : never;
const forSameValues = (response: WithoutKeys<typeof pageResponse>) => response;
const forSameCases = (response: typeof pageResponse) => response;
const forAnyResponse = (
  response: Response.Response<unknown, unknown, unknown>,
) => response.pipe(Response.orElse(Response.status(204, Body.empty)));
const dropdownReply = () => json(200, page([option(1)]));
const firstOf = <T>(list: ReadonlyArray<T>) => list[0];
const dataOf = (value: typeof ThingPage.Type) => value.data;
const listThings = (pageNumber: number) =>
  getThings.pipe(Operation.mapRequest(Request.setQuery({ page: pageNumber })));
const inList = <I, A, E, R>(operation: Operation.Operation<I, A, E, R>) =>
  operation.pipe(Operation.map((value) => [value] as const));
const withTenant = <B, I, E, R, S, O, T>(
  operation: Operation.Derived<B, Request.Request<I, E, R>, S, O, T>,
) => operation.pipe(Operation.mapRequest(Request.setHeader("x-tenant", "a")));

describe("Operation.mapRequest", () => {
  it.effect("changes the request and leaves the original alone", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const variant = pagedThings.pipe(Operation.mapRequest(firstFive));
      yield* variant.execute(undefined).pipe(Effect.provide(server.layer));
      yield* pagedThings.execute(undefined).pipe(Effect.provide(server.layer));
      expect(urlsOf(server)).toEqual([
        "https://api.example.test/v1/things?page=1&limit=5",
        "https://api.example.test/v1/things?page=1&limit=25",
      ]);
    }),
  );

  it.effect(
    "can replace the whole request, changing its method and input",
    () =>
      Effect.gen(function* () {
        const server = synthetic(reply);
        const searchInstead = pagedThings.pipe(
          Operation.mapRequest(() =>
            Request.post("/search").pipe(api, Request.body(Body.text)),
          ),
        );
        expectTypeOf<Input<typeof searchInstead>>().toExtend<{
          readonly body: string;
        }>();
        yield* searchInstead
          .execute({ body: "term" })
          .pipe(Effect.provide(server.layer));
        expect(server.exchanges[0]?.request.method).toBe("POST");
        expect(bodyText(server.exchanges[0]!.request)).toBe("term");
        expect(urlsOf(server)).toEqual(["https://api.example.test/v1/search"]);
      }),
  );

  it.effect("adds a binding in a callback, which changes the input", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const Cursor = Schema.Struct({
        page: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.String),
        cursor: Schema.String,
      });
      const byCursor = getThings.pipe(
        Operation.mapRequest((request) => request.pipe(Request.query(Cursor))),
      );
      expectTypeOf<{ readonly query: { readonly cursor: string } }>().toExtend<
        Input<typeof byCursor>
      >();
      expect(
        yield* byCursor
          .execute({ query: { cursor: "c" } })
          .pipe(Effect.provide(server.layer)),
      ).toEqual(things);
      expect(urlsOf(server)).toEqual([
        "https://api.example.test/v1/things?page=1&limit=25&cursor=c",
      ]);
    }),
  );

  it.effect("carries every option over", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? json(503, {}) : reply(),
      );
      const configured = Operation.make(
        Request.get("/things").pipe(api),
        Response.status(200, Body.jsonSchema(ThingPage)),
        {
          policy: retryTwice,
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader("x-client", "yes"),
          ),
        },
      );
      yield* configured
        .pipe(Operation.mapRequest(firstFive))
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges).toHaveLength(2);
      expect(server.exchanges[1]?.request.headers["x-client"]).toBe("yes");
    }),
  );

  it.effect("keeps a request's own Accept and a removed one", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const declared = pagedThings.pipe(
        Operation.mapRequest(
          Request.setHeader("Accept", "application/vnd+json"),
        ),
      );
      const removed = pagedThings.pipe(
        Operation.mapRequest(Request.removeHeader("accept")),
      );
      yield* declared.execute(undefined).pipe(Effect.provide(server.layer));
      yield* removed.execute(undefined).pipe(Effect.provide(server.layer));
      expect(server.exchanges[0]?.request.headers.accept).toBe(
        "application/vnd+json",
      );
      expect(server.exchanges[1]?.request.headers.accept).toBeUndefined();
    }),
  );

  it.effect("stacks on another variant, and each keeps what it had", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const first = pagedThings.pipe(Operation.mapRequest(firstFive));
      const second = first.pipe(Operation.mapRequest(withoutPaging));
      yield* second.execute(undefined).pipe(Effect.provide(server.layer));
      yield* first.execute(undefined).pipe(Effect.provide(server.layer));
      expect(urlsOf(server)).toEqual([
        "https://api.example.test/v1/things?limit=5",
        "https://api.example.test/v1/things?page=1&limit=5",
      ]);
    }),
  );
});

describe("Operation.mapResponse", () => {
  it.effect("changes the response and leaves the original alone", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, page([option(1)])));
      const asOptions = Response.replace(200, Body.jsonSchema(OptionPage));
      const variant = pagedThings.pipe(Operation.mapResponse(asOptions));
      expect(
        yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(page([option(1)]));
      const failure = yield* Effect.flip(
        pagedThings.execute(undefined).pipe(Effect.provide(server.layer)),
      );
      expect(failure._tag).toBe("DecodeError");
    }),
  );

  it.effect("takes the automatic Accept from the new response", () =>
    Effect.gen(function* () {
      const server = synthetic(() => text(200, "plain"));
      const asText = Response.replace(200, Body.text);
      expect(
        yield* pagedThings
          .pipe(Operation.mapResponse(asText))
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toBe("plain");
      expect(server.exchanges[0]?.request.headers.accept).toBe("text/plain");
    }),
  );

  it.effect(
    "adds, removes and replaces whole cases on an unmapped operation",
    () =>
      Effect.gen(function* () {
        const server = synthetic(gone);
        const withMissing = pagedThings.pipe(
          Operation.mapResponse(Response.orElse(missing)),
        );
        const result = yield* withMissing
          .execute(undefined)
          .pipe(Effect.provide(server.layer));
        expect(result).toMatchObject({
          _tag: "Missing",
          value: { title: "gone" },
        });

        const without = withMissing.pipe(
          Operation.mapResponse(Response.remove(404)),
        );
        const failure = yield* Effect.flip(
          without.execute(undefined).pipe(Effect.provide(server.layer)),
        );
        expect(failure._tag).toBe("UnexpectedResponse");

        const emptied = pagedThings.pipe(
          Operation.mapResponse(() => Response.status(404, Body.empty)),
        );
        expectTypeOf<Success<typeof emptied>>().toEqualTypeOf<void>();
        yield* emptied.execute(undefined).pipe(Effect.provide(server.layer));
      }),
  );

  it("keeps only the cases that can occur in the result type", () => {
    const asOptions = Response.replace(
      200,
      Response.tag("Found", Body.jsonSchema(OptionPage)),
    );
    const raw = Operation.make(Request.get("/search").pipe(api), contract);
    const variant = raw.pipe(Operation.mapResponse(asOptions));
    expectTypeOf<Success<typeof variant>>().toEqualTypeOf<
      | Response.Tagged<"Found", typeof OptionPage.Type>
      | Response.Tagged<"Missing", typeof Problem.Type>
      | Response.Tagged<"Server", typeof Problem.Type>
    >();
  });

  it.effect("takes a conversion in a case's decoder with that case", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const converted = Operation.make(
        Request.get("/things").pipe(api),
        Response.status(
          200,
          Body.jsonSchema(ThingPage).pipe(Body.map((value) => value.data)),
        ),
      );
      const raw = converted.pipe(
        Operation.mapResponse(
          Response.replace(200, Body.jsonSchema(ThingPage)),
        ),
      );
      expect(
        yield* raw.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(page(things));
      expectTypeOf<Success<typeof raw>>().toEqualTypeOf<
        typeof ThingPage.Type
      >();
    }),
  );
});

describe("Operation.mapOptions", () => {
  it.effect("changes the options and leaves the original alone", () =>
    Effect.gen(function* () {
      const failing = synthetic(() => json(503, {}));
      const patient = pagedThings.pipe(
        Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
      );
      yield* Effect.exit(
        patient.execute(undefined).pipe(Effect.provide(failing.layer)),
      );
      expect(failing.exchanges).toHaveLength(3);

      const once = synthetic(() => json(503, {}));
      yield* Effect.exit(
        pagedThings.execute(undefined).pipe(Effect.provide(once.layer)),
      );
      expect(once.exchanges).toHaveLength(1);
    }),
  );

  it("receives undefined with no options, and the current ones otherwise", () => {
    const seen: Array<unknown> = [];
    const record = <O>(options: O | undefined) => {
      seen.push(options);
      return { policy: Policy.none };
    };
    const configured = pagedThings.pipe(
      Operation.mapOptions(() => ({ policy: retryTwice })),
    );
    pagedThings.pipe(Operation.mapOptions(record));
    configured.pipe(Operation.mapOptions(record));
    expect(seen).toEqual([undefined, { policy: retryTwice }]);
  });

  it.effect("replaces them, so an option left out goes", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const marked = Operation.make(
        Request.get("/things").pipe(api),
        Response.status(200, Body.jsonSchema(ThingPage)),
        {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader("x-client", "yes"),
          ),
        },
      );
      yield* marked
        .pipe(Operation.mapOptions(() => ({})))
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(server.exchanges[0]?.request.headers["x-client"]).toBeUndefined();
    }),
  );

  it("keeps failures and services exact, including what a dropped option added", () => {
    class Marked extends Data.TaggedError("Marked") {}
    const marked = Operation.make(
      Request.get("https://api.test/"),
      Response.status(204, Body.empty),
      {
        transformClient: (client) =>
          client.pipe(
            HttpClient.mapRequestEffect((request) =>
              Effect.flatMap(Nonce, () =>
                Effect.as(Effect.fail(new Marked()), request),
              ),
            ),
          ),
      },
    );
    expectTypeOf<Marked>().toExtend<Failures<typeof marked>>();
    expectTypeOf<Nonce>().toExtend<Services<typeof marked>>();

    const spread = marked.pipe(
      Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
    );
    expectTypeOf<Marked>().toExtend<Failures<typeof spread>>();
    expectTypeOf<Nonce>().toExtend<Services<typeof spread>>();

    const dropped = marked.pipe(
      Operation.mapOptions(() => ({ policy: retryTwice })),
    );
    expectTypeOf<Marked>().not.toExtend<Failures<typeof dropped>>();
    expectTypeOf<Nonce>().not.toExtend<Services<typeof dropped>>();
    expectTypeOf<
      Services<typeof dropped>
    >().toEqualTypeOf<HttpClient.HttpClient>();
  });
});

describe("a recorded result step", () => {
  it.effect(
    "survives a request change, and the original keeps its own request",
    () =>
      Effect.gen(function* () {
        const server = synthetic(reply);
        const variant = getThings.pipe(Operation.mapRequest(firstFive));
        expect(
          yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
        ).toEqual(things);
        expect(
          yield* getThings
            .execute(undefined)
            .pipe(Effect.provide(server.layer)),
        ).toEqual(things);
        expect(urlsOf(server)).toEqual([
          "https://api.example.test/v1/things?page=1&limit=5",
          "https://api.example.test/v1/things?page=1&limit=25",
        ]);
      }),
  );

  it.effect("survives an options change, and runs once after the retries", () =>
    Effect.gen(function* () {
      let calls = 0;
      const server = synthetic((_, index) =>
        index === 0 ? json(503, {}) : reply(),
      );
      const counted = pagedThings
        .pipe(
          Operation.map((value) => {
            calls++;
            return value.data;
          }),
        )
        .pipe(
          Operation.mapOptions((options) => ({
            ...options,
            policy: retryTwice,
          })),
        );
      expect(
        yield* counted.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(things);
      expect(server.exchanges).toHaveLength(2);
      expect(calls).toBe(1);
    }),
  );

  it.effect("runs once when a declared status is retried", () =>
    Effect.gen(function* () {
      let calls = 0;
      const server = synthetic((_, index) =>
        index === 0 ? json(503, page([])) : reply(),
      );
      const declared = Response.status(200, Body.jsonSchema(ThingPage)).pipe(
        Response.orElse(Response.status(503, Body.jsonSchema(ThingPage))),
      );
      const counted = Operation.make(
        Request.get("/things").pipe(api),
        declared,
        {
          policy: retryTwice,
        },
      ).pipe(
        Operation.map((value) => {
          calls++;
          return value.data;
        }),
      );
      expect(
        yield* counted.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(things);
      expect(server.exchanges).toHaveLength(2);
      expect(calls).toBe(1);
    }),
  );

  it.effect("does not run when the operation failed", () =>
    Effect.gen(function* () {
      let calls = 0;
      const server = synthetic(() => json(503, {}));
      const counted = pagedThings.pipe(
        Operation.map(() => {
          calls++;
        }),
      );
      const failure = yield* Effect.flip(
        counted.execute(undefined).pipe(Effect.provide(server.layer)),
      );
      expect(failure._tag).toBe("UnexpectedResponse");
      expect(calls).toBe(0);
    }),
  );

  it.effect("runs two maps in order, as one step, through a variant", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const names = getThings.pipe(
        Operation.map((list) => list.map((entry) => entry.name)),
        Operation.map((list) => list.join(", ")),
      );
      const variant = names.pipe(Operation.mapRequest(firstFive));
      expect(
        yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe("thing 1, thing 2");
      expect(
        yield* names.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe("thing 1, thing 2");
      expectTypeOf<Success<typeof variant>>().toEqualTypeOf<string>();
      expectTypeOf(names.parts).toEqualTypeOf(getThings.parts);
    }),
  );

  it.effect("stops at the first mapping that fails", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      let later = 0;
      const stopped = getThings.pipe(
        Operation.mapEffect(() => Effect.fail("first" as const)),
        Operation.map(() => {
          later++;
        }),
      );
      expect(
        yield* Effect.flip(
          stopped.execute(undefined).pipe(Effect.provide(server.layer)),
        ),
      ).toBe("first");
      expect(later).toBe(0);
    }),
  );

  it.effect("keeps a mapEffect service through a variant", () =>
    Effect.gen(function* () {
      const counts: Array<number> = [];
      const server = synthetic(reply);
      const layer = Layer.merge(
        server.layer,
        Layer.succeed(Audit, {
          record: (count) => Effect.sync(() => void counts.push(count)),
        }),
      );
      const audited = getThings.pipe(
        Operation.mapEffect((list) =>
          Effect.gen(function* () {
            const audit = yield* Audit;
            yield* audit.record(list.length);
            return list;
          }),
        ),
      );
      const variant = audited.pipe(Operation.mapRequest(firstFive));
      expectTypeOf<Audit>().toExtend<Services<typeof audited>>();
      expectTypeOf<Audit>().toExtend<Services<typeof variant>>();
      yield* audited.execute(undefined).pipe(Effect.provide(layer));
      yield* variant.execute(undefined).pipe(Effect.provide(layer));
      expect(counts).toEqual([2, 2]);
    }),
  );

  it.effect("delivers a mapping failure as itself, with no retry", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const everyFailure = Policy.make(Schedule.recurs(2), {
        while: (reason) => reason._tag === "Failure",
      });
      const failing = Operation.make(
        Request.get("/things").pipe(api),
        Response.status(200, Body.jsonSchema(ThingPage)),
        { policy: everyFailure },
      ).pipe(Operation.mapEffect(() => Effect.fail("mapping" as const)));
      const variant = failing.pipe(Operation.mapRequest(firstFive));
      expect(
        yield* Effect.flip(
          variant.execute(undefined).pipe(Effect.provide(server.layer)),
        ),
      ).toBe("mapping");
      expect(server.exchanges).toHaveLength(1);
      expectTypeOf<"mapping">().toExtend<Failures<typeof variant>>();
    }),
  );

  it.effect("treats a defect in a mapping as a defect, with no retry", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const everyFailure = Policy.make(Schedule.recurs(2), {
        while: (reason) => reason._tag === "Failure",
      });
      const broken = Operation.make(
        Request.get("/things").pipe(api),
        Response.status(200, Body.jsonSchema(ThingPage)),
        { policy: everyFailure },
      ).pipe(
        Operation.map(() => {
          throw new Error("broken mapping");
        }),
      );
      const exit = yield* Effect.exit(
        broken.execute(undefined).pipe(Effect.provide(server.layer)),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect("runs outside the attempt timeout", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const slow = Operation.make(
        Request.get("/things").pipe(api),
        Response.status(200, Body.jsonSchema(ThingPage)),
        {
          policy: Policy.make(Schedule.recurs(1), {
            attemptTimeout: "1 second",
          }),
        },
      ).pipe(
        Operation.mapEffect((value) =>
          Effect.as(Effect.sleep("5 seconds"), value.total),
        ),
      );
      const fiber = yield* slow
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toBe(2);
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect("runs outside the attempt's scope, so a resource outlives it", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const server = synthetic(reply);
      const opened = pagedThings.pipe(
        Operation.mapEffect((value) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("acquire");
              return value.total;
            }),
            () => Effect.sync(() => void events.push("release")),
          ),
        ),
      );
      const variant = opened.pipe(Operation.mapRequest(firstFive));
      expectTypeOf<Scope.Scope>().toExtend<Services<typeof opened>>();
      expectTypeOf<Scope.Scope>().toExtend<Services<typeof variant>>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* opened.execute(undefined);
          events.push("use");
        }),
      ).pipe(Effect.provide(server.layer));
      expect(events).toEqual(["acquire", "use", "release"]);
    }),
  );

  it.effect("stays cold, and runs again on each evaluation", () =>
    Effect.gen(function* () {
      let calls = 0;
      const server = synthetic(reply);
      const effect = pagedThings
        .pipe(
          Operation.map(() => {
            calls++;
          }),
        )
        .execute(undefined);
      expect(server.exchanges).toHaveLength(0);
      expect(calls).toBe(0);
      yield* effect.pipe(Effect.provide(server.layer));
      yield* effect.pipe(Effect.provide(server.layer));
      expect(server.exchanges).toHaveLength(2);
      expect(calls).toBe(2);
    }),
  );

  it.effect("keeps a failure a failure through every change that fits", () =>
    Effect.gen(function* () {
      const notFound = synthetic(gone);
      const sameShape = Response.replace(
        404,
        Response.tag("Missing", Body.jsonSchema(Problem)),
      );
      for (const operation of [
        search,
        search.pipe(Operation.mapRequest(firstFive)),
        search.pipe(Operation.mapResponse(sameShape)),
      ]) {
        expect(
          yield* Effect.flip(
            operation.execute(undefined).pipe(Effect.provide(notFound.layer)),
          ),
        ).toBeInstanceOf(NotFound);
      }
      const down = synthetic(() =>
        json(503, { title: "down", detail: "try later" }),
      );
      expect(
        yield* Effect.flip(
          search.execute(undefined).pipe(Effect.provide(down.layer)),
        ),
      ).toBeInstanceOf(ServerProblem);
    }),
  );

  it.effect("never sees a removed case, which falls through", () =>
    Effect.gen(function* () {
      const server = synthetic(gone);
      const removed = search.pipe(Operation.mapResponse(Response.remove(404)));
      const failure = yield* Effect.flip(
        removed.execute(undefined).pipe(Effect.provide(server.layer)),
      );
      expect(failure).toBeInstanceOf(Response.UnexpectedResponse);
      expectTypeOf<Success<typeof removed>>().toEqualTypeOf<
        Success<typeof search>
      >();
    }),
  );

  it.effect("applies a stricter decoder that replaced a case", () =>
    Effect.gen(function* () {
      const Stricter = pageOf(
        Schema.Array(
          Schema.Struct({
            id: Schema.Number,
            name: Schema.String,
            description: Schema.String,
            extra: Schema.Boolean,
          }),
        ),
      );
      const stricter = getThings.pipe(
        Operation.mapResponse(Response.replace(200, Body.jsonSchema(Stricter))),
      );
      const server = synthetic(reply);
      const failure = yield* Effect.flip(
        stricter.execute(undefined).pipe(Effect.provide(server.layer)),
      );
      expect(failure._tag).toBe("DecodeError");
    }),
  );

  it("keeps every step's failures and services when a later step is added", () => {
    const audited = search.pipe(
      Operation.mapEffect((list) => Effect.map(Audit, () => list)),
      Operation.map((list) => list.length),
      Operation.mapRequest(firstFive),
    );
    expectTypeOf<NotFound>().toExtend<Failures<typeof audited>>();
    expectTypeOf<ServerProblem>().toExtend<Failures<typeof audited>>();
    expectTypeOf<Audit>().toExtend<Services<typeof audited>>();
  });

  it("keeps the result, failures and services exact through a variant", () => {
    const variant = search.pipe(
      Operation.mapRequest(firstFive),
      Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
    );
    expectTypeOf<Success<typeof variant>>().toEqualTypeOf<
      Success<typeof search>
    >();
    expectTypeOf<NotFound>().toExtend<Failures<typeof variant>>();
    expectTypeOf<ServerProblem>().toExtend<Failures<typeof variant>>();
    expectTypeOf<Response.UnexpectedResponse>().toExtend<
      Failures<typeof variant>
    >();
    expectTypeOf<
      Services<typeof variant>
    >().toEqualTypeOf<HttpClient.HttpClient>();
  });
});

describe("Operation.unmap", () => {
  it.effect("removes every step, and map can start again", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const names = getThings.pipe(
        Operation.map((list) => list.map((entry) => entry.name)),
      );
      const raw = names.pipe(Operation.unmap);
      expect(
        yield* raw.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(page(things));
      expectTypeOf<Success<typeof raw>>().toEqualTypeOf<
        typeof ThingPage.Type
      >();

      const total = raw.pipe(Operation.map((value) => value.total));
      expect(
        yield* total.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe(2);
      expect(
        yield* names.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(["thing 1", "thing 2"]);
    }),
  );

  it.effect("reaches a new shape, and Accept follows the new response", () =>
    Effect.gen(function* () {
      const server = synthetic(() => text(200, "plain"));
      const asText = Response.replace(200, Body.text);
      const variant = getThings.pipe(
        Operation.unmap,
        Operation.mapResponse(asText),
        Operation.map((value) => value.length),
      );
      expect(
        yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe(5);
      expect(server.exchanges[0]?.request.headers.accept).toBe("text/plain");
    }),
  );

  it("takes the step's failures and services with it", () => {
    const audited = search.pipe(
      Operation.mapEffect((list) =>
        Effect.map(Audit, (audit) => [audit, list] as const),
      ),
    );
    expectTypeOf<Audit>().toExtend<Services<typeof audited>>();
    expectTypeOf<NotFound>().toExtend<Failures<typeof audited>>();
    const raw = audited.pipe(Operation.unmap);
    expectTypeOf<Audit>().not.toExtend<Services<typeof raw>>();
    expectTypeOf<NotFound>().not.toExtend<Failures<typeof raw>>();
  });

  it.effect("keeps the request and options the mapped operation had", () =>
    Effect.gen(function* () {
      const server = synthetic((_, index) =>
        index === 0 ? json(503, {}) : reply(),
      );
      const raw = getThings.pipe(
        Operation.mapRequest(firstFive),
        Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
        Operation.unmap,
      );
      expect(
        yield* raw.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(page(things));
      expect(urlsOf(server)).toEqual([
        "https://api.example.test/v1/things?page=1&limit=5",
        "https://api.example.test/v1/things?page=1&limit=5",
      ]);
    }),
  );

  it.effect("changes nothing the second time", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const twice = getThings.pipe(Operation.unmap, Operation.unmap);
      expect(
        yield* twice.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(page(things));
    }),
  );

  it.effect("changes nothing on an operation with no step", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const same = pagedThings.pipe(Operation.unmap);
      expectTypeOf<Success<typeof same>>().toEqualTypeOf<
        Success<typeof pagedThings>
      >();
      expect(
        yield* same.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(page(things));
    }),
  );
});

describe("an operation whose execute was replaced", () => {
  const replaced = {
    ...getThings,
    execute: () => Effect.succeed([thing(9)]),
  };

  it.effect("keeps it through map and mapEffect, as a wrapper does", () =>
    Effect.gen(function* () {
      const count = replaced.pipe(Operation.map((list) => list.length));
      const doubled = count.pipe(
        Operation.mapEffect((size) => Effect.succeed(size * 2)),
      );
      expect(yield* count.execute(undefined)).toBe(1);
      expect(yield* doubled.execute(undefined)).toBe(2);
    }),
  );

  it.effect("does not call it until the mapped effect runs", () =>
    Effect.gen(function* () {
      let calls = 0;
      const counting = {
        ...getThings,
        execute: () => {
          calls++;
          return Effect.succeed([thing(9)]);
        },
      };
      const effect = counting
        .pipe(Operation.map((list) => list.length))
        .execute(undefined);
      expect(calls).toBe(0);
      expect(yield* effect).toBe(1);
      expect(calls).toBe(1);
    }),
  );

  it.effect(
    "loses it when a part changes or the step goes, which build from the parts",
    () =>
      Effect.gen(function* () {
        const server = synthetic(reply);
        const count = replaced.pipe(Operation.map((list) => list.length));
        expect(
          yield* count
            .pipe(Operation.mapRequest(firstFive))
            .execute(undefined)
            .pipe(Effect.provide(server.layer)),
        ).toBe(2);
        expect(
          yield* count
            .pipe(Operation.unmap)
            .execute(undefined)
            .pipe(Effect.provide(server.layer)),
        ).toEqual(page(things));
      }),
  );
});

describe("what fits a mapped operation", () => {
  type WideResponse = Response.Response<
    unknown,
    unknown,
    unknown,
    Response.AnyCase
  >;
  const asOptions = Response.replace(200, Body.jsonSchema(OptionPage));

  it("compiles a new result the mapping was written for", () => {
    const replaced = getThings.pipe(
      Operation.mapResponse(Response.replace(200, Body.jsonSchema(ThingPage))),
    );
    const removed = search.pipe(
      Operation.mapResponse(Response.remove("server")),
    );
    const arrow = search.pipe(
      Operation.mapResponse((response) =>
        response.pipe(Response.remove("server")),
      ),
    );
    expectTypeOf<Success<typeof replaced>>().toEqualTypeOf<
      Success<typeof getThings>
    >();
    expectTypeOf<Success<typeof removed>>().toEqualTypeOf<
      Success<typeof search>
    >();
    expectTypeOf<Success<typeof arrow>>().toEqualTypeOf<
      Success<typeof search>
    >();
  });

  it("names an operation's input, mapped or not", () => {
    expectTypeOf<Operation.InputOf<typeof getThings>>().toEqualTypeOf<
      Parameters<typeof getThings.execute>[0]
    >();
    const limited = getThings.pipe(
      Operation.mapRequest(
        Request.query(Schema.Struct({ limit: Schema.FiniteFromString })),
      ),
    );
    expectTypeOf<Operation.InputOf<typeof limited>>().toEqualTypeOf<
      Parameters<typeof limited.execute>[0]
    >();
    expectTypeOf<Operation.InputOf<typeof limited>>().toExtend<{
      readonly query: { readonly limit: string | number };
    }>();
    const sealed = Operation.fromEffect(limited.execute);
    expectTypeOf<Operation.InputOf<typeof sealed>>().toEqualTypeOf<
      Parameters<typeof limited.execute>[0]
    >();
    expectTypeOf<Operation.InputOf<string>>().toEqualTypeOf<never>();
  });

  it("refuses anything else, on one case or several", () => {
    compileOnly(() => {
      // @ts-expect-error a new shape on a mapped operation with one case
      getThings.pipe(Operation.mapResponse(asOptions));
      search.pipe(
        // @ts-expect-error a new shape on a mapped operation with several cases
        Operation.mapResponse(
          Response.replace(
            200,
            Response.tag("Found", Body.jsonSchema(OptionPage)),
          ),
        ),
      );
      // @ts-expect-error unknown JSON proves nothing
      getThings.pipe(Operation.mapResponse(Response.replace(200, Body.json)));
      getThings.pipe(
        // @ts-expect-error an `any` result proves nothing either
        Operation.mapResponse(
          Response.replace(200, Body.jsonSchema(Schema.Any)),
        ),
      );
      // @ts-expect-error a new case the mapping was not written for
      getThings.pipe(Operation.mapResponse(Response.orElse(missing)));
      // @ts-expect-error a whole new response
      getThings.pipe(Operation.mapResponse(wholeNewResponse));
      search.pipe(
        // @ts-expect-error a key the contract lacks
        Operation.mapResponse(Response.replace(201, Body.text)),
      );
      // @ts-expect-error a mapping written for another shape
      getThings.pipe(Operation.map(otherInput));
    });
  });

  it("refuses a result that really is `unknown` or `any`, however it arrives", () => {
    const unknownResult: Response.Response<unknown, unknown> = Response.status(
      200,
      Body.json,
    );
    const allUnknown: WideResponse = unknownResult;
    const anyResult: Response.Response<Anything, unknown> = unknownResult;
    const anything: Anything = unknownResult;
    compileOnly(() => {
      // @ts-expect-error a response annotated with an unknown result
      getThings.pipe(Operation.mapResponse(() => unknownResult));
      // @ts-expect-error every slot unknown, as a failed inference would leave them
      getThings.pipe(Operation.mapResponse(() => allUnknown));
      // @ts-expect-error a response annotated with an `any` result
      getThings.pipe(Operation.mapResponse(() => anyResult));
      // @ts-expect-error a function that returns `any`, which gives nothing to infer from
      getThings.pipe(Operation.mapResponse(() => anything));
      // @ts-expect-error the same from the response it was given
      getThings.pipe(Operation.mapResponse((response) => response as Anything));
      getThings.pipe(
        // @ts-expect-error a schema with an unknown result
        Operation.mapResponse(
          Response.replace(200, Body.jsonSchema(Schema.Unknown)),
        ),
      );
    });
  });

  it("keeps a real `unknown` result where nothing is mapped", () => {
    const anything: Anything = Response.status(200, Body.json);
    const plain = Operation.make(
      Request.get("https://api.test/things"),
      Response.status(200, Body.jsonSchema(ThingPage)),
    );
    const variant = plain.pipe(
      Operation.mapResponse(Response.replace(200, Body.json)),
    );
    expectTypeOf<Success<typeof variant>>().toEqualTypeOf<unknown>();
    const loose = plain.pipe(Operation.mapResponse(() => anything));
    expectTypeOf<Success<typeof loose>>().toEqualTypeOf<unknown>();
  });

  // Each `@ts-expect-error` covers the one line after it, so a second error at the operation, on
  // the line before, would fail this test.
  it("reports a key it cannot address as that key and nothing else", () => {
    const widened: number = 200;
    const either = 200 as 200 | 404;
    compileOnly(() => {
      getThings.pipe(
        Operation.mapResponse(
          // @ts-expect-error a key the contract lacks
          Response.replace(500, Body.text),
        ),
      );
      getThings.pipe(
        Operation.mapResponse(
          // @ts-expect-error the same when removing
          Response.remove(500),
        ),
      );
      search.pipe(
        Operation.mapResponse(
          // @ts-expect-error the same on a contract with several cases
          Response.replace(201, Body.text),
        ),
      );
      getThings.pipe(
        Operation.mapResponse((response) =>
          response.pipe(
            // @ts-expect-error the same in an arrow function
            Response.replace(500, Body.text),
          ),
        ),
      );
      getThings.pipe(
        Operation.mapResponse(
          // @ts-expect-error a key widened to `number`
          Response.replace(widened, Body.text),
        ),
      );
      search.pipe(
        Operation.mapResponse(
          // @ts-expect-error a union of keys
          Response.remove(either),
        ),
      );
    });
  });

  it("states the missing case in the compile error", () => {
    const noSuchCase = Response.replace(500, Body.text);
    type Parameter = Parameters<
      typeof noSuchCase<
        string,
        never,
        never,
        Response.Case<200, string, never, never>
      >
    >[0];
    expectTypeOf<
      Extract<keyof Parameter, `This contract has no case${string}`>
    >().not.toBeNever();
  });

  it("names the way out first in the compile error", () => {
    const refused = Operation.mapResponse(
      (response: Response.Response<string>) =>
        response.pipe(Response.orElse(Response.status(200, Body.json))),
    );
    type Parameter = Parameters<
      typeof refused<string, unknown, unknown, Operation.Step>
    >[0];
    expectTypeOf<
      Extract<keyof Parameter, `Use Operation.unmap first${string}`>
    >().not.toBeNever();
  });

  it("compiles a new case whose result already fits", () => {
    const accepted = Response.status(202, Body.jsonSchema(ThingPage));
    const variant = getThings.pipe(
      Operation.mapResponse(Response.orElse(accepted)),
    );
    expectTypeOf<Success<typeof variant>>().toEqualTypeOf<
      Success<typeof getThings>
    >();
  });

  it.effect(
    "compiles an unchanged response, and a new one with the same result",
    () =>
      Effect.gen(function* () {
        const server = synthetic((_, index) =>
          index === 0 ? reply() : json(201, page(things)),
        );
        const same = getThings.pipe(
          Operation.mapResponse((response) => response),
        );
        const moved = getThings.pipe(
          Operation.mapResponse(() =>
            Response.status(201, Body.jsonSchema(ThingPage)),
          ),
        );
        for (const operation of [same, moved]) {
          expect(
            yield* operation
              .execute(undefined)
              .pipe(Effect.provide(server.layer)),
          ).toEqual(things);
        }
      }),
  );

  it("refuses a function typed for a wider response, mapped or not", () => {
    compileOnly(() => {
      // @ts-expect-error the response slot is invariant, so unmap does not help here
      pagedThings.pipe(Operation.mapResponse(forAnyResponse));
      // @ts-expect-error the same on a mapped operation
      getThings.pipe(Operation.mapResponse(forAnyResponse));
      // @ts-expect-error the exact result, failures and services do not say which cases there are
      pageOperation.pipe(Operation.mapResponse(forSameValues));
    });
  });

  it("takes a function typed with the response's own cases", () => {
    const variant = pageOperation.pipe(Operation.mapResponse(forSameCases));
    expectTypeOf<Success<typeof variant>>().toEqualTypeOf<
      typeof ThingPage.Type
    >();
  });

  it("compares with the current response, so widening back needs unmap", () => {
    const narrower = search.pipe(
      Operation.mapResponse(Response.remove("server")),
    );
    const again = Response.status(
      500,
      Response.tag("Server", Body.jsonSchema(OptionPage)),
    );
    compileOnly(() => {
      // @ts-expect-error the fit check compares with the current response
      narrower.pipe(Operation.mapResponse(Response.orElse(again)));
    });
  });

  it("cannot be dodged by widening the response slot", () => {
    compileOnly(() => {
      // @ts-expect-error `S` is invariant, so the response slot cannot be widened by annotation
      const widened: Operation.Operation<
        never,
        unknown,
        unknown,
        unknown,
        Operation.Parts<unknown, WideResponse, unknown, unknown>
      > = getThings;
      // @ts-expect-error a mapped operation cannot pose as an unmapped one
      const unmapped: Operation.Operation<
        never,
        unknown,
        unknown,
        unknown,
        Operation.Parts<unknown, WideResponse, unknown, undefined>
      > = getThings;
      return [widened, unmapped];
    });
  });

  it("checks a step of unknown type too: only undefined means no step", () => {
    compileOnly(
      (
        unknownStep: Operation.Operation<
          never,
          string,
          unknown,
          unknown,
          Operation.Parts<
            Request.Request<unknown>,
            Response.Response<string>,
            unknown,
            unknown
          >
        >,
        wide: WideResponse,
      ) => {
        // @ts-expect-error the new result does not fit, whatever the step is
        unknownStep.pipe(Operation.mapResponse(() => wide));
      },
    );
  });

  it.effect(
    "is a compile-time rule, so a cast hands the mapping the wrong shape",
    () =>
      Effect.gen(function* () {
        const seen: Array<unknown> = [];
        const defined = pagedThings.pipe(
          Operation.map((value) => {
            seen.push(value);
            return value.data;
          }),
        );
        const mapResponse = Operation.mapResponse as unknown as (
          f: unknown,
        ) => (self: typeof defined) => typeof defined;
        const forced = mapResponse(Response.replace(200, Body.text))(defined);
        const server = synthetic(() => text(200, "plain"));
        expect(
          yield* forced.execute(undefined).pipe(Effect.provide(server.layer)),
        ).toBeUndefined();
        expect(seen).toEqual(["plain"]);
      }),
  );
});

describe("operations with no parts", () => {
  const local = Operation.fromEffect((id: number) =>
    Effect.succeed({ data: [id] }),
  ).pipe(Operation.map((value) => value.data));

  it.effect("map and mapEffect wrap them, as they always did", () =>
    Effect.gen(function* () {
      const failing = local.pipe(
        Operation.mapEffect((list) =>
          list.length > 1
            ? Effect.succeed(list)
            : Effect.fail("short" as const),
        ),
      );
      expect(yield* local.execute(7)).toEqual([7]);
      expect(yield* Effect.flip(failing.execute(7))).toBe("short");
      expect("parts" in local).toBe(false);
      expect("parts" in failing).toBe(false);
    }),
  );

  it("cannot be adjusted, and say so clearly past the types", () => {
    compileOnly(() => {
      // @ts-expect-error a value from fromEffect has no request to adjust
      local.pipe(Operation.mapRequest(firstFive));
      // @ts-expect-error nor a response
      local.pipe(Operation.mapResponse(Response.remove(200)));
      // @ts-expect-error nor options
      local.pipe(Operation.mapOptions(() => ({})));
      // @ts-expect-error nor a step to remove
      local.pipe(Operation.unmap);
    });
    const forced = Operation.unmap as (self: unknown) => unknown;
    expect(() => forced(local)).toThrow("no parts");
  });

  it.effect(
    "sealing with fromEffect keeps the types and removes the parts",
    () =>
      Effect.gen(function* () {
        const server = synthetic(reply);
        const sealed = Operation.fromEffect(getThings.execute);
        expect("parts" in sealed).toBe(false);
        expectTypeOf<Success<typeof sealed>>().toEqualTypeOf<
          Success<typeof getThings>
        >();
        expectTypeOf<Failures<typeof sealed>>().toEqualTypeOf<
          Failures<typeof getThings>
        >();
        compileOnly(() => {
          // @ts-expect-error sealing removes the parts
          sealed.pipe(Operation.mapRequest(firstFive));
        });
        expect(
          yield* sealed.execute(undefined).pipe(Effect.provide(server.layer)),
        ).toEqual(things);
        expect(
          yield* sealed
            .pipe(Operation.map((list) => list.length))
            .execute(undefined)
            .pipe(Effect.provide(server.layer)),
        ).toBe(2);
      }),
  );

  it("a plain annotation seals at compile time", () => {
    const annotated: Operation.Operation<undefined, unknown, unknown, unknown> =
      getThings;
    const asOptions = Response.replace(200, Body.jsonSchema(OptionPage));
    compileOnly(() => {
      // @ts-expect-error the annotation hides the parts
      annotated.pipe(Operation.mapRequest(firstFive));
      // @ts-expect-error a widened result is refused too
      annotated.pipe(Operation.mapResponse(asOptions));
    });
  });

  it.effect("an exported function offers part of a definition", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      yield* listThings(2)
        .execute(undefined)
        .pipe(Effect.provide(server.layer));
      expect(urlsOf(server)).toEqual([
        "https://api.example.test/v1/things?page=2&limit=25",
      ]);
    }),
  );
});

describe("reading and using a variant", () => {
  it("reads a part with operation.parts", () => {
    const request = Request.get("/things").pipe(api);
    const response = Response.status(200, Body.jsonSchema(ThingPage));
    const options = { policy: retryTwice };
    const operation = Operation.make(request, response, options);
    expect(operation.parts?.request).toBe(request);
    expect(operation.parts?.response).toBe(response);
    expect(operation.parts?.options).toBe(options);
    expect(operation.parts?.step).toBeUndefined();

    const mapped = operation.pipe(Operation.map((value) => value.total));
    expect(mapped.parts?.request).toBe(request);
    expect(mapped.parts?.step).toBeDefined();
    expect(mapped.pipe(Operation.unmap).parts?.step).toBeUndefined();
    expect(pagedThings.parts?.options).toBeUndefined();
  });

  it.effect("stays an Operation for code that knows nothing of parts", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const variant = getThings.pipe(Operation.mapRequest(firstFive));
      const plain: Operation.Operation<
        undefined,
        Success<typeof variant>,
        Failures<typeof variant>,
        HttpClient.HttpClient
      > = variant;
      expect(
        yield* Operation.execute(plain, undefined).pipe(
          Effect.provide(server.layer),
        ),
      ).toEqual(things);
      expect(
        yield* variant.pipe(
          Operation.execute(undefined),
          Effect.provide(server.layer),
        ),
      ).toEqual(things);
    }),
  );

  it.effect("works in an interaction", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const variant = getThings.pipe(Operation.mapRequest(firstFive));
      const result = yield* Effect.gen(function* () {
        const interaction = yield* Interaction.make(variant.execute);
        return yield* interaction.run(undefined);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
      expect(result).toEqual(things);
    }),
  );
});

describe("ways to write a variant", () => {
  const dropdownUrl =
    "https://api.example.test/v1/things?limit=all&fields=id%2Cname";
  const asOptions = Response.replace(200, Body.jsonSchema(OptionPage));

  it.effect("names each transform and maps once per change", () =>
    Effect.gen(function* () {
      const server = synthetic(dropdownReply);
      const thingOptions = pagedThings.pipe(
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapResponse(asOptions),
        Operation.map((value) => value.data),
      );
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expect(urlsOf(server)).toEqual([dropdownUrl]);
      expectTypeOf<Success<typeof thingOptions>>().toEqualTypeOf<
        ReadonlyArray<typeof ThingOption.Type>
      >();
    }),
  );

  it.effect("goes through unmap from a mapped definition", () =>
    Effect.gen(function* () {
      const server = synthetic(dropdownReply);
      const thingOptions = getThings.pipe(
        Operation.unmap,
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
        Operation.mapResponse(asOptions),
        Operation.map((value) => value.data),
      );
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expect(urlsOf(server)).toEqual([dropdownUrl]);
    }),
  );

  it.effect("reuses one generic mapping before and after a new shape", () =>
    Effect.gen(function* () {
      const dataOrNotFound = <D>(
        result:
          | Response.Tagged<"Found", { readonly data: D }>
          | Response.Tagged<"Missing", typeof Problem.Type>,
      ) =>
        result._tag === "Found"
          ? Effect.succeed(result.value.data)
          : Effect.fail(new NotFound({ detail: result.value.detail }));

      const definition = Operation.make(
        Request.get("/things?page=1&limit=25").pipe(api),
        found.pipe(Response.orElse(missing)),
      ).pipe(Operation.mapEffect(dataOrNotFound));

      const taggedOptions = Response.replace(
        200,
        Response.tag("Found", Body.jsonSchema(OptionPage)),
      );
      const thingOptions = definition.pipe(
        Operation.unmap,
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapResponse(taggedOptions),
        Operation.mapEffect(dataOrNotFound),
      );

      const server = synthetic(dropdownReply);
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expectTypeOf<Success<typeof thingOptions>>().toEqualTypeOf<
        ReadonlyArray<typeof ThingOption.Type>
      >();
      expectTypeOf<NotFound>().toExtend<Failures<typeof thingOptions>>();

      const notFound = synthetic(gone);
      expect(
        yield* Effect.flip(
          thingOptions.execute(undefined).pipe(Effect.provide(notFound.layer)),
        ),
      ).toBeInstanceOf(NotFound);
    }),
  );

  it.effect(
    "defines one composed function with flow, or a named function",
    () =>
      Effect.gen(function* () {
        const composed = flow(withoutPaging, idAndNameOnly);
        const named = <I, E, R>(request: Request.Request<I, E, R>) =>
          request.pipe(withoutPaging, idAndNameOnly);
        for (const variant of [
          pagedThings.pipe(Operation.mapRequest(composed)),
          pagedThings.pipe(Operation.mapRequest(named)),
        ]) {
          const server = synthetic(reply);
          yield* variant.execute(undefined).pipe(Effect.provide(server.layer));
          expect(urlsOf(server)).toEqual([dropdownUrl]);
        }
      }),
  );

  it.effect("composes maps with flow, which stays adjustable", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const toCount = flow(
        Operation.map((value: typeof ThingPage.Type) => value.data),
        Operation.map((list) => list.length),
      );
      const composed = pagedThings.pipe(toCount);
      const variant = composed.pipe(Operation.mapRequest(firstFive));
      expect(
        yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe(2);
      expectTypeOf<Success<typeof variant>>().toEqualTypeOf<number>();
    }),
  );

  it.effect("takes a generic function in map", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const firstThing = getThings.pipe(Operation.map(firstOf));
      expect(
        yield* firstThing
          .pipe(Operation.mapRequest(firstFive))
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual(thing(1));
      expectTypeOf<Success<typeof firstThing>>().toEqualTypeOf<
        typeof Thing.Type | undefined
      >();
    }),
  );

  it.effect("holds a map in a variable", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const toData = Operation.map(
        (value: typeof ThingPage.Type) => value.data,
      );
      const held = pagedThings.pipe(toData);
      const variant = held.pipe(Operation.mapRequest(firstFive));
      expect(
        yield* variant.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual(things);
    }),
  );

  it("holds a mapOptions that does not read the options in a variable", () => {
    const noRetries = Operation.mapOptions(() => ({ policy: Policy.none }));
    const variant = pagedThings.pipe(noRetries);
    expect(variant.parts?.options?.policy).toBe(Policy.none);
    expectTypeOf<
      Services<typeof variant>
    >().toEqualTypeOf<HttpClient.HttpClient>();
  });

  it.effect("flows once the first function names the operation", () =>
    Effect.gen(function* () {
      const forDropdown = flow(
        identity<typeof getThings>,
        Operation.unmap,
        Operation.mapRequest(withoutPaging),
        Operation.mapRequest(idAndNameOnly),
        Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
        Operation.mapResponse(asOptions),
        Operation.map((value) => value.data),
      );
      const server = synthetic(dropdownReply);
      expect(
        yield* forDropdown(getThings)
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual([option(1)]);
      expect(urlsOf(server)).toEqual([dropdownUrl]);
      expectTypeOf<Success<ReturnType<typeof forDropdown>>>().toEqualTypeOf<
        ReadonlyArray<typeof ThingOption.Type>
      >();
    }),
  );

  it("keeps the fit rule in a flow that names the operation", () => {
    compileOnly(() => {
      flow(
        identity<typeof getThings>,
        // @ts-expect-error the mapping was not written for this response
        Operation.mapResponse(asOptions),
      );
    });
  });

  it("names the operation in a function, which addresses cases as pipe does", () => {
    const withoutServer = (operation: typeof search) =>
      operation.pipe(
        Operation.mapRequest(firstFive),
        Operation.mapResponse(Response.remove("server")),
      );
    expectTypeOf<Success<ReturnType<typeof withoutServer>>>().toEqualTypeOf<
      Success<typeof search>
    >();
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/125
  it("currently refuses flow over the adjustment functions with no operation", () => {
    const unwrapped = Operation.map(dataOf);
    const noServer = Response.remove("server");
    compileOnly(() => {
      // @ts-expect-error the mapping needs a result the flow does not know yet
      flow(Operation.mapRequest(firstFive), unwrapped);
      // @ts-expect-error the same after unmap, and the response has no known cases
      flow(Operation.unmap, Operation.mapResponse(asOptions), unwrapped);
      // @ts-expect-error there are no options yet to spread
      flow(Operation.mapOptions((o) => ({ ...o, policy: retryTwice })));
      // @ts-expect-error a key and the fit rule need a known operation
      flow(Operation.mapRequest(firstFive), Operation.mapResponse(noServer));
    });
  });

  it("currently cannot address a case from a function generic in the cases", () => {
    compileOnly(
      <A, E, R, C extends Response.AnyCase>(
        response: Response.Response<A, E, R, C>,
      ) => {
        // @ts-expect-error a key needs a known contract
        response.pipe(Response.remove(404));
      },
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/125
  it("currently needs the pipe around a generic transform to infer its types", () => {
    const held = Operation.mapRequest(firstFive);
    const variant = pagedThings.pipe(held);
    expectTypeOf<Services<typeof variant>>().toEqualTypeOf<unknown>();

    const inPipe = pagedThings.pipe(Operation.mapRequest(firstFive));
    expectTypeOf<
      Services<typeof inPipe>
    >().toEqualTypeOf<HttpClient.HttpClient>();

    compileOnly(() => {
      // @ts-expect-error held on its own, the transform has no contract to read keys from
      Operation.mapResponse(asOptions);
    });
  });

  it.effect("writes an arrow function in place", () =>
    Effect.gen(function* () {
      const server = synthetic(dropdownReply);
      const thingOptions = pagedThings.pipe(
        Operation.mapRequest((request) =>
          request.pipe(withoutPaging, idAndNameOnly),
        ),
        Operation.mapResponse((response) => response.pipe(asOptions)),
      );
      expect(
        yield* thingOptions
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      ).toEqual(page([option(1)]));
      expect(urlsOf(server)).toEqual([dropdownUrl]);
    }),
  );

  it.effect("uses Effect.gen in mapEffect", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const counted = getThings.pipe(
        Operation.mapEffect((list) =>
          Effect.gen(function* () {
            const size = yield* Effect.succeed(list.length);
            return size * 2;
          }),
        ),
        Operation.mapRequest(firstFive),
      );
      expect(
        yield* counted.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toBe(4);
      expectTypeOf<Success<typeof counted>>().toEqualTypeOf<number>();
    }),
  );

  it.effect("uses Effect.fn in mapEffect", () =>
    Effect.gen(function* () {
      const counts: Array<number> = [];
      const server = synthetic(reply);
      const audit = Effect.fn("audit")(function* (
        list: ReadonlyArray<typeof Thing.Type>,
      ) {
        const service = yield* Audit;
        yield* service.record(list.length);
        return list.length;
      });
      const audited = getThings.pipe(
        Operation.mapEffect(audit),
        Operation.mapRequest(firstFive),
      );
      expectTypeOf<Audit>().toExtend<Services<typeof audited>>();
      expect(
        yield* audited.execute(undefined).pipe(
          Effect.provide(server.layer),
          Effect.provideService(Audit, {
            record: (count) => Effect.sync(() => void counts.push(count)),
          }),
        ),
      ).toBe(2);
      expect(counts).toEqual([2]);
    }),
  );

  it.effect("runs a generic helper over the plain type", () =>
    Effect.gen(function* () {
      const server = synthetic(reply);
      const helped = inList(getThings);
      expect(
        yield* helped.execute(undefined).pipe(Effect.provide(server.layer)),
      ).toEqual([things]);
      expectTypeOf<Success<typeof helped>>().toEqualTypeOf<
        readonly [Success<typeof getThings>]
      >();
      compileOnly(() => {
        // @ts-expect-error the plain parameter hides the parts, and the result stays plain
        helped.pipe(Operation.mapRequest(firstFive));
      });
    }),
  );

  it.effect(
    "runs a generic helper over the parts, which stays adjustable",
    () =>
      Effect.gen(function* () {
        const server = synthetic(reply);
        const tenanted = withTenant(getThings).pipe(
          Operation.mapRequest(firstFive),
        );
        expect(
          yield* tenanted.execute(undefined).pipe(Effect.provide(server.layer)),
        ).toEqual(things);
        expect(server.exchanges[0]?.request.headers["x-tenant"]).toBe("a");
      }),
  );
});
