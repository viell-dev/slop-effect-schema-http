import { Effect, Pipeable, Schema, Stream } from "effect";
import {
  HttpBody,
  HttpClientError,
  type HttpClientResponse,
  type UrlParams,
} from "effect/http";
import * as Inputs from "./internal/input.js";

/**
 * Turn an application value into a finite outgoing HTTP body.
 *
 * @remarks
 * Use with `Request.body`. Encoding occurs once per operation evaluation, before dispatch.
 */
export interface Encoder<in A, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly encode: (value: A) => Effect.Effect<HttpBody.HttpBody, E, R>;
}

/**
 * Read a finite response body into an application value.
 *
 * @remarks
 * Use with `Response.status` or `Response.when`. Read the body within the returned Effect;
 * `Operation.make` closes the attempt's resources before returning the decoded result.
 */
export interface Decoder<out A, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, E, R>;
  /** Contributes to automatic `Accept`; it does not validate response Content-Type. */
  readonly mediaType: string | undefined;
}

/**
 * An encoder and decoder for the same application value.
 *
 * @remarks
 * Encoding and decoding errors and required services are tracked separately. `In` is what encoding
 * takes, which is `A` unless the codec accepts more than it decodes to, as {@link jsonSchema} does.
 */
export interface Codec<
  A,
  EncodeError = never,
  DecodeError = never,
  EncodeServices = never,
  DecodeServices = never,
  In = A,
>
  extends
    Encoder<In, EncodeError, EncodeServices>,
    Decoder<A, DecodeError, DecodeServices> {}

/**
 * Create a custom outgoing body encoder from an Effect-returning function.
 *
 * @remarks
 * Return an Effect `HttpBody` with the representation and content metadata your service needs.
 */
export const encoder = <A, E = never, R = never>(
  encode: (value: A) => Effect.Effect<HttpBody.HttpBody, E, R>,
): Encoder<A, E, R> => ({
  ...Pipeable.Prototype,
  encode,
});

/**
 * Create a custom response-body decoder from an Effect-returning function.
 *
 * @remarks
 * `mediaType` contributes to automatic `Accept`; it does not validate response Content-Type.
 * Return typed failures through the Effect error channel; thrown exceptions are defects.
 */
export const decoder = <A, E = never, R = never>(
  decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, E, R>,
  mediaType?: string,
): Decoder<A, E, R> => ({ ...Pipeable.Prototype, decode, mediaType });

/**
 * Combine custom encoding and decoding functions into one body codec.
 *
 * @remarks
 * `mediaType` describes the accepted response representation. Outgoing content metadata comes
 * from the `HttpBody` returned by `encode`. `encode` may take more than `decode` returns.
 */
export const make = <
  A,
  EncodeError = never,
  DecodeError = never,
  EncodeServices = never,
  DecodeServices = never,
  In = A,
>(options: {
  readonly encode: (
    value: In,
  ) => Effect.Effect<HttpBody.HttpBody, EncodeError, EncodeServices>;
  readonly decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, DecodeError, DecodeServices>;
  readonly mediaType?: string | undefined;
}): Codec<A, EncodeError, DecodeError, EncodeServices, DecodeServices, In> => ({
  ...Pipeable.Prototype,
  encode: options.encode,
  decode: options.decode,
  mediaType: options.mediaType,
});

const decodeFailure = (
  response: HttpClientResponse.HttpClientResponse,
  cause: unknown,
) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({
      request: response.request,
      response,
      cause,
    }),
  });

/**
 * Read and write JSON without schema validation.
 *
 * @remarks
 * Encoding uses Effect's `HttpBody.json`. Values omitted by `JSON.stringify`, such as
 * `undefined`, produce an empty outgoing body. An empty incoming body is a decoding failure,
 * not `null`. Use {@link jsonSchema} to validate and transform application values.
 */
export const json: Codec<
  unknown,
  HttpBody.HttpBodyError,
  HttpClientError.HttpClientError
> = make({
  encode: (value: unknown) => HttpBody.json(value),
  decode: (response) =>
    Effect.flatMap(response.text, (text) =>
      Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (cause) => decodeFailure(response, cause),
      }),
    ),
  mediaType: "application/json",
});

/**
 * Read and write text, with `text/plain` as the media type.
 *
 * @remarks
 * Outgoing text is UTF-8. Incoming decoding delegates to the provider's `response.text`.
 * Fetch-backed providers ignore charset parameters, strip a leading UTF-8 BOM, and replace
 * malformed bytes with U+FFFD. Use {@link bytes} for strict or non-UTF-8 decoding.
 */
export const text: Codec<string, never, HttpClientError.HttpClientError> = make(
  {
    encode: (value: string) => Effect.sync(() => HttpBody.text(value)),
    decode: (response) => response.text,
    mediaType: "text/plain",
  },
);

/**
 * Read and write `Uint8Array` bodies as `application/octet-stream`.
 *
 * @remarks
 * Incoming bytes are buffered. Use a schema or custom decoder to interpret another encoding.
 */
export const bytes: Codec<Uint8Array, never, HttpClientError.HttpClientError> =
  make<Uint8Array, never, HttpClientError.HttpClientError>({
    encode: (value: Uint8Array) =>
      Effect.sync(() => HttpBody.uint8Array(value)),
    decode: (response) =>
      Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
    mediaType: "application/octet-stream",
  });

/**
 * Read and write Web `FormData` as multipart form data.
 *
 * @remarks
 * The transport supplies the outgoing multipart boundary and its Content-Type. A Content-Type the
 * request declares replaces it, and without the boundary the body cannot be read. Decoding
 * delegates to the HTTP provider.
 */
