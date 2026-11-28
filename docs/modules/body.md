# Body

`Body` reads and writes finite HTTP bodies. An **encoder** turns an application value into an
outgoing body. A **decoder** reads an incoming body into an application value. A **codec** combines
both directions. Use encoders with [Request](./request.md) and decoders with
[Response](./response.md).

## Start with JSON and a schema

`Body.jsonSchema` checks values against an Effect schema in both directions:

<<< ../../examples/modules/body.ts#imports

<<< ../../examples/modules/body.ts#json

Pass the request and response to `Operation.make` to execute them. Invalid request input fails
before dispatch. Invalid response data fails during decoding and is returned by the operation as
`Response.DecodeError`.

## Choose a representation

Use the codec that matches what the service sends or accepts:

| Codec                     | Application value               | Media type                          |
| ------------------------- | ------------------------------- | ----------------------------------- |
| `Body.jsonSchema(schema)` | Either side of the schema       | `application/json`                  |
| `Body.json`               | `unknown`; no schema validation | `application/json`                  |
| `Body.text`               | `string`                        | `text/plain`                        |
| `Body.bytes`              | `Uint8Array`                    | `application/octet-stream`          |
| `Body.formData`           | Web `FormData`                  | `multipart/form-data`               |
| `Body.urlEncoded`         | Effect `UrlParams`, or a record | `application/x-www-form-urlencoded` |
| `Body.empty`              | `void`                          | None                                |

`Body.urlEncoded` writes `UrlParams` from `effect/http`, a record of fields, field pairs or
`URLSearchParams`, and reads `UrlParams`. `Body.empty` sends no body and discards incoming bytes. It
is useful for responses whose body your application does not need, such as a successful deletion.

## Validate and transform another representation

### Add a schema to text

A service may return a number as plain text. Add a schema in the direction you need:

<<< ../../examples/modules/body.ts#text-schema

`Body.schema` validates and transforms the decoded value. `Body.encodeSchema` validates and encodes
application input before passing it to the underlying encoder. Each returns only that direction;
adding a decoding transform does not invent an inverse encoder.

