/**
 * Value conventions of the notification service's headers, written by the consumer from the RFCs
 * the service cites. Each schema is strict and reversible: it decodes only the canonical spelling
 * (or a spelling whose difference is stated below) and refuses looser ones with a reason, and its
 * encoder refuses a value it cannot write without loss.
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import type { SchemaAST } from "effect";

const refuse = (
  message: string,
  input: unknown,
  options: SchemaAST.ParseOptions,
): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue({ message }, input, options));

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
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

const two = (value: number) => String(value).padStart(2, "0");

/** Parse an IMF-fixdate, or return the reason it is refused. */
const parseImfFixdate = (text: string): Date | string => {
  const match = imfFixdate.exec(text);
  if (match === null)
    return "expected an IMF-fixdate such as `Sun, 06 Nov 1994 08:49:37 GMT`; RFC 850 and asctime forms are refused";
  const [, weekday, day, month, year, hour, minute, second] = match;
  const [d, y, h, m, s] = [day, year, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (h > 23 || m > 59 || s > 59)
    return "time of day out of range (a leap second is not representable)";
  const date = new Date(0);
  date.setUTCFullYear(y, months.indexOf(month as (typeof months)[number]), d);
  date.setUTCHours(h, m, s, 0);
  if (date.getUTCDate() !== d) return `${month} has no day ${day}`;
  if (days[date.getUTCDay()] !== weekday)
    return `${text.slice(5, 16)} is a ${days[date.getUTCDay()]}, not a ${weekday}`;
  return date;
};

/** Format a Date as an IMF-fixdate, or return the reason it cannot be written without loss. */
const formatImfFixdate = (date: Date): string => {
  if (Number.isNaN(date.getTime())) return "invalid Date";
  if (date.getTime() % 1000 !== 0)
    return "an HTTP-date has whole seconds; this Date has milliseconds";
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) return "an HTTP-date has a four-digit year";
  return `${days[date.getUTCDay()]}, ${two(date.getUTCDate())} ${months[date.getUTCMonth()]} ${String(year).padStart(4, "0")} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} GMT`;
};

const isFormatted = (result: string): boolean => result.endsWith(" GMT");

/**
 * HTTP-date in its preferred IMF-fixdate form (RFC 9110 §5.6.7), as `Sunset` carries it. The
 * weekday must match the date. The obsolete RFC 850 and asctime forms are refused, and a Date
 * with milliseconds cannot be encoded.
 */
export const HttpDate = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Date,
    SchemaTransformation.transformEffect({
      decode: (text, options) => {
        const parsed = parseImfFixdate(text);
        return typeof parsed === "string"
          ? refuse(parsed, text, options)
          : Effect.succeed(parsed);
      },
      encode: (date, options) => {
        const formatted = formatImfFixdate(date);
        return isFormatted(formatted)
          ? Effect.succeed(formatted)
          : refuse(formatted, date, options);
      },
    }),
  ),
);

const structuredInteger = /^@(-?)(0|[1-9]\d{0,14})$/;

/**
 * A Structured Field Date (RFC 9651 §3.3.7), the form RFC 9745 gives `Deprecation`: `@` and the
 * whole seconds since the epoch. Refused: the draft-era `true` and HTTP-date forms, parameters,
 * leading zeros and `-0` (non-canonical), and Dates with milliseconds on encode.
 */
export const StructuredDate = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Date,
    SchemaTransformation.transformEffect({
      decode: (text, options) => {
        const match = structuredInteger.exec(text);
        if (match === null)
          return refuse(
            "expected a Structured Field Date such as `@1688169599`",
            text,
            options,
          );
        if (match[1] === "-" && match[2] === "0")
          return refuse("`@-0` is not canonical", text, options);
        const date = new Date(Number(text.slice(1)) * 1000);
        return Number.isNaN(date.getTime())
          ? refuse("outside the range of a Date", text, options)
          : Effect.succeed(date);
      },
      encode: (date, options) =>
        date.getTime() % 1000 !== 0
          ? refuse(
              "a Structured Field Date has whole seconds; this Date has milliseconds",
              date,
              options,
            )
          : Effect.succeed(`@${date.getTime() / 1000 || 0}`),
    }),
  ),
);

