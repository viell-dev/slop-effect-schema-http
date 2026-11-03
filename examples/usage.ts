import assert from "node:assert/strict";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region shared
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const api = Request.baseUrl("https://api.example.test");
const userPath = Request.path(
  Schema.Struct({ userId: Schema.NumberFromString }),
  ({ userId }, encode) => `/users/${encode(userId)}`,
);
const userBody = Body.jsonSchema(
  Schema.Struct({ id: Schema.Number, name: Schema.String }),
);
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
// { readonly path: { readonly userId: number } }
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

// #region fetch
const overFetch = rename.pipe(Effect.provide(FetchHttpClient.layer));
// After setting your service's URL: await Effect.runPromise(overFetch).
// #endregion fetch

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
