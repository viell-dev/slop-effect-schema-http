import { Schema, SchemaGetter } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as Xml from "../../formats/xml.js";
import { bytesAs, rejected } from "./common.js";
import {
  attempt,
  childElements,
  Element,
  ElementFromBytes,
  enter,
  expect,
  resolve,
  type Scope,
} from "./xml.js";

/**
 * The store's WSDL, reduced to what a client checks its contracts against: each port's SOAP
 * version, address and the action URI of every operation.
 */

const WSDL = "http://schemas.xmlsoap.org/wsdl/";
const bindings: Readonly<Record<string, "1.1" | "1.2">> = {
  "http://schemas.xmlsoap.org/wsdl/soap/": "1.1",
  "http://schemas.xmlsoap.org/wsdl/soap12/": "1.2",
};

export const Port = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.Literals(["1.1", "1.2"]),
  address: Schema.NonEmptyString,
  operations: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      soapAction: Schema.String,
    }),
  ),
});

export const ServiceDescription = Schema.Struct({
  name: Schema.NonEmptyString,
  targetNamespace: Schema.NonEmptyString,
  ports: Schema.Array(Port),
});
export type ServiceDescription = typeof ServiceDescription.Type;

const attribute = (element: Xml.Element, name: string): string => {
  const value = element.attributes[name];
  if (value === undefined)
    throw new Error(`<${element.name}> lacks the ${name} attribute`);
  return value;
};

/** Children in a namespace with a local name, each with its own scope. */
const children = (
  element: Xml.Element,
  scope: Scope,
  namespace: (uri: string | undefined) => boolean,
  local: string,
): ReadonlyArray<{ readonly element: Xml.Element; readonly scope: Scope }> =>
  childElements(element)
    .map((child) => ({ element: child, scope: enter(child, scope) }))
    .filter(
      ({ element: child, scope: inner }) =>
        Xml.localName(child.name) === local &&
        namespace(resolve(child.name, inner)),
    );

const isWsdl = (uri: string | undefined) => uri === WSDL;
const isSoap = (uri: string | undefined) =>
  uri !== undefined && uri in bindings;

const describe = (root: Xml.Element): typeof ServiceDescription.Encoded => {
  const scope = enter(root);
  expect(root, scope, WSDL, "definitions");
  const targetNamespace = attribute(root, "targetNamespace");
  const declared = new Map(
    children(root, scope, isWsdl, "binding").map(
      ({ element, scope: inner }) => {
        const protocol = children(element, inner, isSoap, "binding");
        if (protocol.length !== 1)
          throw new Error(`binding ${element.attributes["name"]} is not SOAP`);
        const uri = resolve(protocol[0]!.element.name, protocol[0]!.scope)!;
        const operations = children(element, inner, isWsdl, "operation").map(
          (operation) => {
            const soap = children(
              operation.element,
              operation.scope,
              (candidate) => candidate === uri,
              "operation",
            );
            if (soap.length !== 1)
              throw new Error(
                `operation ${operation.element.attributes["name"]} has no SOAP binding`,
              );
            return {
              name: attribute(operation.element, "name"),
              soapAction: attribute(soap[0]!.element, "soapAction"),
            };
          },
        );
        return [
          attribute(element, "name"),
          { uri, version: bindings[uri]!, operations },
        ] as const;
      },
    ),
  );
  const services = children(root, scope, isWsdl, "service");
  if (services.length !== 1) throw new Error("expected one service");
  const service = services[0]!;
  const ports = children(service.element, service.scope, isWsdl, "port").map(
    (port) => {
      const reference = attribute(port.element, "binding");
      if (resolve(reference, port.scope) !== targetNamespace)
        throw new Error(`binding ${reference} is outside the target namespace`);
      const binding = declared.get(Xml.localName(reference));
      if (binding === undefined)
        throw new Error(`port binding ${reference} is not declared`);
      const addresses = children(
        port.element,
        port.scope,
        (uri) => uri === binding.uri,
        "address",
      );
      if (addresses.length !== 1)
        throw new Error(
          `port ${port.element.attributes["name"]} has no address`,
        );
      return {
        name: attribute(port.element, "name"),
        version: binding.version,
        address: attribute(addresses[0]!.element, "location"),
        operations: binding.operations,
      };
    },
  );
  return { name: attribute(root, "name"), targetNamespace, ports };
};

/**
 * A WSDL document's root element and its summary. Decode-only: the summary drops the messages,
 * types, port types and documentation, so it cannot be written back as a WSDL.
 */
export const ServiceDescriptionFromElement = Element.pipe(
  Schema.decodeTo(ServiceDescription, {
    decode: SchemaGetter.transformEffect((root: Xml.Element, options) =>
      attempt(() => describe(root), root, options),
    ),
    encode: SchemaGetter.forbidden(
      () =>
        "a service summary drops the messages, types, port types and documentation of its WSDL, so it cannot be written back",
    ),
  }),
);

/**
 * `GET soap?wsdl…`: `null` sends the bare key (`?wsdl`) for the description; a string sends
 * `?wsdl=<part>`, which names a part, so `""` names a part called "" and is a different request.
 */
export const metadata = (origin: string) =>
  Operation.make(
    Request.get("soap").pipe(
      Request.baseUrl(origin),
      Request.query(Schema.Struct({ wsdl: Schema.NullOr(Schema.String) })),
      Request.mapInput((wsdl: string | null) => ({ query: { wsdl } })),
    ),
    Response.status(
      200,
      bytesAs("text/xml").pipe(
        Body.schema(
          ElementFromBytes.pipe(Schema.decodeTo(ServiceDescriptionFromElement)),
        ),
        Body.map((value) => ({ _tag: "Description", ...value }) as const),
      ),
    ).pipe(Response.orElse(Response.status(404, rejected("NoSuchPart")))),
  );
