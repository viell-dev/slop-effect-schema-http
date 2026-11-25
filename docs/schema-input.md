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

[Limits](#active-limits-and-recovery) lists where the rule stops. Each is a decision, recorded with
its reason, not a defect waiting for a fix.

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
alternative. The [0.15 migration](./release-notes/0.15.md) states the normalization changes.

### The decoded side is what the schema's constructor takes

The library builds the schema's value before encoding it, so a plain object works for a
`Schema.Class`, and a field with a constructor default can be left out. These functions need
`Schema.Top`, the bound that has a constructor. Building and then encoding validates twice, which is
part of preparation; neither step is skipped.

## A default never takes a supplied field's place {#constructor-default-validation}

Preparation tries the decoded side first, with the schema's constructor, then the decoder as a
whole, then, for an object that is not a list, the decoder field by field. If all fail, it reports
the decoded side's error, a `SchemaError` before dispatch. [A list stays a
list](#a-list-stays-a-list) describes that rule and its limits.

A route can succeed without reading everything. The constructor strips a name only the encoded side
states, and the decoder strips one only the decoded side states. A constructor default or a decoding
default can then fill the field that was not read. So each route accounts for what it was given:

- **The constructor** has to hold every supplied field in what it made.
- **The decoder** reads strictly, so it consumes every name or fails. A name that only a loose
  decode could strip is lost, even where a decoding default fills it again.
- **Field by field**, each field's own reading accounts for its slice of the value. The object's
  constructor then runs again over the results, so it also has to hold what it took as given.

A route that keeps everything is used. A constructor that lost a field runs again strictly, which
takes a union's first member that keeps everything, and otherwise gives way to a route that loses
fewer of the fields it lost. What is still lost is a `SchemaError` naming the field, unless another
schema in the group takes it and this one sends nothing in its place: neither under the field's
name, nor under a name where it replaces what the other wrote.

```ts
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const search = Request.get("https://api.example.test/things").pipe(
  Request.query(Filter),
);
// Input: { query: {} }; URL query: ?page_size=25
// Input: { query: { limit: 5 } } or { query: { page_size: "05" } }; URL query: ?page_size=5
// Input: { query: { page_size: "many" } }
// SchemaError: The schema cannot keep this field ... at ["page_size"]

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

This holds at any depth, in struct, class, list, tuple, record and union fields, and whatever stands
beside them: another union member, a class, a suspended schema, or a value the library cannot see
into, as an `Option` is. It has these consequences:

- **A field given under both its names** refuses, even where the two agree. Codecs give no general
  way to tell whether two sides' values agree, so this restricts the input rather than finding a
  contradiction. Give each field one name.
- **A decoded name below a name the parent writes**, as `{ w: { limit: 5 } }` where `f: Filter` is
  renamed to `w`, refuses too. Below a renamed field, use the same side as its own name.
- **A list, a tuple and a record are read as one value**, not item by item, so items on different
  sides refuse: `[{ limit: 5 }, { page_size: "6" }]` names `[1]["page_size"]`. The `Input` type
  allows that mix. Give every item on one side.
- **A field both sides can hold**, as under a schema from text to text, means what the route that
  read it takes it for. Built by a constructor or read field by field it is decoded, so it is
  encoded again. Decoded as part of the whole it is already encoded.
- **A key a decoder or transformation adds** to the value it makes is not the caller's, so it is
  never counted as lost. A value that middleware or a transformation puts in the caller's place, as
  `Schema.catchDecoding` does, is the schema's own reading.
- **Defaults, checks, decoders and services can run more than once**, because a later route can be
  tried after one that lost a field. Routes that read one field read it once.
- **A refusal names the innermost fields.** Where one check finds a whole field lost and another
  finds a field inside it lost, only the inner one is named. Where a list is lost because the
  decoder failed at one item, only that item is named.

### Where it applies

These checks run where a value is plain data: a list whose prototype is `Array.prototype` or `null`,
or an object whose prototype is `Object.prototype` or `null`, holding only own data properties, none
named after an `Object.prototype` member such as `toString` or `__proto__`, under a schema that
states no field and no wire name named after one there. They are judged place by place: a value that
is not plain data turns nothing off around it, and nothing is accounted for inside it. A value held
behind an accessor, a class instance, including a `Schema.Class` instance, and a schema that uses
such a name read as Effect reads them. Effect 4.0.7 and 4.1.4 read those names differently, so
preparation does not guess what the caller gave there. [Active limits](#active-limits-and-recovery)
lists what that leaves.

Own data properties include symbol keys, keys that are not enumerable, a list's own named properties
and the fields of a frozen or sealed object. A proxy over plain data cannot be told from its target,
so it is plain data too, and its traps run whenever preparation reads it.

Keep the value unchanged until preparation ends, including while a schema step runs asynchronously.
Preparation reads it as it runs and does not detect a change, so what it accounts for and what it
writes could then differ.

A value that cannot be written strictly, as where a class instance holds a member of its own, is
written loosely. Each union in it, in a class's fields too, is still written by its first member
that holds the whole value: strictly, or loosely where that member states every key the value holds,
so a class instance's own fields do not push a value out of it. Only where no member can is the
union written as Effect writes it, and a field that drops is refused. Where that write fails too,
preparation writes what the fields' own readings give and refuses what they lose.

## Preservation and selection

### A value that fits the decoded side is read as decoded

When both sides have the same type, as under a schema from `string` to `string` such as
`Schema.StringFromBase64`, an already encoded value cannot be told apart from a decoded one, so it
is encoded again, with no error. Under a group with other fields, the order above decides: a group
that only fits on the encoded side goes through the decoder as a whole, so a shared-type field in it
is read as encoded.

### Each route validates what it consumes

An encoded field read through the decoder is validated; a value fitting neither reading fails during
preparation, and [no default stands in for it](#constructor-default-validation).

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

Read field by field, each field is read on its own, and its reading accounts for what the caller
gave it, as [above](#constructor-default-validation). A union field takes its first member reading
that keeps everything, ahead of an earlier one that loses a field. The object's constructor then
runs again over the fields' results, strictly first, so each union field keeps the member it was
read by. Loosely, it could take an earlier member that strips the value and fill that member's
default instead. Only if the strict pass fails does it run as Effect runs it. The strict pass runs
wherever the object itself is plain data, so it can also keep a union member beside a field whose
own value is not.

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

An empty struct keeps every key of the value it reads, as given and at every depth. So do an open
schema, which is `Schema.Unknown`, `Schema.Any` or `Schema.Object` without a check, and an empty
`Schema.Class` for a value that is not a list. Beside members that state fields, such a member keeps
them all, in either order. A key only it holds is not unstated, at any depth below the members.
Under `Union([A, Schema.Struct({})])` with `A = Schema.Struct({ a: Schema.String })`,
`{ a: "x", z: 1 }` sends `{"a":"x","z":1}`, and under
`Union([Schema.Struct({ b: A }), Schema.Struct({})])`, `{ b: { a: "x", z: 1 } }` keeps the nested
`z`, and so it does with `Schema.Unknown` in the empty struct's place. When both members can keep a
value, member order decides, as in Effect's first fit: a value the stated member keeps whole, such
as `{ a: "x" }`, goes through it when it comes first, with its names and constructor defaults, and
through the empty struct as given when that comes first. A class instance the empty struct keeps
reaches a path renderer as the same instance, unless a stated member names a field the instance
holds as an inherited accessor: then it is a plain copy that holds that field with the instance's
own keys. An instance with a key set to `undefined` whose other fields the members beside the empty
struct all state reads as a plain object without that key, so the key neither pushes it out of those
members nor leaves it to a Void. An empty struct query or header binding still states no names.

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

Built-in `Schema.Void` ordinarily accepts any value and returns `undefined`. It never takes an
object with a defined enumerable own field, or a list with a defined own cell:

- In a union of any mode, also grouped or suspended, a member that keeps the value reads it. A union
  of Void and an empty struct keeps the object in either order.
- Anywhere else, as a Void of its own, in a field or in a union of scalars, the request is refused.

This holds through renames, transformations and the fields of a `Schema.Class`, wherever the library
can see the Void. Inside an `Option` or another opaque declaration it is the schema's own.

An object or list that holds nothing, a key no member states, and a value that is neither read as
Void reads them. If the structural member cannot encode a value, such as JSON metadata containing a
`Date` under `Schema.Unknown`, preparation fails with that member's `SchemaError` unless another
member can write the value without dropping a supplied field, as
[below](#a-field-no-member-can-keep-is-an-error) describes.

If an object member maps decoded `limit` to encoded `page_size`, either order with Void prepares
`{ page_size: "05" }` through the object member. An invalid `page_size` is a `SchemaError`. The
[0.18 migration](./release-notes/0.18.md#keep-fields-beside-void) shows the results that changed.

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

This reading applies where what each alternative reads from an object or a list is known from the
schema alone: every alternative at the value is a struct, a record, a list, a tuple, or a
`Schema.Class` that states a field. So is a struct decoded through one plain transformation from an
unchecked struct of the same shape, as `Schema.encodeKeys` builds: as many fields in the same order,
each with the same optionality and the encoded form of the same type, whatever the transformation
does with them. An alternative that takes no object, such as text, a number, `null` or built-in
`Schema.Void`, does not change that. Field types can be anything; each child value of such a value
is judged again at its own level. Every member counts, one a tag rules out included.

Anywhere else a value keeps 0.18.0's reading, and so does every value inside it. That covers an
alternative that is an empty class, a declaration such as `Schema.Date`, an open schema such as
`Schema.Unknown`, `Schema.catchDecoding` or `Schema.catchEncoding` middleware, or a codec with any
other transformation, such as a struct decoded from a struct of another shape. Such an alternative
can take the whole value, and a recovery can turn a failure anywhere inside into a value of its own.
There a list beside a record refuses a cell key the list member does not state.

Beside a Void, a value also keeps 0.18.0's reading where the container rule would leave every field
the caller supplied unstated. With `Named = Schema.Struct({ a: Schema.String })`,
`Union([Named, Schema.Void, Schema.Array(Named)])` refuses `{ 0: { a: "ok" } }` before dispatch, as
0.18.0 did, rather than sending `null`.

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
that states `b` cannot take the value from one that states `c`. A field given under both its names
is refused, as [above](#constructor-default-validation) gives.

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

A strict whole read can fail inside an opaque field, such as an `Option` whose contents hold a key
its schema does not state, and Effect's own reading can then leave a visible union with its narrower
member. The [later routes](#constructor-default-validation) apply there as anywhere else: they keep
the visible fields beside the opaque value, or the request is refused naming them. Opaque values are
not decoded and re-encoded to prepare a different input. The [0.6.1
example](./release-notes/0.6.md#since-0-6-1-keep-visible-fields-beside-an-opaque-value) shows the
common case.

## Limits and recovery {#active-limits-and-recovery}

A supplied field is kept or refused wherever the library can see both the caller's value and what
the schema does with it. These are the places where it cannot, and what happens there.

**The schema's own reading**, where a field can go with no error:

- Outside plain data, as [where it applies](#where-it-applies) defines it, a value reads and writes
  as Effect reads and writes it. Under the `Page` example, `{ n: 1, items: [{ limit: "x" }] }` held
  behind a getter, or given as a class instance, sends `"page_size":"25"`, and
  `Union([Note, Title])` drops `meta` from a class instance.
- A name every object has, such as `toString` or `__proto__`, is read as Effect reads it. A field
  given under both its names sends one of them where its wire name is such a name, and a field given
  under the wire name `__proto__` is dropped.
- An opaque value, a declaration, a custom transformation and middleware decide for themselves. A
  recovery's value is not checked against what it was given: a `Schema.catchDecoding` record beside
  a list member can take a list whose cells hold a key the list member does not state, and what it
  recovers is sent. In `Union([Opaque, Title])`, where `Opaque` is a declaration that cannot be
  written as JSON, `Title` can drop `meta`.
- A union that chooses again on a transformed copy, behind a transformation or middleware on the
  union itself or on the encoded side of a renamed struct, is the schema's own choice, because no
  caller field can be traced to the copy. `Union([Coded, Title]).pipe(Schema.middlewareDecoding(…))`
  can send `{"title":"a"}`. Where `Dropping` is
  `Union([Struct({ d }).pipe(encodeKeys({ d: "w_d" })), Struct({ e: Unknown }), Struct({ c: optionalKey(String) })])`,
  `Struct({ d: Dropping }).pipe(Schema.encodeKeys({ d: "w_d" }))` sends `{ d: { e: new Date(0) } }`
  as `{"w_d":{}}`, which the same struct without the rename refuses.
- An empty `Schema.Class` first in a union takes a list as an object keyed by its indexes, as Effect
  does, after the keys the list member does not state are left out.
- A response reads as Effect reads it: its union takes the first member that fits. Its extra fields
  are the server's, not a caller's input.

**A refusal another reading might have avoided.** These never lose a field:

- Inside a value that keeps 0.18.0's reading, as [A list stays a list](#a-list-stays-a-list) gives,
  a list beside a record refuses a cell key the list member does not state, and an index-keyed
  object beside a list member refuses the key the list states. Leave out keys the list member does
  not state.
- A mixed-side value can refuse beside Void in either order. With
  `Struct({ filter: Union([Void, Filter]), sortBy: String })` and
  `encodeKeys({ sortBy: "sort_by" })`, where `Filter` encodes `limit` as `page_size`,
  `{ filter: { limit: 5 }, sort_by: "a" }` refuses. Use all-decoded or all-encoded names, one per
  field.
- A class instance beside a struct member that would strip it refuses rather than being read as the
  class.
- Some complete encoded filter fields beside a cursor held by a separate binding still refuse in
  either binding order. Bounded [stacked-union
  recovery](./schema-groups.md#declarations-and-defaults) does not perform general backtracking;
  bind the intended member directly.

**Other consequences:**

- The relaxed write selects each union's members by kind and literal tags with a copy of Effect's
  own selection rules, which Effect keeps internal. Effect 4.0.7 and 4.1.4 differ only for a tag
  named after an `Object.prototype` member, such as `constructor`, that the value does not hold as
  its own: 4.0.7 reads the inherited value and 4.1.4 treats the tag as missing. The copy finds the
  installed version's rule once, with a test write. A member with encoding middleware or a
  suspension is tried for every input, as Effect tries it, so its own steps can run before it fails.
- A proxy list whose index read answers `undefined` for a cell its descriptor holds can be taken by
  Void beside an array member and read as `undefined`.
- A populated object constructor default can select the object member beside Void. A default of
  `{ a: 1 }` for a field `g` using `Union([Void, Struct({ a: optionalKey(Number) })])` can write
  `{"g":{"a":1}}` for an omitted `g`. With object-first order and only an undefined-valued input
  key, `Struct({ inner: UndefinedOr(String) })` still needs its key, so the union can write `null`.
  With `Struct({ a: optionalKey(Number) })`, the same omission can write `{}`.
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
  array, report a `SchemaError`. So does such a record or codec that rebuilds a built-in, such as a
  `Map` or a `Date`, from its own fields. Not covered, as on 0.18.0: a symbol inside a declaration's
  type parameter, such as `Option(Record(…))`, `ReadonlyMap`, `Redacted` or `OptionFromNullOr`. A
  symbol key the schema declares is written as it chooses, and one at a class's root is stripped.
  See the [Body guide](./modules/body.md#text-json-and-finite-body-limits) for writer rules. An
  opaque transformation can still choose its own encoded representation.
- Opaque contents use their schema's own reading. A `ReadonlyMap` containing
  `{ term: "x", page_size: "05" }` can lose the alias through construction. Use decoded contents
  such as `{ term: "x", limit: "05" }` for a predictable decoded route.
- Effect can refuse omitted prototype-named fields such as `constructor` or an encode-only
  `toString` default. The [dependency
  overview](https://github.com/viell-dev/slop-effect-schema-http/issues/41) records the schemas and
  controls. Preserve the schema error rather than bypassing validation.

A safe explicit route validates the external representation with the application's chosen schema,
maps it to decoded names, then supplies that decoded value through `Request.mapInput` or the
operation input. The migration examples execute those steps and keep failure cases checked.
