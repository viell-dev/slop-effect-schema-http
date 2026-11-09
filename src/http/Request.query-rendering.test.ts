import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as Request from "./Request.js";
import * as UrlEncoding from "./UrlEncoding.js";

/** Observe both the URL and every call made to a consumer's renderer. */
const render = (
  request: Request.Request<unknown>,
  query: UrlEncoding.Service["query"],
) => {
  const calls: Array<UrlEncoding.Query> = [];
  return Request.compile(request, undefined).pipe(
    Effect.provide(
      UrlEncoding.layer({
        ...UrlEncoding.defaults,
        query: (entries) => {
          calls.push(entries);
          return query(entries);
        },
      }),
    ),
    Effect.map(({ request }) => ({ url: request.url, calls })),
  );
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/196
describe("custom query rendering", () => {
  it.effect(
    "honors an empty result from a nonempty run without an empty-input fallback",
    () =>
      Effect.gen(function* () {
        const result = yield* render(
          Request.get("https://example.test/items").pipe(
            Request.setQuery("drop", "1"),
          ),
          (entries) => (entries.length === 0 ? "empty=1" : ""),
        );
        expect(result).toEqual({
          url: "https://example.test/items",
          calls: [[["drop", "1"]]],
        });
      }),
  );

  it.effect(
    "calls the renderer once with empty input when there really are no entries",
    () =>
      Effect.gen(function* () {
        const result = yield* render(Request.get("/items"), () => "empty=1");
        expect(result).toEqual({ url: "/items?empty=1", calls: [[]] });
      }),
  );

  it.effect(
    "passes written-only query text through without calling the renderer",
    () =>
      Effect.gen(function* () {
        const result = yield* render(
          Request.get("/items?a=%41&flag"),
          () => "unused=1",
        );
        expect(result).toEqual({ url: "/items?a=%41&flag", calls: [] });
      }),
  );

  it.effect("keeps written text between separately rendered empty runs", () =>
    Effect.gen(function* () {
      const result = yield* render(
        Request.get("/items?first=raw&anchor=%41&last=raw").pipe(
          Request.setQuery("first", "1"),
          Request.setQuery("last", "2"),
        ),
        () => "",
      );
      expect(result).toEqual({
        url: "/items?anchor=%41",
        calls: [[["first", "1"]], [["last", "2"]]],
      });
    }),
  );

  it.effect(
    "retains written empty segments without treating them as absent entries",
    () =>
      Effect.gen(function* () {
        const result = yield* render(Request.get("/items?&"), () => "unused=1");
        expect(result).toEqual({ url: "/items?&", calls: [] });
      }),
  );
});
