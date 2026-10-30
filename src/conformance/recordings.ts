/**
 * Backend conformance with recordings of real software (#32). A test reads a recorded exchange
 * from `recordings/`, sends its request to the backend that imitates that software, over a raw
 * socket and adapted only where the test names the adaptation, and compares the reply with the
 * recorded response.
 *
 * - Values that change with every run, such as dates and nonces, are masked on both sides by
 *   named {@link Mask}s before the comparison.
 * - {@link differences} lists what still differs; each test pins that list, and the service page
 *   and the catalogue explain every entry as a deliberate imitation of older software or as the
 *   suite's HTTP server, so any other difference fails.
 *
 * This is backend-side code: it reaches backends only over HTTP and shares nothing with the
 * consumer side. Node-only, because it reads the recordings from disk and compares raw status and
 * header lines.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { Effect } from "effect";

/** Header lines in order, with their spelling and repetition. */
export type Lines = ReadonlyArray<readonly [string, string]>;

/** A response as it crossed the wire, with chunked framing removed from the body. */
export interface Response {
  readonly status: number;
  readonly reason: string;
  readonly lines: Lines;
  readonly body: Buffer;
}

/** A recorded exchange: the request's exact bytes and the parsed response. */
export interface Recorded {
  readonly request: Buffer;
  readonly response: Response;
}

const recordings = new URL("../../recordings/", import.meta.url);
const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

/** Read one recorded exchange of a set. */
export const recorded = (set: string, name: string): Recorded => {
  const response = parseResponse(
    readFileSync(new URL(`${set}/${name}.response.http`, recordings)),
    true,
  );
  if (response === undefined)
    throw new Error(`${set}/${name}: an incomplete recorded response`);
  return {
    request: readFileSync(new URL(`${set}/${name}.request.http`, recordings)),
    response,
  };
};

/** Read a set's synthetic data file, such as the gateway data both Perl servers serve. */
export const data = (set: string, file: string): unknown =>
  JSON.parse(readFileSync(new URL(`${set}/${file}`, recordings), "utf8"));

const field = (lines: Lines, name: string): ReadonlyArray<string> =>
  lines.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);

/**
 * Parse a complete response, or return undefined while `bytes` holds only part of one. A body
 * framed by neither `Content-Length` nor chunked encoding ends where the bytes end once `closed`.
 */
export const parseResponse = (
  bytes: Buffer,
  closed: boolean,
): Response | undefined => {
  const end = bytes.indexOf(HEAD_END);
  if (end < 0) return undefined;
  const [start = "", ...rest] = bytes
    .subarray(0, end)
    .toString("latin1")
    .split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3}) (.*)$/.exec(start);
  if (status === null) throw new Error(`not a status line: ${start}`);
  const lines: Lines = rest.map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).replace(/^[ \t]+/, "")];
  });
  const code = Number(status[1]);
  const response = (body: Buffer): Response => ({
    status: code,
    reason: status[2]!,
    lines,
    body,
  });
  const framed = bytes.subarray(end + HEAD_END.length);
  if (code === 204 || code === 304 || code < 200)
    return response(Buffer.alloc(0));
  if (
    field(lines, "transfer-encoding").some((value) => /chunked/i.test(value))
  ) {
    const parts: Array<Buffer> = [];
    let at = 0;
    for (;;) {
      const line = framed.indexOf(CRLF, at);
      if (line < 0) return undefined;
      const size = Number.parseInt(
        framed.subarray(at, line).toString("latin1").split(";")[0]!,
        16,
      );
      at = line + CRLF.length;
      if (size === 0)
        return framed.indexOf(CRLF, at) < 0
          ? undefined
          : response(Buffer.concat(parts));
      if (framed.length < at + size + CRLF.length) return undefined;
      parts.push(framed.subarray(at, at + size));
      at += size + CRLF.length;
    }
  }
  const length = field(lines, "content-length")[0];
  if (length !== undefined)
    return framed.length >= Number(length)
      ? response(framed.subarray(0, Number(length)))
      : undefined;
  return closed ? response(framed) : undefined;
};

