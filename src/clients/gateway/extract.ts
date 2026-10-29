/**
 * The month-end extract: a fixed-width ISO-8859-1 file of 64-byte records without separators
 * (PAY-4c). It is read as bytes, decoded as strict Latin-1, split into records and sliced into
 * fields, each field decoded by a value schema, and the trailer's record count and control total
 * verified against the records. Encoding computes the trailer, so the domain value never carries
 * one. The same schema reads the HTTP download and the base64 inside XML-RPC (PAY-8).
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as FixedWidth from "../../formats/fixed-width.js";
import {
  Cents,
  CentsFromImpliedDecimals,
  DateFromBare,
  OptionalDateFromBare,
} from "../../values/gateway.js";
import { AccountNumber, ErrorFromBytes, Period } from "./pipe.js";

const RECORD = 64;

const HeaderRecord = FixedWidth.fields([
  ["type", 1],
  ["label", 8],
  ["period", 6],
  ["runDate", 8],
  [null, 41],
]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      type: Schema.Literal("H"),
      label: Schema.Literal("MONTHEND"),
      period: Period,
      runDate: DateFromBare,
    }),
  ),
);

/** Status codes of the mainframe file and their meaning. */
const Status = Schema.Literals(["O", "P", "X"]).pipe(
  Schema.decodeTo(
    Schema.Literals(["open", "paid", "cancelled"]),
    SchemaTransformation.transform<
      "open" | "paid" | "cancelled",
      "O" | "P" | "X"
    >({
      decode: (code) =>
        code === "O" ? "open" : code === "P" ? "paid" : "cancelled",
      encode: (status) =>
        status === "open" ? "O" : status === "paid" ? "P" : "X",
    }),
  ),
);

const DetailRecord = FixedWidth.fields([
  ["type", 1],
  ["account", 8],
  ["title", 30],
  ["amount", 11],
  ["due", 8],
  ["status", 1],
  [null, 5],
]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      type: Schema.Literal("D"),
      account: AccountNumber,
      title: FixedWidth.text(30),
      amount: CentsFromImpliedDecimals(11),
      due: OptionalDateFromBare,
      status: Status,
    }),
  ),
);

const TrailerRecord = FixedWidth.fields([
  ["type", 1],
  ["count", 6],
  ["total", 13],
  [null, 44],
]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      type: Schema.Literal("T"),
      count: FixedWidth.count(6),
      total: CentsFromImpliedDecimals(13),
    }),
  ),
);

/** Header, any number of details, then exactly one trailer. */
const Layout = FixedWidth.Latin1.pipe(
  Schema.decodeTo(FixedWidth.records(RECORD)),
  Schema.decodeTo(
    Schema.TupleWithRest(Schema.Tuple([HeaderRecord]), [
      DetailRecord,
      TrailerRecord,
    ]),
  ),
);

export const ExtractItem = Schema.Struct({
  account: Schema.String,
  title: Schema.String,
  amount: Schema.toType(Cents),
  due: Schema.toType(OptionalDateFromBare),
  status: Schema.Literals(["open", "paid", "cancelled"]),
});
export type ExtractItem = typeof ExtractItem.Type;

export const MonthEnd = Schema.Struct({
  period: Schema.String,
  runDate: Schema.DateTimeUtc,
  items: Schema.Array(ExtractItem),
});
export type MonthEnd = typeof MonthEnd.Type;

type Records = (typeof Layout)["Type"];
type Detail = (typeof DetailRecord)["Type"];
type Trailer = (typeof TrailerRecord)["Type"];

/** The month-end extract as bytes, both directions. */
export const MonthEndExtract = Layout.pipe(
  Schema.decodeTo(
    MonthEnd,
    SchemaTransformation.transformEffect<MonthEnd, Records>({
      decode: (records, options) => {
        const [header, ...rest] = records;
        const trailer = rest.pop() as Trailer;
        const details = rest as Array<Detail>;
        const total = details.reduce((sum, detail) => sum + detail.amount, 0);
        const problem =
          trailer.count !== details.length
            ? `the trailer counts ${trailer.count} records, but the file has ${details.length}`
            : trailer.total !== total
              ? `the trailer's control total ${trailer.total} differs from the records' ${total}`
              : undefined;
        if (problem !== undefined)
          return Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: problem },
              records,
              options,
            ),
          );
        return Effect.succeed({
          period: header.period,
          runDate: header.runDate,
          items: details.map((detail) => ({
            account: detail.account,
            title: detail.title,
            amount: detail.amount,
            due: detail.due,
            status: detail.status,
          })),
        });
      },
      encode: (extract) => {
        const details = extract.items.map((item): Detail => ({
          type: "D",
          ...item,
        }));
        const total = details.reduce((sum, detail) => sum + detail.amount, 0);
        return Effect.succeed([
          {
            type: "H",
            label: "MONTHEND",
            period: extract.period,
            runDate: extract.runDate,
          },
          ...details,
          { type: "T", count: details.length, total: Cents.make(total) },
        ] as unknown as Records);
      },
    }),
  ),
);

export const ExtractQuery = Schema.Struct({
  session: Schema.String,
  period: Period,
});

export interface ExtractInput {
  readonly session: string;
  readonly period: string;
}

const toExtractQuery = (input: ExtractInput) => ({ query: input });

/** The download and the probe address the same resource; only the method differs. */
export const extractRequest = Request.get("cgi-bin/extract.cgi").pipe(
  Request.query(ExtractQuery),
  Request.mapInput(toExtractQuery),
);

export const probeRequest = Request.head("cgi-bin/extract.cgi").pipe(
  Request.query(ExtractQuery),
  Request.mapInput(toExtractQuery),
);

/** The extract.cgi refusals carry a status and an ERROR line. */
const refusal = Response.when(
  (metadata) => [400, 403, 404].includes(metadata.status),
  Response.tag("Refused", Body.bytes.pipe(Body.schema(ErrorFromBytes))),
);

export const extractResponse = Response.status(
  200,
  Response.tag("Extract", Body.bytes.pipe(Body.schema(MonthEndExtract))),
).pipe(Response.orElse(refusal));

export const extract = (origin: string) =>
  Operation.make(extractRequest.pipe(Request.baseUrl(origin)), extractResponse);

/** The facts a probe learns from the response headers alone. */
export const ProbeHeaders = Schema.Struct({
  "x-record-count": Schema.NumberFromString.check(Schema.isInt()),
  "x-control-total": CentsFromImpliedDecimals(13),
  "last-modified": Schema.DateTimeUtcFromHttpDate,
  "content-length": Schema.NumberFromString.check(Schema.isInt()),
});

/**
 * STAT-6: an ordinary schema applied to the header map. The HEAD response has no body to read; the
 * decoder never touches one.
 */
export const probeDecoder = Body.decoder((response) =>
  Schema.decodeUnknownEffect(ProbeHeaders)(response.headers).pipe(
    Effect.map((headers) => ({
      records: headers["x-record-count"],
      controlTotal: headers["x-control-total"],
      lastModified: headers["last-modified"],
      bytes: headers["content-length"],
    })),
  ),
);

export const probe = (origin: string) =>
  Operation.make(
    probeRequest.pipe(Request.baseUrl(origin)),
    Response.status(200, Response.tag("Ready", probeDecoder)).pipe(
      Response.orElse(
        Response.when(
          (metadata) => [400, 403, 404].includes(metadata.status),
          Response.tag(
            "Refused",
            Body.decoder((response) =>
              Effect.as(Body.empty.decode(response), response.status),
            ),
          ),
        ),
      ),
    ),
  );
