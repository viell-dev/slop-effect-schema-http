import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Function,
  Option,
  Pipeable,
  Pull,
  Schedule,
  type Scope,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import * as Transport from "./Transport.js";

/**
 * An executable contract with typed input, output, failures and required services.
 *
 * @remarks
 * `execute(input)` returns a cold Effect: work starts when it is evaluated, and each evaluation
 * runs again. `Operation.make` supplies HTTP execution; `fromEffect` adapts an existing function.
 * With `make`, the request bindings determine `I`. Extract an operation's input type with
 * `Parameters<typeof operation.execute>[0]`.
 *
 * `make` also keeps what it was built from in `parts`, which `P` describes, so {@link mapRequest},
 * {@link mapResponse} and {@link mapOptions} can derive a variant. Annotating a value as
 * `Operation<I, A, E, R>` leaves `P` unknown, which stops those functions compiling on it.
 */
export interface Operation<
  in I,
  out A,
  out E = never,
  out R = never,
  out P = unknown,
>
  extends Pipeable.Pipeable {
  readonly execute: (input: I) => Effect.Effect<A, E, R>;
  /** What the operation was built from. A value from {@link fromEffect} has no parts. */
  readonly parts?: P;
}

/**
 * Adapt an Effect-returning function to the operation interface.
 *
 * @example
 * ```ts
 * import { Body, Operation, Request, Response } from "viell-effect-schema-http";
 * const health = Operation.make(
 *   Request.get("https://api.example.test/health"),
 *   Response.status(200, Body.text),
 * );
 * // Callers can run this and map its result, and cannot adjust what it sends.
 * const sealed = Operation.fromEffect(health.execute);
 * ```
 *
 * @remarks
 * The function is suspended until evaluation. This adapter adds no HTTP dispatch, decoding,
 * retry policy or scope management beyond what the supplied function already does.
 *
 * The result has no parts, at compile time or at run time. So
 * `Operation.fromEffect(operation.execute)` seals a definition: it keeps the same types and offers
 * no adjustment.
 */
export const fromEffect = <I, A, E, R>(
  execute: (input: I) => Effect.Effect<A, E, R>,
): Operation<I, A, E, R> => ({
  ...Pipeable.Prototype,
  execute: (input) => Effect.suspend(() => execute(input)),
});

/**
 * Optional retry policy and per-attempt HTTP client transformation.
 */
export interface Options<
  E = HttpClientError.HttpClientError,
  R = never,
  EP = never,
  RP = never,
> {
  /** Retry selection, budget and attempt timeout. Defaults to `Policy.none`. */
  readonly policy?: Policy.Policy<EP, RP> | undefined;
  /**
   * Customize the HTTP client separately for each attempt.
   *
   * @remarks
   * Applied after request preparation, suitable for fresh credentials or URL-dependent signatures.
   * Run a signer after other request edits it must cover. Native status filters can reject responses
   * before the declared response contract sees them.
   * Appending native URL parameters can reserialize the entire query as form data, changing bare keys and
   * escapes. Prefer Request query combinators, or preserve the query text when editing the URL directly.
   */
  readonly transformClient?:
    | ((client: HttpClient.HttpClient) => HttpClient.HttpClient.With<E, R>)
    | undefined;
}

/** Outcome categories only: errors can contain credentials, response text or schema input. */
const outcome = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit)
    ? "success"
    : Cause.hasInterrupts(exit.cause)
      ? "interrupted"
      : Cause.hasDies(exit.cause)
        ? "defect"
        : "failure";

/**
 * Combine a request and response contract into an executable HTTP operation.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { FetchHttpClient } from "effect/http";
 * import { Body, Operation, Request, Response } from "viell-effect-schema-http";
 * const health = Operation.make(
 *   Request.get("https://api.example.test/health"),
 *   Response.status(200, Body.text),
 * );
 * const program = health.execute(undefined).pipe(Effect.provide(FetchHttpClient.layer));
 * // Evaluate program only after choosing your real service URL.
 * ```
 *
 * @remarks
 * Defaults to one attempt with no library-imposed timeout. The caller supplies Effect's
 * `HttpClient` service and evaluates `execute(input)`.
 *
 * Each evaluation prepares input once. Each attempt then owns a scope covering client execution
 * and body decoding; cleanup completes before classification or a retry delay. Decoder and
 * client `Scope` requirements are supplied by the attempt. Interruption and defects never retry.
 * An automatic `Accept` header is added only when the request declares none and has not removed
 * it with `Request.removeHeader`.
 *
 * The result keeps its parts, so a definition written once can be adjusted where it is used with
 * {@link mapRequest}, {@link mapResponse} and {@link mapOptions}. The original never changes.
 */
