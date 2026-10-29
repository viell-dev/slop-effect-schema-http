/**
 * EXT-5: multipart bodies for comparing the SOAP store's multipart reader and writer with the
 * platform's own parser, `Response.formData()`: undici in Node and Chromium's in the browser. The
 * uploads are sent by the consumer's upload operation and read back from the store's ledger; the
 * bundles are the store's answers for documents it starts with.
 *
 * File names are where the readers part ways. Browsers write a file name raw, except `"`, CR and LF,
 * which the HTML standard's multipart/form-data encoding writes as `%22`, `%0D` and `%0A`; it gives
 * no rule for reading them back, and does not escape `%` or `\`.
 */

/** The platform parser of a lane, by the key a case records a disagreement under. */
export type FormParser = "undici" | "Chromium";

export interface UploadCase {
  readonly id: string;
  readonly about: string;
  readonly label: string;
  readonly file: {
    readonly name: string;
    readonly type: string;
    readonly bytes: Uint8Array;
  };
  /**
   * What the store answers: the label, name and type it stored where they differ from what the
   * consumer gave, or the start of its refusal, which names the file name it read.
   */
  readonly store:
    | {
        readonly label?: string;
        readonly name?: string;
        readonly type?: string;
      }
    | { readonly refused: string };
  /** Platform parsers that read the body differently from the store, and why. */
  readonly disagreements?: Partial<Record<FormParser, string>>;
}

export interface BundleCase {
  readonly id: string;
  readonly about: string;
  /** A document the store starts with, as its `documents` option takes it. */
  readonly document: {
    readonly name: string;
    readonly title: string;
    readonly contentType: string;
    readonly base64: string;
  };
  /** Readers that read the bundle differently from the store's own record, and why. */
  readonly disagreements?: Partial<Record<FormParser | "store", string>>;
}

const encoder = new TextEncoder();

const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

/** Chromium does not reverse the HTML standard's escapes in a file name. */
const chromiumKeepsEscapes =
  "Chromium's formData() keeps %22, %0D and %0A in a file name as written, while the store, like undici, reads them as the quote and line breaks the HTML standard's encoding wrote them for";

export const uploadCases: ReadonlyArray<UploadCase> = [
  {
    id: "binary",
    about: "binary content holding CRLF, '--' lines, NUL and 0xFF",
    label: "Quarterly report",
    file: {
      name: "report-q3.pdf",
      type: "application/pdf",
      bytes: Uint8Array.from([
        0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x2d, 0x2d, 0x0d, 0x0a, 0x2d, 0x2d,
        0x00, 0xff, 0x0d,
      ]),
    },
    store: {},
  },
  {
    id: "non-ascii",
    about: "a non-ASCII label and file name, sent as raw UTF-8",
    label: "Prüfung ✓ – Größe",
    file: {
      name: "Grüße – Bericht.txt",
      type: "text/plain; charset=utf-8",
      bytes: encoder.encode("Grüße\n"),
    },
    store: {},
  },
  {
    id: "label-line-breaks",
    about:
      "LF and lone CR in the label, which the multipart encoding writes as CRLF before any reader sees them",
    label: "line 1\nline 2\rline 3\r\nend",
    file: { name: "lines.txt", type: "text/plain", bytes: encoder.encode("x") },
    store: { label: "line 1\r\nline 2\r\nline 3\r\nend" },
  },
  {
    id: "quote-name",
    about: "a file name with '\"', which the encoding writes as %22",
    label: "Quote",
    file: {
      name: 'say "hi".txt',
      type: "text/plain",
      bytes: encoder.encode("hi"),
    },
    store: {},
    disagreements: { Chromium: chromiumKeepsEscapes },
  },
  {
    id: "percent-name",
    about:
      "a file name holding a literal %22, which the encoding leaves as it is, so the store reads a quote",
    label: "Percent",
    file: {
      name: "100%22 sure.txt",
      type: "text/plain",
      bytes: encoder.encode("sure"),
    },
    store: { name: '100" sure.txt' },
    disagreements: { Chromium: chromiumKeepsEscapes },
  },
  {
    id: "line-feed-name",
    about:
      "a file name with a line feed, written as %0A; the store refuses a control character in a name",
    label: "Line feed",
    file: { name: "a\nb.txt", type: "text/plain", bytes: encoder.encode("x") },
    store: { refused: "Invalid document name a\nb.txt" },
    disagreements: { Chromium: chromiumKeepsEscapes },
  },
  {
    id: "backslash-name",
    about:
      "a file name with '\\', which the encoding leaves as it is; the store refuses it in a name",
    label: "Backslash",
    file: {
      name: "back\\slash.txt",
      type: "text/plain",
      bytes: encoder.encode("x"),
    },
    store: { refused: "Invalid document name back\\slash.txt" },
    disagreements: {
      Chromium:
        "Chromium's formData() reads '\\s' inside the quoted file name as a MIME quoted-pair (RFC 2045, RFC 822 quoted-string) and drops the backslash, while the store, like undici, keeps it as the HTML standard's encoding wrote it",
    },
  },
  {
    id: "parameter-characters",
    about:
      "a file name with ';' and '=', which a naive Content-Disposition split would cut",
    label: "a; b=c",
    file: {
      name: "a;b=c.txt",
      type: "text/plain",
      bytes: encoder.encode("x"),
    },
    store: {},
  },
  {
    id: "untyped",
    about:
      "a Blob without a type, which the encoding sends as application/octet-stream",
    label: "Untyped",
    file: { name: "untyped.bin", type: "", bytes: Uint8Array.from([1, 2]) },
    store: { type: "application/octet-stream" },
  },
  {
    id: "empty",
    about: "an empty file part",
    label: "Empty",
    file: { name: "empty.txt", type: "text/plain", bytes: new Uint8Array() },
    store: {},
  },
];