/** One `Warning` value (RFC 7234 §5.5). `date` is the optional warn-date. */
export interface Warning {
  readonly code: number;
  readonly agent: string;
  readonly text: string;
  readonly date?: Date;
}

const Warning = Schema.Struct({
  code: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999 })),
  agent: Schema.String,
  text: Schema.String,
  date: Schema.optionalKey(Schema.Date),
});

const agentPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z:[\]]+$/;
const isQdtext = (code: number) =>
  code === 0x09 ||
  code === 0x20 ||
  code === 0x21 ||
  (code >= 0x23 && code <= 0x5b) ||
  (code >= 0x5d && code <= 0x7e) ||
  (code >= 0x80 && code <= 0xff);
const isEscapable = (code: number) =>
  code === 0x09 ||
  (code >= 0x20 && code <= 0x7e) ||
  (code >= 0x80 && code <= 0xff);

/** Parse a `Warning` field value: a comma-separated list whose texts and dates may hold commas. */
const parseWarnings = (source: string): ReadonlyArray<Warning> | string => {
  const warnings: Array<Warning> = [];
  let index = 0;
  const ows = () => {
    while (source[index] === " " || source[index] === "\t") index++;
  };
  const quoted = (): string | undefined => {
    if (source[index] !== '"') return undefined;
    index++;
    let value = "";
    while (index < source.length) {
      const char = source[index]!;
      const code = char.charCodeAt(0);
      if (char === '"') {
        index++;
        return value;
      }
      if (char === "\\") {
        const next = source.charCodeAt(index + 1);
        if (!isEscapable(next)) return undefined;
        value += source[index + 1];
        index += 2;
        continue;
      }
      if (!isQdtext(code)) return undefined;
      value += char;
      index++;
    }
    return undefined;
  };
  if (source.trim() === "") return "an empty Warning field";
  while (index < source.length) {
    ows();
    if (source[index] === ",") {
      // RFC 9110 §5.6.1.2: recipients ignore empty list elements.
      index++;
      continue;
    }
    if (index >= source.length) break;
    const code = /^\d{3} /.exec(source.slice(index));
    if (code === null)
      return `expected a three-digit warn-code at offset ${index}`;
    index += 4;
    const end = source.indexOf(" ", index);
    const agent = end < 0 ? "" : source.slice(index, end);
    if (!agentPattern.test(agent))
      return `expected a warn-agent (host[:port] or pseudonym) at offset ${index}`;
    index = end + 1;
    const text = quoted();
    if (text === undefined)
      return `expected a quoted warn-text at offset ${index}`;
    let date: Date | undefined;
    if (source[index] === " " && source[index + 1] === '"') {
      index++;
      const raw = quoted();
      if (raw === undefined) return `malformed warn-date at offset ${index}`;
      const parsed = parseImfFixdate(raw);
      if (typeof parsed === "string") return `warn-date: ${parsed}`;
      date = parsed;
    }
    warnings.push({
      code: Number(code[0].slice(0, 3)),
      agent,
      text,
      ...(date === undefined ? {} : { date }),
    });
    ows();
    if (index < source.length && source[index] !== ",")
      return `expected a comma between warnings at offset ${index}`;
  }
  return warnings;
};

const quote = (text: string): string | undefined => {
  let output = '"';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === '"' || char === "\\") output += `\\${char}`;
    else if (isQdtext(code) && char.length === 1) output += char;
    else return undefined;
  }
  return `${output}"`;
};

