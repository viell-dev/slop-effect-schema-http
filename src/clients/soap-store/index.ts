/**
 * The consumer's contracts for the SOAP document store, written only against the library's public
 * API, Effect and the suite's own format helpers. Everything runs in Node and in a browser.
 *
 * - `Soap`: the two SOAP versions as protocol values, and the fault union.
 * - `Actions`: the actions, their payload codecs, and their operations for a protocol.
 * - `WebDav`: PROPFIND, conditional GET and PUT, and MKCOL.
 * - `Files`: the multipart upload, the raw upload and the multipart bundle.
 * - `Wsdl`: the service description.
 * - `XmlSchema`: the XML schema plumbing the others share.
 */
export * as Actions from "./actions.js";
export * as Files from "./files.js";
export * as Soap from "./soap.js";
export * as WebDav from "./webdav.js";
export * as Wsdl from "./wsdl.js";
export * as XmlSchema from "./xml.js";
