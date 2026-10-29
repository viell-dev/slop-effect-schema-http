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
