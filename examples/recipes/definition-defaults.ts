import assert from "node:assert/strict";
// #region required
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";

const Limit = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);
const things = "https://api.example.test/things";

const alwaysLimited = Request.get(things).pipe(
  Request.query(
    Schema.Struct({
      limit: Limit.pipe(Schema.withConstructorDefault(Effect.succeed(25))),
    }),
  ),
);
// Input: {}; query: ?limit=25. Input: { query: { limit: "5" } }; query: ?limit=5.
// #endregion required

// #region removable
const removableLimit = Request.get(things).pipe(
  Request.query(Schema.Struct({ limit: Schema.optional(Limit) })),
  Request.setQuery("limit", "25"),
);
const withoutLimit = removableLimit.pipe(Request.removeQuery("limit"));
// Input: {}. removableLimit sends ?limit=25; withoutLimit sends no query.
// #endregion removable

// #region owned
const forSummary = (input: { readonly search: string }) => ({
  query: { limit: 5, search: input.search },
});
const summary = Request.get(things).pipe(
  Request.query(Schema.Struct({ limit: Limit, search: Schema.NonEmptyString })),
  Request.mapInput(forSummary),
);
// Input: { search: "widgets" }; query: ?limit=5&search=widgets.
// #endregion owned

const urlOf = async <I, E>(request: Request.Request<I, E>, input: I) =>
  (await Effect.runPromise(Request.compile(request, input))).request.url;

assert.equal(await urlOf(alwaysLimited, {}), `${things}?limit=25`);
assert.equal(
  await urlOf(alwaysLimited, { query: { limit: "5" } }),
  `${things}?limit=5`,
);
assert.equal(await urlOf(removableLimit, {}), `${things}?limit=25`);
assert.equal(
  await urlOf(removableLimit, { query: { limit: 10 } }),
  `${things}?limit=10`,
);
assert.equal(await urlOf(withoutLimit, {}), things);
assert.equal(
  await urlOf(summary, { search: "widgets" }),
  `${things}?limit=5&search=widgets`,
);

// An explicitly constructed mapping keeps the fixed value even with wider runtime input.
const widerInput = { search: "widgets", limit: 100 };
assert.equal(
  await urlOf(summary, widerInput),
  `${things}?limit=5&search=widgets`,
);

const cannotRemove = alwaysLimited.pipe(Request.removeQuery("limit"));
const removal = await Effect.runPromise(
  Effect.flip(Request.compile(cannotRemove, {})),
);
assert.ok(removal instanceof Request.InvalidRequest);
assert.match(removal.message, /limit/);

for (const input of [{ query: { limit: "many" } }, { query: { limit: 0 } }]) {
  const failure = await Effect.runPromise(
    Effect.flip(Request.compile(alwaysLimited, input)),
  );
  assert.ok(Schema.isSchemaError(failure));
}
const invalidSearch = await Effect.runPromise(
  Effect.flip(Request.compile(summary, { search: "" })),
);
assert.ok(Schema.isSchemaError(invalidSearch));

// A raw default does not satisfy a required caller field.
const requiredInput = Request.get(things).pipe(
  Request.setQuery("limit", "25"),
  Request.query(Schema.Struct({ limit: Limit })),
);
const stillMissing = await Effect.runPromise(
  // @ts-expect-error: the required schema input still needs limit.
  Effect.flip(Request.compile(requiredInput, {})),
);
assert.ok(Schema.isSchemaError(stillMissing));

const checkInput = () => {
  // @ts-expect-error: a defaulted group is optional, but the invocation object is required.
  void Request.compile(alwaysLimited, undefined);
  const fixed: Request.InputOf<typeof summary> = {
    search: "widgets",
    // @ts-expect-error: limit belongs to the definition, not its caller input.
    limit: 100,
  };
  return fixed;
};
void checkInput;
