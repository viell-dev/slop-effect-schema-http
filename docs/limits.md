# Limits and recovery

## Compatibility and scope

Your application needs the ESM package, a compatible Effect peer and an Effect HTTP client. Choose
the runtime that fits the application:

| Application environment | Supported setup                                               |
| ----------------------- | ------------------------------------------------------------- |
| Node.js application     | Node.js 24 or 26 on Windows or Linux                          |
| Browser application     | Chromium with Fetch, using your application's ESM build setup |
| Effect dependency       | `^4.0.7`, provided by your application                        |

JavaScript consumers need no TypeScript compiler. TypeScript consumers should enable `strict` and
use an ESM-compatible module setup. Browser applications do not need Playwright; it is a tool used
by this project's tests.

### Tested configurations

The release checks run on Node.js 24.22.2 and the newest Node.js 26, with Effect 4.0.7 and 4.1.2 and
strict TypeScript consumers using 6.0.3 and 7.0.2. These are verification results, not additional
packages to install. The [contributor
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#hostile-server-integration-tests)
records the browser test tooling and how the environments are checked.

Effect's HTTP modules are marked unstable upstream and can change across minor versions. Review its
release notes and retain a known-good lockfile when upgrading, including any application-owned
client middleware. Report regressions with the exact dependency version.

Other Node majors, macOS, Firefox, Safari, Deno, Bun and CommonJS are outside the qualification
scope. Browser support does not imply support for every bundler or browser configuration; provider
behavior and browser policy still apply.

The package declares `engines.node` as `>=24`, which is broader than what is tested. It has no upper
limit because one would only print a warning on install; it would not stop an untested version. So
`engines` says what can install, and this page says what is tested.

## Supported behavior

Bodies are finite. Streaming bodies are deferred. The library does not provide a transport, server
generation, runtime, configuration system, or general cache. `Interaction` retains one success for
one interaction. Read [Design](./design.md) for the precise behavior and delegated policies.

### Paths and other requests passed on as written

The library passes the request you declared to the HTTP client you chose, and its promise stops
there. The client may rewrite or refuse it, and a server may read it differently. The library does
not promise that an unusual request works.

This covers paths, constructor query text, header names and declared headers, fragments, methods,
and bodies on GET and HEAD. Wherever these guides say something is "passed to the client as
written", they describe what the library hands over, not what reaches a server.

These are the paths a server received from Effect's Fetch client on Node.js. Chromium gave the same
result for each shape it was tested with:

| Path passed to the client | Path the server received | Tested in Chromium |
| ------------------------- | ------------------------ | ------------------ |
| `/a//b`                   | `/a//b`                  | Yes                |
| `//a`                     | `//a`                    | No                 |
| `/a/`                     | `/a/`                    | Yes                |
| `/a/./b`                  | `/a/b`                   | Yes                |
| `/a/../b`                 | `/b`                     | Yes                |
| `/a/%2e%2e/b`             | `/b`                     | Yes                |
| `/a/b/..`                 | `/a/`                    | No                 |

So Fetch keeps repeated and trailing slashes, and resolves dot segments, including encoded ones. A
server may then merge `//`, and another client can differ.

Fetch makes other choices of its own. It sends lowercase header names, does not send a fragment,
refuses a body on GET or HEAD, and refuses a method such as `TRACE`. Effect's Fetch client takes a
non-empty declared `Content-Length` off, so `fetch` sends the body's real length, and on Node.js an
empty one fails as a transport failure. A service that needs one of those needs a provider that can
send it.

A relative URL with no base depends on the platform. Node refuses it as an invalid URL, and a
browser resolves it against the page, so the request goes to the page's own server, with no error.

The library joins path text exactly, so a slash at a boundary is yours to get right. The Request
guide [recommends a convention](./modules/request.md#add-to-a-path): start each piece with `/`, do
not end one with `/`, and leave both off a base URL. A trailing slash is part of the address, so put
one a server wants on the last piece.

Encoding a path value does not make it safe, so [constrain a value from a
user](./modules/request.md#encoding-does-not-make-a-value-safe) in its schema.

### Slow or unusual responses

Unmatched responses are drained before `UnexpectedResponse` is returned. A server that never ends
that body can hold the attempt open; set a policy `attemptTimeout` or the caller's whole-operation
timeout when the service cannot guarantee completion.

Browser Fetch hides some cookies, headers and redirect metadata, and CORS can turn an answer into a
transport failure after the server has acted. Effect's default trace headers force a CORS preflight
on a cross-origin request, so a working server that does not allow them looks down; [turn them
off](./recipes.md#browser-requests-to-another-origin) or allow them on the server. Native middleware
can change URL and header representations. `Body.text` is lenient UTF-8 through Fetch-backed
providers. The relevant [browser](./design.md#in-a-browser),
[URL](./design.md#wire-representations-stay-distinct), and [body](./design.md#bodies) sections
explain the controls and limits.

## Identify the failure stage

| Outcome                       | What to inspect                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input schema error            | Check the value against either side of the request schema. Its message describes the decoded side. Nothing was sent.                                                                                                            |
| `Request.InvalidRequest`      | Check URL rendering, custom encoders and `Request.mapBaseUrl` functions, and that declared fields fit the schemas bound to their group. The message names the fields and leaves out their values.                               |
| A base URL Effect's failure   | The Effect given to `Request.baseUrl` failed, with its own error. Nothing was sent, and a retry policy does not repeat it.                                                                                                      |
| `HttpClientError`             | Check the provider, service reachability, and client middleware. A client can refuse a request the library passed on, such as `fetch` with a body on GET. A transport error alone does not prove the request was never applied. |
| `Response.UnexpectedResponse` | Add an explicit case for metadata the application needs to handle. The unmatched body has already been drained.                                                                                                                 |
| `Response.DecodeError`        | Inspect the selected contract, metadata and typed cause. Selection does not fall through after a decode failure.                                                                                                                |
| Timeout                       | Distinguish an attempt timeout from the caller's whole-operation limit; check whether repeating the action is safe.                                                                                                             |

For unexpected text or encoding failures, read bytes and apply a decoder suited to the service's
format. For a browser-only failure, reproduce under the same origin, credentials and CORS policy; a
Node result cannot establish what the page can observe.

## Report a defect

Use the [bug report
form](https://github.com/viell-dev/slop-effect-schema-http/issues/new?template=bug_report.yml).
Include the library version or commit, Node/browser and Effect versions, provider and settings,
synthetic inputs, expected and actual results, and a small reproduction. Distinguish the observed
response or wire facts from your interpretation of their cause. Do not post credentials, private
URLs or service data.

For sensitive security reports, follow the [security
policy](https://github.com/viell-dev/slop-effect-schema-http/blob/main/SECURITY.md), which uses
[GitHub private vulnerability
reporting](https://github.com/viell-dev/slop-effect-schema-http/security/advisories/new). For
changes to the project, follow the public [contribution
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md).

For confusing documentation, [open a documentation
issue](https://github.com/viell-dev/slop-effect-schema-http/issues/new?labels=Type%3A%20Documentation).
Link the page and section, say what you were trying to do, and describe what you expected to learn.
