import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
// #endregion imports

// #region encoded-input
const Filters = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const list = Request.get("https://api.example.test/things").pipe(
  Request.query(Filters),
);
const encoded = Request.compile(list, { query: { page_size: "05" } });
const decoded = Request.compile(list, { query: { limit: 5 } });
// #endregion encoded-input

assert.equal(
  (await Effect.runPromise(encoded)).request.url,
  "https://api.example.test/things?page_size=5",
);
assert.equal(
  (await Effect.runPromise(decoded)).request.url,
  "https://api.example.test/things?page_size=5",
);

// #region helper-input
interface SearchInput {
  readonly term?: string;
  readonly limit?: number;
}
const chooseFilters = (input: SearchInput) => ({
  query: {
    ...(input.term === undefined ? {} : { term: input.term }),
    limit: input.limit ?? 25,
  },
});
const search = list.pipe(Request.mapInput(chooseFilters));
// #endregion helper-input

assert.equal(
  (await Effect.runPromise(Request.compile(search, { limit: 7 }))).request.url,
  "https://api.example.test/things?page_size=7",
);
assert.equal(
  (await Effect.runPromise(Request.compile(search, {}))).request.url,
  "https://api.example.test/things?page_size=25",
);
