# Change history

## 0.1.0-rc.1 — 2026-11-01

First installable candidate for `0.1.0`, distributed through GitHub Releases only. No npm package
has been published. This candidate is intended to become stable with a version and release-metadata
update after the [publication
prerequisites](https://github.com/viell-dev/slop-effect-schema-http/issues/2) are complete.

- Consumer-owned request and response contracts, finite body codecs, ordered response selection,
  retry policies, header-line interoperability, replaceable URL encoding and scoped interactions.
- Preserve literal question marks at the start of declared query keys, including bare keys
  ([#66](https://github.com/viell-dev/slop-effect-schema-http/issues/66)).
- Installable ESM package with strict declarations, all public subpath exports, MIT license and
  source maps; remove the development-only `private` flag.
- Checksummed tarball and runnable synthetic consumer example, verified in an isolated installation.
  Release qualification covers Windows/Linux, Effect 4.0.7/4.1.1 package consumers, and all four
  hostile-server lanes.
- Published installation, compatibility, recovery and release procedures.
- Refresh Effect, ESLint, mdrefine and compatible transitive dependencies, and qualify TypeScript 7
  consumers. The build/lint toolchain retains TypeScript 6 until typescript-eslint supports 7
  ([#69](https://github.com/viell-dev/slop-effect-schema-http/issues/69)).

The [limits](./limits.md) remain part of the contract: finite bodies, client-owned transport and
browser policy, no server generation or general cache. The separate [human
check](https://github.com/viell-dev/slop-effect-schema-http/issues/67) is required before stable
publication; automated qualification does not replace it.
