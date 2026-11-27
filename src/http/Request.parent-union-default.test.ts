import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
import * as Request from "./Request.js";
import { memberFieldwise, memberFieldwiseTrace } from "../../test/request.js";

const Inner = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Direct = Schema.Struct({ filter: Inner });
const Cursor = Schema.Struct({ cursor: Schema.String });
const Root = Schema.Union([Direct, Cursor]);
const AlternateInner = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(50)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Distinct = Schema.Union([
  Direct,
  Schema.Struct({ filter: AlternateInner }),
]);
const NumericOther = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number),
  page_size: Schema.optionalKey(Schema.String),
});
const NumericMember = Schema.StructWithRest(
  Schema.Record(Schema.Literal(1), NumericOther),
  [Schema.Record(Schema.Literal("1"), Inner)],
);
const NumericConflict = Schema.Union([NumericMember, Cursor]);
const Tagged = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("a"), filter: Inner }),
  Schema.Struct({ kind: Schema.Literal("b"), filter: Inner }),
]);
const shapes = [
  { name: "root", schema: Root, wrap: (filter: object) => ({ filter }) },
  {
    name: "reversed root",
    schema: Schema.Union([Cursor, Direct]),
    wrap: (filter: object) => ({ filter }),
  },
  {
    name: "deeper union",
    schema: Schema.Struct({ page: Root }),
    wrap: (filter: object) => ({ page: { filter } }),
  },
  {
    name: "shared field schema",
    schema: Tagged,
    wrap: (filter: object) => ({ kind: "a" as const, filter }),
  },
  {
    name: "nested unions",
    schema: Schema.Union([Root, Schema.Struct({ token: Schema.String })]),
    wrap: (filter: object) => ({ filter }),
  },
] as const;
const prepare = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  kind: "path" | "body",
) => {
  if (kind === "path") {
    let output: unknown;
    const request = Request.get("").pipe(
      Request.path(schema, (value) => {
        output = value;
        return "/prepared";
      }),
    );
    return Request.compile(request, { path: input as Request.Input<S> }).pipe(
      Effect.map(() => output),
    );
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
describe("nested aliases below unchanged parent unions", () => {
  for (const kind of ["path", "body"] as const) {
    for (const { name, schema, wrap } of shapes) {
      it.effect(`refuses invalid ${kind} input through a ${name}`, () =>
        Effect.gen(function* () {
          for (const page_size of ["many", null])
            expect(
              yield* Effect.flip(prepare(schema, wrap({ page_size }), kind)),
            ).toBeInstanceOf(Schema.SchemaError);
        }),
      );
      it.effect(`keeps ${kind} sides and defaults through a ${name}`, () =>
        Effect.gen(function* () {
          for (const [filter, expected] of [
            [{ page_size: "05" }, "5"],
            [{ limit: 5 }, "5"],
            [{}, "25"],
            [{ page_size: undefined }, "25"],
          ] as const)
            expect(yield* prepare(schema, wrap(filter), kind)).toEqual(
              wrap({ page_size: expected }),
            );
          expect(
            yield* Effect.flip(
              prepare(schema, wrap({ limit: 5, page_size: "many" }), kind),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
        }),
      );
    }
    it.effect(`keeps the other ${kind} union alternatives`, () =>
      Effect.gen(function* () {
        expect(yield* prepare(Root, { cursor: "a/b" }, kind)).toEqual({
          cursor: "a/b",
        });
        expect(
          yield* prepare(
            Tagged,
            { kind: "b", filter: { page_size: "05" } },
            kind,
          ),
        ).toEqual({ kind: "b", filter: { page_size: "5" } });
      }),
    );
  }

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "refuses an invalid alias under conflicting normalized numeric declarations",
    () =>
      Effect.gen(function* () {
        for (const { schema, wrap } of [
          {
            schema: NumericConflict,
            wrap: (value: object) => ({ "1": value }),
          },
          { schema: NumericMember, wrap: (value: object) => ({ "1": value }) },
          {
            schema: Schema.Struct({ page: NumericMember }),
            wrap: (value: object) => ({ page: { "1": value } }),
          },
        ]) {
          expect(
            yield* Effect.flip(
              prepare(schema, wrap({ page_size: "many" }), "path"),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
          for (const value of [{ page_size: "05" }, { limit: 5 }])
            expect(yield* prepare(schema, wrap(value), "path")).toEqual(
              wrap({ page_size: "5" }),
            );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "refuses invalid input under distinct parent field declarations",
    () =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            prepare(Distinct, { filter: { page_size: "many" } }, "body"),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  for (const kind of ["path", "body"] as const) {
    it.effect(
      `keeps stable own-data profiles through parent-union ${kind}`,
      () =>
        Effect.gen(function* () {
          for (const input of [
            Object.freeze({ filter: Object.freeze({ page_size: "many" }) }),
            Object.assign(Object.create(null), {
              filter: Object.assign(Object.create(null), { page_size: "many" }),
            }),
            Object.defineProperty({}, "filter", {
              value: Object.defineProperty({}, "page_size", { value: "many" }),
            }),
          ])
            expect(
              yield* Effect.flip(prepare(Root, input, kind)),
            ).toBeInstanceOf(Schema.SchemaError);
        }),
    );
  }

  it.effect("keeps actual member-fieldwise consumption of a nested alias", () =>
    Effect.gen(function* () {
      let defaults = 0;
      const filter = Schema.Struct({
        limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
          Schema.withConstructorDefault(
            Effect.sync(() => {
              defaults++;
              return 25;
            }),
          ),
        ),
        gate: Schema.FiniteFromString,
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const member = Schema.Struct({
        filter,
        n: Schema.FiniteFromString,
        m: Schema.FiniteFromString,
        shared: Schema.StringFromBase64,
        opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
      });
      const schema = Schema.Union([member, Cursor]);
      const input = {
        filter: { page_size: "05", gate: "03" },
        n: "07",
        m: 9,
        shared: "eA==",
        opaque: Option.some({ keep: "x", extra: "opaque" }),
      };
      defaults = 0;
      expect(
        yield* Inputs.reader(schema, Schema.encodeEffect(schema))(input),
      ).toEqual({
        output: {
          filter: { page_size: "5", gate: "3" },
          n: "7",
          m: "9",
          shared: "ZUE9PQ==",
          opaque: Option.some({ keep: "x" }),
        },
        lost: [],
      });
      // The original parent-union member attempts run this default three times.
      expect(defaults).toBe(3);
    }),
  );
});

// Recording a read's failure to explain a refusal must not run the schema's steps. These traces
// are those from before #275's messages, whose recorded loose read ran even where no route read.
// https://github.com/viell-dev/slop-effect-schema-http/issues/317
describe("callback traces of a member read field by field", () => {
  for (const kind of ["path", "body"] as const)
    it.effect(
      `keeps the callback trace of a member-fieldwise ${kind} read`,
      () =>
        Effect.gen(function* () {
          const { schema, input, written, trace } = memberFieldwise(false);
          expect(yield* prepare(schema, input, kind)).toEqual(
            kind === "path"
              ? written
              : {
                  ...written,
                  neighbor: { _tag: "Some", value: { keep: "ok" } },
                },
          );
          expect(trace).toEqual(memberFieldwiseTrace);
        }),
    );
});
