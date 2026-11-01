# Limits and recovery

## Compatibility and scope

The initial supported scope is ESM with Node.js 24 on Windows/Linux, or browser Fetch in Chromium.
Qualification uses Node 24.21.0 and Effect 4.1.1. Isolated package consumers also check the Effect
4.0.7 peer floor and TypeScript 6.0.3/7.0.2. `package.json` accepts Effect `^4.0.7`; its HTTP
modules are marked unstable upstream and can change across minor versions. The tested versions
establish the current compatibility evidence. Review Effect's release notes and retain a known-good
lockfile when upgrading, including any application-owned client middleware. Report regressions with
the exact dependency version.

The hostile source, Chromium, packed-package and built-app lanes exercise real loopback servers.
Their browser is pinned by Playwright 1.64.1. The release's qualification run records its exact
platforms and browser. Other Node majors, macOS, Firefox, Safari, Deno, Bun and CommonJS are outside
the initial qualification scope. Browser support does not imply support for every bundler or browser
configuration; provider behavior and browser policy still apply.

Bodies are finite. Streaming bodies are deferred. The library does not provide a transport, server
generation, runtime, configuration system, or general cache. `Interaction` retains one success for
one interaction. Read [Design](./design.md) for the precise behavior and delegated policies.

Unmatched responses are drained before `UnexpectedResponse` is returned. A server that never ends
that body can hold the attempt open; set a policy `attemptTimeout` or the caller's whole-operation
timeout when the service cannot guarantee completion.

Browser Fetch hides some cookies, headers and redirect metadata, and CORS can turn an answer into a
transport failure after the server has acted. Native middleware can change URL and header
representations. `Body.text` is lenient UTF-8 through Fetch-backed providers. The relevant
[browser](./design.md#in-a-browser), [URL](./design.md#wire-representations-stay-distinct), and
[body](./design.md#bodies) sections explain the controls and limits.

## Identify the failure stage

| Outcome                       | What to inspect                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Input schema error            | Check the application value against the request schema. Encoding failed before dispatch.                                               |
| `Request.InvalidRequest`      | Check URL rendering, custom encoders, and body/method compatibility.                                                                   |
| `HttpClientError`             | Check the provider, service reachability, and client middleware. A transport error alone does not prove the request was never applied. |
| `Response.UnexpectedResponse` | Add an explicit case for metadata the application needs to handle. The unmatched body has already been drained.                        |
| `Response.DecodeError`        | Inspect the selected contract, metadata and typed cause. Selection does not fall through after a decode failure.                       |
| Timeout                       | Distinguish an attempt timeout from the caller's whole-operation limit; check whether repeating the action is safe.                    |

For unexpected text or encoding failures, read bytes and apply a decoder suited to the service's
format. For a browser-only failure, reproduce under the same origin, credentials and CORS policy; a
Node result cannot establish what the page can observe.

## Report a defect

Use the [issue tracker](https://github.com/viell-dev/slop-effect-schema-http/issues). Include the
library commit, Node/browser and Effect versions, provider and settings, synthetic inputs, expected
and actual results, and a small reproduction. Distinguish the observed response or wire facts from
your interpretation of their cause. Do not post credentials, private URLs or service data.

For sensitive security reports, use [GitHub private vulnerability
reporting](https://github.com/viell-dev/slop-effect-schema-http/security/advisories/new). For
changes to the project, follow the public [contribution
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md).
