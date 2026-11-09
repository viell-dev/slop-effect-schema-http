# Versions

## Choose a release

`0.11.0` is the current stable release, available from npm and GitHub. [Getting
started](./getting-started.md) adds the current stable package to your Effect project. [What's in
0.11](./release-notes/0.11.md) describes the steps to update from `0.10`, because encoded aliases
beside mixed common fields can now refuse instead of taking a default. [What's in
0.10](./release-notes/0.10.md), [What's in 0.9](./release-notes/0.9.md), [What's in
0.8](./release-notes/0.8.md), [What's in 0.7](./release-notes/0.7.md), [What's in
0.6](./release-notes/0.6.md), [What's in 0.5](./release-notes/0.5.md), [What's in
0.4](./release-notes/0.4.md), [What's in 0.3](./release-notes/0.3.md), [What's in
0.2](./release-notes/0.2.md) and [What's in 0.1](./release-notes/0.1.md) introduce the earlier
releases.

The npm `latest` tag selects the stable release, so ordinary install commands need no version
suffix. The `rc` tag still identifies `0.1.0-rc.1`; use an explicit prerelease version when
evaluating a candidate.

## Update or remove an installation

Read the release article and any migration instructions before updating. Install your chosen
published version with `npm install viell-effect-schema-http@VERSION`, replacing `VERSION` with its
release number. Commit your application's lockfile so deployments use the dependency versions you
tested.

Review Effect updates too. Its HTTP modules are unstable upstream, and behavior can change across
minor versions within the declared peer range.

Remove the library with:

```sh
npm uninstall viell-effect-schema-http
```

Remove `effect` only if the project no longer uses it elsewhere.

### A newly published version is unavailable

Package managers can delay installing recent releases. For example, Yarn may report that a version
is "quarantined" under its [minimum release
age](https://yarnpkg.com/configuration/yarnrc#npmMinimalAgeGate) policy. Wait until the version
meets your project's policy, then retry the install command.

## Install a GitHub release tarball

The [GitHub release](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.11.0)
offers the same package bytes as npm. This is an alternative to registry installation.

Download both
[`viell-effect-schema-http-0.11.0.tgz`](https://github.com/viell-dev/slop-effect-schema-http/releases/download/0.11.0/viell-effect-schema-http-0.11.0.tgz)
and
[`SHA256SUMS`](https://github.com/viell-dev/slop-effect-schema-http/releases/download/0.11.0/SHA256SUMS)
into one directory. Open a terminal in that directory and compare the downloaded tarball with its
listed checksum.

### PowerShell

```powershell
$archive = "viell-effect-schema-http-0.11.0.tgz"
$entries = @(Get-Content -LiteralPath "./SHA256SUMS" |
    Where-Object { $_.EndsWith("  $archive") })
if ($entries.Count -ne 1) { throw "Expected one checksum entry for $archive" }
$expected = ($entries[0] -split "\s+")[0]
$actual = (Get-FileHash -LiteralPath "./$archive" -Algorithm SHA256).Hash
if ($expected -notmatch "^[0-9a-f]{64}$" -or $actual -ne $expected) {
    throw "Checksum mismatch for $archive"
}
"${archive}: OK"
```

### Linux

```sh
test -f ./viell-effect-schema-http-0.11.0.tgz &&
  sha256sum --check --strict --ignore-missing SHA256SUMS
```

This checks the listed files present in the directory; `--ignore-missing` permits other release
assets to be absent. With just the two downloads above, success prints:

```text
viell-effect-schema-http-0.11.0.tgz: OK
```

Both versions compare the calculated SHA-256 with the release's recorded value. A missing checksum,
missing tarball or mismatch is a failed check. Download the matching pair again before proceeding.

### Install the verified file

After the comparison succeeds, run this from your application directory, adjusting the path if the
downloaded archive is elsewhere:

```sh
npm install ./viell-effect-schema-http-0.11.0.tgz
```

## Compatibility policy

The supported API covers finite-body HTTP contracts, ESM, Node 24 or 26 on Windows/Linux and
Chromium Fetch with Effect 4. [Limits and recovery](./limits.md#compatibility-and-scope) separates
application requirements from tested configurations. Compatible fixes raise the patch number and
breaking changes raise the minor number, so `1.2.3` would be followed by `1.2.4` or `1.3.0`. A
breaking change comes with migration guidance in its release article.

## Which version the documentation describes

The public site describes the newest stable installable release, or the newest candidate before the
first stable release. Navigation shows that version. Documentation on `main` can describe work
awaiting release; it does not automatically replace the public site.

Release articles explain changes that affect applications. The [detailed changelog](./changelog.md)
also records maintenance work. For contribution and release procedures, see [Development and
source](./development.md).
