/**
 * The document store's own XML handling: a small reader for request envelopes and PROPFIND bodies,
 * string templates for replies, and the Latin-1 writer of the 2003 platform. It shares nothing with
 * the consumer's XML helper; the store was never written with a client library in mind. The reader
 * and the writer follow the XML rules in the service page; the writer throws where the reader
 * would refuse.
 *
 * Service documentation: services/soap-store.md
 */

export class XmlError extends Error {}

/** Whether a code point is an XML 1.0 `Char`. */
const legal = (code: number): boolean =>
  code < 0x20
    ? code === 0x09 || code === 0x0a || code === 0x0d
    : code <= 0xd7ff ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);

/** Throw at the first code point that is not a `Char`; a lone surrogate is its own code point. */
const requireLegal = (text: string, doing: string): void => {
  let offset = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (!legal(code))
      throw new XmlError(
        `${doing}: U+${code.toString(16).toUpperCase().padStart(4, "0")} at ${offset} is not an XML character`,
      );
    offset += character.length;
  }
};

/** A parsed element with its in-scope namespace bindings (prefix to URI, `""` for the default). */
export interface Node {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: ReadonlyArray<Node | string>;
  readonly namespaces: ReadonlyMap<string, string>;
}

/** The five predefined entities; no other is declared, since the store reads no DTD. */
const predefined: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

const unescape = (text: string): string =>
  text.replace(/&([^;&\s]*);?/g, (whole, entity: string) => {
    if (!whole.endsWith(";")) throw new XmlError(`bare '&' in ${text}`);
    const numeric = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(entity);
    if (numeric !== null) {
      const code =
        numeric[1] !== undefined
          ? Number.parseInt(numeric[1], 16)
          : Number.parseInt(numeric[2]!, 10);
      if (!legal(code))
        throw new XmlError(`${whole} does not reference an XML character`);
      return String.fromCodePoint(code);
    }
    const value = predefined.get(entity);
    if (value === undefined) throw new XmlError(`unknown entity &${entity};`);
    return value;
  });

/**
 * XML white space, `S` ([3]): space, tab, CR and LF, and no other Unicode space. No CR is left
 * once line ends are normalized.
 */
const space = "[ \\t\\n]";
const blank = new RegExp(`^${space}*$`);

/** `NameStartChar` ([4]) and `NameChar` ([4a]), as the contents of a `u`-flag character class. */
const nameStart =
  ":A-Z_a-z\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}\\u{370}-\\u{37D}\\u{37F}-\\u{1FFF}" +
  "\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}" +
  "\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}";
const nameChar = `${nameStart}\\-.0-9\\u{B7}\\u{300}-\\u{36F}\\u{203F}-\\u{2040}`;
const nameSyntax = `[${nameStart}][${nameChar}]*`;

const token = new RegExp(
  [
    "<!--([\\s\\S]*?)-->",
    "<\\?([\\s\\S]*?)\\?>",
    "<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>",
    `</(${nameSyntax})${space}*>`,
    `<(${nameSyntax})((?:${space}+${nameSyntax}${space}*=${space}*(?:"[^"<]*"|'[^'<]*'))*)${space}*(/?)>`,
    "([^<]+)",
  ].join("|"),
  "uy",
);
const attribute = new RegExp(
  `(${nameSyntax})${space}*=${space}*(?:"([^"<]*)"|'([^'<]*)')`,
  "gu",
);

/** A processing instruction's target and the data after it ([16] PI, [17] PITarget). */
const instruction = new RegExp(`^(${nameSyntax})(?:${space}[\\s\\S]*)?$`, "u");

/** The XML declaration's content after `<?` ([23] XMLDecl to [26] VersionNum, [32] SDDecl). */
const xmlDeclaration = new RegExp(
  [
    `^xml${space}+version${space}*=${space}*(?:"1\\.[0-9]+"|'1\\.[0-9]+')`,
    `(?:${space}+encoding${space}*=${space}*(?:"[A-Za-z][\\w.-]*"|'[A-Za-z][\\w.-]*'))?`,
    `(?:${space}+standalone${space}*=${space}*(?:"(?:yes|no)"|'(?:yes|no)'))?${space}*$`,
  ].join(""),
);

interface Open {
  readonly name: string;
  readonly attributes: Map<string, string>;
  readonly children: Array<Node | string>;
  readonly namespaces: Map<string, string>;
}

/**
 * Parse a whole document; DTDs, stray text, unbalanced tags and anything else XML 1.0 calls
 * malformed throw {@link XmlError}. Offsets refer to the text after line-end normalization.
 */
