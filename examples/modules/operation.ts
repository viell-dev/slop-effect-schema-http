import assert from "node:assert/strict";
// #region imports
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
// #endregion imports

// #region simple
const health = Operation.make(
  Request.get("https://api.example.test/health"),
  Response.status(200, Body.text),
);
const program = health
  .execute(undefined)
  .pipe(Effect.provide(FetchHttpClient.layer));
// Replace the example URL with your service, then run Effect.runPromise(program).
// Merely constructing program sends nothing.
// #endregion simple
assert.ok(Effect.isEffect(program));

// #region synthetic
const client = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(request, new globalThis.Response("ready")),
  ),
);
const result = await Effect.runPromise(
  health
    .execute(undefined)
    .pipe(Effect.provideService(HttpClient.HttpClient, client)),
);
// result === "ready"; this client made no network request.
// #endregion synthetic
assert.equal(result, "ready");

// #region map
const isReady = health.pipe(Operation.map((text) => text === "ready"));
const requireReady = health.pipe(
  Operation.mapEffect((text) =>
    text === "ready"
      ? Effect.succeed(text)
      : Effect.fail("ServiceNotReady" as const),
  ),
);
// #endregion map
assert.equal(
  await Effect.runPromise(
    isReady
      .execute(undefined)
      .pipe(Effect.provideService(HttpClient.HttpClient, client)),
  ),
  true,
);
assert.equal(
  await Effect.runPromise(
    requireReady
      .execute(undefined)
      .pipe(Effect.provideService(HttpClient.HttpClient, client)),
  ),
  "ready",
);

// #region failures
const handled = health
  .execute(undefined)
  .pipe(
    Effect.catchTag("UnexpectedResponse", (error) =>
      Effect.succeed(`Unhandled status: ${error.metadata.status}`),
    ),
  );
// Other typed failures still propagate; this handles only UnexpectedResponse.
// #endregion failures
const missing = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response("missing", { status: 404 }),
    ),
  ),
);
assert.equal(
  await Effect.runPromise(
    handled.pipe(Effect.provideService(HttpClient.HttpClient, missing)),
  ),
  "Unhandled status: 404",
);

// #region adapt
const greet = Operation.fromEffect((name: string) =>
  Effect.succeed(`Hello, ${name}`),
);
const greeting = await Effect.runPromise(greet.execute("Ada"));
// greeting === "Hello, Ada"
// #endregion adapt
assert.equal(greeting, "Hello, Ada");
