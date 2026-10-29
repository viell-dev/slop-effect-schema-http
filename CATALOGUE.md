# Scenario catalogue

Every entry of the scenario catalogue in
[issue #4](https://github.com/viell-dev/slop-effect-schema-http/issues/4) has an ID here. Tests put
the ID at the start of their title, such as `[AUTH-3] refuses an unknown token scheme`, so
`rg "\[AUTH-3\]" src` finds the evidence. One entry can have several tests.

Each entry's status is one of:

- **pending**: not covered yet;
- **tested**: covered by the tests named in the entry;
- **limit**: the behavior belongs to the transport or platform, with the observed constraint
  described;
- **defect**: a reproduced library mismatch, with a link to its issue.

Backends are owned by area. Each area keeps the status of its entries up to date in its own
section.

## Identity provider (`identity`)

Scenarios are in `src/scenarios/identity.test.ts` and run in both lanes (Node and Chromium) unless
marked node-only, in which case they are in `identity.node.test.ts`. Round trips are in
`src/values/identity.test.ts` and `src/clients/identity/schemas.test.ts`.

- **AUTH-3** Three casings of the token type from three code paths: normalize known spellings,
  refuse an unknown scheme. Status: tested.
  - `[AUTH-3] normalizes the three token-type spellings of the three grant paths`
  - `[AUTH-3] refuses an unknown token scheme as a decode error instead of guessing`
  - `[AUTH-3] the resource filter refuses the login's own spelling echoed verbatim`
  - Round trips: `[AUTH-3] normalizes the three known spellings and encodes the RFC 6750 one`,
    `[AUTH-3] refuses unknown schemes and unknown casings rather than guessing`, and the two
    `[AUTH-3]` contract tests. Normalization is canonicalizing: the original spelling is the
    stated loss, and the domain value round-trips.
- **AUTH-4** Opaque access tokens next to JWT refresh tokens; the client never inspects either.
  Status: tested.
  - `[AUTH-4] returns a JWT-shaped refresh token byte for byte without reading its stale claims`
  - `[AUTH-4] a rotated refresh token is refused by the server, not judged by the client`
  - `[AUTH-4] client credentials issue the pinned opaque token, which the directory accepts`
  - `[AUTH-4] keeps tokens opaque, redacted, and not interchangeable` (type-level)
- **AUTH-8** A rate limiter keyed on a trusted `X-Forwarded-For`; the test exploits it for a
  private bucket. Status: tested.
  - `[AUTH-8] a shared bucket spent by other traffic refuses an honest request with a bare message`
  - `[AUTH-8] a forged X-Forwarded-For claims a private bucket of the test's own`
- **ERR-4** A missing user answered as 200 with an active flag of `N` and blank fields: nulls in the
  domain type and a boolean nobody can ignore. Status: tested.
  - `[ERR-4] a missing user arrives as 200 with ACTIVE N and blank fields, and decodes to nulls`
  - `[ERR-4] an inactive user keeps its values, and none reads as present until active is checked`
    (type-level: attributes are `string | null` until `active` narrows them)
  - Round trips: `[ERR-4]` tests for `YesNo`, `blankAsNull` and directory entries.
- **ERR-5** Four error shapes from one organisation (OAuth error object, bare message object, nested
  code and message for 4xx, flat string for 5xx): per-status rules and a client-chosen
  discriminant attached on decode and stripped on encode. Status: tested.
  - `[ERR-5] the token servlet's 400 decodes as a tagged OAuth error`
  - `[ERR-5] the resource filter's 401 decodes as a tagged bare message`
  - `[ERR-5] the JSON API's 401 decodes as a tagged, flattened code and message`
  - `[ERR-5] a 5xx flat string decodes as a tagged server fault`
  - `[ERR-5] a stalled directory surfaces as a timeout, not as a fifth error shape`
  - Round trips: `[ERR-5] attaches the tag on decode and strips it on encode`,
    `[ERR-5] refuses one organisation's shape under another's schema`
- **STAT-1** Register answers 201 with the user, login answers 200 with only tokens: fetch the
  profile separately. Status: tested.
  - `[STAT-1] register answers 201 with the entry, login only tokens, and the profile takes a third
request`
  - `[STAT-1] refuses an invalid uid before dispatch`
  - `[STAT-1] the provider refuses a short password the client let through, and a taken uid`
- **HDR-1** Repeated header lines: one scope per request line with comma-joined values rejected,
  and four scope lines in the response. Fetch joins the lines and is rejected; the custom provider
  succeeds; response metadata says whether original lines exist; `Set-Cookie` is parsed separately.
  Status: tested.
  - `[HDR-1] Fetch joins the scope lines, and the provider rejects the comma-joined value`
  - `[HDR-1] through Fetch the response metadata says no original lines exist` (the session
    cookie is visible in Node and absent in Chromium, asserted per lane)
  - `[HDR-1] refuses a scope containing a comma before dispatch`
  - Node-only: `[HDR-1] the line-preserving provider sends one scope per line and reads four
granted lines`, `[HDR-1] parses each Set-Cookie line separately in Node, through both
providers`. Observed: Effect's normalized `headers["set-cookie"]` keeps only the last line,
    while `cookies` holds both.
- **PAY-9** A form-encoded grant beside a JSON grant, 415 when the wrong one is sent, and every
  response value a string, including the expiry. Status: tested.
  - `[PAY-9] sends grants form-encoded and decodes string values, including the expiry`
  - `[PAY-9] sends the JSON grant as JSON and decodes a numeric expiry into the same domain type`
  - `[PAY-9] the form endpoint answers JSON with 415 and an OAuth error`
  - `[PAY-9] the JSON endpoint answers a form with 415 and a coded error`
  - Round trips: the `[PAY-9]` tests for `IntegerString`, form grants and scope lists.
- **VAL-1a** LDAP generalized time, strict and reversible. Status: tested.
  - `[VAL-1a] decodes the directory's LDAP times to instants`
  - `[VAL-1a] refuses an imported entry's fractional time as a final decode error`
  - Round trips: four `[VAL-1a]` tests for `LdapTime`, including calendar-impossible values and
    an encode that refuses to drop milliseconds.
- **VAL-5a** Upper-case attribute names and an issuer with a trailing slash. Status: tested.
  - `[VAL-5a] reads upper-case attribute names into the domain's own field names`
  - `[VAL-5a] discovers from an issuer with a trailing slash without doubling it`
  - `[VAL-5a] refuses a discovery document whose issuer differs by the trailing slash`
  - `[VAL-5a] string concatenation doubles the slash and meets an unexpected 404`
  - Round trips: the `[VAL-5a]` tests for `Issuer` and directory entries (the unmodelled `DN` is
    the stated loss).

## SOAP document store (`soap-store`)

Scenarios are in `src/scenarios/soap-store.test.ts` and run in both lanes (Node and Chromium);
tests marked "(provider)" run once per provider of the lane (`fetch` in both, `lines` in Node).
Node-only scenarios are in `soap-store.node.test.ts` and browser-only ones in
`soap-store.browser.test.ts`. Round trips are in `src/values/soap-store.test.ts`, and the consumer's
XML helper tests in `src/formats/xml.test.ts`. The backend is `src/backends/soap-store/`; its quirks are
documented in `soap.ts`, `dav.ts` and `files.ts`.

- **ERR-1a** A SOAP fault code where zero means success, inside HTTP 200: body-level
  discrimination. Status: tested.
  - `[ERR-1a] stores and fetches a document, reading FaultCode 0 as success` (provider)
  - `[ERR-1a] a missing document and a duplicate name arrive as HTTP 200 with nonzero fault codes`
  - `[ERR-1a] the failStore switch refuses chosen names and calls with fault code 5003, storing
nothing`
  - `[ERR-1a] refusedAsFailure moves a nonzero fault code into the failure channel`
  - `[ERR-1a] a held store fails as the caller's timeout, not as a fault code, and the store sees
the abort`
  - `[ERR-1a] a body-level refusal shares the success union, so reading a document needs
narrowing` (type-level)
  - Round trip: `[ERR-1a] action results round-trip success and refusal, and refuse a refusal
carrying success fields`. A success's `FaultString` is informational and not kept; encoding
    writes `OK`.
- **ERR-6** One action that returns a real SOAP fault with HTTP 500: one more rule. Status: tested.
  - `[ERR-6] LockDocument answers a conflict with a SOAP fault under HTTP 500, read by its one
extra rule` (provider)
  - `[ERR-6] the default classifier retries the mapped 500 fault; a classifier for the special
case sends once`. Observed, and as designed: `Policy.transient` classifies status 500 as
    transient even when a rule mapped it, so the default policy sends a lock conflict three
    times; a `while` classifier limited to failures sends it once.
  - `[ERR-6] only LockDocument's union holds SOAP faults: one more rule` (type-level)
  - Round trip: `[ERR-6] SOAP faults round-trip in both versions, with Client and Server read as
Sender and Receiver`
- **STAT-7** PROPFIND answered with 207, plus 412, 428, 415, and 405 with `Allow`: methods as
  strings, statuses as numbers. Status: tested.
  - `[STAT-7] PROPFIND travels as a method string with Depth: 1 and its 207 multistatus decodes`
    (provider)
  - `[STAT-7] 428, 412 and 415 are ordinary declared statuses of a WebDAV write`
  - `[STAT-7] MKCOL on an existing collection answers 405 with an Allow list read through a header
schema`
  - Round trip: `[STAT-7] AllowList round-trips method tokens case-sensitively and refuses
non-tokens`. Separators and empty list elements are not kept; encoding joins with `", "`.
- **STAT-12** A GET carrying a SOAP body for downloads: rejected client-side before dispatch as a
  typed error. Status: tested.
  - `[STAT-12] the documented GET download with a SOAP body is refused before dispatch` (provider;
    `InvalidRequest`, empty ledger)
  - `[STAT-12] POST does not reach the download servlet either: 405 with Allow: GET`
  - Node-only: `[STAT-12] the fixture really serves a GET with a SOAP body, reachable only by
rewriting the method in client middleware`. Client middleware runs after the library's check,
    so the line-preserving provider sends the GET with its body and the servlet answers; Node's
    `fetch` refuses the same request as a transport error.
- **HDR-5e** Latin-1 bytes under a charset-less `text/xml`. Status: tested.
  - `[HDR-5e] SOAP 1.1 replies are Latin-1 bytes under a charset-less text/xml; UTF-8 text
decoding corrupts them silently`. Verified in both lanes: `Body.text` decodes the reply as
    UTF-8 without failing and turns every Latin-1 letter into U+FFFD, while the character
    references above U+00FF survive; a strict UTF-8 decoder fails as `DecodeError`.
- **HDR-5f** SOAP 1.2 carrying the action inside the content type: a protocol version change is a
  codec change, not a header change. Status: tested.
  - `[HDR-5f] SOAP 1.2 carries the action in the codec's content type and sends no SOAPAction`
    (provider)
  - `[HDR-5f] a Content-Type declaration does not relabel a SOAP 1.1 body as SOAP 1.2` (provider;
    the codec's `text/xml` goes out as the only content-type line)
- **HDR-6** `SOAPAction` required, quoted, and matching the body action: one declared header per
  action. Status: tested.
  - `[HDR-6] every action declares one quoted SOAPAction naming its body element` (provider)
  - `[HDR-6] the front controller refuses a missing, unquoted or mismatched SOAPAction with
plain-text 400` (`UnexpectedResponse`, then the reason through a declared 400)
  - `[HDR-6] fetch joins two SOAPAction lines into one value, which the controller refuses as
unquoted`
  - Node-only: `[HDR-6] two SOAPAction lines are refused as repeated through the line-preserving
provider`
- **PAY-3a** SOAP 1.1 and 1.2 under a custom namespace; three list shapes for zero, one, and many
  items, with the single item wrapped in an extra element; WebDAV multistatus with collections
  skipped; a WSDL. Status: tested.
  - `[PAY-3a] ListDocuments decodes zero, one wrapped and many items` (the three shapes are also
    observed as sent)
  - `[PAY-3a] a depth-1 multistatus lists the collection and its subcollections, which the listing
skips`
  - `[PAY-3a] the WSDL names every client action's URI in both bindings`
  - `[PAY-3a] an operation outside the store's namespace is refused, even when SOAPAction names the same namespace`
    (a wrong namespace in both places, in SOAP 1.1 and 1.2, and a missing one: plain-text 400)
  - `[PAY-3a] any prefix bound to the store's namespace dispatches, wherever the binding is declared`
  - SOAP 1.2 through the store: the `[HDR-5f]` tests.
  - Round trips: `[PAY-3a] ListDocuments results round-trip all three list shapes and refuse the
others`, `[PAY-3a] SOAP 1.1 and 1.2 documents round-trip a payload and refuse the other
version's envelope`, and `[PAY-3a] the WSDL summary and the WebDAV listing are decode-only, and
their reverse says why` (each drops what it skips, so its encoder fails with that reason).
- **PAY-4a** Latin-1 XML whose encoding must be read from its own declaration. Status: tested.
  - `[PAY-4a] reads ISO-8859-1 from the reply's own declaration, character references included`
  - Round trips: `[PAY-4a] XmlTextFromBytes reads the encoding from the declaration and writes the
same bytes back`, `[PAY-4a] XmlTextFromBytes refuses bytes invalid in the declared encoding,
other encodings, and characters ISO-8859-1 lacks`. ISO-8859-1 is decoded byte by byte,
    because the WHATWG `TextDecoder` label `iso-8859-1` means windows-1252.
  - XML's character rules hold on both sides, each in its own reader and writer:
    `[PAY-4a] the store refuses characters XML does not allow, raw or as references, with plain-text 400`,
    `[PAY-4a] a title XML cannot carry is refused by the consumer before dispatch` (`SchemaError`,
    empty ledger) and
    `[PAY-4a] the store reads a title's line ends as LF, and a carriage return written as a reference survives the round trip`.
  - Browser-only: `[PAY-4a] Chromium's DOMParser reads the store's replies and the consumer's requests without a parsererror`,
    an independent parser over SOAP 1.1 and 1.2 replies, a fault, and every request the consumer
    wrote, with the stored title read back exactly.
  - Helper: `[PAY-4a] refuses characters outside XML's Char production, raw or as references`,
    `[PAY-4a] normalizes line ends to LF before parsing, and keeps a referenced carriage return`,
    `[PAY-4a] refuses a bare ampersand, '<' in an attribute value and ']]>' in text`, and
    `[PAY-4a] writes carriage returns, tabs and line feeds so they survive parsing, and refuses non-characters`.
- **PAY-6** Multipart in both directions: a `FormData` upload with a `Blob` and a label, and a
  response bundle with a JSON metadata part and a bytes part, read asynchronously inside the schema.
  Status: tested.
  - `[PAY-6] uploads a FormData with a Blob and a label` (provider; Node's `fetch`, Chromium and
    the line-preserving provider all send the non-ASCII file name as raw UTF-8)
  - `[PAY-6] a blank label is refused by the input schema before dispatch` (`SchemaError`, empty
    ledger)
  - `[PAY-6] reads a multipart bundle whose parts are awaited inside the schema` (provider)
  - Round trips: `[PAY-6] the upload form round-trips through FormData and refuses other parts`,
    `[PAY-6] the bundle round-trips through FormData, awaiting both parts inside the schema`. The
    metadata part's own file name is not kept.
- **PAY-7** A raw bytes upload with the file name in the query string and a one-line text receipt.
  Status: tested.
  - `[PAY-7] uploads raw bytes with the file name in the query and decodes the one-line receipt`
    (provider)
  - Round trip: `[PAY-7] UploadReceipt round-trips one CRLF-terminated line and refuses looser
receipts`
- **QRY-1** A bare key and an empty value are different requests (`?wsdl` versus `?wsdl=`). Status:
  tested.
  - `[QRY-1] ?wsdl and ?wsdl= are different requests` (provider; through a query schema and
    through a URL string, both lanes keep the bare key)
  - `[QRY-1] ?wsdl=types names the schema part, which the WSDL contract refuses as a decode error`
- **RET-3** ETag with `If-None-Match` yielding 304 and no body, `If-Match` yielding 412, and 428
  when the validator is missing. Status: tested.
  - `[RET-3] If-None-Match with the current ETag yields 304 and no body` (provider; Chromium
    passes the manually set validator through and hands the 304 to the page)
  - `[RET-3] validators guard writes: 201 to create, 204 to replace, 412 for a replaced or weak
tag, 428 without one`
  - `[RET-3] the ETag StoreDocument returns guards the same document's WebDAV write`
  - Round trips: `[RET-3] EntityTag round-trips strong and weak tags and refuses looser
spellings`, `[RET-3] ConditionHeaders round-trips the three write conditions and refuses both
validators together`

## JSON business API: envelopes (`business/envelopes`)

Scenarios are in `src/scenarios/business-envelopes.test.ts` and run in both lanes (Node and
Chromium); a title ending in `(lines)` or `(fetch)` runs once per provider the lane offers. The
raw-socket check is in `business-envelopes.node.test.ts`. Round trips for the dialect schemas are in
`src/clients/business/envelopes-dialects.test.ts`.

- **ERR-1d** "Not found" answered as 200. Status: tested.
  - `[ERR-1d] decodes a found customer and a not-found 200 into one union` (and moves the
    not-found envelope into the failure channel with `Operation.mapEffect`)
- **ERR-2** An error code in a response header on a 200 (a load balancer ejects nodes answering
  anything else): a header rule selected before any body byte is read, ranked above the plain 200
  rule. Status: tested.
  - `[ERR-2] selects the header error rule ahead of the plain 200 rule`
  - `[ERR-2] declared after the plain 200 rule, the header rule is unreachable and the decode
failure is final`
- **ERR-3** A batch endpoint whose envelope is always 200 with per-item statuses inside:
  discrimination in the schema. Status: tested.
  - `[ERR-3] discriminates per-item statuses inside an always-200 batch envelope`
  - `[ERR-3] refuses a batch item whose status contradicts its payload`
- **ERR-7** Rule matching never peeks at the body. Status: tested. Client middleware replaces each
  body with a stream that records every pull, and a never-matching first rule records selection.
  - `[ERR-7] selects the header rule from metadata alone and never reads its body`
  - `[ERR-7] reads a selected or unmatched body only after selection has finished`
  - `[ERR-7] rules see transport metadata only; the type offers no body` (type-level)
- **STAT-2** Creation answering 200 instead of 201 with a relative `Location`: resolve it against the
  base URL. Status: tested. The path-absolute `Location` is resolved against the request URL
  (RFC 9110); joining it to the base URL would duplicate `/v1`.
  - `[STAT-2] resolves the relative Location of a 200 creation and follows it`
  - Round trip: `[STAT-2] a Location resolves against its request URL and refuses to encode` (the
    container's spelling is the stated loss).
- **STAT-3** A 204 whose handler writes a debug body the container never sends: declare the body
  honestly empty; a JSON declaration exposes the documented quirk as fiction. Status: tested.
  Verified: Node's server sends the 204 head with no `Content-Length`, no `Transfer-Encoding` and
  no body bytes, although the handler writes JSON.
  - `[STAT-3] declares the 204 honestly empty; declaring JSON exposes the debug body as fiction`
  - Node-only: `[STAT-3] the fixture's 204 carries no body bytes on the wire` (raw socket)
- **STAT-4** A 200 with a JSON content type and zero bytes: an explicit empty-body declaration.
  Status: tested.
  - `[STAT-4] an explicit empty declaration accepts a 200 JSON response of zero bytes`
- **STAT-5** 202 Accepted with a relative `Location` and `Retry-After`, pending for the first polls:
  polling is a loop over a cold request, not a retry. Status: tested. The test waits a tenth of each
  requested second and asserts the requested delays. Observed: re-executions differ only in Effect's
  per-execution `b3` and `traceparent` lines.
  - `[STAT-5] polls a 202 export with the same cold request until it is done`
  - `[STAT-5] a retry policy does not poll: a pending 202 is a success` (also a typed failure when
    the poll budget runs out)
- **STAT-13** PATCH returning the state before the write: re-read and never trust the response.
  Status: tested.
  - `[STAT-13] re-reads after PATCH instead of trusting the pre-write state it returns`
- **HDR-2** `Link`-header pagination with zero-based offsets while the query parameter is one-based:
  a schema that parses the header and converts. Status: tested.
  - `[HDR-2] walks Link pagination by converting zero-based offsets to one-based pages`
  - `[HDR-2] following the Link target literally reads the first page again`
  - Round trips: `[HDR-2] the gateway's Link spelling round-trips and looser spellings are
refused`, `[HDR-2] a zero-based window converts to a one-based page and back`, `[HDR-2]
pagination links decode to pages and encode to the gateway's header`.
- **HDR-3** Relative versus absolutized `Location` for the same intent, decided by the container:
  resolve either, after verifying what the fixture really sends. Status: tested. Verified: Node
  never rewrites `Location`, so only the fixture's legacy container sends the absolute form; the
  original lines (Node lane, line provider) and Fetch's headers in both lanes carry each form as sent.
  - `[HDR-3] resolves either Location form, as each container really sends it`
- **HDR-5a** JSON served as `text/html`. Status: tested.
  - `[HDR-5a] decodes JSON served as text/html, never dispatching on content type`
- **HDR-5b** JSON served as `text/json`. Status: tested.
  - `[HDR-5b] decodes JSON served as text/json`
- **HDR-5c** OData's verbose content-type parameter. Status: tested.
  - `[HDR-5c] decodes OData verbose JSON whatever its content-type parameters say`
- **PAY-1** JSON dialects: an anti-hijacking prefix, a JSONP wrapper where any other callback name is
  a decode failure, an OData v2 envelope with metadata and a stringified count, a column-oriented
  grid whose column order is verified, a single result unwrapped from its array, and an enum sent
  as a name but returned as an ordinal. Status: tested.
  - `[PAY-1] strips the anti-hijacking prefix before parsing JSON`
  - `[PAY-1] unwraps JSONP for the requested callback and refuses any other name`
  - `[PAY-1] refuses a JSONP callback that is not an identifier before dispatch`
  - `[PAY-1] reads an OData v2 envelope with metadata and a stringified count`
  - `[PAY-1] maps a column grid through its verified header in any column order` (with the
    positional control that silently swaps two money columns)
  - `[PAY-1] normalizes a single result unwrapped from its array, and none`
  - `[PAY-1] sends a tier as a name and reads it back from an ordinal`
  - Round trips: `[PAY-1] the anti-hijacking prefix round-trips and is required`, `[PAY-1] a JSONP
frame round-trips for its callback and refuses any other`, `[PAY-1] an OData count
round-trips as canonical digits only`, `[PAY-1] a grid maps rows through its verified header
and encodes the documented order`, `[PAY-1] an unwrapped list round-trips for none, one and
many items`, `[PAY-1] a tier is a name in requests and an ordinal in responses`.
- **PAY-2** 64-bit identifiers above 2^53 that the platform parser rounds: read as text and parse
  losslessly before the schema sees them, with the lossy control case. Status: tested. The lossless
  dialect uses `JSON.parse` source text access and `JSON.rawJSON`, available in Node 24 and
  Chromium.
  - `[PAY-2] parses 64-bit ledger ids losslessly and fetches the right row by id`
  - `[PAY-2] the platform JSON parser rounds an id into the previous row's (lossy control)`
  - Round trips: `[PAY-2] lossless JSON keeps 64-bit ids exact in both directions`, `[PAY-2] an
exact id refuses a value the platform parser already rounded`.
- **APP-4** Unmodelled responses drained and surfaced as an unexpected-status failure, or read by an
  explicit fallback inside the operation scope as text or discarded. Status: tested. The unmodelled
  response is the stock HTML page of a web application firewall.
  - `[APP-4] drains an unmodelled firewall page and fails with UnexpectedResponse`
  - `[APP-4] an explicit fallback reads an unmodelled body as text inside the operation`
  - `[APP-4] an explicit fallback can discard an unmodelled body, draining it before the operation returns`
    (a pull-observing body shows the page read to its end before the operation returns; a control
    fallback that ignores the body shows that nothing else reads it)
- **APP-5** Validation on both sides: the client refuses an empty string before any network; the
  server refuses a blank string the client accepted. Status: tested.
  - `[APP-5] refuses an empty customer name before any network`
  - `[APP-5] the server refuses a blank name that the client accepted`

## JSON business API: operations (`business/operations`)

Scenarios are in `src/scenarios/business-operations.test.ts` and run in both lanes (Node and
Chromium); tests over `lane.clients` run once per provider in the lane. Node-only scenarios, about
the line-preserving provider, are in `business-operations.node.test.ts`. Round trips are in
`src/values/business.test.ts`. The backend's conventions, options and endpoints are documented at
the top of `src/backends/business/operations.ts`.

- **STAT-8** An unregistered 420 with `Retry-After`: not transient by default, with a classifier
  that adds it without losing the built-in cases. Status: tested.
  - `[STAT-8] the unregistered 420 is not transient by default`
  - `[STAT-8] a classifier adds 420 and keeps the built-in 503, honouring Retry-After`
  - `[STAT-8] a classifier that replaces the built-in cases loses the 503 that follows`
- **STAT-9** 429 and 503 with `Retry-After` as an HTTP date: both forms honoured unaided. Status:
  tested. The fixture refuses an early return with the same answer, so a fixed retry budget
  succeeds only when every wait was honoured.
  - `[STAT-9] Retry-After in seconds and as an HTTP-date are both honoured unaided`
  - `[STAT-9] a 429 with an HTTP-date Retry-After is honoured`
  - `[STAT-9] ignoring Retry-After meets the same refusal until the budget runs out`
- **STAT-11** A gateway that strips PUT and DELETE, with the service refusing raw ones too: a
  reusable transform that rewrites the method to POST and sets an override header, used even for
  rollback. Also listed under the gateway; this business API is the service behind such a gateway.
  Status: tested.
  - `[STAT-11] the gateway refuses a raw PUT and DELETE (<provider>)`
  - `[STAT-11] the tunnel sends PUT and DELETE as POST with an override (<provider>)`
  - `[STAT-11] a rollback deletes the created tasks through the tunnel after a failure`
  - Node only:
    `[STAT-11] the tunnel needs nothing from the provider; node:http sends the body-less POST chunked`.
    Fixture fact: `node:http` frames a body-less POST as chunked with no `Content-Length`, where
    Fetch sends `content-length: 0`.
- **HDR-8** An edge cache that ignores request `Cache-Control` and honours only a cache-key
  parameter: the cache header, a computed cache-busting query, and the transport cache mode travel
  together as one transform; the test purges first. Status: tested.
  - `[HDR-8] the edge ignores Cache-Control and the cache mode, and honours only the cache key`
  - `[HDR-8] purging the edge leaves the platform cache, which the transform's cache mode skips`
  - Node only:
    `[HDR-8] the line-preserving provider carries the header and the cache key, without a cache mode`
  - Observed: Fetch acts on the `no-store` mode in both lanes by adding `Cache-Control: no-cache`
    and `Pragma: no-cache` request headers. In Chromium the platform cache is a second layer: it
    keeps the edge's `max-age` response, a PURGE does not invalidate it (a POST does), and a plain
    read after the purge is answered without a request. Node's Fetch keeps no HTTP cache.
- **VAL-1b** Dates: epoch milliseconds, the ASP.NET `/Date(…)/` form with a decorative offset, US
  month-first local time with no zone, and HTTP-date; strict reversible transforms that refuse
  looser input. Status: tested.
  - `[VAL-1b] invoice dates decode from epoch, ASP.NET, US local and HTTP-date forms`
  - Round trips: `[VAL-1b] round-trips epoch milliseconds and refuses strings and fractions`,
    `[VAL-1b] keeps the decorative ASP.NET offset without shifting the instant`,
    `[VAL-1b] reads US local time as a wall clock, never as an instant` (with the permissive
    `Date.parse` control, whose instant moves with the reader's offset), and
    `[VAL-1b] round-trips IMF-fixdate HTTP-dates and refuses the obsolete forms`.
- **VAL-2a** Money as a formatted dollar string; branded integer cents in both directions, refusing
  unformatted input. Status: tested.
  - `[VAL-2a] amounts decode to branded cents from the service's dollar strings`
  - `[VAL-2a] the service refuses unformatted money and loose spellings from an untyped body`
  - Round trip: `[VAL-2a] round-trips formatted dollars as branded integer cents`
- **VAL-3a** Booleans as `Y` and `N`, with `y`, `1`, and `true` refused. Status: tested.
  - `[VAL-3a] Y and N flags decode to booleans`
  - Round trip: `[VAL-3a] accepts only Y and N`
- **VAL-4** Absence: `null`, empty string, the string `"null"`, a missing key, a blank string, and
  `-1` for unlimited next to `0` for a real limit; collapse into an optional and keep unlimited
  distinct from zero. Status: tested. The collapse is the stated loss: every absence encodes as
  the missing key, and a present value the wire would read as absent is refused before dispatch.
  - `[VAL-4] five spellings of absence collapse, and unlimited stays distinct from zero`
  - `[VAL-4] re-encoding writes the canonical absence, which the service stores and serves`
    (Chromium reuses the earlier list by heuristic freshness from `Last-Modified`; the test asserts
    each lane's behaviour and reads past the platform cache for the service's state)
  - Round trips: `[VAL-4] collapses five spellings of absence into one missing key`,
    `[VAL-4] keeps unlimited distinct from a limit of zero`
- **VAL-5b** A reference that is an expanded object in some rows and a bare id in others, and
  space-delimited lists where the spec says arrays. Status: tested.
  - `[VAL-5b] customers arrive expanded once, then as bare ids, and tags as words`
  - Round trips: `[VAL-5b] tags an expanded customer and a bare id, and restores each shape`,
    `[VAL-5b] reads space-delimited lists as arrays`
- **QRY-2** Repeated parameters where the server keeps only the last: the client can append; the
  collapse is the server's, verified against the fixture. Status: tested.
  - `[QRY-2] repeated parameters reach the server, which keeps the last (<provider>)`
  - Fixture fact: keeping the last is this fixture's deliberate PHP-era rule, confirmed by the
    filter it echoes; `URLSearchParams.get` keeps the first. Both providers send both entries.
- **QRY-3** An empty path segment left to the application contract, and a base URL replaceable per
  operation. Status: tested.
  - `[QRY-3] an empty id leaves an empty segment, and merged slashes answer another resource`
  - `[QRY-3] the application contract refuses an empty id before dispatch`
  - `[QRY-3] one operation replaces the shared base URL and keeps the credential`
- **RET-1** A strictly increasing nonce in front of two 503 warm-ups with HTTP-date `Retry-After`,
  the replay check before the warm-up check. A retry that replays the encoded request turns a
  transient failure permanent (pinned), then a caller-driven loop and per-attempt client middleware
  advance the nonce while keeping the budget and `Retry-After`. Credentials resolve once per
  evaluation. Status: tested.
  - `[RET-1] a policy that replays the encoded request turns the warm-up into a permanent replay`
  - `[RET-1] a caller-driven loop takes a new nonce per execution and honours Retry-After`
  - `[RET-1] the caller-driven loop stops at its own budget`
  - `[RET-1] per-attempt middleware advances the nonce while the credential resolves once`
  - `[RET-1] the policy's budget still bounds per-attempt retries`
- **RET-2** A long poll held open: a whole-operation timeout surfaces as a timeout failure, not a
  mapped response. Status: tested.
  - `[RET-2] a whole-operation timeout fails as a timeout, and the server sees the abort`
  - `[RET-2] a per-attempt timeout is transient and retried, then surfaces as a timeout`
  - `[RET-2] a poll the server ends, or an event releases, decodes as the mapped answer`

## CGI reporting gateway (`gateway`)

Scenarios are in `src/scenarios/gateway.test.ts` and run in both lanes (Node and Chromium); the two
that need the line-preserving provider are in `gateway.node.test.ts`. Round trips are in
`src/values/gateway.test.ts` and in the CSV, fixed-width and XML-RPC helper tests under
`src/formats`. The backend's endpoints and its month-end extract and token options for the flows
are documented at the top of `src/backends/gateway/index.ts`.

- **AUTH-2** A session obtained by GET with the password in the query string, then carried as a
  query parameter: declared as is. Status: tested.
  - `[AUTH-2] logs in by GET with the password in the query string, then carries the session as a
query parameter` (the password `p+ss w&rd;1` arrives percent-encoded, so CGI.pm's `+` and `;`
    handling cannot alter it)
  - `[AUTH-2] a wrong password and an unknown session are ERROR lines inside 200`
  - `[AUTH-2] a blank user or a malformed account is refused before dispatch`
  - `[AUTH-2] the configured SSO token is accepted wherever a session is`
- **AUTH-7** HTTP Digest in the 1997 form without `qop`: a 401 challenge as a declared response, an
  MD5 response, a single-use nonce, and `stale=true` on replay; the same cold request executed again
  with one added header. Status: tested.
  - `[AUTH-7] the 401 challenge is a declared response, and the same cold request runs again with
one added header` (type-level: the report is unreachable until the challenge is ruled out)
  - `[AUTH-7] a replayed Authorization is answered with stale=true and a fresh nonce`
  - `[AUTH-7] wrong credentials end the loop with a typed rejection after two requests`
  - `[AUTH-7] a response computed over another URI is refused by the server's uri check`
  - Node-only: `[AUTH-7] through the line-preserving provider, the authorized request is the cold
request's lines plus one`
  - MD5 is a pure TypeScript implementation (`src/formats/md5.ts`, RFC 1321 vectors), because
    Web Crypto has none. Chromium returns the 401 to the page without an authentication prompt.
- **ERR-1b** XML-RPC faults inside 200. Status: tested.
  - `[ERR-1b] an XML-RPC fault inside 200 is a member of the result union` (type-level as well)
  - `[ERR-1b] a fault can be moved into the failure channel by the consumer`
  - Schema: `[ERR-1b] an outcome is a result or a fault, both members of one union`
- **ERR-1c** Pipe-delimited `ERROR` lines inside 200. Status: tested.
  - `[ERR-1c] an ERROR line inside 200 decodes as a gateway error beside the OK line`
  - `[ERR-1c] a reply that is neither an OK nor an ERROR line is a decode error`
- **STAT-6** A HEAD probe whose facts live only in headers: an ordinary schema over the header map.
  Status: tested.
  - `[STAT-6] a HEAD probe reads the extract's facts from its headers with an ordinary schema`
  - `[STAT-6] a probe of a missing period is a mapped 404, and a malformed one is never sent`
  - Observed: Node's server drops a HEAD body and keeps the explicit `Content-Length`.
- **STAT-10** A 301 kept alive for an old compiled-in path: unreachable through a redirect-following
  transport; a per-request transport option is the only escape. Status: tested.
  - `[STAT-10] Fetch follows the 301, so the declared 301 case is unreachable` (both lanes: two
    requests, the declared 301 never matches)
  - `[STAT-10] Fetch with redirect: "manual", a per-request transport option outside the library`
    (per lane: Node's fetch hands the 301 and its absolute `Location` to the declared case;
    Chromium returns an opaque redirect with status 0 and no headers, so the operation fails with
    `UnexpectedResponse` and the 301 stays unreachable)
  - Node-only: `[STAT-10] the line-preserving provider observes the 301 itself`
- **HDR-5d** CSV served as `application/octet-stream`. Status: tested.
  - `[HDR-5d] CSV served as application/octet-stream decodes by status and body, never by content
type`
  - `[HDR-5d] a rule keyed on the advertised CSV content type never matches`
  - `[HDR-5d] a refused export is an ERROR line in 200 that the same body schema recognises`
- **PAY-3b** XML-RPC with `i4`, `double`, `boolean`, `dateTime.iso8601`, `base64`, `struct`, `array`,
  and bare scalar responses. Status: tested.
  - `[PAY-3b] an invoice struct carries i4, double, boolean, dateTime.iso8601 and an array of
structs`
  - `[PAY-3b] bare scalar responses: an i4 count, an untyped string and an array of strings`
  - `[PAY-3b] a header declaration cannot relabel a text body, so the gateway refuses the call`
    (both lanes send `text/plain`: the body codec owns the content type)
  - Helper: `[PAY-3b] parses every type into a lossless tree, ignoring whitespace between
elements`, `[PAY-3b] round-trips calls and faults`, `[PAY-3b] refuses malformed responses instead
of guessing`, `[PAY-3b] scalar schemas read the type element and refuse other types or
spellings`
- **PAY-4b** A UTF-8 BOM that would poison the first CSV column name. Status: tested.
  - `[PAY-4b] a BOM-preserving decode poisons the first column name; the byte codec does not`
  - `[PAY-4b] Fetch's text decoding drops the BOM silently, so a text codec cannot write it back`
  - Helper: `[PAY-4b] a BOM kept by the text decoder poisons the first column name`
  - Fixture fact: the poisoning is real only for BOM-preserving decoders (`TextDecoder` with
    `ignoreBOM`, Node's `Buffer.toString`). `Body.text` uses the WHATWG UTF-8 decode, which strips
    the BOM in both lanes and both providers, so it cannot poison the name, and it loses the BOM.
- **PAY-4c** Fixed-width records with no delimiters, Latin-1 titles, implied decimals, zero padding,
  and a trailer whose record count and control total the decode verifies. Status: tested.
  - `[PAY-4c] the extract decodes from Latin-1 bytes with implied decimals and a verified trailer,
and re-encodes to the same bytes`
  - `[PAY-4c] read as UTF-8 text, the same bytes corrupt every accented title without an error`
  - `[PAY-4c] a trailer patched by hand fails the decode with the mismatch it found` (the record
    count)
  - `[PAY-4c] a trailer with the right count and a patched control total fails the decode with both totals`
  - `[PAY-4c] refusals are mapped statuses with ERROR lines, and a malformed period never leaves
the client`
  - Helper: five `[PAY-4c]` tests of strict ISO-8859-1, record splitting, field slicing, padded
    text and zero-padded counts. WHATWG's `latin1` label is windows-1252, so the codec maps bytes
    itself and refuses the C0 and C1 ranges.
- **PAY-5** CSV for a German spreadsheet with BOM, CRLF, semicolons, and a decimal comma,
  round-tripped with the BOM written back on encode. Status: tested.
  - `[PAY-5] the German sheet round-trips byte for byte, BOM included, and the import accepts it`
  - `[PAY-5] an edited sheet uploads and reads back with the new amount and title`
  - `[PAY-5] the importer refuses sheets German Excel would not write, as ERROR lines inside 200`
  - Helper: `[PAY-5] round-trips a German sheet byte for byte: BOM, CRLF, semicolons, quoting`,
    `[PAY-5] refuses what Excel would not write: a missing BOM, bare LF, needless quotes, stray
quotes`
- **PAY-8** Base64 of Latin-1 bytes inside XML-RPC, decoded by the same fixed-width schema that reads
  the HTTP endpoint. Status: tested.
  - `[PAY-8] base64 inside XML-RPC decodes through the same fixed-width schema as the download`
  - Helper: `[PAY-8] base64 decodes Perl's 76-column MIME layout and nothing looser`
- **VAL-1c** XML-RPC's separator-free date, bare `YYYYMMDD`, and a zero date meaning null. Status:
  tested.
  - `[VAL-1c] zero dates decode to none and others to UTC instants across XML-RPC, pipe and fixed
width`
  - `[VAL-1c] a migrated invoice dated 31 February is a decode error, not a shifted date`
  - Round trips: `[VAL-1c] XML-RPC's separator-free date-time round-trips as UTC`, `[VAL-1c] the
date-time refuses separators, zones, compact times and impossible dates`, `[VAL-1c] a bare
YYYYMMDD round-trips as midnight UTC and refuses a time of day on encode` (the stated loss of
    a bare date: encoding a time of day fails with that reason), `[VAL-1c] the zero date means none
in both forms, and only the exact zero spelling`
- **VAL-2b** Money as XML-RPC doubles in units, integer cents with implied decimals, and a decimal
  comma. Status: tested.
  - `[VAL-2b] one amount from five endpoints in four spellings decodes to the same cents`
  - Round trips: `[VAL-2b] XML-RPC doubles in units round-trip to integer cents without floating
point`, `[VAL-2b] units refuse unformatted and looser spellings`, `[VAL-2b] the decimal comma
round-trips and refuses a dot or thousands separators`, `[VAL-2b] implied decimals round-trip
zero padded and refuse signs, spaces and overflow`, `[VAL-2b] unpadded implied decimals in pipe
replies refuse padding and units`, `[VAL-2b] the same amount in every spelling is the same
branded value`
- **VAL-3b** XML-RPC booleans `1` and `0`. Status: tested.
  - `[VAL-3b] the paid flags travel as <boolean>1</boolean> and <boolean>0</boolean>`
  - Round trips: `[VAL-3b] XML-RPC booleans 1 and 0 round-trip`, `[VAL-3b] other spellings of truth
are refused`
- **RET-4** A Digest nonce spent by one request, so every call costs two round trips. Status:
  tested.
  - `[RET-4] every Digest call costs two round trips: three calls, six requests`
  - `[RET-4] sending the previous nonce pre-emptively saves nothing, because it is spent`
  - `[RET-4] a timed-out authenticated request has still spent its nonce` (a whole-operation
    timeout surfaces as `TimeoutError`, and the server observes the abort)
  - `[RET-4] a retry policy replays the encoded request, so its retry meets stale=true`

## Notification service (`notifications`)

- **AUTH-5** Double-submit CSRF: the token arrives as a cookie and in the body and must be echoed in
  a header; Node sends no cookies, so the cookie-reading endpoint needs `Cookie` set by hand.
  Status: tested, in both lanes unless marked Node.
  - `[AUTH-5] fetches the token first and echoes it, with the cookie carried by the transport's own cookie handling`
  - `[AUTH-5] a SameSite=Lax cookie never returns to a cross-site page, while Node's explicit jar ignores SameSite`
  - `[AUTH-5] a Cookie header set by hand reaches the service from Node and is dropped by the browser`
  - `[AUTH-5] echoing the cookie's percent-encoded spelling instead of the body token is refused as incorrect`
  - Node: `[AUTH-5] the lines provider sends a hand-set Cookie line verbatim and keeps no cookies; a pair the service never issued is refused`
  - Values: `[AUTH-5] the CSRF header schema …`, `[AUTH-5] the CSRF failure page …` (one-way, reverse
    refused with its reason).
  - Providers and cookies, as observed: Node's Fetch and the lines provider keep no cookies and show
    `Set-Cookie`; a hand-set `Cookie` goes out verbatim. `HttpClient.withCookiesRef` sends the
    cookie's original (percent-encoded) spelling and replaces any hand-set `Cookie` line, and it
    ignores `SameSite`. Chromium hides `Set-Cookie`, drops a hand-set `Cookie`, and stores and sends
    the cookie only with `credentials: "include"` and `SameSite=None; Secure`, because the test page
    (`localhost`) and the backends (loopback addresses) are different sites. Cookies are scoped by
    host, not port; each browser-lane backend has its own loopback address, so no two backends share
    a cookie jar.
- **AUTH-6** HMAC signing over method, path, timestamp, and the encoded body, with a validity
  window: signing runs after body encoding and once per attempt, regardless of its position in the
  declaration pipeline. A tampered body, a stale timestamp, and a missing CSRF token are distinct
  typed responses. Status: tested, in both lanes.
  - `[AUTH-6] signs each attempt in client middleware after body encoding, over method, path, timestamp and the exact body bytes`
  - `[AUTH-6] the signature does not depend on where the body sits in the declaration pipeline`
  - `[AUTH-6] once-per-evaluation signing depends on its position: before the body it signs an empty body`
  - `[AUTH-6] a retry after a 503 with Retry-After re-signs the attempt beyond the validity window`
  - `[AUTH-6] once-per-evaluation signing replays its signature on an immediate retry, refused as replayed`
  - `[AUTH-6] once-per-evaluation signing goes stale when the retry waits out the window`
  - `[AUTH-6] a tampered body, a stale timestamp and a missing CSRF token are three distinct typed responses`
  - `[AUTH-6] a refused Token credential is its own typed response, selected by its challenge ahead of the plain 401 rule`
  - `[AUTH-6] an empty subject is refused before dispatch; a blank one reaches the service and is refused there`
  - `[AUTH-6] a held announcement under a caller's timeout fails as a TimeoutError; the service sees the abort and records nothing`
  - `[AUTH-6] the failure points: an unretried 503 and a 500 page are unexpected responses, a frozen channel is a typed refusal`
  - Values: `[AUTH-6] the Token credential round-trips its Rails form and refuses other spellings`.
  - The once-per-evaluation control uses `Request.mapEffect`, which the design names for signing
    once per evaluation. A computed header (`Request.setHeader(name, () => …)`) has the same timing
    but cannot see the encoded body, and the raw setters are unavailable once a header schema owns
    the group, as the CSRF headers do here.
- **HDR-4** `Deprecation`, `Sunset`, and `Warning` all announcing retirement on one response: read
  all three through a header schema. Status: tested.
  - `[HDR-4] reads Deprecation, Sunset and both Warning values from one response through a header schema`
  - ``[HDR-4] the draft-era `Deprecation: true` fails the strict header schema as a DecodeError``
  - `[HDR-4] under the service's own CORS, a page can read only Warning, so the header schema fails there`
    (in Chromium the schema fails as a `DecodeError`; Node reads every header).
  - Node: `[HDR-4] the lines provider reports both Warning lines, which the normalized header map joins`
  - Values: round trips and refusals for `HttpDate`, `StructuredDate`, `WarningList` and
    `Retirement`. Fetch joins the two `Warning` lines with `, `; the schema splits outside quoted
    strings, since warn-texts and warn-dates contain commas.
- **HDR-7a** CORS preflight answers as a Node client observes them: an allowlist omitting
  `Content-Type` on one endpoint, one rejecting trace headers, and `OPTIONS` answered without the
  application headers. Status: tested.
  - Node: `[HDR-7a] the subscriptions preflight omits Content-Type: a browser would refuse the JSON POST that Node sends unchecked`
  - Node: `[HDR-7a] the announcement preflight refuses trace headers; disabling propagation for this service removes them`
  - Node: `[HDR-7a] v1 OPTIONS is answered by the container without the application's headers, unlike the v1 GET`
  - `[HDR-7a] the service's own CORS answers decide what a page may send; Node sends everything unchecked`
    (Chromium refuses each request after its preflight, as a transport error, and records which
    headers it asked for).
  - `[HDR-7a] with each hostile CORS behaviour switched off, a page reaches every endpoint`
  - Values: `[HDR-7a] token lists …`, `[HDR-7a] the preflight request and CORS answer schemas …`.
  - Trace propagation is disabled per service by providing `HttpClient.TracerPropagationEnabled`
    as `false` around this service's client in `transformClient`. With it on, even the CSRF
    bootstrap needs a preflight in a browser. Each hostile behaviour has a backend switch under
    `cors` for the browser lane (HDR-7b).

## Cross-service flows (`flows`)

Scenarios are in `src/scenarios/flows.test.ts` and run in both lanes (Node and Chromium); the first
AUTH-1 test runs once per provider in the lane. Round trips and compile-time checks are in
`src/clients/flows/translate.test.ts` and `src/clients/flows/portal.test.ts`. The consumer is
`src/clients/flows/`: one credential source and its three placements (`credentials.ts`), the search
box (`search.ts`), the saga (`saga.ts`), the translations (`translate.ts`), the portal facade's
contract (`portal.ts`) and the flows' own operations against the other services (`services.ts`).
The saga's JSON-to-SOAP proxy is a sixth backend, `src/backends/soap-proxy.ts` (the 2012 WCF
"portal facade"), whose quirks are documented at its top: a wrapped body with PascalCase members,
bytes as an array of numbers, the ASP.NET AJAX `d` wrapper, `jsonerror: true` 500s that relay store
faults, WCF's HTML "Request Error" page for unreadable bodies, and a `portal.` name prefix.

- **AUTH-1** One opaque token as a Bearer header to one service, under a custom `Token` scheme to
  another, and as a query parameter to a third: per-service late-bound credentials resolved at send
  time, an explicit opt-out for endpoints that must not carry one, and omission rather than the
  string `"undefined"` when absent. Status: tested.
  - `[AUTH-1] the identity grant's token travels as Bearer, as Token and as the session parameter (<provider>)`
    (identity's `client_credentials` grant issues the token; the business API gets `Bearer`, the
    notification service `Token token="…"`, the gateway `session=` percent-encoded after the
    request's own query, and the token endpoint gets no credential)
  - `[AUTH-1] credentials resolve at send time from the one source, and an absent token is omitted, never "undefined"`
    (operations built once read the source zero times at construction and once per evaluation;
    signed-out, signed-in and revoked rounds on all three ledgers, with each service's own refusal
    decoded; the template-literal control sends `Bearer undefined`)
  - `[AUTH-1] endpoints that must not carry the token opt out explicitly, and the source is not even read`
    (`Request.removeHeader("authorization")` after the shared business transform removes the
    computed credential without evaluating it; the area contract's own `abandonedRequests`, which
    does not opt out, is the control; the notification CSRF bootstrap is anonymous by contract)
  - Placements: the business contracts' computed header field (`Connection.credential`), the
    notification contracts' once-per-evaluation token effect, and a `Request.mapEffect` that
    appends `session` to the native request. Identity's directory owns its header group with a
    schema, so the saga's lookup reads the source when evaluated and fails as `SignedOut` without a
    token.
- **APP-1** Interaction gates: new input interrupts in-flight work, observed as an aborted request
  under injected latency; equal input joins or reuses the retained success; force re-executes;
  navigation disposes; empty input supersedes through the same gate; updating a credential does not
  unmount the interaction. Status: tested. Aborts are observed twice: on the request ledger and in
  the service's own `GET /v2/ops/abandoned` record.
  - `[APP-1] new input interrupts the search in flight, and the service records the abandoned request`
    (the superseded caller ends interrupted)
  - `[APP-1] equal input joins the active search: two callers, one request, one value`
  - `[APP-1] equal input reuses the one retained success without a request; other input replaces it`
  - `[APP-1] force re-executes, yields the new value, and supersedes an equal search in flight`
  - `[APP-1] navigation disposes: close aborts the search in flight and waits for its finalizers`
    (a 150 ms finalizer has run when `close` returns; later runs fail with `InteractionClosed`)
  - `[APP-1] navigation disposes: closing the acquiring scope aborts the search and waits for finalizers`
  - `[APP-1] empty input supersedes through the same gate without a request; the service would refuse it`
    (fixture fact: a blank `q` that reaches the service is `400 query_required`)
  - `[APP-1] updating the credential does not unmount the search box: later runs use the new token`
    (`retain` keeps only hit lists: a mapped 401 is a success in Effect's terms and would otherwise
    be replayed after the token changed)
  - `[APP-1] a credential provided around run does not reach the interaction: services were captured at acquisition`
    (the documented capture, and the reason the credential is a source read at send time)
- **APP-2** The month-end saga: read the gateway extract, translate, write tasks, store the
  re-encoded bytes over SOAP, push them through a JSON-to-SOAP proxy, announce with a signed request,
  and confirm through search. Compensation deletes the created tasks, tunnelled, after both failure
  and interruption. Status: tested. Compensation runs uninterruptibly and drains the list it deletes
  from, so it happens once whichever way the saga ends; stored documents are kept as the archive.
  - `[APP-2] the saga extracts, translates, writes, archives, publishes, announces and confirms across six services`
    (every ledger; the archived, published and forwarded bytes equal the gateway's download byte
    for byte; every search hit decodes back to the item it was written from)
  - `[APP-2] a store fault at the archive step compensates the created tasks exactly once`
    (soap-store `failStore`)
  - `[APP-2] a store fault relayed by the portal facade at the publish step compensates exactly once`
  - `[APP-2] an error page at the announce step is an unexpected response, and compensation runs exactly once`
    (notifications `announce.fail: "error"`)
  - `[APP-2] interrupting the saga mid-archive aborts the store call and compensates exactly once`
    (soap-store `hold`; the store sees the abort, and the proxy and notification ledgers stay empty)
  - `[APP-2] the portal facade's rejections: a duplicate as a jsonerror fault, base64 content as its HTML page, an absent store`
  - Each compensated failure asserts three task creations, exactly one tunnelled
    `POST /v2/tasks/<id>` with `X-HTTP-Method-Override: DELETE` per task, newest first, no raw
    `DELETE`, and an empty task list afterwards.
  - Round trips: `[APP-2] bytes travel as an array of numbers from 0 to 255, and nothing looser`,
    `[APP-2] the wrapped body uses the data contract's member names`,
    `[APP-2] the d wrapper and its type hint are checked, not ignored`,
    `[APP-2] a jsonerror body is a relayed store fault or another service fault`,
    `[APP-2] the Request Error page is read one way, for its exception message`,
    `[APP-2] the download's file facts round-trip through its header schema`.
- **APP-3** Translation between services: id spaces as a visible reference, a lossy money-to-priority
  mapping made reversible through a text field, an active flag recovered from status, an honest
  one-way transform whose reverse fails with a reason, inactive directory entries refused as
  assignees, and a file-to-upload mapping that drops size and keeps the timestamp in the name.
  Round trips prove non-lossiness, and encoding into the target's schema makes drift a compile
  error. Status: tested. The gateway account becomes a `[00012345]` title prefix and the directory
  uid an `idp:<uid>` assignee reference; the notes carry `Month-end <period>: <$amount> <status>`
  in the business's own dollar format; the announcement renders the saga's summary one way; the
  upload name is `ME<period>-<YYYYMMDD>T<HHMMSS>Z.DAT`.
  - `[APP-3] inactive and missing directory entries are refused as assignees through identity, before any task is written`
  - `[APP-3] a task written from an extract item reads back through the service to the same item`
  - Round trips: `[APP-3] an assignment round-trips through the business write model and its JSON wire form`,
    `[APP-3] ids from other services stay visible references and never become business ids`,
    `[APP-3] the money-to-priority mapping is lossy, and the figure in the notes makes it reversible`,
    `[APP-3] the active flag is recovered from status, and the notes keep paid apart from cancelled`,
    `[APP-3] a due date is a calendar date: a time of day or a fixed offset is refused rather than shifted`,
    `[APP-3] the announcement is one-way: a summary renders, and reading one back fails with the reason`,
    `[APP-3] the upload keeps the file's time in its name and visibly drops the size`.
  - Compile-time: `[APP-3] encoding into the target's own schema makes drift a compile error`
    (`@ts-expect-error` for a renamed, a retyped and an added business field, a store input that
    requires a size, an announcement with a new required field, and an inactive-capable directory
    entry passed as an assignee; branded accounts, task ids and cents refuse each other).
- **APP-6** Narrowing: a mapped 401 is a member of the same union as success, so reading a body
  without narrowing is a type error. Status: tested.
  - `[APP-6] a mapped 401 is a member of each service's success union, so no body is readable before narrowing`
    (cross-service: the business `Unauthorized` and notification `TokenRejected` 401s and the
    gateway's 403 `Refused`, each decoded from a real refusal, with `expectTypeOf` on each union and
    `@ts-expect-error` on each unnarrowed body and on a value read across the three)
  - `[APP-6] the saga's failure keeps each step's own union: its reason is unknown until narrowed`
  - Related type tests in other areas:
    `[ERR-1a] a body-level refusal shares the success union, so reading a document needs narrowing`
    (soap-store), `[ERR-1b] an XML-RPC fault inside 200 is a member of the result union` and
    `[AUTH-7] the 401 challenge is a declared response, and the same cold request runs again with one added header`
    (gateway),
    `[ERR-4] an inactive user keeps its values, and none reads as present until active is checked`
    (identity),
    `[AUTH-6] a tampered body, a stale timestamp and a missing CSRF token are three distinct typed responses`
    (notifications), and `[ERR-7] rules see transport metadata only; the type offers no body`
    (business envelopes).

## Transport and browser lane (`browser`)

Scenarios that run in both lanes are in `src/scenarios/browser.test.ts`; those about a page's CORS
and the same-origin proxy run only in Chromium, in `src/scenarios/browser.browser.test.ts`. The
proxy is `src/harness/proxy.ts`, pinned over raw sockets in `src/harness/proxy.node.test.ts`; the
page's helpers are in `src/clients/browser/`. In the browser lane the page is
`http://localhost:<port>` and each backend has its own `http://127.0.0.<n>:<port>`, so every direct
call is cross-origin and cross-site.

- **HDR-7b** CORS in a real browser: a page on one origin calling the services, with tracing
  propagation disabled per service and a same-origin proxy for the endpoints whose allowlist cannot
  be satisfied. Status: tested, in Chromium.
  - `[HDR-7b] the subscriptions allowlist omits Content-Type: Chromium refuses the JSON POST after its preflight, and the same-origin proxy delivers it`
  - `[HDR-7b] the announcements allowlist refuses trace headers: with propagation off for that service alone, the page announces while another service keeps its trace headers`
  - `[HDR-7b] the v1 OPTIONS is answered by the servlet container: Chromium never sends the GET, the exposed-header list hides the retirement headers, and through the proxy the page reads them all`
  - `[HDR-7b] a service with no CORS at all: a simple form POST still reaches it and counts, though Chromium withholds the answer; the page reads it only through the proxy`
  - `[HDR-7b] a withheld answer is a transport error, which Policy.transient retries: every attempt of the simple POST reaches the service`
  - `[HDR-7b] one page reaches every endpoint with every hostile allowlist on: the announcement across origins without trace propagation, the rest through the proxy`
  - `[HDR-7b] the proxy removes its prefix from the target: an announcement signed over the page's path is refused, and routing after signing keeps the signature valid`
  - Proxy, in Node over raw sockets:
    - `[HDR-7b] forwards the target after its prefix byte for byte, replaces Host in place, drops only hop-by-hop lines, and adds Content-Length for a body that arrived chunked`
    - `[HDR-7b] passes other paths and non-loopback targets on, and refuses a foreign Host or Origin before forwarding`
    - `[HDR-7b] answers 502 for an unreachable backend, and closes the forwarded request when the page aborts`
  - Each hostile behaviour is isolated with the notification service's `cors` switches, so every
    failure is attributed to one allowlist. Chromium reports every refusal (a refused or
    header-less preflight, a missing `Access-Control-Allow-Origin`) as a rejected fetch, which the
    library surfaces as `HttpClientError` with a `TransportError` reason. A refused preflight
    leaves the request unsent, while a CORS simple request is sent and takes effect with only its
    answer withheld. The library cannot tell these apart, so `Policy.transient` retries a withheld
    simple POST, and each attempt reaches the service. Effect's `b3` and `traceparent` headers are
    what make a GET or a form POST need a preflight at all.
  - Escapes: trace propagation off per service (`HttpClient.TracerPropagationEnabled` provided as
    `false` in that service's client middleware) satisfies the announcements allowlist, while
    another service on the same page and layer keeps its trace headers. The same-origin proxy
    covers what no request can satisfy: the subscriptions allowlist, the container-answered v1
    `OPTIONS`, the v1 `Access-Control-Expose-Headers` list, and a service without CORS.
  - What the proxy changes on the wire, as observed: the `/__proxy/<host>:<port>` target prefix is
    removed and the rest forwarded byte for byte; `Host` becomes the backend's, in place;
    hop-by-hop lines are dropped and Node's client appends `Connection: close` (and
    `Content-Length` for a chunked body); nothing is added. Responses pass through except
    hop-by-hop lines; `Set-Cookie` and `Location` are not rewritten, and no CORS header is added,
    because the proxy runs ahead of Vite's CORS middleware. The browser then treats the call as
    same-origin: no preflight, no `Origin` on a GET, `Sec-Fetch-Site: same-origin`, and cookies from
    the page's own jar.
  - The proxy changes the request target, so a signature over the URL path breaks when the base URL
    points at the proxy (`signature_mismatch`). Routing through the proxy in the outermost client
    middleware, after per-attempt signing, keeps the service's own path signed.
- **TRN-1** Explicit cookie and credential behavior, with the transport and credentials settings
  recorded before asserting, in Node and in the browser separately. Status: tested, in both lanes
  (Node: the `lines` and `fetch` providers; Chromium: `fetch`).
  - `[TRN-1] default credentials through ${provider}: the XSRF cookie does not come back, so the POST is refused as cookie-missing`
  - `[TRN-1] credentials: "include" through FetchHttpClient.RequestInit: Chromium stores and returns the SameSite=None cookie but never the Lax ones; Node's fetch keeps none`
  - `[TRN-1] HttpClient.withCookiesRef, one jar for every service: Node's jar keeps every cookie and sends each service's cookies to the other; in Chromium it never sees one`
  - `[TRN-1] a Cookie header set by hand through ${provider}: Node sends it verbatim; Chromium drops it without an error and, under credentials: "include", sends its own stored cookie`
  - Chromium: `[TRN-1] through the proxy, Fetch's default credentials carry a SameSite=Lax cookie, which is first-party to the page`
  - Each test records the provider, Fetch's credentials mode (read from
    `FetchHttpClient.RequestInit` in the Effect context), the cookie jar and any hand-set `Cookie`
    as a `transport` test annotation before its cookie assertions.
  - Node, as observed: neither provider keeps cookies, and both show `Set-Cookie`, so response
    metadata carries the parsed cookies. `credentials: "include"` is accepted and changes nothing.
    A hand-set `Cookie` is sent verbatim. `HttpClient.withCookiesRef` keeps every cookie whatever
    its `SameSite` or `HttpOnly`, and sends the whole jar to every origin: one jar shared by two
    services sends the identity provider's session cookies to the notification service, and the
    XSRF cookie back to the identity provider.
  - Chromium, as observed: `Set-Cookie` is hidden from scripts even when
    `Access-Control-Expose-Headers` lists it, so response metadata has no cookies and a
    `withCookiesRef` jar stays empty. Under Fetch's default credentials (`same-origin`) a
    cross-origin call neither sends cookies nor stores those its response sets. With `include`, a
    `SameSite=None; Secure` cookie is stored and returned; `SameSite=Lax` cookies, explicit or by
    default, never travel on the cross-site call. A hand-set `Cookie` is dropped without an error,
    and with `include` the stored cookie goes instead. Through the same-origin proxy the cookie is
    the page's own: default credentials carry even a `Lax` cookie, and a cookie without `HttpOnly`
    is readable through `document.cookie`.
