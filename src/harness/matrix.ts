import { expect } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import type { HttpClient } from "effect/http";
import type { Operation } from "viell-effect-schema-http";
import { lane } from "#lane";
import type { Client, Listener } from "./lane.js";
import type { Definition } from "./routes.js";
import { send } from "./send.js";
import { open, type OpenOptions, type Table } from "./table.js";

/** One provider on one listener it can reach. */
export interface Case {
  readonly client: Client;
  readonly listener: Listener;
  /** `fetch on plain` and the like, for test titles. */
  readonly title: string;
}

/** Every provider of this lane on every listener it reaches, or on the ones named. */
export const cases = (only?: ReadonlyArray<Listener>): ReadonlyArray<Case> =>
  lane.clients.flatMap((client) =>
    client.reaches
      .filter((listener) => only === undefined || only.includes(listener))
      .map((listener) => ({
        client,
        listener,
        title: `${client.name} on ${listener}`,
      })),
  );

/** Serve a table for this lane: in a browser, with CORS answered outside the routes. */
export const serve = (
  definition: Definition,
  options: OpenOptions = {},
): Effect.Effect<Table, never, Scope.Scope> =>
  open(definition, { cors: lane.name === "browser", ...options });

/**
 * Whether a provider hands the URL to a WHATWG URL parser before sending it. Every provider built
 * with Effect's `HttpClient.make` does, and so does a browser's `fetch`: dot segments are resolved
 * and some characters percent-encoded on the way out. Only the raw provider writes the URL as the
 * library composed it.
 */
export const parsesUrls = (client: Client): boolean => client.name !== "raw";

/**
 * In a browser on `https`, send `probe` until one of its requests has gone over HTTP/3, and
 * elsewhere do nothing. Chromium starts there on HTTP/2 and moves to HTTP/3 once it has learned the
 * server's `Alt-Svc`, and at the move it can send one request over both, so a test that counts the
 * requests of a call waits for the move first.
 */
export const onHttp3 = <A, E>(
  table: Table,
  listener: Listener,
  client: Client,
  probe: Operation.Operation<void, A, E, HttpClient.HttpClient>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (lane.name !== "browser" || listener !== "https") return;
    for (let attempt = 1; ; attempt++) {
      const sent = yield* send(table, listener, client, probe, undefined);
      if (sent.exchanges.some(({ seen }) => seen.version === "HTTP/3")) return;
      expect(attempt, "Chromium did not move to HTTP/3").toBeLessThan(10);
    }
  });
