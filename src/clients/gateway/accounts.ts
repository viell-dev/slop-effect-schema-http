/**
 * The accounts export and the Frankfurt import. The export is CSV served as
 * `application/octet-stream` (HDR-5d), so the contract never consults the content type: the 200 case
 * reads bytes and the schema decides. Both variants start with a UTF-8 BOM that a BOM-preserving
 * decoder would read into the first column name (PAY-4b); the byte codec requires and strips it. The
 * German variant round-trips byte for byte, writing the BOM back on encode (PAY-5).
 */
import { Effect, Schema, SchemaTransformation } from "effect";
import { HttpBody } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as Csv from "../../formats/csv.js";
import {
  Cents,
  CentsFromDecimalComma,
  CentsFromUnits,
  OptionalDateFromBare,
} from "../../values/gateway.js";
import { AccountNumber, ErrorFromBytes, pipeBody } from "./pipe.js";

/** Excel's "CSV UTF-8": comma, LF as the gateway's Perl writes it, and a BOM. */
export const excelUtf8: Csv.Dialect = {
  delimiter: ",",
  newline: "\n",
  bom: true,
};

/** German Excel: semicolon, CRLF and a BOM. */
export const excelGerman: Csv.Dialect = {
  delimiter: ";",
  newline: "\r\n",
  bom: true,
};

export const AccountRow = Schema.Struct({
  account: Schema.String,
  title: Schema.String,
  amount: Schema.toType(Cents),
  due: Schema.toType(OptionalDateFromBare),
});
export type AccountRow = typeof AccountRow.Type;

/** The default export: `account,title,amount,due` with dot decimals. */
export const AccountsSheet = Csv.bytes(excelUtf8).pipe(
  Schema.decodeTo(Csv.table(["account", "title", "amount", "due"])),
  Schema.decodeTo(
    Schema.Array(
      Schema.Struct({
        account: AccountNumber,
        title: Schema.String,
        amount: CentsFromUnits,
        due: OptionalDateFromBare,
      }),
    ),
  ),
);

const GermanColumns = Schema.Struct({
  Konto: AccountNumber,
  Bezeichnung: Schema.String,
  Betrag: CentsFromDecimalComma,
  Fällig: OptionalDateFromBare,
});

/** The German sheet: `Konto;Bezeichnung;Betrag;Fällig` with decimal commas, renamed to the domain. */
export const GermanSheet = Csv.bytes(excelGerman).pipe(
  Schema.decodeTo(Csv.table(["Konto", "Bezeichnung", "Betrag", "Fällig"])),
  Schema.decodeTo(
    Schema.Array(
      GermanColumns.pipe(
        Schema.decodeTo(
          AccountRow,
          SchemaTransformation.transform<
            AccountRow,
            (typeof GermanColumns)["Type"]
          >({
            decode: (row) => ({
              account: row.Konto,
              title: row.Bezeichnung,
              amount: row.Betrag,
              due: row.Fällig,
            }),
            encode: (row) => ({
              Konto: row.account,
              Bezeichnung: row.title,
              Betrag: row.amount,
              Fällig: row.due,
            }),
          }),
        ),
      ),
    ),
  ),
);

export interface ExportInput {
  readonly session: string;
  readonly german: boolean;
}

export const ExportQuery = Schema.Struct({
  session: Schema.String,
  report: Schema.Literal("accounts"),
  format: Schema.Literal("csv"),
  locale: Schema.optionalKey(Schema.Literal("de_DE")),
});

export const exportRequest = Request.get("cgi-bin/report.cgi").pipe(
  Request.query(ExportQuery),
  Request.mapInput((input: ExportInput) => ({
    query: {
      session: input.session,
      report: "accounts" as const,
      format: "csv" as const,
      ...(input.german ? { locale: "de_DE" as const } : {}),
    },
  })),
);

/** Bytes advertised as CSV in `Accept`, whatever the response then claims to be. */
export const csvBytes = Body.decoder(
  (response) => Body.bytes.decode(response),
  "text/csv",
);

const tagged =
  <const Tag extends string>(tag: Tag) =>
  <A, RD, RE>(sheet: Schema.Codec<ReadonlyArray<A>, Uint8Array, RD, RE>) =>
    sheet.pipe(
      Schema.decodeTo(
        Schema.TaggedStruct(tag, { rows: Schema.Array(Schema.Any) }),
        SchemaTransformation.transform<
          { readonly _tag: Tag; readonly rows: ReadonlyArray<A> },
          ReadonlyArray<A>
        >({
          decode: (rows) => ({ _tag: tag, rows }),
          encode: ({ rows }) => rows,
        }),
      ),
    ) as unknown as Schema.Codec<
      { readonly _tag: Tag; readonly rows: ReadonlyArray<A> },
      Uint8Array,
      RD,
      RE
    >;

/**
 * The export body: an ERROR line when the script refused before writing headers, else the sheet.
 * Both arrive as 200; only the body tells them apart.
 */
export const exportBody = (german: boolean) =>
  csvBytes.pipe(
    Body.schema(
      Schema.Union([
        ErrorFromBytes,
        tagged("Accounts")(german ? GermanSheet : AccountsSheet),
      ]),
    ),
  );

export const exportAccounts = (origin: string, german: boolean) =>
  Operation.make(
    exportRequest.pipe(Request.baseUrl(origin)),
    Response.status(200, exportBody(german)),
  );

/** The German sheet as a request body; the codec, not a header declaration, sets its content type. */
export const germanSheetBody = Body.encoder((rows: ReadonlyArray<AccountRow>) =>
  Effect.map(Schema.encodeEffect(GermanSheet)(rows), (bytes) =>
    HttpBody.uint8Array(bytes, "text/csv; charset=utf-8"),
  ),
);

const ImportedFields = Schema.Tuple([
  Schema.Literal("OK"),
  Schema.NumberFromString.check(Schema.isInt()),
]);

export const ImportedLine = ImportedFields.pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Imported", { rows: Schema.Number }),
    SchemaTransformation.transform<
      { readonly _tag: "Imported"; readonly rows: number },
      (typeof ImportedFields)["Type"]
    >({
      decode: ([, rows]) => ({ _tag: "Imported", rows }),
      encode: ({ rows }) => ["OK", rows],
    }),
  ),
);

/** The import reply: `OK|<rows>` or an ERROR line. */
export const importBody = pipeBody(ImportedLine);

export const ImportQuery = Schema.Struct({
  session: Schema.String,
  locale: Schema.Literal("de_DE"),
});

export const importAccounts = (origin: string) =>
  Operation.make(
    Request.post("cgi-bin/import.cgi").pipe(
      Request.query(ImportQuery),
      Request.body(germanSheetBody),
      Request.mapInput(
        (input: {
          readonly session: string;
          readonly rows: ReadonlyArray<AccountRow>;
        }) => ({
          query: { session: input.session, locale: "de_DE" as const },
          body: input.rows,
        }),
      ),
      Request.baseUrl(origin),
    ),
    Response.status(200, importBody),
  );
