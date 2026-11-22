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
union's Array alternative alone does not justify inspecting another alternative's value. An empty
struct member is no such alternative, so beside one a structural view still discovers them. A
rebuilt view that does not discover them keeps them where the caller put them: an own cell it does
not rewrite keeps its descriptor, and an inherited one stays inherited from the same prototype.
Existing enumerable-child normalization still applies across views and does not select or execute an
alternative. The [0.15 migration](./release-notes/0.15.md) states the normalization changes and
exposed default substitutions. The [0.16 batch](./release-notes/0.16.md),
[0.17](./release-notes/0.17.md) and [0.18](./release-notes/0.18.md) extend the separate
constructor-default proof to the bounded profiles below.

### The decoded side is what the schema's constructor takes

The library builds the schema's value before encoding it, so a plain object works for a
`Schema.Class`, and a field with a constructor default can be left out. These functions need
`Schema.Top`, the bound that has a constructor. Building and then encoding validates twice, which is
part of preparation; neither step is skipped.

## Constructor-default validation

Every additional check below requires stable caller evidence and successful actual strict output.
Eligibility is not a promise that every schema or value in the listed container is safe.

| Actual route/container                                               | Added validation                                               | Retained limit                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Initial whole construction at the root                               | Decode the supplied encoded-only input as a whole              | No decoded-only or ambiguous witness names                                       |
| Final fieldwise construction at the root                             | Retain the original strict refusal after failed whole decoding | No decoder replay or nested ownership inferred from property reads               |
| Initial whole construction below direct objects/closed parent unions | Follow stable unchanged declared fields                        | Every declaring member must share the same field schema                          |
| Initial whole construction below arrays/tuples                       | Follow own data positions with matching output length          | Holes/inherited cells supply no witness; arbitrary own iterators remain excluded |
| Initial whole construction below array-shaped unions                 | Follow an array cell into the one member that can read it      | Every other member must refuse arrays at every stage                             |

