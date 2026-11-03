import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

// #region simple
const listUsers = Request.get("https://api.example.test/users").pipe(
  Request.setQuery("limit", "10"),
  Request.setHeader("accept-language", "en"),
);
const compiled = await Effect.runPromise(Request.compile(listUsers, undefined));
// compiled.request.url === "https://api.example.test/users?limit=10"
// Nothing has been sent.
// #endregion simple
assert.equal(compiled.request.url, "https://api.example.test/users?limit=10");
assert.equal(compiled.request.headers["accept-language"], "en");

// #region inputs
const updateUser = Request.patch("/users").pipe(
  Request.baseUrl("https://api.example.test"),
  Request.path(Schema.NumberFromString, (id, encode) => `/users/${encode(id)}`),
  Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
);
const update = await Effect.runPromise(
  Request.compile(updateUser, { path: 42, body: { name: "Ada" } }),
);
// PATCH https://api.example.test/users/42, JSON body { "name": "Ada" }
// #endregion inputs
assert.equal(update.request.url, "https://api.example.test/users/42");
assert.equal(update.request.method, "PATCH");
assert.equal(update.request.headers["content-type"], "application/json");

// #region query
const search = Request.get("https://api.example.test/users").pipe(
  Request.query(Schema.Struct({ page: Schema.NumberFromString })),
  Request.headers(Schema.Struct({ "accept-language": Schema.String })),
);
const page = await Effect.runPromise(
  Request.compile(search, {
    query: { page: 2 },
    headers: { "accept-language": "en" },
  }),
);
// page.request.url === "https://api.example.test/users?page=2"
// #endregion query
assert.equal(page.request.url, "https://api.example.test/users?page=2");

// #region adapt
const renameUser = updateUser.pipe(
  Request.mapInput((input: { id: number; name: string }) => ({
    path: input.id,
    body: { name: input.name },
  })),
);
const renamed = await Effect.runPromise(
  Request.compile(renameUser, { id: 42, name: "Grace" }),
);
// #endregion adapt
assert.equal(renamed.request.url, update.request.url);
