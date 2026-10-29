import type { Effect, Layer, Scope } from "effect";
import type { HttpClient } from "effect/http";

/**
 * The interface every scenario uses, implemented once per lane. Tests import it from `#lane`, which
 * resolves to `lane.node.ts` in the Node project and to `lane.browser.ts` in the browser project.
 * Backends always run in Node; only the consumer moves between lanes.
 */

/** Plain JSON, the only kind of option that can cross from a browser test to a Node backend. */
export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/** One request as the backend's socket received it. */
export interface Recorded {
  readonly method: string;
  /** The request target as sent: path and query, not decoded. */
  readonly target: string;
  /** Header lines in order, with their original spelling and repetition. */
  readonly lines: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
  /** Whether the client had closed the connection before the reply ended, when the ledger was read. */
  readonly aborted: boolean;
}

export interface Backend {
  /**
   * `http://127.0.0.<n>:<port>`, without a trailing slash. The browser lane gives each backend its
   * own loopback address, so backends never share a browser cookie jar.
   */
  readonly origin: string;
  /**
   * The requests received so far, in arrival order. In the browser lane, CORS preflights answered
   * by the harness are left out, so request counts mean the same in both lanes.
   */
  readonly ledger: Effect.Effect<ReadonlyArray<Recorded>>;
  /** Completes once at least `count` requests have arrived. */
  readonly arrived: (count: number) => Effect.Effect<void>;
}

export interface StartOptions {
  /**
   * Browser lane only. `"harness"` (the default) answers preflights and lets the test page read
   * every response header, so a backend's own conventions are what the browser sees. `"backend"`
   * leaves CORS entirely to the backend, for scenarios about its CORS behaviour.
   */
  readonly cors?: "harness" | "backend";
}

export interface Lane {
  readonly name: "node" | "browser";
  /** Start a backend by name (`identity`, `business`, …) with JSON options, for the current scope. */
  readonly backend: (
    name: string,
    options?: Json,
    start?: StartOptions,
  ) => Effect.Effect<Backend, never, Scope.Scope>;
  /** The HTTP client providers available in this lane, by name. */
  readonly clients: ReadonlyArray<
    readonly [name: string, layer: Layer.Layer<HttpClient.HttpClient>]
  >;
  /** Effect's Fetch provider: Node's `fetch` or the browser's. */
  readonly fetchClient: Layer.Layer<HttpClient.HttpClient>;
  /** The line-preserving `node:http` provider, in the Node lane only. */
  readonly linesClient: Layer.Layer<HttpClient.HttpClient> | undefined;
}

/** Text of a recorded body. */
export const bodyText = (
  recorded: Recorded,
  decoder: TextDecoder = new TextDecoder(),
): string => decoder.decode(recorded.body);

/** The first value of a header in recorded lines, case-insensitively. */
export const header = (
  lines: Recorded["lines"],
  name: string,
): string | undefined =>
  lines.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

/** Every value of a header, one per physical line. */
export const headerValues = (
  lines: Recorded["lines"],
  name: string,
): ReadonlyArray<string> =>
  lines
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);

/** Query parameters of a recorded target, in order and with repetition. */
export const queryOf = (recorded: Recorded): URLSearchParams =>
  new URL(recorded.target, "http://placeholder").searchParams;

/** The recorded path, not decoded. */
export const pathOf = (recorded: Recorded): string =>
  recorded.target.split("?")[0] ?? "";