export const formData: Codec<FormData, never, HttpClientError.HttpClientError> =
  make({
    encode: (value: FormData) => Effect.sync(() => HttpBody.formData(value)),
    decode: (response) => response.formData,
    mediaType: "multipart/form-data",
  });

/**
 * Read and write form bodies using Effect's `UrlParams.UrlParams`.
 *
 * @remarks
 * Construct values with `UrlParams.fromInput` from `effect/http`. The media type is
 * `application/x-www-form-urlencoded`.
 */
export const urlEncoded: Codec<
  UrlParams.UrlParams,
  never,
  HttpClientError.HttpClientError
> = make({
  encode: (value: UrlParams.UrlParams) =>
    Effect.sync(() => HttpBody.urlParams(value)),
  decode: (response) => response.urlParamsBody,
  mediaType: "application/x-www-form-urlencoded",
});

const isEmptyBody = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "EmptyBodyError";

/**
 * Send no body, or discard an incoming body when its content is not needed.
 *
 * @remarks
 * Decoding drains even unexpected incoming bytes without buffering them. Draining has no
 * intrinsic timeout; use an attempt or operation timeout for an unbounded response.
 */
export const empty: Codec<void, never, HttpClientError.HttpClientError> = make({
  encode: () => Effect.succeed(HttpBody.empty),
  decode: (response) =>
    Stream.runDrain(response.stream).pipe(
      Effect.catchIf(isEmptyBody, () => Effect.void),
    ),
});

/**
 * Transform a decoded value with a pure function, preserving its media type.
 *
 * @remarks
 * Returns a decoder only. Use {@link mapEffect} if the transformation may fail or need services.
 */
export const map =
  <A, B>(f: (value: A) => B) =>
  <E, R>(self: Decoder<A, E, R>): Decoder<B, E, R> =>
    decoder((response) => Effect.map(self.decode(response), f), self.mediaType);

/**
 * Transform a decoded value with an Effect, adding its errors and required services.
 *
 * @remarks
 * Returns a decoder only and preserves the media type. When used in a response case, this work
 * is part of that attempt's decoding and is covered by its timeout.
 */
export const mapEffect =
  <A, B, E2, R2>(f: (value: A) => Effect.Effect<B, E2, R2>) =>
  <E, R>(self: Decoder<A, E, R>): Decoder<B, E | E2, R | R2> =>
    decoder(
      (response) => Effect.flatMap(self.decode(response), f),
      self.mediaType,
    );

/**
 * Validate and transform a decoded value with an Effect schema.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Body } from "viell-effect-schema-http";
 * const numberFromText = Body.text.pipe(Body.schema(Schema.FiniteFromString));
 * // Decodes the text "42" to the number 42.
 * ```
 *
 * @remarks
 * Returns a decoder with the schema's application type. A failure in a selected response case
 * is final for that attempt; it does not try a later response case.
 */
export const schema = <S extends Schema.Constraint>(contract: S) => {
  const decode = Schema.decodeUnknownEffect(contract);
  return <A, E, R>(
    self: Decoder<A, E, R>,
  ): Decoder<S["Type"], E | Schema.SchemaError, R | S["DecodingServices"]> =>
    self.pipe(mapEffect((value) => decode(value)));
};

/**
 * Validate and encode application input before passing it to a body encoder.
 *
 * @remarks
 * The schema's encoded type must match the underlying encoder's input. Returns an encoder only;
 * use {@link schema} for the decoding direction. The input takes either side of the schema, or a
 * mix by field, as `Request.Input` describes, so a plain object works for a `Schema.Class`, and
 * the underlying encoder receives what the schema writes.
 */
export const encodeSchema = <S extends Schema.Top>(contract: S) => {
  const encode = Inputs.encoder(contract, Schema.encodeEffect(contract));
  return <E, R>(
    self: Encoder<S["Encoded"], E, R>,
  ): Encoder<
    Inputs.Input<S>,
    E | Schema.SchemaError,
    R | S["EncodingServices"] | S["DecodingServices"]
  > =>
    encoder((value: Inputs.Input<S>) =>
      Effect.flatMap(encode(value), self.encode),
    );
};

/**
 * Read and write schema-validated JSON, returning the schema's application type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Body } from "viell-effect-schema-http";
 * const user = Body.jsonSchema(Schema.Struct({ id: Schema.Number, name: Schema.String }));
 * ```
 *
 * @remarks
 * Uses `Schema.toCodecJson` to obtain the schema's canonical JSON codec. Encoding failures occur
 * before dispatch; an operation wraps response decoding failures in `Response.DecodeError`.
 *
 * Encoding takes either side of the schema, or a mix by field, as `Request.Input` describes, and
 * writes the canonical JSON. The encoded side is the schema's own, so a `Schema.Date` field takes a
 * `Date`, not the ISO text JSON carries. Decoding returns the schema's application type, so a class
 * comes back as an instance.
 */
export const jsonSchema = <S extends Schema.Top>(
  contract: S,
): Codec<
  S["Type"],
  Schema.SchemaError | HttpBody.HttpBodyError,
  Schema.SchemaError | HttpClientError.HttpClientError,
  S["EncodingServices"] | S["DecodingServices"],
  S["DecodingServices"],
  Inputs.Input<S>
> => {
  const codec = Schema.toCodecJson(contract);
  const encode = Inputs.encoder(contract, Schema.encodeEffect(codec));
  return make({
    encode: (value: Inputs.Input<S>) =>
      Effect.flatMap(encode(value), json.encode),
    decode: json.pipe(schema(codec)).decode,
    mediaType: json.mediaType,
  });
};
