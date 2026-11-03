# Operation

`Operation` pairs a [request](./request.md) with a [response contract](./response.md). Its `execute`
method returns an Effect that encodes input, sends the request, and decodes the answer. Your
application supplies the HTTP client and chooses when to run the Effect.

## Start with one request

This operation reads a service's health endpoint as text:

<<< ../../examples/modules/operation.ts#imports

<<< ../../examples/modules/operation.ts#simple

`undefined` is the input for a request with no bindings. A request with a path, query, headers or
body binding instead requires the corresponding properties. See the [end-to-end
example](../usage.md).

An Effect is a description of work. It is **cold**: creating it does not execute it. Each evaluation
with `Effect.runPromise`, or with `yield*` inside another Effect, executes the operation again.
There is no automatic result cache or retry. Use [Interaction](./interaction.md) to share work and
[Policy](./policy.md) to opt into retries.

## Supply an HTTP client

`FetchHttpClient.layer` supplies an Effect HTTP client backed by the environment's Fetch. A
**layer** constructs services required by an Effect. In a larger application, provide the layer
around the whole program rather than around every call.

### Try the operation without a server

Provide a client that answers in memory to exercise the same contract locally:

<<< ../../examples/modules/operation.ts#synthetic

`Effect.provideService` supplies an existing service value; `Effect.provide` supplies a layer. The
library accepts any compatible `HttpClient`, including one with application middleware. See Effect's
[services](https://effect.website/docs/v4/requirements-management/services) and
[layers](https://effect.website/docs/v4/requirements-management/layers) guides for composition.

## Transform a successful result

Use `Operation.map` for a pure mapping or `Operation.mapEffect` for a mapping that may fail or need
another service:

<<< ../../examples/modules/operation.ts#map

The transformed operation keeps the original input contract. `mapEffect` adds its error and service
types. Mapping runs after the HTTP operation has completed, including its retry policy; it is not
part of each attempt's decoder or retry classification.

## Handle a typed failure

Compose the returned Effect with Effect's error-handling functions:

<<< ../../examples/modules/operation.ts#failures

Input schema failures happen before dispatch. Transport failures happen during client execution.
`DecodeError` means a selected body decoder failed, while `UnexpectedResponse` means no case
matched. [Limits and recovery](../limits.md#identify-the-failure-stage) explains what to inspect at
each stage. The Effect type retains the error union and any services required by schemas or custom
decoders.

## Advanced execution

### Options and execution helpers

`Operation.make(request, response, options?)` accepts:

| Option            | Default           | Purpose                                                   |
| ----------------- | ----------------- | --------------------------------------------------------- |
| `policy`          | `Policy.none`     | Retry selection, retry budget, delays and attempt timeout |
| `transformClient` | No transformation | Apply native client middleware inside each attempt        |

`Operation.execute(operation, input)` and `operation.pipe(Operation.execute(input))` are
alternatives to `operation.execute(input)`.

### Client middleware

`transformClient` receives the application's client and returns a transformed client. It runs inside
each attempt after request materialization, so it is the place for per-attempt nonces or signatures
over the final library-rendered URL. Order signing after any edits it must cover.

By contrast, `Request.mapEffect` and schema encoding happen once before attempts begin. Native
middleware may reject a response before your declared response case sees it. For example, a native
status filter can reject a 404 that you intended to decode as `Missing`. Choose middleware to match
the operation's declared outcomes.

### Resource lifetime and cancellation

An attempt's scope covers client execution and body decoding. Closing it releases transport
resources before the result is returned, classified, or delayed for retry. Interruption cancels
active work; interruption and defects are never retried. The caller does not need to provide a scope
just for ordinary operation execution.

Preparation happens before the attempt timeout starts. Apply `Effect.timeout` to the returned Effect
if the complete evaluation, including preparation and retry delays, needs a limit.

### Adapt another Effect-returning function

Use `Operation.fromEffect` when you already have a function returning an Effect:

<<< ../../examples/modules/operation.ts#adapt

The function is suspended until evaluation. This adapter adds the operation interface; it does not
add HTTP dispatch, a retry policy, or response decoding to that function.

### Diagnostics

Operations emit Debug-level events in the `schema-http.operation` log span. They report attempt
numbers, method, status and outcome category. They do not log URLs, headers, bodies or error causes.
At Effect's default log level they are silent. The [diagnostics contract](../design.md#diagnostics)
lists the events.

See the [execution contract](../design.md#execution) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.1.0-rc.1/src/http/Operation.ts)
for detailed types and resource guarantees.
