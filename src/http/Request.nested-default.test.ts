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
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import type { HttpBody } from "effect/http";
import { empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
import { nestedEncodedInput } from "./internal/nested-input.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const Inner = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Direct = Schema.Struct({ filter: Inner });
const Deeper = Schema.Struct({ wrapper: Direct });
const ChildUnion = Schema.Struct({
  filter: Schema.Union([Inner, Schema.Struct({ cursor: Schema.String })]),
});
const Optional = Schema.Struct({ filter: Schema.optionalKey(Inner) });

const prepare = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  kind: "path" | "body",
) => {
  if (kind === "path") {
    let output: unknown;
    const request = Request.get("/x").pipe(
      Request.path(schema, (value) => {
        output = value;
        return "/rendered";
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
      if (request.body._tag !== "Uint8Array")
        throw new Error("Expected JSON bytes");
      return JSON.parse(new TextDecoder().decode(request.body.body)) as unknown;
    }),
  );
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("nested aliases replaced during whole construction", () => {
  const shapes = [
    { name: "direct", schema: Direct, wrap: (filter: object) => ({ filter }) },
    {
      name: "deeper",
      schema: Deeper,
      wrap: (filter: object) => ({ wrapper: { filter } }),
    },
    {
      name: "terminal union",
      schema: ChildUnion,
      wrap: (filter: object) => ({ filter }),
    },
    {
      name: "optional field",
      schema: Optional,
      wrap: (filter: object) => ({ filter }),
    },
  ] as const;
  for (const kind of ["path", "body"] as const) {
    for (const { name, schema, wrap } of shapes) {
      it.effect(`refuses a ${name} invalid nested ${kind} alias`, () =>
        Effect.gen(function* () {
          for (const page_size of ["many", null]) {
            const error = yield* Effect.flip(
              prepare(schema, wrap({ page_size }), kind),
            );
            expect(error).toBeInstanceOf(Schema.SchemaError);
            expect(error.message).toContain('["filter"]["page_size"]');
            expect(error.message).not.toContain("many");
          }
        }),
      );
    }
    it.effect(
      `keeps valid nested ${kind} sides, omission and both-alias precedence`,
      () =>
        Effect.gen(function* () {
          for (const { schema, wrap } of shapes) {
            for (const filter of [
              { page_size: "05" },
              { limit: 5 },
              { limit: 5, page_size: "many" },
            ])
              expect(yield* prepare(schema, wrap(filter), kind)).toEqual(
                wrap({ page_size: "5" }),
              );
            for (const filter of [{}, { page_size: undefined }])
              expect(yield* prepare(schema, wrap(filter), kind)).toEqual(
                wrap({ page_size: "25" }),
              );
          }
          expect(yield* prepare(Optional, {}, kind)).toEqual({});
          expect(yield* prepare(Optional, { filter: undefined }, kind)).toEqual(
            {},
          );
        }),
    );
  }

  it.effect(
    "keeps a root fieldwise route that actually decodes the nested alias",
    () =>
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
        const schema = Schema.Struct({
          filter,
          n: Schema.FiniteFromString,
          m: Schema.FiniteFromString,
          shared: Schema.StringFromBase64,
          opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
        });
        const input = {
          filter: { page_size: "05", gate: "03" },
          n: "07",
          m: 9,
          shared: "eA==",
          opaque: Option.some({ keep: "x", extra: "opaque" }),
        };
        const strict = yield* Effect.result(
          Inputs.toDecoded(schema, { onExcessProperty: "error" })(input),
        );
        expect(strict._tag).toBe("Failure");
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
        expect(defaults).toBe(2);
      }),
  );

  it.effect(
    "does not combine stale-written and stable-unwritten candidates",
    () =>
      Effect.gen(function* () {
        const input = {
          left: { page_size: "many" },
          right: { page_size: "many" },
        };
        const finite = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (text) =>
                Number.isFinite(Number(text))
                  ? Effect.succeed(Number(text))
                  : Effect.fail(
                      new SchemaIssue.InvalidValue({ message: "finite" }),
                    ),
              encode: (value) =>
                Effect.sync(() => {
                  input.left.page_size = "05";
                  return String(value);
                }),
            }),
          ),
        );
        const left = Schema.Struct({
          limit: Schema.optionalKey(finite).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const right = Schema.optionalKey(Inner).pipe(
          Schema.decodeTo(Schema.optionalKey(Inner), {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.omit(),
          }),
        );
        const schema = Schema.Struct({ left, right });
        const evidence = nestedEncodedInput(schema.ast)!(input)!;
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )(input);
        expect(result.output).toEqual({ left: { page_size: "25" } });
        expect(result.lost).toEqual([["right", "page_size"]]);
        expect(evidence.select(result.output)).toBeUndefined();
      }),
  );

  it.effect("keeps the selected path fixed when decoding makes it stale", () =>
    Effect.gen(function* () {
      const input = {
        left: { page_size: "05" },
        right: { page_size: "05" },
        opaque: Option.some({ keep: "x", extra: "opaque" }),
      };
      let writes = 0;
      const finite = Schema.FiniteFromString.pipe(
        Schema.decodeTo(
          Schema.Number,
          SchemaTransformation.transformEffect({
            decode: (value) =>
              Effect.sync(() => {
                if (writes > 0) input.left.page_size = "06";
                return value;
              }),
            encode: (value) => Effect.succeed(value),
          }),
        ),
      );
      const left = Schema.Struct({
        limit: Schema.optionalKey(finite).pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const schema = Schema.Struct({
        left,
        right: Inner,
        opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
      });
      const read = Inputs.reader(schema, (value, options) =>
        Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
          writes++;
          return output;
        }),
      );
      expect((yield* Effect.flip(read(input))).message).toContain(
        '["left"]["page_size"]',
      );
      expect(writes).toBe(1);
      expect(input.right.page_size).toBe("05");
    }),
  );

  it.effect(
    "keeps valid additional decoding and parent checks without reconstructing values",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const schema = Schema.Struct({
          filter: Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  trace.push("default");
                  return 25;
                }),
              ),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" })),
          shared: Schema.StringFromBase64,
          opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
        }).check(
          Schema.makeFilter(() => {
            trace.push("parent");
            return true;
          }),
        );
        const input = {
          filter: { page_size: "05" },
          shared: "eA==",
          opaque: Option.some({ keep: "x", extra: "opaque" }),
        };
        expect(
          (yield* Inputs.reader(schema, Schema.encodeEffect(schema))(input))
            .output,
        ).toEqual({
          filter: { page_size: "5" },
          shared: "eA==",
          opaque: Option.some({ keep: "x" }),
        });
        expect(trace.filter((value) => value === "default")).toHaveLength(1);
        expect(trace.filter((value) => value === "parent")).toHaveLength(4);
      }),
  );

  it.effect(
    "preserves constructor failures, defects, interruption and strict writer fallback",
    () =>
      Effect.gen(function* () {
        const boom = new Error("default defect");
        for (const mode of ["typed", "defect", "interrupt"] as const) {
          let defaults = 0;
          const filter = Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(
                Effect.suspend(() => {
                  defaults++;
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
          const schema = Schema.Struct({ filter });
          const result = yield* Effect.exit(
            Inputs.reader(
              schema,
              Schema.encodeEffect(schema),
            )({ filter: { page_size: "many" } }),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            if (mode === "typed")
              expect(String(Cause.squash(result.cause))).toContain(
                "default failed",
              );
            else if (mode === "defect")
              expect(Cause.squash(result.cause)).toBe(boom);
            else expect(Cause.hasInterrupts(result.cause)).toBe(true);
          }
          expect(defaults).toBe(mode === "typed" ? 3 : 1);
        }
        const failure = new Schema.SchemaError(
          new SchemaIssue.InvalidValue({ message: "strict writer failed" }),
        );
        const writes: string[] = [];
        const read = Inputs.reader(Direct, (value, options) => {
          writes.push(options ? "strict" : "ordinary");
          return options
            ? Effect.fail(failure)
            : Schema.encodeEffect(Direct)(value);
        });
        expect((yield* read({ filter: { page_size: "many" } })).output).toEqual(
          { filter: { page_size: "25" } },
        );
        expect(writes).toEqual(["strict", "ordinary"]);
      }),
  );

  for (const mode of ["defect", "interrupt"] as const) {
    it.effect(`propagates ${mode} in additional whole decoding`, () =>
      Effect.gen(function* () {
        const boom = new Error("decoder defect");
        let writes = 0;
        const finite = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (): Effect.Effect<number, SchemaIssue.Issue> =>
                writes === 0
                  ? Effect.fail(
                      new SchemaIssue.InvalidValue({ message: "not yet" }),
                    )
                  : mode === "defect"
                    ? Effect.die(boom)
                    : Effect.interrupt,
              encode: (value) => Effect.succeed(String(value)),
            }),
          ),
        );
        const filter = Schema.Struct({
          limit: Schema.optionalKey(finite).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Struct({ filter });
        const read = Inputs.reader(schema, (value, options) =>
          Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
            writes++;
            return output;
          }),
        );
        const result = yield* Effect.exit(
          read({ filter: { page_size: "many" } }),
        );
        expect(writes).toBe(1);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          if (mode === "defect") expect(Cause.squash(result.cause)).toBe(boom);
          else expect(Cause.hasInterrupts(result.cause)).toBe(true);
        }
      }),
    );
  }

  it.effect(
    "isolates services and witnesses across repeated and concurrent evaluations",
    () =>
      Effect.gen(function* () {
        class Tenant extends Context.Service<Tenant, string>()(
          "nested/Tenant",
        ) {}
        const trace: string[] = [];
        const finite = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (text) =>
                Effect.flatMap(Tenant, (tenant) => {
                  trace.push("decode:" + tenant);
                  return Number.isFinite(Number(text))
                    ? Effect.succeed(Number(text))
                    : Effect.fail(
                        new SchemaIssue.InvalidValue({ message: "finite" }),
                      );
                }),
              encode: (value) =>
                Effect.flatMap(Tenant, (tenant) => {
                  trace.push("encode:" + tenant);
                  return tenant === "bad"
                    ? Effect.fail(
                        new SchemaIssue.InvalidValue({
                          message: "writer failed",
                        }),
                      )
                    : Effect.succeed(String(value));
                }),
            }),
          ),
        );
        const schema = Schema.Struct({
          filter: Schema.Struct({
            limit: Schema.optionalKey(finite).pipe(
              Schema.withConstructorDefault(Effect.succeed(25)),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" })),
        });
        const pending = Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({ filter: { page_size: "many" } });
        const results = yield* Effect.all(
          ["one", "bad", "two"].map((tenant) =>
            Effect.result(pending).pipe(Effect.provideService(Tenant, tenant)),
          ),
          { concurrency: "unbounded" },
        );
        for (const [index, result] of results.entries()) {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.message).toContain(
              index === 1 ? "writer failed" : '["filter"]["page_size"]',
            );
        }
        expect(trace.filter((value) => value === "encode:one")).toHaveLength(1);
        expect(trace.filter((value) => value === "encode:bad")).toHaveLength(2);
        expect(
          (yield* Effect.flip(
            pending.pipe(Effect.provideService(Tenant, "one")),
          )).message,
        ).toContain('["filter"]["page_size"]');
        expect(trace.filter((value) => value === "encode:one")).toHaveLength(2);
      }),
  );

  it.effect("keeps valid strict successes and their callback traces", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const schema = Direct.check(
        Schema.makeFilter(() => {
          trace.push("parent");
          return true;
        }),
      );
      const read = Inputs.reader(schema, Schema.encodeEffect(schema));
      for (const input of [
        { filter: { page_size: "05" } },
        { filter: { limit: 5 } },
      ]) {
        trace.length = 0;
        expect((yield* read(input)).output).toEqual({
          filter: { page_size: "5" },
        });
        expect(trace).toEqual(["parent", "parent"]);
      }
    }),
  );

  it.effect(
    "declines stale ancestor and terminal evidence while an Effect is pending",
    () =>
      Effect.gen(function* () {
        for (const change of [
          (input: { filter: { page_size: string } }) => {
            input.filter = { page_size: "many" };
          },
          (input: { filter: { page_size: string } }) => {
            Object.defineProperty(input, "filter", { writable: false });
          },
          (input: { filter: { page_size: string } }) => {
            Object.setPrototypeOf(input, null);
          },
          (input: { filter: { page_size: string } }) => {
            input.filter.page_size = "still invalid";
          },
          (input: { filter: { page_size: string } }) => {
            Object.defineProperty(input.filter, "page_size", {
              writable: false,
            });
          },
          (input: { filter: { page_size: string } }) => {
            Object.setPrototypeOf(input.filter, null);
          },
        ]) {
          const input = { filter: { page_size: "many" } };
          const pending = Inputs.reader(
            Direct,
            Schema.encodeEffect(Direct),
          )(input);
          change(input);
          expect((yield* pending).output).toEqual({
            filter: { page_size: "25" },
          });
        }
      }),
  );

  it.effect(
    "declines mutations made during original construction or writing",
    () =>
      Effect.gen(function* () {
        for (const stage of ["constructor", "writer"] as const) {
          const input = { filter: { page_size: "many" } };
          const filter = Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  if (stage === "constructor")
                    input.filter.page_size = "changed";
                  return 25;
                }),
              ),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const schema = Schema.Struct({ filter });
          let writes = 0;
          const read = Inputs.reader(schema, (value, options) =>
            Effect.map(
              Schema.encodeEffect(schema)(value, options),
              (output) => {
                writes++;
                if (stage === "writer") input.filter = { page_size: "many" };
                return output;
              },
            ),
          );
          expect((yield* read(input)).output).toEqual({
            filter: { page_size: "25" },
          });
          expect(writes).toBe(1);
        }
      }),
  );

  it("captures frozen, null-prototype and nonenumerable data without reading accessors", () => {
    const capture = nestedEncodedInput(Direct.ast)!;
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
        capture(input)
          ?.select({ filter: { page_size: "25" } })
          ?.matches(),
      ).toBe(true);
    let reads = 0;
    expect(
      capture(
        Object.defineProperty({}, "filter", {
          get: () => {
            reads++;
            return { page_size: "many" };
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      capture({
        filter: Object.defineProperty({}, "page_size", {
          get: () => {
            reads++;
            return "many";
          },
        }),
      }),
    ).toBeUndefined();
    expect(
      capture(Object.create({ filter: { page_size: "many" } })),
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("does not qualify inherited, accessor, nonenumerable or iterable output links", () => {
    const evidence = nestedEncodedInput(Direct.ast)!({
      filter: { page_size: "many" },
    })!;
    let reads = 0;
    for (const output of [
      Object.create({ filter: { page_size: "25" } }),
      Object.defineProperty({}, "filter", { value: { page_size: "25" } }),
      Object.defineProperty({}, "filter", {
        enumerable: true,
        get: () => {
          reads++;
          return { page_size: "25" };
        },
      }),
      {
        filter: { page_size: "25" },
        [Symbol.iterator]: () => {
          reads++;
          return [][Symbol.iterator]();
        },
      },
    ])
      expect(evidence.select(output)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("retains ancestor identities, descriptors, prototypes and all terminal keys", () => {
    for (const change of [
      (input: { filter: Record<string, unknown> }) => {
        input.filter = { page_size: "many" };
      },
      (input: { filter: Record<string, unknown> }) => {
        Object.defineProperty(input, "filter", { enumerable: false });
      },
      (input: { filter: Record<string, unknown> }) => {
        Object.setPrototypeOf(input, null);
      },
      (input: { filter: Record<string, unknown> }) => {
        input.filter.page_size = "changed";
      },
      (input: { filter: Record<string, unknown> }) => {
        input.filter.extra = "changed";
      },
      (input: { filter: Record<string, unknown> }) => {
        Object.setPrototypeOf(input.filter, null);
      },
    ]) {
      const input = { filter: { page_size: "many" } };
      const selected = nestedEncodedInput(Direct.ast)!(input)!.select({
        filter: { page_size: "25" },
      })!;
      expect(selected.matches()).toBe(true);
      change(input);
      expect(selected.matches()).toBe(false);
    }
  });

  it("does not traverse transformed, open, declared or suspended ancestors", () => {
    class Wrapped extends Schema.Class<Wrapped>("NestedAncestor")({
      filter: Inner,
    }) {}
    let thunks = 0;
    const suspended = Schema.suspend(() => {
      thunks++;
      return Direct;
    });
    for (const schema of [
      Direct.pipe(Schema.encodeKeys({ filter: "q" })),
      Wrapped,
      suspended,
      Schema.StructWithRest(Direct, [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ])
      expect(nestedEncodedInput(schema.ast)).toBeUndefined();
    expect(thunks).toBe(0);
    expect(
      nestedEncodedInput(Schema.Struct({ filter: Schema.Option(Inner) }).ast),
    ).toBeUndefined();
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "refuses invalid nested input through an unambiguous parent union",
    () =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            prepare(
              Schema.Union([Direct, Schema.Struct({ cursor: Schema.String })]),
              { filter: { page_size: "many" } },
              "body",
            ),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses invalid nested input through a dense array ancestor", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          prepare(
            Schema.Struct({ filters: Schema.Array(Inner) }),
            { filters: [{ page_size: "many" }] },
            "body",
          ),
        ),
      ).toBeInstanceOf(Schema.SchemaError);
    }),
  );

  it("reuses metadata DAGs and shared inputs without copying cyclic extras", () => {
    const schema = Schema.Struct({ left: Direct, right: Direct });
    const filter: Record<string, unknown> = { page_size: "many" };
    filter.self = filter;
    const shared = { filter };
    const capture = nestedEncodedInput(schema.ast)!({
      left: shared,
      right: shared,
    })!;
    const selected = capture.select({
      left: { filter: { page_size: "25" } },
      right: { filter: { page_size: "25" } },
    })!;
    expect(selected.matches()).toBe(true);
    filter.page_size = "05";
    expect(selected.matches()).toBe(false);
    const cyclic = new SchemaAST.Objects(
      [new SchemaAST.PropertySignature("filter", Inner.ast)],
      [],
    );
    Object.assign(cyclic, {
      propertySignatures: [
        ...cyclic.propertySignatures,
        new SchemaAST.PropertySignature("self", cyclic),
      ],
    });
    expect(nestedEncodedInput(cyclic)).toBeUndefined();
  });

  it.effect(
    "invalidates caller changes but permits obsolete output mutation during suspended decoding",
    () =>
      Effect.gen(function* () {
        for (const mode of [
          "none",
          "ancestor",
          "ancestor-descriptor",
          "ancestor-prototype",
          "terminal",
          "output-ancestor",
          "output-descriptor",
          "output-terminal",
        ] as const) {
          const started = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let writes = 0;
          let initialOutput:
            { filter: { page_size?: string | undefined } } | undefined;
          const input = { filter: { page_size: "05" } };
          const finite = Schema.String.pipe(
            Schema.decodeTo(
              Schema.Number,
              SchemaTransformation.transformEffect({
                decode: (text) =>
                  writes === 0
                    ? Effect.fail(
                        new SchemaIssue.InvalidValue({ message: "not yet" }),
                      )
                    : Effect.gen(function* () {
                        yield* Deferred.succeed(started, undefined);
                        yield* Deferred.await(resume);
                        return Number(text);
                      }),
                encode: (value) => Effect.succeed(String(value)),
              }),
            ),
          );
          const schema = Schema.Struct({
            filter: Schema.Struct({
              limit: Schema.optionalKey(finite).pipe(
                Schema.withConstructorDefault(Effect.succeed(25)),
              ),
            }).pipe(Schema.encodeKeys({ limit: "page_size" })),
          });
          const read = Inputs.reader(schema, (value, options) =>
            Effect.map(
              Schema.encodeEffect(schema)(value, options),
              (output) => {
                writes++;
                initialOutput ??= output;
                return output;
              },
            ),
          );
          const fiber = yield* Effect.result(read(input)).pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          if (mode === "ancestor") input.filter = { page_size: "05" };
          if (mode === "ancestor-descriptor")
            Object.defineProperty(input, "filter", { enumerable: false });
          if (mode === "ancestor-prototype") Object.setPrototypeOf(input, null);
          if (mode === "terminal") Object.setPrototypeOf(input.filter, null);
          if (mode === "output-ancestor")
            initialOutput!.filter = { page_size: "25" };
          if (mode === "output-descriptor")
            Object.defineProperty(initialOutput!, "filter", {
              enumerable: false,
            });
          if (mode === "output-terminal")
            initialOutput!.filter.page_size = "26";
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(fiber);
          if (mode === "none" || mode.startsWith("output-")) {
            expect(result).toMatchObject({
              _tag: "Success",
              success: { output: { filter: { page_size: "5" } } },
            });
            expect(writes).toBe(2);
            expect(input.filter).toEqual({ page_size: "05" });
          } else {
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure.message).toContain(
                '["filter"]["page_size"]',
              );
            expect(writes).toBe(1);
          }
        }
      }),
  );

  it.effect("rechecks the ancestor link after the additional writer", () =>
    Effect.gen(function* () {
      let writes = 0;
      const input = { filter: { page_size: "05" } };
      const finite = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Number,
          SchemaTransformation.transformEffect({
            decode: (text) =>
              writes === 0
                ? Effect.fail(
                    new SchemaIssue.InvalidValue({ message: "not yet" }),
                  )
                : Effect.succeed(Number(text)),
            encode: (value) => Effect.succeed(String(value)),
          }),
        ),
      );
      const schema = Schema.Struct({
        filter: Schema.Struct({
          limit: Schema.optionalKey(finite).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" })),
      });
      const read = Inputs.reader(schema, (value, options) =>
        Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
          if (++writes === 2) input.filter = { page_size: "05" };
          return output;
        }),
      );
      expect((yield* Effect.flip(read(input))).message).toContain(
        '["filter"]["page_size"]',
      );
      expect(writes).toBe(2);
    }),
  );

  it.effect("interrupts additional decoding and runs its cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let writes = 0;
      const finite = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Number,
          SchemaTransformation.transformEffect({
            decode: (): Effect.Effect<number, SchemaIssue.Issue> =>
              writes === 0
                ? Effect.fail(
                    new SchemaIssue.InvalidValue({ message: "not yet" }),
                  )
                : Effect.ensuring(
                    Effect.andThen(
                      Deferred.succeed(started, undefined),
                      Effect.never,
                    ),
                    Deferred.succeed(released, undefined),
                  ),
            encode: (value) => Effect.succeed(String(value)),
          }),
        ),
      );
      const schema = Schema.Struct({
        filter: Schema.Struct({
          limit: Schema.optionalKey(finite).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" })),
      });
      const read = Inputs.reader(schema, (value, options) =>
        Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
          writes++;
          return output;
        }),
      );
      const fiber = yield* read({ filter: { page_size: "05" } }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(released);
      const result = yield* Fiber.await(fiber);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.hasInterrupts(result.cause)).toBe(true);
      expect(writes).toBe(1);
    }),
  );

  it("rejects input iterators without running them and binds numeric and symbol keys exactly", () => {
    let iterations = 0;
    const iterable = {
      [Symbol.iterator]: () => {
        iterations++;
        return [][Symbol.iterator]();
      },
    };
    expect(
      nestedEncodedInput(Direct.ast)!({
        filter: { page_size: "many" },
        ...iterable,
      }),
    ).toBeUndefined();
    expect(
      nestedEncodedInput(Direct.ast)!({
        filter: { page_size: "many", ...iterable },
      }),
    ).toBeUndefined();
    expect(iterations).toBe(0);
    const field = Symbol("field");
    const wire = Symbol("wire");
    const other = Symbol("wire");
    const terminal = Schema.Struct({
      limit: Schema.optionalKey(Schema.String),
    }).pipe(Schema.encodeKeys({ limit: wire }));
    const symbolic = Schema.Struct({ [field]: terminal });
    const captured = nestedEncodedInput(symbolic.ast)!({
      [field]: { [wire]: "value" },
    })!;
    expect(captured.select({ [field]: { [other]: "value" } })).toBeUndefined();
    expect(captured.select({ [field]: { [wire]: "value" } })?.key).toBe(wire);
    const numeric = Schema.Struct({ 1: Inner });
    expect(
      nestedEncodedInput(numeric.ast)!({ "1": { page_size: "many" } })
        ?.select({ "1": { page_size: "25" } })
        ?.matches(),
    ).toBe(true);
  });

  it("declines output-reflection changes to the selected ancestor", () => {
    const input = { filter: { page_size: "many" } };
    const evidence = nestedEncodedInput(Direct.ast)!(input)!;
    const output = new Proxy(
      { filter: { page_size: "25" } },
      {
        getOwnPropertyDescriptor(target, key) {
          input.filter = { page_size: "many" };
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(evidence.select(output)).toBeUndefined();
  });

  it("detects descendant reflection changing an earlier ancestor link, descriptor or prototype", () => {
    for (const change of [
      (input: { wrapper: { filter: { page_size: string } } }) => {
        input.wrapper = { filter: { page_size: "many" } };
      },
      (input: { wrapper: { filter: { page_size: string } } }) => {
        Object.defineProperty(input, "wrapper", { enumerable: false });
      },
      (input: { wrapper: { filter: { page_size: string } } }) => {
        Object.setPrototypeOf(input, null);
      },
    ]) {
      const input = { wrapper: { filter: { page_size: "many" } } };
      const evidence = nestedEncodedInput(Deeper.ast)!(input)!;
      const wrapper = new Proxy(
        { filter: { page_size: "25" } },
        {
          getOwnPropertyDescriptor(target, key) {
            change(input);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      expect(evidence.select({ wrapper })).toBeUndefined();
    }
  });

  it("declines terminal reflection that changes an earlier output link or descriptor", () => {
    for (const mode of ["link", "descriptor", "prototype"] as const) {
      const evidence = nestedEncodedInput(Deeper.ast)!({
        wrapper: { filter: { page_size: "many" } },
      })!;
      const output = { wrapper: { filter: {} as object } };
      output.wrapper.filter = new Proxy(
        { page_size: "25" },
        {
          getOwnPropertyDescriptor(target, key) {
            if (mode === "link") output.wrapper = { filter: {} };
            else if (mode === "descriptor")
              Object.defineProperty(output, "wrapper", { enumerable: false });
            else Object.setPrototypeOf(output, null);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      expect(evidence.select(output)).toBeUndefined();
    }
  });

  it("retains caller-only evidence after a coherent output path was selected", () => {
    for (const mode of ["link", "descriptor", "terminal"] as const) {
      const input = {
        wrapper: { filter: { page_size: "many" } },
      };
      const evidence = nestedEncodedInput(Deeper.ast)!(input)!;
      const output = { wrapper: { filter: { page_size: "25" } } };
      const selected = evidence.select(output)!;
      expect(selected.matches()).toBe(true);
      if (mode === "link") output.wrapper = { filter: { page_size: "25" } };
      else if (mode === "descriptor")
        Object.defineProperty(output.wrapper, "filter", { writable: false });
      else output.wrapper.filter.page_size = "26";
      expect(selected.matches()).toBe(true);
      input.wrapper.filter.page_size = "changed";
      expect(selected.matches()).toBe(false);
    }
  });

  it("revalidates long ancestor paths without repeated suffix work", () => {
    for (const depth of [32, 128]) {
      let ast: SchemaAST.AST = Inner.ast;
      let input: object = { page_size: "many" };
      let output: object = { page_size: "25" };
      let reflections = 0;
      let outputReflections = 0;
      for (let index = 0; index < depth; index++) {
        ast = new SchemaAST.Objects(
          [new SchemaAST.PropertySignature("child", ast)],
          [],
        );
        input = new Proxy(
          { child: input },
          {
            getOwnPropertyDescriptor(target, key) {
              reflections++;
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        );
        output = new Proxy(
          { child: output },
          {
            getOwnPropertyDescriptor(target, key) {
              outputReflections++;
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        );
      }
      const selected = nestedEncodedInput(ast)!(input)!.select(output)!;
      expect(selected.matches()).toBe(true);
      expect(reflections).toBeLessThanOrEqual(depth * 5);
      expect(outputReflections).toBeLessThanOrEqual(depth * 4);
    }
  });

  it.effect(
    "refuses cyclic unknown extras without recursively copying them",
    () =>
      Effect.gen(function* () {
        const filter: Record<string, unknown> = { page_size: "many" };
        filter.self = filter;
        expect(
          yield* Effect.flip(prepare(Direct, { filter }, "body")),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  for (const kind of ["path", "body"] as const) {
    it.effect(`refuses nested ${kind} input before rendering or dispatch`, () =>
      Effect.gen(function* () {
        for (const { schema, wrap } of shapes) {
          let rendered: unknown;
          let renders = 0;
          const request: Request.Request<
            never,
            Schema.SchemaError | Request.InvalidRequest | HttpBody.HttpBodyError
          > =
            kind === "path"
              ? Request.get("https://api.test").pipe(
                  Request.path(schema, (value) => {
                    renders++;
                    rendered = value;
                    return "/ok";
                  }),
                )
              : Request.post("https://api.test/x").pipe(
                  Request.body(Body.jsonSchema(schema)),
                );
          const operation = Operation.make(
            request,
            Response.status(204, Body.empty),
          );
          const provider = synthetic(() => empty(204));
          expect(
            yield* Effect.flip(
              operation
                .execute({ [kind]: wrap({ page_size: "many" }) } as never)
                .pipe(Effect.provide(provider.layer)),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(provider.exchanges).toHaveLength(0);
          expect(renders).toBe(0);
          yield* operation
            .execute({ [kind]: wrap({ page_size: "05" }) } as never)
            .pipe(Effect.provide(provider.layer));
          expect(provider.exchanges).toHaveLength(1);
          if (kind === "path")
            expect(rendered).toEqual(wrap({ page_size: "5" }));
          else {
            const body = provider.exchanges[0]!.request.body;
            expect(body._tag).toBe("Uint8Array");
            if (body._tag === "Uint8Array")
              expect(JSON.parse(new TextDecoder().decode(body.body))).toEqual(
                wrap({ page_size: "5" }),
              );
          }
        }
      }),
    );
  }
});
