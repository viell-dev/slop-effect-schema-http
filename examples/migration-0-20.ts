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
) => {
  const error = await Effect.runPromise(Effect.flip(pending));
  assert.equal(error._tag, "SchemaError");
  return String(error);
};
const post = <S extends Schema.Top>(schema: S) =>
  Request.post("/things").pipe(Request.body(Body.jsonSchema(schema)));

// #region payload
const Owner = Schema.Struct({ owner: Schema.String });
const Wide = Schema.Struct({ owner: Schema.String, limit: Schema.Number });
const Filter = Schema.Union([Owner, Wide]);
const value = { owner: "a", limit: 5, stray: 1 };

const inList = Request.compile(
  post(Schema.Struct({ held: Schema.OptionFromNullOr(Schema.Array(Filter)) })),
  { body: { held: Option.some([value]) } },
);
const configured = Request.compile(
  post(
    Schema.Struct({
      held: Schema.OptionFromOptionalNullOr(Filter, { onNoneEncoding: null }),
    }),
  ),
  { body: { held: Option.some(value) } },
);
const competing = Request.compile(
  post(
    Schema.Struct({
      held: Schema.Union([
        Schema.OptionFromNullOr(Filter),
        Schema.OptionFromUndefinedOr(Filter),
      ]),
    }),
  ),
  { body: { held: Option.some(value) } },
);
// #endregion payload
assert.equal(await prepared(inList), '{"held":[{"owner":"a","limit":5}]}');
assert.equal(await prepared(configured), '{"held":{"owner":"a","limit":5}}');
assert.equal(await prepared(competing), '{"held":{"owner":"a","limit":5}}');

// #region wrapper
const Held = Schema.Struct({
  a: Schema.optionalKey(Schema.String),
  b: Schema.optionalKey(Schema.String),
});
const Counter = Schema.Struct({
  held: Schema.OptionFromNullOr(Held),
  count: Schema.FiniteFromString,
});
const beside = Request.compile(post(Counter), {
  body: { held: Option.some({ a: "a", b: "keep" }), count: "2" },
});
const Renamed = Schema.Struct({ held: Schema.OptionFromNullOr(Held) }).pipe(
  Schema.encodeKeys({ held: "wire_held" }),
);
const atWireName = Request.compile(post(Renamed), {
  body: { wire_held: Option.some({ a: "x" }) } as never,
});
const decodedSide = Request.compile(post(Renamed), {
  body: { held: Option.some({ a: "x" }) },
});
const encodedSide = Request.compile(post(Renamed), {
  body: { wire_held: { a: "x" } },
});
// #endregion wrapper
assert.equal(
  await prepared(beside),
  '{"held":{"a":"a","b":"keep"},"count":"2"}',
);
assert.match(await refused(atWireName), /\["held"\]/);
assert.equal(await prepared(decodedSide), '{"wire_held":{"a":"x"}}');
assert.equal(await prepared(encodedSide), '{"wire_held":{"a":"x"}}');

// #region inner-value
const Inner = Schema.Struct({ value: Schema.Struct({ a: Schema.String }) });
const Either = Schema.Struct({
  held: Schema.OptionFromNullOr(
    Schema.Union([Inner, Schema.Struct({ a: Schema.String })]),
  ),
});
const collision = Request.compile(post(Either), {
  body: { held: Option.some({ value: { a: "inner" }, a: "outer" }) },
});
const inner = Request.compile(post(Either), {
  body: { held: Option.some({ value: { a: "inner" } }) },
});
// #endregion inner-value
assert.match(await refused(collision), /\["held"\]\["value"\]\["a"\]/);
assert.equal(await prepared(inner), '{"held":{"value":{"a":"inner"}}}');

// #region built-ins
const Meta = Schema.Struct({
  held: Schema.Struct({ a: Schema.optionalKey(Schema.String) }),
});
const date = Request.compile(post(Meta), {
  body: { held: new Date(0) } as never,
});
const plain = Request.compile(post(Meta), { body: { held: {} } });
// #endregion built-ins
assert.match(await refused(date), /cannot keep this Date as an object/);
assert.equal(await prepared(plain), '{"held":{}}');

// #region one-of
const Optional = Schema.Struct({ a: Schema.optionalKey(Schema.String) });
const oneOf = Schema.Struct({
  f: Schema.Union([Schema.Void, Optional], { mode: "oneOf" }),
});
const anyOf = Schema.Struct({ f: Schema.Union([Schema.Void, Optional]) });
const ambiguous = Request.compile(post(oneOf), { body: { f: {} } });
const firstFit = Request.compile(post(anyOf), { body: { f: {} } });
const chosen = Request.compile(post(oneOf), { body: { f: undefined } });
// #endregion one-of
assert.match(await refused(ambiguous), /Expected exactly one member to match/);
assert.equal(await prepared(firstFit), '{"f":null}');
assert.equal(await prepared(chosen), '{"f":null}');

// #region class
class Counted extends Schema.Class<Counted>("Counted")({ a: Schema.String }) {
  readonly tally = 1;
}
const Loose = Schema.Struct({ b: Schema.optionalKey(Schema.String) });
const instance = Request.compile(post(Schema.Union([Loose, Counted])), {
  body: new Counted({ a: "item" }),
});
const renamedClass = Request.compile(
  post(Schema.Union([Loose, Counted.pipe(Schema.encodeKeys({ a: "A" }))])),
  { body: new Counted({ a: "item" }) },
);
// #endregion class
assert.equal(await prepared(instance), '{"a":"item"}');
assert.equal(await prepared(renamedClass), '{"A":"item"}');

// #region messages
const Page = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const bothNames = Request.compile(post(Page), {
  body: { limit: 5, page_size: "6" },
});
const decodedInvalid = Request.compile(post(Page), {
  body: { limit: "x" } as never,
});
// #endregion messages
assert.match(
  await refused(bothNames),
  /given under both "limit" and "page_size"; give it under one name\s+at \["page_size"\]/,
);
assert.match(await refused(decodedInvalid), /Expected number\s+at \["limit"\]/);

// #region error-class
class Failed extends Schema.Error<Failed>("Failed")({ id: Schema.Number }) {}
const Report = Schema.Struct({ held: Failed });
const fromInstance = Request.compile(post(Report), {
  body: { held: new Failed({ id: 1 }) },
});
const fromData = Request.compile(post(Report), {
  body: { held: { id: 1 } },
});
const EitherShape = Schema.Struct({
  held: Schema.Union([Failed, Schema.Struct({ id: Schema.Number })]),
});
const inUnion = Request.compile(post(EitherShape), {
  body: { held: new Failed({ id: 1 }) },
});
// #endregion error-class
assert.equal(await prepared(fromInstance), '{"held":{"id":1}}');
assert.equal(await prepared(fromData), '{"held":{"id":1}}');
assert.match(
  await refused(inUnion),
  /cannot keep this Error as an object\s+at \["held"\]/,
);
