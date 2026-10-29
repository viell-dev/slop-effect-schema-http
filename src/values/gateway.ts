/**
 * Value conventions of the CGI reporting gateway, as strict reversible schemas over the lexical text
 * the gateway writes. Each decoder accepts exactly the spelling its encoder produces and refuses
 * looser spellings, so a decoded value re-encodes to the same text.
 *
 * - Money (VAL-2b): XML-RPC doubles in units with two decimals, integer cents with implied
 *   decimals (zero padded in fixed-width files, unpadded in pipe replies), and a decimal comma in
 *   the German CSV. All of them decode to branded integer cents; no floating-point arithmetic is
 *   involved in either direction.
 * - Dates (VAL-1c): XML-RPC's separator-free `dateTime.iso8601`, bare `YYYYMMDD`, and a zero date
 *   that means "none". The gateway's clock has been UTC since the 2004 data-centre move, so its
 *   zone-less times are read as UTC, never in the reader's own zone.
 * - Booleans (VAL-3b): XML-RPC's `1` and `0`.
 */
import {
  DateTime,
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

/** Money as an integer number of cents. */
export const Cents = Schema.Int.pipe(Schema.brand("GatewayCents"));
export type Cents = typeof Cents.Type;

/** Refuse a value with a reason; the schema reports it as an `InvalidValue` issue. */
class Refusal {
  constructor(readonly reason: string) {}
}

const refuse = (reason: string): Refusal => new Refusal(reason);

/** A transformation whose directions may refuse their input with a reason. */
const strict = <T, E>(options: {
  readonly decode: (encoded: E) => T | Refusal;
  readonly encode: (value: T) => E | Refusal;
}): SchemaTransformation.Transformation<T, E> =>
  SchemaTransformation.transformEffect<T, E>({
    decode: (encoded, parse) => {
      const result = options.decode(encoded);
      return result instanceof Refusal
        ? Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: result.reason },
              encoded,
              parse,
            ),
          )
        : Effect.succeed(result);
    },
    encode: (value, parse) => {
      const result = options.encode(value);
      return result instanceof Refusal
        ? Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: result.reason },
              value,
              parse,
            ),
          )
        : Effect.succeed(result);
    },
  });

const cents = (value: number): number | Refusal =>
  Number.isSafeInteger(value)
    ? value
    : refuse(`${value} cents is out of range`);

/** Split cents into a sign and whole units and the two-digit remainder, without floating point. */
const units = (
  value: number,
): { sign: string; whole: string; fraction: string } => {
  const magnitude = Math.abs(value);
  return {
    sign: value < 0 ? "-" : "",
    whole: String(Math.floor(magnitude / 100)),
    fraction: String(magnitude % 100).padStart(2, "0"),
  };
};

const decimal = (separator: "." | ",") => {
  const pattern =
    separator === "."
      ? /^(-?)(0|[1-9]\d*)\.(\d{2})$/
      : /^(-?)(0|[1-9]\d*),(\d{2})$/;
  return strict<number, string>({
    decode: (text) => {
      const match = pattern.exec(text);
      if (match === null)
        return refuse(
          `expected units with exactly two decimals after "${separator}", such as "1234${separator}50"; got ${JSON.stringify(text)}`,
        );
      const [, sign, whole, fraction] = match;
      const value = Number(whole) * 100 + Number(fraction);
      if (sign === "-" && value === 0)
        return refuse(`negative zero ${JSON.stringify(text)}`);
      return cents(sign === "-" ? -value : value);
    },
    encode: (value) => {
      const { sign, whole, fraction } = units(value);
      return `${sign}${whole}${separator}${fraction}`;
    },
  });
};

/** Units with a dot and exactly two decimals (`"1234.50"`), as XML-RPC doubles and the comma CSV. */
export const CentsFromUnits = Schema.String.pipe(
  Schema.decodeTo(Cents, decimal(".")),
);

/** Units with a decimal comma and exactly two decimals (`"1234,50"`), as the German CSV. */
export const CentsFromDecimalComma = Schema.String.pipe(
  Schema.decodeTo(Cents, decimal(",")),
);

/**
 * Unsigned cents with two implied decimals, zero padded to `width` digits (`"00000123450"` is
 * 1234.50), as fixed-width extracts. Encoding refuses negative amounts and overflow.
 */
export const CentsFromImpliedDecimals = (width: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Cents,
      strict<number, string>({
        decode: (text) =>
          new RegExp(`^\\d{${width}}$`).test(text)
            ? cents(Number(text))
            : refuse(
                `expected ${width} digits with implied decimals; got ${JSON.stringify(text)}`,
              ),
        encode: (value) => {
          if (value < 0)
            return refuse(`${value} cents cannot be written unsigned`);
          const text = String(value).padStart(width, "0");
          return text.length > width
            ? refuse(`${value} cents overflows ${width} digits`)
            : text;
        },
      }),
    ),
  );

