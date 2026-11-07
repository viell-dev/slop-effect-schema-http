/**
 * What a client received, for the requests a platform changes or refuses (EXT-9 to EXT-16): the
 * request a `HttpClient.tapRequest` sees when it is applied last in `transformClient`, after any
 * other middleware. A browser cannot send these shapes, so the ledger alone cannot tell a request
 * the platform changed from one the library lost before the platform saw it.
 */
import { Effect, Option } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";
import { Transport } from "viell-effect-schema-http";

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly hash: string | undefined;
}

/** The parts of `request` a provider is given to work with. */
export const receivedOf = (
  request: HttpClientRequest.HttpClientRequest,
): Received => ({
  method: request.method,
  url: request.url,
  hash: Option.getOrUndefined(request.hash),
});

/** The rest of what a client received, for a request whose headers or body are the point. */
export interface Details {
  /** Effect's normalized view, the one client middleware sees: lowercase names, joined values. */
  readonly headers: Readonly<Record<string, string>>;
  /** The lines a provider that can send them reads with `Transport.headerLines`. */
  readonly lines: Transport.Lines;
  /** The text of a body held as bytes, which is what `Body.text` makes. */
  readonly body: string | undefined;
}

const bodyOf = (
  request: HttpClientRequest.HttpClientRequest,
): string | undefined =>
  request.body._tag === "Uint8Array"
    ? new TextDecoder().decode(request.body.body)
    : undefined;

/**
 * A fresh record of what a client received. Apply `last` to a client after any other middleware.
 * It sees each request an operation makes once, before any redirect is followed.
 */
export const watching = () => {
  const received: Array<Received> = [];
  const details: Array<Details> = [];
  return {
    received: received as ReadonlyArray<Received>,
    details: details as ReadonlyArray<Details>,
    last: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
      HttpClient.tapRequest(client, (request) =>
        Effect.map(Transport.headerLines(request), (lines) => {
          received.push(receivedOf(request));
          details.push({
            headers: { ...request.headers },
            lines,
            body: bodyOf(request),
          });
        }),
      ),
  };
};
