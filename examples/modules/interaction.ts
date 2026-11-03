import assert from "node:assert/strict";
// #region imports
import { Effect } from "effect";
import { Interaction } from "viell-effect-schema-http";
// #endregion imports

// #region simple
let executions = 0;
const lookup = (id: number) =>
  Effect.sync(() => {
    executions++;
    return { id, name: "Ada" };
  });

const users = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const interaction = yield* Interaction.make(lookup);
      const first = yield* interaction.run(42);
      const again = yield* interaction.run(42);
      return [first, again];
    }),
  ),
);
// Both values are { id: 42, name: "Ada" }; lookup ran once.
// The interaction closes when this scope ends.
// #endregion simple
assert.equal(executions, 1);
assert.deepEqual(users, [
  { id: 42, name: "Ada" },
  { id: 42, name: "Ada" },
]);

// #region refresh
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const interaction = yield* Interaction.make(lookup);
      yield* interaction.run(42);
      yield* interaction.run(42, { force: true }); // run lookup again
    }),
  ),
);
// #endregion refresh
assert.equal(executions, 3);

// #region options
const acquireSearch = Interaction.make(
  (input: { query: string }) => Effect.succeed([input.query]),
  {
    equivalence: (left, right) => left.query === right.query,
    retain: (results) => results.length > 0,
  },
);
// #endregion options
const matches = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const search = yield* acquireSearch;
      return yield* search.run({ query: "Ada" });
    }),
  ),
);
assert.deepEqual(matches, ["Ada"]);
