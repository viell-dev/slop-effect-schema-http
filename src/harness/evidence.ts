/**
 * What the suite learns about each exchange, in the order it happens: the bytes a client wrote, the
 * head the server stack gave the router, what `Router::select` said about that head, and which
 * target ran. A difference between two neighbours says which project a mismatch belongs to.
 */

/** A request as it crossed a cleartext socket, read one character for each byte. */
export interface WireRequest {
  /** Which cleartext listener it reached. HTTPS is not recorded on the wire. */
  readonly listener: "plain" | "http";
  /** The connection it arrived on, numbered from 1 for each table. */
  readonly connection: number;
  /** The request line and header lines up to the blank line that ends them. */
  readonly head: string;
  readonly method: string;
  /** The request target, not decoded: everything between the first two spaces. */
  readonly target: string;
  /** The protocol named on the request line. */
  readonly protocol: string;
  /** Header lines in order, with their spelling and repetition. */
  readonly lines: ReadonlyArray<readonly [string, string]>;
  /** A CORS preflight, which the host answers outside the routes. */
  readonly preflight: boolean;
}

/** A field of an HTTP/2 header block: a name and a value, one character for each byte. */
export type Field = readonly [string, string];

/** What came back for a request that the HTTP/2 client sent; `host/src/h2.rs` has the details. */
export type H2Received =
  | {
      readonly is: "response";
      readonly status: number;
      /** The response's fields in order, without `:status`. */
      readonly fields: ReadonlyArray<Field>;
      /** The content, in base64. */
      readonly body: string;
    }
  /** RST_STREAM on the request's stream: a stream error. */
  | { readonly is: "reset"; readonly code: string }
  /** GOAWAY before the response ended: a connection error. */
  | { readonly is: "go_away"; readonly code: string; readonly debug: string }
  /** The connection ended without any of those. */
  | { readonly is: "closed" };

/**
 * A request as the HTTP/2 client wrote it to the HTTPS listener, which has no recording proxy. The
 * client writes each field as a plain literal, in order, so its fields are what crossed the wire.
 */
export interface H2Exchange {
  readonly fields: ReadonlyArray<Field>;
  readonly received: H2Received;
}

/** The request head as the HTTP stack gave it to the router. */
export interface Seen {
  readonly method: string;
  readonly version: "HTTP/1.0" | "HTTP/1.1" | "HTTP/2" | "HTTP/3" | "another";
  /** `http::Uri` as text. HTTP/2 and HTTP/3 put the scheme and authority in it. */
  readonly uri: string;
  /** `Uri::path`, which Warded's path conditions read. */
  readonly path: string;
  /** `Uri::query`, which Warded's query conditions read. */
  readonly query: string | null;
  /** The header map, one entry per value, names lowercase, one character for each byte. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The `TransportSecurity` extension the listener inserted. */
  readonly security: "https" | "unsecure" | "unknown";
}

/** What `Router::select` said about the head, apart from dispatch. */
export type Verdict =
  | {
      readonly is: "selected";
      readonly index: number;
      readonly captures: Readonly<Record<string, string>>;
    }
  | { readonly is: "missed" }
  | { readonly is: "failed"; readonly error: string };

type Result<A> = { readonly Ok: A } | { readonly Err: string };

/** What the target that ran knows about its request. */
export interface Dispatched {
  readonly route: string;
  /** The `Selection` in the request's extensions; a fallback has none. */
  readonly index: number | null;
  /** The `Captures` in the request's extensions, raw. */
  readonly captures: Readonly<Record<string, string>>;
  /** The captures as the server's `Params` extractor decoded them, or its refusal. */
  readonly params: Result<Readonly<Record<string, string>>>;
  /** The request body in base64, as the target read it. */
  readonly body: Result<string>;
}

export interface Exchange {
  readonly seen: Seen;
  readonly verdict: Verdict;
  /** `null` when no target ran: a miss without fallback, or a routing error. */
  readonly dispatched: Dispatched | null;
  readonly status: number;
}

/** The values of one header in a head, case-insensitively. */
export const values = (
  lines: ReadonlyArray<readonly [string, string]>,
  name: string,
): ReadonlyArray<string> =>
  lines
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);

/** The text of a body the target read. */
export const bodyText = (dispatched: Dispatched | null): string | undefined =>
  dispatched !== null && "Ok" in dispatched.body
    ? new TextDecoder().decode(
        Uint8Array.from(atob(dispatched.body.Ok), (c) => c.charCodeAt(0)),
      )
    : undefined;
