import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Logger,
  Option,
  References,
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
        expect(lines.filter(([name]) => name === "x-scope")).toEqual([
          ["x-scope", "read"],
          ["x-scope", "write"],
        ]);
        expect(lines.map(([name]) => name)).toContain("traceparent");
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

describe("Operation failures", () => {
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

  it.effect("rejects a GET body as InvalidRequest before dispatch", () =>
    Effect.gen(function* () {
      const server = synthetic(() => json(200, {}));
      const exit = yield* Operation.make(
        Request.get("https://soap.test/download").pipe(Request.body(Body.text)),
        Response.status(200, Body.bytes),
      )
        .execute({ body: "<Envelope/>" })
        .pipe(Effect.provide(server.layer), Effect.exit);
      expect(failureOf(exit)).toBeInstanceOf(Request.InvalidRequest);
      expect(server.exchanges).toHaveLength(0);
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
  it.effect("keeps request encoding and response decoding services apart", () =>
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
      >().toEqualTypeOf<Suffix | HttpClient.HttpClient>();
      expectTypeOf<
        Effect.Services<ReturnType<typeof receive.execute>>
      >().toEqualTypeOf<Prefix | HttpClient.HttpClient>();

      const server = synthetic((exchange) =>
        exchange.request.method === "POST" ? empty(204) : json(200, "wire"),
      );
      yield* send
        .execute({ body: "label" })
        .pipe(Effect.provide(server.layer), Effect.provideService(Suffix, "!"));
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
      expectTypeOf<"retry budget unavailable">().toExtend<
        Effect.Error<ReturnType<typeof operation.execute>>
      >();
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
const withKey = <I, E, R, H extends boolean>(
  request: Request.Request<I, E, R, H, false>,
) =>
  request.pipe(
    Request.setQuery("key", "abc"),
    Request.baseUrl("https://api.test/v1"),
  );

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
