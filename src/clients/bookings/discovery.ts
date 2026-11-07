/**
 * Finding a region when the application starts (#97). One build can be served from any domain, so
 * it keeps a list of candidates and asks each in turn with `GET /v1/health`, which must decode: a
 * host that answers 200 with something else does not count. Nothing in the service says which
 * regions exist, and the library has no step for this. It is the consumer's own composition of an
 * ordinary operation.
 */
import {
  type Cause,
  Data,
  type Duration,
  Effect,
  Exit,
  Schedule,
} from "effect";
import { Policy } from "viell-effect-schema-http";
import { health, inRegion, type Middleware } from "./operations.js";

/** A candidate that did not count, with what it failed as. */
export interface Passed {
  readonly candidate: string;
  readonly error: unknown;
}

export interface Discovered {
  readonly base: string;
  readonly region: string;
  /** Every candidate before the chosen one, in order. */
  readonly passed: ReadonlyArray<Passed>;
}

export class NoRegion extends Data.TaggedError("NoRegion")<{
  readonly passed: ReadonlyArray<Passed>;
}> {}

export interface Search {
  /** Tried in order. The first that decodes is chosen. */
  readonly candidates: ReadonlyArray<string>;
  /** How long one candidate gets, so that a host that hangs cannot stop the search. */
  readonly attemptTimeout: Duration.Input;
  /** Client middleware to add to each probe, outside the candidate's own base. */
  readonly transformClient?: Middleware | undefined;
}

/** Ask each candidate in turn. One attempt each: the next candidate is the retry. */
export const discover = ({
  candidates,
  attemptTimeout,
  transformClient,
}: Search) =>
  Effect.gen(function* () {
    const passed: Array<Passed> = [];
    for (const candidate of candidates) {
      const exit = yield* Effect.exit(
        health({
          policy: Policy.make(Schedule.recurs(0), { attemptTimeout }),
          transformClient: (client, attempt) => {
            const based = inRegion(candidate)(client);
            return transformClient === undefined
              ? based
              : transformClient(based, attempt);
          },
        }).execute(undefined),
      );
      if (Exit.isSuccess(exit)) {
        const discovered: Discovered = {
          base: candidate,
          region: exit.value.region,
          passed,
        };
        return discovered;
      }
      const failure = exit.cause.reasons.find(
        (reason) => reason._tag === "Fail",
      );
      // With no failure in it, a cause is an interrupt or a defect, which is not a candidate's.
      if (failure === undefined)
        return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
      passed.push({ candidate, error: failure.error });
    }
    return yield* new NoRegion({ passed });
  });
