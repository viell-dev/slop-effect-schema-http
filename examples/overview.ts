import assert from "node:assert/strict";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region contract
import { Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const getUser = Operation.make(
  Request.get("https://api.example.test/users/42"),
  Response.status(
    200,
    Body.jsonSchema(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
);

const readUser = getUser.execute(undefined);
// An Effect that will produce { id: number, name: string } when run with a client.
// #endregion contract

let calls = 0;
const synthetic = HttpClient.make((request, url) => {
  calls++;
  assert.equal(request.method, "GET");
  assert.equal(url.href, "https://api.example.test/users/42");
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response('{"id":42,"name":"Ada"}'),
    ),
  );
});
assert.equal(calls, 0);
assert.deepEqual(
  await Effect.runPromise(
    readUser.pipe(Effect.provideService(HttpClient.HttpClient, synthetic)),
  ),
  { id: 42, name: "Ada" },
);
assert.equal(calls, 1);
