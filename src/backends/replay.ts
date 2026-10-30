/**
 * The replay backend: serves responses recorded from real server software (`recordings/`) over a
 * real socket, so the consumer decodes bytes that software wrote rather than an imitation. Each
 * start reads the listed exchanges with `node:fs` and answers each request with the first unused
 * exchange whose recorded method and target equal the request's.
 *
 * Service documentation: services/replay.md
 */
import { readFileSync } from "node:fs";
import { textReply } from "../harness/route.js";
import type { Handler, Lines, Reply } from "../harness/server.js";

/** The test options, documented under "Test options" in the service page. */
export interface Options {
  readonly exchanges: ReadonlyArray<string>;
  readonly reuse?: boolean;
}

interface Exchange {
  readonly name: string;
  readonly method: string;
  readonly target: string;
  readonly reply: Reply;
}

const recordings = new URL("../../recordings/", import.meta.url);
const NAME = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

/** The body of a chunked message without its framing; throws on a malformed or cut-off one. */
const unchunk = (framed: Buffer): Buffer => {
  const parts: Array<Buffer> = [];
  let at = 0;
  for (;;) {
    const line = framed.indexOf(CRLF, at);
    if (line < 0) throw new Error("a chunk size line without its end");
    const size = Number.parseInt(
      framed.subarray(at, line).toString("latin1").split(";")[0]!,
      16,
    );
    if (Number.isNaN(size)) throw new Error("a malformed chunk size");
    at = line + CRLF.length;
    if (size === 0) return Buffer.concat(parts);
    parts.push(framed.subarray(at, at + size));
    at += size + CRLF.length;
  }
};

/** Split a recorded message into its start line, header lines as written, and body bytes. */
const split = (bytes: Buffer) => {
  const end = bytes.indexOf(HEAD_END);
  if (end < 0) throw new Error("a message without the end of its head");
  const [start = "", ...rest] = bytes
    .subarray(0, end)
    .toString("latin1")
    .split("\r\n");
  const lines: Lines = rest.map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).replace(/^[ \t]+/, "")];
  });
  return { start, lines, body: bytes.subarray(end + HEAD_END.length) };
};

const load = (name: string): Exchange => {
  if (!NAME.test(name))
    throw new Error(`an exchange is named <set>/<name>, not ${name}`);
  const request = split(
    readFileSync(new URL(`${name}.request.http`, recordings)),
  );
  const response = split(
    readFileSync(new URL(`${name}.response.http`, recordings)),
  );
  const [method = "", target = ""] = request.start.split(" ");
  const status = /^HTTP\/1\.[01] (\d{3}) (.*)$/.exec(response.start);
  if (status === null)
    throw new Error(`${name}: not a status line: ${response.start}`);
  const chunked = response.lines.some(
    ([field, value]) =>
      field.toLowerCase() === "transfer-encoding" && /chunked/i.test(value),
  );
  return {
    name,
    method,
    target,
    reply: {
      status: Number(status[1]),
      statusText: status[2]!,
      // Node frames the body itself: a chunked recording is sent chunked again, from its bytes.
      lines: response.lines,
      body: chunked ? unchunk(response.body) : response.body,
    },
  };
};

export const handler = (options: Options = { exchanges: [] }): Handler => {
  const exchanges = options.exchanges.map(load);
  const used = new Set<Exchange>();
  return (request) => {
    const found = exchanges.find(
      (exchange) =>
        (options.reuse === true || !used.has(exchange)) &&
        exchange.method === request.method &&
        exchange.target === request.target,
    );
    if (found === undefined)
      return textReply(
        404,
        `no unused recorded exchange for ${request.method} ${request.target}`,
        "text/plain",
      );
    used.add(found);
    return found.reply;
  };
};
