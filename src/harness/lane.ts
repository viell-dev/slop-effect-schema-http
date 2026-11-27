import type { Layer } from "effect";
import type { HttpClient } from "effect/http";
import type { Field, H2Exchange, H3Exchange } from "./evidence.js";

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
  /**
   * `false` adds no `Host` either, so a request that declares none goes out without one. Default:
   * `true`, since HTTP/1.1 requires one.
   */
  readonly host?: boolean;
  /** The protocol on the request line. Default: `HTTP/1.1`. */
  readonly protocol?: string;
}

/** How the HTTP/2 provider writes a request. */
export interface H2Options {
  /**
   * Rewrite the header block before it is sent: repeat, reorder, drop, change or add fields,
   * pseudo-header fields included. It receives the fields the provider composed, one character for
   * each byte. Default: send them as composed.
   */
  readonly fields?: (composed: ReadonlyArray<Field>) => ReadonlyArray<Field>;
}

/** The HTTP/2 provider for one origin, and what it sent there. */
export interface H2Provider {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  /** Each request it sent, in order, with what came back. */
  readonly exchanges: ReadonlyArray<H2Exchange>;
}

/** The HTTP/3 provider writes a request as the HTTP/2 provider does. */
export type H3Options = H2Options;

/** The HTTP/3 provider for one origin, and what it sent there. */
export interface H3Provider {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  /** Each request it sent, in order, with what came back. */
  readonly exchanges: ReadonlyArray<H3Exchange>;
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
  /**
   * The HTTP/2 provider for the listener at `origin`, in the Node lane only: over TLS on `https`,
   * and with prior knowledge (h2c) on the cleartext ones. It writes the request's header block
   * field by field through the host's HTTP/2 client, with nothing refused; `providers.ts` gives
   * the details.
   */
  readonly h2:
    ((origin: string, options?: H2Options) => H2Provider) | undefined;
  /**
   * The HTTP/3 provider for the HTTPS listener at `origin`, in the Node lane only: the HTTP/2
   * provider's requests, through the host's HTTP/3 client.
   */
  readonly h3:
    ((origin: string, options?: H3Options) => H3Provider) | undefined;
}
