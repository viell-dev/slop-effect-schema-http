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

The library reads Effect's schema structure to keep a field from being lost. Tests hold that reading
to the versions above, and to Effect 4.0.7, the oldest the peer range allows. Nothing checks it at
run time, so on an untested Effect it can fall back to Effect's own reading, where a union takes the
first member that fits and a field can go with no error.

Known limits also remain on the tested versions: conflicting decoded/encoded aliases, defaults
hidden by nonempty group transformations, and false refusals outside bounded stacked-union or
constructor-only opaque-neighbor recovery. The [Request
guide](./modules/request.md#a-schema-states-the-shape-of-its-group) and [tracked schema
gaps](https://github.com/viell-dev/slop-effect-schema-http/issues/143) distinguish the supported
checks from those cases.

An invalid encoded alias is refused in 0.9 when stable plain root data, finite closed schema names,
a successful whole constructor and its strict encoding establish that the encoded field would take a
default. Valid encoded input still decodes and can retain fields held by a separate binding.
Ambiguous decoded/encoded names, open/opaque/class/suspended or iterable group shapes,
inherited/accessor fields and changing input remain outside the additional proof; default
substitution can still occur there
([#170](https://github.com/viell-dev/slop-effect-schema-http/issues/170)). Use decoded names,
directly or through a named input mapping. [What's in 0.9](./release-notes/0.9.md) gives examples
and the migration. The earlier [0.8 helper migration](./release-notes/0.8.md) still applies.

The same proof now refuses an ignored encoded-only name after actual successful final fieldwise
construction, at the root or through winning root union members, following failed whole decoding.
The existing strict writer must succeed and actually write that name. No decoding is replayed or
input rebuilt; existing schema effects can run before refusal. Valid aliases beside mixed common
fields can also refuse. [What's in 0.11](./release-notes/0.11.md) gives complete-side and validated
decoded-mapping alternatives. Later member-constructor choices and unsupported recovery routes
remain outside the additional check.

A union between defaulted filters and a cursor can still refuse complete encoded filter fields
beside a cursor held by a separate binding. This pre-existing selection/coverage limit remains under
[#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6730345959), in
either binding order; the fieldwise refusal does not add general backtracking.

In 0.12, the initial whole-constructor proof also follows declared fields through finite closed,
untransformed direct objects. Stable own-data links must reach the same encoded-only terminal field
actually written by the original strict writer. Invalid `filter: { page_size: "many" }` then fails
instead of sending a finite-number default; valid encoded text and omission retain their meaning in
complete-side cases. A closed union can be the terminal child. Where another value forces a
strict-read failure, valid aliases can newly refuse beside decoded-only common fields, and
shared-type fields can change interpretation when the whole encoded group succeeds; use a complete
side or validated decoded mapping. Whole decoding can repeat checks and services; construction is
not replayed. [What's in 0.12](./release-notes/0.12.md) gives path, JSON and decoded mapping
examples.

In 0.13, finite closed untransformed parent unions can also supply unchanged field paths. Every
member that declares a field must use the same field schema; other closed members may omit it. All
member names remain in stable ancestor evidence. The original whole construction and strict writer
still have to succeed, followed by one coherent caller/output witness and whole-schema validation.
[What's in 0.13](./release-notes/0.13.md) covers the migration, including valid mixed-side refusals
and shared-type interpretation changes. At 0.13, distinct field declarations, arrays,
opaque/suspended/transformed/open parents, changing caller objects and unsupported member/fieldwise
routes remained outside that extension under #170. Supply decoded values or a validated decoded
mapping there.

The same ambiguity guard now excludes conflicting normalized declarations inside direct objects,
including numeric `1` and string `"1"`. This can weaken a 0.12 refusal into a generated default in
0.13, directly or below another unchanged field. Supplied `wire: "many"` can therefore produce
`/limit/25` in the [typed
reproduction](https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6733524389).
This newly exposed kept-or-refused defect remains open under #170. Validate and map to decoded names
before preparation, or supply validated decoded values; default substitution is not an intended
guarantee.

In 0.14, stable dense array and tuple positions can also establish that same constructor-only proof.
Own data indices/length, ordinary or null prototype, static element/rest metadata and an unchanged
original strict-output length keep each position's identity. Frozen and nonenumerable positions are
supported. Whole decoding can change mixed runtime input or shared-text meaning; whole-side static
array input already excludes mixed literals. Construction defaults still do not apply to omitted
fields on an ordinary decoding route. [What's in 0.14](./release-notes/0.14.md) gives checked
path/JSON, prefix/rest/tail, omission and decoded-mapping examples.

An item supplied under both decoded and encoded names can also change which value wins when an
encoded-only sibling establishes whole-array reading. The typed nonliteral input
`[{ limit: 1, page_size: "02" }, { page_size: "25" }]` wrote `1/25` on 0.13 and writes `2/25` on
0.14. Constructor/decoded name preference is not a whole-encoded-reading rule. This remains a
[conflicting-alias
limit](https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6735302019), not
a conflict repair or an input statically excluded in every form. Give one complete side or
validate/map to decoded names.

Sparse/accessor/inherited/subclass/custom-iterator/changing arrays, array-shaped parent union
members, group transforms, opaque/suspended ancestors and unsupported member/fieldwise routes stay
outside the added proof under #170. The distinct normalized-declaration defect above also remains
open; use validated decoded values for affected schemas. No general per-element recovery, alias map
or arbitrary equality rule is introduced.

The 0.15 normalization fixes retain actual array keys/length after an inner rewrite: holes and
readable hidden/inherited cells stay in place, metadata is not appended as a cell, and symbols no
longer cause accidental numeric-conversion TypeErrors (#189/#191). The caller's layout remains
unchanged. Ordinary getter/prototype processing can still occur; the fixes do not expand the
constructor-default proof. Hidden/inherited-position discovery requires a structural array view
without an open or opaque alternative. A union containing Unknown, Any, ObjectKeyword or a
declaration does not establish that its Array alternative reads the value. Those mixed views keep
their prior enumerable-child normalization; this is not a general preservation proof for every
alternative.

Removing those accidental failures can expose existing unsupported #170 defaults. A length-two
sparse array with only position one `{ page_size: "many", stray: "ignored" }` previously refused
after compaction; it can now write `[null,{"page_size":"25"}]`. An own enumerable iterator's invalid
alias can change TypeError to generated `25`, even with the normal Array iterator. These are actual
preservation defects, not intended validation. [What's in 0.15](./release-notes/0.15.md) provides
checked examples and a named validated mapping to decoded values. Use that explicit route for
unsupported profiles; declining their constructor evidence does not guarantee clean refusal.

Whole encoded nested shapes retain their static input type in 0.10. Helpers using `Request.Input`
must handle encoded nested names too, or declare their own decoded input shape; the [0.10
migration](./release-notes/0.10.md) gives a checked example. This changes no runtime route. Inside
opaque values such as `Schema.ReadonlyMap`, the schema's own reading still applies, and accepted
encoded contents do not force whole decoding. A map's constructor can accept a nested renamed object
by losing its alias; supply decoded map contents for a predictable decoded route.

Effect can also refuse some omitted prototype-named fields, including `constructor` and an
encode-only `toString` default. The [dependency
overview](https://github.com/viell-dev/slop-effect-schema-http/issues/41) records the exact schemas,
controls and upstream status. These remain schema failures; the library does not bypass them.

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

### What a client does with a request

The library hands a request to the client and reads what the client gives back, and [its promise
stops there](#paths-and-other-requests-passed-on-as-written). These are things the clients do. This
project's integration tests measured them against servers that fail on purpose, on the [tested
configurations](#tested-configurations), and another client or version can differ.

#### One attempt can reach a server twice

`Policy.none` is one attempt by the library, not one send. When a reused connection ends with no
response, Chromium sends the request again by itself, a POST included, so one attempt can make two
commits. A CORS preflight is enough to leave such a connection open.

The library sees one attempt. If the second sending fails too, that is a transport failure. If it
gets an answer, that is a success, and the earlier commit also exists, with nothing to tell the
caller. Node's clients do not send a request again, so a POST lost on a connection already used
arrives once.

A key the server reads to recognize a repeat, such as an idempotency key, goes out with both
sendings, so the browser's second sending replays and there is one commit. A key written for each
attempt does this too, because the browser repeats the attempt it was given.

#### A body cut off after its headers

The same failure on the wire reaches the library differently, depending on when the client hands a
response over:

| Client                                                                            | What the library receives                          | `Policy.transient` |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------ |
| `fetch`, in Node.js and in Chromium                                               | `Response.DecodeError`, with the response's status | Not retried        |
| A client that reads the whole response first, such as a provider on Node's `http` | A `TransportError`, with no response metadata      | Retried            |

`fetch` hands a response over at its headers, so the body fails later, as a body that does not
decode. It has the same error, reason and status as malformed JSON, so a `while` classifier has
nothing portable to tell them apart by.

So one cut POST can duplicate through one provider and not another. With retries on and no key, a
write the server committed before its answer was cut is repeated through the second kind of client
and not through `fetch`. `Policy.transient` stays as it is, because it matches Effect's
classification. Where a repeat would matter, send a key or keep that write off retries.

#### A compressed body that stops early

A gzip body cut short is a success in Node.js `fetch` and in Chromium, holding the part that
arrived, because neither checks that the stream ended. Chromium also ignores a wrong CRC, which
Node.js `fetch` fails with `Response.DecodeError`. The library receives what the client gives it, so
`Body.text` and `Body.bytes` return the partial body. A format or schema that needs the whole body
refuses what no longer fits it.

#### A redirected response can stay open

After `HttpClient.followRedirects`, an attempt's scope does not release the last hop's response,
because of how Effect ties its abort signal to the first request
([#142](https://github.com/viell-dev/slop-effect-schema-http/issues/142)). A response nobody reads,
such as one a decoder refuses unread or `HttpClient.filterStatusOk` rejects, stays open until
garbage collection. A timeout or an interruption still ends it.

## Identify the failure stage

| Outcome                       | What to inspect                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input schema error            | Check the value against either side of the request schema. Its message describes the decoded side, or names a field no union member can hold with the rest. Nothing was sent.                                                   |
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
