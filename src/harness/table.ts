import { Effect, type Scope } from "effect";
import { inject } from "vitest";
import type { Exchange, WireRequest } from "./evidence.js";
import type { Listener } from "./lane.js";
import type { Definition } from "./routes.js";

export interface Table {
  readonly definition: Definition;
  /** Where each listener is reached. The cleartext ones are behind recording proxies. */
  readonly origins: Readonly<Record<Listener, string>>;
  /**
   * The exchanges that reached the routes since the last `take`, in order, and the request heads
   * that crossed a cleartext listener in that time, preflights included.
   */
  readonly take: Effect.Effect<{
    readonly exchanges: ReadonlyArray<Exchange>;
    readonly wire: ReadonlyArray<WireRequest>;
  }>;
}

export interface OpenOptions {
  /** Answer CORS preflights outside the routes, for a test page. The browser lane needs it. */
  readonly cors?: boolean;
  /** A fixed HTTPS port, where the browser was told to use HTTP/3. */
  readonly httpsPort?: number;
  /** Override Warded Server's head size limit. The plain listener uses Hyper's default. */
  readonly headBytes?: number;
}

const control = (path: string, init?: RequestInit) =>
  Effect.promise(async () => {
    const response = await fetch(`${inject("control")}${path}`, init);
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(`control ${path}: ${String(value)}`);
    return value;
  });

interface Opened {
  readonly id: number;
  readonly origins: Table["origins"];
  readonly ports: Readonly<Record<Listener, number>>;
}

const close = (opened: Opened) =>
  Effect.ignore(control(`/tables/${opened.id}`, { method: "DELETE" }));

/**
 * Open a table. The browser lane's Chromium uses HTTP/3 on one port, so a table whose HTTPS listener
 * happens to get that port without asking for it is opened again elsewhere, or its HTTP/2 requests
 * would become HTTP/3 ones.
 */
const opening = (
  definition: Definition,
  options: OpenOptions,
): Effect.Effect<Opened> =>
  Effect.flatMap(
    control("/tables", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...definition, ...options }),
    }) as Effect.Effect<Opened>,
    (opened) =>
      options.httpsPort === undefined &&
      opened.ports.https === inject("quicPort")
        ? Effect.andThen(close(opened), opening(definition, options))
        : Effect.succeed(opened),
  );

/** Serve a route table for the current scope. A definition the host refuses fails the test. */
export const open = (
  definition: Definition,
  options: OpenOptions = {},
): Effect.Effect<Table, never, Scope.Scope> =>
  Effect.acquireRelease(opening(definition, options), close).pipe(
    Effect.map(({ id, origins }) => ({
      definition,
      origins,
      take: control(`/tables/${id}`) as Table["take"],
    })),
  );
