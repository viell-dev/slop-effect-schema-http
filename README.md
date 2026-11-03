# Effect Schema HTTP

Define what your application sends to an HTTP service and what it expects back. Effect Schema
validates and transforms values, and your Effect HTTP client sends the request. The contract belongs
to your application; the server does not need to use this library or Effect.

## Example

Describe a user lookup and the JSON response your application understands:

```ts
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const api = Request.baseUrl("https://api.example.test");

const getUser = Operation.make(
  Request.get("").pipe(
    api,
    Request.path(Schema.NumberFromString, (id, encode) => `/users/${encode(id)}`),
  ),
  Response.status(
    200,
    Body.jsonSchema(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
);

const program = getUser
  .execute({ path: 42 })
  .pipe(Effect.provide(FetchHttpClient.layer));
// Replace the example endpoint with your service, then: await Effect.runPromise(program).
```

Reuse `api` across requests to share the base URL. The path renderer supplies `/users/42`, which is
joined to that base; it replaces the empty path passed to `Request.get`. The path schema encodes the
number as URL text. The response schema validates the returned JSON. Constructing `program` sends
nothing; evaluating it produces a typed user or an Effect failure. [Getting
started](https://viell-dev.github.io/slop-effect-schema-http/getting-started) supplies a complete
in-memory example you can run without a server or credentials.

## Install

Use Node.js 24 and an ESM project. `0.1.0-rc.1` is available as a [GitHub release
tarball](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.1.0-rc.1), with SHA-256
checksums. It is not yet published to npm. Download and verify the tarball, then install it with
Effect:

```sh
npm install --ignore-scripts ./viell-effect-schema-http-0.1.0-rc.1.tgz effect@4.1.1
```

TypeScript declarations are included. The supported environments are Node 24 on Windows/Linux and
browser Fetch in Chromium. See [compatibility and
limits](https://viell-dev.github.io/slop-effect-schema-http/limits) for tested Effect/compiler
versions and provider boundaries.

## Documentation

- [Getting started](https://viell-dev.github.io/slop-effect-schema-http/getting-started):
  installation, a runnable example and the expected output.
- [Usage](https://viell-dev.github.io/slop-effect-schema-http/usage): compose a contract and connect
  it to your HTTP client.
- [Module guides](https://viell-dev.github.io/slop-effect-schema-http/api): Request, Body, Response,
  Operation, Policy, Interaction, UrlEncoding and Transport, from basic use to advanced behavior.
- [Limits and recovery](https://viell-dev.github.io/slop-effect-schema-http/limits): compatibility,
  failure stages and bug reporting.
- [Versions](https://viell-dev.github.io/slop-effect-schema-http/versions) and [change
  history](https://viell-dev.github.io/slop-effect-schema-http/changelog): updates and compatibility
  policy.

The library provides finite-body codecs, typed contracts, ordered response selection, retry policies
and scoped interaction coordination. It uses the application's HTTP transport and Effect runtime.
Streaming bodies, server generation and a general cache are outside its scope. The [design
contract](https://viell-dev.github.io/slop-effect-schema-http/design) explains the precise
guarantees.

## Project and contribution

Agents write and maintain this project. Its code is not human-reviewed. The source is
[MIT-licensed](./LICENSE). The [release
tracker](https://github.com/viell-dev/slop-effect-schema-http/issues/2) owns remaining
stable-publication prerequisites.

Use [CONTRIBUTING.md](./CONTRIBUTING.md) for checkout setup, verification and pull requests. [Report
a defect](https://github.com/viell-dev/slop-effect-schema-http/issues) with a small synthetic
reproduction and library, Effect and environment versions. Include expected and actual results; keep
credentials and private service data out. For sensitive security reports, use [private vulnerability
reporting](https://github.com/viell-dev/slop-effect-schema-http/security/advisories/new).
