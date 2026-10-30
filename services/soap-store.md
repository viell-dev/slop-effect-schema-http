# DocVault, the SOAP document store (`soap-store`)

DocVault is a document store first written in 2003 for an in-house platform and ported to a servlet
container in 2009. Its SOAP endpoint grew a WebDAV view and file endpoints over the years. One
document record backs every view: a document stored over SOAP appears in the WebDAV listing, and an
upload can be fetched over SOAP. The [test options](#test-options) at the end are for the suite's
tests, not part of the published service.

## Endpoints

- `POST /soap`: the SOAP endpoint, in SOAP 1.1 or SOAP 1.2. Actions: `StoreDocument`,
  `FetchDocument`, `ListDocuments` and `LockDocument`.
- `GET /soap?wsdl`: the service description, and `GET /soap?wsdl=types`, its schema part.
- `GET /soap/download`: the download servlet, a GET that carries a SOAP 1.1 `DownloadDocument`
  envelope.
- `/dav/documents/…`: the WebDAV view, with `PROPFIND`, `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL` and
  `OPTIONS`.
- `POST /upload/raw?name=…`: the scanner gateway's raw upload.
- `POST /upload`: the browser uploader's multipart upload.
- `GET /bundle/<id>`: a document and its metadata as one multipart bundle.

Any other path answers 404, and another method on a listed path answers 405 with `Allow`.

## Documents

- **Names** are file names: 1 to 120 characters, without leading or trailing white space, and
  without `/`, `\`, control characters or DEL. The 2003 schema allowed anything but a slash; the
  2009 WebDAV view added the ban on control characters because they broke its hrefs. Names are
  unique across every view.
- **Ids** are `DOC-000001`, `DOC-000002`, … in creation order.
- **Entity tags** are strong, quoted, and change with every write.
- **Times** in SOAP replies and bundles are `xsd:dateTime` in UTC without fractional seconds, as the
  2003 serializer wrote them, such as `2024-01-31T12:00:00Z`. WebDAV uses HTTP-dates.
- **Lists** are ordered by name, the way the 2003 index returned them.

## The SOAP endpoint

The namespace is `urn:docvault:store:2003`, and each action's URI is
`urn:docvault:store:2003#<Action>`. The body holds one element, the action, in that namespace.

### Quirks, oldest first

- **Fault codes inside 200 (2003).** The original platform had no SOAP fault support, so its
  authors copied the fault vocabulary into every result: `<FaultCode>` and `<FaultString>`, where
  `0` means success. Every action answers HTTP 200, whatever happened. Three generations of clients
  branch on `FaultCode`, so it stays.
- **Latin-1 under charset-less `text/xml` (2003).** The platform wrote ISO-8859-1 and said so only
  in the XML declaration; characters above U+00FF become numeric character references. The port
  kept the writer byte for byte to avoid re-certifying the archive interface.
- **One list, three shapes (2005).** Results hold `<Count>` and, for one or more items,
  `<Documents>`. An empty list omits `<Documents>`. A single item is wrapped in `<Item>`, added in
  2005 so a Perl reporting client stopped collapsing one-element lists into scalars. Many items are
  listed directly. The Perl client still runs.
- **The front controller (2009).** The port put a servlet in front of the SOAP stack. It enforces
  WS-I Basic Profile R2744: SOAP 1.1 requests need exactly one `SOAPAction` header, quoted, naming
  the body element as `<namespace>#<element>`. The body element must be in the service's namespace,
  whatever prefix binds it and wherever the binding is declared, before anything dispatches on its
  local name. It answers framing errors with plain-text 400 and unknown media types with 415,
  because it predates the stack's fault writer.
- **SOAP 1.2 on the same URL (2009).** `application/soap+xml` selects SOAP 1.2, whose action
  travels as the `action` parameter of the content type; a `SOAPAction` header is ignored there.
  1.2 replies are UTF-8 and say so.
- **The one correct action (2011).** `LockDocument` was written by a contractor who read the SOAP
  1.1 specification: it reports errors as real SOAP faults with HTTP 500 and has no `FaultCode`.
  Its fault writer answers 500 for SOAP 1.2 too, where the 1.2 binding would send 400 for sender
  faults, as the JAX-WS reference implementation does. Nobody else adopted it.

### Requests

| Version  | `Content-Type`                                                    | Action                                           |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| SOAP 1.1 | `text/xml`                                                        | `SOAPAction: "urn:docvault:store:2003#<Action>"` |
| SOAP 1.2 | `application/soap+xml; action="urn:docvault:store:2003#<Action>"` | the `action` parameter; `SOAPAction` is ignored  |

The request's encoding is the content type's `charset`, else the encoding in its XML declaration,
else UTF-8. UTF-8 and ISO-8859-1 are understood; other encodings, and bytes invalid in the named
one, are refused with 400.

The front controller refuses, with a plain-text 400 that says why:

- a missing, repeated, unquoted or mismatched `SOAPAction` (SOAP 1.1), or a missing `action`
  parameter (SOAP 1.2);
- malformed XML, or a root that is not an envelope of the request's SOAP version;
- a body without exactly one element, or a body element outside the store's namespace;
- an unknown action, and `DownloadDocument`, which only the download servlet serves.

Any other media type answers 415.

### Replies

A result is `<{Action}Response xmlns="urn:docvault:store:2003">` holding `<{Action}Result>`, whose
first children are `<FaultCode>` and `<FaultString>` (`OK` on success).

| Version  | `Content-Type`                        | Bytes                                                     |
| -------- | ------------------------------------- | --------------------------------------------------------- |
| SOAP 1.1 | `text/xml`, no charset                | ISO-8859-1, `<?xml version="1.0" encoding="ISO-8859-1"?>` |
| SOAP 1.2 | `application/soap+xml; charset=utf-8` | UTF-8, `<?xml version="1.0" encoding="utf-8"?>`           |

In SOAP 1.1 replies, a character above U+00FF is a decimal character reference such as `&#8364;`.

### XML rules

The store reads XML 1.0 strictly: a request that breaks any of its
[well-formedness rules](https://www.w3.org/TR/xml/) is malformed. A character outside the
[`Char` production](https://www.w3.org/TR/xml/#charsets) is an error, raw or as a character
reference, and so is a reference to any entity but the five predefined ones. CRLF and a lone CR
become LF before parsing ([line ends](https://www.w3.org/TR/xml/#sec-line-ends)), and literal white
space in an attribute value becomes a space
([attribute normalization](https://www.w3.org/TR/xml/#AVNormalize)). White space is space, tab, CR
and LF only: U+00A0, U+3000 and the other Unicode spaces are not, and U+FEFF is a byte-order mark
only before the first character. Names may use any character XML's `Name` production allows. The
XML declaration, when present, comes first and starts with the version; no other processing
instruction may take `xml`, in any case, as its target, and each needs a target. A comment holds no
`--` and does not end in `-`.

A document type declaration is refused, though XML allows one, because SOAP forbids it in a message
(SOAP 1.1 section 3, SOAP 1.2 part 1 section 5), so the store expands no entities. WebDAV `PROPFIND`
bodies are read by the same rules.

The writer refuses characters outside `Char` too. It writes a carriage return as `&#xD;`, and a tab
or line feed inside an attribute value as a reference, so a reader's normalization keeps them.

### Actions

- **`StoreDocument`** takes `<Name>`, `<Title>` (optional), `<ContentType>` and `<Content>` in
  base64, and answers `<DocumentId>` and `<ETag>`. The document also appears at
  `/dav/documents/<name>`, where its entity tag guards WebDAV writes.
- **`FetchDocument`** takes `<Id>` and answers a `<Document>` with `<Id>`, `<Name>`, `<Title>`,
  `<ContentType>`, `<Size>`, `<ETag>`, `<Modified>` and `<Content>` in base64.
- **`ListDocuments`** takes `<Prefix>` and lists the documents whose names start with it: `<Count>`
  and the three list shapes of `<DocumentInfo>` elements, each holding the fields of `<Document>`
  without `<Content>`.
- **`LockDocument`** takes `<Id>`, `<Owner>` and `<Seconds>` (optional, 1 to 3600, default 300). It
  answers `<LockDocumentResponse>` with `<LockDocumentResult>` holding `<LockToken>`, `<Owner>` and
  `<Expires>`, and no fault fields. The owner of a live lock may lock again; an expired lock is
  gone.

Fault codes inside HTTP 200:

| `FaultCode` | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `0`         | success                                                           |
| `1001`      | no document with that id (`FetchDocument`)                        |
| `1002`      | a document with that name exists (`StoreDocument`)                |
| `2000`      | a required element is missing                                     |
| `2001`      | an invalid document name                                          |
| `2002`      | `<Content>` is not valid base64                                   |
| `5003`      | storage backend unavailable; nothing was stored (`StoreDocument`) |

`LockDocument`'s SOAP faults, always HTTP 500:

| Fault code                                | Cause                                                          | Detail                                        |
| ----------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `soap:Client` (1.1), `env:Sender` (1.2)   | missing `<Id>`, missing or blank `<Owner>`, or bad `<Seconds>` | empty                                         |
| `soap:Client` (1.1), `env:Sender` (1.2)   | no document with that id                                       | `<DocumentNotFound>` with `<Id>`              |
| `soap:Server` (1.1), `env:Receiver` (1.2) | another owner holds a live lock                                | `<LockConflict>` with `<HeldBy>`, `<Expires>` |

A SOAP 1.1 fault has `faultcode`, `faultstring` and `detail`; a SOAP 1.2 fault has `env:Code` with
`env:Value`, `env:Reason` with `<env:Text xml:lang="en">`, and `env:Detail`. The detail elements are
in the store's namespace. A fault without one, the missing-field fault, has no `detail` or
`env:Detail` element at all, as SAAJ writes it.

### Recordings

`LockDocument`'s faults are held to recordings of the JAX-WS reference implementation in JDK 8,
publishing SOAP 1.1 and SOAP 1.2 endpoints with `Endpoint.publish` and faulting on the same three
refusals ([recordings/README.md](../recordings/README.md); catalogue EXT-6e). The store's faults
carry the same status, the same codes, reasons, language and detail entries, in the same
namespaces. What differs is the writer, as documented above: the store writes SOAP 1.1 as
ISO-8859-1 under a charset-less `text/xml` where the runtime writes UTF-8 and says so, and its
prefixes and XML declaration are its own. The runtime's server spells `Content-type` and
`Transfer-encoding`, sends no `Connection` line, and adds an unused `xmlns:ns4` declaration of the
other SOAP version's namespace to every fault, none of which the store copies.

## Service description

`GET /soap?wsdl` answers the WSDL 1.1 description as `text/xml; charset=utf-8`. It was regenerated
in 2009 from the port's annotations and covers the four actions of the SOAP endpoint, with a SOAP
1.1 binding (`DocVaultSoap`) and a SOAP 1.2 binding (`DocVaultSoap12`), both addressed at this
server's `/soap`. The download servlet was never described, only documented in the vendor manual.
The types live in a separate part, `GET /soap?wsdl=types`.

The metadata handler copies the WCF convention: a bare `wsdl` key asks for the description and
`wsdl=<name>` for one of its parts, so `?wsdl=` names a part called `""` and answers 404, like any
other unknown part. `GET /soap` without `wsdl` answers 404.

## The download servlet (2003)

The download servlet reads a `DownloadDocument` envelope from the body of a GET and answers the
bytes. Its `doPost` was never written, so POST gets 405. The vendor manual still documents it, and
the archive robot depends on it.

`GET /soap/download` takes a SOAP 1.1 request, framed as for `/soap`, whose body element is
`<DownloadDocument>` with `<Id>`. It answers 200 with the document's own content type,
`Content-Disposition: attachment; filename*=UTF-8''<name>` and `ETag`, and the bytes. A GET without
a body, a SOAP 1.2 envelope or another action answers plain-text 400; an unknown id answers
plain-text 404.

## The WebDAV view (2009)

The WebDAV view was added in 2009 so desktop clients could mount the store. It lives under
`/dav/documents/`; `archive/` and the other subcollections belong to the nightly archive job.
Documents are at `/dav/documents/<name>`, with the name percent-encoded.

### Quirks

- **Finite depth only.** PROPFIND without `Depth`, which RFC 4918 treats as infinity, is refused
  with 403 and `propfind-finite-depth`: an infinite walk once took the server down.
- **Multistatus lists collections.** A depth-1 listing includes the collection itself and its
  subcollections next to the documents, with a 404 propstat for the properties collections lack.
  The content type is `text/xml; charset="utf-8"`, quoted charset and all, as mod_dav wrote it.
- **Validators are mandatory (2016).** After two archive robots overwrote each other's corrections,
  writes without `If-Match` (replace) or `If-None-Match: *` (create) get 428. A stale or weak
  `If-Match` gets 412; `If-Match` compares strongly.
- **A MIME allowlist.** PUT bodies outside the allowlist get 415, as does a PROPFIND body that is
  not XML.
- **Fixed layout.** MKCOL on an existing resource gets 405 with `Allow`; elsewhere 403. Methods a
  resource does not support get 405 with its `Allow` list.

### Methods

| Resource         | `Allow`                                     |
| ---------------- | ------------------------------------------- |
| a collection     | `OPTIONS, PROPFIND`                         |
| a document       | `OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND` |
| an unmapped name | `OPTIONS, PUT`                              |

- `OPTIONS` answers 200 with `DAV: 1` and the resource's `Allow`.
- `PROPFIND` takes `Depth: 0` or `1` (`infinity` and a missing header are refused with 403, any
  other value with 400) and an optional XML body, which must be a `DAV:` `propfind` element. It
  answers `207 Multi-Status`. Documents report `resourcetype`, `displayname`, `getcontentlength`,
  `getcontenttype`, `getetag` and `getlastmodified`; collections report `resourcetype` with
  `collection`, `displayname` and `getlastmodified`, and the other three under a 404 propstat. A
  depth-1 listing of `/dav/documents/` is sorted by href. An unmapped name answers 404.
- `GET` and `HEAD` of a document answer 200 with its content type, `ETag` and `Last-Modified`. An
  `If-None-Match` that matches, weakly compared, answers 304 without a body.
- `PUT` takes a body of `application/pdf`, `application/octet-stream`, `application/xml`,
  `text/plain` or `text/xml`. It replaces a document under a matching `If-Match` (204 with the new
  `ETag`) and creates one under `If-None-Match: *` (201 with `ETag`, `Location` and an empty body);
  a created document's title is its name. `If-None-Match` on an existing document, and `If-Match`
  on an unmapped name, answer 412. A name with a `/` or an invalid name answers 403.
- `DELETE` of a document needs a matching `If-Match` (428 without one, 412 when stale), and
  answers 204.

WebDAV errors other than the depth refusal and the multistatus are plain text.

## The file endpoints

- **The scanner gateway (2007).** Network scanners could not build multipart bodies, so
  `POST /upload/raw?name=<file name>` takes the raw bytes as `application/octet-stream` and answers
  a one-line plain-text receipt, `STORED <id> <size> <etag>` and CRLF, which the scanner firmware
  prints. Raw uploads carry no content type, so it is guessed from the name's extension: `.pdf` is
  `application/pdf`, `.txt` `text/plain`, `.xml` `application/xml`, and anything else
  `application/octet-stream`.
- **The browser uploader (2015).** `POST /upload` takes `multipart/form-data` with a `label` field
  and a `file` part, and answers JSON: the web team never adopted the SOAP vocabulary. The
  document's name is the part's file name, its title the label, and its content type the part's
  (`application/octet-stream` when it has none). Success is 201 with
  `{ "id", "name", "label", "size", "etag" }` and `Location: /dav/documents/<name>`.
- **Bundles (2015).** `GET /bundle/<id>` returns the document and its metadata together. The same
  web team reused the browser's upload format for the download, so the bundle is
  `multipart/form-data` with a `metadata` part (`application/json`, as a file named
  `metadata.json`) and a `content` part holding the bytes. The metadata is
  `{ "id", "name", "title", "contentType", "size", "etag", "modified" }`. The content part's file
  name is the document's name as raw UTF-8, with `"` written as `%22`, as browsers write it. The
  boundary is `DocVaultBundle-<id>-<version>`, the version counting the document's writes from 1.
  When a part holds `--` and that boundary, the bundle takes the first of
  `DocVaultBundle-<id>-<version>-2`, `-3` and so on that no part holds, since a boundary must never
  occur inside a part ([RFC 2046 section 5.1.1](https://www.rfc-editor.org/rfc/rfc2046#section-5.1.1)).

Both uploads refuse with plain text: 400 for a missing name, label or file part, an empty raw
upload, a malformed body or an invalid name; 415 for the wrong media type; and 409 for a name that
exists. An unknown bundle id answers 404.

## Test options

Start the store with `lane.backend("soap-store", options)`. Every start has fresh state. Options
are plain JSON, and every member is optional.

- `documents`: documents present at start, as `{ name, title, contentType, text?, base64?,
modified? }`. `text` is UTF-8 content; `base64` is binary content, used when `text` is absent.
  `modified` is an ISO 8601 time and defaults to the clock. Defaults to none.
- `collections`: the subcollections under `/dav/documents/`. Defaults to
  `["archive", "templates"]`.
- `clock`: a fixed clock as ISO 8601, for modification times and lock expiry. Defaults to the real
  time.
- `failStore`: `{ names?, calls? }`. `StoreDocument` answers fault code 5003 ("Storage backend
  unavailable; the document was not stored") inside HTTP 200, without storing, for the listed names
  or 1-based call numbers. Calls are counted among the well-formed `StoreDocument` calls.
- `latency`: milliseconds to wait before answering, per action name, including
  `DownloadDocument`. The wait ends early when the client goes away.
- `hold`: action names that never answer; such a request stays open until the client disconnects.
