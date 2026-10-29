/**
 * `/RPC2`, the XML-RPC endpoint the desktop reporting client has called since 1999 (Frontier::RPC,
 * later XMLRPC::Lite). Like every XML-RPC server of its age it answers HTTP 200 for every call that
 * reached the dispatcher, faults included; only a request that is not `text/xml` at all is refused
 * by the HTTP layer with 400. The fault codes follow the 2001 interoperability list for protocol
 * errors, and HTTP-like numbers for application errors because the 2003 maintainers liked them.
 *
 * Values are written the way Perl wrote them: `<i4>`, doubles with exactly two decimals,
 * `<boolean>` as `1` or `0`, `dateTime.iso8601` without separators in the date or a zone,
 * `00000000T00:00:00` for "no date", untyped `<value>` strings where the original handlers forgot
 * the type, and base64 wrapped by MIME::Base64 at 76 columns with a newline after every line.
 *
 * Both servers parsed with expat, so a call is read as expat reads it: line ends are normalized to
 * LF first, and a character outside XML 1.0's `Char` production, raw or as a character reference,
 * or an `&` that starts no reference, makes the document malformed. A malformed call is answered
 * with the -32700 parse-error fault before the session or the method is looked at. The writer
 * escapes text, writes a carriage return as `&#13;` so a reader's line-end handling keeps it, and
 * never writes a character outside `Char`: a value that holds one, which only fixture data can
 * supply, turns the reply into the -32603 internal-error fault.
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

/** Just enough XML to read a methodCall: elements, text, entities, a declaration and comments. */
const parseXml = (input: string): Node => {
  // Expat hands on CRLF and a lone CR as LF before anything else reads the text (XML 1.0 §2.11).
  const source = input.replace(/\r\n?/g, "\n");
  const invalid = firstNonChar(source);
  if (invalid !== undefined)
    throw new Error(
      `U+${invalid.code.toString(16).toUpperCase().padStart(4, "0")} at ${invalid.offset} is not an XML character`,
    );
  let index = 0;
  const skip = () => {
    for (;;) {
      while (/\s/.test(source[index] ?? "")) index++;
      if (source.startsWith("<?", index))
        index = source.indexOf("?>", index) + 2;
      else if (source.startsWith("<!--", index))
        index = source.indexOf("-->", index) + 3;
      else return;
      if (index < 2) throw new Error("unterminated markup");
    }
  };
  const element = (): Node => {
    const open = /^<([A-Za-z_][\w.:-]*)(\s+[^>]*?)?(\/?)>/.exec(
      source.slice(index),
    );
    if (open === null) throw new Error(`expected an element at ${index}`);
    index += open[0].length;
    const name = open[1]!;
    if (open[3] === "/") return { name, children: [] };
    const children: Array<Node | string> = [];
    for (;;) {
      if (index >= source.length) throw new Error(`unterminated <${name}>`);
      if (source.startsWith(`</${name}>`, index)) {
        index += name.length + 3;
        return { name, children };
      }
      if (source.startsWith("</", index))
        throw new Error(`mismatched end tag at ${index}`);
      if (source.startsWith("<![CDATA[", index)) {
        const end = source.indexOf("]]>", index);
        if (end < 0) throw new Error("unterminated CDATA");
        children.push(source.slice(index + 9, end));
        index = end + 3;
      } else if (source[index] === "<") children.push(element());
      else {
        const end = source.indexOf("<", index);
        if (end < 0) throw new Error(`unterminated <${name}>`);
        children.push(unescape(source.slice(index, end)));
        index = end;
      }
    }
  };
  skip();
  const root = element();
  skip();
  if (index !== source.length)
    throw new Error("content after the root element");
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

/** A value written the way the Perl handlers write it. */
export type Out =
  | { readonly i4: number }
  /** Money in cents, written as a `<double>` in units with two decimals, as sprintf("%.2f") did. */
  | { readonly cents: number }
  | { readonly boolean: boolean }
  | { readonly string: string }
  | { readonly untyped: string }
  | { readonly dateTime: string }
  | { readonly base64: Uint8Array }
  | { readonly struct: ReadonlyArray<readonly [string, Out]> }
  | { readonly array: ReadonlyArray<Out> };

const mime = (bytes: Uint8Array): string =>
  (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  )
    .map((line) => `${line}\n`)
    .join("");

const write = (value: Out): string => {
  if ("i4" in value) return `<value><i4>${value.i4}</i4></value>`;
  if ("cents" in value)
    return `<value><double>${units(value.cents, ".")}</double></value>`;
  if ("boolean" in value)
    return `<value><boolean>${value.boolean ? 1 : 0}</boolean></value>`;
  if ("string" in value)
    return `<value><string>${escape(value.string)}</string></value>`;
  if ("untyped" in value) return `<value>${escape(value.untyped)}</value>`;
  if ("dateTime" in value)
    return `<value><dateTime.iso8601>${escape(value.dateTime)}</dateTime.iso8601></value>`;
  if ("base64" in value)
    return `<value><base64>${mime(value.base64)}</base64></value>`;
  if ("struct" in value)
    return `<value><struct>\n${value.struct
      .map(
        ([name, member]) =>
          `<member><name>${escape(name)}</name>${write(member)}</member>\n`,
      )
      .join("")}</struct></value>`;
  return `<value><array><data>\n${value.array.map((item) => `${write(item)}\n`).join("")}</data></array></value>`;
};

const document = (body: string): string =>
  `<?xml version="1.0"?>\n<methodResponse>\n${body}</methodResponse>\n`;

const faultBody = (code: number, message: string): string =>
  `<fault>\n${write({
    struct: [
      ["faultCode", { i4: code }],
      ["faultString", { string: message }],
    ],
  })}\n</fault>\n`;

/** What the library answered when a handler's value could not be serialized. */
const internalError = document(
  faultBody(-32603, "server error. internal xml-rpc error"),
);

/** A methodResponse, or the internal-error fault in place of one XML cannot carry. */
const xml = (body: string): Reply => {
  const text = document(body);
  return {
    status: 200,
    lines: [
      ["Content-Type", "text/xml"],
      ["Server", "Frontier/5.1.2-WinNT"],
    ],
    body: firstNonChar(text) === undefined ? text : internalError,
  };
};

export const result = (value: Out): Reply =>
  xml(`<params>\n<param>\n${write(value)}\n</param>\n</params>\n`);

export const fault = (code: number, message: string): Reply =>
  xml(faultBody(code, message));
