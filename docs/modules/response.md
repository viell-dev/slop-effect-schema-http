# Response

`Response` describes the answers your application understands. It chooses a body decoder from the
HTTP status and other metadata, then returns a typed value. Pair it with a request using
[Operation](./operation.md).

## Start with one status

Declare the status and body format you expect:

<<< ../../examples/modules/response.ts#imports

<<< ../../examples/modules/response.ts#simple

A valid 200 answer produces `{ id: number, name: string }`. A 200 answer with the wrong data fails
decoding. A status without a declared case is an `UnexpectedResponse`.

## Handle several outcomes

### Add an alternative

Use `Response.orElse` to add another case. Give each body's decoder a tag when callers need to tell
the outcomes apart:

<<< ../../examples/modules/response.ts#alternatives

`Response.tag` wraps a decoded value with `_tag` and `metadata`. TypeScript narrows `value` when you
check `_tag`. The metadata contains `status`, normalized `headers`, `cookies`, and optional original
`headerLines` supplied by the provider.

A declared 404 is a successful decoded outcome in this example. It does not automatically enter the
Effect error channel. Use [`Operation.mapEffect`](./operation.md#transform-a-successful-result) if
your application wants to turn that outcome into a domain error.

### Select by headers or other metadata

Use `Response.when` when status alone does not identify the representation:

<<< ../../examples/modules/response.ts#metadata

The predicate runs before the body is read. It can inspect metadata, including cookies and visible
headers, but cannot examine the payload. The example selects plain text regardless of a charset
parameter. A browser may hide headers; see [browser limits](../design.md#in-a-browser).

### Keep an otherwise-unmatched body

Add a final catch-all case when your application needs the text of unexpected answers:

<<< ../../examples/modules/response.ts#fallback

This returns an `Other` value instead of failing with `UnexpectedResponse`. Choose that behavior
deliberately: the application must decide what to do with the outcome and any sensitive content.

## Understand selection and failures

Cases are considered in declaration order. The first matching case wins, so put a general fallback
last. A 200 JSON case matches on status even if the payload is invalid JSON.

| Outcome                       | Meaning                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| Decoded value                 | A case matched and its decoder succeeded                         |
| `Response.DecodeError`        | The selected decoder failed, or an unmatched body's drain failed |
| `Response.UnexpectedResponse` | No case matched; the body was drained                            |

Both error classes carry `metadata`. `DecodeError.cause` keeps the decoder's typed error.

## Advanced response behavior

### Decoder failure never selects another case

`orElse` is a selection fallback, not recovery from a decoding error. If a selected 200 JSON decoder
fails, a later catch-all text decoder is not tried. For several payload shapes under the same
metadata, put a `Schema.Union` in one body decoder. This avoids rereading an already-consumed body
and keeps a contract mismatch visible.

### Accept headers and direct decoding

The operation collects decoder media types into an automatic `Accept` header, in declaration order
without duplicates. An explicitly declared request `Accept` takes precedence.

`Response.metadata(nativeResponse)` reads the metadata of an Effect response.
`Response.decode(contract, nativeResponse)` selects and runs its decoder directly. It is useful when
integrating an existing Effect HTTP response; the caller then owns the native response's resource
lifetime. `Operation.make` manages that lifetime for ordinary execution.

### Resource and content limits

An operation closes the attempt scope before returning or retrying. `UnexpectedResponse` retains
metadata, not the unmatched body. A decoder or native client error can nevertheless retain content
it read in its cause; avoid blindly logging whole errors.

Draining is not time-bounded by itself. Use an [attempt or operation
timeout](./policy.md#bound-execution-time) for a service that might never finish its body.

See the [response contract](../design.md#responses) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.1.0/src/http/Response.ts)
for the complete metadata and error types.
