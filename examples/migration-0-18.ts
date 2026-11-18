import assert from "node:assert/strict";
// #region imports
import { Effect, Option, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

const jsonText = (compiled: Request.Compiled) => {
  const body = compiled.request.body;
  if (body._tag !== "Uint8Array") throw new Error("Expected JSON");
  return new TextDecoder().decode(body.body);
};
const prepared = async <E>(pending: Effect.Effect<Request.Compiled, E>) =>
  jsonText(await Effect.runPromise(pending));
const refused = async <E extends { readonly _tag: string }>(
  pending: Effect.Effect<Request.Compiled, E>,
  tag = "SchemaError",
) => {
  const error = await Effect.runPromise(Effect.flip(pending));
  assert.equal(error._tag, tag);
  return String(error);
};

// #region void-schema
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
// Nothing to send, or a filter.
const Choice = Schema.Union([Schema.Void, Filter]);
const search = Request.post("/searches").pipe(
  Request.body(Body.jsonSchema(Choice)),
);
// #endregion void-schema

// #region void-kept
const encoded = Request.compile(search, { body: { page_size: "05" } });
const decoded = Request.compile(search, { body: { limit: 5 } });
const invalid = Request.compile(search, { body: { page_size: "many" } });
const empty = Request.compile(search, { body: {} });
// #endregion void-kept
assert.equal(await prepared(encoded), '{"page_size":"5"}');
assert.equal(await prepared(decoded), '{"page_size":"5"}');
assert.match(await refused(invalid), /at \["page_size"\]/);
assert.equal(await prepared(empty), "null");

// #region void-sides
const Page = Schema.Struct({ filter: Choice, sortBy: Schema.String }).pipe(
  Schema.encodeKeys({ sortBy: "sort_by" }),
);
const page = Request.post("/pages").pipe(Request.body(Body.jsonSchema(Page)));
const mixedRuntime = {
  filter: { limit: 5 },
  sort_by: "a",
} as unknown as Request.Input<typeof Page>;
const mixed = Request.compile(page, { body: mixedRuntime });
const encodedSide = Request.compile(page, {
  body: { filter: { page_size: "05" }, sort_by: "a" },
});
const decodedSide = Request.compile(page, {
  body: { filter: { limit: 5 }, sortBy: "a" },
});
// #endregion void-sides
assert.match(await refused(mixed), /at \["filter"\]/);
assert.equal(
  await prepared(encodedSide),
  '{"filter":{"page_size":"5"},"sort_by":"a"}',
);
assert.equal(
  await prepared(decodedSide),
  '{"filter":{"page_size":"5"},"sort_by":"a"}',
);

// #region void-defaults
const Grouping = Schema.Struct({
  group: Schema.optionalKey(
    Schema.Union([
      Schema.Void,
      Schema.Struct({ size: Schema.optionalKey(Schema.Number) }),
    ]),
  ).pipe(Schema.withConstructorDefault(Effect.succeed({ size: 1 }))),
});
const grouping = Request.post("/groupings").pipe(
  Request.body(Body.jsonSchema(Grouping)),
);
const defaulted = Request.compile(grouping, { body: {} });
// #endregion void-defaults
assert.equal(await prepared(defaulted), '{"group":{"size":1}}');

// #region void-undefined
const Note = Schema.Union([
  Schema.Struct({ text: Schema.UndefinedOr(Schema.String) }),
  Schema.Void,
]);
const Size = Schema.Union([
  Schema.Struct({ size: Schema.optional(Schema.Number) }),
  Schema.Void,
]);
const note = Request.compile(
  Request.post("/notes").pipe(Request.body(Body.jsonSchema(Note))),
  { body: { text: undefined } },
);
const size = Request.compile(
  Request.post("/sizes").pipe(Request.body(Body.jsonSchema(Size))),
  { body: { size: undefined } },
);
// #endregion void-undefined
assert.equal(await prepared(note), "null");
assert.equal(await prepared(size), "{}");

// A header schema that encodes a non-string value fails with a typed error.
const counted = Request.get("/counts").pipe(Request.headers(Schema.Any));
await refused(
  Request.compile(counted, { headers: { "x-count": 5 } }),
  "InvalidRequest",
);

// #region list-schema
const Plain = Schema.Struct({ limit: Schema.optionalKey(Schema.String) });
// A list of filters, or named filters.
const Listed = Schema.Union([
  Schema.Array(Plain),
  Schema.Record(Schema.String, Schema.Unknown),
]);
const save = Request.post("/filters").pipe(
  Request.body(Body.jsonSchema(Listed)),
);
// #endregion list-schema

// #region lists
const wrongRuntime = [{ limit: 5 }] as unknown as Request.Input<typeof Listed>;
const wrongItem = Request.compile(save, { body: wrongRuntime });
const list = Request.compile(save, { body: [{ limit: "x" }] });
const named = Request.compile(save, { body: { "0": { limit: 5 } } });
// #endregion lists
assert.match(await refused(wrongItem), /at \[0\]\["limit"\]/);
assert.equal(await prepared(list), '[{"limit":"x"}]');
assert.equal(await prepared(named), '{"0":{"limit":5}}');

// #region record-only
const Named = Schema.Record(Schema.String, Schema.Unknown);
const saveNamed = Request.post("/named").pipe(
  Request.body(Body.jsonSchema(Named)),
);
const items = [{ limit: "x" }];
const listRuntime = items as unknown as Request.Input<typeof Named>;
const listForRecord = Request.compile(saveNamed, { body: listRuntime });
const spread = Request.compile(saveNamed, { body: { ...items } });
// #endregion record-only
await refused(listForRecord);
assert.equal(await prepared(spread), '{"0":{"limit":"x"}}');

// #region unstated-keys
const unstated = Request.compile(save, { body: [{ limit: "x", extra: 1 }] });
const readList = Schema.decodeUnknownEffect(Schema.Array(Plain));
const stripped = Effect.gen(function* () {
  const body = yield* readList([{ limit: "x", extra: 1 }]);
  return yield* Request.compile(save, { body });
});
// #endregion unstated-keys
assert.match(await refused(unstated), /at \[0\]\["extra"\]/);
assert.equal(await prepared(stripped), '[{"limit":"x"}]');

// #region alias-schema
const Cursor = Schema.Struct({ cursor: Schema.String });
// One filter, or a list of them.
const OneOrMany = Schema.Union([Schema.Array(Filter), Filter]);
const filters = Request.post("/filters").pipe(
  Request.body(Body.jsonSchema(OneOrMany)),
);
// #endregion alias-schema

// #region one-or-many
const invalidOne = Request.compile(filters, { body: { page_size: "many" } });
const invalidMany = Request.compile(filters, {
  body: [{ page_size: "many" }],
});
const encodedOne = Request.compile(filters, { body: { page_size: "05" } });
const decodedMany = Request.compile(filters, { body: [{ limit: 5 }] });
const omittedMany = Request.compile(filters, { body: [{}] });
// #endregion one-or-many
assert.match(
  await refused(invalidOne),
  /Expected no excess property\s+at \["page_size"\]/,
);
assert.match(await refused(invalidMany), /at \[0\]\["page_size"\]/);
assert.equal(await prepared(encodedOne), '{"page_size":"5"}');
assert.equal(await prepared(decodedMany), '[{"page_size":"5"}]');
assert.equal(await prepared(omittedMany), '[{"page_size":"25"}]');

// A list beside an object that states a field follows the list member too.
const Paged = Schema.Union([Schema.Array(Filter), Cursor]);
const paged = Request.post("/paged").pipe(Request.body(Body.jsonSchema(Paged)));
await refused(Request.compile(paged, { body: [{ page_size: "many" }] }));
assert.equal(
  await prepared(Request.compile(paged, { body: { cursor: "c" } })),
  '{"cursor":"c"}',
);

// #region encoded-primitive
// Each item is a count given as text, or a filter.
const Counts = Schema.Array(Schema.Union([Schema.FiniteFromString, Filter]));
const count = Request.post("/counts").pipe(
  Request.body(Body.jsonSchema(Counts)),
);
const invalidCount = Request.compile(count, { body: [{ page_size: "many" }] });
const counts = Request.compile(count, { body: ["7", { page_size: "05" }] });
// #endregion encoded-primitive
assert.match(await refused(invalidCount), /at \[0\]\["page_size"\]/);
assert.equal(await prepared(counts), '["7",{"page_size":"5"}]');

// #region list-sides
const mixedItems = Request.compile(filters, {
  body: [{ page_size: "05" }, { limit: 7 }],
});
const encodedItems = Request.compile(filters, {
  body: [{ page_size: "05" }, { page_size: "07" }],
});
const decodedItems = Request.compile(filters, {
  body: [{ limit: 5 }, { limit: 7 }],
});
// #endregion list-sides
assert.match(await refused(mixedItems), /at \[1\]\["limit"\]/);
// The decoded item first refuses as well.
assert.match(
  await refused(
    Request.compile(filters, { body: [{ limit: 1 }, { page_size: "25" }] }),
  ),
  /at \[0\]\["limit"\]/,
);
assert.equal(
  await prepared(encodedItems),
  '[{"page_size":"5"},{"page_size":"7"}]',
);
assert.equal(
  await prepared(decodedItems),
  '[{"page_size":"5"},{"page_size":"7"}]',
);

// #region decode-first
const readFilters = Schema.decodeUnknownEffect(Schema.Array(Filter));
const withStored = Effect.fn("withStored")(function* (stored: unknown) {
  const decodedStored = yield* readFilters(stored);
  return yield* Request.compile(filters, {
    body: [...decodedStored, { limit: 7 }],
  });
});
// #endregion decode-first
assert.equal(
  await prepared(withStored([{ page_size: "05" }])),
  '[{"page_size":"5"},{"page_size":"7"}]',
);
await refused(withStored([{ page_size: "many" }]));

// #region dual-names
const bothNames = [{ limit: 1, page_size: "02" }, { page_size: "25" }];
const typedBothNames: Request.Input<typeof OneOrMany> = bothNames;
const conflicting = Request.compile(filters, { body: typedBothNames });
const oneName = Request.compile(filters, {
  body: [{ limit: 1 }, { limit: 25 }],
});
// #endregion dual-names
assert.equal(
  await prepared(conflicting),
  '[{"page_size":"2"},{"page_size":"25"}]',
);
assert.equal(await prepared(oneName), '[{"page_size":"1"},{"page_size":"25"}]');

// #region proof-stops
const Recovering = Schema.FiniteFromString.pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(0))),
);
const recovering = Request.post("/recovering").pipe(
  Request.body(Body.jsonSchema(Schema.Union([Filter, Recovering]))),
);
const twoLists = Request.post("/two-lists").pipe(
  Request.body(
    Body.jsonSchema(Schema.Union([Schema.Array(Filter), Schema.Array(Cursor)])),
  ),
);
const stillRecovered = Request.compile(recovering, {
  body: { page_size: "many" },
});
const stillListed = Request.compile(twoLists, {
  body: [{ page_size: "many" }],
});
// #endregion proof-stops
assert.equal(await prepared(stillRecovered), '"0"');
assert.equal(await prepared(stillListed), '[{"page_size":"25"}]');
// A conflicting alias in one filter is still read by its decoded name.
assert.equal(
  await prepared(
    Request.compile(filters, { body: { limit: 5, page_size: "many" } }),
  ),
  '{"page_size":"5"}',
);
