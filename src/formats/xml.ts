/**
 * A small, strict XML reader and writer for the consumer code in this suite. It covers what the
 * synthetic backends send: elements, attributes, text, CDATA, comments, processing instructions, the
 * five predefined entities, and numeric character references. Namespace prefixes are kept as part
 * of names; DTDs are refused. Malformed input throws, so a schema transformation can surface it as
 * a decoding failure.
 *
 * Names follow XML 1.0's `Name` production, white space is only space, tab, CR and LF, the XML
 * declaration is checked and allowed only at the start, a processing instruction's target is never
 * `xml`, and a comment never holds `--`. EXT-3 and EXT-4 compare this reader with independent
 * parsers over a corpus of edge cases (`corpus/`).
 *
 * Characters outside XML 1.0's `Char` production (https://www.w3.org/TR/xml/#charsets) are refused,
 * raw or as character references, and the writer refuses to emit them. Line breaks are normalized
 * to LF before parsing (https://www.w3.org/TR/xml/#sec-line-ends) and attribute values as CDATA
 * attributes are (https://www.w3.org/TR/xml/#AVNormalize), so the writer emits a carriage return,
 * and a tab or line feed inside an attribute value, as a character reference.
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

/** XML 1.0 `Char`: tab, LF, CR and U+0020 upwards, without surrogates, U+FFFE and U+FFFF. */
const isChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/** A character outside `Char`. With the `u` flag, a lone surrogate is one such character. */
const notChar =
  /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10ffff}]/u;

const codePoint = (character: string): string =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

const decodeEntities = (text: string): string =>
  text.replace(/&([^;&<]*)(;?)/g, (whole, entity: string, end: string) => {
    if (end !== ";")
      throw new Error(`XML: bare '&' before ${JSON.stringify(entity)}`);
    const numeric = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(entity);
    if (numeric !== null) {
      const code =
        numeric[1] !== undefined
          ? Number.parseInt(numeric[1], 16)
          : Number.parseInt(numeric[2]!, 10);
      if (!isChar(code))
        throw new Error(
          `XML: ${whole} refers to a character XML does not allow`,
        );
      return String.fromCodePoint(code);
    }
    const value = entities[entity];
    if (value === undefined) throw new Error(`XML: unknown entity ${whole}`);
    return value;
  });

/** XML 1.0 `NameStartChar` and `NameChar` (https://www.w3.org/TR/xml/#NT-Name). */
const nameStart =
  "A-Z_a-z:\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}\\u{370}-\\u{37D}\\u{37F}-\\u{1FFF}" +
  "\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}" +
  "\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}";
const nameRest = `${nameStart}\\-.0-9\\u{B7}\\u{300}-\\u{36F}\\u{203F}-\\u{2040}`;
const namePattern = new RegExp(`[${nameStart}][${nameRest}]*`, "uy");

/**
 * The XML declaration (https://www.w3.org/TR/xml/#NT-XMLDecl): a version, then optionally the
 * encoding and `standalone`, in that order. White space is only space, tab and line feed here,
 * because carriage returns are normalized away before parsing.
 */
const declarationPattern =
  /<\?xml[ \t\n]+version[ \t\n]*=[ \t\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(?:"[A-Za-z][\w.-]*"|'[A-Za-z][\w.-]*'))?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\n]*\?>/y;

/** XML's white space, `S`: unlike `\s`, no other Unicode space counts. */
const isSpace = (character: string | undefined): boolean =>
  character === " " || character === "\t" || character === "\n";

