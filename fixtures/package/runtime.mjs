import assert from "node:assert/strict";
import console from "node:console";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as root from "viell-effect-schema-http";
import manifest from "viell-effect-schema-http/package.json" with { type: "json" };
import {
  compileDecodedFilters,
  compileEncodedFilters,
  compileExchangedFirst,
  compileExchangedSecond,
  compileInvalidEncodedFilters,
  compileCorrelatedNested,
  compileGenericNested,
  compileNestedBody,
  compileNestedClass,
  compileNestedDecoded,
  compileNestedEncoded,
  compileNestedList,
  compileNestedMap,
  compileNestedTuple,
  compileNestedWithServices,
  compileOmittedFilters,
  compileStackedEncodedFilters,
  countFewNames,
  getItemId,
  nominalInput,
  nestedNominalInput,
  nestedRequest,
} from "./dist/consumer.js";

for (const subpath of Object.keys(manifest.exports)) {
  const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
  const module = await import(
    specifier,
    subpath.endsWith(".json") ? { with: { type: "json" } } : undefined
  );
  assert.ok(Object.keys(module).length > 0, `Empty export: ${specifier}`);
  if (subpath !== "." && !subpath.endsWith(".json")) {
    assert.equal(
      root[subpath.slice(2)],
      module,
      `Root/subpath mismatch: ${specifier}`,
    );
  }
}

