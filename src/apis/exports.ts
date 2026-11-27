/**
 * Exports: the download endpoints of a back office's export service, written as a Warded route
 * table.
 *
 * The service writes each export as its query reads it, so the content arrives in pieces after the
 * head, and how it ends depends on what the query does: it finishes, waits on a lock that is never
 * released, loses its source, or fails. A progress stream stays open while an export runs. Finished
 * exports are files in an object store, which serves each with the `Content-Encoding` its uploader
 * recorded, and that need not describe the bytes. Every route and reply says which real-world
 * convention it imitates. Names, ids and data are synthetic.
 */
import {
  and,
  type Definition,
  exactPath,
  get,
  lookupRoute,
  path,
  type Reply,
  route,
} from "../harness/routes.js";

/** The orders export as CSV, with CRLF line ends as RFC 4180 has them. */
export const ordersCsv = [
  "order,region,total\r\n",
  "1001,north,41.50\r\n",
  "1002,south,37.00\r\n",
  "1003,north,12.25\r\n",
] as const;

/** The orders, as the NDJSON export writes them: one JSON object on each line. */
export const orders = [
  { order: "1001", region: "north", total: "41.50" },
  { order: "1002", region: "south", total: "37.00" },
  { order: "1003", region: "north", total: "12.25" },
  { order: "1004", region: "west", total: "8.00" },
  { order: "1005", region: "east", total: "19.90" },
] as const;

/** How long the export waits for each row from its query, in milliseconds. */
export const rowDelay = 100;

/** The beginning of the feed: a JSON document whose array is still open. */
export const feedStart = '{"items":[{"id":"o-1"},';

/** The progress stream's event, which it sends every 50 milliseconds while the export runs. */
export const heartbeat =
  'event: progress\ndata: {"export":"orders","state":"running"}\n\n';

/**
 * The orders CSV in gzip, as `zlib.gzipSync(ordersCsv.join(""), { level: 9 })` writes it on Node
 * 24, and gzip of that again. `exports.node.test.ts` checks both against `ordersCsv`.
 */
export const gzipped = {
  once: "H4sIAAAAAAACA8svSkkt0ilKTc/Mz9MpyS9JzOHlMjQwMNTJyy8qydAxMdQzNQCLGOkU55eWZOgYm+sZQESMoWoMjfSMTHm5AFkDz25KAAAA",
  twice:
    "H4sIAAAAAAACA5Pv5mAAASbm0/penrqXNL18z585f1nzpL7nmYdPjUwMDK6cPK2vdfKCoeEVY1OGbomXIs+nT0t5ITH7taSDS8/CLJ7eLz0+lTsZIpnP53kBTQIALUrSq1EAAAA=",
} as const;

/** Text in base64, as a reply's `bytes`. */
const base64 = (text: string) => btoa(text);

const csvHeaders = (name: string) =>
  [
    ["content-type", "text/csv; charset=utf-8"],
    ["content-disposition", `attachment; filename="${name}"`],
  ] as const;

/**
 * A file in the object store: its bytes as stored, served with the `Content-Encoding` that its
 * uploader recorded, as an object store keeps that metadata beside the object and does not check
 * it.
 */
const stored = (bytes: string, encoding: string) =>
  ({
    status: 200,
    headers: [...csvHeaders("orders.csv"), ["content-encoding", encoding]],
    bytes,
  }) satisfies Reply;

/** The files of the object store, by name. */
export const files = {
  // Compressed by the uploader, which recorded gzip: the one file whose metadata is right.
  "orders-2026-11-27.csv": stored(gzipped.once, "gzip"),
  // Recorded as gzip by an upload script that skipped the compression step: plain bytes.
  "orders-2026-11-26.csv": stored(base64(ordersCsv.join("")), "gzip"),
  // Compressed by the uploader, which recorded `identity`, as a tool does that sets the field
  // explicitly to its default.
  "orders-2026-11-25.csv": stored(gzipped.once, "identity"),
  // Packed with a coding of the uploader's own, which no client knows: here it left the bytes as
  // they were.
  "orders-2026-11-24.csv": stored(base64(ordersCsv.join("")), "x-export-pack"),
  // Compressed twice, by the uploader's tool and again by a gateway in front of the store, each
  // recording its coding in the order applied, as RFC 9110 section 8.4 asks.
  "orders-2026-11-23.csv": stored(gzipped.twice, "gzip, gzip"),
} as const satisfies Readonly<Record<string, Reply>>;

export const exportService: Definition = {
  routes: [
    // The orders export, streamed row by row as its query returns them, with no length in the
    // head: chunked over HTTP/1.1.
    route("orders-csv", and(get(), exactPath("/v1/exports/orders.csv")), {
      status: 200,
      headers: csvHeaders("orders.csv"),
      stream: {
        chunks: ordersCsv.map((text, at) => ({
          after: at === 0 ? 0 : rowDelay,
          text,
        })),
        ending: "end",
      },
    }),
    // The same orders as NDJSON, one record on each line, for consumers that read records as they
    // arrive.
    route("orders-ndjson", and(get(), exactPath("/v1/exports/orders.ndjson")), {
      status: 200,
      headers: [["content-type", "application/x-ndjson"]],
      stream: {
        chunks: orders.map((order) => ({
          after: 60,
          text: `${JSON.stringify(order)}\n`,
        })),
        ending: "end",
      },
    }),
    // A JSON feed that writes its array as the query returns rows. The query waits on a lock that
    // is never released, so after the first row nothing more comes, and the response stays open.
    route("feed", and(get(), exactPath("/v1/exports/feed")), {
      status: 200,
      headers: [["content-type", "application/json"]],
      stream: { chunks: [{ after: 0, text: feedStart }], ending: "stall" },
    }),
    // An archive copied from storage: the handler declares the file's length, then the copy loses
    // its source, and the handler ends the content instead of failing it.
    route("archive", and(get(), exactPath("/v1/exports/archive.csv")), {
      status: 200,
      headers: [
        ...csvHeaders("archive.csv"),
        ["content-length", String(ordersCsv.join("").length)],
      ],
      stream: {
        chunks: [{ after: 0, text: ordersCsv.slice(0, 2).join("") }],
        ending: "end",
      },
    }),
    // A ledger export whose database cursor fails halfway. The handler returns the error from its
    // stream, as the Warded Server's guide to downloads asks, so that no client takes the part
    // for the whole.
    route("ledger", and(get(), exactPath("/v1/exports/ledger.csv")), {
      status: 200,
      headers: csvHeaders("ledger.csv"),
      stream: {
        chunks: [
          { after: 0, text: ordersCsv[0] },
          { after: 50, text: ordersCsv[1] },
        ],
        ending: "fail",
      },
    }),
    // Server-sent events for the export's progress, which the service sends while the export runs.
    // This one never finishes.
    route("events", and(get(), exactPath("/v1/exports/events")), {
      status: 200,
      headers: [
        ["content-type", "text/event-stream"],
        ["cache-control", "no-cache"],
      ],
      stream: { chunks: [{ after: 50, text: heartbeat }], ending: "repeat" },
    }),
    // The object store, by file name. A missing key gets the store's XML error document.
    lookupRoute("file", and(get(), path("/v1/exports/files/{name}")), {
      capture: "name",
      by: files,
      otherwise: {
        status: 404,
        headers: [["content-type", "application/xml"]],
        body: '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
      },
    }),
  ],
};
