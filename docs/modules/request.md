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
shape](#a-schema-states-the-shape-of-its-group) of its group, whichever comes first. Reusable
transforms can grow into [a vocabulary for one API](../recipes.md#a-vocabulary-for-one-api).

### Extend a base

`Request.baseUrl` replaces the base, so a second level of prefix needs `Request.mapBaseUrl`. It
works on a request you have only as a value, such as an imported definition, and leaves that request
as it was:

<<< ../../examples/modules/request.ts#extend-base

The function gets the base as it stands at that step, so order matters: a later `Request.baseUrl`
replaces the result, and with no base set the function gets `""`. It gets the whole text, so what it
adds after a fragment in the base stays in that fragment. The same function can change a prefix
instead, as a `/v1` to `/v2` variant does. It runs when the request is prepared, and an exception
from it is a `Request.InvalidRequest`.

### Supply the base when the request runs

A location that is not known when the request is defined can come from an Effect, so definitions
stay plain importable values. The service arrives when the program runs, like the HTTP client:

<<< ../../examples/modules/request.ts#discovered-base

The request's type now holds whatever that Effect needs, so `listOrders` needs `ApiHost`, and
leaving it out is a compile error. A failure joins its error type in the same way. A service or a
`Config` value is itself an Effect, so `Request.baseUrl(ApiHost)` and
`Request.baseUrl(Config.String("API_BASE"))` work as they are. `Request.mapBaseUrl` works on this
form too, as the example shows.

The Effect runs once per evaluation, after the input is encoded and before the first attempt. What
it supplies is then treated exactly as text would be, including by a replaced
[`UrlEncoding.join`](./url-encoding.md#replace-one-encoding-rule). Three things follow:

- **Every retry goes to the same base.** To change the location between attempts, use
  [`transformClient`](./operation.md#client-middleware).
- **A failure stops the request.** It comes back as the Effect's own failure, with nothing sent, and
  a retry policy does not repeat it. An `attemptTimeout` does not limit it either; see [resource
  lifetime](./operation.md#resource-lifetime-and-cancellation). Apply retries and timeouts to the
  Effect itself.
- **It runs on every evaluation.** Look a location up once by doing it in the layer that provides
  the service, so each request only reads the answer. It also runs when an absolute request URL
  bypasses the base, because `UrlEncoding.join` decides that and has to receive one.

A later `Request.baseUrl` replaces the Effect, so it never runs, though the request's type keeps
what it added. Choose the form by when the location is known:

| The location                                      | Use                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Is fixed when the request is defined              | `Request.baseUrl("https://api.example.test")`                                 |
| Is known when the request runs, and stays for it  | `Request.baseUrl(effect)`                                                     |
| Must change between the attempts of a single call | [`transformClient` with the attempt number](./operation.md#client-middleware) |

## Bind application input

Bindings say which parts of the call vary. A schema validates the application value and converts it
to the representation used by the service.

### Path and body

This request accepts a numeric user ID and a JSON body:

<<< ../../examples/modules/request.ts#inputs

`Request.pathValue` declares a named value, and `Request.path` is a template that places it. The
text around `${userId}` is used exactly as written. The value's name is its field under `path`, so
the call passes `{ path: { userId: 42 } }`. Without a schema, a path value is a string.

`Schema.FiniteFromString` has an application side of `number` and an encoded side of `string`.
Requests use the encoding direction: `42` becomes `"42"`. [A schema-backed
input](#a-schema-has-two-sides) also takes `"42"`. The encoded value then goes through the [path
encoder](./url-encoding.md), so a `/` in a value stays part of that value. Only a path value can go
in a template, so a plain string there is a compile error, and neither step can be forgotten.

The template adds to the path passed to `Request.patch`, so the example starts with `""` and the
whole path reads in one place. The base URL is joined afterwards. It does not need to be repeated in
the template.

`Request.body` accepts a [body encoder](./body.md). `Body.jsonSchema` validates the body and encodes
JSON, including its content type. The two bindings combine, so execution needs both `path` and
`body`.

The [usage guide](../usage.md#understand-the-input-type) shows the inferred operation input; [nested
resource paths](#compose-nested-resource-paths) demonstrate several named values.

### Query parameters and headers

Use schemas when the caller supplies a query or header group:

<<< ../../examples/modules/request.ts#query

The caller passes a number for `page`, or [its encoded text](#a-schema-has-two-sides); the query
schema writes text. Header schemas work the same way. Their encoded shapes must fit
`Transport.HeaderInput`; query schemas must encode to `UrlEncoding.QueryInput`.

| Binding                          | Input property | What it produces                                     |
| -------------------------------- | -------------- | ---------------------------------------------------- |
| `` Request.path`/users/${id}` `` | `path`         | Its text, with each value encoded, added to the path |
| `Request.path(schema, render)`   | `path`         | The renderer's text, added to the path               |
| `Request.query(schema)`          | `query`        | Its query entries, and the shape of that group       |
| `Request.headers(schema)`        | `headers`      | Its header lines, and the shape of that group        |
| `Request.body(encoder)`          | `body`         | An encoded body                                      |

### Dates in a query

A query value is text, and a `Date` has an obvious text: ISO. So a query schema can encode to a
`Date`, and the request writes it with `toISOString()`:

<<< ../../examples/modules/request.ts#dates

A request carries a schema's encoded side, and the caller gives its decoded side, so such a schema
is easy to read backwards. `Schema.DateFromString` encodes to text and `Schema.Date` to a `Date`,
and both end up as the same text:

| Schema                                                                           | The caller gives       | The request carries |
| -------------------------------------------------------------------------------- | ---------------------- | ------------------- |
| `Schema.Date`                                                                    | A `Date`               | ISO text            |
| `Schema.DateFromString`                                                          | A `Date`, or its text  | ISO text            |
| A schema from `Date` to your own date type, such as `Schema.DateTimeUtcFromDate` | Your type, or a `Date` | ISO text            |

Each is a [schema-backed input](#a-schema-has-two-sides), so the last two take either side. An
invalid `Date` fails each of them with a `SchemaError`.

Headers stay text. Date headers such as `If-Modified-Since` use the HTTP date format, not ISO, so a
header schema has to write its own text, as `Schema.DateTimeUtcFromHttpDate` does.

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

`setHeader` and `setQuery` also take a plain object, which is the form to reach for when several
fields are fixed:

<<< ../../examples/modules/request.ts#plain-fields

Each key replaces that name, as the two-argument form does, in key order, and other names stay.

| Value                       | Query                                | Headers                    |
| --------------------------- | ------------------------------------ | -------------------------- |
| Text                        | `?name=text`                         | A line with that value     |
| A number, bigint or boolean | Written as text, in the object form  | Not accepted               |
| A `Date`                    | ISO text, in the object form         | Not accepted               |
| `""`                        | `?name=`                             | A line with an empty value |
| `null`                      | A bare key, `?name`                  | Not accepted               |
| An array                    | Repeats the name, in the object form | Use `appendHeader`         |
| A function                  | Evaluated during request preparation | The same                   |
| `undefined`                 | Removes that name's declarations     | The same                   |

Header names compare without case; query names compare with case. Use `appendQuery` for exact order
across repeated names. `undefined` declares nothing, so it stops no automatic value; that is what
`removeHeader` is for. An invalid `Date` has no ISO text, so it goes out as `Invalid Date` unless a
query schema refuses it.

A header keeps the spelling you wrote, and a `setHeader` that replaces a line takes the new
spelling. A provider that sends header lines receives that spelling; `fetch` sends lowercase names,
because [what a client does afterwards](../limits.md#paths-and-other-requests-passed-on-as-written)
is up to the client.

These helpers also work on a request with a schema bound, within [the shape that schema
states](#a-schema-states-the-shape-of-its-group).

## Compose nested resource paths

A child endpoint adds to its parent. Declare each value once, hold each level's template in a
variable, and add only what is new:

<<< ../../examples/modules/request.ts#nested-paths

`getEvent` is `getCalendar` with one more part, and `getCalendar` does not change. The input of each
is inferred from its templates. The event call supplies all four IDs. Each value is escaped
separately, so an ID containing `/` stays one path value:

<<< ../../examples/modules/request.ts#nested-input

Pass these request descriptions to `Operation.make` with the responses each endpoint accepts. A
single shared `Request.baseUrl` handles the fixed prefix, and the templates handle the resource
hierarchy.

Give each level its own field name. The same name at two levels is one input value that both
receive, and the same name with incompatible types makes the input impossible to supply, which shows
as a compile error at `execute`.

### Add to a path

The path is the constructor's path followed by what each `Request.path` adds, in order, joined
exactly as written. A fixed start can sit in the constructor, a value can stand inside a segment,
and fixed text is a template with no values:

<<< ../../examples/modules/request.ts#path-suffix

The library adds no `/` and removes none, so a slash at a boundary is yours to get right:

| Constructor           | Added             | Path                          |
| --------------------- | ----------------- | ----------------------------- |
| `/users`              | `/42`             | `/users/42`                   |
| `""`                  | `/users/1`        | `/users/1`                    |
| `https://api.test/v1` | `/users/1`        | `https://api.test/v1/users/1` |
| `/things/42`          | `:archive`        | `/things/42:archive`          |
| `/a`                  | `/b#x`, then `/c` | `/a/b`, with fragment `x/c`   |
| `/users/`             | `/42`             | `/users//42`                  |
| `/users`              | `42`              | `/users42`                    |

A convention keeps this simple, and the library works with any other:

- **Start each piece with `/`, and do not end one with `/`.** So `Request.get("/things")`,
  `` Request.path`/events` ``, and a renderer returning `` `/${encode(id)}` ``.
- **A base URL needs neither.** Joining it to the path handles that boundary, and puts a `/` before
  a path that has none. So with a base URL, write a query on its own in the constructor, as
  `Request.get("?wsdl")`, because a template would give `/?wsdl`.
- **A trailing slash is part of the address.** `/foo` and `/foo/` can be different resources, or the
  same resource read differently, so the library never adds or removes one. When a server wants one,
  put it at the very end, on the last piece.

The text between values is not parsed, so `:` and `'` need no escape, and a `\` is a backslash. A
`?` or `#` is ordinary URL syntax: anything after a `#` belongs to the fragment, as the table shows.
A constructor's query and fragment are kept apart from the path, so they survive `Request.path`.

The finished path is passed to the client as written. The library passes the request you declared to
the HTTP client you chose, and [its promise stops
there](../limits.md#paths-and-other-requests-passed-on-as-written). The client may rewrite or refuse
it, and a server may read it differently. The library does not promise that an unusual request
works. Node.js Fetch keeps `//` and a trailing slash and resolves dot segments. A server may merge
`//`, and another client can differ.

### Change a path in a variant

`Request.unbind("path")` removes what earlier `Request.path` calls added, both their text and their
input. The constructor's path stays until `Request.setPath` replaces it, and `setPath` leaves the
bindings in place, so a variant uses whichever it needs, or both to replace a whole path:

<<< ../../examples/modules/request.ts#path-variant

## Advanced behavior

### Paths whose shape depends on a value

A template has a fixed shape. Use a renderer when the shape itself depends on the value, as with a
value holding several segments, a whole URL, or a path that branches on a value. `Request.path`
takes a schema and a function, and adds what the function returns:

<<< ../../examples/modules/request.ts#path-renderer

The renderer receives the schema-encoded value and the active path encoder. Call `encode` on each
dynamic value and leave the separators unescaped. Nothing makes a renderer do that, which is why a
template is the first choice for a fixed shape.

The schema determines the value under `path`. A scalar schema takes a scalar, and a struct takes its
fields; a parameter name in the renderer changes nothing. A scalar has no name, so stacking it with
a template, or with a scalar of another type, makes the input impossible to supply. Use a struct for
a renderer that stacks.

A renderer's text is added like any other. After an empty constructor path, a whole URL is the
request URL, and it [bypasses the base](#url-and-method-limits). After other text it stays part of
the path, because `/fetch/https://other.test/x` is a legitimate path.

### Encoding does not make a value safe

Encoding stops a `/` in a value from adding a segment. It does not stop everything: `..` and an
empty string have nothing to encode, so they pass through, and so does a `'` inside
`` `Customers('${customer}')` ``. With Node.js Fetch, a `..` can leave the resource:
`/customers/../calendars/7` reaches the server as `/calendars/7`.

A value that comes from a user needs a constraint in its schema. `Schema.TemplateLiteral` states a
value's shape, and `Schema.String.check` with `Schema.isPattern` does the same for a pattern:

<<< ../../examples/modules/request.ts#path-constraint

### A schema has two sides

A schema's decoded side is what your application works with, and its encoded side is what goes on
the wire. A schema-backed input takes either side, or a mix by field, and the request always carries
what the schema writes:

<<< ../../examples/modules/request.ts#two-sides

This applies to `Request.path`, `Request.query`, `Request.headers`, `Body.jsonSchema` and
`Body.encodeSchema`. For this schema:

| The caller gives                               | Read as                    | The request carries                |
| ---------------------------------------------- | -------------------------- | ---------------------------------- |
| `{ from: date, limit: 5 }`                     | Decoded                    | `from=2026-11-07T12…&limit=5`      |
| `{ from: "2026-11-07T12:00:00Z", limit: "5" }` | Encoded, and decoded first | The same                           |
| `{ from: date, limit: "5" }`                   | A mix, field by field      | The same                           |
| `{ from: date, limit: "05" }`                  | A mix                      | `limit=5`, as the schema writes it |
| `{ from: date, limit: "many" }`                | Neither                    | `SchemaError`, before dispatch     |
| `{ from: date, limit: true }`                  | Neither                    | A compile error                    |

The decoded side is what the schema's constructor takes. A plain object works for a `Schema.Class`,
and a field with a constructor default can be left out. Preparation tries the decoded side first,
then the decoder as a whole, then the decoder field by field, and reports the decoded side's error
if all fail. The type of such an input is `Request.Input<S>`.

Both routes validate, so text cannot get past a schema. The check is as strict as the schema,
though. `Schema.NumberFromString` turns `"many"` into `NaN`, so `{ limit: "many" }` goes out as
`limit=NaN` under that schema. Choose `Schema.FiniteFromString` when that matters. A string where a
number was expected compiles, so the failure appears when the request is prepared. An input can need
the schema's decoding services as well as its encoding services, so a binding adds both to the
request.

#### When both sides share a type

A value that fits the decoded side is read as decoded, which is the one rule for a case that cannot
be told apart. Under a schema from text to text, such as `Schema.StringFromBase64`, an already
encoded value fits the decoded side, so it is encoded again, with no error:

<<< ../../examples/modules/request.ts#same-type

Under such a schema, pass the decoded value. Where a group has other fields, a group that only fits
on the encoded side goes through the decoder as a whole, so `{ token: "aGVsbG8=", limit: "5" }`
reads `token` as encoded.

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

A default under a field that encodes to a `Date` is read from its text, so `?from=2026-11-07` goes
out as `from=2026-11-07T00%3A00%3A00.000Z`, and `?from=soon` is an `InvalidRequest`. It is read as
`Schema.DateFromString` reads it, which is `new Date(text)`. Write ISO text with a `Z` or an offset:
JavaScript reads other forms by the engine's rules, and text with no offset in the time zone of
whatever runs the request.

"Required" means the schema always writes the name. A required field with
`Schema.withConstructorDefault` needs no input and still cannot be removed. To give a required field
a value without asking the caller, use `Request.mapInput`. A value the schema supplies itself, from
a constructor or decoding default, counts as written, so it replaces a raw default.

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
  Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
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

An open schema, such as a record, sees every field of the input, so its value type has to accept the
other schemas' fields.

#### Start again with unbind

`Request.unbind(group)` removes that group's earlier bindings, their input type and the shape they
state. It takes `"path"`, `"query"`, `"headers"` or `"body"`. Replacing a binding is `unbind`
followed by a new one:

<<< ../../examples/modules/request.ts#unbind

Raw values stay, and go out unchecked until a new schema states a shape. After `Request.mapInput`,
the binding is skipped, but the mapped input keeps whatever the mapping requires, and a request's
error and service types keep what a removed binding added. For a path, see [Change a path in a
variant](#change-a-path-in-a-variant).

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

`Request.mapEffect((nativeRequest, input) => effect)` edits Effect's native request. The function
returns an Effect, so it can read a service, and a generator works there:

<<< ../../examples/modules/request.ts#map-effect

It runs once per operation evaluation, before attempts begin. At that point, the base URL and query
rendering are not final. Use it for preparation that should be shared by every retry.

Use [Operation's client transformation](./operation.md#client-middleware) for credentials or
signatures that must change per attempt, which receives the attempt number. Input encoding, computed
raw fields and a [base URL from an Effect](#supply-the-base-when-the-request-runs) otherwise happen
only once per evaluation.

### URL and method limits

`Request.baseUrl` sets one base URL; calling it again replaces that base rather than extending it,
and [`Request.mapBaseUrl`](#extend-a-base) extends it. With the default URL encoding, an absolute
request URL bypasses the base. A relative path is appended to the base; a leading `/` does not
discard the base's path prefix.

The library renders URLs through [UrlEncoding](./url-encoding.md). Its defaults preserve entry
order, repetition, bare keys, and empty values. The HTTP provider can still normalize URLs; see [URL
processing](./url-encoding.md#advanced-url-processing).

A query written in the URL is [passed to the client as
written](../limits.md#paths-and-other-requests-passed-on-as-written) until something edits that
entry or a schema covers it, so `?a=1;b=2` and `?q=a+b` keep their spelling. `setQuery`,
`appendQuery` and `removeQuery` address an entry by its decoded name, and leave the other entries as
they are. See [constructor URLs](./url-encoding.md#constructor-urls).

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
constructing them. `declaration.baseUrl` is text or an Effect, so to change a base you hold only as
a request, use `Request.mapBaseUrl` rather than reading it.

See the [request contract](../design.md#requests) for exact guarantees and the [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.1.0/src/http/Request.ts) for
all types and overloads.
