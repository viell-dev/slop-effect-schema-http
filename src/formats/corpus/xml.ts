/**
 * EXT-3: edge-case XML documents for comparing the suite's XML readers with an independent parser.
 * Each document is a SOAP 1.1 `StoreDocument` request, so the SOAP store can read it too, and every
 * edge case sits in the title, an attribute of `<Title>`, or the prolog or epilog around the
 * envelope. A case states XML 1.0's verdict, citing the production or constraint of
 * https://www.w3.org/TR/xml/ that decides it, and records any reader known to disagree.
 */

/** A reader a case can record a disagreement for. */
export type Reader = "saxes" | "DOMParser" | "consumer" | "store" | "gateway";

export interface Case {
  /** A short, stable name, also the stored document's name in the SOAP store. */
  readonly id: string;
  /** What the case checks, and the part of XML 1.0 that decides it. */
  readonly about: string;
  readonly document: string;
  /** XML 1.0's verdict on the document. */
  readonly wellFormed: boolean;
  /**
   * Readers that disagree with XML 1.0, or with the independent parser's decoded text, and why. A
   * test fails both when an unrecorded reader disagrees and when a recorded one stops disagreeing.
   */
  readonly disagreements?: Partial<Record<Reader, string>>;
}

const SOAP11 = "http://schemas.xmlsoap.org/soap/envelope/";
const DECLARATION = '<?xml version="1.0" encoding="utf-8"?>\n';

interface Parts {
  /** Replaces the XML declaration and the line end after it. */
  readonly declaration?: string;
  /** Between the declaration and the envelope. */
  readonly prolog?: string;
  /** Inside the `<Title` start tag, after the name. */
  readonly attributes?: string;
  /** The title's content, as markup. */
  readonly title?: string;
  /** After the envelope. */
  readonly epilog?: string;
}

const document = (id: string, parts: Parts): string =>
  `${parts.declaration ?? DECLARATION}${parts.prolog ?? ""}` +
  `<soap:Envelope xmlns:soap="${SOAP11}"><soap:Body>` +
  `<StoreDocument xmlns="urn:docvault:store:2003"><Name>${id}.txt</Name>` +
  `<Title${parts.attributes ?? ""}>${parts.title ?? "Title"}</Title>` +
  "<ContentType>text/plain</ContentType><Content>eA==</Content>" +
  `</StoreDocument></soap:Body></soap:Envelope>${parts.epilog ?? ""}`;

const valid = (
  id: string,
  about: string,
  parts: Parts,
  disagreements?: Case["disagreements"],
): Case => ({
  id,
  about,
  document: document(id, parts),
  wellFormed: true,
  ...(disagreements === undefined ? {} : { disagreements }),
});

const malformed = (
  id: string,
  about: string,
  parts: Parts,
  disagreements?: Case["disagreements"],
): Case => ({
  id,
  about,
  document: document(id, parts),
  wellFormed: false,
  ...(disagreements === undefined ? {} : { disagreements }),
});

/** SOAP forbids a DTD, so the consumer's SOAP reader and the store refuse every one. */
const soapForbidsDtd =
  "refuses every DTD: SOAP 1.1 section 3 and SOAP 1.2 part 1 section 5 forbid a document type declaration in a message, and the reader expands no entities";

