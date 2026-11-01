# Evaluate the prototype

The package has no supported registry installation, update or release channel yet. Use a source
checkout to evaluate the current alpha API. Keep evaluation separate from production service data:
the example below uses synthetic values and makes no network call.

## Set up the checkout

Use the Node.js version in
[.nvmrc](https://github.com/viell-dev/slop-effect-schema-http/blob/main/.nvmrc) and the npm version
declared in
[package.json](https://github.com/viell-dev/slop-effect-schema-http/blob/main/package.json). Select
Node explicitly with `fnm use` on Windows or `nvm use` where nvm is installed.

```sh
git clone https://github.com/viell-dev/slop-effect-schema-http.git
cd slop-effect-schema-http
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

## Evaluate the tarball

```sh
npm run test:package
npm pack
```

The first command installs the built tarball in an isolated temporary consumer, checks declarations
without `skipLibCheck`, imports every export, and executes a synthetic operation. Successful runs
remove the temporary consumer; failures print its retained path. `npm pack` then writes a tarball in
the checkout for your own evaluation. It is an unreleased development artifact.

To try that artifact in a separate project, copy the tarball there and install it with the tested
Effect peer:

```sh
npm install ./viell-effect-schema-http-0.1.0-alpha.1.tgz effect@4.0.7
```

Use the actual filename printed by `npm pack`; metadata in `package.json` owns the version and peer
range. The sample command names the current alpha artifact, not a registry release. The library is
ESM; TypeScript declarations are included.

## Update or remove an evaluation

In the source checkout, inspect local changes, pull the desired current work, then reinstall and
rebuild:

```sh
git pull --rebase
npm ci
npm run build
npm run docs:examples
```

Repack and reinstall the new tarball in any separate consumer. There is no automatic upgrade
channel, and alpha API changes may require edits to that consumer. Remove a tarball installation
with `npm uninstall viell-effect-schema-http`; remove `effect` only if your project no longer uses
it elsewhere. See [limits and recovery](./limits.md) when evaluation fails.