export const make = <
  I,
  E,
  R,
  A,
  E2,
  R2,
  E3 = HttpClientError.HttpClientError,
  R3 = never,
  EP = never,
  RP = never,
  C extends Response.AnyCase = Response.AnyCase,
>(
  request: Request.Request<I, E, R>,
  response: Response.Response<A, E2, R2, C>,
  options?: Options<E3, R3, EP, RP>,
): Http<
  Request.Request<I, E, R>,
  Response.Response<A, E2, R2, C>,
  Options<E3, R3, EP, RP>
> => {
  const policy: Policy.Policy<EP, RP> = options?.policy ?? Policy.none;
  const accept = response.accepts.join(", ");
  const execute = Effect.fnUntraced(
    function* (input: I) {
      const compiled = yield* Request.compile(request, input);
      const prepared =
        accept !== "" &&
        compiled.request.headers.accept === undefined &&
        !compiled.removedHeaders.has("accept")
          ? HttpClientRequest.setHeader(compiled.request, "accept", accept)
          : compiled.request;
      const client = yield* HttpClient.HttpClient;
      const step = yield* Schedule.toStep(policy.schedule);
      const method = prepared.method;
      let attempt = 0;
      while (true) {
        attempt++;
        yield* Effect.logDebug("HTTP attempt started").pipe(
          Effect.annotateLogs({
            "http.method": method,
            "http.attempt": attempt,
          }),
        );
        let metadata: Response.Metadata | undefined;
        const execution = Effect.scoped(
          Effect.gen(function* () {
            const send: (
              request: HttpClientRequest.HttpClientRequest,
            ) => Effect.Effect<
              HttpClientResponse.HttpClientResponse,
              E3 | HttpClientError.HttpClientError,
              R3 | Scope.Scope
            > =
              options?.transformClient === undefined
                ? HttpClient.withScope(client).execute
                : HttpClient.withScope(options.transformClient(client)).execute;
            // A fresh request identity keeps the scoped abort controller of this attempt separate.
            const received = yield* send(
              HttpClientRequest.setHeaders(prepared, {}),
            ).pipe(
              Effect.provideService(
                Transport.HeaderLines,
                compiled.headerLines,
              ),
              // Client middleware can reject a response, such as filterStatusOk; its metadata still classifies the attempt.
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (
                    HttpClientError.isHttpClientError(error) &&
                    error.response !== undefined
                  )
                    metadata = Response.metadata(error.response);
                }),
              ),
            );
            metadata = Response.metadata(received);
            return yield* Response.decode(response, received);
          }),
        );
        const exit = yield* Effect.exit(
          policy.attemptTimeout === undefined
            ? execution
            : Effect.timeout(execution, policy.attemptTimeout),
        );
        yield* Effect.logDebug("HTTP attempt completed").pipe(
          Effect.annotateLogs({
            "http.method": method,
            "http.attempt": attempt,
            "http.outcome": outcome(exit),
            ...(metadata === undefined
              ? {}
              : { "http.status": metadata.status }),
          }),
        );
        if (
          Exit.isFailure(exit) &&
          (Cause.hasInterrupts(exit.cause) || Cause.hasDies(exit.cause))
        )
          return yield* exit;
        const reason: Policy.Reason = Exit.isFailure(exit)
          ? { _tag: "Failure", cause: exit.cause, metadata }
          : { _tag: "Response", metadata: metadata! };
        if (!policy.while(reason)) return yield* exit;
        const now = yield* Clock.currentTimeMillis;
        const delay = yield* Pull.matchEffect(step(now, reason), {
          onSuccess: ([, scheduled]) => Effect.succeed(Option.some(scheduled)),
          onFailure: Effect.failCause,
          onDone: () => Effect.succeed(Option.none<Duration.Duration>()),
        });
        if (Option.isNone(delay)) {
          yield* Effect.logDebug("HTTP retry budget exhausted").pipe(
            Effect.annotateLogs({ "http.attempt": attempt }),
          );
          return yield* exit;
        }
        yield* Effect.sleep(
          policy.retryAfter && reason.metadata !== undefined
            ? Duration.max(
                delay.value,
                Policy.retryAfterDelay(reason.metadata, now),
              )
            : delay.value,
        );
        yield* Effect.logDebug("HTTP retrying").pipe(
          Effect.annotateLogs({ "http.attempt": attempt + 1 }),
        );
      }
    },
    Effect.onExit((exit) =>
      Effect.logDebug("HTTP operation completed").pipe(
        Effect.annotateLogs({ "http.outcome": outcome(exit) }),
      ),
    ),
    Effect.withLogSpan("schema-http.operation"),
  );
  return {
    ...Pipeable.Prototype,
    execute,
    parts: { request, response, options, step: undefined },
  };
};

