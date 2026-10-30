# Recordings of real server software

Several of the suite's quirks come from server software rather than from the platform: Perl's
XML-RPC encoders, Apache's Digest and redirects, a servlet container's `Location`, a SOAP stack's
faults. The backends imitate them in TypeScript. The recordings here are what the real software
writes, byte for byte, so that the imitations, and the consumer reading them, are held to that
software instead of to one author's reading of it
([#32](https://github.com/viell-dev/slop-effect-schema-http/issues/32)).

Each recording is synthetic data served by real software in a disposable Docker container. The
recordings are checked in and made on demand, never in CI.

## The sets

| Set                | Software                                                         | Imitated by                             | Catalogue |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------- | --------- |
| `frontier-rpc2`    | Frontier::RPC2 0.07b4 under Frontier::Daemon, Perl 5.36 (Debian) | the gateway's `/RPC2`                   | EXT-6a    |
| `xmlrpc-lite`      | XMLRPC::Lite 0.717 on SOAP::Lite 1.27, its HTTP daemon (Debian)  | the gateway's `/RPC2`                   | EXT-6a    |
| `httpd-digest`     | httpd 2.4.68, `mod_auth_digest` with `AuthDigestQop none`; curl  | the gateway's `/admin/audit.cgi`        | EXT-6b    |
| `httpd-redirect`   | httpd 2.4.69, `mod_alias` `Redirect permanent`                   | the gateway's `/cgi-bin/rpt.exe`        | EXT-6c    |
| `tomcat7-redirect` | Tomcat 7.0.109 on OpenJDK 8, defaults and `useRelativeRedirects` | the business API's `POST /v1/customers` | EXT-6d    |
| `jaxws-faults`     | the JAX-WS reference implementation in JDK 8 (Temurin)           | the SOAP store's `LockDocument`         | EXT-6e    |

Each set's `manifest.json` names its base images by digest, the software versions as the software
reports them, the date of the recording, the exact commands, and every exchange. Its `set.json`
lists the substitutions made, such as httpd 2.4 for Apache 1.3, and why. What each recording
showed, and how each backend answers it, is in the backend's service page under "Recordings" and
in the catalogue's EXT-6 entries.

## Files

A set's directory holds:

- `Dockerfile`, and the server configuration or the small program the server runs, written for the
  recording: the Perl handlers, httpd's configuration and CGI, the servlet, the JAX-WS endpoints.
  The base image is pinned by digest, and Debian packages by version.
- `data.json`, for the two XML-RPC sets: the synthetic data both Perl servers serve, which is also
  the gateway's test options in the comparison.
- `set.json`: the description, the `Host` the requests carry, the server's port, a probe request,
  the commands that report versions, the substitutions, and the exchanges in order.
- `<name>.request.http` and `<name>.response.http`: one exchange exactly as the bytes crossed the
  connection, CRLF and chunked framing included. `.gitattributes` keeps Git from converting them.
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
struct members keep their order. Review the diff: anything else that changed is a change in the
software or the set, and the conformance tests show whether the backends still agree.

## How the tests use them

- **The replay backend** ([services/replay.md](../services/replay.md)) serves recorded responses
  over a real socket, so consumer tests decode the real software's bytes in both lanes.
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

The issue declines four recordings; the affected catalogue entries say so:

- **German Excel's CSV** (PAY-5): Excel cannot run in a disposable container, and LibreOffice would
  stand in for different software.
- **The fixed-width extract** (PAY-4c): its layout uses only unsigned, zero-padded fields, so a
  COBOL writer would add nothing the suite's writer lacks.
- **WCF's `jsonerror` responses and the `d` wrapper** (the portal facade in APP-2): hosting WCF
  needs .NET Framework and an HTTP.sys URL reservation on the host, not a container.
- **Apache 1.3's error pages** (STAT-10, AUTH-7, PAY-3b): no maintained image exists, and building
  25-year-old software is out of proportion to the value. httpd 2.4 stands in for the behaviour,
  not for the pages.
