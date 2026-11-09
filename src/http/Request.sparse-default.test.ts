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
      it.effect(`${kind} refuses an invalid own alias below a ${name}`, () =>
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
  it("captures huge sparse own-cell evidence with a bounded number of reflections", () => {
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
  });

  it("selects an own sparse cell and keeps the strict written-array guard", () => {
    const input = sparse({ page_size: "many" });
    const capture = nestedEncodedInput(
      Schema.Array(Schema.optional(Filter)).ast,
    )!;
    const output = [undefined, { page_size: "25" }];
    const selected = capture(input)!.select(output)!;
    expect(selected.matches()).toBe(true);
    expect(capture(input)!.select(sparse({ page_size: "25" }))).toBeUndefined();
    const iterableOutput = Object.defineProperty(output, Symbol.iterator, {
      value: Array.prototype[Symbol.iterator],
    });
    expect(capture(input)!.select(iterableOutput)).toBeUndefined();
    input[0] = {};
    expect(selected.matches()).toBe(false);
  });

  it("admits only exact native own iterator data and rechecks its identity and flags", () => {
    const capture = nestedEncodedInput(Schema.Array(Filter).ast)!;
    const native = Array.prototype[Symbol.iterator];
    for (const enumerable of [false, true]) {
      const input = Object.defineProperty(
        [{ page_size: "many" }],
        Symbol.iterator,
        { value: native, enumerable, writable: true, configurable: true },
      );
      const selected = capture(input)!.select([{ page_size: "25" }])!;
      expect(selected.matches()).toBe(true);
      Object.defineProperty(input, Symbol.iterator, {
        enumerable: !enumerable,
      });
      expect(selected.matches()).toBe(false);
    }
    let reads = 0;
    const original = [{ page_size: "many" }];
    for (const iterator of [
      Array.prototype.entries,
      native.bind([]),
      function* () {
        reads++;
        yield { page_size: "many" };
      },
    ])
      expect(
        capture(
          Object.defineProperty([...original], Symbol.iterator, {
            value: iterator,
          }),
        ),
      ).toBeUndefined();
    expect(
      capture(
        Object.defineProperty([...original], Symbol.iterator, {
          get() {
            reads++;
            return native;
          },
        }),
      ),
    ).toBeUndefined();
    expect(reads).toBe(0);
    const input = Object.defineProperty([...original], Symbol.iterator, {
      value: native,
      writable: true,
    });
    const selected = capture(input)!.select([{ page_size: "25" }])!;
    Object.defineProperty(input, Symbol.iterator, {
      value: Array.prototype.entries,
    });
    expect(selected.matches()).toBe(false);
  });

  it("invalidates native-own evidence if the ordinary iterator uses a different data function", () => {
    const capture = nestedEncodedInput(Schema.Array(Filter).ast)!;
    const descriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    )!;
    const input = Object.defineProperty(
      [{ page_size: "many" }],
      Symbol.iterator,
      { value: descriptor.value },
    );
    const selected = capture(input)!.select([{ page_size: "25" }])!;
    const native = Array.prototype[Symbol.iterator];
    let matches: boolean | undefined;
    try {
      // oxlint-disable-next-line no-extend-native -- Test prototype identity and restore it below.
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        value: function (this: unknown[]) {
          return native.call(this);
        },
        configurable: true,
      });
      matches = selected.matches();
    } finally {
      // oxlint-disable-next-line no-extend-native -- Restore the prototype after this isolated test.
      Object.defineProperty(Array.prototype, Symbol.iterator, descriptor);
    }
    expect(matches).toBe(false);
  });

  it.effect(
    "uses an own valid cell to refuse an inherited invalid neighbor",
    () =>
      Effect.gen(function* () {
        const descriptor = Object.getOwnPropertyDescriptor(
          Array.prototype,
          "0",
        );
        try {
          // oxlint-disable-next-line no-extend-native -- Exercise inherited data and restore it below.
          Object.defineProperty(Array.prototype, "0", {
            value: { page_size: "many" },
            writable: true,
            configurable: true,
          });
          for (const kind of ["path", "body"] as const) {
            const input = sparse({ page_size: "05" });
            expect(
              yield* Effect.flip(
                prepare(Schema.Array(Schema.optional(Filter)), input, kind),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
            expect(Object.hasOwn(input, "0")).toBe(false);
            expect(input[1]).toEqual({ page_size: "05" });
          }
        } finally {
          if (descriptor === undefined) delete Array.prototype[0];
          // oxlint-disable-next-line no-extend-native -- Restore the prototype after this isolated test.
          else Object.defineProperty(Array.prototype, "0", descriptor);
        }
      }),
  );
});
