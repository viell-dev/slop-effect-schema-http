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

  it("[PAY-4a] refuses characters outside XML's Char production, raw or as references", () => {
    for (const raw of [
      "\u0000",
      "\u0001",
      "\u001f",
      "\u{FFFE}",
      "\u{FFFF}",
      "\ud800",
      "\udc00",
    ]) {
      expect(() => Xml.parse(`<a>A${raw}B</a>`)).toThrow(
        /is not allowed in XML/,
      );
      expect(() => Xml.parse(`<a b="A${raw}B"/>`)).toThrow(
        /is not allowed in XML/,
      );
    }
    for (const reference of [
      "&#0;",
      "&#x0;",
      "&#1;",
      "&#x1F;",
      "&#xFFFE;",
      "&#65535;",
      "&#xD800;",
      "&#xDFFF;",
      "&#x110000;",
      "&#99999999999;",
    ]) {
      expect(() => Xml.parse(`<a>A${reference}B</a>`)).toThrow(
        /does not allow/,
      );
      expect(() => Xml.parse(`<a b="A${reference}B"/>`)).toThrow(
        /does not allow/,
      );
    }
    // The edges of the production stay readable, raw and referenced.
    const edges = "\t\n\u{20}\u{D7FF}\u{E000}\u{FFFD}\u{10000}\u{10ffff}\u0085";
    expect(Xml.textOf(Xml.parse(`<a>${edges}</a>`))).toBe(edges);
    expect(
      Xml.textOf(
        Xml.parse(
          "<a>&#9;&#xA;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;&#133;</a>",
        ),
      ),
    ).toBe(edges);
  });

  it("[PAY-4a] normalizes line ends to LF before parsing, and keeps a referenced carriage return", () => {
    const root = Xml.parse(
      `<?xml version="1.0"?>\r\n<a b="x\r\ny\tz\rw" c="x&#13;&#10;y&#9;z">A\r\nB\rC\nD<![CDATA[E\r\nF]]>G&#13;&#10;H</a>\r\n`,
    );
    expect(Xml.textOf(root)).toBe("A\nB\nC\nDE\nFG\r\nH");
    // Attribute values are normalized as CDATA attributes: literal white space becomes a space.
    expect(root.attributes).toEqual({ b: "x y z w", c: "x\r\ny\tz" });
  });

  it("[PAY-4a] refuses a bare ampersand, '<' in an attribute value and ']]>' in text", () => {
    expect(() => Xml.parse("<a>R & D</a>")).toThrow(/bare '&'/);
    expect(() => Xml.parse("<a>R &D</a>")).toThrow(/bare '&'/);
    expect(() => Xml.parse('<a b="1 < 2"/>')).toThrow(
      /'<' in an attribute value/,
    );
    expect(() => Xml.parse("<a>x ]]> y</a>")).toThrow(
      /']]>' in character data/,
    );
    expect(Xml.textOf(Xml.parse("<a>R &amp; D ]]&gt;</a>"))).toBe("R & D ]]>");
  });

  it("[PAY-4a] writes carriage returns, tabs and line feeds so they survive parsing, and refuses non-characters", () => {
    const tree = Xml.element(
      "a",
      { b: "x\r\ny\tz\n" },
      Xml.element("c", {}, "A\r\nB\rC\tD\n"),
    );
    const written = Xml.serialize(tree);
    expect(written).toBe(
      '<a b="x&#13;&#10;y&#9;z&#10;"><c>A&#13;\nB&#13;C\tD\n</c></a>',
    );
    expect(Xml.parse(written)).toEqual(tree);
    expect(() => Xml.serialize(Xml.element("a", {}, "A\u0000B"))).toThrow(
      /U\+0000 cannot be written/,
    );
    expect(() => Xml.serialize(Xml.element("a", { b: "\u{FFFE}" }))).toThrow(
      /U\+FFFE cannot be written/,
    );
    expect(() => Xml.serialize(Xml.element("a", {}, "\ud800"))).toThrow(
      /U\+D800 cannot be written/,
    );
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
