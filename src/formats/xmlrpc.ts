/**
 * XML-RPC for consumer code, built on the suite's XML reader. The wire form is parsed into a tree
 * that keeps each scalar's type element and its lexical text verbatim, so value conventions are
 * applied by schemas rather than by a parser's guess, and a decoded tree serializes back to the
 * same values. An untyped `<value>text</value>` is a plain string, kept distinct from a typed
 * `<string>`. Schemas below unwrap the tree into application values.
 */
import {
  Effect,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as Xml from "./xml.js";

/** One XML-RPC value as the wire carries it. */
export type Value =
  | string
  | { readonly i4: string }
  | { readonly int: string }
  | { readonly double: string }
  | { readonly boolean: string }
  | { readonly string: string }
  | { readonly "dateTime.iso8601": string }
  | { readonly base64: string }
  | { readonly struct: { readonly [name: string]: Value } }
  | { readonly array: ReadonlyArray<Value> };

export type MethodResponse =
  { readonly params: readonly [Value] } | { readonly fault: Value };

export interface MethodCall {
  readonly methodName: string;
  readonly params: ReadonlyArray<Value>;
}

const scalars = [
  "i4",
  "int",
  "double",
  "boolean",
  "string",
  "dateTime.iso8601",
  "base64",
] as const;

const fail = (message: string): never => {
  throw new Error(`XML-RPC: ${message}`);
};

/** Child elements, refusing any non-whitespace text between them. */
const only = (element: Xml.Element): ReadonlyArray<Xml.Element> => {
  if (
    element.children.some(
      (child) => typeof child === "string" && child.trim() !== "",
    )
  )
    fail(`unexpected text in <${element.name}>`);
  return Xml.elements(element);
};

const single = (element: Xml.Element, name: string): Xml.Element => {
  const children = only(element);
  if (children.length !== 1 || children[0]!.name !== name)
    fail(`<${element.name}> must contain exactly one <${name}>`);
  return children[0]!;
};

const scalarText = (element: Xml.Element): string => {
  if (Xml.elements(element).length > 0)
    fail(`<${element.name}> cannot contain elements`);
  return Xml.textOf(element);
};

const readValue = (element: Xml.Element): Value => {
  if (element.name !== "value")
    fail(`expected <value>, found <${element.name}>`);
  const children = Xml.elements(element);
  if (children.length === 0) return Xml.textOf(element);
  const typed = single(element, children[0]!.name);
  const name = typed.name;
  if ((scalars as ReadonlyArray<string>).includes(name))
    return { [name]: scalarText(typed) } as Value;
  if (name === "struct") {
    const members: Record<string, Value> = {};
    for (const member of only(typed)) {
      if (member.name !== "member")
        fail(`unexpected <${member.name}> in <struct>`);
      const parts = only(member);
      if (
        parts.length !== 2 ||
        parts[0]!.name !== "name" ||
        parts[1]!.name !== "value"
      )
        fail("a <member> holds one <name> and then one <value>");
      const key = scalarText(parts[0]!);
      if (Object.hasOwn(members, key))
        fail(`duplicate member ${JSON.stringify(key)}`);
      Object.defineProperty(members, key, {
        value: readValue(parts[1]!),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { struct: members };
  }
  if (name === "array")
    return { array: only(single(typed, "data")).map(readValue) };
  return fail(`unsupported type <${name}>`);
};

const writeValue = (value: Value): Xml.Element => {
  if (typeof value === "string") return Xml.element("value", {}, value);
  if ("struct" in value)
    return Xml.element(
      "value",
      {},
      Xml.element(
        "struct",
        {},
        ...Object.entries(value.struct).map(([name, member]) =>
          Xml.element(
            "member",
            {},
            Xml.element("name", {}, name),
            writeValue(member),
          ),
        ),
      ),
    );
  if ("array" in value)
    return Xml.element(
      "value",
      {},
      Xml.element(
        "array",
        {},
        Xml.element("data", {}, ...value.array.map(writeValue)),
      ),
    );
  const [[type, text]] = Object.entries(value) as [[string, string]];
  return Xml.element("value", {}, Xml.element(type, {}, text));
};

const document = (root: Xml.Element): string =>
  `<?xml version="1.0"?>\n${Xml.serialize(root)}`;

/** Parse a `<methodResponse>`. Throws on anything that is not one well-formed response. */
export const parseResponse = (text: string): MethodResponse => {
  const root = Xml.parse(text);
  if (root.name !== "methodResponse")
    fail(`expected <methodResponse>, found <${root.name}>`);
  const [outcome, ...rest] = only(root);
  if (outcome === undefined || rest.length > 0)
    fail("<methodResponse> must contain exactly one <params> or <fault>");
  if (outcome!.name === "params")
    return { params: [readValue(single(single(outcome!, "param"), "value"))] };
  if (outcome!.name === "fault")
    return { fault: readValue(single(outcome!, "value")) };
  return fail(`unexpected <${outcome!.name}> in <methodResponse>`);
};

export const serializeResponse = (response: MethodResponse): string =>
  document(
    "fault" in response
      ? Xml.element(
          "methodResponse",
          {},
          Xml.element("fault", {}, writeValue(response.fault)),
        )
      : Xml.element(
          "methodResponse",
          {},
          Xml.element(
            "params",
            {},
            Xml.element("param", {}, writeValue(response.params[0])),
          ),
        ),
  );

/** Parse a `<methodCall>`. */
export const parseCall = (text: string): MethodCall => {
  const root = Xml.parse(text);
  if (root.name !== "methodCall")
    fail(`expected <methodCall>, found <${root.name}>`);
  const children = only(root);
  const name = children[0];
  if (name?.name !== "methodName")
    fail("<methodCall> starts with <methodName>");
  const params = children[1];
  if (children.length > 2 || (params !== undefined && params.name !== "params"))
    fail("<methodCall> holds <methodName> and optional <params>");
  return {
    methodName: scalarText(name!),
    params:
      params === undefined
        ? []
        : only(params).map((param) => {
            if (param.name !== "param")
              fail(`unexpected <${param.name}> in <params>`);
            return readValue(single(param, "value"));
          }),
  };
};

export const serializeCall = (call: MethodCall): string =>
  document(
    Xml.element(
      "methodCall",
      {},
      Xml.element("methodName", {}, call.methodName),
      Xml.element(
        "params",
        {},
        ...call.params.map((param) =>
          Xml.element("param", {}, writeValue(param)),
        ),
      ),
    ),
  );

// Schemas over the tree.

type ParseOptions = SchemaAST.ParseOptions;

const invalid = (message: string, input: unknown, options: ParseOptions) =>
  new SchemaIssue.InvalidValue({ message }, input, options);

/** Any value of the tree, for typing the wire side of composed schemas. */
export const Tree: Schema.Codec<Value> = Schema.Union([
  Schema.String,
  ...scalars.map((type) => Schema.Struct({ [type]: Schema.String })),
  Schema.Struct({
    struct: Schema.Record(
      Schema.String,
      Schema.suspend(() => Tree),
    ),
  }),
  Schema.Struct({ array: Schema.Array(Schema.suspend(() => Tree)) }),
]) as unknown as Schema.Codec<Value>;

const Response: Schema.Codec<MethodResponse> = Schema.Union([
  Schema.Struct({ params: Schema.Tuple([Tree]) }),
  Schema.Struct({ fault: Tree }),
]);

/** Response text to the tree, refusing malformed XML or XML-RPC as a schema issue. */
export const ResponseText = Schema.String.pipe(
  Schema.decodeTo(
    Response,
    SchemaTransformation.transformEffect<MethodResponse, string>({
      decode: (text, options) => {
        try {
          return Effect.succeed(parseResponse(text));
        } catch (cause) {
          return Effect.fail(invalid((cause as Error).message, text, options));
        }
      },
      encode: (response) => Effect.succeed(serializeResponse(response)),
    }),
  ),
);

/** The lexical text of one typed scalar. */
const typed = <const K extends (typeof scalars)[number]>(
  type: K,
): Schema.Codec<string, { readonly [P in K]: string }> =>
  Schema.Struct({ [type]: Schema.String } as Record<
    string,
    typeof Schema.String
  >).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform<
        string,
        { readonly [key: string]: string }
      >({
        decode: (value) => value[type]!,
        encode: (text) => ({ [type]: text }),
      }),
    ),
  ) as unknown as Schema.Codec<string, { readonly [P in K]: string }>;

/** `<i4>`: a 32-bit integer in canonical decimal (no sign on zero, no `+`, no leading zeros). */
export const I4 = typed("i4").pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transformEffect<number, string>({
      decode: (text, options) => {
        const value = Number(text);
        return /^(0|-?[1-9]\d*)$/.test(text) &&
          value >= -(2 ** 31) &&
          value < 2 ** 31
          ? Effect.succeed(value)
          : Effect.fail(
              invalid(
                `${JSON.stringify(text)} is not a canonical i4`,
                text,
                options,
              ),
            );
      },
      encode: (value, options) =>
        value >= -(2 ** 31) && value < 2 ** 31
          ? Effect.succeed(String(value))
          : Effect.fail(invalid(`${value} does not fit an i4`, value, options)),
    }),
  ),
);

