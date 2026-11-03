import assert from "node:assert/strict";
import { Effect } from "effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
// #region imports
import { Schema } from "effect";
import { Body, Request, Response } from "viell-effect-schema-http";
// #endregion imports

// #region json
const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
const userBody = Body.jsonSchema(User);
const createUser = Request.post("https://api.example.test/users").pipe(
  Request.body(userBody),
);
const createdUser = Response.status(201, userBody);
// Pass { body: { id: 42, name: "Ada" } } when executing createUser.
// A matching 201 response decodes to { id: number, name: string }.
// #endregion json
const compiled = await Effect.runPromise(
  Request.compile(createUser, { body: { id: 42, name: "Ada" } }),
);
const response = HttpClientResponse.fromWeb(
  compiled.request,
  new globalThis.Response(JSON.stringify({ id: 42, name: "Ada" }), {
    status: 201,
  }),
);
assert.deepEqual(
  await Effect.runPromise(Response.decode(createdUser, response)),
  {
    id: 42,
    name: "Ada",
  },
);

// #region text-schema
const countDecoder = Body.text.pipe(Body.schema(Schema.NumberFromString));
const countEncoder = Body.text.pipe(Body.encodeSchema(Schema.NumberFromString));
// The decoder reads "42" as the number 42; the encoder writes 42 as text "42".
// #endregion text-schema
const countResponse = HttpClientResponse.fromWeb(
  HttpClientRequest.get("https://api.example.test/count"),
  new globalThis.Response("42"),
);
assert.equal(await Effect.runPromise(countDecoder.decode(countResponse)), 42);
const countBody = await Effect.runPromise(countEncoder.encode(42));
assert.equal(countBody._tag, "Uint8Array");
if (countBody._tag === "Uint8Array")
  assert.equal(new TextDecoder().decode(countBody.body), "42");

// #region map
const trimmedText = Body.text.pipe(Body.map((text) => text.trim()));
// #endregion map
assert.equal(
  await Effect.runPromise(
    trimmedText.decode(
      HttpClientResponse.fromWeb(
        countResponse.request,
        new globalThis.Response(" ready \n"),
      ),
    ),
  ),
  "ready",
);
