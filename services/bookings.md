# The regional booking service, Berth (`bookings`)

Berth books quay slots for container ships. It began in 2006 as one application server in
Rotterdam, and every layer between a client and that application was added after an incident, by a
team that has since moved on: the load balancer in 2008, its firmware in 2011 and 2013, the
compression module in 2014, the regions in 2016, and the repeat keys in 2019. Terminal operators
wrote their crane and gate software against whatever each layer did at the time, so nobody removes
anything. The [test options](#test-options) at the end are for the suite's tests, not part of the
published service.

## Regions

Berth runs as separate regions, each a server with its own base URL, its own bookings and its own
edge. A region's paths start at its root. Nothing in the service says which regions exist: an
integrator keeps a list and asks each one in turn. Every region serves the same endpoints.

| Method and path                                 | What it does                                   |
| ----------------------------------------------- | ---------------------------------------------- |
| `GET /v1/health`                                | Says which service and region answered         |
| `POST /v1/bookings`                             | Books a slot                                   |
| `GET /v1/bookings`                              | Lists the bookings committed in this region    |
| `GET /v1/bookings/<id>`                         | Reads one booking                              |
| `GET /v1/keys/<key>`                            | Reads the booking committed under a repeat key |
| `GET /v1/manifest`                              | The day's manifest, as text                    |
| `GET /v1/availability?terminal=<name>`          | A terminal's open slots                        |
| `POST /v1/availability/release?terminal=<name>` | Lets a held board answer finish                |
| `GET /v1/export/<name>`                         | One of the exports                             |
| Any method on a moved path                      | A redirect, from the region's own table        |

Anything else answers 404 with `text/plain` `Not Found`, or 405 with `Allow` for another method on
a path. Berth reads no credential: production terminals authenticate at a gateway outside the
region, and it passes `Authorization`, `Cookie` and `X-Agent-Key` through unread. A region sets no
cookies.

## Health (2012)

`GET /v1/health` answers 200 `application/json`:

```json
{ "service": "berth", "region": "eu", "status": "ok" }
```

It was added for the load balancer's probe, and integrators took it up as the way to tell that a
host they found is really Berth: a host can answer 200 and be something else, as
[Lapsed names](#lapsed-names-2017) explains.

## Bookings (2006)

`POST /v1/bookings` takes `application/json`, with three non-empty strings:

```json
{ "vessel": "MV Aurora", "terminal": "rotterdam", "slot": "2026-11-07T06:00" }
```

A commit answers `201 Created` with `Location: /v1/bookings/<id>`, relative, and the booking:

```json
{
  "id": "eu-000001",
  "region": "eu",
  "vessel": "MV Aurora",
  "terminal": "rotterdam",
  "slot": "2026-11-07T06:00",
  "key": null,
  "replayed": false
}
```

An id is the region, a hyphen and a six-digit count from 1 in commit order, so a repeated booking
shows as a second id, and the region that made it shows in the id. A body that is not such an
object answers 400 `application/json` `{ "error": "invalid_booking" }`, and nothing is committed.
Berth does not refuse a second booking of the same slot: operators overbook on purpose.

`GET /v1/bookings` answers 200 with every booking committed in this region, in commit order, each
with `replayed` false:

```json
{ "region": "eu", "bookings": [] }
```

`GET /v1/bookings/<id>` answers 200 with one booking, or 404 `{ "error": "not_found" }`.

Each booking is committed before anything else happens to its answer. That order is the oldest
quirk in Berth: the application writes the booking and then replies, and every layer below can lose
the reply. A client that gets no answer cannot tell from that whether its booking exists.

## Repeat keys (2019)

After a retry storm double-booked a whole week at one terminal, bookings gained an
`Idempotency-Key` line: up to 64 letters, digits and hyphens. A key with anything else answers 400
`{ "error": "invalid_key" }`. A booking without a key behaves as above, and the key field of its
booking is `null`.

| The key is                           | Answer                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Unknown here and at the peer         | A commit, as above, with the key in the booking                             |
| Known here, with the same body bytes | 200, the stored booking with `replayed` true, and `Idempotent-Replay: true` |
| Known here, with other body bytes    | 409 `{ "error": "key_reused" }`, and nothing committed                      |
| Known to the peer                    | 200, the peer's booking with `replayed` true, and `Idempotent-Replay: true` |

`GET /v1/keys/<key>` answers 200 with the booking committed under that key in this region, with
`replayed` false, or 404 `{ "error": "unknown_key" }`. It is how a client finds out what happened
to a booking whose answer it lost, and how a region asks its peer.

A region can have one peer. Before it commits a keyed booking, a region with a peer asks it with
`GET /v1/keys/<key>`, over a plain HTTP link of its own. A 200 means the peer already has the
booking. Anything else, including a link that cannot connect or has not answered within a second,
counts as the peer not knowing the key, and the region commits. Bodies are not compared across
regions. The design note of 2019 says a region must never stop taking bookings because its peer is
down, so a key protects a client only as far as that link holds.

## The edge

An edge sits between a client and each region. It answers for the region, and it damages what the
region says. What it does is described as a fault applied to the region's answer: the answer's
status and lines, and its body, the bytes the region would have sent. The [test
options](#test-options) say which faults apply to which requests.

- **The idle reaper (2008).** The load balancer reclaims a connection the moment the application
  has finished with it, and under load it does that before the answer has been written, so a
  committed booking gets no answer. Faults `closed` and `reset`.
- **Cut answers (2011).** A firmware release that shared one buffer between connections stops an
  answer wherever the buffer ran out. Faults `cut-head`, `cut-body`, `cut-body-reset`,
  `cut-chunked`, `cut-unframed` and `cut-unavailable`.
- **The chunk bug (2013).** The release that taught the load balancer chunked framing writes two
  wrong bytes after a chunk when its buffer wraps. Fault `bad-chunk`.
- **The compression module (2014).** It compresses every answer it is told to, whatever
  `Accept-Encoding` says, because every browser of the time sent it, and it damages some of what it
  compresses. A client that reads no gzip gets the stream as the body. Faults `gzip` and the
  `gzip-` ones.
- **Slow drains (2015).** When a gate system stalls, an answer can stop part-way, or never start.
  Faults `trickle` and `hang`.
- **Failure pages.** The edge has its own 502 page and its own 503. Neither carries the region's
  CORS lines, because the edge has never heard of them. Faults `bad-gateway` and `unavailable`.

### Lapsed names (2017)

Each region's name is a domain somebody has to renew. One lapsed in 2017 and came back as a parked
page, and a tide-table service once took over a retired host. Both answered 200, and integrators
that checked only the status booked into nothing. Faults `parked` and `other-service`.

### Faults

Below, A is the region's answer to the request and B its body. A head written here has A's status
line and A's lines, with the framing the table says, and no others.

| Fault             | What the client receives                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`          | Nothing. The connection closes in order.                                                                                                                                |
| `reset`           | Nothing. The connection is reset.                                                                                                                                       |
| `cut-head`        | A's status line, then the bytes `Content-Ty`, and the connection closes.                                                                                                |
| `cut-body`        | A's head with `Content-Length` of all of B, then the first half of B, rounded down, and the connection closes.                                                          |
| `cut-body-reset`  | The same, then 50 ms later the connection is reset.                                                                                                                     |
| `cut-chunked`     | A's head with `Transfer-Encoding: chunked`, the first half of B as one chunk, and the connection closes with no last chunk.                                             |
| `cut-unframed`    | A's head with `Connection: close` and no length, then the first half of B, and the connection closes.                                                                   |
| `cut-unavailable` | Instead of A, the head of `unavailable` with `Content-Length: 16`, then the first eight bytes of its body, and the connection closes.                                   |
| `bad-chunk`       | The same head as `cut-chunked`, the first half of B as a chunk with `XX` where its CRLF belongs, the second half as a chunk, the last chunk, and the connection closes. |
| `gzip`            | A whole, with `Content-Encoding: gzip`, B as a valid gzip stream, and `Content-Length` of the stream.                                                                   |
| `gzip-magic`      | The same, with the stream's first byte zero, so it is not gzip.                                                                                                         |
| `gzip-block`      | The same, with the first deflate block set to the reserved type, so nothing decompresses.                                                                               |
| `gzip-checksum`   | The same, with the CRC wrong, so all of B decompresses and only the end shows it.                                                                                       |
| `gzip-truncated`  | The same, with the second half of the stream gone, and `Content-Length` of what is left.                                                                                |
| `gzip-trailer`    | The same, with only the stream's last eight bytes gone, and `Content-Length` of what is left.                                                                           |
| `trickle`         | A's head with `Content-Length` one more than B's length, then B one byte every 20 ms, then nothing, so it never finishes.                                               |
| `hang`            | Nothing. The connection stays open until the client goes.                                                                                                               |
| `bad-gateway`     | Instead of A, a complete 502 `text/html` with the body `<html><body>502 Bad Gateway</body></html>`.                                                                     |
| `unavailable`     | Instead of A, a complete 503 `text/plain` with `Retry-After: 60` and the body `Try again later.`.                                                                       |
| `parked`          | Instead of A, a complete 200 `text/html` with the body `<html><body>This domain is parked.</body></html>`.                                                              |
| `other-service`   | Instead of A, a complete 200 `application/json` with the body `{"service":"tides","status":"ok"}`.                                                                      |

`gzip`, the `gzip-` faults, `bad-gateway`, `unavailable`, `parked` and `other-service` are complete
answers, on a connection that stays open as any other's. Every other fault ends the connection, or
leaves it unusable.

## The manifest (2006)

`GET /v1/manifest` answers 200 `text/plain; charset=utf-8` with 100 lines of nine bytes each: `line
001`, then a line feed, up to `line 100`, so 900 bytes. Reports built on it read it whole, and the
manifest is what most cut answers were found on, because it was the longest thing the first
firmware carried.

## The availability board (2015)

`GET /v1/availability?terminal=<name>` answers 200 `application/json` with a terminal's open slots:

```json
{ "terminal": "rotterdam", "open": ["06:00", "07:00", "08:00", "09:00"] }
```

The wallboards at the terminals poll it, and the board writes its answer as it reads each gate
system. A terminal whose gate system has stalled is held: its answer goes out with `Content-Length`
and the first half of its body, rounded down, and then waits. `POST
/v1/availability/release?terminal=<name>` answers 204 and lets every answer waiting for that
terminal finish with the rest of its body, on the connection it started on. A client that goes away
first ends the wait. The next request for a held terminal is held again.

## Moved paths (2016)

The Rotterdam move left each region with a table from old paths to where they went. A request for
a path in the table, by any method, answers the table's status, with `Location` exactly as the
table has it, relative or absolute, and `Content-Length: 0`. A table can point at another region,
at another moved path, or back at itself, because nobody checks it. The table is read before any
other route, and edge faults apply to its answers as to any other.

## The exports (2009)

`GET /v1/export/<name>` runs a Perl job that prints its own head and body, which the web server
passes on without reading, and the job's authors each had their own idea of a head. Each export
below is written as it stands, with nothing added, and the connection closes after it. `J` is the
eleven bytes `{"ok":true}`, and `CT` is the line `Content-Type: application/json`. Lines end in CRLF
and the head ends with a blank line unless the row says otherwise. An unknown name answers 404.

| Name                 | Status line       | Lines of the head                                                                         | Body                                  |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| `two-types`          | `HTTP/1.1 200 OK` | `Content-Type: text/plain`, `CT`, `Content-Length: 11`                                    | `J`                                   |
| `same-type-twice`    | `HTTP/1.1 200 OK` | `CT`, `CT`, `Content-Length: 11`                                                          | `J`                                   |
| `no-type`            | `HTTP/1.1 200 OK` | `Content-Length: 11`                                                                      | `J`                                   |
| `odd-charset`        | `HTTP/1.1 200 OK` | `Content-Type: text/plain; charset=no-such-charset`, `Content-Length: 11`                 | `J`                                   |
| `latin1-value`       | `HTTP/1.1 200 OK` | `CT`, `X-Vessel: M` byte FC `ller`, `Content-Length: 11`                                  | `J`                                   |
| `utf8-value`         | `HTTP/1.1 200 OK` | `CT`, `X-Vessel: M` bytes C3 BC `ller`, `Content-Length: 11`                              | `J`                                   |
| `nul-value`          | `HTTP/1.1 200 OK` | `CT`, `X-Vessel: a` byte 00 `b`, `Content-Length: 11`                                     | `J`                                   |
| `ctl-value`          | `HTTP/1.1 200 OK` | `CT`, `X-Vessel: a` byte 01 `b`, `Content-Length: 11`                                     | `J`                                   |
| `folded-value`       | `HTTP/1.1 200 OK` | `CT`, `X-Vessel: a`, a line of one space and `b`, `Content-Length: 11`                    | `J`                                   |
| `bare-lf`            | `HTTP/1.1 200 OK` | `CT`, `X-Vessel: a`, `Content-Length: 11`, with every line of the head ending in LF alone | `J`                                   |
| `no-colon`           | `HTTP/1.1 200 OK` | `CT`, `garbage`, `Content-Length: 11`                                                     | `J`                                   |
| `two-lengths`        | `HTTP/1.1 200 OK` | `CT`, `Content-Length: 11`, `Content-Length: 5`                                           | `J`                                   |
| `same-length-twice`  | `HTTP/1.1 200 OK` | `CT`, `Content-Length: 11`, `Content-Length: 11`                                          | `J`                                   |
| `length-and-chunked` | `HTTP/1.1 200 OK` | `CT`, `Content-Length: 3`, `Transfer-Encoding: chunked`                                   | `J` as one chunk, then the last chunk |
| `no-reason`          | `HTTP/1.1 200`    | `CT`, `Content-Length: 11`                                                                | `J`                                   |
| `http10`             | `HTTP/1.0 200 OK` | `CT`                                                                                      | `J`                                   |
| `bad-status`         | `HTTP/1.1 abc OK` | `CT`, `Content-Length: 11`                                                                | `J`                                   |
| `status-99`          | `HTTP/1.1 99 Odd` | `CT`, `Content-Length: 11`                                                                | `J`                                   |
| `no-version`         | `200 OK`          | `CT`, `Content-Length: 11`                                                                | `J`                                   |

These four are text, for what a reader does at the edge of a character. They are `text/plain;
charset=utf-8`. The first three are chunked, and each split below is a chunk boundary with a 25 ms
pause at it, so that the two sides arrive apart. They end with the last chunk.

| Name          | Body                                                   | Split or framing                                |
| ------------- | ------------------------------------------------------ | ----------------------------------------------- |
| `split-utf8`  | `Grüße` in UTF-8, seven bytes                          | After three bytes, inside `ü`                   |
| `split-emoji` | `ship 🚢 ok` in UTF-8, twelve bytes                    | After seven bytes, inside the four-byte ship    |
| `split-bom`   | The bytes EF BB BF, then `ok`                          | After one byte, inside the byte-order mark      |
| `cut-utf8`    | `Gr`, then byte C3, the first half of `ü`, three bytes | Not chunked: `Content-Length: 3`, written whole |

## CORS (2017)

A region answers CORS itself only where its operators turned the filter on. Without it, a region
sends no CORS lines and answers `OPTIONS` like any other method on a path.

With it, `OPTIONS` on any path answers 204 and goes to no edge fault, with
`Access-Control-Allow-Origin` echoing the request's `Origin`, `Access-Control-Allow-Methods: GET,
POST`, `Access-Control-Allow-Headers` naming the list the region was given, joined with `, `, and
`Vary: Origin`. Any other answer with an `Origin` gains `Access-Control-Allow-Origin` and
`Vary: Origin`, unless it is a fault's own page or head, which the filter never sees.

The filter's list was written for the 2017 single-page app and never updated, so a client that adds
headers it does not name, such as trace headers, is refused at the preflight and finds a working
region looking dead.

## Test options

Start a region with `lane.backend("bookings", options)`. Each start is a new region with no
bookings. Options are plain JSON, and every member is optional.

- `region`: the region's name, in `/v1/health`, bookings and ids. Defaults to `"eu"`.
- `edge`: the edge's rules, a list of `{ route, fault, phase?, after?, times? }`. A request is
  matched against the list in order. A rule that matches counts the request, and the first rule
  that has counted past its `after` and has `times` left applies, with the rules below it not
  consulted. A request that no rule takes goes on as normal. `OPTIONS` matches no rule when the CORS
  filter is on.
  - `route`: `"<METHOD> <path>"`, such as `"POST /v1/bookings"`, with the path compared to the
    request's without its query, or `"*"` for every request.
  - `fault`: a name from the table of [faults](#faults).
  - `phase`: `"after"`, the default, lets the region act first, so a booking is committed before
    the fault. `"before"` keeps the request from the region, so nothing is committed, and takes
    only `closed`, `reset`, `hang`, `bad-gateway`, `unavailable`, `parked` and `other-service`;
    any other fault with it is a mistake in the options, and the start fails.
  - `after`: how many matching requests this rule lets past first. Defaults to 0.
  - `times`: how many requests it then applies to. Defaults to every one after that.

  A request passes the CORS filter first, then any rule with `phase: "before"`, then the region,
  which reads its moved paths and then its routes, and then any rule with `phase: "after"`, which
  works on the answer the region gave.

- `peer`: the base URL of this region's peer, for [repeat keys](#repeat-keys-2019). Defaults to
  none. Start the peer first, and pass its `origin`.
- `redirects`: the [moved paths](#moved-paths-2016), an object from a path, compared to the
  request's without its query, to `{ status, location }`. Defaults to none. For a hop to another
  region, start that region first and put its `origin` in `location`.
- `held`: terminal names whose [availability answers](#the-availability-board-2015) are held.
  Defaults to none.
- `cors`: `{ allowHeaders: [...] }` turns on the [CORS filter](#cors-2017) with that list. Defaults
  to off. It matters only under the start option `{ cors: "backend" }`; otherwise the browser lane's
  harness answers CORS, and this filter never sees a preflight.

For example, a region that commits the first booking and loses its answer, and whose peer holds the
keys:

```json
{
  "region": "us",
  "peer": "http://127.0.0.1:50123",
  "edge": [{ "route": "POST /v1/bookings", "fault": "closed", "times": 1 }]
}
```
