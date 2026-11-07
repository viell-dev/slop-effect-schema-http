/**
 * Reading a region's ledger the way a test must: a server learns of a close from its socket, some
 * time after the client saw it, so anything about a connection is read in a bounded loop rather
 * than after a pause.
 */
import { Effect } from "effect";
import { type Backend, pathOf, type Recorded } from "../../harness/lane.js";

const pause = "10 millis";
const reads = 1000;

/** Read `source` until `done` accepts it, or fail the test with what it last held. */
export const until = <A, E, R>(
  source: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  what: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    let value = yield* source;
    for (let read = 0; read < reads && !done(value); read++) {
      yield* Effect.sleep(pause);
      value = yield* source;
    }
    if (!done(value))
      return yield* Effect.die(new Error(`${what} never showed`));
    return value;
  });

/** The arrivals of one method and path, in order. */
export const arrivals = (
  ledger: ReadonlyArray<Recorded>,
  method: string,
  path: string,
): ReadonlyArray<Recorded> =>
  ledger.filter(
    (recorded) => recorded.method === method && pathOf(recorded) === path,
  );

/** Wait until the arrival at `index` shows its connection closed, and return the ledger. */
export const closed = (backend: Backend, index: number) =>
  until(
    backend.ledger,
    (ledger) => ledger[index]?.connectionOpen === false,
    `arrival ${index} with its connection closed`,
  );

/** Wait until the arrival at `index` shows the client left and its connection closed. */
export const aborted = (backend: Backend, index: number) =>
  until(
    backend.ledger,
    (ledger) =>
      ledger[index]?.aborted === true && ledger[index].connectionOpen === false,
    `arrival ${index} aborted, with its connection closed`,
  );
