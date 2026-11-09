import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaTransformation } from "effect";
import {
  bodyOf,
  compile,
  linesOf,
  queried,
  refusal,
  schemaFailure,
  stacked,
  takes,
  urlOf,
} from "../../test/request.js";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

// https://github.com/viell-dev/slop-effect-schema-http/issues/87
// https://github.com/viell-dev/slop-effect-schema-http/issues/134
describe("a caller's field under a union", () => {
  const text = Schema.String;
  const NarrowFirst = Schema.Union([
    Schema.Struct({ a: text }),
    Schema.Struct({ a: text, b: text }),
  ]);
  const Apart = Schema.Union([
    Schema.Struct({ a: text }),
    Schema.Struct({ b: text }),
  ]);
  const Numbers = Schema.Union([
    Schema.Struct({ n: Schema.FiniteFromString }),
    Schema.Struct({ n: Schema.FiniteFromString, d: Schema.FiniteFromString }),
  ]);

  describe("a member that keeps every field wins", () => {
    it.effect("over an earlier member that strips one", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(queried(NarrowFirst), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("whatever the order of the members", () =>
      Effect.gen(function* () {
        const WideFirst = Schema.Union([
          Schema.Struct({ a: text, b: text }),
          Schema.Struct({ a: text }),
        ]);
        for (const query of [{ a: "x", b: "y" }, { a: "x" }])
          expect(yield* urlOf(queried(WideFirst), { query })).toBe(
            yield* urlOf(queried(NarrowFirst), { query }),
          );
      }),
    );

    it.effect("so a default no longer takes the caller's place", () =>
      Effect.gen(function* () {
        const request = Request.get("/x?b=1").pipe(Request.query(NarrowFirst));
        expect(yield* urlOf(request, { query: { a: "x", b: "y" } })).toBe(
          "/x?a=x&b=y",
        );
        expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x&b=1");
      }),
    );

    it.effect("on the decoded side, the encoded side, and a mix", () =>
      Effect.gen(function* () {
        for (const query of [
          { n: 1, d: 2 },
          { n: "1", d: "2" },
          { n: 1, d: "2" },
          { n: "1", d: 2 },
        ])
          expect(yield* urlOf(queried(Numbers), { query })).toBe("/x?n=1&d=2");
      }),
    );

    it.effect("when the encoded step alone would strip it", () =>
      Effect.gen(function* () {
        class Base extends Schema.Class<Base>("Base")({ a: text }) {}
        class Derived extends Base.extend<Derived>("Derived")({ b: text }) {}
        const request = queried(Schema.Union([Base, Derived]));
        // A `Derived` is a `Base`, so a value already built fits the first member as it stands.
        expect(
          yield* urlOf(request, { query: new Derived({ a: "x", b: "y" }) }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("when that member is a record", () =>
      Effect.gen(function* () {
        const Open = Schema.Union([
          Schema.Struct({ a: text }),
          Schema.Record(text, text),
        ]);
        expect(yield* urlOf(queried(Open), { query: { a: "x", b: "y" } })).toBe(
          "/x?a=x&b=y",
        );
      }),
    );

    it.effect("inside a union of unions", () =>
      Effect.gen(function* () {
        const Nested = Schema.Union([NarrowFirst, Schema.Struct({ c: text })]);
        expect(
          yield* urlOf(queried(Nested), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=x&b=y");
        expect(yield* urlOf(queried(Nested), { query: { c: "z" } })).toBe(
          "/x?c=z",
        );
      }),
    );

    it.effect("inside text that holds JSON", () =>
      Effect.gen(function* () {
        const request = queried(
          Schema.Struct({ filter: Schema.fromJsonString(NarrowFirst) }),
        );
        const expected = `/x?filter=${encodeURIComponent('{"a":"x","b":"y"}')}`;
        for (const filter of [{ a: "x", b: "y" }, '{"a":"x","b":"y"}'])
          expect(yield* urlOf(request, { query: { filter } })).toBe(expected);
      }),
    );

    it.effect("in headers", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({ "x-a": text }),
          Schema.Struct({ "x-a": text, "x-b": text }),
        ]);
        const request = Request.get("/x").pipe(
          Request.setHeader("X-B", "default"),
          Request.headers(Either),
        );
        expect(
          yield* linesOf(request, { headers: { "x-a": "1", "x-b": "2" } }),
        ).toEqual([
          ["x-a", "1"],
          ["x-b", "2"],
        ]);
      }),
    );

    it.effect("in a path renderer", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path(NarrowFirst, (value) =>
            "b" in value ? `/${value.a}/${value.b}` : `/${value.a}`,
          ),
        );
        expect(yield* urlOf(request, { path: { a: "x", b: "y" } })).toBe(
          "/x/y",
        );
        expect(yield* urlOf(request, { path: { a: "x" } })).toBe("/x");
      }),
    );

    it.effect("in a template value that encodes to text", () =>
      Effect.gen(function* () {
        const filter = Request.pathValue(
          "filter",
          Schema.fromJsonString(NarrowFirst),
        );
        const request = Request.get("").pipe(Request.path`/f/${filter}`);
        expect(
          yield* urlOf(request, { path: { filter: { a: "x", b: "y" } } }),
        ).toBe(`/f/${encodeURIComponent('{"a":"x","b":"y"}')}`);
      }),
    );

    it("takes every field in the type", () => {
      void takes(NarrowFirst)({ a: "x", b: "y" });
      void takes(NarrowFirst)({ a: "x" });
      void takes(Numbers)({ n: 1, d: "2" });
    });
  });

  describe("beside a stacked schema", () => {
    const Sibling = Schema.Struct({ c: text });

    it.effect("a sibling's field does not stop the choice", () =>
      Effect.gen(function* () {
        const input = { query: { a: "x", b: "y", c: "z" } };
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(NarrowFirst),
              Request.query(Sibling),
            ),
            input,
          ),
        ).toBe("/x?a=x&b=y&c=z");
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(Sibling),
              Request.query(NarrowFirst),
            ),
            input,
          ),
        ).toBe("/x?c=z&a=x&b=y");
      }),
    );

    it.effect("two unions each make their own choice", () =>
      Effect.gen(function* () {
        const Other = Schema.Union([
          Schema.Struct({ c: text }),
          Schema.Struct({ c: text, d: text }),
        ]);
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(NarrowFirst),
              Request.query(Other),
            ),
            { query: { a: "x", b: "y", c: "z", d: "w" } },
          ),
        ).toBe("/x?a=x&b=y&c=z&d=w");
      }),
    );

    it.effect("a sibling's field stays out of a member's encoded names", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Union([
          Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ a: text, b: text }).pipe(
            Schema.encodeKeys({ a: "A", b: "B" }),
          ),
        ]);
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.query(Renamed),
              Request.query(Sibling),
            ),
            { query: { A: "x", B: "y", c: "z" } },
          ),
        ).toBe("/x?A=x&B=y&c=z");
      }),
    );

    it.effect("a field the union cannot hold is still refused", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.query(Apart),
          Request.query(Sibling),
        );
        expect(
          yield* schemaFailure(request, { query: { a: "x", b: "y", c: "z" } }),
        ).toContain('["b"]');
        expect(yield* urlOf(request, { query: { a: "x", c: "z" } })).toBe(
          "/x?a=x&c=z",
        );
      }),
    );

    it.effect("works for headers too", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.headers(
            Schema.Union([
              Schema.Struct({ "x-a": text }),
              Schema.Struct({ "x-a": text, "x-b": text }),
            ]),
          ),
          Request.headers(Schema.Struct({ "x-c": text })),
        );
        expect(
          yield* linesOf(request, {
            headers: { "x-a": "1", "x-b": "2", "x-c": "3" },
          }),
        ).toEqual([
          ["x-a", "1"],
          ["x-b", "2"],
          ["x-c", "3"],
        ]);
      }),
    );

    describe("a field another schema in the group takes", () => {
      const Holds = Schema.Struct({ b: text });
      const HoldsHeader = Schema.Struct({ "x-b": text });
      const ApartHeaders = Schema.Union([
        Schema.Struct({ "x-a": text }),
        Schema.Struct({ "x-b": text }),
      ]);
      it.effect("is not lost, in either order", () =>
        Effect.gen(function* () {
          const query = { a: "x", b: "y" };
          expect(yield* urlOf(stacked(Apart, Holds), { query })).toBe(
            "/x?a=x&b=y",
          );
          expect(yield* urlOf(stacked(Holds, Apart), { query })).toBe(
            "/x?b=y&a=x",
          );
        }),
      );

      it.effect("is not lost from headers, in either order", () =>
        Effect.gen(function* () {
          const input = { headers: { "x-a": "1", "x-b": "2" } };
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.headers(ApartHeaders),
                Request.headers(HoldsHeader),
              ),
              input,
            ),
          ).toEqual([
            ["x-a", "1"],
            ["x-b", "2"],
          ]);
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.headers(HoldsHeader),
                Request.headers(ApartHeaders),
              ),
              input,
            ),
          ).toEqual([
            ["x-b", "2"],
            ["x-a", "1"],
          ]);
        }),
      );

      it.effect("is not lost with another schema between them", () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.query(Apart),
                Request.query(Schema.Struct({ c: text })),
                Request.query(Holds),
              ),
              { query: { a: "x", b: "y", c: "z" } },
            ),
          ).toBe("/x?a=x&c=z&b=y");
        }),
      );

      it.effect("is not lost however that schema holds it", () =>
        Effect.gen(function* () {
          class Held extends Schema.Class<Held>("Held")({ b: text }) {}
          const query = { a: "x", b: "y" };
          expect(yield* urlOf(stacked(Apart, Held), { query })).toBe(
            "/x?a=x&b=y",
          );
          expect(
            yield* urlOf(
              stacked(Apart, Schema.Struct({ b: Schema.optionalKey(text) })),
              { query },
            ),
          ).toBe("/x?a=x&b=y");
          const Open = Schema.Record(text, text);
          expect(yield* urlOf(stacked(Apart, Open), { query })).toBe(
            "/x?a=x&b=y",
          );
          expect(yield* urlOf(stacked(Open, Apart), { query })).toBe(
            "/x?b=y&a=x",
          );
        }),
      );

      it.effect("is not lost if that schema writes it under another name", () =>
        Effect.gen(function* () {
          const Renamed = Holds.pipe(Schema.encodeKeys({ b: "B" }));
          const query = { a: "x", b: "y" };
          expect(yield* urlOf(stacked(Apart, Renamed), { query })).toBe(
            "/x?a=x&B=y",
          );
          expect(yield* urlOf(stacked(Renamed, Apart), { query })).toBe(
            "/x?B=y&a=x",
          );
        }),
      );

      it.effect("is not lost if that schema writes nothing for it", () =>
        Effect.gen(function* () {
          const Maybe = Schema.Struct({
            b: Schema.OptionFromOptionalKey(text),
          });
          expect(
            yield* urlOf(stacked(Apart, Maybe), {
              query: { a: "x", b: Option.none() },
            }),
          ).toBe("/x?a=x");
        }),
      );

      it.effect("is not lost if a second union takes it", () =>
        Effect.gen(function* () {
          const Other = Schema.Union([
            Schema.Struct({ b: text }),
            Schema.Struct({ c: text }),
          ]);
          const query = { a: "x", b: "y" };
          expect(yield* urlOf(stacked(Apart, Other), { query })).toBe(
            "/x?a=x&b=y",
          );
          expect(yield* urlOf(stacked(Other, Apart), { query })).toBe(
            "/x?b=y&a=x",
          );
        }),
      );

      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.effect(
        "recovers when two unions can actually hold the fields between them",
        () =>
          Effect.gen(function* () {
            const Twin = Schema.Union([
              Schema.Struct({ a: text }),
              Schema.Struct({ b: text }),
            ]);
            const query = { a: "x", b: "y" };
            for (const request of [stacked(Apart, Twin), stacked(Apart, Apart)])
              expect(yield* urlOf(request, { query })).toBe("/x?b=y&a=x");
          }),
      );

      it.effect("is lost if a tag ruled out the member that states it", () =>
        Effect.gen(function* () {
          const Tagged = Schema.Union([
            Schema.Struct({ kind: Schema.Literal("one"), b: text }),
            Schema.Struct({ kind: Schema.Literal("two") }),
          ]);
          // The types refuse `b` under this tag in a literal, so it comes in a wider value.
          const query = { a: "x", b: "y", kind: "two" } as const;
          expect(
            yield* schemaFailure(stacked(Apart, Tagged), { query }),
          ).toContain('["b"]');
        }),
      );

      it.effect(
        "is lost if the union writes another field under its name",
        () =>
          Effect.gen(function* () {
            const Swapped = Schema.Union([
              Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "b" })),
              Schema.Struct({ b: text }),
            ]);
            const Other = Schema.Struct({ c: text });
            expect(
              yield* schemaFailure(stacked(Swapped, Other), {
                query: { a: "1", b: "2", c: "3" },
              }),
            ).toContain('["b"]');
          }),
      );

      it.effect(
        "is lost by its encoded name, whichever order they stack in",
        () =>
          Effect.gen(function* () {
            const Renamed = Schema.Union([
              Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
              Schema.Struct({ b: text }),
            ]);
            const query = { A: "x", b: "y" };
            for (const request of [
              stacked(Renamed, Holds),
              stacked(Holds, Renamed),
            ]) {
              const message = yield* schemaFailure(request, { query });
              expect(message).toContain('["A"]');
              expect(message).not.toContain('["b"]');
            }
          }),
      );

      it.effect("is not lost beside text that reads strictly", () =>
        Effect.gen(function* () {
          const Inner = Schema.Union([
            Schema.Struct({ x: text }),
            Schema.Struct({ y: text }),
          ]);
          const WithText = Schema.Union([
            Schema.Struct({ f: Schema.fromJsonString(Inner) }),
            Schema.Struct({ b: text, c: text }),
          ]);
          // The spaces keep the text from coming out as it went in.
          const query = { f: '{ "x": "1" }', b: "2" };
          const url = yield* urlOf(stacked(WithText, Holds), { query });
          const params = new URL(url, "http://x.test").searchParams;
          expect(params.get("f")).toBe('{"x":"1"}');
          expect(params.get("b")).toBe("2");
        }),
      );

      it.effect("leaves a raw value to a renamed schema that allows it", () =>
        Effect.gen(function* () {
          const Either = Schema.Union([
            Schema.Struct({ a: text }),
            Schema.Struct({ k: text }),
          ]);
          const Renamed = Schema.Struct({ b: Schema.optionalKey(text) }).pipe(
            Schema.encodeKeys({ b: "k" }),
          );
          for (const request of [
            stacked(Either, Renamed),
            stacked(Renamed, Either),
          ]) {
            const url = yield* urlOf(
              request.pipe(Request.setQuery("k", "raw")),
              { query: { a: "1" } },
            );
            const params = new URL(url, "http://x.test").searchParams;
            expect(params.get("a")).toBe("1");
            expect(params.get("k")).toBe("raw");
          }
        }),
      );

      it.effect("is taken under its encoded name, in either order", () =>
        Effect.gen(function* () {
          const Either = Schema.Union([
            Schema.Struct({ a: text }),
            Schema.Struct({ k: text }),
          ]);
          const Renamed = Schema.Struct({ b: Schema.optionalKey(text) }).pipe(
            Schema.encodeKeys({ b: "k" }),
          );
          const query = { a: "1", k: "2" };
          expect(yield* urlOf(stacked(Either, Renamed), { query })).toBe(
            "/x?a=1&k=2",
          );
          expect(yield* urlOf(stacked(Renamed, Either), { query })).toBe(
            "/x?k=2&a=1",
          );
        }),
      );

      it.effect("is taken if a union writes it under another name", () =>
        Effect.gen(function* () {
          const Moved = Schema.Union([
            Schema.Struct({ b: text }).pipe(Schema.encodeKeys({ b: "B" })),
            Schema.Struct({ c: text }),
          ]);
          const query = { a: "x", b: "y" };
          expect(yield* urlOf(stacked(Apart, Moved), { query })).toBe(
            "/x?a=x&B=y",
          );
          expect(yield* urlOf(stacked(Moved, Apart), { query })).toBe(
            "/x?B=y&a=x",
          );
        }),
      );

      it.effect("is lost if a schema only allows its name", () =>
        Effect.gen(function* () {
          // Names compare without case, so this allows `x-b`, but it reads the key `X-B`.
          const Allows = Schema.Struct({ "X-B": Schema.optionalKey(text) });
          const headers = { "x-a": "1", "x-b": "2" };
          for (const request of [
            Request.get("/x").pipe(
              Request.headers(ApartHeaders),
              Request.headers(Allows),
            ),
            Request.get("/x").pipe(
              Request.headers(Allows),
              Request.headers(ApartHeaders),
            ),
          ])
            expect(yield* schemaFailure(request, { headers })).toContain(
              '["x-b"]',
            );
        }),
      );

      it.effect("is lost if the other schema was unbound", () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(
            Request.query(Holds),
            Request.unbind("query"),
            Request.query(Apart),
          );
          expect(
            yield* schemaFailure(request, { query: { a: "x", b: "y" } }),
          ).toContain('["b"]');
        }),
      );

      it.effect("is only a field of the group, not one further down", () =>
        Effect.gen(function* () {
          const request = stacked(
            Schema.Struct({ filter: Schema.fromJsonString(Apart) }),
            Schema.Struct({ b: Schema.optionalKey(text) }),
          );
          expect(
            yield* schemaFailure(request, {
              query: { filter: { a: "x", b: "y" }, b: "z" },
            }),
          ).toContain('["filter"]["b"]');
        }),
      );

      it.effect("still has to fit that schema", () =>
        Effect.gen(function* () {
          const message = yield* schemaFailure(
            stacked(Apart, Schema.Struct({ b: Schema.FiniteFromString })),
            { query: { a: "x", b: "many" } },
          );
          expect(message).toContain("Expected number");
        }),
      );

      it.effect("replaces a raw value under its name, in either order", () =>
        Effect.gen(function* () {
          const query = { a: "x", b: "y" };
          const raw = Request.get("/x?b=raw");
          expect(
            yield* urlOf(raw.pipe(Request.query(Apart), Request.query(Holds)), {
              query,
            }),
          ).toBe("/x?a=x&b=y");
          expect(
            yield* urlOf(raw.pipe(Request.query(Holds), Request.query(Apart)), {
              query,
            }),
          ).toBe("/x?b=y&a=x");
          const line = Request.get("/x").pipe(Request.setHeader("X-B", "raw"));
          const headers = { "x-a": "1", "x-b": "2" };
          expect(
            yield* linesOf(
              line.pipe(
                Request.headers(ApartHeaders),
                Request.headers(HoldsHeader),
              ),
              { headers },
            ),
          ).toEqual([
            ["x-a", "1"],
            ["x-b", "2"],
          ]);
          expect(
            yield* linesOf(
              line.pipe(
                Request.headers(HoldsHeader),
                Request.headers(ApartHeaders),
              ),
              { headers },
            ),
          ).toEqual([
            ["x-b", "2"],
            ["x-a", "1"],
          ]);
        }),
      );

      it.effect("compares a union's header names without case", () =>
        Effect.gen(function* () {
          const Left = Schema.Union([
            Schema.Struct({ "x-a": text }),
            Schema.Struct({ "X-B": text }),
          ]);
          const Right = Schema.Union([
            Schema.Struct({ "X-B": text }),
            Schema.Struct({ "x-c": text }),
          ]);
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.headers(Right),
                Request.headers(Left),
              ),
              { headers: { "x-a": "1", "X-B": "2" } },
            ),
          ).toEqual([
            ["X-B", "2"],
            ["x-a", "1"],
          ]);
        }),
      );

      it.effect("compares header names without case", () =>
        Effect.gen(function* () {
          const Spelled = Schema.Union([
            Schema.Struct({ "x-a": text }),
            Schema.Struct({ "X-B": text }),
          ]);
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.headers(Schema.Struct({ "X-B": text })),
                Request.headers(Spelled),
              ),
              { headers: { "x-a": "1", "X-B": "2" } },
            ),
          ).toEqual([
            ["X-B", "2"],
            ["x-a", "1"],
          ]);
        }),
      );

      it.effect("holds a raw value the caller left out, in either order", () =>
        Effect.gen(function* () {
          const Optional = Schema.Struct({ b: Schema.optionalKey(text) });
          const raw = Request.get("/x?b=1");
          const query = { a: "x" };
          expect(
            yield* urlOf(
              raw.pipe(Request.query(Apart), Request.query(Optional)),
              { query },
            ),
          ).toBe("/x?a=x&b=1");
          expect(
            yield* urlOf(
              raw.pipe(Request.query(Optional), Request.query(Apart)),
              { query },
            ),
          ).toBe("/x?b=1&a=x");
          const line = Request.get("/x").pipe(Request.setHeader("x-b", "1"));
          const OptionalHeader = Schema.Struct({
            "x-b": Schema.optionalKey(text),
          });
          expect(
            yield* linesOf(
              line.pipe(
                Request.headers(ApartHeaders),
                Request.headers(OptionalHeader),
              ),
              { headers: { "x-a": "2" } },
            ),
          ).toEqual([
            ["x-a", "2"],
            ["x-b", "1"],
          ]);
        }),
      );

      it.effect("is no reason to leave a raw value under another name", () =>
        Effect.gen(function* () {
          // This schema reads `b` and writes `k`, so a raw `b` is not its to settle.
          const Renamed = Schema.Struct({ b: Schema.optionalKey(text) }).pipe(
            Schema.encodeKeys({ b: "k" }),
          );
          const error = yield* refusal(
            Request.get("/x?b=1").pipe(
              Request.query(Apart),
              Request.query(Renamed),
            ),
            { query: { a: "x" } },
          );
          expect(error.message).toContain('"b"');
        }),
      );

      it.effect(
        "still checks that raw value against the schema it stays with",
        () =>
          Effect.gen(function* () {
            const Numbered = Schema.Struct({
              b: Schema.optionalKey(Schema.FiniteFromString),
            });
            const error = yield* refusal(
              Request.get("/x?b=many").pipe(
                Request.query(Apart),
                Request.query(Numbered),
              ),
              { query: { a: "x" } },
            );
            expect(error.message).toContain('"b"');
          }),
      );

      it.effect("is no reason to leave a raw value to another union", () =>
        Effect.gen(function* () {
          const Twin = Schema.Union([
            Schema.Struct({ a: text }),
            Schema.Struct({ b: text }),
          ]);
          const error = yield* refusal(
            Request.get("/x?b=1").pipe(
              Request.query(Apart),
              Request.query(Twin),
            ),
            { query: { a: "x" } },
          );
          expect(error.message).toContain('"b"');
        }),
      );

      it.effect("leaves a schema's own default going through it", () =>
        Effect.gen(function* () {
          const Own = Schema.Struct({
            b: Schema.OptionFromOptionalKey(Schema.FiniteFromString),
          });
          const request = Request.get("/x?b=many").pipe(
            Request.query(Own),
            Request.query(Apart),
          );
          // It took `b` and wrote nothing, so raw text under that name is still its to check.
          const query = { a: "x", b: Option.none() } as never;
          const error = yield* refusal(request, { query });
          expect(error.message).toContain('"b"');
        }),
      );

      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.effect(
        "recovers a bare union after the sibling takes its lost field",
        () =>
          Effect.gen(function* () {
            const Either = Schema.Union([
              Schema.Struct({ b: text }),
              Schema.Struct({ a: text, c: text }),
            ]);
            expect(
              yield* urlOf(stacked(Either, Holds), {
                query: { a: "x", b: "y", c: "z" },
              }),
            ).toBe("/x?a=x&c=z&b=y");
            const Reordered = Schema.Union([
              Schema.Struct({ a: text, c: text }),
              Schema.Struct({ b: text }),
            ]);
            expect(
              yield* urlOf(stacked(Reordered, Holds), {
                query: { a: "x", b: "y", c: "z" },
              }),
            ).toBe("/x?a=x&c=z&b=y");
            // Binding the member you mean leaves nothing to choose.
            expect(
              yield* urlOf(
                stacked(Schema.Struct({ a: text, c: text }), Holds),
                {
                  query: { a: "x", b: "y", c: "z" },
                },
              ),
            ).toBe("/x?a=x&c=z&b=y");
          }),
      );
    });
  });

  describe("a field no member can keep", () => {
    it.effect("is refused before anything is sent, and named", () =>
      Effect.gen(function* () {
        const message = yield* schemaFailure(queried(Apart), {
          query: { a: "secret-a", b: "secret-b" },
        });
        expect(message).toContain("The schema cannot keep this field");
        expect(message).toContain('["b"]');
        expect(message).not.toContain("secret");
      }),
    );

    it.effect("is refused in headers and in a path", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({ "x-a": text }),
          Schema.Struct({ "x-b": text }),
        ]);
        const headers = Request.get("/x").pipe(Request.headers(Either));
        expect(
          yield* schemaFailure(headers, {
            headers: { "x-a": "1", "x-b": "2" },
          }),
        ).toContain('["x-b"]');
        const path = Request.get("").pipe(Request.path(Apart, () => "/x"));
        expect(
          yield* schemaFailure(path, { path: { a: "1", b: "2" } }),
        ).toContain('["b"]');
      }),
    );

    it.effect("is refused on the encoded side, by its encoded name", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Union([
          Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ b: text }).pipe(Schema.encodeKeys({ b: "B" })),
        ]);
        expect(
          yield* schemaFailure(queried(Renamed), {
            query: { A: "x", B: "y" },
          }),
        ).toContain('["B"]');
      }),
    );

    it.effect("is refused in a mix by field", () =>
      Effect.gen(function* () {
        const Mixed = Schema.Union([
          Schema.Struct({
            n: Schema.FiniteFromString,
            d: Schema.FiniteFromString,
            a: text,
          }),
          Schema.Struct({
            n: Schema.FiniteFromString,
            d: Schema.FiniteFromString,
            b: text,
          }),
        ]);
        expect(
          yield* schemaFailure(queried(Mixed), {
            query: { n: 1, d: "2", a: "x", b: "y" },
          }),
        ).toContain('["b"]');
      }),
    );

    it.effect("is the field that would go, not the one that stays", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Union([
          Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ b: text }),
        ]);
        const message = yield* schemaFailure(queried(Renamed), {
          query: { A: "x", b: "y" },
        });
        expect(message).toContain('["A"]');
        expect(message).not.toContain('["b"]');
      }),
    );

    it.effect(
      "is refused under a field that holds JSON, but not in its text",
      () =>
        Effect.gen(function* () {
          const InText = Schema.Struct({
            filter: Schema.fromJsonString(Apart),
          });
          const decoded = yield* schemaFailure(queried(InText), {
            query: { filter: { a: "1", b: "2" } },
          });
          expect(decoded).toContain('["filter"]["b"]');
          const url = yield* urlOf(queried(InText), {
            query: { filter: '{"a":"1","b":"2"}' },
          });
          expect(new URL(url, "http://x.test").searchParams.get("filter")).toBe(
            '{"a":"1"}',
          );
        }),
    );

    it.effect(
      "is refused in an Option whose encoded side states it, but not in Schema.Option",
      () =>
        Effect.gen(function* () {
          const value = Option.some({ a: "1", b: "2" });
          const seen = Schema.Struct({ f: Schema.OptionFromNullOr(Apart) });
          expect(
            yield* schemaFailure(
              Request.post("/x").pipe(Request.body(Body.jsonSchema(seen))),
              { body: { f: value } },
            ),
          ).toContain('["f"]["value"]["b"]');
          const opaque = Schema.Struct({ f: Schema.Option(Apart) });
          expect(
            yield* bodyOf(
              Request.post("/x").pipe(Request.body(Body.jsonSchema(opaque))),
              { body: { f: value } },
            ),
          ).not.toContain('"b"');
        }),
    );

    it.effect("is ruled out by a tag that is a union of literals", () =>
      Effect.gen(function* () {
        const Tagged = Schema.Union([
          Schema.Struct({ kind: Schema.Literals(["a", "b"]), x: text }),
          Schema.Struct({ kind: Schema.Literal("c") }),
        ]);
        const query = { kind: "c", x: "1" } as const;
        expect(yield* urlOf(queried(Tagged), { query })).toBe("/x?kind=c");
        expect(
          yield* urlOf(queried(Tagged), { query: { kind: "b", x: "1" } }),
        ).toBe("/x?kind=b&x=1");
      }),
    );

    it.effect(
      "is refused if the union writes another object under its name",
      () =>
        Effect.gen(function* () {
          const Inner = Schema.Struct({ x: text });
          const Swapped = Schema.Union([
            Schema.Struct({ a: Inner }).pipe(Schema.encodeKeys({ a: "b" })),
            Schema.Struct({ b: Inner, c: text }),
          ]);
          const request = Request.post("/x").pipe(
            Request.body(Body.jsonSchema(Swapped)),
          );
          expect(
            yield* schemaFailure(request, {
              body: { a: { x: "1" }, b: { x: "2" } },
            }),
          ).toContain('["b"]');
          expect(
            yield* bodyOf(request, { body: { a: { x: "1" }, b: { x: "1" } } }),
          ).toBe('{"b":{"x":"1"}}');
        }),
    );

    it.effect("is refused where only the encoded side shows the member", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({ a: text }),
          Schema.Struct({ b: text }).pipe(Schema.encodeKeys({ b: "k" })),
        ]);
        expect(
          yield* schemaFailure(queried(Either), {
            query: { a: "x", k: "y" },
          }),
        ).toContain('["k"]');
      }),
    );

    it.effect("is refused inside a union of unions", () =>
      Effect.gen(function* () {
        const Nested = Schema.Union([NarrowFirst, Schema.Struct({ c: text })]);
        expect(
          yield* schemaFailure(queried(Nested), {
            query: { a: "x", c: "z" },
          }),
        ).toContain('["c"]');
      }),
    );

    it.effect("is refused where a wider member refuses its value", () =>
      Effect.gen(function* () {
        const Wider = Schema.Union([
          Schema.Struct({ a: text }),
          Schema.Struct({ a: text, b: Schema.FiniteFromString }),
        ]);
        expect(
          yield* schemaFailure(queried(Wider), {
            query: { a: "x", b: "many" },
          }),
        ).toContain('["b"]');
      }),
    );

    it.effect("reads as any other failure if no member fits at all", () =>
      Effect.gen(function* () {
        const message = yield* schemaFailure(queried(Numbers), {
          query: { n: "many" },
        });
        expect(message).toContain("Expected number");
        expect(message).not.toContain("The schema cannot keep");
      }),
    );
  });

  describe("a field the schema never held is not this refusal", () => {
    it.effect("stripping a key no member states, as a struct does", () =>
      Effect.gen(function* () {
        const query = { a: "x", z: "stray" };
        expect(yield* urlOf(queried(Apart), { query })).toBe("/x?a=x");
        expect(
          yield* urlOf(queried(Schema.Struct({ a: text })), { query }),
        ).toBe("/x?a=x");
      }),
    );

    it.effect("keeping the rest of the fields beside such a key", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(queried(NarrowFirst), {
            query: { a: "x", b: "y", z: "stray" },
          }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("taking `undefined` as no field", () =>
      Effect.gen(function* () {
        const query = { a: "x", b: undefined };
        expect(yield* urlOf(queried(Apart), { query })).toBe("/x?a=x");
        expect(yield* urlOf(queried(NarrowFirst), { query })).toBe("/x?a=x");
      }),
    );

    it.effect("so `undefined` cannot take a value from another member", () =>
      Effect.gen(function* () {
        for (const b of [Schema.optionalKey(text), Schema.optional(text)]) {
          const Either = Schema.Union([
            Schema.Struct({ a: text, b }),
            Schema.Struct({ a: text, c: text }),
          ]);
          const value = { a: "x", b: undefined, c: "z" };
          expect(yield* urlOf(queried(Either), { query: value })).toBe(
            "/x?a=x&c=z",
          );
          const Rendered = Request.get("").pipe(
            Request.path(Either, (held) => `/${JSON.stringify(held)}`),
          );
          expect(yield* urlOf(Rendered, { path: value })).toBe(
            '/{"a":"x","c":"z"}',
          );
        }
        const Headered = Schema.Union([
          Schema.Struct({ "x-a": text, "x-b": Schema.optionalKey(text) }),
          Schema.Struct({ "x-a": text, "x-c": text }),
        ]);
        expect(
          yield* linesOf(Request.get("/x").pipe(Request.headers(Headered)), {
            headers: { "x-a": "1", "x-b": undefined, "x-c": "3" },
          }),
        ).toEqual([
          ["x-a", "1"],
          ["x-c", "3"],
        ]);
      }),
    );

    it.effect("holding on to what a read kept when it writes", () =>
      Effect.gen(function* () {
        // Neither strict read can take this: one has `b`, and the other has no `r`. So it is read
        // as Effect reads it, and only a strict write keeps the member the read chose.
        const Either = Schema.Union([
          Schema.Struct({ a: text, b: Schema.optionalKey(text) }),
          Schema.Struct({ a: text, c: text, r: Schema.UndefinedOr(text) }),
        ]);
        expect(
          yield* urlOf(queried(Either), {
            query: { a: "x", b: undefined, c: "z", r: undefined },
          }),
        ).toBe("/x?a=x&c=z");
      }),
    );

    it.effect("keeping `undefined` where a schema requires the key", () =>
      Effect.gen(function* () {
        const Maybe = Schema.UndefinedOr(text);
        const Either = Schema.Union([
          Schema.Struct({ a: Maybe }),
          Schema.Struct({ a: Maybe, c: text }),
        ]);
        expect(
          yield* urlOf(queried(Either), { query: { a: undefined, c: "z" } }),
        ).toBe("/x?c=z");
      }),
    );

    it.effect(
      "reading a decoded name beside its encoded twin, as a struct does",
      () =>
        Effect.gen(function* () {
          const Renamed = Schema.Struct({ a: text }).pipe(
            Schema.encodeKeys({ a: "A" }),
          );
          const Choice = Schema.Union([Renamed, Schema.Struct({ b: text })]);
          for (const query of [
            { a: "1", A: "2" },
            { a: "1", A: "1" },
          ]) {
            expect(yield* urlOf(queried(Renamed), { query })).toBe("/x?A=1");
            expect(yield* urlOf(queried(Choice), { query })).toBe("/x?A=1");
          }
          const InBody = Schema.Struct({ f: NarrowFirst }).pipe(
            Schema.encodeKeys({ f: "F" }),
          );
          const body = { f: { a: "1" }, F: { a: "2" } };
          const compiled = yield* compile(
            Request.post("/x").pipe(Request.body(Body.jsonSchema(InBody))),
            { body },
          );
          expect(bodyText(compiled.request)).toBe('{"F":{"a":"1"}}');
        }),
    );

    it.effect("reading a tag on the side it is written on", () =>
      Effect.gen(function* () {
        const Written = Schema.Literal("a").pipe(
          Schema.decodeTo(
            Schema.Literal("A"),
            SchemaTransformation.transform({
              decode: () => "A" as const,
              encode: () => "a" as const,
            }),
          ),
        );
        const Tagged = Schema.Union([
          Schema.Struct({ kind: Written, x: Schema.optionalKey(text) }),
          Schema.Struct({ kind: Schema.Literal("a") }),
        ]);
        const query = { kind: "a", x: "y", stray: "z" } as never;
        expect(yield* urlOf(queried(Tagged), { query })).toBe("/x?kind=a&x=y");
      }),
    );

    it.effect("leaving a tag to choose", () =>
      Effect.gen(function* () {
        const Tagged = Schema.Union([
          Schema.Struct({ kind: Schema.Literal("a"), x: text }),
          Schema.Struct({ kind: Schema.Literal("b") }),
        ]);
        // The tag has already ruled out the member that states `x`, and the types refuse it in a
        // literal, so it comes in a wider value.
        const query = { kind: "b", x: "y" } as const;
        expect(yield* urlOf(queried(Tagged), { query })).toBe("/x?kind=b");
      }),
    );
  });

  describe("input that must keep working", () => {
    it.effect("a transformation of a member's field", () =>
      Effect.gen(function* () {
        const Shout = text.pipe(
          Schema.decodeTo(
            text,
            SchemaTransformation.transform({
              decode: (value) => value.toLowerCase(),
              encode: (value) => value.toUpperCase(),
            }),
          ),
        );
        const Either = Schema.Union([
          Schema.Struct({ a: Shout }),
          Schema.Struct({ a: Shout, b: Shout }),
        ]);
        expect(
          yield* urlOf(queried(Either), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=X&b=Y");
      }),
    );

    it.effect("a renamed field, on each side", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Union([
          Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ a: text, b: text }).pipe(
            Schema.encodeKeys({ a: "A", b: "B" }),
          ),
        ]);
        for (const query of [
          { a: "x", b: "y" },
          { A: "x", B: "y" },
        ])
          expect(yield* urlOf(queried(Renamed), { query })).toBe("/x?A=x&B=y");
        expect(yield* urlOf(queried(Renamed), { query: { A: "x" } })).toBe(
          "/x?A=x",
        );
      }),
    );

    it.effect("`Option.none()`, which writes no key", () =>
      Effect.gen(function* () {
        const Maybe = Schema.OptionFromOptionalKey(text);
        const Either = Schema.Union([
          Schema.Struct({ a: Maybe }),
          Schema.Struct({ a: Maybe, b: text }),
        ]);
        expect(
          yield* urlOf(queried(Either), { query: { a: Option.none() } }),
        ).toBe("/x");
        expect(
          yield* urlOf(queried(Either), {
            query: { a: Option.none(), b: "y" },
          }),
        ).toBe("/x?b=y");
        expect(
          yield* urlOf(queried(Either), {
            query: { a: Option.some("x"), b: "y" },
          }),
        ).toBe("/x?a=x&b=y");
      }),
    );

    it.effect("a class, as an instance and as a plain value", () =>
      Effect.gen(function* () {
        class First extends Schema.Class<First>("First")({ a: text }) {}
        class Second extends Schema.Class<Second>("Second")({ b: text }) {}
        const request = queried(Schema.Union([First, Second]));
        for (const query of [{ a: "x" }, new First({ a: "x" })])
          expect(yield* urlOf(request, { query })).toBe("/x?a=x");
        for (const query of [{ b: "y" }, new Second({ b: "y" })])
          expect(yield* urlOf(request, { query })).toBe("/x?b=y");
      }),
    );

    it.effect("a class with a property of its own", () =>
      Effect.gen(function* () {
        class Counted extends Schema.Class<Counted>("Counted")({ a: text }) {
          readonly reads = 1;
        }
        class Other extends Schema.Class<Other>("Other")({ b: text }) {}
        expect(
          yield* urlOf(queried(Schema.Union([Counted, Other])), {
            query: new Counted({ a: "x" }),
          }),
        ).toBe("/x?a=x");
      }),
    );

    it.effect("a member that drops a field by design", () =>
      Effect.gen(function* () {
        const Legacy = Schema.Struct({
          a: text,
          legacy: Schema.optionalKey(text),
        }).pipe(
          Schema.decodeTo(
            Schema.Struct({ a: text }),
            SchemaTransformation.transform({
              decode: ({ a }) => ({ a }),
              encode: ({ a }) => ({ a }),
            }),
          ),
        );
        const request = queried(
          Schema.Union([Legacy, Schema.Struct({ legacy: text, c: text })]),
        );
        expect(
          yield* urlOf(request, { query: { a: "x", legacy: "old" } }),
        ).toBe("/x?a=x");
      }),
    );

    it.effect("a member whose transformation hands on a whole object", () =>
      Effect.gen(function* () {
        const Inner = Schema.Struct({ x: text });
        const Spread = Schema.Struct({ a: Inner }).pipe(
          Schema.decodeTo(
            Schema.Struct({ b: Inner }),
            SchemaTransformation.transform({
              decode: (value): { readonly b: { readonly x: string } } => ({
                ...value,
                b: value.a,
              }),
              encode: (value): { readonly a: { readonly x: string } } => ({
                ...value,
                a: value.b,
              }),
            }),
          ),
        );
        const compiled = yield* compile(
          Request.post("/x").pipe(
            Request.body(
              Body.jsonSchema(
                Schema.Union([Spread, Schema.Struct({ a: Inner, c: text })]),
              ),
            ),
          ),
          { body: { a: { x: "1" } } },
        );
        expect(bodyText(compiled.request)).toBe('{"a":{"x":"1"}}');
      }),
    );

    it.effect(
      "a member whose transformation hands on more than it states",
      () =>
        Effect.gen(function* () {
          const Spread = Schema.Struct({ a: text }).pipe(
            Schema.decodeTo(
              Schema.Struct({ b: text }),
              SchemaTransformation.transform({
                decode: (value): { readonly b: string } => ({
                  ...value,
                  b: value.a,
                }),
                encode: (value): { readonly a: string } => ({
                  ...value,
                  a: value.b,
                }),
              }),
            ),
          );
          const request = queried(
            Schema.Union([Spread, Schema.Struct({ a: text, c: text })]),
          );
          expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x");
        }),
    );

    it.effect("a schema with the same type on both sides", () =>
      Effect.gen(function* () {
        const Coded = Schema.StringFromBase64;
        const Either = Schema.Union([
          Schema.Struct({ s: Coded }),
          Schema.Struct({ s: Coded, t: text }),
        ]);
        expect(yield* urlOf(queried(Either), { query: { s: "hi" } })).toBe(
          "/x?s=aGk%3D",
        );
        expect(
          yield* urlOf(queried(Either), { query: { s: "hi", t: "y" } }),
        ).toBe("/x?s=aGk%3D&t=y");
      }),
    );

    it.effect(
      "a schema's encoder, which runs once where nothing is stripped",
      () =>
        Effect.gen(function* () {
          let writes = 0;
          const Counted = text.pipe(
            Schema.decodeTo(
              text,
              SchemaTransformation.transform({
                decode: (value) => value,
                encode: (value) => {
                  writes += 1;
                  return value;
                },
              }),
            ),
          );
          const Wide = Schema.Union([
            Schema.Struct({ a: Counted }),
            Schema.Struct({ a: Counted, b: text }),
          ]);
          yield* urlOf(queried(Wide), { query: { a: "x", b: "y" } });
          expect(writes).toBe(1);
          writes = 0;
          yield* urlOf(queried(Schema.Struct({ a: Counted })), {
            query: { a: "x" },
          });
          expect(writes).toBe(1);
        }),
    );

    it.effect("a union with no choice between objects", () =>
      Effect.gen(function* () {
        const Nullable = Schema.Struct({
          a: Schema.NullOr(text),
          b: Schema.optional(Schema.Union([text, Schema.Array(text)])),
        });
        expect(
          yield* urlOf(queried(Nullable), {
            query: { a: null, b: ["x", "y"], z: "stray" } as never,
          }),
        ).toBe("/x?a&b=x&b=y");
      }),
    );

    it.effect("a schema that suspends", () =>
      Effect.gen(function* () {
        interface Tree {
          readonly a: string;
          readonly next?: Tree;
        }
        const Tree: Schema.Codec<Tree> = Schema.Struct({
          a: text,
          next: Schema.optionalKey(Schema.suspend(() => Tree)),
        });
        const body = Request.post("/x").pipe(
          Request.body(Body.jsonSchema(Tree)),
        );
        const compiled = yield* compile(body, {
          body: { a: "1", next: { a: "2" } },
        });
        expect(bodyText(compiled.request)).toBe('{"a":"1","next":{"a":"2"}}');
      }),
    );

    it.effect("a schema whose steps take time", () =>
      Effect.gen(function* () {
        const Later = text.pipe(
          Schema.decodeTo(
            text,
            SchemaTransformation.transformEffect({
              decode: (value) => Effect.as(Effect.yieldNow, value),
              encode: (value) => Effect.as(Effect.yieldNow, value),
            }),
          ),
        );
        const Either = Schema.Union([
          Schema.Struct({ a: Later }),
          Schema.Struct({ a: Later, b: text }),
        ]);
        expect(
          yield* urlOf(queried(Either), { query: { a: "x", b: "y" } }),
        ).toBe("/x?a=x&b=y");
        expect(
          yield* urlOf(queried(Either), { query: { a: "x", z: "stray" } }),
        ).toBe("/x?a=x");
      }),
    );
  });
});