/** Signed cents with implied decimals and no padding (`"123450"`, `"-75"`), as pipe replies. */
export const CentsFromImpliedInteger = Schema.String.pipe(
  Schema.decodeTo(
    Cents,
    strict<number, string>({
      decode: (text) =>
        /^(0|-?[1-9]\d*)$/.test(text)
          ? cents(Number(text))
          : refuse(
              `expected an integer number of cents without padding; got ${JSON.stringify(text)}`,
            ),
      encode: (value) => String(value),
    }),
  ),
);

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const two = (value: number): string => String(value).padStart(2, "0");

/** A UTC instant from validated parts, or a refusal naming the impossible date. */
const instant = (
  text: string,
  [year, month, day, hour, minute, second]: ReadonlyArray<number>,
): DateTime.Utc | Refusal => {
  if (
    year! < 1 ||
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > daysIn(year!, month!)
  )
    return refuse(`${JSON.stringify(text)} is not a calendar date`);
  if (hour! > 23 || minute! > 59 || second! > 59)
    return refuse(`${JSON.stringify(text)} is not a time of day`);
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(hour!, minute!, second!, 0);
  return DateTime.makeUnsafe(date.getTime());
};

const yyyymmdd = (value: DateTime.Utc): string | Refusal => {
  const parts = DateTime.toPartsUtc(value);
  if (parts.year < 1 || parts.year > 9999)
    return refuse(`year ${parts.year} needs four digits`);
  return `${String(parts.year).padStart(4, "0")}${two(parts.month)}${two(parts.day)}`;
};

const dateTimeIso8601 = strict<DateTime.Utc, string>({
  decode: (text) => {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(text);
    return match === null
      ? refuse(
          `expected YYYYMMDDTHH:MM:SS without zone; got ${JSON.stringify(text)}`,
        )
      : instant(text, match.slice(1).map(Number));
  },
  encode: (value) => {
    const parts = DateTime.toPartsUtc(value);
    if (parts.millisecond !== 0)
      return refuse("XML-RPC dateTime.iso8601 has no milliseconds");
    const date = yyyymmdd(value);
    return date instanceof Refusal
      ? date
      : `${date}T${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)}`;
  },
});

const bareDate = strict<DateTime.Utc, string>({
  decode: (text) => {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    return match === null
      ? refuse(`expected YYYYMMDD; got ${JSON.stringify(text)}`)
      : instant(text, [...match.slice(1).map(Number), 0, 0, 0]);
  },
  encode: (value) => {
    const parts = DateTime.toPartsUtc(value);
    if (
      parts.hour !== 0 ||
      parts.minute !== 0 ||
      parts.second !== 0 ||
      parts.millisecond !== 0
    )
      return refuse("a bare date cannot carry a time of day");
    return yyyymmdd(value);
  },
});

/** XML-RPC's separator-free `YYYYMMDDTHH:MM:SS`, read as UTC. */
export const DateTimeFromXmlRpc = Schema.String.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, dateTimeIso8601),
);

/** A bare `YYYYMMDD` calendar date, as midnight UTC. Encoding refuses a time of day. */
export const DateFromBare = Schema.String.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, bareDate),
);

/** A text value where one exact spelling means "none". */
const zeroMeansNone = <S extends Schema.Codec<DateTime.Utc, string>>(
  zero: string,
  present: S,
) =>
  Schema.Union([Schema.Literal(zero), present]).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.DateTimeUtc),
      SchemaTransformation.transform<
        Option.Option<DateTime.Utc>,
        string | DateTime.Utc
      >({
        decode: (value) =>
          value === zero ? Option.none() : Option.some(value as DateTime.Utc),
        encode: (value) => (Option.isNone(value) ? zero : value.value),
      }),
    ),
  );

/** `00000000T00:00:00` means none; anything else is a {@link DateTimeFromXmlRpc}. */
export const OptionalDateTimeFromXmlRpc = zeroMeansNone(
  "00000000T00:00:00",
  DateTimeFromXmlRpc,
);

/** `00000000` means none; anything else is a {@link DateFromBare}. */
export const OptionalDateFromBare = zeroMeansNone("00000000", DateFromBare);

/** XML-RPC's boolean lexical form: exactly `1` or `0`. */
export const BooleanFromBit = Schema.Literals(["1", "0"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform<boolean, "1" | "0">({
      decode: (bit) => bit === "1",
      encode: (flag) => (flag ? "1" : "0"),
    }),
  ),
);
