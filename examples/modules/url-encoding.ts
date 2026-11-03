import assert from "node:assert/strict";
// #region imports
import { Effect } from "effect";
import { Request, UrlEncoding } from "viell-effect-schema-http";
// #endregion imports

// #region default
const request = Request.get("/search").pipe(
  Request.baseUrl("https://api.example.test/v1"),
  Request.setQuery("q", "Ada Lovelace"),
);
const compiled = await Effect.runPromise(Request.compile(request, undefined));
// compiled.request.url === "https://api.example.test/v1/search?q=Ada%20Lovelace"
// #endregion default
assert.equal(
  compiled.request.url,
  "https://api.example.test/v1/search?q=Ada%20Lovelace",
);

// #region entries
const entries = UrlEncoding.queryEntries({
  tag: ["math", "computing"],
  preview: null,
  empty: "",
  omitted: undefined,
});
const query = UrlEncoding.defaults.query(entries);
// query === "tag=math&tag=computing&preview&empty="
// #endregion entries
assert.equal(query, "tag=math&tag=computing&preview&empty=");

// #region custom
const formSpaces = UrlEncoding.layer({
  ...UrlEncoding.defaults,
  query: (pairs) => UrlEncoding.defaults.query(pairs).replaceAll("%20", "+"),
});
const custom = await Effect.runPromise(
  Request.compile(request, undefined).pipe(Effect.provide(formSpaces)),
);
// custom.request.url === "https://api.example.test/v1/search?q=Ada+Lovelace"
// #endregion custom
assert.equal(
  custom.request.url,
  "https://api.example.test/v1/search?q=Ada+Lovelace",
);
