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
            [{ limit: 5, page_size: "many" }, "5"],
          ] as const)
            expect(yield* prepare(schema, wrap(filter), kind)).toEqual(
              wrap({ page_size: expected }),
            );
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

  it("collects unique fields without evaluating checks or suspensions", () => {
    let evaluations = 0;
    const checked = Root.check(
      Schema.makeFilter(() => {
        evaluations++;
        return true;
      }),
    );
    const evidence = nestedEncodedInput(checked.ast)?.({
      filter: { page_size: "many" },
    });
    expect(evidence?.select({ filter: { page_size: "25" } })?.matches()).toBe(
      true,
    );
    const suspended = Schema.suspend(() => {
      evaluations++;
      return Direct;
    });
    expect(
      nestedEncodedInput(Schema.Union([Direct, suspended]).ast),
    ).toBeUndefined();
    expect(evaluations).toBe(0);
  });

  it("keeps the names of other members in stable ancestor evidence", () => {
    const schema = Schema.Union([
      Direct,
      Schema.Struct({ toString: Schema.String }),
    ]);
    const capture = nestedEncodedInput(schema.ast)!;
    expect(capture({ filter: { page_size: "many" } })).toBeUndefined();
    const input = Object.assign(Object.create(null), {
      filter: { page_size: "many" },
    });
    expect(
      capture(input)
        ?.select({ filter: { page_size: "25" } })
        ?.matches(),
    ).toBe(true);
  });

  it("does not merge distinct declarations of the same field", () => {
    for (const other of [
      AlternateInner,
      Schema.Struct({ page_size: Schema.String }),
      Schema.Unknown,
    ]) {
      const schema = Schema.Union([Direct, Schema.Struct({ filter: other })]);
      expect(nestedEncodedInput(schema.ast)).toBeUndefined();
    }
  });

  it("does not merge duplicate normalized declarations inside one parent member", () => {
    const decoded = Schema.Struct({
      limit: Schema.optionalKey(Schema.Number),
      page_size: Schema.optionalKey(Schema.String),
    });
    const symbol = Symbol("field");
    for (const names of [
      [1, "1"],
      ["filter", "filter"],
      [symbol, symbol],
    ] as const) {
      for (const types of [
        [decoded.ast, Inner.ast],
        [Inner.ast, decoded.ast],
        [Inner.ast, decoded.ast, Inner.ast],
      ]) {
        const member = new SchemaAST.Objects(
          types.map(
            (type, index) =>
              new SchemaAST.PropertySignature(names[index === 0 ? 0 : 1], type),
          ),
          [],
        );
        expect(
          nestedEncodedInput(new SchemaAST.Union([member, Cursor.ast])),
        ).toBeUndefined();
      }
      const member = new SchemaAST.Objects(
        names.map((name) => new SchemaAST.PropertySignature(name, Inner.ast)),
        [],
      );
      const capture = nestedEncodedInput(
        new SchemaAST.Union([member, Cursor.ast]),
      )!;
      const field = names[0];
      expect(
        capture({ [field]: { page_size: "many" } })
          ?.select({ [field]: { page_size: "25" } })
          ?.matches(),
      ).toBe(true);
    }
  });

  it("declines conflicting StructWithRest numeric/string field schemas", () => {
    expect(nestedEncodedInput(NumericConflict.ast)).toBeUndefined();
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "currently retains the default for conflicting normalized numeric declarations",
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
            yield* prepare(schema, wrap({ page_size: "many" }), "path"),
          ).toEqual(wrap({ page_size: "25" }));
          for (const value of [{ page_size: "05" }, { limit: 5 }])
            expect(yield* prepare(schema, wrap(value), "path")).toEqual(
              wrap({ page_size: "5" }),
            );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect.fails(
    "refuses invalid input under conflicting normalized numeric declarations",
    () =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            prepare(NumericConflict, { "1": { page_size: "many" } }, "path"),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "currently retains the default under distinct parent field declarations",
    () =>
      Effect.gen(function* () {
        expect(
          yield* prepare(Distinct, { filter: { page_size: "many" } }, "path"),
        ).toEqual({ filter: { page_size: "25" } });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect.fails(
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

  it("retains ambiguous member names in ancestor evidence", () => {
    const schema = Schema.Union([
      Schema.Struct({ filter: Inner, toString: Schema.String }),
      Schema.Struct({ filter: Inner, toString: Schema.Number }),
    ]);
    const capture = nestedEncodedInput(schema.ast)!;
    expect(capture({ filter: { page_size: "many" } })).toBeUndefined();
    const input = Object.assign(Object.create(null), {
      filter: { page_size: "many" },
    });
    expect(
      capture(input)
        ?.select({ filter: { page_size: "25" } })
        ?.matches(),
    ).toBe(true);
  });

  it("binds one consistent witness across parent alternatives", () => {
    const schema = Schema.Union([
      Schema.Struct({ left: Inner }),
      Schema.Struct({ right: Inner }),
    ]);
    const input = { left: { page_size: "many" }, right: { page_size: "many" } };
    const evidence = nestedEncodedInput(schema.ast)!(input)!;
    input.left.page_size = "changed";
    expect(evidence.select({ left: { page_size: "25" } })).toBeUndefined();
    const stable = nestedEncodedInput(schema.ast)!({
      left: { page_size: "many" },
      right: { page_size: "many" },
    })!;
    expect(stable.select({ right: { page_size: "25" } })?.matches()).toBe(true);
  });

  it("keeps symbol and numeric field identities in parent unions", () => {
    const field = Symbol("filter");
    const other = Symbol("filter");
    const schema = Schema.Union([
      Schema.Struct({ [field]: Inner }),
      Schema.Struct({ [other]: Schema.String }),
    ]);
    const captured = nestedEncodedInput(schema.ast)!({
      [field]: { page_size: "many" },
    })!;
    expect(captured.select({ [other]: { page_size: "25" } })).toBeUndefined();
    expect(captured.select({ [field]: { page_size: "25" } })?.matches()).toBe(
      true,
    );
    const numeric = Schema.Union([Schema.Struct({ 1: Inner }), Cursor]);
    expect(
      nestedEncodedInput(numeric.ast)!({ "1": { page_size: "many" } })
        ?.select({ "1": { page_size: "25" } })
        ?.matches(),
    ).toBe(true);
  });

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

  it.effect(
    "retains caller evidence while parent-union decoding is suspended",
    () =>
      Effect.gen(function* () {
        for (const mode of ["stable", "caller", "obsolete output"] as const) {
          const started = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let writes = 0;
          let original:
            { filter: { page_size?: string | undefined } } | undefined;
          const input = { filter: { page_size: "05" } };
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
          const schema = Schema.Union([Schema.Struct({ filter }), Cursor]);
          const read = Inputs.reader(schema, (value, options) =>
            Effect.map(
              Schema.encodeEffect(schema)(value, options),
              (output) => {
                writes++;
                if ("filter" in output) original ??= output;
                return output;
              },
            ),
          );
          const running = yield* Effect.result(read(input)).pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          if (mode === "caller") input.filter = { page_size: "05" };
          if (mode === "obsolete output")
            original!.filter = { page_size: "99" };
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
                output: { filter: { page_size: "5" } },
                lost: [],
              });
            expect(writes).toBe(2);
          }
        }
      }),
  );

  for (const mode of ["defect", "interrupt"] as const) {
    it.effect(`propagates ${mode} from added parent-union decoding`, () =>
      Effect.gen(function* () {
        const boom = new Error("parent decoder defect");
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
        const schema = Schema.Union([Schema.Struct({ filter }), Cursor]);
        const read = Inputs.reader(schema, (value, options) =>
          Effect.map(Schema.encodeEffect(schema)(value, options), (output) => {
            writes++;
            return output;
          }),
        );
        const result = yield* Effect.exit(
          read({ filter: { page_size: "05" } }),
        );
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
    "isolates services across repeated and concurrent parent-union evaluations",
    () =>
      Effect.gen(function* () {
        class Tenant extends Context.Service<Tenant, string>()(
          "parent/Tenant",
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
        const schema = Schema.Union([Schema.Struct({ filter }), Cursor]);
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
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(Schema.SchemaError);
            if (index === 1)
              expect(result.failure.message).toContain("writer failed");
          }
        }
        expect(writes.filter((value) => value === "one")).toHaveLength(1);
        expect(writes.filter((value) => value === "bad")).toHaveLength(2);
        expect(writes.filter((value) => value === "two")).toHaveLength(1);
        yield* Effect.flip(pending.pipe(Effect.provideService(Tenant, "one")));
        expect(writes.filter((value) => value === "one")).toHaveLength(2);
      }),
  );

  it("reuses union DAGs but declines cycles and unsupported member groups", () => {
    const dag = Schema.Union([Root, Root, Cursor]);
    expect(
      nestedEncodedInput(dag.ast)?.({ filter: { page_size: "many" } })
        ?.select({ filter: { page_size: "25" } })
        ?.matches(),
    ).toBe(true);
    const cycle = new SchemaAST.Union([Direct.ast]);
    Object.assign(cycle, { types: [cycle] });
    expect(nestedEncodedInput(cycle)).toBeUndefined();
    for (const other of [
      Schema.String,
      Schema.Array(Schema.String),
      Schema.Record(Schema.String, Schema.Unknown),
      Direct.pipe(Schema.encodeKeys({ filter: "q" })),
    ])
      expect(
        nestedEncodedInput(Schema.Union([Direct, other]).ast),
      ).toBeUndefined();
  });

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
      let constructed = false;
      let fieldwise = false;
      yield* Inputs.toDecoded(schema)(
        input,
        () => {
          constructed = true;
        },
        () => {
          fieldwise = true;
        },
      );
      expect(constructed).toBe(false);
      expect(fieldwise).toBe(true);
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
