import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as Shapes from "./internal/shape.js";
import * as Request from "./Request.js";
import type * as Transport from "./Transport.js";

type Checked = Request.Request<
  never,
  Schema.SchemaError | Request.InvalidRequest
>;
const compile = (request: Checked, input: unknown) =>
  Request.compile(request, input as never);

// https://github.com/viell-dev/slop-effect-schema-http/issues/143
describe("generated fields in finite closed unions", () => {
  const Base = Schema.Struct({
    limit: Schema.optionalKey(Schema.String).pipe(
      Schema.withConstructorDefault(Effect.succeed("25")),
    ),
    other: Schema.optionalKey(Schema.String),
  });
  const Renamed = Base.pipe(Schema.encodeKeys({ limit: "page_size" }));
  const Alternative = Schema.Struct({ cursor: Schema.String });

  for (const group of ["query", "headers"] as const) {
    const bind =
      <
        S extends Schema.Top &
          Schema.ConstraintCodec<unknown, Transport.HeaderInput, never, never>,
      >(
        schema: S,
      ) =>
      (self: Checked): Checked =>
        group === "query"
          ? self.pipe(Request.query(schema))
          : self.pipe(Request.headers(schema));
    const set = group === "query" ? Request.setQuery : Request.setHeader;
    const append =
      group === "query" ? Request.appendQuery : Request.appendHeader;
    const remove =
      group === "query" ? Request.removeQuery : Request.removeHeader;
    const name = group === "query" ? "page_size" : "PAGE_SIZE";
    const output = (result: Request.Compiled) =>
      group === "query" ? result.request.url : result.headerLines;
    const expected = (value: string) =>
      group === "query" ? `/x?page_size=${value}` : [["page_size", value]];
    const renamedUnion = Schema.Union([Renamed, Alternative]);

    it.effect(
      `refuses replaced ${group} edits through root and member encodings`,
      () =>
        Effect.gen(function* () {
          const outcomes: string[] = [];
          for (const schema of [
            Schema.Union([Renamed]),
            renamedUnion,
            Schema.Union([Alternative, Renamed]),
            Schema.Union([
              Schema.Struct({
                page_size: Schema.optionalKey(Schema.String),
                other: Schema.optionalKey(Schema.String),
              }),
              Schema.Struct({ cursor: Schema.String }),
            ]).pipe(
              Schema.decodeTo(
                Base,
                SchemaTransformation.transform({
                  decode: (value): typeof Base.Type => ({
                    limit:
                      "page_size" in value ? (value.page_size ?? "25") : "25",
                    ...("other" in value ? { other: value.other } : {}),
                  }),
                  encode: ({ limit, other }) => ({
                    page_size: limit ?? "25",
                    ...(other === undefined ? {} : { other }),
                  }),
                }),
              ),
            ),
          ]) {
            expect(
              output(yield* compile(Request.get("/x").pipe(bind(schema)), {})),
            ).toEqual(expected("25"));
            for (const edit of [
              set(name, "secret"),
              append(name, "secret"),
              remove(name),
              remove(name, "secret"),
              set({ [name]: undefined }),
            ]) {
              const request = Request.get("/x").pipe(bind(schema), edit);
              for (const input of [{}, { [group]: Object.create(null) }]) {
                const result = yield* Effect.result(compile(request, input));
                outcomes.push(result._tag);
                if (result._tag === "Failure") {
                  const error = result.failure;
                  expect(error).toBeInstanceOf(Request.InvalidRequest);
                  expect(error.message).toContain("Schema preparation");
                  expect(error.message).toContain('"page_size"');
                  expect(error.cause).toBeUndefined();
                  expect(JSON.stringify(error)).not.toContain("secret");
                }
              }
            }
          }
          expect(outcomes).toEqual(Array.from({ length: 40 }, () => "Failure"));
        }),
    );

    it.effect(
      `proves an omitted same-name ${group} field with nonempty input`,
      () =>
        Effect.gen(function* () {
          const Generated = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.optionalKey(Schema.String), {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.withDefault(Effect.succeed("25")),
              }),
            ),
            other: Schema.optionalKey(Schema.String),
          });
          const schema = Schema.Union([Generated, Alternative]);
          for (const limit of ["absent", "undefined"] as const) {
            const value =
              limit === "absent"
                ? { other: "x" }
                : { other: "x", limit: undefined };
            const request = Request.get("/x").pipe(
              bind(schema),
              remove("limit"),
            );
            expect(
              yield* Effect.flip(compile(request, { [group]: value })),
            ).toBeInstanceOf(Request.InvalidRequest);
          }
        }),
    );

    it.effect(
      `keeps explicit ${group} aliases and edits made before binding`,
      () =>
        Effect.gen(function* () {
          const binding = bind(renamedUnion);
          const request = Request.get("/x").pipe(binding, set(name, "5"));
          for (const value of [{ limit: "7" }, { page_size: "7" }])
            expect(output(yield* compile(request, { [group]: value }))).toEqual(
              expected("7"),
            );
          expect(
            output(
              yield* compile(
                Request.get("/x").pipe(set(name, "5"), binding),
                {},
              ),
            ),
          ).toEqual(expected("25"));
        }),
    );

    it.effect(
      `retains the transformed ${group} limit for every kind of own input key`,
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(
            bind(renamedUnion),
            remove(name),
          );
          for (const value of [
            { other: "x" },
            { limit: undefined },
            Object.defineProperty({}, "hidden", { value: "x" }),
            { [Symbol("metadata")]: "x" },
          ]) {
            const result = output(yield* compile(request, { [group]: value }));
            expect(
              group === "query" ? result : JSON.stringify(result),
            ).toContain("25");
          }
        }),
    );

    it.effect(
      `excludes open, declared, suspended and class ${group} alternatives`,
      () =>
        Effect.gen(function* () {
          class ClosedClass extends Schema.Class<ClosedClass>("ClosedClass")({
            cursor: Schema.String,
          }) {}
          const Declared = Schema.declare(
            (value): value is { cursor: string } =>
              typeof value === "object" && value !== null && "cursor" in value,
          );
          for (const alternative of [
            Schema.Record(Schema.String, Schema.String),
            Declared,
            Schema.suspend(() => Alternative),
            ClosedClass,
          ]) {
            const request = Request.get("/x").pipe(
              bind(Schema.Union([Renamed, alternative])),
              remove(name),
            );
            expect(output(yield* compile(request, {}))).toEqual(expected("25"));
          }
        }),
    );

    it.effect(
      `adds no callbacks while classifying generated ${group} output`,
      () =>
        Effect.gen(function* () {
          const trace: string[] = [];
          const Counted = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.withDefault(
                  Effect.sync(() => {
                    trace.push("default");
                    return "25";
                  }),
                ),
                encode: SchemaGetter.transform((value) => {
                  trace.push("encode");
                  return value;
                }),
              }),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const base = Request.get("/x").pipe(
            bind(Schema.Union([Counted, Alternative])),
          );
          expect(output(yield* compile(base, {}))).toEqual(expected("25"));
          const baseline = [...trace];
          trace.length = 0;
          expect(
            yield* Effect.flip(compile(base.pipe(remove(name)), {})),
          ).toBeInstanceOf(Request.InvalidRequest);
          expect(trace).toEqual(baseline);
          expect(trace).toEqual(["default", "encode"]);
        }),
    );

    it.effect(
      `requires an actual nonundefined ${group} output and keeps iterable output`,
      () =>
        Effect.gen(function* () {
          for (const limit of [
            Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.optionalKey(Schema.String), {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.omit(),
              }),
            ),
            Schema.optionalKey(Schema.UndefinedOr(Schema.String)).pipe(
              Schema.withConstructorDefault(Effect.succeed(undefined)),
            ),
          ]) {
            const schema = Schema.Union([
              Schema.Struct({ limit }).pipe(
                Schema.encodeKeys({ limit: "page_size" }),
              ),
              Alternative,
            ]);
            expect(
              output(
                yield* compile(
                  Request.get("/x").pipe(bind(schema), remove(name)),
                  {},
                ),
              ),
            ).toEqual(group === "query" ? "/x" : []);
          }
          let iterations = 0;
          const Iterable = Schema.Struct({
            ...Base.fields,
            [Symbol.iterator]: Schema.optionalKey(
              Schema.declare(
                (value): value is () => Generator<readonly [string, string]> =>
                  typeof value === "function",
              ),
            ).pipe(
              Schema.withConstructorDefault(
                Effect.succeed(function* () {
                  iterations++;
                  yield* [];
                }),
              ),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const base = Request.get("/x").pipe(
            bind(Schema.Union([Iterable, Alternative])),
          );
          expect(output(yield* compile(base, {}))).toEqual(
            group === "query" ? "/x" : [],
          );
          const baseline = iterations;
          expect(baseline).toBeGreaterThan(0);
          iterations = 0;
          expect(output(yield* compile(base.pipe(remove(name)), {}))).toEqual(
            group === "query" ? "/x" : [],
          );
          expect(iterations).toBe(baseline);
        }),
    );

    it.effect(
      `keeps generated ${group} evidence per binding across stacks, reuse and unbind`,
      () =>
        Effect.gen(function* () {
          const binding = bind(renamedUnion);
          const request = Request.get("/x").pipe(binding, set(name, "5"));
          const stacked = request.pipe(
            bind(Schema.Struct({ other: Schema.optionalKey(Schema.String) })),
          );
          expect(yield* Effect.flip(compile(stacked, {}))).toBeInstanceOf(
            Request.InvalidRequest,
          );
          const reused = request.pipe(
            Request.mapInput(() => ({ [group]: { limit: "7" } }) as never),
            binding,
          );
          expect(output(yield* compile(reused, {}))).toEqual(expected("25"));
          const cleared = request.pipe(Request.unbind(group));
          expect(output(yield* compile(cleared, undefined))).toEqual(
            group === "query" ? "/x?page_size=5" : [[name, "5"]],
          );
          expect(output(yield* compile(cleared.pipe(binding), {}))).toEqual(
            expected("25"),
          );
        }),
    );

    it.effect(
      `preserves ${group} member priority and validation before proof`,
      () =>
        Effect.gen(function* () {
          const First = Schema.Struct({ limit: Base.fields.limit }).pipe(
            Schema.encodeKeys({ limit: "page_size" }),
          );
          const Second = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(Effect.succeed("99")),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const base = Request.get("/x").pipe(
            bind(Schema.Union([First, Second])),
          );
          expect(output(yield* compile(base, {}))).toEqual(expected("25"));
          const edited = base.pipe(remove(name));
          expect(
            yield* Effect.flip(compile(edited, { [group]: { limit: 123 } })),
          ).toBeInstanceOf(Schema.SchemaError);
        }),
    );
  }

  it("checks endpoint names and symbols in every alternative without invoking inherited getters", () => {
    const marker = Symbol("endpoint");
    const Later = Schema.Struct({
      [marker]: Schema.optionalKey(Schema.Unknown),
    });
    const { candidates } = Shapes.bind(
      Schema.Union([Renamed, Later]),
      (name) => name,
    );
    const edits = new Set(["page_size"]);
    expect(candidates({}, edits)).toEqual(["page_size"]);
    expect(candidates(Object.create(null), edits)).toEqual(["page_size"]);
    const withToString = Shapes.bind(
      Schema.Union([
        Renamed,
        Schema.Struct({ toString: Schema.optionalKey(Schema.String) }),
      ]),
      (name) => name,
    );
    expect(withToString.candidates({}, edits)).toEqual([]);
    expect(withToString.candidates(Object.create(null), edits)).toEqual([
      "page_size",
    ]);
    expect(candidates({}, new Set([String(marker)]))).toEqual([]);
    let reads = 0;
    // oxlint-disable-next-line no-extend-native -- Verify an inherited endpoint symbol, then restore it.
    Object.defineProperty(Object.prototype, marker, {
      configurable: true,
      get: () => {
        reads++;
        return undefined;
      },
    });
    try {
      expect(candidates({}, edits)).toEqual([]);
    } finally {
      Reflect.deleteProperty(Object.prototype, marker);
    }
    expect(reads).toBe(0);
  });

  it("uses descriptors for same-name omission and actual enumerable output", () => {
    const union = Schema.Union([Base, Alternative]);
    const shared = Schema.make<typeof union>(
      new SchemaAST.Union([Base.ast, Base.ast, Alternative.ast]),
    );
    const { candidates, filled } = Shapes.bind(shared, (name) => name);
    const edits = new Set(["limit"]);
    expect(candidates({ other: "x" }, edits)).toEqual(["limit"]);
    expect(candidates({ limit: undefined }, edits)).toEqual(["limit"]);
    expect(candidates(Object.create({ limit: undefined }), edits)).toEqual([]);
    let reads = 0;
    const accessor = Object.defineProperty({}, "limit", {
      enumerable: true,
      get: () => {
        reads++;
        return undefined;
      },
    });
    expect(candidates(accessor, edits)).toEqual([]);
    for (const output of [
      {},
      { limit: undefined },
      Object.create({ limit: "25" }),
      Object.defineProperty({}, "limit", { value: "25" }),
      accessor,
      {
        limit: "25",
        [Symbol.iterator]: () => {
          throw new Error("iterator evaluated");
        },
      },
    ])
      expect(filled(["limit"], output)).toEqual([]);
    expect(filled(["limit"], { limit: "25" })).toEqual(["limit"]);
    expect(reads).toBe(0);
  });

  it.effect(
    "allows field-level codecs and opaque values in otherwise closed unions",
    () =>
      Effect.gen(function* () {
        const opaque = "opaque-value";
        const schema = Schema.Union([
          Schema.Struct({
            limit: Base.fields.limit,
            other: Schema.optionalKey(
              Schema.declare(
                (value): value is typeof opaque => value === opaque,
              ),
            ),
          }),
          Alternative,
        ]);
        const request = Request.get("/x").pipe(
          Request.query(schema),
          Request.removeQuery("limit"),
        );
        expect(
          yield* Effect.flip(compile(request, { query: { other: opaque } })),
        ).toBeInstanceOf(Request.InvalidRequest);
      }),
  );

  for (const defect of [false, true]) {
    it.effect(
      `preserves union encoder failure behavior, defect ${defect}`,
      () =>
        Effect.gen(function* () {
          const boom = new Error("encoder defect");
          const limit = Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.String, {
              decode: SchemaGetter.withDefault(Effect.succeed("25")),
              encode: SchemaGetter.transformEffect(() =>
                defect
                  ? Effect.die(boom)
                  : Effect.fail(
                      new SchemaIssue.InvalidValue({
                        message: "encoder failed",
                      }),
                    ),
              ),
            }),
          );
          const schema = Schema.Union([Schema.Struct({ limit }), Alternative]);
          const base = Request.get("/x").pipe(Request.query(schema));
          for (const request of [
            base,
            base.pipe(Request.removeQuery("limit")),
          ]) {
            const exit = yield* Effect.exit(compile(request, {}));
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              if (defect) expect(error).toBe(boom);
              else expect(error).toBeInstanceOf(Schema.SchemaError);
            }
          }
        }),
    );
  }
});
