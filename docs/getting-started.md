# Getting started

The [overview](./index.md) describes a read operation. Here, create a user: encode a JSON request
body, accept HTTP 201, and decode the created user. The example runs in memory, so you need no
server, account or credentials.

## Install

Add the library to your existing Effect project. It is ESM, includes TypeScript declarations, and
requires Effect `^4.0.7`. Keep your application's compatible Effect dependency.

::: code-group

```sh [npm]
npm install viell-effect-schema-http
```

```sh [pnpm]
pnpm add viell-effect-schema-http
```

```sh [Yarn]
yarn add viell-effect-schema-http
```

:::

[Compatibility](./limits.md#compatibility-and-scope) covers application environments and tested
versions.

## Describe a POST request

Create `quickstart.mts` and copy this code into it. The `.mts` extension makes the file an ES
module. Node 24 and 26 can run this example directly, without a separate TypeScript build.

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

::: code-group

```sh [npm]
node quickstart.mts
```

```sh [pnpm]
pnpm exec node quickstart.mts
```

```sh [Yarn]
yarn node quickstart.mts
```

:::

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

## Run it with a generator

The example above runs an operation with `.pipe`. A **generator** does the same work in steps that
read like ordinary code: inside `Effect.gen`, `yield*` runs an Effect and gives you its result.
Append this code to the same file:

<<< ../examples/quickstart.ts#generator

Run the file again, and it also prints `Welcome, Ada`. Both styles build the same kind of Effect, so
use whichever reads better. Effect's [generator
guide](https://effect.website/docs/v4/getting-started/using-generators) explains them in full.

## Add more actions

Continue with [Describe and execute a request](./usage.md) to add PATCH and DELETE operations, share
their base URL and path, adjust a definition, and supply Fetch for your own service. The [module
guides](./api.md) then explain each building block in depth, and [Recipes](./recipes.md) combine
them for everyday tasks.