export const xmlCorpus: ReadonlyArray<Case> = [
  // Characters outside [2] Char, raw.
  malformed("char-nul", "a raw NUL in text ([2] Char)", { title: "A\u0000B" }),
  malformed("char-escape", "a raw ESC (U+001B) in text ([2] Char)", {
    title: "A\u001bB",
  }),
  malformed("char-fffe", "a raw U+FFFE in text ([2] Char)", {
    title: "A\ufffeB",
  }),
  malformed("char-ffff", "a raw U+FFFF in text ([2] Char)", {
    title: "A\uffffB",
  }),
  malformed("char-attribute", "a raw U+0001 in an attribute value ([2] Char)", {
    attributes: ' note="A\u0001B"',
  }),
  malformed("char-comment", "a raw BEL (U+0007) in a comment ([15] Comment)", {
    prolog: "<!-- \u0007 -->",
  }),
  // Characters outside [2] Char, as references.
  malformed("ref-nul", "&#0; (WFC: Legal Character)", { title: "A&#0;B" }),
  malformed("ref-escape", "&#x1B; (WFC: Legal Character)", {
    title: "A&#x1B;B",
  }),
  malformed("ref-surrogate", "&#xD800;, a surrogate (WFC: Legal Character)", {
    title: "A&#xD800;B",
  }),
  malformed("ref-fffe", "&#xFFFE; (WFC: Legal Character)", {
    title: "A&#xFFFE;B",
  }),
  malformed("ref-beyond", "&#x110000;, past Unicode (WFC: Legal Character)", {
    title: "A&#x110000;B",
  }),
  malformed(
    "ref-wraps",
    "&#4294967361;, which is 'A' if truncated to 32 bits (WFC: Legal Character)",
    { title: "A&#4294967361;B" },
  ),
  malformed(
    "ref-attribute",
    "&#1; in an attribute value (WFC: Legal Character)",
    {
      attributes: ' note="A&#1;B"',
    },
  ),
  // The edges of [2] Char, which stay readable.
  valid("char-edges", "the edges of [2] Char, raw", {
    title: "\t \ud7ff\ue000\ufffd\u{10000}\u{10ffff}",
  }),
  valid(
    "char-c1",
    "C1 controls, which XML 1.0 allows and only XML 1.1 restricts ([2] Char)",
    { title: "\u0080\u0085\u009f" },
  ),
  valid("ref-edges", "the edges of [2] Char, as references ([66] CharRef)", {
    title: "&#9;&#xA;&#xD;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;",
  }),
  // References.
  malformed(
    "ref-bare-ampersand",
    "an '&' that starts no reference ([43] content)",
    {
      title: "R & D",
    },
  ),
  malformed("ref-no-semicolon", "&amp without ';' ([68] EntityRef)", {
    title: "R &amp D",
  }),
  malformed("ref-undeclared", "&nbsp; without a DTD (WFC: Entity Declared)", {
    title: "&nbsp;",
  }),
  malformed("ref-upper-x", "&#X41; with an upper-case X ([66] CharRef)", {
    title: "&#X41;",
  }),
  malformed("ref-empty-hex", "&#x; without digits ([66] CharRef)", {
    title: "&#x;",
  }),
  malformed("ref-empty-decimal", "&#; without digits ([66] CharRef)", {
    title: "&#;",
  }),
  malformed("ref-space", "a space inside a reference ([66] CharRef)", {
    title: "&#x 41;",
  }),
  valid("ref-leading-zeros", "leading zeros in references ([66] CharRef)", {
    title: "&#00065;&#x0000042;",
  }),
  valid("ref-predefined", "the five predefined entities (4.6)", {
    title: "&lt;&gt;&amp;&quot;&apos;",
  }),
  valid(
    "ref-not-reexpanded",
    "a reference's character is data, not markup to read again (4.4.2)",
    { title: "&#38;amp; &#38;#60; &#60;b&#62;" },
  ),
  valid("ref-attribute", "references in an attribute value ([10] AttValue)", {
    attributes: ' note="&lt;&#x26;&quot;&apos;&#62;"',
  }),
  malformed(
    "ref-attribute-bare-ampersand",
    "an '&' that starts no reference in an attribute value ([10] AttValue)",
    { attributes: ' note="R & D"' },
  ),
  // CDATA sections.
  valid("cdata-markup", "markup inside CDATA is text ([18] CDSect)", {
    title: "<![CDATA[<b>&amp;</b>]]>",
  }),
  valid(
    "cdata-split-end",
    "']]>' written across two CDATA sections ([18] CDSect)",
    {
      title: "<![CDATA[]]]]><![CDATA[>]]>",
    },
  ),
  valid("cdata-empty", "an empty CDATA section between text ([18] CDSect)", {
    title: "a<![CDATA[]]>b",
  }),
  malformed("cdata-end-in-text", "']]>' in character data ([14] CharData)", {
    title: "a ]]> b",
  }),
  malformed(
    "cdata-unterminated",
    "a CDATA section without ']]>' ([18] CDSect)",
    {
      title: "<![CDATA[abc",
    },
  ),
  malformed("cdata-prolog", "a CDATA section before the root ([22] prolog)", {
    prolog: "<![CDATA[x]]>",
  }),
  malformed("cdata-lower-case", "'<![cdata[' in lower case ([19] CDStart)", {
    title: "<![cdata[x]]>",
  }),
  // Line ends (2.11).
  valid("crlf-text", "CRLF in text becomes LF (2.11)", { title: "a\r\nb" }),
  valid("cr-text", "a lone CR in text becomes LF (2.11)", { title: "a\rb" }),
  valid("cr-crlf-text", "CR then CRLF becomes two LFs (2.11)", {
    title: "a\r\r\nb",
  }),
  valid("crlf-cdata", "line ends inside CDATA are normalized too (2.11)", {
    title: "<![CDATA[a\r\nb\rc]]>",
  }),
  valid(
    "cr-reference",
    "a carriage return written as a reference stays (2.11)",
    {
      title: "a&#13;&#10;b&#xD;",
    },
  ),
  valid(
    "crlf-attribute",
    "literal line ends and tabs in an attribute value become spaces (3.3.3)",
    { attributes: ' note="x\r\ny\rz\tw"' },
  ),
  valid(
    "crlf-attribute-reference",
    "referenced line ends and tabs in an attribute value stay (3.3.3)",
    { attributes: ' note="x&#13;&#10;y&#9;z"' },
  ),
  valid("crlf-markup", "CRLF and lone CR inside tags and between them (2.11)", {
    declaration: '<?xml version="1.0"\r\nencoding="utf-8"?>\r\n',
    prolog: "\r",
    attributes: '\r\n note="1"\r',
    epilog: "\r\n",
  }),
  // Attribute quoting and white space.
  valid("attr-single-quotes", "a value in single quotes ([10] AttValue)", {
    attributes: " note='say \"hi\"'",
  }),
  valid("attr-other-quote", "the other quote inside a value ([10] AttValue)", {
    attributes: ' note="it\'s"',
  }),
  malformed("attr-unquoted", "an unquoted value ([10] AttValue)", {
    attributes: " note=1",
  }),
  malformed("attr-less-than", "'<' in a value ([10] AttValue)", {
    attributes: ' note="1 < 2"',
  }),
  valid("attr-greater-than", "'>' in a value ([10] AttValue)", {
    attributes: ' note="1 > 2"',
  }),
  valid("attr-spaced-equals", "white space around '=' ([25] Eq)", {
    attributes: ' note \t= \n"1"',
  }),
  malformed(
    "attr-no-separator",
    "two attributes without white space between them ([40] STag)",
    { attributes: ' note="1"lang="en"' },
  ),
  malformed(
    "attr-duplicate",
    "an attribute given twice (WFC: Unique Att Spec)",
    {
      attributes: ' note="1" note="2"',
    },
  ),
  valid(
    "attr-object-names",
    "attribute names that are also names of Object.prototype members ([41] Attribute)",
    {
      attributes:
        ' constructor="1" toString="2" __proto__="3" hasOwnProperty="4"',
    },
  ),
  malformed(
    "attr-nbsp-separator",
    "U+00A0 as the separator before an attribute: not white space ([3] S)",
    { attributes: '\u00a0note="1"' },
  ),
  malformed(
    "attr-ideographic-space",
    "U+3000 before the end of a start tag: not white space ([3] S)",
    { attributes: ' note="1"\u3000' },
  ),
  valid(
    "attr-line-separators",
    "tabs, CRLF and CR between attributes ([3] S)",
    {
      attributes: '\n\tnote="1"\r\n\tlang="en"\r',
    },
  ),
  malformed("attr-no-value", "an attribute without a value ([41] Attribute)", {
    attributes: " note",
  }),
  malformed(
    "attr-mixed-quotes",
    "a value opened and closed by different quotes",
    {
      attributes: " note=\"1'",
    },
  ),
  malformed(
    "attr-name-digit",
    "an attribute name starting with a digit ([4] NameStartChar)",
    {
      attributes: ' 1note="x"',
    },
  ),
  malformed(
    "attr-name-hyphen",
    "an attribute name starting with '-' ([4] NameStartChar)",
    { attributes: ' -note="x"' },
  ),
  valid(
    "attr-name-non-ascii",
    "non-ASCII name characters, and U+00B7 after the first ([4] NameStartChar, [4a] NameChar)",
    { attributes: ' größe="x" naïve·x="y"' },
  ),
  // Document type declarations.
  valid(
    "doctype-bare",
    "a document type declaration without an internal subset ([28] doctypedecl)",
    { prolog: "<!DOCTYPE soap:Envelope>" },
    { consumer: soapForbidsDtd, store: soapForbidsDtd },
  ),
  valid(
    "doctype-internal-entity",
    "an internal general entity declared in the DTD and used in the title (4.2, WFC: Entity Declared)",
    {
      prolog: '<!DOCTYPE soap:Envelope [<!ENTITY t "from the DTD">]>',
      title: "&t;",
    },
    {
      saxes:
        "refuses the reference as undefined: saxes reads no declarations from a DTD, by its own documented limitation, though the entity is declared and XML 1.0 4.1 (WFC: Entity Declared) is met",
      consumer: soapForbidsDtd,
      store: soapForbidsDtd,
    },
  ),
  malformed(
    "doctype-epilog",
    "a document type declaration after the root ([1] document)",
    {
      epilog: "<!DOCTYPE soap:Envelope>",
    },
  ),
  // The prolog: comments and processing instructions before the root, and the declaration.
  valid("prolog-comment", "a comment before the root ([27] Misc)", {
    prolog: "<!-- before the root -->",
  }),
  valid("prolog-pi", "a processing instruction before the root ([27] Misc)", {
    prolog: "<?docvault-route archive?>",
  }),
  valid(
    "prolog-xml-prefixed-pi",
    "a PI target that only starts with 'xml' ([17] PITarget)",
    {
      prolog: '<?xml-stylesheet href="a.xsl"?>',
    },
  ),
  valid("prolog-no-declaration", "no XML declaration at all ([22] prolog)", {
    declaration: "",
  }),
  valid(
    "prolog-byte-order-mark",
    "U+FEFF before the declaration: the encoding's signature, not content (4.3.3, F.1)",
    { declaration: `\ufeff${DECLARATION}` },
  ),
  malformed(
    "prolog-zero-width-space",
    "U+FEFF after the declaration: a character, not a signature ([22] prolog)",
    { prolog: "\ufeff" },
  ),
  valid(
    "prolog-line-ends",
    "blank lines with CRLF and CR before the root ([27] Misc)",
    {
      prolog: "\r\n\r\n\r",
    },
  ),
  valid(
    "prolog-standalone",
    "a declaration with standalone='yes' ([32] SDDecl)",
    {
      declaration: "<?xml version='1.0' encoding='utf-8' standalone='yes'?>",
    },
  ),
  malformed(
    "prolog-declaration-late",
    "an XML declaration after a comment: 'xml' is a reserved PI target ([22] prolog, [17] PITarget)",
    { declaration: "", prolog: '<!-- c --><?xml version="1.0"?>' },
  ),
  malformed(
    "prolog-declaration-after-space",
    "an XML declaration after white space ([22] prolog, [17] PITarget)",
    { declaration: ' <?xml version="1.0"?>' },
  ),
  malformed(
    "prolog-declaration-no-version",
    "a declaration without a version ([23] XMLDecl)",
    { declaration: '<?xml encoding="utf-8"?>' },
  ),
  malformed(
    "prolog-declaration-order",
    "a declaration naming the encoding before the version ([23] XMLDecl)",
    { declaration: '<?xml encoding="utf-8" version="1.0"?>' },
  ),
  malformed(
    "prolog-declaration-standalone",
    "standalone='maybe' ([32] SDDecl)",
    { declaration: '<?xml version="1.0" standalone="maybe"?>' },
  ),
  malformed("prolog-pi-reserved", "'XmL' as a PI target ([17] PITarget)", {
    prolog: "<?XmL data?>",
  }),
  malformed("prolog-pi-no-target", "a PI without a target ([16] PI)", {
    prolog: "<? data?>",
  }),
  malformed("prolog-text", "text before the root ([22] prolog)", {
    prolog: "x",
  }),
  malformed("prolog-nbsp", "U+00A0 before the root: not white space ([3] S)", {
    prolog: "\u00a0",
  }),
  // Comments.
  malformed("comment-double-hyphen", "'--' inside a comment ([15] Comment)", {
    prolog: "<!-- a -- b -->",
  }),
  malformed("comment-hyphen-end", "a comment ending in '--->' ([15] Comment)", {
    prolog: "<!-- a --->",
  }),
  malformed(
    "comment-double-hyphen-in-text",
    "'--' inside a comment in the title ([15] Comment)",
    { title: "a<!-- b -- c -->d" },
  ),
  malformed(
    "comment-overlap",
    "'<!--->': the opening's hyphens cannot also close it ([15] Comment)",
    { prolog: "<!--->" },
  ),
  valid("comment-empty", "an empty comment, '<!---->' ([15] Comment)", {
    prolog: "<!---->",
  }),
  valid("comment-in-text", "a comment inside the title's text ([43] content)", {
    title: "a<!-- c -->b",
  }),
  valid(
    "pi-in-text",
    "a processing instruction inside the title's text ([43] content)",
    {
      title: "a<?note x?>b",
    },
  ),
  // Content after the root.
  valid("epilog-comment", "a comment after the root ([27] Misc)", {
    epilog: "<!-- after the root -->",
  }),
  valid("epilog-pi", "a processing instruction after the root ([27] Misc)", {
    epilog: "<?docvault-checksum 1?>",
  }),
  valid(
    "epilog-white-space",
    "white space with CRLF after the root ([27] Misc)",
    {
      epilog: "\r\n \t\r\n",
    },
  ),
  malformed("epilog-text", "text after the root ([1] document)", {
    epilog: "x",
  }),
  malformed(
    "epilog-element",
    "a second element after the root ([1] document)",
    {
      epilog: "<extra/>",
    },
  ),
];
