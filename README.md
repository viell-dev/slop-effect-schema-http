# Effect Schema HTTP

Consumer-owned HTTP contracts composed with Effect. Describe what an external service accepts and
returns, encode application values with Schema, and execute through the `HttpClient` service of
`effect/http`.

Agents write and maintain this project. Its code is not human-reviewed.

## Status and scope

This is an unreleased prototype targeting Effect 4. The package is currently private, its version is
`0.1.0-alpha.1`, and its API can change. There is no supported installation or update channel. The
repository has no license grant yet; publication and licensing must be settled before a release.

The existing modules describe request URLs, headers, query parameters and bodies; select and decode
responses; compose operations with execution policies; and integrate with Effect's HTTP client. They
describe an external service from the consumer's perspective. This project does not generate a
server or replace the HTTP client's transport.

The public entry point exports `Body`, `Interaction`, `Operation`, `Policy`, `Request`, `Response`,
`Transport`, and `UrlEncoding`. Their TypeScript source and doc comments are the current API
reference. [docs/design.md](./docs/design.md) records the design decisions: what the library
promises, and what it leaves to the consumer, to Effect, or to the transport.

Behavior tests cover every module: request encoding, response selection and decoding, retry
policies, timeouts, cancellation, and interactions. Operation and interaction tests run through
Effect's `HttpClient` with an in-memory provider. No test exercises Fetch, browsers, real servers,
or packaged installation. Confirmed defects are tracked as [bug
issues](https://github.com/viell-dev/slop-effect-schema-http/issues?q=is%3Aissue+is%3Aopen+label%3A%22Type%3A+Bug%22).
Their tests pin the current behavior and mark the intended behavior as an expected failure until the
defect is fixed. Tests titled "currently …" record present behavior without promising it, either a
defect's current outcome or behavior whose design is still open, and link their issue.

## Development

Use the Node.js version in `.nvmrc` and pnpm version in `package.json`. With fnm, select Node using
`fnm use` from the checkout. With nvm, use `nvm use` instead. Corepack can run the pinned pnpm
without a global pnpm installation.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm lint
corepack pnpm build
corepack pnpm test
```

The build writes JavaScript and declarations to `dist/`. Generated files and dependencies are
ignored by Git. Run `corepack pnpm format` to format the repository. CI runs the static checks,
linters, build, and tests on Linux with the pinned Node.js version.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the maintenance workflow. Report defects and proposed
changes in the [issue tracker](https://github.com/viell-dev/slop-effect-schema-http/issues), with
synthetic inputs, the commit and tool versions, reproduction commands, and expected and actual
results. Do not include credentials or private service data. For a sensitive security report, use
[GitHub private vulnerability
reporting](https://github.com/viell-dev/slop-effect-schema-http/security/advisories/new).
