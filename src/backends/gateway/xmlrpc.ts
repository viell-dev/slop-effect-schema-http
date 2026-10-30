/**
 * The XML-RPC reader and writer of `/RPC2`: just enough XML to read a `methodCall` the way expat
 * would, and a writer for the value types the Perl handlers wrote. Its XML rules, value formats and
 * fault codes are in the service page.
 *
 * Service documentation: services/gateway.md
 */
import type { Reply } from "../../harness/server.js";
import { units } from "./cgi.js";

/** A parsed element of the request; text children are kept as strings. */
interface Node {
  readonly name: string;
  readonly children: ReadonlyArray<Node | string>;
}

const entity: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

/**
 * XML 1.0's `Char` (https://www.w3.org/TR/xml/#charsets): tab, LF, CR, and U+0020 to U+10FFFF
 * without the surrogates, U+FFFE and U+FFFF.
 */
const isXmlChar = (code: number): boolean =>
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0d ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/** The offset and code point of the first character outside `Char`; a lone surrogate is one. */
const firstNonChar = (
  text: string,
): { readonly offset: number; readonly code: number } | undefined => {
  let offset = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (!isXmlChar(code)) return { offset, code };
    offset += character.length;
  }
  return undefined;
};

/** A reference's replacement; throws when it is malformed or names a character XML forbids. */
const reference = (name: string): string => {
  // XML spells a hexadecimal reference with a lower-case x only.
  const numeric = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(name);
  if (numeric !== null) {
    const code =
      numeric[1] === undefined
        ? Number.parseInt(numeric[2]!, 10)
        : Number.parseInt(numeric[1], 16);
    if (!isXmlChar(code))
      throw new Error(`&${name}; refers to a character XML does not allow`);
    return String.fromCodePoint(code);
  }
  const value = entity.get(name);
  if (value === undefined) throw new Error(`unknown entity &${name};`);
  return value;
};

/** Replace the references in character data; an `&` must start one. */
const unescape = (text: string): string => {
  let result = "";
  let index = 0;
  for (;;) {
    const start = text.indexOf("&", index);
    if (start < 0) return result + text.slice(index);
    const end = text.indexOf(";", start);
    if (end < 0) throw new Error(`an '&' at ${start} starts no reference`);
    result += text.slice(index, start) + reference(text.slice(start + 1, end));
    index = end + 1;
  }
};

/** XML 1.0's white space, `S`: space, tab and LF once line ends are normalized, nothing else. */
const isSpace = (character: string | undefined): boolean =>
  character === " " || character === "\t" || character === "\n";

/** XML 1.0's `Name`: `NameStartChar` then `NameChar`s, most of Unicode included. */
const nameStart =
  ":A-Z_a-z\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}\\u{370}-\\u{37D}\\u{37F}-\\u{1FFF}" +
  "\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}" +
  "\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}";
const nameSyntax = `[${nameStart}][${nameStart}\\-.0-9\\u{B7}\\u{300}-\\u{36F}\\u{203F}-\\u{2040}]*`;
const nameToken = new RegExp(nameSyntax, "uy");

/** The XML declaration's content: a version, then an optional encoding and standalone. */
const declaration =
  /^xml[ \t\n]+version[ \t\n]*=[ \t\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(?:"[A-Za-z][\w.-]*"|'[A-Za-z][\w.-]*'))?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\n]*$/;

/**
 * Enough XML to read a methodCall as expat would: elements, attributes, text, references, CDATA,
 * comments and processing instructions, with every well-formedness rule they carry. A document
 * type declaration is refused, well-formed or not (the service page's "XML rules").
 */
