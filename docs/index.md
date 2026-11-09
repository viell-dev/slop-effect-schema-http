# Effect Schema HTTP

Define what your application sends to an HTTP service and what it expects back. Effect Schema
validates and transforms the values; your Effect HTTP client sends the request. The contract lives
in your application, so you can describe an external service without controlling its server.

## Make one typed operation

Describe a GET request and the JSON you expect back:

<<< ../examples/overview.ts#contract

`getUser.execute(undefined)` returns an Effect. This fixed URL needs no input. Provide an HTTP
client and run it to get a validated `{ id: number, name: string }`. Constructing the operation
sends nothing.

## Define once, adjust where it is used

An operation stays a plan until it runs, and a plan can be copied and changed. Write the common
request once, near the integration, and let each part of your application adjust it for its own
case:

<<< ../examples/overview.ts#adjust

A definition describes the most common request, not the only one. A variant can change the request,
the response or the options, and the original stays as it was.

[Get started](./getting-started.md) installs the package and runs a POST operation that creates a
user. [The usage guide](./usage.md) then adds PATCH and DELETE actions with a shared API base and
path, adjusts a definition, and connects an operation to Fetch.

## Choose your next task

| Task                                               | Guide                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| Add a path, query, headers or request body         | [Request](./modules/request.md)                                         |
| Read or write JSON, text, bytes or forms           | [Body](./modules/body.md)                                               |
| Handle success, missing data and other responses   | [Response](./modules/response.md)                                       |
| Supply a client and handle results or failures     | [Operation](./modules/operation.md)                                     |
| Adjust a definition for one use                    | [Operation](./modules/operation.md#define-once-adjust-where-it-is-used) |
| Set retry and timeout behavior                     | [Policy](./modules/policy.md)                                           |
| Share, refresh or replace work for one interaction | [Interaction](./modules/interaction.md)                                 |
| Combine the parts for an everyday task             | [Recipes](./recipes.md)                                                 |

[All modules](./api.md) also covers custom URL encoding and header-line interoperability. [Limits
and recovery](./limits.md) describes compatibility and failure diagnosis. [Design](./design.md)
records the detailed behavior contract.

## Installation and scope

`0.10.0` is the current release, available from npm and as a checksummed [GitHub
release](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.10.0). Follow the
[installation guide](./getting-started.md) to add the library and run a first example.

The library supports finite request and response bodies, typed input and output, definitions you can
adjust where they are used, ordered response selection, retries and scoped interaction coordination.
Your application supplies its HTTP provider and runtime. Streaming, server generation and a general
cache are outside its scope.

Agents write and maintain the project; its code is not human-reviewed. The source is
[MIT-licensed](https://github.com/viell-dev/slop-effect-schema-http/blob/main/LICENSE).
[Versions](./versions.md) explains compatibility and which release this site describes.
