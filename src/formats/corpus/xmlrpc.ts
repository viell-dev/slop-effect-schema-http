/**
 * EXT-4: edge-case XML-RPC calls and replies for comparing the suite's XML-RPC readers with an
 * independent XML parser. Calls are `account.title` unless a case says otherwise, with the edge
 * case in the account parameter, an attribute of `<methodName>`, or the prolog or epilog, so the
 * gateway can read them too; replies are read by the consumer only. Each case states XML 1.0's
 * verdict (https://www.w3.org/TR/xml/), and value-type cases also the XML-RPC value the
 * specification (https://xmlrpc.com/spec.md) gives the first parameter or the result.
 */
import type { Value } from "../xmlrpc.js";
import type { Case } from "./xml.js";

export interface RpcCase extends Case {
  readonly kind: "call" | "response";
  /**
   * The XML-RPC reading of a well-formed document: the first parameter's or the result's value as
   * the consumer's lossless tree, or the start of the consumer's refusal of an invalid structure.
   */
  readonly xmlrpc?: { readonly value: Value } | { readonly refused: string };
}

/** The account the gateway is started with; any other account is answered 404, echoing it. */
export const ACCOUNT = "12345678";

/** The account's title, which `account.title` answers for {@link ACCOUNT}. */
export const ACCOUNT_TITLE = "Acme Holdings";

/** The invoice the gateway is started with. */
export const INVOICE = 1001;

interface CallParts {
  readonly declaration?: string;
  readonly prolog?: string;
  readonly method?: string;
  /** Inside the `<methodName` start tag, after the name. */
  readonly attributes?: string;
  /** The account parameter's `<string>` content, as markup. */
  readonly text?: string;
  /** The parameter's `<value>` content, as markup, replacing the `<string>`. */
  readonly value?: string;
  /** Everything after `</methodName>` inside `<methodCall>`, replacing the parameters. */
  readonly params?: string;
  readonly epilog?: string;
}

const callDocument = (parts: CallParts): string =>
  `${parts.declaration ?? '<?xml version="1.0"?>\n'}${parts.prolog ?? ""}` +
  `<methodCall><methodName${parts.attributes ?? ""}>${parts.method ?? "account.title"}</methodName>` +
  (parts.params ??
    `<params><param><value>${parts.value ?? `<string>${parts.text ?? ACCOUNT}</string>`}</value></param></params>`) +
  `</methodCall>${parts.epilog ?? ""}`;

interface ResponseParts {
  readonly prolog?: string;
  /** Inside the `<value` start tag of the result. */
  readonly attributes?: string;
  /** The result's `<value>` content, as markup. */
  readonly value: string;
  readonly epilog?: string;
}

const responseDocument = (parts: ResponseParts): string =>
  `<?xml version="1.0"?>\n${parts.prolog ?? ""}` +
  `<methodResponse><params><param><value${parts.attributes ?? ""}>${parts.value}</value></param></params></methodResponse>` +
  (parts.epilog ?? "");

type Extra = Pick<RpcCase, "disagreements" | "xmlrpc">;

const make = (
  kind: RpcCase["kind"],
  wellFormed: boolean,
  id: string,
  about: string,
  document: string,
  extra: Extra = {},
): RpcCase => ({ id, about, document, wellFormed, kind, ...extra });

const call = (
  wellFormed: boolean,
  id: string,
  about: string,
  parts: CallParts,
  extra?: Extra,
) => make("call", wellFormed, id, about, callDocument(parts), extra);

const response = (
  wellFormed: boolean,
  id: string,
  about: string,
  parts: ResponseParts,
  extra?: Extra,
) => make("response", wellFormed, id, about, responseDocument(parts), extra);