let dispatches = 0;
const client = HttpClient.make((request, url) => {
  dispatches++;
  assert.equal(url.href, "https://api.test/items/a%2Fb");
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response('{"id":42}', {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});
const id = await Effect.runPromise(
  getItemId("a/b").pipe(Effect.provideService(HttpClient.HttpClient, client)),
);
assert.equal(id, 42);
assert.equal(dispatches, 1);
const names = [];
const namesClient = HttpClient.make((request, url) => {
  names.push(url.href);
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response('["a","b"]', {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});
const count = await Effect.runPromise(
  countFewNames
    .execute(undefined)
    .pipe(Effect.provideService(HttpClient.HttpClient, namesClient)),
);
assert.equal(count, 2);
assert.deepEqual(names, ["https://api.test/names?limit=5"]);

for (const compile of [compileEncodedFilters, compileDecodedFilters]) {
  const prepared = await Effect.runPromise(compile());
  assert.equal(prepared.request.url, "https://api.test/filtered?page_size=5");
}
assert.equal(
  (await Effect.runPromise(Effect.flip(compileInvalidEncodedFilters())))._tag,
  "SchemaError",
);
assert.equal(
  (await Effect.runPromise(compileOmittedFilters())).request.url,
  "https://api.test/filtered?page_size=25",
);
assert.equal(
  (await Effect.runPromise(compileStackedEncodedFilters())).request.url,
  "https://api.test/paged?page_size=5&cursor=next",
);
assert.equal(
  (await Effect.runPromise(compileExchangedFirst())).request.url,
  "https://api.test/exchanged?kind=a&page_size=05",
);
assert.equal(
  (await Effect.runPromise(compileExchangedSecond())).request.url,
  "https://api.test/exchanged?kind=b&limit=07",
);
assert.equal(nominalInput.read(), "token");
assert.equal(nestedNominalInput.token.read(), "token");

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
const fieldwiseFilters = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  count: Schema.FiniteFromString,
  offset: Schema.FiniteFromString,
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
for (const schema of [
  fieldwiseFilters,
  Schema.Union([fieldwiseFilters, Schema.Struct({ cursor: Schema.String })]),
]) {
  for (const group of ["query", "headers", "path", "body"]) {
    const base = root.Request.get("https://api.test/fieldwise");
    const request =
      group === "query"
        ? base.pipe(root.Request.query(schema))
        : group === "headers"
          ? base.pipe(root.Request.headers(schema))
          : group === "path"
            ? base.pipe(
                root.Request.path(schema, (value) =>
                  "page_size" in value ? `/${value.page_size}` : "/cursor",
                ),
              )
            : root.Request.post("https://api.test/fieldwise").pipe(
                root.Request.body(root.Body.jsonSchema(schema)),
              );
    const operation = root.Operation.make(
      request,
      root.Response.status(204, root.Body.empty),
    );
    for (const page_size of ["many", "05", "25"]) {
      const error = await Effect.runPromise(
        Effect.flip(
          operation
            .execute({ [group]: { page_size, count: "07", offset: 9 } })
            .pipe(Effect.provideService(HttpClient.HttpClient, client)),
        ),
      );
      assert.equal(error._tag, "SchemaError");
      assert.match(error.message, /page_size/);
      assert.equal(dispatches, 1);
    }
    const prepared = await Effect.runPromise(
      root.Request.compile(request, {
        [group]: { page_size: "05", count: "07", offset: "09" },
      }),
    );
    if (group === "query") assert.match(prepared.request.url, /page_size=5/);
    else if (group === "headers")
      assert.deepEqual(prepared.headerLines, [
        ["page_size", "5"],
        ["count", "7"],
        ["offset", "9"],
      ]);
    else if (group === "path")
      assert.equal(prepared.request.url, "https://api.test/fieldwise/5");
    else {
      assert.equal(prepared.request.body._tag, "Uint8Array");
      assert.equal(
        new globalThis.TextDecoder().decode(prepared.request.body.body),
        '{"page_size":"5","count":"7","offset":"9"}',
      );
    }
  }
}
const nestedDefaultInner = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
for (const [schema, wrap, errorPattern = /filter.*page_size/] of [
  [Schema.Struct({ filter: nestedDefaultInner }), (filter) => ({ filter })],
  [
    Schema.Struct({ wrapper: Schema.Struct({ filter: nestedDefaultInner }) }),
    (filter) => ({ wrapper: { filter } }),
  ],
  [
    Schema.Struct({
      filter: Schema.Union([
        nestedDefaultInner,
        Schema.Struct({ cursor: Schema.String }),
      ]),
    }),
    (filter) => ({ filter }),
  ],
  [
    Schema.Union([
      Schema.Struct({ filter: nestedDefaultInner }),
      Schema.Struct({ cursor: Schema.String }),
    ]),
    (filter) => ({ filter }),
  ],
  [
    Schema.Struct({
      wrapper: Schema.Union([
        Schema.Struct({ filter: nestedDefaultInner }),
        Schema.Struct({ cursor: Schema.String }),
      ]),
    }),
    (filter) => ({ wrapper: { filter } }),
  ],
  [
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), filter: nestedDefaultInner }),
      Schema.Struct({ kind: Schema.Literal("b"), filter: nestedDefaultInner }),
    ]),
    (filter) => ({ kind: "a", filter }),
  ],
  [Schema.Array(nestedDefaultInner), (filter) => [filter], /page_size/],
  [
    Schema.Array(Schema.Array(nestedDefaultInner)),
    (filter) => [[filter]],
    /page_size/,
  ],
  [
    Schema.Struct({ filters: Schema.Array(nestedDefaultInner) }),
    (filter) => ({ filters: [filter] }),
    /filters.*page_size/,
  ],
  [
    Schema.Union([
      Schema.Struct({ filters: Schema.Array(nestedDefaultInner) }),
      Schema.Struct({ cursor: Schema.String }),
    ]),
    (filter) => ({ filters: [filter] }),
    /filters.*page_size/,
  ],
  [
    Schema.Array(
      Schema.Union([
        nestedDefaultInner,
        Schema.Struct({ cursor: Schema.String }),
      ]),
    ),
    (filter) => [filter],
    /page_size/,
  ],
  [Schema.Tuple([nestedDefaultInner]), (filter) => [filter], /page_size/],
  [
    Schema.Tuple([Schema.Number, nestedDefaultInner]),
    (filter) => [3, filter],
    /page_size/,
  ],
  [
    Schema.TupleWithRest(Schema.Tuple([Schema.Number]), [nestedDefaultInner]),
    (filter) => [3, filter],
    /page_size/,
  ],
  [
    Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.Number,
      nestedDefaultInner,
    ]),
    (filter) => ["prefix", 3, filter],
    /page_size/,
  ],
]) {
  for (const kind of ["path", "body"]) {
    let rendered;
    const request =
      kind === "path"
        ? root.Request.get("https://api.test/nested-default").pipe(
            root.Request.path(schema, (value) => {
              rendered = value;
              return "/ok";
            }),
          )
        : root.Request.post("https://api.test/nested-default").pipe(
            root.Request.body(root.Body.jsonSchema(schema)),
          );
    const operation = root.Operation.make(
      request,
      root.Response.status(204, root.Body.empty),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        operation
          .execute({ [kind]: wrap({ page_size: "many" }) })
          .pipe(Effect.provideService(HttpClient.HttpClient, client)),
      ),
    );
    assert.equal(error._tag, "SchemaError");
    assert.match(error.message, errorPattern);
    assert.equal(dispatches, 1);
    for (const [filter, expected] of [
      [{ page_size: "05" }, "5"],
      [{ limit: 5 }, "5"],
      [{}, "25"],
    ]) {
      const prepared = await Effect.runPromise(
        root.Request.compile(request, { [kind]: wrap(filter) }),
      );
      if (kind === "path")
        assert.deepEqual(rendered, wrap({ page_size: expected }));
      else {
        assert.equal(prepared.request.body._tag, "Uint8Array");
        assert.deepEqual(
          JSON.parse(
            new globalThis.TextDecoder().decode(prepared.request.body.body),
          ),
          wrap({ page_size: expected }),
        );
      }
    }
  }
}
for (const [compile, expected] of [
  [compileNestedEncoded, "/05"],
  [compileNestedDecoded, "/05"],
  [compileNestedClass, "/05"],
  [compileNestedList, "/05"],
  [compileNestedTuple, "/05/x"],
  [compileNestedMap, "/05"],
  [compileCorrelatedNested, "/a/x"],
  [compileGenericNested, "/generic"],
  [compileNestedWithServices, "/generic"],
]) {
  assert.equal(
    (await Effect.runPromise(compile())).request.url,
    `https://api.test/nested${expected}`,
  );
}
const nestedBody = (await Effect.runPromise(compileNestedBody())).request.body;
assert.equal(nestedBody._tag, "Uint8Array");
assert.equal(
  new globalThis.TextDecoder().decode(nestedBody.body),
  '{"filter":{"page_size":"05"}}',
);
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(
        root.Request.compile(nestedRequest, {
          path: { filter: { page_size: 5 } },
        }),
      ),
    )
  )._tag,
  "SchemaError",
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6735302019
// Pin the disclosed whole-group interpretation, not a general alias-conflict repair.
const arrayAliasSchema = Schema.Array(nestedDefaultInner);
for (const kind of ["path", "body"]) {
  let rendered;
  const request =
    kind === "path"
      ? root.Request.get("/array-aliases").pipe(
          root.Request.path(arrayAliasSchema, (value) => {
            rendered = value;
            return "/ok";
          }),
        )
      : root.Request.post("/array-aliases").pipe(
          root.Request.body(root.Body.jsonSchema(arrayAliasSchema)),
        );
  const input = [{ limit: 1, page_size: "02" }, { page_size: "25" }];
  const prepared = await Effect.runPromise(
    root.Request.compile(request, { [kind]: input }),
  );
  if (kind === "path")
    assert.deepEqual(rendered, [{ page_size: "2" }, { page_size: "25" }]);
  else {
    assert.equal(prepared.request.body._tag, "Uint8Array");
    assert.deepEqual(
      JSON.parse(
        new globalThis.TextDecoder().decode(prepared.request.body.body),
      ),
      [{ page_size: "2" }, { page_size: "25" }],
    );
  }
}

