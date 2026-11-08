import assert from "node:assert/strict";
// #region annotated-union
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const Term = Schema.Struct({ term: Schema.String });
const FilterRange = Schema.Struct({ from: Schema.String, to: Schema.String });
const Filters = Schema.Union([Term, FilterRange]).annotate({
  title: "Search filters",
  description: "A term or a range of labels",
});
const search = Request.get("https://api.example.test/search").pipe(
  Request.query(Filters),
  Request.query(Term),
);
const prepared = Request.compile(search, {
  query: { term: "schema", from: "a", to: "z" },
});
// The range keeps from/to, the other binding keeps term, and Filters keeps its annotations.
// #endregion annotated-union

const compiled = await Effect.runPromise(prepared);
assert.equal(
  compiled.request.url,
  "https://api.example.test/search?from=a&to=z&term=schema",
);
