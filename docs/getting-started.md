# Getting started

Install the library, define a typed request and response, and run one operation. This example
answers in memory, so you need no server, account or credentials.

## Install

Use Node.js 24 and npm. The package is named `viell-effect-schema-http`; it is ESM and includes
TypeScript declarations. Effect is a peer dependency, supplied by your application.

`0.1.0-rc.1` is distributed as a GitHub tarball and is not yet on npm. Download the tarball and
`SHA256SUMS` from the [release
page](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.1.0-rc.1). Compare its
SHA-256 with the listed checksum using `Get-FileHash -Algorithm SHA256` in PowerShell or `sha256sum`
on Linux.

For a new example project, create an empty directory, put the downloaded tarball there, and run:

```sh
npm init -y
npm install --ignore-scripts ./viell-effect-schema-http-0.1.0-rc.1.tgz effect@4.1.1
```

In an existing project, use only the install command. This adds the library and Effect to that
project; no clone or library build is required. See
[compatibility](./limits.md#compatibility-and-scope) for supported environments and tested
peer/compiler versions.

## Define the request and response

Create `quickstart.mts` and copy these imports and operation into it. The `.mts` extension makes the
file an ES module. Node 24 can run this example directly, without a separate TypeScript build.

<<< ../examples/quickstart.ts#imports

<<< ../examples/quickstart.ts#contract

The call will take `{ path: 42 }`. The path schema turns the number into text for the URL. A
successful HTTP 200 answer must contain a JSON object with a numeric `id` and string `name`.

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

The release also provides `release-check.mjs`, an executable check of successful decoding, invalid
input and invalid response data. Download it beside the installed package and run
`node release-check.mjs`. It prints the three outcomes and `Candidate check passed`. The [candidate
usability request](https://github.com/viell-dev/slop-effect-schema-http/issues/67) collects feedback
before stable publication.

## Develop from source

For checkout setup, builds and tests, use the [contributor
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#development-and-verification).

## Verify a locally built tarball

The contributor guide also owns [isolated package
verification](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#packed-package-verification).
A locally built package is distinct from the checksummed release download.
