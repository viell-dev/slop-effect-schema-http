/**
 * A small, strict XML reader and writer for the consumer code in this suite. It covers what the
 * synthetic backends send: elements, attributes, text, CDATA, comments, processing instructions, the
 * five predefined entities, and numeric character references. Namespace prefixes are kept as part
 * of names; DTDs are refused. Malformed input throws, so a schema transformation can surface it as
 * a decoding failure.
 */

export interface Element {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: ReadonlyArray<Node>;
}

export type Node = Element | string;

const entities: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (_, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#"))
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    const value = entities[entity];
    if (value === undefined) throw new Error(`unknown entity &${entity};`);
    return value;
  });

const nameChar = /[\w:.-]/;

/** Parse a document and return its root element. */
export const parse = (source: string): Element => {
  let index = 0;
  const fail = (message: string): never => {
    throw new Error(`XML: ${message} at offset ${index}`);
  };
  const skipSpace = () => {
    while (index < source.length && /\s/.test(source[index]!)) index++;
  };
  const readName = (): string => {
    const start = index;
    while (index < source.length && nameChar.test(source[index]!)) index++;
    if (start === index) fail("expected a name");
    return source.slice(start, index);
  };
  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (source.startsWith("<?", index)) {
        const end = source.indexOf("?>", index);
        if (end < 0) fail("unterminated processing instruction");
        index = end + 2;
      } else if (source.startsWith("<!--", index)) {
        const end = source.indexOf("-->", index);
        if (end < 0) fail("unterminated comment");
        index = end + 3;
      } else if (source.startsWith("<!DOCTYPE", index)) {
        fail("DTDs are not supported");
      } else return;
    }
  };
  const readElement = (): Element => {
    if (source[index] !== "<") fail("expected '<'");
    index++;
    const name = readName();
    const attributes: Record<string, string> = {};
    for (;;) {
      skipSpace();
      if (source.startsWith("/>", index)) {
        index += 2;
        return { name, attributes, children: [] };
      }
      if (source[index] === ">") {
        index++;
        break;
      }
      const attribute = readName();
      skipSpace();
      if (source[index] !== "=") fail("expected '='");
      index++;
      skipSpace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail("expected a quoted value");
      const end = source.indexOf(quote!, index + 1);
      if (end < 0) fail("unterminated attribute value");
      if (attribute in attributes) fail(`duplicate attribute ${attribute}`);
      attributes[attribute] = decodeEntities(source.slice(index + 1, end));
      index = end + 1;
    }
    const children: Array<Node> = [];
    for (;;) {
      if (index >= source.length) fail(`unterminated element <${name}>`);
      if (source.startsWith("</", index)) {
        index += 2;
        const closing = readName();
        if (closing !== name) fail(`expected </${name}>, found </${closing}>`);
        skipSpace();
        if (source[index] !== ">") fail("expected '>'");
        index++;
        return { name, attributes, children };
      }
      if (source.startsWith("<![CDATA[", index)) {
        const end = source.indexOf("]]>", index);
        if (end < 0) fail("unterminated CDATA section");
        children.push(source.slice(index + 9, end));
        index = end + 3;
      } else if (source.startsWith("<!--", index)) {
        const end = source.indexOf("-->", index);
        if (end < 0) fail("unterminated comment");
        index = end + 3;
      } else if (source.startsWith("<?", index)) {
        const end = source.indexOf("?>", index);
        if (end < 0) fail("unterminated processing instruction");
        index = end + 2;
      } else if (source[index] === "<") {
        children.push(readElement());
      } else {
        const end = source.indexOf("<", index);
        if (end < 0) fail(`unterminated element <${name}>`);
        children.push(decodeEntities(source.slice(index, end)));
        index = end;
      }
    }
  };
  skipMisc();
  const root = readElement();
  skipMisc();
  if (index !== source.length) fail("content after the root element");
  return root;
};

/** The local part of a possibly prefixed name. */
export const localName = (name: string): string =>
  name.slice(name.indexOf(":") + 1);

/** Child elements, optionally only those with the given local name. */
export const elements = (
  element: Element,
  local?: string,
): ReadonlyArray<Element> =>
  element.children.filter(
    (child): child is Element =>
      typeof child !== "string" &&
      (local === undefined || localName(child.name) === local),
  );

/** The single child element with the given local name; throws when absent or repeated. */
export const child = (element: Element, local: string): Element => {
  const found = elements(element, local);
  if (found.length !== 1)
    throw new Error(
      `XML: expected one <${local}> in <${element.name}>, found ${found.length}`,
    );
  return found[0]!;
};

/** The concatenated text of an element's direct text and CDATA children. */
export const textOf = (element: Element): string =>
  element.children.filter((node) => typeof node === "string").join("");

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Build an element. */
export const element = (
  name: string,
  attributes: Readonly<Record<string, string>> = {},
  ...children: ReadonlyArray<Node>
): Element => ({ name, attributes, children });

/** Serialize an element, escaping text and attribute values. */
export const serialize = (node: Node): string => {
  if (typeof node === "string") return escape(node);
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escape(value)}"`)
    .join("");
  return node.children.length === 0
    ? `<${node.name}${attributes}/>`
    : `<${node.name}${attributes}>${node.children.map(serialize).join("")}</${node.name}>`;
};

/** The encoding named in a document's XML declaration, if any. */
export const declaredEncoding = (bytes: Uint8Array): string | undefined => {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  return /^<\?xml[^>]*\bencoding=["']([\w.-]+)["']/.exec(head)?.[1];
};
