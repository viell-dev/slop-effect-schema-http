import assert from "node:assert/strict";
// #region imports
import { Data, Effect, flow, identity, Schedule, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
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

// #region per-attempt
const regionOf = (attempt: number) =>
  attempt === 1 ? "https://eu.example.test" : "https://us.example.test";
const toRegion = (self: HttpClient.HttpClient, attempt: number) =>
  HttpClient.mapRequest(self, HttpClientRequest.prependUrl(regionOf(attempt)));

const regionalHealth = Operation.make(
  Request.get("/health"),
  Response.status(200, Body.text),
  {
    policy: Policy.make(Schedule.recurs(1)),
    transformClient: toRegion,
  },
);
// The first attempt goes to the EU region, and a retry goes to the US region.
// #endregion per-attempt
const regionsTried: Array<string> = [];
const onlyUsAnswers = HttpClient.make((request) => {
  regionsTried.push(request.url);
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.startsWith("https://us.")
        ? new globalThis.Response("ready")
        : new globalThis.Response(null, { status: 503 }),
    ),
  );
});
assert.equal(
  await Effect.runPromise(
    regionalHealth
      .execute(undefined)
      .pipe(Effect.provideService(HttpClient.HttpClient, onlyUsAnswers)),
  ),
  "ready",
);
assert.deepEqual(regionsTried, [
  "https://eu.example.test/health",
  "https://us.example.test/health",
]);

// #region adapt
const greet = Operation.fromEffect((name: string) =>
  Effect.succeed(`Hello, ${name}`),
);
const greeting = await Effect.runPromise(greet.execute("Ada"));
// greeting === "Hello, Ada"
// #endregion adapt
assert.equal(greeting, "Hello, Ada");

// #region define
const Thing = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.String,
});
const ThingOption = Schema.Struct({ id: Schema.Number, name: Schema.String });
const Problem = Schema.Struct({ detail: Schema.String });

const api = Request.baseUrl("https://api.example.test/v1");
const notFound = Response.status(
  404,
  Response.tag("Missing", Body.jsonSchema(Problem)),
);

const getThings = Operation.make(
  Request.get("/things?page=1&limit=25").pipe(api),
  Response.status(200, Body.jsonSchema(Schema.Array(Thing))).pipe(
    Response.orElse(notFound),
  ),
);
// #endregion define

// #region adjust
const firstFive = Request.setQuery("limit", "5");

const fewerThings = getThings.pipe(Operation.mapRequest(firstFive));
// fewerThings asks for 5. getThings still asks for 25.
// #endregion adjust

// #region shape
const withoutPaging = Request.removeQuery("page");
const idAndNameOnly = Request.setQuery({ limit: "all", fields: "id,name" });
const asOptions = Response.replace(
  200,
  Body.jsonSchema(Schema.Array(ThingOption)),
);

const thingOptions = getThings.pipe(
  Operation.mapRequest(withoutPaging),
  Operation.mapRequest(idAndNameOnly),
  Operation.mapResponse(asOptions),
);
// The result is the list of options or the Missing case. Thing is gone from the type.
// #endregion shape

// #region options
const retryTwice = Policy.make(Schedule.recurs(2));

const patientThings = getThings.pipe(
  Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
);
// #endregion options

// #region mapped
const ThingPage = Schema.Struct({ data: Schema.Array(Thing) });
const OptionPage = Schema.Struct({ data: Schema.Array(ThingOption) });

class NotFound extends Data.TaggedError("NotFound")<{
  readonly detail: string;
}> {}

const dataOrNotFound = <D>(
  outcome:
    | Response.Tagged<"Found", { readonly data: D }>
    | Response.Tagged<"Missing", typeof Problem.Type>,
) =>
  outcome._tag === "Found"
    ? Effect.succeed(outcome.value.data)
    : Effect.fail(new NotFound({ detail: outcome.value.detail }));

const listThings = Operation.make(
  Request.get("/things?page=1&limit=25").pipe(api),
  Response.status(200, Response.tag("Found", Body.jsonSchema(ThingPage))).pipe(
    Response.orElse(notFound),
  ),
).pipe(Operation.mapEffect(dataOrNotFound));

// A request or options change just works, and the mapping stays.
const fewerListed = listThings.pipe(
  Operation.mapRequest(firstFive),
  Operation.mapOptions((options) => ({ ...options, policy: retryTwice })),
);

// A response change the mapping still fits works too.
const noMissing = Response.remove(404);

const noNotFound = listThings.pipe(Operation.mapResponse(noMissing));
// #endregion mapped

// #region unmap
const asOptionPage = Response.replace(
  200,
  Response.tag("Found", Body.jsonSchema(OptionPage)),
);

const listOptions = listThings.pipe(
  Operation.unmap,
  Operation.mapRequest(withoutPaging),
  Operation.mapRequest(idAndNameOnly),
  Operation.mapResponse(asOptionPage),
  Operation.mapEffect(dataOrNotFound),
);
// #endregion unmap

