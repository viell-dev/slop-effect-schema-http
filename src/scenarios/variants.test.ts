/**
 * EXT-19: variants of a definition over real sockets, in both lanes (#86, #88 and #105). The
 * library's own tests state each rule; these show that a variant's request and answer are what
 * reach the wire, that the definition it came from still sends its own, and that a recorded step
 * stays outside the retries and timeouts of a real exchange.
 */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Effect, Schedule, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Ops from "../clients/business/operations.js";
import { type Backend, header, type Recorded } from "../harness/lane.js";

const token = "variants-token";

const seeded = (title: string, done: boolean) => ({
  title,
  assigneeId: "a.lind",
  priority: 2,
  due: null,
  notes: null,
  done,
  created: 1_700_000_000_000,
});

type Json = Parameters<typeof lane.backend>[1];

const start = (options: { readonly [key: string]: Json } = {}) =>
  lane.backend("business", {
    operations: {
      token,
      tasks: [seeded("Open the books", false), seeded("Close them", true)],
      ...options,
    },
  });

const connect = (backend: Backend): Ops.Connection => ({
  baseUrl: `${backend.origin}/v2`,
  credential: () => token,
});

const targets = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map(({ target }) => target);

const accepts = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map(({ lines }) => header(lines, "accept"));

const task = { path: { id: "T-1001" } };
const missing = { path: { id: "T-9999" } };

/** One task, declared as its JSON alone. */
const readJson = (connection: Ops.Connection) =>
  Operation.make(
    Request.get("/tasks").pipe(
      Ops.at(connection),
      Request.path`/${Request.pathValue("id")}`,
    ),
    Response.status(200, Body.jsonSchema(Ops.Task)),
  );

class Refused extends Data.TaggedError("Refused")<{
  readonly title: string;
}> {}

