/**
 * The document store's own XML handling: a small reader for request envelopes and PROPFIND bodies,
 * string templates for replies, and the Latin-1 writer of the 2003 platform. It shares nothing with
 * the consumer's XML helper; the store was never written with a client library in mind.
 */

export class XmlError extends Error {}

/** A parsed element with its in-scope namespace bindings (prefix to URI, `""` for the default). */
export interface Node {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: ReadonlyArray<Node | string>;
  readonly namespaces: ReadonlyMap<string, string>;
}

const predefined: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const unescape = (text: string): string =>
  text.replace(/&([^;&\s]*);?/g, (whole, entity: string) => {
    if (!whole.endsWith(";")) throw new XmlError(`bare '&' in ${text}`);
    const numeric = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(entity);
    if (numeric !== null)
      return String.fromCodePoint(
        numeric[1] !== undefined
          ? Number.parseInt(numeric[1], 16)
          : Number.parseInt(numeric[2]!, 10),
      );
    const value = predefined[entity];
    if (value === undefined) throw new XmlError(`unknown entity &${entity};`);
    return value;
  });

const nameSyntax = "[A-Za-z_][\\w.:-]*";
const token = new RegExp(
  [
    "<!--[\\s\\S]*?-->",
    "<\\?[\\s\\S]*?\\?>",
    "<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>",
    `</(${nameSyntax})\\s*>`,
    `<(${nameSyntax})((?:\\s+${nameSyntax}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`,
    "([^<]+)",
  ].join("|"),
  "y",
);
const attribute = new RegExp(
  `(${nameSyntax})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`,
  "g",
);

interface Open {
  readonly name: string;
  readonly attributes: Map<string, string>;
  readonly children: Array<Node | string>;
  readonly namespaces: Map<string, string>;
}

/** Parse a whole document; DTDs, stray text and unbalanced tags throw {@link XmlError}. */
export const parse = (source: string): Node => {
  const stack: Array<Open> = [];
  let root: Node | undefined;
  token.lastIndex = 0;
  while (token.lastIndex < source.length) {
    const offset = token.lastIndex;
    const match = token.exec(source);
    if (match === null) throw new XmlError(`unexpected markup at ${offset}`);
    const [whole, cdata, closing, opening, attributes, selfClosing, text] =
      match;
    const parent = stack.at(-1);
    if (whole.startsWith("<!--") || whole.startsWith("<?")) continue;
    if (text !== undefined || cdata !== undefined) {
      if (parent === undefined) {
        if (text !== undefined && text.trim() === "") continue;
        throw new XmlError(`text outside the root element at ${offset}`);
      }
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
      map.set(key!, unescape(double ?? single ?? ""));
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

/** Escape text for element content or a double-quoted attribute value. */
export const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** An element from already-serialized children. */
export const tag = (
  element: string,
  attributes: Readonly<Record<string, string>> = {},
  ...children: ReadonlyArray<string>
): string => {
  const rendered = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escape(value)}"`)
    .join("");
  return children.length === 0
    ? `<${element}${rendered}/>`
    : `<${element}${rendered}>${children.join("")}</${element}>`;
};

/** An element holding escaped text. */
export const leaf = (element: string, value: string): string =>
  `<${element}>${escape(value)}</${element}>`;

/**
 * Encode as ISO-8859-1 the way the 2003 platform's writer does: every character above U+00FF
 * becomes a numeric character reference, which is legal in the element content it writes.
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