/**
 * Return the Effect for an operation's input, in direct or pipeable form.
 *
 * @remarks
 * Equivalent to `operation.execute(input)`. It does not itself evaluate the Effect.
 */
export const execute: {
  <I>(
    input: I,
  ): <A, E, R>(self: Operation<I, A, E, R>) => Effect.Effect<A, E, R>;
  <I, A, E, R>(self: Operation<I, A, E, R>, input: I): Effect.Effect<A, E, R>;
} = Function.dual(
  2,
  <I, A, E, R>(self: Operation<I, A, E, R>, input: I): Effect.Effect<A, E, R> =>
    self.execute(input),
);

/**
 * The conversion {@link map} and {@link mapEffect} recorded, run once after the parts.
 *
 * @remarks
 * Only its failures and services are in the type. Its result is the operation's own `A`, and what
 * it was written for is what the response still produces, so neither is repeated here.
 */
export interface Step<out E = never, out R = never> {
  readonly run: (value: never) => Effect.Effect<unknown, E, R>;
}

/**
 * What {@link make} keeps: the three parts as given, and any recorded {@link Step}.
 *
 * @remarks
 * Read a part with `operation.parts?.request`. Each whole part is one type parameter, which keeps
 * the parameter count down as `Schema.decodeTo` does.
 *
 * `S` is invariant: widening it by annotation could otherwise make any response look as if it fits
 * a recorded step.
 */
export interface Parts<out Q, in out S, out O, out T = undefined> {
  readonly request: Q;
  readonly response: S;
  readonly options: O | undefined;
  readonly step: T;
}

type InputOf<Q> =
  Q extends Request.Request<infer I, unknown, unknown> ? I : never;
type RequestFailure<Q> =
  Q extends Request.Request<never, infer E, unknown> ? E : never;
type RequestServices<Q> =
  Q extends Request.Request<never, unknown, infer R> ? R : never;
// The cases are inferred too, or the check would not resolve while `C` is still generic.
type ValueOf<S> =
  S extends Response.Response<infer A, unknown, unknown, infer _C> ? A : never;
type ResponseFailure<S> =
  S extends Response.Response<unknown, infer E, unknown, infer _C> ? E : never;
type ResponseServices<S> =
  S extends Response.Response<unknown, unknown, infer R, infer _C> ? R : never;
// Every slot is inferred: `Options` is invariant, and a fixed slot silently gives `never`.
type ClientFailure<O> =
  O extends Options<infer E, infer _R, infer _EP, infer _RP> ? E : never;
type ClientServices<O> =
  O extends Options<infer _E, infer R, infer _EP, infer _RP> ? R : never;
type PolicyFailure<O> =
  O extends Options<infer _E, infer _R, infer E, infer _RP> ? E : never;
type PolicyServices<O> =
  O extends Options<infer _E, infer _R, infer _EP, infer R> ? R : never;
