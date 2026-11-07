import assert from "node:assert/strict";
// #region options
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const getPrices = Operation.make(
  Request.get("https://api.example.test/v1/prices"),
  Response.status(200, Body.text),
);

const noStore = Effect.provideService(FetchHttpClient.RequestInit, {
  cache: "no-store",
});

const freshPrices = getPrices.execute(undefined).pipe(noStore);
const anyPrices = getPrices.execute(undefined);
// #endregion options

// #region program
const program = Effect.gen(function* () {
  const fresh = yield* freshPrices;
  const usual = yield* anyPrices;
  return { fresh, usual };
}).pipe(Effect.provide(FetchHttpClient.layer));
// #endregion program

// The real Fetch client, with only the fetch function replaced.
const inits: Array<RequestInit | undefined> = [];
const recordingFetch: typeof globalThis.fetch = (_input, init) => {
  inits.push(init);
  return Promise.resolve(new globalThis.Response("12"));
};
const recorded = Effect.provideService(FetchHttpClient.Fetch, recordingFetch);

assert.deepEqual(await Effect.runPromise(program.pipe(recorded)), {
  fresh: "12",
  usual: "12",
});
assert.equal(inits[0]?.cache, "no-store");
assert.equal(inits[1]?.cache, undefined);

// The client's own fields win: method and signal cannot come from RequestInit, and a
// request's headers win over headers supplied there.
inits.length = 0;
const overriding = Effect.provideService(FetchHttpClient.RequestInit, {
  method: "DELETE",
  headers: { accept: "application/xml", "x-extra": "kept" },
});
await Effect.runPromise(
  getPrices
    .execute(undefined)
    .pipe(overriding, Effect.provide(FetchHttpClient.layer), recorded),
);
assert.equal(inits[0]?.method, "GET");
const headers = inits[0]?.headers as Record<string, string>;
assert.equal(headers["accept"], "text/plain");
assert.equal(headers["x-extra"], "kept");
assert.ok(inits[0]?.signal instanceof AbortSignal);

// A provided value replaces an outer one rather than merging with it.
inits.length = 0;
await Effect.runPromise(
  getPrices.execute(undefined).pipe(
    noStore,
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
    Effect.provide(FetchHttpClient.layer),
    recorded,
  ),
);
assert.equal(inits[0]?.cache, "no-store");
assert.equal(inits[0]?.credentials, undefined);
