/**
 * Independent XML 1.0 parsers, to check the suite's own readers against (EXT-3, EXT-4). The suite
 * wrote both its consumer reader (`xml.ts`) and each backend's reader, so a mistake they share
 * passes every round trip; these parsers have other authors.
 *
 * - In Node, [saxes](https://github.com/lddubeau/saxes), a non-validating parser that aims to
 *   report every well-formedness error of XML 1.0 fifth edition, and the XML parser of jsdom.
 * - In the browser, Chromium's `DOMParser`, which is libxml2.
 *
 * Each reads a document into the tree shape of `Xml.parse`, normalized the same way for both:
 * qualified names as written, decoded attribute values, and text and CDATA joined into one string
 * between elements, with comments and processing instructions left out.
 */
import { SaxesParser } from "./saxes.js";
import type * as Xml from "./xml.js";

/** A parser's reading of one document: its root element, or the error that refused it. */
export type Reading =
  | { readonly accepted: true; readonly root: Xml.Element }
  | { readonly accepted: false; readonly error: string };

export interface IndependentParser {
  /** The key a corpus case uses to record a disagreement with this parser. */
  readonly key: "saxes" | "DOMParser";
  /** A name for test titles and reports. */
  readonly name: string;
  readonly read: (text: string) => Reading;
}

/** Join adjacent text and drop empty text, so readers that split text differently compare equal. */
export const normalize = (element: Xml.Element): Xml.Element => {
  const children: Array<Xml.Node> = [];
  for (const child of element.children) {
    if (typeof child !== "string") children.push(normalize(child));
    else if (child === "") continue;
    else if (typeof children.at(-1) === "string")
      children[children.length - 1] += child;
    else children.push(child);
  }
  return { name: element.name, attributes: element.attributes, children };
};

/** An attribute map that keeps names such as `__proto__` and `constructor` as own properties. */
const attributeMap = (
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, string>> => {
  const map: Record<string, string> = {};
  for (const [name, value] of entries)
    Object.defineProperty(map, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return map;
};

interface Building {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: Array<Xml.Node>;
}

/** saxes without namespace processing, so it judges XML 1.0 alone, as `Xml.parse` does. */
export const saxes: IndependentParser = {
  key: "saxes",
  name: "saxes",
  read: (text) => {
    const parser = new SaxesParser({ xmlns: false });
    const stack: Array<Building> = [];
    let root: Building | undefined;
    let error: string | undefined;
    parser.on("error", (cause) => {
      error ??= cause.message;
    });
    parser.on("opentag", (tag) => {
      const element: Building = {
        name: tag.name,
        attributes: attributeMap(Object.entries(tag.attributes)),
        children: [],
      };
      stack.at(-1)?.children.push(element);
      root ??= element;
      stack.push(element);
    });
    parser.on("closetag", () => {
      stack.pop();
    });
    const characters = (data: string) => {
      stack.at(-1)?.children.push(data);
    };
    parser.on("text", characters);
    parser.on("cdata", characters);
    try {
      parser.write(text).close();
    } catch (cause) {
      error ??= String(cause);
    }
    if (error !== undefined) return { accepted: false, error };
    if (root === undefined) return { accepted: false, error: "no root" };
    return { accepted: true, root: normalize(root) };
  },
};

const fromDom = (element: Element): Xml.Element => {
  const children: Array<Xml.Node> = [];
  for (const node of element.childNodes)
    if (node.nodeType === Node.ELEMENT_NODE)
      children.push(fromDom(node as Element));
    else if (
      node.nodeType === Node.TEXT_NODE ||
      node.nodeType === Node.CDATA_SECTION_NODE
    )
      children.push((node as CharacterData).data);
  return normalize({
    name: element.nodeName,
    attributes: attributeMap(
      Array.from(element.attributes, (attribute) => [
        attribute.name,
        attribute.value,
      ]),
    ),
    children,
  });
};

/**
 * Chromium's `DOMParser`, in the browser lane only. A document that is not well-formed yields a
 * `parsererror` element instead of the tree.
 */
export const domParser: IndependentParser = {
  key: "DOMParser",
  name: "Chromium's DOMParser",
  read: (text) => {
    const document = new DOMParser().parseFromString(text, "application/xml");
    const error = document.getElementsByTagName("parsererror")[0];
    if (error !== undefined)
      return { accepted: false, error: error.textContent ?? "parsererror" };
    return { accepted: true, root: fromDom(document.documentElement) };
  },
};
