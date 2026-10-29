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

- **ERR-1a** A SOAP fault code where zero means success, inside HTTP 200: body-level
  discrimination. Status: pending.
- **ERR-6** One action that returns a real SOAP fault with HTTP 500: one more rule. Status:
  pending.
- **STAT-7** PROPFIND answered with 207, plus 412, 428, 415, and 405 with `Allow`: methods as
  strings, statuses as numbers. Status: pending.
- **STAT-12** A GET carrying a SOAP body for downloads: rejected client-side before dispatch as a
  typed error. Status: pending.
- **HDR-5e** Latin-1 bytes under a charset-less `text/xml`. Status: pending.
- **HDR-5f** SOAP 1.2 carrying the action inside the content type: a protocol version change is a
  codec change, not a header change. Status: pending.
- **HDR-6** `SOAPAction` required, quoted, and matching the body action: one declared header per
  action. Status: pending.
- **PAY-3a** SOAP 1.1 and 1.2 under a custom namespace; three list shapes for zero, one, and many
  items, with the single item wrapped in an extra element; WebDAV multistatus with collections
  skipped; a WSDL. Status: pending.
- **PAY-4a** Latin-1 XML whose encoding must be read from its own declaration. Status: pending.
- **PAY-6** Multipart in both directions: a `FormData` upload with a `Blob` and a label, and a
  response bundle with a JSON metadata part and a bytes part, read asynchronously inside the schema.
  Status: pending.
- **PAY-7** A raw bytes upload with the file name in the query string and a one-line text receipt.
  Status: pending.
- **QRY-1** A bare key and an empty value are different requests (`?wsdl` versus `?wsdl=`). Status:
  pending.
- **RET-3** ETag with `If-None-Match` yielding 304 and no body, `If-Match` yielding 412, and 428
  when the validator is missing. Status: pending.

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
  - `[APP-4] an explicit fallback can discard an unmodelled body`
- **APP-5** Validation on both sides: the client refuses an empty string before any network; the
  server refuses a blank string the client accepted. Status: tested.
  - `[APP-5] refuses an empty customer name before any network`
  - `[APP-5] the server refuses a blank name that the client accepted`

## JSON business API: operations (`business/operations`)

- **STAT-8** An unregistered 420 with `Retry-After`: not transient by default, with a classifier
  that adds it without losing the built-in cases. Status: pending.
- **STAT-9** 429 and 503 with `Retry-After` as an HTTP date: both forms honoured unaided. Status:
  pending.
- **HDR-8** An edge cache that ignores request `Cache-Control` and honours only a cache-key
  parameter: the cache header, a computed cache-busting query, and the transport cache mode travel
  together as one transform; the test purges first. Status: pending.
- **VAL-1b** Dates: epoch milliseconds, the ASP.NET `/Date(…)/` form with a decorative offset, US
  month-first local time with no zone, and HTTP-date; strict reversible transforms that refuse
  looser input. Status: pending.
- **VAL-2a** Money as a formatted dollar string; branded integer cents in both directions, refusing
  unformatted input. Status: pending.
- **VAL-3a** Booleans as `Y` and `N`, with `y`, `1`, and `true` refused. Status: pending.
- **VAL-4** Absence: `null`, empty string, the string `"null"`, a missing key, a blank string, and
  `-1` for unlimited next to `0` for a real limit; collapse into an optional and keep unlimited
  distinct from zero. Status: pending.
- **VAL-5b** A reference that is an expanded object in some rows and a bare id in others, and
  space-delimited lists where the spec says arrays. Status: pending.
- **QRY-2** Repeated parameters where the server keeps only the last: the client can append; the
  collapse is the server's, verified against the fixture. Status: pending.
- **QRY-3** An empty path segment left to the application contract, and a base URL replaceable per
  operation. Status: pending.
- **RET-1** A strictly increasing nonce in front of two 503 warm-ups with HTTP-date `Retry-After`,
  the replay check before the warm-up check. A retry that replays the encoded request turns a
  transient failure permanent (pinned), then a caller-driven loop and per-attempt client middleware
  advance the nonce while keeping the budget and `Retry-After`. Credentials resolve once per
  evaluation. Status: pending.
- **RET-2** A long poll held open: a whole-operation timeout surfaces as a timeout failure, not a
  mapped response. Status: pending.

## CGI reporting gateway (`gateway`)

- **AUTH-2** A session obtained by GET with the password in the query string, then carried as a
  query parameter: declared as is. Status: pending.
- **AUTH-7** HTTP Digest in the 1997 form without `qop`: a 401 challenge as a declared response, an
  MD5 response, a single-use nonce, and `stale=true` on replay; the same cold request executed again
  with one added header. Status: pending.
