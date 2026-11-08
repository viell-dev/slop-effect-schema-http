# Design

This page defines the library's behavior contract: what it promises and what it delegates to the
application, Effect, or the HTTP provider. Start with [Getting started](./getting-started.md) and
the [module guides](./api.md) for examples; use this page when you need precise rules. Changes to
these guarantees follow the [compatibility policy](./versions.md#compatibility-policy).

## The main workflow

An application writes a definition once, near the integration, and adjusts it where it is used. A
definition describes the most common request, not the only one.

1. Describe application input with `Request` and body encoders.
2. Describe accepted responses with `Response` and body decoders.
3. Pair them with `Operation.make`. The result is the definition, an ordinary value to share.
4. Where a use needs something else, [derive a variant](#variants). The original never changes.
5. Supply an Effect HTTP client and evaluate `execute(input)`.
6. Receive a validated value or a typed failure. Add a retry policy or interaction only when needed.

Request encoding is **materialization**: turning a description and input into the native request. An
**attempt** sends that request and decodes its answer. A **scope** owns the resources that must be
released when an attempt ends. The sections below refine those steps.

## Principles

**A plan stays a plan.** `Request`, `Response` and `Operation` values describe work, and nothing
happens until an Effect runs. A plan can be copied and adjusted at any time, and adjusting it never
disturbs the original. Defaults serve the common case and never prevent a less common one.

**Wire Effect, do not replace it.** The library composes Effect's schema and HTTP modules around
consumer-owned contracts. It adds no transport, runtime, service registry, logging facility, cache,
or configuration provider. Where Effect already defines a behavior, the library delegates to it:

- `Body.json` encodes with `HttpBody.json`.
- `Policy.transient` follows the classification of `HttpClient.retryTransient`.
- `Policy.retryAfterDelay` reads `Retry-After` with `Headers.parseRetryAfter`.
- Requests are dispatched through the `HttpClient` service, so client middleware and providers apply
  unchanged.

**Consumer control over imposed policy.** The library makes a choice only where an operation cannot
work without one. An unconventional path, header, method, or status code is not a reason to reject
it or to rewrite its meaning. Defaults that embody a policy can be replaced through ordinary Effect
composition. For example, `UrlEncoding` is a context reference with a replacement layer.

**As permissive as possible on its own end.** Everything in the library is meant to be composable,
configurable or replaceable. It lets through as much as it can: it does not rewrite what a request
declares, and it refuses a request only for something the consumer chose, such as a schema, or
because a URL cannot be rendered at all.

The library passes the request you declared to the HTTP client you chose, and its promise stops
there. The client may rewrite or refuse it, and a server may read it differently. The library does
not promise that an unusual request works. Where this page says the client receives something as
written, it describes what the library hands over, not what reaches a server. [Limits and
recovery](./limits.md#paths-and-other-requests-passed-on-as-written) records what the default client
does.

**Schemas are optional to choose and binding when chosen.** A field with no schema takes plain
input. A chosen schema decides what is valid, and input cannot skip that check, though a caller need
not build a typed value first.

**Finite bodies first.** Streaming request and response bodies are deferred. The finite-body design
must not foreclose them.

These principles give a few rules that the sections below state in full:

- Bindings add, and nothing replaces silently. The constructor path and `Request.path` join, and
  later schemas add fields. Functions that say they replace, such as `Request.setQuery` and
  `Request.baseUrl`, still do, and `Request.unbind` starts a group again.
- A schema states the shape of its group: once any schema is bound to headers or query, every header
  or query field the request declares must be a name some schema allows. A raw value under such a
  name is a default, and any other name is an error.
- A request's own declaration wins. Automatic `Accept`, `Content-Type` and `Content-Length` apply
  only when the request declares nothing.
- What is written is what the client receives. Path text is joined exactly, a constructor query
  keeps its spelling until something edits that entry or a schema covers it, header names keep their
  spelling unless a schema covers them, and a fragment stays on the request.

## Requests

A `Request` is a pure description of an HTTP request and of the input needed to send it.
Constructing one evaluates nothing; materialization happens when an operation runs or when
`Request.compile` is evaluated.

### Fields and schemas

Use raw fields for fixed headers or query parameters, and bind a schema for values supplied by the
caller. Path, query, header and body bindings contribute their corresponding input properties; see
the [Request examples](./modules/request.md#bind-application-input).

Raw declarations (`setHeader`, `appendHeader` and the query equivalents) take a value or a
computation. A computation runs once per materialization, and `undefined` omits the field.
`setHeader` and `setQuery` also take a plain object, whose keys each replace their name in key
order. Its query values are what a query schema may encode to, or a computation of one such value,
so `page: 2` writes `page=2`, a `Date` writes ISO text, `null` is a bare key and an array repeats
the name, at the name's first position. In either group a key set to `undefined` removes that name's
earlier declarations. Header names compare without case and keep the spelling they were written
with, so a `setHeader` that replaces an earlier line also replaces its spelling. Query keys compare
exactly.

`Request.headers` and `Request.query` take a schema whose encoded side fits the representation
(`Transport.HeaderInput` or `UrlEncoding.QueryInput`); its application side can be any shape.
`Request.path` and `Request.body` add their input to the request, so each can be combined with the
other bindings.

A query or header binding makes its input key optional when `Request.Input<S>` accepts `{}`. An
all-optional struct qualifies, and a union qualifies when one member does. Stacked bindings
intersect their input contributions, so every binding on the group has to permit omission. A
required field stays required even when a raw default supplies its name.

An absent or `undefined` query or header group is read as `{}` inside each binding, before schema
validation or accounting for the caller's fields. Omitting it therefore behaves exactly like an
explicit `{}`, including constructor defaults and refinements that can reject an empty object. Other
explicit values, including `null`, are validated as given. With TypeScript's
`exactOptionalPropertyTypes`, an explicit `undefined` still has to fit the schema's input.
`Request.mapInput` keeps its declared argument, and `Request.unbind` still removes the group. Path
and body keys remain required. The call still takes an input object: `execute({})` works for
omittable groups, and `execute()` remains a compile error.

### A schema has two sides

A schema's decoded side is what an application works with, and its encoded side is what goes on the
wire. In Effect, outgoing data goes through `encode` and incoming data through `decode`. The two
directions are not always inverses. A decoder can accept more than the encoder writes, so
`decode(encode(value))` need not equal `value`, and `encode(decode(text))` need not equal `text`. A
schema may accept `t1530` and `15:30` and always write `15:30:00`.

A schema-backed input takes either side, or a mix by field, and the request always carries what the
schema writes. That applies to headers, query, path and bodies, and it is the same route a raw
default takes.

```text
decoded value ----------------------> encode --> wire
encoded value --> decode --> decoded -> encode --> wire
```

**What the library promises.** For a value it can see, a field the caller gave is kept, or the
request is refused. It can see plain objects, lists, tuples, classes and unions of those, at any
depth. Inside an opaque value, which is text that holds JSON, a `Map`, an `Option` or any other
declaration, the schema's own reading applies, and nothing is refused for what happens there. To
choose a union member for certain, bind that member directly.

Known violations of this rule remain in
[#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143). In particular, giving a
renamed field under both names still lets the decoded name win, and defaults hidden by group
transformations or fallback routes can still replace raw edits. The rules and limits below state
where the current checks apply.

- **The decoded side is what the schema's constructor takes.** The library builds the schema's value
  before encoding it, so a plain object works for a `Schema.Class`, and a field with a constructor
  default can be left out. These functions need `Schema.Top`, the bound that has a constructor.
  Building and then encoding validates twice, which costs microseconds next to a request, so neither
  step is skipped.
- **Preparation tries the decoded side first, then the decoder as a whole, then the decoder field by
  field.** If all fail, it reports the decoded side's error, a `SchemaError` before dispatch, so
  existing failures read the same.
- **A value that fits the decoded side is read as decoded.** When both sides have the same type, as
  under a schema from `string` to `string` such as `Schema.StringFromBase64`, an already encoded
  value cannot be told apart from a decoded one, so it is encoded again, with no error. Under a
  group with other fields, the order above decides: a group that only fits on the encoded side goes
  through the decoder as a whole, so a shared-type field in it is read as encoded.
- **Both routes validate.** An encoded value goes through the decoder, so text cannot get past a
  schema. A value on neither side is a compile error.
- **A value stays on the side it was given on.** Where a schema's two sides state different names, a
  value on the encoded side can also fit the decoded side by losing them. Under
  `Struct({ a: optionalKey(String) }).pipe(encodeKeys({ a: "A" }))`, `{ A: "x" }` would be an empty
  value, and a constructor default would go out in the caller's place. Such a schema is read
  strictly, as a union is below, at any depth, so that value goes through the decoder. The same goes
  for a transformation between objects. A value takes its names from one side, so `{ a, B }`, which
  mixes the names of two renamed fields, is a `SchemaError` that names `B`.
- **A union keeps what the caller gave.** Effect takes the first member that fits and strips what
  that member does not state, when it reads a value and again when it encodes one. A schema with a
  choice between objects is therefore read strictly, through both steps, so a member that keeps
  every field wins over an earlier one that would strip one, at any depth. What it reads is what the
  caller means: a key set to `undefined` holds nothing, so it is no field, and a key no member
  states is left out, so neither can push a value out of the member that holds the rest. A struct
  reads a stated name however a value holds it, so an accessor on a class, an inherited field and
  one that is not enumerable are fields, and they become keys first, because a strict read only
  counts keys. An ordinary class instance that only a struct can read reads as a plain object. A
  strict read that passes has stripped nothing. Anything else is read as Effect reads it, and the
  result is compared with what went in, so what is lost is what actually went. A schema with neither
  choice skips this and reads as it always did. Under either choice a schema's own steps can run
  more than once for a value the strict read refuses.
- **A field no member can keep is an error.** Under `Union([Struct({ a }), Struct({ b })])`,
  `{ a, b }` is a `SchemaError` before dispatch, naming the field that would go. The types allow
  that value, and whichever member took it would lose a field the schema states, so the choice
  cannot be made for the caller. A field a wider member states and refuses the value of is the same
  case. Only a real loss counts: a field another schema in the group takes is not lost, as the rule
  on stacked schemas below says.
- **An opaque value is the schema's own reading.** A value is opaque when neither side of its schema
  states an object for it: text given as text, and what a `Schema.Map`, a `Schema.Option` or a
  declaration with no struct behind it holds. Nothing here can reach inside, so nothing is refused
  for what happens there, and a union in one reads as Effect reads it. Either side counts, so an
  object given to a field that holds JSON is not opaque, and nor is the value in
  `Schema.OptionFromNullOr`, whose encoded side states it: a union there keeps or refuses as any
  other does. A strict read of a whole value does pass through an opaque one, because Effect has no
  way to stop it at one part. So beside a choice the library can see, a wider member inside can
  still win. A stray key inside fails that read, and what the library can see is then read as Effect
  reads it and compared, so a field a wider member could hold can be refused. A direct closed struct
  can recover some such nested losses through the constructor-only route below.
- **The reading of Effect is tested, not checked at run time.** Knowing what a schema states means
  reading Effect's schema structure, which a newer Effect could change. Tests hold that reading to
  the versions named in [Limits and recovery](./limits.md), in CI, on the oldest Effect the peer
  range allows, and on each dependency update. On an untested Effect it can fall back to Effect's
  own reading, so a field can go with no error, and valid use does not stop.
- **A key no member states is stripped, as a struct strips it.** That is not a union choosing badly.
  The types did not allow the key, and a stacked schema's fields reach every schema in the group
  this way. So is a key only a member with another tag states, because the tag has already chosen. A
  required literal tag can choose by its decoded or encoded name, including when a whole-object
  transformation changes its name or literal. Both views must rule a member out before its fields
  go. A missing tag with a constructor default leaves that view possible; its default is not run to
  guess a member. A key set to `undefined` is no field at all, so `{ a, b: undefined, c }` reads as
  `{ a, c }`, and a member that states `b` cannot take the value from one that states `c`. An
  encoded name beside its decoded twin is stripped too, under a union as under a struct: the whole
  value is not on the encoded side, so the decoded name is the field.
- **A weak schema lets more through.** `Schema.NumberFromString` turns `"many"` into `NaN`, so
  `{ limit: "many" }` goes out as `limit=NaN`, and `Schema.FiniteFromString` refuses it. That is a
  property of the definition, and the library does not try to correct it.

The type of an input is `Request.Input<S>`, and the type of a whole request's input is
`Request.InputOf<R>`. A mix is one level deep in the type, and a renamed field takes its encoded
name only when the whole value is on the encoded side. A plain value in a branded field compiles,
because it is on the encoded side, and it goes through the schema's checks. The compiler therefore
checks less than it would for the decoded side alone: a string where a number was expected compiles,
and fails when the request is prepared if the schema refuses it.

#### A last constructor attempt

A strict whole read can fail inside an opaque field and leave a visible union with its narrower
member. If the original reader reports a nested caller field it would lose, a direct closed struct
can try a constructor-only recovery. Root losses alone do not start it, because a sibling schema can
hold those names. No earlier successful call takes this additional route.

The attempt keeps the full original input and stable evidence captured before callbacks. It
constructs supplied visible fields strictly, and direct opaque declarations without an encoding
ordinarily. It then runs the original parent's strict constructor and writer, including its checks
and defaults, and compares the actual result with the original visible fields. It accepts only
complete preservation. A typed candidate failure or a remaining loss keeps the original refusal;
defects and interruption propagate.

Every supplied field must fit its constructor. Trying each field's decoder as well would change
whole-input priority: one field might require whole decoding while another fits both sides and would
be read differently in isolation. That case retains the original refusal. JSON text and broader
transformed, open or unstable inputs remain outside this recovery; opaque values are not decoded and
re-encoded to prepare a different input. New attempts can repeat effects and require schema
services. The [0.6.1
example](./release-notes/0.6.md#since-0-6-1-keep-visible-fields-beside-an-opaque-value) shows the
bounded case.

### A schema states the shape of its group

In plain terms, once any schema is bound to headers or query, every header or query field the
request declares must be a name some schema allows.

A field group is a dictionary of names, and each raw edit produces a new dictionary. A header or
query schema states the shape of that dictionary, and one that cannot be built against the schema is
an error: `Request.InvalidRequest` before anything is sent.

- **A raw value under a name a schema allows is a default.** What the schema writes replaces it. If
  the schema writes nothing under that name, the default stays, so an omitted optional field never
  removes an inherited value. An empty list counts as written, and leaves no entries, and so does a
  value the schema supplies itself: a constructor or decoding default writes the name, so it
  replaces a raw default.
- **A default goes through the schema.** The group is decoded and encoded again, together with what
  the schema wrote, and the request carries the result. A value that does not fit is an error. Raw
  text cannot get past a schema, and a decoder that accepts more spellings than its encoder writes
  cannot let a loose spelling out. A default therefore loses its exact text: `?page=02` under a
  number field goes out as `page=2`, and order and header spelling follow the schema.
- **A default cannot push a field out.** Effect strips what a union member does not state, so a
  group whose default and caller's field sit in different members would lose one of them with no
  error. The whole group is matched first, so a member that holds all of it wins over an earlier
  member that holds part of it. If no member holds it, a field the schema does not write back is an
  error naming that field, whichever side it came from. Under
  `Union([Struct({ page, size? }), Struct({ cursor })])` a shared `?page=1` takes `{ page: 2 }` and
  refuses `{ cursor }`, because no member holds both.
- **A raw value under a name no schema allows is an incompatible shape.** The check looks at the
  finished declaration, so it does not matter whether a shared transform comes before or after the
  schema.
- **A raw edit of a required field is an error.** After a schema, setting a name it always writes
  could never reach the client, because the caller's value replaces it, and removing that name would
  change nothing, because the schema puts the value back. An edit of an optional field is allowed:
  setting it changes the default, removing it clears the default, and callers can still pass that
  field. A field with a decoding default counts as required, because the schema writes it whatever
  the caller does. This is the one rule that depends on order. Before the schema, a raw value under
  a required name is an ordinary default that the caller's value replaces.
- **Refuse an edit successful preparation replaces.** A direct struct can supply an omitted field
  through construction, decoding, fieldwise input or encoding. When its ordinary non-iterable output
  actually holds an own enumerable non-`undefined` data value under the same name, a raw edit after
  the binding is an `InvalidRequest`. The caller must have left that field absent throughout its
  prototype chain, or supplied an own data property containing `undefined`, before preparation runs.
  This includes setting, appending and either kind of removal, with header names compared without
  case. The check reads the successful encoded result without evaluating any callback again. Earlier
  raw defaults and explicit caller values keep their existing behavior.
- **An empty group can prove generation through a transformation.** When the decoded and encoded
  endpoints are closed objects, a plain or null-prototype caller group with no own keys supplies no
  declared fields, provided every endpoint name is also absent from its prototype chain. This is
  snapshotted before preparation, including symbol and non-enumerable keys. Actual ordinary output
  can then prove that a later edit of a generated encoded name is replaced. Any own caller key,
  custom prototype or inherited endpoint field disables this additional proof. It does not infer a
  mapping between names or repeat a schema callback.
- **Schemas stack.** A second `Request.query` or `Request.headers` adds its fields, and together the
  schemas state the shape. Each takes its own fields from one input, and a default goes through
  every schema that allows its name. An open schema sees every field, so its value type has to
  accept the others.
- **A field stays with the schema that took it.** Each applied binding records actual consumption;
  stating that a name is allowed supplies no certificate that it kept caller input. A union's lost
  group fields are checked against the other bindings' records. Caller-key evidence stays exact;
  header folding applies to wire names and defaults. A raw value a caller leaves out can stay with a
  non-union schema that allows and validates it, so the union need not hold that default. A body or
  path has no sibling bindings by name, so group sharing applies to headers and query.
- **A bare union may recover an initial refusal.** If normal preparation would refuse uncovered
  group-level fields, an eligible top-level anyOf union retries the whole schema with each other
  member moved to the front, keeping every member and the original full input. Its members must be
  closed direct structs without group transformations or iterable representation; parent behavior
  and nested losses exclude this recovery. This preserves whole-union constructor/decoder/fieldwise
  priority and each field's custom schema. A candidate must cover both original and new loss
  obligations, and its certificate replaces only this applied binding's claim. Aggregate coverage of
  previously certified names cannot decrease, so earlier successful checks stay justified. Reused
  binding factories get distinct identities per application. If none qualifies, the original refusal
  remains. These new attempts can evaluate schemas again or fail; already successful calls never
  enter recovery. This is a bounded search, with no joint backtracking between bindings.
- **A schema can allow other names.** A record or `Schema.StructWithRest` allows any name, and
  values are still checked. Callers can then pass any name as well.
- **`Request.unbind` removes bindings.** `Request.unbind(group)` makes earlier bindings of that group
  skip themselves and removes their input type and the shape, so raw values go out unchecked. It
  takes `"path"`, `"query"`, `"headers"` or `"body"`, and replacing a binding is `unbind` followed by
  a new one. After `Request.mapInput`, the binding is skipped, but the mapped input keeps whatever
  the mapping requires. A request's error and service types keep what a removed binding added.

Names are wire names, read from the schema's encoded AST when it is bound. That covers structs,
classes, renamed fields and unions, where a union allows what any member allows and requires what
every member writes. Where names cannot be read, as with a record or a list of pairs, the schema
allows any name. Header names compare without case, and query names compare exactly.

A name is required if the encoded side requires it. It is also required if the encoded side leaves
it optional, the decoded side always holds a value, and the step that makes it optional hands that
value on as it is, which is how a decoding default writes. A step that decides for itself may write
nothing, so `Schema.OptionFromOptionalKey` and a default with the `omit` encoding strategy do not
count. A raw value under `omit` is refused differently: the schema reads it and never writes it, so
it would be lost.

Raw values are text. Where a field encodes to a number, boolean, bigint or `Date`, the text is read
as one first, the reverse of how the library writes it, so a schema encoded as a number accepts a
default. Date text is read as `Schema.DateFromString` reads it, with `new Date(text)`, and text that
holds no date stays text for the schema to refuse. Only ISO text with a `Z` or an offset reads the
same everywhere. JavaScript reads other forms by the engine's rules, and text with no offset in the
time zone of whatever runs the request. A single raw value under a list field fits that list. A
query entry written in the constructor is a raw value like any other, under its decoded name. A
written empty segment has no name, so it is not a field, and it stays as written.

The check runs when the request is prepared, not in the editor. A definition's dictionary is
normally incomplete, because required values come from the caller, and a stacked schema can allow a
name a later step needs. An edit in a `pipe` returns a `Request`, so an incompatible shape or an
edit of an always-written name fails on every run, whatever the input. A generated optional field's
refusal depends on the invocation. Catching these in the types would need field names in the
request's type, which stops generic helpers from compiling.

Some things are outside the check:

- Text in the URL is not a field. A `?` in a base URL or in `Request.path` output is not read.
- `Request.mapEffect` is the deliberate way around a schema, so a native edit is not a declaration.
  A schema's output replaces every entry under the names it writes, so a native edit has to come
  after the schema to survive under such a name. `transformClient` and a client layer work on the
  prepared request, so the check does not see them.
- A check is only as strict as its schema. `Schema.NumberFromString` accepts `"two"` as `NaN`.
- A group transformation can hide a default's field correspondence. The strictly empty caller-group
  proof above covers some such calls. With any own caller field, a renamed default can still replace
  a later raw edit without refusal; the library does not guess which alias supplied that output.
- Generated-field proof otherwise remains limited to explicit same-name fields of direct structs.
  Classes, unions, unknown/open endpoints and accessor/inherited input remain outside the additional
  empty-group proof. Iterable output uses yielded entries, so own string properties prove nothing
  about what it sends. An absent, non-enumerable, accessor or `undefined` output property supplies
  no generated-field evidence. Ordinary schema/default and lost-field checks still apply.
- A union outside the bare-recovery guard keeps its initial selection. For example, a group-level
  check prevents recovery for the union of `{ b }` and `{ a, c }` stacked with `{ b }`, so
  `{ a, b, c }` can still be refused. Recovery also declines a candidate that would withdraw an
  earlier field certificate, and it does not jointly backtrack several choices.
- Two members can state one field under different wire names. A union of `{ c }` and `{ c }` renamed
  to `C` takes the first member that fits, so `{ C: "s" }` goes out as `?c=s`. The value arrives,
  under the other member's name, with no error. Bind the member you mean directly.
- A schema that encodes to an iterable other than a list of pairs, such as a `Map`, cannot take
  defaults, because they are added as pairs. A default under it fails the check.

A failed check names the fields and never includes their values, because a default may be a
credential. It carries no `cause`, since a schema's error would repeat the value.

Allowing a name also offers it to callers: a schema field is both what the group may hold and what
the caller may pass. `Request.mapInput` hides a field by fixing its value, and `transformClient` or
a client layer keeps a value off the request description altogether.

### Bodies

For typed JSON, `Body.jsonSchema` validates application values in both directions. Use another codec
when the service sends text, bytes or forms; the [Body guide](./modules/body.md) starts with these
common choices.

A body needs an encoder or a decoder, not necessarily a schema. `Body.json`, `Body.text`,
`Body.bytes`, `Body.formData`, `Body.urlEncoded`, and `Body.empty` cover the finite representations,
and `Body.encodeSchema`, `Body.schema`, and `Body.jsonSchema` add validation.

`Body.json` is untyped and encodes exactly as `HttpBody.json` does. That includes Effect's choice
for a value that `JSON.stringify` omits, such as `undefined` or a function: it encodes as an empty
`application/json` body. `Body.jsonSchema` is the validated path; it encodes through the schema's
canonical JSON codec (`Schema.toCodecJson`), and a struct schema never produces `undefined`.

`Body.text` delegates incoming decoding to the provider's `response.text`. Fetch-backed providers
decode UTF-8 regardless of a `Content-Type` charset, strip a leading UTF-8 byte-order mark, and
replace malformed bytes with U+FFFD without failing. Use `Body.bytes` with a schema or custom
decoder when the format needs strict decoding, another encoding, or the original bytes. Web
`TextDecoder` labels follow the [Encoding
Standard](https://encoding.spec.whatwg.org/#names-and-labels): `iso-8859-1` selects windows-1252, so
bytes 0x80–0x9F differ from exact Latin-1. A format that requires exact Latin-1 needs its own byte
mapping.

A body is what the client gives the library. Truncated gzip is a partial body and a success in
Node.js `fetch` and in Chromium, and Chromium ignores a wrong CRC, so [a compressed body that stops
early](./limits.md#a-compressed-body-that-stops-early) is only refused by a format or schema that
needs the whole of it.

The body codec supplies the request's `Content-Type` and `Content-Length`. Multipart form data
leaves both to the transport, so it can add the boundary. These are automatic values: a request that
declares nothing keeps them, and a request's own declaration wins.

- A value from `setHeader`, `appendHeader` or a header schema wins over the automatic one, whether
  it comes before or after the body. It keeps its lines and spelling.
- An optional schema field the caller leaves out counts as nothing declared, so the automatic value
  still applies.
- `Request.removeHeader(name)` stops the automatic value: the request records the name, and the
  library adds nothing for it. It stops only the library's own value. A later declaration, a header
  schema's output or a `Request.mapEffect` edit still goes out, and the client may add its own. A
  computed value that returns `undefined` declares nothing, so the removal stays in force, and so
  does a field a header schema leaves out. `Request.removeHeader(name, value)` stops nothing,
  because the name may still be declared.
- A declaration stays on a request with an empty body, including `Body.empty`.
- On multipart form data, a declared `Content-Type` replaces the one the transport would supply.
  That is the consumer's choice, and without the boundary the body cannot be read.

A declaration describes a header and never changes the bytes a codec produced, so a declared
`Content-Length` can disagree with the body. A client can refuse such a request, and Effect's Fetch
client takes a non-empty one off before `fetch` sees it. The body step applies these rules itself,
so a later `Request.mapEffect` still has the last word on the native request, and one before the
body sees its edit replaced unless the request removed that name.

Any method can carry a body, including GET and HEAD. The library passes the request to the client
and adds no check of its own. A client can still refuse it: `fetch` does so for GET and HEAD, which
surfaces as a transport failure from the client, not as `Request.InvalidRequest`.

### Request transforms

`Request.mapInput` adapts the invocation argument. `Request.mapEffect` edits the native request
effectfully, once per evaluation before any attempt. It sees the preparation steps before it, but
the base URL has not been joined and query entries are still separate parameters: the URL is not
final. URL-dependent signing belongs in client middleware through `Operation.make`'s
`transformClient`, after any request edits the signature must cover. It runs per attempt, after the
library renders the base URL and query. The provider's own URL normalization still applies.

### The path is joined exactly

A request's path is the constructor's path followed by what each `Request.path` call adds, in order,
joined exactly as written. The library adds no `/` and removes none:

| Constructor           | Added             | Path                          |
| --------------------- | ----------------- | ----------------------------- |
| `/users`              | `/42`             | `/users/42`                   |
| `""`                  | `/users/1`        | `/users/1`                    |
| `https://api.test/v1` | `/users/1`        | `https://api.test/v1/users/1` |
| `/things/42`          | `:archive`        | `/things/42:archive`          |
| `/a`                  | `/b#x`, then `/c` | `/a/b`, with fragment `x/c`   |
| `/users/`             | `/42`             | `/users//42`                  |
| `/users`              | `42`              | `/users42`                    |

This is one rule with no exceptions. It does not tidy a URL, and only it can express a suffix such
as `:archive` or `.json`. The cost is that `/users/` and `/42` pass a double slash to the client, so
the [Request guide](./modules/request.md#add-to-a-path) recommends a convention: start each piece
with `/`, do not end one with `/`, and leave both off a base URL. A trailing slash is part of the
address, so the library never adds or removes one, and one a server wants goes on the last piece.

- **`?` and `#` in path text are ordinary URL syntax.** Joining comes first, so anything after a `#`
  belongs to the fragment, and a `?` starts query text. That text is [not a
  field](#a-schema-states-the-shape-of-its-group), and a declared query goes after it.
- **A whole URL gets no special case.** After an empty constructor path it is the request URL, and
  the default `UrlEncoding.join` lets it bypass the base. After other text it is added like any
  other, because `/fetch/https://other.test/x` is a legitimate path, and letting it replace what
  came before would bring back a silent loss.
- **A constructor's query and fragment are not part of the path.** They are separated before any
  path work, so they survive `Request.path` and `Request.setPath`.
- **A base URL is joined last.** `UrlEncoding.join` handles that boundary, so it is the one place
  with slash logic of its own.

The finished path is passed to the client as written, and what the client then does is outside the
library's promise. Measured with Fetch on Node.js 24 and in Chromium, `//` and a trailing slash are
kept and dot segments are resolved, including encoded ones. A server may merge `//`. Another client
can differ, and the library does not promise that an unusual path works.

#### Templates and renderers

`Request.path` has two forms, and which to use depends on the path's shape, not on taste.

A **template** is for a fixed shape:
`` Request.path`/customers/${customer}/calendars/${calendar}` ``. A tagged template is a function
called with backticks, which receives the text and the `${}` values separately, so there is no
grammar and nothing to escape. Text is used as written, from `strings.raw`, so a `\` is a backslash
and no JavaScript escape applies. That also means a template cannot write a backtick or `${` without
its backslash, so a path that needs one uses the constructor or a renderer. Fixed text is a template
with no values, and it needs no input.

Only a `PathValue` compiles in a template, declared by `Request.pathValue(name, schema?)`. A value
arrives under its name in `{ path }`, as a string when it has no schema. Its input is `Input<S>`, so
it takes [either side of its schema](#a-schema-has-two-sides). What the schema writes is then always
encoded with the active `UrlEncoding` path encoder. A plain string in a template is a compile error,
and so are parentheses in place of the backticks and a schema that does not encode to one string,
number, bigint or boolean. A schema can still get past that type: `Schema.Any` has no type to check,
and `Schema.optionalKey` can leave the value out. A value that is not a scalar then fails with
`Request.InvalidRequest` rather than writing `undefined` or `[object Object]`.

A **renderer** is for a shape that depends on the value: a value holding several segments, a whole
URL, or a path that branches on a value. `Request.path(schema, render)` passes `render` the
schema-encoded value and the path encoder, and adds what it returns. Escaping each dynamic value is
up to the renderer. Text chosen at run time also needs a renderer, or `Request.mapEffect`, because a
template's text is fixed when it is written.

The compiler checks a value's name against the input, not against the text around it, so
`` Request.path`/users${id}` `` compiles and gives `/users42`. A value is declared apart from the
template, so a variable and the name it holds can drift apart.

Schema failures stay `SchemaError`, and they name the value. Exceptions from a renderer or from the
path encoder stay `Request.InvalidRequest`.

#### Values share one input

Each `Request.path` adds to the `path` input, so a child states only its own part and the combined
input is inferred. A schema reads its own fields and ignores the others, for a template value, a
`Schema.Struct` and a `Schema.Class` alike.

- **The same name with the same type is one value,** and every use receives it.
- **The same name with incompatible types makes the input impossible to supply,** which shows as a
  compile error at `execute`. Inside one template, two schemas under one name are a union in the
  type, so that mistake fails when the request is prepared. Give each level its own field name.
- **A scalar renderer has no name.** It takes the whole `path` value, so stacked with a template, or
  with a scalar of another type, it makes the input impossible to supply. Scalars of one type share
  one value.

#### Replacing a path

Nothing replaces a path silently. `Request.unbind("path")` makes earlier `Request.path` calls skip
themselves, which removes their text as well as their input, and it leaves later ones alone. The
constructor's path stays, because it is a declaration. `Request.setPath` replaces that text and
leaves every binding in place, and it keeps the constructor's query and fragment. The two together
replace a whole path.

### URLs are made sendable, not normalized

`Request.baseUrl` supplies a shared origin and fixed prefix, and the base is joined after the path
is complete. A later call replaces the base, and
[`Request.mapBaseUrl`](#a-base-url-can-be-known-late) changes it. The library does not join two
Request values.

The `UrlEncoding` service renders path values, query entries, and the final URL. Its defaults
percent-encode path values and query entries with `encodeURIComponent`, and join the base URL and
the request URL at their slash boundary. They do not resolve dot segments, drop empty values, or
reorder anything:

- A path value of `..` composes `https://api.test/v1/files/..`.
- An empty path value composes an empty segment, such as `https://api.test/v1/files//meta`.
- An encoded dot segment such as `%2e%2e` is encoded again (`%252e%252e`), so it stays literal.

What happens to the URL afterwards is a property of the client. Effect's `HttpClient.make` parses
the composed URL with the WHATWG `URL` parser, which resolves dot segments. A relative URL with no
base fails there as an invalid URL, except in a browser, where it resolves against the page. The
runner that `make` calls also receives the unparsed request, so a provider can send the composed URL
unchanged. A consumer that must never send a dot segment validates the value in the path schema or
replaces `UrlEncoding.path`; the default does not restrict every consumer to protect some.

Encoded is not the same as safe. A `/` in a value cannot add a segment, but `..` and an empty string
contain nothing to encode, so a value from a user needs a constraint in its schema, such as
`Schema.TemplateLiteral` or a pattern. `encodeURIComponent` also leaves `'` alone, so a value inside
`` `Customers('${customer}')` `` can close the quote.

A base URL is an origin plus a path prefix. The default join is a string join, so a query string in
the base URL ends up before the joined path. Put parameters that every request needs in a shared
transform:

```ts
import { Request } from "viell-effect-schema-http";

const service = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(
    Request.setQuery("key", "abc"),
    Request.baseUrl("https://api.test/v1"),
  );

// GET https://api.test/v1/users?key=abc
const users = service(Request.get("/users"));
```

A query string in a URL passed to `Request.make` or a method helper such as `Request.get` is passed
to the client as written until something edits that entry or a schema covers it:

| Written                                            | The client receives      |
| -------------------------------------------------- | ------------------------ |
| `/x?a=1;b=2`                                       | `/x?a=1;b=2`             |
| `/x?a=1&&b=2`                                      | `/x?a=1&&b=2`            |
| `/x?`                                              | `/x?`                    |
| `/x?q=a+b`                                         | `/x?q=a+b`               |
| `/x?a=%41&wsdl`                                    | `/x?a=%41&wsdl`          |
| `/x?a=%41&b=1;2` with `setQuery("a", "new value")` | `/x?a=new%20value&b=1;2` |
| `/x?` with `setQuery("b", "1")`                    | `/x?b=1`                 |
| `/x?a=1&` with `setQuery("b", "1")`                | `/x?a=1&&b=1`            |
| `/things?page=02&&tail=1` under a schema for both  | `/things?&page=2&tail=1` |

Each segment between `&` signs is also an entry with a form-decoded name and value, so `setQuery`,
`appendQuery` and `removeQuery` can edit one entry and leave the others alone. Decoding reads `+` as
a space and decodes percent escapes. It keeps a bare key (`?wsdl`) distinct from an empty value
(`?wsdl=`), and semicolons and further equals signs are data. It decides what an entry is called,
not what the client receives. A written empty segment is text like any other, so `&&` survives an
addition; its decoded name is the empty string. A lone `?` holds no entries and only records that
the marker was written, so an added field reads `/x?b=1`.

A value from `setQuery`, `appendQuery` or a schema goes through `UrlEncoding.query`, because it is
data and not written URL text. A custom `UrlEncoding.query` receives only the entries that are not
kept as written, in order. Written text standing between them splits them into separate calls, so
the query keeps its order. Written text is what the author wrote, so the library neither re-encodes
nor validates it, until a query schema covers the entry. [A schema states the
shape](#a-schema-states-the-shape-of-its-group) of its group, so a written entry goes through a
schema that allows it, and one no schema allows is an incompatible shape. A lone `?` holds no
entries, so a schema has nothing to say about it, and it stays until something writes an entry.

A written empty segment is not a field, so a schema leaves it in place, and what a schema writes
goes after every entry it leaves in place. An empty segment between two entries a schema covers
therefore ends up leading, as the last row of the table shows.

A URL that cannot be rendered or encoded fails with `Request.InvalidRequest`.

### A base URL can be known late

`Request.baseUrl` also takes an `Effect`, so a service or a `Config` value can supply a location
that is not known when the request is defined. That is Effect's own mechanism, so the library gains
no configuration system, and a definition stays a plain value. Forgetting the location is a compile
error, where a relative request sent with no base would fail or reach the wrong server at run time.

- **The types carry it.** The Effect's failures and services join the request's. A later
  `Request.baseUrl` replaces the Effect, so it never runs, but the types keep what it added, as they
  do for `Request.unbind`.
- **It runs once per evaluation,** after computed fields, input encoding and `Request.mapEffect`,
  and before the first attempt. Refused input therefore costs no lookup, and every retry uses the
  same base.
- **Its failure is its own.** It stays the Effect's typed failure rather than
  `Request.InvalidRequest`, and nothing is sent. A policy does not retry it, and an `attemptTimeout`
  does not limit it, because both apply to attempts.
- **What it supplies is a base like any other.** It goes through `UrlEncoding.join`, and a fragment
  or query in it behaves as it does in text. The Effect runs even when an absolute request URL
  bypasses the base, because the join decides that.

`Request.mapBaseUrl` changes a base in either form, so a variant can extend a prefix it cannot read,
or one that is not known yet. Its function runs during preparation in both, as constructing a
request evaluates nothing, and an exception from it is `Request.InvalidRequest`. It receives the
whole text as it stands at that step, so a later `Request.baseUrl` replaces the result, and text
added after a fragment stays in the fragment. `declaration.baseUrl` is text or an Effect, and after
`Request.mapBaseUrl` it is always an Effect, so reading it is no way to extend a base.

A location that must change between attempts belongs in client middleware, through
[`transformClient`](#preparation-and-attempt-lifetime). A base resolved here cannot move during
retries.

### Fragments stay on the request

A fragment ends a URL, so the query always goes before it. The compiled request keeps the fragment
out of its URL text, in Effect's native `hash` field, exactly as written. Effect keeps a fragment
there too, and client middleware can use `HttpClientRequest.setHash` and `removeHash` on it. A path
that renders `/users/1#top` with the query `f=xml` compiles to the URL `/users/1?f=xml` and the hash
`top`.

A fragment written in the constructor survives `Request.path` and query edits, as a constructor
query does. `Request.mapEffect` sees it in `request.hash`, and `HttpClientRequest.removeHash` there
removes it.

Compilation takes any fragment off the base URL and off the request's URL before joining them, so a
custom `UrlEncoding.join` receives neither. When several places supply a fragment, the first of
these wins:

1. the native `hash`, which the constructor or `HttpClientRequest.setHash` sets;
2. the request's URL, such as `Request.path` output;
3. the base URL, even when an absolute request URL bypassed it;
4. text that a custom `UrlEncoding.join` returned.

What happens to a fragment afterwards is a property of the client. `HttpClient.make` puts it back on
the `URL` it gives its runner, which percent-encodes some characters. A provider built with
`HttpClient.makeWith` reads `request.url` directly, so it has to read `request.hash` as well.
`fetch` does not send a fragment.

### A query value can be a `Date`

A query value is text, and a `Date` has an obvious text, so `UrlEncoding.QueryValue` includes it and
a query schema can encode to it. It is written with `toISOString()`. A request carries a schema's
encoded side, and the caller gives its decoded side:

| Schema                                                                             | Caller gives          | Request carries |
| ---------------------------------------------------------------------------------- | --------------------- | --------------- |
| `Schema.Date`                                                                      | A `Date`              | ISO text        |
| `Schema.DateFromString`                                                            | A `Date`, or its text | ISO text        |
| A schema from `Date` to an application's own type, as `Schema.DateTimeUtcFromDate` | Its type, or a `Date` | ISO text        |

An invalid `Date` has no ISO text, so it goes out as `String(value)`, which is `Invalid Date`. A
schema such as `Schema.Date` refuses it before that, with a `SchemaError`. A raw record takes a
`Date` too, in the object form of `Request.setQuery`, which turns it into text when the request is
defined, so a later change to that `Date` changes nothing. As a default it goes through the schema
like any other [raw value](#a-schema-states-the-shape-of-its-group).

Headers stay text. Date headers such as `If-Modified-Since` use the HTTP date format, not ISO, so
`Transport.HeaderInput` has no `Date`, and a header schema writes its own text.

### Wire representations stay distinct

These are different things and the library keeps them different:

- a bare query key (`null`) and an empty value (`""`);
- a repeated query entry or header line and a single one;
- a header value that contains commas and several header lines;
- the order of entries, including across names.

These distinctions describe the request the library materializes. Client middleware can change them
afterwards: Effect appends native URL parameters through
[`URLSearchParams`](https://url.spec.whatwg.org/#interface-urlsearchparams), which serializes the
whole query as form data. Appending `key=abc` to `?wsdl&q=a%20b` that way produces
`?wsdl=&q=a+b&key=abc`. Put parameters in `Request` combinators to use the library's encoding. If
middleware must add a parameter, preserve the existing URL text and encode the new entry explicitly.

Native client middleware sees the normalized `Headers` view: lowercase names, with repeated lines
joined by `, `. The original lines, with their spelling, are available to a provider that can send
them, through `Transport.HeaderLines` and `Transport.headerLines`. Lines changed by middleware
replace the original lines of that field only. On responses, provider-observed lines are an
`Option`, and `None` means the provider supplied none. The library never splits a combined value or
invents lines.

The library does not refuse a carriage return or line feed in a URL, a header name or a header
value. `fetch` and `node:http` do not put them on the wire, and a provider that writes bytes itself
[has to refuse them](./modules/transport.md#refuse-cr-and-lf-in-a-provider-that-writes-bytes).

## Responses

A `Response` selects a decoder from transport metadata only: status, headers, cookies, and the
optional provider lines. Selection happens before any body byte is read.

Use `Response.status(200, decoder)` for one expected status and add alternatives with
`Response.orElse`. A matched response returns the decoder's value, even when the declared status
represents an application-level failure such as 404. The [Response guide](./modules/response.md)
shows how to tag and interpret those outcomes.

### Selection and decoding rules

- Declaration order is priority. `Response.orElse` consults its fallback only when no earlier case
  matches; there is no ranking by specificity.
- A selected decoder's failure is final. It fails with `Response.DecodeError`, which carries the
  metadata and the decoder's typed cause, and never falls through to a later case. Payloads that
  vary under identical metadata are a `Schema.Union` inside one case.
- An unmatched response is drained, then fails with `Response.UnexpectedResponse`, which carries the
  metadata only. If draining itself fails, the result is a `Response.DecodeError`. A consumer that
  needs the payload of other responses declares a final case that reads it.
- No live response crosses a failure boundary: the attempt's scope closes, releasing the response's
  transport resources, before the outcome is returned or classified. Errors are not stripped,
  though. A `DecodeError` keeps the decoder's cause, and an Effect client error there, or one from
  middleware that rejected the response, includes the response object with any body it already read.
  Treat such errors as possibly containing response content.

The media types of the declared decoders form the operation's automatic `Accept` header. As with the
[body fields](#bodies), a request's own declaration wins, an optional schema field left out counts
as nothing declared, and `Request.removeHeader("accept")` stops the automatic value.

### Cases and keys

A contract is an ordered list of cases, available as `cases`, and `select` and `accepts` are
computed from it. Each case has a key. A status case is keyed by its status, and a `Response.when`
case by its `key` option, or by nothing without one. Tags stay labels on results, because they are
optional and can repeat.

- **`Response.replace(key, decoder)`** changes one case's decoder. The case keeps its position and
  its match rule, because order is priority. If a key appears twice, the first position stays and
  the others go.
- **`Response.remove(key)`** removes every case with that key, so a matching response falls through
  to a later case or to `UnexpectedResponse`.
- **Adding a case** is `Response.orElse`, or placing the new case first. Replacing never adds one,
  so a typo cannot leave the old case in place.
- **The type follows the cases.** A contract's fourth type parameter records each case, so a
  replaced or removed case leaves the result, failure and service types.
- **A key is one literal the contract declares.** A key that is absent, widened to `number` or
  `string`, or a union is a compile error, whether it is passed in or is the case's own key. A union
  is refused because the type would drop every member while only the value passed is touched at run
  time. A key that gets past the types throws when the contract is built, so nothing fails silently.
- **An annotation drops the keys.** `Response.Response<A, E, R>` has no keys to address, which is one
  way to seal a contract.

Because keys are part of the type, two contracts with different cases are different types. A `let`
cannot hold one and then the other, and `Operation.make` refuses a conditional between them.

### In a browser

The HTTP provider and browser determine which response facts are visible. In a Fetch-backed browser
client:

- `Set-Cookie` is hidden from response metadata even if CORS lists it as exposed. The browser
  manages cookies according to its credentials and cookie policy; a hand-set `Cookie` request header
  is dropped.
- A cross-origin header that CORS does not expose is absent. A response rule cannot select on a
  hidden value. A custom decoder that requires it can fail with `Response.DecodeError`.
- With `redirect: "manual"`, a redirect becomes an opaque redirect response with status 0 and no
  visible headers. A declared 301 case cannot match the original status.
- A refused preflight and a request whose answer is withheld by CORS both surface as transport
  failures. The latter may already have changed server state, so retrying can repeat an action.
- Effect's client adds `b3` and `traceparent` headers by default, which forces a preflight on a
  cross-origin request. A server that does not allow them refuses it, so a working server looks down.
  `HttpClient.TracerPropagationEnabled` [turns them
  off](./recipes.md#browser-requests-to-another-origin).

These are [Fetch platform limits](https://fetch.spec.whatwg.org/), outside the library. A schema or
response rule cannot recover hidden metadata. Do not infer browser cookie, redirect, header or CORS
behavior from a Node run.

## Execution

`Operation.make` pairs a request with a response contract. Construction is pure, and executing it
returns an ordinary cold `Effect`.

By default an evaluation makes one attempt. The application supplies `HttpClient` and decides when
to run the Effect. See [Operation](./modules/operation.md) for execution and error handling, then
[Policy](./modules/policy.md) for retries and timeouts.

### Preparation and attempt lifetime

Each evaluation materializes the request once: computed fields run, input is encoded and a base URL
Effect runs a single time, so credentials stay the same across retries. Anything that must differ
per attempt, such as a nonce or a signature over the attempt, belongs in client middleware through
the `transformClient` option. Its second argument is the attempt number, which starts at `1` for
each evaluation, counts every attempt, including one that timed out, and matches the `http.attempt`
log annotation. A function with an optional second parameter of its own receives the number there.

Each attempt owns a `Scope` that covers dispatch and decoding. The scope closes, aborting the
attempt's request if it is still in flight, before the outcome is classified or a retry delay
begins. After `HttpClient.followRedirects` the scope does not release the last hop's response,
because of how Effect ties its abort signal to the first request
([#142](https://github.com/viell-dev/slop-effect-schema-http/issues/142)). A response nobody reads
then stays open until garbage collection. A timeout or an interruption still ends it.

### Retry rules

Retries follow a `Policy`:

- The default, `Policy.none`, makes one attempt. That is one attempt by the library, not one send.
- `Policy.make` takes a schedule and options. One schedule owns the retry budget across every
  reason, and a failing schedule fails the operation with the schedule's error.
- The `while` option replaces the default classification, `Policy.transient`: timeouts, transport
  errors, and the statuses 408, 429, 500, 502, 503, and 504. It sees every completed outcome, so
  `while: () => true` also repeats a 200 that decoded successfully until the schedule ends.
- Interruption and defects never retry.
- `Retry-After`, as delay seconds or an HTTP date, is a minimum delay. It also applies when client
  middleware turned the response into an error, such as `HttpClient.filterStatusOk`. Malformed or
  unrepresentable values request no delay.
- `attemptTimeout` limits each attempt; a timed-out attempt is transient. A limit on the whole
  operation is an ordinary `Effect.timeout` applied by the caller. `Policy.timeout` is one attempt
  with this limit and no retries. It excludes preparation and result mapping, as any attempt timeout
  does.

The transient classifier checks status or failure alone. It does not check the request method or
idempotency, and even a declared response that decoded successfully is retried when its status is
transient. A POST that returns a declared HTTP 500 can therefore run several times when retries are
enabled. A transport error can also follow a request the server already acted on; it does not prove
that nothing was sent. Use `Policy.none` for a single attempt by the library, or supply a `while`
classifier suited to the operation's repeat semantics. Its `Reason` contains metadata and failures,
not the request method or decoded result; the method can be captured from the operation's known
configuration. Decisions that need the decoded value belong in the consumer's composition outside
this classifier.

The client can repeat a request too, and its answer decides what a classifier sees. Both are the
client's, within [what the library promises](#principles), and [Limits and
recovery](./limits.md#what-a-client-does-with-a-request) records what was measured:

- When a reused connection ends with no response, Chromium sends the request again by itself, a POST
  included, so one attempt can make two commits. Node's clients do not. An idempotency key goes out
  with both sendings, so the browser's second sending replays.
- A body cut off after the headers is a `Response.DecodeError` through `fetch`, not retried, and a
  classifier has nothing portable to tell it from malformed JSON by. Through a provider such as
  Node's `http` it is a transport error, retried. So one cut POST can duplicate through one provider
  and not another. `Policy.transient` stays as it is, because it matches Effect's classification.

### Variants

`Operation.make` keeps what it was built from in `parts`, as `request`, `response`, `options` and
`step`. `Operation.mapRequest`, `Operation.mapResponse` and `Operation.mapOptions` each take the
current part and return a new one. A plan stays a plan: each builds a new operation through
`Operation.make`, so the automatic `Accept` follows the response, and the original never changes.

The library adds no limit of its own on what a variant can change. An author who wants to offer less
exports a function with the parameters they choose, or seals a definition with
`Operation.fromEffect(operation.execute)`, which keeps the same types and has no parts, at compile
time or at run time. Annotating a value as a plain `Operation<I, A, E, R>` hides its parts from the
compiler only. Deriving from a value with no parts is a compile error, and one that gets past the
types throws.

A generic transform needs a `pipe` around it to learn its types. Hold the `Request` or `Response`
transform in a variable rather than the `Operation.mapRequest` call, which on its own has no
operation to infer from. For the same reason, `flow` over `Operation.mapRequest`,
`Operation.mapResponse`, `Operation.mapOptions` and `Operation.unmap` is a compile error unless its
first function names the operation, as `identity<typeof getThings>` does. A type cannot apply a
generic function, and the key and fit rules depend on an operation a composed function does not have
yet. Moving those rules into the result type would let `flow` compile, but a refused change would
then compile and run with no error where it was written.

A function given to `Operation.mapResponse` has to take the response's whole type, including its
cases, because the response slot is invariant, mapped or not. Make it generic, or type it as
`typeof contract`. `Response.Response<A, E, R>` is refused even with the operation's exact `A`, `E`
and `R`, because it does not say which cases there are. A function generic in the cases cannot
address one, because a key needs a known contract.

`Operation.map` and `Operation.mapEffect` wrap the operation's own `execute`, so a value whose
`execute` was replaced keeps that replacement. `Operation.mapRequest`, `Operation.mapResponse`,
`Operation.mapOptions` and `Operation.unmap` build from the parts, so they drop it.

### Recorded result steps

`Operation.map` and `Operation.mapEffect` keep the parts and record a **step**, the conversion to
run after them. Two maps combine into one step, so the type does not grow. A value with no parts has
nothing to record, so it is wrapped as an ordinary function.

- **A step runs once, after the retries.** It is outside the attempt's scope and timeout. Its
  failure arrives as itself, never triggers a retry, and is not wrapped in `Response.DecodeError`. A
  resource it opens belongs to the caller's scope.
- **A step's failures and services stay through a variant** and leave with `Operation.unmap`.
- **`mapRequest` and `mapOptions` always work on a mapped operation**, because they cannot change
  what the step receives.
- **`mapResponse` works when the new result fits.** The new result type must be assignable to the
  current response's result type, and not `any`, which proves nothing. So a same-shape replace, a
  removal or a stricter schema for the same shape compiles, and the step keeps running. That is what
  keeps a recognized outcome a failure: a `mapEffect` that fails on a 404 still fails after that
  case is replaced with the same shape.
- **Anything else is a compile error**, whose last line starts with the instruction to use
  `Operation.unmap`. That covers a new shape and a new case whose result does not fit. The check
  compares with the current response, so widening back after narrowing needs `Operation.unmap` as
  well. It stands aside when the function given to `mapResponse` does not compile, so a key the
  contract lacks gets its own error alone: nothing is known about that function's result.
- **`Operation.unmap` removes every step**, and the operation returns what its response decodes.
  Together with `Operation.map` it reaches any response, so the fit check blocks nothing.

The check is compile-time only. A cast gets past it, and the step then receives a shape it was not
written for, as with any cast. A step applies to the whole result: a conversion that belongs to one
case goes in that case's decoder with `Body.map`, and a replace takes it with the case.

### Error and service types

Failures and services are typed and kept separate. Input schema errors, `InvalidRequest`, a base URL
Effect's failure, transport errors, `DecodeError`, `UnexpectedResponse`, `TimeoutError`, and the
schedule's error are distinct members of the operation's error type. A request schema contributes
its encoding and decoding services, because an encoded input or a raw default goes through the
decoder, a base URL Effect contributes its own, and a response schema contributes its decoding
services. A decoder's or client transform's `Scope` is provided by the attempt and does not reach
the caller.

## Diagnostics

Operations emit Debug-level log events inside the `schema-http.operation` log span: when an attempt
starts and completes, when a retry begins or the budget is exhausted, and when the operation
completes. The annotations are the method, the attempt number, the numeric status, and an outcome
category (`success`, `failure`, `interrupted`, or `defect`). Nothing from URLs, headers, cookies,
bodies, decoded values, or error causes is recorded, because any of them can contain credentials or
personal data. At Effect's default minimum log level, nothing is emitted.

## Interactions

An `Interaction` serves one user-facing interaction, such as a search box, with at most one active
execution and one retained success.

Acquire it with `Interaction.make(execute)` inside a scope, then call `run(input)`. The [Interaction
guide](./modules/interaction.md) starts with sequential reuse before covering refresh and
cancellation.

### Reuse, replacement and lifetime rules

- Equal input joins the active execution or reuses the retained success. Input is compared with
  `Equal.equals` by default, which compares plain objects and arrays structurally.
- Different input interrupts the active execution.
- `force` starts fresh work, superseding the active execution and bypassing the retained success.
- `retain` decides whether a success is kept for reuse; it never changes the returned value. A
  rejected success drops an earlier retained success for equal input, which it replaces.
- Failures, defects, and interruptions leave the retained success in place.
- Each execution belongs to the interaction, not to a caller, and runs in its own child scope.
  Interrupting one waiter never cancels work another waiter shares.
- Every execution publishes its result, even when it was superseded before it started.
- Services are captured when the interaction is acquired, like a layer.
- `close` is permanent and idempotent, and runs when the acquiring scope closes. Every caller waits
  for the finalizers of all owned work, including superseded executions.

Presentation state, such as what a UI shows while work is pending, belongs to the application.

## Not provided

- A transport. Requests run through whichever `HttpClient` the application provides.
- Server or client code generation.
- Streaming bodies (deferred, see above).
- Caching beyond an interaction's single retained success, and configuration or logging facilities
  of its own.
