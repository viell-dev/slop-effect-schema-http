import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import * as XmlRpc from "./xmlrpc.js";

const wrap = (inner: string) =>
  `<methodResponse><params><param>${inner}</param></params></methodResponse>`;

describe("xml-rpc helper", () => {
  it("[PAY-3b] parses every type into a lossless tree, ignoring whitespace between elements", () => {
    const text = `<?xml version="1.0"?>
<methodResponse>
  <params>
    <param>
      <value><struct>
        <member><name>id</name><value><i4>7</i4></value></member>
        <member><name>ratio</name><value><double>0.50</double></value></member>
        <member><name>ok</name><value><boolean>1</boolean></value></member>
        <member><name>at</name><value><dateTime.iso8601>19980717T14:08:55</dateTime.iso8601></value></member>
        <member><name>blob</name><value><base64>QUJD
</base64></value></member>
        <member><name>typed</name><value><string> padded </string></value></member>
        <member><name>bare</name><value>  bare &amp; untyped  </value></member>
        <member><name>list</name><value><array><data>
          <value><int>1</int></value>
          <value></value>
        </data></array></value></member>
      </struct></value>
    </param>
  </params>
</methodResponse>`;
    const tree = XmlRpc.parseResponse(text);
    expect(tree).toEqual({
      params: [
        {
          struct: {
            id: { i4: "7" },
            ratio: { double: "0.50" },
            ok: { boolean: "1" },
            at: { "dateTime.iso8601": "19980717T14:08:55" },
            blob: { base64: "QUJD\n" },
            typed: { string: " padded " },
            bare: "  bare & untyped  ",
            list: { array: [{ int: "1" }, ""] },
          },
        },
      ],
    });
    expect(XmlRpc.parseResponse(XmlRpc.serializeResponse(tree))).toEqual(tree);
  });

  it("[PAY-3b] round-trips calls and faults", () => {
    const call: XmlRpc.MethodCall = {
      methodName: "invoice.get",
      params: [{ i4: "1001" }, "x < y", { array: [] }],
    };
    expect(XmlRpc.parseCall(XmlRpc.serializeCall(call))).toEqual(call);
    const fault: XmlRpc.MethodResponse = {
      fault: {
        struct: { faultCode: { i4: "-32601" }, faultString: { string: "no" } },
      },
    };
    expect(XmlRpc.parseResponse(XmlRpc.serializeResponse(fault))).toEqual(
      fault,
    );
  });

  it("[PAY-3b] refuses malformed responses instead of guessing", () => {
    expect(() => XmlRpc.parseResponse("<methodResponse/>")).toThrow(
      /exactly one/,
    );
    expect(() => XmlRpc.parseResponse(wrap("<value><nil/></value>"))).toThrow(
      /unsupported type <nil>/,
    );
    expect(() =>
      XmlRpc.parseResponse(wrap("<value>x<i4>1</i4></value>")),
    ).toThrow(/unexpected text/);
    expect(() =>
      XmlRpc.parseResponse(wrap("<value><i4>1</i4><i4>2</i4></value>")),
    ).toThrow(/exactly one/);
    expect(() =>
      XmlRpc.parseResponse(
        wrap(
          "<value><struct><member><name>a</name><value>1</value></member>" +
            "<member><name>a</name><value>2</value></member></struct></value>",
        ),
      ),
    ).toThrow(/duplicate member "a"/);
    expect(() => XmlRpc.parseResponse("<methodCall/>")).toThrow(
      /expected <methodResponse>/,
    );
  });

  it("[PAY-3b] scalar schemas read the type element and refuse other types or spellings", () => {
    expect(Schema.decodeUnknownSync(XmlRpc.I4)({ i4: "-42" })).toBe(-42);
    expect(Schema.encodeSync(XmlRpc.I4)(-42)).toEqual({ i4: "-42" });
    for (const text of ["+1", "01", "-0", "2147483648", "1.0", " 1"])
      for (const type of ["i4", "int"])
        expect(() =>
          Schema.decodeUnknownSync(XmlRpc.I4)({ [type]: text }),
        ).toThrow(/canonical i4/);
    expect(() =>
      Schema.decodeUnknownSync(XmlRpc.I4)({ string: "1" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(XmlRpc.I4)("1")).toThrow();
    expect(() => Schema.decodeUnknownSync(XmlRpc.Text)("bare")).toThrow();
    expect(Schema.decodeUnknownSync(XmlRpc.Untyped)("bare")).toBe("bare");
  });

  it("[PAY-3b] <int> reads as <i4>, its synonym, and encodes as <i4>: the spelling is not kept", () => {
    expect(Schema.decodeUnknownSync(XmlRpc.I4)({ int: "-42" })).toBe(-42);
    expect(
      Schema.encodeSync(XmlRpc.I4)(
        Schema.decodeUnknownSync(XmlRpc.I4)({ int: "2147483647" }),
      ),
    ).toEqual({ i4: "2147483647" });
    expect(() =>
      Schema.decodeUnknownSync(XmlRpc.I4)({ int: "2147483648" }),
    ).toThrow(/canonical i4/);
  });

  it("[PAY-3b] a string value reads untyped or typed, and encodes untyped: the spelling is not kept", () => {
    expect(Schema.decodeUnknownSync(XmlRpc.StringValue)("bare")).toBe("bare");
    expect(
      Schema.decodeUnknownSync(XmlRpc.StringValue)({ string: "Café" }),
    ).toBe("Café");
    expect(Schema.encodeSync(XmlRpc.StringValue)("Café")).toBe("Café");
    for (const other of [{ i4: "1" }, { base64: "QUJD" }, { array: [] }])
      expect(() =>
        Schema.decodeUnknownSync(XmlRpc.StringValue)(other),
      ).toThrow();
  });

  it("[PAY-8] base64 decodes MIME::Base64's 76-column lines, one line, or any line feeds, refuses other characters, and encodes MIME::Base64's layout", () => {
    const bytes = Uint8Array.from(
      { length: 70 },
      (_, index) => (index * 37) % 256,
    );
    const encoded = Schema.encodeSync(XmlRpc.Base64)(bytes);
    const lines = encoded.base64.split("\n");
    expect(lines.map((line) => line.length)).toEqual([76, 20, 0]);
    expect(Schema.decodeUnknownSync(XmlRpc.Base64)(encoded)).toEqual(bytes);
    const flat = encoded.base64.replaceAll("\n", "");
    // One line, as XMLRPC::Lite writes it, and line feeds anywhere: the layout is not kept.
    for (const layout of [
      flat,
      `${flat}\n`,
      `\n${flat.slice(0, 5)}\n\n${flat.slice(5)}`,
    ]) {
      expect(
        Schema.decodeUnknownSync(XmlRpc.Base64)({ base64: layout }),
      ).toEqual(bytes);
      expect(
        Schema.encodeSync(XmlRpc.Base64)(
          Schema.decodeUnknownSync(XmlRpc.Base64)({ base64: layout }),
        ),
      ).toEqual(encoded);
    }
    for (const text of [
      "QUJ\n",
      "QUJD REVG",
      "QUJD\tREVG",
      "QUJD\r\nREVG",
      "QQ==QUJD",
      "QUJD*",
      "QUJD=",
    ])
      expect(() =>
        Schema.decodeUnknownSync(XmlRpc.Base64)({ base64: text }),
      ).toThrow(/not base64/);
    expect(Schema.decodeUnknownSync(XmlRpc.Base64)({ base64: "" })).toEqual(
      new Uint8Array(),
    );
  });

  it("[ERR-1b] an outcome is a result or a fault, both members of one union", () => {
    const schema = XmlRpc.outcome(
      XmlRpc.struct({ id: XmlRpc.I4, tags: XmlRpc.array(XmlRpc.Text) }),
    );
    expect(
      Schema.decodeUnknownSync(schema)({
        params: [
          {
            struct: {
              id: { i4: "1" },
              tags: { array: [{ string: "a" }] },
              extra: "x",
            },
          },
        ],
      }),
    ).toEqual({ _tag: "Result", value: { id: 1, tags: ["a"] } });
    expect(
      Schema.decodeUnknownSync(schema)({
        fault: {
          struct: {
            faultCode: { i4: "4" },
            faultString: { string: "Too many parameters" },
          },
        },
      }),
    ).toEqual({ _tag: "Fault", code: 4, message: "Too many parameters" });
    expect(
      Schema.encodeSync(schema)({ _tag: "Result", value: { id: 1, tags: [] } }),
    ).toEqual({
      params: [{ struct: { id: { i4: "1" }, tags: { array: [] } } }],
    });
    expect(() =>
      Schema.decodeUnknownSync(schema)({ params: [{ i4: "1" }] }),
    ).toThrow();
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(XmlRpc.ResponseText)("<methodResponse/>"),
      ),
    ).toBe(false);
  });
});