type StepFailure<T> = T extends Step<infer E, unknown> ? E : never;
type StepServices<T> = T extends Step<unknown, infer R> ? R : never;

/** An operation fresh from {@link make}: three parts, no step, and the response's own result. */
export type Http<Q, S, O> = Derived<ValueOf<S>, Q, S, O>;

/**
 * An operation built from parts, returning `B`.
 *
 * @remarks
 * `B` comes first so that an editor hover shows the result before the parts. The unions stay
 * inline: a named alias would print with all of `Q`, `S` and `O` repeated inside it.
 */
export type Derived<B, Q, S, O, T = undefined> = Operation<
  InputOf<Q>,
  B,
  | RequestFailure<Q>
  | ClientFailure<O>
  | PolicyFailure<O>
  | StepFailure<T>
  | Request.InvalidRequest
  | HttpClientError.HttpClientError
  | Response.UnexpectedResponse
  | Response.DecodeError<ResponseFailure<S> | HttpClientError.HttpClientError>
  | Cause.TimeoutError,
  | RequestServices<Q>
  | PolicyServices<O>
  | StepServices<T>
  | Exclude<ResponseServices<S> | ClientServices<O>, Scope.Scope>
  | HttpClient.HttpClient,
  Parts<Q, S, O, T>
>;

/**
 * Any operation carrying the parts `P` and returning `B`.
 *
 * @remarks
 * What {@link mapRequest}, {@link mapResponse}, {@link mapOptions} and {@link unmap} accept. The
 * input, failures and services are left open because a variant works them out again from `P`.
 */
export type Adjustable<B, P> = Operation<never, B, unknown, unknown, P>;

type Runner = (value: unknown) => Effect.Effect<unknown, unknown, unknown>;

/** Parts with their types erased, for the helpers below. Each caller's signature states them. */
type ErasedParts = Parts<
  Request.Request<never, unknown, unknown>,
  Response.Response<unknown, unknown, unknown>,
  Options<unknown, unknown, unknown, unknown>,
  { readonly run: Runner } | undefined
>;

/** The types refuse an operation with no parts; a cast or plain JavaScript gets a clear failure. */
const partsOf = <P>(self: Adjustable<unknown, P>): P => {
  if (self.parts === undefined)
    throw new Error(
      "This operation has no parts to adjust: it came from Operation.fromEffect",
    );
  return self.parts;
};

/** Rebuild through {@link make}, so the automatic `Accept` follows the response. */
const rebuild = <Q, S, O, T, Result>(parts: Parts<Q, S, O, T>): Result => {
  const { request, response, options, step } = parts as unknown as ErasedParts;
  const built = make(request, response, options);
  const result: unknown =
    step === undefined
      ? built
      : {
          ...built,
          execute: (input: never) =>
            Effect.flatMap(built.execute(input), step.run),
          parts: { request, response, options, step },
        };
  return result as Result;
};

/**
 * Derive a variant with a changed request. A recorded result step stays.
 *
 * @example
 * ```ts
 * import { Body, Operation, Request, Response } from "viell-effect-schema-http";
 * const getThings = Operation.make(
 *   Request.get("https://api.example.test/things?limit=25"),
 *   Response.status(200, Body.json),
 * );
 * const firstFive = Request.setQuery("limit", "5");
 * const fewerThings = getThings.pipe(Operation.mapRequest(firstFive));
 * // getThings still asks for 25.
 * ```
 *
 * @remarks
 * The function receives the current request, so every `Request` function works here, including a
 * binding that changes the operation's input. The automatic `Accept` and the options carry over.
 * The library cannot tell whether a change alters the shape of the answer: selecting fields or
 * embedding relations usually does, and then needs {@link mapResponse} too.
 *
 * Works on any operation from {@link make}, mapped or not. A value from {@link fromEffect} has no
 * parts, and one annotated as a plain `Operation<I, A, E, R>` hides them: both are compile errors.
 */
export const mapRequest =
  <I, E, R, I2, E2, R2>(
    f: (request: Request.Request<I, E, R>) => Request.Request<I2, E2, R2>,
  ) =>
  <B, S, O, T>(
    self: Adjustable<B, Parts<Request.Request<I, E, R>, S, O, T>>,
  ): Derived<B, Request.Request<I2, E2, R2>, S, O, T> => {
    const parts = partsOf(self);
    return rebuild({ ...parts, request: f(parts.request) });
  };

