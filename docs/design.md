# Design

This page records the decisions behind Effect Schema HTTP: what the library promises and what it
deliberately leaves to the consumer, to Effect, or to the transport. Doc comments in the source give
the details of each function. Tests and proposed changes are judged against this page and those
comments, not against whatever the implementation happens to do. Where the implementation deviates
from them, the deviation is a defect, tracked in the [issue
tracker](https://github.com/viell-dev/slop-effect-schema-http/issues?q=is%3Aissue+label%3A%22Type%3A+Bug%22).

The project is an unreleased prototype; these decisions can still change, and a change is recorded
here.

## Principles

**Wire Effect, do not replace it.** The library composes Effect's schema and HTTP modules around
consumer-owned contracts. It adds no transport, runtime, service registry, logging facility, cache,
or configuration provider. Where Effect already defines a behavior, the library delegates to it:

- `Body.json` encodes with `HttpBody.json`.
- `Policy.transient` uses the classification of `HttpClient.retryTransient`.
- `Policy.retryAfterDelay` reads `Retry-After` with `Headers.parseRetryAfter`.
- Requests are dispatched through the `HttpClient` service, so client middleware and providers apply
  unchanged.

**Consumer control over imposed policy.** The library makes a choice only where an operation cannot
work without one. An unconventional path, header, method, or status code is not a reason to reject
it or to rewrite its meaning. Defaults that embody a policy can be replaced through ordinary Effect
composition. For example, `UrlEncoding` is a context reference with a replacement layer.

**Finite bodies first.** Streaming request and response bodies are deferred. The finite-body design
must not foreclose them.

## Requests

A `Request` is a pure description of an HTTP request and of the input needed to send it.
Constructing one evaluates nothing; materialization happens when an operation runs or when
`Request.compile` is evaluated.

### URLs are made sendable, not normalized

The `UrlEncoding` service renders path values, query entries, and the final URL. Its defaults
percent-encode path values and query entries with `encodeURIComponent`, and join the base URL and
the request URL at their slash boundary. They do not resolve dot segments, drop empty values, or
reorder anything:

- A path value of `..` composes `https://api.test/v1/files/..`.
- An empty path value composes an empty segment, such as `https://api.test/v1/files//meta`.
- An encoded dot segment such as `%2e%2e` is encoded again (`%252e%252e`), so it stays literal.

What happens to the URL afterwards is a property of the client. Effect's `HttpClient.make` parses
the composed URL with the WHATWG `URL` parser, which resolves dot segments. The runner that `make`
calls also receives the unparsed request, so a provider can send the composed URL unchanged. A
consumer that must never send a dot segment validates the value in the path schema or replaces
`UrlEncoding.path`; the default does not restrict every consumer to protect some.

A base URL is an origin plus a path prefix. The default join is a string join, so a query string in
the base URL ends up before the joined path. Put parameters that every request needs in a shared
transform:

```ts
const service = <I, E, R, H extends boolean>(
  request: Request.Request<I, E, R, H, false>,
) =>
  request.pipe(
    Request.setQuery("key", "abc"),
    Request.baseUrl("https://api.test/v1"),
  );

// GET https://api.test/v1/users?key=abc
const users = service(Request.get("users"));
```

A query string in a URL passed to `Request.make` or a method helper such as `Request.get` becomes
raw query declarations. Parsing it keeps a bare key (`?wsdl`) distinct from an empty value
(`?wsdl=`), and the entries are encoded again during materialization. Whether a declared query
should instead keep its original encoding is an [open
question](https://github.com/viell-dev/slop-effect-schema-http/issues/14).

A URL that cannot be rendered or encoded fails with `Request.InvalidRequest`.

### Wire representations stay distinct

These are different things and the library keeps them different:

- a bare query key (`null`) and an empty value (`""`);
- a repeated query entry or header line and a single one;
- a header value that contains commas and several header lines;
- the order of entries, including across names.

Native client middleware sees the normalized `Headers` view: lowercase names, with repeated lines
joined by `, `. The original lines are available to a provider that can send them, through
`Transport.HeaderLines` and `Transport.headerLines`. Lines changed by middleware replace the
original lines of that field only. On responses, provider-observed lines are an `Option`, and `None`
means the provider supplied none. The library never splits a combined value or invents lines.

### Fields and schemas

Raw declarations (`setHeader`, `appendHeader`, `removeHeader`, and the query equivalents) take a
value or a computation. A computation runs once per materialization, and `undefined` omits the
field. Header names are case-insensitive; query keys are not.

Schemas are optional to choose and binding when chosen. `Request.headers` and `Request.query` take a
schema whose encoded side fits the representation (`Transport.HeaderInput` or
`UrlEncoding.QueryInput`); its application side can be any shape. Once a schema owns the header or
query group, it replaces the raw declarations, the raw setters disappear from the request's type,
and the group cannot be bound a second time. `Request.path` and `Request.body` add their input to
the request instead, so each can be combined with the other bindings.

### Bodies

A body needs an encoder or a decoder, not necessarily a schema. `Body.json`, `Body.text`,
`Body.bytes`, `Body.formData`, `Body.urlEncoded`, and `Body.empty` cover the finite representations,
and `Body.encodeSchema`, `Body.schema`, and `Body.jsonSchema` add validation.

`Body.json` is untyped and encodes exactly as `HttpBody.json` does. That includes Effect's choice
for a value that `JSON.stringify` omits, such as `undefined` or a function: it encodes as an empty
`application/json` body. `Body.jsonSchema` is the validated path; it encodes through the schema's
canonical JSON codec (`Schema.toCodecJson`), and a struct schema never produces `undefined`.

The body codec owns the request's `Content-Type`. Multipart form data leaves `Content-Type` to the
transport, so it can add the boundary. A header declaration describes a header; it does not relabel
an encoded body. A protocol that needs a parameterized content type gets it from a custom codec.
`Request.mapEffect` remains available to edit the native request deliberately.

A GET or HEAD request with a body fails with `Request.InvalidRequest` before dispatch.

### Request transforms

`Request.mapInput` adapts the invocation argument. `Request.mapEffect` edits the native request
effectfully, for example to sign it, once per evaluation before any attempt. Its input type is fixed
when the transform is created, which lets `pipe` infer `input` for an inline transform. A transform
created on its own that ignores its input targets `Request<unknown>`; apply it before the input
bindings, or reuse it through a generic function as in the example above.

## Responses

A `Response` selects a decoder from transport metadata only: status, headers, cookies, and the
optional provider lines. Selection happens before any body byte is read.

- Declaration order is priority. `Response.orElse` consults its fallback only when no earlier case
  matches; there is no ranking by specificity.
- A selected decoder's failure is final. It fails with `Response.DecodeError`, which carries the
  metadata and the decoder's typed cause, and never falls through to a later case. Payloads that
  vary under identical metadata are a `Schema.Union` inside one case.
- An unmatched response is drained and fails with `Response.UnexpectedResponse`, which carries the
  metadata only. A consumer that needs the payload of other responses declares a final case that
  reads it.
- A live response never crosses a failure boundary: errors hold metadata, not response bodies.

The media types of the declared decoders form the operation's automatic `Accept` header, unless the
request declares one.

## Execution

`Operation.make` pairs a request with a response contract. Construction is pure, and executing it
returns an ordinary cold `Effect`.

Each evaluation materializes the request once: computed fields run and input is encoded a single
time, so credentials stay the same across retries. Anything that must differ per attempt, such as a
nonce or a signature over the attempt, belongs in client middleware through the `transformClient`
option.

Each attempt owns a `Scope` that covers dispatch and decoding. The scope closes, aborting the
attempt's request if it is still in flight, before the outcome is classified or a retry delay
begins.

Retries follow a `Policy`:

- The default, `Policy.none`, makes one attempt.
- `Policy.make` takes a schedule and options. One schedule owns the retry budget across every
  reason, and a failing schedule fails the operation with the schedule's error.
- The `while` option replaces the default classification, `Policy.transient`: timeouts, transport
  errors, and the statuses 408, 429, 500, 502, 503, and 504.
- Interruption and defects never retry.
- `Retry-After`, as delay seconds or an HTTP date, is a minimum delay. It also applies when client
  middleware turned the response into an error, such as `HttpClient.filterStatusOk`. Malformed or
  unrepresentable values request no delay.
- `attemptTimeout` limits each attempt; a timed-out attempt is transient. A limit on the whole
  operation is an ordinary `Effect.timeout` applied by the caller.

Failures and services are typed and kept separate. Input schema errors, `InvalidRequest`, transport
errors, `DecodeError`, `UnexpectedResponse`, `TimeoutError`, and the schedule's error are distinct
members of the operation's error type. A request schema contributes its encoding services and a
response schema its decoding services. A decoder's or client transform's `Scope` is provided by the
attempt and does not reach the caller.

## Diagnostics

Operations emit Debug-level log events inside the `schema-http.operation` log span: when an attempt
starts and completes, when a retry begins or the budget is exhausted, and when the operation
completes. The annotations are the method, the attempt number, the numeric status, and an outcome
category (`success`, `failure`, `interrupted`, or `defect`). Nothing from URLs, headers, cookies,
bodies, decoded values, or error causes is recorded, because any of them can contain credentials or
personal data. At Effect's default minimum log level, nothing is emitted.

## Interactions

An `Interaction` serves one user-facing interaction, such as a search box, with at most one active
execution and one retained success.

- Equal input joins the active execution or reuses the retained success. Input is compared with
  `Equal.equals` by default, which compares plain objects and arrays structurally.
- Different input interrupts the active execution.
- `force` starts fresh work, superseding the active execution and bypassing the retained success.
- `retain` decides whether a success is kept for reuse; it never changes the returned value.
- Failures, defects, and interruptions leave the retained success in place.
- Each execution belongs to the interaction, not to a caller, and runs in its own child scope.
  Interrupting one waiter never cancels work another waiter shares.
- Every execution publishes its result, even when it was superseded before it started.
- Services are captured when the interaction is acquired, like a layer.
- `close` is permanent and idempotent, and runs when the acquiring scope closes. Every caller waits
  for the finalizers of all owned work, including superseded executions.

Presentation state, such as what a UI shows while work is pending, belongs to the application.

## Not provided

- A transport. Requests run through whichever `HttpClient` the application provides.
- Server or client code generation.
- Streaming bodies (deferred, see above).
- Caching beyond an interaction's single retained success, and configuration or logging facilities
  of its own.
