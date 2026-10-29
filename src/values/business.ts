/**
 * Value conventions of the JSON business API's operations era (`/v2/`): dates, money, flags,
 * absence, references and lists, each as a strict schema between the wire spelling and a domain
 * value.
 *
 * Every transform here is reversible for the spellings it accepts: decoding a canonical wire value
 * and encoding the result gives the same wire value back, and decoding refuses looser spellings that
 * would make the reverse ambiguous. The one deliberate loss, the five spellings of absence, is
 * documented on {@link optionalText}.
 */
import {
  DateTime,
  Effect,
  Option,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

const invalid = (input: unknown, message: string) =>
  new SchemaIssue.InvalidValue({ message }, input);

const fail = (input: unknown, message: string) =>
  Effect.fail(invalid(input, message));

const pad = (n: number) => String(n).padStart(2, "0");

/** The range of instants that ECMAScript dates (and Effect's `DateTime`) can represent. */
const maxEpochMillis = 8_640_000_000_000_000;

const utcFromMillis = (
  input: unknown,
  millis: number,
): Effect.Effect<DateTime.Utc, SchemaIssue.Issue> =>
  Number.isSafeInteger(millis) && Math.abs(millis) <= maxEpochMillis
    ? Effect.succeed(DateTime.makeUnsafe(millis))
    : fail(
        input,
        "expected a whole number of milliseconds within the date range",
      );

// ---------------------------------------------------------------------------------------------
// Dates (VAL-1b)
// ---------------------------------------------------------------------------------------------

/**
 * Epoch milliseconds as a JSON number. Refuses numeric strings, fractions and values outside the
 * date range. Seconds cannot be told apart from milliseconds by shape, so the transform does not
 * guess: a value in seconds decodes to an instant in January 1970.
 */
export const EpochMillis = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transformEffect({
      decode: (millis) => utcFromMillis(millis, millis),
      encode: (value) => Effect.succeed(DateTime.toEpochMillis(value)),
    }),
  ),
);

const aspNet = /^\/Date\((-?(?:0|[1-9]\d*))(?:([+-])(\d{2})(\d{2}))?\)\/$/;

/**
 * The ASP.NET JSON date, `/Date(<epoch ms>)/` or `/Date(<epoch ms>±hhmm)/`. The milliseconds are
 * the instant in UTC; the offset is decorative: it records the server's zone and never shifts the
 * instant. On the wire it is escaped as `\/Date(…)\/`, which JSON parsing turns into slashes.
 *
 * Decoding yields a `DateTime.Utc` without an offset and a `DateTime.Zoned` in a fixed-offset zone
 * with one, so the offset survives the round trip. Encoding refuses a named zone, whose offset is
 * not part of the value. Decoding refuses `+hh:mm`, missing digits, offsets beyond ±14:00, leading
 * zeros, whitespace and any other casing.
 */
export const AspNetDate = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Union([Schema.DateTimeUtc, Schema.DateTimeZoned]),
    SchemaTransformation.transformEffect({
      decode: (text) => {
        const match = aspNet.exec(text);
        if (match === null)
          return fail(
            text,
            "expected /Date(<epoch ms>)/ or /Date(<epoch ms>±hhmm)/",
          );
        const [, digits, sign, hours, minutes] = match;
        return Effect.flatMap(utcFromMillis(text, Number(digits)), (utc) => {
          if (sign === undefined) return Effect.succeed<DateTime.DateTime>(utc);
          const offsetMinutes = Number(hours) * 60 + Number(minutes);
          if (Number(minutes) > 59 || offsetMinutes > 14 * 60)
            return fail(text, "expected an offset between -1400 and +1400");
          // A negative zero offset is a different spelling of +0000; refuse it to stay reversible.
          if (sign === "-" && offsetMinutes === 0)
            return fail(text, "expected +0000 rather than -0000");
          const offset = (sign === "-" ? -1 : 1) * offsetMinutes * 60_000;
          return Effect.succeed<DateTime.DateTime>(
            DateTime.makeZonedUnsafe(DateTime.toEpochMillis(utc), {
              timeZone: DateTime.zoneMakeOffset(offset),
            }),
          );
        });
      },
      encode: (value) => {
        const millis = DateTime.toEpochMillis(value);
        if (DateTime.isUtc(value)) return Effect.succeed(`/Date(${millis})/`);
        if (!DateTime.isTimeZoneOffset(value.zone))
          return fail(
            value,
            "a named time zone has no single offset; convert it to a fixed offset first",
          );
        const offset = Math.round(DateTime.zonedOffset(value) / 60_000);
        const sign = offset < 0 ? "-" : "+";
        const absolute = Math.abs(offset);
        if (absolute > 14 * 60 || DateTime.zonedOffset(value) % 60_000 !== 0)
          return fail(
            value,
            "the offset is not a whole number of minutes within ±14:00",
          );
        const hh = String(Math.floor(absolute / 60)).padStart(2, "0");
        const mm = String(absolute % 60).padStart(2, "0");
        return Effect.succeed(`/Date(${millis}${sign}${hh}${mm})/`);
      },
    }),
  ),
);