const parseXml = (input: string): Node => {
  // CRLF and a lone CR become LF before anything else reads the text (XML 1.0 §2.11).
  const source = input.replace(/\r\n?/g, "\n");
  const invalid = firstNonChar(source);
  if (invalid !== undefined)
    throw new Error(
      `U+${invalid.code.toString(16).toUpperCase().padStart(4, "0")} at ${invalid.offset} is not an XML character`,
    );
  let index = 0;
  const fail = (message: string): never => {
    throw new Error(`${message} at ${index}`);
  };
  const spaces = (): boolean => {
    const start = index;
    while (isSpace(source[index])) index++;
    return index > start;
  };
  const readName = (): string | undefined => {
    nameToken.lastIndex = index;
    const match = nameToken.exec(source)?.[0];
    if (match !== undefined) index = nameToken.lastIndex;
    return match;
  };
  // At `<!--`: no `--` inside, and no `-` before the closing `-->`.
  const comment = () => {
    const end = source.indexOf("-->", index + 4);
    if (end < 0) fail("unterminated comment");
    const content = source.slice(index + 4, end);
    if (content.includes("--") || content.endsWith("-"))
      fail("'--' inside a comment");
    index = end + 3;
  };
  // At `<?`: a target, then white space before any data; `xml` in any case is reserved for the
  // declaration, which only the very start may hold.
  const instruction = () => {
    const end = source.indexOf("?>", index + 2);
    if (end < 0) fail("unterminated processing instruction");
    const start = index;
    index += 2;
    const target = readName();
    if (target === undefined) fail("a processing instruction without a target");
    if (index < end && !isSpace(source[index]))
      fail("no white space after the processing instruction's target");
    if (/^xml$/i.test(target!)) {
      if (start !== 0 || target !== "xml") fail("a misplaced XML declaration");
      if (!declaration.test(source.slice(start + 2, end)))
        fail("a malformed XML declaration");
    }
    index = end + 2;
  };
  // Comments, processing instructions and white space, before and after the root.
  const misc = () => {
    for (;;) {
      spaces();
      if (source.startsWith("<?", index)) instruction();
      else if (source.startsWith("<!--", index)) comment();
      else return;
    }
  };
  const element = (): Node => {
    if (source[index] !== "<") fail("expected an element");
    index++;
    const tag = readName() ?? fail("expected an element name");
    // Attribute values are checked, then ignored.
    const attributes = new Set<string>();
    for (;;) {
      const spaced = spaces();
      if (source.startsWith("/>", index)) {
        index += 2;
        return { name: tag, children: [] };
      }
      if (source[index] === ">") {
        index++;
        break;
      }
      if (!spaced) fail(`no white space before an attribute of <${tag}>`);
      const key = readName() ?? fail(`a malformed attribute in <${tag}>`);
      if (attributes.has(key)) fail(`attribute ${key} given twice in <${tag}>`);
      attributes.add(key);
      spaces();
      if (source[index] !== "=") fail(`attribute ${key} has no value`);
      index++;
      spaces();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail(`attribute ${key} is unquoted`);
      const end = source.indexOf(quote!, index + 1);
      if (end < 0) fail(`attribute ${key} is unterminated`);
      const value = source.slice(index + 1, end);
      if (value.includes("<")) fail(`'<' in attribute ${key} of <${tag}>`);
      unescape(value);
      index = end + 1;
    }
    const children: Array<Node | string> = [];
    for (;;) {
      if (index >= source.length) fail(`unterminated <${tag}>`);
      if (source.startsWith("</", index)) {
        index += 2;
        if (readName() !== tag) fail(`an end tag that does not close <${tag}>`);
        spaces();
        if (source[index] !== ">") fail(`a malformed end tag of <${tag}>`);
        index++;
        return { name: tag, children };
      }
      if (source.startsWith("<![CDATA[", index)) {
        const end = source.indexOf("]]>", index);
        if (end < 0) fail("unterminated CDATA");
        children.push(source.slice(index + 9, end));
        index = end + 3;
      } else if (source.startsWith("<!--", index)) comment();
      else if (source.startsWith("<?", index)) instruction();
      else if (source[index] === "<") children.push(element());
      else {
        const end = source.indexOf("<", index);
        if (end < 0) fail(`unterminated <${tag}>`);
        const text = source.slice(index, end);
        if (text.includes("]]>")) fail("']]>' in character data");
        children.push(unescape(text));
        index = end;
      }
    }
  };
  misc();
  // The 2014 patch: no DTD reaches expat, whatever it declares.
  if (source.startsWith("<!DOCTYPE", index))
    fail("a document type declaration");
  const root = element();
  misc();
  if (index !== source.length) fail("content after the root element");
  return root;
};

const elementsOf = (node: Node): ReadonlyArray<Node> =>
  node.children.filter((child): child is Node => typeof child !== "string");

const textOf = (node: Node): string =>
  node.children
    .filter((child): child is string => typeof child === "string")
    .join("");

/** A request parameter as the dispatcher sees it. */
export type Param = { readonly type: string; readonly text: string };

const param = (value: Node): Param => {
  const typed = elementsOf(value);
  if (typed.length === 0) return { type: "string", text: textOf(value) };
  const inner = typed[0]!;
  return {
    type: inner.name === "int" ? "i4" : inner.name,
    text: textOf(inner),
  };
};

/** Read a methodCall's name and scalar parameters. Throws on malformed XML. */
export const readCall = (
  body: string,
): { readonly method: string; readonly params: ReadonlyArray<Param> } => {
  const root = parseXml(body);
  if (root.name !== "methodCall") throw new Error("not a methodCall");
  const name = elementsOf(root).find((child) => child.name === "methodName");
  if (name === undefined) throw new Error("no methodName");
  const params = elementsOf(root).find((child) => child.name === "params");
  return {
    method: textOf(name).trim(),
    params: (params === undefined ? [] : elementsOf(params)).map((entry) => {
      const value = elementsOf(entry)[0];
      if (entry.name !== "param" || value?.name !== "value")
        throw new Error("malformed param");
      return param(value);
    }),
  };
};

