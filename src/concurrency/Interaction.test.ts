import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { empty, json, synthetic } from "../../test/support.js";
import * as Body from "../http/Body.js";
import * as Operation from "../http/Operation.js";
import * as Request from "../http/Request.js";
import * as Response from "../http/Response.js";
import * as Interaction from "./Interaction.js";

/** An execution whose calls start, wait for release, and record interruption and finalization. */
const controlled = <I>() =>
  Effect.sync(() => {
    const calls: Array<I> = [];
    const interrupted: Array<I> = [];
    const finalized: Array<I> = [];
    const gates = new Map<number, Deferred.Deferred<void>>();
    const starts: Array<Deferred.Deferred<void>> = [];
    const startOf = (index: number) =>
      (starts[index] ??= Deferred.makeUnsafe<void>());
    const execute = (input: I) =>
      Effect.gen(function* () {
        const index = calls.length;
        calls.push(input);
        const gate = yield* Deferred.make<void>();
        gates.set(index, gate);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finalized.push(input)),
        );
        // Signal inside the interruption handler, so an interruption right after the signal is
        // still recorded.
        yield* Deferred.succeed(startOf(index), undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.push(input))),
        );
        return `${String(input)}#${index}`;
      });
    /** Wait until `count` executions have started. Executions are numbered in start order. */
    const awaitStarted = (count: number) =>
      Effect.suspend(() => Deferred.await(startOf(count - 1)));
    const release = (index: number) =>
      Effect.suspend(() => {
        const gate = gates.get(index);
        if (gate === undefined)
          return Effect.die(`execution ${index} not started`);
        return Deferred.succeed(gate, undefined);
      });
    return { execute, calls, interrupted, finalized, awaitStarted, release };
  });

const isInterrupted = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);

