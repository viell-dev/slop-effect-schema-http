import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

// #region nested-input
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Nested = Schema.Struct({ filter: Filter });
const lookup = Request.get("").pipe(
  Request.path(
    Nested,
    (value, encode) => `/${encode(value.filter.page_size ?? "missing")}`,
  ),
);
const invalid = Request.compile(lookup, {
  path: { filter: { page_size: "many" } },
});
const encoded = Request.compile(lookup, {
  path: { filter: { page_size: "05" } },
});
const decoded = Request.compile(lookup, { path: { filter: { limit: 5 } } });
const omitted = Request.compile(lookup, { path: { filter: {} } });
// #endregion nested-input

assert.equal(
  (await Effect.runPromise(Effect.flip(invalid)))._tag,
  "SchemaError",
);
assert.equal((await Effect.runPromise(encoded)).request.url, "/5");
assert.equal((await Effect.runPromise(decoded)).request.url, "/5");
assert.equal((await Effect.runPromise(omitted)).request.url, "/25");

// #region nested-json
const batch = Request.post("https://api.example.test/search").pipe(
  Request.body(Body.jsonSchema(Schema.Struct({ page: Nested }))),
);
const validBody = Request.compile(batch, {
  body: { page: { filter: { page_size: "05" } } },
});
const invalidBody = Request.compile(batch, {
  body: { page: { filter: { page_size: "many" } } },
});
// #endregion nested-json

assert.equal(
  (await Effect.runPromise(Effect.flip(invalidBody)))._tag,
  "SchemaError",
);
const body = (await Effect.runPromise(validBody)).request.body;
assert.equal(body._tag, "Uint8Array");
if (body._tag === "Uint8Array")
  assert.equal(
    new TextDecoder().decode(body.body),
    '{"page":{"filter":{"page_size":"5"}}}',
  );

// #region decoded-mapping
interface SearchForm {
  readonly limit?: string;
}
const Form = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString),
});
const readForm = Schema.decodeUnknownEffect(Form);
const prepareSearch = Effect.fn("prepareSearch")(function* (form: SearchForm) {
  const filter = yield* readForm(form);
  return yield* Request.compile(lookup, { path: { filter } });
});
const mapped = prepareSearch({ limit: "05" });
// #endregion decoded-mapping

assert.equal((await Effect.runPromise(mapped)).request.url, "/5");
assert.equal((await Effect.runPromise(prepareSearch({}))).request.url, "/25");
assert.equal(
  (await Effect.runPromise(Effect.flip(prepareSearch({ limit: "many" }))))._tag,
  "SchemaError",
);