/** Escape character data; a carriage return is a reference, so line-end handling keeps it. */
const escape = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;");

/** Frontier::RPC2's escaping of a typed object's text, which escapes the quote too. */
const escapeTyped = (text: string): string =>
  escape(text).replaceAll('"', "&quot;");

/**
 * Frontier::RPC2's escaping of a plain scalar's text: as a typed object's, and every character
 * from U+0080 to U+FFFF as a decimal character reference.
 */
const escapePlain = (text: string): string =>
  escapeTyped(text).replace(/[\u0080-￿]/g, (character) =>
    /[\ud800-\udfff]/.test(character)
      ? character
      : `&#${character.charCodeAt(0)};`,
  );

/**
 * A value as a handler hands it to Frontier::RPC2's encoder (the service page's "Values"). A plain
 * Perl scalar is typed by the encoder's guess and written without a line end after it: `i4` for
 * an integer, `cents` for an amount formatted with two decimals, which the guess makes a
 * `<double>`, and `plain` for text. The module's typed objects are written with a line end after
 * `</value>`: `string` for text a guess would make an integer, `boolean`, `dateTime` and
 * `base64`, and so are structs and arrays. `untyped` is the 1999 `account.title`'s own reply.
 */
export type Out =
  | { readonly i4: number }
  | { readonly cents: number }
  | { readonly plain: string }
  | { readonly string: string }
  | { readonly boolean: boolean }
  | { readonly dateTime: string }
  | { readonly base64: Uint8Array }
  | { readonly untyped: string }
  | { readonly struct: ReadonlyArray<readonly [string, Out]> }
  | { readonly array: ReadonlyArray<Out> };

/** MIME::Base64's `encode_base64` with its default line end: 76 columns, each line ended. */
const mime = (bytes: Uint8Array): string =>
  (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  )
    .map((line) => `${line}\n`)
    .join("");

/** Whether any text in a value holds a character outside `Char`, which no reference may carry. */
const holdsNonChar = (value: Out): boolean => {
  if ("struct" in value)
    return value.struct.some(
      ([name, member]) =>
        firstNonChar(name) !== undefined || holdsNonChar(member),
    );
  if ("array" in value) return value.array.some(holdsNonChar);
  const text =
    "plain" in value
      ? value.plain
      : "string" in value
        ? value.string
        : "dateTime" in value
          ? value.dateTime
          : "untyped" in value
            ? value.untyped
            : "";
  return firstNonChar(text) !== undefined;
};

const write = (value: Out): string => {
  if ("i4" in value) return `<value><i4>${value.i4}</i4></value>`;
  if ("cents" in value)
    return `<value><double>${units(value.cents, ".")}</double></value>`;
  if ("plain" in value)
    return `<value><string>${escapePlain(value.plain)}</string></value>`;
  if ("untyped" in value) return `<value>${escape(value.untyped)}</value>`;
  if ("string" in value)
    return `<value><string>${escapeTyped(value.string)}</string></value>\n`;
  if ("boolean" in value)
    return `<value><boolean>${value.boolean ? 1 : 0}</boolean></value>\n`;
  if ("dateTime" in value)
    return `<value><dateTime.iso8601>${escapeTyped(value.dateTime)}</dateTime.iso8601></value>\n`;
  if ("base64" in value)
    return `<value><base64>${mime(value.base64)}</base64></value>\n`;
  if ("struct" in value)
    return `<value><struct>\n${value.struct
      .map(
        ([name, member]) =>
          `<member><name>${escapeTyped(name)}</name>${write(member)}</member>\n`,
      )
      .join("")}</struct></value>\n`;
  return `<value><array><data>\n${value.array.map(write).join("")}</data></array></value>\n`;
};

/** A reply with its length, which the script prints as Frontier::Daemon does. */
const xml = (content: string): Reply => {
  const body = `<?xml version="1.0"?>\n<methodResponse>\n${content}</methodResponse>\n`;
  return {
    status: 200,
    lines: [
      ["Content-Length", String(Buffer.byteLength(body))],
      ["Content-Type", "text/xml"],
    ],
    body,
  };
};

/** A fault as Frontier::RPC2's `encode_fault` writes it. */
export const fault = (code: number, message: string): Reply =>
  xml(
    `<fault>\n${write({
      struct: [
        ["faultCode", { i4: code }],
        ["faultString", { plain: message }],
      ],
    })}</fault>\n`,
  );

/**
 * A methodResponse as Frontier::RPC2's `encode_response` writes it, or the internal-error fault in
 * place of one XML cannot carry.
 */
export const result = (value: Out): Reply =>
  holdsNonChar(value)
    ? fault(-32603, "server error. internal xml-rpc error")
    : xml(`<params>\n<param>${write(value)}</param>\n</params>\n`);
