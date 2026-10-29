# The portal facade (`soap-proxy`)

A JSON front for the [DocVault SOAP store](./soap-store.md). The intranet portal team wrote it in
2012 as a WCF service on `webHttpBinding` with the `enableWebScript` behaviour, so the portal's
jQuery code could publish documents without speaking SOAP. It forwards each call to the store's SOAP
1.1 endpoint over HTTP, with its own SOAP code, and reshapes the answer. The portal team was
disbanded in 2016; the facade still serves the month-end job and two portal widgets, and nobody has
the build machine that compiled it.

The facade keeps no documents of its own: everything it publishes lives in the store it forwards
to. The [test options](#test-options) at the end are for the suite's tests, not part of the
published service.

## Endpoint

`POST /DocumentService.svc/Publish` publishes one document. Everything else answers 404, or 405 with
`Allow` for another method on that path.

The request is `application/json` with the wrapped `document` parameter:

```json
{
  "document": {
    "Name": "report.pdf",
    "Title": "Monthly report",
    "ContentType": "application/pdf",
    "Content": [37, 80, 68, 70]
  }
}
```

`Title` is optional. The facade stores the document in DocVault with `StoreDocument`, under the
name `portal.<Name>`, and answers 200:

```json
{
  "d": {
    "__type": "PublishResult:#DocVault.Portal",
    "DocumentId": "DOC-000001",
    "ETag": "\"…\"",
    "Name": "portal.report.pdf"
  }
}
```

## Quirks, oldest first

- **The wrapped request body (2012).** `enableWebScript` only supports the wrapped body style, so
  the JSON body is an object whose single key is the operation's parameter name, `document`. Member
  names are the PascalCase names of the .NET data contract. Unknown members are ignored, as
  `DataContractJsonSerializer` does; a missing `Name`, `ContentType` or `Content` is a
  deserialization failure.
- **Bytes as an array of numbers (2012).** The data contract declares `Content` as `byte[]`, which
  `DataContractJsonSerializer` reads and writes as a JSON array of integers from 0 to 255, not as
  base64. The portal's JavaScript built that array from a `FileReader`, so it stays.
- **Deserialization failures as an HTML page (2012).** A body the serializer cannot read (malformed
  JSON, a wrong member type, a byte outside 0–255, a missing required member) answers `400` with
  WCF's own `text/html` "Request Error" page, because the formatter fails before the operation runs
  and `enableWebScript` has no JSON error writer for that stage. A content type other than
  `application/json` answers `415` with the same page. The page names the failure in its sentence
  "The exception message is '…'."
- **The `d` wrapper (2012).** Success is `200` with the result under `d`, ASP.NET AJAX's
  anti-hijacking wrapper, including the serializer's type hint `__type`.
- **Errors as `jsonerror` 500s (2012).** Once the operation runs, every failure is `500` with the
  header `jsonerror: true` and the body
  `{"ExceptionDetail":null,"ExceptionType":…,"Message":…,"StackTrace":null}`:
  - A nonzero store `FaultCode` becomes `ExceptionType` `DocVault.Portal.StoreFaultException` with
    the message `DocVault <code>: <FaultString>`. The team turned on exception details for that one
    type so the portal could show the store's reason.
  - An unreachable store is `System.ServiceModel.EndpointNotFoundException`.
  - An unreadable store reply is `System.ServiceModel.ProtocolException`.
- **The `portal.` prefix (2013).** The portal's front-page job lists the store by name prefix, so
  the facade stores every published document as `portal.<Name>` and answers with that name. The
  prefix keeps a published copy from colliding with an archive copy of the same file.
- **Disconnects cancel the store call (2014).** After hung store calls exhausted the IIS worker
  pool, the facade started passing the client-disconnected token to its outbound call, so a client
  that goes away also aborts the forwarded SOAP request.

## What the store receives

Each publish is one SOAP 1.1 `StoreDocument` call to the store's `POST /soap`, sent as
`text/xml; charset=utf-8` in UTF-8 with `SOAPAction: "urn:docvault:store:2003#StoreDocument"`. It
carries the prefixed name, the title (empty when none was given), the content type, and the content
in base64.

## Test options

Start the facade with `lane.backend("soap-proxy", { soapOrigin })`. `soapOrigin` is the SOAP store's
origin, such as `http://127.0.0.1:1234`, and is required; a trailing slash is ignored. Pointing
`soapOrigin` at an address where nothing listens produces the `EndpointNotFoundException` answer.
