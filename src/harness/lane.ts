import type { Layer } from "effect";
import type { HttpClient } from "effect/http";

/**
 * The interface every scenario uses, implemented once per lane. Tests import it from `#lane`, which
 * resolves to `lane.node.ts` in the Node project and to `lane.browser.ts` in the browser project.
 * The host always runs beside the control server; only the consumer moves between lanes.
 */

export type Listener = "plain" | "http" | "https";

/** A provider, and the listeners it can reach. */
export interface Client {
  readonly name: string;
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly reaches: ReadonlyArray<Listener>;
}

/** How the raw provider writes a request. */
export interface RawOptions {
  /**
   * `false` adds no `Content-Type` or `Content-Length` for the body, so a request goes out with only
   * the header lines it has, and `Host` when it has none, and its body bytes after them.
   */
  readonly framing?: boolean;
  /** The protocol on the request line. Default: `HTTP/1.1`. */
  readonly protocol?: string;
}

export interface Lane {
  readonly name: "node" | "browser";
  /** The providers an application in this lane would use, by name. */
  readonly clients: ReadonlyArray<Client>;
  /** Effect's Fetch provider: Node's `fetch` or the browser's. */
  readonly fetch: Client;
  /** The line-preserving `node:http` provider, in the Node lane only. */
  readonly lines: Client | undefined;
  /**
   * The raw provider for the server at `origin`, in the Node lane only. It writes the request as
   * written to a socket of its own, with no URL parsing; `providers.ts` gives the details.
   */
  readonly raw:
    | ((
        origin: string,
        options?: RawOptions,
      ) => Layer.Layer<HttpClient.HttpClient>)
    | undefined;
}
