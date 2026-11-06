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
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientError,
} from "effect/http";
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
          const jar = yield* Ref.make<ReadonlyArray<Cookies.Cookie>>([]);
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.live("a line-preserving provider sends a name as it was written", () =>
    Effect.gen(function* () {
      for (const preserve of [false, true]) {
        const received: Array<string> = [];
        const { origin } = yield* listen((request, response) => {
          for (let index = 0; index < request.rawHeaders.length; index += 2) {
            if (request.rawHeaders[index]!.toLowerCase() === "x-api-key")
              received.push(request.rawHeaders[index]!);
          }
          response.end("ok");
        });
        yield* Operation.make(
          Request.get(origin).pipe(Request.setHeader("X-API-Key", "k")),
          Response.status(200, Body.text),
        )
          .execute(undefined)
          .pipe(
            preserve
              ? Effect.provideService(HttpClient.HttpClient, linesClient)
              : Effect.provide(FetchHttpClient.layer),
          );
        expect(received).toEqual([preserve ? "X-API-Key" : "x-api-key"]);
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/102
  it.live.each([
    "/x?a=1;b=2",
    "/x?a=1&&b=2",
    "/x?",
    "/x?q=a+b",
    "/x?a=%41&wsdl",
  ])("Fetch delivers the constructor query of %s", (target) =>
    Effect.gen(function* () {
      const targets: Array<string | undefined> = [];
      const { origin } = yield* listen((request, response) => {
        targets.push(request.url);
        response.end("ok");
      });
      yield* Operation.make(
        Request.get(`${origin}${target}`),
        Response.status(200, Body.text),
      )
        .execute(undefined)
        .pipe(Effect.provide(FetchHttpClient.layer));
      expect(targets).toEqual([target]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/100
  it.live("Fetch sends a declared Content-Type and honours a removal", () =>
    Effect.gen(function* () {
      const received: Array<string | undefined> = [];
      const { origin } = yield* listen((request, response) => {
        received.push(request.headers["content-type"]);
        request.resume();
        request.once("end", () => response.end("ok"));
      });
      for (const request of [
        Request.post(origin).pipe(
          Request.setHeader("Content-Type", "application/weird"),
          Request.body(Body.text),
        ),
        Request.post(origin).pipe(
          Request.removeHeader("content-type"),
          Request.body(Body.text),
        ),
      ]) {
        yield* Operation.make(request, Response.status(200, Body.text))
          .execute({ body: "hello" })
          .pipe(Effect.provide(FetchHttpClient.layer));
      }
      expect(received).toEqual(["application/weird", undefined]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/93
  it.live("Fetch does not send a fragment the library passed on", () =>
    Effect.gen(function* () {
      const targets: Array<string | undefined> = [];
      const { origin } = yield* listen((request, response) => {
        targets.push(request.url);
        response.end("ok");
      });
      const seen: Array<Option.Option<string>> = [];
      yield* Operation.make(
        Request.get(`${origin}/a?q=1#top`),
        Response.status(200, Body.text),
        {
          transformClient: HttpClient.mapRequest((request) => {
            seen.push(request.hash);
            return request;
          }),
        },
      )
        .execute(undefined)
        .pipe(Effect.provide(FetchHttpClient.layer));
      expect(seen).toStrictEqual([Option.some("top")]);
      expect(targets).toEqual(["/a?q=1"]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/96
  it.live("Fetch refuses a GET body the library passed on", () =>
    Effect.gen(function* () {
      let requests = 0;
      const { origin } = yield* listen((_, response) => {
        requests++;
        response.end("ok");
      });
      const error = yield* Operation.make(
        Request.get(origin).pipe(Request.body(Body.text)),
        Response.status(200, Body.text),
      )
        .execute({ body: "<Envelope/>" })
        .pipe(Effect.provide(FetchHttpClient.layer), Effect.flip);
      expect(error).toBeInstanceOf(HttpClientError.HttpClientError);
      expect(error).toMatchObject({ reason: { _tag: "TransportError" } });
      expect(requests).toBe(0);
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
