# API modules

This reference describes the unreleased prototype. The public package root exports the eight
namespaces below. Each also has a subpath export, such as `viell-effect-schema-http/Request`. The
linked source and its TypeScript doc comments own the detailed signatures.

| Module                                                                                                       | Purpose                                                                    |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Body](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/http/Body.ts)                      | Finite encoders and decoders; schema validation and transformations.       |
| [Request](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/http/Request.ts)                | Pure request descriptions, fields, schema bindings and native preparation. |
| [Response](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/http/Response.ts)              | Metadata-based decoder selection, tagging and typed decoding failures.     |
| [Operation](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/http/Operation.ts)            | Pair a request and response, then execute a cold Effect.                   |
| [Policy](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/http/Policy.ts)                  | Retry classification, schedule budget, attempt timeout and retry delay.    |
| [Transport](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/http/Transport.ts)            | Header-line interoperability with native HTTP providers.                   |
| [UrlEncoding](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/http/UrlEncoding.ts)        | Replaceable path, query and base-URL rendering policy.                     |
| [Interaction](https://github.com/viell-dev/slop-effect-schema-http/blob/main/src/concurrency/Interaction.ts) | Scoped coordination of one active execution and one retained success.      |

`Request.compile` materializes a request without dispatch. `Operation.make` composes execution with
the application's `HttpClient`; the library supplies no transport or runtime. Error types and
required services remain part of the returned Effect's type. [Design](./design.md) is the contract
behind these functions, and [the runnable example](./usage.md) shows the main workflow.
