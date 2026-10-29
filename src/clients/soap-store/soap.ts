import { Effect, Schema, SchemaTransformation } from "effect";
import { HttpBody, type HttpClientError } from "effect/http";
import { Body, Request } from "viell-effect-schema-http";
import * as Xml from "../../formats/xml.js";
import {
  attempt,
  childElements,
  detach,
  Element,
  ElementFromBytes,
  enter,
  expect,
  fields,
  leaf,
  resolve,
  type Scope,
  text,
} from "./xml.js";

/** The store's own namespace, which every action payload uses. */
export const Namespace = "urn:docvault:store:2003";

/**
 * One SOAP action: its name, its action URI, and the codecs between its payload elements and the
 * application's values. The envelope and the transport framing belong to the {@link Protocol}.
 */
export interface Action<In, Out> {
  readonly name: string;
  readonly uri: string;
  readonly input: Schema.Codec<In, Xml.Element>;
  readonly output: Schema.Codec<Out, Xml.Element>;
}

/** What frames a request: the action URI and the payload codec. */
export type Framed<In> = Pick<Action<In, unknown>, "uri" | "input">;

export const action = <In, Out>(
  name: string,
  input: Schema.Codec<In, Xml.Element>,
  output: Schema.Codec<Out, Xml.Element>,
): Action<In, Out> => ({ name, uri: `${Namespace}#${name}`, input, output });

/** How a fault classifies its cause, in SOAP 1.2 terms; SOAP 1.1 says Client and Server. */
export const FaultCode = Schema.Literals(["Sender", "Receiver"]);

export const LockConflict = Schema.TaggedStruct("LockConflict", {
  code: FaultCode,
  message: Schema.String,
  heldBy: Schema.String,
  expires: Schema.String,
});

export const DocumentNotFound = Schema.TaggedStruct("DocumentNotFound", {
  code: FaultCode,
  message: Schema.String,
  id: Schema.String,
});

/** A fault without a detail this client knows. */
export const SoapFault = Schema.TaggedStruct("SoapFault", {
  code: FaultCode,
  message: Schema.String,
});

/** A real SOAP fault, as only `LockDocument` sends them. */
export const Fault = Schema.Union([LockConflict, DocumentNotFound, SoapFault]);
export type Fault = typeof Fault.Type;

type FaultEncoded = typeof Fault.Encoded;

const detailOf = (
  children: ReadonlyArray<Xml.Element>,
  scope: Scope,
  code: "Sender" | "Receiver",
  message: string,
): FaultEncoded => {
  if (children.length === 0) return { _tag: "SoapFault", code, message };
  if (children.length > 1) throw new Error("expected one fault detail");
  const detail = children[0]!;
  const inner = enter(detail, scope);
  if (Xml.localName(detail.name) === "LockConflict") {
    expect(detail, inner, Namespace, "LockConflict");
    const found = fields(detail, ["HeldBy", "Expires"]);
    return {
      _tag: "LockConflict",
      code,
      message,
      heldBy: text(found.HeldBy),
      expires: text(found.Expires),
    };
  }
  expect(detail, inner, Namespace, "DocumentNotFound");
  return {
    _tag: "DocumentNotFound",
    code,
    message,
    id: text(fields(detail, ["Id"]).Id),
  };
};

const detailElements = (fault: FaultEncoded): ReadonlyArray<Xml.Element> =>
  fault._tag === "LockConflict"
    ? [
        Xml.element(
          "LockConflict",
          { xmlns: Namespace },
          leaf("HeldBy", fault.heldBy),
          leaf("Expires", fault.expires),
        ),
      ]
    : fault._tag === "DocumentNotFound"
      ? [
          Xml.element(
            "DocumentNotFound",
            { xmlns: Namespace },
            leaf("Id", fault.id),
          ),
        ]
      : [];

/** The `Envelope` and `Body` around exactly one element. */
const unwrap = (
  root: Xml.Element,
  namespace: string,
): { readonly child: Xml.Element; readonly scope: Scope } => {
  const scope = enter(root);
  expect(root, scope, namespace, "Envelope");
  const body = fields(root, ["Body"]).Body;
  const inner = enter(body, scope);
  expect(body, inner, namespace, "Body");
  const children = childElements(body);
  if (children.length !== 1)
    throw new Error(`the SOAP Body holds ${children.length} elements, not one`);
  return { child: children[0]!, scope: inner };
};

