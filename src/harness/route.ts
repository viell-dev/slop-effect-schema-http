import { STATUS_CODES } from "node:http";
import { gzipSync } from "node:zlib";
import {
  type Bytes,
  type Context,
  type Handler,
  type Lines,
  path,
  type RawEnd,
  type RawHandler,
  type RawReply,
  type Received,
  type Reply,
} from "./server.js";

/** A route: a method (or `*`), a path pattern, and its handler. Named groups become `params`. */
export interface Route<Answer = Reply> {
  readonly method: string;
  readonly path: string | RegExp;
  readonly handle: (
    request: Received,
    context: Context & { readonly params: Readonly<Record<string, string>> },
  ) => Answer | Promise<Answer>;
}

/** A JSON reply with the given status and extra raw lines. */
export const json = (
  status: number,
  value: unknown,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply => ({
  status,
  lines: [["Content-Type", "application/json"], ...lines],
  body: JSON.stringify(value),
});

/** A text reply with an explicit content type, which may lie about the body. */
export const textReply = (
  status: number,
  body: string | Uint8Array,
  contentType: string,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply => ({
  status,
  lines: [["Content-Type", contentType], ...lines],
  body,
});

/**
 * A response head for a {@link RawReply}: the status line, `lines` as given, and the blank line. It
 * adds nothing, so a reply with a body states its own framing. `statusText` defaults to Node's text
 * for the status.
 */
export const rawHead = (
  status: number,
  lines: Lines = [],
  statusText: string = STATUS_CODES[status] ?? "",
): string =>
  [
    `HTTP/1.1 ${status} ${statusText}`,
    ...lines.map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");

/** The bytes of `bytes`, for a helper that has to measure or cut them. */
const raw = (bytes: Bytes): Buffer =>
  typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes);

/**
 * A reply that declares all of `body` with `Content-Length`, after `lines`, and then sends only its
 * first `sent` bytes before the connection ends.
 */
export const truncated = (
  status: number,
  lines: Lines,
  body: Bytes,
  sent: number,
  end: RawEnd = "close",
): RawReply => {
  const bytes = raw(body);
  return {
    head: rawHead(status, [...lines, ["Content-Length", String(bytes.length)]]),
    body: [bytes.subarray(0, sent)],
    end,
  };
};

/**
 * One chunk of a chunked body: its size line, `data`, and `terminator`, which is CRLF in a valid
 * chunk. Put the chunks in a raw reply's `body`, with a head that says
 * `Transfer-Encoding: chunked`, and end a valid body with {@link lastChunk}.
 */
export const chunk = (data: Bytes, terminator: Bytes = "\r\n"): Uint8Array => {
  const bytes = raw(data);
  return Buffer.concat([
    Buffer.from(`${bytes.length.toString(16)}\r\n`, "latin1"),
    bytes,
    raw(terminator),
  ]);
};

/** The last chunk and blank line that end a chunked body. */
export const lastChunk = "0\r\n\r\n";

/**
 * A reply whose head arrives and whose body never ends: `piece`, every `every` milliseconds, until
 * the client goes. `lines` state the framing, so `piece` is a {@link chunk} under chunked framing.
 */
export const trickled = (
  status: number,
  lines: Lines,
  piece: Bytes,
  every: number,
): RawReply => ({
  head: rawHead(status, lines),
  body: [{ repeat: piece, every }],
  end: "hold",
});

/**
 * No reply at all: the connection ends with nothing written. A handler that has already acted shows
 * a client a write that was committed and whose answer was lost.
 */
export const noReply = (end: RawEnd = "close"): RawReply => ({ head: "", end });

/**
 * What can be wrong with a gzip stream, each found at a different point of reading it:
 *
 * - `"magic"`: the first byte is wrong, so the stream is not gzip at all.
 * - `"block"`: the first deflate block claims the reserved type, so nothing decompresses.
 * - `"checksum"`: the CRC is wrong, so every byte decompresses and only the end can tell.
 * - `"truncated"`: the second half of the stream is missing, so some bytes decompress.
 * - `"trailer"`: only the CRC and length are missing, so every byte decompresses and nothing can
 *   tell whether they are right.
 */
export type GzipDamage =
  "magic" | "block" | "checksum" | "truncated" | "trailer";

/**
 * `data` as a gzip stream, damaged if asked. The result is bytes for a body, so a whole stream goes
 * in a `Reply` with `Content-Encoding: gzip` and valid framing, and framing that is cut short as
 * well is {@link truncated}'s.
 */
export const gzip = (data: Bytes, damage?: GzipDamage): Uint8Array => {
  const stream = gzipSync(raw(data));
  switch (damage) {
    case undefined:
      return stream;
    case "magic":
      stream[0] = 0;
      return stream;
    case "block":
      // After the ten-byte header: BFINAL, then BTYPE in the next two bits, where 3 is reserved.
      stream[10]! |= 0b110;
      return stream;
    case "checksum":
      stream[stream.length - 8]! ^= 0xff;
      return stream;
    case "truncated":
      return stream.subarray(0, Math.floor(stream.length / 2));
    case "trailer":
      return stream.subarray(0, stream.length - 8);
  }
};

const dispatch =
  <Answer>(
    routes: ReadonlyArray<Route<Answer>>,
    fallback?: Handler<Answer>,
  ): Handler<Answer | Reply> =>
  (request, context) => {
    const target = path(request);
    const allowed: Array<string> = [];
    for (const route of routes) {
      const match =
        typeof route.path === "string"
          ? route.path === target
            ? {}
            : undefined
          : route.path.exec(target)?.groups;
      const matched =
        typeof route.path === "string"
          ? route.path === target
          : route.path.test(target);
      if (!matched) continue;
      if (route.method !== "*" && route.method !== request.method) {
        allowed.push(route.method);
        continue;
      }
      return route.handle(request, { ...context, params: match ?? {} });
    }
    if (fallback !== undefined) return fallback(request, context);
    if (allowed.length > 0)
      return textReply(405, "Method Not Allowed", "text/plain", [
        ["Allow", allowed.join(", ")],
      ]);
    return textReply(404, "Not Found", "text/plain");
  };

/**
 * Dispatch to the first route whose method and path match. An unmatched path answers 404 and a
 * matched path with another method answers 405 with Allow, as a plain server would.
 */
export const router: (
  routes: ReadonlyArray<Route>,
  fallback?: Handler,
) => Handler = dispatch;

/** {@link router}, for routes that can answer with a raw reply as well as an ordinary one. */
export const rawRouter: (
  routes: ReadonlyArray<Route<Reply | RawReply>>,
  fallback?: RawHandler,
) => RawHandler = dispatch;
