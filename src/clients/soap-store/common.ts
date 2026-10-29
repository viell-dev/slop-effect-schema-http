import { Effect } from "effect";
import type { HttpClientError } from "effect/http";
import { Body } from "viell-effect-schema-http";

/** The response bytes, announcing `mediaType` for the automatic `Accept` header. */
export const bytesAs = (
  mediaType: string,
): Body.Decoder<Uint8Array, HttpClientError.HttpClientError> =>
  Body.decoder(
    (response) =>
      Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
    mediaType,
  );

/**
 * A server rejection the contract declares: its plain-text reason under a client-chosen tag. The
 * trailing line break the store writes is not kept.
 */
export const rejected = <const Tag extends string>(tag: Tag) =>
  Body.text.pipe(
    Body.map((reason) => ({ _tag: tag, reason: reason.trimEnd() }) as const),
  );
