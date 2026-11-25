import assert from "node:assert/strict";
import { Exit, Option } from "effect";
// #region what-is-sent
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";

// limit is written as page_size; both fields are numbers written as text.
const Page = Schema.Struct({
  limit: Schema.FiniteFromString,
  count: Schema.FiniteFromString,
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Ids = Schema.Struct({ ids: Schema.Array(Schema.NumberFromString) });
const Comment = Schema.TaggedStruct("Comment", { text: Schema.String });
const Reschedule = Schema.TaggedStruct("Reschedule", {
  text: Schema.String,
  due: Schema.String,
});

const json = <S extends Schema.Top>(schema: S) =>
  Request.post("https://api.example.test/things").pipe(
    Request.body(Body.jsonSchema(schema)),
  );
const sendPage = json(Page);
const sendChange = json(Schema.Union([Comment, Reschedule]));

const change = { _tag: "Comment" as const, text: "x", due: "d" };
const prepared = Request.compile(sendChange, { body: change });
// JSON body: {"_tag":"Comment","text":"x"}; due is not a Comment field.
// #endregion what-is-sent

// What a compiled request carries, or the first line and path of its typed failure.
const outcome = async (
  effect: Effect.Effect<Request.Compiled, unknown>,
): Promise<string> => {
  const exit = await Effect.runPromise(Effect.exit(effect));
  if (Exit.isSuccess(exit)) {
    const { url, body } = exit.value.request;
    return body._tag === "Uint8Array"
      ? new TextDecoder().decode(body.body)
      : url;
  }
  const error = Option.getOrThrow(Exit.findErrorOption(exit));
  const { _tag, message } = error as { _tag: string; message: string };
  return `${_tag}: ${message.replace(/\n\s*/g, " ")}`;
};
const kept = "The schema cannot keep this field with the rest of the value";

assert.equal(
  await outcome(Request.compile(sendPage, { body: { limit: 5, count: "3" } })),
  '{"page_size":"5","count":"3"}',
);
assert.equal(
  await outcome(
    Request.compile(sendPage, {
      // A compile error when written in place; a cast stands for a value from elsewhere.
      body: { page_size: "5", count: 3 } as never,
    }),
  ),
  'SchemaError: Missing key at ["limit"]',
);
assert.equal(
  await outcome(
    Request.compile(sendPage, {
      body: { limit: 5, page_size: "5", count: 3 },
    }),
  ),
  `SchemaError: ${kept} at ["page_size"]`,
);
assert.equal(
  await outcome(
    Request.compile(sendPage, { body: { page_size: "many", count: "3" } }),
  ),
  'SchemaError: Missing key at ["limit"]',
);
const OptionalPage = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
assert.equal(
  await outcome(
    Request.compile(json(OptionalPage), { body: { page_size: "many" } }),
  ),
  `SchemaError: ${kept} at ["page_size"]`,
);
assert.equal(
  await outcome(
    Request.compile(json(Schema.Array(OptionalPage)), {
      body: [{ limit: 5 }, { page_size: "6" }],
    }),
  ),
  `SchemaError: ${kept} at [1]["page_size"]`,
);
assert.equal(
  await outcome(
    Request.compile(json(Ids), { body: { ids: [5, "6"] } as never }),
  ),
  'SchemaError: Expected number at ["ids"][1]',
);
assert.equal(
  await outcome(Request.compile(json(Ids), { body: { ids: ["5", "6"] } })),
  '{"ids":["5","6"]}',
);
assert.equal(await outcome(prepared), '{"_tag":"Comment","text":"x"}');
const titled = { title: "a", extra: 1 };
assert.equal(
  await outcome(
    Request.compile(json(Schema.Struct({ title: Schema.String })), {
      body: titled,
    }),
  ),
  '{"title":"a"}',
);

// undefined under each optional form
const note = <F extends Schema.Top>(field: F) =>
  json(Schema.Struct({ note: field }));
const getThings = Request.get("https://api.example.test/things");
const omitted = { note: undefined } as never;
assert.equal(
  await outcome(
    Request.compile(note(Schema.optional(Schema.String)), { body: omitted }),
  ),
  '{"note":null}',
);
assert.equal(
  await outcome(
    Request.compile(
      getThings.pipe(
        Request.query(Schema.Struct({ note: Schema.optional(Schema.String) })),
      ),
      { query: omitted },
    ),
  ),
  "https://api.example.test/things",
);
assert.equal(
  await outcome(
    Request.compile(note(Schema.optionalKey(Schema.String)), { body: omitted }),
  ),
  'SchemaError: Expected string at ["note"]',
);
assert.equal(
  await outcome(
    Request.compile(note(Schema.UndefinedOr(Schema.String)), {
      body: omitted,
    }),
  ),
  '{"note":null}',
);
assert.equal(
  await outcome(Request.compile(note(Schema.Any), { body: omitted })),
  "{}",
);

// NaN
const nan = { note: NaN } as never;
assert.equal(
  await outcome(Request.compile(note(Schema.Number), { body: nan })),
  '{"note":"NaN"}',
);
assert.equal(
  await outcome(
    Request.compile(
      getThings.pipe(Request.query(Schema.Struct({ note: Schema.Number }))),
      { query: nan },
    ),
  ),
  "https://api.example.test/things?note=NaN",
);
assert.equal(
  await outcome(Request.compile(note(Schema.Finite), { body: nan })),
  'SchemaError: Expected a finite number at ["note"]',
);
assert.equal(
  await outcome(Request.compile(note(Schema.Any), { body: nan })),
  'HttpBodyError: JSON body at $["note"] must be a finite number',
);

// A Map and a class instance
const map = { note: new Map([["a", 1]]) } as never;
assert.equal(
  await outcome(Request.compile(note(Schema.Any), { body: map })),
  'HttpBodyError: JSON body at $["note"] cannot encode Map',
);
assert.equal(
  await outcome(
    Request.compile(note(Schema.Record(Schema.String, Schema.Unknown)), {
      body: map,
    }),
  ),
  `SchemaError: ${kept} at ["note"]`,
);
assert.equal(
  await outcome(Request.compile(note(Schema.Unknown), { body: map })),
  'SchemaError: Expected JSON value at ["note"]',
);
class Point {
  readonly x = 1;
}
const point = { note: new Point() } as never;
assert.equal(
  await outcome(Request.compile(note(Schema.Any), { body: point })),
  '{"note":{"x":1}}',
);
assert.equal(
  await outcome(
    Request.compile(note(Schema.Record(Schema.String, Schema.Unknown)), {
      body: point,
    }),
  ),
  '{"note":{"x":1}}',
);
assert.equal(
  await outcome(Request.compile(note(Schema.Unknown), { body: point })),
  'SchemaError: Expected JSON value at ["note"]',
);

// Query and header writers
assert.equal(
  await outcome(
    Request.compile(
      getThings.pipe(Request.query(Schema.Struct({ note: Schema.Any }))),
      { query: { note: { x: 1 } } as never },
    ),
  ),
  'InvalidRequest: The query field "note" must encode a scalar value or a list of scalar values',
);
assert.equal(
  await outcome(
    Request.compile(
      getThings.pipe(Request.headers(Schema.Struct({ "x-count": Schema.Any }))),
      { headers: { "x-count": 5 } as never },
    ),
  ),
  'InvalidRequest: The header field "x-count" must have a string value',
);

// Void
const ack = json(Schema.Struct({ ack: Schema.Void }));
for (const value of [undefined, null, {}, []])
  assert.equal(
    await outcome(Request.compile(ack, { body: { ack: value } as never })),
    '{"ack":null}',
  );
for (const value of [5, new Date(0), new Map(), { a: 1 }])
  assert.equal(
    await outcome(Request.compile(ack, { body: { ack: value } as never })),
    'SchemaError: Expected void at ["ack"]',
  );
const voidOrNamed = json(
  Schema.Union([Schema.Void, Schema.Struct({ a: Schema.String })]),
);
assert.equal(
  await outcome(Request.compile(voidOrNamed, { body: { b: 1 } as never })),
  "null",
);
