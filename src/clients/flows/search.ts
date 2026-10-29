/**
 * APP-1: the task search box, one `Interaction` over the business search. The search runs with the
 * connection's late-bound credential, so changing the token in the one source reaches the next
 * execution without closing the interaction.
 *
 * - Blank input never reaches the service, which refuses it with `400 query_required`. It still
 *   goes through the same gate, so clearing the box supersedes a search in flight.
 * - Only a decoded hit list is retained. A mapped `401` is a success in Effect's terms, a member of
 *   the result union, so retaining it would replay a stale refusal after the token changed.
 */
import { Effect, type Scope } from "effect";
import type { HttpClient } from "effect/http";
import { Interaction } from "viell-effect-schema-http";
import * as Ops from "../business/operations.js";

/** The box was cleared: no request was sent. */
export interface Cleared {
  readonly _tag: "Cleared";
}

export const cleared: Cleared = { _tag: "Cleared" };

type Searched = ReturnType<ReturnType<typeof Ops.searchTasks>["execute"]>;

/** What the box shows: the search's own result union, or the cleared box. */
export type Outcome = Effect.Success<Searched> | Cleared;
export type Failure = Effect.Error<Searched>;

/** One search, or the cleared box for blank input. */
export const search = (connection: Ops.Connection) => {
  const operation = Ops.searchTasks(connection);
  return (
    text: string,
  ): Effect.Effect<Outcome, Failure, HttpClient.HttpClient> =>
    text.trim() === ""
      ? Effect.succeed(cleared)
      : operation.execute({ query: { q: text } });
};

/** Keep only a hit list for reuse; refusals and the cleared box run again. */
export const retainResults = (outcome: Outcome): boolean =>
  outcome._tag === "Results";

/** The search box, acquired in the current scope with the services in context. */
export const searchBox = (
  connection: Ops.Connection,
): Effect.Effect<
  Interaction.Interaction<string, Outcome, Failure>,
  never,
  HttpClient.HttpClient | Scope.Scope
> => Interaction.make(search(connection), { retain: retainResults });