const formatWarning = (warning: Warning): string => {
  if (!agentPattern.test(warning.agent))
    return `warn-agent ${JSON.stringify(warning.agent)} is not a host or pseudonym`;
  const text = quote(warning.text);
  if (text === undefined)
    return "warn-text holds a character a quoted-string cannot carry";
  let date = "";
  if (warning.date !== undefined) {
    const formatted = formatImfFixdate(warning.date);
    if (!isFormatted(formatted)) return `warn-date: ${formatted}`;
    date = ` "${formatted}"`;
  }
  return `${String(warning.code).padStart(3, "0")} ${warning.agent} ${text}${date}`;
};

/**
 * The `Warning` field (RFC 7234 §5.5; obsoleted by RFC 9111 but still sent by legacy services). A
 * provider that joins repeated lines with `, ` produces one list; the parser splits it outside
 * quoted strings, since texts and warn-dates contain commas. Canonicalization: separators encode
 * as `, `, empty list elements are dropped, and only `"` and `\` are escaped, so a decoded value
 * round-trips exactly and a canonical field string does too.
 */
export const WarningList = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Warning),
    SchemaTransformation.transformEffect({
      decode: (source, options) => {
        const parsed = parseWarnings(source);
        return typeof parsed === "string"
          ? refuse(parsed, source, options)
          : Effect.succeed(parsed);
      },
      encode: (warnings, options) => {
        if (warnings.length === 0)
          return refuse(
            "a Warning field has at least one value",
            warnings,
            options,
          );
        const parts: Array<string> = [];
        for (const warning of warnings) {
          const formatted = formatWarning(warning);
          if (!/^\d{3} /.test(formatted))
            return refuse(formatted, warnings, options);
          parts.push(formatted);
        }
        return Effect.succeed(parts.join(", "));
      },
    }),
  ),
);

/** The three retirement announcements of one response, read from its normalized header map. */
export const Retirement = Schema.Struct({
  deprecation: StructuredDate,
  sunset: HttpDate,
  warning: WarningList,
});

const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A comma-separated list of tokens (RFC 9110 §5.6.1), such as `Allow` or the CORS method and
 * header lists, written with `separator`. Decoding accepts optional whitespace around commas and
 * drops empty elements; element case is kept. A field string round-trips when it is canonical for
 * the separator.
 */
export const tokenList = (separator: ", " | ",") =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transformEffect<ReadonlyArray<string>, string>({
        decode: (source, options) => {
          const elements = source
            .split(",")
            .map((element) => element.replace(/^[ \t]+|[ \t]+$/g, ""))
            .filter((element) => element !== "");
          const invalid = elements.find(
            (element) => !tokenPattern.test(element),
          );
          return invalid === undefined
            ? Effect.succeed(elements)
            : refuse(
                `${JSON.stringify(invalid)} is not a token`,
                source,
                options,
              );
        },
        encode: (elements, options) => {
          const invalid = elements.find(
            (element) => !tokenPattern.test(element),
          );
          return invalid === undefined
            ? Effect.succeed(elements.join(separator))
            : refuse(
                `${JSON.stringify(invalid)} is not a token`,
                elements,
                options,
              );
        },
      }),
    ),
  );

const credentialValue = /^[!#-[\]-~]+$/;
const tokenCredential = /^Token token="([!#-[\]-~]+)"$/;

/**
 * The service's `Token` authorization scheme in its Rails form, `Token token="<opaque>"`, as the
 * `Authorization` value. The scheme name is case-sensitive and the parameter must be quoted; the
 * bare `Token <opaque>` and `Bearer` forms are refused. The opaque value is visible ASCII without
 * `"` or `\`, so it never needs escaping.
 */
export const TokenCredential = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (header, options) => {
        const match = tokenCredential.exec(header);
        return match === null
          ? refuse('expected `Token token="<opaque>"`', header, options)
          : Effect.succeed(match[1]!);
      },
      encode: (token, options) =>
        credentialValue.test(token)
          ? Effect.succeed(`Token token="${token}"`)
          : refuse(
              "an opaque token is visible ASCII without quotes or backslashes",
              token,
              options,
            ),
    }),
  ),
);
