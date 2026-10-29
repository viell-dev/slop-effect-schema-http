import { Effect } from "effect";
import type { Backend, Lane } from "./lane.js";
import { fetchClient, linesLayer } from "./providers.js";
import { loadHandler } from "./registry.js";
import { serve } from "./server.js";

/** The Node lane: backends run in this process, and both client providers are available. */
export const lane: Lane = {
  name: "node",
  backend: (name, options) =>
    Effect.gen(function* () {
      const handler = yield* Effect.promise(() => loadHandler(name, options));
      const server = yield* serve(handler);
      const backend: Backend = {
        origin: server.origin,
        ledger: Effect.sync(() =>
          server.ledger.map((received) => ({
            method: received.method,
            target: received.target,
            lines: received.lines,
            body: received.body,
            aborted: received.aborted(),
          })),
        ),
        arrived: (count) => Effect.promise(() => server.arrived(count)),
      };
      return backend;
    }),
  clients: [
    ["lines", linesLayer],
    ["fetch", fetchClient],
  ],
  fetchClient,
  linesClient: linesLayer,
};