describe(`variants over real sockets (${lane.name})`, () => {
  it.live(
    "[EXT-19a] a request variant sends its own query, and the definition it came from still sends none",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const all = Ops.listTasks(connect(backend));
        const done = all.pipe(
          Operation.mapRequest(Request.setQuery("status", "done")),
        );
        const input = { query: {} };
        const before = yield* all.execute(input);
        const variant = yield* done.execute(input);
        const after = yield* all.execute(input);
        expect(targets(yield* backend.ledger)).toEqual([
          "/v2/tasks",
          "/v2/tasks?status=done",
          "/v2/tasks",
        ]);
        expect(before._tag === "Tasks" && before.value.count).toBe(2);
        expect(variant._tag === "Tasks" && variant.value.count).toBe(1);
        expect(after._tag === "Tasks" && after.value.count).toBe(2);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19a] an options variant retries a real 420, and the definition it came from does not",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const once = Ops.quote(connect(backend), Policy.none);
        const patient = once.pipe(
          Operation.mapOptions((options) => ({
            ...options,
            policy: Policy.make(Schedule.recurs(2), {
              while: Ops.transientOrCalm,
            }),
          })),
        );
        const input = { path: { pair: "EURUSD" } };
        const refused = yield* Effect.flip(once.execute(input));
        expect(refused).toBeInstanceOf(Response.UnexpectedResponse);
        expect(yield* backend.ledger).toHaveLength(1);
        const quote = yield* patient.execute(input);
        expect(quote.pair).toBe("EURUSD");
        // The one refused request above, then the variant's three attempts.
        expect(targets(yield* backend.ledger)).toEqual(
          Array.from({ length: 4 }, () => "/v2/rates/EURUSD"),
        );
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  for (const [provider, client] of lane.clients)
    it.live(
      `[EXT-19b] ${provider}: the automatic Accept follows a replaced case, and the definition keeps its own`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const json = readJson(connect(backend));
          const text = json.pipe(
            Operation.mapResponse(Response.replace(200, Body.text)),
          );
          const value = yield* text.execute(task);
          const decoded = yield* json.execute(task);
          expect(typeof value).toBe("string");
          expect(JSON.parse(value)).toMatchObject({ id: "T-1001" });
          expect(decoded.id).toBe("T-1001");
          expect(accepts(yield* backend.ledger)).toEqual([
            "text/plain",
            "application/json",
          ]);
        }).pipe(Effect.provide(client)),
    );

  it.live(
    "[EXT-19b] the automatic Accept loses what a removed case declared",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const both = Operation.make(
          Request.get("/tasks").pipe(
            Ops.at(connect(backend)),
            Request.path`/${Request.pathValue("id")}`,
          ),
          Response.status(200, Body.jsonSchema(Ops.Task)).pipe(
            Response.orElse(Response.status(404, Body.text)),
          ),
        );
        const onlyJson = both.pipe(Operation.mapResponse(Response.remove(404)));
        yield* both.execute(task);
        yield* onlyJson.execute(task);
        expect(accepts(yield* backend.ledger)).toEqual([
          "application/json, text/plain",
          "application/json",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19c] a removed 404 falls through to UnexpectedResponse, and the definition still decodes it",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const read = Ops.readTask(connect(backend));
        const strict = read.pipe(Operation.mapResponse(Response.remove(404)));
        const declared = yield* read.execute(missing);
        expect(declared._tag).toBe("NotFound");
        const error = yield* Effect.flip(strict.execute(missing));
        expect(error).toBeInstanceOf(Response.UnexpectedResponse);
        if (error instanceof Response.UnexpectedResponse)
          expect(error.metadata.status).toBe(404);
        const found = yield* strict.execute(task);
        expect(found._tag).toBe("Task");
        expect(yield* backend.ledger).toHaveLength(3);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[EXT-19d] a recorded step runs once after three real attempts", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      let steps = 0;
      const rate = Ops.quote(
        connect(backend),
        Policy.make(Schedule.recurs(2), { while: Ops.transientOrCalm }),
      ).pipe(
        Operation.map((quote) => {
          steps += 1;
          return quote.rate;
        }),
      );
      const value = yield* rate.execute({ path: { pair: "EURUSD" } });
      expect(typeof value).toBe("string");
      expect(steps).toBe(1);
      expect(yield* backend.ledger).toHaveLength(3);
    }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19d] a failing step comes back as itself, and a policy that retries failures sends one request",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let steps = 0;
        const refusing = readJson(connect(backend)).pipe(
          Operation.mapOptions((options) => ({
            ...options,
            policy: Policy.make(Schedule.recurs(3), {
              while: (reason) => reason._tag === "Failure",
            }),
          })),
          Operation.mapEffect(({ title }) => {
            steps += 1;
            return Effect.fail(new Refused({ title }));
          }),
        );
        const error = yield* Effect.flip(refusing.execute(task));
        expect(error).toBeInstanceOf(Refused);
        expect(steps).toBe(1);
        expect(yield* backend.ledger).toHaveLength(1);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19d] a classifier that retries every outcome repeats a real 200, and the step runs once, on the last",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let steps = 0;
        const repeating = readJson(connect(backend)).pipe(
          Operation.mapOptions((options) => ({
            ...options,
            policy: Policy.make(Schedule.recurs(3), { while: () => true }),
          })),
          Operation.map(({ title }) => {
            steps += 1;
            return title;
          }),
        );
        expect(yield* repeating.execute(task)).toBe("Open the books");
        expect(steps).toBe(1);
        expect(yield* backend.ledger).toHaveLength(4);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19d] a slow step is not under the attempt timeout, which the attempt itself met in time",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const slow = readJson(connect(backend)).pipe(
          Operation.mapOptions((options) => ({
            ...options,
            policy: Policy.make(Schedule.recurs(1), {
              attemptTimeout: "1 second",
            }),
          })),
          Operation.mapEffect((read) =>
            Effect.as(Effect.sleep("1200 millis"), read.title),
          ),
        );
        expect(yield* slow.execute(task)).toBe("Open the books");
        expect(yield* backend.ledger).toHaveLength(1);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19d] attempts that time out never reach the step, and fail as a timeout",
    () =>
      Effect.gen(function* () {
        const backend = yield* start({ longPollHold: 10_000 });
        let steps = 0;
        let attempts = 0;
        const polled = Ops.pollEvents(
          connect(backend),
          Policy.make(Schedule.recurs(1), { attemptTimeout: "150 millis" }),
        ).pipe(
          Operation.mapOptions((options) => ({
            ...options,
            transformClient: (
              client: HttpClient.HttpClient,
              attempt: number,
            ) => {
              attempts = attempt;
              return client;
            },
          })),
          Operation.map((answer) => {
            steps += 1;
            return answer;
          }),
        );
        const error = yield* Effect.flip(polled.execute(undefined));
        expect(Cause.isTimeoutError(error)).toBe(true);
        expect(steps).toBe(0);
        // Counted at the client: a request aborted this soon need not have reached the socket.
        expect(attempts).toBe(2);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19d] a request variant of a mapped operation keeps the step, and sends its own request",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const titled = readJson(connect(backend)).pipe(
          Operation.map(({ title }) => title),
        );
        const other = titled.pipe(
          Operation.mapRequest(Request.setHeader("X-Trace", "variant")),
        );
        expect(yield* other.execute(task)).toBe("Open the books");
        expect(yield* titled.execute(task)).toBe("Open the books");
        const [variant, original] = yield* backend.ledger;
        expect(header(variant!.lines, "x-trace")).toBe("variant");
        expect(header(original!.lines, "x-trace")).toBeUndefined();
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19e] Operation.unmap gives the response's own value back, and the mapped operation keeps its step",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const titled = readJson(connect(backend)).pipe(
          Operation.map(({ title }) => title),
        );
        const whole = Operation.unmap(titled);
        expect((yield* whole.execute(task)).id).toBe("T-1001");
        expect(yield* titled.execute(task)).toBe("Open the books");
        expect(targets(yield* backend.ledger)).toEqual([
          "/v2/tasks/T-1001",
          "/v2/tasks/T-1001",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19e] a response that does not fit a mapping goes through Operation.unmap, and its Accept reaches the wire",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const titled = readJson(connect(backend)).pipe(
          Operation.map(({ title }) => title),
        );
        const sized = titled.pipe(
          Operation.unmap,
          Operation.mapResponse(Response.replace(200, Body.text)),
          Operation.map((text) => text.length),
        );
        expect(yield* sized.execute(task)).toBeGreaterThan(0);
        expect(yield* titled.execute(task)).toBe("Open the books");
        expect(accepts(yield* backend.ledger)).toEqual([
          "text/plain",
          "application/json",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-19e] a 404 turned into a failure stays one when that case is replaced by one of the same shape",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const Problem = Schema.Struct({ error: Schema.String });
        const problem = Response.tag("Missing", Body.jsonSchema(Problem));
        const read = Operation.make(
          Request.get("/tasks").pipe(
            Ops.at(connect(backend)),
            Request.path`/${Request.pathValue("id")}`,
          ),
          Response.status(200, Response.tag("Found", Body.json)).pipe(
            Response.orElse(Response.status(404, problem)),
          ),
        ).pipe(
          Operation.mapEffect((result) =>
            result._tag === "Missing"
              ? Effect.fail(new Refused({ title: result.value.error }))
              : Effect.succeed(result.value),
          ),
        );
        const same = read.pipe(
          Operation.mapResponse(Response.replace(404, problem)),
        );
        const error = yield* Effect.flip(same.execute(missing));
        expect(error).toBeInstanceOf(Refused);
        expect(yield* backend.ledger).toHaveLength(1);
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});
