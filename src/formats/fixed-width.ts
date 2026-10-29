/**
 * Fixed-width record files as consumer-side schemas: a byte codec for strict ISO-8859-1, a splitter
 * for fixed-length records without separators, and a field slicer whose fields are decoded by
 * ordinary schemas. Latin-1 maps one byte to one character, so character offsets after decoding
 * are byte offsets. A UTF-8 text decode would replace each Latin-1 accent with U+FFFD and keep
 * going, which is why the codec starts from bytes.
 *
 * WHATWG's `TextDecoder("latin1")` is windows-1252, which reads 0x80 as "€", so this module maps
 * bytes to code points itself and refuses the C0 and C1 control ranges.
 */
import {
  Effect,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

const printable = (code: number): boolean =>
  (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);

const issue = (
  message: string,
  input: unknown,
  options: SchemaAST.ParseOptions,
) => new SchemaIssue.InvalidValue({ message }, input, options);

/** Map bytes to the code points of the same value, in chunks that stay within argument limits. */
const latin1 = (bytes: Uint8Array): string => {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return result;
};

/** Printable ISO-8859-1 text from bytes, refusing control bytes; encoding refuses other characters. */
export const Latin1 = Schema.Uint8Array.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect<string, Uint8Array>({
      decode: (bytes, options) => {
        const offset = bytes.findIndex((byte) => !printable(byte));
        return offset >= 0
          ? Effect.fail(
              issue(
                `byte 0x${bytes[offset]!.toString(16).padStart(2, "0")} at offset ${offset} is not printable ISO-8859-1`,
                bytes,
                options,
              ),
            )
          : Effect.succeed(latin1(bytes));
      },
      encode: (text, options) => {
        const bytes = new Uint8Array(text.length);
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index);
          if (!printable(code))
            return Effect.fail(
              issue(
                `${JSON.stringify(text[index])} at offset ${index} is not printable ISO-8859-1`,
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

/** Fixed-length records with no separators: the text length must be a multiple of `length`. */
export const records = (length: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transformEffect<ReadonlyArray<string>, string>({
        decode: (text, options) => {
          if (text.length % length !== 0)
            return Effect.fail(
              issue(
                `${text.length} bytes is not a whole number of ${length}-byte records`,
                text,
                options,
              ),
            );
          const result: Array<string> = [];
          for (let offset = 0; offset < text.length; offset += length)
            result.push(text.slice(offset, offset + length));
          return Effect.succeed(result);
        },
        encode: (lines, options) => {
          const wrong = lines.findIndex((line) => line.length !== length);
          return wrong >= 0
            ? Effect.fail(
                issue(
                  `record ${wrong} has ${lines[wrong]!.length} bytes, not ${length}`,
                  lines,
                  options,
                ),
              )
            : Effect.succeed(lines.join(""));
        },
      }),
    ),
  );

/** A field: its name and width. A `null` name is filler that must be spaces and is written as spaces. */
export type Field = readonly [name: string | null, width: number];

/**
 * Slice one record into named fields of exactly their width, untrimmed. Encoding requires every
 * named field to have exactly its width, so field schemas own padding and overflow.
 */
export const fields = (layout: ReadonlyArray<Field>) => {
  const length = layout.reduce((total, [, width]) => total + width, 0);
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.Record(Schema.String, Schema.String),
      SchemaTransformation.transformEffect<
        Readonly<Record<string, string>>,
        string
      >({
        decode: (line, options) => {
          if (line.length !== length)
            return Effect.fail(
              issue(
                `record has ${line.length} bytes, not ${length}`,
                line,
                options,
              ),
            );
          const result: Record<string, string> = {};
          let offset = 0;
          for (const [name, width] of layout) {
            const value = line.slice(offset, offset + width);
            if (name === null) {
              if (value.trim() !== "")
                return Effect.fail(
                  issue(
                    `filler at offset ${offset} is not blank: ${JSON.stringify(value)}`,
                    line,
                    options,
                  ),
                );
            } else result[name] = value;
            offset += width;
          }
          return Effect.succeed(result);
        },
        encode: (values, options) => {
          let line = "";
          for (const [name, width] of layout) {
            if (name === null) {
              line += " ".repeat(width);
              continue;
            }
            const value = values[name];
            if (value === undefined || value.length !== width)
              return Effect.fail(
                issue(
                  `field ${name} must be exactly ${width} characters wide`,
                  values,
                  options,
                ),
              );
            line += value;
          }
          return Effect.succeed(line);
        },
      }),
    ),
  );
};

/**
 * Left-justified text padded with spaces to `width`. Decoding drops the trailing padding; encoding
 * pads again and refuses text that would not survive the trip: too wide, or ending in a space.
 */
export const text = (width: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect<string, string>({
        decode: (value, options) =>
          value.length === width
            ? Effect.succeed(value.replace(/ +$/, ""))
            : Effect.fail(
                issue(
                  `expected ${width} characters, got ${value.length}`,
                  value,
                  options,
                ),
              ),
        encode: (value, options) =>
          value.length > width
            ? Effect.fail(
                issue(
                  `${JSON.stringify(value)} is wider than ${width} characters`,
                  value,
                  options,
                ),
              )
            : value.endsWith(" ")
              ? Effect.fail(
                  issue(
                    `${JSON.stringify(value)} ends in a space that padding would swallow`,
                    value,
                    options,
                  ),
                )
              : Effect.succeed(value.padEnd(width, " ")),
      }),
    ),
  );

/** An unsigned integer zero padded to exactly `width` digits. */
export const count = (width: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Int,
      SchemaTransformation.transformEffect<number, string>({
        decode: (value, options) =>
          new RegExp(`^\\d{${width}}$`).test(value)
            ? Effect.succeed(Number(value))
            : Effect.fail(
                issue(
                  `expected ${width} digits, got ${JSON.stringify(value)}`,
                  value,
                  options,
                ),
              ),
        encode: (value, options) => {
          const digits = String(value).padStart(width, "0");
          return value < 0 || digits.length > width
            ? Effect.fail(
                issue(
                  `${value} does not fit ${width} unsigned digits`,
                  value,
                  options,
                ),
              )
            : Effect.succeed(digits);
        },
      }),
    ),
  );
