/**
 * Strict CSV for consumer code: bytes to rows to named records, each step a reversible schema.
 * A dialect fixes the delimiter, the line ending and the byte-order mark, and the reader accepts
 * exactly what the writer produces: every record ends with the dialect's line ending, a field is
 * quoted only when it must be, and a stray quote, bare CR or bare LF is refused. Decoding then
 * encoding reproduces the input bytes.
 *
 * The byte step is deliberate. A WHATWG UTF-8 decode, such as `Response.text()`, silently drops a
 * leading BOM, so a text codec can never write it back; a BOM-preserving decoder (`TextDecoder` with
 * `ignoreBOM`, or Node's `Buffer.toString`) keeps it as U+FEFF in the first column name instead.
 */
import {
  Effect,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

export interface Dialect {
  /** A single character. */
  readonly delimiter: string;
  readonly newline: "\n" | "\r\n";
  /** Whether the file starts with a UTF-8 byte-order mark, required on decode and written on encode. */
  readonly bom: boolean;
}

/** RFC 4180-style CSV with a comma, as Unix tools write it: LF endings, no BOM. */
export const unix: Dialect = { delimiter: ",", newline: "\n", bom: false };

const BOM = "\uFEFF";

const mustQuote = (value: string, dialect: Dialect): boolean =>
  value.includes(dialect.delimiter) ||
  value.includes('"') ||
  value.includes("\r") ||
  value.includes("\n");

/** Parse CSV text (after any BOM). Throws an `Error` naming the offset of the first violation. */
export const parse = (text: string, dialect: Dialect): Array<Array<string>> => {
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let index = 0;
  const fail = (message: string): never => {
    throw new Error(`CSV: ${message} at offset ${index}`);
  };
  while (index < text.length) {
    let value: string;
    if (text[index] === '"') {
      const start = index;
      index++;
      value = "";
      for (;;) {
        const quote = text.indexOf('"', index);
        if (quote < 0) {
          index = start;
          return fail("unterminated quoted field");
        }
        value += text.slice(index, quote);
        index = quote + 1;
        if (text[index] !== '"') break;
        value += '"';
        index++;
      }
      if (!mustQuote(value, dialect)) {
        index = start;
        return fail("needlessly quoted field");
      }
    } else {
      const start = index;
      while (
        index < text.length &&
        !text.startsWith(dialect.delimiter, index) &&
        text[index] !== "\r" &&
        text[index] !== "\n"
      )
        index++;
      value = text.slice(start, index);
      const quote = value.indexOf('"');
      if (quote >= 0) {
        index = start + quote;
        return fail("stray quote in an unquoted field");
      }
    }
    row.push(value);
    if (text.startsWith(dialect.delimiter, index)) {
      index += dialect.delimiter.length;
      if (index === text.length) fail("missing final line ending");
      continue;
    }
    if (text.startsWith(dialect.newline, index)) {
      index += dialect.newline.length;
      rows.push(row);
      row = [];
      continue;
    }
    if (index === text.length) return fail("missing final line ending");
    return fail(
      text[index] === "\r"
        ? "bare CR"
        : dialect.newline === "\r\n"
          ? "bare LF"
          : "unexpected CR",
    );
  }
  return rows;
};

/** Serialize rows, quoting only fields that need it. Every row ends with the dialect's newline. */
export const serialize = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  dialect: Dialect,
): string =>
  rows
    .map(
      (row) =>
        row
          .map((value) =>
            mustQuote(value, dialect)
              ? `"${value.replaceAll('"', '""')}"`
              : value,
          )
          .join(dialect.delimiter) + dialect.newline,
    )
    .join("");

type Options = SchemaAST.ParseOptions;

const issue = (message: string, input: unknown, options: Options) =>
  new SchemaIssue.InvalidValue({ message }, input, options);

/** Strict UTF-8 with the dialect's BOM: required and stripped on decode, written on encode. */
export const utf8 = (dialect: Dialect) =>
  Schema.Uint8Array.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect<string, Uint8Array>({
        decode: (bytes, options) => {
          let text: string;
          try {
            text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
          } catch {
            return Effect.fail(
              issue("the bytes are not valid UTF-8", bytes, options),
            );
          }
          if (dialect.bom && !text.startsWith(BOM))
            return Effect.fail(
              issue("the file has no UTF-8 byte-order mark", bytes, options),
            );
          if (!dialect.bom && text.startsWith(BOM))
            return Effect.fail(
              issue("unexpected UTF-8 byte-order mark", bytes, options),
            );
          return Effect.succeed(dialect.bom ? text.slice(1) : text);
        },
        encode: (text) =>
          Effect.succeed(
            new TextEncoder().encode(dialect.bom ? BOM + text : text),
          ),
      }),
    ),
  );

/** CSV text to rows of fields. */
export const rows = (dialect: Dialect) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.Array(Schema.String)),
      SchemaTransformation.transformEffect<
        ReadonlyArray<ReadonlyArray<string>>,
        string
      >({
        decode: (text, options) => {
          try {
            return Effect.succeed(parse(text, dialect));
          } catch (cause) {
            return Effect.fail(issue((cause as Error).message, text, options));
          }
        },
        encode: (value, options) =>
          value.some((row) => row.length === 0)
            ? Effect.fail(
                issue("a row needs at least one field", value, options),
              )
            : Effect.succeed(serialize(value, dialect)),
      }),
    ),
  );

/** Bytes to rows: {@link utf8} then {@link rows}. */
export const bytes = (dialect: Dialect) =>
  utf8(dialect).pipe(Schema.decodeTo(rows(dialect)));

/**
 * A header row that must equal `columns` exactly and in order, then one record per row with exactly
 * that many fields. The column order is verified, never trusted.
 */
export const table = (columns: ReadonlyArray<string>) =>
  Schema.Array(Schema.Array(Schema.String)).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.Record(Schema.String, Schema.String)),
      SchemaTransformation.transformEffect<
        ReadonlyArray<Readonly<Record<string, string>>>,
        ReadonlyArray<ReadonlyArray<string>>
      >({
        decode: (table, options) => {
          const [header, ...body] = table;
          if (
            header === undefined ||
            header.length !== columns.length ||
            header.some((name, index) => name !== columns[index])
          )
            return Effect.fail(
              issue(
                `expected the header ${JSON.stringify(columns)}, got ${JSON.stringify(header ?? null)}`,
                table,
                options,
              ),
            );
          const wrong = body.findIndex((row) => row.length !== columns.length);
          if (wrong >= 0)
            return Effect.fail(
              issue(
                `row ${wrong + 1} has ${body[wrong]!.length} fields, not ${columns.length}`,
                table,
                options,
              ),
            );
          return Effect.succeed(
            body.map((row) =>
              Object.fromEntries(
                columns.map((name, index) => [name, row[index]!]),
              ),
            ),
          );
        },
        encode: (records, options) => {
          const result: Array<ReadonlyArray<string>> = [columns];
          for (const record of records) {
            const row = columns.map((name) => record[name]);
            if (row.some((value) => value === undefined))
              return Effect.fail(
                issue("a record lacks a column", record, options),
              );
            result.push(row as ReadonlyArray<string>);
          }
          return Effect.succeed(result);
        },
      }),
    ),
  );
