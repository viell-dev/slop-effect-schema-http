/**
 * The exports, each written as its Perl job prints it. A row keeps its framing apart from its other
 * lines, because a fault on an export replaces the framing and keeps the rest.
 */
import { chunk, lastChunk } from "../../harness/route.js";
import type { RawStep } from "../../harness/server.js";
import { type Answer, head, type Readable } from "./edge.js";

const J = Buffer.from('{"ok":true}');
const CT = "Content-Type: application/json";
const TEXT = "Content-Type: text/plain; charset=utf-8";
const LENGTH = "Content-Length: 11";
const CHUNKED = "Transfer-Encoding: chunked";

interface Row {
  /** Defaults to `HTTP/1.1 200 OK`. */
  readonly statusLine?: string;
  readonly lines: ReadonlyArray<string>;
  /** Defaults to {@link LENGTH}. */
  readonly framing?: ReadonlyArray<string>;
  /** Defaults to CRLF. */
  readonly lineEnd?: string;
  /** Defaults to {@link J}. */
  readonly body?: Buffer;
  /** The body as written, when that is not {@link Row.body} in one piece. */
  readonly steps?: ReadonlyArray<RawStep>;
}

/** Text in two chunks, split `at` a byte and with a pause between them. */
const split = (body: Buffer, at: number): Row => ({
  lines: [TEXT],
  framing: [CHUNKED],
  body,
  steps: [
    chunk(body.subarray(0, at)),
    { wait: 25 },
    chunk(body.subarray(at)),
    lastChunk,
  ],
});

const rows: ReadonlyMap<string, Row> = new Map<string, Row>([
  ["two-types", { lines: ["Content-Type: text/plain", CT] }],
  ["same-type-twice", { lines: [CT, CT] }],
  ["no-type", { lines: [] }],
  [
    "odd-charset",
    { lines: ["Content-Type: text/plain; charset=no-such-charset"] },
  ],
  // A string goes out one byte per character, so these are the bytes the page names.
  ["latin1-value", { lines: [CT, "X-Vessel: M\xfcller"] }],
  ["utf8-value", { lines: [CT, "X-Vessel: M\xc3\xbcller"] }],
  ["nul-value", { lines: [CT, "X-Vessel: a\0b"] }],
  ["ctl-value", { lines: [CT, "X-Vessel: a\x01b"] }],
  ["folded-value", { lines: [CT, "X-Vessel: a", " b"] }],
  ["bare-lf", { lines: [CT, "X-Vessel: a"], lineEnd: "\n" }],
  ["no-colon", { lines: [CT, "garbage"] }],
  ["two-lengths", { lines: [CT], framing: [LENGTH, "Content-Length: 5"] }],
  ["same-length-twice", { lines: [CT], framing: [LENGTH, LENGTH] }],
  [
    "length-and-chunked",
    {
      lines: [CT],
      framing: ["Content-Length: 3", CHUNKED],
      steps: [chunk(J), lastChunk],
    },
  ],
  ["no-reason", { statusLine: "HTTP/1.1 200", lines: [CT] }],
  ["http10", { statusLine: "HTTP/1.0 200 OK", lines: [CT], framing: [] }],
  ["bad-status", { statusLine: "HTTP/1.1 abc OK", lines: [CT] }],
  ["status-99", { statusLine: "HTTP/1.1 99 Odd", lines: [CT] }],
  ["no-version", { statusLine: "200 OK", lines: [CT] }],
  ["split-utf8", split(Buffer.from("Grüße"), 3)],
  ["split-emoji", split(Buffer.from("ship 🚢 ok"), 7)],
  ["split-bom", split(Buffer.from([0xef, 0xbb, 0xbf, 0x6f, 0x6b]), 1)],
  [
    "cut-utf8",
    {
      lines: [TEXT],
      framing: ["Content-Length: 3"],
      body: Buffer.from([0x47, 0x72, 0xc3]),
    },
  ],
]);

/** The export called `name`, or undefined when there is none. */
export const exported = (name: string): Readable | undefined => {
  const row = rows.get(name);
  if (row === undefined) return undefined;
  const { statusLine = "HTTP/1.1 200 OK", lines, body = J } = row;
  const { framing = [LENGTH], lineEnd = "\r\n", steps = [body] } = row;
  const answer: Answer = {
    statusLine,
    lines,
    body,
    // An export ends its connection however it is framed, so this is raw as well.
    whole: (added, stream) => ({
      head: head(
        answer,
        added.map(([key, value]) => `${key}: ${value}`),
      ),
      body: [stream],
    }),
  };
  return {
    head: [statusLine, ...lines, ...framing, "", ""].join(lineEnd),
    body: steps,
    answer,
  };
};