// #region flow
const forDropdown = flow(
  identity<typeof listThings>,
  Operation.unmap,
  Operation.mapRequest(withoutPaging),
  Operation.mapRequest(idAndNameOnly),
  Operation.mapResponse(asOptionPage),
  Operation.mapEffect(dataOrNotFound),
);

const dropdownOptions = forDropdown(listThings);
// #endregion flow

// #region generator
const namesOnly = Effect.fn("namesOnly")(function* (
  things: ReadonlyArray<typeof Thing.Type>,
) {
  yield* Effect.logDebug(`Read ${things.length} things`);
  return things.map((thing) => thing.name);
});

const thingNames = listThings.pipe(Operation.mapEffect(namesOnly));
// #endregion generator

// #region decoder
const unwrapped = Operation.make(
  Request.get("/things").pipe(api),
  Response.status(
    200,
    Body.jsonSchema(ThingPage).pipe(Body.map((page) => page.data)),
  ).pipe(Response.orElse(notFound)),
);

const asPlainOptions = Response.replace(
  200,
  Body.jsonSchema(Schema.Array(ThingOption)),
);

const unwrappedOptions = unwrapped.pipe(Operation.mapResponse(asPlainOptions));
// The 200 case and its conversion left together, and no unmap was needed.
// #endregion decoder

// #region limit
// Offer one adjustment, and nothing else about the definition.
const thingsOnPage = (page: number) =>
  getThings.pipe(Operation.mapRequest(Request.setQuery({ page })));

// Offer no adjustment at all. The types stay the same, and there are no parts.
const fixedThings = Operation.fromEffect(getThings.execute);
// #endregion limit

const fullThing = { id: 1, name: "first", description: "synthetic" };
const answering = (status: number, body: unknown, urls?: Array<string>) =>
  HttpClient.make((request, url) => {
    urls?.push(url.href);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new globalThis.Response(JSON.stringify(body), { status }),
      ),
    );
  });
const dispatched = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  provider: HttpClient.HttpClient,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(HttpClient.HttpClient, provider)),
  );

const sent: Array<string> = [];
await dispatched(
  fewerThings.execute(undefined),
  answering(200, [fullThing], sent),
);
await dispatched(
  getThings.execute(undefined),
  answering(200, [fullThing], sent),
);
assert.deepEqual(sent, [
  "https://api.example.test/v1/things?page=1&limit=5",
  "https://api.example.test/v1/things?page=1&limit=25",
]);

sent.length = 0;
assert.deepEqual(
  await dispatched(
    thingOptions.execute(undefined),
    answering(200, [{ id: 1, name: "first" }], sent),
  ),
  [{ id: 1, name: "first" }],
);
assert.deepEqual(sent, [
  "https://api.example.test/v1/things?limit=all&fields=id%2Cname",
]);

let attempts = 0;
const flaky = HttpClient.make((request) =>
  Effect.sync(() =>
    HttpClientResponse.fromWeb(
      request,
      attempts++ === 0
        ? new globalThis.Response("{}", { status: 503 })
        : new globalThis.Response(JSON.stringify([fullThing])),
    ),
  ),
);
await dispatched(patientThings.execute(undefined), flaky);
assert.equal(attempts, 2);

assert.deepEqual(
  await dispatched(
    fewerListed.execute(undefined),
    answering(200, { data: [fullThing] }),
  ),
  [fullThing],
);
assert.ok(
  (await dispatched(
    Effect.flip(listThings.execute(undefined)),
    answering(404, { detail: "no such thing" }),
  )) instanceof NotFound,
);
assert.equal(
  (
    await dispatched(
      Effect.flip(noNotFound.execute(undefined)),
      answering(404, { detail: "no such thing" }),
    )
  )._tag,
  "UnexpectedResponse",
);
assert.deepEqual(
  await dispatched(
    listOptions.execute(undefined),
    answering(200, { data: [{ id: 1, name: "first" }] }),
  ),
  [{ id: 1, name: "first" }],
);
assert.deepEqual(
  await dispatched(
    dropdownOptions.execute(undefined),
    answering(200, { data: [{ id: 1, name: "first" }] }),
  ),
  [{ id: 1, name: "first" }],
);
assert.deepEqual(
  await dispatched(
    thingNames.execute(undefined),
    answering(200, { data: [fullThing] }),
  ),
  ["first"],
);
assert.deepEqual(
  await dispatched(
    unwrappedOptions.execute(undefined),
    answering(200, [{ id: 1, name: "first" }]),
  ),
  [{ id: 1, name: "first" }],
);

sent.length = 0;
await dispatched(
  thingsOnPage(2).execute(undefined),
  answering(200, [fullThing], sent),
);
assert.deepEqual(sent, ["https://api.example.test/v1/things?page=2&limit=25"]);
assert.equal(fixedThings.parts, undefined);
