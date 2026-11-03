# Effect Schema HTTP

Define what your application sends to an HTTP service and what it expects back. Effect Schema
validates and transforms the values; your Effect HTTP client sends the request. The contract lives
in your application, so you can describe an external service without controlling its server.

## Make one typed operation

A request, a body codec and a response case form an operation:

<<< ../examples/quickstart.ts#contract

`getUser.execute({ path: 42 })` returns an Effect. Provide an HTTP client and run it to get a
validated `{ id: number, name: string }`. Constructing the operation sends nothing.

[Get started](./getting-started.md) has the imports, installation commands, an in-memory client and
the expected output. [The usage guide](./usage.md) explains the example and connects it to Fetch.

## Choose your next task

| Task                                               | Guide                                   |
| -------------------------------------------------- | --------------------------------------- |
| Add a path, query, headers or request body         | [Request](./modules/request.md)         |
| Read or write JSON, text, bytes or forms           | [Body](./modules/body.md)               |
| Handle success, missing data and other responses   | [Response](./modules/response.md)       |
| Supply a client and handle results or failures     | [Operation](./modules/operation.md)     |
| Set retry and timeout behavior                     | [Policy](./modules/policy.md)           |
| Share, refresh or replace work for one interaction | [Interaction](./modules/interaction.md) |

[All modules](./api.md) also covers custom URL encoding and header-line interoperability. [Limits
and recovery](./limits.md) describes compatibility and failure diagnosis. [Design](./design.md)
records the detailed behavior contract.

## Installation and scope

`0.1.0-rc.1` is a release candidate available from npm and as a checksummed [GitHub
release](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.1.0-rc.1). Follow the
[installation guide](./getting-started.md) to install that explicit version and run a first example.

The library supports finite request and response bodies, typed input and output, ordered response
selection, retries and scoped interaction coordination. Your application supplies its HTTP provider
and runtime. Streaming, server generation and a general cache are outside its scope.

Agents write and maintain the project; its code is not human-reviewed. The source is
[MIT-licensed](https://github.com/viell-dev/slop-effect-schema-http/blob/main/LICENSE).
[Versions](./versions.md) explains compatibility and which release this site describes.
