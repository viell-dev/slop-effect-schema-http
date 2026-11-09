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
| `Body.urlEncoded`         | Effect `UrlParams.UrlParams`    | `application/x-www-form-urlencoded` |
| `Body.empty`              | `void`                          | None                                |

For `Body.urlEncoded`, construct values with `UrlParams.fromInput` from `effect/http`. `Body.empty`
sends no body and discards incoming bytes. It is useful for responses whose body your application
does not need, such as a successful deletion.

## Validate and transform another representation

### Add a schema to text

A service may return a number as plain text. Add a schema in the direction you need:

<<< ../../examples/modules/body.ts#text-schema

`Body.schema` validates and transforms the decoded value. `Body.encodeSchema` validates and encodes
application input before passing it to the underlying encoder. Each returns only that direction;
adding a decoding transform does not invent an inverse encoder.

A schema-backed body takes [either side of its schema](./request.md#a-schema-has-two-sides), or a
mix by field, and the underlying encoder receives what the schema writes. A plain object works for a
`Schema.Class`, including one nested in a struct, and a field with a constructor default can be left
out. An existing instance works as it is, and decoding still returns an instance. With
`Body.jsonSchema`, the encoded side is the schema's own: a `Schema.Date` field takes a `Date`, not
the ISO text the JSON carries. [Under a union](./request.md#under-a-union), a member that keeps
every field wins at any depth, and a field no member can keep is a `SchemaError`.

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

### Text, JSON, and finite-body limits

Fetch-backed `Body.text` decoding is lenient UTF-8: malformed bytes become replacement characters,
and charset parameters do not select another encoding. Use `Body.bytes` with an appropriate decoder
for strict or non-UTF-8 data.

`Body.json` follows Effect's JSON encoding, including an empty outgoing body for values that
`JSON.stringify` omits. An empty incoming body is a JSON decoding error. Choose `Body.jsonSchema` to
validate the application shape, or `Body.empty` for a response with no useful body.

Bodies are finite; streaming is outside the supported API. Even discarding an unmatched body can
wait forever if the server never ends it. Set a [timeout](./policy.md#bound-execution-time) when
completion is not guaranteed. See the [body contract](../design.md#bodies) and [source
signatures](https://github.com/viell-dev/slop-effect-schema-http/blob/0.11.0/src/http/Body.ts) for
precise behavior and generic types.
