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
const refused = async <E extends { readonly _tag: string }>(
  pending: Effect.Effect<Request.Compiled, E>,
) => {
  const error = await Effect.runPromise(Effect.flip(pending));
  assert.equal(error._tag, "SchemaError");
  return String(error);
};

// #region schema
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
// Each item is a filter or one of two keywords.
const Items = Schema.Array(
  Schema.Union([Schema.Literals(["all", "none"]), Filter]),
);
const submit = Request.post("/pages").pipe(
  Request.body(Body.jsonSchema(Items)),
);
// #endregion schema

// #region literals
const invalid = Request.compile(submit, { body: [{ page_size: "many" }] });
const encoded = Request.compile(submit, { body: [{ page_size: "05" }] });
const decoded = Request.compile(submit, { body: [{ limit: 5 }] });
const omitted = Request.compile(submit, { body: [{}] });
const keywords = Request.compile(submit, {
  body: ["all", { limit: 5 }, "none"],
});
// #endregion literals
assert.match(
  await refused(invalid),
  /Expected no excess property\s+at \[0\]\["page_size"\]/,
);
assert.equal(jsonText(await Effect.runPromise(encoded)), '[{"page_size":"5"}]');
assert.equal(jsonText(await Effect.runPromise(decoded)), '[{"page_size":"5"}]');
assert.equal(
  jsonText(await Effect.runPromise(omitted)),
  '[{"page_size":"25"}]',
);
assert.equal(
  jsonText(await Effect.runPromise(keywords)),
  '["all",{"page_size":"5"},"none"]',
);

// #region complete-sides
const mixed = Request.compile(submit, {
  body: [{ page_size: "05" }, { limit: 5 }],
});
const encodedSide = Request.compile(submit, {
  body: [{ page_size: "05" }, { page_size: "5" }],
});
const decodedSide = Request.compile(submit, {
  body: [{ limit: 5 }, { limit: 7 }],
});
// #endregion complete-sides
await refused(mixed);
assert.equal(
  jsonText(await Effect.runPromise(encodedSide)),
  '[{"page_size":"5"},{"page_size":"5"}]',
);
assert.equal(
  jsonText(await Effect.runPromise(decodedSide)),
  '[{"page_size":"5"},{"page_size":"7"}]',
);

// #region nullable
const Cell = Schema.Struct({
  cell: Schema.Union([
    Schema.NullOr(Schema.String),
    Schema.Struct({ filter: Filter }),
  ]),
});
const save = Request.post("/cells").pipe(Request.body(Body.jsonSchema(Cell)));
const invalidCell = Request.compile(save, {
  body: { cell: { filter: { page_size: "many" } } },
});
const textCell = Request.compile(save, { body: { cell: "x" } });
// #endregion nullable
await refused(invalidCell);
assert.equal(jsonText(await Effect.runPromise(textCell)), '{"cell":"x"}');

// #region encoded-alternative
const Counts = Schema.Array(Schema.Union([Schema.FiniteFromString, Filter]));
const count = Request.post("/counts").pipe(
  Request.body(Body.jsonSchema(Counts)),
);
const stillDefaulted = Request.compile(count, {
  body: [{ page_size: "many" }],
});
// #endregion encoded-alternative
assert.equal(
  jsonText(await Effect.runPromise(stillDefaulted)),
  '[{"page_size":"25"}]',
);
