import assert from "node:assert/strict";
// #region contract
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const createUser = Operation.make(
  Request.post("https://api.example.test/users").pipe(
    Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
  ),
  Response.status(
    201,
    Body.jsonSchema(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
);
// #endregion contract

// #region synthetic
const synthetic = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(JSON.stringify({ id: 42, name: "Ada" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
);

const user = await Effect.runPromise(
  createUser
    .execute({ body: { name: "Ada" } })
    .pipe(Effect.provideService(HttpClient.HttpClient, synthetic)),
);
console.log(user); // { id: 42, name: 'Ada' }
// #endregion synthetic

assert.deepEqual(user, { id: 42, name: "Ada" });
const inspected = synthetic.pipe(
  HttpClient.mapRequest((request) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://api.example.test/users");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.body._tag, "Uint8Array");
    if (request.body._tag === "Uint8Array") {
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(request.body.body)),
        { name: "Ada" },
      );
    }
    return request;
  }),
);
await Effect.runPromise(
  createUser
    .execute({ body: { name: "Ada" } })
    .pipe(Effect.provideService(HttpClient.HttpClient, inspected)),
);
