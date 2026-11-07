import assert from "node:assert/strict";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region define
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const Thing = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.String,
});
const Problem = Schema.Struct({ detail: Schema.String });

const api = Request.baseUrl("https://api.example.test/v1");
const missing = Response.status(
  404,
  Response.tag("Missing", Body.jsonSchema(Problem)),
);
const thingId = Request.pathValue("id", Schema.FiniteFromString);

const getThings = Operation.make(
  Request.get("/things?page=1&limit=25").pipe(api),
  Response.status(
    200,
    Response.tag("Found", Body.jsonSchema(Schema.Array(Thing))),
  ).pipe(Response.orElse(missing)),
);

const getThing = Operation.make(
  Request.get("").pipe(api, Request.path`/things/${thingId}`),
  Response.status(200, Response.tag("Found", Body.jsonSchema(Thing))).pipe(
    Response.orElse(missing),
  ),
);
// #endregion define

// #region adjust
const ThingOption = Schema.Struct({ id: Schema.Number, name: Schema.String });

const withoutPaging = Request.removeQuery("page");
const idAndNameOnly = Request.setQuery({ limit: "all", fields: "id,name" });
const asOptions = Response.replace(
  200,
  Response.tag("Found", Body.jsonSchema(Schema.Array(ThingOption))),
);

const thingOptions = getThings.pipe(
  Operation.mapRequest(withoutPaging),
  Operation.mapRequest(idAndNameOnly),
  Operation.mapResponse(asOptions),
);
// #endregion adjust

// #region run
const openPicker = Effect.gen(function* () {
  const options = yield* thingOptions.execute(undefined);
  const selected = yield* getThing.execute({ path: { id: 42 } });
  return {
    options: options._tag === "Found" ? options.value : [],
    selected: selected._tag === "Found" ? selected.value : undefined,
  };
});
// #endregion run

const first = { id: 42, name: "first", description: "synthetic" };
const sent: Array<string> = [];
const client = HttpClient.make((request, url) => {
  sent.push(url.href);
  const body = url.pathname.endsWith("/things")
    ? [{ id: 42, name: "first" }]
    : first;
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(JSON.stringify(body)),
    ),
  );
});
const provided = Effect.provideService(HttpClient.HttpClient, client);

assert.deepEqual(await Effect.runPromise(openPicker.pipe(provided)), {
  options: [{ id: 42, name: "first" }],
  selected: first,
});
assert.deepEqual(sent, [
  "https://api.example.test/v1/things?limit=all&fields=id%2Cname",
  "https://api.example.test/v1/things/42",
]);

// The original definition is unchanged: it still asks for a page of whole things,
// so an answer without a description fails it.
const original = await Effect.runPromise(
  Effect.flip(getThings.execute(undefined)).pipe(provided),
);
assert.equal(original._tag, "DecodeError");
assert.equal(sent.at(-1), "https://api.example.test/v1/things?page=1&limit=25");

// The error case came through the variant, and the component reads each outcome.
const absent = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response('{"detail":"nothing here"}', { status: 404 }),
    ),
  ),
);
const noThings = Effect.provideService(HttpClient.HttpClient, absent);
const outcome = await Effect.runPromise(
  thingOptions.execute(undefined).pipe(noThings),
);
assert.equal(outcome._tag, "Missing");
assert.deepEqual(await Effect.runPromise(openPicker.pipe(noThings)), {
  options: [],
  selected: undefined,
});