/** `<double>` as its lexical text, for a value convention such as money to read exactly. */
export const DoubleText = typed("double");

/** `<boolean>` as its lexical text. */
export const BooleanText = typed("boolean");

/** `<dateTime.iso8601>` as its lexical text. */
export const DateTimeText = typed("dateTime.iso8601");

/** A typed `<string>`. */
export const Text = typed("string");

/** An untyped `<value>text</value>`, which the specification defines as a string. */
export const Untyped = Schema.String;

const MIME_LINE = 76;

/** Base64 laid out as Perl's MIME::Base64 writes it: 76-character lines, each ending in `\n`. */
const mime = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const flat = btoa(binary);
  let text = "";
  for (let offset = 0; offset < flat.length; offset += MIME_LINE)
    text += `${flat.slice(offset, offset + MIME_LINE)}\n`;
  return text;
};

/**
 * `<base64>` to bytes. The gateway's Perl stack wraps base64 at 76 characters with a newline after
 * every line; only exactly that layout is accepted, so the bytes re-encode to the same text.
 */
export const Base64 = typed("base64").pipe(
  Schema.decodeTo(
    Schema.Uint8Array,
    SchemaTransformation.transformEffect<Uint8Array, string>({
      decode: (text, options) => {
        const flat = text.replaceAll("\n", "");
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            flat,
          )
        )
          return Effect.fail(invalid("not base64", text, options));
        const binary = atob(flat);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return mime(bytes) === text
          ? Effect.succeed(bytes)
          : Effect.fail(
              invalid(
                "base64 is not wrapped as 76-character lines ending in \\n",
                text,
                options,
              ),
            );
      },
      encode: (bytes) => Effect.succeed(mime(bytes)),
    }),
  ),
);