/**
 * Send a request's exact bytes to a backend over a new connection and read its whole response,
 * without following redirects or interpreting anything.
 */
export const send = (
  origin: string,
  request: Buffer,
): Effect.Effect<Response> =>
  Effect.promise(
    () =>
      new Promise<Response>((resolve, reject) => {
        const { hostname, port } = new URL(origin);
        const chunks: Array<Buffer> = [];
        const socket = connect({ host: hostname, port: Number(port) }, () =>
          socket.write(request),
        );
        const settle = (closed: boolean) => {
          const response = parseResponse(Buffer.concat(chunks), closed);
          if (response === undefined) {
            if (closed) reject(new Error("the connection closed mid-response"));
            return;
          }
          socket.destroy();
          resolve(response);
        };
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          settle(false);
        });
        socket.on("end", () => settle(true));
        socket.on("error", reject);
      }),
  );

/** A request with another request target, for a backend that serves the resource elsewhere. */
export const retarget = (request: Buffer, target: string): Buffer => {
  const line = request.indexOf(CRLF);
  const [method, , version] = request
    .subarray(0, line)
    .toString("latin1")
    .split(" ");
  return Buffer.concat([
    Buffer.from(`${method} ${target} ${version}`, "latin1"),
    request.subarray(line),
  ]);
};

/** A request whose first header line named `name` carries `value` instead. */
export const replaceHeader = (
  request: Buffer,
  name: string,
  value: string,
): Buffer => {
  const end = request.indexOf(HEAD_END);
  const lines = request.subarray(0, end).toString("latin1").split("\r\n");
  const index = lines.findIndex((line) =>
    line.toLowerCase().startsWith(`${name.toLowerCase()}:`),
  );
  if (index < 1) throw new Error(`the request has no ${name} line`);
  lines[index] = `${lines[index]!.slice(0, name.length)}: ${value}`;
  return Buffer.concat([
    Buffer.from(lines.join("\r\n"), "latin1"),
    request.subarray(end),
  ]);
};

/** The value of a request's first header line named `name`. */
export const requestHeader = (
  request: Buffer,
  name: string,
): string | undefined =>
  request
    .subarray(0, request.indexOf(HEAD_END))
    .toString("latin1")
    .split("\r\n")
    .slice(1)
    .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    ?.slice(name.length + 1)
    .trim();

/** Every value of a response header, one per line. */
export const header = (
  response: Response,
  name: string,
): ReadonlyArray<string> => field(response.lines, name.toLowerCase());

/**
 * A named mask for a value that changes with every run. `apply` replaces the value on one side;
 * it throws when the value is missing or not of the stated shape, so a mask never hides a
 * difference in kind.
 */
export interface Mask {
  readonly name: string;
  readonly apply: (response: Response) => Response;
}

/** Mask the part of a header's value that `pattern`'s first group captures, checking its shape. */
export const maskHeader = (
  name: string,
  headerName: string,
  pattern: RegExp,
  shape: RegExp,
): Mask => ({
  name,
  apply: (response) => ({
    ...response,
    lines: response.lines.map(([key, value]) => {
      if (key.toLowerCase() !== headerName.toLowerCase()) return [key, value];
      const match = pattern.exec(value);
      if (match === null || match[1] === undefined)
        throw new Error(`${name}: ${key}: ${value} holds no such value`);
      if (!shape.test(match[1]))
        throw new Error(`${name}: ${match[1]} is not of the stated shape`);
      return [key, value.replace(match[1], `<${name}>`)];
    }),
  }),
});

/** Mask the response body with a transformation applied to both sides. */
export const maskBody = (
  name: string,
  transform: (body: string) => string,
): Mask => ({
  name,
  apply: (response) => ({
    ...response,
    body: Buffer.from(transform(response.body.toString("latin1")), "latin1"),
  }),
});

