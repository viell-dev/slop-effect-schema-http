/**
 * The gateway's file formats, written and read with the gateway's own code.
 *
 * - The month-end extract is a byte copy of the mainframe's RECFM=FB, LRECL=64 file: ISO-8859-1,
 *   no field delimiters and no record separators, amounts as unsigned zero-padded cents with two
 *   implied decimals, dates as `YYYYMMDD` with `00000000` for none. A header record opens it and a
 *   trailer carrying the record count and control total closes it. The mainframe team (2001) own
 *   the layout, and the general ledger reconciles against it, so it cannot change.
 * - The accounts export was added in 2012 for spreadsheet users. Both variants start with a UTF-8
 *   byte-order mark because Excel otherwise reads UTF-8 as windows-1252. The default variant uses
 *   commas, LF and dot decimals; `locale=de_DE`, added for the Frankfurt office, uses semicolons,
 *   CRLF and a decimal comma, because that is what German Excel writes and reads back.
 * - The Frankfurt office uploads the German variant to `import.cgi`, whose validator refuses
 *   anything German Excel would not have produced.
 */
import { units } from "./cgi.js";

export interface Account {
  /** Eight digits. */
  readonly account: string;
  readonly title: string;
  /** Balance in cents. */
  readonly cents: number;
  /** `YYYYMMDD`, or `00000000` for none. */
  readonly due: string;
}

export interface ExtractRecord extends Account {
  /** `O` open, `P` paid, `X` cancelled. */
  readonly status: "O" | "P" | "X";
}

export interface Extract {
  /** `YYYYMMDD`. */
  readonly runDate: string;
  /** ISO 8601 instant of the file's last change, served as `Last-Modified`. */
  readonly lastModified: string;
  readonly records: ReadonlyArray<ExtractRecord>;
  /**
   * The trailer as printed, when it differs from the records: a re-run whose trailer was patched by
   * hand. Defaults to the true count and total.
   */
  readonly trailer?: { readonly count: number; readonly cents: number };
}

export const RECORD_LENGTH = 64;

const field = (value: string, width: number): string => {
  if (value.length > width)
    throw new Error(`fixture value ${value} exceeds ${width} bytes`);
  return value;
};

const zeros = (value: number, width: number): string =>
  field(String(value).padStart(width, "0"), width);

export const trailerOf = (
  extract: Extract,
): { readonly count: number; readonly cents: number } =>
  extract.trailer ?? {
    count: extract.records.length,
    cents: extract.records.reduce((total, record) => total + record.cents, 0),
  };

/** The extract file as the mainframe writes it. */
export const extractBytes = (period: string, extract: Extract): Uint8Array => {
  const trailer = trailerOf(extract);
  const lines = [
    `HMONTHEND${field(period, 6)}${field(extract.runDate, 8)}${" ".repeat(41)}`,
    ...extract.records.map(
      (record) =>
        `D${field(record.account, 8)}${field(record.title, 30).padEnd(30)}${zeros(record.cents, 11)}` +
        `${field(record.due, 8)}${record.status}${" ".repeat(5)}`,
    ),
    `T${zeros(trailer.count, 6)}${zeros(trailer.cents, 13)}${" ".repeat(44)}`,
  ];
  for (const line of lines) {
    if (line.length !== RECORD_LENGTH)
      throw new Error(`fixture record is ${line.length} bytes`);
    if (/[^ -~ -ÿ]/.test(line))
      throw new Error(
        `fixture record ${JSON.stringify(line)} is not printable ISO-8859-1`,
      );
  }
  return new Uint8Array(Buffer.from(lines.join(""), "latin1"));
};

const BOM = "\uFEFF";

const quote = (value: string, delimiter: string): string =>
  /["\r\n]/.test(value) || value.includes(delimiter)
    ? `"${value.replaceAll('"', '""')}"`
    : value;

/** The accounts export in the default or the German variant. */
export const accountsCsv = (
  accounts: ReadonlyArray<Account>,
  german: boolean,
): Uint8Array => {
  const delimiter = german ? ";" : ",";
  const newline = german ? "\r\n" : "\n";
  const header = german
    ? ["Konto", "Bezeichnung", "Betrag", "Fällig"]
    : ["account", "title", "amount", "due"];
  const rows = [
    header,
    ...accounts.map((account) => [
      account.account,
      account.title,
      units(account.cents, german ? "," : "."),
      account.due,
    ]),
  ];
  const text = rows
    .map(
      (row) =>
        row.map((value) => quote(value, delimiter)).join(delimiter) + newline,
    )
    .join("");
  return new TextEncoder().encode(BOM + text);
};

/** Read one German export back, or say why import.cgi refuses it. */
export const importGerman = (
  bytes: Uint8Array,
):
  | { readonly accounts: ReadonlyArray<Account> }
  | { readonly refusal: string } => {
  if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf)
    return { refusal: "missing byte-order mark" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(3),
    );
  } catch {
    return { refusal: "not UTF-8" };
  }
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let value = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 2;
      } else if (char === '"') {
        quoted = false;
        index++;
      } else {
        value += char;
        index++;
      }
    } else if (char === '"' && value === "") {
      quoted = true;
      index++;
    } else if (char === ";") {
      row.push(value);
      value = "";
      index++;
    } else if (char === "\r" && text[index + 1] === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      index += 2;
    } else if (char === "\r" || char === "\n") {
      return { refusal: `line ${rows.length + 1}: line breaks must be CRLF` };
    } else {
      value += char;
      index++;
    }
  }
  if (quoted || value !== "" || row.length > 0)
    return { refusal: "file does not end with CRLF" };
  const [header, ...body] = rows;
  if (header?.join(";") !== "Konto;Bezeichnung;Betrag;Fällig")
    return { refusal: "line 1: expected Konto;Bezeichnung;Betrag;Fällig" };
  const accounts: Array<Account> = [];
  for (const [offset, fields] of body.entries()) {
    const line = offset + 2;
    if (fields.length !== 4)
      return { refusal: `line ${line}: expected 4 fields` };
    const [account, title, amount, due] = fields as [
      string,
      string,
      string,
      string,
    ];
    if (!/^\d{8}$/.test(account))
      return { refusal: `line ${line}: Konto must be 8 digits` };
    const money = /^(-?)(\d+),(\d{2})$/.exec(amount);
    if (money === null)
      return { refusal: `line ${line}: Betrag needs a decimal comma` };
    if (!/^\d{8}$/.test(due))
      return { refusal: `line ${line}: Fällig must be YYYYMMDD` };
    const magnitude = Number(money[2]) * 100 + Number(money[3]);
    accounts.push({
      account,
      title,
      cents: money[1] === "-" ? -magnitude : magnitude,
      due,
    });
  }
  return { accounts };
};
