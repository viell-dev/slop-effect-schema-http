import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
// #endregion imports

// #region generated-union
const Limited = Schema.Struct({
  limit: Schema.optionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed("25")),
  ),
  other: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const limited = Request.get("https://api.example.test/things").pipe(
  Request.query(Schema.Union([Limited])),
);
const overwritten = limited.pipe(Request.setQuery("page_size", "5"));
// Compiling overwritten with {} fails with Request.InvalidRequest.
// #endregion generated-union

const error = await Effect.runPromise(
  Request.compile(overwritten, {}).pipe(Effect.flip),
);
assert.ok(error instanceof Request.InvalidRequest);
assert.match(error.message, /"page_size"/);

// #region choose-input
const explicit = Request.compile(overwritten, { query: { limit: "5" } });

const chooseLimit = (input: { readonly limit?: string }) => ({
  query: { limit: input.limit ?? "5" },
});
const fiveByDefault = limited.pipe(Request.mapInput(chooseLimit));
// #endregion choose-input

assert.equal(
  (await Effect.runPromise(explicit)).request.url,
  "https://api.example.test/things?page_size=5",
);
assert.equal(
  (await Effect.runPromise(Request.compile(fiveByDefault, {}))).request.url,
  "https://api.example.test/things?page_size=5",
);
assert.equal(
  (await Effect.runPromise(Request.compile(fiveByDefault, { limit: "7" })))
    .request.url,
  "https://api.example.test/things?page_size=7",
);

// #region same-name
const Direct = Schema.Union([
  Schema.Struct({
    limit: Schema.optionalKey(Schema.String).pipe(
      Schema.withConstructorDefault(Effect.succeed("25")),
    ),
    other: Schema.optionalKey(Schema.String),
  }),
]);
const direct = Request.get("/things").pipe(
  Request.query(Direct),
  Request.setQuery("limit", "5"),
);
// Even with another supplied field, the omitted limit is provably generated.
const refused = Request.compile(direct, { query: { other: "kept" } });
// #endregion same-name

assert.ok(
  (await Effect.runPromise(refused.pipe(Effect.flip))) instanceof
    Request.InvalidRequest,
);
