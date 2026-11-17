import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Option, Schema, SchemaGetter } from "effect";
import {
  bodyOf,
  linesOf,
  schemaFailure,
  Tenant,
  urlOf,
} from "../../test/request.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

const post = <S extends Schema.Top>(schema: S) =>
  Request.post("/x").pipe(Request.body(Body.jsonSchema(schema)));

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

const VoidFirst = Schema.Union([Schema.Void, Filter]);
const VoidLast = Schema.Union([Filter, Schema.Void]);
const RenamedSort = Schema.Struct({
  filter: VoidFirst,
  sortBy: Schema.String,
}).pipe(Schema.encodeKeys({ sortBy: "sort_by" }));

describe("request preparation beside Void", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps an encoded field beneath a renamed parent key", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ pageFilter: VoidFirst }).pipe(
        Schema.encodeKeys({ pageFilter: "page_filter" }),
      );
      expect(
        yield* bodyOf(post(schema), {
          body: { page_filter: { page_size: "05" } },
        }),
      ).toBe('{"page_filter":{"page_size":"5"}}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses an invalid encoded field beneath a renamed parent key",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({ pageFilter: VoidLast }).pipe(
          Schema.encodeKeys({ pageFilter: "page_filter" }),
        );
        expect(
          yield* schemaFailure(post(schema), {
            body: { page_filter: { page_size: "many" } },
          }),
        ).toContain('["page_filter"]["page_size"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps an encoded filter beside a renamed sibling", () =>
    Effect.gen(function* () {
      expect(
        yield* bodyOf(post(RenamedSort), {
          body: { filter: { page_size: "05" }, sort_by: "a" },
        }),
      ).toBe('{"filter":{"page_size":"5"},"sort_by":"a"}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps encoded filters inside a fieldwise object and array", () =>
    Effect.gen(function* () {
      const object = Schema.Struct({
        n: Schema.FiniteFromString,
        mid: Schema.Struct({ inner: VoidFirst }),
      });
      const array = Schema.Struct({
        n: Schema.FiniteFromString,
        items: Schema.Array(VoidFirst),
      });
      expect(
        yield* bodyOf(post(object), {
          body: { n: 1, mid: { inner: { page_size: "05" } } },
        } as never),
      ).toBe('{"n":"1","mid":{"inner":{"page_size":"5"}}}');
      expect(
        yield* bodyOf(post(array), {
          body: { n: 1, items: [{ page_size: "05" }] },
        } as never),
      ).toBe('{"n":"1","items":[{"page_size":"5"}]}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "keeps fields when the JSON writer encounters annotated or checked Void",
    () =>
      Effect.gen(function* () {
        const checkedInputs: Array<unknown> = [];
        const checked = Schema.Void.check(
          Schema.makeFilter((value) => {
            checkedInputs.push(value);
            return true;
          }),
        );
        for (const empty of [
          Schema.Void.annotate({ description: "none" }),
          checked,
        ]) {
          const schema = Schema.Union([empty, Filter]);
          for (const body of [{ limit: 5 }, { page_size: "05" }])
            expect(yield* bodyOf(post(schema), { body })).toBe(
              '{"page_size":"5"}',
            );
          expect(yield* bodyOf(post(schema), { body: {} })).toBe("null");
        }
        const request = Request.get("").pipe(
          Request.path(Schema.Union([checked, Filter]), (value) =>
            value ? "/kept" : "/empty",
          ),
        );
        expect(yield* urlOf(request, { path: {} })).toBe("/empty");
        expect(checkedInputs.length).toBeGreaterThan(0);
        expect(checkedInputs.every((value) => value === undefined)).toBe(true);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("keeps fields past Void in nested any-of alternatives", () =>
    Effect.gen(function* () {
      for (const schema of [
        Schema.Union([Filter, Schema.NullOr(Schema.Void)]),
        Schema.Union([
          Schema.Union([Schema.Void, Schema.Literal("a")]),
          Filter,
        ]),
      ]) {
        expect(yield* bodyOf(post(schema), { body: { page_size: "05" } })).toBe(
          '{"page_size":"5"}',
        );
        expect(
          yield* schemaFailure(post(schema), { body: { page_size: "many" } }),
        ).toContain('["page_size"]');
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "names the invalid field when an unrelated Void branch declines",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          extra: Schema.Union([
            Schema.Void,
            Schema.Struct({ a: Schema.Number }),
          ]),
          filter: Filter,
        });
        expect(
          yield* schemaFailure(post(schema), {
            body: { extra: { a: "x" }, filter: { page_size: "many" } },
          } as never),
        ).toBe(
          'The schema cannot keep this field with the rest of the value\n  at ["filter"]["page_size"]',
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "refuses mixed sides when a whole read would discard the filter",
    () =>
      Effect.gen(function* () {
        expect(
          yield* schemaFailure(post(RenamedSort), {
            body: { filter: { limit: 5 }, sort_by: "a" },
          } as never),
        ).toContain('["filter"]');
      }),
  );

  it.effect("keeps first fit for fields that are undefined or unstated", () =>
    Effect.gen(function* () {
      for (const body of [
        {},
        { limit: undefined, page_size: undefined },
        { extra: true },
      ])
        expect(yield* bodyOf(post(VoidFirst), { body } as never)).toBe("null");
    }),
  );

  it.effect("uses defined own cells rather than array metadata", () =>
    Effect.gen(function* () {
      const request = post(
        Schema.Union([Schema.Void, Schema.Array(Schema.FiniteFromString)]),
      );
      const hidden = Object.defineProperty([5], 0, { enumerable: false });
      expect(yield* bodyOf(request, { body: hidden })).toBe('["5"]');
      expect(yield* bodyOf(request, { body: ["05"] })).toBe('["5"]');
      expect(
        yield* bodyOf(request, { body: Object.assign([], { extra: true }) }),
      ).toBe("null");
    }),
  );

  it.effect("keeps generated values in ordinary schemas", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        generated: Schema.optionalKey(Schema.Struct({ a: Schema.Number })).pipe(
          Schema.withConstructorDefault(Effect.succeed({ a: 1 })),
        ),
        empty: Schema.optionalKey(
          Schema.Union([
            Schema.Void,
            Schema.Struct({ a: Schema.optionalKey(Schema.Number) }),
          ]),
        ).pipe(Schema.withConstructorDefault(Effect.succeed({}))),
      });
      expect(yield* bodyOf(post(schema), { body: {} })).toBe(
        '{"generated":{"a":1},"empty":null}',
      );
    }),
  );

  it.effect(
    "uses winning schema services once and propagates defects and interruption",
    () =>
      Effect.gen(function* () {
        const trace: Array<string> = [];
        const defect = new Error("defective filter decoder");
        const Counted = Schema.String.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transformEffect((text) =>
              Effect.flatMap(Tenant, (tenant) => {
                trace.push("decode:" + tenant);
                return text === "die"
                  ? Effect.die(defect)
                  : text === "interrupt"
                    ? Effect.interrupt
                    : Effect.succeed(Number(text));
              }),
            ),
            encode: SchemaGetter.transformEffect((value) =>
              Effect.map(Tenant, (tenant) => {
                trace.push("encode:" + tenant);
                return String(value);
              }),
            ),
          }),
        );
        const schema = Schema.Struct({
          filter: Schema.Union([
            Schema.Void,
            Schema.Struct({ limit: Counted }).pipe(
              Schema.encodeKeys({ limit: "page_size" }),
            ),
          ]),
        }).pipe(Schema.encodeKeys({ filter: "page_filter" }));
        const run = (page_size: string) =>
          Request.compile(post(schema), {
            body: { page_filter: { page_size } },
          }).pipe(Effect.provideService(Tenant, "request"));
        yield* run("05");
        expect(trace).toEqual(["decode:request", "encode:request"]);
        for (const mode of ["die", "interrupt"] as const) {
          const result = yield* Effect.exit(run(mode));
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(
              mode === "die"
                ? Cause.hasDies(result.cause)
                : Cause.hasInterrupts(result.cause),
            ).toBe(true);
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/236
  it.effect(
    "refuses an undefined query or header encoding with a typed error",
    () =>
      Effect.gen(function* () {
        const Sort = Schema.Struct({ sort: Schema.optionalKey(Schema.String) });
        for (const schema of [Schema.Void, Schema.Union([Schema.Void, Sort])]) {
          const query = Request.get("/x").pipe(Request.query(schema as never));
          const headers = Request.get("/x").pipe(
            Request.headers(schema as never),
          );
          for (const [compile, name] of [
            [Request.compile(query, { query: {} } as never), "query"],
            [Request.compile(headers, { headers: {} } as never), "header"],
          ] as const) {
            const result = yield* Effect.result(compile);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure).toBeInstanceOf(Request.InvalidRequest);
              expect(result.failure.message).toBe(
                "The " +
                  name +
                  " schema must encode a field record or field pairs",
              );
            }
          }
        }
        const schema = Schema.Union([Schema.Void, Sort]);
        expect(
          yield* urlOf(Request.get("/x").pipe(Request.query(schema as never)), {
            query: { sort: "a" },
          } as never),
        ).toBe("/x?sort=a");
        expect(
          yield* linesOf(
            Request.get("/x").pipe(Request.headers(schema as never)),
            { headers: { sort: "a" } } as never,
          ),
        ).toEqual([["sort", "a"]]);
      }),
  );
});

describe("known Void selection limits", () => {
  class FilterClass extends Schema.Class<FilterClass>("FilterClass")({
    limit: Schema.FiniteFromString,
  }) {}
  class ParentClass extends Schema.Class<ParentClass>("ParentClass")({
    filter: VoidFirst,
  }) {}
  const ClassMember = Schema.Union([Schema.Void, FilterClass]);
  const OneOf = Schema.Union([Schema.Void, Filter], { mode: "oneOf" });
  const Discard = Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Undefined, {
      decode: SchemaGetter.transform((_input: unknown) => undefined),
      encode: SchemaGetter.transform((_value: undefined): unknown => undefined),
    }),
  );
  const Custom = Schema.Union([Discard, Filter]);

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently loses a class member or a union field inside a class",
    () =>
      Effect.gen(function* () {
        expect(yield* bodyOf(post(ClassMember), { body: { limit: 5 } })).toBe(
          "null",
        );
        expect(
          yield* bodyOf(post(ParentClass), { body: { filter: { limit: 5 } } }),
        ).toBe('{"filter":null}');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect.fails("keeps the visible class member beside Void", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(post(ClassMember), { body: { limit: 5 } })).toBe(
        '{"limit":"5"}',
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect.fails("keeps the visible union field in a class", () =>
    Effect.gen(function* () {
      expect(
        yield* bodyOf(post(ParentClass), { body: { filter: { limit: 5 } } }),
      ).toBe('{"filter":{"page_size":"5"}}');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("currently discards an encoded field through oneOf", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(post(OneOf), { body: { page_size: "05" } })).toBe(
        "null",
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("currently lets a custom transformation discard its input", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(post(Custom), { body: { page_size: "05" } })).toBe(
        '{"page_size":"25"}',
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently discards fields inside opaque or suspended schemas",
    () =>
      Effect.gen(function* () {
        const opaque = Request.get("").pipe(
          Request.path(Schema.Option(VoidFirst), (value) =>
            Option.isSome(value) && value.value === undefined
              ? "/empty"
              : "/kept",
          ),
        );
        expect(yield* urlOf(opaque, { path: Option.some({ limit: 5 }) })).toBe(
          "/empty",
        );
        const suspended = post(
          Schema.suspend((): typeof VoidFirst => VoidFirst),
        );
        expect(yield* bodyOf(suspended, { body: { limit: 5 } })).toBe("null");
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently discards fields through an encoded member union or standalone Void",
    () =>
      Effect.gen(function* () {
        const member = Schema.Union([Schema.Void, Schema.Literal("a")]).pipe(
          Schema.encodeTo(Schema.Literal("a"), {
            decode: SchemaGetter.transform(() => undefined),
            encode: SchemaGetter.transform(() => "a" as const),
          }),
        );
        const request = post(Schema.Union([member, Filter]));
        expect(yield* bodyOf(request, { body: { limit: 5 } })).toBe('"a"');
        expect(
          yield* bodyOf(post(Schema.Void), { body: { limit: 5 } } as never),
        ).toBe("null");
      }),
  );
});
