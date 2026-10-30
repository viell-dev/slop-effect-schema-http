# The JSON business API (`business`)

One service that grew by accretion, so its two halves come from different eras and teams:

- [`/v1/`, the envelope era](#v1-the-envelope-era): customers, orders, exports, the ledger and a
  handful of reference endpoints, on a Spring stack. It is the oldest part of the service.
- [`/v2/`, the operations era](#v2-the-operations-era): tasks, search and operational endpoints,
  built in 2014 by the platform team on a .NET stack and put behind the company's API gateway and
  edge cache in 2016.

Both halves answer on the same origin; paths below are relative to it. The
[test options](#test-options) at the end are for the suite's tests, not part of the published
service.

## `/v1/`: the envelope era

Each convention below is a historical accident that a paying integration now depends on, so nobody
can remove it.

### Conventions

- **Content type.** Every JSON reply carries Jackson's default content type on the Spring stack,
  `application/json;charset=UTF-8`, unless an endpoint below says otherwise.
- **Validation.** The 2016 validation layer renders Bean Validation messages as 422
  `{ "errors": [{ "field", "code", "message" }] }`. A body that is not a JSON object is 400 with one
  error of code `malformed`. The field codes are `missing` ("must not be null"), `type` ("must be a
  string"), `blank` ("must not be blank") and `unknown_enum`. The blank check (`@NotBlank`) trims
  before checking, so a name of spaces is refused although it is not empty.
- **Tiers.** Customer tiers are a Java enum: `STANDARD`, `SILVER`, `GOLD`, `PLATINUM`. In 2014 a
  mobile team switched Jackson's `WRITE_ENUMS_USING_INDEX` on to shave bytes from list payloads, so
  every response sends the ordinal, 0 to 3. Deserialization was never touched, so requests still
  send names, and only exact names. The enum may only ever grow at the end, or every stored ordinal
  in every partner's cache changes meaning.
- **Customers** read as `{ "id", "name", "tier", "archived" }`, with `tier` as the ordinal.
- **The firewall.** The F5 web application firewall in front of `/v1/` rejects anything that looks
  like markup in the request target, a `<` or `>` once the target is percent-decoded, with its stock
  HTML page: 403 `text/html; charset=utf-8`, `Cache-Control: no-cache`, `Connection: close`, and a
  support ID in the text. The security team owns its policy; it predates every consumer of this API
  and answers before the application sees the request. It also removes the container's `Server`
  line from every reply, so no `/v1/` reply names its server.

### Customers

- **`POST /v1/customers`** creates a customer from `{ "name", "tier" }` and answers 200 rather than
  201, with an empty acknowledgement, `{ "success": true }`, and the new resource only in
  `Location`. The 2012 controller returned `ResponseEntity.ok()`, and partner SDKs check for
  exactly 200.

  Two containers serve this path behind a round-robin balancer, and `X-Served-By` names the one
  that answered. Ops documentation says the servlet container absolutizes `Location`; neither
  container does, since Tomcat leaves a `Location` header as the handler set it and absolutizes
  only `sendRedirect`'s 302, and only with `useRelativeRedirects="false"`, the behaviour of releases
  before 7.0.67. The legacy node (`app-legacy-2`) still runs the 2012 build, whose controller builds
  the URL itself from the request's `Host` header, in the form Tomcat's `sendRedirect` uses:
  `http://<host>/v1/customers/<id>`, with the port when `Host` names one. The newer node (`app-1`)
  sends the path, `/v1/customers/<id>`, exactly as the handler wrote it. Which form a client sees is
  the balancer's choice; it alternates, starting with `app-1`.

- **`GET /v1/customers?page=&per_page=&name=`** lists customers as `{ "customers": [...] }`. The
  controller reads a one-based `page` (default 1) and `per_page` (default 2, at most 50), and
  answers 400 for anything else; `name` filters by a case-insensitive substring.

  The `Link` header is added by the API gateway's 2017 pagination plugin, which only speaks
  zero-based `offset` and `limit`:
  `</v1/customers?offset=2&limit=2>; rel="next"`, with `first`, `prev`, `next` and `last` links as
  they apply. The controller ignores both parameters, so following a link literally reads the first
  page again. Mobile apps parse the header and partners send `page`, so neither side can move.

- **`GET /v1/customers/<id>`** answers 200 `{ "result": "OK", "customer": … }`. "Not found" is a 200
  as well: `{ "result": "NOT_FOUND", "message": "Customer <id> was not found" }`. The customer
  controller was written against a 2009 SOAP facade that had no status codes, and the partner SDKs
  generated from it still branch on `result`. A 404 from this path would make those SDKs throw an
  unhandled exception, so the envelope stays.

- **`PATCH /v1/customers/<id>`** takes `{ "name"?, "tier"? }` and answers with the customer as it
  was loaded, before the changes apply: the open-session-in-view filter (2013) serializes the entity
  before Hibernate flushes. Two partners diff this response against their request to detect
  concurrent edits, so it stays. An unknown id is the same `NOT_FOUND` 200 as a read.

- **`POST /v1/customers/<id>/archive`** answers 204. The handler still writes a debug body that the
  2018 runbook documents as "the archive receipt", but the container drops body bytes on a 204, so
  the receipt never reaches the wire, whatever the runbook says. The 204 keeps its JSON
  `Content-Type`.

- **`PUT /v1/customers/<id>/preferences`** takes
  `{ "newsletter": boolean, "invoiceFormat": string }` and answers 200 with a JSON content type and zero bytes (`Content-Length: 0`): a 2017 refactor
  changed the return type to `void` but left `produces = APPLICATION_JSON` on the mapping.
  `GET /v1/customers/<id>/preferences` reads them back; every customer starts with
  `{ "newsletter": false, "invoiceFormat": "EMAIL" }`.

The archive and preference routes answer an unknown id with 404 `{ "error": "not_found", "id" }`.

### Orders

**`POST /v1/orders`** places an order from `{ "customerId", "poNumber", "lines": [{ "sku",
"quantity" }] }` and never answers anything but 200. Success is
`{ "orderId": "SO-<n>", "status": "ACCEPTED", "totalCents" }`. A failure is a 200 too, with the
error in `X-Error-Code` and `X-Error-Message` and the exception's text as the body, under the JSON
content type:

```http
HTTP/1.1 200 OK
Content-Type: application/json;charset=UTF-8
X-Error-Code: CREDIT_HOLD
X-Error-Message: Customer 1002 is on credit hold

com.example.orders.CreditHoldException: Customer 1002 is on credit hold
```

In 2016 the hardware balancer's health monitor was pointed at live traffic; it ejects a node that
answers too many 4xx or 5xx, and customer typos took nodes out of rotation. Since then failures
travel in headers on a 200, and the error filter writes the exception's text under the JSON content
type. The monitor belongs to a network team on another continent.

| `X-Error-Code`     | Status as its own request | Cause                                                                   |
| ------------------ | ------------------------- | ----------------------------------------------------------------------- |
| `MALFORMED_ORDER`  | 400                       | a missing field, no lines, or a quantity that is not a positive integer |
| `UNKNOWN_CUSTOMER` | 404                       | no such customer                                                        |
| `CREDIT_HOLD`      | 403                       | the customer is on credit hold                                          |
| `UNKNOWN_SKU`      | 422                       | a line names a product that does not exist                              |
| `DUPLICATE_PO`     | 409                       | the customer already placed this purchase order number                  |

**`POST /v1/orders/batch`** (2018) takes `{ "orders": [...] }` and answers 200 for any batch it
could read, with the status each item would have had as its own request inside the envelope:
`{ "batchId": "B-<n>", "results": [...] }`, where each result is
`{ "index", "status": 201, "order" }` or `{ "index", "status", "error": { "code", "message" } }`
with the status from the table above.

### Exports

**`POST /v1/exports`** takes `{ "report": "aging" }` and answers 202
`{ "exportId", "state": "QUEUED" }` with a relative-path `Location: exports/<id>` (resolved against
the request URL it lands at `/v1/exports/<id>`) and `Retry-After: 1`, in seconds. Another report
answers 422.

**`GET /v1/exports/<id>`** reports the export pending for its first status checks, two of them, no
matter how far the work has got: 202 with `state` `QUEUED`, then `RUNNING`, and `Retry-After: 1`.
Then it answers 200 `{ "exportId", "state": "DONE", "rows": [{ "customerId", "overdue30" }] }`. A
2015 "temporary" throttle stopped dashboards from hammering the status table; the scheduler's own
tick hides the delay for real work, so nobody has noticed it is still there.

### The ledger

**`GET /v1/ledger?account=<account>`** answers `{ "account", "entries": [{ "id", "amountCents",
"memo" }] }`, and **`GET /v1/ledger/<id>`** answers `{ "entry": … }`. Unknown accounts and entries
are 404 with `{"error":"no such account"}` or `{"error":"no such entry"}`.

Entry ids are 64-bit Snowflake ids from the 2019 ledger rewrite, written as exact JSON numbers.
Above 2^53 the platform's JSON number type cannot tell neighbours apart, so `9007199254740993` reads
as `9007199254740992`, the previous row's id. The rewrite's own clients are Java; nobody quotes the
ids.

### Reference endpoints

- **`GET /v1/regions`** answers `{ "regions": [{ "code", "name" }] }` as
  `text/html; charset=UTF-8`. Regions come from a 2010 MVC controller that renders JSON through a
  view template; the view resolver's default content type is `text/html`, and the CMS that embeds
  the page sniffs it.
- **`GET /v1/currencies`** answers `{ "currencies": [{ "code", "decimals" }] }` as
  `text/json; charset=utf-8`: currencies still pass an IIS handler mapping from 2009 that labels
  JSON that way.
- **`GET /v1/odata/Products`** is a WCF Data Services (OData v2) facade from 2011 in verbose JSON:
  the `d` wrapper, `__metadata` per entity, `__count` as a string, decimals as strings, and
  `odata=verbose` in the content type, `application/json;odata=verbose;charset=utf-8`, with
  `DataServiceVersion: 2.0;`. An Excel add-in on every sales laptop reads it. Each product has
  `__metadata` (its `uri` and `"type": "Business.Product"`), `ProductID`, `Name`, `UnitPrice` and
  `Discontinued`, with `UnitPrice` an `Edm.Decimal` string with four decimal places, such as
  `"12.5000"`. `$top` limits the results, and `$inlinecount=allpages` adds `__count`. An invalid
  `$top` is 400 with an OData error object.
- **`GET /v1/dashboard`** answers `{ "openOrders", "creditHolds" }` behind the anti-JSON-hijacking
  prefix `)]}',` and a line feed. The feed was written for the 2014 AngularJS back office, which
  strips the prefix; the prefix is part of the contract now.
- **`GET /v1/rates?callback=<name>`** serves the exchange rates, `{ "base", "rates" }` with rates as
  decimal strings, as JSONP for a 2012 storefront widget, in Express's framing and as
  `application/javascript; charset=utf-8`:

  ```js
  /**/ typeof name === 'function' && name({"base":"USD","rates":{…}});
  ```

  Without `callback` the rates are plain JSON. A callback that is not a JavaScript identifier is 400
  `Invalid callback name`. The CDN in front of the rates keys its cache on the path alone, so the
  first caller's callback name, or plain JSON, is served to everyone until the entry expires;
  `X-Cache` says `MISS` or `HIT`. The CDN contract is renewed every three years and nobody owns the
  rule.

- **`GET /v1/reports/aging?layout=<layout>`** answers `{ "columns": [...], "rows": [[...]] }`. The
  aging report serves saved column layouts from the reporting UI, and `layout` picks one; the
  default is the documented order. Finance swapped the money columns in 2019 to read arrears first,
  and the summary layout drops the name. Both money columns are integer cents, so a client that
  trusts positions swaps them without noticing. An unknown layout is 400.

  | `layout`  | Columns                                      |
  | --------- | -------------------------------------------- |
  | `default` | `customerId`, `name`, `current`, `overdue30` |
  | `finance` | `customerId`, `name`, `overdue30`, `current` |
  | `summary` | `customerId`, `current`, `overdue30`         |

- **`GET /v1/warehouses?region=<code>`** answers the region's warehouses, `{ "code", "city" }`. The
  warehouse directory is an XML service behind a 2011 XML-to-JSON bridge, which unwraps a
  one-element list into a bare object and drops an empty list entirely: many warehouses are
  `{ "warehouse": [...] }`, one is `{ "warehouse": {…} }`, and none is `{}`. Mobile clients written
  against the bridge parse exactly that, so it cannot be fixed. An unknown region has none, and a
  missing `region` is 400 with a `missing` error in the validation shape.

### Recordings

The customer creation is held to recordings of Tomcat 7.0.109, the last Tomcat 7 release, with its
defaults and with `useRelativeRedirects="false"`
([recordings/README.md](../recordings/README.md); catalogue EXT-6d). `app-1`'s reply matches
Tomcat's reply to a handler that sets `Location` on a 200, and `app-legacy-2`'s absolute `Location`
matches the URL Tomcat's `sendRedirect` builds for the same path and `Host`. The differences that
remain are documented above: `X-Served-By`, the `Server` line the firewall removes, the legacy
node's own absolute URL, and the framing of the suite's HTTP server, which chunks a reply Tomcat
would count (recordings/README.md, "Comparing").

The recordings also show what the ops documentation got wrong: by default Tomcat 7.0.109 writes
`sendRedirect`'s location as given, even a relative `customers/1006`, and a `setStatus(200)` after
`sendRedirect` leaves the 302 in place.

## `/v2/`: the operations era

### Conventions shared by every `/v2/` route

- **The gateway's method allowlist.** The gateway forwards only GET, HEAD, POST and OPTIONS (plus
  PURGE to the edge). PUT, PATCH, DELETE and any other method get `405` with
  `Allow: GET, HEAD, POST, OPTIONS`, `Via: 1.1 api-gateway` and `{"message":"Method Not Allowed"}`.
  The service registers updates and deletes only behind the tunnel, so a raw PUT or DELETE has no
  route even past the gateway.
- **The method override tunnel.** A POST with `X-HTTP-Method-Override: PUT`, `PATCH` or `DELETE` is
  handled as that method; any other value answers `400` with `{"error":"unsupported_override"}`. The
  header is ignored on other methods. The tunnel dates from the gateway's introduction: it could not
  be taught PUT or DELETE, so the service learned to read the override header instead.
- **Merged slashes.** The gateway runs nginx's `merge_slashes on`, the default it was deployed with
  in 2016, so `/v2/tasks//history` is routed as `/v2/tasks/history`.
- **Repeated query parameters keep the last value.** The PHP front end that preceded this service
  kept the last of repeated names, and the 2014 port reproduced that so existing links kept working.
- **Bearer authentication.** Tasks, search and payouts need `Authorization: Bearer <token>`, with
  the scheme matched case-insensitively. A missing token answers `401` with
  `WWW-Authenticate: Bearer realm="business-v2"` and `{"error":"invalid_request"}`; a wrong one
  answers `401` with `error="invalid_token"` in the challenge and `{"error":"invalid_token"}`. Two
  `Authorization` lines answer 400 `invalid_request`.
- **JSON bodies.** A request body must be `application/json` (else `415`) and parse (else `400` with
  `{"error":"malformed_json"}`) as an object (else `422`). Validation failures answer `422` with
  `{"errors":[{"field":…,"message":…}]}`. Other errors are `{"error":<code>,…}`, and an unknown
  `/v2/` path is 404 `{"error":"not_found","path":…}`.
- **Value conventions:**
  - epoch milliseconds as numbers;
  - ASP.NET dates `/Date(ms)/` or `/Date(ms±hhmm)/`, whose offset is decorative, written with
    escaped slashes, `"\/Date(…)\/"`. JSON as the 2014 serializer wrote it has the escaped form, and
    mobile apps released that year match on it, so it cannot change;
  - US local time, `M/d/yyyy h:mm:ss AM`, with no zone;
  - HTTP-dates in headers;
  - money as `$1,234.56`;
  - flags as `"Y"` and `"N"`;
  - `-1` for an unlimited count;
  - lists as space-delimited strings.

### Tasks and search

- `POST /v2/tasks` creates a task from `{ title, assigneeId, priority, due?, notes? }` and answers
  `201` with a relative `Location: /v2/tasks/T-<n>` and the task. `title` is non-blank text up to
  200 characters, `assigneeId` matches `[A-Za-z0-9._:@-]{1,64}`, `priority` is an integer from 1
  (urgent) to 4 (low), `due` is `null` or an ASP.NET date, and `notes` is `null` or text up to 2000
  characters. A task reads back as `{ id, title, assigneeId, priority, due, notes, done, created }`:
  `due` and `notes` are `null` when unset, `done` is `"Y"` or `"N"`, and `created` is epoch
  milliseconds. Ids are `T-1001`, `T-1002`, … in creation order.
- `GET /v2/tasks?assignee=…&status=open|done` lists tasks as `{ applied, items, count }`, where
  `applied` echoes the filters the service used. Another `status` is 400 `invalid_filter`.
- `GET /v2/tasks/<id>` reads one task, or answers `404` with `{"error":"task_not_found","id":…}`.
- `POST /v2/tasks/<id>` with `X-HTTP-Method-Override: PUT` replaces a task (the creation fields plus
  optional `done`; omitted optional fields are reset), with `PATCH` changes only the given fields,
  and with `DELETE` removes it with `204`. Without an override it answers `400` with
  `{"error":"override_required"}`.
- `GET /v2/tasks/history` is the audit history of every task and `GET /v2/tasks/<id>/history` that
  of one task, both as `{ events: [{ task, action, at }] }`, where `action` is `created`, `updated`
  or `deleted`.
- `GET /v2/search?q=…` searches titles and notes case-insensitively, answering `{ query, hits }`. A
  missing or blank `q` answers `400` with `{"error":"query_required"}`.
- Task and search responses carry no caching headers, so a browser does not reuse them.

### Rate limits and `Retry-After`

- `GET /v2/rates/<PAIR>`, for six upper-case letters, answers `420 Enhance Your Calm` with
  `Retry-After: 1` and `{"error":"enhance_your_calm"}`, and again for an early return; then `503`
  `quote_feed_reconnecting` once, without `Retry-After`; then `200` with `{ pair, rate, asOf }`.
  The platform team copied 420 from Twitter's 2012 API; mobile clients key their back-off on it, so
  moving to 429 would break every app still in the field. The quote feed drops its upstream session
  whenever the limiter trips, and nobody owns it.
- `GET /v2/reports/<name>` answers `429` `rate_limited` with `Retry-After: 1`, then `503`
  `maintenance` with `Retry-After` as an HTTP-date, then `200` with `{ report, rows }`. An early
  return gets the same answer again. The dates are whole seconds at least 500 ms ahead, so a client
  waits between 0.5 and 1.5 seconds. The report generator's maintenance filter is a Java servlet
  that has written `Retry-After` with `setDateHeader` since 2009, so it arrives as an HTTP-date.
- `GET /v2/exports/<name>` answers `429` `rate_limited` with `Retry-After` as an HTTP-date, then
  `200` with `{ export, status: "ready" }`. The export limiter shares the report generator's servlet
  filter, so its 429 carries a date as well.

### The edge cache

`GET /v2/catalog/prices` sits behind an edge cache keyed on the path and the last `v` query value
only. The CDN contract renegotiated in 2016 dropped header-based bypass after a cache-busting flood
of `Cache-Control: no-cache`, and the marketing site's versioned URLs need `v`.

- The edge ignores request `Cache-Control` and `Pragma`, and adds `X-Cache: HIT` or `MISS`, `Age`
  and `Via: 1.1 edge`.
- Yesterday's deploy warmed the edge with the previous price list, so the plain path starts cached
  with stale prices.
- `PURGE /v2/catalog/prices` empties every variant of the path and answers
  `{"status":"ok","purged":<n>}`.
- `POST /v2/catalog/prices` with `{ sku, price }` changes the origin without telling the edge.
- Prices read as `{ version, prices: [{ sku, price }] }`, with
  `Cache-Control: public, max-age=86400`, which a browser's own cache honours too.

### Invoices

`GET /v2/invoices` and `GET /v2/invoices/<id>` answer with `Last-Modified` and rows of
`{ id, customer, amount, paid, issued, due, printed, tags, poNumber?, seatLimit }`:

| Field       | Convention                                                                            |
| ----------- | ------------------------------------------------------------------------------------- |
| `customer`  | `{ id, name, country }` the first time it appears in a response, a bare id afterwards |
| `amount`    | money, `$1,234.56`                                                                    |
| `paid`      | `"Y"` or `"N"`                                                                        |
| `issued`    | epoch milliseconds                                                                    |
| `due`       | an ASP.NET date with its decorative offset                                            |
| `printed`   | US local time with no zone, as the branch office's printer recorded it                |
| `tags`      | a space-delimited list                                                                |
| `poNumber`  | written exactly as stored, including its absent spellings                             |
| `seatLimit` | a count, or `-1` for unlimited                                                        |

The 2014 serializer expands a customer the first time it appears in a response and writes the bare
id afterwards, to keep list payloads small for the mobile apps. Three generations of import jobs
wrote an absent purchase order number differently, and the column keeps them all: a missing key,
`null`, and the strings that stand for nothing.

`POST /v2/invoices/<id>` with `X-HTTP-Method-Override: PUT` replaces one after strict validation,
and answers with the stored invoice. Each field must be in the convention above: `customer` an
existing customer's id or object, `amount` formatted money, `paid` a flag, `issued` an integer,
`due` an ASP.NET date (offset at most 14 hours), `printed` a real calendar time in the US form,
`tags` words separated by single spaces, `poNumber` text, `null` or absent, and `seatLimit` an
integer from -1. The write moves `Last-Modified` to its own time. An unknown id is 404
`invoice_not_found`. The invoice routes need no token, and send no `Cache-Control`, so a browser may
reuse a list by heuristic freshness from `Last-Modified`.

### Payouts

`POST /v2/payouts` with `{ amount, to }` needs a bearer token, `X-Nonce` (a decimal integer strictly
greater than the last one accepted) and `X-Signature` (hex HMAC-SHA256 keyed by the token over
`<nonce>.` followed by the body bytes). After the token, the service checks in this order:

1. `X-Nonce` is a decimal integer without leading zeros (else `400` `nonce_required`);
2. the signature (else `401` `bad_signature`);
3. the replay: `409` with `{"error":"nonce_replayed","last":…}` for a nonce not above the last one
   accepted;
4. the warm-up: the first two requests that pass the replay check meet `503` `warming_up` with an
   HTTP-date `Retry-After`, a whole second at least 250 ms ahead, and an early return meets `503`
   again;
5. the body: `amount` formatted money and `to` a string, else `422`.

A nonce is spent as soon as it passes the replay check: the nonce filter was installed in front of
the service in 2017, so a nonce is spent even when the service then refuses to work. The payout
worker loads its ledger cache lazily in two stages after every deploy, and the deploy tooling cannot
pre-warm it. Success is `201` with `{ payout, amount, to, nonce }` and
`Location: /v2/payouts/P-<n>`.

### Events and abandoned requests

- `GET /v2/events` is a long poll, held open while nothing happens and then answered `200` with
  `{ events: [], next }`. `POST /v2/events` with `{ type }` publishes an event, answers `202` with
  `{ accepted: <id> }`, and releases held polls with `{ events: [{ id, type }], next: <id> }`.
- `GET /v2/ops/abandoned?atLeast=<n>` lists the held requests (`search` and `events`) whose client
  went away before the answer, as `{ abandoned: [{ route, target }] }` in the order the service
  noticed. With `atLeast`, it waits up to two seconds for that many before answering. SRE added it
  in 2018 so the load balancer's drain script could wait for clients to let go.

The events and abandoned-request routes need no token.

## Test options

Start the API with `lane.backend("business", { envelopes, operations })`; each member configures its
half, and both are optional. Every start has fresh state, so tests never share customers, orders,
tasks, caches, nonces or limiter state. Options are plain JSON. Every member of each half is
optional and replaces its default whole; the default data are small, generic sets, so pass the
values a test asserts on. The request ledger records each target as sent, before the `/v2/` gateway merges its
slashes.

### `envelopes`

- `customers`: seed customers, as `{ id, name, tier, creditHold? }` with `tier` an enum name.
  Created customers continue after the largest id, and from 1001 at least.
- `products`: the products orders may reference, as `{ sku, name, priceCents, discontinued? }`,
  served in this order by the OData facade, whose `ProductID` is the position.
- `ledger`: one ledger account, `{ account, entries: [{ id, amountCents, memo }] }`. Entry ids are
  decimal strings, because JSON numbers cannot carry them.
- `aging`: rows of the aging report, `{ customerId, name, current, overdue30 }`, in integer cents.
  The finished export reads the same rows.
- `warehouses`: warehouses by region code, `{ "<region>": [{ code, city }] }`.
- `regions`: `{ code, name }` entries.
- `currencies`: `{ code, decimals }` entries.
- `rates`: exchange rates against `base`, `{ base, rates: { "<code>": "<decimal>" } }`. The CDN's
  cached entry does not expire during a start.
- `pendingPolls`: how many status checks of an export report it pending. Defaults to 2.

### `operations`

- `token`: the only bearer token the service accepts. Defaults to `ops-token-2016`.
- `searchLatency`: milliseconds `GET /v2/search` waits before answering, per query text; queries not
  listed answer at once. A client abort ends the wait, and the search is recorded as abandoned.
- `longPollHold`: milliseconds `GET /v2/events` holds a poll open without events. Defaults to
  25 000.
- `clock`: fixed epoch milliseconds for data stamps such as a task's `created`, or `null` for the
  real time (the default). `Retry-After` timing always uses real time, because clients wait in real
  time.
- `tasks`: seed tasks, in the service's internal model:
  `{ title, assigneeId, priority, due, notes, done, created }`, where `due` is `null` or
  `{ epochMillis, offsetMinutes }` (`offsetMinutes` `null` writes no offset), `done` a boolean and
  `created` epoch milliseconds. Seeded tasks take the first ids.
- `customers`: invoice customers, `{ id, name, country }`.
- `invoices`: seed invoices, `{ id, customerId, amountCents, paid, issued, due, printed, tags,
poNumber?, seatLimit }`, where `due` is `{ epochMillis, offsetMinutes }`, `printed` is
  `{ year, month, day, hour, minute, second }`, `tags` an array, `poNumber` written as is (a string
  or `null`; a missing key stays missing), and `seatLimit` a count or `"unlimited"`.
- `invoicesModified`: the invoice routes' `Last-Modified` until a write, in epoch milliseconds of
  whole seconds.
- `catalog`: `{ prices, stale }`, each `[{ sku, cents }]`: the origin's prices and the stale list
  the edge holds for the plain path at start.