/** Parse a document and return its root element. */
export const parse = (input: string): Element => {
  // Line ends are normalized before parsing, so offsets refer to the normalized text.
  const source = input.replace(/\r\n?/g, "\n");
  let index = 0;
  const fail = (message: string): never => {
    throw new Error(`XML: ${message} at offset ${index}`);
  };
  const invalid = notChar.exec(source);
  if (invalid !== null) {
    index = invalid.index;
    fail(`character ${codePoint(invalid[0])} is not allowed in XML`);
  }
  /** Skip white space; whether there was any. */
  const skipSpace = (): boolean => {
    const start = index;
    while (isSpace(source[index])) index++;
    return index > start;
  };
  const readName = (): string => {
    namePattern.lastIndex = index;
    const name = namePattern.exec(source)?.[0];
    if (name === undefined) return fail("expected a name");
    index += name.length;
    return name;
  };
  /** A comment, which may not hold `--` (https://www.w3.org/TR/xml/#NT-Comment). */
  const skipComment = () => {
    const end = source.indexOf("--", index + 4);
    if (end < 0) fail("unterminated comment");
    if (source[end + 2] !== ">") fail("'--' inside a comment");
    index = end + 3;
  };
  /** A processing instruction, whose target is a name other than `xml` in any case. */
  const skipInstruction = () => {
    index += 2;
    const target = readName();
    if (target.toLowerCase() === "xml")
      fail("an XML declaration is allowed only at the start");
    if (!source.startsWith("?>", index) && !isSpace(source[index]))
      fail("expected white space after a processing instruction's target");
    const end = source.indexOf("?>", index);
    if (end < 0) fail("unterminated processing instruction");
    index = end + 2;
  };
  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (source.startsWith("<?", index)) skipInstruction();
      else if (source.startsWith("<!--", index)) skipComment();
      else if (source.startsWith("<!DOCTYPE", index))
        fail("DTDs are not supported");
      else return;
    }
  };
  const readElement = (): Element => {
    if (source[index] !== "<") fail("expected '<'");
    index++;
    const name = readName();
    const attributes: Record<string, string> = {};
    for (;;) {
      const spaced = skipSpace();
      if (source.startsWith("/>", index)) {
        index += 2;
        return { name, attributes, children: [] };
      }
      if (source[index] === ">") {
        index++;
        break;
      }
      if (!spaced) fail("expected white space before an attribute");
      const attribute = readName();
      skipSpace();
      if (source[index] !== "=") fail("expected '='");
      index++;
      skipSpace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail("expected a quoted value");
      const end = source.indexOf(quote!, index + 1);
      if (end < 0) fail("unterminated attribute value");
      // Own properties only: a name such as `constructor` is not already present.
      if (Object.hasOwn(attributes, attribute))
        fail(`duplicate attribute ${attribute}`);
      const raw = source.slice(index + 1, end);
      if (raw.includes("<")) fail("'<' in an attribute value");
      // Literal white space becomes a space; white space written as a reference is kept.
      Object.defineProperty(attributes, attribute, {
        value: decodeEntities(raw.replace(/[\t\n]/g, " ")),
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
        skipComment();
      } else if (source.startsWith("<?", index)) {
        skipInstruction();
      } else if (source[index] === "<") {
        children.push(readElement());
      } else {
        const end = source.indexOf("<", index);
        if (end < 0) fail(`unterminated element <${name}>`);
        const raw = source.slice(index, end);
        if (raw.includes("]]>")) fail("']]>' in character data");
        children.push(decodeEntities(raw));
        index = end;
      }
    }
  };
  // A leading U+FEFF is the byte-order mark a decoder kept, not content
  // (https://www.w3.org/TR/xml/#sec-guessing); anywhere else it is a character.
  if (source.startsWith("\u{FEFF}")) index = 1;
  // `<?xml` followed by white space or `?>` opens the declaration, which only the start may hold.
  if (/^<\?xml(?:[ \t\n]|\?>)/.test(source.slice(index, index + 7))) {
    declarationPattern.lastIndex = index;
    if (!declarationPattern.test(source)) fail("malformed XML declaration");
    index = declarationPattern.lastIndex;
  }
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

/** Refuse what no XML document can carry, rather than write a document no parser accepts. */
const writable = (text: string): string => {
  const invalid = notChar.exec(text);
  if (invalid !== null)
    throw new Error(
      `XML: character ${codePoint(invalid[0])} cannot be written in XML`,
    );
  return text;
};

/** Escape text; a carriage return is referenced so that line-end normalization keeps it. */
const escape = (text: string): string =>
  writable(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;");

/** Escape an attribute value; tabs and line feeds are referenced so normalization keeps them. */
const escapeAttribute = (text: string): string =>
  escape(text).replace(/\t/g, "&#9;").replace(/\n/g, "&#10;");

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
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
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
