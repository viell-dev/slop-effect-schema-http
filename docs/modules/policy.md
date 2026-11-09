# Policy

`Policy` controls whether an [operation](./operation.md) makes another attempt, how long it waits,
and how long an attempt may take. Operations use `Policy.none` by default: one attempt, with no
library-imposed timeout.

## Start with bounded retries

For a read that your service permits you to repeat, attach a policy to the operation:

<<< ../../examples/modules/policy.ts#imports

<<< ../../examples/modules/policy.ts#retry

This allows two retries after the first attempt. It waits at least 100 milliseconds before each
retry and limits each attempt to five seconds. The policy retries transient failures by default; it
does not retry every error.

Enable retries only when repeating the action is acceptable. The default classifier does not check
the method or whether the server has already applied the request. This matters for writes and for
transport failures received after the server acted. [Create, then
upload](../recipes.md#create-then-upload) shows a retry on the one step that is safe to repeat.

`Policy.none` is one attempt by the library, not one send: [a client can send a request again by
itself](../limits.md#one-attempt-can-reach-a-server-twice).

## Choose the retry budget and delay

An Effect `Schedule` determines how many retries are allowed and their delays. `Schedule.recurs(n)`
allows `n` retries. The example adds a fixed delay; Effect also supplies exponential backoff and
other schedules. See [choosing and combining
schedules](https://effect.website/docs/v4/scheduling/choosing-and-combining-schedules).

One schedule owns the budget across all retry reasons. A response asking for `Retry-After` cannot
create additional attempts beyond that budget. When the budget is exhausted, the operation returns
the last attempt's result or failure.

## Bound execution time

`Policy.timeout` makes one attempt with a limit and no retries. A policy that retries takes the same
limit as `attemptTimeout`. Apply `Effect.timeout` to the operation's Effect when you also need an
overall deadline:

<<< ../../examples/modules/policy.ts#timeout

Pass `oneAttempt` as the operation's `policy` to use it. An attempt timeout covers dispatch and
decoding. It excludes preparation and result mapping, such as a slow base URL Effect or an
`Operation.mapEffect` step. The outer timeout covers those too, with retry delays and all attempts
together. A timeout interrupts the work and waits for its cleanup; it cannot undo an action the
server already performed. Cleanup can delay when the caller receives the timeout failure.

## Choose which outcomes retry

The default `Policy.transient` classifier retries:

- Timeouts and transport failures.
- Responses with status 408, 429, 500, 502, 503, or 504, including a declared response that decoded
  successfully or a response rejected by native middleware.

Supply `while` to replace that classifier:

<<< ../../examples/modules/policy.ts#classification

An outcome is what the client reports, and clients differ. [A body cut off after its
headers](../limits.md#a-body-cut-off-after-its-headers) is a decoding failure through `fetch`, which
does not retry, and a transport failure through some other providers, which does.

The replacement sees a `Policy.Reason`. A `Response` reason contains metadata; a `Failure` reason
contains a cause and, when a response was available, metadata. The example therefore handles both a
decoded 429 and a failure associated with a 429. It does not retry an unrelated transport error or
timeout.

The classifier sees every completed outcome, not only failures. A 200 that decoded successfully is a
`Response` reason like any other, so `while: () => true` retries it too. The operation repeats until
the schedule runs out, then returns the last attempt's result. Inspect the reason rather than
answering `true` for everything.

## Advanced policy behavior

### Options and defaults

| Option to `Policy.make` | Default            | Behavior                                            |
| ----------------------- | ------------------ | --------------------------------------------------- |
| `while`                 | `Policy.transient` | Whether an outcome is eligible for retry            |
| `attemptTimeout`        | None               | Limit dispatch and decoding for each attempt        |
| `retryAfter`            | `true`             | Honor a response's `Retry-After` as a minimum delay |

Both the classifier and schedule must permit another attempt. Interruption and defects never retry,
even if a custom classifier would otherwise allow them. A schedule's own typed failure fails the
operation and remains part of its error type.

### Retry-After

`Retry-After` accepts delay seconds or an HTTP date. The retry waits for the larger of its scheduled
delay and that minimum. Invalid or unrepresentable values add no delay. Set `retryAfter: false` to
use only the schedule's delay.

`Policy.retryAfterDelay(metadata, now)` exposes that calculation; `now` is the current time in
milliseconds since the Unix epoch. Ordinary operations call it for you.

### What a classifier can observe

A reason contains metadata and failures, not the request method or decoded result. Capture the
operation's known method or repeat-safety decision in the classifier's closure. For decisions based
on decoded application values, compose outside the operation's attempt policy.

The attempt scope has already closed when classification runs. Input encoding, computed request
fields, `Request.mapEffect` and a base URL from an Effect are not rerun for a retry. Use [client
middleware](./operation.md#client-middleware) for per-attempt data, which receives the attempt
number.

See the [execution contract](../design.md#execution) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.16.0/src/http/Policy.ts) for
the complete reason and policy types.
