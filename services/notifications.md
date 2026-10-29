# The notification service, Notify (`notifications`)

Notify was built between 2014 and 2016 while the company moved its web front end to a single-page
app. Each layer was added by a different team for a different client, and every one of them still
has a caller somebody is afraid to break. The [test options](#test-options) at the end are for the
suite's tests, not part of the published service.

Requests pass the layers in the order they were stacked: the CORS filter, the web framework's CSRF
middleware, the API layer's Token authentication, then the HMAC check of the announce route. The
first layer that refuses a request answers it.

## Endpoints

| Method and path          | CSRF | Token | Signature |
| ------------------------ | ---- | ----- | --------- |
| `GET /v2/session/csrf`   |      |       |           |
| `POST /v2/subscriptions` | yes  | yes   |           |
| `POST /v2/announcements` | yes  | yes   | yes       |
| `GET /v2/announcements`  |      | yes   |           |
| `GET /v1/subscriptions`  |      | yes   |           |
| `GET /v1/channels`       |      | yes   |           |

`OPTIONS` on any path is a CORS preflight, answered as described under [CORS](#cors).

## Token authentication (2015)

The API layer reused Rails-style token authentication, realm and message included. Every route
except the CSRF bootstrap requires exactly one `Authorization` line of the form

```http
Authorization: Token token="<opaque>"
```

with the scheme name case-sensitive and the value quoted. Anything else answers 401
`text/plain; charset=utf-8` with `WWW-Authenticate: Token realm="Application"` and the body
`HTTP Token: Access denied.` and a line feed.

## CSRF (2014)

Every POST requires the double-submit pair: the `XSRF-TOKEN` cookie and the same token in the
`X-XSRF-TOKEN` header.

`GET /v2/session/csrf` issues a token, in the JSON body and as a cookie, with
`Cache-Control: no-store`:

```http
Set-Cookie: XSRF-TOKEN=<percent-encoded token>; Path=/; SameSite=Lax
```

```json
{ "csrfToken": "<token>" }
```

The framework's cookie helper percent-encodes values, such as `%3D%3D` for a token's `==`; the SPA's
HTTP library decodes the cookie before echoing it, so the header carries the decoded token. Only
issued tokens are accepted. The cookie is `SameSite=Lax`, set by the 2019 framework upgrade, so a
cross-site page never gets it back. The embedded-widget deployment, where the page and the API are
on different sites, sends it as `SameSite=None; Secure` instead.

When a request repeats a cookie, the first occurrence wins, as in the cookie parser the framework
ships with; several `Cookie` lines are read as one.

A failure answers 403 with the framework's own HTML page, whose `Reason:` line names the failed
check:

| `Reason:`                    | Cause                                                      |
| ---------------------------- | ---------------------------------------------------------- |
| `CSRF cookie not set.`       | no `XSRF-TOKEN` cookie                                     |
| `CSRF token missing.`        | no `X-XSRF-TOKEN` header, or an empty one                  |
| `CSRF token incorrect.`      | the header differs from the cookie's percent-decoded value |
| `CSRF token not recognised.` | the pair matches, but this service never issued the token  |

The CSRF check is the web framework's middleware, which predates the JSON API layer and renders its
own HTML page. The SPA's error interceptor matches on the status, so the page was never replaced.

## Announcements (2016)

Signed announcements arrived in 2016, after a leaked token was used to page every on-call engineer.

`POST /v2/announcements` takes a JSON body
`{ "channel": string, "subject": string, "body": string }` with the CSRF pair, the Token, and an
HMAC signature:

- `X-Notify-Timestamp`: epoch milliseconds, within the validity window of the server clock (five
  minutes);
- `X-Notify-Signature`: `v1=` and the lowercase hex HMAC-SHA256, keyed with the shared signing
  secret, over `METHOD \n path \n timestamp \n` followed by the exact body bytes. The path is the
  raw request target without its query.

A signature is spent once verified, even when the announcement then fails, so an attempt must be
signed again.

Success is 202 with the recorded announcement and `Location: /v2/announcements/<id>`:

```json
{
  "id": "ann_1",
  "channel": "month-end",
  "subject": "…",
  "body": "…",
  "receivedAt": "2026-10-29T12:00:00.000Z"
}
```

Signature failures are 401 JSON, `{ "error": { "code": … } }`, checked in this order:

1. `signature_missing`: a header is missing;
2. `timestamp_out_of_window`: the timestamp is not within the window, with `serverTime` and
   `windowMs` beside the code;
3. `signature_mismatch`;
4. `signature_replayed`: the signature was already spent.

After a valid signature, a blank or missing field is 422 `invalid_announcement` with its `field`.
The fan-out behind the announcement can answer:

- 503 `{ "error": { "code": "fanout_busy" } }` while it is busy, possibly with `Retry-After`;
- 500 with the platform's HTML error page;
- 409 `{ "error": { "code": "channel_frozen", "channel": … } }` for a frozen channel.

`GET /v2/announcements` lists the recorded announcements as `{ "announcements": [...] }`.

## Subscriptions

`POST /v2/subscriptions` takes `{ "channel": …, "address": … }` with the CSRF pair and the Token. It
answers 201 with `{ "id", "channel", "address" }` and `Location: /v2/subscriptions/<id>`; a blank or
missing field is 422 `invalid_subscription` with its `field`. Two subscriptions exist from the
start: `sub_1` (`billing`, `billing@example.test`) and `sub_2` (`incidents`, `oncall@example.test`).

## The legacy v1 routes

`GET /v1/subscriptions` answers `{ "subscriptions": [...] }`, and `GET /v1/channels` answers
`{ "channels": ["billing", "incidents", "month-end"] }`. Both announce their retirement, each
header added by a different team:

```http
Deprecation: @1767225599
Sunset: Sun, 31 Jan 2027 23:59:59 GMT
Warning: 299 - "Deprecated API: \"/v1\" retires 2026-06-30; use /v2" "Wed, 31 Dec 2025 23:59:59 GMT"
Warning: 299 notify-gw.example.test:8443 "v1 traffic is metered, billed per call"
Link: </v2/subscriptions>; rel="successor-version"
```

- **`Warning` (2015).** The original team announced the retirement in `Warning`, because the 2015
  Android SDK shows any 299 text as a banner. The text still has the first planned date; changing
  it needs an SDK release nobody will ship.
- **`Sunset` (2019).** The platform team added RFC 8594's `Sunset` when the retirement date was
  agreed.
- **The second `Warning` (2021).** The API gateway adds its own warning line for metered legacy
  traffic.
- **`Deprecation` (2025).** API governance added RFC 9745's `Deprecation` to the routes it knew
  about. The 2019 gateway rule on `/v1/channels` still sends the draft-era `Deprecation: true`, and
  nobody owns that rule.

## CORS

A hand-rolled CORS filter answers for the allowed browser origins, with credentials allowed. It
decorates every application response to an allowed `Origin` with
`Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true` and
`Vary: Origin`. The v1 routes expose only `Warning`, which the 2015 web banner read:
`Access-Control-Expose-Headers: Warning`, not `Deprecation`, `Sunset` or `Link`.

Preflights (`OPTIONS`):

- **`/v2/announcements`** refuses any requested header outside its list with 403 and a plain-text
  reason, so `b3` and `traceparent` fail, as does an origin that is not allowed. The 2016 security
  review of signed announcements demanded a strict filter that refuses any header outside its list.
  Tracing arrived in 2021; the filter has not been re-reviewed. The list is `Authorization`,
  `Content-Type`, `X-XSRF-TOKEN`, `X-Notify-Timestamp` and `X-Notify-Signature`.
- **`/v2/subscriptions`** omits `Content-Type` from its list:
  `Authorization, X-XSRF-TOKEN, X-Requested-With`. The endpoint copied its allowlist in 2015 from
  the v1 form endpoint, whose form-encoded bodies never needed `Content-Type` listed.
- **Other `/v2/` paths** list `Authorization, Content-Type, X-XSRF-TOKEN, X-Requested-With` without
  checking what was requested.
- **v1 paths** are answered by the servlet container: 200 with `Allow: GET, OPTIONS` and no CORS
  headers. The v1 routes still run in the 2013 servlet container, which answers `OPTIONS` itself
  from the methods the servlet implements. The application, and with it the CORS filter and every
  header the application adds, never sees the request.

The filter's preflight answers are 204 with `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
`Access-Control-Allow-Headers`, `Access-Control-Max-Age: 600` and `Vary: Origin`, plus the origin
and credentials lines for an allowed origin.

## Test options

Start the service with `lane.backend("notifications", options)`. Every start has fresh state:
issued CSRF tokens, spent signatures, subscriptions and announcements. Options are plain JSON.

- `acceptedToken` (required): the opaque token accepted under the `Token` scheme.
- `signingSecret` (required): the shared HMAC-SHA256 key for announcement signatures.
- `allowedOrigins` (required): the browser origins the CORS filter answers for.
- `windowMs`: the allowed distance between a signature's timestamp and the server clock. Defaults
  to 300 000 (five minutes).
- `clockOffsetMs`: added to the real clock to form the server clock, to simulate clock skew.
  Defaults to 0.
- `csrfCookieSameSite`: `"Lax"` (the default) or `"None"`, which sends the cookie with
  `SameSite=None; Secure`, as the embedded-widget deployment does.
- `announce`: the fan-out's failure point, applied only to announcements that passed every check
  above:
  - `unavailable: { times, retryAfter? }` answers the first `times` such announcements with 503
    `fanout_busy`, after spending their signatures, with `retryAfter` sent verbatim as
    `Retry-After` when given;
  - `fail: "error"` answers every one with the 500 page, and `fail: "frozen"` with 409
    `channel_frozen`;
  - `holdMs` holds each one this long before answering. A client that goes away during the hold
    leaves nothing recorded.
- `cors`: the hostile CORS behaviours, each on (`true`) by default. The browser lane switches one
  off to reach an endpoint without the same-origin proxy.
  - `subscriptionsOmitContentType`: `false` lists `Content-Type` for `/v2/subscriptions`.
  - `strictAnnouncements`: `false` makes `/v2/announcements` preflights list every header, including
    `traceparent` and `b3`, without checking.
  - `v1ContainerOptions`: `false` lets the filter answer v1 preflights like other paths.
  - `v1ExposeWarningOnly`: `false` exposes `Warning`, `Deprecation`, `Sunset` and `Link` on v1
    responses.

In the browser lane the page is on another site than the backend, so pass
`csrfCookieSameSite: "None"` for the XSRF cookie to come back. When the backend answers CORS itself
(the lane's `{ cors: "backend" }` start option), include the page's origin (`location.origin`) in
`allowedOrigins`.