/** A wall-clock reading without a zone. It is not an instant, and nothing here makes it one. */
export const LocalDateTime = Schema.Struct({
  year: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 9999 })),
  month: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  day: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
  second: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
});
export type LocalDateTime = typeof LocalDateTime.Type;

const isLeap = (year: number) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysIn = (year: number, month: number) =>
  [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]!;

const usLocal =
  /^(1[0-2]|[1-9])\/(3[01]|[12]\d|[1-9])\/(\d{4}) (1[0-2]|[1-9]):([0-5]\d):([0-5]\d) (AM|PM)$/;

/**
 * US month-first local time with no zone, as .NET's en-US general format writes it:
 * `M/d/yyyy h:mm:ss tt`, such as `11/14/2023 5:13:20 PM`. Decodes to a {@link LocalDateTime}, never
 * to an instant: a permissive parser such as `new Date(text)` reads it in the reader's own zone and
 * shifts the instant by that offset.
 *
 * Refuses zero-padded months, days and hours, 24-hour times, missing seconds, lower-case or missing
 * AM/PM, a trailing zone, ISO input and impossible calendar dates.
 */
export const UsLocalDateTime = Schema.String.pipe(
  Schema.decodeTo(
    LocalDateTime,
    SchemaTransformation.transformEffect({
      decode: (text) => {
        const match = usLocal.exec(text);
        if (match === null)
          return fail(text, "expected M/d/yyyy h:mm:ss AM|PM");
        const [, month, day, year, hour12, minute, second, half] = match;
        const value = {
          year: Number(year),
          month: Number(month),
          day: Number(day),
          hour: (Number(hour12) % 12) + (half === "PM" ? 12 : 0),
          minute: Number(minute),
          second: Number(second),
        };
        if (value.year < 1 || value.day > daysIn(value.year, value.month))
          return fail(text, "the calendar has no such date");
        return Effect.succeed(value);
      },
      encode: (value) => {
        if (value.day > daysIn(value.year, value.month))
          return fail(value, "the calendar has no such date");
        const hour12 = value.hour % 12 === 0 ? 12 : value.hour % 12;
        const half = value.hour < 12 ? "AM" : "PM";
        return Effect.succeed(
          `${value.month}/${value.day}/${String(value.year).padStart(4, "0")} ` +
            `${hour12}:${pad(value.minute)}:${pad(value.second)} ${half}`,
        );
      },
    }),
  ),
);

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const imfFixdate =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/** Format an instant with whole seconds as an IMF-fixdate. */
export const formatHttpDate = (millis: number): string => {
  const date = new Date(millis);
  return (
    `${weekdays[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${String(date.getUTCFullYear()).padStart(4, "0")} ${pad(date.getUTCHours())}:` +
    `${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT`
  );
};

/**
 * HTTP-date in the IMF-fixdate form that senders must generate (RFC 9110, section 5.6.7), such as
 * `Sun, 06 Nov 1994 08:49:37 GMT`. Refuses the obsolete RFC 850 and asctime forms, a weekday that
 * does not match the date, numeric zones, single-digit days and impossible dates. The form has
 * one-second resolution, so encoding refuses an instant with milliseconds rather than truncating.
 */