interface NoLongerFits<A> {
  readonly "Use Operation.unmap first, then map again: this response no longer fits the mapping.": A;
}

/**
 * The rule {@link mapResponse} applies to a new result `A2`, given the current result `A`.
 *
 * @remarks
 * With no step, `T` is `undefined` and anything fits. With a step, `A2` must be something the
 * current response could produce. An `any` result proves nothing, so it does not fit either.
 */
export type Fits<A2, A, T> = [T] extends [undefined]
  ? unknown
  : 0 extends 1 & A2
    ? NoLongerFits<A2>
    : [A2] extends [A]
      ? unknown
      : NoLongerFits<A2>;

/**
 * Derive a variant with a changed response. A recorded result step stays, and has to fit.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Body, Operation, Request, Response } from "viell-effect-schema-http";
 * const Thing = Schema.Struct({ id: Schema.Number, name: Schema.String });
 * const ThingOption = Schema.Struct({ id: Schema.Number });
 * const getThing = Operation.make(
 *   Request.get("https://api.example.test/things/1"),
 *   Response.status(200, Body.jsonSchema(Thing)),
 * );
 * const asOption = Response.replace(200, Body.jsonSchema(ThingOption));
 * const thingOption = getThing.pipe(Operation.mapResponse(asOption));
 * ```
 *
 * @remarks
 * The function receives the current response, so {@link Response.replace},
 * {@link Response.remove} and {@link Response.orElse} all work here. The automatic `Accept` follows
 * the new response.
 *
 * On a mapped operation the new result must fit: it has to be assignable to the current response's
 * result, and not `any`, because the recorded step was written for that result. So a same-shape
 * replace or a removal works, and anything else is a compile error that names {@link unmap}.
 * A narrowed result is the new baseline, so widening it back needs {@link unmap} as well.
 * This is a compile-time rule: a cast gets past it, and the step then receives the wrong shape.
 */
export const mapResponse =
  <
    A,
    E,
    R,
    C extends Response.AnyCase,
    A2,
    E2,
    R2,
    C2 extends Response.AnyCase,
  >(
    f: (
      response: Response.Response<A, E, R, C>,
    ) => Response.Response<A2, E2, R2, C2>,
  ) =>
  <B, Q, O, T>(
    self: Adjustable<B, Parts<Q, Response.Response<A, E, R, C>, O, T>> &
      Fits<A2, A, T>,
  ): Derived<
    [T] extends [undefined] ? A2 : B,
    Q,
    Response.Response<A2, E2, R2, C2>,
    O,
    T
  > => {
    const parts = partsOf(self);
    return rebuild({ ...parts, response: f(parts.response) });
  };

/**
 * Derive a variant with changed options. A recorded result step stays.
 *
 * @example
 * ```ts
 * import { Schedule } from "effect";
 * import {
 *   Body,
 *   Operation,
 *   Policy,
 *   Request,
 *   Response,
 * } from "viell-effect-schema-http";
 * const getThings = Operation.make(
 *   Request.get("https://api.example.test/things"),
 *   Response.status(200, Body.json),
 * );
 * const retryTwice = Policy.make(Schedule.recurs(2));
 * const patient = getThings.pipe(
 *   Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
 * );
 * ```
 *
 * @remarks
 * The function receives the current options, or `undefined` if there are none, and its result
 * replaces them. Spread them to keep what you do not change. A failure or service type that only
 * a dropped option added leaves with it.
 */
export const mapOptions =
  <O, E = HttpClientError.HttpClientError, R = never, EP = never, RP = never>(
    f: (options: O | undefined) => Options<E, R, EP, RP>,
  ) =>
  <B, Q, S, T>(
    self: Adjustable<B, Parts<Q, S, O, T>>,
  ): Derived<B, Q, S, Options<E, R, EP, RP>, T> => {
    const parts = partsOf(self);
    return rebuild({ ...parts, options: f(parts.options) });
  };

