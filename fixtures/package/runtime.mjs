import assert from "node:assert/strict";
import console from "node:console";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as root from "viell-effect-schema-http";
import manifest from "viell-effect-schema-http/package.json" with { type: "json" };
import { getItemId } from "./dist/consumer.js";

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
console.log(
  `Packed consumer passed: ${Object.keys(manifest.exports).length} exports, id ${id}.`,
);