export const HttpDate = Schema.String.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transformEffect({
      decode: (text) => {
        const match = imfFixdate.exec(text);
        if (match === null)
          return fail(
            text,
            "expected an IMF-fixdate such as Sun, 06 Nov 1994 08:49:37 GMT",
          );
        const [, weekday, day, month, year, hour, minute, second] = match;
        const monthIndex = months.indexOf(month as (typeof months)[number]);
        const millis = Date.UTC(
          Number(year),
          monthIndex,
          Number(day),
          Number(hour),
          Number(minute),
          Number(second),
        );
        const date = new Date(millis);
        if (
          Number(year) < 1 ||
          date.getUTCDate() !== Number(day) ||
          Number(hour) > 23 ||
          Number(minute) > 59 ||
          Number(second) > 59
        )
          return fail(text, "the calendar has no such date or time");
        if (weekdays[date.getUTCDay()] !== weekday)
          return fail(text, "the weekday does not match the date");
        return utcFromMillis(text, millis);
      },
      encode: (value) => {
        const millis = DateTime.toEpochMillis(value);
        return millis % 1000 === 0
          ? Effect.succeed(formatHttpDate(millis))
          : fail(
              value,
              "HTTP-date has one-second resolution; the value has milliseconds",
            );
      },
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Money (VAL-2a)
// ---------------------------------------------------------------------------------------------

/** An amount of money in integer cents. Arithmetic on it stays exact. */
export const Cents = Schema.Int.check(
  Schema.isBetween({
    minimum: Number.MIN_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
).pipe(Schema.brand("Cents"));
export type Cents = typeof Cents.Type;

const dollars = /^(-?)\$(0|[1-9]\d{0,2}(?:,\d{3})*)\.(\d{2})$/;

/**
 * A formatted dollar string, `$1,234.56` or `-$1,234.56`, as branded integer cents. Refuses
 * unformatted numbers (`1234.56`, `$1234.56`), a missing or partial cents part, spaces, currency
 * codes, leading zeros, accounting parentheses, and `-$0.00`.
 */
export const DollarString = Schema.String.pipe(
  Schema.decodeTo(
    Cents,
    SchemaTransformation.transformEffect({
      decode: (text) => {
        const match = dollars.exec(text);
        if (match === null)
          return fail(
            text,
            "expected a formatted dollar amount such as $1,234.56",
          );
        const [, sign, whole, fraction] = match;
        const magnitude =
          Number(whole!.replaceAll(",", "")) * 100 + Number(fraction);
        if (!Number.isSafeInteger(magnitude))
          return fail(text, "the amount is too large to represent in cents");
        if (sign === "-" && magnitude === 0)
          return fail(text, "expected $0.00 rather than -$0.00");
        return Effect.succeed(sign === "-" ? -magnitude : magnitude);
      },
      encode: (cents) => {
        const magnitude = Math.abs(cents);
        const whole = Math.floor(magnitude / 100)
          .toString()
          .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        const fraction = String(magnitude % 100).padStart(2, "0");
        return Effect.succeed(`${cents < 0 ? "-" : ""}$${whole}.${fraction}`);
      },
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Booleans (VAL-3a)
// ---------------------------------------------------------------------------------------------

/** `Y` and `N` as a boolean. Refuses `y`, `n`, `1`, `0`, `true`, `false`, `Yes` and JSON booleans. */
export const YesNo = Schema.Literals(["Y", "N"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (flag) => flag === "Y",
      encode: (value): "Y" | "N" => (value ? "Y" : "N"),
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Absence and limits (VAL-4)
// ---------------------------------------------------------------------------------------------

const isAbsentSpelling = (value: string | null) =>
  value === null || value.trim() === "" || value === "null";

/**
 * Text that is present: not blank and not the word `null`, which the wire uses for absence. Kept as
 * written otherwise, including surrounding spaces.
 */
export const PresentText = Schema.String.check(
  Schema.makeFilter((value: string) =>
    isAbsentSpelling(value)
      ? "a blank string or the word null cannot be sent; the wire reads it as absent"
      : undefined,
  ),
);

/**
 * An optional text field whose absence arrives in five spellings: `null`, `""`, `"null"`, a missing
 * key and a blank string. All five decode to a missing key, so the domain sees one absence.
 *
 * This is the one deliberate loss in this module: the five spellings collapse into one, and
 * encoding writes the canonical absence, a missing key. Present values round-trip unchanged, and
 * encoding refuses a present value that the wire would read back as absent.
 */
export const optionalText = Schema.optionalKey(
  Schema.NullOr(Schema.String),
).pipe(
  Schema.decodeTo(
    Schema.optionalKey(PresentText),
    SchemaTransformation.transformOptional<string, string | null>({
      decode: (wire) =>
        Option.flatMap(wire, (value): Option.Option<string> =>
          value === null || isAbsentSpelling(value)
            ? Option.none()
            : Option.some(value),
        ),
      encode: (domain) => domain,
    }),
  ),
);

/** A count limit where the wire's `-1` means unlimited and `0` is a real limit of zero. */
export const Limit = Schema.Int.check(
  Schema.isBetween({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(
  Schema.decodeTo(
    Schema.Union([
      Schema.Literal("unlimited"),
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ]),
    SchemaTransformation.transform({
      decode: (wire): "unlimited" | number =>
        wire === -1 ? "unlimited" : wire,
      encode: (domain) => (domain === "unlimited" ? -1 : domain),
    }),
  ),
);
export type Limit = typeof Limit.Type;

// ---------------------------------------------------------------------------------------------
// References and lists (VAL-5b)
// ---------------------------------------------------------------------------------------------

/** A customer id as the business API issues it: a positive integer. */
export const CustomerId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("CustomerId"),
);
export type CustomerId = typeof CustomerId.Type;

const ExpandedCustomerWire = Schema.Struct({
  id: CustomerId,
  name: Schema.String,
  country: Schema.String,
});

const ExpandedCustomer = Schema.TaggedStruct("Expanded", {
  id: CustomerId,
  name: Schema.String,
  country: Schema.String,
});

const CustomerReference = Schema.TaggedStruct("Reference", { id: CustomerId });

/**
 * A customer reference that the serializer expands into an object the first time a customer
 * appears in a response and leaves as a bare id afterwards. The domain keeps the distinction as a
 * tag, `Expanded` or `Reference`, attached on decode and stripped on encode, so both shapes
 * round-trip.
 */
export const CustomerRef = Schema.Union([
  ExpandedCustomerWire.pipe(
    Schema.decodeTo(
      ExpandedCustomer,
      SchemaTransformation.transform<
        typeof ExpandedCustomer.Encoded,
        typeof ExpandedCustomerWire.Type
      >({
        decode: (wire) => ({ _tag: "Expanded", ...wire }),
        encode: ({ id, name, country }) => ({
          id: CustomerId.make(id),
          name,
          country,
        }),
      }),
    ),
  ),
  CustomerId.pipe(
    Schema.decodeTo(
      CustomerReference,
      SchemaTransformation.transform<
        typeof CustomerReference.Encoded,
        CustomerId
      >({
        decode: (id) => ({ _tag: "Reference", id }),
        encode: ({ id }) => CustomerId.make(id),
      }),
    ),
  ),
]);
export type CustomerRef = typeof CustomerRef.Type;

const spaceDelimited = /^(?:[^\s]+(?: [^\s]+)*)?$/;

/**
 * A list sent as one space-delimited string where the specification says array, such as
 * `"urgent overdue"`. The empty string is the empty list. Refuses repeated, leading or trailing
 * spaces, tabs and JSON arrays; encoding refuses an item that is empty or contains whitespace,
 * because the wire cannot carry it.
 */
export const SpaceDelimited = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transformEffect<ReadonlyArray<string>, string>({
      decode: (text) =>
        spaceDelimited.test(text)
          ? Effect.succeed(text === "" ? [] : text.split(" "))
          : fail(text, "expected items separated by single spaces"),
      encode: (items) =>
        items.every((item) => /^[^\s]+$/.test(item))
          ? Effect.succeed(items.join(" "))
          : fail(items, "an item is empty or contains whitespace"),
    }),
  ),
);
