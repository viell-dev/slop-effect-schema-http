import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const things = "https://api.example.test/things";
// #endregion imports

// #region renamed-default
const Limited = Schema.Struct({
  limit: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("25")),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const limited = Request.get(things).pipe(Request.query(Limited));
const overwritten = limited.pipe(Request.setQuery("page_size", "5"));
// Compiling overwritten with {} now fails with Request.InvalidRequest.
// #endregion renamed-default

const error = await Effect.runPromise(
  Request.compile(overwritten, {}).pipe(Effect.flip),
);
assert.ok(error instanceof Request.InvalidRequest);
assert.match(error.message, /"page_size"/);

// #region choose-input
const chooseLimit = (input: { readonly limit?: number }) => ({
  query: { limit: input.limit ?? 5 },
});
const fiveByDefault = limited.pipe(Request.mapInput(chooseLimit));
// #endregion choose-input

const urlOf = async <I, E>(request: Request.Request<I, E>, input: I) =>
  (await Effect.runPromise(Request.compile(request, input))).request.url;
assert.equal(await urlOf(fiveByDefault, {}), `${things}?page_size=5`);
assert.equal(await urlOf(fiveByDefault, { limit: 7 }), `${things}?page_size=7`);
assert.equal(
  await urlOf(overwritten, { query: { page_size: "7" } }),
  `${things}?page_size=7`,
);

// #region stacked-union
const B = Schema.Struct({ b: Schema.String });
const AC = Schema.Struct({ a: Schema.String, c: Schema.String });
const combined = Request.get(things).pipe(
  Request.query(Schema.Union([B, AC])),
  Request.query(B),
);
const prepared = Request.compile(combined, {
  query: { a: "x", b: "y", c: "z" },
});
// The union supplies a and c; the other binding supplies b.
// #endregion stacked-union

const result = await Effect.runPromise(prepared);
const widerFirst = Request.get(things).pipe(
  Request.query(Schema.Union([AC, B])),
  Request.query(B),
);
assert.equal(
  result.request.url,
  await urlOf(widerFirst, { query: { a: "x", b: "y", c: "z" } }),
);
assert.deepEqual([...new URL(result.request.url).searchParams].toSorted(), [
  ["a", "x"],
  ["b", "y"],
  ["c", "z"],
]);
