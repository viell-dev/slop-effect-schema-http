# Versions

## Compatibility policy

The supported API covers finite-body HTTP contracts, ESM, Node 24 on Windows/Linux and Chromium
Fetch with Effect 4. See [compatibility and limits](./limits.md) for the tested versions and
exclusions. Compatible fixes use `0.1.x`; a breaking public API change requires `0.2.0` and
migration guidance.

`0.1.0-rc.1` is a release candidate for `0.1.0`, available from npm and GitHub. Install the explicit
`viell-effect-schema-http@0.1.0-rc.1` version as shown in [Getting started](./getting-started.md).
[Release readiness](https://github.com/viell-dev/slop-effect-schema-http/issues/2) tracks
qualification and the remaining publication prerequisites.

## Update or remove an installation

Read the [change history](./changelog.md) before updating. Install your chosen published version
with `npm install viell-effect-schema-http@VERSION`, replacing `VERSION` with that release's number.
An explicit version makes the choice clear even when moving from a local tarball to npm.

The `rc` tag selects a candidate. During this first-release bootstrap, `latest` also identifies
`0.1.0-rc.1`; it is not evidence of a stable release. The first stable publication will move
`latest` to `0.1.0`. Use the explicit version while evaluating the candidate.

For a tarball installation, download the chosen version from [GitHub
Releases](https://github.com/viell-dev/slop-effect-schema-http/releases), verify its checksum, and
install the file as in Getting started.

Commit your application's lockfile so deployments use the dependency versions you tested. Review
Effect updates too: its HTTP modules are unstable upstream, and behavior can change across minor
versions even within the declared peer range.

Remove the library with:

```sh
npm uninstall viell-effect-schema-http
```

Remove `effect` only if the project no longer uses it elsewhere.

## Documentation version policy

The default site describes the newest stable installable release, or the newest GitHub candidate
before the first stable release. The navigation and footer show that version. Documentation on
`main` can describe work awaiting release; it does not automatically replace the public site.

A current-release documentation correction keeps the software version unchanged. Each page's
`library-version` and `documentation-commit` metadata identifies what it describes and where it was
built. History belongs in the changelog; upgrade instructions accompany releases that need them.

## Contribute or verify a change

Use the [contributor
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md) for checkout
setup, tests, documentation editing and pull requests.
[Releasing](https://github.com/viell-dev/slop-effect-schema-http/blob/main/RELEASING.md) owns
qualification, publication, documentation deployment and current-release corrections.
