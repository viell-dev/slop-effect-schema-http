import assert from "node:assert/strict";
import { HttpClientResponse } from "effect/http";
// #region service
import { Context, Effect, Layer, Ref, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";

class ApiBase extends Context.Service<ApiBase, Ref.Ref<string>>()(
  "app/ApiBase",
) {}

const currentBase = ApiBase.pipe(Effect.flatMap(Ref.get));
const onApi = Request.baseUrl(currentBase);

const Order = Schema.Struct({ id: Schema.Number });
const listOrders = Operation.make(
  Request.get("/orders").pipe(onApi),
  Response.status(200, Body.jsonSchema(Schema.Array(Order))),
);
// #endregion service

// #region discover
const candidates = [
  "https://api.example.test",
  "https://api-eu.example.test",
] as const;

const Health = Schema.Struct({ service: Schema.Literal("orders-api") });
const oneQuickAttempt = Policy.make(Schedule.recurs(0), {
  attemptTimeout: "2 seconds",
});

const probe = (base: string) =>
  Operation.make(
    Request.get("/health").pipe(Request.baseUrl(base)),
    Response.status(200, Body.jsonSchema(Health)),
    { policy: oneQuickAttempt },
  )
    .execute(undefined)
    .pipe(Effect.as(base));

const discover = Effect.firstSuccessOf(candidates.map(probe));
const discovered = Layer.effect(
  ApiBase,
  discover.pipe(Effect.flatMap(Ref.make)),
);
// #endregion discover

// #region move
const moveToWorkingServer = Effect.gen(function* () {
  const current = yield* ApiBase;
  yield* Ref.set(current, yield* discover);
});
// #endregion move

// #region within-a-call
const serverFor = (attempt: number) =>
  candidates[(attempt - 1) % candidates.length] ?? candidates[0];
const toServer = (self: HttpClient.HttpClient, attempt: number) =>
  HttpClient.mapRequest(self, HttpClientRequest.prependUrl(serverFor(attempt)));

const readOrdersAnywhere = Operation.make(
  Request.get("/orders"),
  Response.status(200, Body.jsonSchema(Schema.Array(Order))),
  {
    policy: Policy.make(Schedule.recurs(candidates.length - 1)),
    transformClient: toServer,
  },
);
// #endregion within-a-call

// #region cached
const rememberedOnSuccess = Effect.gen(function* () {
  const [lookup, forget] = yield* Effect.cachedInvalidateWithTTL(
    discover,
    "1 hour",
  );
  return lookup.pipe(Effect.tapError(() => forget));
});
// #endregion cached

const sent: Array<string> = [];
let answers: (url: URL) => globalThis.Response = () =>
  new globalThis.Response("[]");
const client = HttpClient.make((request, url) => {
  sent.push(url.href);
  return Effect.succeed(HttpClientResponse.fromWeb(request, answers(url)));
});
const provided = Effect.provideService(HttpClient.HttpClient, client);

const healthy = () => new globalThis.Response('{"service":"orders-api"}');
const parked = () =>
  new globalThis.Response("<html>This domain is parked</html>");
const anotherService = () =>
  new globalThis.Response('{"service":"something-else"}');

// A parked page and another service are both refused by the probe's response schema.
for (const refused of [parked, anotherService]) {
  sent.length = 0;
  answers = (url) => {
    if (url.pathname === "/orders") return new globalThis.Response("[]");
    return url.hostname === "api.example.test" ? refused() : healthy();
  };
  await Effect.runPromise(
    listOrders.execute(undefined).pipe(Effect.provide(discovered), provided),
  );
  assert.deepEqual(sent, [
    "https://api.example.test/health",
    "https://api-eu.example.test/health",
    "https://api-eu.example.test/orders",
  ]);
}

// Between calls, the next evaluation reads the moved base.
sent.length = 0;
answers = (url) => {
  if (url.pathname === "/orders") return new globalThis.Response("[]");
  return url.hostname === "api.example.test" ? parked() : healthy();
};
await Effect.runPromise(
  Effect.gen(function* () {
    const current = yield* Ref.make("https://retired.example.test");
    const session = Effect.provideService(ApiBase, current);
    yield* listOrders.execute(undefined).pipe(session);
    yield* moveToWorkingServer.pipe(session);
    yield* listOrders.execute(undefined).pipe(session);
  }).pipe(provided),
);
assert.deepEqual(sent, [
  "https://retired.example.test/orders",
  "https://api.example.test/health",
  "https://api-eu.example.test/health",
  "https://api-eu.example.test/orders",
]);

// Within a call, a retry moves to the next server.
sent.length = 0;
answers = (url) =>
  url.hostname === "api.example.test"
    ? new globalThis.Response(null, { status: 503 })
    : new globalThis.Response('[{"id":1}]');
assert.deepEqual(
  await Effect.runPromise(readOrdersAnywhere.execute(undefined).pipe(provided)),
  [{ id: 1 }],
);
assert.deepEqual(sent, [
  "https://api.example.test/orders",
  "https://api-eu.example.test/orders",
]);

// Effect.cached keeps a failure, so a working server is never tried again.
let reachable = false;
answers = () =>
  reachable ? healthy() : new globalThis.Response(null, { status: 503 });
sent.length = 0;
await Effect.runPromise(
  Effect.gen(function* () {
    const lookup = yield* Effect.cached(discover);
    yield* Effect.flip(lookup);
    reachable = true;
    yield* Effect.flip(lookup);
  }).pipe(provided),
);
assert.equal(sent.length, candidates.length);

// Keeping only a success tries again, and then reuses the answer.
reachable = false;
sent.length = 0;
assert.equal(
  await Effect.runPromise(
    Effect.gen(function* () {
      const lookup = yield* rememberedOnSuccess;
      yield* Effect.flip(lookup);
      reachable = true;
      const base = yield* lookup;
      yield* lookup;
      return base;
    }).pipe(provided),
  ),
  "https://api.example.test",
);
assert.equal(sent.length, candidates.length + 1);

// A discovery with no working server fails the layer, with nothing kept.
reachable = false;
const failed = await Effect.runPromiseExit(
  listOrders.execute(undefined).pipe(Effect.provide(discovered), provided),
);
assert.equal(failed._tag, "Failure");
