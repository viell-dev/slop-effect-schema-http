import { Effect } from "effect";
import type { Backend, Lane } from "./lane.js";
import { fetchClient, linesLayer, rawLayer } from "./providers.js";
import { loadHandler } from "./registry.js";
import { serve } from "./server.js";

/** The Node lane: backends run in this process, and every client provider is available. */
export const lane: Lane = {
  name: "node",
  backend: (name, options, start) =>
    Effect.gen(function* () {
      const handler = yield* Effect.promise(() => loadHandler(name, options));
      const server = yield* serve(handler, undefined, start?.listener);
      const backend: Backend = {
        origin: server.origin,
        ledger: Effect.sync(() =>
          server.ledger.map((received) => ({
            method: received.method,
            target: received.target,
            lines: received.lines,
            head: received.head,
            body: received.body,
            aborted: received.aborted(),
            connection: received.connection,
            connectionOpen: received.connectionOpen(),
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
  rawClient: rawLayer,
};
