# Transport

`Transport` preserves individual HTTP header lines for providers that can send or observe them.
Ordinary Fetch users can use [Request](./request.md) and [Response](./response.md) without this
module. Use it when implementing a custom Effect HTTP provider or integrating a protocol where
repeated lines matter.

## Start with the two header views

A normalized header value and the original header lines carry different information:

<<< ../../examples/modules/transport.ts#imports

<<< ../../examples/modules/transport.ts#views

`Transport.Lines` is an ordered array of name/value pairs. `Transport.entries` expands a supported
header collection without merging repetitions. `Transport.toHeaders` produces the lowercase,
comma-joined view used by Effect client middleware.

Lines keep the spelling they were written with, from `Request.setHeader`, `Request.appendHeader` and
header schemas alike. Comparing two names folds their case, so `Request.setHeader("X-Thing", …)`
replaces an earlier `x-thing` line. A header a schema covers takes the schema's spelling.

A comma in a value is not evidence of separate lines. The library never splits a normalized value to
guess the original representation.

## Integrate a provider

### Read request lines and attach observed response lines

An operation makes the request's header lines available during each attempt. A provider reads them
after native middleware has run. It can also attach the response lines it actually observed.

This in-memory example shows both boundaries without sending a network request:

<<< ../../examples/modules/transport.ts#provider

Replace the fixture's transport work with your native HTTP implementation. It must actually be able
to send and observe separate lines; adding metadata does not give Fetch that capability.

### Read the fragment

The compiled URL text holds no fragment, which stays in the native request's `hash` field. A
provider built with `HttpClient.make` receives a `URL` with the fragment back in place. `URL`
percent-encodes some characters, so read `request.hash` for the exact text. A provider built with
`HttpClient.makeWith` reads `request.url` directly, so it has to read `request.hash` as well or the
fragment is lost.

### Refuse CR and LF in a provider that writes bytes

The library does not refuse a carriage return or line feed in a URL, a header name or a header
value. It stays as permissive as possible on its own end, so this check belongs to the provider.
`fetch` and `node:http` do not put them on the wire. A provider that writes bytes itself must refuse
them: otherwise a value taken from user input can add a header or split a request.

### Read response metadata

`Transport.responseHeaderLines(nativeResponse)` returns an Effect `Option` of the attached lines.
`Response.metadata` exposes the same value as `headerLines`; `Response.tag` includes that metadata
with the decoded result. `None` means the provider supplied no line information. It does not mean
the response had no headers.

Normalized response headers remain available independently. `withResponseHeaders` attaches a
snapshot of lines to the supplied response object and returns that same object. This mutates the
response's attached metadata; it does not rewrite its normalized headers or alter the bytes
received.

## Advanced interoperability

### Reconcile middleware changes

`Transport.headerLines(request)` reads `Transport.HeaderLines` from the current Effect context and
reconciles it with the native request. It preserves original lines for each field whose normalized
value is unchanged. Changed or added fields use the middleware's current normalized values; removed
fields disappear.

`Transport.reconcile(lines, headers)` exposes that pure calculation. Prefer `headerLines` inside a
provider so that operation context and middleware changes are both considered. Outside an operation,
the context reference defaults to no original lines, so only the native request view is available.

### Provider and browser limits

The library preserves the information it has; it cannot reconstruct lines a provider has already
merged or hidden. Browser Fetch also controls cookies, restricted headers, CORS visibility and
redirect metadata. Supplying a schema does not recover those hidden values. See [browser
limits](../design.md#in-a-browser).

See the [wire-representation contract](../design.md#wire-representations-stay-distinct) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.2.0/src/http/Transport.ts)
for the complete input and line types.
