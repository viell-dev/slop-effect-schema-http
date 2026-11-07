# Effect Schema HTTP

Define what your application sends to an HTTP service and what it expects back. Effect Schema
validates and transforms values, and your Effect HTTP client sends the request. The contract belongs
to your application; the server does not need to use this library or Effect.

## Example

Describe a user lookup and the JSON response your application understands. The constructor's path
and `Request.path` add together, so the example passes `""` and the template holds the whole path;
`Request.get("/users")` with the same template would ask for `/users/users/42`. A base URL is joined
to a relative path, and an absolute URL in the request bypasses it:

```ts
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const api = Request.baseUrl("https://api.example.test");
const userId = Request.pathValue("userId", Schema.FiniteFromString);

const getUser = Operation.make(
  Request.get("").pipe(api, Request.path`/users/${userId}`),
  Response.status(
    200,
    Body.jsonSchema(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
);

const program = getUser
  .execute({ path: { userId: 42 } })
  .pipe(Effect.provide(FetchHttpClient.layer));
// Replace the example endpoint with your service, then: await Effect.runPromise(program).

// Adjust the definition where it is used. getUser itself does not change.
const inFrench = Request.setHeader("accept-language", "fr");
const getUserInFrench = getUser.pipe(Operation.mapRequest(inFrench));
```

Reuse `api` across requests to share the base URL. The path value's schema turns the number into URL
text, and the library escapes it. The response schema validates the returned JSON. Constructing
`program` sends nothing; evaluating it produces a typed user or an Effect failure.

A definition describes the most common request, not the only one. Write it once, near the
integration, and let each part of your application adjust its request, response or options. [Getting
started](https://viell-dev.github.io/slop-effect-schema-http/getting-started) supplies a complete
in-memory example you can run without a server or credentials.

## Install

In an existing Node.js 24 or 26 ESM project with Effect `^4.0.7`, add the library:

```sh
npm install viell-effect-schema-http
```

`0.3.0` is the current release. The same package is available as a checksummed [GitHub release
tarball](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.3.0). It changes
existing behavior, so read [What's in
0.3](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.3) before you update from
`0.2`.

TypeScript declarations and editor documentation are included. The supported environments are Node
24 or 26 on Windows/Linux and browser Fetch in Chromium. See [compatibility and
limits](https://viell-dev.github.io/slop-effect-schema-http/limits) for tested Effect/compiler
versions and provider boundaries.

## Documentation

- [Getting started](https://viell-dev.github.io/slop-effect-schema-http/getting-started):
  installation, a runnable example and the expected output.
- [Usage](https://viell-dev.github.io/slop-effect-schema-http/usage): add PATCH and DELETE actions,
  share URL descriptions, adjust a definition and connect an operation to your HTTP client.
- [Recipes](https://viell-dev.github.io/slop-effect-schema-http/recipes): everyday tasks that
  combine the modules, such as adjusting a definition for one component.
- [Module guides](https://viell-dev.github.io/slop-effect-schema-http/api): Request, Body, Response,
  Operation, Policy, Interaction, UrlEncoding and Transport, from basic use to advanced behavior.
- [Limits and recovery](https://viell-dev.github.io/slop-effect-schema-http/limits): compatibility,
  where the library's promise stops, failure stages and bug reporting.
- [What's in 0.2](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.2) introduces
  the release and how to update, and [What's in
  0.1](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.1) the one before it;
  [Versions](https://viell-dev.github.io/slop-effect-schema-http/versions) covers updates and
  compatibility policy. [CHANGELOG.md](./CHANGELOG.md) records the detailed history.

The library provides finite-body codecs, typed contracts you can adjust where they are used, ordered
response selection, retry policies and scoped interaction coordination. It uses the application's
HTTP transport and Effect runtime. Streaming bodies, server generation and a general cache are
outside its scope. The [design contract](https://viell-dev.github.io/slop-effect-schema-http/design)
explains the precise guarantees.

## Project and contribution

Agents write and maintain this project. Its code is not human-reviewed. The source is
[MIT-licensed](./LICENSE). The [release
tracker](https://github.com/viell-dev/slop-effect-schema-http/issues/2) records the first stable
release's qualification and publication.

Use [CONTRIBUTING.md](./CONTRIBUTING.md) for checkout setup, verification and pull requests. [Report
a defect](https://github.com/viell-dev/slop-effect-schema-http/issues/new?template=bug_report.yml)
with a small synthetic reproduction and library, Effect and environment versions. Include expected
and actual results; keep credentials and private service data out. For sensitive security reports,
follow the [security policy](./SECURITY.md).
