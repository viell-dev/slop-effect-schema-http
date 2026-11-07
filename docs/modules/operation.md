# Operation

`Operation` pairs a [request](./request.md) with a [response contract](./response.md). Its `execute`
method returns an Effect that encodes input, sends the request, and decodes the answer. Your
application supplies the HTTP client and chooses when to run the Effect.

## Start with one request

This operation reads a service's health endpoint as text:

<<< ../../examples/modules/operation.ts#imports

<<< ../../examples/modules/operation.ts#simple

`undefined` is the input for a request with no bindings. A request with a path, query, headers or
body binding instead requires the corresponding properties. Their value types come from the request
schemas. Hover over `execute` in your editor, or use TypeScript's
`Parameters<typeof operation.execute>[0]` to extract the input type. The [end-to-end
example](../usage.md#understand-the-input-type) shows named path input and a JSON body.

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
types. Mapping runs once, after the HTTP operation has completed, including its retry policy. It is
not part of each attempt's decoder or retry classification, its failures arrive as themselves, and
the attempt's scope and timeout do not cover it. A mapped operation [stays
adjustable](#adjust-a-mapped-operation).

## Handle a typed failure

Compose the returned Effect with Effect's error-handling functions:

<<< ../../examples/modules/operation.ts#failures

Input schema failures happen before dispatch. Transport failures happen during client execution.
`DecodeError` means a selected body decoder or an unmatched body's drain failed.
`UnexpectedResponse` means no case matched and draining succeeded. [Limits and
recovery](../limits.md#identify-the-failure-stage) explains what to inspect at each stage. The
Effect type retains the error union and any services required by schemas or custom decoders.

## Define once, adjust where it is used

An application usually writes its common requests once, near the integration, and each component
adjusts one for its own case. An operation from `Operation.make` keeps its parts, so a default that
suits the common request never prevents a less common one:

<<< ../../examples/modules/operation.ts#define

`Operation.mapRequest`, `Operation.mapResponse` and `Operation.mapOptions` each derive a
**variant**. Pass any function from the part's module, here one held in a variable:

<<< ../../examples/modules/operation.ts#adjust

The original never changes. Hold each transform in a named variable and map once per change, or pass
an arrow function such as `(request) => request.pipe(...)`. To compose several transforms into one,
define it with `flow` or an ordinary function, then pass that. Each is equally good.

Hold the `Request` or `Response` transform in the variable, not the `Operation.mapRequest` call. A
transform like `firstFive` works for any request, and a call on its own has no operation to learn
the types from, so it gives `unknown` failures and services or a compile error. `Operation.map` with
an annotated parameter, and `Operation.mapOptions` with a function that ignores the current options,
have no such problem.

### Change the request and the response together

Some changes keep the shape of the answer, such as paging, sorting and filtering. Others change it,
such as selecting fields or embedding relations, because a request that asks for a different shape
gets a different shape. The library cannot tell them apart, so a change of shape needs both:

<<< ../../examples/modules/operation.ts#shape

`Response.replace` keeps the error cases and swaps the one success shape, and the [Response
guide](./response.md#adjust-a-contract) explains how cases are addressed. The automatic `Accept`
follows the new response.

A request binding can also change the operation's input. Inside `Operation.mapRequest`, a
`Request.query` adds its input property to `execute`.

### Change the options

`Operation.mapOptions` receives the current options, or `undefined` when there are none, and its
result replaces them. Spread them to keep what you do not change:

<<< ../../examples/modules/operation.ts#options

### Adjust a mapped operation

`Operation.map` and `Operation.mapEffect` keep the parts and record the mapping as a step that runs
after them. This definition unwraps an envelope and turns a 404 into a failure, and it stays
adjustable:

<<< ../../examples/modules/operation.ts#mapped

| Change                             | On a mapped operation                        |
| ---------------------------------- | -------------------------------------------- |
| `mapRequest`, `mapOptions`         | Always works, and the mapping stays          |
| `mapResponse`, the new result fits | Works, and the mapping stays                 |
| `mapResponse`, anything else       | A compile error that names `Operation.unmap` |

A new result **fits** when it is something the current response could already produce, so the
mapping was written for it. A same-shape replace or a removal fits. So does a stricter schema for
the same shape. A new shape, a new case, or an `any` result does not, and neither does widening back
after narrowing, because the check compares with the current response. Nothing is out of reach:
`Operation.unmap` removes every step, then you change the response and map again. A named generic
function can serve both shapes:

<<< ../../examples/modules/operation.ts#unmap

The mapping's failures and services stay through a variant and leave with `Operation.unmap`. A
mapping can use a generator, with `Effect.gen` inside the function or `Effect.fn` around it:

<<< ../../examples/modules/operation.ts#generator

The fit check is a compile-time rule. A cast gets past it, and the mapping then receives a shape it
was not written for.

### Choose `Operation.map` or `Body.map`

Use `Operation.map` or `Operation.mapEffect` for a conversion of the **whole result**, whichever
case produced it. It stays when a case is replaced, which is why a new shape has to go through
`Operation.unmap`. A `mapEffect` that turns a recognized outcome into a failure belongs here, so
that replacing the case with the same shape cannot turn the failure into a success.

Use `Body.map` for a conversion that belongs to **one case**. It lives in that case's decoder, so a
replace takes the conversion with it, and the operation has no step to fit:

<<< ../../examples/modules/operation.ts#decoder

### Offer less than the whole definition

The library adds no limit of its own: a variant can change any part. An author who wants to offer
less exports a function with the parameters they choose, or seals the definition:

<<< ../../examples/modules/operation.ts#limit

`Operation.fromEffect(operation.execute)` keeps the same types and has no parts, at compile time or
at run time, so `Operation.mapRequest` and the others are compile errors on it. Callers can still
run it and map its result. Annotating a value as a plain `Operation.Operation<I, A, E, R>` has the
same effect at compile time only. A function that takes that plain type stays usable with any
operation, and what it returns stays plain.

An operation's parts can be read with `operation.parts?.request`, `operation.parts?.response` and
`operation.parts?.options`.

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
add HTTP dispatch, a retry policy, or response decoding to that function. The result has no parts,
so it [cannot be adjusted](#offer-less-than-the-whole-definition).

### Diagnostics

Operations emit Debug-level events in the `schema-http.operation` log span. They report attempt
numbers, method, status and outcome category. They do not log URLs, headers, bodies or error causes.
At Effect's default log level they are silent. The [diagnostics contract](../design.md#diagnostics)
lists the events.

See the [execution contract](../design.md#execution) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.1.0/src/http/Operation.ts)
for detailed types and resource guarantees.
