/**
 * Value conventions of the identity provider, as the consumer reads them. Every transform is
 * strict: it accepts exactly the spellings the provider emits and refuses looser ones, so a
 * decoded value encodes back to the same wire text. Where a mapping deliberately drops
 * information, its documentation says what is lost.
 */
import {
  Effect,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

const refuse = (
  message: string,
  input: unknown,
  options: SchemaAST.ParseOptions,
): SchemaIssue.Issue =>
  new SchemaIssue.InvalidValue({ message }, input, options);

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0");

const generalizedTime = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/;

const formatGeneralizedTime = (date: Date): string =>
  pad(date.getUTCFullYear(), 4) +
  pad(date.getUTCMonth() + 1, 2) +
  pad(date.getUTCDate(), 2) +
  pad(date.getUTCHours(), 2) +
  pad(date.getUTCMinutes(), 2) +
  pad(date.getUTCSeconds(), 2) +
  "Z";

/**
 * VAL-1a. LDAP generalized time in the one form the directory writes: `YYYYMMDDHHMMSSZ`, whole
 * seconds in UTC. RFC 4517 allows omitted minutes or seconds, fractions and numeric offsets; the
 * directory never writes them, and accepting them would make the decoded instant encode to a
 * different string. A time without `Z` is local to an unknown zone and is refused rather than
 * read in the reader's own offset. Calendar-impossible values (February 30th, hour 24, a leap
 * second) are refused instead of rolled over.
 *
 * Encoding refuses an instant with milliseconds, which the form cannot carry, rather than
 * truncating it.
 */
export const LdapTime = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Date,
    SchemaTransformation.transformEffect({
      decode: (text: string, options) => {
        const match = generalizedTime.exec(text);
        if (match === null)
          return Effect.fail(
            refuse(
              "Expected LDAP generalized time as YYYYMMDDHHMMSSZ",
              text,
              options,
            ),
          );
        const [year, month, day, hour, minute, second] = match
          .slice(1)
          .map(Number) as [number, number, number, number, number, number];
        const date = new Date(0);
        date.setUTCFullYear(year, month - 1, day);
        date.setUTCHours(hour, minute, second, 0);
        return formatGeneralizedTime(date) === text
          ? Effect.succeed(date)
          : Effect.fail(refuse("Not a calendar date and time", text, options));
      },
      encode: (date: Date, options) => {
        if (date.getUTCMilliseconds() !== 0)
          return Effect.fail(
            refuse(
              "LDAP generalized time carries whole seconds; refusing to drop milliseconds",
              date,
              options,
            ),
          );
        const year = date.getUTCFullYear();
        if (year < 0 || year > 9999)
          return Effect.fail(
            refuse(
              "LDAP generalized time needs a four-digit year",
              date,
              options,
            ),
          );
        return Effect.succeed(formatGeneralizedTime(date));
      },
    }),
  ),
);

/** The token-type spellings the provider's three grant paths emit. */
export const tokenTypeSpellings = ["bearer", "Bearer", "BEARER"] as const;

/**
 * AUTH-3. The token type of a grant response, normalized to the RFC 6750 spelling `Bearer`.
 * Only the three spellings the provider is known to emit are accepted; another scheme, or a new
 * casing from a fourth code path, is refused rather than guessed.
 *
 * Canonicalizing, not reversible on the wire: the original spelling is deliberately not kept, so
 * encoding always writes `Bearer`. Authorization schemes are case-insensitive (RFC 9110), so the
 * dropped spelling carries no meaning; the domain value round-trips exactly.
 */
export const TokenType = Schema.Literals(tokenTypeSpellings).pipe(
  Schema.decodeTo(
    Schema.Literal("Bearer"),
    SchemaTransformation.transform<
      "Bearer",
      (typeof tokenTypeSpellings)[number]
    >({
      decode: () => "Bearer",
      encode: () => "Bearer",
    }),
  ),
);

/**
 * PAY-9. A non-negative integer written as a decimal string, such as `"3600"`, as the 2012
 * token servlet writes every value. Only the canonical spelling is accepted: no sign, leading
 * zero, fraction, exponent or whitespace, and at most 15 digits so the number stays exact.
 */
export const IntegerString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Natural,
    SchemaTransformation.transformEffect({
      decode: (text: string, options) =>
        /^(0|[1-9]\d{0,14})$/.test(text)
          ? Effect.succeed(Number(text))
          : Effect.fail(
              refuse(
                "Expected a non-negative decimal integer without sign, padding or fraction",
                text,
                options,
              ),
            ),
      encode: (value: number) => Effect.succeed(String(value)),
    }),
  ),
);

/**
 * VAL-5a. The provider's issuer identifier. OpenID Connect compares issuers as exact strings, so
 * the trailing slash this provider has always published is part of the value: it is kept on
 * decode, written back unchanged, and never added or removed. Query strings and fragments are
 * refused, as the specification forbids them.
 */
export const Issuer = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/),
).pipe(Schema.brand("Issuer"));
export type Issuer = typeof Issuer.Type;

/** ERR-4. The directory's `Y`, decoded as `true`. Any other spelling is refused. */
export const Yes = Schema.Literal("Y").pipe(
  Schema.decodeTo(
    Schema.Literal(true),
    SchemaTransformation.transform({
      decode: () => true as const,
      encode: () => "Y" as const,
    }),
  ),
);

/** ERR-4. The directory's `N`, decoded as `false`. Any other spelling is refused. */
export const No = Schema.Literal("N").pipe(
  Schema.decodeTo(
    Schema.Literal(false),
    SchemaTransformation.transform({
      decode: () => false as const,
      encode: () => "N" as const,
    }),
  ),
);

/** The directory's flag as a boolean: `Y` or `N` exactly, refusing `y`, `1` and `true`. */
export const YesNo = Schema.Union([Yes, No]);

const Blank = Schema.Literal("").pipe(
  Schema.decodeTo(
    Schema.Null,
    SchemaTransformation.transform({
      decode: () => null,
      encode: () => "" as const,
    }),
  ),
);

/**
 * ERR-4. A directory attribute that the gateway blanks when it has no value: the empty string
 * decodes to `null`, and `null` encodes to the empty string. The value schema must refuse the
 * empty string itself, so that the domain never holds both `""` and `null` and the mapping stays
 * reversible.
 */
export const blankAsNull = <S extends Schema.Constraint>(value: S) =>
  Schema.Union([Blank, value]);