export const parse = (document: string): Node => {
  const source = document.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  requireLegal(source, "parse");
  const stack: Array<Open> = [];
  let root: Node | undefined;
  token.lastIndex = 0;
  while (token.lastIndex < source.length) {
    const offset = token.lastIndex;
    const match = token.exec(source);
    if (match === null)
      throw new XmlError(
        source.startsWith("<!DOCTYPE", offset)
          ? `a document type declaration at ${offset}: the store reads no DTD`
          : `unexpected markup at ${offset}`,
      );
    const [
      whole,
      comment,
      pi,
      cdata,
      closing,
      opening,
      attributes,
      selfClosing,
      text,
    ] = match;
    const parent = stack.at(-1);
    if (comment !== undefined) {
      if (comment.includes("--") || comment.endsWith("-"))
        throw new XmlError(`'--' inside a comment at ${offset}`);
      continue;
    }
    if (pi !== undefined) {
      const target = instruction.exec(pi)?.[1];
      if (target === undefined)
        throw new XmlError(
          `a processing instruction without a target, or without white space after it, at ${offset}`,
        );
      if (/^xml$/i.test(target)) {
        // Only the XML declaration may use the name, and only at the very start.
        if (offset !== 0 || target !== "xml")
          throw new XmlError(`a misplaced XML declaration at ${offset}`);
        if (!xmlDeclaration.test(pi))
          throw new XmlError(`a malformed XML declaration: ${whole}`);
      }
      continue;
    }
    if (text !== undefined || cdata !== undefined) {
      if (parent === undefined) {
        if (text !== undefined && blank.test(text)) continue;
        throw new XmlError(`text outside the root element at ${offset}`);
      }
      if (text?.includes("]]>") === true)
        throw new XmlError(`']]>' in character data at ${offset}`);
      parent.children.push(cdata ?? unescape(text!));
      continue;
    }
    if (closing !== undefined) {
      const open = stack.pop();
      if (open?.name !== closing)
        throw new XmlError(`unexpected </${closing}> at ${offset}`);
      const done: Node = open;
      if (stack.length === 0) root = done;
      else stack.at(-1)!.children.push(done);
      continue;
    }
    if (root !== undefined) throw new XmlError("content after the root");
    const map = new Map<string, string>();
    for (const [, key, double, single] of attributes!.matchAll(attribute)) {
      if (map.has(key!)) throw new XmlError(`duplicate attribute ${key}`);
      const literal = (double ?? single ?? "")
        .replaceAll("\t", " ")
        .replaceAll("\n", " ");
      map.set(key!, unescape(literal));
    }
    const namespaces = new Map(parent?.namespaces ?? []);
    for (const [key, value] of map) {
      if (key === "xmlns") namespaces.set("", value);
      else if (key.startsWith("xmlns:")) namespaces.set(key.slice(6), value);
    }
    const open: Open = {
      name: opening!,
      attributes: map,
      children: [],
      namespaces,
    };
    if (selfClosing === "/") {
      if (parent === undefined) root = open;
      else parent.children.push(open);
    } else stack.push(open);
  }
  if (stack.length > 0 || root === undefined)
    throw new XmlError("unterminated document");
  return root;
};

/** The local part of an element name. */
export const local = (node: Node): string =>
  node.name.slice(node.name.indexOf(":") + 1);

/** The namespace URI of an element, from its prefix and the bindings in scope. */
export const namespace = (node: Node): string | undefined => {
  const colon = node.name.indexOf(":");
  return node.namespaces.get(colon < 0 ? "" : node.name.slice(0, colon));
};

/** Child elements, ignoring text. */
export const elements = (node: Node): ReadonlyArray<Node> =>
  node.children.filter((child): child is Node => typeof child !== "string");

/** The first child element with the given local name. */
export const find = (node: Node, name: string): Node | undefined =>
  elements(node).find((child) => local(child) === name);

/** The text content of an element's direct text children. */
export const text = (node: Node): string =>
  node.children.filter((child) => typeof child === "string").join("");

/**
 * Escape text for element content. A carriage return is written as a reference, which survives
 * line-end normalization; a character XML does not allow throws {@link XmlError}.
 */
export const escape = (value: string): string => {
  requireLegal(value, "write");
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#xD;");
};

/** Escape a double-quoted attribute value, referencing the white space normalization would change. */
const escapeAttribute = (value: string): string =>
  escape(value).replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;");

/** An element from already-serialized children. */
export const tag = (
  element: string,
  attributes: Readonly<Record<string, string>> = {},
  ...children: ReadonlyArray<string>
): string => {
  const rendered = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
  return children.length === 0
    ? `<${element}${rendered}/>`
    : `<${element}${rendered}>${children.join("")}</${element}>`;
};

/** An element holding escaped text. */
export const leaf = (element: string, value: string): string =>
  `<${element}>${escape(value)}</${element}>`;

/**
 * Encode as ISO-8859-1, with every character above U+00FF as a numeric character reference, which
 * is legal in the element content it writes.
 */
export const latin1 = (document: string): Uint8Array => {
  let output = "";
  for (const character of document) {
    const code = character.codePointAt(0)!;
    output += code > 0xff ? `&#${code};` : character;
  }
  return new Uint8Array(Buffer.from(output, "latin1"));
};

/** The encoding named in an XML declaration at the start of `bytes`. */
export const declared = (bytes: Uint8Array): string | undefined =>
  /^<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(
    Buffer.from(bytes.subarray(0, 120)).toString("latin1"),
  )?.[1];

/** Decode request bytes by charset label; unknown labels and invalid bytes give `undefined`. */
export const decode = (
  bytes: Uint8Array,
  label: string,
): string | undefined => {
  const normalized = label.toLowerCase();
  if (normalized === "utf-8" || normalized === "utf8") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  if (normalized === "iso-8859-1" || normalized === "latin1")
    return Buffer.from(bytes).toString("latin1");
  return undefined;
};
