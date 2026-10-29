import { connect } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schedule } from "effect";
import {
  Body,
  Operation,
  Request,
  Response,
  Transport,
} from "viell-effect-schema-http";
import { startControl } from "./control.js";
import { fetchClient, linesLayer } from "./providers.js";
import { header, headerValues, serve } from "./server.js";

/** Ten distinct bytes, a hundred times: the part of an upload that arrives before the cut. */
const partial = "0123456789".repeat(100);

/**
 * Open a raw connection and start a POST that declares 100,000 bytes but sends only `partial`. The
 * socket is destroyed when the test's scope closes, if the test has not cut it off by then.
 */
const startUpload = (origin: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const { hostname, port, host } = new URL(origin);
      const socket = connect(Number(port), hostname);
      // The server may reset the connection once it is cut; that is the point, not a failure.
      socket.on("error", () => undefined);
      socket.write(
        [
          "POST /upload HTTP/1.1",
          `Host: ${host}`,
          "Content-Type: application/octet-stream",
          "Content-Length: 100000",
          "",
          partial,
        ].join("\r\n"),
      );
      return socket;
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );

/** Re-check `condition` every 10 ms until it holds, failing after two seconds. */
const eventually = (condition: () => boolean | Promise<boolean>) =>
  Effect.promise(async () => condition()).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (held) => held,
      times: 200,
    }),
    Effect.flatMap((held) =>
      held ? Effect.void : Effect.die(new Error("condition never held")),
    ),
  );

/** Collect unhandled rejections for the rest of the test. */
const watchRejections = Effect.acquireRelease(
  Effect.sync(() => {
    const seen: Array<unknown> = [];
    const listener = (reason: unknown) => {
      seen.push(reason);
    };
    process.on("unhandledRejection", listener);
    return { seen, listener };
  }),
  ({ listener }) =>
    Effect.sync(() => process.off("unhandledRejection", listener)),
);

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
    "records an upload at arrival, and one cut off mid-body as aborted with the bytes received, without an unhandled rejection",
    () =>
      Effect.gen(function* () {
        // Needs raw sockets, which only Node has: a client library always finishes its upload.
        const rejections = yield* watchRejections;
        let handled = 0;
        const server = yield* serve(() => {
          handled++;
          return { status: 200 };
        });
        const socket = yield* startUpload(server.origin);
        yield* Effect.promise(() => server.arrived(1));
        // Recorded before the body is complete; the entry shows the bytes so far.
        yield* eventually(
          () => server.ledger[0]!.body.length === partial.length,
        );
        expect(server.ledger[0]!.aborted()).toBe(false);
        socket.destroy();
        yield* eventually(() => server.ledger[0]!.aborted());
        // Give the disconnect's remaining events, and any rejection they raise, time to surface.
        yield* Effect.sleep("50 millis");
        const [entry, ...rest] = server.ledger;
        expect(rest).toEqual([]);
        expect(entry!.method).toBe("POST");
        expect(entry!.target).toBe("/upload");
        expect(header(entry!.lines, "content-length")).toBe("100000");
        expect(new TextDecoder().decode(entry!.body)).toBe(partial);
        expect(entry!.aborted()).toBe(true);
        expect(handled).toBe(0);
        expect(rejections.seen).toEqual([]);
      }),
  );

  it.live(
    "the control server reports a cut-off upload from the same ledger entry",
    () =>
      Effect.gen(function* () {
        const rejections = yield* watchRejections;
        const control = yield* Effect.acquireRelease(
          Effect.promise(() => startControl()),
          (started) => Effect.promise(() => started.close()),
        );
        const call = (path: string, init?: RequestInit) =>
          Effect.promise(async () => {
            const response = await fetch(`${control.url}${path}`, init);
            expect(response.ok).toBe(true);
            return response.status === 204 ? undefined : response.json();
          });
        const { id, origin } = (yield* call("/backends", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "echo" }),
        })) as { readonly id: string; readonly origin: string };
        const socket = yield* startUpload(origin);
        yield* call(`/backends/${id}/arrived?count=1`);
        type Entry = { readonly body: string; readonly aborted: boolean };
        const ledger = () =>
          fetch(`${control.url}/backends/${id}/ledger`).then(
            (response) => response.json() as Promise<ReadonlyArray<Entry>>,
          );
        yield* eventually(
          async () => atob((await ledger())[0]!.body).length === partial.length,
        );
        socket.destroy();
        yield* eventually(async () => (await ledger())[0]!.aborted);
        yield* Effect.sleep("50 millis");
        const entries = yield* Effect.promise(ledger);
        expect(entries).toEqual([
          {
            method: "POST",
            target: "/upload",
            lines: [
              ["Host", new URL(origin).host],
              ["Content-Type", "application/octet-stream"],
              ["Content-Length", "100000"],
            ],
            body: btoa(partial),
            aborted: true,
          },
        ]);
        expect(rejections.seen).toEqual([]);
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
