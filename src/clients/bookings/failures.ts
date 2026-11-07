/**
 * What a failed operation was, in the catalogue's terms, so that a test can compare it whole.
 * `DecodeError` is a `Response.DecodeError`, and `TransportError` is an `HttpClientError` with that
 * reason. They have different retry verdicts under `Policy.transient`, so telling them apart is the
 * point.
 */
import { Cause } from "effect";
import { HttpClientError } from "effect/http";
import { Response } from "viell-effect-schema-http";

export interface Described {
  readonly kind: string;
  /** The status in the failure's metadata, when a head arrived first. */
  readonly status?: number;
  /** For a `DecodeError`, what failed inside: an `HttpClientError` reason or a `SchemaError`. */
  readonly inner?: string;
}

const reasonOf = (error: unknown) =>
  HttpClientError.isHttpClientError(error) ? error.reason : undefined;

/** The failure's name, its status and what failed inside it. */
export const described = (error: unknown): Described => {
  if (Cause.isTimeoutError(error)) return { kind: "TimeoutError" };
  if (error instanceof Response.UnexpectedResponse)
    return { kind: "UnexpectedResponse", status: error.metadata.status };
  if (error instanceof Response.DecodeError) {
    const inner: unknown = error.cause;
    return {
      kind: "DecodeError",
      status: error.metadata.status,
      inner:
        reasonOf(inner)?._tag ??
        (inner instanceof Error ? inner.name : typeof inner),
    };
  }
  const reason = reasonOf(error);
  if (reason !== undefined) return { kind: reason._tag };
  return { kind: error instanceof Error ? error.name : typeof error };
};

/** The message of an error and of each `cause` under it, down to the platform's own. */
export const causes = (error: unknown): ReadonlyArray<string> => {
  const messages: Array<string> = [];
  let current =
    error instanceof Response.DecodeError ? (error.cause as unknown) : error;
  if (reasonOf(current) !== undefined) current = reasonOf(current)?.cause;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
};
