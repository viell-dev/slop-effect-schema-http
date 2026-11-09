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

  it.effect(
    "does not replay construction when validating a positional alias",
    () =>
      Effect.gen(function* () {
        let defaults = 0;
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
        const schema = Schema.Array(inner);
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(
            yield* Effect.flip(
              prepare(schema, [{ page_size: "many" }], "path"),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(defaults).toBe(attempt + 1);
        }
        expect(yield* prepare(schema, [{ page_size: "05" }], "path")).toEqual([
          { page_size: "5" },
        ]);
        expect(defaults).toBe(2);
      }),
  );

  it.effect("keeps visible union siblings or refuses the complete array", () =>
    Effect.gen(function* () {
      const schema = Schema.Array(
        Schema.Struct({
          filter: Inner,
          choice: Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ a: Schema.String, b: Schema.String }),
          ]),
          opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
        }),
      );
      for (const kind of ["path", "body"] as const) {
        const result = yield* Effect.result(
          prepare(
            schema,
            [
              {
                filter: { page_size: "05" },
                choice: { a: "a", b: "kept" },
                opaque: Option.some({ keep: "x", extra: "opaque" }),
              },
            ],
            kind,
          ),
        );
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(Schema.SchemaError);
        else
          expect(result.success).toMatchObject([
            { choice: { a: "a", b: "kept" } },
          ]);
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

  it.effect("retains frozen, null-prototype and hidden own positions", () =>
    Effect.gen(function* () {
      for (const kind of ["path", "body"] as const)
        for (const profile of ["frozen", "null prototype", "hidden"] as const)
          for (const page_size of ["many", "05"]) {
            const input = [{ page_size }];
            if (profile === "frozen") {
              Object.freeze(input[0]);
              Object.freeze(input);
            }
            if (profile === "null prototype")
              Object.setPrototypeOf(input, null);
            if (profile === "hidden")
              Object.defineProperty(input, "0", { enumerable: false });
            if (page_size === "many")
              expect(
                yield* Effect.flip(prepare(Schema.Array(Inner), input, kind)),
              ).toBeInstanceOf(Schema.SchemaError);
            else
              expect(yield* prepare(Schema.Array(Inner), input, kind)).toEqual([
                { page_size: "5" },
              ]);
          }
    }),
  );

  it("invalidates array identities, order, length, descriptors and prototype", () => {
    const capture = nestedEncodedInput(Schema.Array(Inner).ast)!;
    for (const change of [
      (value: Array<object>) => value.push({}),
      (value: Array<object>) => value.pop(),
      (value: Array<object>) => {
        [value[0], value[1]] = [value[1]!, value[0]!];
      },
      (value: Array<object>) => {
        value[0] = { page_size: "many" };
      },
      (value: Array<object>) => {
        value.length = 1;
      },
      (value: Array<object>) => {
        delete value[0];
      },
      (value: Array<object>) =>
        Object.defineProperty(value, "0", { enumerable: false }),
      (value: Array<object>) => Object.freeze(value),
      (value: Array<object>) => Object.setPrototypeOf(value, null),
    ]) {
      const input = [{ page_size: "many" }, {}];
      const selected = capture(input)!.select([{ page_size: "25" }, {}])!;
      expect(selected.matches()).toBe(true);
      change(input);
      expect(selected.matches()).toBe(false);
    }
  });

  it("declines accessors, inherited cells, subclasses and custom iterators", () => {
    const capture = nestedEncodedInput(Schema.Array(Inner).ast)!;
    let reads = 0;
    const accessor = Object.defineProperty([], "0", {
      get() {
        reads++;
        return { page_size: "many" };
      },
    });
    const inherited: Array<object> = [];
    inherited.length = 1;
    Object.setPrototypeOf(inherited, {
      0: { page_size: "many" },
    });
    class Other extends Array<object> {}
    const iterator = Object.defineProperty(
      [{ page_size: "many" }],
      Symbol.iterator,
      {
        value() {
          reads++;
          return [][Symbol.iterator]();
        },
      },
    );
    for (const input of [
      accessor,
      inherited,
      new Other({ page_size: "many" }),
      iterator,
    ])
      expect(capture(input)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("rechecks output length after descendant reflection", () => {
    const capture = nestedEncodedInput(Schema.Array(Inner).ast)!;
    const output: Array<object> = [];
    let changed = false;
    output.push(
      new Proxy(
        { page_size: "25" },
        {
          getOwnPropertyDescriptor(target, key) {
            if (!changed && key === "page_size") {
              changed = true;
              output.push({});
            }
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      ),
    );
    expect(capture([{ page_size: "many" }])!.select(output)).toBeUndefined();
    expect(changed).toBe(true);
  });

  it("reuses array DAGs without cloning unknown cyclic values and declines AST cycles", () => {
    const items = Schema.Array(Inner);
    const schema = Schema.Struct({ left: items, right: items });
    const extra: { self?: unknown } = {};
    extra.self = extra;
    const leaf = { page_size: "many", extra };
    const shared = [leaf];
    const selected = nestedEncodedInput(schema.ast)!({
      left: shared,
      right: shared,
    })!.select({ left: [{ page_size: "25" }], right: [{ page_size: "25" }] })!;
    expect(selected.matches()).toBe(true);
    expect(leaf.extra).toBe(extra);
    expect(extra.self).toBe(extra);
    leaf.page_size = "05";
    expect(selected.matches()).toBe(false);
    const cycle = new SchemaAST.Arrays(false, [Inner.ast], []);
    Object.assign(cycle, { rest: [cycle] });
    expect(nestedEncodedInput(cycle)).toBeUndefined();
  });

  it("bounds deep positional evidence by a linear number of descriptor reads", () => {
    for (const depth of [16, 64, 256, 512]) {
      let schema: Schema.Top = Inner;
      let input: unknown = { page_size: "many" };
      let output: unknown = { page_size: "25" };
      const reads = { input: 0, output: 0 };
      const tracked = (value: unknown, side: keyof typeof reads) =>
        new Proxy([value], {
          getOwnPropertyDescriptor(target, key) {
            reads[side]++;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
      for (let index = 0; index < depth; index++) {
        schema = Schema.Array(schema);
        input = tracked(input, "input");
        output = tracked(output, "output");
      }
      expect(
        nestedEncodedInput(schema.ast)!(input)!.select(output)?.matches(),
      ).toBe(true);
      expect(reads.input).toBeLessThanOrEqual(10 * depth + 16);
      expect(reads.output).toBeLessThanOrEqual(8 * depth + 16);
    }
  });

  it.effect("retains caller evidence while array decoding is suspended", () =>
    Effect.gen(function* () {
      for (const mode of ["stable", "caller", "obsolete output"] as const) {
        const started = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let writes = 0;
        let original:
          | ReadonlyArray<{ readonly page_size?: string | undefined }>
          | undefined;
        const input = [{ page_size: "05" }];
        const codec = Schema.String.pipe(
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
        const filter = Schema.Struct({
          limit: Schema.optionalKey(codec).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Array(filter);
        const read = Inputs.reader(schema, (value, options) =>
          Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
            writes++;
            original ??= output;
            return output;
          }),
        );
        const running = yield* Effect.result(read(input)).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        if (mode === "caller") input[0] = { page_size: "05" };
        if (mode === "obsolete output")
          Reflect.set(original!, "length", original!.length + 1);
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(running);
        if (mode === "caller") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toBeInstanceOf(Schema.SchemaError);
          expect(writes).toBe(1);
        } else {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success")
            expect(result.success).toEqual({
              output: [{ page_size: "5" }],
              lost: [],
            });
          expect(writes).toBe(2);
        }
      }
    }),
  );

  for (const mode of ["defect", "interrupt"] as const) {
    it.effect(`propagates ${mode} from added array decoding`, () =>
      Effect.gen(function* () {
        const boom = new Error("array decoder defect");
        let writes = 0;
        const codec = Schema.String.pipe(
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
          limit: Schema.optionalKey(codec).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Array(filter);
        const read = Inputs.reader(schema, (value, options) =>
          Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
            writes++;
            return output;
          }),
        );
        const result = yield* Effect.exit(read([{ page_size: "05" }]));
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          if (mode === "defect") expect(Cause.squash(result.cause)).toBe(boom);
          else expect(Cause.hasInterrupts(result.cause)).toBe(true);
        }
        expect(writes).toBe(1);
      }),
    );
  }

  it.effect(
    "isolates services across repeated and concurrent array evaluations",
    () =>
      Effect.gen(function* () {
        class Tenant extends Context.Service<Tenant, string>()(
          "array/Tenant",
        ) {}
        const writes: string[] = [];
        const codec = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (text) =>
                Effect.flatMap(Tenant, () =>
                  Number.isFinite(Number(text))
                    ? Effect.succeed(Number(text))
                    : Effect.fail(
                        new SchemaIssue.InvalidValue({ message: "finite" }),
                      ),
                ),
              encode: (value) =>
                Effect.flatMap(Tenant, (tenant) => {
                  writes.push(tenant);
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
        const filter = Schema.Struct({
          limit: Schema.optionalKey(codec).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Array(filter);
        const pending = Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )([{ page_size: "many" }]);
        const results = yield* Effect.all(
          ["one", "bad", "two"].map((tenant) =>
            Effect.result(pending).pipe(Effect.provideService(Tenant, tenant)),
          ),
          { concurrency: "unbounded" },
        );
        for (const [index, result] of results.entries()) {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(Schema.SchemaError);
            if (index === 1)
              expect(result.failure.message).toContain("writer failed");
          }
        }
        expect(writes.filter((value) => value === "one")).toHaveLength(1);
        expect(writes).toContain("bad");
        expect(writes.filter((value) => value === "two")).toHaveLength(1);
        yield* Effect.flip(pending.pipe(Effect.provideService(Tenant, "one")));
        expect(writes.filter((value) => value === "one")).toHaveLength(2);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently uses encoded names after a sibling enables whole array decoding",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Array(Inner);
        for (const kind of ["path", "body"] as const)
          for (const [input, output] of [
            [[{ limit: 1, page_size: "02" }], [{ page_size: "1" }]],
            [
              [{ limit: 1, page_size: "02" }, {}],
              [{ page_size: "1" }, { page_size: "25" }],
            ],
            [
              [{ limit: 1, page_size: "02" }, { limit: 25 }],
              [{ page_size: "1" }, { page_size: "25" }],
            ],
            [
              [{ limit: 1, page_size: "02" }, { page_size: "25" }],
              [{ page_size: "2" }, { page_size: "25" }],
            ],
            [
              [{ page_size: "02" }, { page_size: "25" }],
              [{ page_size: "2" }, { page_size: "25" }],
            ],
            [
              [{ limit: 1 }, { limit: 25 }],
              [{ page_size: "1" }, { page_size: "25" }],
            ],
          ])
            expect(yield* prepare(schema, input, kind)).toEqual(output);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect.fails(
    "refuses conflicting aliases beside an encoded-only array item",
    () =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            prepare(
              Schema.Array(Inner),
              [{ limit: 1, page_size: "02" }, { page_size: "25" }],
              "path",
            ),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  const aliasProfiles = [
    {
      name: "optional elements",
      schema: Schema.Array(Schema.optional(Inner)),
      input: (values: ReadonlyArray<object>) => [...values],
      sparse: false,
    },
    {
      name: "nullable elements",
      schema: Schema.Array(Schema.NullOr(Inner)),
      input: (values: ReadonlyArray<object>) => [...values],
      sparse: false,
    },
    {
      name: "native own iterator",
      schema: Schema.Array(Inner),
      input: (values: ReadonlyArray<object>) =>
        Object.defineProperty([...values], Symbol.iterator, {
          value: Array.prototype[Symbol.iterator],
          enumerable: true,
        }),
      sparse: false,
    },
    {
      name: "sparse optional elements",
      schema: Schema.Array(Schema.optional(Inner)),
      input: (values: ReadonlyArray<object>) => {
        const input: object[] = [];
        input.length = values.length + 1;
        values.forEach((value, index) => {
          input[index + 1] = value;
        });
        return input;
      },
      sparse: true,
    },
  ] as const;
  for (const kind of ["path", "body"] as const)
    for (const profile of aliasProfiles) {
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6750236968
      it.effect(
        `currently ${kind} whole reading changes a conflicting name through ${profile.name}`,
        () =>
          Effect.gen(function* () {
            for (const [input, expected] of [
              [[{ limit: 1, page_size: "02" }], [{ page_size: "1" }]],
              [
                [{ limit: 1, page_size: "02" }, {}],
                [{ page_size: "1" }, { page_size: "25" }],
              ],
              [
                [{ limit: 1, page_size: "02" }, { limit: 25 }],
                [{ page_size: "1" }, { page_size: "25" }],
              ],
              [
                [{ limit: 1, page_size: "02" }, { page_size: "25" }],
                [{ page_size: "2" }, { page_size: "25" }],
              ],
              [
                [{ page_size: "02" }, { page_size: "25" }],
                [{ page_size: "2" }, { page_size: "25" }],
              ],
              [
                [{ limit: 1 }, { limit: 25 }],
                [{ page_size: "1" }, { page_size: "25" }],
              ],
            ] as const) {
              expect(
                yield* prepare(profile.schema, profile.input(input), kind),
              ).toEqual(
                profile.sparse
                  ? [kind === "body" ? null : undefined, ...expected]
                  : expected,
              );
            }
          }),
      );
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.effect.fails(
        `refuses conflicting aliases through ${profile.name} in ${kind}`,
        () =>
          Effect.gen(function* () {
            expect(
              yield* Effect.flip(
                prepare(
                  profile.schema,
                  profile.input([
                    { limit: 1, page_size: "02" },
                    { page_size: "25" },
                  ]),
                  kind,
                ),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
          }),
      );
    }

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
