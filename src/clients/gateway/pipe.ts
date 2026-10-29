/**
 * The gateway's pipe-delimited replies: one line ending in `\n`, fields separated by `|`, `OK|…` on
 * success and `ERROR|<code>|<message>` otherwise, all inside HTTP 200. Status and headers cannot
 * tell the outcomes apart, so the discrimination lives in the schema (ERR-1c).
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Body } from "viell-effect-schema-http";

/** An eight-digit account number. */
export const AccountNumber = Schema.String.check(Schema.isPattern(/^\d{8}$/));

/** A month as `YYYYMM`. */
export const Period = Schema.String.check(
  Schema.isPattern(/^\d{4}(0[1-9]|1[0-2])$/),
);

/** One reply line split into its fields. Exactly one line, LF-terminated; no field may hold a `|`. */
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

const ErrorFields = Schema.Tuple([
  Schema.Literal("ERROR"),
  Schema.NonEmptyString,
  Schema.String,
]);

/** `ERROR|<code>|<message>`. */
export const ErrorLine = ErrorFields.pipe(
  Schema.decodeTo(
    GatewayError,
    SchemaTransformation.transform<GatewayError, (typeof ErrorFields)["Type"]>({
      decode: ([, code, message]) => ({ _tag: "GatewayError", code, message }),
      encode: ({ code, message }) => ["ERROR", code, message],
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