describe("Interaction.run", () => {
  it.effect("executes and returns the value", () =>
    Effect.gen(function* () {
      const interaction = yield* Interaction.make((input: string) =>
        Effect.succeed(input.toUpperCase()),
      );
      expect(yield* interaction.run("a")).toBe("A");
    }),
  );

  it.effect("joins active work for equal input", () =>
    Effect.gen(function* () {
      const work = yield* controlled<string>();
      // Without retention, only joining can return the first execution's value to both callers.
      const interaction = yield* Interaction.make(work.execute, {
        retain: () => false,
      });
      const first = yield* Effect.forkChild(interaction.run("a"));
      yield* work.awaitStarted(1);
      const second = yield* Effect.forkChild(interaction.run("a"), {
        startImmediately: true,
      });
      yield* work.release(0);
      expect(yield* Fiber.join(first)).toBe("a#0");
      expect(yield* Fiber.join(second)).toBe("a#0");
      expect(work.calls).toEqual(["a"]);
    }),
  );

  it.effect("reuses the retained success for equal input", () =>
    Effect.gen(function* () {
      let calls = 0;
      const interaction = yield* Interaction.make((input: string) =>
        Effect.sync(() => `${input}#${calls++}`),
      );
      expect(yield* interaction.run("a")).toBe("a#0");
      expect(yield* interaction.run("a")).toBe("a#0");
      expect(calls).toBe(1);
    }),
  );

  it.effect("compares plain objects and arrays structurally by default", () =>
    Effect.gen(function* () {
      let calls = 0;
      const interaction = yield* Interaction.make(() =>
        Effect.sync(() => calls++),
      );
      yield* interaction.run({ q: "x", tags: ["a"] });
      yield* interaction.run({ q: "x", tags: ["a"] });
      yield* interaction.run({ q: "x", tags: ["b"] });
      expect(calls).toBe(2);
    }),
  );

  it.effect("uses a custom equivalence", () =>
    Effect.gen(function* () {
      let calls = 0;
      const interaction = yield* Interaction.make(
        (input: string) => Effect.sync(() => `${input}#${calls++}`),
        { equivalence: (a, b) => a.toLowerCase() === b.toLowerCase() },
      );
      expect(yield* interaction.run("Ada")).toBe("Ada#0");
      expect(yield* interaction.run("ADA")).toBe("Ada#0");
      expect(calls).toBe(1);
    }),
  );

  it.effect(
    "supersedes active work for different input and interrupts it",
    () =>
      Effect.gen(function* () {
        const work = yield* controlled<string>();
        const interaction = yield* Interaction.make(work.execute);
        const first = yield* Effect.forkChild(interaction.run("a"));
        yield* work.awaitStarted(1);
        const second = yield* Effect.forkChild(interaction.run("b"));
        yield* work.awaitStarted(2);
        const firstExit = yield* Fiber.await(first);
        expect(isInterrupted(firstExit)).toBe(true);
        expect(work.interrupted).toEqual(["a"]);
        expect(work.finalized).toEqual(["a"]);
        yield* work.release(1);
        expect(yield* Fiber.join(second)).toBe("b#1");
      }),
  );

  it.effect("supersedes with empty input through the same gate", () =>
    Effect.gen(function* () {
      const work = yield* controlled<string>();
      const interaction = yield* Interaction.make(work.execute);
      const search = yield* Effect.forkChild(interaction.run("query"));
      yield* work.awaitStarted(1);
      const cleared = yield* Effect.forkChild(interaction.run(""));
      yield* work.awaitStarted(2);
      expect(isInterrupted(yield* Fiber.await(search))).toBe(true);
      yield* work.release(1);
      expect(yield* Fiber.join(cleared)).toBe("#1");
    }),
  );

  it.effect("force re-executes equal input, superseding active work", () =>
    Effect.gen(function* () {
      const work = yield* controlled<string>();
      const interaction = yield* Interaction.make(work.execute);
      const first = yield* Effect.forkChild(interaction.run("a"));
      yield* work.awaitStarted(1);
      const forced = yield* Effect.forkChild(
        interaction.run("a", { force: true }),
      );
      yield* work.awaitStarted(2);
      expect(isInterrupted(yield* Fiber.await(first))).toBe(true);
      yield* work.release(1);
      expect(yield* Fiber.join(forced)).toBe("a#1");
    }),
  );

  it.effect("force bypasses and replaces the retained success", () =>
    Effect.gen(function* () {
      let calls = 0;
      const interaction = yield* Interaction.make((input: string) =>
        Effect.sync(() => `${input}#${calls++}`),
      );
      expect(yield* interaction.run("a")).toBe("a#0");
      expect(yield* interaction.run("a", { force: true })).toBe("a#1");
      expect(yield* interaction.run("a")).toBe("a#1");
    }),
  );

  it.effect(
    "keeps the retained success of other input while new input runs",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const interaction = yield* Interaction.make((input: string) =>
          Effect.sync(() => `${input}#${calls++}`),
        );
        yield* interaction.run("a");
        yield* interaction.run("b");
        expect(yield* interaction.run("b")).toBe("b#1");
        expect(yield* interaction.run("a")).toBe("a#2");
      }),
  );

  it.effect("does not retain failures", () =>
    Effect.gen(function* () {
      let calls = 0;
      const interaction = yield* Interaction.make(() =>
        Effect.suspend(() =>
          calls++ === 0
            ? Effect.fail("offline" as const)
            : Effect.succeed("ok"),
        ),
      );
      expect(yield* Effect.flip(interaction.run("a"))).toBe("offline");
      expect(yield* interaction.run("a")).toBe("ok");
      expect(calls).toBe(2);
    }),
  );

  it.effect("returns but does not retain a success the predicate rejects", () =>
    Effect.gen(function* () {
      let calls = 0;
      const interaction = yield* Interaction.make(
        (input: string) => Effect.sync(() => ({ input, n: calls++ })),
        { retain: (value) => value.n !== 1 },
      );
      expect((yield* interaction.run("a")).n).toBe(0);
      expect((yield* interaction.run("a")).n).toBe(0);
      expect((yield* interaction.run("a", { force: true })).n).toBe(1);
      expect((yield* interaction.run("a")).n).toBe(2);
      expect(calls).toBe(3);
    }),
  );

  it.effect(
    "keeps another input's retained success when a result is not retained",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const interaction = yield* Interaction.make(
          (input: string) => Effect.sync(() => `${input}#${calls++}`),
          { retain: (_value, input) => input !== "volatile" },
        );
        expect(yield* interaction.run("a")).toBe("a#0");
        expect(yield* interaction.run("volatile")).toBe("volatile#1");
        expect(yield* interaction.run("a")).toBe("a#0");
        expect(yield* interaction.run("volatile")).toBe("volatile#2");
      }),
  );

  it.effect("passes the value and input to the retention predicate", () =>
    Effect.gen(function* () {
      const seen: Array<readonly [number, string]> = [];
      const interaction = yield* Interaction.make(
        (input: string) => Effect.succeed(input.length),
        {
          retain: (value, input) => {
            seen.push([value, input]);
            return true;
          },
        },
      );
      yield* interaction.run("abc");
      expect(seen).toEqual([[3, "abc"]]);
    }),
  );

  it.effect(
    "releases waiters and clears active work when the retention predicate throws",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const interaction = yield* Interaction.make(
          () => Effect.sync(() => calls++),
          {
            retain: (value) => {
              if (value === 0) throw new Error("predicate bug");
              return true;
            },
          },
        );
        const exit = yield* Effect.exit(interaction.run("a"));
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(yield* interaction.run("a")).toBe(1);
        expect(yield* interaction.run("a")).toBe(1);
      }),
  );

  it.effect("keeps shared work running when one waiter is interrupted", () =>
    Effect.gen(function* () {
      const work = yield* controlled<string>();
      const interaction = yield* Interaction.make(work.execute);
      const first = yield* Effect.forkChild(interaction.run("a"));
      yield* work.awaitStarted(1);
      const second = yield* Effect.forkChild(interaction.run("a"), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(first);
      expect(work.interrupted).toEqual([]);
      yield* work.release(0);
      expect(yield* Fiber.join(second)).toBe("a#0");
    }),
  );

  it.effect(
    "keeps work running after its only waiter is interrupted and retains the result",
    () =>
      Effect.gen(function* () {
        const work = yield* controlled<string>();
        const interaction = yield* Interaction.make(work.execute);
        const waiter = yield* Effect.forkChild(interaction.run("a"));
        yield* work.awaitStarted(1);
        yield* Fiber.interrupt(waiter);
        yield* work.release(0);
        expect(yield* interaction.run("a")).toBe("a#0");
        expect(work.calls).toEqual(["a"]);
        expect(work.interrupted).toEqual([]);
      }),
  );

  it.effect(
    "runs each execution in its own scope, closed when it completes",
    () =>
      Effect.gen(function* () {
        const work = yield* controlled<string>();
        const interaction = yield* Interaction.make(work.execute);
        const run = yield* Effect.forkChild(interaction.run("a"));
        yield* work.awaitStarted(1);
        expect(work.finalized).toEqual([]);
        yield* work.release(0);
        yield* Fiber.join(run);
        expect(work.finalized).toEqual(["a"]);
      }),
  );

  it.effect("captures services at acquisition", () =>
    Effect.gen(function* () {
      class Greeting extends Context.Service<Greeting, string>()("Greeting") {}
      const interaction = yield* Interaction.make((name: string) =>
        Effect.map(Greeting, (greeting) => `${greeting}, ${name}`),
      ).pipe(Effect.provideService(Greeting, "Hello"));
      expect(
        yield* interaction
          .run("Ada")
          .pipe(Effect.provideService(Greeting, "Bye")),
      ).toBe("Hello, Ada");
    }),
  );

  it.effect("aborts a superseded HTTP operation under injected latency", () =>
    Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>();
      const server = synthetic((exchange) =>
        exchange.url.endsWith("q=slow")
          ? Deferred.succeed(arrived, undefined).pipe(
              Effect.andThen(Effect.sleep("10 seconds")),
              Effect.as(json(200, ["slow"])),
            )
          : json(200, ["fast"]),
      );
      const search = Operation.make(
        Request.get("https://api.test/search").pipe(
          Request.query(Schema.Struct({ q: Schema.String })),
          Request.mapInput((q: string) => ({ query: { q } })),
        ),
        Response.status(200, Body.json),
      );
      const interaction = yield* Interaction.make(search.execute).pipe(
        Effect.provide(server.layer),
      );
      const slow = yield* Effect.forkChild(interaction.run("slow"));
      yield* Deferred.await(arrived);
      expect(yield* interaction.run("fast")).toEqual(["fast"]);
      expect(isInterrupted(yield* Fiber.await(slow))).toBe(true);
      expect(server.exchanges[0]?.signal.aborted).toBe(true);
      yield* TestClock.adjust("10 seconds");
      expect(server.exchanges).toHaveLength(2);
    }),
  );
});

