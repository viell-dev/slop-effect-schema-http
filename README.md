# Effect Schema HTTP and Warded: request-head suite

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
family, HTTP version, transport security and host. It does not repeat the wide range of the
[hostile suite](https://github.com/viell-dev/slop-effect-schema-http/tree/hostile-servers-test),
which tests the library against imitations of real services, including their bodies and formats.

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
   the client wrote.
2. **What the server saw.** The host records the head the HTTP stack gave the router: method,
   version, URI, path, query, header map and transport security.
3. **What the router chose.** The host asks `Router::select` about that head, apart from dispatch.
4. **What ran.** The selected target reports the selection and captures in its request's
   extensions, the captures as the server's `Params` extractor decodes them, and the body it read.

So a mismatch says where it belongs. A wrong wire points at the library or the HTTP client it uses.
A right wire and a wrong head point at the server's HTTP stack. A right head and a wrong choice point
at the router. Every exchange is also checked for dispatch running the route that `select` chose,
with the same captures.

### Lanes and providers

The Node lane uses each client an application might use: Node's `fetch`, undici and `node:http`
through `@effect/platform-node`, and a provider that keeps the library's original header lines. A
raw provider writes the composed request to a socket as it is, for requests that no standard client
sends. Undici negotiates HTTP/2 over TLS; the others stay on HTTP/1.1.

The browser lane runs the same tests in Chromium with the page's own `fetch`. Chromium accepts the
host's certificate by the hash of its key, and is told to use HTTP/3 on one port, which the HTTP/3
test serves. No Node provider here speaks HTTP/3, so that test runs only in the browser.

Tests that need Node itself live in `*.node.test.ts` files, and tests that need a browser in
`*.browser.test.ts` files.

| File                                                                       | What it checks                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`paths.test.ts`](./src/scenarios/paths.test.ts)                           | Path values, templates and renderers against `exact_path` and `path` |
| [`queries.test.ts`](./src/scenarios/queries.test.ts)                       | Query writers against `param_pair` and `param_present`               |
| [`methods.test.ts`](./src/scenarios/methods.test.ts)                       | Method helpers and method names against Warded's method conditions   |
| [`headers.test.ts`](./src/scenarios/headers.test.ts)                       | Header declarations and automatic headers against header conditions  |
| [`negotiation.test.ts`](./src/scenarios/negotiation.test.ts)               | Automatic `Accept` and declared languages against offer sets         |
| [`limits.test.ts`](./src/scenarios/limits.test.ts)                         | Path captures and negotiation field boundaries                       |
| [`transport.test.ts`](./src/scenarios/transport.test.ts)                   | Version, transport security and host                                 |
| [`selection.test.ts`](./src/scenarios/selection.test.ts)                   | Variants against ordered routes, fallthrough, fallbacks and errors   |
| [`raw.node.test.ts`](./src/scenarios/raw.node.test.ts)                     | Requests only the raw provider sends                                 |
| [`hostile-heads.node.test.ts`](./src/scenarios/hostile-heads.node.test.ts) | Malformed HTTP/1.1 heads, the server's host rules and false lengths  |
| [`http3.browser.test.ts`](./src/scenarios/http3.browser.test.ts)           | The same conditions over HTTP/3                                      |

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
