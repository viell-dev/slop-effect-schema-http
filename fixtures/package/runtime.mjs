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

console.log(
  `Packed consumer passed: ${Object.keys(manifest.exports).length} exports, id ${id}.`,
);
