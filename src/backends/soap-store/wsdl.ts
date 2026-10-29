/**
 * The service description and its schema part, as fixed text.
 *
 * Service documentation: services/soap-store.md
 */

const namespace = "urn:docvault:store:2003";
const operations = [
  "StoreDocument",
  "FetchDocument",
  "ListDocuments",
  "LockDocument",
] as const;

const binding = (prefix: "soap" | "soap12", name: string): string =>
  [
    `  <wsdl:binding name="${name}" type="tns:DocVaultSoap">`,
    `    <${prefix}:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>`,
    ...operations.map((operation) =>
      [
        `    <wsdl:operation name="${operation}">`,
        `      <${prefix}:operation soapAction="${namespace}#${operation}" style="document"/>`,
        `      <wsdl:input><${prefix}:body use="literal"/></wsdl:input>`,
        `      <wsdl:output><${prefix}:body use="literal"/></wsdl:output>`,
        `    </wsdl:operation>`,
      ].join("\r\n"),
    ),
    `  </wsdl:binding>`,
  ].join("\r\n");

/** The WSDL 1.1 document, with both ports addressed at this server. */
export const serviceDescription = (origin: string): string =>
  [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="${namespace}" targetNamespace="${namespace}" name="DocVault">`,
    `  <wsdl:documentation>DocVault document store. Generated 2009-03-17 by the port's annotation processor.</wsdl:documentation>`,
    `  <wsdl:types>`,
    `    <xsd:schema targetNamespace="${namespace}">`,
    `      <xsd:import namespace="${namespace}" schemaLocation="${origin}/soap?wsdl=types"/>`,
    `    </xsd:schema>`,
    `  </wsdl:types>`,
    ...operations.flatMap((operation) => [
      `  <wsdl:message name="${operation}SoapIn"><wsdl:part name="parameters" element="tns:${operation}"/></wsdl:message>`,
      `  <wsdl:message name="${operation}SoapOut"><wsdl:part name="parameters" element="tns:${operation}Response"/></wsdl:message>`,
    ]),
    `  <wsdl:portType name="DocVaultSoap">`,
    ...operations.map(
      (operation) =>
        `    <wsdl:operation name="${operation}"><wsdl:input message="tns:${operation}SoapIn"/><wsdl:output message="tns:${operation}SoapOut"/></wsdl:operation>`,
    ),
    `  </wsdl:portType>`,
    binding("soap", "DocVaultSoap"),
    binding("soap12", "DocVaultSoap12"),
    `  <wsdl:service name="DocVault">`,
    `    <wsdl:port name="DocVaultSoap" binding="tns:DocVaultSoap"><soap:address location="${origin}/soap"/></wsdl:port>`,
    `    <wsdl:port name="DocVaultSoap12" binding="tns:DocVaultSoap12"><soap12:address location="${origin}/soap"/></wsdl:port>`,
    `  </wsdl:service>`,
    `</wsdl:definitions>`,
    ``,
  ].join("\r\n");

const info = [
  `<xsd:element name="Id" type="xsd:string"/>`,
  `<xsd:element name="Name" type="xsd:string"/>`,
  `<xsd:element name="Title" type="xsd:string"/>`,
  `<xsd:element name="ContentType" type="xsd:string"/>`,
  `<xsd:element name="Size" type="xsd:long"/>`,
  `<xsd:element name="ETag" type="xsd:string"/>`,
  `<xsd:element name="Modified" type="xsd:dateTime"/>`,
].join("");

/** The schema part. */
export const schemaPart = (): string =>
  [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="${namespace}" targetNamespace="${namespace}" elementFormDefault="qualified">`,
    `  <xsd:complexType name="Fault"><xsd:sequence><xsd:element name="FaultCode" type="xsd:int"/><xsd:element name="FaultString" type="xsd:string"/></xsd:sequence></xsd:complexType>`,
    `  <xsd:complexType name="DocumentInfo"><xsd:sequence>${info}</xsd:sequence></xsd:complexType>`,
    `  <xsd:element name="StoreDocument"><xsd:complexType><xsd:sequence><xsd:element name="Name" type="xsd:string"/><xsd:element name="Title" type="xsd:string" minOccurs="0"/><xsd:element name="ContentType" type="xsd:string"/><xsd:element name="Content" type="xsd:base64Binary"/></xsd:sequence></xsd:complexType></xsd:element>`,
    `  <xsd:element name="FetchDocument"><xsd:complexType><xsd:sequence><xsd:element name="Id" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>`,
    `  <xsd:element name="ListDocuments"><xsd:complexType><xsd:sequence><xsd:element name="Prefix" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>`,
    `  <xsd:element name="LockDocument"><xsd:complexType><xsd:sequence><xsd:element name="Id" type="xsd:string"/><xsd:element name="Owner" type="xsd:string"/><xsd:element name="Seconds" type="xsd:int" minOccurs="0"/></xsd:sequence></xsd:complexType></xsd:element>`,
    `</xsd:schema>`,
    ``,
  ].join("\r\n");
