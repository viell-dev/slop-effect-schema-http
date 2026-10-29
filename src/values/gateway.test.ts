import { describe, expect, it } from "@effect/vitest";
import { DateTime, Option, Schema } from "effect";
import {
  BooleanFromBit,
  Cents,
  CentsFromDecimalComma,
  CentsFromImpliedDecimals,
  CentsFromImpliedInteger,
  CentsFromUnits,
  DateFromBare,
  DateTimeFromXmlRpc,
  OptionalDateFromBare,
  OptionalDateTimeFromXmlRpc,
} from "./gateway.js";

/**
 * Semantic equality checked by the round trips: decoding then encoding reproduces the exact text,
 * and encoding then decoding reproduces an equal value (DateTime compared by epoch milliseconds,
 * cents as integers). Every refused spelling would otherwise decode to a value whose encoding
 * differs from the input.
 */
const roundTrip = <T>(schema: Schema.Codec<T, string>, text: string): T => {
  const value = Schema.decodeUnknownSync(schema)(text);
  expect(Schema.encodeSync(schema)(value)).toBe(text);
  return value;
};

const refuses = <T>(
  schema: Schema.Codec<T, string>,
  text: string,
  reason: RegExp,
) => expect(() => Schema.decodeUnknownSync(schema)(text)).toThrow(reason);

const utc = (iso: string) => DateTime.makeUnsafe(iso);

const millis = (value: DateTime.Utc) => DateTime.toEpochMillis(value);

