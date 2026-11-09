import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Effect, Schema, SchemaTransformation } from "effect";
import { empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const Inner = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

const bind = <S extends Schema.Top>(
  schema: S,
  render: (value: S["Encoded"]) => string,
) => Request.get("https://api.test").pipe(Request.path(schema, render));

// https://github.com/viell-dev/slop-effect-schema-http/issues/172
describe("whole nested encoded input", () => {
  it.effect("retains nested object, list and tuple representations", () =>
    Effect.gen(function* () {
      const Deep = Schema.Struct({
        envelope: Schema.Struct({ filter: Inner }),
      });
      const deep = Request.get("").pipe(
        Request.path(Deep, (value) => `/${value.envelope.filter.page_size}`),
      );
      expect(
        (yield* Request.compile(deep, {
          path: { envelope: { filter: { page_size: "05" } } },
        })).request.url,
      ).toBe("/05");
      const List = Schema.Struct({ filters: Schema.Array(Inner) });
      const list = Request.get("").pipe(
        Request.path(List, (value) => `/${value.filters[0]?.page_size}`),
      );
      expect(
        (yield* Request.compile(list, {
          path: { filters: [{ page_size: "05" }] },
        })).request.url,
      ).toBe("/05");
      const Tuple = Schema.Tuple([Inner, Schema.String]);
      const tuple = Request.get("").pipe(
        Request.path(Tuple, (value) => `/${value[0].page_size}/${value[1]}`),
      );
      expect(
        (yield* Request.compile(tuple, { path: [{ page_size: "05" }, "x"] }))
          .request.url,
      ).toBe("/05/x");
      void (() => {
        // @ts-expect-error: an encoded nested value still takes text
        void Request.compile(list, { path: { filters: [{ page_size: 5 }] } });
        // @ts-expect-error: a whole encoded tuple retains its length
        void Request.compile(tuple, { path: [{ page_size: "05" }] });
      });
    }),
  );

  it.effect("preserves nested discriminated member correlations", () =>
    Effect.gen(function* () {
      const fields = {
        common: Schema.optionalKey(Schema.String),
        term: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.String),
      };
      const Choice = Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("a"),
          filter: Schema.Struct(fields).pipe(
            Schema.encodeKeys({ term: "search_a", limit: "page_size" }),
          ),
        }),
        Schema.Struct({
          kind: Schema.Literal("b"),
          filter: Schema.Struct(fields).pipe(
            Schema.encodeKeys({ term: "search_b", limit: "page_size" }),
          ),
        }),
      ]);
      const request = Request.get("").pipe(
        Request.path(Schema.Struct({ choice: Choice }), ({ choice }) =>
          choice.kind === "a"
            ? `/a/${choice.filter.search_a}/${choice.filter.page_size}`
            : `/b/${choice.filter.search_b}/${choice.filter.page_size}`,
        ),
      );
      const first: Request.InputOf<typeof request> = {
        path: {
          choice: { kind: "a", filter: { search_a: "x", page_size: "05" } },
        },
      };
      const second: Request.InputOf<typeof request> = {
        path: {
          choice: { kind: "b", filter: { search_b: "y", page_size: "07" } },
        },
      };
      expect((yield* Request.compile(request, first)).request.url).toBe(
        "/a/x/05",
      );
      expect((yield* Request.compile(request, second)).request.url).toBe(
        "/b/y/07",
      );
      void (() => {
        const wrong: Request.Input<typeof Choice> = {
          kind: "a",
          // @ts-expect-error: the a discriminant cannot take b's encoded alias
          filter: { search_b: "x", page_size: "05" },
        };
        void wrong;
      });
    }),
  );

  it.effect("keeps plain and branded class constructor inputs", () =>
    Effect.gen(function* () {
      class Filter extends Schema.Class<Filter>("NestedInputFilter")({
        filter: Inner,
      }) {}
      class Branded extends Schema.Class<
        Branded,
        { readonly NestedInput: unique symbol }
      >("BrandedNestedInputFilter")({ filter: Inner }) {}
      const plain = Request.get("").pipe(
        Request.path(Filter, (value) => `/${value.filter.page_size}`),
      );
      const branded = Request.get("").pipe(
        Request.path(Branded, (value) => `/${value.filter.page_size}`),
      );
      const constructed: Request.Input<typeof Filter> = {
        filter: { limit: "05" },
      };
      const encoded: Request.Input<typeof Filter> = {
        filter: { page_size: "05" },
      };
      for (const path of [
        constructed,
        encoded,
        new Filter({ filter: { limit: "05" } }),
      ]) {
        expect((yield* Request.compile(plain, { path })).request.url).toBe(
          "/05",
        );
      }
      expect(
        (yield* Request.compile(branded, {
          path: { filter: { page_size: "05" } },
        })).request.url,
      ).toBe("/05");
      void (() => {
        // @ts-expect-error: the class constructor still requires its filter
        void Request.compile(plain, { path: {} });
      });
    }),
  );

  it.effect("preserves private identity beneath an unchanged outer name", () =>
    Effect.gen(function* () {
      class Token {
        private readonly value = "token";
        read() {
          return this.value;
        }
      }
      const Native = Schema.declare(
        (value): value is Token => value instanceof Token,
      );
      const Wire = Schema.declare(
        (value): value is Token & { readonly hint?: string } =>
          value instanceof Token,
      );
      const TokenCodec = Wire.pipe(
        Schema.decodeTo(
          Native,
          SchemaTransformation.transform({
            decode: (value) => value,
            encode: (value) => value,
          }),
        ),
      );
      const Nested = Schema.Struct({ token: TokenCodec });
      const request = Request.get("").pipe(
        Request.path(Nested, (value) => `/${value.token.read()}`),
      );
      for (const token of [
        new Token(),
        Object.assign(new Token(), { hint: "wire" }),
      ]) {
        const path: Request.Input<typeof Nested> = { token };
        expect((yield* Request.compile(request, { path })).request.url).toBe(
          "/token",
        );
      }
      void (() => {
        const forged: Request.Input<typeof Nested> = {
          // @ts-expect-error: retaining either whole side must retain the private brand
          token: { read: () => "forged" },
        };
        void forged;
      });
    }),
  );

  it.effect("keeps opaque map types and their decoded runtime input", () =>
    Effect.gen(function* () {
      const Nested = Schema.Struct({
        options: Schema.ReadonlyMap(Schema.String, Inner),
      });
      const request = Request.get("").pipe(
        Request.path(
          Nested,
          (value) => `/${value.options.get("page")?.page_size}`,
        ),
      );
      const encoded: Request.Input<typeof Nested> = {
        options: new Map([["page", { term: "x", page_size: "05" }]]),
      };
      expect(encoded.options).toBeInstanceOf(Map);
      expect(
        (yield* Request.compile(request, {
          path: { options: new Map([["page", { term: "x", limit: "05" }]]) },
        })).request.url,
      ).toBe("/05");
      void (() => {
        // @ts-expect-error: the opaque map is still a map
        void Request.compile(request, { path: { options: {} } });
      });
    }),
  );

  it.effect(
    "keeps services and operation inputs through a generic binding",
    () =>
      Effect.gen(function* () {
        class Decode extends Context.Service<Decode, string>()(
          "nested/Decode",
        ) {}
        class Encode extends Context.Service<Encode, string>()(
          "nested/Encode",
        ) {}
        const Text = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (value) => Effect.as(Decode, value),
              encode: (value) => Effect.as(Encode, value),
            }),
          ),
        );
        const Nested = Schema.Struct({
          filter: Schema.Struct({
            term: Schema.optionalKey(Schema.String),
            limit: Schema.optionalKey(Text),
          }).pipe(Schema.encodeKeys({ limit: "page_size" })),
        });
        const request = bind(Nested, (value) => `/${value.filter.page_size}`);
        const input: Request.InputOf<typeof request> = {
          path: { filter: { page_size: "05" } },
        };
        const compiled = Request.compile(request, input);
        expectTypeOf<Effect.Services<typeof compiled>>().toEqualTypeOf<
          Decode | Encode
        >();
        expectTypeOf<Effect.Error<typeof compiled>>().toEqualTypeOf<
          Schema.SchemaError | Request.InvalidRequest
        >();
        expect(
          (yield* compiled.pipe(
            Effect.provideService(Decode, "decode"),
            Effect.provideService(Encode, "encode"),
          )).request.url,
        ).toBe("https://api.test/05");
        const operation = Operation.make(
          request,
          Response.status(204, Body.empty),
        );
        expectTypeOf<Operation.InputOf<typeof operation>>().toEqualTypeOf<
          Request.InputOf<typeof request>
        >();
        const provider = synthetic(() => empty(204));
        yield* operation
          .execute({ path: { filter: { page_size: "05" } } })
          .pipe(
            Effect.provideService(Decode, "decode"),
            Effect.provideService(Encode, "encode"),
            Effect.provide(provider.layer),
          );
        expect(provider.exchanges.map(({ url }) => url)).toEqual([
          "https://api.test/05",
        ]);
      }),
  );

  it.effect("keeps the non-mutual one-level field mix", () =>
    Effect.gen(function* () {
      const Mixed = Schema.Struct({
        filter: Inner,
        count: Schema.FiniteFromString,
      });
      const request = Request.get("").pipe(
        Request.path(
          Mixed,
          (value) => `/${value.filter.page_size}/${value.count}`,
        ),
      );
      expect(
        (yield* Request.compile(request, {
          path: { filter: { page_size: "05" }, count: 7 },
        })).request.url,
      ).toBe("/05/7");
    }),
  );
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "currently retains nested encoded defaults outside the root proof",
    () =>
      Effect.gen(function* () {
        const NestedDefault = Schema.Struct({
          filter: Schema.Struct({
            term: Schema.optionalKey(Schema.String),
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(Effect.succeed(25)),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" })),
        });
        const request = bind(
          NestedDefault,
          (value) => `/${value.filter.page_size ?? "missing"}`,
        );
        for (const [filter, expected] of [
          [{ page_size: "many" }, "25"],
          [{ page_size: "05" }, "5"],
          [{ limit: 5 }, "5"],
          [{}, "25"],
        ] as const)
          expect(
            (yield* Request.compile(request, { path: { filter } })).request.url,
          ).toBe(`https://api.test/${expected}`);
        const invalid = yield* Effect.flip(
          Request.compile(request, { path: { filter: { limit: Number.NaN } } }),
        );
        expect(Schema.isSchemaError(invalid)).toBe(true);
      }),
  );
});
