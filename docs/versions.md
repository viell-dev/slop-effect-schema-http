# Versions

## Choose a release

`0.1.0-rc.1` is a release candidate for the first stable `0.1.0`, available from npm and GitHub.
[Getting started](./getting-started.md) installs that explicit version. [What's in
0.1](./release-notes/0.1.md) introduces what the release lets your application do.

The npm `rc` tag selects a candidate. During this first-release bootstrap, `latest` also identifies
`0.1.0-rc.1`; use the explicit version while evaluating the candidate. Stable publication will move
`latest` to `0.1.0`.

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

## Install a GitHub release tarball

The [GitHub release](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.1.0-rc.1)
offers the same package bytes as npm. This is an alternative to registry installation.

Download both
[`viell-effect-schema-http-0.1.0-rc.1.tgz`](https://github.com/viell-dev/slop-effect-schema-http/releases/download/0.1.0-rc.1/viell-effect-schema-http-0.1.0-rc.1.tgz)
and
[`SHA256SUMS`](https://github.com/viell-dev/slop-effect-schema-http/releases/download/0.1.0-rc.1/SHA256SUMS)
into one directory. Open a terminal in that directory and compare the downloaded tarball with its
listed checksum.

### PowerShell

```powershell
$archive = "viell-effect-schema-http-0.1.0-rc.1.tgz"
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
test -f ./viell-effect-schema-http-0.1.0-rc.1.tgz &&
  sha256sum --check --strict --ignore-missing SHA256SUMS
```

This checks the listed files present in the directory; `--ignore-missing` permits other release
assets to be absent. With just the two downloads above, success prints:

```text
viell-effect-schema-http-0.1.0-rc.1.tgz: OK
```

Both versions compare the calculated SHA-256 with the release's recorded value. A missing checksum,
missing tarball or mismatch is a failed check. Download the matching pair again before proceeding.

### Install the verified file

After the comparison succeeds, run this from your application directory, adjusting the path if the
downloaded archive is elsewhere:

```sh
npm install ./viell-effect-schema-http-0.1.0-rc.1.tgz effect@4.1.1
```

## Compatibility policy

The supported API covers finite-body HTTP contracts, ESM, Node 24 on Windows/Linux and Chromium
Fetch with Effect 4. [Limits and recovery](./limits.md#compatibility-and-scope) separates
application requirements from tested configurations. Compatible fixes use `0.1.x`; a breaking public
API change requires `0.2.0` and migration guidance.

## Which version the documentation describes

The public site describes the newest stable installable release, or the newest candidate before the
first stable release. Navigation shows that version. Documentation on `main` can describe work
awaiting release; it does not automatically replace the public site.

Release articles explain changes that affect applications. The [detailed changelog](./changelog.md)
also records maintenance work. For contribution and release procedures, see [Development and
source](./development.md).
