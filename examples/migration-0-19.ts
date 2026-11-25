import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

const jsonText = (compiled: Request.Compiled) => {
  const body = compiled.request.body;
  if (body._tag !== "Uint8Array") throw new Error("Expected JSON");
  return new TextDecoder().decode(body.body);
};
const prepared = async <E>(pending: Effect.Effect<Request.Compiled, E>) =>
  jsonText(await Effect.runPromise(pending));
const url = async <E>(pending: Effect.Effect<Request.Compiled, E>) =>
  (await Effect.runPromise(pending)).request.url;
const refused = async <E extends { readonly _tag: string }>(
  pending: Effect.Effect<Request.Compiled, E>,
  tag = "SchemaError",
) => {
  const error = await Effect.runPromise(Effect.flip(pending));
  assert.equal(error._tag, tag);
  return String(error);
};

// #region filter
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Page = Schema.Struct({
  n: Schema.FiniteFromString,
  items: Schema.Array(Filter),
});
const pages = Request.post("/pages").pipe(Request.body(Body.jsonSchema(Page)));
// #endregion filter

// #region defaults
const kept = Request.compile(pages, {
  body: { n: 1, items: [{ limit: 5 }, {}] },
});
const invalid = Request.compile(pages, {
  body: { n: "1", items: [{ page_size: "many" }] },
});
const rows = Request.post("/rows").pipe(
  Request.body(Body.jsonSchema(Schema.Array(Filter))),
);
const items = [{ limit: 1, page_size: "02" }, { page_size: "25" }];
const bothInItem = Request.compile(rows, { body: items });
const bothNames = Request.compile(
  Request.post("/filters").pipe(Request.body(Body.jsonSchema(Filter))),
  { body: { limit: 5, page_size: "6" } },
);
const byName = Request.post("/by-name").pipe(
  Request.body(Body.jsonSchema(Schema.Record(Schema.String, Filter))),
);
const inRecord = Request.compile(byName, {
  body: { a: { limit: 1 }, b: { page_size: "2" } },
});
// #endregion defaults
assert.equal(
  await prepared(kept),
  '{"n":"1","items":[{"page_size":"5"},{"page_size":"25"}]}',
);
assert.match(await refused(invalid), /at \["items"\]\[0\]\["page_size"\]/);
assert.match(
  await refused(bothInItem),
  /at \[0\]\["page_size"\][^]*at \[1\]\["page_size"\]/,
);
assert.match(await refused(inRecord), /at \["b"\]\["page_size"\]/);
assert.match(await refused(bothNames), /at \["page_size"\]/);
// A decoding default no longer fills a field the decoder stripped.
const Defaulted = Schema.Struct({
  limit: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("30")),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const defaulted = Request.post("/defaulted").pipe(
  Request.body(Body.jsonSchema(Schema.Array(Defaulted))),
);
const decodedItems = [{ limit: 5 }, {}] as never;
assert.match(
  await refused(Request.compile(defaulted, { body: decodedItems })),
  /at \[0\]\["limit"\]/,
);

// #region one-side
interface Row {
  readonly limit?: number;
  readonly page_size?: string;
}
/** Choose one name for each row before the schema reads it. */
const toRow = ({ limit, page_size }: Row) =>
  limit !== undefined
    ? { limit }
    : page_size !== undefined
      ? { limit: Number(page_size) }
      : {};
const save = pages.pipe(
  Request.mapInput((rows: ReadonlyArray<Row>) => ({
    body: { n: 1, items: rows.map(toRow) },
  })),
);
const oneSide = Request.compile(save, [
  { limit: 5 },
  { page_size: "6" },
  { limit: 7, page_size: "8" },
]);
// #endregion one-side
assert.equal(
  await prepared(oneSide),
  '{"n":"1","items":[{"page_size":"5"},{"page_size":"6"},{"page_size":"7"}]}',
);

// #region write
class Counted extends Schema.Class<Counted>("Counted")({ a: Schema.String }) {
  readonly reads = 1;
}
const Note = Schema.Struct({ title: Schema.String, meta: Schema.Unknown });
const Title = Schema.Struct({ title: Schema.String });
const notes = Request.post("/notes").pipe(
  Request.body(Body.jsonSchema(Schema.Union([Note, Title]))),
);
const dated = Request.compile(notes, {
  body: { title: "a", meta: new Date(0) },
});
const beside = Request.post("/beside").pipe(
  Request.body(
    Body.jsonSchema(
      Schema.Struct({
        f: Schema.Union([
          Title,
          Schema.Struct({ title: Schema.String, n: Schema.Number }),
        ]),
        c: Counted,
      }),
    ),
  ),
);
const besideClass = Request.compile(beside, {
  body: { f: { title: "a", n: 1 }, c: new Counted({ a: "x" }) },
});
// #endregion write
assert.match(await refused(dated), /Expected JSON value\s+at \["meta"\]/);
assert.equal(
  await prepared(besideClass),
  '{"f":{"title":"a","n":1},"c":{"a":"x"}}',
);

// #region open
const A = Schema.Struct({ a: Schema.String });
const tagged = Request.get("/things").pipe(
  Request.query(Schema.Union([Filter, Schema.Struct({})])),
);
const nested = Request.post("/nested").pipe(
  Request.body(
    Body.jsonSchema(Schema.Union([Schema.Struct({ b: A }), Schema.Unknown])),
  ),
);
const tag = Request.compile(tagged, { query: { limit: 5, tag: "a" } });
const below = Request.compile(nested, { body: { b: { a: "x", z: 1 } } });
// #endregion open
assert.equal(await url(tag), "/things?limit=5&tag=a");
assert.equal(await prepared(below), '{"b":{"a":"x","z":1}}');

// #region voids
const Nothing = Schema.Union([Schema.Void, Schema.Struct({})]);
const labels = Request.post("/labels").pipe(
  Request.body(Body.jsonSchema(Nothing)),
);
const ping = Request.post("/ping").pipe(
  Request.body(Body.jsonSchema(Schema.Struct({ ack: Schema.Void }))),
);
const label = Request.compile(labels, { body: { tag: "a" } });
const erased = Request.compile(ping, { body: { ack: { id: 1 } } as never });
const scalar = Request.compile(ping, { body: { ack: 5 } as never });
const empty = Request.compile(ping, { body: { ack: undefined } });
const replies = Request.post("/replies").pipe(
  Request.body(Body.jsonSchema(Schema.Union([Schema.Void, Schema.String]))),
);
const said = Request.compile(replies, { body: "hello" });
// #endregion voids
assert.equal(await prepared(label), '{"tag":"a"}');
assert.match(await refused(erased), /at \["ack"\]/);
assert.match(await refused(scalar), /Expected void\s+at \["ack"\]/);
assert.equal(await prepared(empty), '{"ack":null}');
assert.equal(await prepared(said), '"hello"');

// #region lists
const Plain = Schema.Struct({ limit: Schema.optionalKey(Schema.String) });
const listed = Request.post("/listed").pipe(
  Request.body(
    Body.jsonSchema(
      Schema.Union([
        Schema.Array(Plain),
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
  ),
);
const extraKey = [{ limit: "x", extra: 1 }];
const list = Request.compile(listed, { body: extraKey });
// #endregion lists
assert.equal(await prepared(list), '[{"limit":"x"}]');

// #region json
const raw = Request.post("/raw").pipe(Request.body(Body.json));
const open = Request.post("/open").pipe(
  Request.body(Body.jsonSchema(Schema.Record(Schema.String, Schema.Unknown))),
);
const notANumber = Request.compile(raw, { body: { v: Number.NaN } });
const map = Request.compile(raw, { body: { v: new Map([["k", "v"]]) } });
const rebuilt = Request.compile(open, {
  body: new Map([["k", "v"]]) as never,
});
const written = Request.compile(raw, {
  body: { v: Object.fromEntries(new Map([["k", "v"]])) },
});
// #endregion json
assert.match(await refused(notANumber, "HttpBodyError"), /\["v"\]/);
assert.match(await refused(map, "HttpBodyError"), /\["v"\]/);
assert.match(await refused(rebuilt), /cannot keep the content of this value/);
assert.equal(await prepared(written), '{"v":{"k":"v"}}');

// #region group-values
const find = Request.get("/find").pipe(Request.query(Schema.Any));
const object = Request.compile(find, { query: { b: { x: 1 } } });
const pair = Request.compile(find, { query: [["k", "v", "x"]] });
const text = Request.compile(find, { query: { b: JSON.stringify({ x: 1 }) } });
// #endregion group-values
assert.match(await refused(object, "InvalidRequest"), /"b"/);
assert.match(await refused(pair, "InvalidRequest"), /field pairs/);
assert.equal(await url(text), "/find?b=%7B%22x%22%3A1%7D");
