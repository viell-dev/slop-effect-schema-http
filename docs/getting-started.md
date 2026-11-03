# Getting started

Install the library, define a typed request and response, and run one operation. This example
answers in memory, so you need no server, account or credentials.

## Install

Use Node.js 24 and npm. The package is named `viell-effect-schema-http`; it is ESM and includes
TypeScript declarations. Effect is a peer dependency, supplied by your application.

`0.1.0-rc.1` is a published release candidate. For a new example project, create an empty directory
and run:

```sh
npm init -y
npm install --ignore-scripts viell-effect-schema-http@0.1.0-rc.1 effect@4.1.1
```

In an existing project, use only the install command. This adds the library and Effect to that
project; no clone or library build is required. See
[compatibility](./limits.md#compatibility-and-scope) for supported environments and tested
peer/compiler versions. Use the explicit candidate version rather than relying on the registry's
default tag before stable publication.

## Define the request and response

Create `quickstart.mts` and copy these imports and operation into it. The `.mts` extension makes the
file an ES module. Node 24 can run this example directly, without a separate TypeScript build.

<<< ../examples/quickstart.ts#imports

<<< ../examples/quickstart.ts#contract

The call will take `{ path: 42 }`. The path schema turns the number into text for the URL. A
successful HTTP 200 answer must contain a JSON object with a numeric `id` and string `name`. Reuse
`api` for other endpoints. The path renderer supplies `/users/42`; the library joins it to that
shared base URL. `Request.get("")` starts empty because the renderer supplies the whole path.

## Supply a client and run it

Append this code to the same file. It supplies an Effect HTTP client that returns a synthetic user:

<<< ../examples/quickstart.ts#synthetic

Run the file from your example directory:

```sh
node quickstart.mts
```

Expected output:

```text
{ id: 42, name: 'Ada' }
```

The operation constructs and decodes an HTTP response through the client you supplied. This client
does not send network traffic. [The usage guide](./usage.md#use-an-http-client-for-your-service)
shows how to supply Fetch for a real service.

## Change the contract

Add a string field to both the `Schema.Struct` response schema and the synthetic JSON response, then
run the example again. The decoded result includes the new field.

Next, make the synthetic `id` a string while leaving its schema as `Schema.Number`. The run fails
with `DecodeError`: a response arrived but did not fit the contract. Restore the number to recover.
Passing a string as the operation's `path` instead fails input encoding before dispatch. A
TypeScript checker also rejects that call; Node's direct TypeScript execution strips types without
checking them.

For application type checking, enable TypeScript `strict` and an ESM-compatible module setup. Keep
your normal build toolchain; the `.mts` shortcut is just for running this example.

## Where to go next

- [Describe and execute a request](./usage.md) explains the pieces and connects them to Fetch.
- [Module guides](./api.md) cover input bindings, body formats, response alternatives, retries and
  interactions, from basic examples to advanced behavior.
- [Limits and recovery](./limits.md) helps distinguish an input, transport or response failure.
- [Versions](./versions.md#update-or-remove-an-installation) covers updates and removal.

## Candidate verification

The [GitHub release](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.1.0-rc.1)
also provides `release-check.mjs`, an executable check of successful decoding, invalid input and
invalid response data. Download it beside the installed package and run `node release-check.mjs`. It
prints the three outcomes and `Candidate check passed`. The [candidate documentation
review](https://github.com/viell-dev/slop-effect-schema-http/issues/67) collects feedback before
stable publication.

### Install the same candidate from a tarball

For a verified download instead of a registry installation, obtain
`viell-effect-schema-http-0.1.0-rc.1.tgz` and `SHA256SUMS` from that release. Compare the tarball's
SHA-256 using `Get-FileHash -Algorithm SHA256` in PowerShell or `sha256sum` on Linux, then install:

```sh
npm install --ignore-scripts ./viell-effect-schema-http-0.1.0-rc.1.tgz effect@4.1.1
```

The GitHub and npm RC tarballs contain the same bytes. Both installations use the same examples.

## Develop from source

For checkout setup, builds and tests, use the [contributor
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#development-and-verification).

## Verify a locally built tarball

The contributor guide also owns [isolated package
verification](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#packed-package-verification).
A locally built package is distinct from the checksummed release download.
