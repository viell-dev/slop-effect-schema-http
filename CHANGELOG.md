# Change history

## 0.5.0 — 2026-11-08

Read [What's in 0.5](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.5) for the
consumer introduction and migration from raw edits to invocation input or `Request.mapInput`.

- **Breaking:** refuse later raw query/header edits when successful direct-struct preparation writes
  a field the caller stably omitted. This extends the constructor-default check to handwritten
  decoding defaults, successful fieldwise fallback and encoder-generated fields, without evaluating
  any callback again. The proof uses actual ordinary-record output and per-binding edit provenance;
  group transformations, classes, unions and accessor/inherited input remain outside it
  ([#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143)).
- Keep iterable output on its entry-based path. An own generated field beside a generator does not
  prove that the field is sent, so it no longer triggers this particular false refusal.
- Remove constructor-route and decoded-snapshot plumbing made unnecessary by the output proof.
  Error/service types, fallback order and existing schema validation remain unchanged.

## 0.4.0 — 2026-11-08

Read [What's in 0.4](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.4) for the
consumer introduction and migration checks for constructor defaults and transformed union tags.

- Add executable recipes for definition-owned values and defaults, and for effectful credentials in
  client middleware. These use the existing API rather than introducing separate base fields or
  tracking raw setter names in the input type
  ([#111](https://github.com/viell-dev/slop-effect-schema-http/issues/111),
  [#112](https://github.com/viell-dev/slop-effect-schema-http/issues/112)).
- **Breaking for low-level extensions:** `Request.Draft` adds `editedFields`. Preserve it when
  deriving a draft, or initialize it with `new Map()` when constructing one from scratch.

- Fix a false refusal when a union's tag is given by its encoded name. Required literal tags can
  rule a member out on either side, including through a whole-object transformation, so a field only
  an excluded member states is stripped as it is for a decoded tag. Both views must rule a member
  out, and a constructor default is not evaluated to guess a tag
  ([#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143)).

- **Breaking:** keep a field beside a tag whose union contains a transformed literal. The old tag
  check could mistake the literal's encoded value for a contradiction, discard the member that held
  the field, and silently send a narrower value. Such a tag now leaves member selection to the
  schema instead of guessing through that inner transformation
  ([#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143)).

- **Breaking:** refuse a raw query/header edit after a direct struct binding when this preparation
  actually constructs and encodes a constructor default for the optional field the caller omitted.
  The check uses the successful preparation without running defaults again. Group transformations,
  classes, unions, decoder fallback and accessor/inherited input fields remain outside its proof
  ([#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143)).

- **Breaking for generic input helpers:** allow a query or header group to be omitted when its
  schema input accepts `{}`, including all-optional structs. An absent or `undefined` group is
  validated as `{}`, so constructor defaults and refinements still apply. Stacked schemas keep a
  group required when any binding requires it; path and body inputs stay as before
  ([#135](https://github.com/viell-dev/slop-effect-schema-http/issues/135)). Ordinary calls remain
  compatible, but a helper constrained to a required group can need an optional-group constraint, as
  the hostile suite's Digest helper demonstrated.

## 0.3.0 — 2026-11-07

Read [What's in 0.3](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.3) for the
consumer introduction and migration steps. Start with its section on unions, because a call that
compiles can now fail at run time for some values.

- Test the library's reading of Effect's schema structure, which keeps a field from being lost, in
  CI and on each dependency update. Release qualification also runs the behavior tests on Effect
  4.0.7, the oldest version the peer range allows, and not only the consumer fixture. Nothing checks
  that reading at run time, so on an untested Effect the library can fall back to Effect's own
  reading.

- State what clients do with a request, as the hostile suite measured it, in Limits and recovery and
  on the design page: `Policy.none` is one attempt by the library and not one send, because Chromium
  can send a POST again by itself; a body cut off after its headers has different verdicts by
  provider; truncated gzip can be a partial body and a success; and a redirected response can stay
  open until garbage collection
  ([#142](https://github.com/viell-dev/slop-effect-schema-http/issues/142)).
- Add `Policy.timeout(duration)`, one attempt with a timeout and no retries, for what used to be
  spelled `Policy.make(Schedule.recurs(0), { attemptTimeout })`. It excludes preparation and result
  mapping, as any attempt timeout does
  ([#136](https://github.com/viell-dev/slop-effect-schema-http/issues/136)).
- Correct what the guides say about a declared `Content-Length`. Effect's Fetch client takes a
  non-empty one off before `fetch` sees it, so `fetch` sends the body's real length, and it neither
  fails nor stalls there. On Node.js an empty one is a transport failure.
- **Breaking:** keep a caller's field under a union. A request can now carry a field this code never
  sent before. Effect takes the first member that fits and strips what it does not state, so
  `{ a, b }` under a union of `{ a }` and `{ a, b }` lost `b` with no error, and a raw `?b=1` then
  took the caller's place. A schema with a choice between objects is now read strictly first, on the
  decoded side and again when it encodes, so a member that keeps every field wins, in headers,
  query, path and bodies, at any depth. The order of the members no longer costs a field, and a
  wider member need not go first. A key set to `undefined` is no field under such a schema, so
  `{ a, b: undefined, c }` under a union of `{ a, b? }` and `{ a, c }` now sends `c`, where it used
  to lose it. A key no member states is still stripped, as a struct strips it, and a schema with no
  such choice reads as before. An empty union now fails as a `SchemaError`, where it used to die
  with a defect ([#134](https://github.com/viell-dev/slop-effect-schema-http/issues/134)).
- **Breaking:** keep a field a strict read could not see, so a request can carry a field it lost
  before. Where a schema's two sides state different names, a value on the encoded side could fit
  the decoded side by losing them, with no union involved: `{ A: "x" }` under a struct that renames
  an optional `a` to `A` sent nothing, a constructor default went out in the caller's place, and so
  did a raw value under `A`. Such a schema is now read strictly too, at any depth the library can
  see, so the value goes through the decoder and keeps its field. The same goes for a transformation
  between objects. A struct reads a stated name however a value holds it, so an accessor on a class,
  an inherited field and one that is not enumerable are now fields under such a schema, and a value
  read field by field keeps them on a plain struct too. An ordinary class instance that only a
  struct can read reads as a plain object there, so a key nothing states is stripped. Every renamed
  struct now takes the strict pass, which measured about 14 to 34 µs per request on one Windows
  machine with Node.js 24, as [#145](https://github.com/viell-dev/slop-effect-schema-http/pull/145)
  records.
- **Breaking:** refuse a value that mixes the names of two renamed fields. `{ a, B }` used to lose
  `B`, and it is now a `SchemaError` that names it.
- **Breaking:** refuse a field no union member can keep. `{ a, b }` under a union of `{ a }` and
  `{ b }` used to send `a` and drop `b`, and a value a wider member refused was dropped the same
  way. It is now a `SchemaError` before anything is sent, which names the field and never its value.
  This call compiled and ran, and it now fails at run time, for the values that reach it. Add a
  member that holds both fields, or send one of them. The library cannot see inside text given as
  text, a `Schema.Map`, a `Schema.Option` or a declaration with no struct behind it, so nothing is
  refused for what happens there, and the schema's own reading applies. An object given to a field
  that holds JSON and the value in `Schema.OptionFromNullOr` can be seen, so a union there is
  refused like any other. A field a schema stacked with the union takes is not lost, in headers and
  query, so that call goes on working. `Draft` requires new `takenQuery` and `takenHeaders` members,
  of a new `Request.Taken` type, and `Request.Shape` a new `chooses` member
  ([#134](https://github.com/viell-dev/slop-effect-schema-http/issues/134)).
- Leave a field with the schema that took it. A union stacked after a schema that holds one of its
  fields used to take that value for a default it could not hold, and a raw value under that name
  did the same in either order, so `Request.InvalidRequest` refused a group that lost nothing. Such
  a group now goes out whole, and a raw value the caller leaves out stays with a schema that has no
  union and allows its name
  ([#134](https://github.com/viell-dev/slop-effect-schema-http/issues/134)).
- **Breaking:** refuse a raw edit, after the schema, of a field with a decoding default. A field
  with `Schema.withDecodingDefaultKey` or one of its relatives is optional on the encoded side, so
  `Request.setQuery` and the other raw edits got past the check, although the schema always writes
  that name and the edit never reached the client. It is now `Request.InvalidRequest` on every run,
  as for any field the schema always writes. Remove the edit, make the field optional so the raw
  value is a default, or supply the value with `Request.mapInput`. Moving the edit before the schema
  does not send it. A raw value under a default with the `omit` encoding strategy is still refused,
  as a field that would be lost, and a field a struct renames with `Schema.encodeKeys` is still not
  refused ([#120](https://github.com/viell-dev/slop-effect-schema-http/issues/120)).
- State that a success `retain` rejects drops an earlier retained success for equal input, and what
  a `Request.mapEffect` finds after `Request.unbind` removes the input it reads.
- Show editor help on the members of public types, such as `execute`, `decoder` and `headerLines`.
- State in the compatibility guide why `engines.node` has no upper limit.
- Check more published facts in the ordinary documentation commands: the rendered `library-version`,
  the release status paragraphs, every install command, navigation completeness, the commands and
  workflows the guides name, skipped Markdown fences, docblocks on public interface members and
  `{@link}` targets. Release preparation also compares the tested versions the guides state with the
  files that set them.
- Add `npm run check-live`, a read-only comparison of the published surfaces, as the last step of a
  release.
- Deploy the documentation by itself after a verified stable npm publication, instead of by a
  separate dispatch that could be forgotten. A dry run, a failed run and a prerelease leave the site
  as it is, and manual dispatch stays for corrections and recovery.

## 0.2.0 — 2026-11-07

Read [What's in 0.2](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.2) for the
consumer introduction and migration steps. Start with its section on paths, because one change
compiles and still changes your URLs.

- Wait for npm version/attestation visibility after publication and provide a read-only recovery
  workflow that verifies the original qualification artifact without another upload
  ([#78](https://github.com/viell-dev/slop-effect-schema-http/issues/78)).
- Record the owner's decision that substantial API changes after `0.1.0` get an agent usability
  review instead of a human use pass
  ([#92](https://github.com/viell-dev/slop-effect-schema-http/issues/92)).
- Move to Effect 4.1.2 and Node.js 24.22.2, a Node.js security release, and refresh the development
  tools. Support Node.js 26, test it in CI and release qualification, and add monthly grouped
  dependency updates ([#106](https://github.com/viell-dev/slop-effect-schema-http/issues/106)).
- **Breaking:** let any method carry a body. `Request.compile` no longer refuses a body on GET or
  HEAD, so `fetch` users get a transport failure from the client where they used to get
  `Request.InvalidRequest` ([#96](https://github.com/viell-dev/slop-effect-schema-http/issues/96)).
- Put a query before a fragment. A `#` in a base URL or in `Request.path` output used to take the
  query into the fragment, where it never arrived as a query. The compiled request now keeps the
  fragment in its `hash` field rather than its URL text, and a custom `UrlEncoding.join` receives
  the base and path without fragments. **Breaking for providers:** one built with
  `HttpClient.makeWith` has to read `request.hash`
  ([#83](https://github.com/viell-dev/slop-effect-schema-http/issues/83)).
- Keep a fragment written in the constructor. `Request.make` and its shortcuts used to discard it.
  It now reaches the client in the `hash` field, exactly as written, and wins over a fragment in
  path output or a base URL. `fetch` still does not send a fragment. **Breaking for extensions:**
  `Request.Declaration` requires a new `hash` member
  ([#93](https://github.com/viell-dev/slop-effect-schema-http/issues/93)).
- Keep the spelling of header names. `Request.setHeader` and `Request.appendHeader` used to
  lowercase a name, so a provider that sends header lines could not deliver `X-API-Key`. Lines now
  keep the spelling they were written with, and comparing names still folds case, so `setHeader`
  replaces a line spelled differently and takes the new spelling. Client middleware still sees
  lowercase `Headers`, and `fetch` still sends lowercase names
  ([#101](https://github.com/viell-dev/slop-effect-schema-http/issues/101)).
- **Breaking:** let a request's own headers win over automatic ones. A declared `Content-Type` or
  `Content-Length` now takes effect, as a declared `Accept` already did, from a raw setter or a
  header schema, before or after the body, including on multipart and empty bodies. A declaration
  that used to be ignored now goes out. `Request.removeHeader(name)` now stops the automatic value,
  including `Accept`, and `Request.Compiled`, `Draft` and `Declaration` require a new
  `removedHeaders` member ([#100](https://github.com/viell-dev/slop-effect-schema-http/issues/100)).
- **Breaking:** pass a constructor query to the client as written until something edits that entry.
  The library used to decode it and render it again, so `?a=1;b=2` became `?a=1%3Bb%3D2`, `?q=a+b`
  became `?q=a%20b`, `?a=1&&b=2` lost a segment and a lone `?` disappeared. Each entry keeps its
  text, stays editable by its decoded name, and goes through `UrlEncoding.query` once edited. A
  custom `UrlEncoding.query` no longer receives entries kept as written, and text the library used
  to escape, such as a space, is no longer escaped. `Request.Declaration` requires a new
  `emptyQuery` member and `Draft` a new `queryText` member
  ([#102](https://github.com/viell-dev/slop-effect-schema-http/issues/102)).
- **Breaking:** let a schema state the shape of its group, instead of owning it. A header or query
  schema used to replace every raw value silently and take raw setters out of the request's type. A
  raw value under a name a schema allows is now a default: what the schema writes replaces it, an
  omitted optional field leaves it in place, and it goes through the schema in both directions, so
  the request carries what the schema writes. A raw value under a name no schema allows, including
  one written in the constructor, is `Request.InvalidRequest` before anything is sent, in either
  order, so `Request.get("/x?a=1").pipe(Request.query(schema))` now fails unless the schema allows
  `a`. A raw edit of a required field after the schema is `InvalidRequest` too. These checks run
  when the request is prepared, so a raw setter after a schema now compiles and can fail at run
  time. Schemas now stack, and `Request.unbind` removes a group's bindings, their input and the
  shape. Header and query schemas add `InvalidRequest` to the error type and their decoding services
  to the requirements. `Request<I, E, R, H, Q>` becomes `Request<I, E, R>`, so a five-parameter
  annotation stops compiling, and `Request.Declaration` and `Draft` replace their `headersBound` and
  `queryBound` members with `headerShapes`, `queryShapes`, `conflicts`, `declaredQuery` and
  `unbound` ([#87](https://github.com/viell-dev/slop-effect-schema-http/issues/87)).
- Refuse a group that would lose a field under a union. Effect strips what a union member does not
  state, so a raw default in one member and a caller's field in another lost one of them with no
  error: `?page=1` under `{ page } | { cursor }` sent `page` and dropped the caller's `cursor`. The
  whole group is now matched first, so a later member that holds all of it is used, and otherwise
  the request fails with `Request.InvalidRequest`, naming the field that would be lost and never its
  value.
- Build a schema's value before encoding it, so a plain object works for a `Schema.Class`, including
  a nested one, in `Request.path`, `Request.query`, `Request.headers`, `Body.encodeSchema` and
  `Body.jsonSchema`, and a field with a constructor default can be left out. Such a call used to
  compile and then fail with `Expected User`. **Breaking for generic helpers:** these functions need
  `Schema.Top` rather than `Schema.Constraint`, so a helper written as
  `<S extends Schema.Constraint>(schema: S) => Body.jsonSchema(schema)` stops compiling.
  `Body.Codec` and `Body.make` gain a trailing `In` parameter that defaults to `A`, so existing
  annotations stay valid ([#91](https://github.com/viell-dev/slop-effect-schema-http/issues/91)).
- Take either side of a schema as input. Headers, query, path and bodies accept a schema's decoded
  side, its encoded side, or a mix by field, and the request carries what the schema writes.
  Preparation tries the decoded side, then the decoder as a whole, then field by field, and reports
  the decoded side's error if all fail. A value that fits the decoded side is read as decoded, so
  under a schema whose two sides share a type an already encoded value is encoded again, with no
  error. A string where a number was expected now compiles, and a plain value in a branded field now
  compiles as the encoded side. **Breaking for schemas with services:** a request now needs its
  schema's decoding services as well as its encoding services, so a schema-backed body's
  `EncodeServices` include both. `Request.Input` names the input type
  ([#113](https://github.com/viell-dev/slop-effect-schema-http/issues/113)).
- Add `Request.InputOf` and `Operation.InputOf`, which name the whole input of a request or an
  operation. `Request.mapInput` returns that input, so hiding a field no longer needs
  `Parameters<typeof request.prepare>[0]`. `Request.Input` still names what one schema takes.
- Show a schema-backed input as one object in an editor. A hover used to list the decoded side, the
  encoded side and the mix by field, as
  `{ limit?: number } | { limit?: string } | { limit?: string | number }`, where the last takes
  everything the others do. It now shows only that member. The sides stay where they are needed, for
  a renamed field or a field one side leaves out. What an input accepts and rejects does not change.
- Let `Request.setQuery` and `Request.setHeader` take a plain object, so several fixed fields no
  longer need a call each. Each key replaces its name, in key order. `setQuery` takes what a query
  schema may encode to, so `page: 2` writes `page=2`, `null` is a bare key and an array repeats the
  name, as well as a function that returns one such value, written the same way. `setHeader` takes
  text or a function. `undefined` removes a name's earlier declarations in both
  ([#85](https://github.com/viell-dev/slop-effect-schema-http/issues/85)).
- **Breaking, and silent:** join the constructor's path and `Request.path` exactly. The path is now
  the constructor's path followed by what each `Request.path` adds, in order, with no `/` added or
  removed. `Request.path` used to replace whatever came before it. **Code that relied on that still
  compiles and now asks for a different URL.** `Request.get("/users")` with a renderer returning
  `/users/1` now asks for `/users/users/1`, and a second `Request.path` adds to the first instead of
  replacing it. Find these by reading: check every `Request.path` whose constructor has path text,
  even a placeholder or text that only carries a query or fragment, and every stacked call. A
  `Request.path` after `Request.get("")` is unchanged, and a constructor's query and fragment still
  survive ([#82](https://github.com/viell-dev/slop-effect-schema-http/issues/82)).
- Write a path as a template. `Request.path` also works as a tagged template, with values declared
  by `Request.pathValue(name, schema?)`, so a child endpoint adds to its parent with no schema
  spread or hand-written renderer, and the input is inferred. Each value goes through its own
  schema, always through the active `UrlEncoding` path encoder, and a plain string in a template is
  a compile error. The text is used as written, and a template with no values adds fixed text. The
  renderer form stays for a path whose shape depends on its value. `Request.setPath` replaces the
  constructor's path, and `Request.unbind("path")` also removes a template's text
  ([#80](https://github.com/viell-dev/slop-effect-schema-http/issues/80)).
- Keep response cases as a keyed list, and add `Response.replace` and `Response.remove`. A status
  case is keyed by its status, and a `Response.when` case by a new `key` option. A replaced case
  keeps its position and match rule, and a replaced or removed case leaves the contract's type. A
  key that is absent, not a literal or a union is a compile error, and one that gets past the types
  throws when the contract is built. **Breaking for types:** `Response.Response` gains a fourth
  parameter that records each case, with a default, so `Response.Response<A, E, R>` annotations stay
  valid. A contract's type now names its cases, so a `let` holding `Response.status(200, body)`
  cannot be assigned `Response.status(201, body)`, and `Operation.make` refuses a conditional
  between them. Write `Response.status(legacy ? 200 : 201, body)` instead, or annotate both as
  `Response.Response<A, E, R>`. **Breaking for extensions:** `Response.Response` requires a new
  `cases` member ([#88](https://github.com/viell-dev/slop-effect-schema-http/issues/88)).
- Let a definition be adjusted where it is used. `Operation.make` now keeps its parts in `parts`,
  and `Operation.mapRequest`, `Operation.mapResponse` and `Operation.mapOptions` derive a variant,
  leaving the original unchanged. `Operation.fromEffect(operation.execute)` seals a definition.
  `Operation` gains an optional fifth type parameter for the parts, so existing four-parameter
  annotations stay valid and hide the parts from these functions. An editor hover on such an
  annotation shows a trailing `unknown`
  ([#86](https://github.com/viell-dev/slop-effect-schema-http/issues/86)).
- Keep a mapped operation adjustable. `Operation.map` and `Operation.mapEffect` used to return a
  value with nothing to adjust. They now keep the parts and record a step, which runs as before:
  once, after the retries, outside the attempt's scope and timeout. `Operation.mapRequest` and
  `Operation.mapOptions` always work on a mapped operation, and `Operation.mapResponse` works when
  the new result still fits. Anything else is a compile error that names `Operation.unmap`, which
  removes every step. The inner functions of `Operation.map` and `Operation.mapEffect` gain a type
  parameter for the parts. It has a default, so it only matters to explicit type arguments, which
  give a plain operation ([#105](https://github.com/viell-dev/slop-effect-schema-http/issues/105)).
- State the rules a reader meets first where they meet them: the README and Getting Started now say
  that the constructor's path and `Request.path` add together and that an absolute request URL
  bypasses a base URL, and each introduction of a schema's shape gives its plain reading.
- Report a key the contract lacks as one error on a mapped operation.
  `Operation.mapResponse(Response.replace(500, body))` with no 500 case also said that the response
  no longer fits, and said it first. A real `unknown` or `any` result is still refused.
- Let `Request.baseUrl` also take an `Effect`, so a service or a `Config` value can supply a
  location that is not known when a request is defined. Its failures and services join the request's
  type, so leaving out a service is a compile error. It runs once per evaluation, after the input is
  encoded and before the first attempt, so every retry uses the same base, and what it supplies goes
  through `UrlEncoding.join` like any base. A location that must change between attempts stays with
  `transformClient`. **Breaking for extensions:** `Request.Declaration`'s `baseUrl` is text or an
  `Effect` ([#89](https://github.com/viell-dev/slop-effect-schema-http/issues/89)).
- Add `Request.mapBaseUrl`, which changes a base that is text or an `Effect`, so a variant can
  extend a prefix it cannot read or one that is not known yet. Its function runs during preparation,
  and an exception from it is `Request.InvalidRequest`. Joining two `Request` values stays out: it
  would need a conflict rule for every part of a request
  ([#81](https://github.com/viell-dev/slop-effect-schema-http/issues/81)).
- Tell `transformClient` which attempt is running. It receives the attempt number as a second
  argument, starting at `1` and matching the `http.attempt` log annotation, so a retry can go to
  another server, send a retry count or sign differently. A one-parameter function keeps working. A
  function with an optional second parameter of its own now receives the number there
  ([#99](https://github.com/viell-dev/slop-effect-schema-http/issues/99)).
- Let a query carry a `Date`. A query schema can encode to one, and `Request.setQuery` takes one in
  its object form, directly or from a function, written with `toISOString()`. A default under such a
  field is read from its text. An invalid `Date` has no ISO text, so it goes out as `Invalid Date`,
  and a schema such as `Schema.Date` refuses it before that. Headers stay text, because HTTP date
  headers are not ISO ([#110](https://github.com/viell-dev/slop-effect-schema-http/issues/110)).
- Add a Recipes page for everyday tasks, each compiled and run with its failure cases, and note
  Effect's trace headers in the browser limits
  ([#90](https://github.com/viell-dev/slop-effect-schema-http/issues/90)).
- Show generators and named transforms in the guides, and lead them with the main workflow: define
  once, adjust where it is used
  ([#109](https://github.com/viell-dev/slop-effect-schema-http/issues/109)).
- State where the library's promise stops, with what the default client does to a path, and
  recommend a slash convention
  ([#108](https://github.com/viell-dev/slop-effect-schema-http/issues/108)).
- Write the release instructions as a general procedure, replacing wording tied to `0.1`, and state
  the library's direction in the design page. Add a security policy and a bug report form
  ([#107](https://github.com/viell-dev/slop-effect-schema-http/issues/107)).

## 0.1.0 — 2026-11-04

First stable release, retaining the API and runtime behavior of `0.1.0-rc.1`. Existing candidate
consumers can update without code changes. Read [What's in
0.1](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.1) for the consumer
introduction.

- Give the opening guides distinct GET, POST, PATCH and DELETE examples, separate consumer and
  maintainer documentation, add complete checksum comparisons and introduce a consumer release
  article. Assume an existing Effect project, offer package-manager tabs, and explain named path
  inputs and operation input inference.
- Add module guides with executable examples, a complete installed-package quickstart, clearer
  navigation, and common-use explanations before advanced behavior
  ([#75](https://github.com/viell-dev/slop-effect-schema-http/issues/75)).
- Document every public export in the source and generated declarations; check docblock and Markdown
  TypeScript examples, and align request composition, failure explanations and publication guidance.
- Promote package metadata, unversioned install commands and source/release links together. The
  owner completed the final documentation review in
  [#67](https://github.com/viell-dev/slop-effect-schema-http/issues/67); qualification and
  publication are recorded in [#2](https://github.com/viell-dev/slop-effect-schema-http/issues/2).

## 0.1.0-rc.1 npm availability — 2026-11-03

Published the existing candidate to npm with the same tarball as the GitHub release. Both `rc` and
`latest` identified this prerelease during bootstrap. No API or behavior changes; use the explicit
candidate version when installing that historical release.

## 0.1.0-rc.1 — 2026-11-01

Read [What's in 0.1](https://viell-dev.github.io/slop-effect-schema-http/release-notes/0.1) for an
introduction to the consumer API.

First installable candidate for `0.1.0`, initially distributed through GitHub Releases. This
candidate is intended to become stable with documentation, version and release-metadata updates
after the [publication prerequisites](https://github.com/viell-dev/slop-effect-schema-http/issues/2)
are complete.

- Consumer-owned request and response contracts, finite body codecs, ordered response selection,
  retry policies, header-line interoperability, replaceable URL encoding and scoped interactions.
- Preserve literal question marks at the start of declared query keys, including bare keys
  ([#66](https://github.com/viell-dev/slop-effect-schema-http/issues/66)).
- Installable ESM package with strict declarations, all public subpath exports, MIT license and
  source maps; remove the development-only `private` flag.
- Checksummed tarball and runnable synthetic consumer example, verified in an isolated installation.
  Release qualification covers Windows/Linux, Effect 4.0.7/4.1.1 package consumers, and all four
  hostile-server lanes.
- Published installation, compatibility, recovery and release procedures.
- Refresh Effect, ESLint, mdrefine and compatible transitive dependencies, and qualify TypeScript 7
  consumers. The build/lint toolchain retains TypeScript 6 until typescript-eslint supports 7
  ([#69](https://github.com/viell-dev/slop-effect-schema-http/issues/69)).

The [limits](https://viell-dev.github.io/slop-effect-schema-http/limits) remain part of the
contract: finite bodies, client-owned transport and browser policy, no server generation or general
cache. The remaining [release
review](https://github.com/viell-dev/slop-effect-schema-http/issues/67) is recorded separately from
automated qualification.
