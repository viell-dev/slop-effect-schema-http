import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { encodedInput } from "./internal/encoded-input.js";
import * as Excess from "./internal/excess.js";
import * as Inputs from "./internal/input.js";
import * as Request from "./Request.js";
import type * as Transport from "./Transport.js";

type Checked = Request.Request<
  never,
  Schema.SchemaError | Request.InvalidRequest
>;
const compile = (request: Checked, input: unknown) =>
  Request.compile(request, input as never);

const Base = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  term: Schema.optionalKey(Schema.String),
});
const Renamed = Base.pipe(
  Schema.encodeKeys({ limit: "page_size", term: "search_term" }),
);
const Cursor = Schema.Struct({ cursor: Schema.String });

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("encoded input beside constructor defaults", () => {
  for (const group of ["query", "headers"] as const) {
    const bind =
      <
        S extends Schema.Top &
          Schema.ConstraintCodec<unknown, Transport.HeaderInput, never, never>,
      >(
        schema: S,
      ) =>
      (request: Checked): Checked =>
        group === "query"
          ? request.pipe(Request.query(schema))
          : request.pipe(Request.headers(schema));
    const output = (result: Request.Compiled) =>
      group === "query" ? result.request.url : result.headerLines;
    const expected = (value: string) =>
      group === "query" ? `/x?page_size=${value}` : [["page_size", value]];

    for (const [name, schema] of [
      ["direct", Renamed],
      ["singleton", Schema.Union([Renamed])],
      ["union", Schema.Union([Renamed, Cursor])],
      ["reversed", Schema.Union([Cursor, Renamed])],
    ] as const) {
      it.effect(`refuses invalid encoded ${group} values in ${name}`, () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(bind(schema));
          for (const value of ["many", null])
            for (const input of [
              { page_size: value },
              Object.assign(Object.create(null), { page_size: value }),
            ]) {
              const error = yield* Effect.flip(
                compile(request, { [group]: input }),
              );
              expect(error).toBeInstanceOf(Schema.SchemaError);
              expect(error.message).toContain('["page_size"]');
              expect(error.message).not.toContain("many");
            }
        }),
      );
    }

    it.effect(
      `preserves valid ${group} values, omission and alias precedence`,
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(bind(Renamed));
          for (const input of [
            { page_size: "05" },
            { page_size: "05", unknown: "ignored" },
            { limit: 5 },
            { limit: 5, page_size: "many" },
          ])
            expect(output(yield* compile(request, { [group]: input }))).toEqual(
              expected("5"),
            );
          for (const input of [
            {},
            { limit: undefined },
            { page_size: undefined },
          ])
            expect(output(yield* compile(request, { [group]: input }))).toEqual(
              expected("25"),
            );
          for (const input of [
            { limit: Number.NaN },
            { limit: 5, search_term: "x" },
          ])
            expect(
              yield* Effect.flip(compile(request, { [group]: input })),
            ).toBeInstanceOf(Schema.SchemaError);
        }),
    );

    it.effect(
      `decodes the whole ${group} value while a sibling keeps its field`,
      () =>
        Effect.gen(function* () {
          for (const bindings of [
            [bind(Schema.Union([Renamed, Cursor])), bind(Cursor)],
            [bind(Cursor), bind(Schema.Union([Renamed, Cursor]))],
          ]) {
            const request = bindings.reduce(
              (current, binding) => binding(current),
              Request.get("/x") as Checked,
            );
            const result = output(
              yield* compile(request, {
                [group]: { page_size: "05", cursor: "next" },
              }),
            );
            if (group === "query") {
              expect(String(result)).toContain("page_size=5");
              expect(String(result)).toContain("cursor=next");
            } else
              expect(result).toEqual(
                expect.arrayContaining([
                  ["page_size", "5"],
                  ["cursor", "next"],
                ]),
              );
            expect(
              yield* Effect.flip(
                compile(request, {
                  [group]: { page_size: "many", cursor: "next" },
                }),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
          }
        }),
    );
  }

  it.effect("requires the whole encoded side beside same-name codecs", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        ...Base.fields,
        count: Schema.FiniteFromString,
        shared: Schema.StringFromBase64,
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const request = Request.get("/x").pipe(Request.query(schema));
      expect(
        (yield* compile(request, {
          query: { page_size: "05", count: "07", shared: "eA==" },
        })).request.url,
      ).toBe("/x?page_size=5&count=7&shared=eA%3D%3D");
      expect(
        yield* Effect.flip(
          compile(request, {
            query: { page_size: "05", count: 7, shared: "eA==" },
          }),
        ),
      ).toBeInstanceOf(Schema.SchemaError);
      expect(
        (yield* compile(request, {
          query: { limit: 5, count: "07", shared: "eA==" },
        })).request.url,
      ).toBe("/x?page_size=5&count=7&shared=ZUE9PQ%3D%3D");
    }),
  );

  it.effect(
    "leaves successful constructor, decoder and default traces unchanged",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const shared = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: (value) => {
                trace.push("decode");
                return value;
              },
              encode: (value) => {
                trace.push("encode");
                return value;
              },
            }),
          ),
        );
        const schema = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                trace.push("default");
                return 25;
              }),
            ),
          ),
          shared: Schema.optionalKey(shared),
        })
          .pipe(Schema.encodeKeys({ limit: "page_size" }))
          .check(
            Schema.makeFilter(() => {
              trace.push("parent");
              return true;
            }),
          );
        const request = Request.get("/x").pipe(Request.query(schema));
        for (const [input, expected] of [
          [{}, ["default", "parent", "parent"]],
          [{ page_size: undefined }, ["default", "parent", "parent"]],
          [{ limit: 5, shared: "x" }, ["parent", "encode", "parent"]],
          [
            { page_size: "05", shared: "x", unknown: "ignored" },
            ["decode", "parent", "encode", "parent"],
          ],
        ] as const) {
          trace.length = 0;
          yield* compile(request, { query: input });
          expect(trace).toEqual(expected);
        }
        trace.length = 0;
        yield* Effect.flip(compile(request, { query: { page_size: "many" } }));
        expect(trace).toEqual(["default", "parent", "parent"]);
      }),
  );

  it.effect(
    "keeps strict writer failure fallback separate from read failure",
    () =>
      Effect.gen(function* () {
        const failure = new Schema.SchemaError(
          new SchemaIssue.InvalidValue({ message: "strict writer failed" }),
        );
        for (const input of [
          { page_size: "05" },
          { page_size: "05", unknown: "ignored" },
        ]) {
          const writes: string[] = [];
          const read = Inputs.reader(Renamed, (value, options) => {
            writes.push(`${options ? "strict" : "ordinary"}:${value.limit}`);
            return options
              ? Effect.fail(failure)
              : Schema.encodeEffect(Renamed)(value);
          });
          expect((yield* read(input)).output).toEqual({ page_size: "25" });
          expect(writes).toEqual(["strict:5", "strict:25", "ordinary:25"]);
        }
      }),
  );

  it.effect("keeps omitted default failures, defects and interruption", () =>
    Effect.gen(function* () {
      const boom = new Error("default defect");
      for (const mode of ["typed", "defect", "interrupt"] as const) {
        let calls = 0;
        const schema = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.suspend(() => {
                calls++;
                return mode === "typed"
                  ? Effect.fail(
                      new SchemaIssue.InvalidValue({
                        message: "default failed",
                      }),
                    )
                  : mode === "defect"
                    ? Effect.die(boom)
                    : Effect.interrupt;
              }),
            ),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const request = Request.get("/x").pipe(Request.query(schema));
        const result = yield* Effect.exit(compile(request, {}));
        expect(calls).toBe(1);
        if (mode === "typed")
          expect(result).toMatchObject({
            _tag: "Success",
            value: { request: { url: "/x" } },
          });
        else if (Exit.isFailure(result)) {
          if (mode === "defect") expect(Cause.squash(result.cause)).toBe(boom);
          else expect(Cause.hasInterrupts(result.cause)).toBe(true);
        } else expect.fail("The default must fail");
        calls = 0;
        const invalid = yield* Effect.exit(
          compile(request, { query: { page_size: "many" } }),
        );
        expect(Exit.isFailure(invalid)).toBe(true);
        if (Exit.isFailure(invalid)) {
          if (mode === "typed")
            expect(String(Cause.squash(invalid.cause))).toContain(
              "default failed",
            );
          else if (mode === "defect")
            expect(Cause.squash(invalid.cause)).toBe(boom);
          else expect(Cause.hasInterrupts(invalid.cause)).toBe(true);
        }
        expect(calls).toBe(mode === "typed" ? 2 : 1);
      }
    }),
  );

  it.effect(
    "retains the original strict refusal on typed decoder failure",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const shared = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (): Effect.Effect<string, SchemaIssue.Issue> =>
                Effect.suspend(() => {
                  calls++;
                  return Effect.fail(
                    new SchemaIssue.InvalidValue({ message: "decoder failed" }),
                  );
                }),
              encode: Effect.succeed,
            }),
          ),
        );
        const schema = Schema.Struct({ ...Base.fields, shared }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const input = { page_size: "05", shared: "x" };
        const original = yield* Effect.flip(
          Inputs.toDecoded(schema, Excess.strict)(input),
        );
        calls = 0;
        const error = yield* Effect.flip(
          Inputs.reader(schema, Schema.encodeEffect(schema))(input),
        );
        expect(error.message).toBe(original.message);
        expect(error.message).not.toContain("decoder failed");
        expect(calls).toBe(2);
      }),
  );

  for (const mode of ["defect", "interrupt"] as const) {
    it.effect(`propagates ${mode} from the new whole decoder attempt`, () =>
      Effect.gen(function* () {
        let calls = 0;
        const boom = new Error("decoder defect");
        const shared = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (): Effect.Effect<string> =>
                Effect.suspend(() => {
                  calls++;
                  return mode === "defect"
                    ? Effect.die(boom)
                    : Effect.interrupt;
                }),
              encode: Effect.succeed,
            }),
          ),
        );
        const renamed = Schema.Struct({ ...Base.fields, shared }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const schema = Schema.Union([renamed, Cursor]);
        const result = yield* Effect.exit(
          Inputs.reader(
            schema,
            Schema.encodeEffect(schema),
          )({
            page_size: "05",
            shared: "x",
            cursor: "next",
          }),
        );
        expect(calls).toBe(1);
        if (Exit.isFailure(result)) {
          if (mode === "defect") expect(Cause.squash(result.cause)).toBe(boom);
          else expect(Cause.hasInterrupts(result.cause)).toBe(true);
        } else expect.fail("The decoder must fail");
      }),
    );
  }

  it.effect(
    "keeps decoder services isolated for concurrent fallback reads",
    () =>
      Effect.gen(function* () {
        class Tenant extends Context.Service<Tenant, string>()(
          "encoded-default/Tenant",
        ) {}
        const shared = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (value) =>
                Effect.gen(function* () {
                  const tenant = yield* Tenant;
                  yield* Effect.promise(() => Promise.resolve());
                  return `${value}-${tenant}`;
                }),
              encode: Effect.succeed,
            }),
          ),
        );
        const renamed = Schema.Struct({ ...Base.fields, shared }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const schema = Schema.Union([renamed, Cursor]);
        const request = Request.get("/x").pipe(
          Request.query(schema),
          Request.query(Cursor),
        );
        const results = yield* Effect.all(
          ["one", "two"].map((tenant) =>
            Request.compile(request, {
              query: { page_size: "05", shared: "x", cursor: "next" },
            }).pipe(Effect.provideService(Tenant, tenant)),
          ),
          { concurrency: "unbounded" },
        );
        expect(
          results.map(({ request: preparedRequest }) => preparedRequest.url),
        ).toEqual([
          "/x?page_size=5&shared=x-one&cursor=next",
          "/x?page_size=5&shared=x-two&cursor=next",
        ]);
      }),
  );

  it.effect("does not change the reading inside an opaque neighbor", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        ...Base.fields,
        opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const read = Inputs.reader(schema, Schema.encodeEffect(schema));
      const opaque = Option.some({ keep: "x", extra: "opaque" });
      expect((yield* read({ page_size: "05", opaque })).output).toEqual({
        page_size: "5",
        opaque: Option.some({ keep: "x" }),
      });
      expect(
        yield* Effect.flip(read({ page_size: "many", opaque })),
      ).toBeInstanceOf(Schema.SchemaError);
    }),
  );

  it.effect(
    "declines stale side evidence while an encoding Effect is pending",
    () =>
      Effect.gen(function* () {
        const input: { page_size: string; limit?: number } = {
          page_size: "many",
        };
        const pending = Inputs.reader(
          Renamed,
          Schema.encodeEffect(Renamed),
        )(input);
        input.limit = 5;
        expect((yield* pending).output).toEqual({ page_size: "5" });
      }),
  );

  it.effect(
    "refuses changed input during an asynchronous decoder attempt",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const shared = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (value) =>
                Effect.andThen(
                  Deferred.succeed(started, undefined),
                  Effect.as(Deferred.await(resume), value),
                ),
              encode: Effect.succeed,
            }),
          ),
        );
        const renamed = Schema.Struct({ ...Base.fields, shared }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const schema = Schema.Union([renamed, Cursor]);
        const input = { page_size: "05", shared: "x", cursor: "next" };
        let writes = 0;
        const read = Inputs.reader(schema, (value, options) => {
          writes++;
          return Schema.encodeEffect(schema)(value, options);
        });
        const fiber = yield* Effect.forkChild(Effect.result(read(input)));
        yield* Deferred.await(started);
        input.page_size = "07";
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(fiber);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.message).toContain('["page_size"]');
        expect(writes).toBe(1);
      }),
  );

  it.effect("refuses mutation by the fallback writer", () =>
    Effect.gen(function* () {
      const schema = Schema.Union([Renamed, Cursor]);
      const input = { page_size: "05", cursor: "next" };
      let writes = 0;
      const read = Inputs.reader(schema, (value, options) =>
        Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
          writes++;
          if (writes === 2) input.page_size = "07";
          return output;
        }),
      );
      expect((yield* Effect.flip(read(input))).message).toContain(
        '["page_size"]',
      );
      expect(writes).toBe(2);
    }),
  );

  it.effect("interrupts a suspended decoder and runs its cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const shared = Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transformEffect({
            decode: (): Effect.Effect<string> =>
              Effect.ensuring(
                Effect.andThen(
                  Deferred.succeed(started, undefined),
                  Effect.never,
                ),
                Deferred.succeed(released, undefined),
              ),
            encode: Effect.succeed,
          }),
        ),
      );
      const renamed = Schema.Struct({ ...Base.fields, shared }).pipe(
        Schema.encodeKeys({ limit: "page_size" }),
      );
      const schema = Schema.Union([renamed, Cursor]);
      const read = Inputs.reader(schema, Schema.encodeEffect(schema));
      const fiber = yield* read({
        page_size: "05",
        cursor: "next",
        shared: "x",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(released);
      const result = yield* Fiber.await(fiber);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.hasInterrupts(result.cause)).toBe(true);
    }),
  );

  it.effect("handles a closed union behind a root group transformation", () =>
    Effect.gen(function* () {
      const Wire = Schema.Union([
        Schema.Struct({
          page_size: Schema.optionalKey(Schema.FiniteFromString),
        }),
        Cursor,
      ]);
      const schema = Wire.pipe(
        Schema.decodeTo(
          Base,
          SchemaTransformation.transform({
            decode: (value) =>
              "page_size" in value && value.page_size !== undefined
                ? { limit: String(value.page_size) }
                : {},
            encode: ({ limit }) =>
              limit === undefined ? {} : { page_size: Number(limit) },
          }),
        ),
      );
      const request = Request.get("/x").pipe(Request.query(schema));
      expect(
        (yield* Request.compile(request, { query: { page_size: "05" } }))
          .request.url,
      ).toBe("/x?page_size=5");
      const error = yield* Effect.flip(
        Request.compile(request, { query: { page_size: "many" } }),
      );
      expect(error.message).toContain('["page_size"]');
    }),
  );

  it.effect(
    "validates encoded values under exact numeric and symbol names",
    () =>
      Effect.gen(function* () {
        const symbol = Symbol("encoded limit");
        for (const wireName of [1, symbol] as const) {
          const schema = Base.pipe(Schema.encodeKeys({ limit: wireName }));
          const read = Inputs.reader(schema, Schema.encodeEffect(schema));
          expect((yield* read({ [wireName]: "05" })).output[wireName]).toBe(
            "5",
          );
          expect(
            yield* Effect.flip(read({ [wireName]: "many" })),
          ).toBeInstanceOf(Schema.SchemaError);
        }
      }),
  );

  it.effect(
    "keeps constructor-selected sibling fields and their original losses",
    () =>
      Effect.gen(function* () {
        const A = Schema.Struct({ a: Schema.String }).pipe(
          Schema.encodeKeys({ a: "A" }),
        );
        const B = Schema.Struct({ b: Schema.String });
        const schema = Schema.Union([A, B]);
        const input = { A: "x", b: "y" };
        const read = Inputs.reader(schema, Schema.encodeEffect(schema));
        expect(yield* read(input)).toEqual({
          output: { b: "y" },
          lost: [["A"]],
        });
        const keeper = Schema.Struct({ A: Schema.String });
        for (const bindings of [
          [schema, keeper],
          [keeper, schema],
        ]) {
          const request = Request.get("/x").pipe(
            Request.query(bindings[0]!),
            Request.query(bindings[1]!),
          );
          const url = (yield* compile(request, { query: input })).request.url;
          expect(url).toContain("A=x");
          expect(url).toContain("b=y");
        }
        const error = yield* Effect.flip(
          Request.compile(
            Request.get("/x").pipe(Request.query(schema), Request.query(B)),
            { query: input },
          ),
        );
        expect(error.message).toContain('["A"]');
        expect(error.message).not.toContain('["b"]');
      }),
  );

  it.effect(
    "does not retry ordinary decoder successes after a failed constructor",
    () =>
      Effect.gen(function* () {
        let decodes = 0;
        let defaults = 0;
        const shared = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: (value) => {
                decodes++;
                return value;
              },
              encode: (value) => value,
            }),
          ),
        );
        const renamed = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.suspend(() => {
                defaults++;
                return Effect.fail(
                  new SchemaIssue.InvalidValue({
                    message: "constructor unavailable",
                  }),
                );
              }),
            ),
          ),
          shared,
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Union([renamed, Cursor]);
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({ page_size: "05", shared: "x", cursor: 5 } as never);
        expect(result).toEqual({
          output: { page_size: "5", shared: "x" },
          lost: [["cursor"]],
        });
        expect(decodes).toBe(1);
        expect(defaults).toBe(1);
      }),
  );

  it.effect(
    "does not retry decoding when its constructor observer defects",
    () =>
      Effect.gen(function* () {
        const boom = new Error("observer defect");
        const result = yield* Effect.exit(
          Inputs.toDecoded(Renamed)({ limit: 5 }, () => {
            throw boom;
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toBe(boom);
      }),
  );

  it.effect(
    "requires an enumerable own data write without consulting output accessors or iterators",
    () =>
      Effect.gen(function* () {
        let decodes = 0;
        let iterations = 0;
        const shared = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: (value) => {
                decodes++;
                return value;
              },
              encode: (value) => value,
            }),
          ),
        );
        const renamed = Schema.Struct({ ...Base.fields, shared }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const schema = Schema.Union([renamed, Cursor]);
        for (const output of [
          Object.defineProperty({ shared: "x" }, "page_size", { value: "25" }),
          Object.assign(Object.create({ page_size: "25" }), { shared: "x" }),
          Object.defineProperty({ shared: "x" }, "page_size", {
            enumerable: true,
            get: () => "25",
          }),
          { shared: "x", page_size: undefined },
          {
            shared: "x",
            page_size: "25",
            [Symbol.iterator]: function* () {
              iterations++;
              yield* [];
            },
          },
        ]) {
          decodes = 0;
          let writes = 0;
          const result = yield* Inputs.reader(schema, () => {
            writes++;
            return Effect.succeed(output);
          })({ page_size: "05", shared: "x", cursor: "next" });
          expect(result.output).toBe(output);
          expect(decodes).toBe(0);
          expect(writes).toBe(1);
        }
        expect(iterations).toBe(0);
        const evidence = encodedInput(Renamed.ast)!({ page_size: "many" })!;
        let reads = 0;
        expect(
          evidence.written(
            Object.defineProperty({}, "page_size", {
              enumerable: true,
              get: () => {
                reads++;
                return "25";
              },
            }),
          ),
        ).toBe(false);
        expect(reads).toBe(0);
        expect(evidence.written({ page_size: "25" })).toBe(true);
      }),
  );

  it("declines open, opaque, class, suspended, iterable and cyclic group graphs", () => {
    class Fields extends Schema.Class<Fields>("EncodedDefaultFields")({
      cursor: Schema.String,
    }) {}
    let suspended = 0;
    const later = Schema.suspend(() => {
      suspended++;
      return Cursor;
    });
    const cycle = new SchemaAST.Union([Renamed.ast]);
    Object.assign(cycle, { types: [Renamed.ast, cycle] });
    const openMiddle = Schema.Struct({
      wire: Schema.optionalKey(Schema.String),
    }).pipe(
      Schema.decodeTo(
        Schema.Record(Schema.String, Schema.String),
        SchemaTransformation.transform({
          decode: () => ({}),
          encode: () => ({}),
        }),
      ),
      Schema.decodeTo(
        Base,
        SchemaTransformation.transform({
          decode: () => ({}),
          encode: () => ({}),
        }),
      ),
    );
    for (const ast of [
      Schema.Union([Renamed, Schema.Record(Schema.String, Schema.String)]).ast,
      Schema.Union([
        Renamed,
        Schema.declare((value): value is object => typeof value === "object"),
      ]).ast,
      Schema.Union([Renamed, Fields]).ast,
      Schema.Union([Renamed, later]).ast,
      Schema.Union([
        Renamed,
        Schema.Struct({ [Symbol.iterator]: Schema.Unknown }),
      ]).ast,
      openMiddle.ast,
      cycle,
    ])
      expect(encodedInput(ast)).toBeUndefined();
    expect(suspended).toBe(0);
    const shared = Schema.Union([Renamed, Renamed]);
    expect(
      encodedInput(Schema.Union([shared, shared]).ast)?.({
        page_size: "many",
      })?.matches(),
    ).toBe(true);
  });

  it("uses global name ambiguity and exact symbol and numeric property keys", () => {
    const Native = Schema.Struct({
      page_size: Schema.optionalKey(Schema.String),
    });
    expect(
      encodedInput(Schema.Union([Renamed, Native]).ast)?.({
        page_size: "many",
      }),
    ).toBeUndefined();
    const exchanged = Native.pipe(Schema.encodeKeys({ page_size: "limit" }));
    expect(
      encodedInput(Schema.Union([Renamed, exchanged]).ast)?.({
        page_size: "many",
      }),
    ).toBeUndefined();
    const symbol = Symbol("wire");
    const other = Symbol("wire");
    const symbolic = Base.pipe(Schema.encodeKeys({ limit: symbol }));
    expect(encodedInput(symbolic.ast)?.({ [symbol]: "many" })?.matches()).toBe(
      true,
    );
    expect(encodedInput(symbolic.ast)?.({ [other]: "many" })).toBeUndefined();
    const numbered = Base.pipe(Schema.encodeKeys({ limit: 1 }));
    expect(encodedInput(numbered.ast)?.({ "1": "many" })?.matches()).toBe(true);
  });

  it("captures data without reading accessors or iterators and detects root mutations", () => {
    const capture = encodedInput(Renamed.ast)!;
    let reads = 0;
    const accessor = Object.defineProperty({}, "page_size", {
      get: () => {
        reads++;
        return "many";
      },
    });
    expect(capture(accessor)).toBeUndefined();
    expect(capture(Object.create({ page_size: "many" }))).toBeUndefined();
    expect(
      capture({
        page_size: "many",
        [Symbol.iterator]: () => {
          reads++;
          return [][Symbol.iterator]();
        },
      }),
    ).toBeUndefined();
    expect(reads).toBe(0);
    for (const change of [
      (input: Record<PropertyKey, unknown>) => {
        input.page_size = "05";
      },
      (input: Record<PropertyKey, unknown>) => {
        input.extra = "x";
      },
      (input: Record<PropertyKey, unknown>) => {
        Reflect.deleteProperty(input, "page_size");
      },
      (input: Record<PropertyKey, unknown>) => {
        Object.defineProperty(input, "page_size", { enumerable: false });
      },
      (input: Record<PropertyKey, unknown>) => {
        Object.setPrototypeOf(input, null);
      },
      (input: Record<PropertyKey, unknown>) => {
        Reflect.deleteProperty(input, "a");
        input.a = "x";
      },
    ]) {
      const input = { a: "x", page_size: "many" };
      const evidence = capture(input)!;
      expect(evidence.matches()).toBe(true);
      change(input);
      expect(evidence.matches()).toBe(false);
    }
  });
});
