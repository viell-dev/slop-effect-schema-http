import { describe, expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import {
  blankAsNull,
  IntegerString,
  Issuer,
  LdapTime,
  TokenType,
  YesNo,
} from "./identity.js";

const decodes = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  input: unknown,
) => Schema.decodeUnknownExit(schema)(input);

const refusedWith = (exit: Exit.Exit<unknown, Schema.SchemaError>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit) ? String(exit.cause) : "";
};

describe("identity value conventions", () => {
  describe("LdapTime", () => {
    // Semantic equality: the same instant (Date#getTime) on decode, the identical string on encode.
    it("[VAL-1a] round-trips the directory's canonical form", () => {
      for (const [text, iso] of [
        ["20040315093000Z", "2004-03-15T09:30:00.000Z"],
        ["20080229235959Z", "2008-02-29T23:59:59.000Z"],
        ["00010101000000Z", "0001-01-01T00:00:00.000Z"],
        ["99991231235959Z", "9999-12-31T23:59:59.000Z"],
      ] as const) {
        const date = Schema.decodeUnknownSync(LdapTime)(text);
        expect(date.toISOString()).toBe(new Date(iso).toISOString());
        expect(Schema.encodeSync(LdapTime)(date)).toBe(text);
      }
      const instant = new Date("2026-10-29T12:34:56Z");
      expect(
        Schema.decodeUnknownSync(LdapTime)(
          Schema.encodeSync(LdapTime)(instant),
        ).getTime(),
      ).toBe(instant.getTime());
    });

    it("[VAL-1a] refuses looser spellings that a permissive parser would accept", () => {
      for (const text of [
        "20040315093000z", // lower-case zone
        "20040315093000", // no zone: local time of an unknown offset
        "20040315093000+0100", // numeric offset
        "20040315093000.0Z", // Active Directory's fraction
        "200403150930Z", // minutes only
        "2004031509Z", // hours only
        "2004-03-15T09:30:00Z", // ISO 8601
        " 20040315093000Z", // padding
        "20040315093000Z\n",
        "",
      ])
        expect(refusedWith(decodes(LdapTime, text))).toMatch(/YYYYMMDDHHMMSSZ/);
    });

    it("[VAL-1a] refuses calendar-impossible values instead of rolling them over", () => {
      for (const text of [
        "20040230000000Z", // February 30th
        "20050229000000Z", // not a leap year
        "20041301000000Z", // month 13
        "20040015000000Z", // month 0
        "20040315240000Z", // hour 24
        "20040315096000Z", // minute 60
        "20161231235960Z", // leap second
      ])
        expect(refusedWith(decodes(LdapTime, text))).toMatch(
          /Not a calendar date/,
        );
    });

    it("[VAL-1a] refuses to encode what the form cannot carry", () => {
      expect(
        refusedWith(
          Schema.encodeExit(LdapTime)(new Date("2004-03-15T09:30:00.250Z")),
        ),
      ).toMatch(/refusing to drop milliseconds/);
      expect(
        refusedWith(
          Schema.encodeExit(LdapTime)(new Date("+010000-01-01T00:00:00Z")),
        ),
      ).toMatch(/four-digit year/);
      expect(Exit.isFailure(Schema.encodeExit(LdapTime)(new Date(NaN)))).toBe(
        true,
      );
    });
  });

  describe("TokenType", () => {
    it("[AUTH-3] normalizes the three known spellings and encodes the RFC 6750 one", () => {
      for (const spelling of ["bearer", "Bearer", "BEARER"])
        expect(Schema.decodeUnknownSync(TokenType)(spelling)).toBe("Bearer");
      // The domain value round-trips; the wire spelling is canonicalized, which is the stated loss.
      expect(Schema.encodeSync(TokenType)("Bearer")).toBe("Bearer");
      expect(
        Schema.encodeSync(TokenType)(
          Schema.decodeUnknownSync(TokenType)("BEARER"),
        ),
      ).toBe("Bearer");
    });

    it("[AUTH-3] refuses unknown schemes and unknown casings rather than guessing", () => {
      for (const spelling of [
        "mac",
        "MAC",
        "Basic",
        "DPoP",
        "bEaReR",
        "Bearer ",
        " Bearer",
        "",
      ])
        expect(Exit.isFailure(decodes(TokenType, spelling))).toBe(true);
      expect(Exit.isFailure(decodes(TokenType, null))).toBe(true);
    });
  });

  describe("IntegerString", () => {
    it("[PAY-9] round-trips canonical decimal integers", () => {
      for (const [text, value] of [
        ["0", 0],
        ["3600", 3600],
        ["999999999999999", 999_999_999_999_999],
      ] as const) {
        expect(Schema.decodeUnknownSync(IntegerString)(text)).toBe(value);
        expect(Schema.encodeSync(IntegerString)(value)).toBe(text);
      }
    });

    it("[PAY-9] refuses signs, padding, fractions, exponents and numbers", () => {
      for (const input of [
        "+3600",
        "-1",
        "03600",
        " 3600",
        "3600 ",
        "3600.0",
        "3.6e3",
        "0x10",
        "",
        "1000000000000000",
        3600,
      ])
        expect(Exit.isFailure(decodes(IntegerString, input))).toBe(true);
      expect(Exit.isFailure(Schema.encodeExit(IntegerString)(1.5))).toBe(true);
      expect(Exit.isFailure(Schema.encodeExit(IntegerString)(-1))).toBe(true);
    });
  });

  describe("Issuer", () => {
    it("[VAL-5a] keeps the trailing slash exactly, in both directions", () => {
      for (const text of [
        "http://127.0.0.1:8080/",
        "https://id.example.test/",
        "https://id.example.test",
        "https://id.example.test/tenant/",
      ]) {
        const issuer = Schema.decodeUnknownSync(Issuer)(text);
        expect(issuer).toBe(text);
        expect(Schema.encodeSync(Issuer)(issuer)).toBe(text);
      }
      // Exact comparison: the two spellings are different issuers.
      expect(
        Schema.decodeUnknownSync(Issuer)("https://id.example.test/"),
      ).not.toBe(Schema.decodeUnknownSync(Issuer)("https://id.example.test"));
    });

    it("[VAL-5a] refuses relative, query-bearing and fragment-bearing issuers", () => {
      for (const text of [
        "id.example.test/",
        "/",
        "ftp://id.example.test/",
        "https://id.example.test/?tenant=a",
        "https://id.example.test/#top",
        "https://id.example.test/ ",
        "",
      ])
        expect(Exit.isFailure(decodes(Issuer, text))).toBe(true);
    });
  });

  describe("YesNo", () => {
    it("[ERR-4] round-trips Y and N", () => {
      expect(Schema.decodeUnknownSync(YesNo)("Y")).toBe(true);
      expect(Schema.decodeUnknownSync(YesNo)("N")).toBe(false);
      expect(Schema.encodeSync(YesNo)(true)).toBe("Y");
      expect(Schema.encodeSync(YesNo)(false)).toBe("N");
    });

    it("[ERR-4] refuses other spellings of a flag", () => {
      for (const input of ["y", "n", "1", "0", "true", "false", "", true])
        expect(Exit.isFailure(decodes(YesNo, input))).toBe(true);
    });
  });

  describe("blankAsNull", () => {
    const Name = blankAsNull(Schema.NonEmptyString);
    const Time = blankAsNull(LdapTime);

    it("[ERR-4] maps blank to null and back, keeping present values", () => {
      expect(Schema.decodeUnknownSync(Name)("")).toBeNull();
      expect(Schema.decodeUnknownSync(Name)("Ada")).toBe("Ada");
      expect(Schema.encodeSync(Name)(null)).toBe("");
      expect(Schema.encodeSync(Name)("Ada")).toBe("Ada");
      expect(Schema.decodeUnknownSync(Time)("")).toBeNull();
      expect(Schema.encodeSync(Time)(null)).toBe("");
      expect(
        Schema.encodeSync(Time)(
          Schema.decodeUnknownSync(Time)("20040315093000Z"),
        ),
      ).toBe("20040315093000Z");
    });

    it("[ERR-4] does not treat null, whitespace or a missing value as blank", () => {
      expect(Exit.isFailure(decodes(Name, null))).toBe(true);
      expect(Exit.isFailure(decodes(Name, undefined))).toBe(true);
      expect(Exit.isFailure(decodes(Time, " "))).toBe(true);
      // The domain never holds an empty string, so null is the only blank.
      expect(Exit.isFailure(Schema.encodeExit(Name)(""))).toBe(true);
    });
  });
});
