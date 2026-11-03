# Describe and execute a request

An operation combines three descriptions: what to send, how to read the body, and which responses
are meaningful to your application. This guide explains the [getting-started
example](./getting-started.md) and then connects it to a real HTTP client.

## Define the consumer's contract

A **contract** states the input your application accepts and the output it expects from the service.
It lives in the consumer application; the external service need not share its implementation.

<<< ../examples/quickstart.ts#imports

<<< ../examples/quickstart.ts#contract

The pieces have distinct jobs:

| Piece                     | In this example                                               |
| ------------------------- | ------------------------------------------------------------- |
| `Request`                 | GET a URL with a user ID supplied at execution                |
| `Schema.NumberFromString` | Encode an application number as path text                     |
| `Body.jsonSchema`         | Read JSON and validate `{ id: number, name: string }`         |
| `Response.status`         | Use that decoder for HTTP 200                                 |
| `Operation.make`          | Combine the request and response into an executable operation |

The input is `{ path: number }`; the successful output is the user object. `Request.path` gives its
renderer the schema-encoded string and a function that escapes a path value. This is why the
renderer calls `encode(id)` rather than inserting unchecked URL text.

`api` is a reusable base URL transformation. The renderer supplies `/users/42`, which joins to
`https://api.example.test`. `Request.path` replaces the constructor's path, so the example uses
`Request.get("")`. The [Request guide](./modules/request.md#share-an-api-base-and-defaults) shows
shared defaults and [nested resource paths](./modules/request.md#compose-nested-resource-paths).

## Supply an HTTP client and run the effect

The operation needs the `HttpClient` service. A service is a dependency supplied to an Effect;
providing a different client lets the same contract run against a real server or an in-memory
fixture.

<<< ../examples/quickstart.ts#synthetic

`execute` returns a **cold Effect**, a description of work that does not run until evaluated.
`Effect.runPromise` evaluates it here and produces `{ id: 42, name: 'Ada' }`. Each evaluation is a
new operation; construction alone sends nothing.

## Use an HTTP client for your service

To send a request with Fetch, replace the example endpoint with your service's address and supply
Effect's Fetch layer:

<<< ../examples/quickstart.ts#fetch

A **layer** constructs services needed by an Effect. After choosing the real endpoint, evaluate
`overFetch` with `Effect.runPromise(overFetch)` or `yield*` it in your application's Effect program.
In a browser, Fetch's credentials, CORS and redirect policies still apply.

## Add input and response choices

Start with the part your service needs:

- [Request bindings](./modules/request.md#bind-application-input) add `{ query }`, `{ headers }` or
  `{ body }`, and combine them with path input.
- [Body formats](./modules/body.md#choose-a-representation) cover text, bytes, forms and JSON.
- [Response alternatives](./modules/response.md#handle-several-outcomes) describe multiple statuses
  and return tagged values when the caller needs to distinguish them.
- [Operation composition](./modules/operation.md#transform-a-successful-result) maps a successful
  value or turns a recognized response into an application error.

The defaults send one attempt and decode the first matching response case. Learn the ordinary
contract first; add the controls below when your workflow needs them.

## Control repeated work

### Choose response and retry behavior

Use a [Policy](./modules/policy.md) to opt into retries, delay them, and set an attempt timeout. The
application decides whether repeating the action is safe. A transient failure does not prove that
the server did nothing.

### Coordinate an interaction

Use [Interaction](./modules/interaction.md) when equal calls should share work or a retained result,
while changed input replaces active work. For example, one interaction can own the current search
request for one search field. Your application owns loading indicators and other presentation state.

## Advanced behavior and terminology

**Materialization** is the step that converts a request description and application input into a
native HTTP request. It happens once per operation evaluation, before any retry attempts. Each
**attempt** then owns a **scope**, the lifetime in which the client response is read and released.
The [Operation guide](./modules/operation.md#advanced-execution) explains where middleware and
cancellation fit.

A schema-bound header or query group owns the whole group. A selected response decoder's failure
never falls through to another case. These rules are covered after the common examples in the
[Request](./modules/request.md#advanced-behavior) and
[Response](./modules/response.md#advanced-response-behavior) guides.

Use [limits and recovery](./limits.md) to diagnose a failure, and [Design](./design.md) for exact
behavior guarantees. Effect's [v4 guides](https://effect.website/docs/v4/getting-started) explain
its underlying Schema, service, layer and scope concepts in more depth.
