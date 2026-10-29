import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as FixedWidth from "./fixed-width.js";

const bytes = (...values: ReadonlyArray<number>) => new Uint8Array(values);

describe("fixed-width helper", () => {
  it("[PAY-4c] decodes strict ISO-8859-1 byte for byte and refuses control bytes", () => {
    const decode = Schema.decodeUnknownSync(FixedWidth.Latin1);
    const encode = Schema.encodeSync(FixedWidth.Latin1);
    const cafe = bytes(0x43, 0x61, 0x66, 0xe9, 0x20, 0xdf);
    expect(decode(cafe)).toBe("Café ß");
    expect(encode("Café ß")).toEqual(cafe);
    // windows-1252 would read 0x80 as "€"; ISO-8859-1 has a control character there.
    expect(new TextDecoder("latin1").decode(bytes(0x80))).toBe("€");
    expect(() => decode(bytes(0x41, 0x80))).toThrow(/0x80 at offset 1/);
    expect(() => decode(bytes(0x41, 0x0a))).toThrow(/0x0a at offset 1/);
    expect(() => encode("€")).toThrow(/not printable ISO-8859-1/);
    expect(() => encode("ā")).toThrow(/not printable ISO-8859-1/);
  });

  it("[PAY-4c] splits records without separators and refuses a partial record", () => {
    const schema = FixedWidth.records(4);
    expect(Schema.decodeUnknownSync(schema)("abcdefgh")).toEqual([
      "abcd",
      "efgh",
    ]);
    expect(Schema.encodeSync(schema)(["abcd", "efgh"])).toBe("abcdefgh");
    expect(() => Schema.decodeUnknownSync(schema)("abcdefg")).toThrow(
      /not a whole number of 4-byte/,
    );
    expect(() => Schema.encodeSync(schema)(["abc"])).toThrow(
      /record 0 has 3 bytes/,
    );
  });

  it("[PAY-4c] slices fields, checks filler, and requires exact widths on encode", () => {
    const schema = FixedWidth.fields([
      ["kind", 1],
      ["name", 4],
      [null, 2],
    ]);
    expect(Schema.decodeUnknownSync(schema)("DAb    ")).toEqual({
      kind: "D",
      name: "Ab  ",
    });
    expect(Schema.encodeSync(schema)({ kind: "D", name: "Ab  " })).toBe(
      "DAb    ",
    );
    expect(() => Schema.decodeUnknownSync(schema)("DAb   x")).toThrow(
      /filler at offset 5/,
    );
    expect(() => Schema.decodeUnknownSync(schema)("DAb")).toThrow(
      /3 bytes, not 7/,
    );
    expect(() => Schema.encodeSync(schema)({ kind: "D", name: "Ab" })).toThrow(
      /exactly 4/,
    );
  });

  it("[PAY-4c] padded text drops trailing spaces and refuses text that cannot survive", () => {
    const schema = FixedWidth.text(6);
    expect(Schema.decodeUnknownSync(schema)(" Peña ")).toBe(" Peña");
    expect(Schema.encodeSync(schema)(" Peña")).toBe(" Peña ");
    expect(() => Schema.encodeSync(schema)("Peña ")).toThrow(/ends in a space/);
    expect(() => Schema.encodeSync(schema)("Señor Peña")).toThrow(
      /wider than 6/,
    );
  });

  it("[PAY-4c] zero-padded counts round-trip and refuse spaces, signs and overflow", () => {
    const schema = FixedWidth.count(6);
    expect(Schema.decodeUnknownSync(schema)("000003")).toBe(3);
    expect(Schema.encodeSync(schema)(3)).toBe("000003");
    for (const text of ["     3", "-00003", "00003", "0000003"])
      expect(() => Schema.decodeUnknownSync(schema)(text)).toThrow(/6 digits/);
    expect(() => Schema.encodeSync(schema)(1_000_000)).toThrow(/does not fit/);
  });
});
