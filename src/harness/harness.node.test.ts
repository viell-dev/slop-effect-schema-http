import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import {
  Body,
  Operation,
  Request,
  Response,
  Transport,
} from "viell-effect-schema-http";
import { fetchClient, linesLayer } from "./providers.js";
import { header, headerValues, serve } from "./server.js";

/** Scope lines sent one per physical line, the way a strict server requires them. */
const scoped = (origin: string) =>
  Operation.make(
    Request.get(`${origin}/scopes`).pipe(
      Request.appendHeader("X-Scope", "read"),
      Request.appendHeader("X-Scope", "write"),
    ),
    Response.status(200, Body.text),
  );

describe("harness", () => {
  it.live(
    "records raw request lines and replies with repeated response lines",
    () =>
      Effect.gen(function* () {
        const server = yield* serve(() => ({
          status: 200,
          lines: [
            ["Content-Type", "text/plain"],
            ["X-Scope", "a"],
            ["X-Scope", "b"],
          ],
          body: "ok",
        }));
        const viaLines = yield* scoped(server.origin)
          .execute(undefined)
          .pipe(Effect.provide(linesLayer));
        const viaFetch = yield* scoped(server.origin)
          .execute(undefined)
          .pipe(Effect.provide(fetchClient));
        expect([viaLines, viaFetch]).toEqual(["ok", "ok"]);
        const [lines, fetched] = server.ledger;
        expect(headerValues(lines!.lines, "x-scope")).toEqual([
          "read",
          "write",
        ]);
        expect(headerValues(fetched!.lines, "x-scope")).toEqual([
          "read, write",
        ]);
        expect(header(lines!.lines, "accept")).toBe("text/plain");
      }),
  );

  it.live("exposes provider response lines only from the custom provider", () =>
    Effect.gen(function* () {
      const server = yield* serve(() => ({
        status: 200,
        lines: [
          ["X-Scope", "a"],
          ["X-Scope", "b"],
        ],
        body: "",
      }));
      const metadata = Operation.make(
        Request.get(`${server.origin}/`),
        Response.status(
          200,
          Body.decoder((response) =>
            Effect.succeed(Transport.responseHeaderLines(response)),
          ),
        ),
      );
      const lines = yield* metadata
        .execute(undefined)
        .pipe(Effect.provide(linesLayer));
      const fetched = yield* metadata
        .execute(undefined)
        .pipe(Effect.provide(fetchClient));
      expect(lines._tag).toBe("Some");
      expect(fetched._tag).toBe("None");
    }),
  );

  for (const [name, client] of [
    ["lines", linesLayer],
    ["fetch", fetchClient],
  ] as const)
    it.live(`returns a bodyless 205 Reset Content as a success (${name})`, () =>
      Effect.gen(function* () {
        const server = yield* serve(() => ({ status: 205 }));
        const outcome = yield* Operation.make(
          Request.post(`${server.origin}/form`),
          Response.status(205, Response.tag("Reset", Body.empty)),
        )
          .execute(undefined)
          .pipe(Effect.provide(client), Effect.timeout("2 seconds"));
        expect(outcome._tag).toBe("Reset");
        expect(outcome.metadata.status).toBe(205);
        expect(server.ledger).toHaveLength(1);
      }),
    );

  it.live(
    "the line-preserving provider fails a response Fetch cannot represent as a transport error",
    () =>
      Effect.gen(function* () {
        // Node's server writes any three-digit status; a Fetch Response allows only 200 to 599.
        const server = yield* serve(() => ({ status: 600, body: "beyond" }));
        const error = yield* Operation.make(
          Request.get(`${server.origin}/odd`),
          Response.status(600, Body.text),
        )
          .execute(undefined)
          .pipe(
            Effect.provide(linesLayer),
            Effect.timeout("2 seconds"),
            Effect.flip,
          );
        expect(error._tag).toBe("HttpClientError");
        if (error._tag !== "HttpClientError") return;
        expect(error.reason._tag).toBe("TransportError");
        expect(String(error.reason.cause)).toMatch(/RangeError/);
      }),
  );

  it.live(
    "aborts a held-open request on interruption, observed by the server",
    () =>
      Effect.gen(function* () {
        let observe!: () => void;
        const observed = new Promise<void>((resolve) => (observe = resolve));
        const server = yield* serve(
          (_, context) =>
            new Promise((resolve) =>
              context.signal.addEventListener("abort", () => {
                observe();
                resolve({ status: 500 });
              }),
            ),
        );
        const fiber = yield* Operation.make(
          Request.get(`${server.origin}/hold`),
          Response.status(200, Body.empty),
        )
          .execute(undefined)
          .pipe(Effect.provide(linesLayer), Effect.forkChild);
        yield* Effect.promise(() => server.arrived(1));
        yield* Fiber.interrupt(fiber);
        yield* Effect.promise(() => observed);
        expect(server.ledger[0]?.aborted()).toBe(true);
      }),
  );
});
