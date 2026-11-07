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
 * Adjust a contract with {@link replace} and {@link remove}.
 *
 * `C` records each case and its key, which is what lets a replaced case leave the type. Annotating
 * a value as `Response<A, E, R>` drops the keys, so no case of it can be addressed any more.
 */
export interface Response<
  out A,
  out E = never,
  out R = never,
  out C extends AnyCase = AnyCase,
>
  extends Pipeable.Pipeable {
  readonly select: (metadata: Metadata) => Option.Option<Body.Decoder<A, E, R>>;
  /** Media types contributed to the automatic `Accept` header, in declaration order. */
  readonly accepts: ReadonlyArray<string>;
  /** The contract's cases, in priority order. */
  readonly cases: ReadonlyArray<C>;
}

/**
 * One case of a contract: when it applies, what decodes it, and the key that addresses it.
 *
 * @remarks
 * A {@link status} case is keyed by its status, and a {@link when} case by its `key` option, or
 * `undefined` without one. Tags from {@link tag} are labels on results, not keys: they are optional
 * and can repeat.
 */
export interface Case<out K, out A, out E, out R> {
  readonly key: K;
  readonly matches: (metadata: Metadata) => boolean;
  readonly decoder: Body.Decoder<A, E, R>;
}

/** Any case of any contract: the bound of {@link Response}'s case parameter. */
export type AnyCase = Case<unknown, unknown, unknown, unknown>;

/** A value that can address a case: a status, or the `key` option of {@link when}. */
export type Key = string | number;

/**
 * The results of a set of cases.
 *
 * @remarks
 * This and the other helpers below are public so that the declaration of a transform held in an
 * exported variable, such as `export const asText = Response.replace(200, Body.text)`, can name
 * them. A private interface there stops the declaration emitting, and a private alias printed in
 * full can lose its meaning.
 */
export type CaseValue<C> =
  C extends Case<unknown, infer A, unknown, unknown> ? A : never;

/** The decoder failures of a set of cases. */
export type CaseFailure<C> =
  C extends Case<unknown, unknown, infer E, unknown> ? E : never;

/** The services a set of cases requires. */
export type CaseServices<C> =
  C extends Case<unknown, unknown, unknown, infer R> ? R : never;

type IsUnion<K, All = K> = K extends unknown
  ? [All] extends [K]
    ? false
    : true
  : never;

/** A record over a literal requires that key; one over `number`, `string` or a pattern does not. */
type IsLiteral<K> =
  Record<never, never> extends Record<K & Key, unknown> ? false : true;

/**
 * The keys of `C` that can be addressed. A widened or union key proves nothing about which case
 * this is, so the type could not say what an edit leaves behind.
 */
export type KeyOf<C> =
  C extends Case<infer K, unknown, unknown, unknown>
    ? IsUnion<K> extends false
      ? IsLiteral<K> extends true
        ? K
        : never
      : never
    : never;

/** The cases of `C` other than those keyed exactly `K`. */
export type Without<C, K> =
  C extends Case<infer CK, unknown, unknown, unknown>
    ? [CK] extends [K]
      ? never
      : C
    : never;

/** The compile error for a union of keys. Its one member's name is the message. */
export interface OneKeyAtATime<K> {
  readonly "Pass one key at a time. Only the value passed is touched at run time, so a union of keys would leave cases the type says are gone.": K;
}

/** The compile error for a key the contract lacks. Its one member's name is the message. */
export interface NoSuchCase<K> {
  readonly "This contract has no case with this literal key. Only a literal status or `key` option can be addressed.": K;
}

/**
 * The union check stays a separate member: nested in the other conditional it refuses nothing. The
 * type would drop every member of the union, but at run time only the value passed is touched, so
 * the other cases would stay and could reach a mapping that no longer expects them.
 */
type Addresses<C, K> = (IsUnion<K> extends false ? unknown : OneKeyAtATime<K>) &
  ([K] extends [KeyOf<C>] ? unknown : NoSuchCase<K>);

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

const fromCases = <A, E, R, C extends AnyCase>(
  cases: ReadonlyArray<C>,
): Response<A, E, R, C> => ({
  ...Pipeable.Prototype,
  cases,
  select: (info) => {
    const selected = cases.find((entry) => entry.matches(info));
    return selected === undefined
      ? Option.none()
      : Option.some(selected.decoder as Body.Decoder<A, E, R>);
  },
  accepts: Array.from(
    new Set(
      cases.flatMap(({ decoder }) =>
        decoder.mediaType === undefined ? [] : [decoder.mediaType],
      ),
    ),
  ),
});

/** A contract after an edit. Its signature states the types, which depend on the key removed. */
const edited = <Result>(cases: ReadonlyArray<AnyCase>): Result => {
  const contract: unknown = fromCases(cases);
  return contract as Result;
};