A schema-backed body takes [either side of its schema](./request.md#a-schema-has-two-sides), and the
underlying encoder receives what the schema writes. Under the decoded names, each field's value can
be on either side; a renamed field under its wire name makes the whole object encoded. A plain
object works for a `Schema.Class`, including one nested in a struct, and a field with a constructor
default can be left out. An existing instance works as it is, and decoding still returns an
instance. With `Body.jsonSchema`, the encoded side is the schema's own: a `Schema.Date` field takes
a `Date`, not the ISO text the JSON carries. [Under a union](./request.md#under-a-union), a member
that keeps every field wins at any depth, and a field no member can keep is a `SchemaError`.

`Body.jsonSchema` uses the schema's canonical JSON codec (`Schema.toCodecJson`). Use the text/bytes
combinators when your service needs another representation. Effect's [Schema
guide](https://effect.website/docs/v4/schema/introduction) explains application and encoded types.

### Map decoded values

Use `Body.map` for a pure transformation:

<<< ../../examples/modules/body.ts#map

Use `Body.mapEffect` when the transformation can fail or requires a service. Its function returns an
Effect, so a generator works there, here through `Effect.fn`:

<<< ../../examples/modules/body.ts#map-effect

Decoder errors and required services remain in the resulting types. In an operation, a failure here
is part of decoding, so it arrives as `Response.DecodeError` with this error as its cause. Both
transformations preserve the decoder's media type, which contributes to the operation's automatic
`Accept` header.

## Advanced codecs and body behavior

### Custom encoders and decoders

`Body.encoder(encode)` takes a function returning an `Effect` of Effect's `HttpBody`.
`Body.decoder(decode, mediaType?)` takes a function that reads an Effect `HttpClientResponse` and
returns an `Effect` of the decoded value. `Body.make({ encode, decode, mediaType })` combines both
directions. These are the extension points for service-specific formats.

Return decoding failures through the Effect error channel so the operation can wrap them in
`Response.DecodeError`. A thrown exception is an Effect defect. Read the finite body within the
decoder; the operation releases the attempt's resources before returning its result.
[Recipes](../recipes.md#a-list-with-a-count-header-and-an-empty-response) show decoders that read a
header as well as the body.

### Body metadata

The encoder supplies outgoing `Content-Type` and `Content-Length`. Multipart form data delegates
both to the HTTP transport, which supplies the boundary. A request's own declaration wins over these
automatic values, and `Request.removeHeader` stops them; see [declared
headers](./request.md#a-request-s-own-headers-win).

Neither changes the bytes a codec produced. A declared `Content-Type` on multipart form data
replaces the transport's, and without the boundary the body cannot be read. A declared
`Content-Length` that disagrees with the body is [passed to the client as
written](../limits.md#paths-and-other-requests-passed-on-as-written). Effect's Fetch client takes a
non-empty one off, so `fetch` sends the body's real length. A client that does send it can fail or
stall on it, so a request that depends on one needs a provider that can send it and a
[timeout](./policy.md#bound-execution-time).

A decoder's `mediaType` contributes to `Accept`; it does not itself check the response's
`Content-Type`. If that header determines how to read the answer, select a decoder with
[`Response.when`](./response.md#select-by-headers-or-other-metadata).

### Optional fields and numbers

Under `Body.jsonSchema`, the schema writes each field before the [JSON
writer](#text-json-and-finite-body-limits) sees it, so the field's schema decides what an absent or
non-finite value becomes. Given `{ note: undefined }`:

| Field schema                        | JSON body                     | Query or header               |
| ----------------------------------- | ----------------------------- | ----------------------------- |
| `Schema.optional(Schema.String)`    | `{"note":null}`               | Left out                      |
| `Schema.optionalKey(Schema.String)` | `Expected string at ["note"]` | `Expected string at ["note"]` |
| `Schema.UndefinedOr(Schema.String)` | `{"note":null}`               | Left out                      |
| `Schema.Any`, or `Body.json`        | `{}`                          | Left out                      |

To leave a field out of the JSON, leave out its key: under `Schema.optional` or
`Schema.optionalKey`, `{}` sends `{}`. `Schema.NullOr(Schema.String)` given `null` writes
`{"note":null}`.

`Schema.Number` accepts `NaN`, `Infinity` and `-Infinity`, and its JSON codec writes them as text,
so `{ v: NaN }` sends `{"v":"NaN"}` and a query sends `?v=NaN`. When such a value must not be sent,
use `Schema.Finite`, which refuses it with `Expected a finite number`, or a check such as
`Schema.Int`. The writer's own refusal of a non-finite number applies to a number a schema passes on
as a number, as `Body.json` and a `Schema.Any` field do.

### Free-form metadata fields

A field that holds whatever the application puts there, such as metadata, needs an open schema. The
choice decides what is converted and how a refusal reads:

<<< ../../examples/modules/body.ts#free-form

| Value in the field           | `Schema.Any`, or `Body.json`                | `Schema.Unknown`                   | `Schema.Record(String, Unknown)`                                                                                  |
| ---------------------------- | ------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| JSON values                  | Written                                     | Written                            | Written                                                                                                           |
| A `Date`, at any depth       | ISO text, through its `toJSON`              | `Expected JSON value` at the field | As the field: `The schema cannot keep this Date as a record`; deeper: `Expected JSON value` at the record's field |
| A class instance with fields | Its fields                                  | `Expected JSON value` at the field | Its fields                                                                                                        |
| `Option.some(1)`             | `{"_id":"Option","_tag":"Some","value":1}`  | `Expected JSON value` at the field | `{"value":1}`: its own fields, so the tag is lost                                                                 |
| A field set to `undefined`   | Left out                                    | `Expected JSON value` at the field | `Expected JSON value` at the record's field                                                                       |
| `NaN`, or a bigint           | `HttpBodyError` at its position             | `Expected JSON value` at the field | `Expected JSON value` at the record's field                                                                       |
| A `Map`                      | `HttpBodyError`: `cannot encode Map`        | `Expected JSON value` at the field | `The schema cannot keep this Map as a record`                                                                     |
| A `Uint8Array`               | `HttpBodyError`: `cannot encode Uint8Array` | `Expected JSON value` at the field | Its positions, as `{"0":1}`                                                                                       |

Use `Schema.Any` to let the JSON writer convert values through `toJSON`, such as a `Date` or an
`Option`, and refuse what it cannot write with `HttpBodyError` at its exact position, such as
`$["meta"]["tags"]`. Use `Schema.Unknown` when the value must already be JSON: it refuses anything
else with a `SchemaError` that names the field holding the open value, not the position inside it. A
string-keyed record rebuilds an object from its own fields, so it drops what is not in them, such as
an `Option`'s tag.

### Text, JSON, and finite-body limits

Fetch-backed `Body.text` decoding is lenient UTF-8: malformed bytes become replacement characters,
and charset parameters do not select another encoding. Use `Body.bytes` with an appropriate decoder
for strict or non-UTF-8 data.

`Body.json`, `Body.jsonSchema`, and encoders composed from `Body.json` use the same JSON writer. It
honours `toJSON` and checks what that conversion returns. Under `Body.jsonSchema` it receives what
the schema's JSON codec wrote, so these checks reach the values a schema passes on unconverted, as
`Body.json` and a `Schema.Any` field do. Before anything is sent, it refuses with `HttpBodyError`
naming the position:

- non-finite numbers, bigints, functions and symbols;
- `undefined` in an array, including a hole and a `toJSON` that returns `undefined`;
- defined enumerable symbol fields, and an array's own fields beside its positions;
- objects whose content is not in their own fields, such as a `Map`, a `Set`, binary data, a
  `RegExp`, an `Error`, `URLSearchParams`, `FormData`, `Headers`, a `Blob` or a boxed symbol.

A schema's codec converts first: `Schema.Number` writes `NaN` as the text `"NaN"`, which the writer
accepts, as [Optional fields and numbers](#optional-fields-and-numbers) shows.

Plain objects, class instances and `Schema.Class` values write their fields, and values such as
`Option`, `Chunk` and `DateTime` write what their `toJSON` returns. So does a `Redacted`, whose
`toJSON` returns `"<redacted>"` rather than its value. Under `Body.jsonSchema`, a `Schema.Redacted`
field writes the value itself. An invalid `Date` writes `null`, which is its own `toJSON` result.
The writer leaves out an object field whose value is `undefined`, so under `Body.json` or a
`Schema.Any` field `{ a: undefined }` becomes `{}`; a schema field can write `null` before the
writer sees it. It encodes top-level `undefined` as an empty outgoing body. Exceptions thrown by
getters, proxies and `toJSON` are defects.

An open schema that rebuilds an object from its own fields, as `Schema.ObjectKeyword` and a
string-indexed record do, refuses with `SchemaError` instead a built-in whose content is not in its
own fields, such as a `Map`, a `Set`, an `ArrayBuffer`, a `DataView` or a `Date`. A typed array's
elements are its own fields, so such a schema writes `new Uint8Array([1])` as `{"0":1}`. Not covered
is a symbol inside a declaration's type parameter, such as a record in an `Option`. The checks add
no nesting limit of their own. Nesting deeper than the engine's own `JSON.stringify` allows fails
with `HttpBodyError` too. That limit depends on the engine and its stack: Node 24 on Windows stops
at about 4,700 levels, while Node 26 on Linux writes over a million. An empty incoming body is a
decoding error. Choose `Body.jsonSchema` to validate the application shape, or `Body.empty` for a
response with no useful body.

Use `Body.formData.pipe(Body.encodeSchema(Schema.fromFormData(fields)))` when a schema supplies the
form entries. The form writer accepts text, files and blobs, including repeated values and nested
fields using bracket paths. An empty list or plain object writes no entries. If a value cannot
supply a form entry, it refuses with `HttpBodyError` naming the field. For example, a number needs a
schema that encodes it to text, and a `Redacted` value one that reveals its text. A prepared
`FormData` can go directly to `Body.formData`, including one from another realm or implementation,
such as the `undici` package used with its own `fetch`. Anything that is not a form fails with
`HttpBodyError`.

A schema supplies a URL-encoded form the same way, through `Body.encodeSchema`:

<<< ../../examples/modules/body.ts#url-encoded

`Body.urlEncoded` writes text, numbers, bigints and booleans, or redacted ones, as their text. A
list writes repeated names and a nested record bracket names, as `UrlParams.fromInput` reads them. A
value that reading would drop or write as something else, such as `null` or a `Date`, and a
malformed pair fail with `HttpBodyError` naming the field.

`Body.text`, `Body.bytes` and `Body.empty` also fail with `HttpBodyError` when JavaScript or a
schema such as `Schema.Any` passes them a value that is not a string, not a `Uint8Array`, or any
value at all, instead of converting or dropping it.

Bodies are finite; streaming is outside the supported API. Even discarding an unmatched body can
wait forever if the server never ends it. Set a [timeout](./policy.md#bound-execution-time) when
completion is not guaranteed. See the [body contract](../design.md#bodies) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.20.1/src/http/Body.ts) for
precise behavior and generic types.
