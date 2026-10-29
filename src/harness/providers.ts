import { request as send } from "node:http";
import { Effect, Layer, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { Transport } from "viell-effect-schema-http";

/**
 * Effect's Fetch provider over Node's global `fetch`. Fetch joins repeated request header lines with
 * `, `, sends no cookies by itself in Node, and follows redirects unless told otherwise.
 */
export const fetchClient: Layer.Layer<HttpClient.HttpClient> =
  FetchHttpClient.layer;

const bodyBytes = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<{
  readonly bytes: Uint8Array | undefined;
  readonly contentType: string | undefined;
}> => {
  const body = request.body;
  switch (body._tag) {
    case "Empty":
      return Effect.succeed({ bytes: undefined, contentType: undefined });
    case "Uint8Array":
      return Effect.succeed({ bytes: body.body, contentType: undefined });
    case "Raw":
      return Effect.succeed({
        bytes:
          typeof body.body === "string"
            ? new TextEncoder().encode(body.body)
            : (body.body as Uint8Array),
        contentType: undefined,
      });
    case "FormData":
      // Let the platform serialize the multipart body and choose its boundary.
      return Effect.promise(async () => {
        const web = new Request("http://serializer.invalid/", {
          method: "POST",
          body: body.formData,
        });
        return {
          bytes: new Uint8Array(await web.arrayBuffer()),
          contentType: web.headers.get("content-type") ?? undefined,
        };
      });
    case "Stream":
      return Stream.runCollect(body.stream).pipe(
        Effect.map((chunks) => {
          const all = Array.from(chunks);
          const bytes = new Uint8Array(
            all.reduce((size, chunk) => size + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of all) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return { bytes, contentType: undefined };
        }),
        Effect.orDie,
      );
  }
};

const transportError = (
  request: HttpClientRequest.HttpClientRequest,
  cause: unknown,
) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });

/** The Fetch standard's null body statuses: a `Response` with one of them must have no body. */
const nullBodyStatuses: ReadonlySet<number> = new Set([
  101, 103, 204, 205, 304,
]);

/**
 * A custom provider over `node:http` that sends the operation's original header lines
 * (`Transport.headerLines`) unjoined, and attaches the response's raw lines to the response with
 * `Transport.withResponseHeaders`. It follows no redirects and keeps no cookies.
 */
export const linesClient: HttpClient.HttpClient = HttpClient.make(
  (request, url, signal) =>
    Effect.gen(function* () {
      const lines = yield* Transport.headerLines(request);
      const { bytes, contentType } = yield* bodyBytes(request);
      // Node adds no default headers to raw header lines, and HTTP/1.1 requires Host.
      const outgoing: Array<readonly [string, string]> = lines.some(
        ([name]) => name.toLowerCase() === "host",
      )
        ? [...lines]
        : [["host", url.host], ...lines];
      if (
        contentType !== undefined &&
        !outgoing.some(([name]) => name.toLowerCase() === "content-type")
      )
        outgoing.push(["content-type", contentType]);
      if (
        bytes !== undefined &&
        !outgoing.some(([name]) => name.toLowerCase() === "content-length")
      )
        outgoing.push(["content-length", String(bytes.length)]);
      return yield* Effect.callback<
        HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError
      >((resume) => {
        const outgoingRequest = send(
          url,
          {
            method: request.method,
            headers: outgoing.flatMap(([name, value]) => [name, value]),
            signal,
          },
          (incoming) => {
            const chunks: Array<Buffer> = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("error", (cause) =>
              resume(Effect.fail(transportError(request, cause))),
            );
            incoming.on("end", () => {
              const raw = incoming.rawHeaders;
              const responseLines: Array<readonly [string, string]> = [];
              for (let index = 0; index + 1 < raw.length; index += 2)
                responseLines.push([raw[index]!, raw[index + 1]!]);
              const status = incoming.statusCode ?? 0;
              const empty =
                nullBodyStatuses.has(status) || request.method === "HEAD";
              let response: HttpClientResponse.HttpClientResponse;
              try {
                const web = new Response(
                  empty ? null : new Uint8Array(Buffer.concat(chunks)),
                  {
                    status,
                    statusText: incoming.statusMessage ?? "",
                    headers: responseLines.map(
                      ([name, value]): [string, string] => [name, value],
                    ),
                  },
                );
                response = Transport.withResponseHeaders(
                  HttpClientResponse.fromWeb(request, web),
                  responseLines,
                );
              } catch (cause) {
                // A response the Fetch API cannot represent, such as a status outside 200–599,
                // fails the request as a transport error instead of throwing in this callback.
                return resume(Effect.fail(transportError(request, cause)));
              }
              resume(Effect.succeed(response));
            });
          },
        );
        outgoingRequest.on("error", (cause) =>
          resume(Effect.fail(transportError(request, cause))),
        );
        outgoingRequest.end(bytes);
      });
    }),
);

/** The line-preserving provider as a layer. */
export const linesLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  linesClient,
);
