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
`Transport`, and `UrlEncoding`. Their TypeScript source is the current API reference. There are no
automated behavior tests yet, so successful static checks and builds do not establish runtime
correctness.

## Development

Use the Node.js version in `.nvmrc` and pnpm version in `package.json`. With fnm, select Node using
`fnm use` from the checkout. With nvm, use `nvm use` instead. Corepack can run the pinned pnpm
without a global pnpm installation.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm lint
corepack pnpm build
```

The build writes JavaScript and declarations to `dist/`. Generated files and dependencies are
ignored by Git. Run `corepack pnpm format` to format the repository. `corepack pnpm test` currently
fails with "No test files found"; add meaningful tests before relying on the library's behavior. CI
runs the static checks, linters, and build on Linux with the pinned Node.js version.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the maintenance workflow. Report defects and proposed
changes in the [issue tracker](https://github.com/viell-dev/slop-effect-schema-http/issues), with
synthetic inputs, the commit and tool versions, reproduction commands, and expected and actual
results. Do not include credentials or private service data. For a sensitive security report, use
[GitHub private vulnerability
reporting](https://github.com/viell-dev/slop-effect-schema-http/security/advisories/new).
