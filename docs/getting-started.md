# Install and try the candidate

`0.1.0-rc.1` is available as a GitHub release candidate, with no npm registry publication. Download
the tarball, `SHA256SUMS`, and `release-check.mjs` from the [release
page](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.1.0-rc.1). Use an empty
directory and Node.js 24. The example uses synthetic values and makes no network call.

```sh
npm init -y
npm install --ignore-scripts ./viell-effect-schema-http-0.1.0-rc.1.tgz effect@4.1.1
node release-check.mjs
```

The example prints `{ id: 42, name: 'Ada' }`, confirms invalid input fails before dispatch, and
confirms a response-schema mismatch produces `DecodeError` after dispatch. Read and adapt the
example alongside [the usage guide](./usage.md). TypeScript declarations are included; the package
and all its subpaths are ESM.

Check the tarball's SHA-256 against `SHA256SUMS` with `Get-FileHash -Algorithm SHA256` in PowerShell
or `sha256sum` on Linux. The [human candidate
check](https://github.com/viell-dev/slop-effect-schema-http/issues/67) gives a short practical
journey and asks for feedback before stable publication.

## Develop from source

Use the Node.js version in
[.nvmrc](https://github.com/viell-dev/slop-effect-schema-http/blob/main/.nvmrc) and the npm version
declared in
[package.json](https://github.com/viell-dev/slop-effect-schema-http/blob/main/package.json). Select
Node explicitly with `fnm use` on Windows or `nvm use` where nvm is installed.

```sh
git clone https://github.com/viell-dev/slop-effect-schema-http.git
cd slop-effect-schema-http
git checkout 0.1.0-rc.1
fnm use
npm ci
npm run build
npm run docs:examples
```

The example prints a user with id `42` and name `Ada`. It imports the built package through its
public entry point, uses a typed path and response schema, and supplies a synthetic `HttpClient`.
[The usage guide](./usage.md) shows the same checked source.

Dependencies' install scripts are disabled by `.npmrc`. The current setup works with that policy; do
not enable lifecycle scripts to work around an unrelated error.

## Verify a locally built tarball

```sh
npm run test:package
npm pack
```

The first command installs the built tarball in an isolated temporary consumer, checks declarations
without `skipLibCheck`, imports every export, and executes synthetic operations. Successful runs
remove the temporary consumer; failures print its retained path. `npm pack` then writes a tarball in
the checkout. A local build is distinct from the checksummed release download.

To try that artifact in a separate project, copy the tarball there and install it with the tested
Effect peer:

```sh
npm install ./viell-effect-schema-http-0.1.0-rc.1.tgz effect@4.1.1
```

Use the actual filename printed by `npm pack`; metadata in `package.json` owns the version and peer
range. The sample command names the candidate artifact, not a registry release. The library is ESM;
TypeScript declarations are included.

## Update or remove an installation

For a release installation, download the chosen newer version's tarball, verify its checksum, read
the [change history](./changelog.md), and install the new file with npm. There is no automatic
registry update channel for this candidate.

For source development, inspect local changes, switch back to your development branch, pull the
desired work, then reinstall and rebuild:

```sh
git pull --rebase
npm ci
npm run build
npm run docs:examples
```

Repack and reinstall the new tarball in any separate consumer. There is no automatic upgrade
channel. A `0.1.x` fix preserves the public API; a breaking change requires `0.2.0` and migration
guidance. Remove a tarball installation with `npm uninstall viell-effect-schema-http`; remove
`effect` only if your project no longer uses it elsewhere. See [limits and recovery](./limits.md)
when evaluation fails.
