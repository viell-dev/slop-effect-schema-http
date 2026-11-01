# Limits and recovery

## Compatibility and scope

This prototype targets Effect 4. `package.json` owns the accepted peer range; development and the
isolated consumer currently verify Effect 4.0.7 with the pinned Node.js toolchain. The hostile suite
also exercises Chromium at its selected library commit. These observations do not establish a
supported browser, provider or version matrix for a release.

Bodies are finite. Streaming bodies are deferred. The library does not provide a transport, server
generation, runtime, configuration system, or general cache. `Interaction` retains one success for
one interaction. Read [Design](./design.md) for the precise behavior and delegated policies.

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
