/**
 * The gateway's pipe-delimited replies: one line ending in `\n`, fields separated by `|`, `OK|…` on
 * success and `ERROR|<code>|<message>` otherwise, all inside HTTP 200. Status and headers cannot
 * tell the outcomes apart, so the discrimination lives in the schema (ERR-1c). A message quotes the
 * request unescaped, so it can hold a `|` of its own: the service page makes it everything after the
 * line's second `|`. An OK line's fields are the gateway's own values, none of which holds a `|`.
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Body } from "viell-effect-schema-http";

/** An eight-digit account number. */
export const AccountNumber = Schema.String.check(Schema.isPattern(/^\d{8}$/));

/** A month as `YYYYMM`. */
export const Period = Schema.String.check(
  Schema.isPattern(/^\d{4}(0[1-9]|1[0-2])$/),
);

/**
 * One reply line split at every `|`. Exactly one line, LF-terminated; no field holds a `|`, so a
 * value that does spans several fields, and only the line's own schema can join them again, as
 * `ErrorLine` does for its message.
 */
export const PipeLine = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transformEffect<ReadonlyArray<string>, string>({
      decode: (text, options) =>
        text.endsWith("\n") &&
        text.indexOf("\n") === text.length - 1 &&
        !text.includes("\r")
          ? Effect.succeed(text.slice(0, -1).split("|"))
          : Effect.fail(
              new SchemaIssue.InvalidValue(
                {
                  message: `expected one LF-terminated line, got ${JSON.stringify(text)}`,
                },
                text,
                options,
              ),
            ),
      encode: (fields, options) =>
        fields.some((field) => /[|\n\r]/.test(field))
          ? Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "a field holds a separator" },
                fields,
                options,
              ),
            )
          : Effect.succeed(`${fields.join("|")}\n`),
    }),
  ),
);

/** A refusal the gateway reported in the body. */
export const GatewayError = Schema.TaggedStruct("GatewayError", {
  code: Schema.String,
  message: Schema.String,
});
export type GatewayError = typeof GatewayError.Type;

/** `ERROR`, the code, then the message in one field or more, which its own `|` separated. */
const ErrorFields = Schema.TupleWithRest(
  Schema.Tuple([Schema.Literal("ERROR"), Schema.NonEmptyString, Schema.String]),
  [Schema.String],
);

/**
 * `ERROR|<code>|<message>`, the message being everything after the second `|`: the fields after the
 * code, joined by the `|` that split them. The code ends at the second `|`, so it never holds one,
 * and `PipeLine` refuses to write one that does.
 */
export const ErrorLine = ErrorFields.pipe(
  Schema.decodeTo(
    GatewayError,
    SchemaTransformation.transform<GatewayError, (typeof ErrorFields)["Type"]>({
      decode: ([, code, ...message]) => ({
        _tag: "GatewayError",
        code,
        message: message.join("|"),
      }),
      encode: ({ code, message }) => {
        const [first = "", ...rest] = message.split("|");
        return ["ERROR", code, first, ...rest];
      },
    }),
  ),
);

/** A reply that is either the given OK line or an ERROR line. */
export const reply = <A, RD, RE>(
  ok: Schema.Codec<A, ReadonlyArray<string>, RD, RE>,
) => PipeLine.pipe(Schema.decodeTo(Schema.Union([ok, ErrorLine])));

/** A UTF-8 text decoder for a pipe reply. */
export const pipeBody = <A, RD, RE>(
  ok: Schema.Codec<A, ReadonlyArray<string>, RD, RE>,
) => Body.text.pipe(Body.schema(reply(ok)));

/** An ERROR line read from raw bytes, for endpoints whose success body is not text. */
export const ErrorFromBytes = Schema.Uint8Array.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect<string, Uint8Array>({
      decode: (bytes, options) => {
        try {
          return Effect.succeed(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          return Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: "not UTF-8" },
              bytes,
              options,
            ),
          );
        }
      },
      encode: (text) => Effect.succeed(new TextEncoder().encode(text)),
    }),
  ),
  Schema.decodeTo(PipeLine),
  Schema.decodeTo(ErrorLine),
);
