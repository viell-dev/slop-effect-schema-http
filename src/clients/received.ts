/**
 * What a client received, for the requests no standard client sends (EXT-9 to EXT-11): the request
 * a `HttpClient.tapRequest` sees when it is applied last in `transformClient`, after any other
 * middleware. A browser cannot send these shapes, so the ledger alone cannot tell a request the
 * platform changed from one the library lost before the platform saw it.
 */
import { Effect, Option } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";

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

/**
 * A fresh record of what a client received. Apply `last` to a client after any other middleware.
 * It sees each request an operation makes once, before any redirect is followed.
 */
export const watching = () => {
  const received: Array<Received> = [];
  return {
    received: received as ReadonlyArray<Received>,
    last: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
      HttpClient.tapRequest(client, (request) =>
        Effect.sync(() => {
          received.push(receivedOf(request));
        }),
      ),
  };
};
