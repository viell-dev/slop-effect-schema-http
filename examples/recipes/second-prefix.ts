import assert from "node:assert/strict";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region prefix
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
const api = Request.baseUrl("https://api.example.test/v1");

const listUsers = Operation.make(
  Request.get("/users").pipe(api),
  Response.status(200, Body.jsonSchema(Schema.Array(User))),
);

const toAdmin = (base: string) => `${base}/admin`;
const inAdmin = Request.mapBaseUrl(toAdmin);

const listAdminUsers = listUsers.pipe(Operation.mapRequest(inAdmin));
// https://api.example.test/v1/admin/users
// #endregion prefix

// #region change
const toV2 = (base: string) => base.replace(/\/v1$/, "/v2");
const onV2 = Request.mapBaseUrl(toV2);

const listUsersOnV2 = listUsers.pipe(Operation.mapRequest(onV2));
// https://api.example.test/v2/users
// #endregion change

const sent: Array<string> = [];
const client = HttpClient.make((request, url) => {
  sent.push(url.href);
  return Effect.succeed(
    HttpClientResponse.fromWeb(request, new globalThis.Response("[]")),
  );
});
const provided = Effect.provideService(HttpClient.HttpClient, client);

await Effect.runPromise(listAdminUsers.execute(undefined).pipe(provided));
await Effect.runPromise(listUsersOnV2.execute(undefined).pipe(provided));
await Effect.runPromise(listUsers.execute(undefined).pipe(provided));
assert.deepEqual(sent, [
  "https://api.example.test/v1/admin/users",
  "https://api.example.test/v2/users",
  "https://api.example.test/v1/users",
]);