/**
 * Remove every recorded result step, so the operation returns what its response decodes.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Body, Operation, Request, Response } from "viell-effect-schema-http";
 * const Page = Schema.Struct({ data: Schema.Array(Schema.String) });
 * const Names = Schema.Struct({ data: Schema.Array(Schema.Number) });
 * const getThings = Operation.make(
 *   Request.get("https://api.example.test/things"),
 *   Response.status(200, Body.jsonSchema(Page)),
 * ).pipe(Operation.map((page) => page.data));
 *
 * const asIds = Response.replace(200, Body.jsonSchema(Names));
 * const thingIds = getThings.pipe(
 *   Operation.unmap,
 *   Operation.mapResponse(asIds),
 *   Operation.map((page) => page.data),
 * );
 * ```
 *
 * @remarks
 * This is the route to a response {@link mapResponse} refuses: remove the mapping, change the
 * response, then map again. The failures and services the steps added leave with them. On an
 * operation with no step this changes nothing.
 */
export const unmap = <B, Q, S, O, T>(
  self: Adjustable<B, Parts<Q, S, O, T>>,
): Http<Q, S, O> => rebuild({ ...partsOf(self), step: undefined });

/**
 * The parts after {@link map} or {@link mapEffect} records a step adding failures `E` and services
 * `R`. An operation with no parts stays that way.
 *
 * @remarks
 * The conditional lives here, in the fifth argument, because a conditional return type would stop
 * `flow` composing these functions.
 */
export type Next<P, E, R> = [P] extends [
  Parts<infer Q, infer S, infer O, infer T>,
]
  ? Parts<Q, S, O, Step<StepFailure<T> | E, StepServices<T> | R>>
  : P;

/** Two steps combine into one, so the type does not grow with each map. */
const addStep = <Result>(
  self: Adjustable<unknown, unknown>,
  f: Runner,
): Result => {
  if (self.parts === undefined) {
    const wrapped: unknown = fromEffect((input: never) =>
      Effect.flatMap(self.execute(input), f),
    );
    return wrapped as Result;
  }
  const parts = self.parts as ErasedParts;
  const previous = parts.step;
  return rebuild({
    ...parts,
    step: {
      run:
        previous === undefined
          ? f
          : (value) => Effect.flatMap(previous.run(value), f),
    },
  });
};

/**
 * Transform an operation's successful result with a pure function.
 *
 * @remarks
 * Keeps the input, error and service types. Runs once, after the operation and its retry policy
 * finish, outside each attempt's scope and timeout. Use {@link mapEffect} to return a typed failure
 * or perform further effectful work.
 *
 * The operation keeps its parts and records this as a step, so {@link mapRequest} and
 * {@link mapOptions} still work on the result, and {@link mapResponse} works while the new result
 * fits. Two maps combine into one step. The mapping applies to the whole result, whichever case
 * produced it. For a conversion that belongs to one case, use `Body.map` on that case's decoder: a
 * later `Response.replace` takes the conversion with the case.
 */
export const map =
  <A, B>(f: (value: A) => B) =>
  <I, E, R, P = unknown>(
    self: Operation<I, A, E, R, P>,
  ): Operation<I, B, E, R, Next<P, never, never>> =>
    addStep(self, (value) => Effect.succeed(f(value as A)));

/**
 * Transform an operation's successful result with an Effect.
 *
 * @remarks
 * Adds the transformation's errors and required services. Runs once, after the operation's retry
 * policy completes, outside each attempt's scope and timeout, so failures here do not trigger that
 * policy and arrive as themselves. Use it to turn a recognized response outcome into an application
 * error.
 *
 * The operation keeps its parts and records this as a step, as {@link map} describes. Its failures
 * and services stay through a variant and leave with {@link unmap}.
 */
export const mapEffect =
  <A, B, E2, R2>(f: (value: A) => Effect.Effect<B, E2, R2>) =>
  <I, E, R, P = unknown>(
    self: Operation<I, A, E, R, P>,
  ): Operation<I, B, E | E2, R | R2, Next<P, E2, R2>> =>
    addStep(self, (value) => f(value as A));
