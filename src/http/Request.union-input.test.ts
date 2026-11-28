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
  strictOnlyCheck,
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

/** What a JSON body schema sends for a value, whatever its type admits. */
const sentBody = (schema: Schema.Top, body: unknown) =>
  bodyOf(post(schema as Schema.Codec<unknown, unknown>), { body } as never);

/** How a JSON body schema refuses a value, whatever its type admits. */
const refusedBody = (schema: Schema.Top, body: unknown) =>
  schemaFailure(post(schema as Schema.Codec<unknown, unknown>), {
    body,
  } as never);

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

  // An empty struct keeps every key of what it reads, so it is the member that keeps them all.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("keeps a key only an empty member holds, in either order", () =>
    Effect.gen(function* () {
      const input = { a: "x", z: 1 };
      for (const schema of [
        Schema.Union([A, Empty]),
        Schema.Union([Empty, A]),
      ]) {
        expect(yield* bodyOf(post(schema), { body: input })).toBe(
          '{"a":"x","z":1}',
        );
        expect(yield* urlOf(queried(schema), { query: input })).toBe(
          "/x?a=x&z=1",
        );
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  class EmptyClass extends Schema.Class<EmptyClass>("EmptyClass")({}) {}

  it.effect("keeps a key only an empty class holds, in either order", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Union([A, EmptyClass]),
        Schema.Union([EmptyClass, A]),
      ])
        expect(yield* bodyOf(post(schema), { body: { a: "x", z: 1 } })).toBe(
          '{"a":"x","z":1}',
        );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("keeps such a key at any depth below a stated member", () =>
    Effect.gen(function* () {
      const nested = { b: { a: "x", z: 1 } };
      for (const schema of [
        Schema.Union([Schema.Struct({ b: A }), Empty]),
        Schema.Union([Empty, Schema.Struct({ b: A })]),
      ])
        expect(yield* bodyOf(post(schema), { body: nested })).toBe(
          '{"b":{"a":"x","z":1}}',
        );
      // A member that reads no `b` holds nothing below it, so the stated member's reading applies.
      const other = Schema.Union([
        Schema.Struct({ b: A }),
        Schema.Struct({ c: Empty }),
      ]);
      expect(yield* bodyOf(post(other), { body: nested })).toBe(
        '{"b":{"a":"x"}}',
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("keeps a stated member's reading where it keeps every key", () =>
    Effect.gen(function* () {
      const Filter = Schema.Struct({
        limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const schema = Schema.Union([Filter, Empty]);
      const tagged = { tag: "a" };
      const undefinedKey = { limit: 5, tag: undefined };
      expect(yield* urlOf(queried(schema), { query: {} })).toBe(
        "/x?page_size=25",
      );
      expect(yield* urlOf(queried(schema), { query: undefinedKey })).toBe(
        "/x?page_size=5",
      );
      // The stated member would drop `tag` and send its default in the caller's place.
      expect(yield* urlOf(queried(schema), { query: tagged })).toBe("/x?tag=a");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("refuses a kept value the request cannot carry", () =>
    Effect.gen(function* () {
      const Named = Schema.Struct({ "x-a": Schema.String });
      const counted = { "x-a": "1", "x-count": 2 };
      for (const schema of [Empty, Schema.Union([Named, Empty])]) {
        const headed = Request.get("/x").pipe(Request.headers(schema));
        const failure = yield* refusal(headed, { headers: counted });
        expect(failure.message).toBe(
          'The header field "x-count" must have a string value',
        );
      }
      // JSON has no BigInt; the JSON writer names the field, beside a stated member or alone.
      const big = { a: "x", n: 1n };
      for (const schema of [Schema.Union([A, Empty]), Empty]) {
        const failure = yield* Effect.flip(
          compile(post(schema), { body: big }),
        );
        expect(failure).toBeInstanceOf(HttpBody.HttpBodyError);
        expect(String(failure)).toContain('$["n"]');
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("refuses a kept field the writer would leave out or replace", () =>
    Effect.gen(function* () {
      const key = Symbol("field");
      const Named = Schema.Struct({ [key]: Schema.String }).pipe(
        Schema.encodeKeys({ [key]: "x-field" }),
      );
      const symbolKeyed = { [key]: "kept", tag: "abc" };
      for (const schema of [
        Schema.Union([Named, Empty]),
        Schema.Union([Empty, Named]),
      ]) {
        // No writer has a symbol key; the stated member would have written it as `x-field`.
        const failure = yield* Effect.flip(
          compile(post(schema), { body: symbolKeyed }),
        );
        expect(failure).toBeInstanceOf(HttpBody.HttpBodyError);
        expect(String(failure)).toContain("$[Symbol(field)]");
        expect(
          (yield* refusal(queried(schema), { query: symbolKeyed })).message,
        ).toContain("[Symbol(field)]");
        const headed = Request.get("/x").pipe(Request.headers(schema));
        expect(
          (yield* refusal(headed, { headers: symbolKeyed })).message,
        ).toContain("[Symbol(field)]");
      }
      const SymbolText = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Symbol,
          SchemaTransformation.transform({
            decode: (text) => Symbol.for(text),
            encode: (symbol) => Symbol.keyFor(symbol) ?? "",
          }),
        ),
      );
      // JSON would write `null` for a number it has no text for, leave out a symbol, and write
      // the bytes as an object keyed by index.
      for (const [field, value, written] of [
        [Schema.NumberFromString, Number.NaN, '{"v":"NaN"}'],
        [Schema.NumberFromString, Number.POSITIVE_INFINITY, '{"v":"Infinity"}'],
        [SymbolText, Symbol.for("west"), '{"v":"west"}'],
        [Schema.Uint8ArrayFromHex, new Uint8Array([7, 8]), '{"v":"0708"}'],
      ] as const) {
        const Stated = Schema.Struct({ v: field });
        const input = { v: value, extra: "keep" };
        for (const schema of [
          Schema.Union([Stated, Empty]),
          Schema.Union([Empty, Stated]),
        ]) {
          const failure = yield* Effect.flip(
            compile(post(schema), { body: input }),
          );
          expect(failure).toBeInstanceOf(HttpBody.HttpBodyError);
          expect(String(failure)).toContain('$["v"]');
        }
        // The stated member alone writes the value through its codec.
        expect(
          yield* bodyOf(post(Stated), { body: { v: value } as never }),
        ).toBe(written);
      }
      // A query writes no object; text it can write from a number goes out.
      const nested = { a: "x", z: { deep: 1 } };
      expect(
        (yield* refusal(queried(Schema.Union([A, Empty])), { query: nested }))
          .message,
      ).toContain('"z"');
      const counted = { a: "x", z: Number.NaN };
      expect(
        yield* urlOf(queried(Schema.Union([A, Empty])), { query: counted }),
      ).toBe("/x?a=x&z=NaN");
    }),
  );

  // A stacked schema's field reaches the union too, and the empty member keeps it as given.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("writes a field as given when bound after its stated schema", () =>
    Effect.gen(function* () {
      const Count = Schema.Struct({ z: Schema.FiniteFromString });
      const Either = Schema.Union([A, Empty]);
      const query = { a: "x", z: "05" };
      expect(yield* urlOf(stacked(Either, Count), { query })).toBe(
        "/x?a=x&z=5",
      );
      expect(yield* urlOf(stacked(Count, Either), { query })).toBe(
        "/x?a=x&z=05",
      );
      // The empty struct alone behaves the same way.
      expect(yield* urlOf(stacked(Count, Empty), { query: { z: "05" } })).toBe(
        "/x?z=05",
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/243
  it.effect(
    "reads a key set to undefined as absent beside an opaque field",
    () =>
      Effect.gen(function* () {
        const Page = Schema.Struct({
          limit: Schema.optional(Schema.Number),
          at: Schema.optionalKey(Schema.Date),
        });
        const schema = Schema.Union([
          Page,
          Schema.Struct({ cursor: Schema.String }),
        ]);
        let rendered: unknown;
        yield* compile(
          Request.get("/x").pipe(
            Request.path(schema, (value) => {
              rendered = value;
              return "/ok";
            }),
          ),
          { path: { limit: undefined } },
        );
        expect(Reflect.ownKeys(rendered as object)).toEqual([]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps a key below a stated member beside an open member", () =>
    Effect.gen(function* () {
      const nested = { b: { a: "x", z: 1 } };
      for (const open of [Schema.Unknown, Schema.Any, Schema.ObjectKeyword])
        for (const schema of [
          Schema.Union([Schema.Struct({ b: A }), open]),
          Schema.Union([open, Schema.Struct({ b: A })]),
          Schema.Union([Schema.Struct({ b: A }), Schema.Union([open, A])]),
          Schema.Union([Schema.Struct({ b: A }), Schema.suspend(() => open)]),
        ])
          expect(
            yield* bodyOf(post(schema as Schema.Codec<unknown>), {
              body: nested,
            }),
          ).toBe('{"b":{"a":"x","z":1}}');
      // A member with a check of its own can refuse the value, so it holds nothing for certain.
      const checked = Schema.Unknown.check(Schema.makeFilter(() => false));
      expect(
        yield* bodyOf(post(Schema.Union([Schema.Struct({ b: A }), checked])), {
          body: nested,
        }),
      ).toBe('{"b":{"a":"x"}}');
    }),
  );

  // A suspended member can name a schema defined after the binding, so it is read once a value is.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("makes a binding before a suspended member is defined", () =>
    Effect.gen(function* () {
      const later: { schema?: typeof A } = {};
      let resolved = 0;
      const schema = Schema.Union([
        Empty,
        Schema.suspend((): typeof A => {
          resolved++;
          return later.schema!;
        }),
      ]);
      const search = queried(schema);
      const send = post(schema);
      const render = Request.get("/x").pipe(Request.path(schema, () => "/ok"));
      expect(resolved).toBe(0);
      later.schema = A;
      const value = { a: "ok" };
      expect(yield* urlOf(search, { query: value })).toBe("/x?a=ok");
      expect(yield* bodyOf(send, { body: value })).toBe('{"a":"ok"}');
      expect(yield* urlOf(render, { path: value })).toBe("/x/ok");
    }),
  );

  // An ordinary union runs each step it reads through once, as before #249.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect(
    "runs an ordinary union's decoder, middleware and getters once",
    () =>
      Effect.gen(function* () {
        const counts = { decode: 0, recover: 0, reads: 0 };
        const Counted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transform({
              decode: (text) => {
                counts.decode++;
                return Number(text);
              },
              encode: String,
            }),
          ),
        );
        const Other = Schema.Struct({ b: Schema.String });
        const Stamped = Schema.Struct({
          a: Counted,
          stamp: Schema.optionalKey(Schema.Date),
        });
        const runs: Array<typeof counts> = [];
        for (const schema of [
          Schema.Union([Schema.Struct({ a: Counted }), Other]),
          Schema.Union([Stamped, Other]),
          Schema.Union([
            Schema.Struct({
              a: Counted,
              stamp: Schema.optionalKey(
                Schema.declare((input): input is Date => input instanceof Date),
              ),
            }),
            Other,
          ]),
          Schema.Union([
            Stamped,
            Other.pipe(
              Schema.catchDecoding((issue) => {
                counts.recover++;
                return Effect.fail(issue);
              }),
            ),
          ]),
        ]) {
          counts.decode = counts.recover = counts.reads = 0;
          const input = Object.defineProperty({ extra: 1 }, "a", {
            get: () => {
              counts.reads++;
              return "5";
            },
            enumerable: true,
          });
          expect(yield* bodyOf(post(schema), { body: input as never })).toBe(
            '{"a":"5"}',
          );
          runs.push({ ...counts });
        }
        // Normalization reads the getter once and the decoder once more; 0.18.0 read it three times.
        for (const run of runs)
          expect(run).toEqual({ decode: 1, recover: 0, reads: 2 });
      }),
  );

  // A class or middleware field keeps 0.18.0's reading, so when it is omitted it neither refuses a
  // sibling's value nor runs code inside an opaque one.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/243
  it.effect("leaves sibling values alone beside an omitted field", () =>
    Effect.gen(function* () {
      class Bare extends Schema.Class<Bare>("Bare")({}) {}
      const Open = Schema.Record(Schema.String, Schema.Unknown);
      const Failing = Open.pipe(
        Schema.catchDecoding((issue) => Effect.fail(issue)),
      );
      const Joined = Schema.Unknown.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (cells) =>
              Array.isArray(cells) ? cells.join(",") : String(cells),
            encode: (text) => text,
          }),
        ),
      );
      const joined = Schema.Union([
        Schema.Struct({ a: Joined, r: Schema.optionalKey(Failing) }),
        Schema.Struct({ b: Schema.Boolean }),
      ]);
      expect(
        yield* bodyOf(post(joined), { body: { a: ["x", "y"] } as never }),
      ).toBe('{"a":"x,y"}');
      for (const unused of [Bare, Failing])
        for (const failing of [false, true]) {
          let reads = 0;
          const schema = Schema.Union([
            Schema.Struct({
              a: Schema.String,
              b: Schema.Unknown,
              c: Schema.optionalKey(unused),
            }),
            Schema.Struct({ id: Schema.String }),
          ]);
          const opaque = {
            deep: {
              get field() {
                reads++;
                if (failing) throw new Error("opaque field read");
                return 42;
              },
            },
          };
          expect(
            yield* urlOf(
              Request.get("/x").pipe(Request.path(schema, () => "/ok")),
              { path: { a: "ok", extra: "dropped", b: opaque } as never },
            ),
          ).toBe("/x/ok");
          expect(reads).toBe(0);
        }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect("passes a class instance an empty member keeps as given", () =>
    Effect.gen(function* () {
      class Thing {
        readonly a = "x";
        readonly z = 1;
      }
      const thing = new Thing();
      for (const schema of [
        Schema.Union([Empty, Schema.Void]),
        Schema.Union([A, Empty]),
      ]) {
        let seen: unknown;
        yield* compile(
          Request.get("/x").pipe(
            Request.path(schema, (value) => {
              seen = value;
              return "/ok";
            }),
          ),
          { path: thing },
        );
        expect(seen).toBe(thing);
      }
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
        // The union's own check fails, and no Void takes the object in its place.
        expect(
          yield* schemaFailure(request, { body: { page_size: "06" } }),
        ).toContain("Expected <filter>");
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
        }),
    );

    it.effect("is refused beside its encoded twin, as under a struct", () =>
      Effect.gen(function* () {
        const Renamed = Schema.Struct({ a: text }).pipe(
          Schema.encodeKeys({ a: "A" }),
        );
        const Choice = Schema.Union([Renamed, Schema.Struct({ b: text })]);
        for (const schema of [Renamed, Choice])
          for (const A of ["1", "2"])
            expect(
              yield* schemaFailure(queried(schema), { query: { a: "1", A } }),
            ).toContain('["A"]');
        const InBody = post(
          Schema.Struct({ f: NarrowFirst }).pipe(Schema.encodeKeys({ f: "F" })),
        );
        expect(
          yield* schemaFailure(InBody, {
            body: { f: { a: "1" }, F: { a: "2" } },
          }),
        ).toContain('["F"]');
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
      "leaves the write of a struct beside an opaque declaration to Effect",
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

    /** A class whose instances hold a member of their own, so none can be written strictly. */
    class Counted extends Schema.Class<Counted>("Counted")({ a: text }) {
      readonly reads = 1;
    }
    /** A struct that reads any object, and so would strip a `Counted` instance. */
    const Filter = Schema.Struct({
      limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
        Schema.withConstructorDefault(Effect.succeed(25)),
      ),
    }).pipe(Schema.encodeKeys({ limit: "page_size" }));
    const counted = () => new Counted({ a: "item" });

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "writes a class instance its strict read kept through its class, in either order",
      () =>
        Effect.gen(function* () {
          for (const members of [
            [Filter, Counted],
            [Counted, Filter],
          ] as const) {
            const Either = Schema.Union(members);
            expect(yield* bodyOf(post(Either), { body: counted() })).toBe(
              '{"a":"item"}',
            );
            expect(
              yield* bodyOf(post(Schema.Struct({ item: Either })), {
                body: { item: counted() },
              }),
            ).toBe('{"item":{"a":"item"}}');
            expect(
              yield* bodyOf(
                post(Schema.Struct({ o: Schema.Struct({ item: Either }) })),
                { body: { o: { item: counted() } } },
              ),
            ).toBe('{"o":{"item":{"a":"item"}}}');
            expect(
              yield* bodyOf(post(Schema.Array(Either)), {
                body: [counted(), { limit: 5 }],
              }),
            ).toBe('[{"a":"item"},{"page_size":"5"}]');
            expect(
              yield* bodyOf(
                post(Schema.Struct({ item: Either, counted: Counted })),
                {
                  body: {
                    item: counted(),
                    counted: new Counted({ a: "sibling" }),
                  },
                },
              ),
            ).toBe('{"item":{"a":"item"},"counted":{"a":"sibling"}}');
            expect(yield* urlOf(queried(Either), { query: counted() })).toBe(
              "/x?a=item",
            );
          }
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "still refuses a class instance its class member cannot write whole",
      () =>
        Effect.gen(function* () {
          const schema = Schema.Struct({
            item: Schema.Union([Filter, Counted]),
          });
          // Effect's struct would write `{}` for each of these.
          const invalid = Object.assign(counted(), { a: 5 });
          expect(
            yield* schemaFailure(post(schema), { body: { item: invalid } }),
          ).toContain('["item"]["a"]');
          // Only `Filter` states `limit`, and the class member does not write it.
          const holding = Object.assign(counted(), { limit: 5 });
          expect(
            yield* schemaFailure(post(schema), { body: { item: holding } }),
          ).toContain('["item"]["a"]');
          // An open member beside the class holds the instance's own member too.
          expect(
            yield* schemaFailure(
              post(
                Schema.Struct({
                  item: Schema.Union([
                    Schema.Struct({ a: text }),
                    Schema.Unknown,
                  ]),
                }),
              ),
              { body: { item: counted() } },
            ),
          ).toContain('["item"]["reads"]');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "leaves plain data and a class with no member of its own as they were",
      () =>
        Effect.gen(function* () {
          class Bare extends Schema.Class<Bare>("Bare")({ a: text }) {}
          for (const members of [
            [Filter, Bare],
            [Bare, Filter],
          ] as const)
            expect(
              yield* bodyOf(
                post(Schema.Struct({ item: Schema.Union(members) })),
                { body: { item: new Bare({ a: "item" }) } },
              ),
            ).toBe('{"item":{"a":"item"}}');
          const schema = Schema.Struct({
            item: Schema.Union([Filter, Counted]),
          });
          expect(
            yield* bodyOf(post(schema), { body: { item: { a: "item" } } }),
          ).toBe('{"item":{"a":"item"}}');
          expect(yield* bodyOf(post(schema), { body: { item: {} } })).toBe(
            '{"item":{"page_size":"25"}}',
          );
        }),
    );

    /** `Counted` writing its field as `A`. */
    const Renamed = Counted.pipe(Schema.encodeKeys({ a: "A" }));

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "writes a class instance with a renamed field through its class, in either order",
      () =>
        Effect.gen(function* () {
          for (const members of [
            [Filter, Renamed],
            [Renamed, Filter],
          ] as const) {
            const Either = Schema.Union(members);
            expect(yield* bodyOf(post(Either), { body: counted() })).toBe(
              '{"A":"item"}',
            );
            expect(
              yield* bodyOf(post(Schema.Struct({ item: Either })), {
                body: { item: counted() },
              }),
            ).toBe('{"item":{"A":"item"}}');
            expect(
              yield* bodyOf(post(Schema.Array(Either)), {
                body: [counted(), { limit: 5 }],
              }),
            ).toBe('[{"A":"item"},{"page_size":"5"}]');
            // A renamed field above the instance.
            expect(
              yield* bodyOf(
                post(
                  Schema.Struct({ item: Either }).pipe(
                    Schema.encodeKeys({ item: "the_item" }),
                  ),
                ),
                { body: { item: counted() } },
              ),
            ).toBe('{"the_item":{"A":"item"}}');
            // A renamed sibling: the parent's encoded side states the union's encoded form too.
            expect(
              yield* bodyOf(
                post(
                  Schema.Struct({ item: Either, b: text }).pipe(
                    Schema.encodeKeys({ b: "B" }),
                  ),
                ),
                { body: { item: counted(), b: "b" } },
              ),
            ).toBe('{"item":{"A":"item"},"B":"b"}');
            expect(yield* urlOf(queried(Either), { query: counted() })).toBe(
              "/x?A=item",
            );
          }
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "writes renamed fields inside a class instance through its class, in either order",
      () =>
        Effect.gen(function* () {
          class Outer extends Schema.Class<Outer>("Outer")({
            inner: Renamed,
            listed: Schema.Array(Schema.Union([Renamed, Filter])),
            b: text,
          }) {
            readonly reads = 2;
          }
          const RenamedOuter = Outer.pipe(
            Schema.encodeKeys({ inner: "Inner" }),
          );
          class Fielded extends Schema.Class<Fielded>("Fielded")({
            a: text,
            f: Schema.Struct({ x: text }).pipe(Schema.encodeKeys({ x: "X" })),
          }) {
            readonly reads = 3;
          }
          const outer = () =>
            new Outer({ inner: counted(), listed: [counted()], b: "b" });
          for (const members of [
            [Filter, RenamedOuter],
            [RenamedOuter, Filter],
          ] as const)
            expect(
              yield* bodyOf(post(Schema.Union(members)), { body: outer() }),
            ).toBe('{"Inner":{"A":"item"},"listed":[{"A":"item"}],"b":"b"}');
          for (const members of [
            [Filter, Fielded],
            [Fielded, Filter],
          ] as const)
            expect(
              yield* bodyOf(
                post(Schema.Struct({ item: Schema.Union(members) })),
                {
                  body: { item: new Fielded({ a: "item", f: { x: "x" } }) },
                },
              ),
            ).toBe('{"item":{"a":"item","f":{"X":"x"}}}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "still refuses a class instance with a renamed field its class cannot write whole",
      () =>
        Effect.gen(function* () {
          const schema = Schema.Struct({
            item: Schema.Union([Filter, Renamed]),
          });
          const invalid = Object.assign(counted(), { a: 5 });
          expect(
            yield* schemaFailure(post(schema), { body: { item: invalid } }),
          ).toContain('["item"]["a"]');
          // Only `Filter` states `limit`, and the class member does not write it.
          const holding = Object.assign(counted(), { limit: 5 });
          expect(
            yield* schemaFailure(post(schema), { body: { item: holding } }),
          ).toContain('["item"]["a"]');
          expect(
            yield* schemaFailure(post(Schema.Array(schema)), {
              body: [{ item: holding }],
            }),
          ).toContain('[0]["item"]["a"]');
          // The instance's own `A` would go where the class writes `a`.
          const holdingWire = Object.assign(counted(), { A: "wire" });
          expect(
            yield* schemaFailure(post(schema), { body: { item: holdingWire } }),
          ).toContain('["item"]["A"]');
          // Under a wire name another member writes for another field, the class's write cannot say
          // which field it holds.
          const Aliased = Schema.Struct({
            limit: Schema.optionalKey(text),
          }).pipe(Schema.encodeKeys({ limit: "A" }));
          for (const item of [
            counted(),
            Object.assign(counted(), { limit: "5" }),
          ])
            expect(
              yield* schemaFailure(
                post(Schema.Struct({ item: Schema.Union([Aliased, Renamed]) })),
                { body: { item } },
              ),
            ).toContain('["item"]["a"]');
        }),
    );

    /** A struct whose own field `A` is written with a value it makes where the caller gave none. */
    const Defaulted = Schema.Struct({
      A: Schema.flip(
        text.pipe(Schema.withDecodingDefaultKey(Effect.succeed("made"))),
      ),
    });
    const Fields = Schema.Struct({ A: Schema.optionalKey(text) });
    /** A transformation between structs of one shape that writes `A` whatever it is given. */
    const Making = Fields.pipe(
      Schema.decodeTo(
        Fields,
        SchemaTransformation.transform({
          decode: (fields: typeof Fields.Type) => fields,
          encode: (): typeof Fields.Type => ({ A: "made" }),
        }),
      ),
    );
    /** A `Counted` instance whose field the class cannot write. */
    const invalid = () => Object.assign(counted(), { a: 5 });

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "refuses a class instance whose wire name another member writes from a field of its own",
      () =>
        Effect.gen(function* () {
          for (const Writing of [Defaulted, Making]) {
            const Either = Schema.Union([Writing, Renamed]);
            // `{"A":"made"}` would show the class kept `a` though it wrote nothing. The class can
            // write a valid instance, but `A` cannot say which member wrote it.
            for (const body of [invalid(), counted()])
              expect(yield* schemaFailure(post(Either), { body })).toContain(
                'at ["a"]',
              );
            expect(
              yield* schemaFailure(post(Schema.Struct({ item: Either })), {
                body: { item: invalid() },
              }),
            ).toContain('at ["item"]["a"]');
            expect(
              yield* schemaFailure(
                post(
                  Schema.Struct({ item: Either }).pipe(
                    Schema.encodeKeys({ item: "Item" }),
                  ),
                ),
                { body: { item: invalid() } },
              ),
            ).toContain('at ["item"]["a"]');
            expect(
              yield* schemaFailure(post(Schema.Array(Either)), {
                body: [invalid()],
              }),
            ).toContain('at [0]["a"]');
            expect(
              yield* schemaFailure(post(Schema.Record(Schema.String, Either)), {
                body: { one: invalid() },
              }),
            ).toContain('at ["one"]["a"]');
            expect(
              yield* schemaFailure(
                post(
                  Schema.Union([
                    Writing,
                    Renamed,
                    Schema.Struct({ q: Schema.optionalKey(text) }),
                  ]),
                ),
                { body: invalid() },
              ),
            ).toContain('at ["a"]');
            expect(
              yield* schemaFailure(queried(Either), { query: invalid() }),
            ).toContain('at ["a"]');
            expect(
              yield* schemaFailure(
                Request.get("/x").pipe(Request.headers(Either)),
                { headers: invalid() },
              ),
            ).toContain('at ["a"]');
          }
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/274
    it.effect(
      "writes a class instance beside a transformation between structs of one shape that writes other names",
      () =>
        Effect.gen(function* () {
          // Read by position as renaming `b` to `B`, whatever its functions do.
          const Upper = Schema.Struct({ B: Schema.optionalKey(text) }).pipe(
            Schema.decodeTo(
              Schema.Struct({ b: Schema.optionalKey(text) }),
              SchemaTransformation.transform({
                decode: ({ B }) => (B === undefined ? {} : { b: B }),
                encode: ({ b }) =>
                  b === undefined ? {} : { B: b.toUpperCase() },
              }),
            ),
          );
          expect(
            yield* bodyOf(post(Schema.Union([Upper, Renamed])), {
              body: counted(),
            }),
          ).toBe('{"A":"item"}');
        }),
    );

    /** The #250 value, in a class instance, which is not plain data. */
    class Dated {
      readonly title = "a";
      readonly meta = new Date(0);
    }

    // https://github.com/viell-dev/slop-effect-schema-http/issues/250
    it.effect(
      "leaves the write of a value that is not plain data to Effect",
      () =>
        Effect.gen(function* () {
          expect(
            yield* bodyOf(post(Schema.Union([Note, Title])), {
              body: new Dated(),
            } as never),
          ).toBe('{"title":"a"}');
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
      "leaves what a renamed struct's encoded side chooses to the schema",
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
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/335
  describe("a member whose strict write fails on a step that reads the options", () => {
    // Effect gives a write's options to the schema's own steps, so a member that the library's
    // strict attempt refuses can still write the value with the request's own options.
    const keyed = Schema.Record(Schema.String, Schema.Number).check(
      Schema.isPropertyNames(
        strictOnlyCheck("Option-sensitive key refusal", Schema.String),
      ),
    );
    const other = Schema.Struct({ other: Schema.String });
    const whole = Schema.Struct({
      a: text,
      b: strictOnlyCheck("Option-sensitive b", Schema.String),
    });
    const wholeToo = Schema.Struct({
      a: strictOnlyCheck("Option-sensitive a", Schema.String),
      b: text,
    });
    const narrow = Schema.Struct({ a: text });
    const given = { a: "x", b: "y" };
    const oneOf = { mode: "oneOf" } as const;
    // The same check on the encoded side: the strict read passes it, and only the strict write fails.
    const writeOnly = (message: string) =>
      text.pipe(
        Schema.decodeTo(text, {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.checkEffect((_value: string, options) =>
            Effect.succeed(options.onExcessProperty !== "error" || message),
          ),
        }),
      );
    const wholeW = Schema.Struct({ a: text, b: writeOnly("Write-only b") });
    // `b` is the reading's default where the caller leaves it out, so it is not the caller's.
    const defaulted = Schema.Struct({
      a: text,
      b: strictOnlyCheck("Option-sensitive b", Schema.String).pipe(
        Schema.withConstructorDefault(Effect.succeed("dflt")),
      ),
    });
    const checked = Schema.Struct({
      a: strictOnlyCheck("Option-sensitive a", Schema.String),
    });
    // Its encoded side is at least nine long, so a strict write of `"y"` fails for another reason.
    const longCode = text.pipe(
      Schema.encodeTo(text.check(Schema.isMinLength(9)), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    );
    it.effect("writes the value through it, as Effect does", () =>
      Effect.gen(function* () {
        const forms = [
          [Schema.Union([keyed, other]), { foo: 1 }],
          [Schema.Union([keyed, other], oneOf), { foo: 1 }],
          [Schema.Union([other, narrow, keyed]), { foo: 1 }],
          [
            Schema.Union([Schema.Struct({ a: keyed }), other]),
            { a: { foo: 1 } },
          ],
          [
            Schema.Union([
              Schema.Struct({ a: keyed }).pipe(Schema.encodeKeys({ a: "A" })),
              other,
            ]),
            { a: { foo: 1 } },
          ],
          [Schema.Union([whole, narrow]), given],
        ] as const;
        for (const [union, value] of forms) {
          const schema = union as Schema.Codec<unknown, unknown>;
          // What Effect's own write of the value gives, with the request's options.
          const sent = JSON.stringify(Schema.encodeUnknownSync(schema)(value));
          expect(yield* sentBody(schema, value)).toBe(sent);
          expect(
            yield* sentBody(Schema.Struct({ f: schema }), { f: value }),
          ).toBe(`{"f":${sent}}`);
          expect(yield* sentBody(Schema.Array(schema), [value])).toBe(
            `[${sent}]`,
          );
          expect(
            yield* sentBody(Schema.Record(Schema.String, schema), { r: value }),
          ).toBe(`{"r":${sent}}`);
          expect(
            yield* sentBody(
              Schema.Struct({ f: schema, p: text }).pipe(
                Schema.encodeKeys({ p: "wire_p" }),
              ),
              { f: value, p: "y" },
            ),
          ).toBe(`{"f":${sent},"wire_p":"y"}`);
        }
        expect(
          yield* urlOf(queried(Schema.Union([keyed, other])), {
            query: { foo: 1 },
          }),
        ).toBe("/x?foo=1");
      }),
    );

    it.effect(
      "writes the value through a member that holds it where the member written drops a field",
      () =>
        Effect.gen(function* () {
          // Effect's own write takes `narrow` first and drops `b`, so `whole` is tried in its place.
          // With the check passing strictly, preparation writes `whole` strictly, whatever the order.
          expect(
            Schema.encodeUnknownSync(Schema.Union([narrow, whole]))(given),
          ).toEqual({ a: "x" });
          const kept = '{"a":"x","b":"y"}';
          for (const union of [
            Schema.Union([narrow, whole]),
            Schema.Union([narrow, wholeToo, whole]),
            Schema.Union([whole, narrow], oneOf),
            Schema.Union([narrow, whole], oneOf),
          ])
            expect(yield* sentBody(union, given)).toBe(kept);
          // A member that drops `b` does not count against one that keeps it, as in the strict
          // pass. Effect's own one-of write finds both.
          expect(() =>
            Schema.encodeUnknownSync(Schema.Union([whole, narrow], oneOf))(
              given,
            ),
          ).toThrow("Expected exactly one member to match");
          // Beside a stacked schema that states `b`, the value is still written by `whole`.
          expect(
            yield* urlOf(
              stacked(
                Schema.Union([whole, narrow], oneOf),
                Schema.Struct({ b: text }),
              ),
              { query: given },
            ),
          ).toBe("/x?a=x&b=y");
          expect(
            yield* urlOf(
              stacked(
                Schema.Struct({ b: text }),
                Schema.Union([whole, narrow]),
              ),
              { query: given },
            ),
          ).toBe("/x?a=x&b=y");
        }),
    );

    it.effect(
      "writes the field a stacked schema took as the member that holds the value states it",
      () =>
        Effect.gen(function* () {
          // 0.20.0 wrote `narrow`, and the stacked schema wrote `b`. Now `whole` writes `b` too, as
          // the same union writes it with the check passing strictly.
          const union = Schema.Union([whole, narrow]);
          const shouting = Schema.Struct({
            b: text.pipe(
              Schema.decodeTo(text, {
                decode: SchemaGetter.transform((value: string) =>
                  value.toLowerCase(),
                ),
                encode: SchemaGetter.transform((value: string) =>
                  value.toUpperCase(),
                ),
              }),
            ),
          });
          // Bound first, the stacked schema's own encoding gives way to the union's, as a schema
          // bound later writes a field the two share in the earlier one's place.
          expect(yield* urlOf(stacked(shouting, union), { query: given })).toBe(
            "/x?a=x&b=y",
          );
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.headers(shouting),
                Request.headers(union),
              ),
              { headers: given },
            ),
          ).toEqual([
            ["a", "x"],
            ["b", "y"],
          ]);
          // Bound later, it writes the field in the union's place, as it did.
          expect(yield* urlOf(stacked(union, shouting), { query: given })).toBe(
            "/x?a=x&b=Y",
          );
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.headers(union),
                Request.headers(shouting),
              ),
              { headers: given },
            ),
          ).toEqual([
            ["a", "x"],
            ["b", "Y"],
          ]);
          // Under another name, the stacked schema still writes the field, so it goes out twice.
          const renamed = Schema.Struct({ b: text }).pipe(
            Schema.encodeKeys({ b: "B2" }),
          );
          expect(yield* urlOf(stacked(union, renamed), { query: given })).toBe(
            "/x?a=x&b=y&B2=y",
          );
          expect(yield* urlOf(stacked(renamed, union), { query: given })).toBe(
            "/x?B2=y&a=x&b=y",
          );
        }),
    );

    it.effect(
      "writes the value through a member whose step fails only the strict write",
      () =>
        Effect.gen(function* () {
          // The strict read passes, so the value is read whole wherever the union stands.
          const kept = '{"a":"x","b":"y"}';
          for (const union of [
            Schema.Union([narrow, wholeW]),
            Schema.Union([wholeW, narrow]),
            Schema.Union([narrow, wholeW], oneOf),
          ]) {
            expect(yield* sentBody(union, given)).toBe(kept);
            expect(
              yield* sentBody(Schema.Struct({ f: union }), { f: given }),
            ).toBe(`{"f":${kept}}`);
            expect(yield* sentBody(Schema.Array(union), [given])).toBe(
              `[${kept}]`,
            );
            expect(
              yield* sentBody(
                Schema.Struct({ f: union }).pipe(Schema.encodeKeys({ f: "F" })),
                { f: given },
              ),
            ).toBe(`{"F":${kept}}`);
          }
          expect(
            yield* urlOf(queried(Schema.Union([narrow, wholeW])), {
              query: given,
            }),
          ).toBe("/x?a=x&b=y");
        }),
    );

    it.effect(
      "writes a union inside text the caller gave as it writes it with the check passing strictly",
      () =>
        Effect.gen(function* () {
          // What the text holds is what the caller wrote, so `wholeW` is tried ahead of `narrow`,
          // which drops `b`. 0.20.1, like Effect's own write, sent `{"a":"x"}`.
          const json = JSON.stringify(given);
          const kept = '{"a":"x","b":"y"}';
          expect(
            Schema.encodeUnknownSync(
              Schema.fromJsonString(Schema.Union([narrow, wholeW])),
            )(given),
          ).toBe('{"a":"x"}');
          for (const holder of [wholeW, Schema.Struct({ a: text, b: text })]) {
            const inText = Schema.fromJsonString(
              Schema.Union([narrow, holder]),
            );
            expect(yield* sentBody(inText, json)).toBe(JSON.stringify(kept));
            const field = Schema.Struct({ j: inText });
            expect(yield* sentBody(field, { j: json })).toBe(
              JSON.stringify({ j: kept }),
            );
            expect(yield* urlOf(queried(field), { query: { j: json } })).toBe(
              `/x?j=${encodeURIComponent(kept)}`,
            );
          }
          // Text cannot be matched with a place in the caller's value, so where that value holds
          // anything that is not plain data, as a `Date`, the union is written as 0.20.1 wrote it.
          expect(
            yield* sentBody(
              Schema.Struct({
                j: Schema.fromJsonString(Schema.Union([narrow, wholeW])),
                when: Schema.Date,
              }),
              { j: json, when: new Date(0) },
            ),
          ).toBe(
            JSON.stringify({
              j: '{"a":"x"}',
              when: "1970-01-01T00:00:00.000Z",
            }),
          );
        }),
    );

    it.effect(
      "leaves a member that holds the value to the loose write where its attempt ahead would replace a field",
      () =>
        Effect.gen(function* () {
          // Read on its decoded side, the value holds `b`, which `renamed` writes as `B`, a name the
          // caller gave. Tried ahead of `dropsA`, which drops `a`, that write is not kept, so
          // `renamed` goes back to the loose write, which takes it first, as Effect's own write does.
          // 0.20.1 refused `q`, which only `inner`'s second member states.
          const inner = Schema.Union([
            Schema.Struct({ p: text }),
            Schema.Struct({ p: text, q: writeOnly("Write-only q") }),
          ]);
          const renamed = Schema.Struct({ a: text, b: text, n: inner }).pipe(
            Schema.encodeKeys({ b: "B" }),
          );
          const dropsA = Schema.Struct({
            b: text,
            n: Schema.Struct({ p: text, q: text }),
          });
          expect(
            yield* sentBody(Schema.Union([renamed, dropsA]), {
              a: "x",
              B: "y",
              n: { p: "1", q: "2" },
            }),
          ).toBe('{"a":"x","B":"y","n":{"p":"1","q":"2"}}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/335
    // Under oneOf, a member that holds the value but first fails its strict write in a union below
    // it counts as one whose failure a loose write strips. The loose write tries it beside a member
    // that drops a field, both write, and the reading with the request's own options decides.
    it.effect(
      "currently refuses under oneOf a value whose holding member first fails strictly in a union below it",
      () =>
        Effect.gen(function* () {
          const inner = Schema.Union([
            Schema.Struct({ p: text }),
            Schema.Struct({ p: text, q: writeOnly("Write-only q") }),
          ]);
          const value = { n: { p: "1", q: "2" }, x: "y" };
          const sent = '{"n":{"p":"1","q":"2"},"x":"y"}';
          const members = [
            Schema.Struct({ n: inner }),
            Schema.Struct({ n: inner, x: text }),
          ] as const;
          expect(yield* refusedBody(Schema.Union(members, oneOf), value)).toBe(
            'The schema cannot keep this field with the rest of the value\n  at ["n"]["q"]',
          );
          // A recursive union whose level below comes before its write-only field meets the same.
          interface Row {
            readonly v: string;
            readonly kids: ReadonlyArray<Row>;
            readonly x?: string;
          }
          const kids = Schema.Array(
            Schema.suspend((): Schema.Codec<Row> => row),
          );
          const row: Schema.Codec<Row> = Schema.Union(
            [
              Schema.Struct({ v: text, kids }),
              Schema.Struct({ v: text, kids, x: writeOnly("Write-only x") }),
            ],
            oneOf,
          );
          expect(
            yield* refusedBody(row, {
              v: "n1",
              kids: [{ v: "n0", kids: [], x: "x0" }],
              x: "x1",
            }),
          ).toBe("Expected exactly one member to match");
          // In an any-of union, or where the member's strict write fails first at its own step, the
          // value is sent.
          expect(yield* sentBody(Schema.Union(members), value)).toBe(sent);
          expect(
            yield* sentBody(
              Schema.Union(
                [
                  Schema.Struct({ n: inner }),
                  Schema.Struct({ x: writeOnly("Write-only x"), n: inner }),
                ],
                oneOf,
              ),
              value,
            ),
          ).toBe('{"x":"y","n":{"p":"1","q":"2"}}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/335
    it.effect.fails(
      "sends under oneOf a value whose holding member first fails strictly in a union below it",
      () =>
        Effect.gen(function* () {
          const inner = Schema.Union([
            Schema.Struct({ p: text }),
            Schema.Struct({ p: text, q: writeOnly("Write-only q") }),
          ]);
          expect(
            yield* sentBody(
              Schema.Union(
                [
                  Schema.Struct({ n: inner }),
                  Schema.Struct({ n: inner, x: text }),
                ],
                oneOf,
              ),
              { n: { p: "1", q: "2" }, x: "y" },
            ),
          ).toBe('{"n":{"p":"1","q":"2"},"x":"y"}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/335
    // A refusal still takes its cause from a step that fails only under the strict write's options,
    // which no request uses.
    it.effect(
      "currently names a strict write's own failure where a member fails only that write",
      () =>
        Effect.gen(function* () {
          // `first` states every key of the value but one below `n`, and its strict write fails at
          // `b` first, so it is neither tried loosely nor counted as holding the value.
          const first = Schema.Struct({
            b: writeOnly("Write-only b"),
            n: Schema.Struct({ p: text }),
          });
          const both = Schema.Struct({ p: text, q: text });
          expect(
            yield* refusedBody(
              Schema.Union([
                first,
                Schema.Struct({ n: both }),
                Schema.Struct({ b: longCode, n: both }),
              ]),
              { b: "y", n: { p: "1", q: "2" } },
            ),
          ).toBe('Write-only b\n  at ["b"]');
          // Given under its wire name, the value is read on its encoded side only strictly.
          expect(
            yield* refusedBody(
              Schema.Union([
                Schema.Struct({ a: text, b: longCode }),
                Schema.Struct({ a: text, b: writeOnly("Write-only b") }).pipe(
                  Schema.encodeKeys({ b: "B" }),
                ),
              ]),
              { a: "x", B: "y" },
            ),
          ).toBe(
            'Expected a value with a length of at least 9\n  at ["b"]\nWrite-only b\n  at ["b"]',
          );
        }),
    );

    it.effect("writes a value that is not plain data as before", () =>
      Effect.gen(function* () {
        // What the caller gave cannot be accounted for in such a value, so what its write drops is
        // not refused, and no member is tried that 0.20.0 did not try.
        class Payload {
          a = "x";
          b = "y";
        }
        class One {
          a = "x";
        }
        class Held extends Schema.Class<Held>("Held")({
          f: Schema.Union([defaulted, checked]),
        }) {}
        const pair = Schema.Union([checked, whole]);
        const forms: ReadonlyArray<readonly [Schema.Top, unknown, string]> = [
          [pair, new Payload(), '{"a":"x"}'],
          // A name every object has makes a literal other than plain data.
          [pair, { a: "x", b: "y", constructor: "c" }, '{"a":"x"}'],
          [Schema.Union([defaulted, checked]), new One(), '{"a":"x"}'],
          // Its constructor gives `f` the default, which `checked` drops.
          [Held, new Held({ f: { a: "x" } }), '{"f":{"a":"x"}}'],
          [Schema.Union([narrow, wholeW]), new Payload(), '{"a":"x"}'],
        ];
        for (const [schema, value, sent] of forms)
          expect(yield* sentBody(schema, value)).toBe(sent);
        expect(
          yield* urlOf(queried(Schema.Union([defaulted, checked])), {
            query: new One() as never,
          }),
        ).toBe("/x?a=x");
      }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/335
    // Below a parent, the value is read with the request's own options once the strict read fails
    // on the check, and that reading takes the first member that fits, which strips `b`.
    it.effect(
      "currently refuses below a parent a field the reading's first fit strips",
      () =>
        Effect.gen(function* () {
          const anyOf = Schema.Union([narrow, whole]);
          expect(
            yield* refusedBody(Schema.Struct({ f: anyOf }), { f: given }),
          ).toBe(
            'The schema cannot keep this field with the rest of the value\n  at ["f"]["b"]',
          );
          expect(yield* refusedBody(Schema.Array(anyOf), [given])).toBe(
            'The schema cannot keep this field with the rest of the value\n  at [0]["b"]',
          );
          // Under oneOf that reading finds both members, in either order.
          for (const union of [
            Schema.Union([narrow, whole], oneOf),
            Schema.Union([whole, narrow], oneOf),
          ])
            expect(
              yield* refusedBody(Schema.Struct({ f: union }), { f: given }),
            ).toBe('Expected exactly one member to match\n  at ["f"]');
          // In the other order, and with the check passing strictly, the field is sent.
          for (const union of [
            Schema.Union([whole, narrow]),
            Schema.Union([narrow, Schema.Struct({ a: text, b: text })]),
          ])
            expect(
              yield* sentBody(Schema.Struct({ f: union }), { f: given }),
            ).toBe('{"f":{"a":"x","b":"y"}}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/335
    it.effect.fails(
      "sends below a parent a value a later member holds, whatever the order",
      () =>
        Effect.gen(function* () {
          expect(
            yield* sentBody(
              Schema.Struct({ f: Schema.Union([narrow, whole]) }),
              {
                f: given,
              },
            ),
          ).toBe('{"f":{"a":"x","b":"y"}}');
        }),
    );

    it.effect(
      "leaves a stripped constructor default to the member that strips it, as before",
      () =>
        Effect.gen(function* () {
          // `b` is the reading's default, not the caller's, so `checked` dropping it loses nothing,
          // and the member holding it is not tried in its place.
          for (const union of [
            Schema.Union([defaulted, checked]),
            Schema.Union([defaulted, checked], oneOf),
            Schema.Union([checked, defaulted]),
          ]) {
            const encoded = Schema.encodeUnknownSync(union)(
              Schema.decodeUnknownSync(union)({ a: "x" }),
            );
            expect(encoded).toEqual({ a: "x" });
            expect(yield* sentBody(union, { a: "x" })).toBe('{"a":"x"}');
          }
          // Nothing in a default the reading made is the caller's either.
          const fallback = Schema.Struct({
            x: text,
            f: Schema.Union([whole, narrow]).pipe(
              Schema.withConstructorDefault(
                Effect.succeed({ a: "da", b: "db" }),
              ),
            ),
          });
          expect(yield* sentBody(fallback, { x: "1" })).toBe(
            '{"x":"1","f":{"a":"da"}}',
          );
          // A key no member states is left out before the reading, so it does not make the default
          // the caller's, at any depth and below a renamed field too.
          const extra = { x: "1", extra: "e" };
          expect(yield* sentBody(fallback, extra)).toBe(
            '{"x":"1","f":{"a":"da"}}',
          );
          expect(yield* sentBody(Schema.Array(fallback), [extra])).toBe(
            '[{"x":"1","f":{"a":"da"}}]',
          );
          expect(
            yield* sentBody(Schema.Struct({ g: fallback }), { g: extra }),
          ).toBe('{"g":{"x":"1","f":{"a":"da"}}}');
          expect(
            yield* sentBody(
              fallback.pipe(Schema.encodeKeys({ x: "X" })),
              extra,
            ),
          ).toBe('{"X":"1","f":{"a":"da"}}');
        }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/358
    it.effect(
      "keeps a one-of union's write that drops a field where two or more members hold the value",
      () =>
        Effect.gen(function* () {
          // Both `whole` and `wholeToo` write the value with the request's options, so neither is
          // chosen, and `narrow`'s write stands as before. A stacked schema takes `b`.
          const union = Schema.Union([whole, wholeToo, narrow], oneOf);
          expect(
            yield* urlOf(stacked(union, Schema.Struct({ b: text })), {
              query: given,
            }),
          ).toBe("/x?a=x&b=y");
          // Alone, the field `narrow` drops is refused, for the reason the request's own options give.
          expect(yield* refusedBody(union, given)).toBe(
            "Expected exactly one member to match",
          );
          // Ahead of `narrow`'s write, the members that hold the value are tried first. Once two of
          // them have written it, a third is not tried, as it would not settle the union either.
          const third = Schema.Struct({
            a: text,
            b: strictOnlyCheck("Option-sensitive b3", Schema.String),
          });
          const three = Schema.Union([narrow, whole, wholeToo, third], oneOf);
          expect(() => Schema.encodeUnknownSync(three)(given)).toThrow(
            "Expected exactly one member to match",
          );
          expect(yield* refusedBody(three, given)).toBe(
            "Expected exactly one member to match",
          );
          expect(yield* schemaFailure(queried(three), { query: given })).toBe(
            "Expected exactly one member to match",
          );
          expect(
            yield* refusedBody(
              Schema.Array(
                Schema.Union([narrow, whole, wholeToo, wholeW], oneOf),
              ),
              [given],
            ),
          ).toBe("Expected exactly one member to match\n  at [0]");
          // Beside a stacked schema, `narrow`'s write stands, and no third member writes `b` as `B`.
          const renamedB = third.pipe(Schema.encodeKeys({ b: "B" }));
          expect(
            yield* urlOf(
              stacked(
                Schema.Union([narrow, whole, wholeToo, renamedB], oneOf),
                Schema.Struct({ b: text }),
              ),
              { query: given },
            ),
          ).toBe("/x?a=x&b=y");
        }),
    );

    it.effect(
      "refuses a default a member writes under the name of a field the caller gave",
      () =>
        Effect.gen(function* () {
          // Read on its decoded side, `{ a, B }` is `defaultedB`'s, with `B` stripped and `b` its
          // default. `renamedB` would write that default as `B`, where the caller gave `"y"`.
          const renamedB = Schema.Struct({
            a: text,
            b: strictOnlyCheck("Option-sensitive b", Schema.String),
          }).pipe(Schema.encodeKeys({ b: "B" }));
          const defaultedB = Schema.Struct({
            a: text,
            b: strictOnlyCheck("Option-sensitive b", Schema.String).pipe(
              Schema.withConstructorDefault(Effect.succeed("dflt")),
            ),
          });
          const union = Schema.Union([
            renamedB,
            defaultedB,
            Schema.Record(Schema.String, Schema.String).check(
              Schema.isPropertyNames(
                strictOnlyCheck("Option-sensitive key", Schema.String),
              ),
            ),
          ]);
          const value = { a: "x", B: "y" };
          expect(
            yield* refusedBody(Schema.Struct({ f: union }), { f: value }),
          ).toBe(
            'The schema cannot keep this field with the rest of the value\n  at ["f"]["B"]',
          );
          expect(yield* refusedBody(Schema.Array(union), [value])).toBe(
            'The schema cannot keep this field with the rest of the value\n  at [0]["B"]',
          );
          // As the value itself, the record reads and writes it as given.
          expect(yield* sentBody(union, value)).toBe('{"a":"x","B":"y"}');
        }),
    );

    it.effect(
      "still refuses a field the written value loses, with the request's own errors",
      () =>
        Effect.gen(function* () {
          // Only the member that cannot read `a: "x"` states `b`.
          expect(
            yield* refusedBody(
              Schema.Union([
                Schema.Struct({
                  a: strictOnlyCheck("Option-sensitive a", Schema.String),
                }),
                Schema.Struct({ a: Schema.Number, b: text }),
              ]),
              given,
            ),
          ).toBe(
            'The schema cannot keep this field with the rest of the value\n  at ["b"]',
          );
          // A value no member can read keeps the reading's own error.
          expect(
            yield* refusedBody(Schema.Union([keyed, other]), { foo: "x" }),
          ).toBe('Expected number\n  at ["foo"]\nMissing key\n  at ["other"]');
        }),
    );

    it.effect(
      "runs a member that holds the value again only where a write would drop a supplied field or fail",
      () =>
        Effect.gen(function* () {
          // `Coded` reads `code` and cannot write it, as its encoded side is at least two long, so
          // its strict write fails for another reason than a key. Nothing reads the options.
          let runs = 0;
          const title = text.pipe(
            Schema.decodeTo(text, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transformEffect((value: string) =>
                Effect.sync(() => {
                  runs++;
                  return value;
                }),
              ),
            }),
          );
          const code = text.pipe(
            Schema.encodeTo(text.check(Schema.isMinLength(2)), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.passthrough(),
            }),
          );
          const union = (field: Schema.Codec<string, string>) =>
            Schema.Union([
              Schema.Struct({ title, code: field }),
              Schema.Struct({ title: text }),
            ]);
          const coded = { title: "a", code: "x" };
          const counted = (
            effect: Effect.Effect<string | undefined, unknown>,
          ) =>
            Effect.suspend(() => {
              runs = 0;
              return Effect.match(effect, {
                onFailure: () => ({ sent: undefined, runs }),
                onSuccess: (sent) => ({ sent, runs }),
              });
            });
          // `Title` drops the caller's `code`, so `Coded` is tried in its place with the request's
          // options: once more in each loose write, where 0.20.0 ran it 4 times.
          expect(
            yield* counted(urlOf(queried(union(code)), { query: coded })),
          ).toEqual({ sent: undefined, runs: 6 });
          // The stacked schema takes `code` only after the union's write, so the attempt runs
          // there too, and the request sends what 0.20.0 sends.
          const beside = yield* counted(
            urlOf(stacked(union(code), Schema.Struct({ code: text })), {
              query: coded,
            }),
          );
          expect(beside).toEqual({ sent: "/x?title=a&code=x", runs: 6 });
          // A constructor default is not the caller's, so `Title` drops it as before.
          const fromDefault = yield* counted(
            urlOf(
              queried(
                union(
                  code.pipe(Schema.withConstructorDefault(Effect.succeed("x"))),
                ),
              ),
              { query: { title: "a" } },
            ),
          );
          expect(fromDefault).toEqual({ sent: "/x?title=a", runs: 3 });
          // Nor is anything a class instance holds, so its write runs as often as before.
          class Titled {
            title = "a";
            code = "x";
          }
          expect(yield* counted(sentBody(union(code), new Titled()))).toEqual({
            sent: '{"title":"a"}',
            runs: 4,
          });
          // `Title` would drop `code`, so `Coded` is tried ahead of its write, and fails. A step whose
          // result depends on how often it ran sees that attempt first: `title` numbered by its runs
          // goes out from its fifth, where 0.20.1 sent its fourth.
          const numbered = text.pipe(
            Schema.decodeTo(text, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transformEffect((value: string) =>
                Effect.sync(() => `${value}-${++runs}`),
              ),
            }),
          );
          const numberedUnion = Schema.Union([
            Schema.Struct({ title: numbered, code }),
            Schema.Struct({ title: numbered }),
          ]);
          runs = 0;
          expect(
            yield* urlOf(
              stacked(numberedUnion, Schema.Struct({ code: text })),
              { query: coded },
            ),
          ).toBe("/x?title=a-5&code=x");
        }),
    );

    it.effect(
      "writes each level of a recursive union once where a member that holds it replaces one that drops a field",
      () =>
        Effect.gen(function* () {
          let runs = 0;
          const counted = text.pipe(
            Schema.decodeTo(text, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transformEffect((value: string) =>
                Effect.sync(() => {
                  runs++;
                  return value;
                }),
              ),
            }),
          );
          interface Node {
            readonly v: string;
            readonly kids: ReadonlyArray<Node>;
            readonly x?: string;
          }
          // Every level holds `x`, which only the second member states, behind a write-only step.
          const tree = (
            xFirst: boolean,
            options?: typeof oneOf,
          ): Schema.Codec<Node> => {
            const kids = Schema.Array(Schema.suspend(() => node));
            const x = writeOnly("Write-only x");
            const node: Schema.Codec<Node> = Schema.Union(
              [
                Schema.Struct({ v: counted, kids }),
                xFirst
                  ? Schema.Struct({ v: counted, x, kids })
                  : Schema.Struct({ v: counted, kids, x }),
              ],
              options,
            );
            return node;
          };
          const chain = (depth: number): Node => ({
            v: `n${depth}`,
            kids: depth === 0 ? [] : [chain(depth - 1)],
            x: `x${depth}`,
          });
          const runsAt = (schema: Schema.Codec<Node>, depth: number) =>
            Effect.suspend(() => {
              runs = 0;
              return Effect.map(sentBody(schema, chain(depth)), () => runs);
            });
          // Where `x` comes first, the second member's strict write fails there, before the level
          // below, and each level adds two runs of `v`, where 0.20.0 took four before refusing.
          for (const options of [undefined, oneOf]) {
            expect(yield* runsAt(tree(true, options), 2)).toBe(8);
            expect(yield* runsAt(tree(true, options), 6)).toBe(16);
          }
          // Where the level below comes first, each strict attempt writes it too, so the work
          // doubles with each level, as on 0.20.0, which took 186 runs at depth 4 before refusing.
          expect(yield* runsAt(tree(false), 2)).toBe(24);
          expect(yield* runsAt(tree(false), 4)).toBe(98);
        }),
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("leaves what a union behind middleware chooses to the schema", () =>
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

// Where an alternative's reading is not known, the value keeps 0.18.0's reading.
// https://github.com/viell-dev/slop-effect-schema-http/issues/249
describe("values at the edge of the known alternatives", () => {
  const Empty = Schema.Struct({});
  const A = Schema.Struct({ a: Schema.String });
  /** What a path renderer receives for one input. */
  const rendered = <S extends Schema.Top>(schema: S, input: unknown) => {
    let seen: unknown;
    return Effect.map(
      compile(
        Request.get("/x").pipe(
          Request.path(schema, (value) => {
            seen = value;
            return "/ok";
          }),
        ),
        { path: input as never },
      ),
      () => seen,
    );
  };
  const sent = (schema: Schema.Codec<unknown, unknown>, input: unknown) =>
    bodyOf(post(schema), { body: input as never });

  it.effect(
    "keeps a key below a Void beside or inside a suspended member",
    () =>
      Effect.gen(function* () {
        const nested = { p: { a: "x", z: 1 } };
        for (const schema of [
          Schema.Union([
            Schema.Struct({
              p: Schema.Union([Schema.suspend(() => A), Schema.Void]),
            }),
            Empty,
          ]),
          Schema.Union([
            Schema.Struct({
              p: Schema.suspend(() => Schema.Union([A, Schema.Void])),
            }),
            Empty,
          ]),
          Schema.Union([
            Schema.suspend(() =>
              Schema.Struct({ p: Schema.Union([A, Schema.Void]) }),
            ),
            Empty,
          ]),
        ]) {
          expect(yield* rendered(schema, nested)).toEqual(nested);
          expect(yield* sent(schema, nested)).toBe('{"p":{"a":"x","z":1}}');
        }
        const guarded = Schema.Union([
          Schema.Struct({ p: Schema.Union([A, Schema.Void]) }),
          Empty,
        ]);
        expect(yield* sent(guarded, nested)).toBe('{"p":{"a":"x","z":1}}');
      }),
  );

  it.effect("keeps a value its alternatives cannot read as an object", () =>
    Effect.gen(function* () {
      class Money {
        constructor(
          readonly amount: number,
          readonly currency: string,
        ) {}
      }
      const Note = Schema.String.pipe(
        Schema.catchDecoding(() => Effect.succeedSome("n/a")),
      );
      const schema = Schema.Union([Schema.Struct({ when: Note }), Empty]);
      for (const when of [
        new Date(0),
        new Uint8Array([7, 8]),
        new URL("https://example.test/a"),
        new Money(5, "EUR"),
      ]) {
        const output = (yield* rendered(schema, { when })) as {
          readonly when: unknown;
        };
        expect(output.when).toBe(when);
      }
    }),
  );

  it.effect("judges a member a tag rules out for its middleware", () =>
    Effect.gen(function* () {
      const TA = Schema.Struct({ type: Schema.Literal("a"), a: Schema.String });
      const TB = Schema.Struct({ type: Schema.Literal("b") });
      const input = { type: "a", a: "x", z: 1 };
      for (const recovering of [
        TB.pipe(Schema.catchDecoding(() => Effect.succeedSome({ type: "b" }))),
        TB.pipe(Schema.catchEncoding(() => Effect.succeedSome({ type: "b" }))),
      ])
        for (const schema of [
          Schema.Union([TA, recovering, Empty]),
          Schema.Union([TA, Empty, recovering]),
        ]) {
          expect(yield* rendered(schema, input)).toEqual({
            type: "a",
            a: "x",
          });
          expect(yield* sent(schema, input)).toBe('{"type":"a","a":"x"}');
        }
    }),
  );

  it.effect(
    "reads an empty struct decoded into another struct as a codec",
    () =>
      Effect.gen(function* () {
        const Picks = Empty.pipe(
          Schema.decodeTo(
            A,
            SchemaTransformation.transform({
              decode: (raw) => ({
                a: String((raw as { readonly a?: unknown }).a),
              }),
              encode: (value) => value,
            }),
          ),
        );
        const list = [{ a: "ok", z: 1 }];
        for (const schema of [
          Schema.Union([Schema.Array(A), Picks]),
          Schema.Union([Picks, Schema.Array(A)]),
        ]) {
          expect(yield* rendered(schema, list)).toEqual([{ a: "ok" }]);
          expect(yield* sent(schema, list)).toBe('[{"a":"ok"}]');
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  class Limited extends Schema.Class<Limited>("Limited")({
    a: Schema.String,
  }) {}
  const Holding = Schema.Union([Schema.Struct({ b: Limited }), Empty]);

  it.effect("keeps a key below a class field the empty member holds", () =>
    Effect.gen(function* () {
      expect(yield* sent(Holding, { b: { a: "x", z: 1 }, top: 1 })).toBe(
        '{"b":{"a":"x","z":1},"top":1}',
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/249
  it.effect(
    "sends a child below a suspended Void the empty member holds the parent of",
    () =>
      Effect.gen(function* () {
        const Suspended = Schema.Union([
          Schema.Struct({
            p: Schema.suspend(() => Schema.Union([A, Schema.Void])),
          }),
          Empty,
        ]);
        expect(yield* sent(Suspended, { p: { z: 1 }, top: 1 })).toBe(
          '{"p":{"z":1},"top":1}',
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/264
  describe("a class instance with a key set to undefined", () => {
    class Held {
      readonly z = undefined;
      constructor(fields: object = {}) {
        Object.assign(this, fields);
      }
    }
    class Written extends Held {
      toJSON() {
        return { written: true };
      }
    }
    const Settled = Schema.Struct({ a: Schema.optionalKey(Schema.String) });
    const Filter = Schema.Struct({
      limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
        Schema.withConstructorDefault(Effect.succeed(25)),
      ),
    }).pipe(Schema.encodeKeys({ limit: "page_size" }));
    const keeping = Schema.Union([Settled, Empty]);

    it.effect("is not left to a Void", () =>
      Effect.gen(function* () {
        for (const schema of [
          Schema.Union([Settled, Schema.Void, Empty]),
          Schema.Union([Settled, Empty, Schema.Void]),
        ])
          for (const fields of [{}, { 0: undefined }, { a: undefined }]) {
            expect(yield* sent(schema, new Held(fields))).toBe("{}");
            expect(yield* rendered(schema, new Held(fields))).toEqual({});
          }
        const nested = Schema.Struct({
          p: Schema.Union([Settled, Schema.Void, Empty]),
        });
        expect(yield* sent(nested, { p: new Held() })).toBe('{"p":{}}');
      }),
    );

    it.effect("stays with the member that states its other fields", () =>
      Effect.gen(function* () {
        const schema = Schema.Union([Filter, Empty]);
        expect(yield* sent(schema, new Held({ limit: 5 }))).toBe(
          '{"page_size":"5"}',
        );
        expect(yield* sent(schema, new Held({ page_size: "05" }))).toBe(
          '{"page_size":"05"}',
        );
        class Accessed {
          readonly z = undefined;
          get limit() {
            return 5;
          }
        }
        expect(yield* sent(schema, new Accessed())).toBe('{"page_size":"5"}');
      }),
    );

    it.effect("reads its getters no more often than other members do", () =>
      Effect.gen(function* () {
        let reads = 0;
        const readsUnder = (schema: Schema.Codec<unknown, unknown>) => {
          reads = 0;
          const value = Object.defineProperty(new Held(), "a", {
            enumerable: true,
            get: () => {
              reads += 1;
              return "x";
            },
          });
          return Effect.map(rendered(schema, value), () => reads);
        };
        const Other = Schema.Struct({ b: Schema.String });
        expect(yield* readsUnder(keeping)).toBe(
          yield* readsUnder(Schema.Union([Settled, Other])),
        );
      }),
    );

    it.effect(
      "is kept as given where only the empty struct holds a field",
      () =>
        Effect.gen(function* () {
          const extra = new Held({ a: "x", extra: 1 });
          expect(yield* rendered(keeping, extra)).toBe(extra);
          expect(yield* sent(keeping, new Written({ extra: 1 }))).toBe(
            '{"written":true}',
          );
        }),
    );

    it.effect("is kept as given where no member states a field", () =>
      Effect.gen(function* () {
        const value = new Held();
        for (const schema of [
          Schema.Union([Empty, Schema.Void]),
          Schema.Union([Empty, Schema.Array(Schema.String)]),
        ])
          expect(yield* rendered(schema, value)).toBe(value);
      }),
    );

    it.effect("is kept as given where its content is not in its fields", () =>
      Effect.gen(function* () {
        const map = Object.assign(new Map([["k", "v"]]), { z: undefined });
        expect(yield* rendered(keeping, map)).toBe(map);
        const failure = yield* Effect.flip(sent(keeping, map));
        expect(failure.message).toContain("cannot encode Map");
      }),
    );
  });
});

/** A oneOf query group whose first member checks `c`, stacked after a sibling, and its checks. */
const countedOneOf = () => {
  const runs: Array<number> = [];
  const c = Schema.optionalKey(
    Schema.FiniteFromString.check(
      Schema.makeFilter((value) => {
        runs.push(value);
        return true;
      }),
    ),
  );
  const union = Schema.Union(
    [
      Schema.Struct({
        c,
        tags: Schema.optionalKey(Schema.Array(Schema.String)),
        at: Schema.optionalKey(Schema.Date),
        // Its decoded side is an `Option`, which is not plain data.
        note: Schema.optionalKey(
          Schema.fromJsonString(
            Schema.OptionFromNullOr(
              Schema.Struct({ text: Schema.optionalKey(Schema.String) }),
            ),
          ),
        ),
        bytes: Schema.optionalKey(Schema.Uint8ArrayFromBase64),
      }).pipe(Schema.encodeKeys({ c: "c_w" })),
      Schema.Struct({ d: Schema.String, b: Schema.StringFromBase64 }).pipe(
        Schema.encodeKeys({ d: "d_w", b: "b_w" }),
      ),
    ],
    { mode: "oneOf" },
  );
  // The sibling takes `b_w`, which the union's first member does not state.
  const sibling = Schema.Struct({ b: Schema.String }).pipe(
    Schema.encodeKeys({ b: "b_w" }),
  );
  return { runs, request: stacked(sibling, union) };
};

/** A oneOf whose members both read a value with no fields. */
const EitherOptional = Schema.Union(
  [
    Schema.Struct({ a: Schema.optionalKey(Schema.String) }),
    Schema.Struct({ b: Schema.optionalKey(Schema.String) }),
  ],
  { mode: "oneOf" },
);

/** A oneOf whose members both read a value with no fields, one by its constructor default. */
const EitherByDefault = Schema.Union(
  [
    Schema.Struct({
      a: Schema.optionalKey(Schema.String).pipe(
        Schema.withConstructorDefault(Effect.succeed("x")),
      ),
    }),
    Schema.Struct({ b: Schema.optionalKey(Schema.String) }),
  ],
  { mode: "oneOf" },
);

/** An `Option` neighbour whose payload holds a key it does not state, which fails the strict pass. */
const opaqueNeighbour = {
  schema: Schema.Option(Schema.Struct({ a: Schema.String })),
  value: () => Option.some({ a: "x", extra: 1 }),
};

// Under a oneOf, the value without its unstated and undefined-valued keys is constructed first, to
// find an ambiguity, only where it holds an object or list with no fields at any depth, also inside
// a value that is not plain data, as only such a value can read as ambiguous. Elsewhere it is
// constructed only where the value as given fails, as on 0.19.0, whose runs these are.
// https://github.com/viell-dev/slop-effect-schema-http/issues/331
describe("constructor runs of a oneOf beside a key it does not state", () => {
  it.effect("constructs a oneOf as often as before beside a stray key", () =>
    Effect.gen(function* () {
      for (const [query, suffix, count] of [
        [{ b_w: "q", c: 2 }, "", 4],
        [{ b_w: "q", c: 2, stray: "1" }, "", 5],
        [{ b_w: "q", c: 2, d: undefined }, "", 5],
        // A `Date` is not plain data and holds no field.
        [
          { b_w: "q", c: 2, at: new Date(0), stray: "1" },
          "&at=1970-01-01T00%3A00%3A00.000Z",
          5,
        ],
        // Nor does what this `Some` holds, once looked into.
        [
          { b_w: "q", c: 2, note: Option.some({ text: "n" }), stray: "1" },
          "&note=%7B%22text%22%3A%22n%22%7D",
          5,
        ],
      ] as const) {
        const { runs, request } = countedOneOf();
        expect(yield* urlOf(request, { query } as never)).toBe(
          `/x?b_w=q&c_w=2${suffix}`,
        );
        expect(runs).toEqual(Array<number>(count).fill(2));
      }
    }),
  );

  // Decided: a value that can read as ambiguous is constructed without the keys it does not state
  // before it is constructed as given, so its checks run once more than on 0.19.0.
  it.effect(
    "constructs a oneOf once more where it may hold a value with no fields",
    () =>
      Effect.gen(function* () {
        for (const [query, suffix, count] of [
          [{ b_w: "q", c: 2, tags: [] }, "", 4],
          [{ b_w: "q", c: 2, tags: [], stray: "1" }, "", 6],
          // The empty payload inside the `Some`, though the `Some` is not plain data.
          [
            { b_w: "q", c: 2, note: Option.some({}), stray: "1" },
            "&note=%7B%7D",
            6,
          ],
          // Bytes count as possibly holding one, as their indexes are not listed.
          [
            { b_w: "q", c: 2, bytes: new Uint8Array([1]), stray: "1" },
            "&bytes=AQ%3D%3D",
            6,
          ],
        ] as const) {
          const { runs, request } = countedOneOf();
          expect(yield* urlOf(request, { query } as never)).toBe(
            `/x?b_w=q&c_w=2${suffix}`,
          );
          expect(runs).toEqual(Array<number>(count).fill(2));
        }
      }),
  );

  it.effect(
    "still refuses a value with no fields that two members read beside a stray key",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          f: EitherOptional,
          n: Schema.String,
        }).pipe(Schema.encodeKeys({ n: "N_w" }));
        for (const body of [
          { f: { stray: 1 }, n: "x" },
          { f: {}, N_w: "x", zz: 1 },
          { f: { a: undefined }, n: "x" },
        ])
          expect(yield* schemaFailure(post(schema), { body } as never)).toBe(
            'Expected exactly one member to match\n  at ["f"]',
          );
      }),
  );

  // Each value is empty once its undefined-valued keys are left out, below a field, a list item or
  // a record entry, while an opaque neighbour's key fails the strict pass.
  it.effect(
    "still refuses a value with no fields below the top level beside an opaque neighbour",
    () =>
      Effect.gen(function* () {
        const unset = { a: undefined, b: undefined };
        for (const [g, value, at] of [
          [Schema.Struct({ f: EitherByDefault }), { f: unset }, '["g"]["f"]'],
          [Schema.Array(EitherByDefault), [unset], '["g"][0]'],
          [
            Schema.Record(Schema.String, EitherByDefault),
            { k: unset },
            '["g"]["k"]',
          ],
        ] as const) {
          const schema = Schema.Struct({
            w: Schema.Struct({ o: opaqueNeighbour.schema }),
            g,
          });
          const body = { w: { o: opaqueNeighbour.value() }, g: value };
          expect(yield* schemaFailure(post(schema), { body } as never)).toBe(
            `Expected exactly one member to match\n  at ${at}`,
          );
        }
      }),
  );

  // Looking for such a value takes no stack and visits each object once, however the value nests.
  it.effect(
    "prepares a deep or cyclic value beside a key the schema does not state",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          blob: Schema.Unknown,
          f: EitherOptional,
          o: opaqueNeighbour.schema,
        });
        const request = Request.get("").pipe(
          Request.path(schema, () => "/sent"),
        );
        let chain: unknown = { leaf: 1 };
        let list: unknown = [1];
        for (let depth = 0; depth < 20_000; depth++) {
          chain = { next: chain };
          list = [list];
        }
        const cycle: Record<string, unknown> = { leaf: 1 };
        cycle["self"] = cycle;
        cycle["list"] = [cycle];
        for (const blob of [chain, list, cycle])
          for (const unstated of [{ zz: 1 }, { limit: undefined }])
            expect(
              yield* urlOf(request, {
                path: {
                  blob,
                  f: { a: "x" },
                  o: opaqueNeighbour.value(),
                  ...unstated,
                },
              } as never),
            ).toBe("/sent");
      }),
  );
});