/** A struct whose members are own properties, `__proto__` included. */
const struct = (
  members: ReadonlyArray<readonly [string, Value]>,
): { readonly struct: { readonly [name: string]: Value } } => {
  const value: Record<string, Value> = {};
  for (const [name, member] of members)
    Object.defineProperty(value, name, {
      value: member,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return { struct: value };
};

const consumerRefusesDtd =
  "refuses every DTD: the reader expands no entities, and none of the services the suite reads sends one";

/** Where the gateway's reader departs from XML 1.0 by its service page, as observed over HTTP. */
const gateway = {
  dtd: "refuses it with the parse-error fault, though the document is well-formed: since a 2014 security patch the gateway refuses every call with a document type declaration before expat reads it, as its service page documents under 'XML rules'",
} as const;

export const xmlRpcCorpus: ReadonlyArray<RpcCase> = [
  // Characters outside [2] Char, raw and as references.
  call(false, "call-char-nul", "a raw NUL in a string ([2] Char)", {
    text: "A\u0000B",
  }),
  call(false, "call-char-escape", "a raw ESC (U+001B) in a string ([2] Char)", {
    text: "A\u001bB",
  }),
  call(false, "call-char-ffff", "a raw U+FFFF in a string ([2] Char)", {
    text: "A\uffffB",
  }),
  call(false, "call-ref-nul", "&#0; (WFC: Legal Character)", {
    text: "A&#0;B",
  }),
  call(
    false,
    "call-ref-escape",
    "&#x1b; with lower-case digits (WFC: Legal Character)",
    {
      text: "A&#x1b;B",
    },
  ),
  call(
    false,
    "call-ref-surrogate",
    "&#xDFFF;, a surrogate (WFC: Legal Character)",
    {
      text: "&#xDFFF;",
    },
  ),
  call(
    false,
    "call-ref-beyond",
    "&#1114112;, past Unicode (WFC: Legal Character)",
    {
      text: "&#1114112;",
    },
  ),
  call(
    false,
    "call-ref-wraps",
    "&#4294967345;, which is '1' if truncated to 32 bits (WFC: Legal Character)",
    { text: "&#4294967345;2345678" },
  ),
  call(
    true,
    "call-char-edges",
    "the edges of [2] Char, raw, and a C1 control",
    {
      text: "\t\u0080\ud7ff\ue000\ufffd\u{10ffff}",
    },
  ),
  call(
    true,
    "call-ref-edges",
    "the edges of [2] Char, as references ([66] CharRef)",
    {
      text: "&#9;&#xA;&#xD;&#x20;&#x10FFFF;",
    },
  ),
  // References.
  call(
    false,
    "call-ref-bare-ampersand",
    "an '&' that starts no reference ([43] content)",
    {
      text: "R & D",
    },
  ),
  call(
    false,
    "call-ref-undeclared",
    "&eacute; without a DTD (WFC: Entity Declared)",
    {
      text: "caf&eacute;",
    },
  ),
  call(
    false,
    "call-ref-upper-x",
    "&#X31; with an upper-case X ([66] CharRef)",
    {
      text: "&#X31;2345678",
    },
  ),
  call(false, "call-ref-no-semicolon", "&lt without ';' ([68] EntityRef)", {
    text: "&lt",
  }),
  call(true, "call-ref-predefined", "the five predefined entities (4.6)", {
    text: "&lt;&gt;&amp;&quot;&apos;",
  }),
  call(
    true,
    "call-ref-digits",
    "the account's first digit as a reference ([66] CharRef)",
    {
      text: "&#x31;2345678",
    },
  ),
  call(
    true,
    "call-ref-leading-zeros",
    "a reference with leading zeros ([66] CharRef)",
    {
      text: "&#0049;2345678",
    },
  ),
  call(
    true,
    "call-ref-not-reexpanded",
    "a reference's character is data, not markup to read again (4.4.2)",
    { text: "&#38;#49;" },
  ),
  call(
    true,
    "call-method-reference",
    "a reference in the method name ([66] CharRef)",
    {
      method: "account.titl&#101;",
    },
  ),
  // CDATA sections.
  call(
    true,
    "call-cdata-digits",
    "the account split over CDATA and text ([18] CDSect)",
    {
      text: "<![CDATA[1234]]>5678",
    },
  ),
  call(true, "call-cdata-markup", "markup inside CDATA is text ([18] CDSect)", {
    text: "<![CDATA[<&>]]>",
  }),
  call(
    true,
    "call-cdata-split-end",
    "']]>' across two CDATA sections ([18] CDSect)",
    {
      text: "<![CDATA[]]]]><![CDATA[>]]>",
    },
  ),
  call(
    false,
    "call-cdata-end-in-text",
    "']]>' in character data ([14] CharData)",
    { text: "a]]>b" },
  ),
  // Line ends (2.11).
  call(true, "call-crlf", "CRLF in a string becomes LF (2.11)", {
    text: "a\r\nb",
  }),
  call(true, "call-cr", "a lone CR in a string becomes LF (2.11)", {
    text: "a\rb",
  }),
  call(
    true,
    "call-cr-reference",
    "a carriage return written as a reference stays (2.11)",
    {
      text: "a&#13;b",
    },
  ),
  call(
    true,
    "call-crlf-markup",
    "CRLF and lone CR between and inside tags (2.11)",
    {
      declaration: '<?xml version="1.0"?>\r\n',
      attributes: "\r\n",
      params:
        "\r\n<params>\r<param>\r\n<value><string>12345678</string></value>\r\n</param>\r\n</params>\r\n",
      epilog: "\r\n",
    },
  ),
  // Attributes, which XML-RPC does not define but a reader must still parse.
  call(
    true,
    "call-attr-single-quotes",
    "a value in single quotes ([10] AttValue)",
    {
      attributes: " kind='say \"hi\"'",
    },
  ),
  call(false, "call-attr-unquoted", "an unquoted value ([10] AttValue)", {
    attributes: " kind=a",
  }),
  call(false, "call-attr-less-than", "'<' in a value ([10] AttValue)", {
    attributes: ' kind="a<b"',
  }),
  call(false, "call-attr-reference", "&#0; in a value (WFC: Legal Character)", {
    attributes: ' kind="&#0;"',
  }),
  call(
    false,
    "call-attr-bare-ampersand",
    "an '&' that starts no reference in a value",
    {
      attributes: ' kind="a & b"',
    },
  ),
  call(
    false,
    "call-attr-no-separator",
    "two attributes without white space ([40] STag)",
    {
      attributes: ' kind="a"lang="en"',
    },
  ),
  call(
    false,
    "call-attr-duplicate",
    "an attribute given twice (WFC: Unique Att Spec)",
    { attributes: ' kind="a" kind="b"' },
  ),
  call(
    true,
    "call-attr-object-names",
    "attribute names that are also names of Object.prototype members ([41] Attribute)",
    { attributes: ' constructor="1" __proto__="2"' },
  ),
  call(
    false,
    "call-attr-nbsp-separator",
    "U+00A0 as the separator before an attribute: not white space ([3] S)",
    { attributes: '\u00a0kind="a"' },
  ),
  call(true, "call-attr-line-ends", "line ends in an attribute value (3.3.3)", {
    attributes: ' kind="a\r\nb"',
  }),
  // Document type declarations.
  call(
    true,
    "call-doctype-bare",
    "a document type declaration without an internal subset ([28] doctypedecl)",
    { prolog: "<!DOCTYPE methodCall>" },
    { disagreements: { consumer: consumerRefusesDtd, gateway: gateway.dtd } },
  ),
  call(
    true,
    "call-doctype-internal-entity",
    "an internal general entity declared in the DTD and used as the account (4.2, WFC: Entity Declared)",
    {
      prolog: '<!DOCTYPE methodCall [<!ENTITY account "12345678">]>',
      text: "&account;",
    },
    {
      disagreements: {
        saxes:
          "refuses the reference as undefined: saxes reads no declarations from a DTD, by its own documented limitation, though the entity is declared and XML 1.0 4.1 (WFC: Entity Declared) is met",
        consumer: consumerRefusesDtd,
        gateway: gateway.dtd,
      },
    },
  ),
  // The prolog and the epilog.
  call(true, "call-prolog-comment", "a comment before the root ([27] Misc)", {
    prolog: "<!-- desktop client 4.2 -->",
  }),
  call(
    true,
    "call-prolog-pi",
    "a processing instruction before the root ([27] Misc)",
    {
      prolog: "<?frontier trace?>",
    },
  ),
  call(
    true,
    "call-prolog-no-declaration",
    "no XML declaration at all ([22] prolog)",
    {
      declaration: "",
    },
  ),
  call(
    true,
    "call-prolog-byte-order-mark",
    "U+FEFF before the declaration: the encoding's signature, not content (4.3.3, F.1)",
    { declaration: '\ufeff<?xml version="1.0"?>\n' },
  ),
  call(
    false,
    "call-prolog-declaration-late",
    "an XML declaration after a comment ([22] prolog, [17] PITarget)",
    { declaration: "", prolog: '<!-- c --><?xml version="1.0"?>' },
  ),
  call(
    false,
    "call-prolog-declaration-after-space",
    "an XML declaration after white space ([22] prolog, [17] PITarget)",
    { declaration: '\n<?xml version="1.0"?>' },
  ),
  call(
    false,
    "call-prolog-declaration-no-version",
    "a declaration without a version ([23] XMLDecl)",
    { declaration: "<?xml?>" },
  ),
  call(
    false,
    "call-prolog-nbsp",
    "U+00A0 before the root: not white space ([3] S)",
    { prolog: "\u00a0" },
  ),
  call(
    false,
    "call-comment-double-hyphen",
    "'--' inside a comment before the root ([15] Comment)",
    { prolog: "<!-- a -- b -->" },
  ),
  call(
    false,
    "call-comment-double-hyphen-in-string",
    "'--' inside a comment in the account ([15] Comment)",
    { text: "1234<!-- a -- b -->5678" },
  ),
  call(
    true,
    "call-comment-in-string",
    "a comment inside the account ([43] content)",
    { text: "1234<!-- x -->5678" },
  ),
  call(true, "call-epilog-comment", "a comment after the root ([27] Misc)", {
    epilog: "<!-- end -->",
  }),
  call(false, "call-epilog-text", "text after the root ([1] document)", {
    epilog: "x",
  }),
  call(
    false,
    "call-epilog-element",
    "a second element after the root ([1] document)",
    {
      epilog: "<methodCall/>",
    },
  ),
  // Value types in calls.
  call(
    true,
    "call-untyped",
    "an untyped value is a string (XML-RPC: Scalar values)",
    {
      value: ACCOUNT,
    },
    { xmlrpc: { value: ACCOUNT } },
  ),
  call(
    true,
    "call-string-white-space",
    "white space inside a <string> is data",
    {
      text: ` ${ACCOUNT} `,
    },
    { xmlrpc: { value: { string: ` ${ACCOUNT} ` } } },
  ),
  call(
    true,
    "call-untyped-white-space",
    "white space inside an untyped value is data",
    {
      value: ` ${ACCOUNT} `,
    },
    { xmlrpc: { value: ` ${ACCOUNT} ` } },
  ),
  call(
    true,
    "call-white-space-around-type",
    "white space around the type element is not part of the value",
    { value: `\n  <string>${ACCOUNT}</string>\n` },
    { xmlrpc: { value: { string: ACCOUNT } } },
  ),
  call(
    true,
    "call-empty-string",
    "an empty <string/>",
    { value: "<string/>" },
    {
      xmlrpc: { value: { string: "" } },
    },
  ),
  call(
    true,
    "call-int-alias",
    "invoice.get with <int>, the other spelling of <i4>",
    {
      method: "invoice.get",
      value: `<int>${INVOICE}</int>`,
    },
    { xmlrpc: { value: { int: String(INVOICE) } } },
  ),
  call(
    true,
    "call-i4-white-space",
    "invoice.get with white space inside <i4>, kept as lexical text",
    {
      method: "invoice.get",
      value: `<i4> ${INVOICE} </i4>`,
    },
    { xmlrpc: { value: { i4: ` ${INVOICE} ` } } },
  ),
  call(true, "call-no-params", "system.listMethods without <params>", {
    method: "system.listMethods",
    params: "",
  }),
  // Replies, read by the consumer only.
  response(false, "reply-char-nul", "a raw NUL in a result ([2] Char)", {
    value: "<string>A\u0000B</string>",
  }),
  response(false, "reply-ref-nul", "&#0; in a result (WFC: Legal Character)", {
    value: "<string>A&#0;B</string>",
  }),
  response(
    false,
    "reply-ref-surrogate",
    "&#xD800; in a result (WFC: Legal Character)",
    {
      value: "<string>&#xD800;</string>",
    },
  ),
  response(
    false,
    "reply-bare-ampersand",
    "an '&' that starts no reference ([43] content)",
    {
      value: "<string>R & D</string>",
    },
  ),
  response(
    true,
    "reply-cdata",
    "a string in CDATA, with markup characters ([18] CDSect)",
    { value: "<string><![CDATA[<a & b>]]></string>" },
    { xmlrpc: { value: { string: "<a & b>" } } },
  ),
  response(
    true,
    "reply-crlf",
    "CRLF and lone CR in a string become LF (2.11)",
    { value: "<string>a\r\nb\rc</string>" },
    { xmlrpc: { value: { string: "a\nb\nc" } } },
  ),
  response(
    true,
    "reply-cr-reference",
    "carriage returns written as references stay (2.11)",
    { value: "<string>a&#13;b&#xD;</string>" },
    { xmlrpc: { value: { string: "a\rb\r" } } },
  ),
  response(
    true,
    "reply-doctype",
    "a document type declaration before the reply ([28] doctypedecl)",
    { prolog: "<!DOCTYPE methodResponse>", value: "<string>x</string>" },
    { disagreements: { consumer: consumerRefusesDtd } },
  ),
  response(
    true,
    "reply-prolog-comment",
    "a comment before the root ([27] Misc)",
    {
      prolog: "<!-- Frontier/5.1.2 -->",
      value: "<i4>1</i4>",
    },
  ),
  response(false, "reply-epilog-text", "text after the root ([1] document)", {
    value: "<i4>1</i4>",
    epilog: "trailing",
  }),
  response(
    false,
    "reply-attr-no-separator",
    "two attributes without white space ([40] STag)",
    {
      attributes: ' a="1"b="2"',
      value: "<i4>1</i4>",
    },
  ),
  response(
    true,
    "reply-attr-object-names",
    "attribute names that are also names of Object.prototype members ([41] Attribute)",
    { attributes: ' constructor="1" toString="2"', value: "<i4>1</i4>" },
    { xmlrpc: { value: { i4: "1" } } },
  ),
  // Value types in replies.
  response(
    true,
    "reply-i4-white-space",
    "white space inside <i4>, kept as lexical text for the schema to judge",
    { value: "<i4> 42 </i4>" },
    { xmlrpc: { value: { i4: " 42 " } } },
  ),
  response(
    true,
    "reply-i4-sign",
    "an explicit '+' sign on <i4>",
    { value: "<i4>+42</i4>" },
    {
      xmlrpc: { value: { i4: "+42" } },
    },
  ),
  response(
    true,
    "reply-int",
    "<int>, the other spelling of <i4>",
    { value: "<int>-7</int>" },
    {
      xmlrpc: { value: { int: "-7" } },
    },
  ),
  response(
    true,
    "reply-boolean",
    "<boolean> as 1",
    { value: "<boolean>1</boolean>" },
    {
      xmlrpc: { value: { boolean: "1" } },
    },
  ),
  response(
    true,
    "reply-double-exponent",
    "a <double> with an exponent",
    {
      value: "<double>-1.5E3</double>",
    },
    { xmlrpc: { value: { double: "-1.5E3" } } },
  ),
  response(
    true,
    "reply-datetime",
    "a <dateTime.iso8601> without separators in the date",
    {
      value: "<dateTime.iso8601>19980717T14:08:55</dateTime.iso8601>",
    },
    { xmlrpc: { value: { "dateTime.iso8601": "19980717T14:08:55" } } },
  ),
  response(
    true,
    "reply-base64-line-ends",
    "base64 lines ending in CRLF become LF (2.11)",
    {
      value: "<base64>QUJD\r\nREVG\r\n</base64>",
    },
    { xmlrpc: { value: { base64: "QUJD\nREVG\n" } } },
  ),
  response(
    true,
    "reply-string-empty",
    "an empty <string/>",
    { value: "<string/>" },
    {
      xmlrpc: { value: { string: "" } },
    },
  ),
  response(
    true,
    "reply-value-empty",
    "an empty untyped value",
    { value: "" },
    {
      xmlrpc: { value: "" },
    },
  ),
  response(
    true,
    "reply-untyped-white-space",
    "white space inside an untyped value is data",
    {
      value: "  a  ",
    },
    { xmlrpc: { value: "  a  " } },
  ),
  response(
    true,
    "reply-white-space-around-type",
    "white space around the type element is not part of the value",
    { value: "\n\t<string> a </string>\n" },
    { xmlrpc: { value: { string: " a " } } },
  ),
  response(
    true,
    "reply-struct-name-reference",
    "a member name written with references",
    {
      value:
        "<struct><member><name>a&amp;b&#x20;c</name><value>x</value></member></struct>",
    },
    { xmlrpc: { value: struct([["a&b c", "x"]]) } },
  ),
  response(
    true,
    "reply-struct-object-names",
    "member names that are also names of Object.prototype members",
    {
      value:
        "<struct><member><name>__proto__</name><value>x</value></member>" +
        "<member><name>constructor</name><value><i4>1</i4></value></member></struct>",
    },
    {
      xmlrpc: {
        value: struct([
          ["__proto__", "x"],
          ["constructor", { i4: "1" }],
        ]),
      },
    },
  ),
  response(
    true,
    "reply-struct-duplicate",
    "a member given twice, which the reader refuses rather than choosing one",
    {
      value:
        "<struct><member><name>a</name><value>1</value></member>" +
        "<member><name>a</name><value>2</value></member></struct>",
    },
    { xmlrpc: { refused: 'XML-RPC: duplicate member "a"' } },
  ),
  response(
    true,
    "reply-array-nested",
    "nested and empty arrays",
    {
      value:
        "<array><data><value><array><data/></array></value><value><i4>1</i4></value></data></array>",
    },
    { xmlrpc: { value: { array: [{ array: [] }, { i4: "1" }] } } },
  ),
  response(
    true,
    "reply-nil",
    "<nil/>, an extension the specification does not define",
    {
      value: "<nil/>",
    },
    { xmlrpc: { refused: "XML-RPC: unsupported type <nil>" } },
  ),
  response(
    true,
    "reply-mixed-content",
    "text beside a type element",
    {
      value: "x<i4>1</i4>",
    },
    { xmlrpc: { refused: "XML-RPC: unexpected text in <value>" } },
  ),
  response(
    true,
    "reply-nbsp-beside-type",
    "U+00A0 beside a type element: text, since XML white space is only space, tab, CR and LF",
    { value: "<i4>1</i4>\u00a0" },
    { xmlrpc: { refused: "XML-RPC: unexpected text in <value>" } },
  ),
  make(
    "response",
    true,
    "reply-fault",
    "a fault whose string holds references and CDATA",
    '<?xml version="1.0"?>\n<methodResponse><fault><value><struct>' +
      "<member><name>faultCode</name><value><i4>-32601</i4></value></member>" +
      "<member><name>faultString</name><value><string>no &lt;method&gt; <![CDATA[a&b]]></string></value></member>" +
      "</struct></value></fault></methodResponse>",
  ),
];
