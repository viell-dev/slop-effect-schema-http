/**
 * What the suite learns about each exchange, in the order it happens: the bytes a client wrote, the
 * head the server stack gave the router, what `Router::select` said about that head, and which
 * target ran. A difference between two neighbours says which project a mismatch belongs to.
 */

/**
 * A request as it crossed a cleartext socket, read one character for each byte. For HTTP/2 with
 * prior knowledge, only the connection preface's request line, `PRI * HTTP/2.0`; the HTTP/2
 * provider's own record holds the fields.
 */
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
  /**
   * Informational heads, then the end of the stream, which RFC 9113 section 8.1 makes a malformed
   * response: their statuses, in order.
   */
  | { readonly is: "interim"; readonly statuses: ReadonlyArray<number> }
  /** The connection ended without any of those. */
  | { readonly is: "closed" };

/**
 * The parameters of the first SETTINGS frame that a server sent, by the names their RFCs give
 * them, such as `SETTINGS_MAX_HEADER_LIST_SIZE`. An unknown one is named by its identifier in hex,
 * and HTTP/3's greasing ones are left out. `null` when no SETTINGS arrived.
 */
export type Settings = Readonly<Record<string, number>> | null;

/**
 * A request as the HTTP/2 client wrote it to the HTTPS listener, which has no recording proxy. The
 * client writes each field as a plain literal, in order, so its fields are what crossed the wire.
 */
export interface H2Exchange {
  readonly fields: ReadonlyArray<Field>;
  readonly received: H2Received;
  /** The server's SETTINGS. */
  readonly settings: Settings;
  /** The size in bytes of the encoded header block. */
  readonly block: number;
  /** The frames that carried it: HEADERS, then CONTINUATION frames of at most 16 384 bytes. */
  readonly frames: number;
}

/** What came back for a request that the HTTP/3 client sent; `host/src/h3.rs` has the details. */
export type H3Received =
  | Extract<H2Received, { readonly is: "response" }>
  /** RESET_STREAM on the request stream: a stream error. */
  | { readonly is: "reset"; readonly code: string }
  /**
   * CONNECTION_CLOSE before the response ended: a connection error, with HTTP/3's code, or QUIC's
   * when QUIC itself closed the connection.
   */
  | { readonly is: "close"; readonly code: string; readonly reason: string }
  /** The connection ended without any of those. */
  | { readonly is: "closed" };

/**
 * A request as the HTTP/3 client wrote it to the HTTPS listener's HTTP/3 endpoint. The client
 * writes each field as a plain literal, in order, so its fields are what crossed the wire.
 */
export interface H3Exchange {
  readonly fields: ReadonlyArray<Field>;
  readonly received: H3Received;
  /** The SETTINGS on the server's control stream. */
  readonly settings: Settings;
  /** The size in bytes of the encoded field section: the payload of the HEADERS frame. */
  readonly block: number;
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
  /**
   * The status the application answered with, before the server finished the response: the
   * handler's own, which the client may not receive, such as an informational status.
   */
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
