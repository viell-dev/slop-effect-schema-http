import {
  Context,
  Data,
  Deferred,
  Effect,
  Equal,
  type Equivalence,
  Exit,
  type Fiber,
  Scope,
  Semaphore,
} from "effect";

/**
 * A call tried to start work after the interaction had permanently closed.
 *
 * @remarks
 * The error's `_tag` is `"InteractionClosed"`.
 */
export class Closed extends Data.TaggedError("InteractionClosed") {}

/**
 * Options for one call to an interaction.
 */
export interface RunOptions {
  /** Start fresh work, superseding active work and bypassing the retained result. */
  readonly force?: boolean | undefined;
}

/**
 * Coordinate one active execution and one retained successful result.
 *
 * @remarks
 * Use for one user-facing activity, such as a search field. Equal input shares work or reuses a
 * success; different input supersedes active work. This is not a cache of all previous inputs.
 */
export interface Interaction<in I, out A, out E = never> {
  /** Equal input joins active work or reuses the retained success; different input supersedes active work. */
  readonly run: (
    input: I,
    options?: RunOptions,
  ) => Effect.Effect<A, E | Closed>;
  /** Permanent and idempotent. Every caller waits for all owned finalizers, including superseded work. */
  readonly close: Effect.Effect<void>;
}

/**
 * Choose how inputs compare and which successful results are retained.
 */
export interface Options<I, A> {
  /** Defaults to `Equal.equals`, which compares plain objects and arrays structurally. */
  readonly equivalence?: Equivalence.Equivalence<I> | undefined;
  /** Whether to retain a success. Defaults to retaining; the result is returned either way. */
  readonly retain?: ((value: A, input: I) => boolean) | undefined;
}

interface Flight<I, A, E> {
  readonly input: I;
  readonly result: Deferred.Deferred<A, E>;
  readonly fiber: Fiber.Fiber<void>;
}

/**
 * Acquire a scoped interaction around an Effect-returning function.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { Interaction } from "viell-effect-schema-http";
 * const program = Effect.scoped(Effect.gen(function* () {
 *   const lookup = yield* Interaction.make((id: number) => Effect.succeed({ id }));
 *   const first = yield* lookup.run(42);
 *   const reused = yield* lookup.run(42);
 *   return [first, reused];
 * }));
 * ```
 *
 * @remarks
 * Keep the acquiring scope alive while calls should be accepted. Required services are captured
 * at acquisition. Each execution belongs to the interaction in its own child scope; cancelling
 * one waiter does not cancel shared work. Closing the acquiring scope closes the interaction
 * and waits for all owned cleanup.
 */
export const make = Effect.fnUntraced(function* <I, A, E, R>(
  execute: (input: I) => Effect.Effect<A, E, R>,
  options?: Options<I, A>,
): Effect.fn.Return<Interaction<I, A, E>, never, R | Scope.Scope> {
  const context = yield* Effect.context<R>();
  const owned = yield* Scope.make("parallel");
  const lock = yield* Semaphore.make(1);
  const closing = yield* Deferred.make<void>();
  const equivalent = options?.equivalence ?? Equal.equals;
  let closed = false;
  let flight: Flight<I, A, E> | undefined;
  let retained: { readonly input: I; readonly value: A } | undefined;

  const close = Effect.uninterruptible(
    Effect.gen(function* () {
      const first = yield* lock.withPermit(
        Effect.sync(() => {
          if (closed) return false;
          closed = true;
          flight = undefined;
          retained = undefined;
          return true;
        }),
      );
      if (first)
        yield* Deferred.done(
          closing,
          yield* Effect.exit(Scope.close(owned, Exit.void)),
        );
      yield* Deferred.await(closing);
    }),
  );
  yield* Effect.addFinalizer(() => close);

  // State transitions hold the lock briefly; it is never held while waiting for work or finalizers.
  const publish = (
    input: I,
    shared: Deferred.Deferred<A, E>,
    exit: Exit.Exit<A, E>,
  ) =>
    lock.withPermit(
      Effect.sync(() => {
        if (flight?.result !== shared) return;
        try {
          if (Exit.isSuccess(exit)) {
            if (options?.retain?.(exit.value, input) ?? true)
              retained = { input, value: exit.value };
            else if (
              retained !== undefined &&
              equivalent(retained.input, input)
            )
              retained = undefined;
          }
        } finally {
          flight = undefined;
        }
      }),
    );

  // Forked uninterruptibly so that publication always happens, even when superseded before starting.
  const worker = Effect.fnUntraced(function* (
    input: I,
    shared: Deferred.Deferred<A, E>,
  ) {
    const exit = yield* Effect.exit(
      Effect.interruptible(
        Effect.scopedWith((scope) =>
          Effect.suspend(() => execute(input)).pipe(
            Effect.provideContext(Context.add(context, Scope.Scope, scope)),
          ),
        ),
      ),
    );
    // A retention predicate defect still releases every waiter and clears the active flight.
    const publication = yield* Effect.exit(publish(input, shared, exit));
    yield* Deferred.done(
      shared,
      Exit.isFailure(publication) ? Exit.failCause(publication.cause) : exit,
    );
  });

  const admit = Effect.fnUntraced(function* (input: I, force: boolean) {
    if (closed) return yield* new Closed();
    if (!force && flight !== undefined && equivalent(flight.input, input))
      return Deferred.await(flight.result);
    if (flight !== undefined) {
      flight.fiber.interruptUnsafe();
      flight = undefined;
    }
    if (!force && retained !== undefined && equivalent(retained.input, input))
      return Effect.succeed(retained.value);
    const shared = yield* Deferred.make<A, E>();
    const fiber = yield* Effect.forkIn(worker(input, shared), owned, {
      uninterruptible: true,
    });
    flight = { input, result: shared, fiber };
    return Deferred.await(shared);
  });

  const run = (input: I, settings?: RunOptions): Effect.Effect<A, E | Closed> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        lock.withPermit(admit(input, settings?.force === true)),
        (result) => restore(result),
      ),
    );

  return { run, close };
});
