import { Buffer } from "node:buffer";
import { createServer, request as send, type RequestListener } from "node:http";
import { Effect } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as Transport from "../src/http/Transport.js";

/** A fresh loopback server per test, with active connections closed at scope exit. */
export const listen = (handler: RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly origin: string;
          readonly server: ReturnType<typeof createServer>;
        }>((resolve, reject) => {
          const server = createServer(handler);
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            const address = server.address();
            if (address === null || typeof address === "string") {
              server.close();
              reject(new Error("Expected a loopback TCP address"));
              return;
            }
            resolve({ origin: `http://127.0.0.1:${address.port}`, server });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
  );

/**
 * A deliberately narrow GET-only provider for the repeated-header socket control.
 * It buffers one HTTP 200 response and supplies its raw lines; it is not a general Node transport.
 */
export const linesClient = HttpClient.make((request, url, signal) =>
  Effect.gen(function* () {
    if (request.method !== "GET" || request.body._tag !== "Empty") {
      return yield* Effect.die(
        new Error("The header-line fixture supports bodyless GET only"),
      );
    }
    const lines = yield* Transport.headerLines(request);
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<HttpClientResponse.HttpClientResponse>(
          (resolve, reject) => {
            const outgoing = send(
              url,
              {
                method: "GET",
                headers: [
                  "Host",
                  url.host,
                  ...lines.flatMap(([name, value]) => [name, value]),
                ],
                signal,
              },
              (incoming) => {
                const chunks: Array<Buffer> = [];
                incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                incoming.once("error", reject);
                incoming.once("end", () => {
                  if (incoming.statusCode !== 200) {
                    reject(
                      new Error("The header-line fixture expects HTTP 200"),
                    );
                    return;
                  }
                  const observed: Array<[string, string]> = [];
                  for (
                    let index = 0;
                    index < incoming.rawHeaders.length;
                    index += 2
                  ) {
                    observed.push([
                      incoming.rawHeaders[index]!,
                      incoming.rawHeaders[index + 1]!,
                    ]);
                  }
                  try {
                    resolve(
                      Transport.withResponseHeaders(
                        HttpClientResponse.fromWeb(
                          request,
                          new globalThis.Response(
                            new Uint8Array(Buffer.concat(chunks)),
                            { status: 200, headers: observed },
                          ),
                        ),
                        observed,
                      ),
                    );
                  } catch (cause) {
                    reject(cause);
                  }
                });
              },
            );
            outgoing.once("error", reject);
            outgoing.end();
          },
        ),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    });
  }),
);
