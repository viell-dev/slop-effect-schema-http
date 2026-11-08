import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
// #endregion imports

// #region encoded-input
const Filters = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  term: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const list = Request.get("https://api.example.test/things").pipe(
  Request.query(Filters),
);
const invalid = Request.compile(list, { query: { page_size: "many" } });
const valid = Request.compile(list, { query: { page_size: "05" } });
const omitted = Request.compile(list, { query: {} });
// #endregion encoded-input

assert.equal(
  (await Effect.runPromise(Effect.flip(invalid)))._tag,
  "SchemaError",
);
assert.equal(
  (await Effect.runPromise(valid)).request.url,
  "https://api.example.test/things?page_size=5",
);
assert.equal(
  (await Effect.runPromise(omitted)).request.url,
  "https://api.example.test/things?page_size=25",
);

// #region decoded-input
interface SearchInput {
  readonly pageSize?: number;
}
const chooseFilters = (input: SearchInput) => ({
  query: { limit: input.pageSize ?? 25 },
});
const search = list.pipe(Request.mapInput(chooseFilters));
// #endregion decoded-input

assert.equal(
  (await Effect.runPromise(Request.compile(search, { pageSize: 5 }))).request
    .url,
  "https://api.example.test/things?page_size=5",
);
assert.equal(
  (await Effect.runPromise(Request.compile(search, {}))).request.url,
  "https://api.example.test/things?page_size=25",
);

// #region stacked-input
const Cursor = Schema.Struct({ cursor: Schema.String });
const paged = Request.get("https://api.example.test/things").pipe(
  Request.query(Schema.Union([Filters, Cursor])),
  Request.query(Cursor),
);
const next = Request.compile(paged, {
  query: { page_size: "05", cursor: "next" },
});
// #endregion stacked-input

assert.equal(
  (await Effect.runPromise(next)).request.url,
  "https://api.example.test/things?page_size=5&cursor=next",
);
