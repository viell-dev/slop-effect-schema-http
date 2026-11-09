import assert from "node:assert/strict";
// #region imports
import { Effect, Option, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

const jsonText = (compiled: Request.Compiled) => {
  const body = compiled.request.body;
  if (body._tag !== "Uint8Array") throw new Error("Expected JSON");
  return new TextDecoder().decode(body.body);
};
const refused = async <E extends { readonly _tag: string }>(
  pending: Effect.Effect<Request.Compiled, E>,
) =>
  assert.equal(
    (await Effect.runPromise(Effect.flip(pending)))._tag,
    "SchemaError",
  );

// #region schema
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Filters = Schema.Array(Schema.optional(Filter));
const submit = Request.post("/pages").pipe(
  Request.body(Body.jsonSchema(Filters)),
);
// #endregion schema

// #region optional
const invalid = Request.compile(submit, { body: [{ page_size: "many" }] });
const encoded = Request.compile(submit, { body: [{ page_size: "05" }] });
const decoded = Request.compile(submit, { body: [{ limit: 5 }] });
const omitted = Request.compile(submit, { body: [{}] });
// #endregion optional
await refused(invalid);
assert.equal(jsonText(await Effect.runPromise(encoded)), '[{"page_size":"5"}]');
assert.equal(jsonText(await Effect.runPromise(decoded)), '[{"page_size":"5"}]');
assert.equal(
  jsonText(await Effect.runPromise(omitted)),
  '[{"page_size":"25"}]',
);

// #region sparse-iterator
const sparse: Array<typeof Filter.Encoded> = [];
sparse.length = 2;
sparse[1] = { page_size: "many" };
const sparseInvalid = Request.compile(submit, { body: sparse });

const ownNative = [{ page_size: "many" }];
ownNative[Symbol.iterator] = Array.prototype[Symbol.iterator];
const iteratorInvalid = Request.compile(submit, { body: ownNative });
// #endregion sparse-iterator
await refused(sparseInvalid);
await refused(iteratorInvalid);
assert.equal(Object.hasOwn(sparse, "0"), false);
assert.equal(sparse.length, 2);
for (const [input, expected] of [
  [{ page_size: "05" }, "5"],
  [{}, "25"],
] as const) {
  sparse[1] = input;
  assert.equal(
    jsonText(
      await Effect.runPromise(Request.compile(submit, { body: sparse })),
    ),
    `[null,{"page_size":"${expected}"}]`,
  );
}
const decodedSparse: Array<typeof Filter.Type> = [];
decodedSparse.length = 2;
decodedSparse[1] = { limit: 5 };
assert.equal(
  jsonText(
    await Effect.runPromise(Request.compile(submit, { body: decodedSparse })),
  ),
  '[null,{"page_size":"5"}]',
);

// #region complete-sides
const mixedRuntime = [
  { limit: 2 },
  { page_size: "05" },
] as unknown as Request.Input<typeof Filters>;
const mixed = Request.compile(submit, { body: mixedRuntime });
const completeEncoded = Request.compile(submit, {
  body: [{ page_size: "02" }, { page_size: "05" }],
});
const completeDecoded = Request.compile(submit, {
  body: [{ limit: 2 }, { limit: 5 }],
});
// #endregion complete-sides
await refused(mixed);
for (const pending of [completeEncoded, completeDecoded])
  assert.equal(
    jsonText(await Effect.runPromise(pending)),
    '[{"page_size":"2"},{"page_size":"5"}]',
  );

// #region shared-text
const Rows = Schema.Array(
  Schema.optional(
    Schema.Struct({
      filter: Filter,
      shared: Schema.StringFromBase64,
      opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
    }),
  ),
);
const lookup = Request.get("").pipe(
  Request.path(Rows, (rows, encode) => `/${encode(rows[0]!.shared)}`),
);
const opaque = Option.some({ keep: "x", extra: "opaque" });
const encodedText = Request.compile(lookup, {
  path: [{ filter: { page_size: "25" }, shared: "eA==", opaque }],
});
const decodedText = Request.compile(lookup, {
  path: [{ filter: { limit: 25 }, shared: "eA==", opaque }],
});
// #endregion shared-text
assert.equal((await Effect.runPromise(encodedText)).request.url, "/eA%3D%3D");
assert.equal(
  (await Effect.runPromise(decodedText)).request.url,
  "/ZUE9PQ%3D%3D",
);

// #region dual-names
const bothNames = [{ limit: 1, page_size: "02" }, { page_size: "25" }];
const typedBothNames: Request.Input<typeof Filters> = bothNames;
const wholeEncodedChoice = Request.compile(submit, { body: typedBothNames });
// #endregion dual-names
assert.equal(
  jsonText(await Effect.runPromise(wholeEncodedChoice)),
  '[{"page_size":"2"},{"page_size":"25"}]',
);
assert.equal(
  jsonText(
    await Effect.runPromise(
      Request.compile(submit, { body: [{ limit: 1, page_size: "02" }] }),
    ),
  ),
  '[{"page_size":"1"}]',
);

// #region decoded-mapping
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
  return yield* Request.compile(submit, { body: decoded });
});
// #endregion decoded-mapping
assert.equal(
  jsonText(
    await Effect.runPromise(compileForms([undefined, { limit: "05" }, {}])),
  ),
  '[null,{"page_size":"5"},{"page_size":"25"}]',
);
await refused(compileForms([{ limit: "many" }]));
