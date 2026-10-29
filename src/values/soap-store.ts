import {
  Effect,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

/**
 * Value conventions of the SOAP document store, written against what it sends. Every schema here
 * is strict in both directions and uses only Web-standard APIs, so it runs in a browser too.
 */

const invalid = (
  message: string,
  input: unknown,
  options: SchemaAST.ParseOptions,
) => new SchemaIssue.InvalidValue({ message }, input, options);

/**
 * ISO-8859-1 maps every byte to the code point of the same value. The WHATWG `TextDecoder` treats
 * the label "iso-8859-1" as windows-1252, which remaps 0x80 to 0x9F, so this decodes by hand.
 */
const latin1 = (bytes: Uint8Array): string => {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x2000)
    text += String.fromCharCode(...bytes.subarray(start, start + 0x2000));
  return text;
};

const declaration =
  /^<\?xml\s[^>]*?\bencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1[^>]*\?>/;

/** The encoding an XML declaration names, if the text starts with one. */
export const declaredEncoding = (text: string): string | undefined =>
  declaration.exec(text)?.[2];

type Encoding = "utf-8" | "iso-8859-1";

/** XML encoding names are case-insensitive; this convention accepts exactly these two. */
const encodingOf = (label: string): Encoding | undefined => {
  const lowered = label.toLowerCase();
  return lowered === "utf-8" || lowered === "iso-8859-1" ? lowered : undefined;
};

/**
 * XML bytes and their text, with the encoding read from the document's own declaration (UTF-8
 * when there is none, as XML specifies). A charset-less `text/xml` response gives a decoder nothing
 * else to go on, and decoding Latin-1 as UTF-8 does not fail: it replaces every accented letter
 * with U+FFFD. This schema fails instead, on bytes that are invalid in the declared encoding and on
 * encodings it does not support. Encoding writes the text in the encoding its declaration names and
 * refuses characters that encoding cannot hold. A UTF-8 byte order mark is kept as U+FEFF.
 */
export const XmlTextFromBytes = Schema.Uint8Array.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (bytes, options) => {
        const label = declaredEncoding(latin1(bytes.subarray(0, 200)));
        const encoding = encodingOf(label ?? "utf-8");
        if (encoding === undefined)
          return Effect.fail(
            invalid(`unsupported XML encoding ${label}`, bytes, options),
          );
        if (encoding === "iso-8859-1") return Effect.succeed(latin1(bytes));
        try {
          return Effect.succeed(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            ),
          );
        } catch {
          return Effect.fail(
            invalid(
              `the bytes are not valid UTF-8, the encoding ${label === undefined ? "XML assumes without a declaration" : "the declaration names"}`,
              bytes,
              options,
            ),
          );
        }
      },
      encode: (text, options) => {
        const label = declaredEncoding(text);
        const encoding = encodingOf(label ?? "utf-8");
        if (encoding === undefined)
          return Effect.fail(
            invalid(`unsupported XML encoding ${label}`, text, options),
          );
        if (encoding === "utf-8")
          return Effect.succeed(new TextEncoder().encode(text));
        const bytes = new Uint8Array(text.length);
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index);
          if (code > 0xff)
            return Effect.fail(
              invalid(
                `U+${code.toString(16).toUpperCase().padStart(4, "0")} cannot be written in ISO-8859-1; use a character reference`,
                text,
                options,
              ),
            );
          bytes[index] = code;
        }
        return Effect.succeed(bytes);
      },
    }),
  ),
);

const etagc = /^[!#-~\u0080-ÿ]*$/;

/**
 * An entity tag (RFC 9110): `"opaque"` or the weak `W/"opaque"`. The opaque part excludes quotes,
 * spaces and controls. Decoding refuses an unquoted tag and a lower-case `w/`.
 */
export const EntityTag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ weak: Schema.Boolean, opaque: Schema.String }),
    SchemaTransformation.transformEffect({
      decode: (text, options) => {
        const match = /^(W\/)?"([^"]*)"$/.exec(text);
        return match === null || !etagc.test(match[2]!)
          ? Effect.fail(invalid(`not an entity tag: ${text}`, text, options))
          : Effect.succeed({ weak: match[1] !== undefined, opaque: match[2]! });
      },
      encode: (tag, options) =>
        etagc.test(tag.opaque)
          ? Effect.succeed(`${tag.weak ? "W/" : ""}"${tag.opaque}"`)
          : Effect.fail(
              invalid(
                `an entity tag cannot hold ${JSON.stringify(tag.opaque)}`,
                tag,
                options,
              ),
            ),
    }),
  ),
);

export type EntityTag = typeof EntityTag.Type;

const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * An `Allow` value: a comma-separated list of method tokens. Methods are case-sensitive strings,
 * so `PROPFIND` and `propfind` stay distinct. Empty list elements are ignored, as RFC 9110 requires
 * of recipients, and an empty value is an empty list. Encoding joins with `", "`, so
 * `"GET,PUT"` decodes to the same list as `"GET, PUT"` but encodes as the latter.
 */
export const AllowList = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transformEffect({
      decode: (
        text,
        options,
      ): Effect.Effect<ReadonlyArray<string>, SchemaIssue.Issue> => {
        const methods = text
          .split(",")
          .map((element) => element.trim())
          .filter((element) => element !== "");
        const bad = methods.find((method) => !token.test(method));
        return bad === undefined
          ? Effect.succeed(methods)
          : Effect.fail(invalid(`not a method token: ${bad}`, text, options));
      },
      encode: (methods, options) => {
        const bad = methods.find((method) => !token.test(method));
        return bad === undefined
          ? Effect.succeed(methods.join(", "))
          : Effect.fail(
              invalid(`not a method token: ${bad}`, methods, options),
            );
      },
    }),
  ),
);

/**
 * The scanner gateway's receipt: one line, `STORED <id> <size> <etag>`, ended by CRLF. Decoding
 * refuses a bare LF, a missing terminator, a second line and a size with leading zeros.
 */
export const UploadReceipt = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[A-Z]+-\d+$/)),
      size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      etag: EntityTag,
    }),
    SchemaTransformation.transformEffect({
      decode: (line, options) => {
        const match = /^STORED (\S+) (0|[1-9]\d*) (\S+)\r\n$/.exec(line);
        return match === null
          ? Effect.fail(invalid(`not a receipt line: ${line}`, line, options))
          : Effect.succeed({
              id: match[1]!,
              size: Number(match[2]),
              etag: match[3]!,
            });
      },
      encode: (receipt) =>
        Effect.succeed(
          `STORED ${receipt.id} ${receipt.size} ${receipt.etag}\r\n`,
        ),
    }),
  ),
);
