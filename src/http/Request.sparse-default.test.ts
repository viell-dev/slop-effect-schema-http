import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Body from "./Body.js";
import { nestedEncodedInput } from "./internal/nested-input.js";
import * as Request from "./Request.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const sparse = (leaf: object, index = 1) => {
  const input: object[] = [];
  input.length = 2;
  input[index] = leaf;
  return input;
};
const shapes = [
  {
    name: "leading hole",
    schema: Schema.Array(Schema.optional(Filter)),
    wrap: (leaf: object) => sparse(leaf),
    output: (leaf: object) => [null, leaf],
  },
  {
    name: "trailing hole",
    schema: Schema.Array(Schema.optional(Filter)),
    wrap: (leaf: object) => sparse(leaf, 0),
    output: (leaf: object) => [leaf, null],
  },
  {
    name: "hidden own cell",
    schema: Schema.Array(Schema.optional(Filter)),
    wrap: (leaf: object) => {
      const input: object[] = [];
      input.length = 2;
      return Object.defineProperty(input, "1", { value: leaf });
    },
    output: (leaf: object) => [null, leaf],
  },
  {
    name: "null prototype",
    schema: Schema.Array(Schema.optional(Filter)),
    wrap: (leaf: object) =>
      Object.setPrototypeOf(sparse(leaf), null) as object[],
    output: (leaf: object) => [null, leaf],
  },
  {
    name: "optional tuple",
    schema: Schema.Tuple([Schema.optional(Filter), Schema.optional(Filter)]),
    wrap: (leaf: object) => sparse(leaf),
    output: (leaf: object) => [null, leaf],
  },
  {
    name: "post-rest tuple",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.optional(Schema.Number),
      Filter,
    ]),
    wrap: (leaf: object) => {
      const input: unknown[] = ["prefix"];
      input.length = 3;
      input[2] = leaf;
      return input;
    },
    output: (leaf: object) => ["prefix", null, leaf],
  },
] as const;
const prepare = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  kind: "path" | "body",
) => {
  if (kind === "path") {
    let output: unknown;
    return Request.compile(
      Request.get("").pipe(
        Request.path(schema, (value) => {
          output = value;
          return "/prepared";
        }),
      ),
      { path: input as Request.Input<S> },
    ).pipe(Effect.map(() => JSON.parse(JSON.stringify(output)) as unknown));
  }
  return Request.compile(
    Request.post("/x").pipe(Request.body(Body.jsonSchema(schema))),
    { body: input as Request.Input<S> },
  ).pipe(
    Effect.map(({ request }) => {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON");
      return JSON.parse(new TextDecoder().decode(request.body.body)) as unknown;
    }),
  );
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("constructor defaults below sparse own positions", () => {
  for (const kind of ["path", "body"] as const) {
    for (const { name, schema, wrap, output } of shapes) {
      it.effect(`currently ${kind} defaults below a ${name}`, () =>
        Effect.gen(function* () {
          for (const page_size of ["many", null])
            expect(yield* prepare(schema, wrap({ page_size }), kind)).toEqual(
              output({ page_size: "25" }),
            );
        }),
      );
      it.effect.fails(
        `${kind} refuses an invalid own alias below a ${name}`,
        () =>
          Effect.gen(function* () {
            for (const page_size of ["many", null])
              expect(
                yield* Effect.flip(prepare(schema, wrap({ page_size }), kind)),
              ).toBeInstanceOf(Schema.SchemaError);
          }),
      );
      it.effect(
        `${kind} keeps valid, decoded and omitted controls below a ${name}`,
        () =>
          Effect.gen(function* () {
            for (const leaf of [{ page_size: "05" }, { limit: 5 }])
              expect(yield* prepare(schema, wrap(leaf), kind)).toEqual(
                output({ page_size: "5" }),
              );
            expect(yield* prepare(schema, wrap({}), kind)).toEqual(
              output({ page_size: "25" }),
            );
          }),
      );
    }
  }

  it("currently declines sparse input evidence before checking a huge sparse length", () => {
    const input: object[] = [];
    input.length = 0xffff_ffff;
    input[1] = { page_size: "many" };
    expect(
      nestedEncodedInput(Schema.Array(Filter).ast)!(input),
    ).toBeUndefined();
  });
  it.fails(
    "captures huge sparse own-cell evidence with a bounded number of reflections",
    () => {
      let reads = 0;
      const input: object[] = [];
      input.length = 0xffff_ffff;
      input[1] = { page_size: "many" };
      const watched = new Proxy(input, {
        ownKeys(target) {
          reads++;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          reads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const evidence = nestedEncodedInput(Schema.Array(Filter).ast)!(watched);
      expect(evidence).toBeDefined();
      expect(reads).toBeLessThanOrEqual(12);
    },
  );
});
