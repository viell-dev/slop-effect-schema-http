import { Context, Effect, Option } from "effect";
import {
  Headers,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/**
 * Ordered header name/value pairs, preserving supplied spelling and repeated lines.
 *
 * @remarks
 * These are declarations or provider observations. Sending separate lines requires provider
 * support; normalized headers cannot reveal their original line boundaries.
 */
export type Lines = ReadonlyArray<readonly [string, string]>;

/**
 * The header collection shapes accepted by Effect's `Headers.Input`.
 *
 * @remarks
 * Use {@link entries} to expand them without combining repeated values.
 */
export type HeaderInput = Headers.Input;

/**
 * Expand a supported header collection into ordered name/value lines.
 *
 * @remarks
 * Record array values become repeated lines; `undefined` fields are omitted.
 */
export const entries = (input: HeaderInput): Lines =>
  Symbol.iterator in input
    ? Array.from(input, ([name, value]) => [name, value] as const)
    : Object.entries(input).flatMap(
        ([name, value]): Array<readonly [string, string]> =>
          value === undefined
            ? []
            : typeof value === "string"
              ? [[name, value]]
              : value.map((line) => [name, line]),
      );

/**
 * Produce Effect's normalized header view from ordered lines.
 *
 * @remarks
 * Names become lowercase and repeated values are joined with `, `. This loses line boundaries;
 * keep the original lines when a provider can send them.
 */
export const toHeaders = (lines: Lines): Headers.Headers => {
  const grouped = new Map<string, Array<string>>();
  for (const [name, value] of lines) {
    const key = name.toLowerCase();
    const values = grouped.get(key);
    if (values === undefined) grouped.set(key, [value]);
    else values.push(value);
  }
  return Headers.fromInput(
    Array.from(grouped, ([key, values]) => [key, values.join(", ")] as const),
  );
};

/**
 * Preserve original header lines where native middleware left the normalized value unchanged.
 *
 * @remarks
 * Changed or added native fields replace those fields' original lines. Removed fields disappear.
 * For a provider handling an operation, prefer {@link headerLines} to obtain the original lines
 * from the current Effect context.
 */
export const reconcile = (lines: Lines, headers: Headers.Headers): Lines => {
  const original = toHeaders(lines);
  const preserved = new Set(
    Object.keys(original).filter((name) => original[name] === headers[name]),
  );
  return [
    ...lines.filter(([name]) => preserved.has(name.toLowerCase())),
    ...Object.entries(headers).filter(([name]) => !preserved.has(name)),
  ];
};

/**
 * The original request header lines available during an operation's attempt.
 *
 * @remarks
 * Operations supply this context reference to the client. It defaults to an empty array outside
 * that context. Providers should read it through {@link headerLines}.
 */
export const HeaderLines: Context.Reference<Lines> = Context.Reference<Lines>(
  "viell-effect-schema-http/Transport/HeaderLines",
  { defaultValue: () => [] },
);

/**
 * Get the header lines a custom provider should send after native middleware edits.
 *
 * @remarks
 * Reads {@link HeaderLines} and reconciles it with the native request. Fetch does not gain
 * separate-line support from this helper.
 */
export const headerLines = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Lines> =>
  Effect.map(HeaderLines, (lines) => reconcile(lines, request.headers));

const ResponseHeaderLines = Symbol.for(
  "viell-effect-schema-http/Transport/ResponseHeaderLines",
);

/**
 * Attach the header lines a custom provider observed to its native response.
 *
 * @remarks
 * Copies the supplied lines, mutates the response with that snapshot, and returns the same
 * response object. Normalized headers and received bytes are unchanged. Attach only information
 * the provider actually observed; do not split normalized values to guess original lines.
 */
export const withResponseHeaders = (
  response: HttpClientResponse.HttpClientResponse,
  lines: Lines,
): HttpClientResponse.HttpClientResponse => {
  Object.defineProperty(response, ResponseHeaderLines, {
    value: lines.map(([name, value]) => [name, value] as const),
    configurable: true,
  });
  return response;
};

/**
 * Read the original response lines attached by a supporting provider.
 *
 * @remarks
 * Returns `None` when none were supplied, not when the response necessarily has no headers.
 * Normalized header values are never split to reconstruct lines.
 */
export const responseHeaderLines = (
  response: HttpClientResponse.HttpClientResponse,
): Option.Option<Lines> =>
  Option.fromUndefinedOr(
    (response as { readonly [ResponseHeaderLines]?: Lines })[
      ResponseHeaderLines
    ],
  );
