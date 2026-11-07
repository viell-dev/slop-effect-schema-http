import assert from "node:assert/strict";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region shared
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const api = Request.baseUrl("https://api.example.test");
const userId = Request.pathValue("userId", Schema.FiniteFromString);
const userPath = Request.path`/users/${userId}`;
const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
const userBody = Body.jsonSchema(User);
// #endregion shared

// #region update
const updateUser = Operation.make(
  Request.patch("").pipe(
    api,
    userPath,
    Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
  ),
  Response.status(200, userBody),
);

const rename = updateUser.execute({
  path: { userId: 42 },
  body: { name: "Grace" },
});
// PATCH https://api.example.test/users/42 with JSON { "name": "Grace" }
// Result: { id: number, name: string }
// #endregion update

// #region input-type
export type UpdateUserInput = Parameters<typeof updateUser.execute>[0];
// { readonly path: { readonly userId: string | number } }
// & { readonly body: { readonly name: string } }
// #endregion input-type

// #region remove
const deleteUser = Operation.make(
  Request.del("").pipe(api, userPath),
  Response.status(204, Body.empty),
);

const remove = deleteUser.execute({ path: { userId: 42 } });
// DELETE https://api.example.test/users/42
// Result: undefined after an HTTP 204 response with an empty body.
// #endregion remove

// #region list
const listUsers = Operation.make(
  Request.get("/users?limit=25").pipe(api),
  Response.status(200, Body.jsonSchema(Schema.Array(User))),
);
// #endregion list

// #region adjust
const firstFive = Request.setQuery("limit", "5");

const fewerUsers = listUsers.pipe(Operation.mapRequest(firstFive));
// GET https://api.example.test/users?limit=5. listUsers still asks for 25.
// #endregion adjust

// #region adjust-shape
const UserName = Schema.Struct({ name: Schema.String });
const namesOnly = Request.setQuery("fields", "name");
const asNames = Response.replace(200, Body.jsonSchema(Schema.Array(UserName)));

const listNames = listUsers.pipe(
  Operation.mapRequest(namesOnly),
  Operation.mapResponse(asNames),
);
// Result: an array of { name: string }. The whole user has left this variant's type.
// #endregion adjust-shape

// #region fetch
const overFetch = rename.pipe(Effect.provide(FetchHttpClient.layer));
// After setting your service's URL: await Effect.runPromise(overFetch).
// #endregion fetch

// #region generator
const mergeUsers = Effect.gen(function* () {
  const kept = yield* updateUser.execute({
    path: { userId: 42 },
    body: { name: "Grace" },
  });
  yield* deleteUser.execute({ path: { userId: 43 } });
  return kept;
});
// One Effect that runs both requests in order. Provide a client as above.
// #endregion generator

// #region named-function
const renameUser = Effect.fn("renameUser")(function* (
  id: number,
  name: string,
) {
  const user = yield* updateUser.execute({
    path: { userId: id },
    body: { name },
  });
  return user.name;
});

const renamed = renameUser(42, "Grace");
// An Effect again, so nothing has been sent yet.
// #endregion named-function

const received: string[] = [];
const synthetic = HttpClient.make((request, url) => {
  received.push(`${request.method} ${url.href}`);
  if (request.method === "PATCH") {
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.body._tag, "Uint8Array");
    if (request.body._tag === "Uint8Array") {
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(request.body.body)),
        { name: "Grace" },
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new globalThis.Response('{"id":42,"name":"Grace"}'),
      ),
    );
  }
  if (request.method === "GET") {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new globalThis.Response(
          url.searchParams.has("fields")
            ? '[{"name":"Grace"}]'
            : '[{"id":42,"name":"Grace"}]',
        ),
      ),
    );
  }
  assert.equal(request.method, "DELETE");
  assert.equal(request.body._tag, "Empty");
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(null, { status: 204 }),
    ),
  );
});
assert.ok(Effect.isEffect(overFetch));
assert.deepEqual(received, []);
assert.deepEqual(
  await Effect.runPromise(
    rename.pipe(Effect.provideService(HttpClient.HttpClient, synthetic)),
  ),
  { id: 42, name: "Grace" },
);
assert.equal(
  await Effect.runPromise(
    remove.pipe(Effect.provideService(HttpClient.HttpClient, synthetic)),
  ),
  undefined,
);
assert.deepEqual(received, [
  "PATCH https://api.example.test/users/42",
  "DELETE https://api.example.test/users/42",
]);

received.length = 0;
const provided = Effect.provideService(HttpClient.HttpClient, synthetic);
assert.deepEqual(await Effect.runPromise(mergeUsers.pipe(provided)), {
  id: 42,
  name: "Grace",
});
assert.equal(await Effect.runPromise(renamed.pipe(provided)), "Grace");
assert.deepEqual(
  await Effect.runPromise(listUsers.execute(undefined).pipe(provided)),
  [{ id: 42, name: "Grace" }],
);
assert.deepEqual(
  await Effect.runPromise(fewerUsers.execute(undefined).pipe(provided)),
  [{ id: 42, name: "Grace" }],
);
assert.deepEqual(
  await Effect.runPromise(listNames.execute(undefined).pipe(provided)),
  [{ name: "Grace" }],
);
assert.deepEqual(received, [
  "PATCH https://api.example.test/users/42",
  "DELETE https://api.example.test/users/43",
  "PATCH https://api.example.test/users/42",
  "GET https://api.example.test/users?limit=25",
  "GET https://api.example.test/users?limit=5",
  "GET https://api.example.test/users?limit=25&fields=name",
]);
