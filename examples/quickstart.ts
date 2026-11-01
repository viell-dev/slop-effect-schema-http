import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

// #region contract
const getUser = Operation.make(
  Request.get("https://api.example.test/users").pipe(
    Request.path(
      Schema.NumberFromString,
      (id, encode) => `https://api.example.test/users/${encode(id)}`,
    ),
  ),
  Response.status(
    200,
    Body.jsonSchema(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
);
// #endregion contract

// #region synthetic
const synthetic = HttpClient.make((request, url) => {
  assert.equal(url.href, "https://api.example.test/users/42");
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(JSON.stringify({ id: 42, name: "Ada" }), {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});
const user = await Effect.runPromise(
  getUser
    .execute({ path: 42 })
    .pipe(Effect.provideService(HttpClient.HttpClient, synthetic)),
);
console.log(user); // { id: 42, name: 'Ada' }
// #endregion synthetic

assert.deepEqual(user, { id: 42, name: "Ada" });

// #region fetch
const overFetch = getUser
  .execute({ path: 42 })
  .pipe(Effect.provide(FetchHttpClient.layer));
// Evaluate with Effect.runPromise(overFetch) after replacing the example endpoint with a real service.
// #endregion fetch

// Construction stays cold: the example executes only the synthetic client above.
assert.ok(Effect.isEffect(overFetch));
