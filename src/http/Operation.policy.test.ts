import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  References,
  Schedule,
} from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import {
  failureOf,
  getItem,
  recording,
  retries,
} from "../../test/operation.js";
import { bodyText, empty, json, synthetic, text } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import * as UrlEncoding from "./UrlEncoding.js";

/** Up to `retries` retries, at least one second apart. */
const spaced = (count: number, options?: Parameters<typeof Policy.make>[1]) =>
  Policy.make(
    Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(count)]),
    options,
  );

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

  it.effect("adds no attempt for a Retry-After once the budget is spent", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(503, { "retry-after": "10" }));
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(204, Body.empty),
        { policy: spaced(1) },
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(failureOf(yield* Fiber.await(fiber))).toBeInstanceOf(
        Response.UnexpectedResponse,
      );
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

  it.effect("bounds the drain of an unmatched body within the attempt", () =>
    Effect.gen(function* () {
      const server = synthetic(
        () =>
          new globalThis.Response(
            new ReadableStream<Uint8Array>({
              pull: () => new Promise(() => {}),
            }),
            { status: 500 },
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
    }),
  );

  it.effect("covers a Body.mapEffect within the attempt", () =>
    Effect.gen(function* () {
      const server = synthetic(() => text(200, "x"));
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        Response.status(
          200,
          Body.text.pipe(Body.mapEffect(() => Effect.never)),
        ),
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
    }),
  );

  it.effect("lets a caller's timeout cover preparation and retry delays", () =>
    Effect.gen(function* () {
      const accepted = Response.status(204, Body.empty);
      const idle = synthetic(() => empty(204));
      const preparing = yield* Operation.make(
        Request.get("/things").pipe(
          Request.baseUrl(
            Effect.as(Effect.sleep("1 minute"), "https://slow.test"),
          ),
        ),
        accepted,
      )
        .execute(undefined)
        .pipe(
          Effect.timeout("1 second"),
          Effect.provide(idle.layer),
          Effect.forkChild,
        );
      yield* TestClock.adjust("1 second");
      const slowExit = yield* Fiber.await(preparing);
      expect(Cause.isTimeoutError(failureOf(slowExit))).toBe(true);
      expect(idle.exchanges).toHaveLength(0);

      const busy = synthetic(() => empty(503));
      const waiting = yield* Operation.make(
        Request.get("https://api.test/"),
        accepted,
        { policy: spaced(5) },
      )
        .execute(undefined)
        .pipe(
          Effect.timeout("1500 millis"),
          Effect.provide(busy.layer),
          Effect.forkChild,
        );
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("500 millis");
      const busyExit = yield* Fiber.await(waiting);
      expect(Cause.isTimeoutError(failureOf(busyExit))).toBe(true);
      expect(busy.exchanges).toHaveLength(2);
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

// https://github.com/viell-dev/slop-effect-schema-http/issues/136
describe("an operation with Policy.timeout", () => {
  const accepted = Response.status(204, Body.empty);
  const quick = { policy: Policy.timeout("1 second") };

  it.effect("gives up on a slow attempt, aborts it and makes no other", () =>
    Effect.gen(function* () {
      const server = synthetic(() => Effect.never);
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        accepted,
        quick,
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const exit = yield* Fiber.await(fiber);
      expect(Cause.isTimeoutError(failureOf(exit))).toBe(true);
      expect(server.exchanges).toHaveLength(1);
      expect(server.exchanges[0]?.signal.aborted).toBe(true);
    }),
  );

  it.effect("does not retry a transient answer", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(503));
      yield* Effect.exit(
        Operation.make(Request.get("https://api.test/"), accepted, quick)
          .execute(undefined)
          .pipe(Effect.provide(server.layer)),
      );
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect("excludes preparation", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      const fiber = yield* Operation.make(
        Request.get("/things").pipe(
          Request.baseUrl(
            Effect.as(Effect.sleep("1 minute"), "https://slow.test"),
          ),
        ),
        accepted,
        quick,
      )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
      expect(server.exchanges).toHaveLength(1);
    }),
  );

  it.effect("excludes result mapping", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      const fiber = yield* Operation.make(
        Request.get("https://api.test/"),
        accepted,
        quick,
      )
        .pipe(
          Operation.mapEffect(() =>
            Effect.as(Effect.sleep("1 minute"), "done"),
          ),
        )
        .execute(undefined)
        .pipe(Effect.provide(server.layer), Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toBe("done");
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

  it.effect("puts prependUrl's text before a fixed base, past the join", () =>
    Effect.gen(function* () {
      const joins: Array<readonly [string, string]> = [];
      const server = synthetic(() => empty(204));
      const onServer = HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://eu.test"),
      );
      yield* Operation.make(
        Request.get("/things").pipe(Request.baseUrl("https://api.test")),
        contract,
        { transformClient: (client) => onServer(client) },
      )
        .execute(undefined)
        .pipe(
          Effect.provide(server.layer),
          Effect.provide(
            UrlEncoding.layer({
              ...UrlEncoding.defaults,
              join: (base, path) => {
                joins.push([base, path]);
                return UrlEncoding.defaults.join(base, path);
              },
            }),
          ),
        );
      expect(joins).toEqual([["https://api.test", "/things"]]);
      expect(server.exchanges.map(({ url }) => url)).toEqual([
        "https://eu.test/https://api.test/things",
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