- **ERR-1b** XML-RPC faults inside 200. Status: pending.
- **ERR-1c** Pipe-delimited `ERROR` lines inside 200. Status: pending.
- **STAT-6** A HEAD probe whose facts live only in headers: an ordinary schema over the header map.
  Status: pending.
- **STAT-10** A 301 kept alive for an old compiled-in path: unreachable through a redirect-following
  transport; a per-request transport option is the only escape. Status: pending.
- **STAT-11** A gateway that strips PUT and DELETE, with the service refusing raw ones too: a
  reusable transform that rewrites the method to POST and sets an override header. Status: pending.
- **HDR-5d** CSV served as `application/octet-stream`. Status: pending.
- **PAY-3b** XML-RPC with `i4`, `double`, `boolean`, `dateTime.iso8601`, `base64`, `struct`, `array`,
  and bare scalar responses. Status: pending.
- **PAY-4b** A UTF-8 BOM that would poison the first CSV column name. Status: pending.
- **PAY-4c** Fixed-width records with no delimiters, Latin-1 titles, implied decimals, zero padding,
  and a trailer whose record count and control total the decode verifies. Status: pending.
- **PAY-5** CSV for a German spreadsheet with BOM, CRLF, semicolons, and a decimal comma,
  round-tripped with the BOM written back on encode. Status: pending.
- **PAY-8** Base64 of Latin-1 bytes inside XML-RPC, decoded by the same fixed-width schema that reads
  the HTTP endpoint. Status: pending.
- **VAL-1c** XML-RPC's separator-free date, bare `YYYYMMDD`, and a zero date meaning null. Status:
  pending.
- **VAL-2b** Money as XML-RPC doubles in units, integer cents with implied decimals, and a decimal
  comma. Status: pending.
- **VAL-3b** XML-RPC booleans `1` and `0`. Status: pending.
- **RET-4** A Digest nonce spent by one request, so every call costs two round trips. Status:
  pending.

## Notification service (`notifications`)

- **AUTH-5** Double-submit CSRF: the token arrives as a cookie and in the body and must be echoed in
  a header; Node sends no cookies, so the cookie-reading endpoint needs `Cookie` set by hand.
  Status: pending.
- **AUTH-6** HMAC signing over method, path, timestamp, and the encoded body, with a validity
  window: signing runs after body encoding and once per attempt, regardless of its position in the
  declaration pipeline. A tampered body, a stale timestamp, and a missing CSRF token are distinct
  typed responses. Status: pending.
- **HDR-4** `Deprecation`, `Sunset`, and `Warning` all announcing retirement on one response: read
  all three through a header schema. Status: pending.
- **HDR-7a** CORS preflight answers as a Node client observes them: an allowlist omitting
  `Content-Type` on one endpoint, one rejecting trace headers, and `OPTIONS` answered without the
  application headers. Status: pending.

## Cross-service flows (`flows`)

- **AUTH-1** One opaque token as a Bearer header to one service, under a custom `Token` scheme to
  another, and as a query parameter to a third: per-service late-bound credentials resolved at send
  time, an explicit opt-out for endpoints that must not carry one, and omission rather than the
  string `"undefined"` when absent. Status: pending.
- **APP-1** Interaction gates: new input interrupts in-flight work, observed as an aborted request
  under injected latency; equal input joins or reuses the retained success; force re-executes;
  navigation disposes; empty input supersedes through the same gate; updating a credential does not
  unmount the interaction. Status: pending.
- **APP-2** The month-end saga: read the gateway extract, translate, write tasks, store the
  re-encoded bytes over SOAP, push them through a JSON-to-SOAP proxy, announce with a signed request,
  and confirm through search. Compensation deletes the created tasks, tunnelled, after both failure
  and interruption. Status: pending.
- **APP-3** Translation between services: id spaces as a visible reference, a lossy money-to-priority
  mapping made reversible through a text field, an active flag recovered from status, an honest
  one-way transform whose reverse fails with a reason, inactive directory entries refused as
  assignees, and a file-to-upload mapping that drops size and keeps the timestamp in the name.
  Round trips prove non-lossiness, and encoding into the target's schema makes drift a compile
  error. Status: pending.
- **APP-6** Narrowing: a mapped 401 is a member of the same union as success, so reading a body
  without narrowing is a type error. Status: pending.

## Transport and browser lane (`browser`)

- **HDR-7b** CORS in a real browser: a page on one origin calling the services, with tracing
  propagation disabled per service and a same-origin proxy for the endpoints whose allowlist cannot
  be satisfied. Status: pending.
- **TRN-1** Explicit cookie and credential behavior, with the transport and credentials settings
  recorded before asserting, in Node and in the browser separately. Status: pending.
