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
  /**
   * The request target as sent, not decoded, one character per byte: normally the path and query,
   * and anything else the client wrote there, such as a fragment, `*` or a whole URL.
   */
  readonly target: string;
  /** Header lines in order, with their original spelling and repetition. */
  readonly lines: ReadonlyArray<readonly [string, string]>;
  /**
   * The request line and header lines as they arrived, one character per byte, up to the blank line
   * that ends them. Only a backend started with `listener: "socket"` has this.
   */
  readonly head?: string | undefined;
  /**
   * The body bytes received when the ledger was read. A request is recorded as its head arrives, so
   * an upload still in progress, or cut off by a disconnect, shows the bytes that had arrived.
   */
  readonly body: Uint8Array;
  /** Whether the client had closed the connection before the reply ended, when the ledger was read. */
  readonly aborted: boolean;
  /**
   * The connection this request arrived on, numbered from 1 for each backend, so two requests with
   * one number shared a connection. In the browser lane a preflight the harness answers takes a
   * number too, though it is left out of the ledger, so numbers need not be consecutive.
   */
  readonly connection: number;
  /**
   * Whether that connection was still open when the ledger was read, whichever side closed it. A
   * server learns of a client's close when the socket does, so read the ledger until it shows.
   */
  readonly connectionOpen: boolean;
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
  /**
   * Completes once at least `count` requests have arrived: their heads, whether or not their bodies
   * are complete. Preflights answered by the harness do not count.
   */
  readonly arrived: (count: number) => Effect.Effect<void>;
}

export interface StartOptions {
  /**
   * Browser lane only. `"harness"` (the default) answers preflights and lets the test page read
   * every response header, so a backend's own conventions are what the browser sees. `"backend"`
   * leaves CORS entirely to the backend, for scenarios about its CORS behaviour.
   */
  readonly cors?: "harness" | "backend";
  /**
   * Both lanes. `"http"` (the default) is `node:http`, which refuses or reshapes some requests before
   * a backend sees them. `"socket"` is a plain socket listener that refuses nothing, serves one
   * request per connection and records each request's `head`. Its reply is the same as under
   * `node:http`, except `Connection: close`. A body needs `Content-Length`, or it is ignored.
   */
  readonly listener?: "http" | "socket";
}

/** How the raw provider writes a request. */
export interface RawOptions {
  /**
   * `false` adds no `Content-Type` or `Content-Length` for the body, so a request goes out with only
   * the header lines it has, and `Host` when it has none, and its body bytes after them.
   */
  readonly framing?: boolean;
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
  /**
   * The raw provider for the server at `origin`, in the Node lane only: it writes the request as
   * written to a socket of its own, with no URL parsing, so it reaches that one origin alone. Its
   * target is `request.url` without `origin`, then `#` and `request.hash` when there is a hash; a URL
   * that does not start with `origin`, such as `*`, goes on the request line whole. Its header lines
   * are `Transport.headerLines`, with `Host` and `Content-Length` added only when the request has
   * none and they apply, unless `options` says otherwise. `src/harness/providers.ts` gives the
   * details.
   */
  readonly rawClient:
    | ((
        origin: string,
        options?: RawOptions,
      ) => Layer.Layer<HttpClient.HttpClient>)
    | undefined;
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

/** The recorded path, not decoded: the target up to its query or fragment. */
export const pathOf = (recorded: Recorded): string =>
  recorded.target.split(/[?#]/)[0] ?? "";
