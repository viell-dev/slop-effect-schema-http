import assert from "node:assert/strict";
// #region imports
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

const jsonText = (compiled: Request.Compiled) => {
  const body = compiled.request.body;
  if (body._tag !== "Uint8Array") throw new Error("Expected JSON");
  return new TextDecoder().decode(body.body);
};

// #region schema
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Filters = Schema.Array(Filter);
const submit = Request.post("/pages").pipe(
  Request.body(Body.jsonSchema(Filters)),
);
const leaf = { page_size: "05", stray: "ignored" };
// #endregion schema

// #region metadata
const withMetadata = [leaf];
Object.defineProperty(withMetadata, "audit", { value: 7, enumerable: true });
const metadataBody = Request.compile(submit, { body: withMetadata });
// #endregion metadata
assert.equal(
  jsonText(await Effect.runPromise(metadataBody)),
  '[{"page_size":"5"}]',
);
assert.equal(withMetadata.length, 1);
assert.equal(withMetadata[0], leaf);

// #region sparse
const optionalSubmit = Request.post("/pages").pipe(
  Request.body(Body.jsonSchema(Schema.Array(Schema.optional(Filter)))),
);
const sparse: Array<typeof Filter.Encoded> = [];
sparse.length = 2;
sparse[1] = leaf;
const sparseBody = Request.compile(optionalSubmit, { body: sparse });
// #endregion sparse
assert.equal(
  jsonText(await Effect.runPromise(sparseBody)),
  '[null,{"page_size":"5"}]',
);
assert.equal(sparse.length, 2);
assert.equal(Object.hasOwn(sparse, "0"), false);

// #region hidden
const hidden = [{ page_size: "07" }, leaf];
Object.defineProperty(hidden, "0", { enumerable: false });
const hiddenBody = Request.compile(submit, { body: hidden });
// #endregion hidden
assert.equal(
  jsonText(await Effect.runPromise(hiddenBody)),
  '[{"page_size":"7"},{"page_size":"5"}]',
);
assert.equal(Object.getOwnPropertyDescriptor(hidden, "0")?.enumerable, false);

// #region symbol
const withIterator = [leaf];
withIterator[Symbol.iterator] = Array.prototype[Symbol.iterator];
const symbolBody = Request.compile(submit, { body: withIterator });
// #endregion symbol
assert.equal(
  jsonText(await Effect.runPromise(symbolBody)),
  '[{"page_size":"5"}]',
);

// #region unsupported-defaults
const invalidSparse: Array<typeof Filter.Encoded> = [];
invalidSparse.length = 2;
const invalidLeaf = { page_size: "many", stray: "ignored" };
invalidSparse[1] = invalidLeaf;
const sparseDefault = Request.compile(optionalSubmit, { body: invalidSparse });

const invalidIterator = [{ page_size: "many" }];
invalidIterator[Symbol.iterator] = Array.prototype[Symbol.iterator];
const iteratorDefault = Request.compile(submit, { body: invalidIterator });
// #endregion unsupported-defaults
assert.equal(
  jsonText(await Effect.runPromise(sparseDefault)),
  '[null,{"page_size":"25"}]',
);
assert.equal(
  jsonText(await Effect.runPromise(iteratorDefault)),
  '[{"page_size":"25"}]',
);

// #region validated-mapping
interface FilterForm {
  readonly limit?: string;
}
const readForms = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.optional(
      Schema.Struct({ limit: Schema.optionalKey(Schema.FiniteFromString) }),
    ),
  ),
);
const compileForms = Effect.fn("compileForms")(function* (
  forms: ReadonlyArray<FilterForm | undefined>,
) {
  const decoded = yield* readForms(forms);
  return yield* Request.compile(optionalSubmit, { body: decoded });
});
const validated = compileForms([undefined, { limit: "05" }]);
// #endregion validated-mapping
assert.equal(
  jsonText(await Effect.runPromise(validated)),
  '[null,{"page_size":"5"}]',
);
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(compileForms([undefined, { limit: "many" }])),
    )
  )._tag,
  "SchemaError",
);
assert.equal(
  jsonText(await Effect.runPromise(compileForms([undefined, {}]))),
  '[null,{"page_size":"25"}]',
);
