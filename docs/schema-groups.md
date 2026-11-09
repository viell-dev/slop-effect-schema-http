# Schema-backed groups

This reference owns query/header declaration shapes, raw defaults, generated fields and stacked
binding recovery. For adding a typed query or header, start with
[Request](./modules/request.md#query-parameters-and-headers). For constructor/encoded input and
array preservation, see [Schema-backed input](./schema-input.md).

## Declarations and defaults

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
  text consumed through the schema is validated, and a decoder that accepts more spellings than its
  encoder writes cannot let a loose spelling out. The raw-default correspondence limits below remain
  exceptions. A default therefore loses its exact text: `?page=02` under a number field goes out as
  `page=2`, and order and header spelling follow the schema.
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
- **Refuse an edit successful preparation replaces.** A direct struct or finite closed union with no
  group encoding can supply an omitted field through construction, decoding, fieldwise input or
  encoding. When its ordinary non-iterable output actually holds an own enumerable non-`undefined`
  data value under the same name, a raw edit after the binding is an `InvalidRequest`. The caller
  must have left that field absent throughout its prototype chain, or supplied an own data property
  containing `undefined`, before preparation runs. This includes setting, appending and either kind
  of removal, with header names compared without case. The check reads the successful encoded result
  without evaluating any callback again. Earlier raw defaults and explicit caller values keep their
  existing behavior.
- **An empty group can prove generation through a transformation.** When the decoded and encoded
  group shapes are closed objects or finite unions of closed objects, a plain or null-prototype
  caller group with no own keys supplies no declared fields, provided every endpoint name is also
  absent from its prototype chain. This is snapshotted before preparation, including symbol and
  non-enumerable keys. Actual ordinary output can then prove that a later edit of a generated
  encoded name is replaced. Any own caller key, custom prototype or inherited endpoint field
  disables this additional proof. It does not infer a mapping between names or repeat a schema
  callback. For the union extension, every traversed group encoding step must also be closed;
  property-value schemas supply no group correspondence.
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
- **A union may recover an initial refusal.** If normal preparation would refuse uncovered
  group-level fields, an eligible top-level anyOf union retries the whole schema with each other
  member moved to the front, keeping every member and the original full input. Its members must be
  closed direct structs without group transformations or iterable representation. Parent checks,
  encoding checks, context/defaults and annotations are retained unchanged, including unfamiliar
  metadata. Each candidate runs its validation; a previous passing answer cannot approve a new
  member. Group encoding and nested losses exclude this recovery. This preserves whole-union
  constructor/decoder/fieldwise priority and each field's custom schema. A candidate must cover both
  original and new loss obligations, and its certificate replaces only this applied binding's claim.
  Aggregate coverage of previously certified names cannot decrease, so earlier successful checks
  stay justified. Reused binding factories get distinct identities per application. If none
  qualifies, the original refusal remains. These new attempts can evaluate schemas again or fail;
  already successful calls never enter recovery. This is a bounded search, with no joint
  backtracking between bindings. If normal reading and writing still fail after their usual fallback
  routes, this search does not run: they must succeed before an uncovered field loss can trigger it.
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

A specific member can be bound directly when its selection should not depend on recovery:

```ts
import { Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const search = Request.get("https://api.example.test/things").pipe(
  Request.query(Schema.Struct({ a: Schema.String, c: Schema.String })),
  Request.query(Schema.Struct({ b: Schema.String })),
);
// Input: { query: { a: "x", b: "y", c: "z" } }; URL query: ?a=x&c=z&b=y
```

## Limits and deliberate native edits

Some things are outside the check:

- Text in the URL is not a field. A `?` in a base URL or in `Request.path` output is not read.
- `Request.mapEffect` is the deliberate way around a schema, so a native edit is not a declaration.
  A schema's output replaces every entry under the names it writes, so a native edit has to come
  after the schema to survive under such a name. `transformClient` and a client layer work on the
  prepared request, so the check does not see them.
- A check is only as strict as its schema. `Schema.NumberFromString` accepts `"two"` as `NaN`.
- Invalid encoded aliases can still take optional constructor defaults outside the supported
  [constructor-default validation](./schema-input.md#constructor-default-validation). That reference
  owns the root, nested, array and recovery boundaries and the decoded-input workaround.
- A group transformation can hide a default's field correspondence. The strictly empty caller-group
  proof above covers some such calls. With any own caller field, a renamed default can still replace
  a later raw edit without refusal; the library does not guess which alias supplied that output.
- Generated-field proof otherwise remains limited to explicit same-name fields of direct structs and
  closed unions without group encoding. Classes, declarations, suspended/unknown/open endpoints and
  accessor/inherited input remain outside the additional empty-group proof. Iterable output uses
  yielded entries, so own string properties prove nothing about what it sends. An absent,
  non-enumerable, accessor or `undefined` output property supplies no generated-field evidence.
  Ordinary schema/default and lost-field checks still apply.
- A union outside the recovery guard keeps its initial selection. For example, the union of `{ b }`
  and `{ a, c }` stacked with `{ b }` can still refuse `{ a, b, c }` if its parent check rejects the
  initial `{ b }` read, because that failure precedes field-loss recovery. If the initial read and
  write pass, candidates must still satisfy the same parent checks. Recovery also declines a
  candidate that would withdraw an earlier field certificate, and it does not jointly backtrack
  several choices.
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
