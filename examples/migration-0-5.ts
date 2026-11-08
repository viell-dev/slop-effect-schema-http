import assert from "node:assert/strict";
// #region imports
import { Effect, Schema, SchemaGetter } from "effect";
import { Request } from "viell-effect-schema-http";

const things = "https://api.example.test/things";
// #endregion imports

// #region generated
const trimLimit = (value: string) => value.trim();
const Limited = Schema.Struct({
  limit: Schema.optionalKey(Schema.String).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.withDefault(Effect.succeed("25")),
      encode: SchemaGetter.transform(trimLimit),
    }),
  ),
});
const limited = Request.get(things).pipe(Request.query(Limited));
const ineffectiveEdit = limited.pipe(Request.setQuery("limit", "5"));
// Compiling ineffectiveEdit with {} fails with Request.InvalidRequest.
// #endregion generated

const error = await Effect.runPromise(
  Request.compile(ineffectiveEdit, {}).pipe(Effect.flip),
);
assert.ok(error instanceof Request.InvalidRequest);
assert.match(error.message, /"limit"/);
assert.equal(error.cause, undefined);

// #region choose-input
const chooseLimit = (input: { readonly limit?: string }) => ({
  query: { limit: input.limit ?? "5" },
});
const fiveByDefault = limited.pipe(Request.mapInput(chooseLimit));
// An absent limit now sends 5; a caller can still choose another limit.
// #endregion choose-input

const urlOf = async <I, E>(request: Request.Request<I, E>, input: I) =>
  (await Effect.runPromise(Request.compile(request, input))).request.url;
assert.equal(await urlOf(fiveByDefault, {}), `${things}?limit=5`);
assert.equal(await urlOf(fiveByDefault, { limit: " 7 " }), `${things}?limit=7`);
assert.equal(
  await urlOf(ineffectiveEdit, { query: { limit: " 9 " } }),
  `${things}?limit=9`,
);

// A field that writes no value still permits a raw default.
const optional = Request.get(things).pipe(
  Request.query(Schema.Struct({ limit: Schema.optionalKey(Schema.String) })),
  Request.setQuery("limit", "5"),
);
assert.equal(await urlOf(optional, {}), `${things}?limit=5`);
