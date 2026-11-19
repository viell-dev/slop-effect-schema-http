import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Exit,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect";
import { empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import type * as Transport from "./Transport.js";
import type * as UrlEncoding from "./UrlEncoding.js";

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
      it.effect(`${binding} refuses invalid cells beside ${String(key)}`, () =>
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

  it.effect("keeps opaque union winners' hidden and inherited cells", () =>
    Effect.gen(function* () {
      const cellSchema = Schema.Struct({ value: Schema.Number }).pipe(
        Schema.encodeKeys({ value: "VALUE" }),
      );
      const array = Schema.Array(cellSchema);
      for (const child of [
        Schema.Union([Schema.Unknown, array]),
        Schema.Union([Schema.Any, array]),
        Schema.Union([Schema.ObjectKeyword, array]),
        Schema.Union([Schema.declare(Array.isArray), array]),
        Schema.Union([array, Schema.Unknown]),
      ]) {
        const parent = Schema.Struct({
          values: child,
          count: Schema.FiniteFromString,
          tag: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ tag: "TAG" }));
        for (const inherited of [false, true]) {
          const cell = { VALUE: 5, additional: "retain" };
          const values: Array<object> = [];
          values.length = 1;
          if (inherited)
            Object.setPrototypeOf(
              values,
              Object.create(Array.prototype, { "0": { value: cell } }),
            );
          else Object.defineProperty(values, "0", { value: cell });
          const rendered = (yield* prepare(
            parent,
            { values, count: "05" },
            "path",
          )) as { readonly values: ReadonlyArray<unknown> };
          expect(rendered.values).toBe(values);
          expect(rendered.values[0]).toBe(cell);
        }
      }
    }),
  );

  it.effect(
    "retains a mixed view's old length-getter boundary during a rewrite",
    () =>
      Effect.gen(function* () {
        const cell = Schema.Struct({ value: Schema.Number }).pipe(
          Schema.encodeKeys({ value: "VALUE" }),
        );
        for (const stray of [false, true]) {
          let lengthReads = 0;
          const input = new Proxy(
            [stray ? { VALUE: 5, extra: "ignored" } : { VALUE: 5 }],
            {
              get(target, key, receiver) {
                if (key === "length") {
                  lengthReads++;
                  throw new Error("opaque length inspected");
                }
                return Reflect.get(target, key, receiver);
              },
            },
          );
          const schema = Schema.Struct({
            values: Schema.Union([Schema.Unknown, Schema.Array(cell)]),
            count: Schema.FiniteFromString,
            tag: Schema.optionalKey(Schema.String),
          }).pipe(Schema.encodeKeys({ tag: "TAG" }));
          const rendered = (yield* prepare(
            schema,
            { values: input, count: "05" },
            "path",
          )) as { readonly values: ReadonlyArray<unknown> };
          if (stray) {
            expect(rendered.values.length).toBe(1);
            expect(rendered.values[0]).toEqual({ VALUE: 5 });
          } else expect(rendered.values).toBe(input);
          expect(lengthReads).toBe(0);
        }
      }),
  );

  it.effect(
    "still validates an array after an opaque alternative rejects",
    () =>
      Effect.gen(function* () {
        const cell = Schema.Struct({ value: Schema.Number }).pipe(
          Schema.encodeKeys({ value: "VALUE" }),
        );
        for (const declaration of [false, true]) {
          let checks = 0;
          const reject = () => {
            checks++;
            return false;
          };
          const opaque = declaration
            ? Schema.declare((_value: unknown): _value is unknown => reject())
            : Schema.Unknown.check(Schema.makeFilter(reject));
          const schema = Schema.Struct({
            values: Schema.Union([opaque, Schema.Array(cell)]),
            count: Schema.FiniteFromString,
            tag: Schema.optionalKey(Schema.String),
          }).pipe(Schema.encodeKeys({ tag: "TAG" }));
          for (const binding of ["path", "body"] as const) {
            const valid = [{ VALUE: 5, extra: "ignored" }];
            Object.defineProperty(valid, "audit", {
              value: "metadata",
              enumerable: true,
            });
            expect(
              yield* prepare(schema, { values: valid, count: "05" }, binding),
            ).toEqual({ values: [{ VALUE: 5 }], count: "5" });
            const invalid = [{ VALUE: "invalid", extra: "ignored" }];
            Object.defineProperty(invalid, "audit", {
              value: "metadata",
              enumerable: true,
            });
            expect(
              yield* Effect.flip(
                prepare(schema, { values: invalid, count: "05" }, binding),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
          }
          expect(checks).toBeGreaterThan(0);
        }
      }),
  );

  it.effect(
    "does not inspect prototypes through an array-backed declaration",
    () =>
      Effect.gen(function* () {
        type Values = ReadonlyArray<{ readonly value: number }>;
        const cell = Schema.Struct({ value: Schema.Number }).pipe(
          Schema.encodeKeys({ value: "VALUE" }),
        );
        const child = Schema.Array(cell).pipe(
          Schema.decodeTo(
            Schema.declare((value: unknown): value is Values =>
              Array.isArray(value),
            ),
            SchemaTransformation.transform<Values, Values>({
              decode: (value) => value,
              encode: () => [{ value: 9 }],
            }),
          ),
        );
        const target: Array<object> = [];
        target.length = 2;
        target[1] = { VALUE: 5 };
        const values = new Proxy(target, {
          getPrototypeOf() {
            throw new Error("opaque prototype inspected");
          },
        });
        const schema = Schema.Struct({
          values: child,
          count: Schema.FiniteFromString,
          tag: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ tag: "TAG" }));
        expect(yield* prepare(schema, { values, count: "05" }, "path")).toEqual(
          { values: [{ VALUE: 9 }], count: "5" },
        );
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

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses an invalid sparse alias after an inner rewrite", () =>
    Effect.gen(function* () {
      const input: Array<object> = [];
      input.length = 2;
      input[1] = { page_size: "many", stray: "ignored" };
      expect(
        yield* Effect.flip(
          prepare(Schema.Array(Schema.optional(Filter)), input, "body"),
        ),
      ).toBeInstanceOf(Schema.SchemaError);
      expect(Object.hasOwn(input, "0")).toBe(false);
    }),
  );
});

/** A success's value, or the refusal; anything else stays a failure of the test. */
const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, {
    onFailure: (error) =>
      error instanceof Schema.SchemaError ? ("refused" as const) : error,
    onSuccess: (value) => ({ value }),
  });

/** What the path and body bindings each give for one input. */
const prepared = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.forEach(["path", "body"] as const, (binding) =>
    outcome(prepare(schema, input, binding)),
  );

const refused = ["refused", "refused"];
const kept = (value: unknown) => [{ value }, { value }];

/** Where the path and body bindings each refuse one input. */
const refusals = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.forEach(["path", "body"] as const, (binding) =>
    Effect.map(Effect.flip(prepare(schema, input, binding)), (error) =>
      error instanceof Schema.SchemaError ? error.message : error,
    ),
  );

/** The URL a query group writes, or the refusal. */
const queried = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, UrlEncoding.QueryInput, unknown, unknown>,
>(
  schema: S,
  query: unknown,
) =>
  outcome(
    Effect.map(
      Request.compile(Request.get("/x").pipe(Request.query(schema)), {
        query: query as never,
      }),
      ({ request }) => request.url,
    ),
  );

/** The header lines a header group writes, or the refusal. */
const headed = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, Transport.HeaderInput, unknown, unknown>,
>(
  schema: S,
  headers: unknown,
) =>
  outcome(
    Effect.map(
      Request.compile(Request.get("/x").pipe(Request.headers(schema)), {
        headers: headers as never,
      }),
      ({ headerLines }) => headerLines,
    ),
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/237
describe("a caller's list beside a record member", () => {
  // The types refuse a list for a record and each invalid item, so these come in wider values.
  const Plain = Schema.Struct({ limit: Schema.optionalKey(Schema.String) });
  const Open = Schema.Record(Schema.String, Schema.Unknown);
  const plainUnions = [
    Schema.Union([Schema.Array(Plain), Open]),
    Schema.Union([Open, Schema.Array(Plain)]),
  ];
  const filterUnions = [
    Schema.Union([Schema.Array(Filter), Open]),
    Schema.Union([Open, Schema.Array(Filter)]),
  ];

  it.effect("refuses an item its list member refuses, in either order", () =>
    Effect.gen(function* () {
      for (const [unions, list, input] of [
        [plainUnions, Schema.Array(Plain), [{ limit: 5 }]],
        [filterUnions, Schema.Array(Filter), [{ limit: "x" }]],
        [filterUnions, Schema.Array(Filter), [{ limit: "05" }]],
      ] as const) {
        expect(yield* prepared(list, input)).toEqual(refused);
        for (const schema of unions)
          expect(yield* prepared(schema, input)).toEqual(refused);
      }
    }),
  );

  // The record cannot read a list, so its open values hold nothing at the list's positions.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/243
  it.effect("reads a list as its list member alone reads it", () =>
    Effect.gen(function* () {
      for (const [input, output] of [
        [[{ page_size: "05" }], [{}]],
        [[{ page_size: "many" }], [{}]],
        [[{ limit: "x", extra: 1 }], [{ limit: "x" }]],
      ] as const) {
        expect(yield* prepared(Schema.Array(Plain), input)).toEqual(
          kept(output),
        );
        for (const schema of plainUnions)
          expect(yield* prepared(schema, input)).toEqual(kept(output));
      }
    }),
  );

  // The record refuses a list, so the list's one array reader is followed.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses an invalid alias in the list", () =>
    Effect.gen(function* () {
      for (const schema of [Schema.Array(Filter), ...filterUnions])
        expect(yield* prepared(schema, [{ page_size: "many" }])).toEqual(
          refused,
        );
    }),
  );

  it.effect("keeps valid lists, and objects with index-like keys", () =>
    Effect.gen(function* () {
      const objects = [Open, ...plainUnions, ...filterUnions];
      for (const [schemas, input, output] of [
        [
          [Schema.Array(Plain), ...plainUnions],
          [{ limit: "x" }],
          [{ limit: "x" }],
        ],
        [
          [Schema.Array(Filter), ...filterUnions],
          [{ page_size: "05" }],
          [{ page_size: "5" }],
        ],
        [
          [Schema.Array(Filter), ...filterUnions],
          [{ limit: 5 }],
          [{ page_size: "5" }],
        ],
        [objects, { 0: { page_size: "05" } }, { 0: { page_size: "05" } }],
        [objects, { 0: { limit: 5 }, 1: [] }, { 0: { limit: 5 }, 1: [] }],
      ] as const)
        for (const schema of schemas)
          expect(yield* prepared(schema, input)).toEqual(kept(output));
    }),
  );

  it.effect("reads a nested list the same way", () =>
    Effect.gen(function* () {
      const union = filterUnions[0]!;
      for (const schema of [
        Schema.Struct({ items: union }),
        Schema.Union([
          Schema.Struct({ items: Schema.Array(Filter) }),
          Schema.Struct({ items: Open }),
        ]),
      ]) {
        expect(yield* prepared(schema, { items: [{ limit: "x" }] })).toEqual(
          refused,
        );
        expect(yield* prepared(schema, { items: [{ limit: 5 }] })).toEqual(
          kept({ items: [{ page_size: "5" }] }),
        );
        expect(yield* prepared(schema, { items: { 0: { limit: 5 } } })).toEqual(
          kept({ items: { 0: { limit: 5 } } }),
        );
      }
      const elements = Schema.Array(union);
      expect(yield* prepared(elements, [[{ limit: "x" }]])).toEqual(refused);
      expect(
        yield* prepared(elements, [[{ limit: 5 }], { 0: { limit: 5 } }]),
      ).toEqual(kept([[{ page_size: "5" }], { 0: { limit: 5 } }]));
    }),
  );

  // A decoded `n` beside the list makes the parent read field by field.
  const parents = [...filterUnions, Schema.Array(Filter)].map((items) =>
    Schema.Struct({ n: Schema.FiniteFromString, items }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/241
  it.effect(
    "currently replaces an invalid item with a default under a fieldwise parent",
    () =>
      Effect.gen(function* () {
        expect(yield* prepared(Schema.Array(Filter), [{ limit: "x" }])).toEqual(
          refused,
        );
        for (const schema of parents)
          expect(
            yield* prepared(schema, { n: 1, items: [{ limit: "x" }] }),
          ).toEqual(kept({ n: "1", items: [{ page_size: "25" }] }));
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/241
  it.effect.fails("refuses an invalid item under a fieldwise parent", () =>
    Effect.gen(function* () {
      for (const schema of parents)
        expect(
          yield* prepared(schema, { n: 1, items: [{ limit: "x" }] }),
        ).toEqual(refused);
    }),
  );

  it.effect("keeps the list rule beside a guarded Void member", () =>
    Effect.gen(function* () {
      const list = Schema.Array(Plain);
      for (const schema of [
        Schema.Union([list, Open, Schema.Void]),
        Schema.Union([Schema.Void, list, Open]),
        Schema.Union([Open, Schema.Void, list]),
        Schema.Union([Schema.Union([list, Open]), Schema.Void]),
      ]) {
        expect(yield* prepared(schema, [{ limit: 5 }])).toEqual(refused);
        expect(yield* prepared(schema, [{ limit: "x" }])).toEqual(
          kept([{ limit: "x" }]),
        );
        expect(yield* prepared(schema, { 0: { limit: 5 } })).toEqual(
          kept({ 0: { limit: 5 } }),
        );
        const parent = Schema.Struct({ x: schema });
        expect(yield* prepared(parent, { x: [{ limit: 5 }] })).toEqual(refused);
      }
    }),
  );

  it.effect("refuses a list given to a record", () =>
    Effect.gen(function* () {
      // Effect's record refuses an actual array, as the types do.
      expect(
        Exit.isFailure(Schema.decodeUnknownExit(Open)([{ limit: "x" }])),
      ).toBe(true);
      for (const input of [[{ limit: "x" }], []])
        expect(yield* prepared(Open, input)).toEqual(refused);
    }),
  );

  it.effect("refuses such a list as a query or header group", () =>
    Effect.gen(function* () {
      const Group = Schema.Union([
        Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
        Schema.Record(Schema.String, Schema.Array(Schema.String)),
      ]);
      expect(yield* queried(Group, [["a", "b", "c"]])).toBe("refused");
      expect(yield* queried(Group, [["a", "b"]])).toEqual({ value: "/x?a=b" });
      expect(yield* queried(Group, { a: ["x", "y"] })).toEqual({
        value: "/x?a=x&a=y",
      });
      expect(yield* headed(Group, [["x-a", "1", "2"]])).toBe("refused");
      expect(yield* headed(Group, [["x-a", "1"]])).toEqual({
        value: [["x-a", "1"]],
      });
      expect(yield* headed(Group, { "x-a": ["1", "2"] })).toEqual({
        value: [
          ["x-a", "1"],
          ["x-a", "2"],
        ],
      });
    }),
  );

  it.effect("still tries union members one by one for a list", () =>
    Effect.gen(function* () {
      // Both members read the list, so the any-one rule refuses it as a whole. Only the first
      // member can write it, so a member read alone settles the choice.
      const DecodeOnly = Schema.Array(Schema.String).pipe(
        Schema.decodeTo(Schema.Array(Schema.String), {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.forbiddenEncoding,
        }),
      );
      const Either = Schema.Union([Schema.Array(Schema.String), DecodeOnly], {
        mode: "oneOf",
      });
      expect(Exit.isFailure(Schema.decodeUnknownExit(Either)(["abc"]))).toBe(
        true,
      );
      expect(yield* prepared(Either, ["abc"])).toEqual(kept(["abc"]));
    }),
  );

  it.effect(
    "treats extra keys, holes, no prototype or an own iterator as a list",
    () =>
      Effect.gen(function* () {
        const union = plainUnions[0]!;
        let iterations = 0;
        const lists = (item: object) => {
          const sparse: Array<object> = [];
          sparse.length = 2;
          sparse[1] = item;
          return {
            extra: Object.assign([item], { extra: "metadata" }),
            sparse,
            bare: Object.setPrototypeOf([item], null) as Array<object>,
            iterable: Object.defineProperty([item], Symbol.iterator, {
              value: function* () {
                iterations++;
                yield item;
              },
              enumerable: true,
            }),
          };
        };
        for (const [name, input] of Object.entries(lists({ limit: 5 })))
          expect(yield* prepared(union, input), name).toEqual(refused);
        for (const [name, input] of Object.entries(lists({ limit: "x" })))
          expect(yield* prepared(union, input), name).toEqual(
            yield* prepared(Schema.Array(Plain), input),
          );
        expect(iterations).toBe(0);
      }),
  );
});

describe("positional query and header groups", () => {
  const Pairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
  const Kept = Schema.Union([Schema.Struct({}), Pairs]);

  // https://github.com/viell-dev/slop-effect-schema-http/issues/242
  it.effect(
    "keeps order, repetition and declared defaults without array iterators",
    () =>
      Effect.gen(function* () {
        const base = Request.get("https://api.test/x");
        const fallback = base.pipe(
          Request.setQuery("fallback", "d"),
          Request.setQuery("k", "shadowed"),
          Request.setHeader("fallback", "d"),
          Request.setHeader("K", "shadowed"),
        );
        const original = [
          ["k", "v"],
          ["tag", "one"],
          ["k", "again"],
        ] as const;
        for (const schema of [Pairs, Kept]) {
          for (const declaration of [base, fallback]) {
            const request = declaration.pipe(
              Request.query(schema),
              Request.headers(schema),
            );
            const url =
              "https://api.test/x?k=v&tag=one&k=again" +
              (declaration === fallback ? "&fallback=d" : "");
            const lines =
              declaration === fallback
                ? [...original, ["fallback", "d"]]
                : original;
            for (const layout of [
              "ordinary",
              "null prototype",
              "own iterator",
            ] as const) {
              let iterations = 0;
              const pairs = original.map(
                ([name, value]) => [name, value] as const,
              );
              if (layout === "null prototype") {
                for (const pair of pairs) Object.setPrototypeOf(pair, null);
                Object.setPrototypeOf(pairs, null);
              }
              if (layout === "own iterator") {
                Object.defineProperty(pairs[0], Symbol.iterator, {
                  value: function* () {
                    iterations++;
                    yield "substituted";
                    yield "entry";
                  },
                });
                Object.defineProperty(pairs, Symbol.iterator, {
                  value: function* () {
                    iterations++;
                    yield ["substituted", "group"];
                  },
                });
              }
              const input = { query: pairs, headers: pairs };
              const scenario = `${schema === Pairs ? "pairs" : "union"}, ${declaration === fallback ? "with defaults" : "without defaults"}, ${layout}`;
              const compiled = yield* Request.compile(request, input);
              expect(compiled.request.url, scenario).toBe(url);
              expect(compiled.headerLines, scenario).toEqual(lines);
              const server = synthetic(() => empty(204));
              yield* Operation.make(request, Response.status(204, Body.empty))
                .execute(input)
                .pipe(Effect.provide(server.layer));
              expect(server.exchanges, scenario).toHaveLength(1);
              expect(server.exchanges[0]?.url, scenario).toBe(url);
              expect(server.exchanges[0]?.headerLines, scenario).toEqual(lines);
              expect(iterations, scenario).toBe(0);
            }
          }
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/242
  it.effect("reads each encoded array and pair position once per binding", () =>
    Effect.gen(function* () {
      const fetches = { entry: 0, name: 0, value: 0 };
      const pair = ["k", "v"];
      Object.defineProperties(pair, {
        "0": { get: () => (++fetches.name === 1 ? "k" : "substituted") },
        "1": { get: () => (++fetches.value === 1 ? "v" : "substituted") },
      });
      const pairs = [pair];
      Object.defineProperty(pairs, "0", {
        get: () => (++fetches.entry === 1 ? pair : ["substituted", "group"]),
      });
      const Group = Schema.Any.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform(() => "decoded"),
          encode: SchemaGetter.transform(() => pairs),
        }),
      );
      const query = Request.get("/x").pipe(Request.query(Group));
      const headers = Request.get("/x").pipe(Request.headers(Group));
      const result = yield* Request.compile(query, { query: "decoded" });
      expect(result.request.url).toBe("/x?k=v");
      expect(fetches).toEqual({ entry: 1, name: 1, value: 1 });

      Object.assign(fetches, { entry: 0, name: 0, value: 0 });
      const headerResult = yield* Request.compile(headers, {
        headers: "decoded",
      });
      expect(headerResult.headerLines).toEqual([["k", "v"]]);
      expect(fetches).toEqual({ entry: 1, name: 1, value: 1 });
    }),
  );
});

/** A union of two members, in each order. */
const either = <A extends Schema.Top, B extends Schema.Top>(a: A, b: B) => [
  Schema.Union([a, b]),
  Schema.Union([b, a]),
];

/** A list whose one item has a key no list item states. */
const row = () => [{ limit: "x", extra: 1 }];

/** The same item under an index-like key of an object. */
const cell = () => ({ 0: { limit: "x", extra: 1 } });

/**
 * A list whose first cell is hidden or inherited, beside a cell with a key set to `undefined`,
 * which normalization takes out.
 */
const hiddenFirst = (inherited: boolean) => {
  const first = { limit: "first" };
  const cells: Array<object> = [first, { limit: "last", absent: undefined }];
  if (!inherited) Object.defineProperty(cells, "0", { enumerable: false });
  else {
    delete cells[0];
    Object.setPrototypeOf(
      cells,
      Object.create(Array.prototype, { 0: { value: first } }),
    );
  }
  return cells;
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/243
describe("members that cannot read the caller's container", () => {
  const Plain = Schema.Struct({ limit: Schema.optionalKey(Schema.String) });
  const Open = Schema.Record(Schema.String, Schema.Unknown);
  const Indexed = Schema.Record(Schema.String, Plain);
  const Zero = Schema.Struct({ 0: Plain });
  const Rows = Schema.Array(Plain);
  class Limited extends Schema.Class<Limited>("Limited")({
    limit: Schema.optionalKey(Schema.String),
  }) {}
  class Bare extends Schema.Class<Bare>("Bare")({}) {}

  it("relies on Effect's parsers telling containers apart", () => {
    const list = [{ limit: "x" }];
    const object = { 0: { limit: "x" } };
    for (const schema of [Open, Indexed, Zero, Plain, Limited]) {
      expect(Exit.isFailure(Schema.decodeUnknownExit(schema)(list))).toBe(true);
      expect(Exit.isFailure(Schema.encodeUnknownExit(schema)(list))).toBe(true);
    }
    for (const schema of [
      Schema.Array(Schema.Unknown),
      Schema.Tuple([Schema.Unknown]),
    ]) {
      expect(Exit.isFailure(Schema.decodeUnknownExit(schema)(object))).toBe(
        true,
      );
      expect(Exit.isFailure(Schema.encodeUnknownExit(schema)(object))).toBe(
        true,
      );
    }
    // An empty struct reads a list as it is; an empty class copies its cells by index.
    expect(Schema.decodeUnknownSync(Schema.Struct({}))(list)).toBe(list);
    const instance = Schema.decodeUnknownSync(Bare)(list);
    expect(instance).toBeInstanceOf(Bare);
    expect({ ...instance }).toEqual(object);
  });

  it.effect("reads an object as its object member alone reads it", () =>
    Effect.gen(function* () {
      for (const object of [Indexed, Zero])
        for (const list of [
          Schema.Array(Schema.Unknown),
          Schema.Tuple([Schema.Unknown]),
        ]) {
          for (const [input, output] of [
            [cell(), { 0: { limit: "x" } }],
            [{ 0: { page_size: "05" } }, { 0: {} }],
          ] as const) {
            expect(yield* prepared(object, input)).toEqual(kept(output));
            for (const schema of either(object, list))
              expect(yield* prepared(schema, input)).toEqual(kept(output));
          }
          // The array member still reads a list the object member cannot.
          for (const schema of either(object, list))
            expect(yield* prepared(schema, [{ limit: "x", extra: 1 }])).toEqual(
              kept([{ limit: "x", extra: 1 }]),
            );
        }
    }),
  );

  it.effect("rules out a child schema another parent member gives", () =>
    Effect.gen(function* () {
      for (const schema of either(
        Schema.Struct({ items: Rows }),
        Schema.Struct({ items: Open }),
      )) {
        expect(yield* prepared(schema, { items: row() })).toEqual(
          kept({ items: [{ limit: "x" }] }),
        );
        expect(yield* prepared(schema, { items: cell() })).toEqual(
          kept({ items: cell() }),
        );
      }
      for (const schema of either(
        Schema.Struct({ items: Indexed }),
        Schema.Struct({ items: Schema.Array(Schema.Unknown) }),
      )) {
        expect(yield* prepared(schema, { items: cell() })).toEqual(
          kept({ items: { 0: { limit: "x" } } }),
        );
        expect(yield* prepared(schema, { items: row() })).toEqual(
          kept({ items: row() }),
        );
      }
    }),
  );

  it.effect("names only what the list member loses", () =>
    Effect.gen(function* () {
      for (const schema of either(Schema.Array(Filter), Open))
        for (const message of yield* refusals(schema, row())) {
          expect(message).toContain('[0]["limit"]');
          expect(message).not.toContain("extra");
        }
    }),
  );

  it.effect("keeps every member that can read the container", () =>
    Effect.gen(function* () {
      // An empty struct reads a list, so it keeps the cells' keys beside the record.
      for (const schema of [
        Schema.Union([Rows, Open, Schema.Struct({})]),
        Schema.Union([Schema.Struct({}), Open, Rows]),
      ])
        expect(yield* prepared(schema, row())).toEqual(kept(row()));
    }),
  );

  it.effect("keeps hidden and inherited cells beside an empty struct", () =>
    Effect.gen(function* () {
      for (const inherited of [false, true])
        for (const schema of either(Rows, Schema.Struct({})))
          expect(yield* prepared(schema, hiddenFirst(inherited))).toEqual(
            kept([{ limit: "first" }, { limit: "last" }]),
          );
    }),
  );

  // The rules above apply only where every alternative at a value is a struct, a record, a list or
  // a tuple. Beside a class, a declaration, any other codec or middleware, and inside a value that
  // middleware reads, a value keeps the reading it had on 0.18.0.

  // A codec that reads its encoded side through a declaration.
  const Listed = Schema.declare(
    (input: unknown): input is ReadonlyArray<unknown> => Array.isArray(input),
  );
  const FromList = Listed.pipe(
    Schema.decodeTo(
      Open,
      SchemaTransformation.transform({
        decode: (cells): Record<string, unknown> => ({ ...cells }),
        encode: (record) => Object.values(record),
      }),
    ),
  );
  // The same codec with its declaration behind a suspension.
  const FromDeferredList = Schema.suspend(() => Listed).pipe(
    Schema.decodeTo(
      Open,
      SchemaTransformation.transform({
        decode: (cells): Record<string, unknown> => ({ ...cells }),
        encode: (record) => Object.values(record),
      }),
    ),
  );

  it.effect("keeps 0.18.0's reading beside a codec from a declaration", () =>
    Effect.gen(function* () {
      const FromTwiceDeferred = Schema.suspend(() =>
        Schema.suspend(() => Listed),
      ).pipe(
        Schema.decodeTo(
          Open,
          SchemaTransformation.transform({
            decode: (cells): Record<string, unknown> => ({ ...cells }),
            encode: (record) => Object.values(record),
          }),
        ),
      );
      const FromListOrText = Schema.Union([Listed, Schema.String]).pipe(
        Schema.decodeTo(
          Open,
          SchemaTransformation.transform({
            decode: (cells): Record<string, unknown> =>
              typeof cells === "string" ? { text: cells } : { ...cells },
            encode: (record) => Object.values(record),
          }),
        ),
      );
      const FromDeferredUnknown = Schema.suspend(() => Schema.Unknown).pipe(
        Schema.decodeTo(
          Open,
          SchemaTransformation.transform({
            decode: (cells): Record<string, unknown> => ({
              ...(cells as object),
            }),
            encode: (record) => Object.values(record),
          }),
        ),
      );
      const FromUnknown = Schema.Unknown.pipe(
        Schema.decodeTo(
          Open,
          SchemaTransformation.transform({
            decode: (cells): Record<string, unknown> => ({
              ...(cells as object),
            }),
            encode: (record) => record,
          }),
        ),
      );
      for (const schema of [
        ...either(Rows, FromList),
        Schema.Union([Rows, Schema.suspend(() => FromList)]),
        Schema.suspend(() => Schema.Union([Rows, FromList])),
        ...either(Rows, FromDeferredList),
        ...either(Rows, FromTwiceDeferred),
        ...either(Rows, FromListOrText),
        ...either(Rows, FromDeferredUnknown),
      ])
        expect(yield* prepared(schema, row())).toEqual(kept(row()));
      for (const schema of either(Rows, FromUnknown))
        expect(yield* prepared(schema, row())).toEqual(kept(cell()));
      // An object beside a member decoded from a date keeps its stated reading.
      const A = Schema.Struct({ a: Schema.String });
      const B = Schema.Struct({ b: Schema.String });
      const FromDate = Schema.suspend(() => Schema.Date).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (date) => date.toISOString(),
            encode: (text) => new Date(text),
          }),
        ),
      );
      const FromDateOrNumber = Schema.Union([Schema.Date, Schema.Number]).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (moment) => String(Number(moment)),
            encode: (text) => Number(text),
          }),
        ),
      );
      for (const schema of [
        Schema.Union([A, B, Schema.DateTimeUtcFromDate]),
        Schema.Union([A, FromDate]),
        Schema.Union([A, B, FromDateOrNumber]),
      ])
        expect(yield* prepared(schema, { a: "x", z: 1 })).toEqual(
          kept({ a: "x" }),
        );
      const Dated = Schema.Struct({
        when: Schema.Union([A, Schema.DateTimeUtcFromDate]),
      }).pipe(Schema.encodeKeys({ when: "at" }));
      expect(yield* prepared(Dated, { when: { a: "x", z: 1 } })).toEqual(
        kept({ at: { a: "x" } }),
      );
    }),
  );

  it.effect(
    "refuses a cell key a list codec from a declaration cannot write",
    () =>
      Effect.gen(function* () {
        // As on 0.18.0, the record behind the codec holds the cell's keys, and it takes no `undefined`
        // inside a JSON value, so that subtree is refused rather than left out.
        const nested = [{ limit: "x", z: { keep: 1, absent: undefined } }];
        for (const schema of [
          ...either(Rows, FromList),
          ...either(Rows, FromDeferredList),
        ]) {
          const failure = yield* Effect.flip(prepare(schema, nested, "body"));
          expect(failure).toBeInstanceOf(Schema.SchemaError);
          expect(String(failure)).toContain('[0]["z"]');
          expect(yield* prepare(schema, nested, "path")).toEqual([
            { limit: "x", z: { keep: 1 } },
          ]);
        }
      }),
  );

  it.effect("keeps 0.18.0's reading beside or inside middleware", () =>
    Effect.gen(function* () {
      // The record reports the list it refused, and the recovery keeps its cells under their indexes.
      const Reported = Schema.declareConstructor()(
        [Open],
        ([member]) =>
          (input, _ast, options) =>
            Effect.mapError(
              Schema.decodeUnknownEffect(member)(input, {
                ...options,
                reportInput: true,
              }),
              (failure) => failure.issue,
            ),
      );
      const Restored = Reported.pipe(
        Schema.decodeTo(Open),
        Schema.catchDecoding((issue) => {
          let leaf: { readonly issue?: unknown; readonly input?: unknown } =
            issue;
          while (leaf.issue !== undefined) leaf = leaf.issue as typeof leaf;
          return Array.isArray(leaf.input)
            ? Effect.succeedSome(Object.fromEntries(leaf.input.entries()))
            : Effect.fail(issue);
        }),
      );
      for (const schema of [Restored, ...either(Rows, Restored)])
        expect(yield* prepared(schema, row())).toEqual(kept(cell()));
      // A recovery that returns the caller's own cells, on a member, on the union or on a parent.
      const cells = [{ limit: "x", extra: "unique" }];
      const returned = () =>
        Effect.succeedSome(Object.fromEntries(cells.entries()));
      const Returned = Open.pipe(Schema.catchDecoding(returned));
      for (const schema of [
        Returned,
        ...either(Rows, Returned),
        Schema.Union([Rows, Open]).pipe(Schema.catchDecoding(returned)),
        Schema.Union([
          Rows,
          Schema.Union([Open, Schema.String]).pipe(
            Schema.catchDecoding(returned),
          ),
        ]),
      ])
        expect(yield* prepared(schema, cells)).toEqual(
          kept({ 0: { limit: "x", extra: "unique" } }),
        );
      const Parent = Schema.Struct({ items: Schema.Union([Rows, Open]) }).pipe(
        Schema.catchDecoding(() =>
          Effect.succeedSome({ items: Object.fromEntries(cells.entries()) }),
        ),
      );
      expect(yield* prepared(Parent, { items: cells })).toEqual(
        kept({ items: { 0: { limit: "x", extra: "unique" } } }),
      );
      // A list a codec reads as text beside a record whose recovery fails keeps that codec's text.
      const Joined = Schema.Unknown.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: (items) =>
              Array.isArray(items) ? items.join(",") : String(items),
            encode: (text) => text,
          }),
        ),
      );
      const Failing = Open.pipe(
        Schema.catchDecoding((issue) => Effect.fail(issue)),
      );
      expect(
        yield* prepared(Schema.Struct({ a: Schema.Union([Joined, Failing]) }), {
          a: ["x", "y"],
        }),
      ).toEqual(kept({ a: "x,y" }));
      expect(
        yield* prepared(Schema.Union([Failing, Joined]), ["x", "y"]),
      ).toEqual(kept("x,y"));
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/243
  const Recovering = Open.pipe(
    Schema.catchDecoding(() => Effect.succeedSome({ recovered: true })),
  );

  it.effect("currently sends a recovery's value in place of a valid list", () =>
    Effect.gen(function* () {
      // The record holds the cell key, so the list member refuses it and the recovery takes the list.
      expect(yield* prepared(Schema.Union([Rows, Recovering]), row())).toEqual(
        kept({ recovered: true }),
      );
      expect(
        yield* prepared(Schema.Union([Rows, Recovering]), [{ limit: "x" }]),
      ).toEqual(kept([{ limit: "x" }]));
    }),
  );

  it.effect.fails("reads a valid list as its list member does", () =>
    Effect.gen(function* () {
      expect(yield* prepared(Schema.Union([Rows, Recovering]), row())).toEqual(
        kept([{ limit: "x" }]),
      );
    }),
  );

  // A recovery's value is not checked against the cells it was given.
  const Substituted = Open.pipe(
    Schema.catchDecoding(() =>
      Effect.succeedSome({ 0: { limit: "altered", extra: 99 } }),
    ),
  );

  it.effect("currently sends a cell a recovery puts in a caller's place", () =>
    Effect.gen(function* () {
      for (const schema of either(Rows, Substituted))
        expect(yield* prepared(schema, [{ limit: 5, extra: 1 }])).toEqual(
          kept({ 0: { limit: "altered", extra: 99 } }),
        );
    }),
  );

  it.effect.fails("refuses a cell a recovery puts in a caller's place", () =>
    Effect.gen(function* () {
      for (const schema of either(Rows, Substituted))
        expect(yield* prepared(schema, [{ limit: 5, extra: 1 }])).toEqual(
          refused,
        );
    }),
  );

  it.effect("keeps 0.18.0's reading beside a class", () =>
    Effect.gen(function* () {
      // A class has no list reading of its own here, so a list member placed first keeps the list.
      for (const schema of [
        ...either(Rows, Limited),
        Schema.Union([Rows, Bare]),
      ])
        expect(yield* prepared(schema, row())).toEqual(kept([{ limit: "x" }]));
      // Where Effect's first fit or a record's open values leave the list to the empty class, the
      // class takes every cell.
      for (const schema of [
        Bare,
        Schema.Union([Rows, Open, Bare]),
        Schema.Union([Rows, Schema.Union([Bare, Open])]),
        Schema.Union([Bare, Rows, Open]),
        Schema.Union([Open, Bare, Rows]),
        Schema.Union([Schema.Union([Open, Bare]), Rows]),
        Schema.Union([Schema.suspend(() => Bare), Rows, Open]),
        Schema.Union([
          Schema.suspend(() => Schema.suspend(() => Bare)),
          Rows,
          Open,
        ]),
        Schema.Union([
          Schema.Tuple([Schema.Number, Schema.Number]),
          Bare,
          Rows,
          Open,
        ]),
        Schema.Union([
          Schema.Tuple([Schema.Number, Schema.Number]),
          Schema.suspend(() => Schema.suspend(() => Bare)),
          Rows,
          Open,
        ]),
      ])
        expect(yield* prepared(schema, row())).toEqual(kept(cell()));
      for (const binding of ["path", "body"] as const)
        expect(
          yield* Effect.flip(prepare(Limited, row(), binding)),
        ).toBeInstanceOf(Schema.SchemaError);
    }),
  );

  it.effect("keeps a class codec's reading beside a list member", () =>
    Effect.gen(function* () {
      class Box extends Schema.Class<Box>("Box")({ value: Schema.Unknown }) {}
      const Boxed = Schema.Tuple([Schema.Unknown]).pipe(
        Schema.decodeTo(
          Box,
          SchemaTransformation.transform({
            decode: ([value]) => new Box({ value }),
            encode: ({ value }) => [value] as const,
          }),
        ),
      );
      // The tuple a class is decoded from reads the list.
      for (const schema of [Boxed, ...either(Boxed, Rows)])
        for (const binding of ["path", "body"] as const) {
          const output = yield* prepare(schema, row(), binding);
          const cells =
            output instanceof Box ? [output.value] : (output as Array<unknown>);
          expect(cells).toEqual(row());
        }
      const fromCell = SchemaTransformation.transform({
        decode: ([value]: readonly [unknown]) => new Bare({ 0: value }),
        encode: (bare: Bare): readonly [unknown] => [Reflect.get(bare, 0)],
      });
      const Cell = Schema.Tuple([Schema.Unknown]);
      for (const codec of [
        Cell.pipe(Schema.decodeTo(Bare, fromCell)),
        Cell.pipe(
          Schema.decodeTo(
            Schema.suspend(() => Bare),
            fromCell,
          ),
        ),
      ])
        for (const schema of [codec, ...either(Rows, codec)])
          expect(yield* prepared(schema, row())).toEqual(kept(row()));
    }),
  );

  it.effect("reads a class field's list without changing its siblings", () =>
    Effect.gen(function* () {
      const counts = { decode: 0, encode: 0 };
      const Price = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Number,
          SchemaTransformation.transform({
            decode: (text) => {
              counts.decode++;
              return Number(text);
            },
            encode: (price) => {
              counts.encode++;
              return String(price);
            },
          }),
        ),
      );
      const Late = Schema.Union([
        Schema.Tuple([Schema.Number, Schema.Number]),
        Bare,
        Rows,
        Open,
      ]);
      const Tail = Schema.Union([Rows, Bare]);
      for (const schema of [
        Schema.Struct({ first: Late, second: Tail }),
        Schema.Struct({ second: Tail, first: Late }),
      ])
        expect(
          yield* prepared(schema, { first: row(), second: row() }),
        ).toEqual(kept({ first: cell(), second: [{ limit: "x" }] }));
      // Under a renamed key too.
      expect(
        yield* prepared(
          Schema.Struct({ items: Late }).pipe(
            Schema.encodeKeys({ items: "ITEMS" }),
          ),
          { items: row() },
        ),
      ).toEqual(kept({ ITEMS: cell() }));
      // A sibling's decoder and encoder run once, as for any value.
      for (const binding of ["path", "body"] as const) {
        counts.decode = counts.encode = 0;
        expect(
          yield* prepare(
            Schema.Struct({ price: Price, items: Late }),
            { price: "05", items: row() },
            binding,
          ),
        ).toEqual({ price: "5", items: cell() });
        expect(counts).toEqual({ decode: 1, encode: 1 });
      }
      // A list another member writes as a record keeps that record, whatever else changes.
      const ListAsRecord = Schema.Record(Schema.String, Schema.String).pipe(
        Schema.decodeTo(
          Schema.Array(Schema.Number),
          SchemaTransformation.transform({
            decode: (record): ReadonlyArray<number> =>
              Object.values(record).map(Number),
            encode: (numbers) =>
              Object.fromEntries(
                numbers.map((number, index) => [String(index), String(number)]),
              ),
          }),
        ),
      );
      const Listing = Schema.Struct({
        a: Schema.String,
        items: Schema.Union([ListAsRecord, Bare]),
      });
      for (const input of [
        { a: "x", items: [1, 2] },
        { a: "x", extra: 1, items: [1, 2] },
        { a: "x", gone: undefined, items: [1, 2] },
      ])
        expect(yield* prepared(Listing, input)).toEqual(
          kept({ a: "x", items: { 0: "1", 1: "2" } }),
        );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/243
  const Parted = Schema.Union([
    Schema.Struct({ items: Bare }),
    Schema.Struct({ items: Rows }),
  ]);

  it.effect("currently cuts the cells an empty class takes beside a list", () =>
    Effect.gen(function* () {
      expect(yield* prepared(Schema.Union([Bare, Rows]), row())).toEqual(
        kept({ 0: { limit: "x" } }),
      );
      expect(yield* prepared(Parted, { items: row() })).toEqual(
        kept({ items: { 0: { limit: "x" } } }),
      );
    }),
  );

  it.effect.fails("keeps the cells an empty class takes beside a list", () =>
    Effect.gen(function* () {
      // Effect's first fit gives the list to the class, which keeps every cell.
      expect(yield* prepared(Schema.Union([Bare, Rows]), row())).toEqual(
        kept(cell()),
      );
      expect(yield* prepared(Parted, { items: row() })).toEqual(
        kept({ items: cell() }),
      );
    }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/257
describe("a list beside an open member", () => {
  const Rows = Schema.Array(
    Schema.Struct({ limit: Schema.optionalKey(Schema.String) }),
  );

  it.effect(
    "keeps a hidden or inherited cell when a later cell is rewritten",
    () =>
      Effect.gen(function* () {
        // The key set to undefined makes normalization rebuild the list; the first cell stays.
        for (const inherited of [false, true])
          for (const open of [Schema.Unknown, Schema.Any, Schema.ObjectKeyword])
            for (const schema of either(Rows, open))
              for (const binding of ["path", "body"] as const)
                // The cell keeps its own place, so the list reads as the caller's does.
                expect(
                  JSON.stringify(
                    yield* prepare(schema, hiddenFirst(inherited), binding),
                  ),
                ).toBe('[{"limit":"first"},{"limit":"last"}]');
      }),
  );

  it.effect("reads no prototype of a dense list it rebuilds", () =>
    Effect.gen(function* () {
      // Its own positions cover the list, so nothing can be inherited.
      for (const failing of [false, true])
        for (const schema of either(Rows, Schema.Unknown))
          for (const binding of ["path", "body"] as const) {
            let inspected = 0;
            const input = new Proxy(
              [{ limit: "first" }, { limit: "last", absent: undefined }],
              {
                getPrototypeOf(target) {
                  inspected++;
                  if (failing) throw new Error("prototype inspected");
                  return Reflect.getPrototypeOf(target);
                },
              },
            );
            const output = yield* prepare(schema, input, binding);
            expect(inspected).toBe(0);
            expect(JSON.stringify(output)).toBe(
              '[{"limit":"first"},{"limit":"last"}]',
            );
          }
    }),
  );
});
