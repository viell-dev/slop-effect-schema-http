# Effect Schema HTTP and Warded: request-head and service suite

This branch holds an integration suite that tests two projects against each other over real
sockets:

- [Effect Schema HTTP](https://github.com/viell-dev/slop-effect-schema-http), which describes the
  requests a client sends;
- [Warded](https://github.com/viell-dev/slop-warded-router), which selects a route from the request
  head, served by the [Warded Server](https://github.com/viell-dev/slop-warded-server).

Both projects work the same way on their own side of a request. A definition is a value that a
caller adjusts without changing it, and selection is ordered: the library's response cases and
Warded's routes both take the first complete match. The suite checks the request head between them:
whatever the library can declare, Warded should see as declared, and every kind of condition Warded
can match, the library should be able to satisfy.

It covers the dimensions Warded matches on: path, query parameters, method, headers, the `Accept`
family, HTTP version, transport security and host.

It also tests the library against services built on Warded: route tables shaped like real APIs,
whose handlers answer with the conventions real services use, such as odd statuses, error shapes
that differ by status, repeated `Set-Cookie` lines, JSONP, challenges and redirects, and whose
routes match the way such services read a request, such as by forwarded fields or `;` queries.
The tests check what the library decodes or refuses of each answer, and the records show what the
server did with it on the way. The
[hostile suite](https://github.com/viell-dev/slop-effect-schema-http/tree/hostile-servers-test)
keeps the rest: its own servers write what Hyper does not let a handler write, such as truncated
replies and malformed status lines, and it imitates many more services with their bodies and
formats.

Agents write and maintain this suite. Its code is not human-reviewed. This branch has its own
history and never merges into `main`.

## How it works

Each test writes a route table as data, in [`src/harness/routes.ts`](./src/harness/routes.ts). Every
condition is named after the `warded` function it calls, and a Rust host,
[`host/`](./host/), builds those routes with the router at the commit under test. It serves each
table on three listeners:

| Listener | Server                                                  | Transport security it reports |
| -------- | ------------------------------------------------------- | ----------------------------- |
| `plain`  | The router under `axum::serve`, as an application would | None, so `Unknown`            |
| `http`   | The Warded Server's cleartext listener                  | `Unsecure`                    |
| `https`  | The Warded Server: HTTP/1.1, HTTP/2 and HTTP/3          | `Https`                       |

The library sends requests to a table through each provider the lane has, and the suite collects
four records of each exchange, in the order they happen:

1. **The wire.** A recording proxy in front of each cleartext listener keeps the request heads that
   the client wrote. On `https`, which it cannot read, the HTTP/2 and HTTP/3 providers below record
   the fields they wrote. The proxies read HTTP/1 only: of HTTP/2 with prior knowledge they keep the
   preface, and the HTTP/2 provider's record holds the fields.
2. **What the server saw.** The host records the head the HTTP stack gave the router: method,
   version, URI, path, query, header map and transport security.
3. **What the router chose.** The host asks `Router::select` about that head, apart from dispatch.
4. **What ran.** The selected target reports the selection and captures in its request's
   extensions, the captures as the server's `Params` extractor decodes them, and the body it read.
   The exchange also keeps the status the application answered, before the server finished the
   response, which can replace it.

So a mismatch says where it belongs. A wrong wire points at the library or the HTTP client it uses.
A right wire and a wrong head point at the server's HTTP stack. A right head and a wrong choice point
at the router. Every exchange is also checked for dispatch running the route that `select` chose,
with the same captures.

### Lanes and providers

The Node lane uses each client an application might use: Node's `fetch`, undici and `node:http`
through `@effect/platform-node`, and a provider that keeps the library's original header lines. A
raw provider writes the composed request to a socket as it is, for requests that no standard client
sends. Undici negotiates HTTP/2 over TLS; the others stay on HTTP/1.1.

For HTTP/2 heads that no standard client sends, an HTTP/2 provider hands the composed request to
the host's own HTTP/2 client, `warded-test-host h2`, one connection per request. It writes the
header block field by field, as plain HPACK literals in the order given, and refuses nothing, so a
test can repeat, move, drop or add pseudo-header fields. It records the fields it wrote and what
came back: a response, a reset stream, a stream that ended after informational heads only, or a
closed connection. It speaks HTTP/2 over TLS to
`https`, and with prior knowledge (h2c) to the cleartext listeners. It also records the server's
SETTINGS, and the size of the header block it wrote and the frames that carried it, which the
limits on encoded heads count.

An HTTP/3 provider does the same over QUIC to the HTTP/3 endpoint of `https`, through
`warded-test-host h3`. It writes the field section as QPACK literals, without Huffman codes or the
dynamic table, allows the server no dynamic table either, and records what came back: a response,
a reset stream or a closed connection with its code. It also records the SETTINGS on the server's
control stream and the size of the field section. It uses Quinn, at the version and with the
features that the Warded Server uses; the framing and QPACK are the host's own, since h3's client
builds its heads from the `http` crate's types, which hold none of these shapes.

The browser lane runs the same tests in Chromium with the page's own `fetch`. Chromium accepts the
host's certificate by the hash of its key, and is told to use HTTP/3 on one port, which the HTTP/3
test serves. No standard Node client speaks HTTP/3, so that test of ordinary requests runs only in
the browser.

Tests that need Node itself live in `*.node.test.ts` files, and tests that need a browser in
`*.browser.test.ts` files.

### Service tables

A service table in [`src/apis/`](./src/apis/) is an ordinary route table whose targets answer the
way a real service does: with a fixed reply, or with a lookup by one of the route's decoded
captures, the way an application reads a record by its id. Each table, route and reply says which
convention it imitates, with synthetic names and data. The consumer side, the library's
description of the same API, sits beside it.

| Table                                 | What it imitates                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`parcels.ts`](./src/apis/parcels.ts) | A parcel-tracking API behind an edge proxy: error shapes by status and layer, statuses from 100 to 999, `Set-Cookie` lines with a clearing cookie of the same name, PURGE                                                   |
| [`reports.ts`](./src/apis/reports.ts) | A CGI-style reporting gateway: a report for a trusted forwarded hop only, `;` queries, JSONP, a Digest challenge, and temporary, permanent, relative, cross-origin and looping redirects, with an archive on another origin |

| File                                                                       | What it checks                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`paths.test.ts`](./src/scenarios/paths.test.ts)                           | Path values, templates and renderers against `exact_path` and `path`               |
| [`queries.test.ts`](./src/scenarios/queries.test.ts)                       | Query writers against `param_pair` and `param_present`                             |
| [`methods.test.ts`](./src/scenarios/methods.test.ts)                       | Method helpers and method names against Warded's method conditions                 |
| [`headers.test.ts`](./src/scenarios/headers.test.ts)                       | Header declarations and automatic headers against header conditions                |
| [`negotiation.test.ts`](./src/scenarios/negotiation.test.ts)               | Automatic `Accept` and declared languages against offer sets                       |
| [`negotiation-edges.test.ts`](./src/scenarios/negotiation-edges.test.ts)   | Wildcards, weights, repeated fields and strict negotiation errors                  |
| [`limits.test.ts`](./src/scenarios/limits.test.ts)                         | Path captures and negotiation field boundaries                                     |
| [`transport.test.ts`](./src/scenarios/transport.test.ts)                   | Version, transport security and host                                               |
| [`selection.test.ts`](./src/scenarios/selection.test.ts)                   | Variants against ordered routes, fallthrough, fallbacks and errors                 |
| [`raw.node.test.ts`](./src/scenarios/raw.node.test.ts)                     | Requests only the raw provider sends                                               |
| [`hostile-heads.node.test.ts`](./src/scenarios/hostile-heads.node.test.ts) | Malformed HTTP/1.1 heads, the server's host rules and false lengths                |
| [`http2-heads.node.test.ts`](./src/scenarios/http2-heads.node.test.ts)     | Malformed HTTP/2 heads, `:authority` against `Host`, split cookies, h2c            |
| [`http3-heads.node.test.ts`](./src/scenarios/http3-heads.node.test.ts)     | The same heads over HTTP/3                                                         |
| [`head-limits.node.test.ts`](./src/scenarios/head-limits.node.test.ts)     | Head limits over HTTP/2 and HTTP/3, their SETTINGS, negotiation fields             |
| [`http3.browser.test.ts`](./src/scenarios/http3.browser.test.ts)           | The same conditions over HTTP/3                                                    |
| [`parcels.test.ts`](./src/scenarios/parcels.test.ts)                       | The parcels table through every provider: what the library decodes                 |
| [`parcels.node.test.ts`](./src/scenarios/parcels.node.test.ts)             | What the servers wrote for those answers, through the recording providers          |
| [`reports.test.ts`](./src/scenarios/reports.test.ts)                       | The reports table through every provider: what each decodes, follows or hands over |
| [`reports.node.test.ts`](./src/scenarios/reports.node.test.ts)             | Its repeated fields and redirects over HTTP/2 and HTTP/3, as both sides wrote them |

## Running the suite

You need the Node.js version in [.nvmrc](./.nvmrc) with the npm it bundles, Rust through `rustup`
(the version is in [rust-toolchain.toml](./rust-toolchain.toml)), and Git.

```sh
npm ci
npm run library                   # write the library at the commit in refs.json into .library/
npm run host                      # build the host with the locked Warded commits
npx playwright install chromium   # once, for the browser lane
npm run check
npm run lint
npm test                          # the Node lane, then the browser lane
```

`npm test` runs each lane as its own Vitest run, `npm run test:node` and `npm run test:browser`, so
a lane that finds no tests fails instead of passing behind the other. Each writes a JUnit report to
`artifacts/`. To run one file, use `npx vitest run <file> --project node` (or `browser`). A run
refuses to start when `.library/` or the host was made from other commits or sources than those it
names, and prints the three commits it tests.

`.npmrc` sets `ignore-scripts=true`, so no dependency's install script runs.

### The commits under test

- **The library:** `library` in [refs.json](./refs.json), or `LIBRARY_REF` for both `npm run library`
  and `npm test`. `npm run library` writes that commit's `src` into `.library/` with Git alone.
- **The router and the server:** the `rev`s in [host/Cargo.toml](./host/Cargo.toml), locked in
  `host/Cargo.lock`. The host takes the router through `warded_server::warded`, and a
  `[patch.crates-io]` entry replaces the release the server pins with the router commit, so both
  use one set of types. `npm run host` refuses a lock that holds a `warded` from anywhere else.

To test other Warded commits, change a `rev`, then run
`cargo update --manifest-path host/Cargo.toml -p warded -p warded-server` and `npm run host`. The
patch applies only while the router's version equals the one the server pins. A router commit with
a later version needs a server commit that pins it.

## Reporting what the suite finds

A test that finds a project behaving contrary to its documentation pins what it observed, says so
in a comment, and links an issue in the repository that owns the behaviour:

- the library: [slop-effect-schema-http](https://github.com/viell-dev/slop-effect-schema-http/issues);
- the router: [slop-warded-router](https://github.com/viell-dev/slop-warded-router/issues);
- the server: [slop-warded-server](https://github.com/viell-dev/slop-warded-server/issues).

Problems with the suite itself go to the library's repository, which holds this branch. Changes to
the suite arrive through pull requests into this branch.
