# Request

`Request` describes an outgoing HTTP request: its method, URL, fields, and the application input
needed to construct them. Build a description once and reuse it with different input. Creating a
request sends nothing; [Operation](./operation.md) sends it through your application's HTTP client.

## Start with a fixed request

Use a method helper, then add fixed query parameters or headers with `pipe`:

<<< ../../examples/modules/request.ts#imports

<<< ../../examples/modules/request.ts#simple

`Request.compile` evaluates the description and returns the native request plus its header lines. It
is useful for inspecting a request without sending it. A request with no bound input accepts
`undefined`.

The method helpers are `get`, `post`, `put`, `patch`, `del`, `head`, and `options`.
`Request.make(method, url)` accepts another method string.

## Share an API base and defaults

Define the origin and any fixed prefix once, then reuse that transformation across endpoints:

<<< ../../examples/modules/request.ts#shared-base

`api` applies the base URL to a request. It works with any method, and the base can include a long
hostname and a prefix such as `/api/v1`. Each endpoint only needs its own path.

Use Effect's `flow` to combine reusable transformations. Requests are immutable, so deriving one
with a different header leaves the original intact:

<<< ../../examples/modules/request.ts#shared-defaults

This helper supplies raw headers before any header schema is bound. A header schema owns its whole
group; [schema ownership](#a-schema-owns-its-whole-field-group) explains that boundary.

## Bind application input

Bindings say which parts of the call vary. A schema validates the application value and converts it
to the representation used by the service.

### Path and body

This request accepts a numeric user ID and a JSON body:

<<< ../../examples/modules/request.ts#inputs

`Schema.NumberFromString` has an application side of `number` and an encoded side of `string`.
Requests use the encoding direction: `42` becomes `"42"`. The path renderer receives that encoded
string; `encode(id)` escapes it as a path value. The renderer supplies the whole request path and
replaces the path passed to `Request.patch`, so the example starts with `""`. The base URL is joined
afterwards. It does not need to be repeated inside the renderer.

`Request.body` accepts a [body encoder](./body.md). `Body.jsonSchema` validates the body and encodes
JSON, including its content type. The two bindings combine, so execution needs both `path` and
`body`.

The path schema determines the value under `path`. A scalar schema gives `path: 42`; a
`Schema.Struct({ userId: Schema.NumberFromString })` gives `path: { userId: 42 }`. The renderer's
parameter name does not change that input type. Use a struct to name a single ID or group several
path values. The [usage guide](../usage.md#understand-the-input-type) shows the inferred operation
input; [nested resource paths](#compose-nested-resource-paths) demonstrate several named values.

### Query parameters and headers

Use schemas when the caller supplies a query or header group:

<<< ../../examples/modules/request.ts#query

The caller passes a number for `page`; the query schema encodes it to text. Header schemas work the
same way. Their encoded shapes must fit `Transport.HeaderInput`; query schemas must encode to
`UrlEncoding.QueryInput`.

| Binding                        | Input property | What it produces                                  |
| ------------------------------ | -------------- | ------------------------------------------------- |
| `Request.path(schema, render)` | `path`         | The renderer's path from the schema-encoded value |
| `Request.query(schema)`        | `query`        | The complete query group                          |
| `Request.headers(schema)`      | `headers`      | The complete header group                         |
| `Request.body(encoder)`        | `body`         | An encoded body                                   |

### Adapt your application's argument

Keep the HTTP contract while presenting a more convenient call shape:

<<< ../../examples/modules/request.ts#adapt

The same transformation works when this request is passed to `Operation.make`. Its `execute` method
then takes `{ id, name }`.

## Set, append, and remove fixed fields

Use the raw field helpers when a schema is unnecessary:

| Headers                      | Query                       | Behavior                                          |
| ---------------------------- | --------------------------- | ------------------------------------------------- |
| `setHeader(name, value)`     | `setQuery(name, value)`     | Replace the named field                           |
| `appendHeader(name, value)`  | `appendQuery(name, value)`  | Add a line or entry, preserving repetition        |
| `removeHeader(name, value?)` | `removeQuery(name, value?)` | Remove the field, or only entries with that value |

A value can be a string or a function evaluated during request preparation. `undefined` omits it.
Query values also accept `null` for a bare key such as `?preview`; `""` produces `?preview=`. Header
names compare without case; query names compare with case.

## Compose nested resource paths

When endpoints share several parent resource IDs, reuse schema fields and a path-rendering function.
Each endpoint binds one complete path schema. The calendar endpoint and its event endpoint can share
the same parent path:

<<< ../../examples/modules/request.ts#nested-paths

The event call supplies all five IDs. Each value is escaped separately, so an ID containing `/`
stays one path value:

<<< ../../examples/modules/request.ts#nested-input

Pass these request descriptions to `Operation.make` with the responses each endpoint accepts. The
shared `calendarPath` function defines the parent structure once; a new child endpoint only adds its
own suffix. Use the supplied `encode` function for each dynamic value, leaving the path separators
themselves unescaped.

This is ordinary function composition in your application. The library has no combinator that joins
two `Request` values or appends a typed path binding to another. Repeating `Request.path` replaces
the rendered path instead of adding a child. A single shared `Request.baseUrl` handles the fixed
prefix; reusable renderers handle the variable resource hierarchy.

## Advanced behavior

### A schema owns its whole field group

Binding a header or query schema replaces that group's raw declarations, including parameters in the
constructor URL. It does not merge them with the schema's output. The type system prevents raw
setters or another schema from being applied to that group afterwards. Put any required fixed values
in the schema input or adapt the invocation with `mapInput`.

Path and body bindings add their own input properties. The body codec controls `Content-Type` and
`Content-Length`; a header declaration cannot relabel a body. See [body
metadata](./body.md#body-metadata).

### Effectful preparation and per-attempt changes

`Request.mapEffect((nativeRequest, input) => effect)` edits Effect's native request. It runs once
per operation evaluation, before attempts begin. At that point, the base URL and query rendering are
not final. Use it for preparation that should be shared by every retry.

Use [Operation's client transformation](./operation.md#client-middleware) for credentials or
signatures that must change per attempt. Input encoding and computed raw fields otherwise happen
only once per evaluation.

### URL and method limits

`Request.baseUrl` sets one base URL; calling it again replaces that base rather than extending it.
With the default URL encoding, an absolute request URL bypasses the base. A relative path is
appended to the base; a leading `/` does not discard the base's path prefix.

The library renders URLs through [UrlEncoding](./url-encoding.md). Its defaults preserve entry
order, repetition, bare keys, and empty values. The HTTP provider can still normalize URLs; see [URL
processing](./url-encoding.md#advanced-url-processing).

Unrenderable URLs fail with `Request.InvalidRequest`. Schema encoding errors remain distinct from
`InvalidRequest` and occur before dispatch.

Any method can carry a body, including GET and HEAD. The library passes the request to the client
without a check of its own. `fetch` refuses a body on GET or HEAD, which surfaces as a transport
failure from the client. A service that needs one needs a provider that can send it.

### Lower-level preparation

`Request.materialize(request, input)` returns only the native request. `Request.compile` also
returns the header lines a supporting provider can send. The exported `Declaration`, `Draft`, and
`Compiled` types describe these stages; ordinary application code can use the combinators without
constructing them.

See the [request contract](../design.md#requests) for exact guarantees and the [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.1.0/src/http/Request.ts) for
all types and overloads.