/**
 * A SOAP version: the envelope namespace, the codec that owns the request content type, the
 * transport framing of an action, and the fault format. Switching versions swaps this value; the
 * actions and their payload codecs stay the same.
 */
export interface Protocol {
  readonly version: "1.1" | "1.2";
  readonly namespace: string;
  /** The response media type, which also forms the automatic `Accept` header. */
  readonly mediaType: string;
  /** The envelope around one payload element. */
  readonly envelope: <T>(
    payload: Schema.Codec<T, Xml.Element>,
  ) => Schema.Codec<T, Xml.Element>;
  /** A whole SOAP message: its bytes and the payload's value. */
  readonly document: <T>(
    payload: Schema.Codec<T, Xml.Element>,
  ) => Schema.Codec<T, Uint8Array>;
  /** A fault message as an element. */
  readonly fault: Schema.Codec<Fault, Xml.Element>;
  /** The body codec of an action's request. It sets the content type. */
  readonly body: <In>(
    action: Framed<In>,
  ) => Body.Encoder<In, Schema.SchemaError>;
  /** An action's request: `POST soap` with the version's framing. Relative to a base URL. */
  readonly request: <In>(
    action: Framed<In>,
  ) => Request.Request<{ readonly body: In }, Schema.SchemaError>;
  /** The decoder of an action's successful response. */
  readonly decoder: <Out>(
    action: Action<unknown, Out>,
  ) => Body.Decoder<Out, Schema.SchemaError | HttpClientError.HttpClientError>;
  /** The decoder of a fault response. */
  readonly faultDecoder: Body.Decoder<
    Fault,
    Schema.SchemaError | HttpClientError.HttpClientError
  >;
}

/** XML as bytes under a content type the protocol chooses; the bytes decoder ignores the charset. */
const xmlBytes = (contentType: string, mediaType: string) =>
  Body.make<Uint8Array, never, HttpClientError.HttpClientError>({
    encode: (bytes) => Effect.succeed(HttpBody.uint8Array(bytes, contentType)),
    decode: (response) =>
      Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
    mediaType,
  });

const makeProtocol = (options: {
  readonly version: "1.1" | "1.2";
  readonly namespace: string;
  readonly prefix: string;
  readonly mediaType: string;
  readonly contentType: (action: Framed<unknown>) => string;
  readonly frame: (
    action: Framed<unknown>,
  ) => <I, E, R>(request: Request.Request<I, E, R>) => Request.Request<I, E, R>;
  readonly fault: Schema.Codec<Fault, Xml.Element>;
}): Protocol => {
  const envelope = <T>(
    payload: Schema.Codec<T, Xml.Element>,
  ): Schema.Codec<T, Xml.Element> =>
    Element.pipe(
      Schema.decodeTo(
        payload,
        SchemaTransformation.transformEffect<Xml.Element, Xml.Element>({
          decode: (root, parse) =>
            attempt(
              () => {
                const { child, scope } = unwrap(root, options.namespace);
                return detach(child, scope);
              },
              root,
              parse,
            ),
          encode: (child) =>
            Effect.succeed(
              Xml.element(
                `${options.prefix}:Envelope`,
                { [`xmlns:${options.prefix}`]: options.namespace },
                Xml.element(`${options.prefix}:Body`, {}, child),
              ),
            ),
        }),
      ),
    );
  const document = <T>(
    payload: Schema.Codec<T, Xml.Element>,
  ): Schema.Codec<T, Uint8Array> =>
    ElementFromBytes.pipe(Schema.decodeTo(envelope(payload)));
  const responses = xmlBytes("application/octet-stream", options.mediaType);
  const body = <In>(framed: Framed<In>): Body.Encoder<In, Schema.SchemaError> =>
    xmlBytes(options.contentType(framed), options.mediaType).pipe(
      Body.encodeSchema(document(framed.input)),
    );
  return {
    version: options.version,
    namespace: options.namespace,
    mediaType: options.mediaType,
    envelope,
    document,
    fault: options.fault,
    body,
    request: (framed) =>
      Request.post("soap").pipe(
        options.frame(framed),
        Request.body(body(framed)),
      ),
    decoder: (definition) =>
      responses.pipe(Body.schema(document(definition.output))),
    faultDecoder: responses.pipe(
      Body.schema(ElementFromBytes.pipe(Schema.decodeTo(options.fault))),
    ),
  };
};

