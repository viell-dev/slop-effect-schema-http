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
 */
export interface Operation<in I, out A, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly execute: (input: I) => Effect.Effect<A, E, R>;
}

/**
 * Adapt an Effect-returning function to the operation interface.
 *
 * @remarks
 * The function is suspended until evaluation. This adapter adds no HTTP dispatch, decoding,
 * retry policy or scope management beyond what the supplied function already does.
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
 */
export const make = <
  I,
  E,
  R,
  H extends boolean,
  Q extends boolean,
  A,
  E2,
  R2,
  E3 = HttpClientError.HttpClientError,
  R3 = never,
  EP = never,
  RP = never,
>(
  request: Request.Request<I, E, R, H, Q>,
  response: Response.Response<A, E2, R2>,
  options?: Options<E3, R3, EP, RP>,
): Operation<
  I,
  A,
  | E
  | E3
  | EP
  | Request.InvalidRequest
  | HttpClientError.HttpClientError
  | Response.UnexpectedResponse
  | Response.DecodeError<E2 | HttpClientError.HttpClientError>
  | Cause.TimeoutError,
  R | RP | Exclude<R2 | R3, Scope.Scope> | HttpClient.HttpClient
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
  return { ...Pipeable.Prototype, execute };
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
 * Transform an operation's successful result with a pure function.
 *
 * @remarks
 * Keeps the input, error and service types. Runs after the operation and its retry policy finish.
 * Use {@link mapEffect} to return a typed failure or perform further effectful work.
 */
export const map =
  <A, B>(f: (value: A) => B) =>
  <I, E, R>(self: Operation<I, A, E, R>): Operation<I, B, E, R> =>
    fromEffect((input) => Effect.map(self.execute(input), f));

/**
 * Transform an operation's successful result with an Effect.
 *
 * @remarks
 * Adds the transformation's errors and required services. Runs after the operation's retry
 * policy completes, so failures here do not trigger that policy. Use it to turn a recognized
 * response outcome into an application error.
 */
export const mapEffect =
  <A, B, E2, R2>(f: (value: A) => Effect.Effect<B, E2, R2>) =>
  <I, E, R>(self: Operation<I, A, E, R>): Operation<I, B, E | E2, R | R2> =>
    fromEffect((input) => Effect.flatMap(self.execute(input), f));
