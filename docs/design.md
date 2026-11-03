# Design

This page defines the library's behavior contract: what it promises and what it delegates to the
application, Effect, or the HTTP provider. Start with [Getting started](./getting-started.md) and
the [module guides](./api.md) for examples; use this page when you need precise rules. Changes to
these guarantees follow the [compatibility policy](./versions.md#compatibility-policy).

## The main workflow

1. Describe application input with `Request` and body encoders.
2. Describe accepted responses with `Response` and body decoders.
3. Pair them with `Operation.make`, supply an Effect HTTP client, and evaluate `execute(input)`.
4. Receive a validated value or a typed failure. Add a retry policy or interaction only when needed.

Request encoding is **materialization**: turning a description and input into the native request. An
**attempt** sends that request and decodes its answer. A **scope** owns the resources that must be
released when an attempt ends. The sections below refine those steps.

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

### Fields and schemas

Use raw fields for fixed headers or query parameters, and bind a schema for values supplied by the
caller. Path, query, header and body bindings contribute their corresponding input properties; see
the [Request examples](./modules/request.md#bind-application-input).

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

For typed JSON, `Body.jsonSchema` validates application values in both directions. Use another codec
when the service sends text, bytes or forms; the [Body guide](./modules/body.md) starts with these
common choices.

A body needs an encoder or a decoder, not necessarily a schema. `Body.json`, `Body.text`,
`Body.bytes`, `Body.formData`, `Body.urlEncoded`, and `Body.empty` cover the finite representations,
and `Body.encodeSchema`, `Body.schema`, and `Body.jsonSchema` add validation.

`Body.json` is untyped and encodes exactly as `HttpBody.json` does. That includes Effect's choice
for a value that `JSON.stringify` omits, such as `undefined` or a function: it encodes as an empty
`application/json` body. `Body.jsonSchema` is the validated path; it encodes through the schema's
canonical JSON codec (`Schema.toCodecJson`), and a struct schema never produces `undefined`.

`Body.text` delegates incoming decoding to the provider's `response.text`. Fetch-backed providers
decode UTF-8 regardless of a `Content-Type` charset, strip a leading UTF-8 byte-order mark, and
replace malformed bytes with U+FFFD without failing. Use `Body.bytes` with a schema or custom
decoder when the format needs strict decoding, another encoding, or the original bytes. Web
`TextDecoder` labels follow the [Encoding
Standard](https://encoding.spec.whatwg.org/#names-and-labels): `iso-8859-1` selects windows-1252, so
bytes 0x80–0x9F differ from exact Latin-1. A format that requires exact Latin-1 needs its own byte
mapping.

The body codec owns the request's `Content-Type` and `Content-Length`. Multipart form data leaves
both to the transport, so it can add the boundary. A header declaration describes a header; it does
not relabel an encoded body. A protocol that needs a parameterized content type gets it from a
custom codec. `Request.mapEffect` remains available to edit the native request deliberately.

A GET or HEAD request requires `HttpBody.empty`, as produced by `Body.empty`. Even a zero-length
text or byte body fails with `Request.InvalidRequest` before dispatch.

### Request transforms

`Request.mapInput` adapts the invocation argument. `Request.mapEffect` edits the native request
effectfully, once per evaluation before any attempt. It sees the preparation steps before it, but
the base URL has not been joined and query entries are still separate parameters: the URL is not
final. URL-dependent signing belongs in client middleware through `Operation.make`'s
`transformClient`, after any request edits the signature must cover. It runs per attempt, after the
library renders the base URL and query. The provider's own URL normalization still applies.

### URLs are made sendable, not normalized

`Request.baseUrl` supplies a shared origin and fixed prefix. `Request.path` renders the complete
request path from schema-encoded input, replacing the constructor's path; it does not append to it.
The base is joined afterwards. Reuse application renderers for variable parent paths; the library
does not join two Request values or incrementally merge typed path bindings.

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
import { Request } from "viell-effect-schema-http";

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
raw query declarations through form decoding. Parsing splits on `&`, drops empty segments, reads `+`
as a space, and decodes percent escapes. It keeps a bare key (`?wsdl`) distinct from an empty value
(`?wsdl=`). Semicolons and additional equals signs inside a value are data, so `?a=1;b=2` renders as
`?a=1%3Bb%3D2` under the default policy. Every decoded entry is rendered through `UrlEncoding.query`
during materialization: `?q=a+b` becomes `?q=a%20b`, and `?a=%41` becomes `?a=A`.

This treats a declared query as structured fields that `setQuery`, `removeQuery`, and query schemas
can edit uniformly. A custom `UrlEncoding.query` receives the decoded entries; the original spelling
is already gone. To supply opaque query text, start with a request without query declarations and
set the native URL text through `Request.mapEffect`. Base-URL joining still runs afterwards, and
client or provider URL processing still applies.

A URL that cannot be rendered or encoded fails with `Request.InvalidRequest`.

### Wire representations stay distinct

These are different things and the library keeps them different:

- a bare query key (`null`) and an empty value (`""`);
- a repeated query entry or header line and a single one;
- a header value that contains commas and several header lines;
- the order of entries, including across names.

These distinctions describe the request the library materializes. Client middleware can change them
afterwards: Effect appends native URL parameters through
[`URLSearchParams`](https://url.spec.whatwg.org/#interface-urlsearchparams), which serializes the
whole query as form data. Appending `key=abc` to `?wsdl&q=a%20b` that way produces
`?wsdl=&q=a+b&key=abc`. Put parameters in `Request` combinators to use the library's encoding. If
middleware must add a parameter, preserve the existing URL text and encode the new entry explicitly.

Native client middleware sees the normalized `Headers` view: lowercase names, with repeated lines
joined by `, `. The original lines are available to a provider that can send them, through
`Transport.HeaderLines` and `Transport.headerLines`. Lines changed by middleware replace the
original lines of that field only. On responses, provider-observed lines are an `Option`, and `None`
means the provider supplied none. The library never splits a combined value or invents lines.

## Responses

A `Response` selects a decoder from transport metadata only: status, headers, cookies, and the
optional provider lines. Selection happens before any body byte is read.

Use `Response.status(200, decoder)` for one expected status and add alternatives with
`Response.orElse`. A matched response returns the decoder's value, even when the declared status
represents an application-level failure such as 404. The [Response guide](./modules/response.md)
shows how to tag and interpret those outcomes.

### Selection and decoding rules

- Declaration order is priority. `Response.orElse` consults its fallback only when no earlier case
  matches; there is no ranking by specificity.
- A selected decoder's failure is final. It fails with `Response.DecodeError`, which carries the
  metadata and the decoder's typed cause, and never falls through to a later case. Payloads that
  vary under identical metadata are a `Schema.Union` inside one case.
- An unmatched response is drained, then fails with `Response.UnexpectedResponse`, which carries the
  metadata only. If draining itself fails, the result is a `Response.DecodeError`. A consumer that
  needs the payload of other responses declares a final case that reads it.
- No live response crosses a failure boundary: the attempt's scope closes, releasing the response's
  transport resources, before the outcome is returned or classified. Errors are not stripped,
  though. A `DecodeError` keeps the decoder's cause, and an Effect client error there, or one from
  middleware that rejected the response, includes the response object with any body it already read.
  Treat such errors as possibly containing response content.

The media types of the declared decoders form the operation's automatic `Accept` header, unless the
request declares one.

### In a browser

The HTTP provider and browser determine which response facts are visible. In a Fetch-backed browser
client:

- `Set-Cookie` is hidden from response metadata even if CORS lists it as exposed. The browser
  manages cookies according to its credentials and cookie policy; a hand-set `Cookie` request header
  is dropped.
- A cross-origin header that CORS does not expose is absent. A response rule cannot select on a
  hidden value. A custom decoder that requires it can fail with `Response.DecodeError`.
- With `redirect: "manual"`, a redirect becomes an opaque redirect response with status 0 and no
  visible headers. A declared 301 case cannot match the original status.
- A refused preflight and a request whose answer is withheld by CORS both surface as transport
  failures. The latter may already have changed server state, so retrying can repeat an action.

These are [Fetch platform limits](https://fetch.spec.whatwg.org/), outside the library. A schema or
response rule cannot recover hidden metadata. Do not infer browser cookie, redirect, header or CORS
behavior from a Node run.

## Execution

`Operation.make` pairs a request with a response contract. Construction is pure, and executing it
returns an ordinary cold `Effect`.

By default an evaluation makes one attempt. The application supplies `HttpClient` and decides when
to run the Effect. See [Operation](./modules/operation.md) for execution and error handling, then
[Policy](./modules/policy.md) for retries and timeouts.

### Preparation and attempt lifetime

Each evaluation materializes the request once: computed fields run and input is encoded a single
time, so credentials stay the same across retries. Anything that must differ per attempt, such as a
nonce or a signature over the attempt, belongs in client middleware through the `transformClient`
option.

Each attempt owns a `Scope` that covers dispatch and decoding. The scope closes, aborting the
attempt's request if it is still in flight, before the outcome is classified or a retry delay
begins.

### Retry rules

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

The transient classifier checks status or failure alone. It does not check the request method or
idempotency, and even a declared response that decoded successfully is retried when its status is
transient. A POST that returns a declared HTTP 500 can therefore run several times when retries are
enabled. A transport error can also follow a request the server already acted on; it does not prove
that nothing was sent. Use `Policy.none` for a single attempt, or supply a `while` classifier suited
to the operation's repeat semantics. Its `Reason` contains metadata and failures, not the request
method or decoded result; the method can be captured from the operation's known configuration.
Decisions that need the decoded value belong in the consumer's composition outside this classifier.

### Error and service types

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

Acquire it with `Interaction.make(execute)` inside a scope, then call `run(input)`. The [Interaction
guide](./modules/interaction.md) starts with sequential reuse before covering refresh and
cancellation.

### Reuse, replacement and lifetime rules

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
