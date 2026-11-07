import assert from "node:assert/strict";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
// #region imports
import { Data, Effect, Schema } from "effect";
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
const countDecoder = Body.text.pipe(Body.schema(Schema.FiniteFromString));
const countEncoder = Body.text.pipe(Body.encodeSchema(Schema.FiniteFromString));
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
const trimmed = (text: string) => text.trim();

const trimmedText = Body.text.pipe(Body.map(trimmed));
// #endregion map

// #region map-effect
class ServiceBusy extends Data.TaggedError("ServiceBusy")<{
  readonly text: string;
}> {}

const readyOrBusy = Effect.fn("readyOrBusy")(function* (text: string) {
  if (text !== "ready") return yield* new ServiceBusy({ text });
  return text;
});

const readyText = Body.text.pipe(Body.mapEffect(readyOrBusy));
// "ready" decodes to "ready". Other text fails with ServiceBusy.
// #endregion map-effect
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(
        readyText.decode(
          HttpClientResponse.fromWeb(
            HttpClientRequest.get("https://api.example.test/status"),
            new globalThis.Response("busy"),
          ),
        ),
      ),
    )
  )._tag,
  "ServiceBusy",
);
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