describe("gateway value conventions", () => {
  describe("money", () => {
    it("[VAL-2b] XML-RPC doubles in units round-trip to integer cents without floating point", () => {
      expect(roundTrip(CentsFromUnits, "1234.50")).toBe(123450);
      expect(roundTrip(CentsFromUnits, "0.29")).toBe(29);
      expect(roundTrip(CentsFromUnits, "-12.05")).toBe(-1205);
      expect(roundTrip(CentsFromUnits, "0.00")).toBe(0);
      // 0.29 * 100 is 28.999999999999996 in binary floating point; the text path never multiplies.
      expect(roundTrip(CentsFromUnits, "90071992547409.91")).toBe(
        9007199254740991,
      );
    });

    it("[VAL-2b] units refuse unformatted and looser spellings", () => {
      for (const text of [
        "1234.5",
        "1234",
        "1,234.50",
        " 1234.50",
        "+1.00",
        "01.00",
        "1e3",
        "-0.00",
        "",
      ])
        refuses(CentsFromUnits, text, /two decimals|negative zero/);
      refuses(CentsFromUnits, "90071992547409.92", /out of range/);
    });

    it("[VAL-2b] the decimal comma round-trips and refuses a dot or thousands separators", () => {
      expect(roundTrip(CentsFromDecimalComma, "1234,50")).toBe(123450);
      expect(roundTrip(CentsFromDecimalComma, "-0,99")).toBe(-99);
      for (const text of ["1234.50", "1.234,50", "1234,5", "1234"])
        refuses(CentsFromDecimalComma, text, /two decimals/);
    });

    it("[VAL-2b] implied decimals round-trip zero padded and refuse signs, spaces and overflow", () => {
      const eleven = CentsFromImpliedDecimals(11);
      expect(roundTrip(eleven, "00000123450")).toBe(123450);
      expect(roundTrip(eleven, "00000000000")).toBe(0);
      for (const text of [
        "123450",
        "-0000012345",
        "0000012345 ",
        "000001234.5",
        "000000123450",
      ])
        refuses(eleven, text, /11 digits/);
      const encode = Schema.encodeSync(eleven);
      expect(() => encode(Cents.make(-1))).toThrow(/unsigned/);
      expect(() => encode(Cents.make(100_000_000_000))).toThrow(
        /overflows 11 digits/,
      );
    });

    it("[VAL-2b] unpadded implied decimals in pipe replies refuse padding and units", () => {
      expect(roundTrip(CentsFromImpliedInteger, "123450")).toBe(123450);
      expect(roundTrip(CentsFromImpliedInteger, "-75")).toBe(-75);
      expect(roundTrip(CentsFromImpliedInteger, "0")).toBe(0);
      for (const text of ["0123450", "1234.50", "-0", "+5", ""])
        refuses(CentsFromImpliedInteger, text, /without padding/);
    });

    it("[VAL-2b] the same amount in every spelling is the same branded value", () => {
      const spellings = [
        Schema.decodeUnknownSync(CentsFromUnits)("1234.50"),
        Schema.decodeUnknownSync(CentsFromDecimalComma)("1234,50"),
        Schema.decodeUnknownSync(CentsFromImpliedDecimals(11))("00000123450"),
        Schema.decodeUnknownSync(CentsFromImpliedInteger)("123450"),
      ];
      expect(new Set(spellings)).toEqual(new Set([123450]));
      expect(Schema.encodeSync(CentsFromDecimalComma)(spellings[0]!)).toBe(
        "1234,50",
      );
    });
  });

  describe("dates", () => {
    it("[VAL-1c] XML-RPC's separator-free date-time round-trips as UTC", () => {
      const value = roundTrip(DateTimeFromXmlRpc, "19991231T23:59:59");
      expect(millis(value)).toBe(millis(utc("1999-12-31T23:59:59Z")));
      expect(millis(roundTrip(DateTimeFromXmlRpc, "20240229T00:00:00"))).toBe(
        millis(utc("2024-02-29T00:00:00Z")),
      );
    });

    it("[VAL-1c] the date-time refuses separators, zones, compact times and impossible dates", () => {
      for (const text of [
        "1999-12-31T23:59:59",
        "19991231T23:59:59Z",
        "19991231T235959",
        "19991231 23:59:59",
        "19991231",
      ])
        refuses(DateTimeFromXmlRpc, text, /YYYYMMDDTHH:MM:SS/);
      refuses(DateTimeFromXmlRpc, "19980231T00:00:00", /not a calendar date/);
      refuses(DateTimeFromXmlRpc, "20230229T00:00:00", /not a calendar date/);
      refuses(DateTimeFromXmlRpc, "19991231T24:00:00", /not a time of day/);
      expect(() =>
        Schema.encodeSync(DateTimeFromXmlRpc)(utc("2026-10-31T12:00:00.250Z")),
      ).toThrow(/milliseconds/);
    });

    it("[VAL-1c] a bare YYYYMMDD round-trips as midnight UTC and refuses a time of day on encode", () => {
      expect(millis(roundTrip(DateFromBare, "20261031"))).toBe(
        millis(utc("2026-10-31T00:00:00Z")),
      );
      for (const text of ["2026-10-31", "261031", "20261031 ", "31102026"])
        refuses(DateFromBare, text, /YYYYMMDD|calendar date/);
      refuses(DateFromBare, "20261131", /not a calendar date/);
      expect(() =>
        Schema.encodeSync(DateFromBare)(utc("2026-10-31T01:00:00Z")),
      ).toThrow(/time of day/);
    });

    it("[VAL-1c] the zero date means none in both forms, and only the exact zero spelling", () => {
      expect(roundTrip(OptionalDateFromBare, "00000000")).toEqual(
        Option.none(),
      );
      expect(
        roundTrip(OptionalDateTimeFromXmlRpc, "00000000T00:00:00"),
      ).toEqual(Option.none());
      const present = roundTrip(OptionalDateFromBare, "20261115");
      expect(Option.map(present, millis)).toEqual(
        Option.some(millis(utc("2026-11-15T00:00:00Z"))),
      );
      for (const text of ["0", "", "        ", "00000000T00:00:00"])
        expect(() =>
          Schema.decodeUnknownSync(OptionalDateFromBare)(text),
        ).toThrow();
      for (const text of [
        "00000000",
        "00000000T00:00:00Z",
        "0000-00-00T00:00:00",
      ])
        expect(() =>
          Schema.decodeUnknownSync(OptionalDateTimeFromXmlRpc)(text),
        ).toThrow();
    });
  });

  describe("booleans", () => {
    it("[VAL-3b] XML-RPC booleans 1 and 0 round-trip", () => {
      expect(roundTrip(BooleanFromBit, "1")).toBe(true);
      expect(roundTrip(BooleanFromBit, "0")).toBe(false);
    });

    it("[VAL-3b] other spellings of truth are refused", () => {
      for (const text of [
        "true",
        "false",
        "TRUE",
        "yes",
        "Y",
        "01",
        " 1",
        "2",
        "",
      ])
        expect(() => Schema.decodeUnknownSync(BooleanFromBit)(text)).toThrow();
    });
  });
});
