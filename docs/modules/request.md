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

A header schema on such a request has to allow these headers. [A schema states the
shape](#a-schema-states-the-shape-of-its-group) of its group, whichever comes first.

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
| `Request.query(schema)`        | `query`        | Its query entries, and the shape of that group    |
| `Request.headers(schema)`      | `headers`      | Its header lines, and the shape of that group     |
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

A header keeps the spelling you wrote, and a `setHeader` that replaces a line takes the new
spelling. A provider that sends header lines receives that spelling; `fetch` sends lowercase names.

These helpers also work on a request with a schema bound, within [the shape that schema
states](#a-schema-states-the-shape-of-its-group).

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

### A schema states the shape of its group

A header or query group is a dictionary of names, and each edit produces a new one. A schema states
what that dictionary may hold, and whatever the request ends up declaring has to fit. A request that
does not fit fails with `Request.InvalidRequest` before anything is sent, whichever comes first, the
schema or the raw value. Path and body bindings add their own input properties.

<<< ../../examples/modules/request.ts#shape

Each rule below applies to query entries, including those written in the constructor, and to
headers:

| The request declares                                    | What happens                                              |
| ------------------------------------------------------- | --------------------------------------------------------- |
| A raw value under a name a schema allows                | A default: what the schema writes replaces it             |
| The same, and the caller leaves that optional field out | The default stays, and goes through the schema            |
| A raw value that does not fit the schema                | `InvalidRequest`                                          |
| A raw value under a name no schema allows               | `InvalidRequest`, an incompatible shape                   |
| A raw edit of a required field, after the schema        | `InvalidRequest`, because it could never reach the client |

A default goes through the schema with the rest of the group, and the request carries what the
schema writes. `?page=02` under a number field goes out as `page=2`, and order and header spelling
follow the schema. A check is only as strict as the schema, so `Schema.NumberFromString` accepts
`"two"` as `NaN` and `Schema.FiniteFromString` refuses it.

"Required" means the schema always writes the name. A required field with
`Schema.withConstructorDefault` needs no input and still cannot be removed. To give a required field
a value without asking the caller, use `Request.mapInput`.

The error names the fields and leaves out their values, because a default may be a credential. The
check runs when the request is prepared, so a mismatch compiles and then fails on every run. It does
not see what `Request.mapEffect` edits on the native request, what `transformClient` or a client
layer does afterwards, or text in the URL, such as a `?` in a base URL.

#### Stack schemas

A second `Request.query` or `Request.headers` adds its fields, and together the schemas state the
shape, so each can be a reusable transform. That also gives a variant its way to add to a typed
group: stack a small schema, then set the value.

```ts
import { Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const paged = Request.get("https://api.example.test/things").pipe(
  Request.query(Schema.Struct({ page: Schema.NumberFromString })),
);
const withFields = paged.pipe(
  Request.query(Schema.Struct({ fields: Schema.optional(Schema.String) })),
  Request.setQuery("fields", "id,name"),
);
// Input: { query: { page: 1 } }; URL query: ?page=1&fields=id%2Cname
```

Typing part of a raw group takes the same care. Binding a schema for `cursor` onto a request with a
raw `?page=1&limit=25` is refused until a schema also allows `page` and `limit`, or they are
removed.

Where several schemas allow the same name, keep it in a shared constant rather than restating it, as
`ApiHeaders` does above. A record or `Schema.StructWithRest` allows any name, and still checks each
value. Callers can then pass any name as well.

#### Start again with unbind

`Request.unbind(group)` removes that group's earlier bindings, their input type and the shape they
state. It takes `"path"`, `"query"`, `"headers"` or `"body"`. Replacing a binding is `unbind`
followed by a new one:

<<< ../../examples/modules/request.ts#unbind

Raw values stay, and go out unchecked until a new schema states a shape. After `Request.mapInput`,
the binding is skipped, but the mapped input keeps whatever the mapping requires, and a request's
error and service types keep what a removed binding added.

#### Keep a value away from callers

Allowing a name also offers it to callers: the `authorization` field above lets a caller replace the
shared token. To keep a value out of the caller's hands, fix it with `Request.mapInput`, so the
field never reaches the input type, or supply it in `transformClient` or a client layer, so it is
not on the request description at all.

### A request's own headers win

The library sets three headers by itself: `Accept` from the response contract, and `Content-Type`
and `Content-Length` from the body encoder. A request that declares nothing keeps these automatic
values. A request's own declaration wins, from a raw setter or a header schema, whether it comes
before or after the body:

```ts
import { Body, Request } from "viell-effect-schema-http";

const upload = Request.post("/upload").pipe(
  Request.body(Body.text),
  Request.setHeader("Content-Type", "application/vnd.example+text"),
  Request.removeHeader("Accept"),
);
```

`Request.removeHeader(name)` stops the automatic value. It stops only the library's own value: a
later declaration, a header schema's output or a `Request.mapEffect` edit still goes out, and the
client may add its own. With a value argument it removes matching declarations and stops nothing. An
optional schema field the caller leaves out counts as nothing declared, so the automatic value still
applies, unless a `removeHeader` before the schema stopped it.

A declaration does not change the bytes the encoder produced. See [body
metadata](./body.md#body-metadata) for multipart and `Content-Length`.

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

A query written in the URL is passed to the client as written until something edits that entry or a
schema covers it, so `?a=1;b=2` and `?q=a+b` keep their spelling. `setQuery`, `appendQuery` and
`removeQuery` address an entry by its decoded name, and leave the other entries as they are. See
[constructor URLs](./url-encoding.md#constructor-urls).

A fragment stays on the request. The compiled request holds it in `request.hash`, exactly as
written, and the query goes before it. A constructor fragment survives `Request.path` and query
edits, and `Request.mapEffect` with `HttpClientRequest.removeHash` removes it, after which a
fragment in the base URL or path output applies. Whether it goes out is up to the client: `fetch`
does not send one. See [fragments](../design.md#fragments-stay-on-the-request).

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
