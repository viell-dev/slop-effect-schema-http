# Effect Schema HTTP: hostile-API integration suite

This branch holds a server-backed integration suite for
[Effect Schema HTTP](https://github.com/viell-dev/slop-effect-schema-http). Five synthetic backends
reproduce the conventions of real APIs that a client does not control: an identity provider, a SOAP
document store, a JSON business API, a CGI reporting gateway, and a notification service. Each one
carries decades of plausible historical accidents. The suite checks that one consumer can talk to
all of them through the library's public API, without escaping it.

Agents write and maintain this suite. Its code is not human-reviewed.

## Why a separate branch

The backends are deliberately heavy, so they stay out of the library's `main` branch. This branch
has its own history and never merges into `main`. Each run tests a specific library commit, which
the suite fetches from this repository.

The scenario catalogue and acceptance criteria are tracked in
[issue #4](https://github.com/viell-dev/slop-effect-schema-http/issues/4). Changes to the suite
arrive through pull requests into this branch.

## Running the suite

Use the Node.js version in `.nvmrc` and the npm it bundles; `package.json` requires npm 11.19 or
later.

```sh
npm ci
npm run library                   # fetch the library source at the commit in library-ref
npx playwright install chromium   # once, for the browser lane
npm run check
npm run lint
npm test                          # the Node lane, then the browser lane, then the catalogue
```

`npm test` runs each lane as its own Vitest run (`npm run test:node`, then
`npm run test:browser`), so a lane that finds no tests fails instead of passing behind the other.
Each run writes a JUnit report to `artifacts/junit-node.xml` or `artifacts/junit-browser.xml`, and
`npm run test:catalogue` then reads both. To run part of the suite, use
`npx vitest run <file> --project node` (or `browser`).

`.npmrc` sets `ignore-scripts=true`, so no dependency's install script runs; none of the current
dependencies needs one. Commit `package-lock.json` with any dependency change.

`library-ref` names the library commit under test. `npm run library` writes that commit's `src`
tree into `.library/` using Git alone, and the suite imports the library from that source. To test
a different commit, branch or tag, set `LIBRARY_REF` for both `npm run library` and `npm test`. A
run refuses to start if `.library/` holds a different ref, and it prints the commit it tests.

The backends are `node:http` servers on ephemeral loopback ports, started for each test. They need
no accounts, network access beyond loopback, secrets or private data, and they are black boxes:
the consumer reaches them only over HTTP. `npm run check` runs `scripts/boundaries.mjs`, which
resolves every import, following `package.json` `imports` and `tsconfig.json` `paths` aliases: a
backend may import only Node built-ins, other backend modules and the harness's server and router,
consumer code may import neither a backend nor a Node-side harness module, and the backend-side
conformance tests in `src/conformance/` may import neither a backend nor consumer code. A `#…`
specifier that resolves to nothing and an undeclared package are refused. `npm run check` also runs
the script's own tests, `scripts/boundaries.test.mjs`, on generated fixture trees.

Each service is documented the way its owners would publish it for integrators, on a page under
[services/](./services/): endpoints, formats, conventions, errors and the history of each quirk,
with the options a test can set. New work writes the two sides in separate agent contexts, so that
one misreading of a format cannot hide on both: a backend from the [catalogue](./CATALOGUE.md) and
its service page, and the consumer side from the service page, the catalogue and observed HTTP
behaviour, without opening `src/backends/`. Code written before this rule was written by one agent
per area; it is checked against recordings of real software and independent parsers instead
([#32](https://github.com/viell-dev/slop-effect-schema-http/issues/32),
[#33](https://github.com/viell-dev/slop-effect-schema-http/issues/33)). `scripts/boundaries.mjs`
checks that every backend links its page; [AGENTS.md](./AGENTS.md) states the full rule. The
independent parsers are [saxes](https://github.com/lddubeau/saxes) in Node, Chromium's `DOMParser`
and each platform's `Response.formData()`; `src/scenarios/parsers.test.ts` compares the consumer's
and the backends' XML, XML-RPC and multipart readers with them over the edge-case corpora in
`src/formats/corpus/` (catalogue entries EXT-3 to EXT-5).

The quirks that come from server software are held to that software.
[recordings/](./recordings/README.md) holds raw HTTP exchanges recorded, byte for byte, from Perl's
Frontier::RPC2 and XMLRPC::Lite, httpd 2.4's Digest and `Redirect permanent`, Tomcat 7 and the
JAX-WS reference implementation in JDK 8, each in a disposable Docker container from an image
pinned by digest. `npm run record -- <set>` makes a set again; it needs Docker, runs on demand and
never in CI. The `replay` backend ([services/replay.md](./services/replay.md)) serves the recorded
responses over a real socket, and the Node-lane tests in `src/conformance/` send each recorded
request to the backend that imitates the software and pin every difference that remains, as the
service pages explain (catalogue entries EXT-6a to EXT-6e). On the consumer's side,
`src/scenarios/recordings.test.ts` decodes the replayed responses through the consumer's own
operations in both lanes (EXT-8a to EXT-8d).

Every scenario runs in two lanes. The Node lane runs the consumer in Node. The browser lane runs
the same tests in headless Chromium through Vitest browser mode, to show that the library works in
a browser page; there, a Node-side control server starts the backends, and the browser enforces
CORS, forbidden headers, cookies and redirects itself. The tests run as test code in the page, not
as a built application; [the app lane](#the-app-lane) runs a single-page app built by a bundler.

By default the control server, not the backend, answers each backend's CORS preflights and exposes
every response header, so a browser-lane scenario runs under permissive CORS. Only a test that
starts a backend with the start option `{ cors: "backend" }` meets the backend's own CORS, as the
notification service's HDR-7 tests do.

Tests that need Node, such as the line-preserving provider, live in `*.node.test.ts` files; tests
about the browser itself, such as a page's CORS, live in `*.browser.test.ts` files. The test
page's server also hosts a same-origin proxy (`src/harness/proxy.ts`), so a page can reach a
backend without CORS, as a deployed single-page app does through its own server. The client
providers are:

- Effect's Fetch provider, over Node's global `fetch` or the browser's;
- in the Node lane, a custom `node:http` provider in `src/harness/providers.ts`, which sends the
  library's original header lines and reports observed response lines.

[CATALOGUE.md](./CATALOGUE.md) maps each scenario to its tests or to a recorded limit.
`npm run check` verifies it against the test sources: every entry has a status, and every entry
marked tested has a test whose title carries its ID. `npm test` verifies it against the executed
results: every entry marked tested has a passed, not skipped, test carrying its ID in at least one
lane. An entry marked `Lane: app` runs only in the app lane, and only `npm run app` checks it.

### The packed lane

The packed lane tests the library as an application installs it. Use the source lanes above for
everyday work, because they need no build; run the packed lane as well after moving `library-ref`,
or when a change concerns how the suite imports the library. CI runs both.

```sh
npm run library:pack   # also build and pack the library at library-ref, and install the package
npm run packed         # the Node lane, its catalogue check and a type-check, against the package
```

`npm run library:pack` fetches the source as `npm run library` does, then writes the whole commit
into `.library/build/` with Git, runs `npm ci` and `npm run build` there, and packs the package
with `npm pack` into `.library/viell-effect-schema-http.tgz`. It installs that tarball into the
suite's `node_modules` with `npm install --no-save`, where the package finds the suite's own
`effect` as its peer, and `.library/PACKED` records the commit it was packed from. Install scripts
stay off for the library's build too. `npm run packed` then runs:

- `packed:test`, the Node lane without the source alias, so `viell-effect-schema-http` resolves
  through the package's `exports` map. It adds `src/harness/package.packed.test.ts`, which imports
  the package root and every subpath export the installed `package.json` lists. The run refuses to
  start unless `node_modules` holds the package packed for the requested ref, and it writes
  `artifacts/junit-packed.xml`. For part of it, use `npx vitest run <file> --mode packed`.
- `packed:catalogue`, the catalogue check against that report alone: every entry marked tested
  needs a passed test in the packed lane.
- `packed:tsc`, the whole suite type-checked against the package's emitted declarations with
  `tsconfig.packed.json`, without `skipLibCheck`. Tests named `*.packed.test.ts` are type-checked
  only there and run only in this lane. `npm run check` refuses a `tsconfig.packed.json` whose
  aliases differ from `tsconfig.json`'s by more than the library's, so the boundary check holds in
  both.

The packed lane covers the package's `exports` map, its emitted JavaScript and declarations, and
the peer `effect` as npm resolves it. It does not cover the browser lane, which always imports the
source, or a bundled application, which the app lane covers. Nor does it isolate the
package from the suite's other dependencies: a package the library imports without declaring it
would go unnoticed if the suite happens to install it. A check of the packed package in an
isolated consumer, in the library's own CI, is tracked in
[#15](https://github.com/viell-dev/slop-effect-schema-http/issues/15).

### The app lane

The app lane runs the library as a static single-page app does: built by a bundler, served as
static files, and used by someone who navigates, searches again before an answer arrives, and
reloads. It needs the package that `npm run library:pack` installs, so CI runs it after the packed
lane.

```sh
npm run library:pack   # as for the packed lane
npm run app            # build the app, drive it in Chromium, and check the catalogue
```

The app in `src/app/` is a small task search over the business service: plain DOM, a history-API
router that gives each page a scope of its own, and the search box of APP-1
(`src/clients/flows/search.ts`), one `Interaction` per mounted search page. It is consumer code
under the same boundary check as `src/clients/`. The page reads the service's origin from its `api`
query parameter, because each test starts the service on an ephemeral port, and calls only its own
origin, through the same-origin proxy. `npm run app` runs:

- `app:test`, the app project. Its global setup refuses a missing or stale package, as the packed
  lane's does, then builds the app with `vite build --config vite.app.config.ts`, in production
  mode, into `.app/`. The build has no alias for the library, so Vite resolves
  `viell-effect-schema-http` through the installed package's `exports` map, and it fails unless
  every library module it bundles comes from the package's `dist/`. The setup then serves `.app/`
  on a loopback port, with the proxy of `src/harness/proxy.ts` in front, and answers any other path
  without an extension with `index.html`, so a route loaded directly or reloaded is rendered by the
  app's router. The tests, `*.app.test.ts`, start backends with the Node lane and drive the page
  with Playwright's Chromium. The run writes `artifacts/junit-app.xml`. For part of it, use
  `npx vitest run <file> --mode app`.
- `app:catalogue`, the catalogue check against that report: every entry marked `Lane: app` needs a
  passed test there.
