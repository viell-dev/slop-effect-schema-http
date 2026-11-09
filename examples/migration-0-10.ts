import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

// #region encoded-input
const Filters = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Nested = Schema.Struct({ filter: Filters });
const lookup = Request.get("").pipe(
  Request.path(
    Nested,
    (value, encode) => `/${encode(value.filter.page_size ?? "")}`,
  ),
);
const encoded = Request.compile(lookup, {
  path: { filter: { page_size: "05" } },
});
const decoded = Request.compile(lookup, {
  path: { filter: { limit: "05" } },
});
// #endregion encoded-input

assert.equal((await Effect.runPromise(encoded)).request.url, "/05");
assert.equal((await Effect.runPromise(decoded)).request.url, "/05");
assert.equal(
  (
    await Effect.runPromise(
      Request.compile(lookup, { path: { filter: { page_size: "a/b" } } }),
    )
  ).request.url,
  "/a%2Fb",
);

// #region helper-input
interface SearchInput {
  readonly filter: {
    readonly term?: string;
    readonly limit?: string;
  };
}
const chooseFilter = (input: SearchInput) => ({
  path: {
    filter: {
      ...(input.filter.term === undefined ? {} : { term: input.filter.term }),
      limit: input.filter.limit ?? "25",
    },
  },
});
const search = lookup.pipe(Request.mapInput(chooseFilter));
// #endregion helper-input

assert.equal(
  (
    await Effect.runPromise(
      Request.compile(search, { filter: { limit: "05" } }),
    )
  ).request.url,
  "/05",
);
assert.equal(
  (await Effect.runPromise(Request.compile(search, { filter: {} }))).request
    .url,
  "/25",
);

// #region json-list
const batch = Request.post("https://api.example.test/search").pipe(
  Request.body(
    Body.jsonSchema(Schema.Struct({ filters: Schema.Array(Filters) })),
  ),
);
const body = Request.compile(batch, {
  body: { filters: [{ page_size: "05" }] },
});
// #endregion json-list

const preparedBody = (await Effect.runPromise(body)).request.body;
assert.ok(preparedBody._tag === "Uint8Array");
assert.equal(
  new globalThis.TextDecoder().decode(preparedBody.body),
  '{"filters":[{"page_size":"05"}]}',
);

void (() => {
  // @ts-expect-error: the nested encoded value still requires text
  void Request.compile(lookup, { path: { filter: { page_size: 5 } } });
  // @ts-expect-error: the containing filter remains required
  void Request.compile(lookup, { path: {} });
  // @ts-expect-error: the named mapping accepts decoded names only
  void Request.compile(search, { filter: { page_size: "05" } });
});
