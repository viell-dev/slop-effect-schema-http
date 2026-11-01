# Versions and contributing

## Compatibility policy

The agreed first-stable goal is `0.1.0`: the existing finite-body APIs documented in
[Design](./design.md), with the [qualified environments and exclusions](./limits.md). Compatible
fixes use `0.1.x`; a breaking public API change requires `0.2.0` and migration guidance. Release
candidates are intended to become that stable version, subject to qualification and the outstanding
publication checks.

`0.1.0-rc.1` is a GitHub-only candidate. The npm package name is `viell-effect-schema-http`, but it
is not yet available from the registry. Use the checksummed tarball in the [installation
guide](./getting-started.md). [Release
readiness](https://github.com/viell-dev/slop-effect-schema-http/issues/2) records the agreed scope,
evidence and remaining gates.

## Documentation version policy

The public default site describes the newest stable installable release. Until the first stable
release, it describes the newest GitHub candidate. Unreleased changes on `main` do not automatically
deploy. The navigation reads the package version, and each page records `library-version` and
`documentation-commit` metadata. A local build with uncommitted edits carries `-dirty`.

The documentation workflow builds a published release tag, or a documentation-only correction
descending from that tag. The correction must retain the package version and may change only
`docs/`. Correct documentation through a pull request, then redeploy and record the documentation
commit. Software tags and package bytes stay fixed. The next release replaces those corrections with
its own documentation. A documentation deployment does not publish a package.

## Contribute or verify a change

The [contribution
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md) owns setup,
tests, labels and review. Required pull-request checks build the library and this site, run the
typed executable example, validate internal links and anchors, and exercise behavior, sockets and
isolated installation.
[Releasing](https://github.com/viell-dev/slop-effect-schema-http/blob/main/RELEASING.md) owns
complete candidate qualification, artifact publication and recovery.

Documentation source is excluded from the package. VitePress 2 is a prerelease pinned exactly.
Dependency install scripts remain disabled. For API changes, explain the consumer problem and
compare it with [Design](./design.md).
