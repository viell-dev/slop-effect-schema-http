# Modules

The guides below describe the public API of `0.11.0`. Start with the four modules that make one HTTP
operation: `Request` describes what to send, `Body` reads and writes its payload, `Response`
describes the answers, and `Operation` executes them together.

## Build and execute a contract

| Module                              | What you can do                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| [Request](./modules/request.md)     | Set a method and URL, bind path/query/header/body input, and inspect the prepared request |
| [Body](./modules/body.md)           | Read and write JSON, text, bytes and forms; validate and transform with schemas           |
| [Response](./modules/response.md)   | Select by status or headers, tag alternatives, replace or remove cases, and read failures |
| [Operation](./modules/operation.md) | Supply an HTTP client, execute the contract, adjust a definition, and compose results     |

## Control repeated work

| Module                                  | What you can do                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| [Policy](./modules/policy.md)           | Set retries, delays, attempt timeouts, and outcome classification              |
| [Interaction](./modules/interaction.md) | Share equal work, refresh a result, and replace superseded work within a scope |

## Integrate service-specific behavior

These are extension points when ordinary request composition is insufficient:

| Module                                   | What you can do                                                     |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [UrlEncoding](./modules/url-encoding.md) | Change path/query encoding or base-URL joining                      |
| [Transport](./modules/transport.md)      | Preserve individual header lines through a supporting HTTP provider |

## Imports and types

Import namespaces from the package root, or import a module through its subpath:

```ts
import { Request, Response } from "viell-effect-schema-http";
// Alternatively, in a file using only Request:
import * as HttpRequest from "viell-effect-schema-http/Request";
```

The package is ESM and includes TypeScript declarations with public API documentation and examples.
Your editor shows inferred input, result, error and service types. Each module guide starts with an
example, covers ordinary composition, then explains advanced behavior. Links to source signatures
remain at the end for exact overloads and generic types.

Use the [end-to-end guide](./usage.md) to see the pieces together, [Recipes](./recipes.md) for
everyday tasks that combine them, and the [design contract](./design.md) for their precise
guarantees. Effect's [v4 documentation](https://effect.website/docs/v4/getting-started) covers the
underlying Effect, Schema, Layer and Scope APIs.
