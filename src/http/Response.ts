import { Data, Effect, Option, Pipeable } from "effect";
import type {
  Cookies,
  Headers,
  HttpClientError,
  HttpClientResponse,
} from "effect/http";
import * as Body from "./Body.js";
import * as Transport from "./Transport.js";

/**
 * The status, headers and cookies available for selecting a response decoder.
 *
 * @remarks
 * Contains no body. Header and cookie visibility depends on the HTTP provider and browser.
 * `headerLines` is present only when a provider attached its observed lines.
 */
export interface Metadata {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly cookies: Cookies.Cookies;
  /** Provider-observed lines, when the provider supplied them. Normalized headers are always available. */
  readonly headerLines: Option.Option<Transport.Lines>;
}

/**
 * No response case matched, and the unmatched body was successfully drained.
 *
 * @remarks
 * Contains metadata only. A failed drain produces {@link DecodeError} instead.
 */
export class UnexpectedResponse extends Data.TaggedError("UnexpectedResponse")<{
  readonly metadata: Metadata;
}> {}

/**
 * A selected body decoder failed, or draining an unmatched body failed.
 *
 * @remarks
 * `cause` retains the underlying typed error; it may contain schema input or response content.
 * Selection does not fall through to a different case after this failure.
 */
export class DecodeError<out E> extends Data.TaggedError("DecodeError")<{
  readonly metadata: Metadata;
  readonly cause: E;
}> {}

/**
 * An ordered contract that chooses a body decoder from response metadata.
 *
 * @remarks
 * Build cases with {@link status} or {@link when}, then combine them with {@link orElse}.
 * A declared status, including 4xx or 5xx, returns the decoder's value if decoding succeeds.
 */
export interface Response<out A, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly select: (metadata: Metadata) => Option.Option<Body.Decoder<A, E, R>>;
  /** Media types contributed to the automatic `Accept` header, in declaration order. */
  readonly accepts: ReadonlyArray<string>;
}

/**
 * Read metadata from an Effect HTTP response without consuming its body.
 */
export const metadata = (
  response: HttpClientResponse.HttpClientResponse,
): Metadata => ({
  status: response.status,
  headers: response.headers,
  cookies: response.cookies,
  headerLines: Transport.responseHeaderLines(response),
});

const make = <A, E, R>(
  select: Response<A, E, R>["select"],
  accepts: ReadonlyArray<string>,
): Response<A, E, R> => ({
  ...Pipeable.Prototype,
  select,
  accepts,
});

/**
 * Select a body decoder when a predicate accepts the response metadata.
 *
 * @remarks
 * The predicate runs before body decoding. It cannot select by payload contents; use one schema
 * with alternatives for payloads sharing the same metadata.
 */
export const when = <A, E, R>(
  predicate: (metadata: Metadata) => boolean,
  body: Body.Decoder<A, E, R>,
): Response<A, E, R> =>
  make(
    (info) => (predicate(info) ? Option.some(body) : Option.none()),
    body.mediaType === undefined ? [] : [body.mediaType],
  );

/**
 * Select a body decoder for one exact HTTP status.
 *
 * @example
 * ```ts
 * import { Body, Response } from "viell-effect-schema-http";
 * const health = Response.status(200, Body.text);
 * ```
 */
export const status = <A, E, R>(
  code: number,
  body: Body.Decoder<A, E, R>,
): Response<A, E, R> => when((info) => info.status === code, body);

/**
 * Use another response contract when this one has no matching case.
 *
 * @remarks
 * Declaration order is priority. This is selection fallback, not decoding-error recovery.
 * A selected decoder's failure never tries the fallback.
 */
export const orElse =
  <B, E2, R2>(that: Response<B, E2, R2>) =>
  <A, E, R>(self: Response<A, E, R>): Response<A | B, E | E2, R | R2> =>
    make<A | B, E | E2, R | R2>(
      (info) => Option.orElse(self.select(info), () => that.select(info)),
      Array.from(new Set([...self.accepts, ...that.accepts])),
    );

/**
 * A decoded value labelled with its case name and response metadata.
 *
 * @remarks
 * Checking `_tag` narrows the value type when several tagged outcomes form a union.
 */
export interface Tagged<Tag extends string, A> {
  readonly _tag: Tag;
  readonly value: A;
  readonly metadata: Metadata;
}

/**
 * Wrap a body decoder's result with a case name, value and response metadata.
 *
 * @example
 * ```ts
 * import { Body, Response } from "viell-effect-schema-http";
 * const response = Response.status(200, Response.tag("Found", Body.text)).pipe(
 *   Response.orElse(Response.status(404, Response.tag("Missing", Body.empty))),
 * );
 * ```
 *
 * @remarks
 * This returns a body decoder, ready to use inside {@link status} or {@link when}.
 * Tagging a response does not turn it into an Effect failure.
 */
export const tag = <const Tag extends string, A, E, R>(
  name: Tag,
  body: Body.Decoder<A, E, R>,
): Body.Decoder<Tagged<Tag, A>, E, R> =>
  Body.decoder(
    (response) =>
      Effect.map(body.decode(response), (value) => ({
        _tag: name,
        value,
        metadata: metadata(response),
      })),
    body.mediaType,
  );

/**
 * Choose a response case and decode the native response's body.
 *
 * @remarks
 * An unmatched body is drained before `UnexpectedResponse`; a failed drain or decoder becomes
 * `DecodeError`. Direct callers own the response's resource lifetime. `Operation.make` manages
 * that lifetime and any configured attempt timeout for ordinary execution.
 */
export const decode = <A, E, R>(
  self: Response<A, E, R>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  A,
  UnexpectedResponse | DecodeError<E | HttpClientError.HttpClientError>,
  R
> =>
  Effect.suspend(() => {
    const info = metadata(response);
    const selected = self.select(info);
    const decodeError = (cause: E | HttpClientError.HttpClientError) =>
      new DecodeError({ metadata: info, cause });
    if (Option.isNone(selected)) {
      return Body.empty
        .decode(response)
        .pipe(
          Effect.mapError(decodeError),
          Effect.andThen(
            Effect.fail(new UnexpectedResponse({ metadata: info })),
          ),
        );
    }
    return Effect.mapError(selected.value.decode(response), decodeError);
  });
