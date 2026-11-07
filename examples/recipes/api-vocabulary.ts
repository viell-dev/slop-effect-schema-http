import assert from "node:assert/strict";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region vocabulary
import { flow, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const paged = (page: number, size: number) => Request.setQuery({ page, size });
const sorted = (field: string) => Request.setQuery({ sort: field });
const embedded = (...relations: ReadonlyArray<string>) =>
  Request.setQuery({ embed: relations.join(",") });

const Thing = Schema.Struct({ id: Schema.Number, name: Schema.String });
const api = Request.baseUrl("https://api.example.test/v1");
const getThings = Operation.make(
  Request.get("/things").pipe(api, paged(0, 25)),
  Response.status(200, Body.jsonSchema(Schema.Array(Thing))),
);
// #endregion vocabulary

// #region use
const firstFifty = paged(0, 50);
const byName = sorted("name");
const withOwner = embedded("owner");

const thingTable = getThings.pipe(
  Operation.mapRequest(firstFifty),
  Operation.mapRequest(byName),
  Operation.mapRequest(withOwner),
);
// ?page=0&size=50&sort=name&embed=owner
// #endregion use

// #region compose
const tableDefaults = flow(firstFifty, byName, withOwner);

const sameTable = getThings.pipe(Operation.mapRequest(tableDefaults));
// #endregion compose

// #region typed
const Paging = Schema.Struct({
  page: Schema.optional(Schema.FiniteFromString),
  size: Schema.optional(Schema.FiniteFromString),
});
const Sorting = Schema.Struct({
  sort: Schema.optional(Schema.Literals(["name", "created"])),
});

const pageable = Request.query(Paging);
const sortable = Request.query(Sorting);

const searchThings = Operation.make(
  Request.get("/things").pipe(api, paged(0, 25), pageable, sortable),
  Response.status(200, Body.jsonSchema(Schema.Array(Thing))),
);

const secondPage = searchThings.execute({ query: { page: 1, sort: "name" } });
// ?page=1&size=25&sort=name, because size keeps its default
// #endregion typed

const sent: Array<string> = [];
const client = HttpClient.make((request, url) => {
  sent.push(url.href);
  return Effect.succeed(
    HttpClientResponse.fromWeb(request, new globalThis.Response("[]")),
  );
});
const provided = Effect.provideService(HttpClient.HttpClient, client);

await Effect.runPromise(thingTable.execute(undefined).pipe(provided));
await Effect.runPromise(sameTable.execute(undefined).pipe(provided));
await Effect.runPromise(getThings.execute(undefined).pipe(provided));
await Effect.runPromise(secondPage.pipe(provided));
assert.deepEqual(sent, [
  "https://api.example.test/v1/things?page=0&size=50&sort=name&embed=owner",
  "https://api.example.test/v1/things?page=0&size=50&sort=name&embed=owner",
  "https://api.example.test/v1/things?page=0&size=25",
  "https://api.example.test/v1/things?page=1&size=25&sort=name",
]);

// A raw edit has to fit the schema, and that check runs when the request is prepared.
const unsortable = searchThings.pipe(Operation.mapRequest(sorted("price")));
const refused = await Effect.runPromise(
  Effect.flip(unsortable.execute({ query: {} })).pipe(provided),
);
assert.equal(refused._tag, "InvalidRequest");
assert.equal(sent.length, 4);
