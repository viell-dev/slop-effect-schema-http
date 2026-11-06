# Change history

## Unreleased

- Wait for npm version/attestation visibility after publication and provide a read-only recovery
  workflow that verifies the original qualification artifact without another upload
  ([#78](https://github.com/viell-dev/slop-effect-schema-http/issues/78)).
- Record the owner's decision that substantial API changes after `0.1.0` get an agent usability
  review instead of a human use pass
  ([#92](https://github.com/viell-dev/slop-effect-schema-http/issues/92)).
- Move to Effect 4.1.2 and Node.js 24.22.2, a Node.js security release, and refresh the development
  tools. Support Node.js 26, test it in CI and release qualification, and add monthly grouped
  dependency updates ([#106](https://github.com/viell-dev/slop-effect-schema-http/issues/106)).
- **Breaking:** let any method carry a body. `Request.compile` no longer refuses a body on GET or
  HEAD, so `fetch` users get a transport failure from the client where they used to get
  `Request.InvalidRequest` ([#96](https://github.com/viell-dev/slop-effect-schema-http/issues/96)).
- Put a query before a fragment. A `#` in a base URL or in `Request.path` output used to take the
  query into the fragment, where it never arrived as a query. The compiled request now keeps the
  fragment in its `hash` field rather than its URL text, and a custom `UrlEncoding.join` receives
  the base and path without fragments. A provider built with `HttpClient.makeWith` has to read
  `request.hash` ([#83](https://github.com/viell-dev/slop-effect-schema-http/issues/83)).
- Keep a fragment written in the constructor. `Request.make` and its shortcuts used to discard it.
  It now reaches the client in the `hash` field, exactly as written, and wins over a fragment in
  path output or a base URL. `fetch` still does not send a fragment. `Request.Declaration` gains
  `hash` ([#93](https://github.com/viell-dev/slop-effect-schema-http/issues/93)).
- Keep the spelling of header names. `Request.setHeader` and `Request.appendHeader` used to
  lowercase a name, so a provider that sends header lines could not deliver `X-API-Key`. Lines now
  keep the spelling they were written with, and comparing names still folds case, so `setHeader`
  replaces a line spelled differently and takes the new spelling. Client middleware still sees
  lowercase `Headers`, and `fetch` still sends lowercase names
  ([#101](https://github.com/viell-dev/slop-effect-schema-http/issues/101)).
- **Breaking:** let a request's own headers win over automatic ones. A declared `Accept`,
  `Content-Type` or `Content-Length` now takes effect, from a raw setter or a header schema, before
  or after the body, including on multipart and empty bodies. A declaration that used to be ignored
  now goes out. `Request.removeHeader(name)` now stops the automatic value, and `Request.Compiled`,
  `Draft` and `Declaration` gain `removedHeaders`
  ([#100](https://github.com/viell-dev/slop-effect-schema-http/issues/100)).
- **Breaking:** pass a constructor query to the client as written until something edits that entry.
  The library used to decode it and render it again, so `?a=1;b=2` became `?a=1%3Bb%3D2`, `?q=a+b`
  became `?q=a%20b`, `?a=1&&b=2` lost a segment and a lone `?` disappeared. Each entry keeps its
  text, stays editable by its decoded name, and goes through `UrlEncoding.query` once edited. A
  custom `UrlEncoding.query` no longer receives entries kept as written, and text the library used
  to escape, such as a space, is no longer escaped. `Request.Declaration` gains `emptyQuery` and
  `Draft` gains `queryText`
  ([#102](https://github.com/viell-dev/slop-effect-schema-http/issues/102)).

## 0.1.0 — 2026-11-04

First stable release, retaining the API and runtime behavior of `0.1.0-rc.1`. Existing candidate
consumers can update without code changes. Read [What's in
0.1](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.1) for the consumer
introduction.

- Give the opening guides distinct GET, POST, PATCH and DELETE examples, separate consumer and
  maintainer documentation, add complete checksum comparisons and introduce a consumer release
  article. Assume an existing Effect project, offer package-manager tabs, and explain named path
  inputs and operation input inference.
- Add module guides with executable examples, a complete installed-package quickstart, clearer
  navigation, and common-use explanations before advanced behavior
  ([#75](https://github.com/viell-dev/slop-effect-schema-http/issues/75)).
- Document every public export in the source and generated declarations; check docblock and Markdown
  TypeScript examples, and align request composition, failure explanations and publication guidance.
- Promote package metadata, unversioned install commands and source/release links together. The
  owner completed the final documentation review in
  [#67](https://github.com/viell-dev/slop-effect-schema-http/issues/67); qualification and
  publication are recorded in [#2](https://github.com/viell-dev/slop-effect-schema-http/issues/2).

## 0.1.0-rc.1 npm availability — 2026-11-03

Published the existing candidate to npm with the same tarball as the GitHub release. Both `rc` and
`latest` identified this prerelease during bootstrap. No API or behavior changes; use the explicit
candidate version when installing that historical release.

## 0.1.0-rc.1 — 2026-11-01

Read [What's in 0.1](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.1) for an
introduction to the consumer API.

First installable candidate for `0.1.0`, initially distributed through GitHub Releases. This
candidate is intended to become stable with documentation, version and release-metadata updates
after the [publication prerequisites](https://github.com/viell-dev/slop-effect-schema-http/issues/2)
are complete.

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

The [limits](https://viell-dev.github.io/slop-effect-schema-http/limits) remain part of the
contract: finite bodies, client-owned transport and browser policy, no server generation or general
cache. The remaining [release
review](https://github.com/viell-dev/slop-effect-schema-http/issues/67) is recorded separately from
automated qualification.