/** The `Date` of a reply: the time it was written, as an IMF-fixdate. */
export const date: Mask = maskHeader(
  "date",
  "Date",
  /^(.*)$/,
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
);

/** Apply masks to both responses. */
export const masked = (
  responses: readonly [Response, Response],
  masks: ReadonlyArray<Mask>,
): readonly [Response, Response] =>
  [
    masks.reduce((response, mask) => mask.apply(response), responses[0]),
    masks.reduce((response, mask) => mask.apply(response), responses[1]),
  ] as const;

/**
 * What differs between a recorded and an actual response: `status`, `reason`, `header <name>` for
 * a header whose values differ (names compared case-insensitively, absence counting as a value),
 * `spelling <name>` for a header with equal values under a differently spelled name, and `body`.
 * Header order is not compared: HTTP gives it no meaning except among lines of one name, which
 * the values keep.
 */
export const differences = (
  expected: Response,
  actual: Response,
): ReadonlyArray<string> => {
  const found: Array<string> = [];
  if (expected.status !== actual.status) found.push("status");
  if (expected.reason !== actual.reason) found.push("reason");
  const names = new Set(
    [...expected.lines, ...actual.lines].map(([name]) => name.toLowerCase()),
  );
  for (const name of [...names].toSorted()) {
    const values = [expected, actual].map((response) =>
      JSON.stringify(field(response.lines, name)),
    );
    if (values[0] !== values[1]) found.push(`header ${name}`);
    else {
      const spellings = [expected, actual].map((response) =>
        JSON.stringify(
          response.lines
            .filter(([key]) => key.toLowerCase() === name)
            .map(([key]) => key),
        ),
      );
      if (spellings[0] !== spellings[1]) found.push(`spelling ${name}`);
    }
  }
  if (!expected.body.equals(actual.body)) found.push("body");
  return found;
};

/** A parsed XML element: its name and attributes as written, its children, and its source. */
export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  readonly children: ReadonlyArray<XmlElement | XmlText>;
  /** The start tag as written, or the whole empty-element tag. */
  readonly open: string;
  /** The end tag as written; empty for an empty-element tag. */
  readonly close: string;
}

/** Character data, decoded, with its source. */
export interface XmlText {
  readonly text: string;
  readonly raw: string;
}

const isText = (node: XmlElement | XmlText): node is XmlText => "text" in node;

const ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const decodeText = (raw: string): string =>
  raw.replace(/&(#x[0-9A-Fa-f]+|#\d+|\w+);/g, (whole, name: string) => {
    if (name.startsWith("#x"))
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#"))
      return String.fromCodePoint(Number(name.slice(1)));
    const value = ENTITIES[name];
    if (value === undefined) throw new Error(`unknown entity ${whole}`);
    return value;
  });

/**
 * Parse a well-formed XML document of the kinds recorded here: elements, attributes, character
 * data, references, CDATA, comments and processing instructions; no document type declaration.
 * Line ends are kept as written, so a document can be written back from its source slices.
 */
