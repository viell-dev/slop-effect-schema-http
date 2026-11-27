/**
 * The export service as an application describes it with the library: the consumer side of
 * `exports.ts`. It uses only the library's package root and Effect.
 *
 * The library reads finite bodies, and leaves an endless or stalled one to a timeout: an attempt
 * timeout covers dispatch and decoding, and its scope closes, ending the request, before the
 * outcome is returned. A decoder may read `response.stream` itself, as long as it finishes within
 * the attempt.
 */
import { Schema, Stream } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import { mediaType } from "./metadata.js";

/** The export service's base, relative: the suite puts each listener's origin in front of it. */
const exportOf = (file: string) =>
  Request.get(`/exports/${file}`).pipe(Request.baseUrl("/v1"));

/** A CSV download, read whole as text. */
export const csvAnswers = Response.status(200, Response.tag("Csv", Body.text));

/** The orders CSV, under a policy the test chooses: a timeout bounds every attempt. */
export const ordersCsv = (policy: Policy.Policy) =>
  Operation.make(exportOf("orders.csv"), csvAnswers, { policy });

/** The archive, whose content ends before its `Content-Length`. */
export const archive = (policy: Policy.Policy) =>
  Operation.make(exportOf("archive.csv"), csvAnswers, { policy });

/** The ledger, whose content fails halfway. */
export const ledger = (policy: Policy.Policy) =>
  Operation.make(exportOf("ledger.csv"), csvAnswers, { policy });

export const Order = Schema.Struct({
  order: Schema.String,
  region: Schema.String,
  total: Schema.String,
});

const decodeOrder = Schema.decodeUnknownEffect(Schema.fromJsonString(Order));

/**
 * The first `count` records of an NDJSON export, decoded as they arrive from `response.stream`.
 * The decoder stops reading there, and the attempt's scope ends the response with the rest unread.
 */
export const firstOrders = (count: number) =>
  Body.decoder(
    (response) =>
      response.stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line !== ""),
        Stream.take(count),
        Stream.mapEffect((line) => decodeOrder(line)),
        Stream.runCollect,
      ),
    "application/x-ndjson",
  );

/** The first page of the NDJSON export, read record by record. */
export const firstPage = (count: number, policy: Policy.Policy) =>
  Operation.make(
    exportOf("orders.ndjson"),
    Response.status(200, Response.tag("Page", firstOrders(count))),
    { policy },
  );

export const Feed = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String })),
});

/** The JSON feed, decoded whole by its schema. */
export const feed = (policy: Policy.Policy) =>
  Operation.make(
    exportOf("feed"),
    Response.status(200, Response.tag("Feed", Body.jsonSchema(Feed))),
    { policy },
  );

/**
 * The progress stream through a contract that declares JSON only, as a consumer writes it who
 * expected a status document there. The event stream matches no case, so the library drains it
 * before it can fail with `UnexpectedResponse`.
 */
export const progressAsJson = (policy: Policy.Policy) =>
  Operation.make(
    exportOf("events"),
    Response.when(
      (info) => mediaType(info) === "application/json",
      Response.tag("Status", Body.json),
    ),
    { policy },
  );

/**
 * The progress stream read whole as text, which never ends: with no attempt timeout, the caller's
 * own deadline bounds it.
 */
export const progressAsText = Operation.make(
  exportOf("events"),
  Response.status(200, Response.tag("Events", Body.text)),
);

/** A file of the object store, read as the bytes that the provider gives. */
export const file = Operation.make(
  Request.get("/exports/files").pipe(
    Request.baseUrl("/v1"),
    Request.path`/${Request.pathValue("name", Schema.String)}`,
  ),
  Response.status(200, Response.tag("File", Body.bytes)),
  { policy: Policy.timeout("5 seconds") },
);
