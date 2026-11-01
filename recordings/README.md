# Recordings of real server software

Several of the suite's quirks come from server software rather than from the platform: Perl's
XML-RPC encoders, Apache's Digest and redirects, a servlet container's `Location`, a SOAP stack's
faults, and CGI.pm's query parser. The backends imitate them in TypeScript. The recordings here are
what the real software writes, byte for byte, so that the imitations, and the consumer reading them,
are held to that software instead of to one author's reading of it
([#32](https://github.com/viell-dev/slop-effect-schema-http/issues/32)).

Each recording is synthetic data served by real software in a disposable Docker container. The
recordings are checked in and made on demand, never in CI.

## The sets

| Set                | Software                                                         | Imitated by                             | Catalogue             |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------- | --------------------- |
| `frontier-rpc2`    | Frontier::RPC2 0.07b4 under Frontier::Daemon, Perl 5.36 (Debian) | the gateway's `/RPC2`                   | EXT-6a                |
| `xmlrpc-lite`      | XMLRPC::Lite 0.717 on SOAP::Lite 1.27, its HTTP daemon (Debian)  | the gateway's `/RPC2`                   | EXT-6a                |
| `httpd-digest`     | httpd 2.4.68, `mod_auth_digest` with `AuthDigestQop none`; curl  | the gateway's `/admin/audit.cgi`        | EXT-6b                |
| `httpd-redirect`   | httpd 2.4.69, `mod_alias` `Redirect permanent`                   | the gateway's `/cgi-bin/rpt.exe`        | EXT-6c                |
| `tomcat7-redirect` | Tomcat 7.0.109 on OpenJDK 8, defaults and `useRelativeRedirects` | the business API's `POST /v1/customers` | EXT-6d                |
| `jaxws-faults`     | the JAX-WS reference implementation in JDK 8 (Temurin)           | the SOAP store's `LockDocument`         | EXT-6e                |
| `cgi-pm-query`     | CGI.pm 4.55 on Perl 5.36, HTTP::Daemon 6.16 (Debian)             | the gateway's CGI query handling        | AUTH-2                |
| `httpd-dav`        | httpd 2.4.69, stock `mod_dav` and `mod_dav_fs`                   | the store's WebDAV view                 | STAT-7, PAY-3a, RET-3 |
| `nginx-paths`      | nginx 1.30.6, default `merge_slashes on`                         | the business API's `/v2` gateway        | QRY-3                 |
| `express-jsonp`    | Express 5.3.0 `res.jsonp`, Node 24.21.0                          | the business API's `/v1/rates`          | PAY-1                 |

Each set's `manifest.json` names its base images by digest, the software versions as the software
reports them, the date of the recording, the exact commands, and every exchange. Its `set.json`
lists the substitutions made, such as httpd 2.4 for Apache 1.3, and why. What each recording
showed, and how each backend answers it, is in the backend's service page under "Recordings" and
in the catalogue's entries.

The CGI.pm set uses the same digest-pinned Debian/Perl base as the XML-RPC sets. Its small balance
handler passes the raw query to CGI.pm and reads parameters in scalar context, so CGI.pm owns
splitting, percent decoding and first-value selection. Only the documented synthetic report and
session-error replies are supplied by the handler. Eleven targets exercise plus and semicolon as
data or separators, repeated and empty/name-only sessions, equals signs and lowercase escapes.
These recordings hold query outcomes to CGI.pm 4.55, not to a historical CGI.pm or Apache 1.3
installation. Name-only and empty sessions both produce the service's session-error outcome;
those replies do not distinguish an absent value from an empty one inside the parser.

The WebDAV set uses two static UTF-8 files, two subcollections and fixed modification times.
Stock mod_dav produces the multistatus, missing-property groups, quoted charset, method lists and
conditional replies. Its full property sets, prefixes, href spelling/order and metadata differ
from DocVault's deliberately restricted servlet view; backend tests retain and pin those
differences. The exact conditional ETags were copied from an initial GET. `FileETag MTime Size`
keeps file tags independent of inode allocation. If the dataset, timestamps or ETag configuration
changes, take the new GET tag, update the definition's conditional headers, then re-record the set.
Never edit the raw HTTP files. An initial pass is a way to discover a validator, not a replacement
for the final recorded conditional exchange.

The nginx set uses exact-match locations returning synthetic global and individual task histories.
No handler normalizes paths: nginx selects the location with its default
[`merge_slashes on`](https://nginx.org/en/docs/http/ngx_http_core_module.html#merge_slashes).
Six exchanges retain the original and normalized URI in diagnostic headers, covering an empty id,
longer slash runs, valid-id controls and query slash preservation. This probes current nginx's
routing, without the service's authentication or historical gateway deployment. It does not cover
percent decoding, dot segments or other nginx normalization rules.

The Express set passes a fixed rates object directly to stock
[`res.jsonp`](https://expressjs.com/en/5x/api/response/#resjsonp). Its eight replies establish the
guarded frame, repeated-callback selection, plain/empty-callback JSON, and the framework's dotted
and sanitized callbacks. The recording uses all Express defaults with an exact dependency lock;
it adds neither the service's identifier-only validator nor its path-only CDN cache. Conformance
pins these deliberate differences, including a sequential cache check. Consumer replay decodes
the replies as data in both lanes; it does not execute them as scripts or claim to reproduce the
historical storefront deployment.

## Files

A set's directory holds:

- `Dockerfile`, and the server configuration or the small program the server runs, written for the
  recording: the Perl handlers, httpd's configuration and CGI, the servlet, the JAX-WS endpoints.
  The base image is pinned by digest, and Debian packages by version.
- `data.json`, for the XML-RPC, WebDAV and Express sets: the synthetic data served by the real software,
  also used to configure the imitating backend in the comparison.
- `package.json` and `package-lock.json`, for the Express set: the exact framework and transitive
  package versions and integrity hashes installed in its container. These are separate from the
  suite's dependencies.
- `set.json`: the description, the `Host` the requests carry, the server's port, a probe request,
  the commands that report versions, the substitutions, and the exchanges in order.
- `<name>.request.http` and `<name>.response.http`: one exchange exactly as the bytes crossed the
  connection, CRLF and chunked framing included. `.gitattributes` keeps Git from converting them
  and permits their CRLF and terminating blank header lines in whitespace checks.
- `manifest.json`, written by the recorder.

## Making a recording

```sh
npm run record -- <set>
```

`scripts/record.mjs` builds the set's image as `hostile-recording-<set>`, starts it as a container
of that name with the server's port published on an ephemeral loopback port, waits for the server
to answer a probe, and records the versions. It then performs the exchanges in order:

- a request from the script over a raw TCP socket, written as `set.json` lists it, with `Host`
  first and `Content-Length` and `Connection: close` added;
- the exact bytes of an earlier exchange's request, sent again, after an optional wait;
- a curl command run in its own container from a pinned image, which reaches the server through a
  relay in the script that keeps both directions' bytes. curl's own `--trace` is not used: it
  leaves out the body of a 401 it reads while negotiating Digest.

It writes the exchanges and the manifest, removes `.http` files of exchanges no longer listed, and
removes the container whether or not the recording succeeded. The image stays as a build cache;
`docker image rm hostile-recording-<set>` removes it. The relay listens on `127.0.0.1`, which
Docker Desktop's `host.docker.internal` reaches; on a Docker engine whose containers cannot reach
the host's loopback interface, set `RECORD_RELAY_HOST` to an address they can.

A re-recording changes every `Date` and nonce, and the Perl sets fix Perl's hash seed so that
struct members keep their order. WebDAV filesystem `creationdate` values also reflect the new
container's files; fixed modification times do not fix filesystem change times. Review the diff:
other changes reflect the software, filesystem or set, and conformance tests show whether the
backends still agree.

## How the tests use them

- **The replay backend** ([services/replay.md](../services/replay.md)) serves recorded responses
  over a real socket, so consumer tests decode the real software's bytes in both lanes:
  `src/scenarios/recordings.test.ts` runs the consumer's own operations against them (catalogue
  entries EXT-8a to EXT-8d); `src/scenarios/cgi-query.test.ts` checks the CGI.pm set (AUTH-2),
  `src/scenarios/webdav-recordings.test.ts` checks mod_dav (STAT-7, PAY-3a, RET-3),
  `src/scenarios/nginx-paths.test.ts` checks nginx routing and the application contract's empty-id
  validation (QRY-3), and `src/scenarios/express-jsonp.test.ts` checks Express JSONP and callback
  validation/binding (PAY-1).
- **The conformance tests** in `src/conformance/` send each recorded request to the backend that
  imitates the software, over a raw socket, and compare the reply with the recorded response. They
  are backend-side code, kept apart from the consumer side by `scripts/boundaries.mjs`.

### Comparing

A test may adapt a recorded request only where the backend serves the same thing differently, and
names each adaptation: the gateway's `session` parameter, the gateway's own Digest nonce, the
store's one address for both SOAP versions, the business API's ids.

Values that change with every run are masked on both sides, and each test names its masks: `Date`;
a Digest nonce, checked to have the shape httpd gives it; and a struct's member order, which Perl
takes from its hash order, new with every process.

Every other difference is listed by `differences` and pinned by the test, each with the reason the
backend keeps it: an imitation of older software that no recording can reach, such as Apache
1.3's pages, or the suite's own HTTP server. The server's differences are the same everywhere:

- **Framing.** Node's server chunks a reply whose backend gives no `Content-Length`. Where the
  recorded software counts its replies and the backend writes them in one place, the backend sends
  `Content-Length` too; otherwise the difference stays.
- **Connection management.** Node's server answers `Connection: close` to a request that asks to
  close, and `Connection: keep-alive` with `Keep-Alive` to one it keeps open; the recorded servers
  often say nothing.
- **Header spelling and order.** Header names are compared without regard to case, and a different
  spelling is listed on its own, such as the JDK server's `Content-type`. Header order is not
  compared, since HTTP gives it no meaning except among lines of one name.

## Not recorded

The original recording issue declined these sets; the affected catalogue entries explain their
limits. [#47](https://github.com/viell-dev/slop-effect-schema-http/issues/47) supplements the first
two with hand-authored contract references:

- **German Excel's CSV** (PAY-5): Excel cannot run in a disposable container, and LibreOffice would
  stand in for different software. The [hand-made CSV](../fixtures/gateway/german-accounts.md)
  checks the documented bytes and meanings without claiming a real Excel save.
- **The fixed-width extract** (PAY-4c): the [hand-made file](../fixtures/gateway/README.md) checks
  the documented unsigned, zero-padded layout. No mainframe or COBOL recording establishes that a
  real installation emits this layout.
- **WCF's `jsonerror` responses and the `d` wrapper** (the portal facade in APP-2): hosting WCF
  needs .NET Framework and an HTTP.sys URL reservation on the host, not a container.
- **Apache 1.3's error pages** (STAT-10, AUTH-7, PAY-3b): no maintained image exists, and building
  25-year-old software is out of proportion to the value. httpd 2.4 stands in for the behaviour,
  not for the pages.