export const parseXml = (source: string): XmlElement => {
  let at = 0;
  const skipMisc = () => {
    for (;;) {
      while (/\s/.test(source[at] ?? "")) at++;
      if (source.startsWith("<?", at)) at = source.indexOf("?>", at) + 2;
      else if (source.startsWith("<!--", at))
        at = source.indexOf("-->", at) + 3;
      else return;
      if (at < 2) throw new Error("unterminated markup");
    }
  };
  const element = (): XmlElement => {
    const open =
      /^<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(
        source.slice(at),
      );
    if (open === null) throw new Error(`expected an element at ${at}`);
    at += open[0].length;
    const attributes = [
      ...(open[2] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
    ].map(
      (match) => [match[1]!, decodeText(match[2] ?? match[3] ?? "")] as const,
    );
    const name = open[1]!;
    if (open[3] === "/")
      return { name, attributes, children: [], open: open[0], close: "" };
    const children: Array<XmlElement | XmlText> = [];
    for (;;) {
      if (at >= source.length) throw new Error(`unterminated <${name}>`);
      const close = new RegExp(`^</${name.replace(/[.]/g, "\\.")}\\s*>`).exec(
        source.slice(at),
      );
      if (close !== null) {
        at += close[0].length;
        return { name, attributes, children, open: open[0], close: close[0] };
      }
      if (source.startsWith("</", at))
        throw new Error(`mismatched end tag in <${name}> at ${at}`);
      if (source.startsWith("<![CDATA[", at)) {
        const end = source.indexOf("]]>", at);
        children.push({
          text: source.slice(at + 9, end),
          raw: source.slice(at, end + 3),
        });
        at = end + 3;
      } else if (source.startsWith("<!--", at)) {
        const end = source.indexOf("-->", at) + 3;
        children.push({ text: "", raw: source.slice(at, end) });
        at = end;
      } else if (source[at] === "<") children.push(element());
      else {
        const end = source.indexOf("<", at);
        const raw = source.slice(at, end < 0 ? source.length : end);
        children.push({ text: decodeText(raw), raw });
        at += raw.length;
      }
    }
  };
  skipMisc();
  const root = element();
  skipMisc();
  if (at !== source.length) throw new Error("content after the root element");
  return root;
};

/** Write an element back exactly as it was parsed, children included. */
export const writeXml = (node: XmlElement): string =>
  node.open +
  node.children
    .map((child) => (isText(child) ? child.raw : writeXml(child)))
    .join("") +
  node.close;

const children = (node: XmlElement): ReadonlyArray<XmlElement> =>
  node.children.filter((child): child is XmlElement => !isText(child));

const textOf = (node: XmlElement): string =>
  node.children
    .filter(isText)
    .map((child) => child.text)
    .join("");

/**
 * An XML-RPC body with every struct's members in name order, each member keeping the white space
 * written after it. Perl writes a struct's members in hash order, which changes with every
 * process; both recorded Perl servers do, and the recordings fixed the hash seed only to make a
 * re-recording reproducible.
 */
export const sortStructMembers = (body: string): string => {
  if (!body.includes("<methodResponse>")) return body;
  const declaration = /^<\?xml[^>]*\?>\s*/.exec(body)?.[0] ?? "";
  const sort = (node: XmlElement): XmlElement => {
    const sorted = node.children.map((child) =>
      isText(child) ? child : sort(child),
    );
    if (node.name !== "struct") return { ...node, children: sorted };
    const leading: Array<XmlElement | XmlText> = [];
    const members: Array<Array<XmlElement | XmlText>> = [];
    for (const child of sorted)
      if (!isText(child)) members.push([child]);
      else if (members.length === 0) leading.push(child);
      else members.at(-1)!.push(child);
    const nameOf = (group: ReadonlyArray<XmlElement | XmlText>) => {
      const name = children(group[0] as XmlElement).find(
        (child) => child.name === "name",
      );
      return name === undefined ? "" : textOf(name);
    };
    const ordered = members.toSorted((left, right) =>
      nameOf(left) < nameOf(right) ? -1 : nameOf(left) > nameOf(right) ? 1 : 0,
    );
    return { ...node, children: [...leading, ...ordered.flat()] };
  };
  const tail = body.slice(declaration.length);
  const root = parseXml(tail);
  const written = writeXml(root);
  return `${declaration}${writeXml(sort(root))}${tail.slice(tail.indexOf(written) + written.length)}`;
};

/** An XML-RPC value as data: its type and decoded content, for comparing two spellings. */
export type XmlRpcValue =
  | { readonly untyped: string }
  | { readonly int: string }
  | { readonly double: string }
  | { readonly boolean: string }
  | { readonly string: string }
  | { readonly dateTime: string }
  | { readonly base64: string }
  | { readonly struct: ReadonlyArray<readonly [string, XmlRpcValue]> }
  | { readonly array: ReadonlyArray<XmlRpcValue> };

const xmlRpcValue = (value: XmlElement): XmlRpcValue => {
  const [typed] = children(value);
  if (typed === undefined) return { untyped: textOf(value) };
  switch (typed.name) {
    case "i4":
    case "int":
      return { int: textOf(typed) };
    case "double":
      return { double: textOf(typed) };
    case "boolean":
      return { boolean: textOf(typed) };
    case "string":
      return { string: textOf(typed) };
    case "dateTime.iso8601":
      return { dateTime: textOf(typed) };
    case "base64":
      return { base64: textOf(typed).replace(/\s/g, "") };
    case "struct":
      return {
        struct: children(typed)
          .map((member) => {
            const [name, inner] = children(member);
            return [textOf(name!), xmlRpcValue(inner!)] as const;
          })
          .toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
      };
    case "array":
      return { array: children(children(typed)[0]!).map(xmlRpcValue) };
    default:
      throw new Error(`unknown XML-RPC type <${typed.name}>`);
  }
};

/**
 * The values of an XML-RPC response, whatever their spelling: `<i4>` and `<int>` are one type,
 * text is decoded, base64 loses its line breaks, and struct members are in name order.
 */
export const xmlRpcValues = (
  body: Buffer,
):
  | { readonly params: ReadonlyArray<XmlRpcValue> }
  | { readonly fault: XmlRpcValue } => {
  const root = parseXml(body.toString("utf8"));
  const [part] = children(root);
  if (part?.name === "fault") return { fault: xmlRpcValue(children(part)[0]!) };
  return {
    params: children(part!).map((param) => xmlRpcValue(children(param)[0]!)),
  };
};

/** An element as namespaces see it: names resolved, prefixes and namespace declarations dropped. */
export interface Infoset {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly content: string | ReadonlyArray<Infoset>;
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** A qualified name as `{namespace}local`; an unprefixed attribute is in no namespace. */
const resolve = (
  name: string,
  scope: ReadonlyMap<string, string>,
  attribute: boolean,
): string => {
  const colon = name.indexOf(":");
  if (colon < 0) return attribute ? name : `{${scope.get("") ?? ""}}${name}`;
  const prefix = name.slice(0, colon);
  const namespace = prefix === "xml" ? XML_NAMESPACE : scope.get(prefix);
  if (namespace === undefined) throw new Error(`unbound prefix ${prefix}`);
  return `{${namespace}}${name.slice(colon + 1)}`;
};

/**
 * An XML document as namespaces see it, for comparing two writers: element and attribute names
 * as `{namespace}local`, white space between elements dropped, and the text of the elements
 * `qualified` accepts, which hold a qualified name, resolved the same way.
 */
export const infoset = (
  body: Buffer,
  qualified: (name: string) => boolean,
): Infoset => {
  const head = body.subarray(0, 100).toString("latin1");
  const latin1 = /encoding\s*=\s*["']iso-8859-1["']/i.test(head);
  const root = parseXml(body.toString(latin1 ? "latin1" : "utf8"));
  const walk = (
    node: XmlElement,
    outer: ReadonlyMap<string, string>,
  ): Infoset => {
    const scope = new Map(outer);
    for (const [key, value] of node.attributes)
      if (key === "xmlns") scope.set("", value);
      else if (key.startsWith("xmlns:")) scope.set(key.slice(6), value);
    const name = resolve(node.name, scope, false);
    const attributes = Object.fromEntries(
      node.attributes
        .filter(([key]) => key !== "xmlns" && !key.startsWith("xmlns:"))
        .map(([key, value]) => [resolve(key, scope, true), value] as const),
    );
    const elements = children(node);
    if (elements.length > 0)
      return {
        name,
        attributes,
        content: elements.map((child) => walk(child, scope)),
      };
    const text = textOf(node);
    return {
      name,
      attributes,
      content: qualified(name) ? resolve(text.trim(), scope, false) : text,
    };
  };
  return walk(root, new Map());
};