describe("Interaction.close", () => {
  it.effect("refuses further work", () =>
    Effect.gen(function* () {
      const interaction = yield* Interaction.make((input: string) =>
        Effect.succeed(input),
      );
      yield* interaction.run("a");
      yield* interaction.close;
      const error = yield* Effect.flip(interaction.run("a"));
      expect(error).toBeInstanceOf(Interaction.Closed);
      expect(error._tag).toBe("InteractionClosed");
    }),
  );

  it.effect("interrupts active work and waits for its finalizers", () =>
    Effect.gen(function* () {
      const work = yield* controlled<string>();
      const interaction = yield* Interaction.make(work.execute);
      const run = yield* Effect.forkChild(interaction.run("a"));
      yield* work.awaitStarted(1);
      yield* interaction.close;
      expect(work.interrupted).toEqual(["a"]);
      expect(work.finalized).toEqual(["a"]);
      expect(isInterrupted(yield* Fiber.await(run))).toBe(true);
    }),
  );

  it.effect(
    "makes every caller wait for slow finalizers, including superseded work",
    () =>
      Effect.gen(function* () {
        const finished: Array<string> = [];
        const gate = yield* Deferred.make<void>();
        const started = {
          a: yield* Deferred.make<void>(),
          b: yield* Deferred.make<void>(),
        };
        const execute = (input: "a" | "b") =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Deferred.await(gate).pipe(
                Effect.andThen(Effect.sync(() => finished.push(input))),
              ),
            );
            yield* Deferred.succeed(started[input], undefined);
            return yield* Effect.never;
          });
        const interaction = yield* Interaction.make(execute);
        yield* Effect.forkChild(interaction.run("a"));
        yield* Deferred.await(started.a);
        yield* Effect.forkChild(interaction.run("b"));
        yield* Deferred.await(started.b);
        const closer = Effect.fnUntraced(function* () {
          const entered = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(interaction.close),
            ),
          );
          yield* Deferred.await(entered);
          return fiber;
        });
        const first = yield* closer();
        const second = yield* closer();
        // Proving that both callers wait needs them to have had every chance to return early.
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        expect(first.pollUnsafe()).toBeUndefined();
        expect(second.pollUnsafe()).toBeUndefined();
        expect(finished).toEqual([]);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(finished.toSorted()).toEqual(["a", "b"]);
        // A caller arriving after closing has completed returns at once.
        yield* interaction.close;
      }),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      const interaction = yield* Interaction.make((input: string) =>
        Effect.succeed(input),
      );
      yield* interaction.close;
      yield* interaction.close;
      expect(yield* Effect.flip(interaction.run("a"))).toBeInstanceOf(
        Interaction.Closed,
      );
    }),
  );

  it.effect("runs when the acquiring scope closes", () =>
    Effect.gen(function* () {
      const work = yield* controlled<string>();
      const scope = yield* Scope.make();
      const interaction = yield* Interaction.make(work.execute).pipe(
        Scope.provide(scope),
      );
      yield* Effect.forkChild(interaction.run("a"));
      yield* work.awaitStarted(1);
      yield* Scope.close(scope, Exit.void);
      expect(work.finalized).toEqual(["a"]);
      expect(yield* Effect.flip(interaction.run("a"))).toBeInstanceOf(
        Interaction.Closed,
      );
    }),
  );
});

describe("Interaction with an HTTP operation", () => {
  it.effect("shares one request between equal runs", () =>
    Effect.gen(function* () {
      const server = synthetic(() => empty(204));
      const ping = Operation.make(
        Request.get("https://api.test/ping"),
        Response.status(204, Body.empty),
      );
      const interaction = yield* Interaction.make(ping.execute).pipe(
        Effect.provide(server.layer),
      );
      yield* Effect.all(
        [interaction.run(undefined), interaction.run(undefined)],
        {
          concurrency: "unbounded",
        },
      );
      yield* interaction.run(undefined);
      expect(server.exchanges).toHaveLength(1);
    }),
  );
});
