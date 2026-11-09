import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
// #endregion imports

// #region fieldwise-refusal
const Filters = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  count: Schema.FiniteFromString,
  offset: Schema.FiniteFromString,
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const list = Request.get("https://api.example.test/things").pipe(
  Request.query(Filters),
);
const invalid = Request.compile(list, {
  query: { page_size: "many", count: "07", offset: 9 },
});
const mixed = Request.compile(list, {
  query: { page_size: "05", count: "07", offset: 9 },
});
// #endregion fieldwise-refusal

const sameDefault = Request.compile(list, {
  query: { page_size: "25", count: "07", offset: 9 },
});
for (const refused of [invalid, mixed, sameDefault])
  assert.equal(
    (await Effect.runPromise(Effect.flip(refused)))._tag,
    "SchemaError",
  );

// #region whole-sides
const encoded = Request.compile(list, {
  query: { page_size: "05", count: "07", offset: "09" },
});
const decoded = Request.compile(list, {
  query: { limit: 5, count: 7, offset: 9 },
});
// #endregion whole-sides

const expected = "https://api.example.test/things?page_size=5&count=7&offset=9";
for (const prepared of [encoded, decoded])
  assert.equal((await Effect.runPromise(prepared)).request.url, expected);
for (const query of [
  { count: "07", offset: 9 },
  { page_size: undefined, count: "07", offset: 9 },
])
  assert.equal(
    (await Effect.runPromise(Request.compile(list, { query }))).request.url,
    "https://api.example.test/things?page_size=25&count=7&offset=9",
  );

// #region decoded-mapping
const Form = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString),
  count: Schema.FiniteFromString,
  offset: Schema.Finite,
});
interface SearchForm {
  readonly limit?: string;
  readonly count: string;
  readonly offset: number;
}
const readForm = Schema.decodeUnknownEffect(Form);
const prepareSearch = Effect.fn("prepareSearch")(function* (form: SearchForm) {
  const query = yield* readForm(form);
  return yield* Request.compile(list, { query });
});
const mapped = prepareSearch({ limit: "05", count: "07", offset: 9 });
// #endregion decoded-mapping

assert.equal((await Effect.runPromise(mapped)).request.url, expected);
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(prepareSearch({ limit: "many", count: "07", offset: 9 })),
    )
  )._tag,
  "SchemaError",
);
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(
        prepareSearch({ limit: "05", count: "07", offset: Number.NaN }),
      ),
    )
  )._tag,
  "SchemaError",
);