/** The delimiter line of the bundle for the first document the store starts with. */
const firstDelimiter = "--DocVaultBundle-DOC-000001-1";

export const bundleCases: ReadonlyArray<BundleCase> = [
  {
    id: "delimiter-in-content",
    about:
      "content holding the delimiter line the store writes for this bundle (it must come first, as DOC-000001)",
    document: {
      name: "delimiter.txt",
      title: "Delimiter",
      contentType: "text/plain",
      base64: base64(
        encoder.encode(
          `a\r\n${firstDelimiter}\r\nb\r\n${firstDelimiter}--\r\n`,
        ),
      ),
    },
    disagreements: {
      store:
        "writes a boundary that occurs in the content, which RFC 2046 section 5.1.1 forbids, so no parser can find the parts: both formData() parsers refuse the bundle, and so does the consumer's bundle operation",
    },
  },
  {
    id: "plain",
    about:
      "a non-ASCII name and a title with CRLF and quotes, in the JSON metadata",
    document: {
      name: "Prüfbericht.txt",
      title: 'Prüfbericht "Q3"\r\nfür Café',
      contentType: "text/plain; charset=utf-8",
      base64: base64(encoder.encode("Prüfung bestanden.\r\n")),
    },
  },
  {
    id: "all-bytes",
    about: "every byte value, CR and LF included",
    document: {
      name: "all-bytes.bin",
      title: "All bytes",
      contentType: "application/octet-stream",
      base64: base64(Uint8Array.from({ length: 256 }, (_, index) => index)),
    },
  },
  {
    id: "quote-name",
    about: "a name with '\"', which the bundle writes as %22, as browsers do",
    document: {
      name: 'say "hi".txt',
      title: "Quote",
      contentType: "text/plain",
      base64: base64(encoder.encode("hi")),
    },
    disagreements: {
      Chromium:
        "Chromium's formData() reads the file name as say %22hi%22.txt, keeping the escape the store wrote; the JSON metadata holds the name",
    },
  },
  {
    id: "percent-name",
    about:
      "a name holding a literal %22, which the bundle writes unchanged, so it reads like an escaped quote",
    document: {
      name: "100%22 sure.txt",
      title: "Percent",
      contentType: "text/plain",
      base64: base64(encoder.encode("sure")),
    },
    disagreements: {
      undici:
        "undici's formData() reads the file name as 100\" sure.txt: the store escapes '\"' but not '%', as browsers do, so no reader can tell this name from one with a quote; the JSON metadata holds the name",
    },
  },
  {
    id: "parameter-characters",
    about: "a name with ';' and '=', and a content type with a parameter",
    document: {
      name: "a;b=c.txt",
      title: "Parameters",
      contentType: "text/plain; charset=utf-8",
      base64: base64(encoder.encode("x")),
    },
  },
  {
    id: "empty",
    about: "empty content",
    document: {
      name: "empty.txt",
      title: "Empty",
      contentType: "text/plain",
      base64: "",
    },
  },
];
