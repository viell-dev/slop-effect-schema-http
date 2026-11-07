import assert from "node:assert/strict";
import { HttpClient } from "effect/http";
// #region decoder
import { Effect, Schema } from "effect";
import { HttpClientResponse } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const created = Body.jsonSchema(Schema.Struct({ id: Schema.Number }));
const readId = Schema.decodeUnknownEffect(Schema.FiniteFromString);
const lastSegment = (location: string) =>
  location.slice(location.lastIndexOf("/") + 1);

const createdId = Body.decoder(
  Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
    const location = response.headers["location"];
    if (location === undefined) {
      const { id } = yield* created.decode(response);
      return id;
    }
    yield* Body.empty.decode(response);
    return yield* readId(lastSegment(location));
  }),
  created.mediaType,
);
// #endregion decoder

// #region operation
const createThing = Operation.make(
  Request.post("https://api.example.test/v1/things").pipe(
    Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
  ),
  Response.status(201, createdId),
);
// The result is the new ID, as a number, from either place.
// #endregion operation

const answering = (response: globalThis.Response) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, response)),
    ),
  );
const input = { body: { name: "first" } };

const fromHeader = new globalThis.Response("ignored", {
  status: 201,
  headers: { location: "/v1/things/42" },
});
assert.equal(
  await Effect.runPromise(
    createThing.execute(input).pipe(answering(fromHeader)),
  ),
  42,
);
// The unused body was read to its end rather than left open.
assert.equal(fromHeader.bodyUsed, true);

assert.equal(
  await Effect.runPromise(
    createThing
      .execute(input)
      .pipe(answering(new globalThis.Response('{"id":43}', { status: 201 }))),
  ),
  43,
);

const unreadable = await Effect.runPromise(
  Effect.flip(createThing.execute(input)).pipe(
    answering(
      new globalThis.Response(null, {
        status: 201,
        headers: { location: "/v1/things/latest" },
      }),
    ),
  ),
);
assert.equal(unreadable._tag, "DecodeError");

const noIdAtAll = await Effect.runPromise(
  Effect.flip(createThing.execute(input)).pipe(
    answering(new globalThis.Response("{}", { status: 201 })),
  ),
);
assert.equal(noIdAtAll._tag, "DecodeError");
