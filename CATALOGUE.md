# Scenario catalogue

Every entry of the scenario catalogue in
[issue #4](https://github.com/viell-dev/slop-effect-schema-http/issues/4) has an ID here, and
scenarios added later from reviews have `EXT-` IDs in their own section at the end. Tests put
the ID at the start of their title, such as `[AUTH-3] refuses an unknown token scheme`, so
`rg "\[AUTH-3\]" src` finds the evidence. One entry can have several tests.

Each entry's status is one of:

- **pending**: not covered yet;
- **tested**: covered by the tests named in the entry;
- **limit**: the behavior belongs to the transport or platform, with the observed constraint
  described;
- **defect**: a reproduced library mismatch, with a link to its issue.

An entry whose tests run only in a dedicated lane names it, such as `Lane: app` for the built
single-page app; only that lane's run checks it, and the other lanes' runs leave it out.

Backends are owned by area. Each area keeps the status of its entries up to date in its own
section. Each service's behaviour is documented on its page under [services/](./services/), which
is where consumer code and its tests take it from.

## Identity provider (`identity`)

Scenarios are in `src/scenarios/identity.test.ts` and run in both lanes (Node and Chromium) unless
marked node-only, in which case they are in `identity.node.test.ts`. Round trips are in
`src/values/identity.test.ts` and `src/clients/identity/schemas.test.ts`. The service is documented
in [services/identity.md](./services/identity.md).

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
XML helper tests in `src/formats/xml.test.ts`. The service is documented in
[services/soap-store.md](./services/soap-store.md).

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
  - Recorded (EXT-6e): the JAX-WS reference implementation in JDK 8 answers SOAP 1.1 and 1.2 faults
    with HTTP 500, sender faults included, as the store does. It writes no detail element for a
    fault without detail entries, where the store wrote an empty one; the store now omits it.
  - Decoded by the consumer (EXT-8d): the reference implementation's SOAP 1.1 and 1.2 faults
    decode through the one extra rule, in both lanes. No fix was needed.
- **STAT-7** PROPFIND answered with 207, plus 412, 428, 415, and 405 with `Allow`: methods as
  strings, statuses as numbers. Status: tested.
  - `[STAT-7] PROPFIND travels as a method string with Depth: 1 and its 207 multistatus decodes`
    (provider)
  - `[STAT-7] 428, 412 and 415 are ordinary declared statuses of a WebDAV write`
  - `[STAT-7] MKCOL on an existing collection answers 405 with an Allow list read through a header
schema`
  - Round trip: `[STAT-7] AllowList round-trips method tokens case-sensitively and refuses
non-tokens`. Separators and empty list elements are not kept; encoding joins with `", "`.
  - Recorded referee (#47): stock httpd 2.4.69 mod_dav's quoted XML charset, explicit-property 404
    groups, OPTIONS lists, MKCOL 405 and missing-Depth 403 (`recordings/httpd-dav`). Conformance
    retains DocVault's smaller method set/DAV class and its XML depth error instead of Apache HTML.
    Apache's recorded MKCOL advertises only TRACE, unlike its OPTIONS list; both are pinned as
    observed rather than treated as DocVault's policy. Consumer checks decode the real lists and
    error outcomes in both lanes/providers.
- **STAT-12** A GET carrying a SOAP body for downloads: the library passes it on like any other
  request, so a client that can send the body reaches the servlet, and what `fetch` does with it is
  the platform's limit. Issue #4 asked for a typed error before dispatch;
  [#96](https://github.com/viell-dev/slop-effect-schema-http/issues/96) replaced that. Status:
  tested.
  - Node-only: `[STAT-12] the documented GET download with a SOAP body reaches the servlet`
    (`lines` and the raw client; the ledger holds the GET with the envelope, and the bytes decode)
  - `[STAT-12] fetch refuses the documented GET download as a transport error after the client received it`
    (both lanes, with an empty ledger; EXT-11w records the limit for any GET)
  - `[STAT-12] POST does not reach the download servlet either: 405 with Allow: GET`
- **HDR-5e** Latin-1 bytes under a charset-less `text/xml`. Status: tested.
  - `[HDR-5e] SOAP 1.1 replies are Latin-1 bytes under a charset-less text/xml; UTF-8 text
decoding corrupts them silently`. Verified in both lanes: `Body.text` decodes the reply as
    UTF-8 without failing and turns every Latin-1 letter into U+FFFD, while the character
    references above U+00FF survive; a strict UTF-8 decoder fails as `DecodeError`.
- **HDR-5f** SOAP 1.2 carrying the action inside the content type: a protocol version change is a
  codec change, not a header change. A declared `Content-Type` changes the label and never the
  bytes. Status: tested.
  - `[HDR-5f] SOAP 1.2 carries the action in the codec's content type and sends no SOAPAction`
    (provider)
  - `[HDR-5f] a Content-Type declaration relabels a SOAP 1.1 body as SOAP 1.2, and the store refuses the envelope`
    (provider; the declaration wins over the codec's `text/xml`, as
    [#100](https://github.com/viell-dev/slop-effect-schema-http/issues/100) decided, and goes out as
    the only content-type line, over a body that is still SOAP 1.1, so the store answers 400)
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
  - Recorded WebDAV referee (#47): allprop and explicit-property multistatus include the root,
    two subcollections and two files. Backend tests retain every property/status group and pin
    extra/missing properties, namespaces, href escaping/order and opaque tag differences. The
    consumer reads both through the existing listing decoder, preserving accented names and byte
    lengths while skipping collections and 404 properties. Removing the backend collection marker
    fails both comparisons; disabling the consumer's 404 handling fails explicit-property reads
    while allprop controls pass. Both implementations are restored after mutation probes.
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
  - `[QRY-1] client middleware that appends a URL parameter re-serialises the query and ?wsdl
becomes ?wsdl=; editing the URL text keeps it` (provider). Effect builds the dispatch URL with
    `URLSearchParams` once a request carries a parameter, so the library's rendering survives only
    middleware that edits the URL text. That is settled: it is Effect's behaviour, the library's
    [design page](https://github.com/viell-dev/slop-effect-schema-http/blob/main/docs/design.md#wire-representations-stay-distinct)
    documents it, and this test pins it as a fact of the client rather than a mismatch.
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
  - Recorded referee (#47): mod_dav GET bytes/validators, wildcard and matching-tag 304 with no
    content, and weak/stale If-Match 412. Backend conformance adapts only current tag identities,
    counts setup/verification GETs, and proves rejected writes leave the resource unchanged.
    Consumer operations decode the real GET/304/412 replies in both lanes/providers. DocVault's
    mandatory-validator policy is its own rule; this does not make it a stock httpd policy.

## JSON business API: envelopes (`business/envelopes`)

Scenarios are in `src/scenarios/business-envelopes.test.ts` and run in both lanes (Node and
Chromium); a title ending in `(lines)` or `(fetch)` runs once per provider the lane offers. The
raw-socket check is in `business-envelopes.node.test.ts`. Round trips for the dialect schemas are in
`src/clients/business/envelopes-dialects.test.ts`. The service is documented in
[services/business.md](./services/business.md), whose `/v1/` half is this part.

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
  - Recorded (EXT-6d), a correction: the container does not decide the form. Tomcat 7.0.109 never
    rewrites a `Location` header a handler sets, and absolutizes only `sendRedirect`'s location,
    always a 302, and only with `useRelativeRedirects="false"`, the behaviour before 7.0.67. The
    service page now gives the legacy node's absolute `Location` to its 2012 build, which builds it
    from `Host` in the form Tomcat's `sendRedirect` uses, and the conformance test checks that form.
  - Decoded by the consumer (EXT-8c): Tomcat's 200 reaches `Created` in every provider of both
    lanes. It carries no `X-Served-By`, which the creation contract required; the header is now
    optional and `servedBy` an `Option`, which this entry's test checks for both containers.
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
  Eight [stock Express recordings](recordings/express-jsonp/set.json) provide an outside referee
  for JSONP framing and plain JSON. Backend conformance checks every body byte/value and pins
  metadata, callback-policy and CDN differences. Consumer replay runs the existing rates operation
  and dialect reader in both lanes, rejecting another callback's frame, plain JSON where JSONP is
  required, and callbacks outside the application's identifier contract. This covers current
  Express HTTP replies; it neither executes scripts nor establishes historical deployment behavior.
  - `[PAY-1] strips the anti-hijacking prefix before parsing JSON`
  - `[PAY-1] unwraps JSONP for the requested callback and refuses any other name`
  - `[PAY-1] refuses a JSONP callback that is not an identifier before dispatch`
  - `[PAY-1] decode stock Express` (all eight recordings, both providers)
  - `[PAY-1] the existing rates operation reads Express` (three identifiers)
  - `[PAY-1] the rates contract rejects non-identifiers before Express replay`
  - `[PAY-1] a showRates decoder refuses Express` (foreign callback and plain JSON)
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
`src/values/business.test.ts`. The service's conventions, endpoints and test options are documented
in [services/business.md](./services/business.md), whose `/v2/` half is this part.

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
  operation. Status: tested. Six [stock nginx recordings](recordings/nginx-paths/set.json) provide
  an outside referee for the gateway's adjacent-slash routing: default-on compression selects
  global history for an empty id, while a valid id selects one task. Diagnostic headers retain the
  original/normalized URI and unchanged query slash runs. Backend conformance checks every event
  and pins metadata differences; consumer replay checks real replies and pre-dispatch validation
  in both lanes. Authentication and historical nginx behavior are outside the recording's scope.
  - `[QRY-3] an empty id leaves an empty segment, and merged slashes answer another resource`
  - `[QRY-3] the application contract refuses an empty id before dispatch`
  - `[QRY-3] one operation replaces the shared base URL and keeps the credential`
  - `[QRY-3] nginx routes` (each recorded path, both providers)
  - `[QRY-3] an unconstrained empty id reads nginx's global history`
  - `[QRY-3] the task contract rejects an empty id before nginx replay`
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
`src/formats`. The service's endpoints, its month-end extract and the token option the flows use
are documented in [services/gateway.md](./services/gateway.md).

- **AUTH-2** A session obtained by GET with the password in the query string, then carried as a
  query parameter: declared as is. Status: tested.
  - `[AUTH-2] logs in by GET with the password in the query string, then carries the session as a
query parameter` (the password `p+ss w&rd;1` arrives percent-encoded, so CGI.pm's `+` and `;`
    handling cannot alter it)
  - `[AUTH-2] a wrong password and an unknown session are ERROR lines inside 200`
  - `[AUTH-2] a blank user or a malformed account is refused before dispatch`
  - `[AUTH-2] the configured SSO token is accepted wherever a session is`
  - Backend conformance holds every other gateway script to the same query rule: the query ends at
    the target's first `#`, a `?` after it starts none, and a fragment changes no reply
    (`src/conformance/fragment-query.node.test.ts`).
  - Backend conformance (EXT-31b): query values are bytes, as CGI.pm decodes them, and match stored
    text by its UTF-8 bytes.
  - Recorded referee (#47): CGI.pm 4.55 on the XML-RPC sets' pinned Debian/Perl base, with a small
    HTTP::Daemon balance handler. Eleven raw targets pin plus/semicolon decoding and separators,
    repeated first-value selection, empty/name-only session outcomes, equals and escape case.
    Backend conformance compares exact status/body and pins every metadata difference, masking
    only Date. `recordings/cgi-pm-query` and the service page state the substitutions and limits.
  - Consumer checks replay all eleven real replies in both lanes/providers and separately run the
    ordinary balance contract with CGI-sensitive token characters. Recorded raw queries use the
    public native-request hook without structured query declarations, and the ledger verifies
    their spelling. Name-only and empty sessions both mean a session error; no parser-internal
    distinction is inferred from those replies.
  - Mutation controls: disabling semicolon splitting fails three backend body comparisons;
    replacing the consumer's token plus with a space fails the ordinary-contract replay because
    its request target no longer matches. Both implementations are restored after the probes.
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
  - Round trips (`src/clients/gateway/digest.test.ts`): `[AUTH-7] ChallengeFromHeader round-trips quotes and backslashes in realm, nonce and opaque`,
    `[AUTH-7] ChallengeFromHeader reads other parameter orders and spellings, and writes one form`
    (parameter order, letter case, quoting style and an absent `algorithm` are not kept),
    `[AUTH-7] ChallengeFromHeader refuses malformed and unanswerable challenges`, and
    `[AUTH-7] ChallengeFromHeader reads RFC 7230 tokens unquoted and refuses any other unquoted value or separator`
    (every token character reads unquoted; any other character in an unquoted value of any
    parameter, and a separator other than a space or tab, is refused).
  - MD5 is a pure TypeScript implementation (`src/formats/md5.ts`, RFC 1321 vectors), because
    Web Crypto has none. Chromium returns the 401 to the page without an authentication prompt.
  - Recorded (EXT-6b), with httpd 2.4.68's `mod_auth_digest` and `AuthDigestQop none` standing in
    for Apache 1.3's `mod_digest`; httpd 2.4.69 refuses the directive. httpd challenges with
    `realm`, `nonce` and `algorithm=MD5` and no `opaque`, and curl computes the response the
    service page gives. The gateway's challenge carried an `opaque` and required it back; it now
    has httpd's form and nonce shape. httpd accepts a replayed `Authorization` within the nonce's
    lifetime and answers an expired nonce with `stale=true`; the gateway's single-use nonces are
    the service's own. Apache 1.3's 401 page is not recorded (no maintained image exists).
  - Decoded by the consumer (EXT-8b): its parser reads httpd's challenges, and it computes the
    `Authorization` curl sent, byte for byte, from the recorded nonce. No fix was needed.
- **ERR-1b** XML-RPC faults inside 200. Status: tested.
  - `[ERR-1b] an XML-RPC fault inside 200 is a member of the result union` (type-level as well)
  - `[ERR-1b] a fault can be moved into the failure channel by the consumer`
  - Schema: `[ERR-1b] an outcome is a result or a fault, both members of one union`
  - Recorded (EXT-6a): Frontier::Daemon's own dispatcher answers faults `1`, `3` and `4` with
    Perl's messages, and XMLRPC::Lite answers protocol errors with the string `Client` as
    `faultCode`. The gateway's codes are its own dispatcher's, written in Frontier::RPC2's layout.
  - Decoded by the consumer (EXT-8a): Frontier::RPC2's faults and XMLRPC::Lite's `<int>` 404 are
    Fault outcomes; XMLRPC::Lite's string `Client` is the fault rule's decode error, since the
    specification makes `faultCode` an `<int>`.
- **ERR-1c** Pipe-delimited `ERROR` lines inside 200. Status: tested.
  - `[ERR-1c] an ERROR line inside 200 decodes as a gateway error beside the OK line`
  - `[ERR-1c] a reply that is neither an OK nor an ERROR line is a decode error`
  - The consumer chooses strict UTF-8 for both ordinary pipe replies and help replies (EXT-31b).
    Malformed echoed bytes fail as `Response.DecodeError`; they never become altered message text.
  - Backend conformance (EXT-31c): a message quotes the request unescaped, so it can hold `|` and
    is everything after the line's second `|`. Apache's own 404 and 405 are HTML pages (EXT-31a).
  - Round trips (`src/clients/gateway/pipe.test.ts`): the consumer's `ErrorLine` reads such a
    message whole in every pipe reply (EXT-9p over HTTP), and OK lines keep their exact fields:
    `[ERR-1c] an ERROR line's message is everything after its second |, in a pipe reply and from bytes`
    and `[ERR-1c] an OK line keeps exactly its fields, so a | in one is still refused`.
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
  - Recorded (EXT-6c): httpd 2.4.69's `Redirect permanent` builds the absolute `Location` from the
    request's `Host`, port included, and keeps the query for any method. The gateway built it from
    its own address; it now builds it from `Host`, and its page escapes the target as httpd's does.
    Apache 1.3's page is not recorded (no maintained image exists), so the gateway keeps it.
  - Decoded by the consumer (EXT-8c): in the Node lane, httpd's 301 reaches the declared `Moved`
    case with httpd's `Location` as written; Chromium's manual mode gives the opaque redirect.
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
  - `[PAY-3b] a header declaration relabels a text body as XML, so the gateway answers the call`
    (both lanes send `text/xml`: a request's declaration wins over the body codec's `text/plain`,
    as [#100](https://github.com/viell-dev/slop-effect-schema-http/issues/100) decided)
  - XML's character rules hold in the gateway's own reader and writer, checked over raw calls and
    reply bytes:
    `[PAY-3b] a call holding a NUL or another character XML forbids, raw or as a reference, gets the parse-error fault in well-formed XML`
    (also an upper-case `&#X`, a bare `&` and bytes that are not UTF-8; a well-formed call on the
    same path is the control),
    `[PAY-3b] the gateway reads a call's line ends as LF, and writes a referenced carriage return back as a reference`,
    and
    `[PAY-3b] a fixture value XML cannot carry is answered with the internal-error fault, never written`
    (-32603, decoded by the consumer's strict reader).
  - Helper: `[PAY-3b] parses every type into a lossless tree, ignoring whitespace between
elements`, `[PAY-3b] round-trips calls and faults`, `[PAY-3b] refuses malformed responses instead
of guessing`, `[PAY-3b] scalar schemas read the type element and refuse other types or
spellings`,
    `[PAY-3b] <int> reads as <i4>, its synonym, and encodes as <i4>: the spelling is not kept`,
    `[PAY-3b] a string value reads untyped or typed, and encodes untyped: the spelling is not kept`
  - Decoded by the consumer (EXT-8a): `<int>` and the modules' typed `account.title` broke its
    reader; it now reads both, as the specification allows.
  - Recorded (EXT-6a), with Frontier::RPC2 0.07b4 and XMLRPC::Lite 0.717 serving the same methods
    over the same data. The gateway wrote raw UTF-8, other line ends than the module's, and
    `Server: Frontier/5.1.2-WinNT`, which no Perl module writes; it now writes Frontier::RPC2's
    bytes, apart from struct member order, which Perl's hash order changes with every process:
    character references for text outside ASCII, `&quot;`, and a line end after each typed value.
    Neither module can write the untyped `account.title`, which the service page now gives to a
    hand-written reply, and neither refuses a call that is not `text/xml`: Frontier::RPC2 decodes
    it and XMLRPC::Lite answers a `Client` fault in 200, so the 400 is the gateway's Apache
    configuration. XMLRPC::Lite writes `<int>`, base64 on one line, raw UTF-8 and `<data />`, and
    turns untyped text holding a letter outside ASCII into base64.
- **PAY-4b** A UTF-8 BOM that would poison the first CSV column name. Status: tested.
  - `[PAY-4b] a BOM-preserving decode poisons the first column name; the byte codec does not`
  - `[PAY-4b] Fetch's text decoding drops the BOM silently, so a text codec cannot write it back`
  - Helper: `[PAY-4b] a BOM kept by the text decoder poisons the first column name`
  - Fixture fact: the poisoning is real only for BOM-preserving decoders (`TextDecoder` with
    `ignoreBOM`, Node's `Buffer.toString`). `Body.text` uses the WHATWG UTF-8 decode, which strips
    the BOM in both lanes and both providers, so it cannot poison the name, and it loses the BOM.
  - Independent German-file referee (#47, PAY-5): the literal UTF-8 BOM is preserved by both
    writers, and the consumer rejects the hand-made sheet when those three bytes are removed.
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
  - Independent referee (#47): [a hand-authored binary file](./fixtures/gateway/README.md), made
    from the service page in a fresh context that read neither implementation. Backend conformance
    compares the HTTP download and XML-RPC payload byte for byte; the consumer decodes to the
    worksheet's values and re-encodes to the file. Both contexts copied the inputs separately.
    These disk-fixture checks run in Node; the existing scenarios above run in both lanes.
    Corrupt count, total, padding and record length fail independently. Deliberately mapping `X`
    to paid in the consumer or writing underscores as title padding in the backend also fails
    the golden comparison.
  - Not recorded from a mainframe or COBOL writer: the hand-made referee checks the documented
    unsigned, zero-padded layout; it does not establish conformance with real mainframe software.
- **PAY-5** CSV for a German spreadsheet with BOM, CRLF, semicolons, and a decimal comma,
  round-tripped with the BOM written back on encode. Status: tested.
  - `[PAY-5] the German sheet round-trips byte for byte, BOM included, and the import accepts it`
  - `[PAY-5] an edited sheet uploads and reads back with the new amount and title`
  - `[PAY-5] the importer refuses missing BOMs, decimal points and LF record separators, as ERROR lines inside 200`
  - Helper: `[PAY-5] round-trips a German sheet byte for byte: BOM, CRLF, semicolons, quoting`,
    `[PAY-5] refuses a missing BOM, wrong record separators, needless quotes and stray quotes`
  - Not recorded: Excel cannot run in a disposable container, and LibreOffice would stand in for
    different software (recordings/README.md).
  - Independent referee (#47): [a hand-authored German CSV file](./fixtures/gateway/german-accounts.md),
    constructed from the service page in a fresh context before either implementation was read.
    Separately authored backend checks compare the export and imported/re-exported bytes with
    this file; both Node consumer providers decode, encode, upload and read back its semantic rows.
    These disk-fixture checks run in Node; the existing scenarios above run in both lanes.
  - The literal file covers a BOM, CRLF record separators, semicolons, doubled quotes, an embedded
    CRLF, accented UTF-8, signed/zero/sub-unit amounts, leading zeroes and an absent date. Invalid
    BOM, UTF-8, separators, final CRLF and amount spellings are checked separately. Changing the
    backend's record endings to LF or multiplying the consumer's decoded cents by 100 fails the
    golden assertions.
  - Clarified in #60: CRLF separates records; CR, LF and CRLF inside quoted fields are preserved
    data. Initially proposed rejection inputs for quoted CR/LF were retained as positive controls
    on both sides after triage, including a consumer helper check in Node and Chromium. No parser
    behavior changed, and no real-Excel file was recorded.
- **PAY-8** Base64 of Latin-1 bytes inside XML-RPC, decoded by the same fixed-width schema that reads
  the HTTP endpoint. Status: tested.
  - `[PAY-8] base64 inside XML-RPC decodes through the same fixed-width schema as the download`
  - Helper:
    `[PAY-8] base64 decodes MIME::Base64's 76-column lines, one line, or any line feeds, refuses other characters, and encodes MIME::Base64's layout`
    (the layout of a decoded text is the stated loss)
  - Recorded (EXT-6a): MIME::Base64's `encode_base64` under Frontier::RPC2 writes the layout the
    gateway writes, 76 columns with a newline after every line, the last included. XMLRPC::Lite
    calls it with an empty line end and writes base64 on one line.
  - Decoded by the consumer (EXT-8a): its base64 schema accepted only MIME::Base64's layout, so
    XMLRPC::Lite's extract was a decode error. The specification gives base64 no line layout, so
    the schema now ignores line feeds wherever they fall and still refuses any other character.
  - Independent fixed-width referee (#47, PAY-4c): a Node conformance check compares the embedded
    bytes with the hand-made file, and both Node providers decode the RPC result to the worksheet
    and encode it back to that file. The real-Perl recording above remains the framing referee.
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
  - Recorded (EXT-6b): httpd 2.4 sends `Authentication-Info` with a `nextnonce` on success, which
    would save the second round trip, and its nonces last their lifetime. The gateway sends none,
    and its nonces are single-use, as the service page documents.

## Notification service (`notifications`)

The service is documented in [services/notifications.md](./services/notifications.md).

- **AUTH-5** Double-submit CSRF: the token arrives as a cookie and in the body and must be echoed in
  a header; Node sends no cookies, so the cookie-reading endpoint needs `Cookie` set by hand.
  Status: tested, in both lanes unless marked Node.
  - `[AUTH-5] fetches the token first and echoes it, with the cookie carried by the transport's own cookie handling`
  - `[AUTH-5] a SameSite=Lax cookie never returns to a cross-site page, while Node's explicit jar ignores SameSite`
  - `[AUTH-5] Node's explicit jar withholds Secure cookies over HTTP; Chromium accepts them on loopback with credentials included`
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
The saga's JSON-to-SOAP proxy is a sixth backend, `soap-proxy` (the 2012 WCF "portal facade"),
documented in [services/soap-proxy.md](./services/soap-proxy.md): a wrapped body with PascalCase
members, bytes as an array of numbers, the ASP.NET AJAX `d` wrapper, `jsonerror: true` 500s that
relay store faults, WCF's HTML "Request Error" page for unreadable bodies, and a `portal.` name
prefix.

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
  - Independent fixed-width referee (#47, PAY-4c): both Node providers run the saga's first-step
    download operation against the hand-made fixture's inputs, checking decoded values, exact
    bytes, file facts and the authenticated request. This isolates the first step; the full saga
    and its browser lane remain covered by the existing tests above.
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
  - Not recorded: WCF's `jsonerror` responses and the `d` wrapper, because hosting WCF needs .NET
    Framework and an HTTP.sys URL reservation on the host, not a container
    (services/soap-proxy.md).
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
  - `[TRN-1] HttpClient.withCookiesRef shares cookies between Node services on the same host; in Chromium the jar never sees one`
  - `[TRN-1] a Cookie header set by hand through ${provider}: Node sends it verbatim; Chromium drops it without an error and, under credentials: "include", sends its own stored cookie`
  - Chromium: `[TRN-1] through the proxy, Fetch's default credentials carry a SameSite=Lax cookie, which is first-party to the page`
  - Each test records the provider, Fetch's credentials mode (read from
    `FetchHttpClient.RequestInit` in the Effect context), the cookie jar and any hand-set `Cookie`
    as a `transport` test annotation before its cookie assertions.
  - Node, as observed: neither provider keeps cookies, and both show `Set-Cookie`, so response
    metadata carries the parsed cookies. `credentials: "include"` is accepted and changes nothing.
    A hand-set `Cookie` is sent verbatim. Effect 4.1's `HttpClient.withCookiesRef` scopes cookies
    by host, path, expiry and Secure, but ignores `SameSite` and `HttpOnly`. In this test, both Node
    services use the same host and Path=/, so one jar sends their cookies to both services across
    different ports. This does not establish cross-host behavior. Node's other positive CSRF tests
    use Lax cookies: the jar withholds Secure cookies over the fixtures' plain HTTP.
  - Chromium, as observed: `Set-Cookie` is hidden from scripts even when
    `Access-Control-Expose-Headers` lists it, so response metadata has no cookies and a
    `withCookiesRef` jar stays empty. Under Fetch's default credentials (`same-origin`) a
    cross-origin call neither sends cookies nor stores those its response sets. With `include`, a
    `SameSite=None; Secure` cookie is stored and returned; `SameSite=Lax` cookies, explicit or by
    default, never travel on the cross-site call. A hand-set `Cookie` is dropped without an error,
    and with `include` the stored cookie goes instead. Through the same-origin proxy the cookie is
    the page's own: default credentials carry even a `Lax` cookie, and a cookie without `HttpOnly`
    is readable through `document.cookie`.

## Beyond the issue #4 catalogue (`EXT-`)

Scenarios a hostile suite should show that the issue's catalogue does not name, added from the
[review of PR #23](https://github.com/viell-dev/slop-effect-schema-http/pull/23#issuecomment-6509333821)
(section 3.2; EXT-3 to EXT-5 from sections 4.3 and 4.4, tracked in
[#33](https://github.com/viell-dev/slop-effect-schema-http/issues/33); EXT-6a to EXT-6e and
EXT-8a to EXT-8d from sections 4.2 to 4.4, tracked in
[#32](https://github.com/viell-dev/slop-effect-schema-http/issues/32)). They are checked like the
other entries.

EXT-6a to EXT-6e hold backends to recordings of the real software they imitate
([recordings/README.md](./recordings/README.md)). Each test sends a recorded request to the backend
over a raw socket, masks only values that change with every run, and pins every other difference,
each explained in the backend's service page under "Recordings". The tests are backend-side, in
`src/conformance/`, and Node-only, because they read the recordings from disk and compare raw header
lines; each set also has a test that the replay backend serves it as recorded.

EXT-8a to EXT-8d hold the consumer to the same recordings. The replay backend
([services/replay.md](./services/replay.md)) serves the recorded responses over a real socket, and
the consumer's own operations send their requests and decode the real software's bytes, in both
lanes. A test adapts a request only where a consumer contract cannot produce the recorded target,
and names the adaptation. Where the real bytes broke consumer code, the entry records the fix and
its reason. The tests are in `src/scenarios/recordings.test.ts`, written by a consumer-side context
that did not open `src/backends/` or `src/conformance/`.

- **EXT-1** One tag for two statuses: a tunnelled write answers `200` with the task or `204` with no
  body, and the contract decodes both as `Changed`, the task as an `Option`. Tags belong to
  decoders; ordered status predicates, not unique tags, select the representation. In
  `src/scenarios/business-operations.test.ts`, both lanes. Status: tested.
  - `[EXT-1] a 200 with the task and a 204 without a body are both Changed; the status picks the
decoder` (with a type-level check that both cases have one type)
  - `[EXT-1] control: a first rule that also matches 204 takes it, and the empty case behind it
under the same tag is never consulted` (a decode error, after the service applied the delete)
- **EXT-2** A provider chosen for one operation: `transformClient` replaces the client the library
  hands over, rather than decorating it, so one operation runs on its own provider while the
  operations around it keep the layer's. In `src/scenarios/business-operations.test.ts`, both
  lanes. Status: tested.
  - `[EXT-2] one operation replaces the layer's client through transformClient, and the operations
around it keep the layer's` (provider; in the Node lane's `lines` run, the replacement is the
    Fetch provider)
- **EXT-3** The suite's XML readers against an independent parser, over a corpus of edge cases:
  characters XML forbids, raw and as references; malformed and valid references; CDATA; CRLF and
  lone CR; attribute quoting, white space and names; a DTD; comments, processing instructions and
  the XML declaration before the root; and content after it. Each of the 92 documents
  (`src/formats/corpus/xml.ts`, 40 well-formed) is a SOAP `StoreDocument` call with XML 1.0's
  verdict, read by the independent parser (saxes in Node, Chromium's `DOMParser` in the browser),
  by the consumer's reader and, over HTTP, by the SOAP store. Every reader is compared with the
  independent parser, not with another reader: on acceptance, and on the decoded tree (the
  consumer) or the title stored, read back from the bundle's JSON (the store). A recorded
  disagreement that stops holding fails too. In `src/scenarios/parsers.test.ts`, both lanes; the
  backend side's own regression cases, which the corpus does not hold, in
  `src/conformance/readers.node.test.ts`, Node lane. Status: tested.
  - `[EXT-3] ${parser} gives XML 1.0's verdict on every document of the XML corpus, except its recorded disagreements`
  - `[EXT-3] the consumer's XML reader agrees with ${parser} on every document: acceptance, and the decoded tree when accepted`
  - `[EXT-3] the store's XML reader agrees with ${parser} on every document, judged over HTTP: a "Malformed XML" 400, or the title it stored`
    (the ledger holds exactly the corpus bytes)
  - `[EXT-3] the store's XML reader gives XML 1.0's verdict on the backend-side cases the corpus does not hold, and refuses a DTD as SOAP requires`
    (18 documents, each with the production that decides it; the ledger holds exactly their bytes)
  - The independent parsers: both give XML 1.0's verdict on every document, except that saxes
    refuses an entity declared in the internal DTD subset (`doctype-internal-entity`). saxes reads
    no declarations from a DTD, a limitation its README documents, though XML 1.0 section 4.1 (WFC:
    Entity Declared) is met; the readers are compared with XML 1.0's verdict there. saxes was
    chosen for the Node lane because it aims to report every well-formedness error of XML 1.0
    fifth edition, is jsdom's XML parser, is pure JavaScript with one dependency and no install
    script, and is a different implementation from Chromium's libxml2. Its last release, 6.0.0, is
    from 2021, and its declarations do not type-check without `skipLibCheck` (TS2344, TS2430), so
    the suite imports it through `src/formats/saxes.js` with its own `saxes.d.ts`, and the packed
    lane's type-check stays strict.
  - The consumer's reader, fixed against the corpus: it accepted two attributes without white space
    between them (`attr-no-separator`), U+00A0, U+3000 and U+FEFF as white space
    (`attr-nbsp-separator`, `attr-ideographic-space`, `prolog-nbsp`, `prolog-zero-width-space`),
    names starting with a digit or `-`
    (`attr-name-digit`, `attr-name-hyphen`), a misplaced or malformed XML declaration
    (`prolog-declaration-*`), `xml` in any case or nothing as a processing instruction's target
    (`prolog-pi-reserved`, `prolog-pi-no-target`), and `--` inside comments, ending `<!--->` at its
    own opening hyphens (`comment-double-hyphen`, `comment-hyphen-end`, `comment-overlap`); and it
    refused non-ASCII names (`attr-name-non-ascii`) and attribute names such as `constructor` and
    `__proto__`, which it took for duplicates (`attr-object-names`).
  - Recorded, by design: the consumer and the store refuse every DTD (`doctype-bare`,
    `doctype-internal-entity`). SOAP 1.1 section 3 and SOAP 1.2 part 1 section 5 forbid a
    document type declaration in a message, and neither reader expands entities; the store's
    service page says so.
  - The store's reader, fixed against the corpus by the backend side: it took U+00A0, U+3000 and
    U+FEFF for white space (`attr-nbsp-separator`, `attr-ideographic-space`, `prolog-nbsp`,
    `prolog-zero-width-space`); refused non-ASCII names as "unexpected markup"
    (`attr-name-non-ascii`); checked neither the XML declaration's place nor its content
    (`prolog-declaration-late`, `-after-space`, `-no-version`, `-order`, `-standalone`); did not
    check a processing instruction's target (`prolog-pi-reserved`, `prolog-pi-no-target`); and
    accepted `--` inside a comment (`comment-double-hyphen`, `comment-hyphen-end`,
    `comment-double-hyphen-in-text`). Its service page says it reads XML 1.0 strictly. The
    backend-side cases hold the same rules elsewhere in a document (end tags, the epilog, a title's
    content, the declaration's spelling) and a defect the corpus does not reach: the store looked
    entities up on a plain object, so `&constructor;` and `&__proto__;` read as text from
    `Object.prototype` instead of being refused as undeclared (`entity-constructor`,
    `entity-proto`).
- **EXT-4** The suite's XML-RPC readers against an independent XML parser, over a corpus of 61
  calls (33 well-formed) and 31 replies (25 well-formed) in `src/formats/corpus/xmlrpc.ts`: the
  same XML edge cases inside XML-RPC documents, and value-type edge cases (untyped values, white
  space inside and around type elements, `<int>`, signs, exponents, CRLF in base64, empty values,
  member names written with references or named `__proto__`, duplicate members, `<nil/>`, mixed
  content). The consumer's reader must agree with the independent parser on acceptance and, read
  through the same XML-RPC mapping over the parser's tree, on the value, which must also be the one
  the specification gives where a case names it. The gateway reads every call over HTTP: the
  -32700 fault is its parse error, and the decoded text comes back in the 404 fault for an unknown
  account, the -32601 fault for an unknown method, or the known account's title. In
  `src/scenarios/parsers.test.ts`, both lanes; the backend side's own regression cases in
  `src/conformance/readers.node.test.ts`, Node lane. Status: tested.
  - `[EXT-4] ${parser} gives XML 1.0's verdict on every call and reply of the XML-RPC corpus, except its recorded disagreements`
  - `[EXT-4] the consumer's XML-RPC reader agrees with ${parser} on every call and reply, and reads the values the specification gives`
  - `[EXT-4] the gateway's XML-RPC reader agrees with ${parser} on every call, judged over HTTP: the parse-error fault, or the decoded text it answers with`
    (the ledger holds exactly the corpus bytes)
  - `[EXT-4] the gateway's XML-RPC reader gives XML 1.0's verdict on the backend-side cases the corpus does not hold, and refuses a DTD as its page documents`
    (18 calls, each with the production that decides it; the ledger holds exactly their bytes)
  - The independent parsers: as for EXT-3, saxes alone refuses the entity from the internal DTD
    subset (`call-doctype-internal-entity`).
  - The consumer: before the EXT-3 fixes to the shared XML reader, it disagreed on
    `call-attr-no-separator`, `call-attr-object-names`, `call-attr-nbsp-separator`,
    `call-prolog-declaration-late`, `-after-space`, `-no-version`, `call-prolog-nbsp`,
    `call-comment-double-hyphen`, `reply-attr-no-separator` and `reply-attr-object-names`. Its
    XML-RPC layer, fixed here, took U+00A0 beside a type element for white space, as `trim` does
    (`reply-nbsp-beside-type`). `XmlRpc.callOf` and `XmlRpc.responseOf` read a tree from any
    parser. Recorded, by design: it refuses every DTD (`call-doctype-*`, `reply-doctype`), because
    it expands no entities and no service the suite reads sends one.
  - Recorded, as the gateway's service page documents: it answers every DTD with the parse-error
    fault (`call-doctype-bare`, `call-doctype-internal-entity`), a 2014 security patch in front of
    expat, which would read the DTD and expand its internal entities. The page said calls were read
    as expat reads them without this exception; the backend side kept the refusal and documented
    it with its owner and reason, rather than writing a DTD reader no client needs.
  - The gateway's reader, fixed against the corpus by the backend side: it refused a comment
    inside a string (`call-comment-in-string`); took U+00A0 for white space
    (`call-attr-nbsp-separator`, `call-prolog-nbsp`); checked neither the XML declaration's place
    nor its content (`call-prolog-declaration-late`, `-after-space`, `-no-version`); and accepted
    `--` in a comment before the root, though not inside it (`call-comment-double-hyphen`), `]]>`
    in text (`call-cdata-end-in-text`), and an attribute given twice (`call-attr-duplicate`). The
    backend-side cases also hold what the corpus does not reach: it refused a processing
    instruction inside a string, a comment inside the method name, `>` and `]]>` in an attribute
    value, white space before an end tag's `>`, and non-ASCII names; and it accepted U+3000 and
    U+FEFF as white space, a processing instruction without a target or with `xml` as one, a
    misordered declaration or one with `standalone="maybe"`, and comments ending in `--->` or
    holding `--` after the root.
- **EXT-5** The store's multipart reader and writer against the platform's `Response.formData()`
  (undici in Node, Chromium's in the browser), over 10 uploads and 7 bundles in
  `src/formats/corpus/multipart.ts`. Each upload the consumer sends, as the ledger recorded it, is
  read by `formData()` and compared with what the store stored (its answer, and the document's type
  and bytes from WebDAV) or refused; each bundle is read by `formData()` and compared with the
  document the store started with, and the consumer's bundle operation must read it as `formData()`
  does through every provider. In `src/scenarios/parsers.test.ts`, both lanes; the backend side's
  own regression cases in `src/conformance/readers.node.test.ts`, Node lane. Status: tested.
  - `[EXT-5] ${formParser} reads the upload bodies the consumer sends through ${provider}, from the ledger, as the store read them: label, file name, type and bytes`
    (provider)
  - `[EXT-5] ${formParser} reads the store's bundles as the store's own record has them, and the consumer's bundle operation reads them as ${formParser} does`
  - `[EXT-5] the store's bundle boundary occurs in no part: a numbered variant when the content or the metadata holds the usual one (RFC 2046 section 5.1.1)`
    (the boundary each bundle takes, its delimiter only where it delimits, and Node's `formData()`
    reading the title and content back)
  - The store's bundle writer, fixed by the backend side: a bundle's boundary was
    `DocVaultBundle-<id>-<version>` whatever the parts held, so content holding that delimiter line
    (`delimiter-in-content`) made a body no parser could split, which RFC 2046 section 5.1.1
    forbids. Both `formData()` parsers refused it, and the consumer's bundle operation failed with
    a `DecodeError`. The store now takes the first numbered variant, `-2`, `-3` and so on, that no
    part holds, as its service page says; the backend-side cases put the delimiter and its first
    variant in the content, and the delimiter in the title, which the metadata part carries.
  - A limit of the platforms: the HTML standard's multipart/form-data encoding writes `"`, CR and LF
    in a file name as `%22`, `%0D` and `%0A`, and gives no rule for reading them back. undici and the
    store decode them; Chromium's `formData()` keeps them (`quote-name`, `line-feed-name`). Neither
    escapes `%`, so a name holding a literal `%22` reads as a quote to undici and the store
    (`percent-name`). Chromium also reads `\` in a quoted file name as a MIME quoted-pair and drops
    it (`backslash-name`), where undici and the store keep it. A bundle's file name is therefore not
    a reliable copy of the document's name in either lane; the name in its JSON metadata is.
  - As observed in both lanes and every provider: a label's LF and lone CR travel as CRLF, as the
    multipart encoding normalizes them, and the store stores CRLF (`label-line-breaks`); a `Blob`
    without a type travels and is stored as `application/octet-stream` (`untyped`).
- **EXT-6a** The gateway's XML-RPC replies against Frontier::RPC2 0.07b4 under Frontier::Daemon
  and XMLRPC::Lite 0.717, recorded serving the gateway's five methods over the same data: every
  value type, base64 long enough to wrap, three faults, and a call sent as `text/plain`
  (`recordings/frontier-rpc2`, `recordings/xmlrpc-lite`). In `src/conformance/xmlrpc.node.test.ts`,
  Node lane. Status: tested.
  - `[EXT-6a] ${name}: the gateway writes Frontier::RPC2's bytes, members in any order` (the
    array of strings, the integer, two structs with every scalar type and an empty array, and the
    base64; masks: `Date`, struct member order)
  - `[EXT-6a] account-title: Frontier::RPC2 types the title and writes character references; the gateway's hand-written reply does neither`
  - `[EXT-6a] ${name}: the same fault layout, with the gateway's own code and string` (Frontier's
    codes `4`, `3` and `1` against the gateway's 404, -32601 and -32700)
  - `[EXT-6a] not-xml: Frontier::RPC2 decodes a text/plain call; the gateway's Apache refuses it with 400`
  - `[EXT-6a] ${name}: XMLRPC::Lite sends the gateway's values in its own spelling` (the same
    values, read type by type)
  - `[EXT-6a] XMLRPC::Lite writes <int>, base64 on one line, raw UTF-8 and no white space between elements`
  - `[EXT-6a] account-title: XMLRPC::Lite types the title as a string, which the gateway leaves untyped`
  - `[EXT-6a] ${name}: XMLRPC::Lite's fault code is ${code}; the gateway's …` (`404`, and the
    string `Client` for protocol errors and the `text/plain` call)
  - Replay: `[EXT-6a] serves every exchange of frontier-rpc2 as recorded: status line, header lines in order, body`,
    and the same for `xmlrpc-lite`.
  - Fixed in the gateway: Frontier::RPC2's exact bytes (character references, `&quot;`, its line
    ends), `Content-Length`, and Apache's `Server` line in place of `Frontier/5.1.2-WinNT`. Kept,
    in services/gateway.md: the fault codes, the hand-written `account.title`, Apache's 400 for a
    call that is not `text/xml`, and HTTP::Daemon's head, which Apache replaces.
- **EXT-6b** The gateway's audit Digest against httpd 2.4.68's `mod_auth_digest` with
  `AuthDigestQop none`, the last httpd that accepts it, recorded with curl computing the
  `Authorization`: the challenge, the authorized request, the same request again at once and after
  the nonce's lifetime, and a wrong password (`recordings/httpd-digest`). In
  `src/conformance/digest.node.test.ts`, Node lane. Status: tested.
  - `[EXT-6b] curl's recorded responses are RFC 2069's, computed from the nonce it was given`
  - `[EXT-6b] ${name}: the same challenge, without opaque, qop or domain` (masks: `Date`, the
    nonce, checked to have httpd's shape)
  - `[EXT-6b] accepted: curl's computation authorizes the request, answered without httpd's Authentication-Info`
    (adapted: the gateway's own nonce, and the response computed from it as curl computed its own)
  - `[EXT-6b] replayed: httpd accepts the same Authorization again within the nonce's lifetime; the gateway's spent nonce answers as httpd's stale one`
  - `[EXT-6b] wrong-password: a fresh challenge without stale, as httpd answers`
  - Replay: `[EXT-6b] serves every exchange of httpd-digest as recorded: status line, header lines in order, body`
    and `[EXT-6b] answers a request no unused exchange matches with 404, and reuses exchanges only when asked`.
  - Fixed in the gateway: the challenge's form, without `opaque`, and httpd's nonce shape; Apache's
    `Server` line and the page's `Content-Length`. Kept, in services/gateway.md: single-use
    nonces, no `Authentication-Info` (httpd's starts with a stray comma), and Apache 1.3's page.
- **EXT-6c** The gateway's old desktop path against httpd 2.4.69's `Redirect permanent`, for a GET
  with the report's query and a POST (`recordings/httpd-redirect`). In
  `src/conformance/redirect.node.test.ts`, Node lane. Status: tested.
  - `[EXT-6c] ${name}: the same 301 and absolute Location, from the request's Host, under Apache 1.3's page`
    (mask: `Date`; both pages link the target, escaped)
  - Replay: `[EXT-6c] serves every exchange of httpd-redirect as recorded: status line, header lines in order, body`
  - Fixed in the gateway: `Location` from the request's `Host`, the escaped link, `Server` and
    `Content-Length`. Kept: Apache 1.3's page and version.
- **EXT-6d** The business API's customer creation against Tomcat 7.0.109, with its defaults and with
  `useRelativeRedirects="false"`: a `Location` set on a 200, and `sendRedirect` with a path, a
  relative path, and followed by `setStatus(200)` (`recordings/tomcat7-redirect`). In
  `src/conformance/location.node.test.ts`, Node lane. Status: tested.
  - `[EXT-6d] header: app-1 answers as Tomcat does when the handler sets Location on a 200`
  - `[EXT-6d] legacy-header: app-legacy-2 absolutizes the Location Tomcat leaves as set, in the form Tomcat's sendRedirect builds`
    (adapted: the recording's `/legacy` context prefix, and four customers so the legacy node's
    creation gets the recorded id)
  - `[EXT-6d] Tomcat 7.0.109 absolutizes only sendRedirect's location, only with useRelativeRedirects="false", and keeps the 302`
  - Replay: `[EXT-6d] serves every exchange of tomcat7-redirect as recorded: status line, header lines in order, body`
  - Corrected in services/business.md and HDR-3: the absolute form is the legacy build's, not the
    container's. Kept: `X-Served-By`, the `Server` line the firewall removes, and chunked framing.
- **EXT-6e** The SOAP store's `LockDocument` faults against the JAX-WS reference implementation in
  JDK 8 (`Endpoint.publish`, a SOAP 1.2 binding for 1.2), for a missing owner, an unknown id and a
  lock conflict in both versions (`recordings/jaxws-faults`). In
  `src/conformance/soap-faults.node.test.ts`, Node lane. Status: tested.
  - `[EXT-6e] soap11-${name}: the same fault under HTTP 500, in the store's Latin-1 writer`
  - `[EXT-6e] soap12-${name}: the same fault under HTTP 500, whatever the 1.2 binding says of sender faults`
    (each compared by namespace-resolved infoset, qualified-name codes included; mask: `Date`;
    adapted: SOAP 1.2 calls go to `/soap`)
  - Replay: `[EXT-6e] serves every exchange of jaxws-faults as recorded: status line, header lines in order, body`
  - Fixed in the store: no detail element for a fault without detail entries. Kept, in
    services/soap-store.md: the Latin-1 SOAP 1.1 writer and its own prefixes and declaration; the
    JDK server's `Content-type` and `Transfer-encoding` spellings are not copied.
- **EXT-7a** Mount and navigation in a built single-page app: a route starts an interaction, and
  navigating away within the page disposes it, which aborts its request on the wire. In
  `src/scenarios/spa.app.test.ts`, which drives the app in `src/app` with Playwright's Chromium
  from Node; the app is built by Vite in production mode against the packed library and served as
  static files with the same-origin proxy. Lane: app. Status: tested.
  - `[EXT-7a] a route mounts the search, which starts its interaction; navigating away disposes it, and the service records the abort`
    (a link to `/search?q=ledger` mounts the search page and sends the search, held by
    `searchLatency`; an in-app link, then the browser's back and forward buttons, each close the
    view's scope. The page stays one document throughout, so no unload aborts anything in the
    app's place. Both aborts are on the ledger and in `GET /v2/ops/abandoned`. The search went to
    the page's own origin, `Sec-Fetch-Site: same-origin`, with the bearer token and the service's
    `Host` from the proxy.)
- **EXT-7b** Supersession under latency in the built app: a second search from the user while the
  first is in flight aborts the first on the wire, and the page shows only the second result. In
  `src/scenarios/spa.app.test.ts`. Lane: app. Status: tested.
  - `[EXT-7b] a second search while the first is in flight aborts the first on the wire, and only the second result is shown`
    (the page's every state is recorded from before its script runs: the superseded search never
    rendered a result)
- **EXT-7c** Reload: a full page load starts clean, with no request of the earlier page left open
  and nothing of its state shown or reused. In `src/scenarios/spa.app.test.ts`. Lane: app.
  Status: tested. Observed in Chromium: the browser closes the earlier page's request as the page
  unloads, without any app or library code running, so this entry shows what a reload leaves
  behind, not the app's disposal, which EXT-7a covers.
  - `[EXT-7c] a reload starts clean: the earlier page's search in flight is closed, and the new page asks again for its own`
    (the new document shows only its own states, and sends its link's search again although the
    earlier page held a result for it)
- **EXT-8a** The consumer's XML-RPC reader and the gateway's contracts against Frontier::RPC2
  0.07b4 and XMLRPC::Lite 0.717 (`recordings/frontier-rpc2`, `recordings/xmlrpc-lite`), served by
  the replay backend: every value type, base64 long enough to wrap, three faults, and the answer to
  a call sent as `text/plain`. Each test sends the consumer's own call through `Rpc`'s operations,
  adapted only by dropping the gateway's `session` parameter, which the recorded servers never
  took; the ledger shows each call as the recording's. The malformed and the `text/plain` calls,
  which the consumer's writer cannot produce, are sent as recorded and decoded by the method's
  decoder. In `src/scenarios/recordings.test.ts`, both lanes. Status: tested.
  - `[EXT-8a] ${set}: the method list, the integer and the title decode through the gateway's contracts (${spelling})`
  - `[EXT-8a] ${set}: invoice 7 decodes through the gateway's struct contract, its members in Perl's hash order`
  - `[EXT-8a] ${set}: invoice 8's migrated 31 February is the contract's decode error, and its other members decode`
    (VAL-1c's declared outcome; read again with `issued` as text, the false flag, the zero date,
    `0.05` and the empty array, `<data />` from XMLRPC::Lite, decode as declared)
  - `[EXT-8a] ${set}: the extract's base64 decodes through the same fixed-width schema as the download`
  - `[EXT-8a] ${set}: its faults are Fault outcomes where faultCode is an integer, and the contract's decode error where it is not`
    (Frontier::RPC2's `4`, `3` and `1` with Perl's messages, and XMLRPC::Lite's `404`, are Fault
    outcomes; XMLRPC::Lite's string `Client` is a decode error of the fault rule)
  - `[EXT-8a] ${set}: the answer to a call sent as text/plain, decoded by report.count's decoder`
    (Frontier::RPC2 decodes the call and answers `3`; XMLRPC::Lite's `Client` fault is a decode
    error)
  - Fixed in the consumer, because the real bytes broke it: `XmlRpc.I4` reads `<int>`, which the
    specification gives as `<i4>`'s other name and XMLRPC::Lite writes for every integer, and
    writes `<i4>`; `XmlRpc.Base64` ignores line feeds wherever they fall, so XMLRPC::Lite's base64
    on one line decodes, where only MIME::Base64's 76-column layout did; and `account.title` reads
    a typed `<string>`, which both modules write, as well as the gateway's untyped value, through
    `XmlRpc.StringValue`. Each states its loss: an `<int>`'s spelling, a typed string's and the
    base64 layout are not re-encoded.
  - Kept: XMLRPC::Lite's string `faultCode` stays a decode error, since the specification makes it
    an `<int>`; `XmlRpc.I4` still refuses `+` and leading zeros, which the specification allows and
    neither module writes.
- **EXT-8b** The consumer's Digest code against httpd 2.4.68's `mod_auth_digest` with
  `AuthDigestQop none` and the `Authorization` curl computed (`recordings/httpd-digest`), served by
  the replay backend, which answers each request in turn whatever its `Authorization`. In
  `src/scenarios/recordings.test.ts`, both lanes. Status: tested.
  - `[EXT-8b] the consumer's parser reads httpd's challenges: realm, a nonce holding + / and =, algorithm=MD5, stale=true unquoted, no opaque`
  - `[EXT-8b] withDigest answers httpd's challenge with the Authorization curl sent, byte for byte, and reads the report under httpd's Authentication-Info`
    (and again with the same `Authorization`, which httpd accepts within the nonce's lifetime)
  - `[EXT-8b] httpd's stale=true challenge is answered once more, with the new nonce`
  - `[EXT-8b] a wrong password computes the response curl sent, and httpd's fresh challenge without stale ends the loop`
  - No fix was needed: from the recorded nonce and the recorded credentials, the consumer writes
    curl's `Authorization` lines exactly, for the right and a wrong password, and httpd's
    `Authentication-Info: , nextnonce="…"` does not disturb the report's decoding.
- **EXT-8c** Redirects as httpd 2.4.69's `Redirect permanent` (`recordings/httpd-redirect`) and
  Tomcat 7.0.109 (`recordings/tomcat7-redirect`) wrote them, through the gateway's `legacyBalance`
  (STAT-10) and the business API's customer creation (STAT-2, HDR-3), per provider and lane. No
  following provider is run against a `Location` naming a recorded host (`gateway.example:8080`,
  `business.example:8080`), since following it would leave loopback. Adapted: Tomcat's
  `sendRedirect` replies are selected by the recording servlet's `variant` query, and its
  `useRelativeRedirects="false"` mode is the context `/legacy`. In
  `src/scenarios/recordings.test.ts`, both lanes. Status: tested.
  - `[EXT-8c] httpd-redirect/get: httpd's 301 reaches legacyBalance as ${provider} hands it over`
    (Node, `lines` and Fetch with `redirect: "manual"`: the declared `Moved` case with httpd's
    absolute `Location` as written, from the recorded `Host`; Chromium, Fetch with
    `redirect: "manual"`: the opaque redirect, status 0 and no `Location`, an `UnexpectedResponse`)
  - `[EXT-8c] tomcat7-redirect: a Location set on a 200, as Tomcat leaves it in both modes, reaches createCustomer's Created case (${provider})`
    (every provider of both lanes; `/v1/customers/1006` resolved against the request URL)
  - `[EXT-8c] tomcat7-redirect: sendRedirect's 302s are no case of the creation contract; ${provider} hands each over with the Location Tomcat wrote`
    (Node: `UnexpectedResponse` with status 302 and `customers/1006`, `/v1/customers/1006` or the
    absolute form as written; Chromium: status 0)
  - `[EXT-8c] tomcat7-redirect: Fetch follows sendRedirect's 302 to the path Tomcat wrote, or to the relative one resolved against the request, as a GET`
    (both lanes: a GET of `/v1/customers/1006` without a body, the relative `customers/1006`
    resolved against `/v1/customers?variant=relative`)
  - Fixed in the consumer, because the real bytes broke it: the creation contract required
    `X-Served-By`, which Tomcat does not write, so Tomcat's 200 was a decode error. The header is
    the balancer's diagnostic, and a decode error after a creation that happened invites a retry
    that duplicates the customer; it is now optional, and `servedBy` an `Option`.
- **EXT-8d** The JAX-WS reference implementation's `LockDocument` faults
  (`recordings/jaxws-faults`) through the consumer's `LockDocument` operation and its one extra
  rule for faults under 500 (ERR-6), in both SOAP versions. Adapted: SOAP 1.2 calls go to
  `/soap12`, where the recording published that binding, and the missing-owner fault answers a
  complete call, since the consumer refuses an empty owner before dispatch, as the test shows. In
  `src/scenarios/recordings.test.ts`, both lanes. Status: tested.
  - `[EXT-8d] jaxws-faults: the RI's SOAP 1.1 faults under 500 decode through LockDocument's fault rule: S:Client and S:Server, with and without detail`
  - `[EXT-8d] jaxws-faults: the RI's SOAP 1.2 faults under 500 decode through LockDocument's fault rule: S:Sender and S:Receiver, with and without Detail`
  - No fix was needed: UTF-8 under a charset, the `S` prefix with codes resolved by namespace,
    `<?xml version="1.0" ?>`, chunked framing, the unused `xmlns:ns4`, and no detail element for
    the missing-owner fault all decode.

### Requests no standard client sends

The entries above cover strange responses. EXT-9 to EXT-16 cover strange requests, most of which
neither standard client can send, tracked in
[#95](https://github.com/viell-dev/slop-effect-schema-http/issues/95) and
[#98](https://github.com/viell-dev/slop-effect-schema-http/issues/98). They rest on a provider that
sends a request exactly as written, `lane.rawClient(backend.origin)`, called the raw client below,
and on a plain socket listener; [AGENTS.md](./AGENTS.md) describes both, and
`src/harness/raw.node.test.ts` tests them without any hostile backend. `fetch` below means
`lane.fetchClient`. EXT-17 covers raw values under a schema at a real service, and EXT-18 to EXT-22
cover paths, variants and values known late. [Failures on the wire](#failures-on-the-wire) has
EXT-23 to EXT-28, which go back to strange responses, and
[A union's fields at the wire](#a-unions-fields-at-the-wire) has EXT-30.

Entries marked limit or defect have tests too, as each entry lists: those statuses record what was
observed, and a test pins it.

Each entry gives the request as a consumer declares it. "The client received" means the request a
`HttpClient.tapRequest` sees when it is applied last in `transformClient`, after any other
middleware: its `method`, `url` and `hash`. A test through `fetch` asserts that as well as the
ledger, because a browser cannot send these shapes, and a regression that lost one only in a browser
would otherwise go unseen. A `fetch` test runs in both lanes unless its entry says otherwise, and
asserts each lane's own result where they differ.

The results below were measured on 2026-11-07 with the library at the commit in `library-ref`,
Effect 4.1.2, Node.js 24.22.2 and Chromium 158. Issues #95 and #98 hold the first measurements, with
published `0.1.0`.

#### Fragments

EXT-9a to EXT-9p send a URL fragment. A standard client never sends one, but a client that writes
its own request line can, and a server can read it, as the gateway's
[help topics](./services/gateway.md#the-help-topics-1998) do. `node:http` passes a fragment through,
so these start the gateway with `lane.backend("gateway")` and its default listener, unless an entry
says otherwise. The tests that need the raw client are in `src/scenarios/fragments.node.test.ts`,
because only Node can send a fragment; the others are in `src/scenarios/fragments.test.ts`, in both
lanes. The consumer's reader of these replies has round-trip and negative tests of its own in
`src/clients/gateway/help.test.ts`, listed under EXT-9e, and for a `|` in a message under EXT-9p.
`<help>` below is `/cgi-bin/help.cgi/accounts`. Its whole topic is the `opening` and `closing`
lines, and the `closing` line alone is the section.

- **EXT-9a** A fragment in a base URL or in path output, through the raw client: the server reads it
  and answers one section. Declared as `Request.get("")` with
  `Request.baseUrl("${origin}<help>#closing")`, and as `Request.get("")` with
  `Request.path(Schema.String, (path) => path)`, `Request.baseUrl(origin)` and the input
  `{ path: "<help>#closing" }`. The client received `${origin}<help>` with the `hash` `closing`. The
  target is `<help>#closing`. Status: tested.
  - `[EXT-9a] a fragment in the base URL reaches help.cgi, which answers that section`
  - `[EXT-9a] a fragment in path output reaches help.cgi, which answers that section`
- **EXT-9b** A fragment set in client middleware, with a query, through the raw client. Declared as
  `Request.get("${origin}<help>")` with `Request.setQuery("lang", "de")` and
  `transformClient: HttpClient.mapRequest(HttpClientRequest.setHash("closing"))`. The client
  received `${origin}<help>?lang=de` with the `hash` `closing`. The target is
  `<help>?lang=de#closing`, and the answer is the `closing` line in German. Status: tested.
  - `[EXT-9b] setHash in transformClient puts the fragment after the query, and help.cgi answers that section in German`
- **EXT-9c** A fragment in the constructor, through the raw client: it stays on the request, as
  [#93](https://github.com/viell-dev/slop-effect-schema-http/issues/93) decided, so a client can
  send it. Declared as `Request.get("${origin}<help>#closing")`. The client received
  `${origin}<help>` with the `hash` `closing`, the target is `<help>#closing`, and the answer is
  that section. Status: tested.
  - `[EXT-9c] a fragment in the constructor stays on the request and reaches help.cgi, which answers that section`
- **EXT-9d** A fragment in path output with a query, through the raw client: the query goes before
  the fragment, as [#83](https://github.com/viell-dev/slop-effect-schema-http/issues/83) decided.
  Declared as EXT-9a's path output with `Request.setQuery("lang", "de")`. The client received
  `${origin}<help>?lang=de` with the `hash` `closing`, the target is `<help>?lang=de#closing`, and
  the answer is the `closing` line in German. Status: tested.
  - `[EXT-9d] a query goes before a fragment in path output, and help.cgi answers that section in German`
- **EXT-9e** The declarations of EXT-9a to EXT-9d and EXT-9h to EXT-9n through every provider of
  the lane: the platform drops the fragment. Each client received what the raw client received in
  that entry, the `hash` included. A browser cannot send a fragment, so this is where a fragment lost
  only in a browser would show. A target is that entry's without its fragment, and with no `?lang=de`
  the answer is the whole topic in English; with it, the whole topic in German. The same in both
  lanes, and for `fetch` and `lines` in Node. Status: limit.
  - `[EXT-9e] ${provider} drops a fragment from ${declaration}, and help.cgi answers without it`
    (provider)
  - `[EXT-9e] HelpReply round-trips a whole topic, keeping the order of its lines`
  - `[EXT-9e] HelpReply round-trips one section and one ERROR line`
  - `[EXT-9e] HelpReply refuses ${name}`
- **EXT-9f** A redirect whose `Location` carries a fragment, through the raw client with
  `transformClient: (client) => HttpClient.followRedirects(client)`. Declared as
  `Request.get("${origin}/cgi-bin/go.cgi")` with `Request.setQuery("section", "closing")`, and the
  gateway answers 302 with `Location: ${origin}<help>#closing`. Effect's redirect handling moves the
  fragment into the next request's `hash`, and the raw client writes it. The ledger holds
  `/cgi-bin/go.cgi?section=closing`, then `<help>#closing`, and the answer is the section.
  Status: tested.
  - `[EXT-9f] followRedirects moves a Location's fragment into the hash, and the raw client sends it to help.cgi`
- **EXT-9g** The redirect of EXT-9f through `fetch`, which follows it by itself: the platform drops
  the `Location`'s fragment. The ledger holds `/cgi-bin/go.cgi?section=closing`, then `<help>`, and
  the answer is the whole topic. Status: limit.
  - `[EXT-9g] fetch follows go.cgi's redirect without the Location's fragment, and help.cgi answers the whole topic`
- **EXT-9h** A fragment in the constructor with a query set on it, through the raw client. Declared
  as EXT-9c's constructor with `Request.setQuery("lang", "de")`. The client received
  `${origin}<help>?lang=de` with the `hash` `closing`, the target is `<help>?lang=de#closing`, and
  the answer is the `closing` line in German. Status: tested.
  - `[EXT-9h] a constructor's fragment goes after a query set on it, and help.cgi answers that section in German`
- **EXT-9i** A constructor's query and fragment under `Request.path` and `Request.baseUrl`, through
  the raw client: both survive the path being added to. Declared as
  `Request.get("/cgi-bin/help.cgi?lang=de#closing")` with EXT-9a's path binding,
  `Request.baseUrl(origin)` and the input `{ path: "/accounts" }`. The client, the target and the
  answer are EXT-9h's. Status: tested.
  - `[EXT-9i] a constructor's query and fragment survive Request.path and the base URL`
- **EXT-9j** A fragment in a base URL with a path to join and a query, through the raw client: the
  last row of #83's table. Declared as `Request.get("accounts")` with
  `Request.baseUrl("${origin}/cgi-bin/help.cgi#closing")` and `Request.setQuery("lang", "de")`. The
  client, the target and the answer are EXT-9h's. Status: tested.
  - `[EXT-9j] a joined path and a query both go before a base URL's fragment`
- **EXT-9k** Fragments in two places, through the raw client: the constructor's wins over path
  output's, and path output's over the base URL's. A base URL's fragment applies even when an
  absolute URL bypassed the rest of that base. In each case the winner is `closing`, the loser
  `opening`, the client received `${origin}<help>` with the `hash` `closing`, the target is
  `<help>#closing`, and the answer is that section. Status: tested.
  - `[EXT-9k] the constructor's fragment wins over path output's`
  - `[EXT-9k] path output's fragment wins over the base URL's`
  - `[EXT-9k] a base URL's fragment still applies when an absolute URL bypassed that base`
- **EXT-9l** A `?` inside a fragment, with a query, through the raw client: the `?` stays in the
  fragment, and the query still gets a `?` of its own, where the library used to write `&`. Declared
  as EXT-9d with the input `{ path: "<help>#closing?x=1" }`. The client received
  `${origin}<help>?lang=de` with the `hash` `closing?x=1`, the target is
  `<help>?lang=de#closing?x=1`, and `help.cgi` answers `ERROR|E_SECTION|no section closing?x=1`.
  Status: tested.
  - `[EXT-9l] a ? in a fragment stays in it and the query gets its own, so help.cgi looks up that whole section name`
- **EXT-9m** A fragment that `URL` would percent-encode, through the raw client:
  `Request.get("${origin}<help>#a b\"c")`. The `hash` keeps the text as written, and the raw client
  reads it from there, so the target is `<help>#a b"c`. `node:http` refuses a raw space in a target,
  so this starts the gateway with `{ listener: "socket" }`. `help.cgi` answers
  `ERROR|E_SECTION|no section a b"c`. Status: tested.
  - `[EXT-9m] a fragment reaches the client and the socket as written, with what URL would encode`
- **EXT-9n** An empty fragment, through the raw client: `Request.get("${origin}<help>#")`. The client
  received the `hash` `""`, not none, and the target is `<help>#`. `help.cgi` reads an empty fragment
  as none and answers the whole topic. Status: tested.
  - `[EXT-9n] an empty fragment reaches the client and the socket, and help.cgi reads it as none`
- **EXT-9o** Taking a constructor's fragment off: EXT-9c with `Request.mapEffect` applying
  `HttpClientRequest.removeHash`, the one way to do it, since a fragment on a shared definition is
  rare enough to need no API of its own. No client received a `hash`, the target is `<help>`, and
  the answer is the whole topic, through the raw client and every provider of the lane.
  Status: tested.
  - `[EXT-9o] removeHash in Request.mapEffect takes the constructor's fragment off before ${provider} receives the request`
    (`the raw client`, and each provider of the lane)
- **EXT-9p** A `|` in a fragment, through the raw client: `Request.get("${origin}<help>#a|b")`. The
  client received `${origin}<help>` with the `hash` `a|b`, and the target is `<help>#a|b`.
  `help.cgi` quotes the fragment as it arrived and answers `ERROR|E_SECTION|no section a|b`, four
  fields when split at every `|`. The service page makes an `ERROR` line's message everything after
  its second `|`, so the consumer's reader joins the fields after the code again, and the contract
  decodes the code `E_SECTION` and the message `no section a|b`. The reader allowed no `|` in a
  field and gave a decode error
  ([#122](https://github.com/viell-dev/slop-effect-schema-http/issues/122)); it now takes the code
  and message from the first two `|` alone. A section line still has exactly its four fields, and a
  message that a line end cut, as a decoded `%0A` does, is still refused. Status: tested.
  - `[EXT-9p] a | in a fragment reaches help.cgi, whose ERROR line quotes it, and the message is everything after the second |`
    (the same request read as text shows the four fields)
  - Round trips (`src/clients/gateway/help.test.ts`):
    `[EXT-9p] HelpReply reads an ERROR message holding ${name} as everything after the second |, and round-trips it`
    (one `|`, several, `|` at its ends and side by side, and nothing but a `|`), and
    `[EXT-9p] HelpReply refuses to write a | in an ERROR code, or a line end in its message`. Its
    negative cases are EXT-9e's `HelpReply refuses ${name}`.
  - Backend side: EXT-31c holds the gateway to the page's bytes for the same target.

#### Request shapes

EXT-10a to EXT-10x send odd request shapes through the raw client, in
`src/scenarios/request-shapes.node.test.ts`, which needs Node because only Node has that client.
EXT-11a to EXT-11x send the same shapes through `fetch`, in `src/scenarios/request-shapes.test.ts`,
in both lanes. The letters match: EXT-11c is EXT-10c's shape. Where an entry says a URL is resolved
or normalized, that happens in the URL parse inside Effect's `HttpClient.make`, before `fetch` sees
the request, so any provider built with `make` does the same.

The server's answer is not the point of these, so each test starts the neutral helper, with
`lane.backend("echo", undefined, { listener: "socket" })`. The socket listener is needed because
`node:http` stops a raw space, tab or non-ASCII byte in the target, a lower-case or unknown method
and a broken request line with 400 before a handler runs, and closes the connection on `CONNECT`.
`echo` answers 404 with the text `Not Found` for any path but `/text`, `/scopes` and `/hold`, so
each test uses another path and declares `Response.status(404, Body.text)`. `origin` below is
`backend.origin`, and `<host>` the same without `http://`.

For the raw client, the ledger's `head` is the proof. Unless an entry says otherwise, it is the
entry's request line, then `host: <host>`, then `accept: text/plain`. The client received the URL
as declared in every entry, whatever the provider then does with it.

- **EXT-10a** Dot segments in a path: `Request.get("${origin}/a/../b")`. Sent as
  `GET /a/../b HTTP/1.1`. Status: tested.
  - `[EXT-10a] the raw client sends /a/../b with its dot segments`
- **EXT-10b** Percent-encoded dot segments: `Request.get("${origin}/a/%2e%2e/b")`. Sent as
  `GET /a/%2e%2e/b HTTP/1.1`. Status: tested.
  - `[EXT-10b] the raw client sends /a/%2e%2e/b unchanged`
- **EXT-10c** A backslash in a path: ``Request.get(`${origin}/a\\b`)``, one backslash on the wire.
  Sent as `GET /a\b HTTP/1.1`. Status: tested.
  - `[EXT-10c] the raw client sends a backslash in a path unchanged`
- **EXT-10d** A space in a path: `Request.get("${origin}/a b")`. Sent as `GET /a b HTTP/1.1`, and
  the ledger's target is `/a b`. Status: tested.
  - `[EXT-10d] the raw client sends a raw space in a path`
- **EXT-10e** A non-ASCII path: `Request.get("${origin}/ä")`. The raw client writes a target as
  UTF-8, and the ledger reads bytes as characters one for one, so the target is `/` and the two
  characters U+00C3 and U+00A4, for the bytes `C3 A4`. Status: tested.
  - `[EXT-10e] the raw client sends /ä as its raw UTF-8 bytes`
- **EXT-10f** A tab in a path: ``Request.get(`${origin}/a\tb`)``. Sent with the tab, and the
  ledger's target is `/a\tb`. Status: tested.
  - `[EXT-10f] the raw client sends a tab in a path`
- **EXT-10g** Path spellings no client changes: `/a//b`, `/a;v=1/b` and `/a%2Fb`, each through
  `Request.get`. Each is sent unchanged. Status: tested.
  - `[EXT-10g] the raw client sends ${path} unchanged`
- **EXT-10h** A lower-case method: `Request.make("get", "${origin}/shape")`. Sent as
  `get /shape HTTP/1.1`, and the ledger's method is `get`. Status: tested.
  - `[EXT-10h] the raw client sends the method get in lower case`
- **EXT-10i** The method `patch`, which `fetch` leaves in lower case:
  `Request.make("patch", "${origin}/shape")`. Sent as `patch /shape HTTP/1.1`. Status: tested.
  - `[EXT-10i] the raw client sends the method patch in lower case`
- **EXT-10j** `TRACE` and `CONNECT`: `Request.make("TRACE", "${origin}/shape")`, and the same with
  `CONNECT`. Sent as `TRACE /shape HTTP/1.1` and `CONNECT /shape HTTP/1.1`. Status: tested.
  - `[EXT-10j] the raw client sends ${method}`
- **EXT-10k** A method with a space: `Request.make("BAD METHOD", "${origin}/shape")`. Sent as
  `BAD METHOD /shape HTTP/1.1`. A server splits that at the first space, so the ledger's method is
  `BAD` and its target `METHOD /shape`; `head` shows what was sent. Status: tested.
  - `[EXT-10k] the raw client sends the method BAD METHOD, which the server splits at its space`
- **EXT-10l** `OPTIONS` on a path of `*`: `Request.options("${origin}/*")`. Sent as
  `OPTIONS /* HTTP/1.1`. Status: tested.
  - `[EXT-10l] the raw client sends OPTIONS on the path /*`
- **EXT-10m** A `host` header set by the request:
  `Request.setHeader("host", "other.example:8080")` on `Request.get("${origin}/shape")`. `head` has
  `host: other.example:8080` in place of `host: <host>`, and no other `host` line. Status: tested.
  - `[EXT-10m] the raw client sends the host header the request set`
- **EXT-10n** An empty header value: `Request.setHeader("x-empty", "")`. `head` has `x-empty: ` as a
  line, and the ledger's lines hold `["x-empty", ""]`. Status: tested.
  - `[EXT-10n] the raw client sends an empty header value`
- **EXT-10o** A Latin-1 header value: `Request.setHeader("x-name", "Müller")`. The raw client
  writes a header line as Latin-1, so `ü` is the single byte `0xFC`, and the ledger's value reads
  `Müller`. Status: tested.
  - `[EXT-10o] the raw client sends a Latin-1 header value as Latin-1 bytes`
- **EXT-10p** A header value containing CR and LF: `Request.setHeader("x-name", "a\r\nx-added: b")`.
  The library passes it on and the raw client refuses nothing, so it becomes two header lines,
  `x-name: a` and `x-added: b`. This is why a provider that writes bytes itself must refuse CR and
  LF: the library will not. Status: tested.
  - `[EXT-10p] a header value with CR and LF becomes two header lines through the raw client`
- **EXT-10q** A path containing CR and LF: `Request.get("${origin}/a\r\nb")`. It breaks the request
  line: `head` starts `GET /a`, then `b HTTP/1.1`, then `host: <host>`. The ledger's method is
  `GET`, its target `/a`, and its first line `["b HTTP/1.1", ""]`. Status: tested.
  - `[EXT-10q] a path with CR and LF breaks the request line through the raw client`
- **EXT-10r** A URL with user info: `Request.get("http://user:pw@<host>/shape")`. The URL does not
  start with the origin, so it goes on the request line whole, as an absolute-form target:
  `GET http://user:pw@<host>/shape HTTP/1.1`, with `host: <host>` as usual. Status: tested.
  - `[EXT-10r] the raw client sends a URL with user info whole`
- **EXT-10s** A DELETE with a body: `Request.del("${origin}/shape")` with `Request.body(Body.text)`
  and the input `{ body: "gone" }`. `head` is `DELETE /shape HTTP/1.1`, `host: <host>`,
  `content-type: text/plain`, `content-length: 4`, `accept: text/plain`, and the ledger's body is
  `gone`. Status: tested.
  - `[EXT-10s] the raw client sends a DELETE with its body`
- **EXT-10t** A bare `*`, with no URL at all: `Request.options("*")`. `HttpClient.make` would fail
  on it, but the raw client needs no valid URL. Sent as `OPTIONS * HTTP/1.1`. Status: tested.
  - `[EXT-10t] the raw client sends OPTIONS *`
- **EXT-10u** A URL no parser accepts: `Request.get("http://[bad/x")`. Sent whole, as
  `GET http://[bad/x HTTP/1.1`. Status: tested.
  - `[EXT-10u] the raw client sends an unparseable URL whole`
- **EXT-10v** Opaque query text, the route the design documents: `Request.get("${origin}/shape")`
  with `Request.mapEffect` appending the text to the native request's URL through
  `HttpClientRequest.setUrl`, for each of `?a=1;b=2`, `?a=1&&b=2`, a bare `?`, `?a=%2f` and
  `?q=a|b[1]{x}`. Each arrives unchanged. Status: tested.
  - `[EXT-10v] the raw client sends the opaque query ${query} unchanged`
- **EXT-10w** A GET with a body: `Request.get("${origin}/shape")` with `Request.body(Body.text)` and
  the input `{ body: "hello" }`. The library passes it on like any other method, as
  [#96](https://github.com/viell-dev/slop-effect-schema-http/issues/96) decided. `head` is
  `GET /shape HTTP/1.1`, `host: <host>`, `content-type: text/plain`, `content-length: 5`,
  `accept: text/plain`, and the ledger's body is `hello`. STAT-12 is the same request to a service
  that needs it. Status: tested.
  - `[EXT-10w] the raw client sends a GET with a body`
- **EXT-10x** A HEAD with a body: EXT-10w through `Request.head`, with the same `head` under
  `HEAD /shape HTTP/1.1`. `echo`'s reply has no body, so the answer is empty. Status: tested.
  - `[EXT-10x] the raw client sends a HEAD with a body`
- **EXT-11a** Dot segments through `fetch`: the target is `/b`. Status: limit.
  - `[EXT-11a] fetch resolves /a/../b to /b after the client received it as written`
- **EXT-11b** Percent-encoded dot segments through `fetch`: the target is `/b`. Status: limit.
  - `[EXT-11b] fetch resolves /a/%2e%2e/b to /b after the client received it as written`
- **EXT-11c** A backslash through `fetch`: the target is `/a/b`. Status: limit.
  - `[EXT-11c] fetch turns a backslash in a path into a slash after the client received it as written`
- **EXT-11d** A space through `fetch`: the target is `/a%20b`. Status: limit.
  - `[EXT-11d] fetch percent-encodes a space in a path after the client received it as written`
- **EXT-11e** A non-ASCII path through `fetch`: the target is `/%C3%A4`. Status: limit.
  - `[EXT-11e] fetch percent-encodes /ä after the client received it as written`
- **EXT-11f** A tab through `fetch`: the tab is removed, and the target is `/ab`. Status: limit.
  - `[EXT-11f] fetch removes a tab from a path after the client received it as written`
- **EXT-11g** Path spellings no client changes, through `fetch`: `/a//b`, `/a;v=1/b` and `/a%2Fb`
  each arrive unchanged. Status: tested.
  - `[EXT-11g] fetch sends ${path} unchanged`
- **EXT-11h** A lower-case `get` through `fetch`: the client received `get`, and the Fetch standard
  normalizes it, so the ledger's method is `GET`. Status: limit.
  - `[EXT-11h] fetch normalizes the method get to GET after the client received it as written`
- **EXT-11i** The method `patch` through `fetch`: the Fetch standard normalizes only `DELETE`,
  `GET`, `HEAD`, `OPTIONS`, `POST` and `PUT`, so the ledger's method is `patch`. Status: tested.
  - `[EXT-11i] fetch sends the method patch in lower case`
- **EXT-11j** `TRACE` and `CONNECT` through `fetch`: refused, as `HttpClientError` with a
  `TransportError` reason. The client received the request, and the ledger is empty. Status: limit.
  - `[EXT-11j] fetch refuses ${method} as a transport error after the client received it`
- **EXT-11k** A method with a space through `fetch`: refused the same way. Status: limit.
  - `[EXT-11k] fetch refuses the method BAD METHOD as a transport error after the client received it`
- **EXT-11l** `OPTIONS` on a path of `*` through `fetch`: the target is `/*`. Status: tested.
  - `[EXT-11l] fetch sends OPTIONS on the path /*`
- **EXT-11m** A `host` header through `fetch`: ignored without an error, in both lanes. The ledger's
  `Host` value is `<host>`. Status: limit.
  - `[EXT-11m] fetch ignores the host header the request set`
- **EXT-11n** An empty header value through `fetch`: sent, and the ledger's lines hold the name with
  an empty value. Status: tested.
  - `[EXT-11n] fetch sends an empty header value`
- **EXT-11o** A Latin-1 header value through `fetch`: sent, and the ledger's value reads `Müller`.
  Status: tested.
  - `[EXT-11o] fetch sends a Latin-1 header value as Latin-1 bytes`
- **EXT-11p** A header value containing CR and LF through `fetch`: refused, as `HttpClientError`
  with a `TransportError` reason. The client received the request, and the ledger is empty.
  Status: limit.
  - `[EXT-11p] fetch refuses a header value with CR and LF as a transport error after the client received it`
- **EXT-11q** A path containing CR and LF through `fetch`: the URL parser removes both, and the
  target is `/ab`. Status: limit.
  - `[EXT-11q] fetch removes CR and LF from a path after the client received it as written`
- **EXT-11r** A URL with user info through `fetch`: refused, as `HttpClientError` with a
  `TransportError` reason. The client received the request, and the ledger is empty. Status: limit.
  - `[EXT-11r] fetch refuses a URL with user info as a transport error after the client received it`
- **EXT-11s** A DELETE with a body through `fetch`: sent, and the ledger's body is `gone`.
  Status: tested.
  - `[EXT-11s] fetch sends a DELETE with its body`
- **EXT-11t** A bare `*` through `fetch`: the lanes differ, because Effect resolves a relative URL
  against the page. In Node there is no page, so it fails as `HttpClientError` with an
  `InvalidUrlError` reason. In Chromium `*` becomes the page's own `/*`, so the request goes to the
  page's server and the answer is an `UnexpectedResponse`; its status is the test server's own, 204
  when measured, so a test does not pin it. The ledger is empty in both. Status: limit.
  - `[EXT-11t] OPTIONS * never reaches the backend through fetch: Node refuses the URL, and Chromium sends it to the page's own origin`
- **EXT-11u** A URL no parser accepts through `fetch`: fails as `HttpClientError` with an
  `InvalidUrlError` reason, and the ledger is empty. Status: limit.
  - `[EXT-11u] fetch refuses an unparseable URL as an invalid URL after the client received it`
- **EXT-11v** Opaque query text through `fetch`: each spelling arrives unchanged. Status: tested.
  - `[EXT-11v] fetch sends the opaque query ${query} unchanged`
- **EXT-11w** A GET with a body through `fetch`: refused, as `HttpClientError` with a `TransportError`
  reason whose cause holds the platform's words, `Request with GET/HEAD method cannot have body.`,
  in Node and in Chromium. The client received the request with its body and headers, and the ledger
  is empty. Status: limit.
  - `[EXT-11w] fetch refuses a GET with a body as a transport error after the client received it`
- **EXT-11x** A HEAD with a body through `fetch`: refused the same way. Status: limit.
  - `[EXT-11x] fetch refuses a HEAD with a body as a transport error after the client received it`

#### Automatic headers

EXT-12 and EXT-13 cover what the library adds by itself: an operation's `Accept`, and a body's
`Content-Type` and `Content-Length`. A request's own declaration wins over these, and
`Request.removeHeader` stops them, as
[#100](https://github.com/viell-dev/slop-effect-schema-http/issues/100) decided and the design page
states under _Bodies_. EXT-12a to EXT-12u go through the raw client, in
`src/scenarios/header-declarations.node.test.ts`, which needs Node because only Node has that
client, and every other client adds or changes these headers. EXT-13a to EXT-13u go through `fetch`,
in `src/scenarios/header-declarations.test.ts`, in both lanes. The letters match, and
`src/clients/echoed.ts` holds the declarations they share.

Each test starts `echo` with its socket listener and declares `Response.status(404, Body.text)`, so
the automatic `Accept` is `text/plain`. "A `POST` with `hello`" below is
`Request.post("${origin}/shape")` with `Request.body(Body.text)` and the input `{ body: "hello" }`.
An entry with a body is a `POST`, and any other a `GET`. For the raw client, `head` is the proof: the
request line, then `host: <host>`, then the lines an entry gives, and no others. An EXT-13 test compares all three
headers at the client and on the wire, so one gained or lost beside the header in the title fails
too.

Effect's Fetch provider takes a declared `Content-Length` off before `fetch` sees it, unless the
value is empty. So what the platform itself does with a wrong length needs a client that hands the
header over: "bare `fetch`" below is a small `HttpClient.make` client in the test, which passes
`request.headers` and the body's bytes to the lane's `fetch`.

- **EXT-12a** Nothing declared: a `POST` with `hello`. `head` has `content-type: text/plain`,
  `content-length: 5` and `accept: text/plain`, and the body arrives. Status: tested.
  - `[EXT-12a] a request that declares nothing gets the automatic Accept, Content-Type and Content-Length`
- **EXT-12b** `Request.removeHeader("accept")`, alone and followed by
  `Request.setHeader("accept", () => undefined)`, which declares nothing. `head` has no other line.
  Status: tested.
  - `[EXT-12b] removeHeader("accept") stops the automatic Accept`
  - `[EXT-12b] a computed value that returns undefined declares nothing, so the removal stays in force`
- **EXT-12c** `Request.setHeader("accept", "text/weird")`. `head` has `accept: text/weird`.
  Status: tested.
  - `[EXT-12c] a declared Accept wins over the automatic one`
- **EXT-12d** `Request.setHeader("accept", "")`. `head` has `accept: ` as its one line. Status:
  tested.
  - `[EXT-12d] an empty declared Accept goes out empty, and the automatic one stays away`
- **EXT-12e** A header schema that writes `accept`, with the input `text/schema`. `head` has
  `accept: text/schema`. Status: tested.
  - `[EXT-12e] a header schema that writes Accept wins over the automatic one`
- **EXT-12f** Optional schema fields left out: a `POST` with `hello` under a header schema of
  optional `accept` and `content-type`, with the input `{ headers: {} }`. `head` is EXT-12a's.
  Status: tested.
  - `[EXT-12f] an optional schema field left out declares nothing, so the automatic values stay`
- **EXT-12g** A declared `Content-Type`: a `POST` with `hello` and
  `Request.setHeader("Content-Type", "application/weird")`, before and after the body. `head` has
  `Content-Type: application/weird`, in that spelling, and `content-length: 5` and
  `accept: text/plain`. Two lines from `Request.appendHeader`, spelled differently, both go out as
  written. Status: tested.
  - `[EXT-12g] a Content-Type declared before the body wins, with its spelling`
  - `[EXT-12g] a Content-Type declared after the body wins, with its spelling`
  - `[EXT-12g] two Content-Type lines declared with appendHeader both go out, as written`
- **EXT-12h** A header schema that writes `Content-Type`, bound before and after the body. `head` is
  EXT-12g's. Status: tested.
  - `[EXT-12h] a header schema bound before the body wins over the codec's Content-Type`
  - `[EXT-12h] a header schema bound after the body wins over the codec's Content-Type`
- **EXT-12i** `Request.removeHeader("content-type")` on a `POST` with `hello`. `head` has
  `content-length: 5` and `accept: text/plain`. Status: tested.
  - `[EXT-12i] removeHeader("content-type") stops the codec's Content-Type`
- **EXT-12j** `Request.removeHeader("content-type", "text/plain")`: a removal limited to one value
  records nothing, because the name may still be declared. `head` is EXT-12a's. Status: tested.
  - `[EXT-12j] a removal limited to one value stops nothing`
- **EXT-12k** A declared `Content-Type` over `Body.empty`, on a `POST`. `head` has
  `content-type: application/weird` and `accept: text/plain`, and no `Content-Length`, because the
  raw client frames only bytes. Status: tested.
  - `[EXT-12k] a declared Content-Type stays on a request with Body.empty`
- **EXT-12l** A declared `Content-Type` over `Body.formData`. Without one, `head` has the boundary
  the provider supplied. With `multipart/form-data` declared, `head` has that value alone, and the
  body still has a boundary nothing on the request names, so no server can read it. That is the
  consumer's choice. Status: tested.
  - `[EXT-12l] a declared Content-Type replaces the boundary a multipart body would have had`
- **EXT-12m** `Request.mapEffect` setting `content-type` after the body, over a declared one. Its
  value goes out, as a line in lower case. Status: tested.
  - `[EXT-12m] Request.mapEffect after the body has the last word`
- **EXT-12n** `Request.mapEffect` setting `content-type` before the body: the codec's value replaces
  the edit, unless the request removed that name, in which case the edit goes out. Status: tested.
  - `[EXT-12n] Request.mapEffect before the body sees its edit replaced`
  - `[EXT-12n] Request.mapEffect before the body keeps its edit when the request removed that name`
- **EXT-12o** `Request.removeHeader("accept")` and then `Request.setHeader("accept", "text/late")`.
  `head` has `accept: text/late`. Status: tested.
  - `[EXT-12o] a later declaration still goes out after a removal`
- **EXT-12p** A removal and a schema: a removal can never discard what a schema writes. After a
  schema that always writes `accept`, the removal is `Request.InvalidRequest` before anything is
  sent, and the ledger is empty. Before that schema, the schema's value goes out. After an optional
  field, nothing goes out if the caller leaves it out, and the caller's value if not. Status: tested.
  - `[EXT-12p] removing a name a schema always writes, after that schema, is refused before anything is sent`
  - `[EXT-12p] a removal before a schema never discards what the schema writes`
  - `[EXT-12p] a removal after an optional schema field stays in force when the caller leaves it out`
  - `[EXT-12p] a removal after an optional schema field gives way to a caller's value`
- **EXT-12q** A `Content-Length` below the body's: a `POST` with `hello` and
  `Request.setHeader("Content-Length", "3")`. `head` has `Content-Length: 3`, then
  `content-type: text/plain` and `accept: text/plain`. The declaration never changes the bytes, so
  all five go out, and the server, which believes the line, reads `hel`. Status: tested.
  - `[EXT-12q] a declared Content-Length below the body's goes out, with the whole body, and the server reads that many bytes`
- **EXT-12r** A `Content-Length` above the body's: the same with `10`. The line goes out, and the
  server waits for bytes that never come. `arrived(1)` fires on the head, so the test then waits 300
  milliseconds for an answer, and none comes. The ledger's body is the five bytes sent, short of the
  ten the line promised, and the test stops the request. Status: tested.
  - `[EXT-12r] a declared Content-Length above the body's goes out, and the server waits for bytes that never come`
- **EXT-12s** An empty `Content-Length`: `Request.setHeader("content-length", "")`. `head` has
  `content-length: ` as a line, and the socket listener reads no body. Status: tested.
  - `[EXT-12s] an empty declared Content-Length goes out empty, and the server reads no body`
- **EXT-12t** `Request.removeHeader("content-length")`. The library adds nothing. The raw client
  frames a body itself unless told not to, so with `{ framing: false }` `head` has
  `content-type: text/plain` and `accept: text/plain` alone, and the socket listener reads no body.
  Without it, `content-length: 5` follows them, as the line-preserving provider's does. Status:
  tested.
  - `[EXT-12t] removeHeader("content-length") leaves the provider to frame the body, and this one can decline`
  - `[EXT-12t] the raw client frames a body whose Content-Length the request removed`
- **EXT-12u** Client middleware removing the automatic value: `transformClient` with
  `HttpClient.mapRequest(HttpClientRequest.removeHeader("accept"))`. It runs after the operation
  added `Accept`, so `head` has no other line. Status: tested.
  - `[EXT-12u] client middleware that removes Accept leaves the request with none`
- **EXT-13a** EXT-12a through `fetch`: all three reach the client and arrive. Status: tested.
  - `[EXT-13a] a request that declares nothing gets the automatic Accept, Content-Type and Content-Length`
- **EXT-13b** EXT-12b through `fetch`: no client received an `Accept`, and the platform adds
  `Accept: */*`, in both lanes. Status: limit.
  - `[EXT-13b] removeHeader("accept") reaches the client with no Accept, and the platform adds its own`
  - `[EXT-13b] a computed value that returns undefined leaves the removal in force, and the platform adds its own`
- **EXT-13c** EXT-12c through `fetch`. Status: tested.
  - `[EXT-13c] a declared Accept wins over the automatic one`
- **EXT-13d** EXT-12d through `fetch`: the empty value arrives, in both lanes, and the platform adds
  no `Accept` of its own. Status: tested.
  - `[EXT-13d] an empty declared Accept goes out empty, and the automatic one stays away`
- **EXT-13e** EXT-12e through `fetch`. Status: tested.
  - `[EXT-13e] a header schema that writes Accept wins over the automatic one`
- **EXT-13f** EXT-12f through `fetch`. Status: tested.
  - `[EXT-13f] an optional schema field left out declares nothing, so the automatic values stay`
- **EXT-13g** EXT-12g through `fetch`. The two lines reach `fetch` joined, as
  `application/one, application/two`, and go out as one. Status: tested.
  - `[EXT-13g] a Content-Type declared before the body wins`
  - `[EXT-13g] a Content-Type declared after the body wins`
  - `[EXT-13g] two Content-Type lines declared with appendHeader reach fetch joined, and go out as one`
- **EXT-13h** EXT-12h through `fetch`. Status: tested.
  - `[EXT-13h] a header schema bound before the body wins over the codec's Content-Type`
  - `[EXT-13h] a header schema bound after the body wins over the codec's Content-Type`
- **EXT-13i** EXT-12i through `fetch`: neither platform supplies a `Content-Type` for a body of
  bytes, so none arrives. Status: tested.
  - `[EXT-13i] removeHeader("content-type") stops the codec's Content-Type, and a body of bytes gets none from fetch`
- **EXT-13j** EXT-12j through `fetch`. Status: tested.
  - `[EXT-13j] a removal limited to one value stops nothing`
- **EXT-13k** EXT-12k through `fetch`: the declaration arrives, and the platform adds
  `Content-Length: 0` to the `POST`. Status: tested.
  - `[EXT-13k] a declared Content-Type stays on a request with Body.empty, and the platform frames the empty body`
- **EXT-13l** EXT-12l through `fetch`: `multipart/form-data` arrives with no boundary, in both lanes,
  over a body that has one. Without a declaration the client received no `Content-Type`, and the
  platform supplies the boundary. Status: tested.
  - `[EXT-13l] a declared Content-Type replaces the boundary fetch would have supplied`
- **EXT-13m** EXT-12m through `fetch`. Status: tested.
  - `[EXT-13m] Request.mapEffect after the body has the last word`
- **EXT-13n** EXT-12n through `fetch`. Status: tested.
  - `[EXT-13n] Request.mapEffect before the body sees its edit replaced`
  - `[EXT-13n] Request.mapEffect before the body keeps its edit when the request removed that name`
- **EXT-13o** EXT-12o through `fetch`. Status: tested.
  - `[EXT-13o] a later declaration still goes out after a removal`
- **EXT-13p** EXT-12p through `fetch`. The refused request reaches no client, and a caller who left
  the optional field out meets the platform's `Accept: */*`, as in EXT-13b. Status: tested.
  - `[EXT-13p] removing a name a schema always writes, after that schema, is refused before the client receives anything`
  - `[EXT-13p] a removal before a schema never discards what the schema writes`
  - `[EXT-13p] a removal after an optional schema field stays in force when the caller leaves it out, and the platform adds its own`
  - `[EXT-13p] a removal after an optional schema field gives way to a caller's value`
- **EXT-13q** EXT-12q through `fetch`: the client received `3`, Effect's Fetch provider takes it off,
  and the platform writes `Content-Length: 5` over the whole body, in both lanes. Bare `fetch` in
  Node stalls: nothing reaches the socket and nothing fails, so only the caller's own timeout, 500
  milliseconds in the test, ends the request. Bare `fetch` in Chromium writes the true length,
  because `Content-Length` is a forbidden header there. Status: limit.
  - `[EXT-13q] Effect's Fetch provider takes off a Content-Length below the body's, and the platform writes the true one`
  - `[EXT-13q] fetch on its own stalls in Node on a Content-Length below the body's, and Chromium writes the true one`
- **EXT-13r** EXT-12r through `fetch`: the same with `10` through Effect's Fetch provider. Bare
  `fetch` in Node fails as `HttpClientError` with a `TransportError` reason whose cause has the code
  `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`, and the ledger is empty. Bare `fetch` in Chromium writes the
  true length. Status: limit.
  - `[EXT-13r] Effect's Fetch provider takes off a Content-Length above the body's, and the platform writes the true one`
  - `[EXT-13r] fetch on its own refuses a Content-Length above the body's in Node, and Chromium writes the true one`
- **EXT-13s** EXT-12s through `fetch`: Effect's Fetch provider leaves an empty value on, so `fetch`
  sees it. Node refuses it as `HttpClientError` with a `TransportError` reason whose cause has the
  code `UND_ERR_INVALID_ARG`, with an empty ledger. Chromium writes `Content-Length: 5`. Status:
  limit.
  - `[EXT-13s] an empty Content-Length reaches fetch, which Node refuses and Chromium replaces with the true one`
- **EXT-13t** EXT-12t through `fetch`: the client received no `Content-Length`, and the platform
  writes `Content-Length: 5`, in both lanes. A body always goes out framed. Status: limit.
  - `[EXT-13t] removeHeader("content-length") reaches the client with none, and the platform writes the true one`
- **EXT-13u** EXT-12u through `fetch`: no client received an `Accept`, and the platform adds
  `Accept: */*`, as in EXT-13b. Status: limit.
  - `[EXT-13u] client middleware that removes Accept reaches the client with none, and the platform adds its own`

#### Header name spelling

EXT-14 covers how a header name is spelled, as
[#101](https://github.com/viell-dev/slop-effect-schema-http/issues/101) decided: a name keeps the
spelling it was written with, and names compare without case. EXT-14a to EXT-14g go through the raw
client, in `src/scenarios/header-declarations.node.test.ts`, on a `GET`; each `head` also ends with
`accept: text/plain`. EXT-14h and EXT-14i go through `fetch`, in
`src/scenarios/header-declarations.test.ts`, in both lanes.

- **EXT-14a** `Request.setHeader("X-API-Key", "v")`. `head` has `X-API-Key: v`. Status: tested.
  - `[EXT-14a] setHeader keeps the name as written`
- **EXT-14b** `Request.appendHeader("X-Multi", "a")` and `Request.appendHeader("x-multi", "b")`.
  `head` has both lines as written. Status: tested.
  - `[EXT-14b] appendHeader keeps each line as written`
- **EXT-14c** `x-thing: 1`, then `X-Other: 2`, then `Request.setHeader("X-Thing", "3")`. `head` has
  `X-Thing: 3` where the first line was, then `X-Other: 2`. Status: tested.
  - `[EXT-14c] a replacing setHeader matches across spellings, keeps the first position and takes the new spelling`
- **EXT-14d** `Request.setHeader("X-Thing", "1")` and `Request.removeHeader("x-THING")`. `head` has
  no such line. Status: tested.
  - `[EXT-14d] removeHeader matches across spellings`
- **EXT-14e** A header schema with the field `X-API-Key`. `head` has `X-API-Key: v`. Status: tested.
  - `[EXT-14e] a header schema writes the spelling it was given`
- **EXT-14f** A raw `X-API-KEY` under a schema's optional `X-Api-Key`, which the caller leaves out.
  The default goes through the schema, so `head` has `X-Api-Key: v`. Status: tested.
  - `[EXT-14f] a raw default under a schema's name takes the schema's spelling`
- **EXT-14g** Client middleware changing one of two declared fields. It sees the normalized view,
  with lowercase names. `head` keeps `X-Other: 2` as written, and a lowercase `x-thing: 3` replaces
  the line that field had. Status: tested.
  - `[EXT-14g] middleware sees the lowercase view, and a value it changes replaces that field's lines alone`
- **EXT-14h** EXT-14a through `fetch`: the client's lines hold `X-API-Key`, and `x-api-key` arrives,
  because `fetch` receives the normalized view. Status: limit.
  - `[EXT-14h] fetch sends a lowercase name, whatever the client's lines say`
- **EXT-14i** EXT-14b to EXT-14g through `fetch`: the lines a provider reads with
  `Transport.headerLines` are the ones the raw client writes in those entries, in both lanes, and
  `fetch` sends each name in lower case. Only the Node lane can send these lines, so this is where a
  regression in them that touched only browsers would show. Status: tested.
  - `[EXT-14i] the client receives the lines ${declaration} leaves, and fetch sends their names in lower case`
    (`appendHeader`, `a replacing setHeader`, `removeHeader`, `a header schema`,
    `a raw default under a schema`, `middleware`)

#### Queries as written

EXT-15 and EXT-16 are the table of
[#102](https://github.com/viell-dev/slop-effect-schema-http/issues/102), which the design page
repeats under _URLs are made sendable, not normalized_: a query written in the constructor goes out
as written until something edits that entry. The last letter adds its rule that an entry stays
editable by its decoded name. Each row is a `Request.get` of the written text on `origin`, with its
edit. EXT-15a to EXT-15i go through the raw client, in `src/scenarios/written-queries.node.test.ts`,
and each asserts the client's URL and the request line. EXT-16a to EXT-16i go through `fetch`, in
`src/scenarios/written-queries.test.ts`, in both lanes, and each asserts the client's URL and the
target. The letters match. Every row gave the same result at
the client and on the wire, in Node and in Chromium, apart from the line-preserving provider's in
EXT-15c.

- **EXT-15a** `/x?a=1;b=2` goes out as written. Status: tested.
  - `[EXT-15a] the raw client sends /x?a=1;b=2 as /x?a=1;b=2`
- **EXT-15b** `/x?a=1&&b=2` goes out as written. Status: tested.
  - `[EXT-15b] the raw client sends /x?a=1&&b=2 as /x?a=1&&b=2`
- **EXT-15c** `/x?` goes out as written. The line-preserving provider receives it the same way and
  sends `/x`, because it hands `node:http` a parsed `URL`, whose `search` has no place for a `?` with
  nothing after it. That belongs to that provider, so the entry stays tested. Status: tested.
  - `[EXT-15c] the raw client sends /x? as /x?`
  - `[EXT-15c] the line-preserving provider receives /x? as written, and sends /x`
- **EXT-15d** `/x?q=a+b` goes out as written. Status: tested.
  - `[EXT-15d] the raw client sends /x?q=a+b as /x?q=a+b`
- **EXT-15e** `/x?a=%41&wsdl` goes out as written. Status: tested.
  - `[EXT-15e] the raw client sends /x?a=%41&wsdl as /x?a=%41&wsdl`
- **EXT-15f** `/x?a=%41&b=1;2` with `Request.setQuery("a", "new value")` goes out as
  `/x?a=new%20value&b=1;2`: the edited entry is rendered, the other stays as written, and the order
  holds. Status: tested.
  - `[EXT-15f] the raw client sends /x?a=%41&b=1;2 with setQuery("a", "new value") as /x?a=new%20value&b=1;2`
- **EXT-15g** `/x?` with `Request.setQuery("b", "1")` goes out as `/x?b=1`: a lone `?` holds no
  entries. Status: tested.
  - `[EXT-15g] the raw client sends /x? with setQuery("b", "1") as /x?b=1`
- **EXT-15h** `/x?a=1&` with `Request.setQuery("b", "1")` goes out as `/x?a=1&&b=1`: a written empty
  segment is text like any other. Status: tested.
  - `[EXT-15h] the raw client sends /x?a=1& with setQuery("b", "1") as /x?a=1&&b=1`
- **EXT-15i** `/x?a+b=1&c=%32` with `Request.setQuery("a b", "2")` goes out as `/x?a%20b=2&c=%32`: the
  first entry's decoded name is `a b`, so the edit finds it and renders it, and the other entry
  keeps its escape. Status: tested.
  - `[EXT-15i] the raw client sends /x?a+b=1&c=%32 with setQuery("a b", "2") as /x?a%20b=2&c=%32`
- **EXT-16a** EXT-15a through `fetch`. Status: tested.
  - `[EXT-16a] fetch sends /x?a=1;b=2 as /x?a=1;b=2`
- **EXT-16b** EXT-15b through `fetch`. Status: tested.
  - `[EXT-16b] fetch sends /x?a=1&&b=2 as /x?a=1&&b=2`
- **EXT-16c** EXT-15c through `fetch`: the `?` survives the URL parser in both lanes. Status: tested.
  - `[EXT-16c] fetch sends /x? as /x?`
- **EXT-16d** EXT-15d through `fetch`. Status: tested.
  - `[EXT-16d] fetch sends /x?q=a+b as /x?q=a+b`
- **EXT-16e** EXT-15e through `fetch`. Status: tested.
  - `[EXT-16e] fetch sends /x?a=%41&wsdl as /x?a=%41&wsdl`
- **EXT-16f** EXT-15f through `fetch`. Status: tested.
  - `[EXT-16f] fetch sends /x?a=%41&b=1;2 with setQuery("a", "new value") as /x?a=new%20value&b=1;2`
- **EXT-16g** EXT-15g through `fetch`. Status: tested.
  - `[EXT-16g] fetch sends /x? with setQuery("b", "1") as /x?b=1`
- **EXT-16h** EXT-15h through `fetch`. Status: tested.
  - `[EXT-16h] fetch sends /x?a=1& with setQuery("b", "1") as /x?a=1&&b=1`
- **EXT-16i** EXT-15i through `fetch`. Status: tested.
  - `[EXT-16i] fetch sends /x?a+b=1&c=%32 with setQuery("a b", "2") as /x?a%20b=2&c=%32`

#### Raw values under a schema

EXT-17 takes the schema rules of
[#87](https://github.com/viell-dev/slop-effect-schema-http/issues/87) and
[#113](https://github.com/viell-dev/slop-effect-schema-http/issues/113) to a real service, the
business API, in `src/scenarios/schema-groups.test.ts`, in both lanes. The library's own tests state
each rule; these show what a consumer meets at the other end.

- **EXT-17a** A shared default under an optional header:
  `Request.setHeader("Authorization", "Bearer <token>")` under a schema with an optional
  `Authorization`, against `GET /v2/tasks`. With the input `{ headers: {} }` the default arrives and
  the service answers 200. With `Bearer wrong` as input, the caller's value replaces it, it arrives
  as the one line, and the service answers 401. Status: tested.
  - `[EXT-17a] a shared Authorization default under an optional header reaches the service, and a caller's value replaces it`
- **EXT-17b** A raw name no schema allows: `X-Stray` beside that schema, and `?fields=hidden` written
  in the constructor under a query schema. Each is `Request.InvalidRequest` before anything is sent,
  with an empty ledger, and its message names the field and never holds the value. Status: tested.
  - `[EXT-17b] a raw header no schema allows is refused before anything is sent, by its name and never its value`
  - `[EXT-17b] a query entry written in the constructor that no schema allows is refused before anything is sent`
- **EXT-17c** A value in the form the schema writes, against `GET /v1/customers` with `page` under
  `Schema.FiniteFromString`. The caller's `2` and `"02"`, from the two sides of the schema, are the
  same request, `?page=2`, and so is `?page=02` written in the constructor under an optional field.
  Status: tested.
  - `[EXT-17c] a caller's value reaches the service in the form the schema writes, from either side of the schema`
  - `[EXT-17c] a default written in the constructor goes through the schema, which writes its own spelling`

#### Paths, variants and values known late

EXT-18 to EXT-22 take what the library gained after `0.1.0` to real services over real sockets:
paths joined exactly and written as templates
([#82](https://github.com/viell-dev/slop-effect-schema-http/issues/82),
[#80](https://github.com/viell-dev/slop-effect-schema-http/issues/80) and
[#104](https://github.com/viell-dev/slop-effect-schema-http/issues/104)), variants of a definition
([#86](https://github.com/viell-dev/slop-effect-schema-http/issues/86),
[#88](https://github.com/viell-dev/slop-effect-schema-http/issues/88) and
[#105](https://github.com/viell-dev/slop-effect-schema-http/issues/105)), a base URL known late
([#89](https://github.com/viell-dev/slop-effect-schema-http/issues/89) and
[#81](https://github.com/viell-dev/slop-effect-schema-http/issues/81)), the attempt number
([#99](https://github.com/viell-dev/slop-effect-schema-http/issues/99)), and a `Date` in a query
([#110](https://github.com/viell-dev/slop-effect-schema-http/issues/110)). The library's own tests
state each rule; these show what a consumer meets at the other end. They are in
`src/scenarios/path-rules.test.ts`, `variants.test.ts`, `late-base-urls.test.ts`,
`attempt-numbers.test.ts` and `query-dates.test.ts`, in both lanes, and the tests that need the raw
client or the line-preserving provider are in `src/scenarios/path-rules.node.test.ts`. `<id>` below
is a path value declared with `Request.pathValue("id")`.

Node's and Chromium's `fetch` agree on every path below except EXT-18k's. Written dot segments are
EXT-10a, EXT-10b, EXT-11a and EXT-11b, and an empty id at nginx is QRY-3; these entries add what a
value does, and what each service then answers.

- **EXT-18a** A template and a renderer on the wire. `` Request.path`/tasks/${id}` `` with the input
  `{ path: { id: "T-1001" } }`, and a renderer writing the same text with the input `"T-1001"`,
  reach `/v2/tasks/T-1001` and the service answers 200. `a/b c`, `ä`, `100%` and `?q#f` stay one
  segment in both forms, as `a%2Fb%20c`, `%C3%A4`, `100%25` and `%3Fq%23f`. A value under
  `Schema.FiniteFromString` takes `2026` or `"2026.0"`, and the path carries `2026` for both.
  Status: tested.
  - `[EXT-18a] a template and a renderer ask for the same task, and the service answers both`
  - `[EXT-18a] ${value} stays one segment in both forms, and arrives as ${segment}`
  - `[EXT-18a] a value takes either side of its schema, and the path carries what the schema writes`
- **EXT-18b** A child adds to its parent. `` Request.path`/preferences` `` on a parent at
  `/v1/customers/<id>` reads `/v1/customers/1001/preferences`, and the parent still reads the
  customer. Two levels with a value each take one input, `{ path: { year, id } }`.
  `Request.unbind("path")` with `Request.setPath("/tasks/history")` makes a variant of a task's
  history that needs no input and reads the global one. Status: tested.
  - `[EXT-18b] a child adds to its parent, and each reads its own resource`
  - `[EXT-18b] each level adds a value of its own, and one input carries both to the wire`
  - `[EXT-18b] a variant replaces a whole path with Request.unbind and Request.setPath`
- **EXT-18c** Pieces are joined exactly: `/things/42` and `:archive`, `/report` and `.json`,
  `/users` and `42`, `/odata` and `/Customers('O'Brien')`, and `/fetch` and `/https://other.test/x`,
  which stays a path. An apostrophe in a value needs no encoding, so `Customers('${id}')` with
  `O'Brien` closes its quote. A `?` in a template is URL text: `` Request.path`?y=${id}` `` with
  `a b` and `Request.setQuery("z", "1 2")` arrives as `/x?y=a%20b&z=1%202`. A whole URL after an
  empty constructor bypasses a base, and a whole URL in the constructor takes a template. With a
  base URL at `${origin}/soap`, `Request.get("?wsdl")` reaches `/soap?wsdl`, and a template of
  `?wsdl` reaches `/soap/?wsdl`, because the join puts a `/` before it, and the store answers that 404. Status: tested.
  - `[EXT-18c] ${constructor} and ${added} are joined exactly, as ${target}`
  - `[EXT-18c] an apostrophe in a value needs no encoding, so it closes the quote around it`
  - `[EXT-18c] a ? in a template is URL text: a value after it is encoded, and a declared query goes after it`
  - `[EXT-18c] a whole URL after an empty constructor bypasses the base, and one in the constructor takes a template`
  - `[EXT-18c] with a base URL, a query alone belongs in the constructor, because a template gets a / from the join`
- **EXT-18d** A `//` from a constructor's trailing slash and a piece's leading one. The client
  receives it, `fetch` keeps it, and the servers disagree: the `/v2` gateway merges
  `/v2/tasks//T-1001` and answers the task, `/v1/customers//1001` is 404, and the WebDAV view
  answers `/dav//documents/` with 404. Status: tested.
  - `[EXT-18d] a constructor's trailing slash and a piece's leading one give //, which fetch keeps and the /v2 gateway merges`
  - `[EXT-18d] /v1 has no gateway, and answers // with 404`
  - `[EXT-18d] the WebDAV view answers // with 404 too`
- **EXT-18e** Real nginx with a template: `/v2//tasks///` and `${id}//history` arrive as the
  recorded `/v2//tasks///T-1001//history`, and the replayed answer is that task's history. Status:
  tested.
  - `[EXT-18e] real nginx merges the slashes of a template, and answers the task's history`
- **EXT-18f** A trailing slash is kept, and it is part of the address. `/v2/tasks` is the list and
  `/v2/tasks/` is 404. `/dav/documents/` is the WebDAV collection, 207, and `/dav/documents` is 404,
  so a definition that must end in a slash writes it on its last piece. Status: tested.
  - `[EXT-18f] a trailing slash is kept, and the same service answers each spelling differently`
  - `[EXT-18f] the WebDAV collection exists only with its trailing slash, so a template ends in one`
- **EXT-18g** A value of `..` or `.` has nothing to encode, and `fetch` resolves it after the client
  received it as written. `/customers/${id}/regions` with `..` arrives as `/v1/regions`, which is a
  real resource, so the service answers 200 for something the caller did not name. Status: limit.
  - `[EXT-18g] a value of .. leaves the customer: fetch resolves it after the client received it, and /v1/regions answers 200`
  - `[EXT-18g] a value of . disappears: fetch resolves it after the client received it`
- **EXT-18h** Values that look like dot segments and are not: `%2e%2e` is encoded again as
  `%252e%252e`, `../..` as `..%2F..` and `.. ` as `..%20`. Each stays one literal segment, which
  `fetch` leaves alone, and the service answers 404. Status: tested.
  - `[EXT-18h] ${value} is encoded into a literal segment, which fetch leaves alone`
- **EXT-18i** An empty value has nothing to encode either. At the end it leaves `/v2/tasks/`, which
  is 404 and not the list. In the middle it leaves `/v2/tasks//history`, which the `/v2` gateway
  merges into the global history, so the service answers 200 for another resource. Status: tested.
  - `[EXT-18i] an empty value at the end leaves a trailing slash, which is not the list`
  - `[EXT-18i] an empty value in the middle leaves //, which the /v2 gateway merges into another resource`
- **EXT-18j** What stops such a value. A pattern on the value refuses `..` and `""` as a
  `SchemaError`, and a replaced `UrlEncoding.path` refuses `..` as `Request.InvalidRequest`, each
  with an empty ledger. Status: tested.
  - `[EXT-18j] a schema on the value refuses .. and an empty value before anything is sent`
  - `[EXT-18j] a replaced path encoder refuses .. for every value at once, as Request.InvalidRequest with nothing sent`
- **EXT-18k** A label left in the constructor of a whole-URL renderer, as
  `Request.get("{location}")`, which the library used to discard: the URL becomes
  `{location}http://…` and the backend's ledger is empty. Node refuses it with an `InvalidUrl`
  reason. Chromium reads it as a relative URL and asks the page's own server, so the operation
  answers with no error and nothing says the service was never asked. Asserted per lane. Status:
  limit.
  - `[EXT-18k] a label left in the constructor of a whole-URL renderer reaches nothing: Node refuses it, and Chromium asks the page's own origin`
- **EXT-18l** A definition still written the old way, `Request.get("tasks")` with a renderer
  returning `tasks/<id>`, compiles and asks for `/v2/taskstasks/T-1001`. Its declared 404 then reads
  as an ordinary `NotFound` answer, with no failure anywhere. Status: tested.
  - `[EXT-18l] a definition still written the old way asks for the wrong URL, and a declared 404 reads as an ordinary answer`
- **EXT-18m** A value of `..` past `fetch`, in the Node lane: the raw client sends
  `/v1/customers/../regions` as written and the service answers 404, and the line-preserving
  provider resolves it as `fetch` does, because it reads the URL `HttpClient.make` parsed. Status:
  tested.
  - `[EXT-18m] the raw client sends a value of .. as written, and the service answers 404, not its regions`
  - `[EXT-18m] the line-preserving provider resolves a value of .. as fetch does, because it reads the parsed URL`
- **EXT-18n** What a piece adds after a `#` stays in the fragment, through the raw client:
  `/cgi-bin/help.cgi`, then `/accounts#clo`, then `sing`. The client received the `hash` `closing`,
  the target is `<help>#closing`, and the answer is that section. Status: tested.
  - `[EXT-18n] what a piece adds after a # stays in the fragment, and help.cgi answers that section`
- **EXT-19a** A variant's request and options, with the original unchanged. `Operation.mapRequest`
  adds `status=done` to the task list: the targets are `/v2/tasks`, `/v2/tasks?status=done`,
  `/v2/tasks`, and the counts 2, 1, 2. `Operation.mapOptions` gives a variant a retry policy that
  gets past a real 420, which the original still fails on. Status: tested.
  - `[EXT-19a] a request variant sends its own query, and the definition it came from still sends none`
  - `[EXT-19a] an options variant retries a real 420, and the definition it came from does not`
- **EXT-19b** The automatic `Accept` follows the cases. `Response.replace(200, Body.text)` sends
  `text/plain` and the original still sends `application/json`, through each provider of the lane.
  `Response.remove(404)` takes `text/plain` out of `application/json, text/plain`. Status: tested.
  - `[EXT-19b] ${provider}: the automatic Accept follows a replaced case, and the definition keeps its own`
  - `[EXT-19b] the automatic Accept loses what a removed case declared`
- **EXT-19c** A removed case: `Response.remove(404)` turns the service's 404 into
  `Response.UnexpectedResponse`, the original still decodes it as `NotFound`, and the variant still
  reads a task that exists. Status: tested.
  - `[EXT-19c] a removed 404 falls through to UnexpectedResponse, and the definition still decodes it`
- **EXT-19d** A recorded step stays outside the attempts. It runs once after three real attempts. A
  failure from it comes back as itself, and a policy that retries failures sends one request. A
  classifier of `() => true` also repeats a real 200, because a completed response is an outcome
  too, so four requests go out and the step runs once, on the last. A slow step is not under the
  attempt timeout. Attempts that time out never reach it. A request variant of a mapped operation
  keeps it. Status: tested.
  - `[EXT-19d] a recorded step runs once after three real attempts`
  - `[EXT-19d] a failing step comes back as itself, and a policy that retries failures sends one request`
  - `[EXT-19d] a classifier that retries every outcome repeats a real 200, and the step runs once, on the last`
  - `[EXT-19d] a slow step is not under the attempt timeout, which the attempt itself met in time`
  - `[EXT-19d] attempts that time out never reach the step, and fail as a timeout`
  - `[EXT-19d] a request variant of a mapped operation keeps the step, and sends its own request`
- **EXT-19e** `Operation.unmap` gives the response's own value back, and the mapped operation keeps
  its step. A response that does not fit a mapping goes through it, and that response's `Accept`
  reaches the wire. A 404 turned into a failure stays one when that case is replaced by one of the
  same shape. Status: tested.
  - `[EXT-19e] Operation.unmap gives the response's own value back, and the mapped operation keeps its step`
  - `[EXT-19e] a response that does not fit a mapping goes through Operation.unmap, and its Accept reaches the wire`
  - `[EXT-19e] a 404 turned into a failure stays one when that case is replaced by one of the same shape`
- **EXT-20a** A location from a service or a `Config` value, supplied when the program runs. A
  missing `Config` value fails as a `ConfigError` with nothing sent, and leaving the service out is
  a compile error. Status: tested.
  - `[EXT-20a] a service supplies the location when the program runs, and the definition stays a plain value`
  - `[EXT-20a] a Config value supplies it the same way`
  - `[EXT-20a] forgetting the location is a compile error` (type-level)
- **EXT-20b** A lookup that fails comes back as its own typed failure with an empty ledger, and a
  policy that retries everything does not repeat it. It stops a request with an absolute URL too,
  though the join would bypass it. Status: tested.
  - `[EXT-20b] a lookup that fails comes back as itself: nothing is sent, and a policy does not repeat it`
  - `[EXT-20b] a lookup that fails stops a request with an absolute URL too, though the join would bypass it`
- **EXT-20c** A lookup that hangs is not under `attemptTimeout`: with a 50 ms limit it is still
  running after 400 ms. Only the caller's limit ends it, which interrupts the lookup, and nothing is
  sent. Status: tested.
  - `[EXT-20c] a lookup that hangs is not under the attempt timeout, and only the caller's limit ends it`
  - `[EXT-20c] a caller's Effect.timeout turns a hanging lookup into a timeout, with nothing sent`
- **EXT-20d** A lookup runs once for three real attempts, all to the same base, and again for the
  next evaluation. Input the schema refuses costs no lookup. Status: tested.
  - `[EXT-20d] a lookup runs once for three real attempts, and again for the next evaluation`
  - `[EXT-20d] input the schema refuses costs no lookup`
- **EXT-20e** `Request.mapBaseUrl` extends a base given as text, leaving the request it came from as
  it was, and a base that is not known yet. With no base set it receives `""` and can supply one. A
  function that throws is `Request.InvalidRequest` with an empty ledger. A later `Request.baseUrl`
  replaces what it made, and a lookup behind that never runs. Status: tested.
  - `[EXT-20e] Request.mapBaseUrl extends a base given as text, and the request it came from keeps its own`
  - `[EXT-20e] Request.mapBaseUrl extends a base that is not known yet, at the moment it is`
  - `[EXT-20e] with no base set, Request.mapBaseUrl receives the empty text and can supply one`
  - `[EXT-20e] a Request.mapBaseUrl function that throws is Request.InvalidRequest, with nothing sent`
  - `[EXT-20e] a later Request.baseUrl replaces what Request.mapBaseUrl made, and a lookup behind it never runs`
- **EXT-21a** `transformClient` writes its attempt number into a header, so the number asserted is
  the one that arrived: `1`, `2` and `3` across a real 420, 503 and 200, through each provider of
  the lane, and `1` again for the next evaluation. Status: tested.
  - `[EXT-21a] ${provider}: three real attempts arrive numbered 1, 2 and 3, and the next evaluation starts at 1`
- **EXT-21b** An attempt that timed out counts. A server holds the first attempt past its timeout,
  and the second arrives at a standby numbered `2`. The witness is the attempt that was answered,
  because a request aborted by a timeout need not have reached the socket. Status: tested.
  - `[EXT-21b] an attempt that timed out counts, so the one after it arrives numbered 2`
- **EXT-21c** A retry moves to another server by its number, as a base URL cannot: the first attempt
  meets a closed port, and the second arrives at the standby. Status: tested.
  - `[EXT-21c] a retry moves off a dead server by its number, which a base URL cannot do`
- **EXT-21d** A function with an optional second parameter of its own receives the number there:
  passed as it is it writes `1`, and wrapped in an arrow function it keeps its default. Status:
  tested.
  - `[EXT-21d] a function with an optional second parameter of its own receives the number there`
- **EXT-22a** A `Date` in a query arrives as `?since=2026-11-07T12%3A30%3A45.678Z`, with `:` as
  `%3A`, by every route: `Schema.Date` through each provider of the lane, `Schema.DateFromString`
  from a `Date` or its text, `Schema.DateTimeUtcFromDate` from its type or a `Date`, and a raw
  `Date` in the object form. A list repeats the name in order, from a schema and from a raw array.
  Status: tested.
  - `[EXT-22a] ${provider}: Schema.Date takes a Date and sends ISO text`
  - `[EXT-22a] a list of Dates repeats the name, in order`
  - `[EXT-22a] Schema.DateFromString takes a Date or its text, and sends the same`
  - `[EXT-22a] a schema from Date to an application's type takes that type or a Date, and sends the same`
  - `[EXT-22a] a raw Date in the object form sends the same`
- **EXT-22b** An invalid `Date` is a `SchemaError` with an empty ledger under each of the three
  schemas, and a raw one has no ISO text and arrives as `?since=Invalid%20Date`. Status: tested.
  - `[EXT-22b] an invalid Date under ${name} is a SchemaError, with nothing sent`
  - `[EXT-22b] a raw invalid Date has no ISO text, and goes out as Invalid Date`
- **EXT-22c** When a raw date is read. A `Date` in the object form is read when the request is
  defined, so changing it later changes nothing. A computation is read on each evaluation, whether
  it returns text or a `Date`, and a `Date` goes out as ISO text. Status: tested.
  - `[EXT-22c] a raw Date is read when the request is defined, so changing it later changes nothing`
  - `[EXT-22c] a computation is read on each evaluation, so its text reaches the next request`
  - `[EXT-22c] a computation that returns a Date goes out as ISO text, read on each evaluation`
- **EXT-22d** A raw `Date` under each of the three schemas is a default, which the schema writes and
  a caller's value replaces. Status: tested.
  - `[EXT-22d] a raw Date under ${name} is a default, which the schema writes and a caller's value replaces`
- **EXT-22e** Written text is not a `Date`: `?since=2026-11-07T13:30:45+01:00` in the constructor
  goes out as written, and the same text as a caller's value under `Schema.DateFromString` goes out
  in UTC. Status: tested.
  - `[EXT-22e] an offset in written text stays as written, and only a Date is rewritten to UTC`

### Failures on the wire

EXT-23 to EXT-28 cover what goes wrong once a request has left: answers that fail after their
headers, writes whose outcome nobody knows, redirect chains that carry state, failures that threaten
the calls after them, response metadata no server should send, and a client that finds its API at
runtime. They all run against the regional booking service, `bookings`, documented in
[services/bookings.md](./services/bookings.md), and a backend writes these answers with the raw
replies [AGENTS.md](./AGENTS.md) describes. The consumer is `src/clients/bookings/`, and the
scenarios are in `src/scenarios/`, in `wire-failures.test.ts`, `ambiguous-writes.test.ts`,
`redirect-chains.test.ts`, `later-calls.test.ts`, `response-metadata.test.ts` and
`discovery.test.ts`, with a `.browser.test.ts` or a `.node.test.ts` beside one of them for what needs
that lane. They run in both lanes unless an entry says otherwise. EXT-29 is the backend side's own
check of `bookings`.

Each entry separates two things, because a failure here can be either:

- **Library** is what the library's [design](https://github.com/viell-dev/slop-effect-schema-http/blob/main/docs/design.md)
  and [limits](https://github.com/viell-dev/slop-effect-schema-http/blob/main/docs/limits.md) pages
  promise. A test that finds otherwise has found a suspected defect, and follows the Mismatches rule
  in [AGENTS.md](./AGENTS.md).
- **Provider** is what a client or a platform did. It is not the library's to change, and a test
  pins it for each lane. Do not carry a result from one lane to the other, or from `fetch` to
  `lines`.

The results under Provider were measured on 2026-11-07 through `bookings` and its consumer, with the
library at the commit in `library-ref`, Effect 4.1.2, Node.js 24.22.2 and Chromium 158, and the tests
each entry names keep them under test. A test asserts what its lane really gives; where that differs
from an entry, find out why before changing either. `src/harness/raw-replies.test.ts` keeps the same
answers under test against bare `fetch`, through the harness's own fixture.

This table is what each kind of answer does to each client. `DecodeError` means
`Response.DecodeError` whose cause is an `HttpClientError` with a `DecodeError` reason, and
`TransportError` means an `HttpClientError` with that reason. "Retried" is `Policy.transient`'s
verdict, seen as a second arrival.

| Answer                                      | `fetch` in Node              | `lines`                   | `fetch` in Chromium                         | Through the same-origin proxy |
| ------------------------------------------- | ---------------------------- | ------------------------- | ------------------------------------------- | ----------------------------- |
| No answer: `closed`, `reset`                | `TransportError`, retried    | The same                  | The same, sent twice on a reused connection | A 502 from the proxy          |
| A cut head: `cut-head`                      | `TransportError`, retried    | The same                  | A 200 with an empty body                    | A 502 from the proxy          |
| A cut body: `cut-body`, `cut-chunked`       | `DecodeError`, not retried   | `TransportError`, retried | `DecodeError`, not retried                  | As Chromium                   |
| A malformed chunk: `bad-chunk`              | `DecodeError`, not retried   | `TransportError`, retried | `DecodeError`, not retried                  | As Chromium                   |
| A body with no framing, cut: `cut-unframed` | Success, with half the body  | The same                  | The same                                    | The same                      |
| `gzip`                                      | The text                     | The stream, as text       | The text                                    | As Chromium                   |
| `gzip-magic`, `gzip-block`                  | `DecodeError`, not retried   | The stream, as text       | `DecodeError`, not retried                  | As Chromium                   |
| `gzip-checksum`                             | `DecodeError`, not retried   | The stream, as text       | The text, with no failure                   | As Chromium                   |
| `gzip-truncated`                            | Part of the text, no failure | The stream, as text       | Part of the text, no failure                | As Chromium                   |
| `gzip-trailer`                              | The text, with no failure    | The stream, as text       | The text, with no failure                   | As Chromium                   |
| `trickle`, `hang`, under an attempt timeout | `TimeoutError`, retried      | The same                  | The same                                    | The same                      |

What a browser cannot show, whichever answer it meets:

- **Why a body failed.** Every failed body is `Failed to fetch`, with no cause, so a page cannot tell
  a cut answer from a bad chunk or a damaged stream. Node's causes name each one.
- **The bytes of a compressed answer.** The browser decompresses before a page sees anything, and it
  checks neither the CRC nor that a stream ended, so `gzip-checksum` and `gzip-truncated` are not
  failures at all.
- **A request sent twice.** On a reused connection, Chromium sends a request again by itself when
  the connection ends before any response, a POST included, so one library attempt can arrive twice.
  A preflight is enough to warm that connection. Only the ledger shows it, in the two arrivals and
  their different `connection` numbers. A backend behind the socket listener closes every connection
  after one request, so no connection is reused and this stops; that is the control. Node's clients
  do not do this: a POST lost on a connection already used arrives once, through `fetch` and `lines`.
- **A head of its own.** Harness CORS writes its lines straight after a raw head's status line, or a
  page could read nothing at all of a raw reply. A cut or malformed head therefore reaches a page
  with CORS lines a real one would not have, and the same answer under `{ cors: "backend" }` is a
  `TransportError`. A body's bytes are unaffected. Under `{ cors: "backend" }`, `cut-body` keeps the
  filter's lines, so a page fails it at the body, and only what the edge writes for itself is a CORS
  refusal.
- **Headers the filter does not expose.** With no `Access-Control-Expose-Headers`, a page under the
  region's own CORS cannot read `Location`, `Idempotent-Replay` or `Retry-After`, so it tells a
  replay from a commit only by the booking's `replayed`.
- **A failure through the same-origin proxy.** The proxy is `node:http` on both sides, so it reads an
  answer before a page does and frames it again. An answer that fails before its head is complete,
  or whose head `node:http` refuses, is a `502` with the proxy's text, which a page reads as an
  ordinary response, and a chunk is not passed on as it arrived.
- **Whether the server saw the abort.** A timeout or an interruption reaches a backend as a closed
  socket, some time later, so read the ledger in a bounded loop until `aborted` and `connectionOpen`
  show it.

`lines` reads a whole response before it hands one over, so a body failure reaches the library at
dispatch, as a transport failure, with no response metadata. That is the difference between its
column and `fetch`'s: not a difference in what went wrong.

The suite's backends are plain HTTP, so none of this covers TLS: a bad certificate, or a connection
cut during a handshake. [#97](https://github.com/viell-dev/slop-effect-schema-http/issues/97) saw a
bad certificate fail as a `TransportError` on Node.js, outside the suite.

The timeouts below are sized for a slow runner: a request aborted before it arrived leaves nothing
in a ledger, and an answer that has to finish has to fit inside its attempt. The answers these tests
time out never finish, so a longer limit changes nothing else.

#### Failures after response headers arrive

Unless an entry says otherwise, `bookings` starts with one `edge` rule on `GET /v1/manifest` with
`times: 1`, and the operation is that `GET` with `Response.status(200, Body.text)`. Each test runs
through every provider of the lane, in two parts:

1. With `Policy.none`, it asserts the failure by its tag, its reason and any `metadata`.
2. With a new region and `Policy.make(Schedule.recurs(1))`, it asserts the classification from the
   ledger: two arrivals and the whole manifest if `Policy.transient` retries, or one arrival and the
   same failure if it does not.

After either part it reads the ledger until the failed arrival shows `connectionOpen` false, and
then a further call on the same client gets the whole manifest, with its own arrival on a new
connection. A gzip fault is the exception: its framing is whole, so even a stream that cannot be read
leaves the connection open, in both lanes and through every provider, and the further call reuses
it. The manifest's text comes from its rule on the service page, written out by the test.

The library promises the same thing throughout, so entries do not repeat it: a value reaches the
caller only from a body the decoder could read, no live response crosses a failure, the attempt's
scope closes before its outcome is classified, and `Policy.transient` retries timeouts, transport
errors and the statuses 408, 429, 500, 502, 503 and 504.

- **EXT-23a** `cut-body`: 450 of 900 bytes under `Content-Length`, then an orderly close. Provider:
  `fetch` hands the response over at its head, so the failure is a `DecodeError` with status 200 in
  its `metadata`, not retried, in both lanes (Node's cause is `terminated`, then `other side closed`;
  Chromium's is `Failed to fetch`). `lines` is a `TransportError` with the cause `aborted` and no
  metadata, retried. The same failure on the wire gets opposite verdicts, because `Policy.transient`
  reads a transport error and not a failed body. Under `{ cors: "backend" }` a page gets the same
  `DecodeError`, because this head keeps the filter's lines. Status: tested.
  - `[EXT-23a] ${provider}: cut-body stops at 450 of 900 bytes and is a DecodeError at the body, not retried` (`fetch`)
  - `[EXT-23a] ${provider}: cut-body stops at 450 of 900 bytes and is a TransportError before any response, retried` (`lines`)
  - `[EXT-23a] under the region's own CORS cut-body keeps the filter's lines, so it is a failed body and not a CORS refusal` (Chromium)
  - `[EXT-23a] through the same-origin proxy cut-body fails at the body as it does for a page reaching the region directly` (Chromium)
- **EXT-23b** `cut-body-reset`: EXT-23a ended by a reset. Provider: as EXT-23a, with Node's cause
  `read ECONNRESET`, under `terminated` through `fetch` and alone through `lines`. A reset can
  overtake bytes a client has not read yet, and the page's 50 ms does not cover a heavily loaded
  machine, where Chromium met it first with twice as many busy processes as cores. A client that
  meets it first has seen no answer, so the result is EXT-23f's: Chromium sends the request again and
  gets the manifest, and Node's `fetch` is a `TransportError`, retried. The test accepts those two
  orders and no others, with a ledger that agrees. Status: tested.
  - `[EXT-23b] ${provider}: a reset after half the body fails as cut-body does, unless it overtakes the bytes`
- **EXT-23c** `cut-chunked`: one chunk and no last chunk. Provider: as EXT-23a. Status: tested.
  - `[EXT-23c] ${provider}: a chunk with no last chunk fails as cut-body does`
  - `[EXT-23c] through the same-origin proxy cut-chunked fails at the body as it does for a page reaching the region directly` (Chromium)
- **EXT-23d** `bad-chunk`: a chunk followed by `XX`. Provider: as EXT-23a, with Node's cause naming
  the parser's refusal, `Expected LF after chunk data`, in the words of each client: under
  `terminated` as `Response does not match the HTTP/1.1 protocol (…)` through `fetch`, and as
  `Parse Error: …` through `lines`. Status: tested.
  - `[EXT-23d] ${provider}: a chunk followed by XX fails as cut-body does, with the parser's refusal in Node`
  - `[EXT-23d] through the same-origin proxy bad-chunk fails at the body as it does for a page reaching the region directly` (Chromium)
- **EXT-23e** `cut-head`: a status line and part of a header name, then an orderly close. Provider:
  in Node, a `TransportError` with no metadata, retried, through both providers (`fetch failed`, then
  `other side closed`; `socket hang up` through `lines`). Chromium takes the cut head for a complete
  one, so under harness CORS `Body.text` gives the empty string with no failure, one arrival; under
  `{ cors: "backend" }` the same answer is a `TransportError`, retried, because no CORS line arrived.
  Status: tested.
  - `[EXT-23e] ${provider}: a cut head is a TransportError with no metadata, retried` (Node)
  - `[EXT-23e] ${provider}: Chromium takes a cut head under harness CORS for a complete one, an empty body with no failure` (Chromium)
  - `[EXT-23e] under the region's own CORS a cut head is a TransportError, because no CORS line arrived, and it is retried` (Chromium)
  - `[EXT-23e] through the same-origin proxy cut-head is a 502 from the proxy, an ordinary response a retry repeats` (Chromium)
- **EXT-23f** `closed` and `reset`: no answer at all to a read. Provider: `TransportError` with no
  metadata, retried, through every provider. In Chromium the first `GET` follows a preflight on the
  same connection, so the browser sends it again by itself: with `times: 1` the second sending gets
  the manifest and the library sees a success, with two arrivals and no failure, and it takes
  `times: 2` to see the `TransportError`, with two arrivals, after which one retry is a third.
  Status: tested.
  - `[EXT-23f] ${provider}: ${fault} is a TransportError with no metadata, retried` (Node)
  - `[EXT-23f] ${provider}: ${fault} on one GET is hidden, because Chromium sends it again on a new connection and the library sees a success` (Chromium)
  - `[EXT-23f] ${provider}: it takes ${fault} twice for a page to see a TransportError, and one retry then gets the manifest` (Chromium)
  - `[EXT-23f] through the same-origin proxy ${fault} is a 502 from the proxy, an ordinary response a retry repeats` (Chromium)
- **EXT-23g** `cut-unframed`: half the manifest with no length, then an orderly close. No client can
  tell this from a whole answer, which is why it is here: the control for EXT-23a. Provider: every
  provider gives 450 bytes of text as a success, with one arrival. A decoder that needs the whole
  document has to check for itself, so a test also runs it through a consumer check that counts 100
  lines and fails as a `DecodeError`, not retried. Status: limit.
  - `[EXT-23g] ${provider}: an answer with no framing that stops half-way is a success holding 450 bytes`
  - `[EXT-23g] ${provider}: only the consumer's own check of the lines finds it, as a DecodeError, not retried`
  - `[EXT-23g] through the same-origin proxy an answer with no framing that stops half-way is still a success` (Chromium)
  - `[EXT-23g] the manifest check refuses a cut, a short count and a stray line`
- **EXT-23h** `gzip`: a valid stream, the control for EXT-23i to EXT-23k. Provider: `fetch` gives the
  manifest in both lanes. `lines` asks for nothing and decompresses nothing, so `Body.text` gives the
  stream read as text with no failure, and `Body.bytes` gives bytes starting 1F 8B. A provider that
  needs the text has to decompress it itself, as a test does with `DecompressionStream`. Status:
  tested.
  - `[EXT-23h] ${provider}: a valid gzip stream gives the manifest` (`fetch`)
  - `[EXT-23h] ${provider}: asks for nothing and decompresses nothing, so Body.text is the stream read as text` (`lines`)
  - `[EXT-23h] ${provider}: Body.bytes is the stream itself, which the consumer can decompress` (`lines`)
  - `[EXT-23h] through the same-origin proxy gzip gives the manifest, as it does for a page` (Chromium)
- **EXT-23i** `gzip-magic` and `gzip-block`: a stream that is not gzip, and one whose first block
  cannot be read. Provider: `fetch` is a `DecodeError`, not retried, with Node's cause
  `incorrect header check` or `invalid block type` under `terminated`, and the connection stays open
  for the next call. `lines`: as EXT-23h, a success holding the stream. Status: tested.
  - `[EXT-23i] ${provider}: ${fault} is a DecodeError, not retried, with Node's cause naming it` (`fetch`)
  - `[EXT-23i] ${provider}: ${fault} is a success holding the stream` (`lines`)
  - `[EXT-23i] through the same-origin proxy ${fault} fails at the body as it does for a page reaching the region directly` (Chromium)
- **EXT-23j** `gzip-checksum`: all of the text, and a wrong CRC. Provider: Node's `fetch` is a
  `DecodeError` with the cause `incorrect data check`, and the connection stays open. Chromium never
  checks, so it gives the manifest with no failure. `lines`: as EXT-23h. Status: limit.
  - `[EXT-23j] ${provider}: gzip-checksum is a DecodeError in Node, with the cause incorrect data check` (`fetch` in Node)
  - `[EXT-23j] ${provider}: Chromium never checks the CRC, so gzip-checksum gives the manifest with no failure` (Chromium)
  - `[EXT-23j] ${provider}: gzip-checksum is a success holding the stream` (`lines`)
  - `[EXT-23j] through the same-origin proxy gzip-checksum gives the manifest, as it does for a page` (Chromium)
- **EXT-23k** `gzip-truncated` and `gzip-trailer`: a stream that stops, under framing that says it is
  whole. Provider: neither `fetch` checks that a stream ended, so `gzip-trailer` gives the manifest
  with no failure, and `gzip-truncated` gives the start of the manifest as a success, shorter than
  900 bytes, in both lanes (349 bytes when measured). Assert that it is a proper prefix, not its
  length, which depends on zlib. `lines`: as EXT-23h. Status: limit.
  - `[EXT-23k] ${provider}: gzip-trailer gives the manifest with no failure, because nothing checks that a stream ended` (`fetch`)
  - `[EXT-23k] ${provider}: gzip-truncated gives a proper prefix of the manifest as a success` (`fetch`)
  - `[EXT-23k] ${provider}: ${fault} is a success holding the stream` (`lines`)
  - `[EXT-23k] through the same-origin proxy gzip-trailer gives the manifest, as it does for a page` (Chromium)
  - `[EXT-23k] through the same-origin proxy gzip-truncated gives part of the manifest as a success` (Chromium)
- **EXT-23l** `trickle`, with no `times`, under `attemptTimeout: "1 second"` and under a caller's
  `Effect.timeout`. Library: an attempt timeout covers the body too, a timed-out attempt is
  transient, and a caller's limit is not retried. Each attempt's arrival ends with `aborted` true and
  `connectionOpen` false. With `Policy.make(Schedule.recurs(1), { attemptTimeout: "1 second" })`
  there are two arrivals on two connections, then a `TimeoutError`; a caller's timeout has one
  arrival. A `while` classifier that records `Reason.metadata` sees status 200 through `fetch`,
  because the head arrived, and none through `lines`, which is still reading. A `Fetch` of the test's
  own shows the request's signal already aborted when that classifier runs. Every manifest answer
  trickles under this rule, so the further call reads `GET /v1/health`. Status: tested.
  - `[EXT-23l] ${provider}: trickle under an attempt timeout is a TimeoutError on two connections, and a classifier sees ${seen}`
  - `[EXT-23l] ${provider}: a caller's Effect.timeout around trickle is not retried`
  - `[EXT-23l] ${provider}: an attempt's request is already aborted when its outcome is classified` (`fetch`)
  - `[EXT-23l] through the same-origin proxy trickle under an attempt timeout is a TimeoutError` (Chromium)
- **EXT-23m** `hang`: EXT-23l with no head at all, so the classifier sees no metadata through any
  provider. Status: tested.
  - `[EXT-23m] ${provider}: hang under an attempt timeout is a TimeoutError on two connections, and a classifier sees no metadata`
  - `[EXT-23m] ${provider}: a caller's Effect.timeout around hang is not retried`
  - `[EXT-23m] through the same-origin proxy hang under an attempt timeout is a TimeoutError` (Chromium)
- **EXT-23n** A cut body on a status the contract does not declare: `cut-body` on
  `GET /v1/bookings/missing`, whose 404 is not in a contract of `Response.status(200, Body.text)`.
  Library: an unmatched body is drained, and a drain that fails is a `Response.DecodeError`, with
  status 404 in its `metadata`, not an `UnexpectedResponse`. Provider: `lines` has read the body
  before the library selects anything, so it is a `TransportError` as in EXT-23a, and its retry gets
  the whole 404 as an `UnexpectedResponse`. Status: tested.
  - `[EXT-23n] ${provider}: a cut body on a status the contract does not declare fails the drain, a DecodeError with status 404` (`fetch`)
  - `[EXT-23n] ${provider}: a cut body on a status the contract does not declare is a TransportError, because the body was read before anything was selected` (`lines`)
- **EXT-23o** A cut body on a transient status: `cut-unavailable`, a 503 that stops half-way, under a
  contract that declares it, with `retryAfter: false` in the policy, because its head says
  `Retry-After: 60`. Library: `Policy.transient` reads the status from the `metadata` of a failure
  too, so through `fetch` this `DecodeError` is retried where EXT-23a's is not. Two arrivals, and the
  second gets the manifest. Provider: under `{ cors: "backend" }` this head has no CORS lines, so a
  page gets a `TransportError` with no status, which is retried all the same. Status: tested.
  - `[EXT-23o] ${provider}: a 503 cut half-way is a DecodeError that Policy.transient retries by the status in its metadata, and the retry gets the manifest` (`fetch`)
  - `[EXT-23o] ${provider}: a 503 cut half-way is a TransportError, retried, and the retry gets the manifest` (`lines`)
  - `[EXT-23o] under the region's own CORS a cut 503 has no CORS lines, so a page gets a TransportError with no status, retried all the same` (Chromium)
- **EXT-23p** A body that never ends on an undeclared status: `trickle` on
  `GET /v1/bookings/missing`, with no `times`. Library: draining holds the attempt open, as the limits
  page warns, so only `attemptTimeout` or the caller's limit ends it, as a `TimeoutError`. Status:
  tested.
  - `[EXT-23p] ${provider}: a body that never ends on an undeclared status holds the attempt until its timeout`
  - `[EXT-23p] ${provider}: so does a caller's limit`

#### Ambiguous completion of writes

A write that loses its answer is the case the library cannot resolve: its design says a transport
error does not prove nothing was applied. These entries pin what really happens, on the server,
rather than assuming either way.

The operation books one slot with `POST /v1/bookings` and the body from the service page, under a
contract that declares 201 and 200 as the same booking. Two regions are `eu` and `us`, each started
by the test. Each test reads the ledger's `POST` arrivals and `GET /v1/bookings` on both regions, the
second through `lane.fetchClient`, and asserts both: the ledger says what arrived, and the list says
what was committed. Where a test moves a write, `transformClient` uses its attempt number to replace
the origin, as EXT-21c does, and stamps the number in `X-Attempt`.

Library, throughout: a request is prepared once per evaluation, so each attempt carries the same
body and the same computed headers; `Policy.transient` does not look at the method; and a transport
error says nothing about whether the server acted.

In Chromium a rule on a lost `POST` meets the browser's own second sending first, so an entry here
states the policy's result behind the socket listener, in either lane, where no connection is
reused, and what Chromium makes of the same rule on a reused connection.

- **EXT-24a** Committed, then nothing: `{ "route": "POST /v1/bookings", "fault": "closed" }` with
  `Policy.none`. In Node, through each provider, a `TransportError`, one arrival and one booking: the
  write happened and the caller was told it failed. That holds on a connection already used too.
  Provider: in Chromium, two arrivals on two connections, with the same body and the same `X-Attempt`,
  two bookings and one `TransportError`, from one attempt. Behind the socket listener, in either
  lane, one arrival and one booking. Under `{ cors: "backend" }` the region's own preflight warms the
  connection in the same way. Status: tested.
  - `[EXT-24a] ${provider}: the write happened and the caller was told it failed: one arrival, one booking and a TransportError` (Node)
  - `[EXT-24a] ${provider}: on a connection already used it stays one arrival, because Node's clients do not send a request again` (Node)
  - `[EXT-24a] ${provider}: Chromium sends a lost POST twice on two connections, so one attempt makes two bookings and one TransportError` (Chromium)
  - `[EXT-24a] ${provider}: behind the socket listener no connection is reused, so one arrival and one booking`
  - `[EXT-24a] under the region's own CORS a preflight warms the connection too, so a lost POST arrives twice` (Chromium)
  - `[EXT-24a] ${provider}: a commit says where its booking is, and reading that gives the same booking`
  - `[EXT-24a] the page's own examples round-trip through their schemas`
  - `[EXT-24a] a draft needs three non-empty strings`
  - `[EXT-24a] a booking without a key says null, and anything else must be a key`
- **EXT-24b** The same with `times: 1` in Chromium: the browser's own second sending gets a 201, so
  the library reports a success for `eu-000002` while `eu-000001` also exists. Nothing tells the
  caller, and `Policy.none` does not stop it, because the library made one attempt. Behind the socket
  listener the same rule reaches the caller as a `TransportError` with one booking. Chromium only;
  Node's result is EXT-24a's. Status: limit.
  - `[EXT-24b] the browser's own second sending gets a 201, so the library reports a success while an earlier booking also exists` (Chromium)
  - `[EXT-24b] behind the socket listener nothing is reused, so the same rule reaches the caller as a TransportError with one booking` (Chromium)
- **EXT-24c** The control for EXT-24a: `phase: "before"`. The caller sees the same failure, and
  nothing is committed. The ledger shows the arrival, two of them in Chromium, and `GET /v1/bookings`
  shows no booking, so the failure alone cannot tell the two apart. Status: tested.
  - `[EXT-24c] ${provider}: with the fault before the region the caller sees the same failure, and nothing is committed`
- **EXT-24d** A retry on the same region with no key: `times: 1`, `Policy.make(Schedule.recurs(1))`.
  Two bookings with two ids and the same fields, and the caller sees the second as a success. The
  second arrival carries the first's body and is stamped `2`. Provider: on a reused connection in
  Chromium the browser's own second sending takes the 201, so the policy never retries: the same two
  bookings, with both arrivals stamped `1`. Status: tested.
  - `[EXT-24d] ${provider}: a retry with no key makes two bookings with two ids and the same fields, and the caller sees the second as a success` (behind the socket listener)
  - `[EXT-24d] ${provider}: Chromium's own second sending gets the 201, so the policy never retries and two bookings exist` (Chromium)
  - `[EXT-24d] an id is a region, a hyphen and six digits`
- **EXT-24e** A retry that moves to another region with no key. `eu` has the fault, and the second
  attempt goes to `us`. One arrival and one booking at each, numbered `1` and `2` in `X-Attempt`, so
  the first server did not "do nothing". Provider: on a reused connection Chromium commits twice at
  `eu` before the attempt fails and moves. Status: tested.
  - `[EXT-24e] ${provider}: a retry that moves region with no key leaves a booking at each, so the first server did not do nothing` (behind the socket listener)
  - `[EXT-24e] ${provider}: on a reused connection Chromium commits twice at the first region before the attempt fails and moves` (Chromium)
- **EXT-24f** A retry on the same region with a repeat key, computed as a request field. Library:
  computed once per evaluation, so both arrivals carry one key. Two arrivals, one booking, and the
  second answer is 200 with `Idempotent-Replay: true` and `replayed` true. A key the schema refuses
  is a `SchemaError` with nothing sent. Provider: under `{ cors: "backend" }` a page cannot read
  `Idempotent-Replay` or `Location`, so only `replayed` says it was a replay. Status: tested.
  - `[EXT-24f] ${provider}: a key computed as a request field is computed once, so a retry replays: two arrivals, one key and one booking`
  - `[EXT-24f] ${provider}: a key the schema refuses is a SchemaError before dispatch, with nothing sent`
  - `[EXT-24f] a contract of 201 alone reads a replay as unexpected, so a caller has to declare both`
  - `[EXT-24f] under the region's own CORS a page reads a replay from the booking alone, because Idempotent-Replay is not exposed` (Chromium)
  - `[EXT-24f] a repeat key is one to 64 letters, digits and hyphens`
- **EXT-24g** The control for EXT-24f: a key written per attempt by `transformClient`. Each attempt
  has its own key, so two bookings: a key only helps if it outlives the attempt. Provider: on a
  reused connection Chromium's own second sending repeats the attempt's key, so that sending replays
  and there is one booking. Status: tested.
  - `[EXT-24g] ${provider}: a key written per attempt changes between attempts, so the retry makes a second booking` (behind the socket listener)
  - `[EXT-24g] ${provider}: on a reused connection Chromium's own second sending repeats the attempt's key, so that sending replays` (Chromium)
- **EXT-24h** A retry that moves region, with a key and a working link: `us` starts with `peer` set
  to `eu`'s origin. The booking committed at `eu` is what the caller gets back from `us`, with
  `replayed` true. `eu`'s ledger shows the `GET /v1/keys/<key>`, and `us` has no booking. Status:
  tested.
  - `[EXT-24h] ${provider}: with a working link a retry that moves region gets back the booking committed at the first`
- **EXT-24i** The same with the link down: `peer` names a closed port. The key protects nothing, and
  each region has a booking under the same key, so the caller holds `us`'s and `eu`'s also exists.
  Status: tested.
  - `[EXT-24i] ${provider}: with the link down the key protects nothing, and each region has a booking under it`
- **EXT-24j** A committed write whose body is cut after the head: `cut-body` on the `POST`, with
  `times: 1`, under `Policy.make(Schedule.recurs(1))` and no key. Provider: `fetch` is a `DecodeError`
  with status 201 in its `metadata`, not retried, so one booking. `lines` is a `TransportError`,
  retried, so two. The same answer duplicates a booking through one provider and not the other.
  Status: tested.
  - `[EXT-24j] ${provider}: a committed write whose body is cut is a DecodeError with status 201, not retried, so one booking` (`fetch`)
  - `[EXT-24j] ${provider}: a committed write whose body is cut is a TransportError, retried, so two bookings` (`lines`)
- **EXT-24k** A timed-out write: `hang`, after the commit, under `attemptTimeout: "2 seconds"` and
  `Policy.make(Schedule.recurs(1))` with `times: 1`. The first arrival ends `aborted`, and the retry
  makes a second booking, though the caller sees one success. A caller's `Effect.timeout` around
  `Policy.none` leaves one booking and a `TimeoutError`. Status: tested.
  - `[EXT-24k] ${provider}: an attempt timeout on a committed write makes a second booking, though the caller sees one success`
  - `[EXT-24k] ${provider}: a caller's timeout around one attempt leaves one booking and a TimeoutError`
- **EXT-24l** Finding out, instead of repeating: EXT-24a with a key, then `GET /v1/keys/<key>` on
  the region, which answers the booking. A 404 from the same read after `phase: "before"` says it
  was not committed. This is the consumer's own composition; the library offers no such step.
  Status: tested.
  - `[EXT-24l] ${provider}: reading the key answers the booking a lost answer left behind`
  - `[EXT-24l] ${provider}: the same read after a fault before the region is a 404, so it was not committed`
- **EXT-24m** A key reused with another body: a second evaluation with the same key and another
  `slot`. 409 `key_reused`, nothing committed, and not retried by `Policy.transient`. Status:
  tested.
  - `[EXT-24m] ${provider}: a key reused with another body is a 409, commits nothing and is not retried`
  - `[EXT-24m] a refusal names one of the page's errors`

#### Redirect chains with state

A redirect is the client's business. The library hands over one request and gets one response, so
one attempt covers a whole chain, and only the last answer reaches a contract. Every test asserts
each recipient's ledger: method, target, body, `Authorization`, `X-Agent-Key`, and, in Node, `Cookie`.

The providers are: `fetch`, which follows by itself in both lanes; in Node, `lines` with
`HttpClient.followRedirects` in `transformClient`; and in Node, `fetch` with `redirect: "manual"`
through `FetchHttpClient.RequestInit` and `followRedirects`. A test states which. Chromium's manual
mode gives an opaque answer, as STAT-10 records, so it cannot be followed there. The request carries
`Authorization: Bearer secret`, `X-Agent-Key: agent-1` and, in Node, `Cookie: session=1`, which
Chromium would drop (TRN-1). Every Node provider treats `Cookie` as it treats `Authorization`: it
reaches each recipient on the origin and stops at the origin.

Each region's `redirects` option gives the chain, and the last hop is a real route, so what a chain
does to a booking shows in `GET /v1/bookings`.

- **EXT-25a** A POST through 301, 302 and 303, on one origin: `/v1/reserve` to `/v1/bookings`.
  Provider: every provider arrives at the target as `GET`, with no body and no `Content-Type` or
  `Content-Length`, keeping `Authorization` and `X-Agent-Key`. That `GET` is the booking list, so the
  caller gets a 200 and nothing is committed: under a contract of 201, an `UnexpectedResponse` with
  status 200; the booking is lost without a transport failure. Status: limit.
  - `[EXT-25a] ${name}: a POST through ${status} arrives as a GET of the list, so a contract of 201 gets an UnexpectedResponse and the booking is lost`
- **EXT-25b** A POST through 307 and 308, on one origin. Provider: every provider keeps the method,
  body and every header, and one booking is committed. Status: tested.
  - `[EXT-25b] ${name}: a POST through ${status} keeps its method, body and every header, and one booking is committed`
- **EXT-25c** A same-origin hop and then a cross-origin hop, by 307: `eu`'s `/v1/reserve` to its
  `/v1/transfer` to `us`'s `/v1/bookings`. Provider: `Authorization` reaches both `eu` recipients and
  not `us`, with `followRedirects` and with `fetch`. `X-Agent-Key` reaches all three through every
  provider, because no client knows it is a credential: that is the forwarding to watch. The body
  arrives at all three, and one booking is committed at `us`. In Chromium, `us` sees `Origin: null`.
  Status: limit.
  - `[EXT-25c] ${name}: a same-origin hop then a cross-origin hop by 307 keeps the body and X-Agent-Key throughout, and Authorization stops at the origin`
- **EXT-25d** The same chain by 302: the cross-origin hop arrives as `GET`, with `X-Agent-Key` and
  without `Authorization`, and nothing is committed anywhere. Status: limit.
  - `[EXT-25d] ${name}: the same chain by 302 reaches the other region as a GET, with X-Agent-Key and without Authorization, and nothing is committed anywhere`
- **EXT-25e** A loop on one origin: `/v1/a` to `/v1/b` to `/v1/a`, by 302. Provider: `fetch` is a
  `TransportError` after 21 arrivals, with Node's cause `redirect count exceeded`.
  `followRedirects` stops after 11 arrivals and returns the last 302, so a contract of 200 gives an
  `UnexpectedResponse` with status 302. Status: limit.
  - `[EXT-25e] ${name}: a loop is a TransportError after 21 arrivals` (`fetch`)
  - `[EXT-25e] ${name}: a loop stops after 11 arrivals and hands back the last 302` (`followRedirects`)
- **EXT-25f** A loop of POSTs by 307: every arrival carries the body, and nothing is committed.
  Provider: as EXT-25e for the counts, with a last status of 307. Status: limit.
  - `[EXT-25f] ${name}: a loop of POSTs by 307 carries the body on every arrival and commits nothing`
- **EXT-25g** A timeout during a redirected body: `/v1/reports/today` to `/v1/manifest` by 302, with
  `trickle` on the manifest. Library: one attempt covers the chain, so `attemptTimeout` ends it as a
  `TimeoutError`, and a retry starts again at the first URL. The ledger holds the two hops twice, in
  order; the first hop's arrivals are not aborted, and each manifest arrival ends `aborted` with its
  connection closed. Status: tested.
  - `[EXT-25g] ${name}: one attempt covers a chain, so a timeout in the redirected body retries from the first URL`
- **EXT-25h** What an attempt's scope releases after `HttpClient.followRedirects`, Node lane only:
  the chain of EXT-25g, with a decoder that refuses the last hop's answer without reading it, and
  `HttpClient.filterStatusOk` rejecting a 404 at the end of a chain. Library: no live response crosses
  a failure, because the attempt's scope closes and releases it before the outcome is classified.
  That holds with no redirect: the request's abort signal is set when `while` runs, and the arrival
  ends `aborted`. After a redirect it does not. The signals read `[true, false]` at that moment, so
  the last hop's request is still running, the arrival still showed `aborted` false and its connection
  open 1.5 seconds later, and only garbage collection or the end of the body releases it. The cause
  is Effect's: `withScope` ties an abort controller to the request an attempt starts with, and
  `followRedirects` makes a new request for each hop without carrying that controller over, as
  `withCookiesRef` does. The last test shows it with no library at all, as
  `HttpClient.withScope(HttpClient.followRedirects(client))`. An attempt timeout and an interruption
  still end the body, because they reach it directly, so what stays open is an answer nothing is
  reading. A suspected defect, tracked in
  [#142](https://github.com/viell-dev/slop-effect-schema-http/issues/142). Status: defect.
  - `[EXT-25h] with no redirect a refused answer's request is aborted by the time its outcome is classified`
  - `[EXT-25h] currently, a redirected answer refused unread is still running when its outcome is classified, against the design's promise`
  - `[EXT-25h] currently, so is one that filterStatusOk rejects after a redirect, the same thing through ordinary middleware`
  - `[EXT-25h] currently, Effect alone does the same: withScope over followRedirects does not abort the last hop when its scope closes`
  - `[EXT-25h] an attempt timeout still ends a redirected answer, because interruption reaches its body`

#### Failures that threaten later calls

A failure must end with itself. These check that what a failure leaves behind cannot hurt the next
call on the same client: a connection still open, a timer still running, or a stale result. Each
entry ends with a successful request through the same layer and operation. "Once its head is in"
means a test waits for a `Deferred` a `transformClient` tap completes on the response, rather than
sleeping.

Library, throughout: interruption is not retried, an attempt's scope aborts its request before its
outcome is classified, a retry delay runs outside any attempt, and an `Interaction` runs at most one
execution, retains only successes, and waits for superseded work's finalizers on `close`.

- **EXT-26a** Repeated interruption during body reading: `trickle` on `GET /v1/manifest` with
  `times: 3`. Three calls are each interrupted once their heads are in. Each arrival ends `aborted`
  with its connection closed, and the fourth call returns the whole manifest. `lines` holds no head
  until the body ends, so there it is interrupted on arrival. Status: tested.
  - `[EXT-26a] ${provider}: three calls interrupted once their heads are in each leave a closed connection, and the fourth gets the whole manifest` (`fetch`)
  - `[EXT-26a] ${provider}: three calls interrupted on arrival each leave a closed connection, and the fourth gets the whole manifest` (`lines`)
- **EXT-26b** Interruption during retry backoff: `unavailable` with `times: 1`, under a policy with a
  delay of a second and `retryAfter: false`, interrupted once the classifier has seen the first
  answer. After a wait past that delay, which nothing else can signal, the ledger still holds one
  arrival, so no timer fired a late attempt, and a new evaluation succeeds with the attempt number
  `1`. Status: tested.
  - `[EXT-26b] ${provider}: an interrupt during retry backoff leaves no timer to fire a late attempt, and a new evaluation starts at attempt 1`
- **EXT-26c** Superseding an interaction during a body read: `held: ["rotterdam"]`. `run("rotterdam")`
  reaches its held body, then `run("hamburg")` supersedes it. The first caller ends interrupted, its
  arrival `aborted` with its connection closed, and `hamburg` is the retained success. A later
  `run("rotterdam")` is a new arrival, not a stale value. `close` during the same held body ends the
  caller and the connection in the same way, and a later `run` is `Interaction.Closed`. Status:
  tested.
  - `[EXT-26c] ${provider}: superseding an interaction during a held body ends the old caller and its connection, and a later run is a new arrival`
  - `[EXT-26c] ${provider}: closing the interaction during a held body ends its caller and its connection`
- **EXT-26d** Superseding an interaction while the old response is completing: as EXT-26c, with
  `POST /v1/availability/release?terminal=rotterdam` sent beside `run("hamburg")`, so the old body may
  finish first or be aborted first, and sent before it, which favours the other order. The test
  asserts what holds in both orders: the `hamburg` caller gets `hamburg`, the old caller never gets a
  value later than that, the retained success is `hamburg`, and no held answer stays open. Status:
  tested.
  - `[EXT-26d] ${provider}: with the release ${order} the new caller gets hamburg and keeps it, the old one gets nothing later, and no held answer stays open`
- **EXT-26e** A failed body under an `Interaction`: a retained success for one terminal, then
  `force` with `cut-body` on the next `GET /v1/availability` (`after: 1`, `times: 1`). The failure
  reaches the caller, and the retained success stays, so the next `run` needs no request. Status:
  tested.
  - `[EXT-26e] ${provider}: a failed body under force reaches the caller and leaves the retained success, so the next run needs no request`
- **EXT-26f** Attempts that time out in a row: `trickle` with `times: 3`, under
  `Policy.make(Schedule.recurs(3), { attemptTimeout: "1 second" })`. Four arrivals on four
  connections, the first three `aborted` and closed, and the fourth answers the whole manifest.
  Status: tested.
  - `[EXT-26f] ${provider}: attempts that time out in a row leave four arrivals on four connections, and the fourth is whole`

#### Malformed response metadata and decoding boundaries

Each of these is one [export](./services/bookings.md#the-exports-2009), read three ways. Through the
library, with `Response.when(() => true, …)` and a decoder that returns the status, the headers and
the text, by every provider of the lane; through bare `fetch` in the same lane, as the independent
control, with `arrayBuffer()` and a `TextDecoder` of the test's own; and, for an export the control
accepts, once more with the decoder the contract would really use.

The classification follows from the comparison. Where the library and the control agree, the result
is the provider's, and the test pins it. Where they differ, that is a suspected library defect, under
the Mismatches rule. They agreed on every export when measured. Library, throughout: selection sees
only what the provider exposed, normalized headers join repeated lines with `, `, provider lines are
an `Option`, and `Body.text` is the provider's `response.text`.

- **EXT-27a** Conflicting `Content-Type` lines: `two-types`. Provider: every client accepts it and
  joins them, so `metadata.headers["content-type"]` is `text/plain, application/json`, and only
  `lines` still has two lines, through `Transport.responseHeaderLines`. A selection rule that compares
  the whole value matches neither, and one that tests the media type must say what it does with a
  list. The body decodes. Status: limit.
  - `[EXT-27a] ${provider}: conflicting Content-Type lines are joined, and only lines still has them apart`
  - `[EXT-27a] ${provider}: a rule that compares the whole value matches neither type, and one that reads the list has to say so`
- **EXT-27b** One `Content-Type` twice: `same-type-twice`, as EXT-27a, joined into
  `application/json, application/json`. Status: limit.
  - `[EXT-27b] ${provider}: one Content-Type twice is joined as well`
- **EXT-27c** No `Content-Type`, and an unknown charset: `no-type` and `odd-charset`. Provider: every
  client gives the bytes as UTF-8 text, ignoring the charset. `Body.jsonSchema` decodes both, because
  it reads no content type. Status: limit.
  - `[EXT-27c] ${provider}: no Content-Type gives UTF-8 text, and Body.jsonSchema decodes it because it reads no content type`
  - `[EXT-27c] ${provider}: an unknown charset is ignored, so the bytes are UTF-8 text`
- **EXT-27d** Header bytes outside ASCII: `latin1-value` and `utf8-value`. Provider: every client
  reads a value as Latin-1, so byte FC is `ü`, and UTF-8's C3 BC arrives as `Ã¼`. The library passes
  that on unchanged, and repair is the consumer's. Status: limit.
  - `[EXT-27d] ${provider}: byte FC in a value reads as Latin-1, a u with two dots`
  - `[EXT-27d] ${provider}: UTF-8 in a value also reads as Latin-1, unchanged by the library, and repair is the consumer's`
- **EXT-27e** Heads every client refuses: `nul-value`, `two-lengths` and `no-version`. Provider: a
  `TransportError` everywhere, retried by `Policy.transient`, with a cause in Node that names the
  refusal: the parser's words through `lines`, as `Parse Error: Duplicate Content-Length`, and through
  `fetch` under `fetch failed`, where `two-lengths` says the body's length does not match
  `content-length`. Status: limit.
  - `[EXT-27e] ${provider}: ${name} is refused by every client, a TransportError that a retry repeats`
- **EXT-27f** Heads Node refuses and Chromium reads: `ctl-value`, `folded-value`, `bare-lf`,
  `no-colon`, `same-length-twice`, `length-and-chunked`, `bad-status` and `status-99`. Provider: in
  Node, a `TransportError` through both providers, each with a cause naming the rule. Chromium keeps
  the value in `ctl-value`, unfolds `folded-value` into `a b`, accepts LF alone, ignores the
  `no-colon` line, shows `11, 11` for `same-length-twice`, goes by the chunks in `length-and-chunked`, reads
  `bad-status` as 200 with empty status text, and hands over a status of 99. These run with harness
  CORS, so the page can read them at all. A 99 matches no declared case, so a contract of 200 gives an
  `UnexpectedResponse`. Status: limit.
  - `[EXT-27f] ${provider}: Node refuses ${name}, with a cause naming the rule` (Node)
  - `[EXT-27f] Chromium keeps a control character in a value, which Node refuses` (Chromium)
  - `[EXT-27f] Chromium unfolds a folded value into a b` (Chromium)
  - `[EXT-27f] Chromium accepts a head that ends its lines in LF` (Chromium)
  - `[EXT-27f] Chromium ignores a line with no colon` (Chromium)
  - `[EXT-27f] Chromium shows one length twice as 11, 11` (Chromium)
  - `[EXT-27f] Chromium goes by the chunks when a length and chunks disagree` (Chromium)
  - `[EXT-27f] Chromium reads a status of abc as 200 with empty status text` (Chromium)
  - `[EXT-27f] Chromium hands over a status of 99, which matches no declared case` (Chromium)
- **EXT-27g** Heads every client accepts: `no-reason`, with empty status text, and `http10`, whose
  body ends with the connection. Status: limit.
  - `[EXT-27g] ${provider}: a status line with no reason is accepted, with empty status text`
  - `[EXT-27g] ${provider}: an HTTP/1.0 answer with no length ends with its connection`
- **EXT-27h** A character split across chunks: `split-utf8` and `split-emoji`. Library: `Body.text`
  is the provider's, and it gives the text whole. The control decodes the same bytes at once. A
  streaming decoder would have to carry the bytes over; the library has none, because bodies are
  finite. Status: tested.
  - `[EXT-27h] ${provider}: ${name} gives the text whole, as a decoder of all the bytes at once does`
- **EXT-27i** A byte-order mark split across chunks: `split-bom`. Library: `Body.text` on a Fetch
  provider strips it, as its documentation says, so the text is `ok`, and the split changes nothing.
  `Body.bytes` keeps all five bytes, and the control's `TextDecoder` with `ignoreBOM` keeps the mark.
  `lines` gives the same, because its `Response` is a Fetch one. Status: tested.
  - `[EXT-27i] ${provider}: Body.text strips a byte-order mark split across chunks, and Body.bytes and the control keep it`
- **EXT-27j** A character cut at the end of a body: `cut-utf8`, under valid framing. Library:
  `Body.text` gives `Gr` and U+FFFD with no failure, as documented. A decoder over `Body.bytes` with
  `new TextDecoder("utf-8", { fatal: true })` fails as a `Response.DecodeError`. Status: tested.
  - `[EXT-27j] ${provider}: Body.text gives U+FFFD for a character cut at the end of a body, with no failure`
  - `[EXT-27j] ${provider}: a strict decoder over Body.bytes fails the same answer as a DecodeError`

#### A client that finds its API at runtime

From [#97](https://github.com/viell-dev/slop-effect-schema-http/issues/97). One client build can be
served from any domain, and finds its API when it starts: it tries its own candidates in order until
one answers, then uses that one. Definitions hold no domain. A health operation with an
`attemptTimeout` tries each candidate, and it must decode `{ "service": "berth", … }`, so a host that
answers 200 with something else does not count. The chosen base goes on through the HTTP client,
with `HttpClientRequest.prependUrl`, except in EXT-28l.

Each case below starts one region per candidate, and the last is healthy. A refused connection is a
closed port: a region started in a scope of its own that has ended, as EXT-21c does. Rows that a
browser refuses because of CORS start with `{ cors: "backend" }` and say so; the others run under
harness CORS. Library, throughout: a base URL Effect runs once per evaluation, an attempt timeout
applies to attempts, and the attempt number in `transformClient` starts at 1 for each evaluation.

- **EXT-28a** Candidates that refuse or reset, then one that works: a closed port, and
  `{ "route": "*", "fault": "reset" }`. A `TransportError` for each in both lanes, then the last is
  chosen. Chromium sends the `GET` to the region that resets twice, as EXT-23f pins. When no candidate
  counts, the search fails as the consumer's own `NoRegion`, saying what each did. Status: tested.
  - `[EXT-28a] ${provider}: a closed port and a reset are each a TransportError, and the last candidate is chosen`
  - `[EXT-28a] ${provider}: when no candidate counts the search fails as NoRegion, saying what each did`
- **EXT-28b** A candidate that hangs, under a bounded `attemptTimeout`: `hang` on `*`. A `TimeoutError`,
  then it moves on, in both lanes. Status: tested.
  - `[EXT-28b] ${provider}: a candidate that hangs is a TimeoutError under its limit, and the search moves on`
- **EXT-28c** A candidate that answers 502: `bad-gateway` on `*`, under `{ cors: "backend" }`, with
  `cors: { allowHeaders: ["b3", "traceparent"] }`, so that the preflight passes and the answer is
  what fails. Node: `UnexpectedResponse` with status 502. Chromium: `TransportError`, because the
  edge's page has no CORS lines and the page never sees it. The ledger holds the `GET` in both. Both
  move on. Status: tested.
  - `[EXT-28c] ${provider}: an edge's 502 is an UnexpectedResponse with its status, and the search moves on` (Node)
  - `[EXT-28c] ${provider}: an edge's 502 is a TransportError, because its page has no CORS lines, and the search moves on` (Chromium)
- **EXT-28d** A candidate that answers 200 with something else: `parked` and `other-service`, set up
  as EXT-28c. Node: `DecodeError`, from `Body.json` for the page and from the schema for the other
  service's JSON. Chromium: `TransportError`, for the same reason. Both move on. Under harness CORS a
  page reads both, so each is the same `DecodeError` in either lane. Status: tested.
  - `[EXT-28d] ${provider}: ${fault} answers 200 with something else, a DecodeError, and the search moves on` (Node)
  - `[EXT-28d] ${provider}: ${fault} answers 200 with something else, a TransportError for want of CORS lines, and the search moves on` (Chromium)
  - `[EXT-28d] ${provider}: under harness CORS a page reads both, so each is a DecodeError in either lane`
  - `[EXT-28d] health refuses what a parked page or another service would say`
- **EXT-28e** A correct answer without CORS lines: a healthy region with no `cors` option, under
  `{ cors: "backend" }`. Node accepts it. Chromium: `TransportError`, then it moves on. The ledger
  holds only the refused `OPTIONS`. With trace propagation off the `GET` needs no preflight, so it
  arrives and is answered, and the browser withholds a good answer: the same `TransportError`.
  Status: tested.
  - `[EXT-28e] ${provider}: a correct answer without CORS lines is accepted` (Node)
  - `[EXT-28e] ${provider}: a correct answer without CORS lines is refused at its preflight, so the search moves on` (Chromium)
  - `[EXT-28e] ${provider}: with trace propagation off the GET needs no preflight and is accepted` (Node)
  - `[EXT-28e] ${provider}: with trace propagation off the GET needs no preflight and arrives and is answered, and the browser withholds a good answer` (Chromium)
- **EXT-28f** A region that does not allow `b3` and `traceparent`: `cors: { allowHeaders:
["content-type"] }`, under `{ cors: "backend" }`. Node accepts it. Chromium's preflight fails, so
  it looks dead, and with `HttpClient.TracerPropagationEnabled` off for that client the same region
  is chosen. Status: tested.
  - `[EXT-28f] ${provider}: a region that does not allow the trace lines is accepted` (Node)
  - `[EXT-28f] ${provider}: a region that does not allow the trace lines looks dead to a page` (Chromium)
  - `[EXT-28f] ${provider}: with trace propagation off the same region is chosen`
- **EXT-28g** Parallel calls during discovery: several calls before a base is known, through
  `Effect.cached` or an equivalent of the consumer's. One discovery: each candidate's ledger has one
  health arrival. Status: tested.
  - `[EXT-28g] ${provider}: parallel calls before a base is known make one discovery`
- **EXT-28h** The chosen region resets during a session, a write included: `reset` on the session's
  routes, `GET /v1/manifest` with `after: 1` and `POST /v1/bookings`, and a call and a booking that
  move to the next candidate, by `transformClient` and the attempt number, in both lanes. A rule on
  `*` would also take the test's own `GET /v1/bookings`, and how many of those a `times` must spare
  depends on what Chromium sends again. The ledgers of both regions and `GET /v1/bookings` on both
  say what really happened to the write, as EXT-24e does: in Node a booking at each, and in Chromium
  two at the first. Status: tested.
  - `[EXT-28h] ${provider}: when the chosen region resets, a read and a booking move on by their attempt number, and the write stands at both regions`
- **EXT-28i** The chosen region hangs during a session: as EXT-28h with `hang`, under an
  `attemptTimeout`. The hung arrival ends `aborted`, with its connection closed. Status: tested.
  - `[EXT-28i] ${provider}: when the chosen region hangs, each hung arrival ends aborted and closed, and the attempt moves on`
- **EXT-28j** A definition that keeps a fixed base under `prependUrl`: the prefix goes in front of a
  whole URL, so the request goes to a wrong URL with no error from the library. Provider: both lanes
  send it to the chosen region with the target `/<wanted origin>/v1/health`, which answers 404, so the
  caller gets an `UnexpectedResponse`, and the ledger of the region it should have reached shows
  nothing. Status: limit.
  - `[EXT-28j] ${provider}: a fixed base under prependUrl goes to a wrong URL with no error from the library`
- **EXT-28k** No base added at all. Node: `InvalidUrlError`, in `HttpClientError`. Chromium: the
  relative URL resolves against the page, so the call goes to the page's own server, with no error
  from the library; that server answers 404, an `UnexpectedResponse`, and the regions' ledgers stay
  empty. Status: limit.
  - `[EXT-28k] ${provider}: no base at all is an InvalidUrlError, and no region hears of it` (Node)
  - `[EXT-28k] ${provider}: no base at all resolves against the page, so the call reaches the page's own server, and no region hears of it` (Chromium)
- **EXT-28l** A definition with `Request.baseUrl` and a service, the form for a location known late.
  Library: it runs once per evaluation, every retry uses that base, and it cannot move during
  retries, so the service supplies the chosen region and a failed lookup comes back as its own
  failure with nothing sent. The client route of EXT-28h stays, because only it can move a call
  between attempts. Status: tested.
  - `[EXT-28l] ${provider}: a base from a service runs once, so every retry uses it and a call cannot move between attempts`
  - `[EXT-28l] ${provider}: a lookup that fails comes back as itself, with nothing sent`
- **EXT-28m** A write moving between attempts by the attempt number alone, with no state in a
  classifier: `closed` on the first candidate's `POST`, and `transformClient` choosing the candidate
  from its second argument. As EXT-24e, with `X-Attempt` on both ledgers. A retry after two failures
  reaches a third candidate. Status: tested.
  - `[EXT-28m] ${provider}: a write moves between attempts by its number alone, with no state in a classifier`
  - `[EXT-28m] ${provider}: a retry after two failures reaches a third candidate`

#### The backend held to its page

- **EXT-29** The `bookings` backend against its [service page](./services/bookings.md), byte for
  byte over a raw socket: every route, the rows of the repeat-key table, the peer link, moved paths,
  the availability board, each export, each fault, the rules' `phase`, `after` and `times`, and the
  CORS filter. Every expected answer is written out from the page and the gzip streams are damaged
  in the test, so nothing is shared with the backend, and `date` is the only mask. Backend-side, in
  `src/conformance/bookings.node.test.ts`, Node lane. Status: tested.

#### A union's fields at the wire

EXT-30 takes the rule of
[#134](https://github.com/viell-dev/slop-effect-schema-http/issues/134) and
[#120](https://github.com/viell-dev/slop-effect-schema-http/issues/120) to the wire, in
`src/scenarios/union-fields.test.ts`, in both lanes, with `echo` and the socket listener. For values
the library can see, on either side of a schema, a field a caller gave is kept or the request is
refused. The library's own tests and search state that rule; these pin what arrives, or that nothing
does. The remaining gaps are listed in
[#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143). A status of limit here
records where the library says the rule stops.

- **EXT-30a** A narrower member first: `Union([{ owner }, { owner, limit }])`, in a query, the same
  in headers, and in a list of filters in a JSON body. Every field the caller gave arrives. On
  `0.2.0` the first member took the value and `limit` went. Status: tested.
  - `[EXT-30a] a narrower member first still sends every query field the caller gave`
  - `[EXT-30a] a narrower member first still sends every header the caller gave`
  - `[EXT-30a] a narrower member first still sends every field of a nested JSON body`
- **EXT-30b** A raw default under that union: `?limit=1` written in the constructor stays when the
  caller leaves `limit` out, and the caller's value replaces it, once, when given. Status: tested.
  - `[EXT-30b] a raw default stays when the caller leaves its field out, and goes when the caller gives it`
- **EXT-30c** Fields no member can hold together, `{ owner, team }` under `Union([{ owner }, { team
}])`: a `SchemaError`, with an empty ledger, naming the field and its whole path in a body, and
  never holding the value. Status: tested.
  - `[EXT-30c] fields no member can hold together are refused in a query, by name and never by value, and nothing is sent`
  - `[EXT-30c] fields no member can hold together are refused in a body, by their whole path, and nothing is sent`
- **EXT-30d** A union stacked with a struct that takes one of its fields, in both orders: both
  fields arrive once. Status: tested.
  - `[EXT-30d] a union stacked with a struct sends both fields, in either order`
- **EXT-30e** Two stacked unions that each state a field: neither can leave it to the other, so the
  group is refused, with nothing sent and no value in the error. Status: tested.
  - `[EXT-30e] two stacked unions that each state a field leave it to neither, and are refused`
- **EXT-30f** A raw edit of a field with a decoding default, after the schema:
  `Request.InvalidRequest` before anything is sent, saying that the value could never reach the
  client. Before the schema the same edit is an ordinary default, and the schema's value goes out.
  Status: tested.
  - `[EXT-30f] a raw edit of a field with a decoding default is refused before anything is sent`
  - `[EXT-30f] control: the same edit before the schema is an ordinary default, and the schema's value goes out`
- **EXT-30g** Controls for EXT-30f. Under the `omit` strategy the schema never writes the name, so
  the same edit is refused as lost, by the other message. Under `Schema.OptionFromOptionalKey` a raw
  edit stands. Status: tested.
  - `[EXT-30g] control: under the omit strategy the schema never writes the name, so the same edit is refused as lost`
  - `[EXT-30g] control: an optional field that reads absence as None leaves a raw edit to stand`
- **EXT-30h** What either side of a schema states can be seen. Under `Schema.OptionFromNullOr` and
  in an object given to `Schema.fromJsonString`, a wider member wins, and fields no member holds
  together are refused with nothing sent. Status: tested.
  - `[EXT-30h] a wider member wins under OptionFromNullOr and under an object given to a field that holds JSON, because a side of each schema states it`
  - `[EXT-30h] fields no member can hold together are refused under OptionFromNullOr, and nothing is sent`
  - `[EXT-30h] fields no member can hold together are refused in an object given to a field that holds JSON, and nothing is sent`
- **EXT-30i** What is opaque: text given as text, and `Schema.Option`, a declaration. Fields no
  member holds together are not refused, and the first member's go out, as on `0.2.0`. Status:
  limit.
  - `[EXT-30i] limit: fields no member can hold together in text given as text are not refused, and the first member's go out`
  - `[EXT-30i] limit: fields no member can hold together inside Schema.Option are not refused, and the first member's go out`
- **EXT-30j** A stray key inside an opaque value fails the whole strict read, because
  `onExcessProperty` applies to a read and not to a part, so a visible union beside it is read
  loosely, and a wider member's field is refused, with nothing sent. Loud, and stated in the design
  page. Status: limit.
  - `[EXT-30j] limit: a stray key inside an Option beside a visible union makes the union read loosely, so a wider member's field is refused, and nothing is sent`
- **EXT-30k** A renamed struct takes its names from one side: `{ a, B }` is refused by name, with
  nothing sent, and each side alone goes out under the wire names. Status: tested.
  - `[EXT-30k] names from two sides of a renamed struct are refused, by name and never by value, and nothing is sent`
  - `[EXT-30k] control: each side of the renamed struct alone goes out under the wire names`
- **EXT-30l** One field under both of its names with different values: the decoded name's goes out
  and the encoded name's goes, with no error, because the whole value is not on the encoded side.
  Item 6 of #143. Status: limit.
  - `[EXT-30l] limit: one field under both of its names under different values keeps the decoded name's, with no error`
- **EXT-30m** A value a wider member refuses, `limit` under `Schema.FiniteFromString`, is refused
  rather than cut down to the narrower member. Status: tested.
  - `[EXT-30m] a value a wider member refuses is refused, and is not cut down to the narrower member`
- **EXT-30n** A key set to `undefined` under a union is no field, and the request goes out without
  it. Status: tested.
  - `[EXT-30n] a key set to undefined under a union is no field, so the request goes out without it`
- **EXT-30o** A tag has already chosen, so a key only another tag's member states goes, with no
  error. Status: tested.
  - `[EXT-30o] a tag has already chosen, so a key only another tag's member states goes, with no error`
- **EXT-30p** A bare union can recover another member using an actual sibling's consumption.
  The original `Union([{ team }, { owner, limit }])` stacked with `{ team }` input now sends all
  three fields; fields no member can hold together still refuse dispatch. EXT-34 exercises the
  business-service workflow and the bounded recovery's limits. Item 1 of #143. Status: tested.
  - `[EXT-30p] a bare union recovers its wider member beside an actual sibling holder`
  - `[EXT-30p] control: fields no member can hold together remain refused beside a sibling`
  - `[EXT-30p] control: bound directly, the member goes out whole beside that schema`
- **EXT-30q** A field whose own encode step omits it goes out without it. The schema decided that,
  so it is no loss the library can answer for. Status: tested.
  - `[EXT-30q] a value whose encode step drops a field is the schema's own decision, and goes out without it`

#### The gateway held to its page

EXT-31 holds the gateway to its [service page](./services/gateway.md) where no recording reaches,
byte for byte over a raw socket, under both listeners unless an entry says otherwise. No Apache 1.3
can be recorded and the CGI.pm recording quotes nothing, so every expected answer is written out
from the page, and nothing is shared with the backend. Backend-side, in
`src/conformance/gateway-page.node.test.ts`, Node lane. The three differences from the page that
[#122](https://github.com/viell-dev/slop-effect-schema-http/issues/122) found are fixed in the
gateway or settled on the page, as each entry says.

- **EXT-31a** Apache's own refusals: a path no script serves is Apache 1.3's 404 page and another
  method on a listed path its 405 page, `text/html; charset=iso-8859-1` with `Content-Length`, with
  `Allow` naming the path's methods from the endpoint table. A page names the path up to its first
  `?` or `#`, as it arrived, with `&`, `<`, `>` and `"` escaped, and the 405 page the method,
  unescaped. Status: tested.
  - `[EXT-31a] ${listener}: ${target} reaches no script, and is Apache's 404 page naming ${path}`
    (an unknown path, one with a query and fragment, a help path without a topic or with two
    segments, a script with a path after it, and an escaped dot)
  - `[EXT-31a] the 404 page writes &, <, > and " as references and every other byte of the path as it arrived`
    (socket listener)
  - `[EXT-31a] ${listener}: ${method} ${target} is Apache's 405 page with Allow: ${allow}` (every
    listed path, with a query and fragment on one)
  - `[EXT-31a] the 405 page names the method as it arrived, unescaped, and escapes the path`
    (socket listener)
  - Controls: `[EXT-31a] rpt.exe takes every method, so ${method} is its 301 and never 405`, and
    `[EXT-31a] extract.cgi's own 404 stays its text/plain ERROR line, not Apache's page`.
  - Fixed in the gateway: the shared router answered both as plain text `Not Found` and
    `Method Not Allowed`, where the page promised Apache's pages. The page now gives the pages'
    exact lines and messages, from Apache 1.3's `ap_send_error_response`. It records as kept that
    stock Apache 1.3 hands a CGI any method, so the 405 is the gateway's own.
  - Mutation control: answering with the router's plain-text refusals fails 30 of the file's tests.
- **EXT-31b** Query values are bytes, as CGI.pm's `unescape` leaves them: `%` and two hexadecimal
  digits, in either case, is that byte, any other `%` stays, and a raw byte outside ASCII is that
  byte. A value matches stored text by its UTF-8 bytes, and a message quotes it as those bytes.
  Status: tested.
  - `[EXT-31b] ${listener}: go.cgi?${query} quotes the section as the bytes CGI.pm decodes` (`%E4`,
    `%e4`, `%C3%A4`, `%FF%00%80`, a bad escape beside a good one, a cut escape, `+` and `%2B`,
    `%u00E4` kept, and `%25E4`)
  - `[EXT-31b] socket: a raw byte outside ASCII is that byte, as its escape would be (${query})`
  - `[EXT-31b] http: node:http answers a raw byte outside ASCII with its own 400 before any script runs`
  - `[EXT-31b] ${listener}: report.cgi quotes an account and a report name as the decoded bytes`
  - `[EXT-31b] ${listener}: a value matches stored text by its UTF-8 bytes, and Latin-1 escapes do not`
    (a user, a password and the SSO token outside ASCII), and
    `[EXT-31b] socket: raw UTF-8 bytes match stored text the same as their escapes`
  - Control: `[EXT-31b] a message's own text stays UTF-8: import.cgi's refusal spells Fällig in UTF-8`
  - Measured before the fix, on both listeners: `go.cgi?section=%E4` answered
    `ERROR|E_SECTION|no section %E4`, the escape as text, because a component that was not UTF-8
    was kept undecoded, and `a%20%G1` came back whole. Under the socket listener the raw bytes C3 A4
    came back as C3 83 C2 A4, and a raw E4 as C3 A4, because a reply was encoded as UTF-8 from a
    string of one character per byte. `%C3%A4` came back right by accident.
  - Fixed in the gateway: CGI.pm's byte decoding, replies written one byte per character, and
    stored text compared and written as UTF-8. Kept, in the page's "Recordings": CGI.pm 4.55 also
    reads `%uXXXX`, which the gateway keeps as it is.
  - Mutation controls: writing replies as UTF-8 fails 15 tests; keeping `%E4` undecoded fails 6.
  - Consumer policy ([#149](https://github.com/viell-dev/slop-effect-schema-http/issues/149)):
    strict UTF-8 for the text view of ordinary pipe and help replies, matching the byte-backed
    error reader. The service's arbitrary echoed bytes remain available through `Body.bytes`.
    `src/scenarios/gateway-utf8.test.ts` checks exact response bytes and request targets in both
    lanes, through each lane's providers:
    - `[EXT-31b] ${provider}: pipe and help contracts preserve valid UTF-8 ${escaped}` (ASCII,
      `ä`, a four-byte emoji and a literal U+FFFD; `Accept` stays `text/plain`).
    - `[EXT-31b] ${provider}: pipe and help contracts refuse malformed UTF-8 ${escaped}, while Body.text replaces it`
      (a lone E4, a stray continuation byte, an overlong sequence, a surrogate and a value above
      U+10FFFF). The refusal is a `Response.DecodeError` in HTTP 200 with a schema cause saying
      `not UTF-8`. The transparent `Body.text` control keeps the library's lenient behavior.
- **EXT-31c** A message quotes the request unescaped: a `|` in a fragment, a topic or a query value
  stays a `|`, so an `ERROR` line can have more than three fields and its message is everything
  after the second `|`; a value decoded from `%0A` ends the line inside the message. Status: tested.
  - `[EXT-31c] ${listener}: ${target} quotes its | in the message as it is` (a fragment, one with
    a query and two `|`, a fragment's `%7C` left encoded, a topic with `|` and with `%7C`,
    `go.cgi`'s section encoded and raw, and `report.cgi`'s report and account)
  - `[EXT-31c] the page's example: #a|b answers 31 bytes, whose message after the second | is no section a|b`
  - `[EXT-31c] ${listener}: go.cgi?${query} ends the line inside the message` (`%0A` and `%0D%0A`)
  - Settled on the page: the gateway already wrote `|` as it is; the page said only that errors
    quote a fragment as it arrived. It now says the message is the rest of the line, with the exact
    bytes of `#a|b`, so a reader takes the code and message from the first two `|` alone.
  - Consumer side: EXT-9p decodes the page's example through the consumer's contract, whose reader
    gave a decode error on it before.

#### Candidate preparation contracts at the wire

EXT-32 checks the request-preparation changes introduced in `0.4`. The current default source
commit is recorded in `library-ref`; release qualification supplies its final library commit
separately. The consumer tests in
`src/scenarios/preparation-contracts.test.ts` use the customer-list endpoint documented in
[services/business.md](./services/business.md), with seeded customers, its `page`, `per_page` and
`name` query fields, and `Accept`. Both Node and Chromium use Fetch over the socket listener.
Every successful call checks the returned customer names and the ledger's exact GET target, one
JSON Accept line, empty body and one request; every preparation failure checks an empty ledger.
EXT-30l's contradictory-alias limit remains unchanged.
The gateway's Digest helper accepts the now-omittable header group; the existing successful AUTH-7
handshake also starts without that group.

- **EXT-32a** Query/header groups whose schema input accepts `{}` can be omitted. Raw defaults
  still validate, explicit caller values override them, and refinements or explicit `null` can
  still fail before dispatch. Status: tested.
  - `[EXT-32a] omitted and undefined optional query/header groups reach the customer list`
  - `[EXT-32a] omitted optional groups keep validated raw defaults and accept explicit overrides`
  - `[EXT-32a] omission still validates refinements and explicit null before dispatch`
- **EXT-32b** A direct struct's successful constructor fills an omitted optional field and its
  encoder writes it, so a post-binding raw edit is an `InvalidRequest` with nothing dispatched.
  Query set, append and both removals, plus case-insensitive header set/removal, are covered.
  Earlier raw defaults and explicit input still dispatch. Whole-decoder fallback after a sibling
  fails construction, an undefined-producing default and a failed-default fallback keep raw
  values. Status: tested.
  - `[EXT-32b] constructor-filled query/header fields refuse post-binding raw edits with nothing sent`
  - `[EXT-32b] control: pre-binding defaults and explicit caller values reach the wire`
  - `[EXT-32b] control: decoder fallback and undefined-producing defaults leave raw values to stand`
- **EXT-32c** An encoded tag under `Schema.encodeKeys` selects its member before treating an
  extra value as a field only the other member states. `name=cedar` arrives without the other
  member's invalid `per_page`, and the customer list succeeds. Status: tested.
  - `[EXT-32c] an encoded renamed tag rules out the other member's query field`
- **EXT-32d** A transformed literal inside a tag union cannot be guessed through. The wider
  member keeps `per_page` beside the tag and both arrive, instead of silently losing the field.
  Status: tested.
  - `[EXT-32d] a transformed literal inside a tag union keeps its wider member's query field`

#### Generated direct-struct fields at the wire

EXT-33 extends the direct-struct request-preparation contract for the `0.5` repair of
[#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143). Consumer tests in
`src/scenarios/generated-field-contracts.test.ts` use the documented business customer list,
seeded customers and Fetch over real sockets in Node and Chromium. A successful ordinary encoded
object writing an omitted field makes a later raw edit an `InvalidRequest`; an iterable's own
properties do not establish which entries it sends. Every successful call checks returned customer
names, the exact GET target, one JSON Accept line, empty body and one request. Every refusal checks
an empty ledger and a field-naming error without the raw value. Group transformations, aliases,
classes, unions, inherited/accessor input and opaque selection remain outside this extension;
EXT-30l's contradictory-alias pin is unchanged.

- **EXT-33a** A handwritten decoding default with a nonpassthrough encoder writes an omitted query
  field. A later set, append or removal must be refused before dispatch. Status: tested.
  - `[EXT-33a] a handwritten decoding default refuses a later query set before dispatch`
  - `[EXT-33a] a handwritten decoding default refuses a later query append before dispatch`
  - `[EXT-33a] a handwritten decoding default refuses a later query remove before dispatch`
- **EXT-33b** An optional header generated only while encoding also refuses later set and removal,
  comparing header names without case. Status: tested.
  - `[EXT-33b] an encode-only generated header refuses later set and removal regardless of case`
- **EXT-33c** Mixed input supplies `page` as text and `per_page` as a decoded number, while `name`
  has a constructor default. Successful fieldwise reading must still protect that generated field,
  without evaluating its default more often than an ordinary successful call. Status: tested.
  - `[EXT-33c] mixed decoded input still refuses a generated field's later raw edit without rerunning its default`
- **EXT-33d** Ordinary generated values reach the customer list. Raw defaults before the binding
  and explicit caller values preserve their existing precedence. Status: tested.
  - `[EXT-33d] control: generated values, pre-binding defaults and explicit caller values reach the customer list`
- **EXT-33e** A decoder fallback that writes no omitted field leaves a later raw query value to
  stand. Status: tested.
  - `[EXT-33e] control: a decoder fallback that generates no field keeps a later raw query value`
- **EXT-33f** A direct struct declares an empty generator at `Symbol.iterator` and has an own
  constructor-generated query property. The iterable sends no entries, so removing that property
  must remain usable and the customer list receives no query. Status: tested.
  - `[EXT-33f] control: an empty iterable direct struct sends no own generated query field and permits removal`

#### Empty transformed groups and bounded stacked-union recovery

EXT-34 covers the two bounded `0.6` follow-ups accepted in
[#143's scope decision](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6724274862).
Consumer tests in `src/scenarios/group-preservation.test.ts` use the documented business customer
list and seeded customers through Fetch and the socket listener, in Node and Chromium. Business
successes check customer names, exact GET target, one JSON Accept line, empty body and one arrival.
The inherited `toString` name uses the neutral echo probe's README contract and exact wire checks.
Refusals check the error kind, a named field, redacted values and an empty ledger. Recovery may
repeat schema work for formerly refused calls; successful calls retain their original path. No
joint backtracking or general transformed-field correspondence is claimed. EXT-30l's conflicting
aliases and the opaque-value pins remain unchanged.

- **EXT-34a** A strictly empty plain or null-prototype caller group, including normalized omission,
  proves a generated renamed field without a key map. Renamed and multistage closed-object schemas
  refuse later set, append and removal of an actual encoded field. Status: tested.
  - `[EXT-34a] an empty ${shape} group refuses a later query ${edit}`
  - `[EXT-34a] an ${shape} empty group refuses replacement of its renamed default`
- **EXT-34b** A renamed generated `Accept` header refuses later set and removal regardless of raw
  edit casing. The ordinary generated header reaches the service. Status: tested.
  - `[EXT-34b] an empty renamed header group protects Accept without case sensitivity`
- **EXT-34c** The empty-group proof adds no default or transformation evaluations: compare the
  exact callback trace against an ordinary successful call using the same schema. Status: tested.
  - `[EXT-34c] empty-group evidence reuses ordinary default and transform evaluations`
- **EXT-34d** Explicit decoded and encoded values retain their precedence over later raw defaults;
  earlier raw defaults retain ordinary schema behavior. Status: tested.
  - `[EXT-34d] control: explicit decoded and encoded values and earlier raw defaults retain precedence`
- **EXT-34e** An unrelated own key, a nonenumerable own key, a symbol own key or a custom prototype
  disables the new proof. These unchanged transformed-input limits still permit the generated
  output to replace a later raw edit, including legitimate nonempty `{ page: 1 }` input. An
  inherited encoded `toString` name also disables it. A renamed empty generator still sends
  yielded entries rather than its own generated field.
  Status: limit.
  - `[EXT-34e] limit: an ${shape} disables the new empty-group proof`
  - `[EXT-34e] limit: a nonempty renamed group keeps the broader generated-field correspondence limit`
  - `[EXT-34e] control: an inherited encoded toString name disables empty-group evidence`
  - `[EXT-34e] control: a renamed iterable output still sends yielded entries rather than own fields`
- **EXT-34f** `Union([{ page }, { per_page, name }])` stacked with `{ page }` recovers the full
  customer filter in both binding orders using actual sibling consumption. Status: tested.
  - `[EXT-34f] ${order}: actual sibling consumption lets a union keep the remaining customer filters`
- **EXT-34g** Recovery retains whole-union constructor-before-decoder priority: a later string
  member keeps `name: "01"` although an earlier numeric member could decode it as `1`. Returned
  customer names distinguish both wire spellings; the direct numeric control writes `1`.
  Status: tested.
  - `[EXT-34g] whole-union constructor priority preserves literal 01 during recovery`
  - `[EXT-34g] control: directly binding the numeric member canonicalizes name 01 to 1`
- **EXT-34h** A wider-first successful call keeps its baseline schema-evaluation trace and full
  customer filter. Status: tested.
  - `[EXT-34h] control: a wider-first successful union keeps its evaluation trace`
- **EXT-34i** Two applications of one binding factory cannot hold three separate alternatives'
  fields. Names merely stated by a union cannot excuse fields it did not consume. Status: tested.
  - `[EXT-34i] control: reused bindings cannot pre-credit all names merely stated by their unions`
- **EXT-34j** A binding's generated name cannot be withdrawn during recovery after a mapped inner
  input relied on that name's certificate. The old false refusal is preserved rather than silently
  losing the mapped caller value. Status: tested.
  - `[EXT-34j] recovery cannot withdraw generated credit already used after mapInput`
- **EXT-34k** Parent checks leave a union outside the bounded recovery route. Its original false
  refusal remains a stated limit. Status: limit.
  - `[EXT-34k] control: parent checks keep the bounded union recovery unavailable`

## Visible fields beside opaque neighbors

EXT-35 covers the constructor-only repair accepted in
[#143, gap 10](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6725100255).
The neutral echo probe's [public contract](./README.md#the-neutral-echo-probe) supplies its fixed
404 response; Fetch in Node and Chromium reaches socket listeners, and the ledger establishes exact
method, target, body bytes, relevant header lines and request counts. Refusals check `SchemaError`,
field paths, value redaction and an empty ledger. Published `0.6.0` refuses nine intended successful
calls at `["f"]["b"]`; its eighteen passing controls remain part of the regression evidence.
EXT-30j uses `OptionFromNullOr`, whose encoded object is visible, and remains a separate limit.

- **EXT-35a** A direct `Option` with an extra opaque key does not prevent a visible nested union
  from keeping its wider member. Both a JSON body and a path renderer preserve `f.b`; the opaque
  option retains its schema's ordinary reading. Status: tested.
  - `[EXT-35a] a direct Option neighbor preserves the wider JSON body member`
  - `[EXT-35a] a direct Option neighbor preserves the wider path renderer member`
- **EXT-35b** A `ReadonlyMap` neighbor behaves the same. A path renderer serializes its entries so
  both the visible member and the opaque value's ordinary reading reach the wire. Status: tested.
  - `[EXT-35b] a ReadonlyMap neighbor preserves the visible member and its own ordinary reading`
- **EXT-35c** Constructor-only recovery preserves whole-group side selection: encoded `n: "1"`
  alongside `base64: "eA=="` remains refused, while decoded `n: 1` permits recovery and sends
  `base64: "ZUE9PQ=="`. General fieldwise decoding would change the meaning of the first call.
  Status: tested.
  - `[EXT-35c] encoded numeric input cannot force a new fieldwise base64 interpretation`
  - `[EXT-35c] decoded numeric input recovers with the constructor's double-encoded base64`
- **EXT-35d** Existing successful calls keep their exact traces and body bytes: two checks on the
  strict path and five on the loose fallback with opaque excess. No additional schema evaluations run on
  either path. Status: tested.
  - `[EXT-35d] control: an existing successful read retains its checks and bytes`
  - `[EXT-35d] control: a successful loose read with opaque excess retains its check trace`
- **EXT-35e** Parent refinements still reject a wider member, and an omitted constructor default
  survives recovery as the generated field in the outgoing body. Status: tested.
  - `[EXT-35e] a parent's rejection of the wider member still refuses dispatch`
  - `[EXT-35e] recovery preserves an omitted parent's constructor default`
- **EXT-35f** Fields no visible member can hold together remain refused by their full path, without
  exposing their values or dispatching. Status: tested.
  - `[EXT-35f] fields no visible member can hold together still refuse by path without their values`
- **EXT-35g** A root sibling's actual consumption of `b` cannot excuse losing nested `f.b`.
  Status: tested.
  - `[EXT-35g] a root sibling named b cannot excuse losing nested f.b`
- **EXT-35h** A decoded renamed visible sibling already works without opaque excess. Its union
  also preserves the wider member's wire names when an opaque neighbor has excess.
  Status: tested.
  - `[EXT-35h] control: a renamed visible sibling already works without opaque excess`
  - `[EXT-35h] a renamed visible sibling keeps its decoded values beside opaque excess`
- **EXT-35i** Text supplied to a JSON-text field remains subject to its schema's own first-member
  choice, within the documented opaque boundary. Status: limit.
  - `[EXT-35i] control: JSON text remains subject to its schema's own member choice`
- **EXT-35j** Reconstruction preserves caller-supplied own `__proto__` and `constructor` fields as
  JSON data, and a declared symbol field remains available to a path renderer.
  Status: tested.
  - `[EXT-35j] recovery retains own prototype-named fields as JSON data`
  - `[EXT-35j] recovery keeps a symbol field consumed by a path renderer`
- **EXT-35k** The original wider member succeeds when its opaque neighbor has no excess key.
  Status: tested.
  - `[EXT-35k] control: the original wider member works when its Option neighbor has no excess`
- **EXT-35l** A wider member that rejects a supplied visible field's value cannot discard it by
  selecting the narrow member. Status: tested.
  - `[EXT-35l] control: a visible field whose value the wider member rejects remains refused`
- **EXT-35m** Accessor input remains outside the stable-input evidence used by the bounded repair;
  its original refusal remains. Status: limit.
  - `[EXT-35m] limit: accessor input retains its original refusal rather than manufacturing stable evidence`
- **EXT-35n** An iterable parent is not reconstructed as an ordinary record. Its original visible
  loss still refuses dispatch before the renderer runs. Status: limit.
  - `[EXT-35n] limit: an iterable parent is not reconstructed as an ordinary record`
- **EXT-35o** A null-prototype caller object omits `toString`, whose constructor default is `"25"`.
  Recovery must preserve both visible union fields and write that default, without manufacturing
  an inherited native method or mutating the caller. This independently covers the
  [pre-publication candidate defect](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6725476571).
  Status: tested.
  - `[EXT-35o] null-prototype recovery keeps a missing toString field's constructor default`
- **EXT-35p** A sparse array's custom prototype supplies inherited index `0: "original"`.
  A parent check rejects the wider `f` member while that element remains. Recovery must retain
  the refusal rather than copy away the element and dispatch `x: [null]`. The custom prototype
  belongs only to this array. This and EXT-35q cover the
  [two deep-review blockers](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6725666937).
  Status: tested.
  - `[EXT-35p] an inherited sparse-array element cannot be copied away to bypass a parent check`
- **EXT-35q** An empty `Struct` receives an externally held object. A parent check rejects the
  wider member while `x` retains that object's identity. Recovery must retain the refusal rather
  than clone `x` and bypass the check. Status: tested.
  - `[EXT-35q] an empty Struct's external identity cannot be copied away to bypass a parent check`
- **EXT-35r** A caller adds visible `f.b` after creating a JSON encoding Effect but before running
  it. A custom `Body.encoder` returns that pending Effect through `Request.body`. Recovery must
  retain the refusal rather than send the older narrow value. This and EXT-35s/t cover the
  [pending-input regression](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726041080).
  Status: tested.
  - `[EXT-35r] a visible field added after creating a pending body cannot disappear during recovery`
- **EXT-35s** Changing existing `f.a` while its body encoding Effect is pending must not recover
  the earlier value. A typed refusal and empty socket ledger preserve the current input rather
  than dispatch stale bytes. Status: tested.
  - `[EXT-35s] a visible value changed after creating a pending body cannot recover its old value`
- **EXT-35t** Replacing a direct opaque `Option` while its body encoding Effect is pending must
  not let recovery test an older identity against the parent's check. The original refusal remains,
  with no request sent. Status: tested.
  - `[EXT-35t] an opaque identity replaced after creating a pending body cannot bypass a parent check`
- **EXT-35u** Deleting and re-adding a nested Record's key while its body encoding Effect is pending
  changes its observable key order. A parent check rejects the current order; recovery must not
  bypass it using the old order. The
  [own-key-order control](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726073336)
  retains a typed refusal and empty ledger. Status: tested.
  - `[EXT-35u] record keys reordered after creating a pending body cannot bypass a parent check`

## Annotations on whole request unions

EXT-36 covers the annotation-only extension to bounded whole-union recovery accepted in
[#143, gap 1](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726559103).
The neutral echo probe's [contract](./README.md#the-neutral-echo-probe), Fetch in Node and Chromium,
and socket ledgers establish the decoded response, exact target, empty body, physical header lines
and request count. Published `0.6.1` refuses eight intended successful calls solely because their
union has annotations; twelve controls pass. Existing parent-behavior and member-shape limits
remain separate from this extension.

- **EXT-36a** Title, description and combined annotations retain all supplied query/header fields
  under the narrower-first union stacked with an actual sibling holder. Both binding orders are
  represented; the query preserves encoded punctuation and each header arrives exactly once.
  Status: tested.
  - `[EXT-36a] ${group}: ${annotation} annotations keep every field with ${order}`
- **EXT-36b** Bare unions already preserve all fields for both query and headers, with the union
  before or after its sibling. These keep the existing successful wire behavior. Status: tested.
  - `[EXT-36b] control: a bare ${group} union already keeps every field with ${order}`
- **EXT-36c** Wider-first annotated calls already succeed in both groups. Their exact three-check
  trace and complete wire output remain unchanged. Status: tested.
  - `[EXT-36c] control: a wider-first annotated ${group} union retains its successful trace`
- **EXT-36d** An identifier and unfamiliar consumer metadata do not disable recovery. The original
  schema retains the custom metadata object's identity before and after execution. Status: tested.
  - `[EXT-36d] identifier and unfamiliar metadata do not prevent query recovery`
- **EXT-36e** Recovery preserves whole-union constructor-before-decoder priority. A numeric member
  before a string member cannot canonicalize caller text `"01"` when the later constructor accepts
  that text. Status: tested.
  - `[EXT-36e] annotated recovery keeps whole-union constructor priority for literal 01`
- **EXT-36f** Three mutually exclusive members and one sibling cannot jointly hold every supplied
  field. The refusal identifies `c`, omits its value and sends nothing. Status: tested.
  - `[EXT-36f] contradictory member fields remain refused by name without exposing values`
- **EXT-36g** A member's field check remains effective. An annotation and sibling cannot excuse a
  value the only wider member rejects; the redacted `SchemaError` leaves the ledger empty.
  Status: tested.
  - `[EXT-36g] a rejected member value is not excused by an annotation or sibling`
- **EXT-36h** A parent check leaves the union outside bounded recovery even when it always passes.
  Its original refusal remains. Status: limit.
  - `[EXT-36h] limit: a parent check still keeps annotated recovery unavailable`
- **EXT-36i** A constructor default on the union is parent context, not descriptive metadata.
  Recovery remains unavailable and the supplied input does not evaluate the default. Status: limit.
  - `[EXT-36i] limit: a parent constructor default is not descriptive metadata`
- **EXT-36j** An annotated `oneOf` union still refuses an input that also supplies the sibling's
  fields. Its constraint is not converted to `anyOf`, and nothing is sent. Status: tested.
  - `[EXT-36j] control: an annotated oneOf union remains a refusal with no dispatch`
- **EXT-36k** A member with a group rename remains outside bounded recovery. An annotation does
  not expand recovery to arbitrary transformed members. Status: limit.
  - `[EXT-36k] limit: annotated transformed members stay outside bounded recovery`

## Generated fields through closed request unions

EXT-37 covers the bounded generated-field extension accepted in
[#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6727350120).
Consumer tests use the neutral echo probe's [public contract](./README.md#the-neutral-echo-probe),
Fetch in Node and Chromium, and physical socket ledgers. Refusals require `InvalidRequest`, a
field name without its value and zero requests; controls assert exact method, target, relevant header lines,
empty body and request count. These scenarios target the breaking `0.7.0` candidate after published `0.6.2`.

- **EXT-37a** Singleton, multiple-member and nested reversed-member closed unions protect a
  renamed generated optional field from later set, append and removal. Ordinary and null-prototype
  empty caller groups are represented. Status: tested.
  - `[EXT-37a] ${group}: a closed ${shape} union refuses a later ${kind} of a renamed generated field`
- **EXT-37b** A closed union without any group codec protects the exact top-level identity of an
  omitted generated field even beside supplied `other` input. Status: tested.
  - `[EXT-37b] ${group}: an untransformed closed union protects an omitted exact-name field beside supplied input`
- **EXT-37c** Explicit caller input under either decoded or encoded aliases chooses the outgoing
  value despite a later raw default. Status: tested.
  - `[EXT-37c] control: ${group} explicit decoded and encoded aliases choose the outgoing value`
- **EXT-37d** Earlier raw defaults remain replaceable by generated values; unbinding allows the
  later raw value through without schema evaluation. Status: tested.
  - `[EXT-37d] control: ${group} pre-binding defaults and unbind retain their established behavior`
- **EXT-37e** Nonempty renamed input remains outside the empty-group extension and retains its
  generated value, replacing the later raw edit. Status: limit.
  - `[EXT-37e] limit: a nonempty renamed ${group} union still replaces the later raw edit`
- **EXT-37f** An open record, declaration, suspended schema or class alternative disables this
  extension even when an earlier closed member succeeds. Status: limit.
  - `[EXT-37f] limit: open, declared, suspended and class alternatives disable the empty ${group} extension`
- **EXT-37g** An iterable output sends yielded entries, not own generated fields; an absent output
  field supplies no evidence and permits the later raw value. Status: tested.
  - `[EXT-37g] control: ${group} unions require actual output and honor iterable entries`
- **EXT-37h** Comparing ordinary successful execution with the refusal preserves the constructor
  and field-codec callback trace exactly. Classification adds no evaluations. Status: tested.
  - `[EXT-37h] ${group}: generated-field refusal adds no constructor or field-codec callbacks`
- **EXT-37i** Headers compare names without case; query names retain exact spelling. A separately
  allowed uppercase query name remains distinct and reaches the wire. Status: tested.
  - `[EXT-37i] ${group}: raw name comparison preserves query spelling and folds header case`
- **EXT-37j** Invalid supplied values retain their original `SchemaError`, field path and empty
  ledger rather than becoming a generated-field refusal. Status: tested.
  - `[EXT-37j] control: invalid ${group} input keeps its original schema failure and never dispatches`

## Encoded input aliases in partly renamed structs

EXT-38 covers the public input typing repair accepted in
[#169](https://github.com/viell-dev/slop-effect-schema-http/issues/169), targeting unreleased 0.8.0.
Consumer-authored scenarios in `src/scenarios/encoded-input-aliases.test.ts` use the neutral echo
probe's [public contract](./README.md#the-neutral-echo-probe), Fetch in Node and Chromium, and
physical socket ledgers. Published 0.7.0 rejects the positive encoded `Request.Input` assignments
under strict TypeScript even though these valid calls already work at runtime. The repair retains
those wire outcomes: `"05"` becomes `5`, decoded `5` stays `5`, and omission generates `25`.
Singleton unions, all-string fields, required siblings and invalid names/value types have static
checks too. Invalid encoded values being replaced by defaults remain outside this repair;
[#170](https://github.com/viell-dev/slop-effect-schema-http/issues/170) is still unresolved.

- **EXT-38a** A partly renamed direct query accepts encoded input beside its unchanged optional
  sibling; decoded and omitted inputs retain their exact targets. Status: tested.
  - `[EXT-38a] a direct query accepts encoded aliases and retains decoded and omitted controls`
- **EXT-38b** A multiple-member query union retains the same encoded, decoded and omitted behavior.
  Status: tested.
  - `[EXT-38b] a query union accepts encoded aliases and retains decoded and omitted controls`
- **EXT-38c** Partly renamed direct headers accept encoded input, preserve the unchanged sibling,
  and retain decoded and omitted behavior. Status: tested.
  - `[EXT-38c] direct headers accept encoded aliases and retain decoded and omitted controls`
- **EXT-38d** A multiple-member header union retains the same fields and canonical values.
  Status: tested.
  - `[EXT-38d] a header union accepts encoded aliases and retains decoded and omitted controls`
- **EXT-38e** A discriminated query union exchanges `limit` and `page_size` between its members.
  Both encoded aliases remain available in public input types even though the complete union has
  the same keys on both sides. String values retain their exact `05` and `07` spelling. The initial
  `a56585f` candidate still rejects these valid typed calls; their runtime controls already pass.
  Status: tested.
  - `[EXT-38e] a query union retains encoded aliases exchanged between discriminated members`
- **EXT-38f** The same exchanged-alias union bound to headers sends each member's exact encoded
  name and value once, without the other alias or an omitted sibling. Status: tested.
  - `[EXT-38f] a header union retains encoded aliases exchanged between discriminated members`

## Encoded aliases beside optional constructor defaults

EXT-39 covers the visible-input defect in
[#170](https://github.com/viell-dev/slop-effect-schema-http/issues/170), independently through
`src/scenarios/encoded-default-loss.test.ts`. The consumer uses only the neutral echo probe's
[public contract](./README.md#the-neutral-echo-probe), Fetch in Node and Chromium, and physical
socket ledgers. A rejected encoded value must produce `SchemaError` before dispatch. Published
0.8.0 instead sends `page_size=25` for both `"many"` and `null`, under direct and union bindings;
it also replaces valid `"05"` with `25` beside a separately bound cursor. Valid encoded, decoded,
omitted-default and whole-side codec controls preserve their observed bytes.

- **EXT-39a** Direct and multiple-member query bindings refuse invalid text and explicit null under
  the encoded alias rather than generate the optional constructor default. Status: tested.
  - `[EXT-39a] a ${shape} query refuses invalid encoded aliases before dispatch`
- **EXT-39b** Direct and multiple-member header bindings refuse the same invalid values with no
  physical request. Status: tested.
  - `[EXT-39b] ${shape} headers refuse invalid encoded aliases before dispatch`
- **EXT-39c** Direct and union queries retain the encoded `"05"` to `5` conversion, decoded `5`,
  the renamed optional sibling and an omitted group's default `25`. Status: tested.
  - `[EXT-39c] a ${shape} query retains valid aliases, decoded input and omitted defaults`
- **EXT-39d** The same controls send each encoded header once, with neither decoded alias on the
  wire, and preserve method, target, empty body and exact request count. Status: tested.
  - `[EXT-39d] ${shape} headers retain valid aliases, decoded input and omitted defaults`
- **EXT-39e** A query union followed by a separate cursor binding keeps both `page_size=5` from
  encoded `"05"` and `cursor=next`; the sibling cannot excuse replacement by `25`. Status: tested.
  - `[EXT-39e] a stacked cursor binding preserves a valid encoded query alias`
- **EXT-39f** The corresponding header bindings send `page_size: 5` and `cursor: next` exactly
  once each. Status: tested.
  - `[EXT-39f] a stacked cursor binding preserves a valid encoded header alias`
- **EXT-39g** Whole encoded query input reads its unchanged Base64 field as encoded text. Decoded
  input writes the same canonical result; an ambiguous Base64 spelling beside decoded numeric
  input is encoded again. Both preserve whole-input priority rather than assuming an independent
  decoder for every alias. Status: tested.
  - `[EXT-39g] a whole encoded query keeps shared-type codec decoding priority`
- **EXT-39h** Whole encoded headers retain the same Base64 behavior and canonical numeric alias,
  with decoded and ambiguous shared-type controls. Status: tested.
  - `[EXT-39h] whole encoded headers keep shared-type codec decoding priority`

## Nested encoded input aliases

EXT-40 covers the public input typing defect in
[#172](https://github.com/viell-dev/slop-effect-schema-http/issues/172), independently through
`src/scenarios/nested-encoded-aliases.test.ts`. The consumer uses the neutral echo probe's
[public contract](./README.md#the-neutral-echo-probe), Fetch in Node and Chromium, and physical
socket ledgers. The 0.9.0 source baseline at `66fab8e` rejects nested `page_size` input with
TypeScript's excess-property error even though the runtime accepts it. Positive `Request.Input`
assignments and inferred `Operation.execute` calls remain unmasked so the repair must accept them
without changing bytes. The cases retain complete schema sides, without asserting arbitrary
recursive field mixing.
Unevaluated API calls also reject unknown nested names, wrong encoded primitive types, crossed
discriminated members and a public lookalike of a class with a private field.

- **EXT-40a** A nested partly renamed direct path accepts complete encoded and decoded sides.
  String `"05"` stays `05`, the unchanged sibling escapes a slash, and omitted optional fields
  retain the renderer's declared placeholders. Status: tested.
  - `[EXT-40a] a nested direct path accepts both complete sides and preserves literal text`
- **EXT-40b** A nested union retains an encoded alias and its decoded-name control, while its
  cursor alternative keeps a slash inside one path segment. Status: tested.
  - `[EXT-40b] a nested union path retains encoded aliases and its cursor alternative`
- **EXT-40c** A nested JSON-body schema accepts complete encoded and decoded sides and writes
  canonical numeric text `"5"`, UTF-8 sibling bytes and the encoded field name. Empty optional
  fields remain absent. Status: tested.
  - `[EXT-40c] a nested JSON body accepts both complete sides and writes canonical numeric text`
- **EXT-40d** A discriminated JSON-body union accepts its nested encoded alias, retains decoded
  and cursor-member controls, and keeps the static relationship between its tag and fields.
  Status: tested.
  - `[EXT-40d] a discriminated JSON body retains nested aliases and member correlation`
- **EXT-40e** Nested encoded path text `"many"` fails the finite-number schema. A deliberately
  type-invalid boolean fails too; both are `SchemaError` with no dispatch. Status: tested.
  - `[EXT-40e] invalid nested encoded path values still fail before dispatch`
- **EXT-40f** The JSON-body binding retains the same schema failures and empty ledger for invalid
  encoded text and a deliberately type-invalid boolean. Status: tested.
  - `[EXT-40f] invalid nested encoded JSON values still fail before dispatch`
- **EXT-40g** A visible nested partly renamed field with a constructor default refuses invalid
  encoded `"many"` with `SchemaError` before dispatch. Valid encoded `"05"` and decoded `5` send
  `5`; omission sends `25`. This covers the original
  [#170 nested-default report](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6729728316)
  under the bounded constructor repair of EXT-42, distinct from #172's earlier type-only change.
  The original 0.11.0 bad-dispatch baseline is retained separately. Status: tested.
  - `[EXT-40g] a nested invalid encoded value refuses before dispatch and retains valid controls`

## Encoded aliases lost during fieldwise preparation

EXT-41 covers the bounded breaking refusal subset accepted in
[#170's fieldwise assessment](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6729802994)
and its [0.10.0 recheck](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6730270545).
The independently authored `src/scenarios/fieldwise-alias-loss.test.ts` uses public input types and
inferred operation calls, the neutral echo probe's
[public contract](./README.md#the-neutral-echo-probe), Fetch in Node and Chromium, and physical
socket ledgers. The flat schema renames optional finite-number `limit` to `page_size`, gives it
constructor default `25`, and requires finite-number `count` and `offset`.

Published 0.10.0 at `ac5822d` dispatches `25` for invalid encoded `"many"` beside mixed common fields
`count: "07", offset: 9`. Valid `"05"` and same-default `"25"` aliases with those common fields
are also within the accepted refusal subset, as is invalid `"many"` with entirely encoded common
fields. These calls require `SchemaError` and an empty ledger. Positive controls retain their
exact observed bytes. This does not extend its proof to the nested constructor case in EXT-40g or
to general mixed-alias preservation; #170 remains open.

- **EXT-41a** Direct and root-union queries refuse all four supplied-alias cases rather than
  dispatch a generated `25`. Status: tested.
  - `[EXT-41a] a ${shape} query refuses supplied aliases lost by fieldwise preparation`
- **EXT-41b** Direct and root-union headers require the same schema failures and no dispatch.
  Status: tested.
  - `[EXT-41b] ${shape} headers refuse supplied aliases lost by fieldwise preparation`
- **EXT-41c** Direct and root-union queries retain complete encoded and decoded input, supported
  decoded-name mixing, omission and an explicit undefined encoded alias. The last two generate
  `25`; the other controls write `5`. Status: tested.
  - `[EXT-41c] control: a ${shape} query keeps complete sides, decoded-name mixing and defaults`
- **EXT-41d** The corresponding header controls preserve canonical numeric text, one line per
  encoded name, empty body and exact request count. Status: tested.
  - `[EXT-41d] control: ${shape} headers keep complete sides, decoded-name mixing and defaults`
- **EXT-41e** A direct filter query beside a separate cursor binding refuses the invalid mixed
  alias, with either binding first. A sibling cannot excuse the overwrite. Status: tested.
  - `[EXT-41e] query siblings with ${order} cannot excuse the fieldwise alias loss`
- **EXT-41f** The corresponding header bindings refuse before dispatch in both orders.
  Status: tested.
  - `[EXT-41f] header siblings with ${order} cannot excuse the fieldwise alias loss`
- **EXT-41g** Direct filter and cursor query bindings preserve decoded and supported decoded-name
  mixed input in both orders, including each binding's exact outgoing fields. Status: tested.
  - `[EXT-41g] control: query siblings with ${order} retain decoded and mixed decoded-name values`
- **EXT-41h** The header siblings preserve the same values once each in both orders.
  Status: tested.
  - `[EXT-41h] control: header siblings with ${order} retain decoded and mixed decoded-name values`
- **EXT-41i** An earlier raw query default has no caller alias witness. Without a constructor
  default, raw `"05"` becomes `5` and raw `"many"` is `InvalidRequest` without dispatch. A
  constructor default legitimately replaces either raw value with `25`. Status: tested.
  - `[EXT-41i] control: earlier raw query defaults remain distinct from supplied aliases`
- **EXT-41j** Earlier raw header defaults preserve the same validation and replacement behavior,
  with exact physical lines and request counts. Status: tested.
  - `[EXT-41j] control: earlier raw header defaults remain distinct from supplied aliases`
- **EXT-41k** A root union of filter and cursor, stacked with cursor, still refuses complete
  encoded query input in both binding orders. Its `SchemaError` and empty ledger remain a separate
  selection/certificate limit under [#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143).
  Status: limit.
  - `[EXT-41k] limit: a root union beside a cursor still refuses whole encoded query input`
- **EXT-41l** The same root-union/cursor combination retains its whole-encoded header refusal in
  both orders, outside this repair. Status: limit.
  - `[EXT-41l] limit: a root union beside a cursor still refuses whole encoded header input`
- **EXT-41m** Direct and root-union path bindings refuse the flat mixed invalid alias before
  dispatch. Baseline 0.10.0 instead sends `/x/page/25/7/9`. Status: tested.
  - `[EXT-41m] a ${shape} path refuses a supplied alias lost by fieldwise preparation`
- **EXT-41n** Direct and root-union JSON-body bindings refuse the same flat input before dispatch.
  Baseline 0.10.0 instead writes `{"page_size":"25","count":"7","offset":"9"}`. Status: tested.
  - `[EXT-41n] a ${shape} JSON body refuses a supplied alias lost by fieldwise preparation`
- **EXT-41o** Complete encoded and decoded path input retains canonical `/x/page/5/7/9`, with
  empty body and exact request count. Status: tested.
  - `[EXT-41o] control: a ${shape} path retains complete encoded and decoded values`
- **EXT-41p** Complete encoded and decoded JSON-body input retains its canonical bytes, JSON
  content type, method, target and request count. Status: tested.
  - `[EXT-41p] control: a ${shape} JSON body retains complete encoded and decoded values`

## Nested constructor-default aliases through transparent objects

EXT-42 covers the bounded constructor-only subset accepted in
[#170's nested assessment](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6730758484).
The independently authored `src/scenarios/nested-constructor-defaults.test.ts` uses only public
schemas and operation inputs, the neutral echo probe's
[public contract](./README.md#the-neutral-echo-probe), Fetch in Node and Chromium, and socket
ledgers. Published 0.11.0 at `8ae8fb3` substitutes `25` for nested `"many"` and `null` under direct,
deeper transparent-object and terminal child-union shapes. Covered calls require `SchemaError`
without dispatch; encoded `"05"`, decoded `5` and omitted defaults retain their actual bytes.
The cases preserve whole-constructor priority and require one stable input path with an actual
corresponding terminal output write. They do not assert general recursive fieldwise recovery.

- **EXT-42a** A required unchanged outer `filter` contains a direct or child-union terminal schema
  with a renamed optional finite-number limit and constructor default. Invalid aliases refuse on
  paths, including ordinary/null-prototype/frozen objects and nonenumerable own-data ancestor or
  alias properties. Explicit null is a deliberate runtime-negative input. Status: tested.
  - `[EXT-42a] ${shape} nested path aliases refuse invalid values in stable own-data inputs`
- **EXT-42b** The same terminal shapes and own-data profiles refuse before JSON-body dispatch.
  Status: tested.
  - `[EXT-42b] ${shape} nested JSON aliases refuse invalid values in stable own-data inputs`
- **EXT-42c** Encoded and decoded path controls retain `5`, omission retains `25`, and supplying
  the decoded name still wins beside its encoded twin. The unchanged text sibling escapes a slash.
  Status: tested.
  - `[EXT-42c] control: ${shape} nested path input retains encoded, decoded and omitted values`
- **EXT-42d** JSON-body controls retain the same values, exact field names, JSON content type,
  body bytes and request count. Status: tested.
  - `[EXT-42d] control: ${shape} nested JSON input retains encoded, decoded and omitted values`
- **EXT-42e** Several finite explicit object fields lead to the invalid terminal path alias.
  Frozen ancestors and explicit null remain covered. Status: tested.
  - `[EXT-42e] transparent object ancestors retain the nested path refusal`
- **EXT-42f** The corresponding deeper JSON input refuses without dispatch. Status: tested.
  - `[EXT-42f] transparent object ancestors retain the nested JSON refusal`
- **EXT-42g** Deeper path controls preserve complete encoded/decoded input and omitted defaults.
  Status: tested.
  - `[EXT-42g] control: transparent ancestors preserve complete encoded and decoded paths`
- **EXT-42h** Deeper JSON controls preserve the complete encoded structure and canonical bytes.
  Status: tested.
  - `[EXT-42h] control: transparent ancestors preserve complete encoded and decoded JSON`
- **EXT-42i** An omitted optional outer field remains absent; a defaulted outer field uses its
  declared decoded value. Supplying an empty inner object invokes only its normal default. None
  creates an encoded caller witness. Status: tested.
  - `[EXT-42i] control: absent optional and defaulted outer path fields invent no caller witness`
- **EXT-42j** The same outer-omission cases retain their distinct JSON outputs. Status: tested.
  - `[EXT-42j] control: absent optional and defaulted outer JSON fields invent no caller witness`
- **EXT-42k** Root fieldwise preparation genuinely decodes nested `page_size: "05"` and
  `gate: "03"` beside mixed outer numbers and an opaque Option with a stray field. The path keeps
  `5` and `3`; shared Base64 text retains its prior decoded-string interpretation and writes
  `YUdrPQ==`. The actual baseline callback order stays exact. Status: tested.
  - `[EXT-42k] control: actual fieldwise nested decoding retains path meaning and callback order`
- **EXT-42l** The same counterexample preserves JSON bytes, normalized Option output and the
  same baseline callback sequence. It cannot authorize the new constructor-only proof.
  Status: tested.
  - `[EXT-42l] control: actual fieldwise nested decoding retains JSON meaning and callback order`
- **EXT-42m** A constructor callback replaces an ancestor, changes its descriptor or prototype,
  or changes the terminal alias. These unstable inputs retain their original `25` output and
  callback sequence; the new proof adds no decoding attempt. Status: tested.
  - `[EXT-42m] control: ${mutation} changes during construction cannot authorize new nested decoding`
- **EXT-42n** Replacing an ancestor while a constructor default is awaiting a Deferred retains
  the baseline route and exact callbacks. Synchronization uses no sleep. Status: tested.
  - `[EXT-42n] control: an ancestor replaced while a default waits retains the baseline route`
- **EXT-42o** An actual field encoder replaces the left caller object and writes its field, while
  a deliberately one-way right encoder omits its still-stable field. The original right-field loss
  remains a `SchemaError` with no dispatch and the exact baseline callback sequence: separate
  stable and written candidates cannot authorize another whole decoder. The right codec's reverse
  explicitly fails. Status: tested.
  - `[EXT-42o] control: stale written left and stable unwritten right are not one witness`
- **EXT-42p** A finite closed parent union refuses an invalid nested alias before dispatch.
  Published 0.12 baseline overwrote it with `25`; retained Node/Chromium reports reproduce that
  defect before this assertion changed. Status: tested.
  - `[EXT-42p] a closed parent union refuses its invalid nested alias`
- **EXT-42q** A stable dense array ancestor refuses its invalid nested alias under the later
  accepted EXT-44 extension. The original 0.13 default-overwrite pin passed in both lanes before
  conversion; reports remain under `artifacts/array-default-013-ext42q-*`. Status: tested.
  - `[EXT-42q] a stable dense array ancestor refuses its invalid nested alias`
- **EXT-42r** A terminal child union preserves its cursor alternative in both path and JSON-body
  input, including slash escaping, exact bytes and request count. Status: tested.
  - `[EXT-42r] control: a terminal child union preserves its cursor alternative on path and body`

## Closed parent-union constructor defaults (EXT-43)

Consumer-authored from the accepted [#170 parent-union subset](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6732380757)
and the README's neutral echo contract. All exchanges use its real socket listener. Published
0.12 baseline reports are retained under `artifacts/parent-union-012-*`; desired refusals fail
on that baseline. These checks do not establish general parent ownership or fieldwise recovery.

- **EXT-43a** Root, reversed and exact shared-field parent unions refuse invalid text/null path
  aliases in ordinary, frozen, null-prototype and nonenumerable own-data inputs, with no dispatch.
  Status: tested.
  - `[EXT-43a] ${name} parent union refuses invalid stable path aliases`
- **EXT-43b** The same independent matrix checks JSON-body refusal and empty ledgers.
  Status: tested.
  - `[EXT-43b] ${name} parent union refuses invalid stable JSON aliases`
- **EXT-43c** Encoded, decoded, omitted and decoded-name-priority inputs retain canonical JSON
  bytes, headers, method, target and exact request counts. Status: tested.
  - `[EXT-43c] ${name} preserves encoded decoded default and alternate inputs`
- **EXT-43d** Parent unions at two deeper positions retain the invalid-alias refusal.
  Status: tested.
  - `[EXT-43d] nested parent unions refuse invalid aliases without dispatch`
- **EXT-43e** Cursor, deeper alternate and complete encoded inputs keep exact path escaping,
  JSON bytes, headers and counts. Missing filter declarations invent no ownership. Status: tested.
  - `[EXT-43e] parent cursor and deeper other branches preserve wire bytes`
- **EXT-43f** Distinct finite/default filter declarations still overwrite invalid text with 25.
  This is a current #170 defect pin, not an intended guarantee; revisit with a broader proof.
  Status: defect.
  - `[EXT-43f] currently distinct filter declarations retain the ambiguous default overwrite`
- **EXT-43g** Required inner gate forces genuine nested decoding during member fieldwise
  preparation beside mixed outer fields and an opaque Option. The alias keeps 8 while shared
  Base64 text keeps its prior decoded-text meaning; callbacks and full wire bytes are checked.
  Status: tested.
  - `[EXT-43g] member fieldwise consumption keeps callback and shared text interpretation`
- **EXT-43h** Whole parent decoding newly refuses a valid alias beside decoded numeric input
  and reads shared Base64 text on its encoded side. Complete decoded inputs retain prior meaning.
  This intentional migration consequence is asserted independently of invalid-alias checks.
  Status: tested.
  - `[EXT-43h] whole parent decoding refuses valid mixed aliases and reads shared text on its encoded side`
- **EXT-43i** A suspended parent retains the current invalid-alias overwrite. This is an
  unsupported #170 defect pin, not a schema guarantee. Status: defect.
  - `[EXT-43i] currently a suspended parent retains its unsupported overwrite`
- **EXT-43j** Distinct symbols with the same description declare different parent fields.
  Invalid nested aliases refuse without dispatch; a valid alias and the other symbol's member
  retain canonical and slash-escaped paths. Status: tested.
  - `[EXT-43j] equal symbol descriptions retain distinct parent field identities`
- **EXT-43k** A numeric-looking declared field carries the parent-union witness without losing
  field identity. Invalid input refuses; encoded, decoded and omitted controls keep exact paths,
  headers, empty body bytes and counts. Status: tested.
  - `[EXT-43k] numeric parent field preserves invalid valid and default paths`
- **EXT-43l** An unknown cyclic nested extra does not hide invalid aliases or prevent a valid
  alias path. The renderer reads only declared encoded output; the caller graph is neither cloned
  nor serialized, and its cycle and object identities remain intact. Status: tested.
  - `[EXT-43l] unknown cyclic nested extras neither hide invalid aliases nor prevent valid paths`
- **EXT-43m** Ordinary `StructWithRest` declares numeric `1` and string `"1"` with different
  field schemas. The combined test covers that member directly, under `Struct({ page: member })`,
  and in a parent union. Each route first checks encoded/decoded/default controls and exact path,
  headers, empty body and counts. Published 0.12 refuses bad `wire: "many"` in direct/wrapped forms;
  candidate `1fe92e4` newly sends generated `25`. The parent union already substituted `25` on 0.12.
  This is a newly exposed kept-or-refused defect under #170, not unchanged or intended behavior.
  The [public disposition](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6733524389)
  accepts excluding ambiguous declarations from the proof and retains broader correspondence work.
  The public path API avoids Effect JSON-codec conversion's rejection of numeric AST field names.
  Baseline and candidate reports are retained as `artifacts/parent-union-p2-direct-*`.
  Status: defect.
  - `[EXT-43m] currently normalized numeric and string declarations retain their unproved overwrite`

## Stable dense array and tuple constructor defaults (EXT-44)

Consumer-authored from the accepted [#170 array/tuple subset](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6734230849),
the public 0.13 design, request guide, limits and migration, existing consumer fixtures, and the
README's [neutral echo contract](./README.md#the-neutral-echo-probe). No backend, conformance,
library implementation or private design evidence informed this authorship. The tests use public
schemas and operation execution through Fetch over real neutral echo sockets in Node and Chromium.
These synthetic agent checks do not establish human expectations or human use.

Published 0.13.0 at `d66a70fcc6b3d37e7bc169ccb4a2dfd06b389911` substitutes constructor defaults
for covered invalid array aliases. Reports under `artifacts/array-default-013-*` preserve passing
complete-side/default/alternate controls before desired refusals, the original EXT-42q pin, and
exploratory failures. Exact method, target, relevant header lines, body bytes and counts are asserted.
Covered invalid text/null requires `SchemaError` and no additional dispatch. This constructor-only
extension does not establish general per-element recovery, array-shaped union ancestry,
transformed-group ownership, or unsupported member/final-fieldwise repairs.

- **EXT-44a** Root, last index, double and wrapped arrays; forward/reversed object unions;
  terminal element unions; fixed, prefix, homogeneous-rest and post-rest tuples with zero/two
  rest positions; and an optional tuple position retain complete encoded/decoded, inner default
  and decoded-name-priority controls on path and JSON. Multi-element fixtures choose complete-side
  companion values explicitly. Status: tested.
  - `[EXT-44a] ${fixture.name} controls preserve encoded decoded default and priority bytes`
- **EXT-44b** Every EXT-44a shape first dispatches a complete encoded control through the same
  operation, then refuses text/null in ordinary, null-prototype, frozen, nonenumerable-position and
  nonenumerable-alias own-data profiles without further dispatch. Failure evidence includes the
  original received method, target, header lines and body. Status: tested.
  - `[EXT-44b] ${fixture.name} ${binding} refuses invalid stable aliases without dispatch`
- **EXT-44c** Stable profiles preserve a valid alias; terminal cursor and parent cursor alternatives
  retain slash escaping, exact JSON and counts. Status: tested.
  - `[EXT-44c] stable profiles retain valid aliases and terminal or parent alternatives`
- **EXT-44d** An absent optional tuple position remains absent, a supplied empty terminal gets its
  constructor default, and an encoded companion forcing ordinary whole decoding leaves another
  omitted limit absent. These routes have distinct existing bytes. Status: tested.
  - `[EXT-44d] omitted optional positions and whole encoded omission retain distinct meanings`
- **EXT-44e** Accessor, inherited-index, subclass and custom-iterator arrays retain their current
  invalid-alias default overwrite on path and JSON. The custom iterator is never invoked; accessor
  reads belong to existing schema execution. These are unsupported defect pins, not intended
  guarantees. Status: defect.
  - `[EXT-44e] currently ${shape} arrays retain their unsupported default overwrite`
- **EXT-44f** A sparse array with optional elements refuses an invalid alias in its stable own
  cell without dispatch, retaining the caller's hole and lack of own index zero. The original
  default-overwrite pin remains in baseline reports before the EXT-47 combined repair.
  Status: tested.
  - `[EXT-44f] sparse own-cell aliases refuse instead of dispatching constructor defaults`
- **EXT-44g** A union containing an array-shaped ancestor retains its unproved default overwrite;
  the object cursor alternative retains exact path and JSON. Status: defect.
  - `[EXT-44g] currently an array-shaped union ancestor retains its unproved overwrite`
- **EXT-44h** A tail constructor default appends a position or swaps earlier booleans. The length
  change retains the existing schema/loss refusal without dispatch; the order change retains the
  pre-existing default output. Each performs exactly one default callback. Status: tested.
  - `[EXT-44h] ${mutation} changes during a tail default retain their original constructor route`
- **EXT-44i** Unknown cyclic terminal extras neither prevent a valid path nor hide a covered
  invalid alias. Caller references and the cycle remain intact; rendering sees only the schema's
  encoded result. Status: tested.
  - `[EXT-44i] unknown cyclic extras preserve caller identity and cannot hide covered aliases`
- **EXT-44j** Required inner gates force real member-fieldwise decoding of an array beside mixed
  common fields and an opaque Option. Aliases retain 8/2, shared Base64 text retains its decoded
  meaning, and the existing callback sequence and normalized JSON remain exact. Status: tested.
  - `[EXT-44j] actual member fieldwise array consumption preserves shared decoded text`
- **EXT-44k** Added whole-group validation can refuse an otherwise valid default-valued alias
  beside decoded numeric input. Complete decoded values and a named mapping validated by Schema
  retain prior text meaning; invalid mapping input refuses before dispatch. Status: tested.
  - `[EXT-44k] whole array decoding refuses valid mixed input while complete sides and named mapping retain meaning`
- **EXT-44l** Actual whole construction performs its default once before validation selects shared
  Base64 text's encoded-side meaning. Complete decoded input retains double encoding. Status: tested.
  - `[EXT-44l] whole array decoding selects encoded shared text after its actual constructor`
- **EXT-44m** Mixed array members previously sent 2/25 for supplied decoded 2 and encoded `"05"`.
  Complete encoded and decoded controls retain 2/5; the added whole-group check refuses the mixed
  runtime probe. Whole-side array input types already exclude this particular mixed literal.
  Status: tested.
  - `[EXT-44m] mixed array members refuse instead of replacing valid encoded text`
- **EXT-44n** A nonempty identity group transformation between explicitly decoded array schemas
  retains its current invalid-alias default overwrite. This is an unsupported defect pin, not
  permission to infer correspondence through the transformation. Status: defect.
  - `[EXT-44n] currently transformed array groups retain their unsupported overwrite`
- **EXT-44o** The [public dual-name reproduction](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6735302019)
  uses a nonliteral array input that typechecks without a cast:
  `[{ limit: 1, page_size: "02" }, { page_size: "25" }]`. Published 0.13 sends 1/25 on both path and
  JSON; the added whole encoded read sends 2/25. Five controls retain their exact bytes first:
  complete encoded/decoded input, one dual-name member, and a dual-name member with a decoded or
  omitted/default sibling. Each operation dispatches six requests with exact method, target,
  relevant headers and body bytes. This migration pin records a changed choice within #143's open
  conflicting-alias limit; it does not establish conflict refusal, equality, or a solved gap.
  Paired reports remain under `artifacts/array-default-{013,ccca2c1}-p2-*`. Status: limit.
  - `[EXT-44o] currently ${binding} whole array decoding changes a typed neighboring dual-name choice`
- **EXT-44p** An own enumerable `Symbol.iterator`, created by assigning the normal Array iterator,
  produced the [#189 normalization defect](https://github.com/viell-dev/slop-effect-schema-http/issues/189)
  on published 0.13/0.14: evaluation-time `Die(TypeError)`, zero calls and no dispatch. Those exact
  baselines remain in `artifacts/array-default-*-p2-*` and `artifacts/array-key-014-existing-*`.
  Following the [public disposition](https://github.com/viell-dev/slop-effect-schema-http/issues/189#issuecomment-6737041284),
  the unreleased key repair exposes the existing unsupported #170 default 25 for invalid text;
  the original valid encoded/decoded controls each write 5. Native/watched iterator and path/JSON
  cases retain all three old inputs and zero calls. The later EXT-47 combined repair splits the
  iterator profiles: exact native own data refuses the invalid alias and sends the two valid
  controls; the watched wrapper still sends all three requests, including its unsupported default.
  Unchanged candidate reports preserve the exact first pin failures before that conversion.
  Status: defect.
  - `[EXT-44p] ${binding} exact native own iterator refuses invalid aliases and retains valid controls`
  - `[EXT-44p] currently ${binding} watched own iterator retains its unsupported default and valid controls`

## Array keys and normalization layout (EXT-45)

Independent consumer authorship from public [#189](https://github.com/viell-dev/slop-effect-schema-http/issues/189),
its [published 0.14 scope record](https://github.com/viell-dev/slop-effect-schema-http/issues/189#issuecomment-6736766714),
[#191](https://github.com/viell-dev/slop-effect-schema-http/issues/191), published 0.14 design/limits/version
documentation, existing consumer fixtures and the README's
[neutral echo contract](./README.md#the-neutral-echo-probe). No library implementation, unit tests,
backend, conformance, lead probes or private design evidence informed this context. These synthetic
agent observations are not human expectations or human use.

Published 0.14.0 at `829c09c7bc2e8f5fad91c4771f3a7aa77a7db669` supplies the retained baseline
under `artifacts/array-key-014-*`. Before new work, all 61 EXT-44 tests, including the four original
EXT-44p TypeError pins, passed in both lanes. Those baselines remain intact; the four EXT-44p pins
were later converted only for the documented failure-channel change. Physical Fetch
requests use exact method, target, relevant header lines, body bytes and counts in Node and Chromium.
Caller lengths, own keys, descriptors, data-cell identities and holes are checked without cloning
the graph or invoking getters during those checks. No new constructor-default proof is assumed.
The [paired public disposition](https://github.com/viell-dev/slop-effect-schema-http/issues/191#issuecomment-6736959994)
authorizes the unreleased layout correction and explicitly retains the exposed sparse and iterable
#170 default losses. Original tests were run unchanged against checkpoint `e95c7aa`: both lanes
had exactly 12 current-pin failures and 122 passes, including all 48 formerly failing repair goals.
Only then were the documented pins converted. Final checkpoints are not published releases.
The later public proxy-boundary extension under EXT-45r–u retains separate 0.14 and first-checkpoint
reports. Prepared source `8a3083edea2f7292bee381192ed2ddd0dddeacac` passes 149 ordinary cases plus
the same four expected #170 failures in each source lane (153 focused cases). Packing and complete
suite/release qualification remain separate.
Fresh public review later rejected that 8a checkpoint for a mixed opaque/array boundary outside
those inputs. EXT-45v–z and EXT-46 retain the
[finding](https://github.com/viell-dev/slop-effect-schema-http/issues/191#issuecomment-6738794582)
and the [bounded follow-up contract](https://github.com/viell-dev/slop-effect-schema-http/issues/191#issuecomment-6739062465)
through separate published-0.14/8a observations before pairing the next frozen source. The four
existing #170 expected goals and all earlier evidence remain unchanged.
Frozen follow-up `dbfd8a48bc2845d3f3d0c053bfb770dc0176745f` passes all 176 ordinary plus the same
four expected #170 cases in each source lane (180 focused cases), including the 27 mixed-boundary
and length additions. This remains consumer source evidence; final pin, packing, complete suite
qualification and publication are separate.

The EXT-47 combined constructor repair at frozen source `24de284595c4d3044f632f9ec31d0629c0a21b84`
later supersedes sparse-own-cell and exact-native-iterator overwrite pins. Its unchanged Node and
Chromium runs are retained under `artifacts/constructor-input-24de284-unchanged-*` before conversion.
EXT-45p now splits native ordinary refusal checks from two retained watched-wrapper expected
failures. Arbitrary iterator and private/custom-prototype evidence remains excluded.

- **EXT-45a** Plain encoded, decoded, encoded/decoded inner-stray, omitted-default and empty arrays
  retain their ordinary wire bytes on both bindings. Status: tested.
  - `[EXT-45a] ${binding} complete-side and omission controls retain ordinary array bytes`
- **EXT-45b** Without an inner rewrite, ordinary `audit` metadata is ignored, sparse optional
  position zero remains a JSON null, and a readable own nonenumerable cell remains present.
  These exact #191 controls retain caller identity and layout. Status: tested.
  - `[EXT-45b] ${binding} ${layout} layout without an inner rewrite preserves actual cells`
- **EXT-45c** Inner rewriting preserves the valid #191 caller layout: metadata adds no cell,
  sparse input sends null/5, and an own nonenumerable prefix sends 7/5. The original 0.14 phantom
  `[1]` refusal and compacted/dropped `[5]` pins were preserved before conversion. Original EXT-45c
  and EXT-45d used identical fixtures; six shared tests now retain both IDs and the full caller and
  wire assertions. No distinct input or control was removed. Status: tested.
  - `[EXT-45c] [EXT-45d] ${binding} ${layout} inner rewriting preserves real layout without phantom cells`
- **EXT-45d** The original baseline-failing valid-layout goals are now the same six shared tests
  as EXT-45c. Exact outputs, request counts, caller identity, descriptors, lengths and holes remain
  checked; the separate no-inner-rewrite controls remain under EXT-45b. Status: tested.
  - `[EXT-45c] [EXT-45d] ${binding} ${layout} inner rewriting preserves real layout without phantom cells`
- **EXT-45e** Valid complete encoded and decoded inner-stray inputs with enumerable normal/watched
  iterators, ordinary symbols, `Symbol.toStringTag`, undefined-valued symbols, hidden symbols and
  two distinct symbols with equal descriptions follow ordinary schema reading. Root arrays cover
  every profile; fixed/prefix/rest/tail tuples cover normal iterators and ordinary symbols. Symbols
  and descriptors retain their identities and watched iterators stay uncalled. On 0.14 only the
  hidden-symbol profile passes; other selected profiles show the symbol-coercion defect.
  Status: tested.
  - `[EXT-45e] ${binding} ${position.name} ${shape} valid input follows ordinary schema reading`
- **EXT-45f** Valid encoded/decoded array and fixed/prefix/rest/tail input must never append string
  metadata as an element during inner normalization. Root arrays also cover non-index names `01`,
  `-1`, `1.0` and `4294967295`; none changes the caller's length. Status: tested.
  - `[EXT-45f] ${binding} ${position.name} string metadata cannot become an extra tuple cell`
- **EXT-45g** Cyclic non-index metadata remains outside actual cells. The 0.14 phantom-cell
  refusal is retained as failure evidence; the repair goal requires only the valid declared cell
  on the wire and preserves the cycle and caller references. Status: tested.
  - `[EXT-45g] ${binding} cyclic non-index metadata stays outside the real cells`
- **EXT-45h** Dense ordinary arrays with ordinary own-data symbols or `Symbol.toStringTag` metadata
  and invalid text/null aliases refuse with `SchemaError` and no dispatch. Published 0.14 produces a
  TypeError defect; this adds no custom-iterator or sparse constructor proof. Status: tested.
  - `[EXT-45h] ${binding} covered invalid aliases with non-iterator symbol metadata refuse without dispatch`
- **EXT-45i** A hidden custom iterator retains the separately unsupported #170 invalid-alias
  default 25 with zero calls. Its descriptor and caller data remain intact. This current limit is
  separate from valid enumerable-iterator goals and original EXT-44p pins. Status: defect.
  - `[EXT-45i] currently ${binding} hidden iterators retain their unsupported default meaning`
- **EXT-45j** The 0.15 layout correction sent null/25 both with and without inner stray. Published
  0.14 refused the inner-stray call after faulty compaction; that exact report is retained. The
  [public #170 disposition](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6736960353)
  identifies this refusal-to-default consequence as an exposed unsupported route, not repaired
  input preservation or a sparse constructor proof. The later accepted own-cell repair refuses
  both exact inputs without dispatch, preserving caller hole/identity checks. Earlier received
  requests and first candidate failures remain in reports; EXT-45q is now also an ordinary check.
  Status: tested.
  - `[EXT-45j] ${binding} sparse invalid aliases refuse with and without inner rewriting`
- **EXT-45k** A plain text-array schema without reader-choice normalization preserves bytes and
  leaves an enumerable symbol-metadata getter uncalled. This is an observed narrow control,
  not a general no-getter promise. Status: tested.
  - `[EXT-45k] ${binding} plain text arrays bypass rewriting and retain metadata access observations`
- **EXT-45l** Two declared object symbols with the same description remain distinct. The path
  consumes each declared field correctly, and invalid input's actual schema issue path contains
  the first symbol itself, neither the second symbol nor a stringified symbol name. This path-only
  control does not claim canonical JSON support for declared symbol fields. Status: tested.
  - `[EXT-45l] declared object symbols retain identity in path reading and error locations`
- **EXT-45m** A real numeric position containing an invalid element remains a `SchemaError` at
  position one with no dispatch. A metadata correction must not discard actual index cells.
  Status: tested.
  - `[EXT-45m] ${binding} a real numeric cell remains subject to its element schema`
- **EXT-45n** Valid encoded/decoded inherited numeric prefix cells remain readable with and without
  an inner rewrite. The wire retains 7/5 while the caller keeps its prototype, length, inherited
  ownership and both cell identities. This validates ordinary schema reading, not inherited-array
  constructor-default evidence. Status: tested.
  - `[EXT-45n] ${binding} valid inherited numeric cells remain readable with and without rewriting`
- **EXT-45o** Native/watched enumerable iterators on arrays, fixed tuples and post-rest tuples
  retain text/null cases with and without inner stray data. Exact native data now refuses all four
  inputs without dispatch; arbitrary watched wrappers retain four unsupported default-25 requests.
  Both profiles check zero iterator calls and unchanged caller descriptors.
  The [public finding](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6737040870)
  records the earlier TypeError-to-default change; EXT-45p keeps the corresponding checks separate.
  Status: defect.
  - `[EXT-45o] ${binding} ${position.name} native iterator invalid aliases refuse without dispatch`
  - `[EXT-45o] currently ${binding} ${position.name} watched iterator invalid aliases expose unsupported defaults`
- **EXT-45p** The exact native enumerable-iterator fixtures of EXT-45o now require ordinary typed
  refusal without dispatch. Watched arbitrary wrappers remain separate expected-failure #170
  goals: their current output is still generated 25. Each profile retains all twelve original
  inputs per binding; no selected case is skipped. Earlier plain failures and the first unchanged
  candidate run remain in reports. This does not establish arbitrary-iterator evidence or release
  qualification.
  Status: defect.
  - `[EXT-45p] ${binding} invalid enumerable native iterator aliases refuse before dispatch`
  - `[EXT-45p] goal ${binding} invalid enumerable watched iterator aliases are kept or refused`
- **EXT-45q** The exact sparse own-cell invalid aliases of EXT-45j, with and without inner
  rewriting, now refuse without dispatch under the combined constructor repair. Original
  `[null,25]` requests and plain baseline failures remain in reports. Caller holes, descriptors
  and identities remain unchanged. Status: tested.
  - `[EXT-45q] ${binding} invalid sparse own aliases refuse with and without rewriting`
- **EXT-45r** A fully own dense `Array(Filter)` proxy whose `getPrototypeOf` throws retains valid
  encoded 5, with and without inner stray data, on path and JSON. Published 0.14 succeeds; first
  checkpoint `e95c7aa` adds an unnecessary failing walk. The
  [public follow-up](https://github.com/viell-dev/slop-effect-schema-http/issues/191#issuecomment-6738312287)
  restores the old result. Tests assert exact requests and caller length/cell/descriptor identities,
  without deep-matching the throwing proxy or promising a total reflection count. Status: tested.
  - `[EXT-45r] ${binding} fully own dense proxy arrays retain valid alias reading when prototype reflection throws`
- **EXT-45s** An opaque proxy array behind `Schema.Unknown` retains its identity inside a parent
  with an actual key rename and encoded finite count. Its length/prototype traps throw if read;
  neither is inspected. The path renderer reads only encoded count 5 and confirms the opaque
  reference, with exact `/x/count/5` wire evidence. This path-only control exercises normalization;
  it does not claim JSON can serialize a throwing array. Status: tested.
  - `[EXT-45s] an opaque throwing array retains identity behind a parent rename and encoded count`
- **EXT-45t** A legal proxy reports own index `1000` while its actual array length remains one,
  with coherent key/descriptor/get/has traps apart from that explicit contradiction. The no-stray
  control keeps one real cell. With inner stray, the follow-up refuses with `SchemaError` before
  render/dispatch; old 0.14 manufactured two cells and `e95c7aa` manufactured 1001. Reports retain
  received bytes and delivered lengths/positions, and the caller remains unchanged. Real native
  indices remain subject to EXT-45m. Status: tested.
  - `[EXT-45t] ${binding} a virtual own index beyond array length keeps its control and refuses incoherent rewriting`
- **EXT-45u** A length-two sparse proxy with own valid position one and inner stray throws its
  original Error from `getPrototypeOf`. The necessary prototype walk propagates that same object
  as one evaluation-time `Die`, with no rendering or dispatch; `execute` itself returns normally.
  Published 0.14 instead dispatched after faulty compaction. This explicit sparse-reflection bound
  is distinct from typed schema refusal, dense/opaque controls and constructor-default evidence.
  Paired proxy reports use `artifacts/array-key-{014,e95c7aa}-proxy-*`. Status: tested.
  - `[EXT-45u] ${binding} sparse proxy prototype failure propagates its original evaluation defect`
- **EXT-45v** Unknown, Any, ObjectKeyword, accepting Declaration and a rejected-array-first union
  preserve ordinary hidden/inherited cells through the actual opaque alternative. A meaningful
  renamed parent with encoded finite count exercises normalization. Both array/cell identities and
  `additional: "retain"` reach the renderer and exact HTTP path; the caller also remains intact.
  Published 0.14 retains those ten observations, while 8a loses the field and identities.
  Status: tested.
  - `[EXT-45v] ${name} keeps ${profile} opaque array cells and extras before reading another alternative`
- **EXT-45w** The same five mixed views already normalize enumerable cells on published 0.14.
  Their normalized clones omit the extra and retain encoded VALUE 5. Exact identities, caller
  preservation and wire bytes pin that existing interpretation, rather than promising a general
  opaque bypass. Status: tested.
  - `[EXT-45w] control ${name} enumerable mixed cells retain their existing normalized interpretation`
- **EXT-45x** Rejecting checked-Unknown and Declaration alternatives do not prevent subsequent
  visible-array reading. Complete encoded/decoded dense cells with inner extras and audit metadata
  succeed; invalid numeric cells refuse with `SchemaError` and no extra dispatch. Predicate calls
  are observed without a brittle exact count. Closed-array controls isolate the same layout
  correction. Unknown/closed cases cover path and JSON; the Declaration uses the path API directly.
  Status: tested.
  - `[EXT-45x] ${binding} ${opaque} rejection still permits valid dense array reading and rejects invalid cells`
- **EXT-45y** An accepting opaque alternative in a mixed view keeps prior success without reading
  throwing length, hidden-cell or prototype traps. Hidden profiles retain original array identity;
  the prototype profile contains an enumerable rewriting cell and retains its existing normalized
  clone. The initial over-broad identity assertion and failed 0.14 observation are preserved before
  that fixture assertion was corrected under the public enumerable-control rule. Renderers consume
  only count, avoiding serialization or deep comparison of the throwing proxy. Status: tested.
  - `[EXT-45y] an accepting opaque alternative avoids ${reflection} reflection through a mixed array view`
- **EXT-45z** A Declaration backed by an encoded unknown-element array retains ordinary reading
  when a sparse proxy throws on prototype inspection. The declaration's identity mapping has a
  direct public-Schema round-trip and invalid non-array control. The HTTP path consumes only the
  parent's encoded count and preserves caller layout. Published 0.14 passes; 8a newly dies.
  Status: tested.
  - `[EXT-45z] an encoded-array-backed Declaration keeps ordinary reading without unnecessary prototype reflection`

## Mixed-view clone and readable-length controls (EXT-46)

These are additional physical-wire controls from the same public mixed-view follow-up. They do not
establish broader opaque/array correspondence or a constructor-default proof.

- **EXT-46a** A mixed opaque array with an enumerable child must retain prior success without a
  new length-getter read, both without and with an actual child rewrite. Original versus normalized
  identity remains true/false respectively; the backing array/cell stay intact. The count-only path
  avoids serializing the opaque value. Status: tested.
  - `[EXT-46a] mixed opaque enumerable rewriting avoids adding a length getter read`
- **EXT-46b** A structural optional-cell array proxy reports readable length three while its native
  own length descriptor remains one. A child rewrite must preserve the readable three positions,
  encoding VALUE 5 followed by two nulls on path and JSON, rather than 0.14's compacted one cell.
  Caller readable/native lengths, holes, descriptors and cell identity remain unchanged.
  Status: tested.
  - `[EXT-46b] ${binding} structural array reading preserves readable length beyond its native descriptor`

## Constructor input profiles (EXT-47)

Independent consumer authorship from the accepted
[#170 combined batch](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6749956596),
public Schema/Operation APIs, existing consumer scenarios and the README's
[neutral echo contract](./README.md#the-neutral-echo-probe). No library implementation, source
tests, backend or conformance code informed this context. The new
`src/scenarios/constructor-input-profiles.test.ts` runs path and JSON-body operations through Fetch
over real loopback sockets in Node and Chromium; the same file also runs against the packed
package. It checks exact method, target, relevant header lines, JSON bytes and request counts.
Caller own keys, descriptors and direct cell identities remain unchanged. These synthetic checks
do not establish human use or release qualification.

The baseline was main `0b72233da7b7e4dde4e51fafad70ccd45433b098` (package version 0.15.0), with
Effect 4.1.2, Node 24.22.2 and Chromium 158 on Windows. Passing overwrite pins and forty plain
failing goals per source lane remain under `artifacts/constructor-input-main-*`, before conversion.
The frozen unreleased candidate is `24de284595c4d3044f632f9ec31d0629c0a21b84`, using the same
environment. Both unchanged source lanes first detected exactly 95 invalidated pins/expected-failure
markers across EXT-44, EXT-45 and EXT-47, with 225 ordinary passes and two retained wrapper goals.
Those first reports remain under `artifacts/constructor-input-24de284-unchanged-*`. Covered calls
now require ordinary `SchemaError` assertions and empty ledgers.

Frozen-candidate verification on 2026-11-09 passes the full Node lane (2,210 ordinary cases),
Chromium lane (1,385), packed lane (2,223) and app lane (3), with two additional expected failures
for watched iterator wrappers in each source/packed lane and zero skips everywhere. All 142 new
EXT-47 cases pass ordinarily in Node, Chromium and packed mode. Source/packed/app catalogue gates,
strict source and packed declarations, formatting, boundaries and lint pass. Full logs are retained as
`artifacts/constructor-input-24de284-{source,packed,app}-full.log`, with copied per-lane JUnit
reports. The existing app lane supplies general installed-package smoke evidence, not direct tests
of these profiles. These checks use Effect 4.1.2 on Windows; they do not establish other peers or
platforms, human use, implementation review or release qualification. This evidence does not expand
inherited-only, arbitrary-iterator, Void, open-member, normalized-declaration or conflicting-alias
policy; EXT-44o retains the separate #143 migration pin.

Integration now pins CI to reviewed source `9eea0311fe4dacc3679a3eca0b744d6b7101fde2`.
The later review correction consistently excludes primitive-only union members at ancestor and
terminal levels, with source regressions for that boundary and nullable closed object encoding
views. It does not change these consumer fixtures. The Windows results above remain evidence at
their stated original source; the pull request records fresh CI against the updated pin.

- **EXT-47a** Dense optional Filter elements, fixed optional tuples, optional object ancestors,
  NullOr/NullishOr ancestors, root NullOr, and object/string or boolean/object alternatives retain
  encoded `"05"` to `"5"`, decoded `5` to `"5"`, and omitted limit to default `"25"` bytes.
  Unencoded primitive alternatives add no new scalar interpretation. Status: tested.
  - `[EXT-47a] ${binding} ${fixture.name} retains encoded decoded and omitted bytes`
- **EXT-47b** Every EXT-47a shape refuses supplied invalid text and null aliases without dispatch.
  The baseline's exact default-25 requests remain preserved independently of the original goals.
  Status: tested.
  - `[EXT-47b] ${binding} ${fixture.name} refuses invalid aliases without default dispatch`
- **EXT-47c** The exact EXT-47b inputs also retain the original independently authored refusal
  goals as required ordinary passes under the transparent primitive union extension. Status: tested.
  - `[EXT-47c] ${binding} ${fixture.name} refuses invalid aliases before dispatch`
- **EXT-47d** Sparse optional arrays retain leading/trailing holes and a stable own cell, including
  hidden and null-prototype arrays. Fixed optional tuples and post-rest tuples retain their actual
  positions. Encoded, decoded and default controls assert exact null padding and caller layout.
  Holes use schemas that accept undefined; optionalKey alone does not make present undefined valid.
  Status: tested.
  - `[EXT-47d] ${binding} ${fixture.name} retains encoded decoded and omitted bytes`
- **EXT-47e** Every EXT-47d profile refuses supplied invalid text/null without dispatch. Earlier
  default-25 requests at the real index, with surrounding null padding, remain in baseline reports.
  Status: tested.
  - `[EXT-47e] ${binding} ${fixture.name} refuses invalid aliases without default dispatch`
- **EXT-47f** The original sparse own-cell goals now require ordinary typed refusal with zero
  requests. They certify no inherited cell and require no global prototype mutation. Status: tested.
  - `[EXT-47f] ${binding} ${fixture.name} refuses invalid aliases before dispatch`
- **EXT-47g** Exact native own iterator data, enumerable/hidden/frozen/null-prototype profiles,
  nested arrays and wrapped arrays with inner stray fields retain valid/default wire controls.
  Descriptor snapshots do not invoke the iterator. Status: tested.
  - `[EXT-47g] ${binding} ${fixture.name} retains encoded decoded and omitted bytes`
- **EXT-47h** The EXT-47g arrays refuse invalid text/null aliases without dispatch. Their original
  default-25 baseline remains distinct from the earlier symbol-coercion normalization defect.
  Status: tested.
  - `[EXT-47h] ${binding} ${fixture.name} refuses invalid aliases without default dispatch`
- **EXT-47i** The exact native-own-data goals now require ordinary `SchemaError` passes without
  dispatch under the accepted bounded iterator extension. Status: tested.
  - `[EXT-47i] ${binding} ${fixture.name} refuses invalid aliases before dispatch`
- **EXT-47j** Empty arrays, undefined elements, absent tuple/object fields, null and primitive
  alternatives keep their own bytes. Explicit undefined object values render absent on the path;
  the JSON codec's existing representation is null. Status: tested.
  - `[EXT-47j] ${binding} scalar null absent and empty alternatives retain their own bytes`
- **EXT-47k** Wrapper, entries, bound-native, accessor and subclass iterator profiles retain the
  unsupported invalid-alias default route. The wrapper call count and iterator getter count stay
  exactly zero, and descriptors remain unchanged. No iterable is consumed for evidence.
  Status: defect.
  - `[EXT-47k] currently ${binding} ${shape} iterator profiles remain excluded without iteration`
- **EXT-47l** Void-first and Unknown-first alternatives retain their distinct existing member
  behavior: Void consumes the object and writes undefined (absent in path JSON, null in body JSON),
  while Unknown preserves the invalid text. Neither becomes a transparent primitive.
  Status: limit.
  - `[EXT-47l] currently ${binding} Void and open alternatives preserve their own member behavior`
- **EXT-47m** An optionalKey-only ancestor already refuses invalid text/null before dispatch and
  keeps omitted filter absent. This remains a positive refusal control rather than a repair goal.
  Status: tested.
  - `[EXT-47m] ${binding} optionalKey ancestors retain their existing refusal and omission behavior`
- **EXT-47n** A flat nullable renamed root refuses valid encoded `"05"` beside decoded numeric
  count after two complete-side controls retain their distinct Base64 bytes. The earlier mixed
  default-25/double-encoded request remains in baseline reports. Status: tested.
  - `[EXT-47n] ${binding} a nullable root mixed-side gate refuses after complete-side controls`
- **EXT-47o** The original mixed-root goal is an ordinary required refusal when the whole encoded
  decoder rejects decoded count. Independent field decoding may not choose a new shared-text
  interpretation. Status: tested.
  - `[EXT-47o] ${binding} a nullable root mixed-side gate refuses without fieldwise reinterpretation`
- **EXT-47p** An inherited-only invalid alias retains its unsupported default overwrite. The
  prototype belongs only to that input; no own index is manufactured. Status: defect.
  - `[EXT-47p] currently ${binding} an inherited-only alias supplies no own-cell witness`
- **EXT-47q** The native-own-iterator invalid route evaluates its original constructor default
  exactly once before refusing the alias without dispatch. The retained baseline had the same
  callback count before sending `25`; the repair may not replay construction. Status: tested.
  - `[EXT-47q] ${binding} native iterator refusal preserves the original default callback count`
- **EXT-47r** A nested Filter genuinely read during fieldwise preparation inside a nullable root
  keeps valid alias `5` beside decoded count and double-encoded shared Base64 text. This existing
  success is separate from the flat root gate and must retain its exact wire meaning.
  Status: tested.
  - `[EXT-47r] ${binding} actual nested fieldwise consumption retains shared decoded text`
- **EXT-47s** A private/custom array prototype containing an inherited invalid neighbor beside an
  own valid encoded alias currently writes two defaults. The custom prototype keeps this input
  outside the accepted ordinary/null-prototype subset, so it retains a current-output pin. The
  exploratory refusal goal is preserved in reports before its scope correction. Source coverage
  carries the accepted Array.prototype neighbor case without global mutation in wire scenarios.
  Input ownership, cell identity and descriptors remain unchanged. Status: defect.
  - `[EXT-47s] currently ${binding} a private array prototype with own and inherited aliases retains defaults`

## Conflicting aliases in newly covered containers (EXT-48)

Consumer-authored from the public
[#143 acceptance](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6750236968),
the [0.16 migration](https://github.com/viell-dev/slop-effect-schema-http/blob/9eea0311fe4dacc3679a3eca0b744d6b7101fde2/docs/release-notes/0.16.md#account-for-conflicting-names),
and the README's [neutral echo contract](./README.md#the-neutral-echo-probe). No product
implementation, source tests, backend or conformance code informed this context. The new
`src/scenarios/constructor-alias-conflicts.test.ts` executes real path and JSON-body operations
through Fetch in Node, Chromium and packed mode. It checks exact targets, JSON bytes, method,
relevant headers and request counts, plus caller prototypes, own descriptors, cells and holes.

All observations use source `9eea0311fe4dacc3679a3eca0b744d6b7101fde2`, Effect 4.1.2, Node 24.22.2
and Chromium 158 on Windows. The nonliteral `{ limit: 1, page_size: "02" }` item typechecks without
a cast. It writes `1` alone or beside a decoded/defaulted neighbor, and `2` beside encoded-only
`{ page_size: "25" }`. Complete encoded and decoded controls each retain `1/25`. Sparse layouts
keep a real hole after the first cell, represented by null on the wire; no position is compacted.
These current-output pins disclose the existing #143 limit rather than establish alias agreement
or a conflict-selection policy.

Separate contradictory-alias refusal goals require `SchemaError` and zero requests for all four
conflicting inputs per layout/binding. Before marking them expected failures, both plain source
lanes produced exactly twelve current-pin passes and twelve intended goal failures, with zero
skips. Reports remain under `artifacts/constructor-conflict-9eea031-plain-*`.
EXT-48 adds twelve expected failures per consumer lane, alongside the two
existing watched-iterator goals. This is consumer evidence only: no new conflict repair, other
Effect peer/platform, profile-specific built-app behavior, human use or release qualification is
established.

Full verification on 2026-11-09 passes Node (2,222 ordinary cases), Chromium (1,397), packed
(2,235) and app (3). Each source/packed lane has fourteen expected failures: twelve EXT-48d cases
and the two prior watched-iterator goals. Every lane has zero skips and no unexpected failures.
The source, packed and app catalogue gates, source checks/lint and strict packed declarations pass.
Full logs and copied JUnit reports use `artifacts/constructor-conflict-9eea031-*`; earlier evidence
remains intact. The app run is general installed-package compatibility evidence.

- **EXT-48a** Optional and nullable element arrays retain both complete-side controls and the
  dual-name item's `1` versus neighboring-encoded-input `2` interpretation. Each binding receives
  exactly six requests with full wire assertions and unchanged caller data. Status: limit.
  - `[EXT-48a] currently ${binding} ${fixture.name} changes a dual-name item only beside an encoded-only neighbor`
- **EXT-48b** An exact enumerable own native Array iterator retains the same six current outputs.
  Its function reference and descriptor flags remain unchanged; no wrapper substitutes for native
  data. Status: limit.
  - `[EXT-48b] currently ${binding} exact native own iterator changes a dual-name item only beside an encoded-only neighbor`
- **EXT-48c** Ordinary, hidden-own-cell and null-prototype sparse optional arrays preserve the
  actual null padding, length, cell identities and descriptors across all six controls. The
  conflicting first cell changes from `1` to `2` only beside the encoded-only neighbor.
  Status: limit.
  - `[EXT-48c] currently ${binding} ${fixture.name} changes a dual-name item only beside an encoded-only neighbor`
- **EXT-48d** Distinct expected-failure #143 goals retain the intended contradictory-alias
  refusal for all six layouts and both bindings. Each checks all four conflicting inputs and
  requires an empty ledger. Current success remains independently pinned above. Status: defect.
  - `[EXT-48d] goal ${binding} ${fixture.name} contradictory aliases refuse before dispatch`
