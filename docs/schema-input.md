# Schema-backed input

Use this reference when a path, query, header or body accepts a schema. For the ordinary binding
syntax, start with [Request](./modules/request.md#bind-application-input) or
[Body](./modules/body.md). [Schema-backed groups](./schema-groups.md) covers fixed defaults and
stacked query/header bindings. Use the rules below to choose an input form and check its
preservation limits.

## Choose an input form

| You have                                         | What to supply                              | Important limit                                                                |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Application values                               | The schema's constructor input              | A plain object can construct a class; constructor defaults can fill omissions  |
| A complete wire-shaped value                     | The schema's encoded input                  | Constructor priority still applies; decoding/re-encoding can change spelling   |
| Fields using different sides                     | Decoded names, each value on either side    | A wire name makes the whole object encoded; the items of a list share one side |
| Conflicting names or an unsupported default path | Validate and map to one decoded shape first | A field given under both its names refuses, even where the two agree           |

For example, a finite-number query can accept a number or its encoded text:

<<< ../examples/modules/request.ts#imports

<<< ../examples/modules/request.ts#two-sides

## What will be sent

These schemas show the common cases:

<<< ../examples/schema-input.ts#what-is-sent

Each row gives a value, the schema it meets, and what the request carries or which error prepares
instead. A `SchemaError`, `HttpBodyError` or `Request.InvalidRequest` fails before dispatch.
[Limits](./limits.md#read-a-refusal-message) explains each message and what to change.

| The caller gives                                                    | Under                                      | Result                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `{ limit: 5, count: "3" }`: decoded names, values on either side    | `Page`                                     | `{"page_size":"5","count":"3"}`                                                                   |
| `{ page_size: "5", count: 3 }`: a wire name beside a decoded value  | `Page`                                     | `Missing key at ["limit"]`; the whole object is read as encoded, where `3` is not text            |
| `{ limit: 5, page_size: "5", count: 3 }`: one field under two names | `Page`                                     | `This field is given under both "limit" and "page_size"; …` at `["page_size"]`, though they agree |
| `{ page_size: "many", count: "3" }`: an invalid wire-named value    | `Page`, whose fields are required          | `Missing key at ["limit"]`, the decoded name                                                      |
|                                                                     | The same field made `optionalKey`          | `The schema cannot keep this field … at ["page_size"]`                                            |
| `[{ limit: 5 }, { page_size: "6" }]`: list items on different sides | A list of `Page` with `optionalKey` fields | `The items of this field's list or record use different sides; …` at `[1]["page_size"]`           |
| `{ ids: [5, "6"] }`: scalar list items on different sides           | `Ids`                                      | `Expected number at ["ids"][1]`; `["5", "6"]` and `[5, 6]` both work                              |
| `{ _tag: "Comment", text: "x", due: "d" }`: another variant's field | `Union([Comment, Reschedule])`             | `{"_tag":"Comment","text":"x"}`, with no error                                                    |
| `{ title: "a", extra: 1 }`: a key the schema does not state         | `Struct({ title: String })`                | `{"title":"a"}`, with no error                                                                    |
| `{ note: undefined }`                                               | `Schema.optional(String)`                  | JSON `{"note":null}`; a query or header leaves the field out                                      |
|                                                                     | `Schema.optionalKey(String)`               | `Expected string at ["note"]`                                                                     |
|                                                                     | `Schema.UndefinedOr(String)`               | JSON `{"note":null}`                                                                              |
|                                                                     | `Schema.Any`, or `Body.json`               | `{}`                                                                                              |
| `{ note: NaN }`                                                     | `Schema.Number`                            | JSON `{"note":"NaN"}`; a query `?note=NaN`                                                        |
|                                                                     | `Schema.Finite`                            | `Expected a finite number at ["note"]`                                                            |
|                                                                     | `Schema.Any`, or `Body.json`               | `HttpBodyError`: `JSON body at $["note"] must be a finite number`                                 |
| `{ note: new Map([["a", 1]]) }`                                     | `Schema.Any`, or `Body.json`               | `HttpBodyError`: `JSON body at $["note"] cannot encode Map`                                       |
|                                                                     | `Schema.Record(String, Unknown)`           | `The schema cannot keep this Map as a record at ["note"]`                                         |
|                                                                     | `Schema.Unknown`                           | `Expected JSON value at ["note"]`                                                                 |
| `{ note: new Point() }`, a class instance with a field `x`          | `Schema.Any`, or a string-keyed record     | `{"note":{"x":1}}`                                                                                |
|                                                                     | `Schema.Unknown`                           | `Expected JSON value at ["note"]`                                                                 |
| `{ note: { x: 1 } }` in a query                                     | `Schema.Any`                               | `InvalidRequest`: `The query field "note" must encode a scalar value or a list of scalar values`  |
| `{ "x-count": 5 }` in headers                                       | `Schema.Any`                               | `InvalidRequest`: `The header field "x-count" must have a string value`                           |
| `{ ack: undefined }`, `null`, `{}` or `[]`                          | `Struct({ ack: Schema.Void })`             | `{"ack":null}`                                                                                    |
| `{ ack: 5 }`, a `Date`, a `Map` or `{ a: 1 }`                       | `Struct({ ack: Schema.Void })`             | `Expected void at ["ack"]`                                                                        |
| `{ b: 1 }`, whose only key no member states                         | `Union([Void, Struct({ a: String })])`     | `null`: the unstated key is left out, and the empty object is Void's                              |

TypeScript catches some of these first. The `Request.Input` type refuses a wire name beside a
decoded value and a scalar list on two sides. An object literal written in place also fails the
excess-property check for a key the schema does not state, but a value passed in a variable can
compile, as `change` does. The type allows both names of one field and list items on different
sides, and the request then refuses them.

[A key no member states is left out](#a-key-no-member-states-is-stripped-as-a-struct-strips-it), and
the [Body guide](./modules/body.md#optional-fields-and-numbers) explains optional fields and
numbers.

## Reading either schema side

A schema's decoded side is what an application works with, and its encoded side is what goes on the
wire. In Effect, outgoing data goes through `encode` and incoming data through `decode`. The two
directions are not always inverses. A decoder can accept more than the encoder writes, so
`decode(encode(value))` need not equal `value`, and `encode(decode(text))` need not equal `text`. A
schema may accept `t1530` and `15:30` and always write `15:30:00`.

A schema-backed input takes either side, and the request always carries what the schema writes. That
applies to headers, query, path and bodies, and it is the same route a raw default takes.

A value takes its names from one side. Under the decoded names, each field's value can be on either
side, so `{ limit: 5, count: "3" }` works under `Page`, and a nested object can be given on either
side of its own. Once a renamed field appears under its wire name, the whole object is read as the
encoded side, and every field, with everything inside it, must then be encoded. The items of a list,
a tuple or a record share one side too, whether they are objects or scalars: under
`Schema.Array(NumberFromString)`, `[5, "6"]` refuses at `[1]`, though `[5, 6]` and `["5", "6"]` both
work.

```text
decoded value ----------------------> encode --> wire
encoded value --> decode --> decoded -> encode --> wire
```

**What the library promises.** For a value it can see, a field the caller gave is kept, or the
request is refused. It can see plain objects, lists, tuples, classes and unions of those, at any
depth. Preparation can check a valid plain `Some` payload where [the codec and surrounding
schema](#an-opaque-value-is-the-schema-s-own-reading) expose its fields. Inside an opaque value,
such as text that holds JSON, a `Map` or a `Schema.Option` payload, the schema's own reading
applies. To choose a union member for certain, bind that member directly.

[Limits](#active-limits-and-recovery) describes where the rule stops and links the relevant issues.

### Array normalization preserves positions

When preparation rebuilds a list to leave out its items' unstated fields, the list keeps its
positions, length and holes, and an unchanged list stays the same value. The [design
contract](./design.md#a-schema-has-two-sides) gives the precise rules.

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
// SchemaError: Expected number at ["items"][0]["limit"]
```

This holds at any depth, in struct, class, list, tuple, record and union fields, and whatever stands
beside them: another union member, a class, a suspended schema, or a value the library cannot see
into, as an `Option` is. It has these consequences:

- **A field given under both its names** refuses, even where the two agree. Codecs give no general
  way to tell whether two sides' values agree, so this restricts the input rather than finding a
  contradiction. The refusal names the wire name, as `{ limit: 5, page_size: "5" }` names
  `["page_size"]`, and says the field is given under both names. Give each field one name.
- **A decoded name below a name the parent writes**, as `{ w: { limit: 5 } }` where `f: Filter` is
  renamed to `w`, refuses too. Below a renamed field, use the same side as its own name.
- **A list, a tuple and a record are read as one value**, not item by item, so items on different
  sides refuse: `[{ limit: 5 }, { page_size: "6" }]` names `[1]["page_size"]` and says the items use
  different sides. The `Input` type allows that mix. An item that would be valid alone is refused
  too when the others put the list on the other side. The same holds for scalar items: under
  `Schema.Array(Schema.NumberFromString)`, `[5, "6"]` fails with `Expected number` at `[1]`. Give
  every item on one side.
- **A field both sides can hold**, as under a schema from text to text, means what the route that
  read it takes it for. Built by a constructor or read field by field it is decoded, so it is
  encoded again. Decoded as part of the whole it is already encoded.
- **A key a decoder or transformation adds** to the value it makes is not the caller's, so it is
  never counted as lost. A value that middleware or a transformation puts in the caller's place, as
  `Schema.catchDecoding` does, is the schema's own reading.
- **Defaults, checks, decoders and services can run more than once**, because a later route can be
  tried after one that lost a field. Routes that read one field read it once.
- **A refusal names every field it cannot keep, at the innermost level.** Where one check finds a
  whole field lost and another finds a field inside it lost, only the inner one is named. Each item
  that cannot be kept is named on its own: under `Schema.Array(Filter)`,
  `[{ limit: 1, page_size: "02" }, { page_size: "25" }]` refuses at `[0]["page_size"]` and at
  `[1]["page_size"]`, and a record names each entry the same way. A schema's own error, such as
  `Expected number`, is Effect's, which reports the first failure it meets. Where the decoded side
  refuses a value under its decoded name, that side's own error names the field. A value under its
  wire name that the encoded side refuses keeps the decoded side's message, except where the
  request's own reading strips a key the schema does not state and reports the value, or where a
  field beside it under its decoded name cannot be read either and gives its own error, for its
  decoded side, where the renamed struct is the value or a struct's field. The other fields it
  cannot keep are named too, with the generic message where nothing more is known, even where
  correcting that value would keep them: the other side's reading of the whole value loses them
  whether or not they are valid. Only a wire-named field that the reading read under its decoded
  name is left out. A refusal stores no value the caller gave and adds none to its messages, but a
  message the schema's author wrote, which can quote the value, reads as written.
  [Limits](./limits.md#read-a-refusal-message) lists each message.

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

A strict read takes a class instance by its class, but a loose read takes the first member that
fits, and a struct fits any object. Where the loose read's struct would strip the instance, the
write takes the strict read instead, if what it writes keeps every field a member states. With
`class Counted extends Schema.Class<Counted>("Counted")({ a: Schema.String }) { readonly reads = 1 }`
and a struct `Filter` that states only `limit`, `Union([Filter, Counted])` sends a `Counted`
instance as `{"a":"item"}` in either order. `reads`, which no member states, is left out. A field
that `Schema.encodeKeys` renames, on the class or on a struct inside the instance, is kept under the
name it is written as, so `Union([Filter, Counted.pipe(Schema.encodeKeys({ a: "A" }))])` sends
`{"A":"item"}`. That name shows the field was written only where nothing else there can write it, as
the [active limits](#active-limits-and-recovery) give.

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
the names of two renamed fields, is a `SchemaError`. Which field it names depends on the fields:

- With optional fields, the refusal names `B`:
  `The schema cannot keep this field with the rest of the value at ["B"]`.
- With required fields, it is `Missing key at ["b"]`, the decoded name the caller did not use. The
  value fits neither side, so the decoded side's error is reported, and on that side `b` is missing.
  The same goes for a wire-named value the encoded side refuses, such as `{ page_size: "many" }`
  under a required `limit`, which reports `Missing key at ["limit"]`.

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

Under a union whose members state different fields, the member that keeps every field the caller
gave is used, even where an earlier member also fits:

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
actually went. The strict pass also protects visible fields beside Void, as [Void takes only an
empty value](#void-takes-only-an-empty-value) describes. A schema with no choice between objects is
not read strictly. A schema's own steps can run more than once when the strict pass refuses.

### An empty struct or open schema keeps every key

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

A decoded name beside a key only the empty struct holds is sent as given, because the empty struct
takes the whole value, and the stated member's constructor default does not stand in:

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
// Input: { query: { tag: "a" } }; URL query: ?tag=a
// Input: { query: { limit: 5, tag: "a" } }; URL query: ?limit=5&tag=a
// Input: { query: { limit: 5 } }; URL query: ?page_size=5, but ?limit=5 with the empty struct first
```

To get `Filter`'s encoding, bind `Filter` directly; with the empty struct beside it, the first
member that keeps the whole value writes it. Leave out the keys `Filter` does not state before
preparation if they should not be sent.

What the empty struct keeps goes to the writer as given, and each writer refuses before dispatch a
value it would leave out or replace, naming the field. No writer has a symbol key. The [JSON
writer](./modules/body.md#text-json-and-finite-body-limits) refuses `NaN`, a bigint, a symbol or
bytes with `HttpBodyError`. With `InvalidRequest`, a query writer refuses an object other than a
`Date`, a function, a symbol or a nested list, and a header writer refuses a value that is not text
or a list of text, such as a number. The stated member's codec writes such values for the wire when
it takes the value itself.

### A fieldless value must match exactly one member under oneOf

With `mode: "oneOf"`, if a read finds that a fieldless plain object or list matches multiple
members, request preparation fails with `Expected exactly one member to match`. Unstated and
undefined-valued keys are left out when deciding what the value holds. Non-enumerable object fields
do not count unless normalization brings them out as keys. For example, two structs with only
optional fields can both read `{}`, even if constructing one would fill a default. Either member
order produces the same ambiguity. An enclosing union treats that member as a failed read. An
enclosing `anyOf` takes the first complete reading. An enclosing `oneOf` needs exactly one complete
reading. If none reads the value, the failure names the ambiguous path and omits the input. This
applies within optional fields, lists, and query or header groups that receive an empty record
because the group was omitted or stacked with another binding.

When a whole struct's decoder reports ambiguity at a named field, preparation can read the field on
its decoded side. If that succeeds, another field's failure does not make the first field ambiguous.
Lists and records read as a whole, so their encoded-side matches decide the result when preparation
needs that side.

The writer still makes its own choice. For example, suppose only member `K` reads
`{ f: {}, n: "5" }` and returns `{ f: {}, n: 5 }`. If member `M` can write that result with a number
and `K` writes it with a string, `anyOf[M,K]` sends `{"f":{},"n":5}` and `anyOf[K,M]` sends
`{"f":{},"n":"5"}`. An enclosing `oneOf` can refuse at its own position if its writer finds multiple
matches. For a union in a named field, the error points to that field.

For objects with an undefined-valued key,
[#310](https://github.com/viell-dev/slop-effect-schema-http/issues/310) tracks two cases where the
same field can be written as `null` or `{}`.

- In an enclosing `oneOf`, swapping two struct members can change the JSON field from `null` to `{}`
  when one member reads the field through an optional-field struct/Void `oneOf` and the other reads
  it as an empty struct.
- In a field-level `anyOf` with an optional-field struct/Void `oneOf` first and a member that reads
  only on its encoded side second, a stray key in an opaque sibling can let Void read alone. JSON
  then contains `null` for the field where it sends `{}` beside a clean sibling.

An ambiguity is a `SchemaError`. If you handled an `InvalidRequest` or `HttpBodyError` for one of
these inputs, handle the schema failure too. A writer failure at or below the ambiguous position can
retain the ambiguity. A writer failure elsewhere keeps its own diagnostic.

### Void takes only an empty value

Built-in `Schema.Void` ordinarily accepts any value and returns `undefined`. Here it takes only
`undefined`, `null`, and an object or list that holds nothing, and a JSON body writes each of them
as `null`. A scalar, a built-in such as a `Date` or a `Map`, an object with a defined enumerable own
field, and a list with a defined own cell or a defined named field of its own are never its. An
object field that is not enumerable does not count, because no writer sends one: under
`Schema.Unknown` alone such an object is written as `{}`.

- A member that keeps a supplied value can read it beside Void. So `Union([Void, String])` sends
  `"hello"` as given, and a union of Void and an empty struct keeps a populated object in either
  order.
- Anywhere else, as a Void of its own, in a field or in a union with no member that keeps the value,
  the request is refused with `Expected void`. `Union([Void, Struct({ a: String })])` refuses
  `"hello"` this way.

This holds through renames, transformations and the fields of a `Schema.Class`, wherever the library
can see the Void. Inside an `Option` or another opaque declaration it is the schema's own.

A key no member states is left out first, as under a struct, so an object with no other key holds
nothing. Under `Union([Void, Struct({ a: String })])`, `{ b: 1 }` therefore sends `null`, with no
error. A union with only Void members refuses a defined extra key with `Expected void`. Under
`oneOf`, Void and a struct with only optional fields both match an empty object, so the usual
fieldless ambiguity rule applies. If the structural member cannot encode a value, such as JSON
metadata containing a `Date` under `Schema.Unknown`, preparation fails with that member's
`SchemaError` unless another member can write the value without dropping a supplied field, as
[below](#a-field-no-member-can-keep-is-an-error) describes.

If an object member maps decoded `limit` to encoded `page_size`, either order with Void prepares
`{ page_size: "05" }` through the object member. An invalid `page_size` is a `SchemaError`.

### A field no member can keep is an error

Under `Union([Struct({ a }), Struct({ b })])`, `{ a, b }` is a `SchemaError` before dispatch, naming
the field that would go. The types allow that value, and whichever member took it would lose a field
the schema states, so the choice cannot be made for the caller. A field a wider member states and
refuses the value of is the same case. Only a real loss counts: a field another schema in the group
takes is not lost, as the rule on stacked schemas in [Schema-backed
groups](./schema-groups.md#declarations-and-defaults) says.

Writing keeps the same rule. A value is written strictly first. When the member that read it cannot
write it, the relaxed write that follows can take a later member. That write notes which member
wrote each value, and a struct member reads only the names it states, so a supplied field it does
not state is lost, whatever else it writes under that name. A struct that states no field keeps
every key, and a record keeps the keys its key schema takes. Nothing is decoded from what was sent.
The relaxed write selects the members to try by kind of value and literal tags, as the installed
Effect does, before it runs any of them, so a member Effect rules out runs none of its encoders,
middleware or checks. Like Effect, it follows each tag field through its encoding before it asks
whether the tag is required. The check runs where the caller's value is plain data, as [Where it
applies](#where-it-applies) defines it, and the schema there, a union's members and tags among it,
names no field after an `Object.prototype` member; elsewhere the value is written as Effect writes
it. A nested union that fails its own check or one-of rule credits none of its members, and each
place a value is written from is checked on its own, so one object given to two fields is checked
against each field's member. When no member can both keep and write the value, the refusal is the
error of the first member that could not write it, the error that member alone gives. That holds
through grouped and suspended unions:

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
does. In the same way, `{ "0": { limit: "x", extra: 1 } }` beside an array or tuple member is read
as its object member alone reads it.

This reading applies where what each alternative reads from an object or a list is known from the
schema alone: every alternative at the value is a struct, a record, a list, a tuple, or a
`Schema.Class` that states a field. So is a struct decoded through one plain transformation from an
unchecked struct of the same shape, as `Schema.encodeKeys` builds: as many fields in the same order,
each with the same optionality and the encoded form of the same type, whatever the transformation
does with them. An alternative that takes no object, such as text, a number, `null` or built-in
`Schema.Void`, does not change that. Field types can be anything; each child value of such a value
is judged again at its own level. Every member counts, one a tag rules out included.

Anywhere else a value has the **union-wide reading**, and so does every value inside it: a key
counts as held when any alternative at that place states it, whatever kind of value that alternative
reads. That covers an alternative that is an empty class, a declaration such as `Schema.Date`, an
open schema such as `Schema.Unknown`, `Schema.catchDecoding` or `Schema.catchEncoding` middleware,
or a codec with any other transformation, such as a struct decoded from a struct of another shape.
Such an alternative can take the whole value, and a recovery can turn a failure anywhere inside into
a value of its own. There a list beside a record refuses a cell key the list member does not state,
because the record could hold it: with `Schema.Date` added to `Listed`, `[{ page_size: "05" }]`
refuses at `[0]["page_size"]`.

Beside a Void, a value also has the union-wide reading where the container rule would leave every
field the caller supplied unstated. With `Named = Schema.Struct({ a: Schema.String })`,
`Union([Named, Schema.Void, Schema.Array(Named)])` refuses `{ 0: { a: "ok" } }` before dispatch
rather than sending `null`: the list member can hold a cell `0`, so it is a supplied field that Void
would lose.

A query or header group that encodes to an array of field pairs is read by position, including when
`Schema.Struct({})` keeps the original array. Both the list and its pairs can have a `null`
prototype or an own iterator. A callable iterator on another object supplies its pairs once. A pair
must be an array of length two with a string name. A hole at the value position reads as
`undefined`, which omits a query entry and is invalid for a header pair. A malformed entry,
including a hole in the outer list, fails with `InvalidRequest`. Declared defaults are added as
pairs before the schema reads the group again. Arrays of repeated values are also read by position.

### An opaque value is the schema's own reading

A value is opaque when neither side of its schema states an object for it: text given as text, and
what a `Schema.ReadonlyMap`, a `Schema.Option` or a declaration with no struct behind it holds. An
object given to a field that holds JSON as text can still have declared fields. The text is opaque
once the caller supplies it as text. Opaque contents read as Effect reads them. A whole strict read
still passes through an opaque value, so beside a visible choice a wider member inside that value
can win. A stray key in those opaque contents can fail that read and make preparation fall back to
Effect's first fit. The [recovery routes](#recovery-beside-an-opaque-value) account for the visible
fields.

Codecs such as `Schema.OptionFromNullOr` write a native `Some` by unwrapping its payload. When the
codec is unambiguous at that position, preparation can see plain payloads under structural parents,
including renamed structs and plain inputs to a stated class. A scalar, null or undefined
alternative that cannot read the `Some` does not make the codec ambiguous. Before the whole strict
read and write, preparation leaves out keys neither side of any remaining member states. A member
ruled out by a literal tag states nothing, just as for an ordinary field. If the strict attempt
fails, preparation uses the original input and checks for missing visible fields. If the whole write
has to run loosely, unions the writer reaches through the Option's payload schema can try a member
that keeps the whole value first. This includes a nested `Some` and a payload below a key renamed to
an index-like name such as `"0"`. A plain transformation can expose the same payload schema directly
or in a single-field struct for loose writing.

Some codecs that unwrap a `Some` are followed only by the writer: a hand-written codec whose encoder
writes a value in the field's place, a built-in one behind middleware, and an explicit
`Schema.toCodecJson` of a built-in codec where it rebuilds the payload, as it does for a payload
with a `Date` or `BigInt` field or a suspended payload. Preparation cannot tell what such a codec's
encoder writes, so it leaves no key out of its `Some`, and a key no member of the payload states
makes the strict attempt fail. Wherever the strict attempt fails, for that or another reason, such
as a stray key in a sibling `Schema.Option` or a `limit` the wider member refuses, the relaxed read
that follows is checked against what the caller gave: under a direct union, a same-tag union or a
list, and inside a `Some` that a built-in codec reads. A stated field it lost is refused, naming the
field. This needs the codec to be the only Option schema at its position, or to share its payload
schema with the codecs beside it, as the limits below say. What the encoder writes from the read is
its own: one that writes only `owner` sends only `owner`. `Body.jsonSchema` applies
`Schema.toCodecJson` itself, so give it the built-in codec rather than its JSON form. Declare a
hand-written codec's decoded side as `Schema.Option(Schema.toType(payload))`: over a payload with a
renamed field, `Schema.Option(payload)` gives the codec two different payload types, which
TypeScript rejects (TS2322), and at run time the payload is encoded twice, so `limit` can go with no
error.

Use decoded names inside a `Some` that an unwrapping codec reads. For a payload that writes `limit`
as `page_size`, pass `Some({ limit: "5" })`. To supply the wire name, pass the encoded value
`{ page_size: "5" }` at the Option's position. If the decoded payload fails validation, the encoded
read through an unwrapping codec refuses to take the native wrapper as the wire value. The error can
point into `["value"]`, which is where the caller gave the payload. Beside an encoded sibling, a
struct reads its fields one by one, so a valid wrapper stays its field's decoded value and the
sibling is read on its encoded side, as it is for a struct inside a field's union. Where the value
is a union of whole structs, the refusal can remain, because reading the union member by member
would lose which member the whole value chose: give the sibling on its decoded side or supply the
encoded payload directly. A field called `value` inside the payload belongs to the payload.
`Schema.Option(X)` uses Effect's own reading and member selection on every write route. Effect can
read X's encoded names and values from a `Some` at runtime, though the typed input expects decoded
contents. A narrower member can drop a payload field without a refusal.

### The reading of Effect is tested, not checked at run time

Knowing what a schema states means reading Effect's schema structure, which a newer Effect could
change. Tests hold that reading to the versions named in [Limits and recovery](./limits.md), in CI,
on the oldest Effect the peer range allows, and on each dependency update. On an untested Effect it
can fall back to Effect's own reading, so a field can go with no error, and valid use does not stop.

### A key no member states is stripped, as a struct strips it

A key the schema does not state is left out, with no error. Effect's structs strip such keys, and
preparation does the same, under a struct alone and under a union. A misspelled key such as
`{ titel: "a" }` under `Struct({ title: optionalKey(String) })` sends `{}`. TypeScript's
excess-property check catches such a key in an object literal written in place, but not reliably in
a value built elsewhere. Validate input of unknown shape against the schema before preparation if an
unexpected key should be an error.

Under a union, a key only a member with another tag states is unstated too, because the tag has
already chosen. With `Comment` and `Reschedule` from [What will be sent](#what-will-be-sent),
`{ _tag: "Comment", text: "x", due: "d" }` sends `{"_tag":"Comment","text":"x"}`: a field of the
wrong variant is not caught. `Schema.TaggedStruct` makes its tag optional on the input side, because
its constructor fills it in, so a value without `_tag` goes to the first member that keeps every
field: `{ text: "x" }` is sent as a `Comment`, and `{ text: "x", due: "d" }` as a `Reschedule`. Pass
`_tag` to choose the variant.

A stacked schema's fields reach every schema in the group this way. A key only a member that cannot
read the value's container states, such as a record beside a list, is unstated too. A key an empty
struct member holds is not unstated, as [An empty struct or open schema keeps every
key](#an-empty-struct-or-open-schema-keeps-every-key) describes. A required literal tag can choose
by its decoded or encoded name, including when a whole-object transformation changes its name or
literal. Both views must rule a member out before its fields go. A missing tag with a constructor
default leaves that view possible; its default is not run to guess a member. A key set to
`undefined` is no field at all, so `{ a, b: undefined, c }` reads as `{ a, c }`, and a member that
states `b` cannot take the value from one that states `c`. A field given under both its names is
refused, as [above](#constructor-default-validation) gives.

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
migration](./release-notes/0.10.md) shows both. The type changes neither constructor priority nor
schema reading. An opaque `Schema.ReadonlyMap` can read encoded inner aliases as decoded contents
and lose them according to its constructor. Supply decoded contents for a predictable decoded route.

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
  given under both its names sends one of them where its wire name is such a name.
- Inside `Schema.Option(X)`, Effect reads and selects a member of X on every write route. A narrower
  member can drop a payload field. For example, with
  `Schema.Option(Union([Struct({ owner }), Struct({ owner, limit })]))` as the entire body schema,
  `Some({ owner: "b", limit: "l" })` can send as `{"_tag":"Some","value":{"owner":"b"}}`.
- Inside a `Some`, a key no member of the payload states is left out before the strict read, through
  every built-in unwrapping codec, including a configured `OptionFromOptionalNullOr`, and between
  codecs competing at one position when they share one payload schema, or, for a payload without an
  encoding of its own, the optional copy `OptionFromOptionalKey` makes of it. Beside
  `OptionFromOptionalKey`, a payload with its own encoding, such as a renamed struct or a class,
  stays opaque and can lose `limit` there. Codecs competing with different payload schemas, built-in
  or hand-written, or beside a `Schema.Option` alternative, could each write the `Some`, so there a
  relaxed read can still take a narrower member when a stray key defeats the strict read: a same-tag
  union, a list of unions or a union inside another `Some` can lose `limit`, and a direct union
  refuses. A configured codec, alone or in a pair with one payload schema, inside another `Some` can
  lose a field the same way where the strict attempt fails for another reason, such as a record
  member beside the union or a wire name given in the payload. A loose write can select a wider
  member through an unwrapping codec. Data already narrowed by the read, a class instance, or a
  custom writer can fall outside that recovery. Let
  `Choice = Union([Struct({ owner: String }), Struct({ owner: String, limit: String })])`. Inside
  another `Some`, `Union([OptionFromNullOr(Choice), Struct({ z: String })])` can lose `limit` on a
  loose write even without a stray key. Choose the intended member directly or validate and supply
  the encoded representation
  ([#312](https://github.com/viell-dev/slop-effect-schema-http/issues/312)).
- A hand-written codec whose encoder can omit its key, a `transformOptional` as in
  `OptionFromOptional`, is not followed by the writer. Beside a key no member states in its `Some`,
  a same-tag union, a list of unions or a union inside another `Some` can lose `limit`, and a direct
  union refuses. Use `Schema.OptionFromOptional`, or leave the key out
  ([#364](https://github.com/viell-dev/slop-effect-schema-http/issues/364)).
- Inside a `Some` that a hand-written codec, or another codec only the writer follows, reads, a
  nested Option codec, built-in or hand-written, can lose `limit` wherever the strict attempt fails:
  beside a key no member states in its own `Some`, and with none there, as where a sibling
  `Schema.Option` holds one. The check after the relaxed read follows the outer codec's decoded
  payload, where the nested codec reads as an opaque `Schema.Option`. Use a built-in outer codec
  ([#347](https://github.com/viell-dev/slop-effect-schema-http/issues/347)).
- An opaque value, a declaration, a custom transformation and middleware decide for themselves. A
  guard for native Options follows visible schema nodes into the encoded side of Option codecs,
  including hand-written ones. It cannot see a wrapper read inside an opaque declaration or inside a
  middleware callback. Below a struct with renamed keys, it pairs each wire field with the decoded
  field it was projected from, so a native Option given there is refused as well. With `held`
  renamed to `wire_held`, a `Some` or `None` at `wire_held`, or beside a renamed sibling or below a
  renamed ancestor on the encoded side, refuses instead of sending `{"wire_held":{}}`, also through
  a suspension, a recursive schema, a nested rename or a renamed class, and in a list or union below
  a renamed ancestor. A wire field is paired with the decoded field a `Schema.encodeKeys` rename
  wrote there: the one in its place, or, for an integer-like name such as `"1"`, which JavaScript
  lists first, the one field whose wire side it is. Where several fields share that wire side, a
  wrapper given there refuses if any of them may be an Option codec, even when the one written there
  is not. Below such a field, a nested Option keeps the schema's own reading and can be sent as `{}`
  ([#328](https://github.com/viell-dev/slop-effect-schema-http/issues/328)). A field written by
  another transformation keeps the schema's own reading
  ([#321](https://github.com/viell-dev/slop-effect-schema-http/issues/321)). A recovery's value is
  not checked against what it was given: a `Schema.catchDecoding` record beside a list member can
  take a list whose cells hold a key the list member does not state, and what it recovers is sent.
  In `Union([Opaque, Title])`, where `Opaque` is a declaration that cannot be written as JSON,
  `Title` can drop `meta`.
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

- At an opaque or ambiguous unwrapping Option position, a payload field can overlap a wire path
  under `value`. Preparation can refuse at that path
  ([#299](https://github.com/viell-dev/slop-effect-schema-http/issues/299)). Remove the unstated
  outer key, choose the intended member directly, or supply the encoded representation.
- A stray key can also cause a refusal at an opaque Option position where the payload schema states
  a field called `value`, even if the given `value` would have been sent intact. This includes a
  native `Some` supplied as an object beside a competing Option alternative. Remove the unstated
  key, rename the payload's `value` field, supply a plain object to the struct, or use an
  unambiguous `OptionFromNullOr` where appropriate
  ([#292](https://github.com/viell-dev/slop-effect-schema-http/issues/292)).
- Inside a value with the union-wide reading, as [A list stays a list](#a-list-stays-a-list) gives,
  a list beside a record refuses a cell key the list member does not state, and an index-keyed
  object beside a list member refuses the key the list states. Leave out keys the list member does
  not state.
- A wire name on a parent makes everything inside it encoded, so a decoded name below refuses. With
  `Struct({ filter: Filter, sortBy: String })` and `encodeKeys({ sortBy: "sort_by" })`, where
  `Filter` encodes `limit` as `page_size`, `{ filter: { limit: 5 }, sort_by: "a" }` refuses, and so
  it does with `Union([Void, Filter])` in either order in `filter`'s place. Use all-decoded or
  all-encoded names, one per field.
- A class instance that a struct member before its class would strip refuses where its class cannot
  write it whole: where a field is invalid, where the instance holds a field only another member
  states, or where the schema names a field every object has. It also refuses where a renamed
  field's wire name cannot show that the field was written:
  - where any other field there is written under that name, renamed or not, in any member, because a
    default or a transformation can write it where the caller gave nothing. With
    `Renamed = Counted.pipe(encodeKeys({ a: "A" }))` and
    `Defaulted = Struct({ A: flip(String.pipe(withDecodingDefaultKey(…))) })`,
    `Union([Defaulted, Renamed])` refuses a `Counted` instance, valid or not;
  - where the instance holds a key of that name, or the name is an index such as `"0"` or a symbol;
  - where a member beside the class could write any name: another declaration, middleware, a record
    whose keys are encoded, or a transformation other than one between two structs of one shape.

  A transformation between two structs with as many fields in the same order, each with the same
  optionality and the encoded form of the same type, is read by position as renaming each field,
  whatever its functions do. That reading comes from the schema's shape; it does not show that
  `Schema.encodeKeys` built it. So beside a hand-written transformation from `{ b }` to `{ B }`,
  `Renamed` still sends `{"A":"item"}`. With the class first, such an instance is written as Effect
  writes it, as the first item above gives.
- A stray key in a visible `Some` can still appear in a refusal when a separate strict failure
  forces the original reading. If a narrower member on that route would lose a stated field,
  preparation can refuse at that field. Remove undeclared keys from the value blocking the strict
  attempt, or bind the member you intend to use.
- Beside a key no member states in a `Some` that a codec only the writer follows reads, such as a
  hand-written one, a stated field that a built-in codec would keep is refused, because preparation
  cannot leave the key out without knowing what the encoder writes. With `Choice` as above,
  `Some({ owner, limit, stray })` refuses at `limit` under a same-tag union, a list of `Choice` or a
  `Choice` inside another `Some`
  ([#334](https://github.com/viell-dev/slop-effect-schema-http/issues/334)). Under `Choice` itself,
  a struct holding it, or such a codec beside a scalar or another codec, the refusal also names the
  unstated key, and `Some({ owner, stray })` refuses at `stray`
  ([#346](https://github.com/viell-dev/slop-effect-schema-http/issues/346)). Leave unstated keys out
  of the `Some`, or use a built-in codec such as `OptionFromNullOr`, without middleware or an
  explicit `Schema.toCodecJson`. Where something else makes the strict attempt fail, such as a stray
  key in a sibling `Schema.Option`, `OptionFromNullOr` refuses the field too.
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
  array, report a `SchemaError`. So does such a record or codec, or a struct, that rebuilds a
  built-in, such as a `Map` or a `Date`, from its own fields, including a struct that reads a value
  given on the encoded side of an Option codec such as `OptionFromNullOr`. An empty struct keeps the
  value as given. A struct refuses only where it is read on its own: beside a union of structs,
  below a rename, through a suspension, with a constructor default, or as an `Option.some` payload,
  a built-in can still be sent as `{}` or as the struct's defaults
  ([#330](https://github.com/viell-dev/slop-effect-schema-http/issues/330)). Not covered: a symbol
  inside a declaration's type parameter, such as `Option(Record(…))`, `ReadonlyMap`, `Redacted` or
  `OptionFromNullOr`. A symbol key the schema declares is written as it chooses, and one at a
  class's root is stripped. See the [Body guide](./modules/body.md#text-json-and-finite-body-limits)
  for writer rules. An opaque transformation can still choose its own encoded representation.
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

The [cumulative release history](./release-notes/index.md#schema-input-hardening) records how these
rules changed between releases. This page states the current rules without relying on it.
