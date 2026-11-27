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

The release checks run on Node.js 24.22.2 and the newest Node.js 26, with Effect 4.0.7 and 4.1.5 and
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

Schema structure is tested against the configurations above, rather than checked at runtime. The
[Schema-backed input reference](./schema-input.md) owns current constructor/encoded reading and
array behavior, including its [limits](./schema-input.md#active-limits-and-recovery). The [group
reference](./schema-groups.md) covers raw defaults and bounded stacked-union recovery. Those pages
state today's support without assembling it from release history.

Other Node majors, macOS, Firefox, Safari, Deno, Bun and CommonJS are outside the qualification
scope. Browser support does not imply support for every bundler or browser configuration; provider
behavior and browser policy still apply.

The package declares `engines.node` as `>=24`. The open upper range is a compatibility choice, not a
claim that later Node majors are qualified. npm normally treats an incompatible engine range as
advisory, but [`engine-strict`](https://docs.npmjs.com/cli/v11/using-npm/config#engine-strict) can
refuse installation. Other package managers apply their own policies. This page identifies the
qualified environments; the manifest declares the package's accepted range.

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

Before Effect 4.1.3, after `HttpClient.followRedirects`, an attempt's scope does not release the
last hop's response, because of how Effect ties its abort signal to the first request
([#142](https://github.com/viell-dev/slop-effect-schema-http/issues/142)). A response nobody reads,
such as one a decoder refuses unread or `HttpClient.filterStatusOk` rejects, stays open until
garbage collection. A timeout or an interruption still ends it. This was reproduced with 4.1.2;
4.0.7 uses the same scoping code. Effect 4.1.3 fixes this by attaching every request sent during
execution to the scope, including each redirect hop. Upgrade Effect to 4.1.3 or later for that
cleanup guarantee; the library's peer floor remains 4.0.7.

## Identify the failure stage

| Outcome                       | What to inspect                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input schema error            | Check the value against either side of the request schema. Its message describes the decoded side, or names a field the schema cannot keep and, where it can, why. [Read the message](#read-a-refusal-message) for the fix. Nothing was sent. |
| `HttpBody.HttpBodyError`      | A body writer could not represent a value, such as `NaN` under `Body.json` or a number in a form. The message names the writer and the position. Convert the value in the schema, or give a value the writer takes. Nothing was sent.         |
| `Request.InvalidRequest`      | Check URL rendering, custom encoders and `Request.mapBaseUrl` functions, and that declared fields fit the schemas bound to their group. The message names the fields and leaves out their values.                                             |
| A base URL Effect's failure   | The Effect given to `Request.baseUrl` failed, with its own error. Nothing was sent, and a retry policy does not repeat it.                                                                                                                    |
| `HttpClientError`             | Check the provider, service reachability, and client middleware. A client can refuse a request the library passed on, such as `fetch` with a body on GET. A transport error alone does not prove the request was never applied.               |
| `Response.UnexpectedResponse` | Add an explicit case for metadata the application needs to handle. The unmatched body has already been drained.                                                                                                                               |
| `Response.DecodeError`        | Inspect the selected contract, metadata and typed cause. Selection does not fall through after a decode failure.                                                                                                                              |
| Timeout                       | Distinguish an attempt timeout from the caller's whole-operation limit; check whether repeating the action is safe.                                                                                                                           |

For unexpected text or encoding failures, read bytes and apply a decoder suited to the service's
format. For a browser-only failure, reproduce under the same origin, credentials and CORS policy; a
Node result cannot establish what the page can observe.

### Read a refusal message

A request refused before dispatch names where the problem is. Errors from a schema write the path as
`at ["meta"]["at"]`, after the message. Errors from the library's body writers and its field-pair
checks write it as `$["meta"]["at"]`, inside the message, where `$` is the whole body or group. A
query or header writer names its field in quotes, as `The query field "note"`.

Where every way of reading a value would lose a field the caller gave, the request is refused rather
than sent without it, and the message says why where it can. In these examples `limit` is written as
`page_size`:

- **A field given under both its names**, such as `{ limit: 5, page_size: "6" }`, even where the two
  agree:
  `This field is given under both "limit" and "page_size"; give it under one name at ["page_size"]`.
- **A value under its decoded name that the decoded side refuses** gets that side's own error:
  `{ limit: "x" }` reads `Expected number at ["limit"]`.
- **A value under its wire name that the encoded side refuses** keeps the decoded side's message:
  `Missing key` at the decoded name for a required field, as `{ page_size: "many" }` reads
  `Missing key at ["limit"]`, and the generic message below for an optional one. The message is
  taken only from readings with the request's own parse options, and in most schemas only a strict
  read, with other options, reads such a value on its side. Effect gives a read's options to the
  decoders, checks and declarations it runs, which can then fail otherwise, so that read's error is
  not shown. Where the value also holds a key the schema does not state, the request's own reading,
  which strips that key, can report the value: `{ page_size: "many", stray: "1" }` reads
  `Expected a finite number at ["page_size"]`.
- **A wire-named value beside a field that cannot be read either**: where the renamed struct is the
  value itself or a field of a struct, and a field beside the wire-named one, given under its
  decoded name, cannot be read, a required field's `Missing key` gives way to that field's own
  error, from the request's own reading of it. With a string field `term`,
  `{ page_size: "5", term: 1 }` reads `Expected string at ["term"]`, as `{ limit: 5, term: 1 }`
  does. That error describes the field's decoded side, while `page_size` puts the object on its
  encoded side: with `count: FiniteFromString` beside it, `{ page_size: "5", count: "x" }` reads
  `Expected number at ["count"]`, but the fix that sends is the encoded form, `count: "3"`, and
  `count: 3` reads `Missing key at ["limit"]`. Below a wrapper such as `Schema.optional`, `NullOr`,
  a union, a list, a tuple or a record, and where only a field outside the renamed struct is
  invalid, `Missing key` at the decoded name stays.
- **A field beside a Void** that its union member refuses gets the member's own error, such as
  `Expected number at ["extra"]["a"]`. A wire-named field beside it that the reading read under its
  decoded name, such as `filter: { page_size: "05" }`, is not named.
- **The items of a list or a record given on different sides**, such as
  `[{ limit: 5 }, { page_size: "6" }]`:
  `The items of this field's list or record use different sides; give every item on one side at [1]["page_size"]`.
  Every item that cannot be kept is named.
- **A built-in whose content is not in its own fields**, such as a `Map`, a `Set` or a `Date`, given
  where a string-keyed record, `Schema.ObjectKeyword` or a struct would rebuild it from its fields:
  `The schema cannot keep this Map as a record`, or `as an object` for `Schema.ObjectKeyword` and a
  struct. A struct refuses only where it is read on its own; see
  [#330](https://github.com/viell-dev/slop-effect-schema-http/issues/330) for the schemas where a
  built-in is still sent as `{}`.

Every other field the refusal cannot keep is named too, even one that would be kept once another
named value is corrected, because no reading shows that it would be. A reading of the whole value on
one side loses every renamed field given on the other, valid there or not. So with `a` written as
`A` and `b` as `B`, both optional strings, `{ a: 5, b: "x" }` names `["a"]` with `Expected string`
and `["b"]` with the generic message below.

Where nothing more is known, the message is the library's own
`The schema cannot keep this field with the rest of the value`, or, at the top of the value with no
field to name, `The schema cannot keep the content of this value`. Under a union, it names a field
no member can hold with the rest. It also names a field whose object mixes the two sides' names,
such as `{ a: "x", B: "y" }`, and a decoded name below a parent given under its wire name.

A refusal stores no value the caller gave, and the library adds none to its messages, including the
`got …` text Effect can add to its own. A message a schema's author wrote is shown as written, as on
any other schema failure: a check whose message quotes the value it refuses, such as
`` `Rejected ${value}` ``, shows that value.

| Message                                                                             | Cause                                                                                                                                                                                                         | What to change                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `This field is given under both "…" and "…"; give it under one name`                | One field under its decoded name and its wire name                                                                                                                                                            | Give the field under one name                                                                                                            |
| `The items of this field's list or record use different sides; …`                   | Items of one list, tuple or record, some on the decoded side and some on the encoded side                                                                                                                     | Give every item on one side                                                                                                              |
| `The schema cannot keep this Map as a record`, or another kind, or `as an object`   | A built-in whose content is not in its own fields, where a record, `Schema.ObjectKeyword` or a struct rebuilds it                                                                                             | Convert the value to plain data first, or use `Schema.Any` to let the JSON writer refuse or convert it                                   |
| `The schema cannot keep this field with the rest of the value`                      | No union member can hold the field with the rest, the object mixes the two sides' names, another named value puts the whole value on the other side, or the encoded side refuses an optional wire-named value | Choose the union member that states the field, give the whole object on one side, correct the other named value first, or fix that value |
| `Missing key` at a decoded name the caller did not use                              | A required renamed field given under its wire name with a value the encoded side refuses, or beside a decoded value                                                                                           | Fix that value, or give the whole object on one side; elsewhere, the message means a required field was left out                         |
| `Expected exactly one member to match`                                              | Multiple `oneOf` members match, or all enclosing members fail and an inner `oneOf` is ambiguous                                                                                                               | Supply an unambiguous value, or use `anyOf` for first fit. For undefined-valued keys, see [#310][310].                                   |
| `Expected void`                                                                     | A value other than `undefined`, `null`, `{}` or `[]` where only `Schema.Void` can take it                                                                                                                     | Leave the field empty, or add a union member that takes the value                                                                        |
| `Expected JSON value`                                                               | A value under `Schema.Unknown`, or in a string-keyed record of it, that is not already JSON, such as a `Date`                                                                                                 | Convert it first, or use `Schema.Any` to let the JSON writer convert it                                                                  |
| `The query field "…" must encode a scalar value or a list of scalar values`         | A query value that is an object other than a `Date`, a function, a symbol or a nested list                                                                                                                    | Encode the value to text, a number, a boolean or a `Date`, or a flat list of them                                                        |
| `The header field "…" must have a string value`                                     | A header value that is not text or a list of text                                                                                                                                                             | Encode the value to text in the schema                                                                                                   |
| `The query schema must encode a field record or field pairs: …`, or the header form | A query or header schema whose output is neither a record of fields nor a list of name-value pairs                                                                                                            | Make the schema encode to one of those; the rest of the message names what is malformed                                                  |
| `JSON body at $[…] must be a finite number`, or `cannot encode …`                   | A value the JSON writer would drop or replace, passed on by `Body.json` or an open schema such as `Schema.Any`                                                                                                | Use `Schema.Finite` or a schema that converts the value, or leave the value out                                                          |
| `Multipart body at $[…] …`, or `URL-encoded body at $[…] …`                         | A form value the form writer cannot send as an entry, such as a number or `null`                                                                                                                              | Encode the value to text in the schema                                                                                                   |

The [input reference](./schema-input.md#what-will-be-sent) gives the value behind each of these.

[310]: https://github.com/viell-dev/slop-effect-schema-http/issues/310

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
