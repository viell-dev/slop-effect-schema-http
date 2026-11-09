import assert from "node:assert/strict";
// #region imports
import { Effect, Option, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

// #region array
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Filters = Schema.Array(Filter);
const lookup = Request.get("").pipe(
  Request.path(
    Filters,
    (filters, encode) =>
      `/pages/${filters.map((filter) => encode(filter.page_size ?? "none")).join("/")}`,
  ),
);
const invalid = Request.compile(lookup, { path: [{ page_size: "many" }] });
const encoded = Request.compile(lookup, { path: [{ page_size: "05" }] });
const decoded = Request.compile(lookup, { path: [{ limit: 5 }] });
const omitted = Request.compile(lookup, { path: [{}] });
// #endregion array

assert.equal(
  (await Effect.runPromise(Effect.flip(invalid)))._tag,
  "SchemaError",
);
assert.equal((await Effect.runPromise(encoded)).request.url, "/pages/5");
assert.equal((await Effect.runPromise(decoded)).request.url, "/pages/5");
assert.equal((await Effect.runPromise(omitted)).request.url, "/pages/25");

// #region tuple-body
const Batch = Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
  Schema.Number,
  Filter,
]);
const submit = Request.post("/batches").pipe(
  Request.body(Body.jsonSchema(Batch)),
);
const validBatch = Request.compile(submit, {
  body: ["group", 3, { page_size: "05" }],
});
const invalidBatch = Request.compile(submit, {
  body: ["group", 3, { page_size: "many" }],
});
// #endregion tuple-body

const batch = await Effect.runPromise(validBatch);
if (batch.request.body._tag !== "Uint8Array") throw new Error("Expected JSON");
assert.equal(
  new TextDecoder().decode(batch.request.body.body),
  '["group",3,{"page_size":"5"}]',
);
assert.equal(
  (await Effect.runPromise(Effect.flip(invalidBatch)))._tag,
  "SchemaError",
);

// Whole-side static input already excludes this mixed literal. JavaScript and casts can still
// reach the runtime boundary, where 0.13 wrote the second default and 0.14 refuses the group.
const mixedRuntime = [
  { limit: 2 },
  { page_size: "05" },
] as unknown as Request.Input<typeof Filters>;
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(Request.compile(lookup, { path: mixedRuntime })),
    )
  )._tag,
  "SchemaError",
);

// #region omission-route
const encodedOmission = Request.compile(lookup, {
  path: [{ page_size: "02" }, {}],
});
const decodedOmission = Request.compile(lookup, {
  path: [{ limit: 2 }, {}],
});
// #endregion omission-route

assert.equal(
  (await Effect.runPromise(encodedOmission)).request.url,
  "/pages/2/none",
);
assert.equal(
  (await Effect.runPromise(decodedOmission)).request.url,
  "/pages/2/25",
);

// #region shared-text
const Shared = Schema.Array(
  Schema.Struct({
    filter: Filter,
    shared: Schema.StringFromBase64,
    opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
  }),
);
const sharedText = Request.get("").pipe(
  Request.path(Shared, (rows, encode) => `/${encode(rows[0]!.shared)}`),
);
const opaque = Option.some({ keep: "x", extra: "opaque" });
const encodedGroup = Request.compile(sharedText, {
  path: [{ filter: { page_size: "25" }, shared: "eA==", opaque }],
});
const decodedGroup = Request.compile(sharedText, {
  path: [{ filter: { limit: 25 }, shared: "eA==", opaque }],
});
// #endregion shared-text

assert.equal((await Effect.runPromise(encodedGroup)).request.url, "/eA%3D%3D");
assert.equal(
  (await Effect.runPromise(decodedGroup)).request.url,
  "/ZUE9PQ%3D%3D",
);

// #region dual-names
const bothNames = [{ limit: 1, page_size: "02" }, { page_size: "25" }];
const typedBothNames: Request.Input<typeof Filters> = bothNames;
const wholeEncodedChoice = Request.compile(lookup, { path: typedBothNames });
// #endregion dual-names

assert.equal(
  (await Effect.runPromise(wholeEncodedChoice)).request.url,
  "/pages/2/25",
);
const oneBothNames = [{ limit: 1, page_size: "02" }];
assert.equal(
  (await Effect.runPromise(Request.compile(lookup, { path: oneBothNames })))
    .request.url,
  "/pages/1",
);

// #region decoded-mapping
interface FilterForm {
  readonly limit?: string;
}
const readForms = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ limit: Schema.optionalKey(Schema.FiniteFromString) }),
  ),
);
const prepareFilters = Effect.fn("prepareFilters")(function* (
  forms: ReadonlyArray<FilterForm>,
) {
  const filters = yield* readForms(forms);
  return yield* Request.compile(lookup, { path: filters });
});
// #endregion decoded-mapping

assert.equal(
  (await Effect.runPromise(prepareFilters([{ limit: "05" }, {}]))).request.url,
  "/pages/5/25",
);
assert.equal(
  (await Effect.runPromise(Effect.flip(prepareFilters([{ limit: "many" }]))))
    ._tag,
  "SchemaError",
);
