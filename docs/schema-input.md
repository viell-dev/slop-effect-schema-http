# Schema-backed input

Use this reference when a path, query, header or body accepts a schema. For the ordinary binding
syntax, start with [Request](./modules/request.md#bind-application-input) or
[Body](./modules/body.md). [Schema-backed groups](./schema-groups.md) covers fixed defaults and
stacked query/header bindings. Use the rules below to choose an input form and check its
preservation limits.

## Choose an input form

| You have                                         | What to supply                              | Important limit                                                                        |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Application values                               | The schema's constructor input              | A plain object can construct a class; constructor defaults can fill omissions          |
| A complete wire-shaped value                     | The schema's encoded input                  | Constructor priority still applies; decoding/re-encoding can change spelling           |
| Fields using different sides                     | A supported one-level mix                   | Nested mixing is not recursively built into the type; some runtime combinations refuse |
| Conflicting names or an unsupported default path | Validate and map to one decoded shape first | Supplying both aliases is not a general conflict check                                 |

For example, a finite-number query can accept a number or its encoded text:

<<< ../examples/modules/request.ts#imports

<<< ../examples/modules/request.ts#two-sides

The [cumulative release history](./release-notes/index.md#schema-input-hardening) distinguishes
static typing repairs, extensions of constructor-default validation, and separate normalization
fixes. Current support is defined below; it does not require reconstructing earlier articles.

## Reading either schema side

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
renamed field under both names can lose one value: a constructor/decoded read prefers the decoded
name, while a whole encoded read uses the encoded name. Added whole-group validation can change that
choice. Defaults hidden by group transformations or fallback routes can still replace raw edits. The
rules and limits below state where the current checks apply.

### Array normalization preserves positions

When stripping an inner object's unstated fields requires a new view, keep the array's actual keys
and length, holes and readable hidden/inherited numeric cells. Metadata is not an additional element
or looked up as an element type. Symbols stay symbols in lookup and loss diagnostics; noncanonical
index-looking strings stay metadata. Keep an unchanged value's identity and do not invoke its
iterator to rebuild it. Ordinary processing can still read getters and inspect prototypes. Discover
hidden/inherited positions only in structural array views without an open or opaque alternative; a
union's Array alternative alone does not justify inspecting another alternative's value. Existing
enumerable-child normalization still applies across views and does not select or execute an
alternative. These 0.15 corrections do not extend the bounded constructor-default proof: previously
accidental failures can uncover existing unsupported sparse or own-iterator default substitutions
under #170. The [0.15 migration](./release-notes/0.15.md) states exact changed outputs and the
validated-decoded workaround.

### The decoded side is what the schema's constructor takes

The library builds the schema's value before encoding it, so a plain object works for a
`Schema.Class`, and a field with a constructor default can be left out. These functions need
`Schema.Top`, the bound that has a constructor. Building and then encoding validates twice, which is
part of preparation; neither step is skipped.

## Constructor-default validation

Every additional check below requires stable caller evidence and successful actual strict output.
Eligibility is not a promise that every schema or value in the listed container is safe.

| Actual route/container                                               | Added validation                                               | Retained limit                                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Initial whole construction at the root                               | Decode the supplied encoded-only input as a whole              | No decoded-only or ambiguous witness names                                        |
| Final fieldwise construction at the root                             | Retain the original strict refusal after failed whole decoding | No decoder replay or nested ownership inferred from property reads                |
| Initial whole construction below direct objects/closed parent unions | Follow stable unchanged declared fields                        | Every declaring member must share the same field schema                           |
| Initial whole construction below dense arrays/tuples                 | Follow own data positions with matching output length          | Optional-element union routes and sparse/iterator profiles can still lose aliases |

Preparation tries the decoded side first, then the decoder as a whole, then the decoder field by
field. If all fail, it reports the decoded side's error, a `SchemaError` before dispatch. After a
typed strict read failure, stable plain root input can establish an additional encoded check from
finite closed object/union names: it supplies an encoded-only name and no decoded-only name.

### Initial whole construction

The initial whole constructor still runs first, followed by existing strict-first writing. Only a
successful strict write that actually writes that supplied encoded-only name permits whole decoding
to replace the constructor result. The additional check retains loss/sibling certificates and
preserves the original strict refusal if decoding fails.

### Final fieldwise construction

If the actual winning route instead ends in fieldwise construction, at the root or through root
union members, its preceding whole decoder has already failed. Under the same stable caller/output
proof and successful strict write, retain the original strict refusal rather than accepting the
ignored alias's generated replacement. Do not observe individual property reads as this route,
replay decoding, or rebuild encoded input from prepared output. Successful strict reads,
writer-failure fallback and other constructor or decoder choices keep their paths. Existing
defaults/writer effects can precede refusal; construction is not repeated to classify the input.

### Nested paths and positional ancestors

For successful initial whole construction, finite closed untransformed object/union ancestors can
also establish a nested terminal proof. A parent union retains all member names, but follows a field
only when every declaring member has the identical field AST type; missing fields on other closed
members do not supply ownership. Normalize and merge declarations inside objects with the same
guard, including numeric/string collisions for one JavaScript key. A conflicting type stays
ambiguous after later repeated declarations. Distinct declarations remain names in ancestor evidence
but end that path. Untransformed array nodes also contribute explicit element/rest positions.
Capture stable dense own-data arrays of ordinary/null prototype, including nonenumerable/frozen
cells. Record all own keys/descriptors/identities and known positional absences, without invoking
iterators or cloning values. Use actual length for post-rest positions and require every selected
array's strict-output length to match. Reject
sparse/accessor/inherited/subclass/custom-iterator/changing profiles and array-shaped parent union
members for this extension. Metadata and selected-path validation have linear reflection gates;
capture each ancestor frame once. No schema, default or suspension runs to build this metadata.
Capture stable own-data paths before callbacks and select one coherent caller path and actual strict
output write, never independent candidates. Validate output correspondence at selection, then retain
caller evidence through whole decoding and loss checks. Whole decoding can repeat checks and
services; do not replay construction. Root fieldwise success cannot establish nested ownership
because its property reader can already consume that alias. Unsupported evidence remains under
[#170](https://github.com/viell-dev/slop-effect-schema-http/issues/170).

## Preservation and selection

### A value that fits the decoded side is read as decoded

When both sides have the same type, as under a schema from `string` to `string` such as
`Schema.StringFromBase64`, an already encoded value cannot be told apart from a decoded one, so it
is encoded again, with no error. Under a group with other fields, the order above decides: a group
that only fits on the encoded side goes through the decoder as a whole, so a shared-type field in it
is read as encoded.

### Each route validates what it consumes

An encoded field read through the decoder is validated; a value fitting neither reading fails during
preparation. Unsupported constructor-default paths can still ignore an alias instead, as recorded
under #170 above.

### A value stays on the side it was given on

Where a schema's two sides state different names, a value on the encoded side can also fit the
decoded side by losing them. Under
`Struct({ a: optionalKey(String) }).pipe(encodeKeys({ a: "A" }))`, `{ A: "x" }` would be an empty
value, and a constructor default would go out in the caller's place. Such a schema is read strictly,
as a union is below, at any depth, so that value goes through the decoder. The same goes for a
transformation between objects. A value takes its names from one side, so `{ a, B }`, which mixes
the names of two renamed fields, is a `SchemaError` that names `B`.

```ts
import { Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const Renamed = Schema.Struct({ a: Schema.optionalKey(Schema.String) }).pipe(
  Schema.encodeKeys({ a: "A" }),
);
const search = Request.get("https://api.example.test/things").pipe(
  Request.query(Renamed),
);
// Input: { query: { A: "x" } }; URL query: ?A=x
```

### A union keeps what the caller gave

Effect takes the first member that fits and strips what that member does not state, when it reads a
value and again when it encodes one. A schema with a choice between objects is therefore read
strictly, through both steps, so a member that keeps every field wins over an earlier one that would
strip one, at any depth. What it reads is what the caller means: a key set to `undefined` holds
nothing, so it is no field, and a key no member states is left out, so neither can push a value out
of the member that holds the rest. A struct reads a stated name however a value holds it, so an
accessor on a class, an inherited field and one that is not enumerable are fields, and they become
keys first, because a strict read only counts keys. An ordinary class instance that only a struct
can read reads as a plain object. A strict read that passes has stripped nothing. Anything else is
read as Effect reads it, and the result is compared with what went in, so what is lost is what
actually went. A schema with neither choice skips this and reads as it always did. Under either
choice a schema's own steps can run more than once for a value the strict read refuses.

```ts
import { Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const Either = Schema.Union([
  Schema.Struct({ a: Schema.String }),
  Schema.Struct({ a: Schema.String, b: Schema.String }),
]);
const search = Request.get("https://api.example.test/things").pipe(
  Request.query(Either),
);
// Input: { query: { a: "x", b: "y" } }; URL query: ?a=x&b=y
```

### A field no member can keep is an error

Under `Union([Struct({ a }), Struct({ b })])`, `{ a, b }` is a `SchemaError` before dispatch, naming
the field that would go. The types allow that value, and whichever member took it would lose a field
the schema states, so the choice cannot be made for the caller. A field a wider member states and
refuses the value of is the same case. Only a real loss counts: a field another schema in the group
takes is not lost, as the rule on stacked schemas below says.

### An opaque value is the schema's own reading

A value is opaque when neither side of its schema states an object for it: text given as text, and
what a `Schema.ReadonlyMap`, a `Schema.Option` or a declaration with no struct behind it holds.
Nothing here can reach inside, so nothing is refused for what happens there, and a union in one
reads as Effect reads it. Either side counts, so an object given to a field that holds JSON is not
opaque, and nor is the value in `Schema.OptionFromNullOr`, whose encoded side states it: a union
there keeps or refuses as any other does. A strict read of a whole value does pass through an opaque
one, because Effect has no way to stop it at one part. So beside a choice the library can see, a
wider member inside can still win. A stray key inside fails that read, and what the library can see
is then read as Effect reads it and compared, so a field a wider member could hold can be refused. A
direct closed struct can recover some such nested losses through the constructor-only route below.

### The reading of Effect is tested, not checked at run time

Knowing what a schema states means reading Effect's schema structure, which a newer Effect could
change. Tests hold that reading to the versions named in [Limits and recovery](./limits.md), in CI,
on the oldest Effect the peer range allows, and on each dependency update. On an untested Effect it
can fall back to Effect's own reading, so a field can go with no error, and valid use does not stop.

### A key no member states is stripped, as a struct strips it

That is not a union choosing badly. The types did not allow the key, and a stacked schema's fields
reach every schema in the group this way. So is a key only a member with another tag states, because
the tag has already chosen. A required literal tag can choose by its decoded or encoded name,
including when a whole-object transformation changes its name or literal. Both views must rule a
member out before its fields go. A missing tag with a constructor default leaves that view possible;
its default is not run to guess a member. A key set to `undefined` is no field at all, so
`{ a, b: undefined, c }` reads as `{ a, c }`, and a member that states `b` cannot take the value
from one that states `c`. An encoded name beside its decoded twin can be stripped on a
constructor/decoded route, under a union as under a struct. A whole encoded read instead uses the
encoded name, including when an ignored alias elsewhere establishes the added validation route. Name
selection does not prove that supplied values agree; general conflicting-alias refusal remains under
#143.

### A weak schema lets more through

`Schema.NumberFromString` turns `"many"` into `NaN`, so `{ limit: "many" }` goes out as `limit=NaN`,
and `Schema.FiniteFromString` refuses it. That is a property of the definition, and the library does
not try to correct it.

The type of an input is `Request.Input<S>`, and the type of a whole request's input is
`Request.InputOf<R>`. Whole constructor and encoded input shapes remain available through nested
objects, lists, tuples, classes and union members. Mixing by field remains one level deep in the
type; it does not recursively rebuild nested fields. Identical sides are elided using a compiler
type-identity comparison. Mutual assignability or equal outer keys alone cannot establish matching
nested names, so distinct mutually assignable sides remain whole and keep nominal identity and
discriminated alternatives. A plain value in a branded field compiles, because it is on the encoded
side, and it goes through the schema's checks. The compiler therefore checks less than it would for
the decoded side alone: a string where a number was expected compiles, and fails when the request is
prepared if the schema refuses it.

A helper using `Request.Input` must handle the actual alternatives, including encoded nested names.
Decoded-only helpers declare their own input shape or supply it through a named mapping; the [0.10
migration](./release-notes/0.10.md) shows both. This type repair changes neither constructor
priority nor schema reading. An opaque `Schema.ReadonlyMap` can read encoded inner aliases as
decoded contents and lose them according to its constructor. Supply decoded contents for a
predictable decoded route.

## Recovery beside an opaque value

A strict whole read can fail inside an opaque field and leave a visible union with its narrower
member. If the original reader reports a nested caller field it would lose, a direct closed struct
can try a constructor-only recovery. Root losses alone do not start it, because a sibling schema can
hold those names. No earlier successful call takes this additional route.

The attempt keeps the full original input and stable evidence captured before callbacks. Visible
data must still match that evidence when recovery starts; input changed while its encoding Effect
was pending retains the original refusal. The comparison does not inspect inside opaque values. It
constructs supplied visible fields strictly, and direct opaque declarations without an encoding
ordinarily. It then runs the original parent's strict constructor and writer, including its checks
and defaults, and compares the actual result with the original visible fields. It accepts only
complete preservation. A typed candidate failure or a remaining loss keeps the original refusal;
defects and interruption propagate.

Shared references and object values under open or empty schemas do not provide that evidence:
copying them can change identity checks that the schema itself preserves. Arrays need their ordinary
prototype and no inherited in-range elements. Accessors, inherited or nonplain visible data and
suspended structure also prevent a stable capture.

Every supplied field must fit its constructor. Trying each field's decoder as well would change
whole-input priority: one field might require whole decoding while another fits both sides and would
be read differently in isolation. That case retains the original refusal. JSON text and broader
transformed, open or unstable inputs remain outside this recovery; opaque values are not decoded and
re-encoded to prepare a different input. New attempts can repeat effects and require schema
services. The [0.6.1
example](./release-notes/0.6.md#since-0-6-1-keep-visible-fields-beside-an-opaque-value) shows the
bounded case.

## Active limits and recovery

The kept-or-refused rule is the intended contract. Known violations remain under
[#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143) and
[#170](https://github.com/viell-dev/slop-effect-schema-http/issues/170); an unsupported proof is not
a guarantee that preparation refuses safely.

- Conflicting aliases can lose one supplied value. A decoded/constructor route prefers the decoded
  name, while whole encoded reading uses the encoded name. An encoded-only sibling can change that
  choice for the whole value. The [0.14 migration](./release-notes/0.14.md#account-for-both-names)
  includes a typed nonliteral example. Supply only one side or validate a decoded mapping.
- Conflicting normalized declarations, including numeric 1 and string "1" for the same JavaScript
  key, cannot establish an unchanged nested path. The ambiguity guard can therefore leave a supplied
  invalid alias replaced by a generated default.
- A dense array of optional elements can still lose an invalid alias: wrapping the direct element
  schema in `Schema.optional` takes an unsupported union/member constructor route even without holes
  or metadata. Use a validated decoded mapping for this profile too.
- Sparse or own-iterator arrays can still replace invalid aliases with defaults. Preserving
  positions removed accidental failures without fixing that loss: a sparse invalid item can write
  `[null,{"page_size":"25"}]`. The [0.15 migration](./release-notes/0.15.md) retains exact controls
  and an executable validated decoded mapping.
- Opaque contents use their schema's own reading. A `ReadonlyMap` containing
  `{ term: "x", page_size: "05" }` can lose the alias through construction. Use decoded contents
  such as `{ term: "x", limit: "05" }` for a predictable decoded route.
- Some complete encoded filter fields beside a cursor held by a separate binding still refuse in
  either binding order. Bounded [stacked-union
  recovery](./schema-groups.md#declarations-and-defaults) does not perform general backtracking;
  bind the intended member directly.
- Effect can refuse omitted prototype-named fields such as `constructor` or an encode-only
  `toString` default. The [dependency
  overview](https://github.com/viell-dev/slop-effect-schema-http/issues/41) records the schemas and
  controls. Preserve the schema error rather than bypassing validation.

A safe explicit route validates the external representation with the application's chosen schema,
maps it to decoded names, then supplies that decoded value through `Request.mapInput` or the
operation input. The migration examples execute those steps and keep failure cases checked.
