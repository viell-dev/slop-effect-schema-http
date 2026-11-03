import { Cause, Duration, Result, Schedule } from "effect";
import { Headers, HttpClientError } from "effect/http";
import type * as Response from "./Response.js";

/**
 * The completed attempt's response metadata or failure cause, used to decide whether to retry.
 *
 * @remarks
 * Contains no live transport resource, request method or decoded result. A failure includes
 * metadata when a response was available, such as a decoding failure or a middleware rejection.
 * Capture the operation's method or repeat-safety decision in the classifier's closure.
 */
export type Reason =
  | { readonly _tag: "Response"; readonly metadata: Response.Metadata }
  | {
      readonly _tag: "Failure";
      readonly cause: Cause.Cause<unknown>;
      /** Present when a response arrived before the failure: a decoding failure, or middleware rejecting it. */
      readonly metadata?: Response.Metadata | undefined;
    };

/**
 * A retry schedule, outcome classifier and optional timeout for an operation.
 *
 * @remarks
 * The classifier and schedule must both permit another attempt. One schedule owns the retry
 * budget across all reasons for that evaluation.
 */
export interface Policy<out E = never, out R = never> {
  /** Supplies each retry delay and the shared retry budget for one evaluation. */
  readonly schedule: Schedule.Schedule<unknown, Reason, E, R>;
  /** Classifies a completed outcome as eligible for retry; the schedule must also permit it. */
  readonly while: (reason: Reason) => boolean;
  /** Bounds client execution and body decoding per attempt. `undefined` imposes no timeout. */
  readonly attemptTimeout: Duration.Input | undefined;
  /** Whether `Retry-After` supplies a minimum delay in addition to the schedule. */
  readonly retryAfter: boolean;
}

const isTransientStatus = (status: number): boolean =>
  status === 408 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

const isTransientError = (error: unknown): boolean =>
  Cause.isTimeoutError(error) ||
  (HttpClientError.isHttpClientError(error) &&
    (error.reason._tag === "TransportError" ||
      (error.reason._tag === "StatusCodeError" &&
        isTransientStatus(error.reason.response.status))));

/**
 * Recognize timeouts, transport failures and transient HTTP statuses.
 *
 * @remarks
 * The statuses are 408, 429, 500, 502, 503 and 504, matching Effect's transient classification.
 * A declared response with one of these statuses is eligible even when decoding succeeded.
 * This does not check the method or whether repeating a remote action is safe.
 */
export const transient = (reason: Reason): boolean => {
  if (
    reason.metadata !== undefined &&
    isTransientStatus(reason.metadata.status)
  )
    return true;
  if (reason._tag === "Response") return false;
  return reason.cause.reasons.some(
    (failure) => Cause.isFailReason(failure) && isTransientError(failure.error),
  );
};

/**
 * Create a retry policy from an Effect schedule and optional settings.
 *
 * @example
 * ```ts
 * import { Schedule } from "effect";
 * import { Policy } from "viell-effect-schema-http";
 * const retryRead = Policy.make(Schedule.recurs(2), { attemptTimeout: "5 seconds" });
 * // At most three attempts; repeat only operations your service permits you to repeat.
 * ```
 *
 * @remarks
 * `Schedule.recurs(n)` permits up to `n` retries after the first attempt. Defaults to
 * {@link transient}, honoring `Retry-After`, and no attempt timeout. Enable retries only when
 * repeating the service action is acceptable; transport failure does not prove it was unapplied.
 * The attempt timeout covers client execution and decoding, not initial request preparation or
 * retry delays. Apply `Effect.timeout` around the operation for an overall limit.
 */
export const make = <Out, E = never, R = never>(
  schedule: Schedule.Schedule<Out, Reason, E, R>,
  options?: {
    readonly while?: ((reason: Reason) => boolean) | undefined;
    readonly attemptTimeout?: Duration.Input | undefined;
    readonly retryAfter?: boolean | undefined;
  },
): Policy<E, R> => ({
  schedule,
  while: options?.while ?? transient,
  attemptTimeout: options?.attemptTimeout,
  retryAfter: options?.retryAfter ?? true,
});

/**
 * One attempt, with no retry and no library-imposed timeout.
 */
export const none: Policy = make(Schedule.recurs(0));

/**
 * Read the minimum retry delay requested by a response's `Retry-After` header.
 *
 * @remarks
 * `now` is milliseconds since the Unix epoch. Accepts delay seconds or an HTTP date. Missing,
 * malformed or unrepresentable values produce zero. An operation takes the larger of this delay
 * and its scheduled delay; this helper does not decide whether another attempt is allowed.
 */
export const retryAfterDelay = (
  metadata: Response.Metadata,
  now: number,
): Duration.Duration => {
  const value = metadata.headers["retry-after"];
  if (value === undefined) return Duration.zero;
  const parsed = Headers.parseRetryAfter(value);
  if (Result.isFailure(parsed)) return Duration.zero;
  const delay = Headers.retryAfterDelay(parsed.success, now);
  return Number.isFinite(Duration.toMillis(delay)) ? delay : Duration.zero;
};
