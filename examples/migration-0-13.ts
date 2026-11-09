import assert from "node:assert/strict";
// #region imports
import { Effect, Option, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

// #region parent-union
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const Page = Schema.Union([Schema.Struct({ filter: Filter }), Cursor]);
const lookup = Request.get("").pipe(
  Request.path(Page, (page, encode) =>
    "cursor" in page
      ? `/cursor/${encode(page.cursor)}`
      : `/page/${encode(page.filter.page_size ?? "missing")}`,
  ),
);
const invalid = Request.compile(lookup, {
  path: { filter: { page_size: "many" } },
});
const encoded = Request.compile(lookup, {
  path: { filter: { page_size: "05" } },
});
const decoded = Request.compile(lookup, { path: { filter: { limit: 5 } } });
const omitted = Request.compile(lookup, { path: { filter: {} } });
// #endregion parent-union

assert.equal(
  (await Effect.runPromise(Effect.flip(invalid)))._tag,
  "SchemaError",
);
assert.equal((await Effect.runPromise(encoded)).request.url, "/page/5");
assert.equal((await Effect.runPromise(decoded)).request.url, "/page/5");
assert.equal((await Effect.runPromise(omitted)).request.url, "/page/25");
assert.equal(
  (
    await Effect.runPromise(
      Request.compile(lookup, {
        path: { cursor: "next/page" },
      }),
    )
  ).request.url,
  "/cursor/next%2Fpage",
);

// #region shared-field
const SharedPage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("a"), filter: Filter }),
  Schema.Struct({ kind: Schema.Literal("b"), filter: Filter }),
]);
const sharedLookup = Request.get("").pipe(
  Request.path(
    SharedPage,
    ({ filter }, encode) => `/page/${encode(filter.page_size ?? "missing")}`,
  ),
);
// #endregion shared-field

for (const kind of ["a", "b"] as const) {
  assert.equal(
    (
      await Effect.runPromise(
        Effect.flip(
          Request.compile(sharedLookup, {
            path: { kind, filter: { page_size: "many" } },
          }),
        ),
      )
    )._tag,
    "SchemaError",
  );
  assert.equal(
    (
      await Effect.runPromise(
        Request.compile(sharedLookup, {
          path: { kind, filter: { page_size: "05" } },
        }),
      )
    ).request.url,
    "/page/5",
  );
}

// #region nested-json
const batch = Request.post("https://api.example.test/search").pipe(
  Request.body(Body.jsonSchema(Schema.Struct({ page: Page }))),
);
const validBody = Request.compile(batch, {
  body: { page: { filter: { page_size: "05" } } },
});
const invalidBody = Request.compile(batch, {
  body: { page: { filter: { page_size: "many" } } },
});
// #endregion nested-json

assert.equal(
  (await Effect.runPromise(Effect.flip(invalidBody)))._tag,
  "SchemaError",
);
const body = (await Effect.runPromise(validBody)).request.body;
assert.equal(body._tag, "Uint8Array");
if (body._tag === "Uint8Array")
  assert.equal(
    new TextDecoder().decode(body.body),
    '{"page":{"filter":{"page_size":"5"}}}',
  );

// #region whole-group
const opaque = Option.some({ keep: "x", extra: "schema-owned" });
const MixedPage = Schema.Union([
  Schema.Struct({
    filter: Filter,
    count: Schema.FiniteFromString,
    opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
  }),
  Cursor,
]);
const mixed = Request.get("").pipe(
  Request.path(MixedPage, (page) =>
    "cursor" in page ? "/cursor" : `/${page.filter.page_size}/${page.count}`,
  ),
);
const mixedInput = Request.compile(mixed, {
  path: { filter: { page_size: "25" }, count: 3, opaque },
});
const completeEncoded = Request.compile(mixed, {
  path: { filter: { page_size: "25" }, count: "3", opaque },
});
const completeDecoded = Request.compile(mixed, {
  path: { filter: { limit: 25 }, count: 3, opaque },
});
// #endregion whole-group

assert.equal(
  (await Effect.runPromise(Effect.flip(mixedInput)))._tag,
  "SchemaError",
);
assert.equal((await Effect.runPromise(completeEncoded)).request.url, "/25/3");
assert.equal((await Effect.runPromise(completeDecoded)).request.url, "/25/3");

// #region shared-text
const SharedTextPage = Schema.Union([
  Schema.Struct({
    filter: Filter,
    shared: Schema.StringFromBase64,
    opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
  }),
  Cursor,
]);
const sharedText = Request.get("").pipe(
  Request.path(SharedTextPage, (page, encode) =>
    "cursor" in page ? "/cursor" : `/${encode(page.shared)}`,
  ),
);
const encodedGroup = Request.compile(sharedText, {
  path: { filter: { page_size: "25" }, shared: "eA==", opaque },
});
const decodedGroup = Request.compile(sharedText, {
  path: { filter: { limit: 25 }, shared: "eA==", opaque },
});
// #endregion shared-text

assert.equal((await Effect.runPromise(encodedGroup)).request.url, "/eA%3D%3D");
assert.equal(
  (await Effect.runPromise(decodedGroup)).request.url,
  "/ZUE9PQ%3D%3D",
);

// #region decoded-mapping
interface SearchForm {
  readonly limit?: string;
}
const readForm = Schema.decodeUnknownEffect(
  Schema.Struct({ limit: Schema.optionalKey(Schema.FiniteFromString) }),
);
const prepareSearch = Effect.fn("prepareSearch")(function* (form: SearchForm) {
  const filter = yield* readForm(form);
  return yield* Request.compile(lookup, { path: { filter } });
});
// #endregion decoded-mapping

assert.equal(
  (await Effect.runPromise(prepareSearch({ limit: "05" }))).request.url,
  "/page/5",
);
assert.equal(
  (await Effect.runPromise(prepareSearch({}))).request.url,
  "/page/25",
);
assert.equal(
  (await Effect.runPromise(Effect.flip(prepareSearch({ limit: "many" }))))._tag,
  "SchemaError",
);
