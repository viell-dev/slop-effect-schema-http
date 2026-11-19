import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { HttpBody, UrlParams } from "effect/http";
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
import { bodyText, empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const post = <S extends Schema.Top>(schema: S) =>
  Request.post("https://example.test/x").pipe(
    Request.body(Body.jsonSchema(schema)),
  );

describe("signature-less object candidates under unions", () => {
  const Empty = Schema.Struct({});
  const A = Schema.Struct({ a: Schema.String });

  it.effect("keeps supplied keys when every object candidate is empty", () =>
    Effect.gen(function* () {
      class EmptyClass extends Schema.Class<EmptyClass>("EmptyClass")({}) {}
      const tag = { tag: "a" };
      for (const value of [
        Schema.Union([Empty, Schema.Literal("x")]),
        Schema.Union([EmptyClass, Schema.Null]),
      ]) {
        expect(yield* bodyOf(post(value), { body: tag })).toBe('{"tag":"a"}');
        // The renamed sibling requires strict normalization of the whole request value.
        const strict = Schema.Struct({ e: value, title: Schema.String }).pipe(
          Schema.encodeKeys({ title: "wire_title" }),
        );
        expect(
          yield* bodyOf(post(strict), { body: { e: tag, title: "item" } }),
        ).toBe('{"e":{"tag":"a"},"wire_title":"item"}');
      }
    }),
  );

  it.effect(
    "keeps the keys of the only object candidate inside a union member",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Union([Schema.Struct({ e: Empty }), A]);
        expect(yield* bodyOf(post(schema), { body: { e: { tag: "a" } } })).toBe(
          '{"e":{"tag":"a"}}',
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect(
    "currently strips unstated keys when a stated member is available",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Union([A, Empty]);
        const input = { a: "x", z: 1 };
        expect(yield* bodyOf(post(schema), { body: input })).toBe('{"a":"x"}');
        expect(yield* urlOf(queried(schema), { query: input })).toBe("/x?a=x");
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect(
    "currently uses the stated member's query default beside an empty struct",
    () =>
      Effect.gen(function* () {
        const Filter = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Union([Filter, Empty]);
        expect(yield* urlOf(queried(schema), { query: { tag: "a" } })).toBe(
          "/x?page_size=25",
        );
      }),
  );
});

describe("a Void member beside a renamed object", () => {
  const Filter = Schema.Struct({
    limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
      Schema.withConstructorDefault(Effect.succeed(25)),
    ),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const VoidFirst = Schema.Union([Schema.Void, Filter]);
  const VoidLast = Schema.Union([Filter, Schema.Void]);

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps an encoded field in either member order", () =>
    Effect.gen(function* () {
      for (const schema of [VoidFirst, VoidLast])
        expect(yield* bodyOf(post(schema), { body: { page_size: "05" } })).toBe(
          '{"page_size":"5"}',
        );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps a decoded field in either member order", () =>
    Effect.gen(function* () {
      for (const schema of [VoidFirst, VoidLast])
        expect(yield* bodyOf(post(schema), { body: { limit: 5 } })).toBe(
          '{"page_size":"5"}',
        );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("refuses an encoded field that would be discarded", () =>
    Effect.gen(function* () {
      const provider = synthetic(() => empty(204));
      for (const schema of [VoidFirst, VoidLast]) {
        const operation = Operation.make(
          post(schema),
          Response.status(204, Body.empty),
        );
        const result = yield* operation
          .execute({ body: { page_size: "many" } })
          .pipe(Effect.provide(provider.layer), Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") continue;
        expect(result.failure).toBeInstanceOf(Schema.SchemaError);
        expect(String(result.failure)).toContain('["page_size"]');
        expect(String(result.failure)).not.toContain("many");
      }
      expect(provider.exchanges).toHaveLength(0);
    }),
  );

  it.effect("keeps first-fit behavior when no field is supplied", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(post(VoidFirst), { body: {} })).toBe("null");
      expect(yield* bodyOf(post(VoidLast), { body: {} })).toBe(
        '{"page_size":"25"}',
      );
      for (const schema of [VoidFirst, VoidLast])
        expect(yield* bodyOf(post(schema), { body: undefined })).toBe("null");
    }),
  );

  it.effect("preserves the value read by Unknown and Any", () =>
    Effect.gen(function* () {
      for (const member of [Schema.Unknown, Schema.Any]) {
        for (const schema of [
          Schema.Union([Filter, member]),
          Schema.Union([Schema.Void, member]),
        ]) {
          expect(
            yield* bodyOf(post(schema), { body: { page_size: "05" } }),
          ).toBe('{"page_size":"05"}');
        }
      }
    }),
  );

  it.effect("keeps or refuses the object in a field and an array element", () =>
    Effect.gen(function* () {
      for (const schema of [VoidFirst, VoidLast]) {
        const field = post(Schema.Struct({ filter: schema }));
        const array = post(Schema.Array(schema));
        for (const filter of [{ page_size: "05" }, { limit: 5 }]) {
          expect(yield* bodyOf(field, { body: { filter } })).toBe(
            '{"filter":{"page_size":"5"}}',
          );
          expect(yield* bodyOf(array, { body: [filter] })).toBe(
            '[{"page_size":"5"}]',
          );
        }
        expect(
          yield* schemaFailure(field, {
            body: { filter: { page_size: "many" } },
          }),
        ).toContain('["filter"]');
        expect(
          yield* schemaFailure(array, { body: [{ page_size: "many" }] }),
        ).toContain("[0]");
      }
      expect(
        yield* bodyOf(post(Schema.Array(VoidFirst)), {
          body: [{}, { page_size: "05" }],
        }),
      ).toBe('[null,{"page_size":"5"}]');
    }),
  );

  it.effect("keeps or refuses a path input at each visible level", () =>
    Effect.gen(function* () {
      for (const schema of [VoidFirst, VoidLast]) {
        const request = Request.get("").pipe(
          Request.path(schema, (value) => `/${value?.page_size ?? "empty"}`),
        );
        const nested = Request.get("").pipe(
          Request.path(
            Schema.Struct({ filter: schema }),
            ({ filter }) => `/${filter?.page_size ?? "empty"}`,
          ),
        );
        const array = Request.get("").pipe(
          Request.path(
            Schema.Array(schema),
            ([filter]) => `/${filter?.page_size ?? "empty"}`,
          ),
        );
        for (const filter of [{ page_size: "05" }, { limit: 5 }]) {
          expect(yield* urlOf(request, { path: filter })).toBe("/5");
          expect(yield* urlOf(nested, { path: { filter } })).toBe("/5");
          expect(yield* urlOf(array, { path: [filter] })).toBe("/5");
        }
        const invalid = { page_size: "many" };
        expect(yield* schemaFailure(request, { path: invalid })).toContain(
          '["page_size"]',
        );
        expect(
          yield* schemaFailure(nested, { path: { filter: invalid } }),
        ).toContain('["filter"]');
        expect(yield* schemaFailure(array, { path: [invalid] })).toContain(
          "[0]",
        );
      }
    }),
  );

  it.effect(
    "runs a winning decoder and encoder once and keeps union checks",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let writes = 0;
        const Counted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transform({
              decode: (value) => {
                reads += 1;
                return Number(value);
              },
              encode: (value) => {
                writes += 1;
                return String(value);
              },
            }),
          ),
        );
        const ObjectMember = Schema.Struct({ limit: Counted }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const Checked = Schema.Union([Schema.Void, ObjectMember]).check(
          Schema.makeFilter((value) => value === undefined || value.limit <= 5),
        );
        const request = post(Checked);
        expect(yield* bodyOf(request, { body: { page_size: "05" } })).toBe(
          '{"page_size":"5"}',
        );
        expect([reads, writes]).toEqual([1, 1]);
        expect(
          yield* schemaFailure(request, { body: { page_size: "06" } }),
        ).toContain('["page_size"]');
      }),
  );

  it.effect("keeps visible filter objects bound to query and header text", () =>
    Effect.gen(function* () {
      for (const schema of [VoidFirst, VoidLast]) {
        const group = Schema.Struct({ filter: Schema.fromJsonString(schema) });
        const query = queried(group);
        const headers = Request.get("/x").pipe(Request.headers(group));
        const written = '{"page_size":"5"}';
        for (const filter of [{ limit: 5 }, { page_size: "05" }]) {
          expect(yield* urlOf(query, { query: { filter } })).toBe(
            `/x?filter=${encodeURIComponent(written)}`,
          );
          expect(yield* linesOf(headers, { headers: { filter } })).toEqual([
            ["filter", written],
          ]);
        }
        // The text codec exposes the alias as JSON text in its input type. Exercise JS callers too.
        const invalid = { filter: { page_size: "many" } } as never;
        expect(yield* schemaFailure(query, { query: invalid })).toContain(
          '["filter"]',
        );
        expect(yield* schemaFailure(headers, { headers: invalid })).toContain(
          '["filter"]',
        );
      }
    }),
  );
});

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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/250
  describe("a member the write falls back to", () => {
    const Note = Schema.Struct({ title: text, meta: Schema.Unknown });
    const Title = Schema.Struct({ title: text });
    /** Text whose encoded side needs two characters, so a short value fails only when written. */
    const Code = text.pipe(
      Schema.encodeTo(text.check(Schema.isMinLength(2)), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    );
    const Coded = Schema.Struct({ title: text, code: Code });
    const note = { title: "a", meta: new Date(0) };
    const coded = { title: "a", code: "x" };
    const form = Body.encoder((value: Readonly<Record<string, string>>) =>
      Effect.succeed(HttpBody.urlParams(UrlParams.fromInput(value))),
    );
    /** What a query, headers, JSON body, form body and path send, or the refusal. */
    const everywhere = (
      schema: Schema.Codec<object, Record<string, string>>,
      input: Readonly<Record<string, string>> = coded,
    ) =>
      Effect.forEach(
        [
          urlOf(queried(schema), { query: input }),
          Effect.map(
            linesOf(Request.get("/x").pipe(Request.headers(schema)), {
              headers: input,
            }),
            (lines) => JSON.stringify(lines),
          ),
          bodyOf(post(schema), { body: input }),
          bodyOf(
            Request.post("/x").pipe(
              Request.body(form.pipe(Body.encodeSchema(schema))),
            ),
            { body: input },
          ),
          urlOf(
            Request.get("").pipe(
              Request.path(schema, (value) => `/${JSON.stringify(value)}`),
            ),
            { path: input },
          ),
        ] as const,
        (prepared: Effect.Effect<string | undefined, unknown>) =>
          Effect.catchIf(
            prepared,
            (error) => error instanceof Schema.SchemaError,
            (error) => Effect.succeed(`refused: ${error.message}`),
          ),
      );

    it.effect(
      "refuses with the first member's error where no member keeps the field",
      () =>
        Effect.gen(function* () {
          const alone = yield* schemaFailure(post(Note), { body: note });
          expect(alone).toBe('Expected JSON value\n  at ["meta"]');
          for (const schema of [
            Schema.Union([Note, Title]),
            Schema.Union([Note, Schema.Void, Title]),
            Schema.Union([Note, Title, Schema.Void]),
          ])
            expect(yield* schemaFailure(post(schema), { body: note })).toBe(
              alone,
            );
          expect(
            yield* schemaFailure(
              post(Schema.Struct({ x: Schema.Union([Note, Title]) })),
              { body: { x: note } },
            ),
          ).toBe('Expected JSON value\n  at ["x"]["meta"]');
          expect(
            yield* schemaFailure(
              post(Schema.Array(Schema.Union([Note, Title]))),
              { body: [note] },
            ),
          ).toBe('Expected JSON value\n  at [0]["meta"]');
          const refused = yield* everywhere(Coded);
          expect(refused).toEqual(
            Array(5).fill(
              'refused: Expected a value with a length of at least 2\n  at ["code"]',
            ),
          );
          expect(yield* everywhere(Schema.Union([Coded, Title]))).toEqual(
            refused,
          );
        }),
    );

    it.effect("keeps a member that writes every supplied field", () =>
      Effect.gen(function* () {
        const either = Schema.Union([Note, Title]);
        expect(
          yield* bodyOf(post(either), { body: { title: "a", meta: 1 } }),
        ).toBe('{"title":"a","meta":1}');
        expect(yield* bodyOf(post(either), { body: { title: "a" } })).toBe(
          '{"title":"a"}',
        );
        expect(
          yield* everywhere(Schema.Union([Coded, Title]), {
            title: "a",
            code: "xy",
          }),
        ).toEqual([
          "/x?title=a&code=xy",
          '[["title","a"],["code","xy"]]',
          '{"title":"a","code":"xy"}',
          "title=a&code=xy",
          '/{"title":"a","code":"xy"}',
        ]);
      }),
    );

    it.effect("keeps a field the relaxed write sends under its wire name", () =>
      Effect.gen(function* () {
        // The member writes `b` as `a`, and hands its whole input on, so the strict write
        // refuses the `b` it carries. The relaxed write sends `a`, which reads back as `b`.
        const Renamer = Schema.Struct({ a: text }).pipe(
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
        const schema = Schema.Union([Renamer, Schema.Struct({ c: text })]);
        expect(yield* bodyOf(post(schema), { body: { b: "x" } })).toBe(
          '{"a":"x"}',
        );
        expect(yield* urlOf(queried(schema), { query: { b: "x" } })).toBe(
          "/x?a=x",
        );
      }),
    );

    it.effect(
      "keeps a field an encode-only member sends under another name",
      () =>
        Effect.gen(function* () {
          // Nothing reads the output back, so a member that cannot be decoded can still write.
          const OneWay = Schema.Struct({ a: text }).pipe(
            Schema.decodeTo(Schema.Struct({ b: text }), {
              decode: SchemaGetter.forbidden(() => "written only"),
              encode: SchemaGetter.transform(
                (value: { readonly b: string }) => ({ ...value, a: value.b }),
              ),
            }),
          );
          for (const schema of [
            OneWay,
            Schema.Union([OneWay, Schema.Struct({ c: text })]),
          ])
            expect(yield* bodyOf(post(schema), { body: { b: "x" } })).toBe(
              '{"a":"x"}',
            );
        }),
    );

    it.effect("lets a stacked schema take the field the write lost", () =>
      Effect.gen(function* () {
        const request = stacked(
          Schema.Union([Coded, Title]),
          Schema.Struct({ code: text }),
        );
        expect(yield* urlOf(request, { query: coded })).toBe(
          "/x?title=a&code=x",
        );
      }),
    );

    it.effect("never runs a decoder on what it sends", () =>
      Effect.gen(function* () {
        for (const type of [
          Schema.Unknown,
          Schema.declare((input): input is ReadonlyArray<string> =>
            Array.isArray(input),
          ),
        ]) {
          let reads = 0;
          // A decoder that reverses its list in place would change a list it was handed.
          const Reversed = Schema.Struct({ a: type }).pipe(
            Schema.decodeTo(
              Schema.Struct({ b: type }),
              SchemaTransformation.transform({
                decode: ({ a }) => {
                  reads++;
                  // oxlint-disable-next-line unicorn/no-array-reverse -- The decoder must change the list it is handed.
                  return { b: (a as Array<string>).reverse() as unknown };
                },
                encode: (value) => ({
                  ...value,
                  a: (value.b as ReadonlyArray<string>).toReversed(),
                }),
              }),
            ),
          );
          const body = { b: ["one", "two"] };
          expect(yield* bodyOf(post(Reversed), { body })).toBe(
            '{"a":["two","one"]}',
          );
          expect(
            yield* urlOf(
              Request.get("").pipe(
                Request.path(Reversed, (value) => `/${JSON.stringify(value)}`),
              ),
              { path: body },
            ),
          ).toBe('/{"a":["two","one"]}');
          expect(reads).toBe(0);
        }
      }),
    );

    it.effect(
      "does not count a decoding default as a field that was written",
      () =>
        Effect.gen(function* () {
          const Defaulted = Schema.Struct({
            title: text,
            meta: Schema.Unknown.pipe(
              Schema.withDecodingDefaultKey(Effect.succeed("default")),
            ),
          });
          expect(
            yield* schemaFailure(post(Schema.Union([Defaulted, Title])), {
              body: note,
            }),
          ).toBe('Expected JSON value\n  at ["meta"]');
          const DefaultCode = Schema.Struct({
            title: text,
            code: Code.pipe(
              Schema.withDecodingDefaultKey(Effect.succeed("OK")),
            ),
          });
          expect(
            yield* schemaFailure(post(Schema.Union([DefaultCode, Title])), {
              body: coded,
            }),
          ).toBe('Expected a value with a length of at least 2\n  at ["code"]');
        }),
    );

    it.effect(
      "refuses a member that writes another field under the supplied name",
      () =>
        Effect.gen(function* () {
          const Labelled = Schema.Struct({
            title: text,
            meta: Schema.Unknown,
            label: text.pipe(
              Schema.withConstructorDefault(Effect.succeed("fallback")),
            ),
          });
          // `label` goes out as `meta`, so the wire name alone cannot show the caller's `meta` went.
          const Narrow = Schema.Struct({ title: text, label: text }).pipe(
            Schema.encodeKeys({ label: "meta" }),
          );
          expect(
            yield* schemaFailure(post(Schema.Union([Labelled, Narrow])), {
              body: note,
            }),
          ).toBe('Expected JSON value\n  at ["meta"]');
        }),
    );

    it.effect("keeps a later member that states the supplied field", () =>
      Effect.gen(function* () {
        const Renamer = Schema.Struct({ a: text }).pipe(
          Schema.decodeTo(
            Schema.Struct({ b: text }),
            SchemaTransformation.transform({
              decode: ({ a, ...rest }) => ({ ...rest, b: a }),
              encode: (value) => ({ ...value, a: value.b }),
            }),
          ),
        );
        // The output also fits the earlier member's shape, which no longer matters.
        expect(
          yield* bodyOf(
            post(Schema.Union([Schema.Struct({ a: text }), Renamer])),
            {
              body: { b: "x" },
            },
          ),
        ).toBe('{"a":"x"}');
      }),
    );

    it.effect(
      "reports the first member's error through grouped and suspended unions",
      () =>
        Effect.gen(function* () {
          const expected = yield* schemaFailure(post(Coded), { body: coded });
          for (const schema of [
            Schema.Union([Schema.Union([Coded, Title]), Schema.String]),
            Schema.Union([Schema.Union([Coded, Title]), Schema.Null]),
            Schema.Union([Schema.Union([Coded, Title]), Schema.Void]),
            Schema.Union([
              Schema.Union([Coded, Title]),
              Schema.Struct({ title: Schema.Number, code: Schema.Number }),
            ]),
            Schema.Union([
              Schema.Union([Coded, Title]),
              Schema.Struct({ title: text, code: Schema.Number }),
            ]),
            Schema.Union([Schema.Union([Coded, Schema.Void]), Title]),
            Schema.suspend(() => Schema.Union([Coded, Title])),
          ])
            expect(yield* schemaFailure(post(schema), { body: coded })).toBe(
              expected,
            );
        }),
    );

    /** A field that only the relaxed write can send: the strict write refuses the `b` it carries. */
    const Relaxing = Schema.Struct({ a: text }).pipe(
      Schema.decodeTo(
        Schema.Struct({ b: text }),
        SchemaTransformation.transform({
          decode: ({ a }) => ({ b: a }),
          encode: (value) => ({ ...value, a: value.b }),
        }),
      ),
    );
    const relaxed = { b: "ok" };

    it.effect("runs only the members Effect selects by tag", () =>
      Effect.gen(function* () {
        let runs = 0;
        const Counted = Schema.Struct({
          v: text.pipe(
            Schema.middlewareEncoding((effect) =>
              Effect.andThen(
                Effect.sync(() => {
                  runs++;
                }),
                effect,
              ),
            ),
          ),
          tag: Schema.Literal("A"),
        });
        const Thrown = Schema.Struct({
          v: text.pipe(
            Schema.middlewareEncoding((effect) =>
              Effect.andThen(
                Effect.sync(() => {
                  throw new Error("ran a member its tag rules out");
                }),
                effect,
              ),
            ),
          ),
          tag: Schema.Literal("A"),
        });
        // The selected member writes how many times the other one ran.
        const Selected = Schema.Struct({
          v: text.pipe(
            Schema.encodeTo(text, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transform((value) => `${value}-${runs}`),
            }),
          ),
          tag: Schema.Literal("B"),
        });
        const body = {
          choice: { tag: "B", v: "right" },
          rename: relaxed,
        } as const;
        expect(
          yield* bodyOf(
            post(
              Schema.Struct({
                choice: Schema.Union([Counted, Selected]),
                rename: Relaxing,
              }),
            ),
            { body },
          ),
        ).toBe('{"choice":{"v":"right-0","tag":"B"},"rename":{"a":"ok"}}');
        expect(runs).toBe(0);
        expect(
          yield* bodyOf(
            post(
              Schema.Struct({
                choice: Schema.Union([Thrown, Selected]),
                rename: Relaxing,
              }),
            ),
            { body },
          ),
        ).toBe('{"choice":{"v":"right-0","tag":"B"},"rename":{"a":"ok"}}');
      }),
    );

    it.effect(
      "tries a member whose middleware can answer any input, as Effect does",
      () =>
        Effect.gen(function* () {
          const Recovering = Schema.Struct({
            v: text,
            tag: Schema.Literal("A"),
          }).pipe(
            Schema.middlewareEncoding((effect) =>
              Effect.catch(effect, () =>
                Effect.succeed(Option.some({ v: "wrong", tag: "A" })),
              ),
            ),
          );
          const Other = Schema.Struct({ v: text, tag: Schema.Literal("B") });
          const schema = Schema.Struct({
            choice: Schema.Union([Recovering, Other]),
            rename: Relaxing,
          });
          expect(
            yield* bodyOf(post(schema), {
              body: { choice: { tag: "B", v: "right" }, rename: relaxed },
            }),
          ).toBe('{"choice":{"v":"wrong","tag":"A"},"rename":{"a":"ok"}}');
        }),
    );

    it.effect("keeps every field a member that states none writes", () =>
      Effect.gen(function* () {
        for (const other of [Schema.Struct({}), Schema.Unknown])
          expect(
            yield* bodyOf(
              post(
                Schema.Struct({
                  choice: Schema.Union([Coded, other]),
                  rename: Relaxing,
                }),
              ),
              { body: { choice: coded, rename: relaxed } },
            ),
          ).toBe('{"choice":{"title":"a","code":"x"},"rename":{"a":"ok"}}');
      }),
    );

    it.effect("names the field no stacked schema took", () =>
      Effect.gen(function* () {
        const Wide = Schema.Struct({ title: text, code: Code, x: Code });
        const group = Schema.Union([Wide, Title]);
        const Taken = Schema.Struct({ code: text });
        const lost =
          'The schema cannot keep this field with the rest of the value\n  at ["x"]';
        const both = { title: "a", code: "x", x: "t" };
        for (const [first, second] of [
          [group, Taken],
          [Taken, group],
        ] as const) {
          const query = Request.get("/x").pipe(
            Request.query(first),
            Request.query(second),
          );
          const headers = Request.get("/x").pipe(
            Request.headers(first),
            Request.headers(second),
          );
          expect(yield* schemaFailure(query, { query: both })).toBe(lost);
          expect(yield* schemaFailure(headers, { headers: both })).toBe(lost);
          // With `code` valid, `Wide` fails on `x` alone, and its own error names it.
          const fair = { ...both, code: "ok" };
          expect(yield* schemaFailure(query, { query: fair })).toBe(
            'Expected a value with a length of at least 2\n  at ["x"]',
          );
          expect(yield* schemaFailure(headers, { headers: fair })).toBe(
            'Expected a value with a length of at least 2\n  at ["x"]',
          );
        }
        expect(
          yield* urlOf(stacked(group, Schema.Struct({ code: text, x: text })), {
            query: both,
          }),
        ).toBe("/x?title=a&code=x&x=t");
      }),
    );

    it.effect(
      "credits no member of a nested union that failed its own rule",
      () =>
        Effect.gen(function* () {
          const Plain = Schema.Struct({ title: text, code: text });
          const Wider = Schema.Struct({
            title: text,
            code: text,
            extra: Schema.optionalKey(text),
          });
          // Both nested members write the value, which `oneOf` refuses, and the check refuses it too.
          for (const nested of [
            Schema.Union([Plain, Wider], { mode: "oneOf" }),
            Schema.Union([Plain, Wider]).check(Schema.makeFilter(() => false)),
          ])
            expect(
              yield* schemaFailure(post(Schema.Union([Coded, nested, Title])), {
                body: coded,
              }),
            ).toBe(
              'Expected a value with a length of at least 2\n  at ["code"]',
            );
        }),
    );

    it.effect("forgets what a member noted in an attempt that failed", () =>
      Effect.gen(function* () {
        // Each run of `Gate` fails and flips whether `Kept` can write. The first relaxed attempt
        // writes `x` through `Title` before `Gate` fails it; the second writes it through `Kept`.
        let closed = false;
        const failed = Effect.fail(
          new SchemaIssue.InvalidValue({ message: "closed" }),
        );
        const Kept = Schema.Struct({
          title: text,
          meta: Schema.Unknown.pipe(
            Schema.middlewareEncoding((effect) => (closed ? failed : effect)),
          ),
        });
        const Gate = text.pipe(
          Schema.middlewareEncoding(() =>
            Effect.andThen(
              Effect.sync(() => {
                closed = !closed;
              }),
              failed,
            ),
          ),
        );
        const x = Schema.Union([Kept, Title]);
        const schema = Schema.Union([
          Schema.Struct({ x, y: Gate }),
          Schema.Struct({ x, y: text }),
        ]);
        expect(
          yield* bodyOf(post(schema), {
            body: { x: { title: "a", meta: 1 }, y: "z" },
          }),
        ).toBe('{"x":{"title":"a","meta":1},"y":"z"}');
      }),
    );

    it.effect("follows each place one object is written from", () =>
      Effect.gen(function* () {
        const Dated = Schema.Struct({
          title: text,
          meta: Schema.DateFromString,
        });
        const box = { title: "a", meta: new Date(0) };
        // `Dated` keeps `meta` on the left; `Title` drops it on the right.
        expect(
          yield* schemaFailure(
            post(
              Schema.Struct({
                left: Schema.Union([Dated, Title]),
                right: Schema.Union([Note, Title]),
              }),
            ),
            { body: { left: box, right: box } },
          ),
        ).toBe('Expected JSON value\n  at ["right"]["meta"]');
        expect(
          yield* schemaFailure(
            post(
              Schema.Struct({
                left: Schema.Union([Schema.Unknown, Dated]),
                right: Schema.Union([Schema.Unknown, Note, Title]),
              }),
            ),
            { body: { left: box, right: box } },
          ),
        ).toBe('Expected JSON value\n  at ["right"]');
      }),
    );

    it.effect(
      "follows the writing member through structs, lists, records, rest elements and suspensions",
      () =>
        Effect.gen(function* () {
          // A struct of tagged keys beside `title`, and a list of text followed by one union.
          const [byTemplate, byNumber, byPattern] = [
            Schema.TemplateLiteral(["tag-", Schema.String]),
            Schema.Number,
            Schema.String.check(Schema.isPattern(/^tag-/)),
          ].map((key) =>
            Schema.StructWithRest(Title, [Schema.Record(key, text)]),
          );
          const [trailingNote, trailingCode] = [
            Schema.Union([Note, Title]),
            Schema.Union([Coded, Title]),
          ].map((last) => Schema.TupleWithRest(Schema.Tuple([]), [text, last]));
          const [inNote, inTitle] = [Note, Title].map((child) =>
            Schema.Struct({ child }),
          );
          const meta = 'Expected JSON value\n  at ["meta"]';
          const code =
            'Expected a value with a length of at least 2\n  at ["code"]';
          for (const [schema, body, failure] of [
            [
              Schema.Union([inNote!, inTitle!]),
              { child: note },
              'Expected JSON value\n  at ["child"]["meta"]',
            ],
            [
              Schema.Union([inNote!, Schema.Void, inTitle!]),
              { child: note },
              'Expected JSON value\n  at ["child"]["meta"]',
            ],
            [
              Schema.Union([Schema.Array(Note), Schema.Array(Title)]),
              [note],
              'Expected JSON value\n  at [0]["meta"]',
            ],
            [
              Schema.Union([
                Schema.Record(text, Note),
                Schema.Record(text, Title),
              ]),
              { k: note },
              'Expected JSON value\n  at ["k"]["meta"]',
            ],
            [Schema.Union([Note, Schema.suspend(() => Title)]), note, meta],
            [Schema.Union([Coded, Schema.suspend(() => Title)]), coded, code],
            [
              Schema.Union([Schema.Unknown, Title]),
              note,
              "Expected JSON value",
            ],
            [Schema.Union([Note, byTemplate!]), note, meta],
            [Schema.Union([Note, byNumber!]), note, meta],
            [Schema.Union([Note, byPattern!]), note, meta],
            [
              trailingNote!,
              ["ok", note],
              'Expected JSON value\n  at [1]["meta"]',
            ],
            [
              trailingCode!,
              ["ok", coded],
              'Expected a value with a length of at least 2\n  at [1]["code"]',
            ],
          ] as const)
            expect(
              yield* schemaFailure(post(schema as Schema.Codec<unknown>), {
                body: body as never,
              }),
            ).toBe(failure);
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/250
    it.effect(
      "currently lets a struct beside an opaque declaration drop a field",
      () =>
        Effect.gen(function* () {
          // No member but `Title` reads keys, so the union is written as Effect writes it.
          const Opaque = Schema.declare(
            (input): input is object =>
              typeof input === "object" && input !== null,
          );
          expect(
            yield* bodyOf(post(Schema.Union([Opaque, Title])), { body: note }),
          ).toBe('{"title":"a"}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/250
    it.effect.fails(
      "refuses with an opaque declaration's error where a struct after it drops a field",
      () =>
        Effect.gen(function* () {
          const Opaque = Schema.declare(
            (input): input is object =>
              typeof input === "object" && input !== null,
          );
          expect(
            yield* schemaFailure(post(Schema.Union([Opaque, Title])), {
              body: note,
            }),
          ).toBe("Expected JSON value");
        }),
    );

    it.effect(
      "selects by a tag that is optional on one side only, as Effect does",
      () =>
        Effect.gen(function* () {
          let runs = 0;
          const Counted = Schema.Struct({
            v: text.pipe(
              Schema.middlewareEncoding((effect) =>
                Effect.andThen(
                  Effect.sync(() => {
                    runs++;
                  }),
                  effect,
                ),
              ),
            ),
            _tag: Schema.tagDefaultOmit("A"),
          });
          const Thrown = Schema.Struct({
            v: text.pipe(
              Schema.middlewareEncoding((effect) =>
                Effect.andThen(
                  Effect.sync(() => {
                    throw new Error("ran a member its tag rules out");
                  }),
                  effect,
                ),
              ),
            ),
            _tag: Schema.tagDefaultOmit("A"),
          });
          // The selected member writes how many times the other one ran.
          const Selected = Schema.Struct({
            v: text.pipe(
              Schema.encodeTo(text, {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.transform((value) => `${value}-${runs}`),
              }),
            ),
            _tag: Schema.tagDefaultOmit("B"),
          });
          const body = {
            choice: { _tag: "B", v: "right" },
            rename: relaxed,
          } as const;
          for (const other of [Counted, Thrown])
            expect(
              yield* bodyOf(
                post(
                  Schema.Struct({
                    choice: Schema.Union([other, Selected]),
                    rename: Relaxing,
                  }),
                ),
                { body },
              ),
            ).toBe('{"choice":{"v":"right-0"},"rename":{"a":"ok"}}');
          expect(runs).toBe(0);
          // A tag the wire gives a default is not one in the value, so it selects nothing there.
          const K1 = Schema.Struct({
            kind: Schema.Literal("k1").pipe(
              Schema.withDecodingDefaultKey(Effect.succeed("k1")),
            ),
            b: text,
          });
          const Other = Schema.Struct({
            a: Schema.FiniteFromString,
            b: Schema.optionalKey(text),
          });
          expect(
            yield* bodyOf(
              post(
                Schema.Struct({
                  d: Schema.Union([K1, Other]),
                  rename: Relaxing,
                }),
              ),
              { body: { d: { a: 5, b: "z" }, rename: relaxed } },
            ),
          ).toBe('{"d":{"a":"5","b":"z"},"rename":{"a":"ok"}}');
          expect(
            yield* bodyOf(
              post(Schema.Struct({ d: Schema.Union([K1, Relaxing]) })),
              { body: { d: { b: "go" } } },
            ),
          ).toBe('{"d":{"a":"go"}}');
          // A tag the value may leave out but the wire always carries does select there.
          const stamped = Schema.optionalKey(Schema.Literal("a")).pipe(
            Schema.encodeTo(Schema.Literal("a"), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transformOptional(() =>
                Option.some("a" as const),
              ),
            }),
          );
          const Stamped = Schema.Struct({ kind: stamped, p: text });
          for (const other of [
            Schema.Struct({ q: text }),
            Schema.Struct({ p: text }),
          ])
            expect(
              yield* bodyOf(
                post(
                  Schema.Struct({
                    choice: Schema.Union([Stamped, other]),
                    rename: Relaxing,
                  }),
                ),
                { body: { choice: { p: "x" }, rename: relaxed } },
              ),
            ).toBe('{"choice":{"kind":"a","p":"x"},"rename":{"a":"ok"}}');
        }),
    );

    // The write's check runs only where the caller's value is plain data and the schema there names
    // no field every object has. Elsewhere the value is written as Effect writes it.
    it.effect(
      "writes a union that names a field every object has as Effect writes it",
      () =>
        Effect.gen(function* () {
          // The value `{ c: false }` inherits `toString` and `constructor`, which it was not given.
          for (const Named of [
            Schema.Struct({ toString: text }),
            Schema.Struct({ constructor: text }),
          ])
            expect(
              yield* bodyOf(
                post(
                  Schema.Struct({
                    choice: Schema.Union([
                      Schema.Struct({ c: Schema.Boolean }),
                      Named,
                    ]),
                    rename: Relaxing,
                  }),
                ),
                { body: { choice: { c: false }, rename: relaxed } },
              ),
            ).toBe('{"choice":{"c":false},"rename":{"a":"ok"}}');
          const Wire = Schema.Struct({ text }).pipe(
            Schema.encodeKeys({ text: "constructor" }),
          );
          const schema = Schema.Struct({
            any: Schema.Union([
              Schema.Struct({ a: text }),
              Schema.Struct({ b: text }),
            ]),
            rename: Relaxing,
            f: Wire,
          });
          for (const f of [{ constructor: "x" }, { text: "x" }])
            expect(
              yield* bodyOf(post(schema), {
                body: { any: { a: "x" }, rename: relaxed, f } as never,
              }),
            ).toBe(
              '{"any":{"a":"x"},"rename":{"a":"ok"},"f":{"constructor":"x"}}',
            );
        }),
    );

    it.effect(
      "writes a union whose first member takes anything under such a name as Effect writes it",
      () =>
        Effect.gen(function* () {
          for (const name of ["toString", "constructor", "valueOf"]) {
            const Open = Schema.Union([
              Schema.Struct({ [name]: Schema.Unknown }),
              Schema.Struct({ a: Schema.optionalKey(Schema.Number) }),
            ]);
            expect(
              yield* bodyOf(
                post(Schema.Struct({ f: Open, rename: Relaxing })),
                { body: { f: {}, rename: relaxed } } as never,
              ),
            ).toBe('{"f":{},"rename":{"a":"ok"}}');
          }
        }),
    );

    it.effect("writes a class instance as Effect writes it", () =>
      Effect.gen(function* () {
        for (const name of ["toString", "valueOf"]) {
          // The class has a method under a name another member states as a field.
          class Methods {
            readonly a = "";
            readonly b = true;
          }
          Object.defineProperty(Methods.prototype, name, {
            value: () => "v",
            configurable: true,
          });
          const members = Schema.Union([
            Schema.Struct({
              b: Schema.FiniteFromString,
              [name]: Schema.Boolean,
            }),
            Schema.Struct({ a: text, b: Schema.Boolean }),
          ]);
          expect(
            yield* bodyOf(
              post(Schema.Struct({ f: members, rename: Relaxing })),
              { body: { f: new Methods(), rename: relaxed } } as never,
            ),
          ).toBe('{"f":{"a":"","b":true},"rename":{"a":"ok"}}');
          class Kept extends Schema.Class<Kept>(`Kept-${name}`)({
            a: text,
            b: Schema.Boolean,
          }) {}
          const withClass = Schema.Union([
            text,
            Schema.Struct({
              b: Schema.FiniteFromString,
              [name]: Schema.Boolean,
            }),
            Kept,
          ]);
          expect(
            yield* bodyOf(
              post(Schema.Struct({ f: withClass, rename: Relaxing })),
              {
                body: { f: new Kept({ a: "", b: true }), rename: relaxed },
              } as never,
            ),
          ).toBe('{"f":{"a":"","b":true},"rename":{"a":"ok"}}');
        }
      }),
    );

    /** The #250 value, in a class instance, which is not plain data. */
    class Dated {
      readonly title = "a";
      readonly meta = new Date(0);
    }

    // https://github.com/viell-dev/slop-effect-schema-http/issues/250
    it.effect(
      "currently lets a member drop a field of a value that is not plain data",
      () =>
        Effect.gen(function* () {
          expect(
            yield* bodyOf(post(Schema.Union([Note, Title])), {
              body: new Dated(),
            } as never),
          ).toBe('{"title":"a"}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/250
    it.effect.fails(
      "refuses a field a member drops of a value that is not plain data",
      () =>
        Effect.gen(function* () {
          expect(
            yield* schemaFailure(post(Schema.Union([Note, Title])), {
              body: new Dated(),
            } as never),
          ).toBe('Expected JSON value\n  at ["meta"]');
        }),
    );

    it.effect("offers no struct for null, as Effect does not", () =>
      Effect.gen(function* () {
        const NullText = Schema.Null.pipe(
          Schema.encodeTo(text.check(Schema.isMinLength(9)), {
            decode: SchemaGetter.transform(() => null),
            encode: SchemaGetter.transform(() => "null"),
          }),
        );
        expect(
          yield* schemaFailure(
            post(
              Schema.Struct({
                choice: Schema.Union([Schema.Struct({}), NullText]),
                rename: Relaxing,
              }),
            ),
            { body: { choice: null, rename: relaxed } },
          ),
        ).toBe('Expected a value with a length of at least 9\n  at ["choice"]');
      }),
    );

    /** A union that `Struct({ c })` writes for `{ e: new Date(0) }` once `{ e }` cannot be JSON. */
    const Dropping = Schema.Union([
      Schema.Struct({ d: text }).pipe(Schema.encodeKeys({ d: "w_d" })),
      Schema.Struct({ e: Schema.Unknown }),
      Schema.Struct({ c: Schema.optionalKey(text) }),
    ]);
    const dated = { d: { e: new Date(0) } };

    // https://github.com/viell-dev/slop-effect-schema-http/issues/250
    it.effect(
      "currently lets a renamed struct's encoded side drop a field its union writes",
      () =>
        Effect.gen(function* () {
          expect(
            yield* schemaFailure(post(Schema.Struct({ d: Dropping })), {
              body: dated,
            } as never),
          ).toBe(
            'The schema cannot keep this field with the rest of the value\n  at ["d"]["e"]',
          );
          // Renamed, the struct writes `d` through `{ e }`, then its encoded side writes it again,
          // through `Struct({ c })`, which the check does not follow.
          expect(
            yield* bodyOf(
              post(
                Schema.Struct({ d: Dropping }).pipe(
                  Schema.encodeKeys({ d: "w_d" }),
                ),
              ),
              { body: dated } as never,
            ),
          ).toBe('{"w_d":{}}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/250
    it.effect.fails(
      "refuses a field a renamed struct's encoded side drops",
      () =>
        Effect.gen(function* () {
          expect(
            yield* schemaFailure(
              post(
                Schema.Struct({ d: Dropping }).pipe(
                  Schema.encodeKeys({ d: "w_d" }),
                ),
              ),
              { body: dated } as never,
            ),
          ).toContain('["d"]["e"]');
        }),
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently lets middleware on a union write through a member that drops a field",
    () =>
      Effect.gen(function* () {
        const Watched = Schema.Union([
          Schema.Struct({ title: text, code: text }),
          Schema.Struct({ title: text }),
        ]).pipe(Schema.middlewareDecoding((effect) => effect));
        const Code = text.pipe(
          Schema.encodeTo(text.check(Schema.isMinLength(2)), {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.passthrough(),
          }),
        );
        const Coded = Schema.Union([
          Schema.Struct({ title: text, code: Code }),
          Schema.Struct({ title: text }),
        ]).pipe(Schema.middlewareDecoding((effect) => effect));
        expect(
          yield* bodyOf(post(Watched), { body: { title: "a", code: "x" } }),
        ).toBe('{"title":"a","code":"x"}');
        expect(
          yield* bodyOf(post(Coded), { body: { title: "a", code: "x" } }),
        ).toBe('{"title":"a"}');
      }),
  );

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
