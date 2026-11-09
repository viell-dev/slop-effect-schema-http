import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

const prepare = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  binding: "path" | "body",
) => {
  if (binding === "path") {
    let rendered: unknown;
    return Request.compile(
      Request.get("/probe").pipe(
        Request.path(schema, (value) => {
          rendered = value;
          return "/ok";
        }),
      ),
      { path: input as Request.Input<S> },
    ).pipe(Effect.map(() => rendered));
  }
  return Request.compile(
    Request.post("/probe").pipe(Request.body(Body.jsonSchema(schema))),
    { body: input as Request.Input<S> },
  ).pipe(
    Effect.map(({ request }) => {
      expect(request.body._tag).toBe("Uint8Array");
      return request.body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
        : undefined;
    }),
  );
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/189
// https://github.com/viell-dev/slop-effect-schema-http/issues/191
describe("array key normalization during request preparation", () => {
  for (const binding of ["path", "body"] as const) {
    for (const key of [Symbol.iterator, Symbol.toStringTag, Symbol("audit")]) {
      it.effect(`${binding} reads valid cells beside ${String(key)}`, () =>
        Effect.gen(function* () {
          let iterations = 0;
          const metadata =
            key === Symbol.iterator
              ? function* () {
                  iterations++;
                  yield { limit: 99 };
                }
              : "metadata";
          for (const leaf of [
            { page_size: "05" },
            { limit: 5 },
            { page_size: "05", stray: "ignored" },
          ]) {
            const input = [leaf];
            Object.defineProperty(input, key, {
              value: metadata,
              enumerable: true,
            });
            expect(
              yield* prepare(Schema.Array(Filter), input, binding),
            ).toEqual([{ page_size: "5" }]);
            expect(input).toHaveLength(1);
            expect(Object.getOwnPropertyDescriptor(input, key)?.value).toBe(
              metadata,
            );
          }
          expect(iterations).toBe(0);
        }),
      );

      // https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6737040870
      const refuses = key === Symbol.iterator ? it.effect.fails : it.effect;
      refuses(`${binding} refuses invalid cells beside ${String(key)}`, () =>
        Effect.gen(function* () {
          for (const invalid of ["many", null]) {
            const input = [{ page_size: invalid, stray: "ignored" }];
            Object.defineProperty(input, key, {
              value:
                key === Symbol.iterator ? Array.prototype[Symbol.iterator] : 7,
              enumerable: true,
            });
            expect(
              yield* Effect.flip(prepare(Schema.Array(Filter), input, binding)),
            ).toBeInstanceOf(Schema.SchemaError);
          }
        }),
      );

      if (key === Symbol.iterator) {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6737040870
        it.effect(`currently ${binding} retains an own-iterator default`, () =>
          Effect.gen(function* () {
            for (const invalid of ["many", null]) {
              const input = [{ page_size: invalid, stray: "ignored" }];
              Object.defineProperty(input, Symbol.iterator, {
                value: Array.prototype[Symbol.iterator],
                enumerable: true,
              });
              expect(
                yield* prepare(Schema.Array(Filter), input, binding),
              ).toEqual([{ page_size: "25" }]);
            }
          }),
        );
      }
    }

    it.effect(`${binding} retains sparse, hidden and inherited positions`, () =>
      Effect.gen(function* () {
        for (const layout of ["sparse", "hidden", "inherited"] as const) {
          const input: Array<object> = [];
          input.length = layout === "sparse" ? 4 : 2;
          input[1] = { page_size: "05", stray: "ignored" };
          const first = { page_size: "07" };
          if (layout === "hidden")
            Object.defineProperty(input, "0", { value: first });
          if (layout === "inherited")
            Object.setPrototypeOf(
              input,
              Object.create(Array.prototype, { "0": { value: first } }),
            );
          const schema =
            layout === "sparse"
              ? Schema.Array(Schema.optional(Filter))
              : Schema.Array(Filter);
          const output = yield* prepare(schema, input, binding);
          // JSON serializes array holes as null; path rendering retains the schema's undefined.
          expect(output).toEqual(
            layout === "sparse"
              ? binding === "body"
                ? [null, { page_size: "5" }, null, null]
                : [undefined, { page_size: "5" }, undefined, undefined]
              : [{ page_size: "7" }, { page_size: "5" }],
          );
          expect(input).toHaveLength(layout === "sparse" ? 4 : 2);
          expect(Object.hasOwn(input, "0")).toBe(layout === "hidden");
          expect(input[1]).toHaveProperty("stray", "ignored");
        }
      }),
    );
  }

  it.effect("retains an original getter defect", () =>
    Effect.gen(function* () {
      const defect = new Error("metadata getter failed");
      const input = [{ page_size: "05" }];
      Object.defineProperty(input, Symbol("audit"), {
        enumerable: true,
        get() {
          throw defect;
        },
      });
      const exit = yield* Effect.exit(
        prepare(Schema.Array(Filter), input, "body"),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toMatchObject([{ _tag: "Die", defect }]);
    }),
  );

  it.effect("keeps dense proxy input whose prototype inspection fails", () =>
    Effect.gen(function* () {
      for (const binding of ["path", "body"] as const)
        for (const stray of [false, true]) {
          const leaf = stray
            ? { page_size: "05", stray: "ignored" }
            : { page_size: "05" };
          const input = new Proxy([leaf], {
            getPrototypeOf() {
              throw new Error("prototype inspection failed");
            },
          });
          expect(yield* prepare(Schema.Array(Filter), input, binding)).toEqual([
            { page_size: "5" },
          ]);
        }
    }),
  );

  it.effect("leaves an opaque array's layout to its schema", () =>
    Effect.gen(function* () {
      const input = new Proxy(["opaque"], {
        get(target, key, receiver) {
          if (key === "length") throw new Error("opaque length inspected");
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf() {
          throw new Error("opaque prototype inspected");
        },
      });
      const schema = Schema.Struct({
        values: Schema.Unknown,
        count: Schema.FiniteFromString,
        tag: Schema.optionalKey(Schema.String),
      }).pipe(Schema.encodeKeys({ tag: "TAG" }));
      let rendered: unknown;
      yield* Request.compile(
        Request.get("/opaque").pipe(
          Request.path(schema, (value) => {
            rendered = value.values;
            return "/ok";
          }),
        ),
        { path: { values: input, count: "05" } },
      );
      expect(rendered).toBe(input);
    }),
  );

  it.effect(
    "refuses an incoherent virtual position instead of enlarging input",
    () =>
      Effect.gen(function* () {
        const ghost = { page_size: "07" };
        const input = new Proxy([{ page_size: "05", stray: "ignored" }], {
          ownKeys(target) {
            return [...Reflect.ownKeys(target), "1000"];
          },
          getOwnPropertyDescriptor(target, key) {
            return key === "1000"
              ? {
                  value: ghost,
                  enumerable: true,
                  configurable: true,
                  writable: true,
                }
              : Reflect.getOwnPropertyDescriptor(target, key);
          },
          get(target, key, receiver) {
            return key === "1000" ? ghost : Reflect.get(target, key, receiver);
          },
        });
        for (const binding of ["path", "body"] as const)
          expect(
            yield* Effect.flip(
              prepare(Schema.Array(Schema.optional(Filter)), input, binding),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
        expect(input.length).toBe(1);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6736960353
  it.effect(
    "currently exposes the sparse default after correcting compaction",
    () =>
      Effect.gen(function* () {
        const input: Array<object> = [];
        input.length = 2;
        input[1] = { page_size: "many", stray: "ignored" };
        expect(
          yield* prepare(Schema.Array(Schema.optional(Filter)), input, "body"),
        ).toEqual([null, { page_size: "25" }]);
        expect(Object.hasOwn(input, "0")).toBe(false);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect.fails(
    "refuses an invalid sparse alias after an inner rewrite",
    () =>
      Effect.gen(function* () {
        const input: Array<object> = [];
        input.length = 2;
        input[1] = { page_size: "many", stray: "ignored" };
        expect(
          yield* Effect.flip(
            prepare(Schema.Array(Schema.optional(Filter)), input, "body"),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );
});