/** The first position of a key. A key that got past the types must not silently edit nothing. */
const positionOf = (cases: ReadonlyArray<AnyCase>, key: Key): number => {
  const position =
    key === undefined ? -1 : cases.findIndex((entry) => entry.key === key);
  if (position === -1)
    throw new Error(`This response contract has no case ${String(key)}`);
  return position;
};

/**
 * Select a body decoder when a predicate accepts the response metadata.
 *
 * @example
 * ```ts
 * import { Body, Response } from "viell-effect-schema-http";
 * const serverError = Response.when((info) => info.status >= 500, Body.text, {
 *   key: "server",
 * });
 * ```
 *
 * @remarks
 * The predicate runs before body decoding. It cannot select by payload contents; use one schema
 * with alternatives for payloads sharing the same metadata. A `key` lets {@link replace} and
 * {@link remove} address the case; it has no effect on selection.
 */
export const when = <A, E, R, const K extends Key | undefined = undefined>(
  predicate: (metadata: Metadata) => boolean,
  body: Body.Decoder<A, E, R>,
  options?: { readonly key?: K },
): Response<A, E, R, Case<K, A, E, R>> =>
  fromCases([{ key: options?.key as K, matches: predicate, decoder: body }]);

/**
 * Select a body decoder for one exact HTTP status.
 *
 * @example
 * ```ts
 * import { Body, Response } from "viell-effect-schema-http";
 * const health = Response.status(200, Body.text);
 * ```
 */
export const status = <A, E, R, const K extends number = number>(
  code: K,
  body: Body.Decoder<A, E, R>,
): Response<A, E, R, Case<K, A, E, R>> =>
  fromCases([
    { key: code, matches: (info) => info.status === code, decoder: body },
  ]);

/**
 * Use another response contract when this one has no matching case.
 *
 * @remarks
 * Declaration order is priority. This is selection fallback, not decoding-error recovery.
 * A selected decoder's failure never tries the fallback.
 */
export const orElse =
  <B, E2, R2, C2 extends AnyCase = AnyCase>(that: Response<B, E2, R2, C2>) =>
  <A, E, R, C extends AnyCase = AnyCase>(
    self: Response<A, E, R, C>,
  ): Response<A | B, E | E2, R | R2, C | C2> =>
    fromCases([...self.cases, ...that.cases]);

/**
 * Replace the decoder of the case with this key, keeping its position and its match rule.
 *
 * @example
 * ```ts
 * import { Body, Response } from "viell-effect-schema-http";
 * const full = Response.status(200, Body.json).pipe(
 *   Response.orElse(Response.status(404, Body.empty)),
 * );
 * const asText = full.pipe(Response.replace(200, Body.text));
 * // A 200 is now text. The 404 case is unchanged, and `full` still reads JSON.
 * ```
 *
 * @remarks
 * Declaration order is priority, so only the decoder changes. If several cases share the key, the
 * first keeps its position and the others go. The result type holds only the cases that can still
 * occur, and the automatic `Accept` follows the new decoder.
 *
 * The key must be one literal the contract declares: a key that is absent, widened to `number` or
 * `string`, or a union is a compile error. One that gets past the types with a cast throws here,
 * when the contract is built. To add a case, use {@link orElse} or place the new case first.
 */
export const replace =
  <const K extends Key, B, E2, R2>(key: K, body: Body.Decoder<B, E2, R2>) =>
  <A, E, R, C extends AnyCase>(
    self: Response<A, E, R, C> & Addresses<C, K>,
  ): Response<
    CaseValue<Without<C, K>> | B,
    CaseFailure<Without<C, K>> | E2,
    CaseServices<Without<C, K>> | R2,
    Without<C, K> | Case<K, B, E2, R2>
  > => {
    const position = positionOf(self.cases, key);
    return edited(
      self.cases.flatMap((entry, index) =>
        index === position
          ? [{ ...entry, decoder: body }]
          : entry.key === key
            ? []
            : [entry],
      ),
    );
  };

/**
 * Remove every case with this key.
 *
 * @example
 * ```ts
 * import { Body, Response } from "viell-effect-schema-http";
 * const full = Response.status(200, Body.json).pipe(
 *   Response.orElse(Response.status(404, Body.empty)),
 * );
 * const onlyFound = full.pipe(Response.remove(404));
 * // A 404 now falls through to any later case, or fails with UnexpectedResponse.
 * ```
 *
 * @remarks
 * The result type holds only the cases that can still occur. The key follows the same rules as in
 * {@link replace}: a key that is absent, not literal or a union is a compile error, and one that
 * gets past the types throws here.
 */
export const remove =
  <const K extends Key>(key: K) =>
  <A, E, R, C extends AnyCase>(
    self: Response<A, E, R, C> & Addresses<C, K>,
  ): Response<
    CaseValue<Without<C, K>>,
    CaseFailure<Without<C, K>>,
    CaseServices<Without<C, K>>,
    Without<C, K>
  > => {
    positionOf(self.cases, key);
    return edited(self.cases.filter((entry) => entry.key !== key));
  };

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
