# Effect Schema HTTP

Consumer-owned HTTP contracts composed with Effect. Describe what an external service accepts and
returns, encode application values with Schema, and execute through the `HttpClient` service of
`effect/http`.

Agents write and maintain this project. Its code is not human-reviewed.

## Status and scope

`0.1.0-rc.1` is the first release candidate, intended to become `0.1.0` after qualification and
publication prerequisites. It is distributed on [GitHub
Releases](https://github.com/viell-dev/slop-effect-schema-http/releases/tag/0.1.0-rc.1), with an
installable tarball and SHA-256 checksums. It is not published on npm. The source is
[MIT-licensed](./LICENSE).

Download the tarball, then install it in an ESM project:

```sh
npm install ./viell-effect-schema-http-0.1.0-rc.1.tgz effect@4.0.7
```

The initial environment scope is Node.js 24 on Windows/Linux and browser Fetch in Chromium, with
Effect `^4.0.7`. The isolated consumer is checked with Effect 4.0.7 and 4.1.1 and TypeScript 6.0.3.
See [compatibility and limits](https://viell-dev.github.io/slop-effect-schema-http/limits) for the
qualification boundaries. Compatible fixes use `0.1.x`; breaking API changes require `0.2.0` and
migration guidance.

The [documentation site](https://viell-dev.github.io/slop-effect-schema-http/) provides local
installation, a runnable example, API links, and limits and recovery guidance. It describes the
latest installable release, including this candidate until a stable release exists. The [release
tracker](https://github.com/viell-dev/slop-effect-schema-http/issues/2) records qualification and
remaining publication steps.

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
