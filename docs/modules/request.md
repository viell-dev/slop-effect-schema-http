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
`Request.make(method, url)` accepts another method string. `Request.baseUrl` lets several requests
share an origin and path prefix, as in the next example.

## Bind application input

Bindings say which parts of the call vary. A schema validates the application value and converts it
to the representation used by the service.

### Path and body

This request accepts a numeric user ID and a JSON body:

<<< ../../examples/modules/request.ts#inputs

`Schema.NumberFromString` has an application side of `number` and an encoded side of `string`.
Requests use the encoding direction: `42` becomes `"42"`. The path renderer receives that encoded
string; `encode(id)` escapes it as a path value. Return the complete request path from the renderer.
The base URL is joined afterwards.

`Request.body` accepts a [body encoder](./body.md). `Body.jsonSchema` validates the body and encodes
JSON, including its content type. The two bindings combine, so execution needs both `path` and
`body`.

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

The library renders URLs through [UrlEncoding](./url-encoding.md). Its defaults preserve entry
order, repetition, bare keys, and empty values. The HTTP provider can still normalize URLs; see [URL
processing](./url-encoding.md#advanced-url-processing).

Unrenderable URLs and unsupported body/method combinations fail with `Request.InvalidRequest`. GET
and HEAD require the encoder to produce `HttpBody.empty`, as `Body.empty` does; even a zero-length
text or byte body is rejected. Schema encoding errors remain distinct from `InvalidRequest` and
occur before dispatch.

### Lower-level preparation

`Request.materialize(request, input)` returns only the native request. `Request.compile` also
returns the header lines a supporting provider can send. The exported `Declaration`, `Draft`, and
`Compiled` types describe these stages; ordinary application code can use the combinators without
constructing them.

See the [request contract](../design.md#requests) for exact guarantees and the [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.1.0-rc.1/src/http/Request.ts)
for all types and overloads.
