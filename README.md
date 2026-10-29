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
corepack pnpm check
corepack pnpm lint
corepack pnpm test
```

`library-ref` names the library commit under test. `pnpm library` writes that commit's `src` tree
into `.library/` using Git alone, and the suite imports the library from that source. To test a
different commit, branch or tag, set `LIBRARY_REF` for both `pnpm library` and `pnpm test`. A run
refuses to start if `.library/` holds a different ref, and it prints the commit it tests.

The backends are `node:http` servers on ephemeral loopback ports, started inside each test. They
need no accounts, network access beyond loopback, secrets or private data. Two client providers
are exercised:

- Effect's Fetch provider, over Node's global `fetch`;
- a custom `node:http` provider in `src/harness/providers.ts`, which sends the library's original
  header lines and reports observed response lines.

[CATALOGUE.md](./CATALOGUE.md) maps each scenario to its tests or to a recorded limit.
