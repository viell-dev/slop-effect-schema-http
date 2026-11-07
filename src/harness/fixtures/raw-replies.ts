import {
  chunk,
  gzip,
  type GzipDamage,
  lastChunk,
  noReply,
  rawHead,
  rawRouter,
  textReply,
  trickled,
  truncated,
} from "../route.js";
import type { RawHandler, RawReply, Reply } from "../server.js";

/**
 * A neutral fixture for the harness's own tests of raw replies, in both lanes, not part of the
 * catalogue. A browser test can start a backend only by name, so each shape a raw reply can take
 * has a path here: any request to `/<name>` answers the shape in the table below. Its text is `hello world`
 * wherever it has a body.
 */

const text = "hello world";
const plain = [["Content-Type", "text/plain"]] as const;
const chunked = [...plain, ["Transfer-Encoding", "chunked"]] as const;
const encoder = new TextEncoder();

const gzipReply = (damage?: GzipDamage): Reply => ({
  status: 200,
  lines: [...plain, ["Content-Encoding", "gzip"]],
  body: gzip(text, damage),
});

const replies: Readonly<Record<string, () => Reply | RawReply>> = {
  whole: () => textReply(200, text, "text/plain"),
  "raw-whole": () => ({
    head: rawHead(200, [...plain, ["Content-Length", String(text.length)]]),
    body: [text],
  }),
  "truncated-length": () => truncated(200, plain, text, 5),
  "truncated-reset": () => {
    const reply = truncated(200, plain, text, 5, "reset");
    // Let the bytes arrive first: a reset can overtake what the client has not read yet.
    return { ...reply, body: [...reply.body!, { wait: 50 }] };
  },
  "close-delimited": () => ({
    head: rawHead(200, [...plain, ["Connection", "close"]]),
    body: ["hello"],
  }),
  chunked: () => ({
    head: rawHead(200, chunked),
    body: [chunk("hello "), chunk("world"), lastChunk],
  }),
  "truncated-chunked": () => ({
    head: rawHead(200, chunked),
    body: [chunk("hello")],
  }),
  "bad-chunk-terminator": () => ({
    head: rawHead(200, chunked),
    body: [chunk("hello", "XX"), chunk("world"), lastChunk],
  }),
  gzip: () => gzipReply(),
  "gzip-magic": () => gzipReply("magic"),
  "gzip-block": () => gzipReply("block"),
  "gzip-checksum": () => gzipReply("checksum"),
  "gzip-truncated": () => gzipReply("truncated"),
  "gzip-trailer": () => gzipReply("trailer"),
  trickled: () =>
    trickled(200, [...plain, ["Content-Length", "1000"]], "x", 20),
  "no-reply": () => noReply(),
  "no-reply-reset": () => noReply("reset"),
  "cut-head": () => ({ head: "HTTP/1.1 200 OK\r\nContent-Ty" }),
  "nul-in-value": () => ({
    head: "HTTP/1.1 200 OK\r\nX-Bad: a\0b\r\nContent-Length: 2\r\n\r\n",
    body: ["ok"],
  }),
  "split-utf8": () => {
    const bytes = encoder.encode("ä");
    return {
      head: rawHead(200, [
        ["Content-Type", "text/plain; charset=utf-8"],
        ["Transfer-Encoding", "chunked"],
      ]),
      body: [
        chunk(bytes.subarray(0, 1)),
        { wait: 20 },
        chunk(bytes.subarray(1)),
        lastChunk,
      ],
    };
  },
};

export const handler = (): RawHandler =>
  rawRouter(
    Object.entries(replies).map(([name, reply]) => ({
      method: "*",
      path: `/${name}`,
      handle: reply,
    })),
  );
