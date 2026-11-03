# UrlEncoding

`UrlEncoding` controls how request path values, query entries, and base URLs become URL text. The
defaults work without any setup. Replace the policy when a service requires another spelling.

## Start with the defaults

Describe query values as data and let the request encode them:

<<< ../../examples/modules/url-encoding.ts#imports

<<< ../../examples/modules/url-encoding.ts#default

The defaults percent-encode path values and query keys/values with `encodeURIComponent`. Base URL
joining adds a slash at the boundary when needed; an absolute request URL takes precedence over the
base. For path values, call the encoder passed to the `Request.path` renderer, as shown in the
[Request guide](./request.md#path-and-body).

## Represent query entries

`queryEntries` expands a record or iterable of pairs into an ordered array. Arrays become repeated
entries, `null` means a bare key, and `undefined` omits an entry:

<<< ../../examples/modules/url-encoding.ts#entries

Numbers, bigints and booleans become strings. An empty string remains an empty value. Use an
iterable of pairs when you need explicit ordering across repeated names. The exported `QueryInput`
type is also the encoded shape accepted by a request query schema.

## Replace one encoding rule

Provide a layer around request compilation or operation execution. This policy spells spaces in
query fields as `+`, preserving the other default rules:

<<< ../../examples/modules/url-encoding.ts#custom

The replacement applies where the Effect is evaluated. You can provide it around a whole service
integration rather than one request at a time.

## Advanced URL processing

### Policy interface

| Member of `UrlEncoding.Service` | Input                              | Result                             |
| ------------------------------- | ---------------------------------- | ---------------------------------- |
| `path(value)`                   | One schema-encoded path value      | Escaped path text                  |
| `query(entries)`                | Ordered decoded query pairs        | Query text without the leading `?` |
| `join(base, path)`              | Base URL and rendered request path | Combined URL text                  |

`UrlEncoding.UrlEncoding` is an Effect context reference with `defaults` as its default value.
`UrlEncoding.layer(service)` supplies a replacement. Exceptions from rendering become
`Request.InvalidRequest`.

### Constructor URLs and opaque query text

A query already in `Request.get("/search?q=Ada+Lovelace")` is parsed as form data. The `+` becomes a
space and the default policy renders it as `%20`. Original percent-escape spelling is not kept. This
lets field combinators and query schemas work on one structured representation.

If a protocol requires opaque query text, start without query declarations and edit the native URL
using `Request.mapEffect`. Base joining and provider processing still apply afterwards. This is an
advanced escape hatch, not a way to disable the HTTP provider's URL handling.

### Joining and provider normalization

Keep query parameters out of a base URL: the default join is a string join of an origin/path prefix
and a request path. Declare shared query fields with request combinators instead.

The default policy does not remove dot segments or empty path values. Effect's standard client
wrapper subsequently parses a URL with the platform's URL parser, which can normalize it. Validate
path input or replace `path` when those values are invalid for your application.

Native middleware that appends parameters through `URLSearchParams` can reserialize the whole query,
turning a bare `?preview` into `?preview=` or `%20` into `+`. Prefer request combinators when exact
distinctions matter; if middleware must edit the query, preserve existing text and encode its
addition deliberately.

See the [URL contract](../design.md#urls-are-made-sendable-not-normalized), [wire
representations](../design.md#wire-representations-stay-distinct), and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.1.0-rc.1/src/http/UrlEncoding.ts)
for exact rules and types.