/** A `<struct>` whose members are decoded by `fields`. Extra members are ignored on decode. */
export const struct = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
) => {
  const members = Schema.Struct(fields);
  return Schema.Struct({ struct: members }).pipe(
    Schema.decodeTo(
      Schema.toType(members),
      SchemaTransformation.transform<
        (typeof members)["Type"],
        { readonly struct: (typeof members)["Type"] }
      >({
        decode: (value) => value.struct,
        encode: (value) => ({ struct: value }),
      }),
    ),
  );
};

/** An `<array>` whose items are decoded by `item`. */
export const array = <S extends Schema.Top>(item: S) => {
  const items = Schema.Array(item);
  return Schema.Struct({ array: items }).pipe(
    Schema.decodeTo(
      Schema.toType(items),
      SchemaTransformation.transform<
        (typeof items)["Type"],
        { readonly array: (typeof items)["Type"] }
      >({
        decode: (value) => value.array,
        encode: (value) => ({ array: value }),
      }),
    ),
  );
};

/** A fault's struct: `faultCode` as `<i4>` and `faultString` as `<string>`. */
const FaultStruct = struct({ faultCode: I4, faultString: Text });

/** The outcome of a call: the decoded result, or the fault the server answered instead. */
export type Outcome<A> =
  | { readonly _tag: "Result"; readonly value: A }
  | { readonly _tag: "Fault"; readonly code: number; readonly message: string };

/**
 * A method response decoded into an {@link Outcome}. A fault is a body-level outcome inside an HTTP
 * 200, so it is a member of the union, not an exception; a result that `result` cannot decode is a
 * schema failure.
 */
export const outcome = <A, E extends Value, RD, RE>(
  result: Schema.Codec<A, E, RD, RE>,
) =>
  Schema.Union([
    Schema.Struct({ params: Schema.Tuple([result]) }).pipe(
      Schema.decodeTo(
        Schema.TaggedStruct("Result", { value: Schema.toType(result) }),
        SchemaTransformation.transform<
          { readonly _tag: "Result"; readonly value: A },
          { readonly params: readonly [A] }
        >({
          decode: ({ params: [value] }) => ({ _tag: "Result", value }),
          encode: ({ value }) => ({ params: [value] }),
        }),
      ),
    ),
    Schema.Struct({ fault: FaultStruct }).pipe(
      Schema.decodeTo(
        Schema.TaggedStruct("Fault", {
          code: Schema.Int,
          message: Schema.String,
        }),
        SchemaTransformation.transform<
          {
            readonly _tag: "Fault";
            readonly code: number;
            readonly message: string;
          },
          {
            readonly fault: {
              readonly faultCode: number;
              readonly faultString: string;
            };
          }
        >({
          decode: ({ fault }) => ({
            _tag: "Fault",
            code: fault.faultCode,
            message: fault.faultString,
          }),
          encode: ({ code, message }) => ({
            fault: { faultCode: code, faultString: message },
          }),
        }),
      ),
    ),
  ]);
