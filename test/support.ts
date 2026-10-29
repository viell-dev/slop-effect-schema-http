import { Effect, Layer } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import * as Transport from "../src/http/Transport.js";

/** What the synthetic transport received for one dispatch. */
export interface Exchange {
  readonly request: HttpClientRequest.HttpClientRequest;
  /** The URL string the library composed, before WHATWG URL normalization. */
  readonly url: string;
  /** The URL the client resolved for dispatch, including parameters added by client middleware. */
  readonly href: string;
  /** The lines a line-preserving provider would send for this dispatch. */
  readonly headerLines: Transport.Lines;
  readonly signal: AbortSignal;
}

export type Reply =
  | globalThis.Response
  | Effect.Effect<globalThis.Response, HttpClientError.HttpClientError>;

export interface Synthetic {
  readonly client: HttpClient.HttpClient;
  /** Every dispatch in order, recorded before the reply is produced. */
  readonly exchanges: ReadonlyArray<Exchange>;
  /** Provides the client without trace propagation, so headers contain only declared fields. */
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
}

/** An in-memory HttpClient provider that records each dispatch and answers through `respond`. */
export const synthetic = (
  respond: (exchange: Exchange, index: number) => Reply,
): Synthetic => {
  const exchanges: Array<Exchange> = [];
  const client = HttpClient.make((request, url, signal) =>
    Effect.gen(function* () {
      const exchange: Exchange = {
        request,
        url: request.url,
        href: url.href,
        headerLines: yield* Transport.headerLines(request),
        signal,
      };
      exchanges.push(exchange);
      const reply = respond(exchange, exchanges.length - 1);
      const web = Effect.isEffect(reply) ? yield* reply : reply;
      return HttpClientResponse.fromWeb(request, web);
    }),
  );
  return {
    client,
    exchanges,
    layer: Layer.merge(
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(HttpClient.TracerPropagationEnabled, false),
    ),
  };
};

export const json = (
  status: number,
  value: unknown,
  headers?: Record<string, string>,
): globalThis.Response =>
  new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const text = (
  status: number,
  body: string,
  headers?: HeadersInit,
): globalThis.Response =>
  new globalThis.Response(body, {
    status,
    ...(headers === undefined ? {} : { headers }),
  });

export const empty = (
  status: number,
  headers?: HeadersInit,
): globalThis.Response =>
  new globalThis.Response(null, {
    status,
    ...(headers === undefined ? {} : { headers }),
  });

/** Observations of a response body stream: how far it was read and whether it was cancelled. */
export interface BodyProbe {
  readonly body: ReadableStream<Uint8Array>;
  readonly chunksRead: () => number;
  readonly finished: () => boolean;
  readonly cancelled: () => boolean;
}

/** A body stream that records how far it was read, for selection and draining assertions. */
export const probeBody = (chunks: ReadonlyArray<string>): BodyProbe => {
  const encoder = new TextEncoder();
  let read = 0;
  let finished = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[read];
      if (chunk === undefined) {
        finished = true;
        controller.close();
        return;
      }
      read++;
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    chunksRead: () => read,
    finished: () => finished,
    cancelled: () => cancelled,
  };
};

const origin = HttpClientRequest.get("https://api.test/resource");

/** Wrap a Web response as a client response, without any HttpClient. */
export const response = (
  web: globalThis.Response,
  request: HttpClientRequest.HttpClientRequest = origin,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, web);

const decoder = new TextDecoder();

/** The request body as text, or `undefined` when empty. Throws for other body kinds. */
export const bodyText = (
  request: HttpClientRequest.HttpClientRequest,
): string | undefined => {
  const { body } = request;
  switch (body._tag) {
    case "Empty":
      return undefined;
    case "Uint8Array":
      return decoder.decode(body.body);
    case "Raw":
      if (typeof body.body === "string") return body.body;
      throw new Error("raw body is not a string");
    default:
      throw new Error(`unexpected body kind ${body._tag}`);
  }
};
