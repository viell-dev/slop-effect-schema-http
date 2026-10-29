import { describe, expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import {
  AspNetDate,
  Cents,
  CustomerRef,
  DollarString,
  EpochMillis,
  HttpDate,
  Limit,
  optionalText,
  SpaceDelimited,
  UsLocalDateTime,
  YesNo,
} from "./business.js";

/** Decode a canonical wire value, encode the result, and expect the same wire value back. */
const wireRoundTrip = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  wire: S["Encoded"],
) => {
  const decoded = Schema.decodeUnknownSync(schema)(wire);
  expect(Schema.encodeUnknownSync(schema)(decoded)).toEqual(wire);
  return decoded;
};

const refuses = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  inputs: ReadonlyArray<unknown>,
  reason?: RegExp,
) => {
  for (const input of inputs)
    expect(
      () => Schema.decodeUnknownSync(schema)(input),
      `decoding ${JSON.stringify(input)}`,
    ).toThrow(reason);
};

const refusesToEncode = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  value: unknown,
  reason: RegExp,
) => expect(() => Schema.encodeUnknownSync(schema)(value)).toThrow(reason);

describe("business operations values", () => {
  describe("[VAL-1b] dates", () => {
    it("[VAL-1b] round-trips epoch milliseconds and refuses strings and fractions", () => {
      const value = wireRoundTrip(EpochMillis, 1_700_000_000_123);
      expect(DateTime.formatIso(value)).toBe("2023-11-14T22:13:20.123Z");
      wireRoundTrip(EpochMillis, -86_400_000);
      expect(
        Schema.encodeSync(EpochMillis)(
          DateTime.makeUnsafe(Date.UTC(2024, 1, 29)),
        ),
      ).toBe(Date.UTC(2024, 1, 29));
      refuses(EpochMillis, [
        "1700000000000",
        1_700_000_000_000.5,
        Number.NaN,
        8_640_000_000_000_001,
        null,
      ]);
    });

    it("[VAL-1b] keeps the decorative ASP.NET offset without shifting the instant", () => {
      const plain = wireRoundTrip(AspNetDate, "/Date(1700000000000)/");
      expect(DateTime.isUtc(plain)).toBe(true);
      const zoned = wireRoundTrip(AspNetDate, "/Date(1700000000000-0500)/");
      expect(DateTime.toEpochMillis(zoned)).toBe(1_700_000_000_000);
      expect(DateTime.isZoned(zoned)).toBe(true);
      if (DateTime.isZoned(zoned))
        expect(DateTime.zonedOffsetIso(zoned)).toBe("-05:00");
      wireRoundTrip(AspNetDate, "/Date(1700000000000+0530)/");
      wireRoundTrip(AspNetDate, "/Date(-62135596800000+0000)/");
      // JSON escapes the slashes as `\/`, which parsing removes before the schema sees the value.
      expect(
        Schema.decodeUnknownSync(AspNetDate)(
          JSON.parse(String.raw`"\/Date(1700000000000+0100)\/"`),
        ),
      ).toSatisfy(
        (value: DateTime.DateTime) =>
          DateTime.toEpochMillis(value) === 1_700_000_000_000,
      );
      refuses(AspNetDate, [
        "/Date(1700000000000+05:30)/",
        "/Date(1700000000000+530)/",
        "/date(1700000000000)/",
        "Date(1700000000000)",
        "/Date( 1700000000000)/",
        "/Date(01700000000000)/",
        "/Date(1700000000000.5)/",
        "/Date(1700000000000+1500)/",
        "/Date(1700000000000+0560)/",
        "/Date(1700000000000-0000)/",
        "2023-11-14T22:13:20Z",
        1_700_000_000_000,
      ]);
      refusesToEncode(
        AspNetDate,
        DateTime.makeZonedUnsafe(0, { timeZone: "Europe/Berlin" }),
        /named time zone/,
      );
    });

    it("[VAL-1b] reads US local time as a wall clock, never as an instant", () => {
      const wire = "11/14/2023 5:13:20 PM";
      expect(wireRoundTrip(UsLocalDateTime, wire)).toEqual({
        year: 2023,
        month: 11,
        day: 14,
        hour: 17,
        minute: 13,
        second: 20,
      });
      expect(
        wireRoundTrip(UsLocalDateTime, "1/5/2024 12:00:00 AM"),
      ).toMatchObject({
        hour: 0,
      });
      expect(
        wireRoundTrip(UsLocalDateTime, "2/29/2024 12:30:05 PM"),
      ).toMatchObject({
        hour: 12,
      });
      // The permissive control: the platform parser reads the same text in the reader's own zone,
      // so the instant it yields moves with the reader's offset.
      const readerOffset = new Date(
        2023,
        10,
        14,
        17,
        13,
        20,
      ).getTimezoneOffset();
      expect(Date.parse(wire)).toBe(
        Date.UTC(2023, 10, 14, 17, 13, 20) + readerOffset * 60_000,
      );
      refuses(UsLocalDateTime, [
        "11/14/2023 17:13:20",
        "11/14/2023 5:13 PM",
        "11/14/2023 05:13:20 PM",
        "01/05/2024 12:00:00 AM",
        "11/14/2023 5:13:20 pm",
        "11/14/2023 5:13:20 PM +01:00",
        "2023-11-14T17:13:20",
        "2/30/2024 1:00:00 AM",
        "2/29/2023 1:00:00 AM",
        "13/1/2024 1:00:00 AM",
        "14/11/2023 5:13:20 PM",
      ]);
      refusesToEncode(
        UsLocalDateTime,
        { year: 2023, month: 2, day: 29, hour: 0, minute: 0, second: 0 },
        /no such date/,
      );
      refusesToEncode(
        UsLocalDateTime,
        { year: 2023, month: 1, day: 1, hour: 24, minute: 0, second: 0 },
        /23/,
      );
    });

    it("[VAL-1b] round-trips IMF-fixdate HTTP-dates and refuses the obsolete forms", () => {
      const value = wireRoundTrip(HttpDate, "Sun, 06 Nov 1994 08:49:37 GMT");
      expect(DateTime.toEpochMillis(value)).toBe(
        Date.UTC(1994, 10, 6, 8, 49, 37),
      );
      wireRoundTrip(HttpDate, "Thu, 29 Feb 2024 23:59:59 GMT");
      refuses(HttpDate, [
        "Sunday, 06-Nov-94 08:49:37 GMT",
        "Sun Nov  6 08:49:37 1994",
        "Mon, 06 Nov 1994 08:49:37 GMT",
        "Sun, 6 Nov 1994 08:49:37 GMT",
        "Sun, 06 Nov 1994 08:49:37 +0000",
        "sun, 06 nov 1994 08:49:37 GMT",
        "Thu, 30 Feb 2024 00:00:00 GMT",
        "Sun, 06 Nov 1994 24:00:00 GMT",
      ]);
      refusesToEncode(
        HttpDate,
        DateTime.makeUnsafe(Date.UTC(1994, 10, 6, 8, 49, 37) + 1),
        /one-second resolution/,
      );
    });
  });

  describe("[VAL-2a] money", () => {
    it("[VAL-2a] round-trips formatted dollars as branded integer cents", () => {
      expect(wireRoundTrip(DollarString, "$1,234.56")).toBe(123_456);
      expect(wireRoundTrip(DollarString, "$0.05")).toBe(5);
      expect(wireRoundTrip(DollarString, "-$12.50")).toBe(-1_250);
      expect(wireRoundTrip(DollarString, "$1,000,000.00")).toBe(100_000_000);
      expect(wireRoundTrip(DollarString, "$999.99")).toBe(99_999);
      expect(Schema.encodeSync(DollarString)(Cents.make(1_234_567))).toBe(
        "$12,345.67",
      );
      refuses(DollarString, [
        "1234.56",
        "$1234.56",
        "$1,234.5",
        "$1,234",
        "$ 1,234.56",
        "USD 1,234.56",
        "$01.00",
        "($12.50)",
        "-$0.00",
        "$1,23.45",
        "1,234.56",
        123_456,
      ]);
      refusesToEncode(DollarString, 12.5, /int/i);
    });
  });

  describe("[VAL-3a] booleans", () => {
    it("[VAL-3a] accepts only Y and N", () => {
      expect(wireRoundTrip(YesNo, "Y")).toBe(true);
      expect(wireRoundTrip(YesNo, "N")).toBe(false);
      refuses(YesNo, ["y", "n", "1", "0", "true", "Yes", " Y", true, 1]);
    });
  });

  describe("[VAL-4] absence", () => {
    const Row = Schema.Struct({ po: optionalText, seats: Limit });

    it("[VAL-4] collapses five spellings of absence into one missing key", () => {
      for (const wire of [
        { seats: 3, po: null },
        { seats: 3, po: "" },
        { seats: 3, po: "null" },
        { seats: 3 },
        { seats: 3, po: "   " },
      ])
        expect(
          Schema.decodeUnknownSync(Row)(wire),
          JSON.stringify(wire),
        ).toEqual({
          seats: 3,
        });
      // The loss is deliberate: every absence encodes as the missing key.
      expect(Schema.encodeSync(Row)({ seats: 3 })).toEqual({ seats: 3 });
      expect(wireRoundTrip(Row, { seats: 3, po: "PO-7" })).toEqual({
        seats: 3,
        po: "PO-7",
      });
      expect(wireRoundTrip(Row, { seats: 3, po: " PO-7 " })).toEqual({
        seats: 3,
        po: " PO-7 ",
      });
      refusesToEncode(Row, { seats: 3, po: "null" }, /reads it as absent/);
      refusesToEncode(Row, { seats: 3, po: " " }, /reads it as absent/);
      refuses(Row, [{ seats: 3, po: 7 }]);
    });

    it("[VAL-4] keeps unlimited distinct from a limit of zero", () => {
      expect(wireRoundTrip(Limit, -1)).toBe("unlimited");
      expect(wireRoundTrip(Limit, 0)).toBe(0);
      expect(wireRoundTrip(Limit, 25)).toBe(25);
      refuses(Limit, [-2, 1.5, "-1", null, "unlimited"]);
      refusesToEncode(Limit, -1, /unlimited|0/);
    });
  });

  describe("[VAL-5b] references and lists", () => {
    it("[VAL-5b] tags an expanded customer and a bare id, and restores each shape", () => {
      expect(
        wireRoundTrip(CustomerRef, { id: 7, name: "Acme", country: "US" }),
      ).toEqual({ _tag: "Expanded", id: 7, name: "Acme", country: "US" });
      expect(wireRoundTrip(CustomerRef, 7)).toEqual({
        _tag: "Reference",
        id: 7,
      });
      refuses(CustomerRef, [
        "7",
        0,
        -3,
        { id: 7 },
        { id: "7", name: "Acme", country: "US" },
      ]);
    });

    it("[VAL-5b] reads space-delimited lists as arrays", () => {
      expect(wireRoundTrip(SpaceDelimited, "urgent overdue")).toEqual([
        "urgent",
        "overdue",
      ]);
      expect(wireRoundTrip(SpaceDelimited, "")).toEqual([]);
      expect(wireRoundTrip(SpaceDelimited, "solo")).toEqual(["solo"]);
      refuses(SpaceDelimited, [
        "urgent  overdue",
        " urgent",
        "urgent ",
        "urgent\toverdue",
        ["urgent", "overdue"],
      ]);
      refusesToEncode(SpaceDelimited, ["two words"], /whitespace/);
      refusesToEncode(SpaceDelimited, [""], /empty/);
    });
  });
});