// Array-key fixes preserve physical positions; unsupported constructor defaults remain #170.
const rewrittenLeaf = { page_size: "05", stray: "ignored" };
const metadataArray = [rewrittenLeaf];
Object.defineProperty(metadataArray, "audit", { value: 7, enumerable: true });
const sparseArray = [];
sparseArray.length = 2;
sparseArray[1] = rewrittenLeaf;
const hiddenArray = [{ page_size: "07" }, rewrittenLeaf];
Object.defineProperty(hiddenArray, "0", { enumerable: false });
const inheritedArray = [];
inheritedArray.length = 2;
inheritedArray[1] = rewrittenLeaf;
Object.setPrototypeOf(
  inheritedArray,
  Object.create(Array.prototype, {
    0: { value: { page_size: "07" } },
  }),
);
let arrayIteratorCalls = 0;
const iteratorArray = [rewrittenLeaf];
Object.defineProperty(iteratorArray, Symbol.iterator, {
  enumerable: true,
  value: function* () {
    arrayIteratorCalls++;
    yield { page_size: "99" };
  },
});
const ordinarySymbol = Symbol("audit");
const symbolArray = [rewrittenLeaf];
Object.defineProperty(symbolArray, ordinarySymbol, {
  value: 7,
  enumerable: true,
});
const sparseInvalid = [];
sparseInvalid.length = 2;
sparseInvalid[1] = { page_size: "many", stray: "ignored" };
const iteratorInvalid = [{ page_size: "many" }];
iteratorInvalid[Symbol.iterator] = Array.prototype[Symbol.iterator];
for (const [schema, input, expected] of [
  [arrayAliasSchema, metadataArray, '[{"page_size":"5"}]'],
  [
    Schema.Array(Schema.optional(nestedDefaultInner)),
    sparseArray,
    '[null,{"page_size":"5"}]',
  ],
  [arrayAliasSchema, hiddenArray, '[{"page_size":"7"},{"page_size":"5"}]'],
  [arrayAliasSchema, inheritedArray, '[{"page_size":"7"},{"page_size":"5"}]'],
  [arrayAliasSchema, iteratorArray, '[{"page_size":"5"}]'],
  [arrayAliasSchema, symbolArray, '[{"page_size":"5"}]'],
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6736960353
  [
    Schema.Array(Schema.optional(nestedDefaultInner)),
    sparseInvalid,
    '[null,{"page_size":"25"}]',
  ],
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6737040870
  [arrayAliasSchema, iteratorInvalid, '[{"page_size":"25"}]'],
])
  for (const kind of ["path", "body"]) {
    let rendered;
    const request =
      kind === "path"
        ? root.Request.get("/array-keys").pipe(
            root.Request.path(schema, (value) => {
              rendered = value;
              return "/ok";
            }),
          )
        : root.Request.post("/array-keys").pipe(
            root.Request.body(root.Body.jsonSchema(schema)),
          );
    const prepared = await Effect.runPromise(
      root.Request.compile(request, { [kind]: input }),
    );
    if (kind === "path") assert.equal(JSON.stringify(rendered), expected);
    else {
      assert.equal(prepared.request.body._tag, "Uint8Array");
      assert.equal(
        new globalThis.TextDecoder().decode(prepared.request.body.body),
        expected,
      );
    }
  }
assert.equal(arrayIteratorCalls, 0);
assert.equal(sparseArray.length, 2);
assert.equal(Object.hasOwn(sparseArray, "0"), false);
assert.equal(
  Object.getOwnPropertyDescriptor(hiddenArray, "0").enumerable,
  false,
);
assert.equal(
  Object.getOwnPropertyDescriptor(symbolArray, ordinarySymbol).value,
  7,
);
for (const kind of ["path", "body"]) {
  const invalid = [{ page_size: "many" }];
  Object.defineProperty(invalid, ordinarySymbol, {
    value: 7,
    enumerable: true,
  });
  const request =
    kind === "path"
      ? root.Request.get("/array-keys").pipe(
          root.Request.path(arrayAliasSchema, () => "/unexpected"),
        )
      : root.Request.post("/array-keys").pipe(
          root.Request.body(root.Body.jsonSchema(arrayAliasSchema)),
        );
  const failure = await Effect.runPromise(
    Effect.flip(root.Request.compile(request, { [kind]: invalid })),
  );
  assert.ok(Schema.isSchemaError(failure));
}

console.log(
  `Packed consumer passed: ${Object.keys(manifest.exports).length} exports, id ${id}.`,
);
