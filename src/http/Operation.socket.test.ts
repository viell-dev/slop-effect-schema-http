import { Buffer } from "node:buffer";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { Cookies, FetchHttpClient, HttpClient } from "effect/http";
import { linesClient, listen } from "../../test/socket.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

// https://github.com/viell-dev/slop-effect-schema-http/issues/16
// These are Node socket checks. Browser policy and hostile service formats belong to the separate suite.
describe("Operation over real loopback sockets", () => {
  it.live(
    "Fetch follows redirects by default and exposes the 301 in manual mode",
    () =>
      Effect.gen(function* () {
        for (const manual of [false, true]) {
          const targets: Array<string | undefined> = [];
          const { origin } = yield* listen((request, response) => {
            targets.push(request.url);
            if (request.url === "/redirect") {
              response.writeHead(301, { Location: "/final" });
              response.end("moved");
            } else {
              response.end("done");
            }
          });
          const value = yield* Operation.make(
            Request.get(`${origin}/redirect`),
            Response.status(301, Response.tag("Redirect", Body.text)).pipe(
              Response.orElse(
                Response.status(200, Response.tag("Final", Body.text)),
              ),
            ),
          )
            .execute(undefined)
            .pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.provideService(
                FetchHttpClient.RequestInit,
                manual ? { redirect: "manual" } : {},
              ),
            );
          expect(value._tag).toBe(manual ? "Redirect" : "Final");
          expect(value.value).toBe(manual ? "moved" : "done");
          expect(targets).toEqual(
            manual ? ["/redirect"] : ["/redirect", "/final"],
          );
        }
      }),
  );

  it.live(
    "Node Fetch keeps no cookies, while an explicit Effect cookie jar carries them",
    () =>
      Effect.gen(function* () {
        for (const useJar of [false, true]) {
          const received: Array<string | undefined> = [];
          const { origin } = yield* listen((request, response) => {
            received.push(request.headers.cookie);
            if (request.url === "/seed") {
              response.writeHead(204, {
                "Set-Cookie": "session=socket-test; Path=/",
              });
              response.end();
            } else {
              response.end(request.headers.cookie ?? "none");
            }
          });
          const jar = yield* Ref.make(Cookies.empty);
          const options = {
            transformClient: (client: HttpClient.HttpClient) =>
              useJar ? HttpClient.withCookiesRef(client, jar) : client,
          };
          yield* Operation.make(
            Request.get(`${origin}/seed`),
            Response.status(204, Body.empty),
            options,
          )
            .execute(undefined)
            .pipe(Effect.provide(FetchHttpClient.layer));
          const value = yield* Operation.make(
            Request.get(`${origin}/check`),
            Response.status(200, Body.text),
            options,
          )
            .execute(undefined)
            .pipe(Effect.provide(FetchHttpClient.layer));
          expect(value).toBe(useJar ? "session=socket-test" : "none");
          expect(received).toEqual([
            undefined,
            useJar ? "session=socket-test" : undefined,
          ]);
        }
      }),
  );

  it.live(
    "Fetch chooses a multipart boundary that matches the body on the socket",
    () =>
      Effect.gen(function* () {
        const received: { contentType?: string | undefined; body?: Buffer } =
          {};
        const { origin } = yield* listen((request, response) => {
          const chunks: Array<Buffer> = [];
          received.contentType = request.headers["content-type"];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            received.body = Buffer.concat(chunks);
            response.writeHead(204);
            response.end();
          });
        });
        const form = new FormData();
        form.append("label", "June");
        form.append(
          "file",
          new Blob([new Uint8Array([0, 1, 255])]),
          "sample.bin",
        );
        yield* Operation.make(
          Request.post(`${origin}/upload`).pipe(Request.body(Body.formData)),
          Response.status(204, Body.empty),
        )
          .execute({ body: form })
          .pipe(Effect.provide(FetchHttpClient.layer));
        expect(received.contentType).toMatch(
          /^multipart\/form-data; boundary=.+/,
        );
        const boundary = received.contentType!.slice(
          "multipart/form-data; boundary=".length,
        );
        const body = received.body!;
        expect(body.subarray(0, boundary.length + 4).toString()).toBe(
          `--${boundary}\r\n`,
        );
        expect(body.toString()).toContain('name="label"\r\n\r\nJune\r\n');
        expect(body.toString()).toContain('name="file"; filename="sample.bin"');
        expect(body.includes(Buffer.from([0, 1, 255]))).toBe(true);
        expect(
          body.toString().replace(/\r\n$/, "").endsWith(`--${boundary}--`),
        ).toBe(true);
      }),
  );

  it.live(
    "a line-preserving provider sends repeated lines that Fetch joins",
    () =>
      Effect.gen(function* () {
        for (const preserve of [false, true]) {
          const received: Array<string> = [];
          const { origin } = yield* listen((request, response) => {
            for (let index = 0; index < request.rawHeaders.length; index += 2) {
              if (request.rawHeaders[index]!.toLowerCase() === "x-scope")
                received.push(request.rawHeaders[index + 1]!);
            }
            response.writeHead(200, { "X-Reply": ["one", "two"] });
            response.end("ok");
          });
          const value = yield* Operation.make(
            Request.get(origin).pipe(
              Request.appendHeader("X-Scope", "first"),
              Request.appendHeader("X-Scope", "second"),
            ),
            Response.status(200, Response.tag("Ok", Body.text)),
          )
            .execute(undefined)
            .pipe(
              preserve
                ? Effect.provideService(HttpClient.HttpClient, linesClient)
                : Effect.provide(FetchHttpClient.layer),
            );
          expect(value.value).toBe("ok");
          expect(received).toEqual(
            preserve ? ["first", "second"] : ["first, second"],
          );
          if (preserve) {
            expect(
              Option.getOrThrow(value.metadata.headerLines).filter(
                ([name]) => name.toLowerCase() === "x-reply",
              ),
            ).toEqual([
              ["X-Reply", "one"],
              ["X-Reply", "two"],
            ]);
          } else {
            expect(Option.isNone(value.metadata.headerLines)).toBe(true);
          }
        }
      }),
  );

  it.live(
    "interrupting an active body read closes the socket without retrying",
    () =>
      Effect.gen(function* () {
        for (const buffered of [true, false]) {
          const firstChunk = yield* Deferred.make<void>();
          const readStarted = Promise.withResolvers<void>();
          const closed = Promise.withResolvers<void>();
          let bodyFinished = false;
          let requests = 0;
          const { origin } = yield* listen((_, response) => {
            requests++;
            response.once("close", () => closed.resolve());
            response.writeHead(200, { "Content-Type": "text/plain" });
            response.write("prefix");
            // Keep the response open: the selected decoder must wait for more body bytes.
          });
          const observedFetch: typeof globalThis.fetch = async (
            input,
            init,
          ) => {
            const web = await globalThis.fetch(input, init);
            const arrayBuffer = web.arrayBuffer.bind(web);
            // Body.text delegates to Effect's buffered reader. Observe the real native read,
            // preserving its value/error, so the signal means reading has actually started.
            web.arrayBuffer = () => {
              const pending = arrayBuffer().then(
                (value) => {
                  bodyFinished = true;
                  return value;
                },
                (cause) => {
                  bodyFinished = true;
                  throw cause;
                },
              );
              readStarted.resolve();
              return pending;
            };
            return web;
          };
          const reading = Body.decoder((response) =>
            buffered
              ? Effect.as(Body.text.decode(response), undefined)
              : Stream.runDrain(
                  response.stream.pipe(
                    Stream.tap(() => Deferred.succeed(firstChunk, undefined)),
                  ),
                ),
          );
          const fiber = yield* Operation.make(
            Request.get(origin),
            Response.status(200, reading),
            { policy: Policy.make(Schedule.recurs(2)) },
          )
            .execute(undefined)
            .pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.provideService(FetchHttpClient.Fetch, observedFetch),
              Effect.forkChild,
            );
          yield* (
            buffered
              ? Effect.promise(() => readStarted.promise)
              : Deferred.await(firstChunk)
          ).pipe(
            Effect.timeout("3 seconds"),
            Effect.mapError(
              (cause) =>
                new Error("The socket body read did not start", { cause }),
            ),
          );
          if (buffered) expect(bodyFinished).toBe(false);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          ).toBe(true);
          // Observe the peer close before the test scope's server cleanup could close it.
          yield* Effect.promise(() => closed.promise).pipe(
            Effect.timeout("3 seconds"),
            Effect.mapError(
              (cause) =>
                new Error("The socket peer did not close after interruption", {
                  cause,
                }),
            ),
          );
          expect(requests).toBe(1);
        }
      }),
  );
});
