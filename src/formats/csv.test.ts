import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Csv from "./csv.js";

const excelDe: Csv.Dialect = { delimiter: ";", newline: "\r\n", bom: true };
const excelUtf8: Csv.Dialect = { delimiter: ",", newline: "\n", bom: true };

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("csv helper", () => {
  it("[PAY-5] round-trips a German sheet byte for byte: BOM, CRLF, semicolons, quoting", () => {
    const text =
      '\uFEFFKonto;Bezeichnung;Betrag\r\n00012345;"Müller; ""Spezial"" GmbH";1234,50\r\n' +
      '00012346;"Zeile\neins";0,99\r\n00012347;;\r\n';
    const bytes = utf8(text);
    const schema = Csv.bytes(excelDe);
    const rows = Schema.decodeUnknownSync(schema)(bytes);
    expect(rows).toEqual([
      ["Konto", "Bezeichnung", "Betrag"],
      ["00012345", 'Müller; "Spezial" GmbH', "1234,50"],
      ["00012346", "Zeile\neins", "0,99"],
      ["00012347", "", ""],
    ]);
    expect(Schema.encodeSync(schema)(rows)).toEqual(bytes);
  });

  it("[PAY-5] refuses what Excel would not write: a missing BOM, bare LF, needless quotes, stray quotes", () => {
    const decode = Schema.decodeUnknownSync(Csv.bytes(excelDe));
    expect(() => decode(utf8("a;b\r\n"))).toThrow(/byte-order mark/);
    expect(() => decode(utf8("\uFEFFa;b\n"))).toThrow(/bare LF/);
    expect(() => decode(utf8('\uFEFF"a";b\r\n'))).toThrow(/needlessly quoted/);
    expect(() => decode(utf8('\uFEFFa"x;b\r\n'))).toThrow(/stray quote/);
    expect(() => decode(utf8('\uFEFF"a;b\r\n'))).toThrow(/unterminated/);
    expect(() => decode(utf8("\uFEFFa;b"))).toThrow(/final line ending/);
    expect(() => decode(utf8("\uFEFFa;b\rc\r\n"))).toThrow(/bare CR/);
    expect(() =>
      decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xe9, 0x0d, 0x0a])),
    ).toThrow(/not valid UTF-8/);
  });

  it("[PAY-4b] a BOM kept by the text decoder poisons the first column name", () => {
    const bytes = utf8("\uFEFFaccount,title\n00012345,Café\n");
    const kept = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const naive = Csv.parse(kept, { ...excelUtf8, bom: false });
    expect(naive[0]![0]).toBe("\uFEFFaccount");
    expect(() =>
      Schema.decodeUnknownSync(Csv.table(["account", "title"]))(naive),
    ).toThrow(/expected the header \["account","title"\]/);
    // The byte codec requires the BOM and strips it explicitly.
    const records = Schema.decodeUnknownSync(
      Csv.bytes(excelUtf8).pipe(
        Schema.decodeTo(Csv.table(["account", "title"])),
      ),
    )(bytes);
    expect(records).toEqual([{ account: "00012345", title: "Café" }]);
    // A dialect without a BOM refuses one rather than reading it into a column name.
    expect(() => Schema.decodeUnknownSync(Csv.bytes(Csv.unix))(bytes)).toThrow(
      /unexpected UTF-8 byte-order mark/,
    );
  });

  it("verifies the header order and row widths, and writes the header back", () => {
    const table = Csv.table(["a", "b"]);
    expect(() => Schema.decodeUnknownSync(table)([["b", "a"]])).toThrow(
      /expected the header/,
    );
    expect(() => Schema.decodeUnknownSync(table)([["a", "b"], ["1"]])).toThrow(
      /row 1 has 1 fields/,
    );
    expect(() => Schema.decodeUnknownSync(table)([])).toThrow(
      /expected the header/,
    );
    expect(Schema.encodeSync(table)([{ a: "1", b: "2" }])).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses and serializes the plain Unix dialect", () => {
    const text = 'a,b\n"1,5",x\n';
    expect(Csv.parse(text, Csv.unix)).toEqual([
      ["a", "b"],
      ["1,5", "x"],
    ]);
    expect(Csv.serialize(Csv.parse(text, Csv.unix), Csv.unix)).toBe(text);
    expect(() => Csv.parse("a\r\n", Csv.unix)).toThrow(/bare CR/);
    expect(Csv.parse("", Csv.unix)).toEqual([]);
  });
});
