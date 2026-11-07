import assert from "node:assert/strict";
import { HttpClientResponse } from "effect/http";
// #region provide
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const getThing = Operation.make(
  Request.get("https://api.example.test/v1/things/1"),
  Response.status(
    200,
    Body.jsonSchema(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
);

const noTraceHeaders = Effect.provideService(
  HttpClient.TracerPropagationEnabled,
  false,
);
const quietly = getThing.execute(undefined).pipe(noTraceHeaders);
// #endregion provide

// #region layer
const browserClient = Layer.merge(
  FetchHttpClient.layer,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);
const everywhere = getThing
  .execute(undefined)
  .pipe(Effect.provide(browserClient));
// #endregion layer

const headersSeen: Array<ReadonlyArray<string>> = [];
const client = HttpClient.make((request) => {
  headersSeen.push(Object.keys(request.headers));
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response('{"id":1,"name":"first"}'),
    ),
  );
});
const provided = Effect.provideService(HttpClient.HttpClient, client);

await Effect.runPromise(getThing.execute(undefined).pipe(provided));
assert.ok(headersSeen[0]?.includes("traceparent"));
assert.ok(headersSeen[0]?.includes("b3"));

await Effect.runPromise(quietly.pipe(provided));
assert.ok(!headersSeen[1]?.includes("traceparent"));
assert.ok(!headersSeen[1]?.includes("b3"));

// The layer form reaches the real Fetch client.
const fetched: Array<Record<string, string>> = [];
const recordingFetch: typeof globalThis.fetch = (_input, init) => {
  fetched.push(init?.headers as Record<string, string>);
  return Promise.resolve(new globalThis.Response('{"id":1,"name":"first"}'));
};
await Effect.runPromise(
  everywhere.pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch)),
);
assert.equal(fetched[0]?.["traceparent"], undefined);
assert.equal(fetched[0]?.["b3"], undefined);
