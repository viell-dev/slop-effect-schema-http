# Getting started

The [overview](./index.md) describes a read operation. Here, create a user: encode a JSON request
body, accept HTTP 201, and decode the created user. The example runs in memory, so you need no
server, account or credentials.

## Install

For this example, use Node.js 24 and npm. The package is ESM and includes TypeScript declarations.
Effect is a peer dependency, supplied by your application.

Create an empty directory and run:

```sh
npm init -y
npm install viell-effect-schema-http@0.1.0-rc.1 effect@4.1.1
```

In an existing project, use only the install command. No clone or library build is required.
`0.1.0-rc.1` is a published release candidate; use that explicit version while evaluating it.
[Compatibility](./limits.md#compatibility-and-scope) covers other application environments.

## Describe a POST request

Create `quickstart.mts` and copy this code into it. The `.mts` extension makes the file an ES
module. Node 24 can run this example directly, without a separate TypeScript build.

<<< ../examples/quickstart.ts#contract

The input is `{ body: { name: string } }`. `Request.body` encodes the name as JSON and supplies the
content type. The response contract expects HTTP 201 with a numeric `id` and string `name`; the
service assigns the ID.

The request and response schemas are separate. Your application supplies the fields needed to create
a user and receives the fields needed to use the result.

## Supply a client and run it

Append this code to the same file. It supplies an Effect HTTP client that answers with a created
user, without sending network traffic:

<<< ../examples/quickstart.ts#synthetic

`execute` returns an **Effect**, a description of work. `Effect.provideService` supplies its HTTP
client dependency; `Effect.runPromise` runs it and returns the decoded value.

Run the file:

```sh
node quickstart.mts
```

Expected output:

```text
{ id: 42, name: 'Ada' }
```

## Change the response

Add a string field to both the response schema and the synthetic JSON response, then run the example
again. The result includes the new field.

Next, change the synthetic `id` to a string while leaving its schema as `Schema.Number`. The run
fails with `DecodeError`: the response arrived but did not fit your contract. Restore the number to
recover.

Node's direct TypeScript execution strips types without checking them. For application type
checking, enable TypeScript `strict` and an ESM-compatible module setup; keep your normal toolchain.

## Add more actions

Continue with [Describe and execute a request](./usage.md) to add PATCH and DELETE operations, share
their base URL and path, and supply Fetch for your own service. The [module guides](./api.md) then
explain each building block in depth.
