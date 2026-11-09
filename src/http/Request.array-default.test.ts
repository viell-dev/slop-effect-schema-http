import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
import { nestedEncodedInput } from "./internal/nested-input.js";
import * as Request from "./Request.js";

const Inner = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const shapes = [
  {
    name: "root array",
    schema: Schema.Array(Inner),
    wrap: (value: object) => [value],
  },
  {
    name: "wrapped array",
    schema: Schema.Struct({ filters: Schema.Array(Inner) }),
    wrap: (value: object) => ({ filters: [value] }),
  },
  {
    name: "nested arrays",
    schema: Schema.Array(Schema.Array(Inner)),
    wrap: (value: object) => [[value]],
  },
  {
    name: "object parent union",
    schema: Schema.Union([
      Schema.Struct({ filters: Schema.Array(Inner) }),
      Cursor,
    ]),
    wrap: (value: object) => ({ filters: [value] }),
  },
  {
    name: "element union",
    schema: Schema.Array(Schema.Union([Inner, Cursor])),
    wrap: (value: object) => [value],
  },
  {
    name: "fixed tuple",
    schema: Schema.Tuple([Inner]),
    wrap: (value: object) => [value],
  },
  {
    name: "prefix tuple",
    schema: Schema.Tuple([Schema.Number, Inner]),
    wrap: (value: object) => [3, value],
  },
  {
    name: "rest tuple",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.Number]), [Inner]),
    wrap: (value: object) => [3, value],
  },
  {
    name: "post-rest tuple",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.Number,
      Inner,
    ]),
    wrap: (value: object) => ["prefix", 3, value],
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
    ).pipe(Effect.map(() => output));
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
describe("nested aliases below unchanged array positions", () => {
  for (const kind of ["path", "body"] as const)
    for (const { name, schema, wrap } of shapes) {
      it.effect(`refuses invalid ${kind} input through a ${name}`, () =>
        Effect.gen(function* () {
          for (const page_size of ["many", null])
            expect(
              yield* Effect.flip(prepare(schema, wrap({ page_size }), kind)),
            ).toBeInstanceOf(Schema.SchemaError);
        }),
      );
      it.effect(`retains ${kind} controls through a ${name}`, () =>
        Effect.gen(function* () {
          for (const value of [{ page_size: "05" }, { limit: 5 }])
            expect(yield* prepare(schema, wrap(value), kind)).toEqual(
              wrap({ page_size: "5" }),
            );
          expect(yield* prepare(schema, wrap({}), kind)).toEqual(
            wrap({ page_size: "25" }),
          );
        }),
      );
    }

  it.effect("observes the original successful whole constructor", () =>
    Effect.gen(function* () {
      for (const { schema, wrap } of shapes) {
        let constructed = false;
        expect(
          yield* Inputs.toDecoded(schema)(
            wrap({ page_size: "many" }) as Request.Input<typeof schema>,
            () => {
              constructed = true;
            },
          ),
        ).toEqual(wrap({ limit: 25 }));
        expect(constructed).toBe(true);
      }
    }),
  );

  it("builds and captures positional evidence without evaluating schemas", () => {
    let defaults = 0;
    let checks = 0;
    const inner = Schema.Struct({
      limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
        Schema.withConstructorDefault(
          Effect.sync(() => {
            defaults++;
            return 25;
          }),
        ),
      ),
    }).pipe(Schema.encodeKeys({ limit: "page_size" }));
    const schema = Schema.Array(inner).check(
      Schema.makeFilter(() => {
        checks++;
        return true;
      }),
    );
    const capture = nestedEncodedInput(schema.ast);
    expect(capture).toBeDefined();
    expect(
      capture!([{ page_size: "many" }])
        ?.select([{ page_size: "25" }])
        ?.matches(),
    ).toBe(true);
    expect({ defaults, checks }).toEqual({ defaults: 0, checks: 0 });
  });

  it("requires a write at the captured position and unchanged array length", () => {
    const capture = nestedEncodedInput(Schema.Array(Inner).ast)!;
    const evidence = capture([{ page_size: "many" }, {}])!;
    expect(evidence.select([{}, { page_size: "25" }])).toBeUndefined();
    expect(evidence.select([{ page_size: "25" }])).toBeUndefined();
    expect(evidence.select([{ page_size: "25" }, {}])?.matches()).toBe(true);
  });

  it("keeps one coherent positional witness", () => {
    const capture = nestedEncodedInput(Schema.Array(Inner).ast)!;
    const input = [{ page_size: "many" }, { page_size: "many" }];
    const evidence = capture(input)!;
    input[0]!.page_size = "05";
    expect(evidence.select([{ page_size: "25" }, {}])).toBeUndefined();
    const selected = evidence.select([{}, { page_size: "25" }])!;
    expect(selected.matches()).toBe(true);
    input[1]!.page_size = "05";
    expect(selected.matches()).toBe(false);
  });

  it("declines an array-shaped union ancestor", () => {
    expect(
      nestedEncodedInput(Schema.Union([Schema.Array(Inner), Cursor]).ast),
    ).toBeUndefined();
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("currently retains the default below an array-shaped union", () =>
    Effect.gen(function* () {
      const schema = Schema.Union([Schema.Array(Inner), Cursor]);
      for (const kind of ["path", "body"] as const) {
        expect(yield* prepare(schema, [{ page_size: "many" }], kind)).toEqual([
          { page_size: "25" },
        ]);
        expect(yield* prepare(schema, [{ page_size: "05" }], kind)).toEqual([
          { page_size: "5" },
        ]);
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect.fails("refuses invalid input below an array-shaped union", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          prepare(
            Schema.Union([Schema.Array(Inner), Cursor]),
            [{ page_size: "many" }],
            "path",
          ),
        ),
      ).toBeInstanceOf(Schema.SchemaError);
    }),
  );
});
