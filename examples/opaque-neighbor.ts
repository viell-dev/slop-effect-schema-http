import assert from "node:assert/strict";
// #region opaque-neighbor
import { Effect, Option, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";

const Search = Schema.Struct({
  filter: Schema.Union([
    Schema.Struct({ owner: Schema.String }),
    Schema.Struct({ owner: Schema.String, team: Schema.String }),
  ]),
  cache: Schema.Option(Schema.Struct({ etag: Schema.String })),
});
const search = Request.post("https://api.example.test/search").pipe(
  Request.body(Body.jsonSchema(Search)),
);
const prepared = Request.compile(search, {
  body: {
    filter: { owner: "ada", team: "core" },
    cache: Option.some({ etag: "v1", local: "opaque" }),
  },
});
// The filter keeps owner and team; the opaque cache follows its schema's reading.
// #endregion opaque-neighbor

const compiled = await Effect.runPromise(prepared);
assert.equal(compiled.request.body._tag, "Uint8Array");
if (compiled.request.body._tag === "Uint8Array") {
  const text = new TextDecoder().decode(compiled.request.body.body);
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      filter: Schema.Struct({ owner: Schema.String, team: Schema.String }),
    }),
  )(JSON.parse(text));
  assert.deepEqual(decoded.filter, { owner: "ada", team: "core" });
}
