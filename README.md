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

Use the Node.js version in `.nvmrc` and the pnpm version in `package.json`. Corepack can run the
pinned pnpm.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm library   # fetch the library source at the commit in library-ref
corepack pnpm exec playwright install chromium   # once, for the browser lane
corepack pnpm check
corepack pnpm lint
corepack pnpm test      # the Node lane, then the browser lane, then the catalogue against both
```

`pnpm test` runs each lane as its own Vitest run (`pnpm test:node`, then `pnpm test:browser`), so a
lane that finds no tests fails instead of passing behind the other. Each run writes a JUnit report
to `artifacts/junit-node.xml` or `artifacts/junit-browser.xml`, and `pnpm test:catalogue` then reads
both. To run part of the suite, use `corepack pnpm exec vitest run <file> --project node` (or
`browser`).

`library-ref` names the library commit under test. `pnpm library` writes that commit's `src` tree
into `.library/` using Git alone, and the suite imports the library from that source. To test a
different commit, branch or tag, set `LIBRARY_REF` for both `pnpm library` and `pnpm test`. A run
refuses to start if `.library/` holds a different ref, and it prints the commit it tests.

The backends are `node:http` servers on ephemeral loopback ports, started for each test. They need
no accounts, network access beyond loopback, secrets or private data, and they are black boxes:
the consumer reaches them only over HTTP, and lint forbids imports between the two sides.

Every scenario runs in two lanes. The Node lane runs the consumer in Node. The browser lane runs
the same tests in headless Chromium through Vitest browser mode, to show that the library works in
a static single-page app; there, a Node-side control server starts the backends, and the browser
enforces CORS, forbidden headers, cookies and redirects itself. Tests that need Node, such as the
line-preserving provider, live in `*.node.test.ts` files; tests about the browser itself, such as
a page's CORS, live in `*.browser.test.ts` files. The test page's server also hosts a same-origin
proxy (`src/harness/proxy.ts`), so a page can reach a backend without CORS, as a deployed
single-page app does through its own server. The client providers are:

- Effect's Fetch provider, over Node's global `fetch` or the browser's;
- in the Node lane, a custom `node:http` provider in `src/harness/providers.ts`, which sends the
  library's original header lines and reports observed response lines.

[CATALOGUE.md](./CATALOGUE.md) maps each scenario to its tests or to a recorded limit. `pnpm check` verifies
it against the test sources: every entry has a status, and every entry marked tested has a test
whose title carries its ID. `pnpm test` verifies it against the executed results: every entry marked
tested has a passed, not skipped, test carrying its ID in at least one lane.
