# UrlEncoding

`UrlEncoding` controls how request path values, query entries, and base URLs become URL text. The
defaults work without any setup. Replace the policy when a service requires another spelling.

## Start with the defaults

Describe query values as data and let the request encode them:

<<< ../../examples/modules/url-encoding.ts#imports

<<< ../../examples/modules/url-encoding.ts#default

The defaults percent-encode path values and query keys/values with `encodeURIComponent`. Base URL
joining adds a slash at the boundary when needed; an absolute request URL takes precedence over the
base. A value in a `Request.path` template always goes through the path encoder, as shown in the
[Request guide](./request.md#path-and-body). A
[renderer](./request.md#paths-whose-shape-depends-on-a-value) calls the encoder it is given.

## Represent query entries

`queryEntries` expands a record or iterable of pairs into an ordered array. Arrays become repeated
entries, `null` means a bare key, and `undefined` omits an entry:

<<< ../../examples/modules/url-encoding.ts#entries

Numbers, bigints and booleans become strings, and a `Date` becomes its ISO text. An invalid `Date`
has no ISO text, so it goes out as `Invalid Date`, and a schema such as `Schema.Date` refuses it
before that. An empty string remains an empty value. Use an iterable of pairs when you need explicit
ordering across repeated names. The exported `QueryInput` type is also the encoded shape accepted by
a request query schema, so [a query schema can encode to a `Date`](./request.md#dates-in-a-query).

## Replace one encoding rule

Provide a layer around request compilation or operation execution. This policy spells spaces in
query fields as `+`, preserving the other default rules:

<<< ../../examples/modules/url-encoding.ts#custom

The replacement applies where the Effect is evaluated. You can provide it around a whole service
integration rather than one request at a time.

## Advanced URL processing

### Policy interface

| Member of `UrlEncoding.Service` | Input                                                    | Result                             |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `path(value)`                   | One schema-encoded path value                            | Escaped path text                  |
| `query(entries)`                | Ordered decoded query pairs, except text kept as written | Query text without the leading `?` |
| `join(base, path)`              | Base URL and rendered request path                       | Combined URL text                  |

`UrlEncoding.UrlEncoding` is an Effect context reference with `defaults` as its default value.
`UrlEncoding.layer(service)` supplies a replacement. Exceptions from rendering become
`Request.InvalidRequest`.

`join` receives the base and the path without their fragments. The compiled request keeps a fragment
in its `hash` field, so the query goes before it. See
[fragments](../design.md#fragments-stay-on-the-request).

### Constructor URLs

A query already in `Request.get("/search?q=Ada+Lovelace")` is [passed to the client as
written](../limits.md#paths-and-other-requests-passed-on-as-written) until something edits that
entry or a schema covers it. The `+` and any percent escapes keep their spelling, and so do empty
`&` segments and a lone `?`. The client can still process the URL afterwards.

Each entry also has a form-decoded name and value, so `Request.setQuery("q", "Grace Hopper")` edits
this one and leaves any other as written. An edited or added entry goes through `query`, which
receives only the entries that are not kept as written. Where written text stands between such
entries, each run of them is rendered by a separate call, so the query keeps its order. See the [URL
contract](../design.md#urls-are-made-sendable-not-normalized) for examples.

### Joining and provider normalization

Keep query parameters out of a base URL: the default join is a string join of an origin/path prefix
and a request path. Declare shared query fields with request combinators instead.

The default policy does not remove dot segments or empty path values. Effect's standard client
wrapper subsequently parses a URL with the platform's URL parser, which can normalize it. [Constrain
path input](./request.md#encoding-does-not-make-a-value-safe) or replace `path` when those values
are invalid for your application.

Native middleware that appends parameters through `URLSearchParams` can reserialize the whole query,
turning a bare `?preview` into `?preview=` or `%20` into `+`. Prefer request combinators when exact
distinctions matter; if middleware must edit the query, preserve existing text and encode its
addition deliberately.

See the [URL contract](../design.md#urls-are-made-sendable-not-normalized), [wire
representations](../design.md#wire-representations-stay-distinct), and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.16.0/src/http/UrlEncoding.ts)
for exact rules and types.
