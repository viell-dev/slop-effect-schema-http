# Effect Schema HTTP

Consumer-owned HTTP contracts composed with Effect. Describe what an external service accepts and
returns, encode application values with Schema, and execute through the `HttpClient` service of
`effect/http`.

Agents write and maintain this project. Its code is not human-reviewed.

## Status and scope

This is an unreleased prototype targeting Effect 4. The package is private and its API can change.
There is no supported installation or update channel. The repository has no license grant yet;
publication and licensing must be settled before a release. [Release
preparation](https://github.com/viell-dev/slop-effect-schema-http/issues/2) tracks that work.

The existing modules describe request URLs, headers, query parameters and bodies; select and decode
responses; compose operations with execution policies; and integrate with Effect's HTTP client. They
describe an external service from the consumer's perspective. This project does not generate a
server or replace the HTTP client's transport.

The public entry point exports `Body`, `Interaction`, `Operation`, `Policy`, `Request`, `Response`,
`Transport`, and `UrlEncoding`. Their TypeScript source and doc comments are the current API
reference. [docs/design.md](./docs/design.md) records the design decisions: what the library
promises, and what it leaves to the consumer, to Effect, or to the transport.

See the [verification guide](./CONTRIBUTING.md#behavior-tests) for the module tests, separate
hostile-server suite, and their coverage limits. Confirmed defects remain discoverable in the [open
bug
issues](https://github.com/viell-dev/slop-effect-schema-http/issues?q=is%3Aissue+is%3Aopen+label%3A%22Type%3A+Bug%22).

## Development

Follow [CONTRIBUTING.md](./CONTRIBUTING.md#development-and-verification) for setup, commands, tests,
and pull requests. Report defects and proposed changes in the [issue
tracker](https://github.com/viell-dev/slop-effect-schema-http/issues), with synthetic inputs, the
commit and tool versions, reproduction commands, and expected and actual results. Do not include
credentials or private service data. For a sensitive security report, use [GitHub private
vulnerability
reporting](https://github.com/viell-dev/slop-effect-schema-http/security/advisories/new).
