/**
 * Node-only scenarios of the business API's operations part. They are about the line-preserving
 * `node:http` provider, which a browser does not have, so they cannot run in the browser lane.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import * as Ops from "../clients/business/operations.js";
import { header, headerValues } from "../harness/lane.js";

const token = "test-token-ops-v2";

const start = () => lane.backend("business", { operations: { token } });

const connect = (backend: { readonly origin: string }): Ops.Connection => ({
  baseUrl: `${backend.origin}/v2`,
  credential: () => token,
});

const lines = () => {
  if (lane.linesClient === undefined)
    throw new Error("the Node lane provides linesClient");
  return lane.linesClient;
};

describe("business operations: line-preserving provider (node)", () => {
  it.live(
    "[STAT-11] the tunnel needs nothing from the provider; node:http sends the body-less POST chunked",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const deleted = yield* Ops.deleteTask(connect(backend)).execute({
          path: Schema.decodeSync(Ops.TaskId)("T-1002"),
        });
        expect(deleted._tag).toBe("Deleted");
        const [request] = yield* backend.ledger;
        expect(request!.method).toBe("POST");
        expect(headerValues(request!.lines, "x-http-method-override")).toEqual([
          "DELETE",
        ]);
        // Fixture fact: node:http sends a body-less POST with chunked framing and no Content-Length,
        // where Fetch sends `content-length: 0`. The service accepts both.
        expect(header(request!.lines, "transfer-encoding")).toBe("chunked");
        expect(header(request!.lines, "content-length")).toBeUndefined();
      }).pipe(Effect.provide(lines())),
  );

  it.live(
    "[HDR-8] the line-preserving provider carries the header and the cache key, without a cache mode",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const connection = connect(backend);
        yield* Ops.purgePrices(connection).execute(undefined);
        let next = 0;
        const result = yield* Ops.prices(
          connection,
          Ops.bypassEdgeCache(() => `k${++next}`),
        ).execute(undefined);
        expect(result.metadata.headers["x-cache"]).toBe("MISS");
        const [, request] = yield* backend.ledger;
        expect(request!.target).toBe("/v2/catalog/prices?v=k1");
        expect(headerValues(request!.lines, "cache-control")).toEqual([
          "no-cache",
        ]);
        // The cache mode is a Fetch option; this provider ignores it, so no Pragma is added.
        expect(header(request!.lines, "pragma")).toBeUndefined();
      }).pipe(Effect.provide(lines())),
  );
});
