import assert from "node:assert/strict";
// #region imports
import { Effect, Option, Schema } from "effect";
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

// #region whole-group
const opaque = Option.some({ keep: "x", extra: "schema-owned" });
const Mixed = Schema.Struct({
  filter: Filter,
  count: Schema.FiniteFromString,
  opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
});
const mixed = Request.get("").pipe(
  Request.path(Mixed, ({ filter, count }) => `/${filter.page_size}/${count}`),
);
// Even the same text as the default cannot bypass validation of the whole encoded group.
const mixedInput = Request.compile(mixed, {
  path: { filter: { page_size: "25" }, count: 3, opaque },
});
const mappedInput = Request.compile(mixed, {
  path: { filter: { limit: 25 }, count: 3, opaque },
});
const completeEncodedInput = Request.compile(mixed, {
  path: { filter: { page_size: "25" }, count: "3", opaque },
});
// #endregion whole-group

assert.equal(
  (await Effect.runPromise(Effect.flip(mixedInput)))._tag,
  "SchemaError",
);
assert.equal((await Effect.runPromise(mappedInput)).request.url, "/25/3");
assert.equal(
  (await Effect.runPromise(completeEncodedInput)).request.url,
  "/25/3",
);

// #region shared-text
const Shared = Schema.Struct({
  filter: Filter,
  shared: Schema.StringFromBase64,
  opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
});
const sharedText = Request.get("").pipe(
  Request.path(Shared, ({ shared }, encode) => `/${encode(shared)}`),
);
const encodedGroup = Request.compile(sharedText, {
  path: { filter: { page_size: "25" }, shared: "eA==", opaque },
});
const decodedGroup = Request.compile(sharedText, {
  path: { filter: { limit: 25 }, shared: "eA==", opaque },
});
// #endregion shared-text

assert.equal((await Effect.runPromise(encodedGroup)).request.url, "/eA%3D%3D");
assert.equal(
  (await Effect.runPromise(decodedGroup)).request.url,
  "/ZUE9PQ%3D%3D",
);