Preparation tries the decoded side first, then the decoder as a whole, then, for an object that is
not a list, the decoder field by field. If all fail, it reports the decoded side's error, a
`SchemaError` before dispatch. [A list stays a list](#a-list-stays-a-list) describes that rule and
its limits. After a typed strict read failure, stable plain root input can establish an additional
encoded check from finite closed object/union names: it supplies an encoded-only name and no
decoded-only name.

Primitive alternatives that cannot consume an object contribute no object fields or names. This
includes the Undefined/Null members of optional, nullable and nullish object schemas. The allow-list
is String, Number, Boolean, BigInt, Symbol, UniqueSymbol, Literal, Enum, TemplateLiteral, Null,
Undefined and Never. A union whose members all qualify counts as one such alternative, at any depth.
Effect builds `Schema.Literals([...])`, `Schema.NullOr(Schema.String)` and
`Schema.NullishOr(Schema.Number)` this way, so `Union([Filter, Schema.Literals(["all"])])` behaves
like the flat `Union([Filter, Schema.Literal("all")])`. An encoded alternative qualifies when every
link of its encoding is a plain transformation and every stage qualifies, as in
`Schema.FiniteFromString`, `Schema.NumberFromString` or a codec from text to nullable text. Effect
reads the encoded end first, and a plain transformation cannot recover from that read's failure. A
middleware link, as `Schema.catchDecoding` adds, can turn the failure into a value, so it never
qualifies. A Void alternative qualifies only where the [strict Void
rule](#a-union-keeps-what-the-caller-gave) guards it, including inside an unencoded any-of member
union made up of these alternatives. Void elsewhere, unions with any other member, primitive
encoding intermediates and open/opaque/suspended alternatives do not qualify. The object members
retain the same field-identity and closed-name rules. A union of primitives alone still supplies no
object view at either level. A codec's closed object encoding view may include these alternatives,
such as `NullOr(Struct)` or `Union([Struct, Schema.Literals([...])])`; this can establish root or
terminal evidence too.

Array-shaped members are told apart from objects as Effect's parsers tell them, with
`Array.isArray`. An array or tuple member, or a plain-transformation chain of such stages such as an
array-to-array codec, cannot read an ordinary or null-prototype object cell. Beside an object member
it contributes nothing there, so the one-or-many `Union([Schema.Array(Filter), Filter])` reads
`{ page_size: "many" }` as `Filter` alone does. Such a view does not vouch for a list cell, which
the array member can read. A list under an object schema without such a member keeps its object
evidence, because the fieldwise route copies the list's own named properties into an object.

An actual array cell follows a union's one member that can read an array, when every other member
refuses arrays at every stage: a primitive alternative above, an object that states at least one
property or index signature, or a guarded Void, which declines a list with a defined own cell. So
`Union([Schema.Array(Filter), Schema.Void])` refuses `[{ page_size: "many" }]`. The followed member
must be an unencoded array or tuple, or another such union, and uses the array rules below.
`Schema.Struct({})` states no signature and reads every value except `null` and `undefined`, lists
included. The proof stops at a union with it, with a second array-reading member, or with an encoded
array member as the reader; ordinary selection decides those cells, which can keep the supplied
alias or replace it with a default.

Grouping members does not change either reading. An unencoded any-of member union refuses a kind of
cell when each of its own members does, and the Void rule of that inner union decides its Void
branch. With `Cursor = Schema.Struct({ cursor: Schema.String })`,
`Union([Schema.Array(Filter), Schema.Union([Cursor, Schema.Void])])` reads a list as the flat
`Union([Schema.Array(Filter), Cursor, Schema.Void])` does. With
`Parent = Schema.Struct({ filter: Filter })`,
`Union([Parent, Schema.Union([Schema.Array(Schema.String), Schema.Void])])` reads an object as its
flat union does. A `oneOf` member union leaves its Void unguarded, so that Void still counts as a
reader. One member union value used both where its Void is guarded and where it is not counts as
unguarded in every grouping, as it would be wherever that guard is missing; the active limits below
give the consequence.

Capture reads each own cell's descriptor, while the Void rule reads the cell by index. A proxy can
answer the two differently, and then the guarded Void sees no defined cell and can take the list.

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
Capture stable own-data arrays of ordinary/null prototype, including sparse and nonenumerable/frozen
cells. Record all own keys/descriptors/identities and known fixed positional absences, without
invoking caller iterators/getters or cloning values. Visit own keys rather than allocating by
length. Holes and inherited cells supply no witness; an own cell can still establish a whole read
that validates an inherited neighbor. Use actual length for post-rest positions and require every
selected strict-output array to have matching length and dense own data cells. An own
Symbol.iterator data property qualifies only when its value is the unchanged native array iterator;
the reference is Array.prototype's iterator as installed when the module loaded. Capture and recheck
its descriptor. Accessors, subclasses, custom prototypes/iterators and changing paths remain
excluded. A union ancestor passes an actual array cell only to its one array-reading member, as
described above. Metadata and selected-path validation have linear reflection gates; capture each
ancestor frame once. No schema, default or suspension runs to build this metadata. Capture stable
own-data paths before callbacks and select one coherent caller path and actual strict output write,
never independent candidates. Validate output correspondence at selection, then retain caller
evidence through whole decoding and loss checks. Whole decoding can repeat checks and services; do
not replay construction. Root fieldwise success cannot establish nested ownership because its
property reader can already consume that alias. Unsupported evidence remains under
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

### A field keeps what its own reading lost

The last route reads each field of an object on its own, then builds the object with the schema's
constructor. That constructor runs again over each field's result and fills a default where the
field's reading produced nothing, so each field's reading has to account for what the caller gave
it. A supplied field that a field's reading dropped is a `SchemaError` naming it, as the same value
at the root would be. This holds at any depth and in struct, list, tuple, record and union fields:

```ts
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Page = Schema.Struct({
  n: Schema.FiniteFromString,
  items: Schema.Array(Filter),
});
const send = Request.post("https://api.example.test/pages").pipe(
  Request.body(Body.jsonSchema(Page)),
);
// Input: { body: { n: 1, items: [{ limit: 5 }, {}] } }
// JSON body: {"n":"1","items":[{"page_size":"5"},{"page_size":"25"}]}
// Input: { body: { n: 1, items: [{ limit: "x" }] } }
// SchemaError: The schema cannot keep this field ... at ["items"][0]["limit"]
```

A field's own constructor reads the decoded side and strips the rest, such as an encoded name, so
what it made has to hold every supplied field. Where it would drop one, the field is read by its
decoder, strictly, so a union field takes its first member that keeps everything. Then it is read
field by field. A valid `{ page_size: "05" }` writes `5`. `{ page_size: "many" }` is a `SchemaError`
that names it, including under `Union([Filter, Cursor])`, where `Cursor` would read it as an empty
object. A decoder that can read the field only by stripping a supplied key is the last route, and
that key is refused even where a decoding default fills its name again. A field given under both its
names cannot keep both, so it is refused too. A value the constructor returns unchanged, as an
opaque declaration's is, lost nothing, and nothing inside it is read again. A key that a decoder or
transformation adds to the value it makes is not the caller's, so it is never counted as lost.

These checks run where a field's value is plain data throughout: lists and objects whose prototype
is `Object.prototype` or `null`, holding only own data properties, none named after an
`Object.prototype` member such as `toString` or `__proto__`, under a schema that states no field and
no wire name named after one at any depth. The root's own checks need the same of its value and of
the names its schema states. A value held behind an accessor, a class instance, including a
`Schema.Class` instance, and a schema that uses such a name read as Effect reads them. Effect 4.0.7
and 4.1.4 read those names differently, so preparation does not guess what the caller gave there.
[Active limits](#active-limits-and-recovery) lists what that leaves.

A union field read field by field takes its first member reading that keeps everything, ahead of an
earlier one that loses a field. The object's constructor then runs again over the fields' results,
strictly first, so each union field keeps the member it was read by. Loosely, it could take an
earlier member that strips the value and fill that member's default instead. Only if the strict pass
fails does it run as Effect runs it. The write can still take another member, as [Active
limits](#active-limits-and-recovery) describes.

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
actually went. The strict pass also protects visible fields beside Void as described below. A schema
with none of these choices reads as it always did. A schema's own steps can run more than once when
the strict pass refuses.

An empty struct keeps every key of the value it reads, as given and at every depth. Beside members
that state fields it is the member that keeps them all, in either order, where every alternative at
the value is a struct, a record, a list or a tuple, as [A list stays a list](#a-list-stays-a-list)
describes. An empty `Schema.Class` is a class, so beside a stated member it keeps 0.18.0's reading,
which the [active limits](#active-limits-and-recovery) give. Under `Union([A, Schema.Struct({})])`
with `A = Schema.Struct({ a: Schema.String })`, `{ a: "x", z: 1 }` sends `{"a":"x","z":1}`, and
under `Union([Schema.Struct({ b: A }), Schema.Struct({})])`, `{ b: { a: "x", z: 1 } }` keeps the
nested `z`. When both members can keep a value, member order decides, as in Effect's first fit: a
value the stated member keeps whole, such as `{ a: "x" }`, goes through it when it comes first, with
its names and constructor defaults, and through the empty struct as given when that comes first. A
class instance the empty struct keeps reaches a path renderer as the same instance, unless a stated
member names a field the instance holds as an inherited accessor: then it is a plain copy that holds
that field with the instance's own keys. An empty struct query or header binding still states no
names.

What the empty struct keeps goes to the writer as given, and each writer refuses before dispatch a
value it would leave out or replace, naming the field. No writer has a symbol key. The JSON writer
refuses `NaN`, a BigInt, a symbol or bytes with `HttpBodyError`, and a query or header writer
refuses an object or a value that is not text with `InvalidRequest`, as the [JSON
body](./modules/body.md) and [request groups](./schema-groups.md) describe. The stated member's
codec writes such values for the wire when it takes the value itself.

0.18.0 kept such keys only where every object candidate was empty, and otherwise left them out,
sometimes sending the stated member's constructor default in the caller's place. A decoded name
beside a key only the empty struct holds is now sent as given, because the empty struct takes the
whole value:

```ts
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const search = Request.get("https://api.example.test/things").pipe(
  Request.query(Schema.Union([Filter, Schema.Struct({})])),
);
// Input: { query: { tag: "a" } }; 0.18.0: ?page_size=25; now: ?tag=a
// Input: { query: { limit: 5, tag: "a" } }; 0.18.0: ?page_size=5; now: ?limit=5&tag=a
// Input: { query: { limit: 5 } }; both: ?page_size=5, but ?limit=5 with the empty struct first
```

To get `Filter`'s encoding, bind `Filter` directly; with the empty struct beside it, the first
member that keeps the whole value writes it. Leave out the keys `Filter` does not state before
preparation if they should not be sent.

Built-in `Schema.Void` ordinarily accepts an object and returns `undefined`. Beside an object or
list candidate in a visible any-of union, the strict read declines Void for an object with a defined
enumerable own field or a list with a defined own cell. The strict write declines Void for every
object or list, including when its cells decoded to `undefined`. The fallback write keeps that guard
while relaxing excess-property handling. If the structural member cannot encode a value, such as
JSON metadata containing a `Date` under `Schema.Unknown`, preparation fails with that member's
`SchemaError` unless another member can write the value without dropping a supplied field, as
[below](#a-field-no-member-can-keep-is-an-error) describes. The guard includes annotated and checked
Void and paths through unencoded any-of member unions. The read uses original member order when it
sees no defined fields or cells.

A union made up solely of Void and plain, unchecked empty structs keeps first-fit object reading. A
leading Void can take the object and a leading empty struct can keep it. Adding another kind of
member, checking an empty struct or grouping the union as a member of an enclosing guarded union
removes that exception. A defined own list cell still declines Void.

If an object member maps decoded `limit` to encoded `page_size`, either order with Void prepares
`{ page_size: "05" }` through the object member. An invalid `page_size` is a `SchemaError`. Avoid
Void in schemas that rely on a shape excluded under [Active limits](#active-limits-and-recovery).
The [0.18 migration](./release-notes/0.18.md#keep-fields-beside-void) shows the results that
changed.

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

Writing keeps the same rule. A value is written strictly first. When the member that read it cannot
write it, the relaxed write that follows can take a later member. That write notes which member
wrote each value, and a struct member reads only the names it states, so a supplied field it does
not state is lost, whatever else it writes under that name. A struct that states no field keeps
every key, and a record keeps the keys its key schema takes. Nothing is decoded from what was sent.
The relaxed write selects the members to try by kind of value and literal tags, as the installed
Effect does, before it runs any of them, so a member Effect rules out runs none of its encoders,
middleware or checks. Like Effect, it follows each tag field through its encoding before it asks
whether the tag is required. The check runs where the caller's value is plain data, as the section
above defines it, and the schema there, a union's members and tags among it, names no field after an
`Object.prototype` member; elsewhere the value is written as Effect writes it. A nested union that
fails its own check or one-of rule credits none of its members, and each place a value is written
from is checked on its own, so one object given to two fields is checked against each field's
member. When no member can both keep and write the value, the refusal is the error of the first
member that could not write it, the error that member alone gives. That holds through grouped and
suspended unions:

```ts
import { Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";

const Note = Schema.Struct({ title: Schema.String, meta: Schema.Unknown });
const Title = Schema.Struct({ title: Schema.String });
const send = Request.post("https://api.example.test/notes").pipe(
  Request.body(Body.jsonSchema(Schema.Union([Note, Title]))),
);
// Input: { body: { title: "a", meta: 1 } }; JSON body: {"title":"a","meta":1}
// Input: { body: { title: "a", meta: new Date(0) } }
// SchemaError: Expected JSON value at ["meta"]
```

### A list stays a list

Reading field by field, the last route above, copies a value into a new object. Preparation never
takes that route for a list, at any depth, so a record or struct member cannot take an index-keyed
copy in the list's place. Effect's record schemas, and struct schemas that state a field, refuse a
list, as the types do, so beside such a member a list has its list member's reading: it is kept as a
list, or the request is refused. An object stays an object, including one whose keys look like
indexes.

```ts
import { Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";

const Plain = Schema.Struct({ limit: Schema.optionalKey(Schema.String) });
const Listed = Schema.Union([
  Schema.Array(Plain),
  Schema.Record(Schema.String, Schema.Unknown),
]);
const send = Request.post("https://api.example.test/things").pipe(
  Request.body(Body.jsonSchema(Listed)),
);
// Input: { body: [{ limit: "x" }] }; JSON body: [{"limit":"x"}]
// Input: { body: { "0": { limit: 5 } } }; JSON body: {"0":{"limit":5}}
```

An item the list member refuses, as in `[{ limit: 5 }]`, is a `SchemaError` before dispatch. A list
given to a record, struct, or class alone can also refuse with `Expected object` when the fieldwise
copy was its only successful route. This holds in bodies and paths, at any depth, and when reading a
query or header group given as a list of pairs. The [0.18
migration](./release-notes/0.18.md#refuse-a-list-given-to-an-object-schema) shows how to build an
index-keyed object explicitly.

Field-loss accounting reads the same way. A record or a struct that states a field holds none of a
list's cells, and an array or tuple member holds none of an object's keys, including where different
parent members give a field those schemas. So beside the record above, `[{ page_size: "05" }]` and
`[{ limit: "x", extra: 1 }]` write `[{}]` and `[{"limit":"x"}]`, as `Schema.Array(Plain)` alone
does; 0.18.0 refused both. In the same way, `{ "0": { limit: "x", extra: 1 } }` beside an array or
tuple member is read as its object member alone reads it.

This reading, and the empty-struct rule above, apply only where what each alternative reads from an
object or a list is known from the schema alone: every alternative at the value is a struct, a
record, a list or a tuple, an empty struct and a struct whose keys `Schema.encodeKeys` renames
included. An alternative that takes no object, such as text, a number or `null`, does not change
that, nor does built-in `Schema.Void` where the Void rule below guards it, in an any-of union beside
an object or list member and not inside a suspension or a class. Field types can be anything; each
child value of such a value is judged again at its own level. Every member counts, one a tag rules
out included. `Schema.Struct({})` keeps a list as it is there, and only as an alternative of its own
does an empty struct keep the keys it reads.

Anywhere else a value keeps 0.18.0's reading, and so does every value inside it. That covers any
alternative that is a class, a declaration such as `Schema.Date`, an open schema such as
`Schema.Unknown`, `Schema.catchDecoding` or `Schema.catchEncoding` middleware, a Void the Void rule
does not guard, or a codec with any other transformation, such as a struct decoded from another
struct. Such an alternative can take the whole value, and a recovery can turn a failure anywhere
inside into a value of its own. So beside an empty `Schema.Class`, a class decoded from a tuple, a
codec decoded from `Schema.declare` or `Schema.Unknown`, or a record with a recovery, a list and its
cells read as they did on 0.18.0. Under `Union([Schema.Struct({ p: Listed }), Schema.Unknown])`,
`{ p: [{ limit: "x", extra: 1 }] }` keeps `extra`, as on 0.18.0.

Beside a guarded Void, a value also keeps 0.18.0's reading where the container rule would leave
every field the caller supplied unstated, because the Void would then take the value and send none
of them. With `Named = Schema.Struct({ a: Schema.String })`,
`Union([Named, Schema.Void, Schema.Array(Named)])` refuses `{ 0: { a: "ok" } }` before dispatch, as
0.18.0 did, rather than sending `null`. `Union([Named, Schema.Void])` alone still reads such a value
as its Void member, as the Void rule below describes.

A query or header group that encodes to an array of field pairs is read by position, including when
`Schema.Struct({})` keeps the original array. Both the list and its pairs can have a `null`
prototype or an own iterator. A callable iterator on another object supplies its pairs once. A pair
must be an array of length two with a string name. A hole at the value position reads as
`undefined`, which omits a query entry and is invalid for a header pair. A malformed entry,
including a hole in the outer list, fails with `InvalidRequest`. Declared defaults are added as
pairs before the schema reads the group again. Arrays of repeated values are also read by position.

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
the tag has already chosen, and a key only a member that cannot read the value's container states,
such as a record beside a list. A key an empty struct member holds is not unstated, as [A union
keeps what the caller gave](#a-union-keeps-what-the-caller-gave) describes. A required literal tag
can choose by its decoded or encoded name, including when a whole-object transformation changes its
name or literal. Both views must rule a member out before its fields go. A missing tag with a
constructor default leaves that view possible; its default is not run to guess a member. A key set
to `undefined` is no field at all, so `{ a, b: undefined, c }` reads as `{ a, c }`, and a member
that states `b` cannot take the value from one that states `c`. An encoded name beside its decoded
twin can be stripped on a constructor/decoded route, under a union as under a struct. A whole
encoded read instead uses the encoded name, including when an ignored alias elsewhere establishes
the added validation route. Name selection does not prove that supplied values agree; general
conflicting-alias refusal remains under #143.

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
[#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143),
[#170](https://github.com/viell-dev/slop-effect-schema-http/issues/170) and
[#243](https://github.com/viell-dev/slop-effect-schema-http/issues/243); an unsupported proof is not
a guarantee that preparation refuses safely.

- Beside `Schema.Unknown`, `Schema.Any` or `Schema.Object`, a stated member's nested value can still
  lose a key only the open member would hold. With
  `Union([Schema.Struct({ b: A }), Schema.Unknown])`, `{ b: { a: "x", z: 1 } }` sends
  `{"b":{"a":"x"}}` ([#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143)). A key
  at the open member's own value is kept. Below it every value keeps 0.18.0's reading, so an empty
  struct there keeps no more than it did, as [A list stays a list](#a-list-stays-a-list) describes.
- A record with a `Schema.catchDecoding` recovery beside a list member keeps 0.18.0's reading, in
  which the record's values hold a cell key the list member does not state. The list member then
  refuses a valid list, and the recovery's value is sent instead: under
  `Union([Schema.Array(Plain), Recovering])`, where `Recovering` recovers `{ recovered: true }`,
  `[{ limit: "x", extra: 1 }]` sends `{"recovered":true}`, where Effect reads `[{"limit":"x"}]`. A
  recovery's value is not checked against the cells it was given either: one that returns
  `{ 0: { limit: "altered" } }` sends that for `[{ limit: 5, extra: 1 }]`
  ([#243](https://github.com/viell-dev/slop-effect-schema-http/issues/243)). Leave out keys the list
  member does not state, and have a recovery return the caller's cells or fail.
- An empty `Schema.Class` keeps 0.18.0's reading beside a list member or a member that states
  fields. `Union([Bare, Schema.Array(Plain)])`, where `Bare` is an empty class, sends
  `{"0":{"limit":"x"}}` for `[{ limit: "x", extra: 1 }]`, although Effect's first fit gives the
  class every cell, and so does the same pair under two parent members
  ([#243](https://github.com/viell-dev/slop-effect-schema-http/issues/243)). `Union([A, Bare])` and
  `Union([Bare, A])` send `{"a":"x"}` for `{ a: "x", z: 1 }`
  ([#249](https://github.com/viell-dev/slop-effect-schema-http/issues/249)). `Schema.Struct({})` in
  the class's place keeps the cells and the key.
- Below an empty struct that holds a parent value, a child value with an alternative outside the
  known set is normalized as on 0.18.0, so a key no member there states is stripped before the empty
  struct takes the whole value. Under `Union([Schema.Struct({ b: Limited }), Schema.Struct({})])`,
  where `Limited` is a class stating `a`, `{ b: { a: "x", z: 1 }, top: 1 }` sends
  `{"b":{"a":"x"},"top":1}`: `top` is kept and `z` is not
  ([#249](https://github.com/viell-dev/slop-effect-schema-http/issues/249)). Where 0.18.0 erased
  such a child through a Void the Void rule does not guard, the child is now sent with those keys
  stripped: under
  `Union([Schema.Struct({ p: Schema.suspend(() => Schema.Union([A, Schema.Void])) }), Schema.Struct({})])`,
  `{ p: { z: 1 }, top: 1 }` sends `{"p":{},"top":1}`, where 0.18.0 sent `{"p":null}`. A struct in
  the class's place keeps `z`.
- The relaxed write's check sees the members a union chose for the value itself. A class or other
  declaration member is the schema's own reading, and so is a choice Effect makes again after a
  transformation or middleware on the union itself, which no caller field can be traced to:
  `Union([Coded, Title]).pipe(Schema.middlewareDecoding(...))` can still send `{"title":"a"}`. A
  union in which only one member reads keys is written as Effect writes it, so in
  `Union([Opaque, Title])`, where `Opaque` is a declaration that cannot be written as JSON, `Title`
  can still drop `meta` ([#250](https://github.com/viell-dev/slop-effect-schema-http/issues/250)).
  When the member the relaxed write takes loses a supplied field, the request is refused; a later
  member that strips only unsupplied keys is not tried.
- The relaxed write selects each union's members by kind and literal tags with a copy of Effect's
  own selection rules, which Effect keeps internal. Effect 4.0.7 and 4.1.4 differ only for a tag
  named after an `Object.prototype` member, such as `constructor`, that the value does not hold as
  its own: 4.0.7 reads the inherited value and 4.1.4 treats the tag as missing. The copy finds the
  installed version's rule once, with a test write. A member with encoding middleware or a
  suspension is tried for every input, as Effect tries it, so its own steps can run before it fails.
- Beside a field that only the relaxed write can send, such as one whose encoder hands on a key its
  struct does not state, that write chooses each union's member as Effect does. That can be an
  earlier member than the one the field's reading or the strict write took, and where it drops a
  field the request is refused. Under `Union([Filter, Word])`, where `Word` reads `page_size` as
  text, `{ page_size: "many" }` is sent as text where nothing else relaxes the write, and refused
  beside such a field ([#250](https://github.com/viell-dev/slop-effect-schema-http/issues/250)).
- Outside plain data, as [a field keeps what its own reading
  lost](#a-field-keeps-what-its-own-reading-lost) defines it, a value reads and writes as Effect
  reads and writes it, so both checks above are off there
  ([#241](https://github.com/viell-dev/slop-effect-schema-http/issues/241),
  [#250](https://github.com/viell-dev/slop-effect-schema-http/issues/250)). Under the `Page`
  example, `{ n: 1, items: [{ limit: "x" }] }` held behind a getter, or given as a class instance,
  still sends `"page_size":"25"`; `Union([Note, Title])` still drops `meta` from a class instance. A
  field given under both names, where the wire name is one every object has such as `toString`,
  sends one of them, and a field given under the wire name `__proto__` is dropped.
- The relaxed write's check follows a struct's decoded fields. A struct renamed with
  `Schema.encodeKeys` writes each field again on its encoded side, so a union there can take another
  member, and a field that member drops is not seen. Where `Dropping` is
  `Union([Struct({ d }).pipe(encodeKeys({ d: "w_d" })), Struct({ e: Unknown }), Struct({ c: optionalKey(String) })])`,
  `Struct({ d: Dropping }).pipe(Schema.encodeKeys({ d: "w_d" }))` sends `{ d: { e: new Date(0) } }`
  as `{"w_d":{}}`, which the same struct without the rename refuses
  ([#250](https://github.com/viell-dev/slop-effect-schema-http/issues/250)).
- Reading field by field, a field's constructor can run, fill its defaults and then give way to the
  field's decoder or a field-by-field reading, which constructs again. A default can therefore run
  more than once, and a decoder can run strictly and then loosely when the strict read named an
  unstated key. A union field's later members are read after an earlier member's reading that lost a
  field, and the object's constructor can run strictly and then as Effect runs it.
- Conflicting aliases can lose one supplied value. A decoded/constructor route prefers the decoded
  name, while whole encoded reading uses the encoded name. An encoded-only sibling can change that
  choice for the whole value. The [0.14 migration](./release-notes/0.14.md#account-for-both-names)
  includes a typed nonliteral example. Supply only one side or validate a decoded mapping.
- Conflicting normalized declarations, including numeric 1 and string "1" for the same JavaScript
  key, cannot establish an unchanged nested path. The ambiguity guard can therefore leave a supplied
  invalid alias replaced by a generated default.
- Unsupported object alternatives and construction phases can still lose aliases. Optional,
  nullable/nullish, array-shaped and the listed primitive alternatives, including unions and
  plain-transformation codecs of them, extend the bounded proof; guarded Void can qualify there too.
  Other Void, open/opaque/suspended members and middleware-encoded alternatives do not. For an array
  cell, the proof stops at a union with `Schema.Struct({})`, a second array-reading member or an
  encoded array reader; there the schema's own selection decides, and a generated default can still
  replace the alias. A successful actual member-fieldwise reading is not reclassified as initial
  whole construction.
- Void protection applies to built-in Void beside a visible object or list candidate in an any-of
  union, including through unencoded any-of member unions. Standalone Void, a union whose other
  members give it no visible object or list candidate, unions inside `Schema.Class` fields, opaque
  declarations or suspensions, encoded member unions, other union modes such as `oneOf`, and custom
  discarding transformations can still discard values. Class alternatives alone supply no visible
  candidate. Avoid Void in input schemas that rely on those shapes.
- A list supplied by JavaScript or a cast to a union of a struct and Void, whose cells are all
  non-enumerable, can still be discarded and read as `undefined`. Such a cell declines Void on the
  strict read, but a struct cannot read a list and the field-loss check does not see the cell.
  Beside an array member, such a cell is read, so an invalid alias in it refuses.
- One member union value reused where its Void is guarded and where it is not gets the grouped proof
  at neither use. An example is the same union of `Schema.Void` and a text member decoded from an
  object, placed under an any-of union and under a `oneOf` union. An invalid alias that only that
  proof would catch then keeps the constructor default, as on 0.17. A union of primitive members and
  Void keeps the proof at its guarded use. Build a separate member union for each use.
- A proxy list whose index read answers `undefined` for a cell its descriptor holds can be taken by
  Void beside an array member and read as `undefined`.
- A populated object constructor default can select the object member beside Void. A default of
  `{ a: 1 }` for a field `g` using `Union([Void, Struct({ a: optionalKey(Number) })])` can write
  `{"g":{"a":1}}` for an omitted `g`. With object-first order and only an undefined-valued input
  key, `Struct({ inner: UndefinedOr(String) })` still needs its key, so the union can write `null`.
  With `Struct({ a: optionalKey(Number) })`, the same omission can write `{}`.
- A mixed-side value can refuse with either Void order. For example, with
  `Struct({ filter: Union([Void, Filter]), sortBy: String })` and
  `encodeKeys({ sortBy: "sort_by" })`, where `Filter` encodes `limit` as `page_size`,
  `{ filter: { limit: 5 }, sort_by: "a" }` fails at `filter`; with Void last it fails at
  `filter.limit`. An object giving both names beside Void, such as `{ limit: 5, page_size: "5" }`,
  refuses in either order too. Use all-decoded or all-encoded names, one per field, for that input.
- JavaScript, casts and `Schema.Any` can bypass the TypeScript requirement for a query or header
  schema to encode a group of fields. Preparation reports lost input fields first. A non-object
  group, a malformed field pair or an invalid query or header value fails with `InvalidRequest`
  before dispatch. An unsupported query value or a defined enumerable symbol field names its field.
  Iterable outputs supply ordered pairs. `Transport.entries` and `UrlEncoding.queryEntries` throw
  `TypeError` for malformed pairs and invalid fields.
- A successful open schema can hand a value to a writer that cannot represent it. Every body, query
  and header writer checks its actual output values and refuses with the field path. JSON applies
  `toJSON` first, omits undefined object fields, and checks every array position below its length.
  These checks apply when using either `Body.jsonSchema` or a composed JSON encoder. A
  string-indexed record that loses a supplied symbol, on either side of the schema, including one
  among a class's fields, a link whose encoded end is such a record, and the canonical JSON codec of
  `Schema.ObjectKeyword`, which copies only the string fields of an object and the positions of an
  array, report a `SchemaError`. Not covered:
  [#261](https://github.com/viell-dev/slop-effect-schema-http/issues/261), a built-in that an open
  schema rebuilds before the writer, such as a `Date` read by `Schema.ObjectKeyword`. Also not
  covered, as on 0.18.0: a symbol inside a declaration's type parameter, such as
  `Option(Record(…))`, `ReadonlyMap`, `Redacted` or `OptionFromNullOr`. A symbol key the schema
  declares is written as it chooses, and one at a class's root is stripped. See the [Body
  guide](./modules/body.md#text-json-and-finite-body-limits) for writer rules. An opaque
  transformation can still choose its own encoded representation.
- Once an encoded-only alias enables whole decoding of a list, a decoded-only item beside it can
  lose its decoded name and refuse. This applies to every covered container, array-shaped unions
  included.
- Inherited cells, accessors, subclasses, custom prototypes/iterators and changing paths do not
  establish the new array proof. Sparse own cells and exact native own iterator data do qualify. The
  [0.16](./release-notes/0.16.md) and [0.18](./release-notes/0.18.md) migrations cover newly refused
  aliases, whole-reading changes and executable validated decoded mappings; the [0.15
  article](./release-notes/0.15.md) retains the earlier substitutions as historical evidence.
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
