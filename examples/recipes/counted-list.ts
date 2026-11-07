import assert from "node:assert/strict";
import { HttpClient } from "effect/http";
// #region decoders
import { Effect, Schema } from "effect";
import { HttpClientResponse } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const Thing = Schema.Struct({ id: Schema.Number, name: Schema.String });
const Count = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const readCount = Schema.decodeUnknownEffect(Count);
const rows = Body.jsonSchema(Schema.Array(Thing));

const rowsWithTotal = Body.decoder(
  Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
    const total = yield* readCount(response.headers["x-total-count"]);
    const items = yield* rows.decode(response);
    return { items, total };
  }),
  rows.mediaType,
);
const noRows = Body.empty.pipe(Body.map(() => ({ items: [], total: 0 })));
// #endregion decoders

// #region operation
const listThings = Operation.make(
  Request.get("https://api.example.test/v1/things"),
  Response.status(200, rowsWithTotal).pipe(
    Response.orElse(Response.status(204, noRows)),
  ),
);
// Both answers give { items, total }.
// #endregion operation

const answering = (response: globalThis.Response) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, response)),
    ),
  );
const row = { id: 1, name: "first" };
const page = (headers: Record<string, string>) =>
  new globalThis.Response(JSON.stringify([row]), { headers });

assert.deepEqual(
  await Effect.runPromise(
    listThings
      .execute(undefined)
      .pipe(answering(page({ "x-total-count": "120" }))),
  ),
  { items: [row], total: 120 },
);
assert.deepEqual(
  await Effect.runPromise(
    listThings
      .execute(undefined)
      .pipe(answering(new globalThis.Response(null, { status: 204 }))),
  ),
  { items: [], total: 0 },
);

// A malformed, fractional, negative or absent count is a DecodeError, not a wrong total.
for (const headers of [
  { "x-total-count": "many" },
  { "x-total-count": "1.5" },
  { "x-total-count": "-1" },
  {},
]) {
  const failure = await Effect.runPromise(
    Effect.flip(listThings.execute(undefined)).pipe(
      answering(page(headers as Record<string, string>)),
    ),
  );
  assert.equal(failure._tag, "DecodeError");
}
