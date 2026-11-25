import { Effect, type Scope } from "effect";
import { lane } from "#lane";
import type { Client, Listener } from "./lane.js";
import type { Definition } from "./routes.js";
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
