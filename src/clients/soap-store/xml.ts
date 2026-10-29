import {
  Effect,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as Xml from "../../formats/xml.js";
import { XmlTextFromBytes } from "../../values/soap-store.js";

/**
 * Schema plumbing between XML trees from `src/formats/xml.ts` and the store's contracts: an element
 * schema, text and byte codecs for whole documents, namespace resolution, and strict field access.
 */

const isElement = (value: unknown): value is Xml.Element =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { name?: unknown }).name === "string" &&
  Array.isArray((value as { children?: unknown }).children) &&
  typeof (value as { attributes?: unknown }).attributes === "object";

/** A parsed XML element. */
export const Element = Schema.declare(isElement, {
  expected: "an XML element",
});

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Run a throwing function, turning an exception into a schema issue. */
export const attempt = <A>(
  f: () => A,
  input: unknown,
  options: SchemaAST.ParseOptions,
): Effect.Effect<A, SchemaIssue.Issue> =>
  Effect.try({
    try: f,
    catch: (cause) =>
      new SchemaIssue.InvalidValue(
        { message: messageOf(cause) },
        input,
        options,
      ),
  });

/**
 * A document's text and its root element. Encoding writes a UTF-8 declaration and the compact
 * serialization, so whitespace between elements is not reproduced.
 */
export const ElementFromText = Schema.String.pipe(
  Schema.decodeTo(
    Element,
    SchemaTransformation.transformEffect({
      decode: (text, options) => attempt(() => Xml.parse(text), text, options),
      encode: (element, options) =>
        attempt(
          () =>
            `<?xml version="1.0" encoding="utf-8"?>${Xml.serialize(element)}`,
          element,
          options,
        ),
    }),
  ),
);

/** A document's bytes, decoded in the encoding its declaration names, and its root element. */
export const ElementFromBytes = XmlTextFromBytes.pipe(
  Schema.decodeTo(ElementFromText),
);

/**
 * A reversible mapping between an element and a schema's encoded form, written as two functions
 * that throw on anything unexpected. A thrown error becomes a schema issue.
 */
export const mapping = <To extends Schema.Top>(
  to: To,
  functions: {
    readonly decode: (element: Xml.Element) => To["Encoded"];
    readonly encode: (value: To["Encoded"]) => Xml.Element;
  },
) =>
  Element.pipe(
    Schema.decodeTo(
      to,
      SchemaTransformation.transformEffect<To["Encoded"], Xml.Element>({
        decode: (element, options) =>
          attempt(() => functions.decode(element), element, options),
        encode: (value, options) =>
          attempt(() => functions.encode(value), value, options),
      }),
    ),
  );

/** Prefix-to-URI bindings in scope; `""` is the default namespace. */
export type Scope = ReadonlyMap<string, string>;

/** The bindings in scope inside `element`, given those of its parent. */
export const enter = (
  element: Xml.Element,
  parent: Scope = new Map(),
): Scope => {
  const scope = new Map(parent);
  for (const [key, value] of Object.entries(element.attributes)) {
    if (key === "xmlns") scope.set("", value);
    else if (key.startsWith("xmlns:")) scope.set(key.slice(6), value);
  }
  return scope;
};

const prefixOf = (name: string): string => {
  const colon = name.indexOf(":");
  return colon < 0 ? "" : name.slice(0, colon);
};

/** The namespace URI of a prefixed name in a scope. */
export const resolve = (name: string, scope: Scope): string | undefined =>
  scope.get(prefixOf(name));

/** Throw unless `element` is `{namespace}local` in its own scope. */
export const expect = (
  element: Xml.Element,
  scope: Scope,
  namespace: string,
  local: string,
): void => {
  const actual = resolve(element.name, scope);
  if (Xml.localName(element.name) !== local || actual !== namespace)
    throw new Error(
      `expected {${namespace}}${local}, found {${actual ?? ""}}${Xml.localName(element.name)}`,
    );
};

/**
 * Hand a child element its prefix binding when an ancestor declared it, so the child can be
 * checked on its own. A child that declares its own binding is returned unchanged.
 */
export const detach = (element: Xml.Element, scope: Scope): Xml.Element => {
  const prefix = prefixOf(element.name);
  const key = prefix === "" ? "xmlns" : `xmlns:${prefix}`;
  const uri = scope.get(prefix);
  return key in element.attributes || uri === undefined
    ? element
    : { ...element, attributes: { ...element.attributes, [key]: uri } };
};

/** The child elements, refusing text other than whitespace between them. */
export const childElements = (
  element: Xml.Element,
): ReadonlyArray<Xml.Element> => {
  if (
    element.children.some(
      (child) => typeof child === "string" && child.trim() !== "",
    )
  )
    throw new Error(`unexpected text in <${element.name}>`);
  return Xml.elements(element);
};

/**
 * The child elements of `element` by local name, refusing missing required ones, repeated ones
 * and any other child.
 */
export const fields = <
  const Required extends string,
  const Optional extends string = never,
>(
  element: Xml.Element,
  required: ReadonlyArray<Required>,
  optional: ReadonlyArray<Optional> = [],
): Readonly<Record<Required, Xml.Element>> &
  Partial<Readonly<Record<Optional, Xml.Element>>> => {
  const found: Record<string, Xml.Element> = {};
  for (const child of childElements(element)) {
    const local = Xml.localName(child.name);
    if (
      !(required as ReadonlyArray<string>).includes(local) &&
      !(optional as ReadonlyArray<string>).includes(local)
    )
      throw new Error(`unexpected <${child.name}> in <${element.name}>`);
    if (local in found)
      throw new Error(`repeated <${local}> in <${element.name}>`);
    found[local] = child;
  }
  for (const name of required)
    if (!(name in found))
      throw new Error(`missing <${name}> in <${element.name}>`);
  return found as Readonly<Record<Required, Xml.Element>> &
    Partial<Readonly<Record<Optional, Xml.Element>>>;
};

/** The text of a leaf element; nested elements are refused. */
export const text = (element: Xml.Element): string => {
  if (Xml.elements(element).length > 0)
    throw new Error(`<${element.name}> must hold text only`);
  return Xml.textOf(element);
};

/** A non-negative integer without leading zeros or signs. */
export const count = (element: Xml.Element): number => {
  const value = text(element);
  if (!/^(0|[1-9]\d{0,14})$/.test(value))
    throw new Error(
      `<${element.name}> is not a non-negative integer: ${value}`,
    );
  return Number(value);
};

/** A leaf element. An empty value has no text child, as parsing `<a></a>` gives. */
export const leaf = (name: string, value: string): Xml.Element =>
  value === "" ? Xml.element(name) : Xml.element(name, {}, value);
