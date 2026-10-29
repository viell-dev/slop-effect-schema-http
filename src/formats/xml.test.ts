import { describe, expect, it } from "@effect/vitest";
import * as Xml from "./xml.js";

describe("xml helper", () => {
  it("parses elements, attributes, entities, CDATA and prefixed names", () => {
    const root = Xml.parse(
      `<?xml version="1.0"?><!-- c --><s:Envelope xmlns:s="urn:x"><s:Body a="1 &amp; 2">` +
        `x &lt; y<![CDATA[<raw>]]>&#233;</s:Body><Empty/></s:Envelope>`,
    );
    expect(root.name).toBe("s:Envelope");
    const body = Xml.child(root, "Body");
    expect(body.attributes["a"]).toBe("1 & 2");
    expect(Xml.textOf(body)).toBe("x < y<raw>é");
    expect(Xml.elements(root)).toHaveLength(2);
  });

  it("round-trips through serialize and parse", () => {
    const tree = Xml.element(
      "a:Doc",
      { title: `"quoted" & <tagged>` },
      Xml.element("Item", {}, "1 < 2"),
      Xml.element("Empty"),
    );
    expect(Xml.parse(Xml.serialize(tree))).toEqual(tree);
  });

  it("refuses malformed input and DTDs", () => {
    expect(() => Xml.parse("<a><b></a>")).toThrow(/expected <\/b>/);
    expect(() => Xml.parse("<a>&nbsp;</a>")).toThrow(/unknown entity/);
    expect(() => Xml.parse("<!DOCTYPE a><a/>")).toThrow(/DTD/);
    expect(() => Xml.parse("<a/><b/>")).toThrow(/after the root/);
  });

  it("reads the encoding from the XML declaration", () => {
    const bytes = new TextEncoder().encode(
      `<?xml version="1.0" encoding="ISO-8859-1"?><a/>`,
    );
    expect(Xml.declaredEncoding(bytes)).toBe("ISO-8859-1");
    expect(Xml.declaredEncoding(new TextEncoder().encode("<a/>"))).toBe(
      undefined,
    );
  });
});