const faultCode = (
  qualified: string,
  scope: Scope,
  namespace: string,
  names: Readonly<Record<string, "Sender" | "Receiver">>,
): "Sender" | "Receiver" => {
  const local = Xml.localName(qualified);
  const code = names[local];
  if (resolve(qualified, scope) !== namespace || code === undefined)
    throw new Error(`unknown fault code ${qualified}`);
  return code;
};

const SOAP11 = "http://schemas.xmlsoap.org/soap/envelope/";
const SOAP12 = "http://www.w3.org/2003/05/soap-envelope";

const fault11 = Element.pipe(
  Schema.decodeTo(
    Fault,
    SchemaTransformation.transformEffect<FaultEncoded, Xml.Element>({
      decode: (root, parse) =>
        attempt(
          () => {
            const { child, scope } = unwrap(root, SOAP11);
            const inner = enter(child, scope);
            expect(child, inner, SOAP11, "Fault");
            const found = fields(
              child,
              ["faultcode", "faultstring"],
              ["detail"],
            );
            const code = faultCode(text(found.faultcode), inner, SOAP11, {
              Client: "Sender",
              Server: "Receiver",
            });
            const message = text(found.faultstring);
            return found.detail === undefined
              ? detailOf([], inner, code, message)
              : detailOf(
                  childElements(found.detail),
                  enter(found.detail, inner),
                  code,
                  message,
                );
          },
          root,
          parse,
        ),
      encode: (fault) =>
        Effect.succeed(
          Xml.element(
            "soap:Envelope",
            { "xmlns:soap": SOAP11 },
            Xml.element(
              "soap:Body",
              {},
              Xml.element(
                "soap:Fault",
                {},
                leaf(
                  "faultcode",
                  fault.code === "Sender" ? "soap:Client" : "soap:Server",
                ),
                leaf("faultstring", fault.message),
                Xml.element("detail", {}, ...detailElements(fault)),
              ),
            ),
          ),
        ),
    }),
  ),
);

const fault12 = Element.pipe(
  Schema.decodeTo(
    Fault,
    SchemaTransformation.transformEffect<FaultEncoded, Xml.Element>({
      decode: (root, parse) =>
        attempt(
          () => {
            const { child, scope } = unwrap(root, SOAP12);
            const inner = enter(child, scope);
            expect(child, inner, SOAP12, "Fault");
            const found = fields(child, ["Code", "Reason"], ["Detail"]);
            const value = fields(found.Code, ["Value"]).Value;
            const code = faultCode(text(value), inner, SOAP12, {
              Sender: "Sender",
              Receiver: "Receiver",
            });
            const message = text(fields(found.Reason, ["Text"]).Text);
            return detailOf(
              found.Detail === undefined ? [] : childElements(found.Detail),
              found.Detail === undefined ? inner : enter(found.Detail, inner),
              code,
              message,
            );
          },
          root,
          parse,
        ),
      encode: (fault) => {
        const detail = detailElements(fault);
        return Effect.succeed(
          Xml.element(
            "env:Envelope",
            { "xmlns:env": SOAP12 },
            Xml.element(
              "env:Body",
              {},
              Xml.element(
                "env:Fault",
                {},
                Xml.element(
                  "env:Code",
                  {},
                  leaf("env:Value", `env:${fault.code}`),
                ),
                Xml.element(
                  "env:Reason",
                  {},
                  Xml.element("env:Text", { "xml:lang": "en" }, fault.message),
                ),
                ...(detail.length === 0
                  ? []
                  : [Xml.element("env:Detail", {}, ...detail)]),
              ),
            ),
          ),
        );
      },
    }),
  ),
);

/**
 * SOAP 1.1: `text/xml` with a UTF-8 charset, and the action as one quoted `SOAPAction` header,
 * declared per action.
 */
export const Soap11: Protocol = makeProtocol({
  version: "1.1",
  namespace: SOAP11,
  prefix: "soap",
  mediaType: "text/xml",
  contentType: () => "text/xml; charset=utf-8",
  frame: (framed) => Request.setHeader("SOAPAction", `"${framed.uri}"`),
  fault: fault11,
});

/**
 * SOAP 1.2: `application/soap+xml` whose `action` parameter names the action. The codec writes it,
 * so no header is declared.
 */
export const Soap12: Protocol = makeProtocol({
  version: "1.2",
  namespace: SOAP12,
  prefix: "env",
  mediaType: "application/soap+xml",
  contentType: (framed) =>
    `application/soap+xml; charset=utf-8; action="${framed.uri}"`,
  frame: () => (request) => request,
  fault: fault12,
});
