# Describe and execute a request

The complete [quickstart
source](https://github.com/viell-dev/slop-effect-schema-http/blob/main/examples/quickstart.ts) is
type-checked and executed in CI. The snippets on this page are imported from that file.

## Define the consumer's contract

<<< ../examples/quickstart.ts#contract

The path schema accepts an application number and encodes it as a string. `Request.path` supplies
the path renderer with that encoded string and the active path encoder. The response contract
selects HTTP 200 and validates its JSON body. The operation's input is `{ path: number }`; its
successful output has a numeric `id` and a string `name`.

Other request bindings follow the same shape: `Request.body` adds `{ body }`, `Request.query` adds
`{ query }`, and `Request.headers` adds `{ headers }`. Input is encoded once per evaluation.
Raw setters such as `Request.setQuery` are useful for fixed fields; a schema owns its entire group
once bound. [Design](./design.md#fields-and-schemas) gives the ownership and encoding rules.

## Supply an HTTP client and run the effect

<<< ../examples/quickstart.ts#synthetic

The synthetic client is an evaluation fixture. It still passes through Effect's client wrapper, but
answers in memory. `Effect.runPromise` evaluates the operation; constructing it sends nothing.

For an application using Fetch, provide Effect's Fetch layer:

<<< ../examples/quickstart.ts#fetch

Replace the reserved example endpoint with your service's address before evaluating that effect.
Fetch's redirect, cookie and browser policies still apply. See the [browser
limits](./design.md#in-a-browser).

## Choose response and retry behavior

Declare the responses your application understands with `Response.status` or `Response.when`, then
compose alternatives with `Response.orElse`. Declaration order is priority. Once a decoder is
selected, a decoding failure is final; it does not fall through to another case. A payload that
varies under identical metadata belongs in a schema union within that case.

An operation makes one attempt by default. Opt into retries with `Policy.make` and an Effect
schedule. Its default transient classifier checks status or failure, including successfully decoded
transient responses; it does not decide whether repeating your operation is safe. Choose the
classifier for the operation's semantics. [Execution](./design.md#execution) explains timeouts,
retry budgets, `Retry-After`, cancellation, and which data a classifier receives.

## Coordinate an interaction

`Interaction.make` acquires one interaction in a scope, capturing its services. Equal input joins
active work or reuses a retained success; changed input supersedes active work. A caller can force
fresh work, and closing the interaction waits for its owned work to finish releasing resources. The
application controls presentation state. See [Interactions](./design.md#interactions) and the [API
module](./api.md).
