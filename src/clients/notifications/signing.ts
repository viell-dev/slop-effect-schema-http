/**
 * HMAC request signing for the notification service, written by the consumer from the service's
 * documented canonical form: `METHOD \n path \n timestamp \n` followed by the exact body bytes,
 * HMAC-SHA256 under the shared secret, sent as `X-Notify-Signature: v1=<hex>` beside
 * `X-Notify-Timestamp: <epoch ms>`. Web Crypto only, so the same code runs in a browser.
 */
import { Clock, Data, Effect } from "effect";
import { HttpClient, type HttpBody, HttpClientRequest } from "effect/http";
import { Request, UrlEncoding } from "viell-effect-schema-http";

/** The request body cannot be signed: only finite byte and text bodies have exact bytes up front. */
export class SigningError extends Data.TaggedError("SigningError")<{
  readonly message: string;
}> {}

export interface SigningOptions {
  readonly secret: string;
  /** The clock read for each signature. Defaults to Effect's `Clock`. */
  readonly now?: Effect.Effect<number> | undefined;
}

const encoder = new TextEncoder();

const bodyBytes = (
  body: HttpBody.HttpBody,
): Effect.Effect<Uint8Array, SigningError> => {
  switch (body._tag) {
    case "Empty":
      return Effect.succeed(new Uint8Array());
    case "Uint8Array":
      return Effect.succeed(body.body);
    case "Raw":
      return typeof body.body === "string"
        ? Effect.succeed(encoder.encode(body.body))
        : body.body instanceof Uint8Array
          ? Effect.succeed(body.body)
          : Effect.fail(
              new SigningError({ message: "a raw body of unknown bytes" }),
            );
    default:
      return Effect.fail(
        new SigningError({
          message: `a ${body._tag} body has no exact bytes before the transport serializes it`,
        }),
      );
  }
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The signature headers for one request: the canonical form and its HMAC. */
const signatureHeaders = (
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  body: Uint8Array,
): Effect.Effect<Record<string, string>> =>
  Effect.promise(async () => {
    const head = encoder.encode(`${method}\n${path}\n${timestamp}\n`);
    const message = new Uint8Array(head.length + body.length);
    message.set(head);
    message.set(body, head.length);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, message),
    );
    return {
      "x-notify-timestamp": String(timestamp),
      "x-notify-signature": `v1=${hex(signature)}`,
    };
  });

const sign = (
  options: SigningOptions,
  request: HttpClientRequest.HttpClientRequest,
  absoluteUrl: string,
): Effect.Effect<HttpClientRequest.HttpClientRequest, SigningError> =>
  Effect.gen(function* () {
    const timestamp = yield* options.now ?? Clock.currentTimeMillis;
    const body = yield* bodyBytes(request.body);
    // The path the transport sends: the WHATWG-parsed path of the final URL, without its query.
    const path = new URL(absoluteUrl).pathname;
    const headers = yield* signatureHeaders(
      options.secret,
      request.method,
      path,
      timestamp,
      body,
    );
    return HttpClientRequest.setHeaders(request, headers);
  });

/**
 * Client middleware that signs every attempt. It runs inside each attempt, after the operation has
 * encoded the body and joined the URL, so its position among the request's declarations does not
 * matter, and a retry gets a fresh timestamp and signature. Use it through `transformClient`.
 */
export const signAttempts =
  (options: SigningOptions) =>
  <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ): HttpClient.HttpClient.With<E | SigningError, R> =>
    HttpClient.mapRequestEffect(client, (request) =>
      sign(options, request, request.url),
    );

/**
 * The control: signing as a request transform (`Request.mapEffect`), which runs once per operation
 * evaluation like a computed header. Every attempt then repeats one timestamp and signature, and
 * the signature covers whatever body the request had at the transform's position. The URL is still
 * relative there, so it is joined with `baseUrl` the way `UrlEncoding` will join it.
 */
export const signOncePerEvaluation = (
  options: SigningOptions & { readonly baseUrl: string },
) =>
  Request.mapEffect((request: HttpClientRequest.HttpClientRequest) =>
    sign(
      options,
      request,
      UrlEncoding.defaults.join(options.baseUrl, request.url),
    ),
  );
