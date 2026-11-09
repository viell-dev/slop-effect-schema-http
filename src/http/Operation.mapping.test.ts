import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Schema,
  type Scope,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import {
  api,
  Audit,
  compileOnly,
  contract,
  type Failures,
  firstFive,
  getThings,
  gone,
  missing,
  Nonce,
  NotFound,
  option,
  OptionPage,
  page,
  pagedThings,
  pageOf,
  Problem,
  reply,
  retryTwice,
  search,
  ServerProblem,
  type Services,
  type Success,
  thing,
  ThingPage,
  things,
  urlsOf,
  withoutPaging,
} from "../../test/operation.js";
import { bodyText, json, synthetic, text } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

type Input<T> =
  T extends Operation.Operation<infer I, unknown, unknown, unknown> ? I : never;

/** Statements only the compiler reads: they are refused, so they must never run. */
/** `any`, named through the schema that holds it. */
type Anything = (typeof Schema.Any)["Type"];

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
