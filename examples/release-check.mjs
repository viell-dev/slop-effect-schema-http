import assert from "node:assert/strict";
import console from "node:console";
import { Cause, Effect, Exit, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

// Synthetic service: no network, account, credentials or real service data.
let dispatches = 0;
const client = HttpClient.make((request, url) => {
  dispatches++;
  const body = url.pathname.endsWith("/2")
    ? { id: "wrong type", name: "Ada" }
    : { id: 42, name: "Ada" };
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});
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
const run = (path) =>
  Effect.runPromiseExit(
    getUser
      .execute({ path })
      .pipe(Effect.provideService(HttpClient.HttpClient, client)),
  );
const success = await run(42);
assert.ok(Exit.isSuccess(success));
assert.deepEqual(success.value, { id: 42, name: "Ada" });
console.log("Success:", success.value);

const beforeInvalid = dispatches;
const invalidInput = await run("not a number");
assert.ok(Exit.isFailure(invalidInput));
assert.equal(dispatches, beforeInvalid);
console.log("Invalid input: rejected before dispatch.");

const invalidResponse = await run(2);
assert.ok(Exit.isFailure(invalidResponse));
const error = Cause.findErrorOption(invalidResponse.cause);
assert.equal(error._tag, "Some");
assert.equal(error.value._tag, "DecodeError");
console.log("Invalid response: DecodeError after dispatch.");
console.log("Candidate check passed. Read and adapt getUser to try the API.");
