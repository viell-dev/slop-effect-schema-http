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
your application wants to turn that outcome into a domain error. A contract is an ordinary value, so
[cases several operations share](../recipes.md#shared-error-cases) can be written once.

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

## Adjust a contract

A contract is a value. A variant of a shared contract usually needs a different success shape and
the same error cases, so you can change one case and keep the rest. The original never changes, and
[Operation](./operation.md#define-once-adjust-where-it-is-used) applies the same changes to a whole
definition.

Each case has a **key** that addresses it. A status case is keyed by its status.

### Replace a case

`Response.replace` gives a case a new decoder:

<<< ../../examples/modules/response.ts#replace

The case keeps its position and its match rule, because declaration order is priority. Only the
decoder changes. The contract's type holds only what can still occur, so the old result is gone, and
the [automatic `Accept`](#accept-headers-and-direct-decoding) follows the new decoder. If several
cases share a key, the first keeps its position and the others go.

### Remove a case

`Response.remove` drops every case with that key:

<<< ../../examples/modules/response.ts#remove

A matching response then falls through to any later case, and otherwise fails with
`UnexpectedResponse`. To add a case, use `Response.orElse`, or place the new case first.

### Name a `when` case

A status does not identify a `Response.when` case, so give it a `key` when it should be addressable:

<<< ../../examples/modules/response.ts#key

The key has no effect on selection. Tags are not keys: they label results, they are optional, and
they can repeat.

### What can be addressed

Only one literal key the contract declares can be addressed. Anything else is a compile error, so a
typo cannot leave the old case in place with no warning:

- **A key that is absent.** There is no case to change.
- **A key that is not a literal.** `Response.status(code, body)` with `code: number` does not say
  which case it is, and neither does passing such a key to `Response.replace`.
- **A union of keys.** A key typed `200 | 404` is refused, in the call or in the case itself. Only
  the value passed is touched at run time, so the type could not say which cases are left.

A key that gets past the types, through a cast or from JavaScript, throws when the contract is
built, rather than quietly changing nothing.

Annotating a value as `Response.Response<A, E, R>` drops its keys, so nothing can be replaced or
removed. That is one way for an author to seal a contract.

`flow` over `Response.replace` and `Response.remove` is a compile error on its own, because a key
can only be checked against a known contract. Chain them in a `pipe`, or start the `flow` with
`identity<typeof contract>`.

## Advanced response behavior

### Decoder failure never selects another case

`orElse` is a selection fallback, not recovery from a decoding error. If a selected 200 JSON decoder
fails, a later catch-all text decoder is not tried. For several payload shapes under the same
metadata, put a `Schema.Union` in one body decoder. This avoids rereading an already-consumed body
and keeps a contract mismatch visible.

### A contract's type names its cases

Two contracts with different cases are different types:

```ts
import { Body, Response } from "viell-effect-schema-http";

let contract = Response.status(200, Body.text);
// @ts-expect-error A 200 contract and a 201 contract are different types.
contract = Response.status(201, Body.text);
```

A conditional between two contracts is a union for the same reason, and `Operation.make` refuses it.
Choose the status instead, which gives one contract: `Response.status(legacy ? 200 : 201, body)`.
That case's key does not say which status it is, so it cannot be addressed. Annotating both as
`Response.Response<A, E, R>` also gives them one type.

### Accept headers and direct decoding

The operation collects decoder media types into an automatic `Accept` header, in declaration order
without duplicates. An explicitly declared request `Accept` takes precedence, and
`Request.removeHeader("accept")` stops the automatic value.

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
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.9.0/src/http/Response.ts)
for the complete metadata and error types.
