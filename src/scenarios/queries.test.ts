/**
 * Query parameters: the library's query writers against Warded's `param_pair` and `param_present`.
 *
 * Warded splits the raw query on `&`, and each piece at its first `=`, and compares keys and values
 * as written. The library writes declared entries with `encodeURIComponent`, keeps constructor text
 * as written, writes `null` as a bare key and `""` as an empty value. Each route below has its own
 * key, so the route a request reaches names the one piece that matched.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Request, UrlEncoding } from "viell-effect-schema-http";
import { cases, parsesUrls, serve } from "../harness/matrix.js";
import {
  type Condition,
  and,
  exactPath,
  get,
  paramPair,
  paramPresent,
  route,
} from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";

const search = (when: Condition) => and(get(), exactPath("/search"), when);

const table = {
  routes: [
    route("csv", search(paramPair("format", "csv"))),
    route("empty-flag", search(paramPair("flag", ""))),
    route("preview", search(paramPresent("preview"))),
    route("encoded-space", search(paramPair("q", "a%20b"))),
    route("plus", search(paramPair("q", "a+b"))),
    route("date", search(paramPair("since", "2026-11-01T00%3A00%3A00.000Z"))),
    route("encoded-brackets", search(paramPair("filter%5Bname%5D", "ada"))),
    route("brackets", search(paramPair("filter[name]", "ada"))),
    route("semicolon", search(paramPair("a", "1;b=2"))),
    route("wsdl", search(paramPresent("wsdl"))),
    route("apostrophe", search(paramPair("name", "O'Brien"))),
    route("encoded-apostrophe", search(paramPair("name", "O%27Brien"))),
    route("tag-b", search(paramPair("tag", "b"))),
    route("unicode", search(paramPair("word", "%C3%A9t%C3%A9"))),
    route("equals-key", search(paramPair("a%3Db", "c"))),
    route("search", and(get(), exactPath("/search"))),
  ],
};

const searching = Request.get("/search");

describe("query parameters", () => {
  for (const { client, listener, title } of cases()) {
    const run = <E>(request: Request.Request<unknown, E>) =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const sent = yield* send(
          routes,
          listener,
          client,
          operation(request),
          undefined,
        );
        return { outcome: sent.outcome, query: only(sent).seen.query };
      }).pipe(Effect.scoped);

    it.live(
      `${title}: declared entries are encoded, and match encoded pairs`,
      () =>
        Effect.gen(function* () {
          expect(
            yield* run(searching.pipe(Request.setQuery("format", "csv"))),
          ).toMatchObject({ outcome: { route: "csv" }, query: "format=csv" });
          // A space is written %20, which is not a +.
          expect(
            yield* run(searching.pipe(Request.setQuery("q", "a b"))),
          ).toMatchObject({
            outcome: { route: "encoded-space" },
            query: "q=a%20b",
          });
          expect(
            yield* run(searching.pipe(Request.setQuery("word", "été"))),
          ).toMatchObject({ outcome: { route: "unicode" } });
          // Keys are encoded too, so a route names the encoded key.
          expect(
            yield* run(searching.pipe(Request.setQuery("filter[name]", "ada"))),
          ).toMatchObject({
            outcome: { route: "encoded-brackets" },
            query: "filter%5Bname%5D=ada",
          });
          expect(
            yield* run(searching.pipe(Request.setQuery("a=b", "c"))),
          ).toMatchObject({ outcome: { route: "equals-key" } });
          // A Date is its ISO text, whose colons are encoded.
          const since = new Date("2026-11-01T00:00:00.000Z");
          expect(
            yield* run(searching.pipe(Request.setQuery({ since }))),
          ).toMatchObject({ outcome: { route: "date" } });
        }),
    );

    it.live(
      `${title}: bare keys, empty values and repetition stay distinct`,
      () =>
        Effect.gen(function* () {
          // `null` is a bare key, which param_present accepts and param_pair(key, "") does not.
          expect(
            yield* run(searching.pipe(Request.setQuery("preview", null))),
          ).toMatchObject({ outcome: { route: "preview" }, query: "preview" });
          expect(
            yield* run(searching.pipe(Request.setQuery("flag", null))),
          ).toMatchObject({ outcome: { route: "search" }, query: "flag" });
          expect(
            yield* run(searching.pipe(Request.setQuery("flag", ""))),
          ).toMatchObject({ outcome: { route: "empty-flag" }, query: "flag=" });
          // A repeated key matches when any of its pieces does, whatever the order.
          expect(
            yield* run(
              searching.pipe(
                Request.appendQuery("tag", "a"),
                Request.appendQuery("tag", "b"),
              ),
            ),
          ).toMatchObject({
            outcome: { route: "tag-b" },
            query: "tag=a&tag=b",
          });
          expect(
            yield* run(
              searching.pipe(
                Request.query(
                  Schema.Struct({ tag: Schema.Array(Schema.String) }),
                ),
                Request.mapInput(() => ({ query: { tag: ["b", "a"] } })),
              ),
            ),
          ).toMatchObject({
            outcome: { route: "tag-b" },
            query: "tag=b&tag=a",
          });
        }),
    );

    it.live(`${title}: constructor text goes out as written`, () =>
      Effect.gen(function* () {
        expect(yield* run(Request.get("/search?q=a+b"))).toMatchObject({
          outcome: { route: "plus" },
          query: "q=a+b",
        });
        expect(yield* run(Request.get("/search?wsdl"))).toMatchObject({
          outcome: { route: "wsdl" },
          query: "wsdl",
        });
        // Warded splits only on `&`, so `;` stays inside the value.
        expect(yield* run(Request.get("/search?a=1;b=2"))).toMatchObject({
          outcome: { route: "semicolon" },
          query: "a=1;b=2",
        });
        expect(
          yield* run(Request.get("/search?filter[name]=ada")),
        ).toMatchObject({
          outcome: { route: "brackets" },
          query: "filter[name]=ada",
        });
        // Empty pieces split off by `&` match nothing and hide nothing.
        expect(yield* run(Request.get("/search?&&format=csv&"))).toMatchObject({
          outcome: { route: "csv" },
          query: "&&format=csv&",
        });
        // Removing an entry in a variant leaves what was written around it.
        expect(
          yield* run(
            Request.get("/search?q=a+b&format=csv").pipe(
              Request.removeQuery("format"),
            ),
          ),
        ).toMatchObject({ outcome: { route: "plus" }, query: "q=a+b" });
      }),
    );

    it.live(`${title}: a replaced encoding writes what the route expects`, () =>
      Effect.gen(function* () {
        const plus = UrlEncoding.layer({
          ...UrlEncoding.defaults,
          query: (entries) =>
            UrlEncoding.defaults.query(entries).replaceAll("%20", "+"),
        });
        expect(
          yield* run(searching.pipe(Request.setQuery("q", "a b"))).pipe(
            Effect.provide(plus),
          ),
        ).toMatchObject({ outcome: { route: "plus" }, query: "q=a+b" });
      }),
    );

    it.live(
      `${title}: an apostrophe ${parsesUrls(client) ? "is percent-encoded by the URL parser" : "goes out as written"}`,
      () =>
        Effect.gen(function* () {
          // encodeURIComponent leaves `'` alone, and the WHATWG URL parser encodes it in the query of
          // an http or https URL.
          expect(
            yield* run(searching.pipe(Request.setQuery("name", "O'Brien"))),
          ).toMatchObject(
            parsesUrls(client)
              ? {
                  outcome: { route: "encoded-apostrophe" },
                  query: "name=O%27Brien",
                }
              : { outcome: { route: "apostrophe" }, query: "name=O'Brien" },
          );
        }),
    );
  }
});
