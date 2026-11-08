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
  SchemaGetter,
  SchemaIssue,
} from "effect";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
import { snapshotter } from "./internal/snapshot.js";
import * as Request from "./Request.js";

const A = Schema.Struct({ a: Schema.String });
const AB = Schema.Struct({ a: Schema.String, b: Schema.String });
const F = Schema.Union([A, AB]);
const Core = Schema.Struct({ f: F, o: Schema.Option(A) });
const input = () => ({
  f: { a: "x", b: "y" },
  o: Option.some({ a: "o", zz: "z" }),
});
const sparseStrings = () => {
  const value: (string | undefined)[] = [];
  value.length = 1;
  return value;
};
const json = <S extends Schema.Top>(schema: S, value: Inputs.Input<S>) =>
  Effect.map(Body.jsonSchema(schema).encode(value), (body) => {
    if (body._tag !== "Uint8Array") throw new Error("expected a JSON body");
    return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
  });

// https://github.com/viell-dev/slop-effect-schema-http/issues/143
describe("constructor-only recovery beside opaque fields", () => {
  it.effect("keeps the visible wider member through Body.jsonSchema", () =>
    Effect.gen(function* () {
      expect(yield* json(Core, input())).toEqual({
        f: { a: "x", b: "y" },
        o: { _tag: "Some", value: { a: "o" } },
      });
    }),
  );

  it.effect("keeps the wider member through Request.compile", () =>
    Effect.gen(function* () {
      const request = Request.post("/x").pipe(
        Request.body(Body.jsonSchema(Core)),
      );
      const compiled = yield* Request.compile(request, { body: input() });
      if (compiled.request.body._tag !== "Uint8Array")
        throw new Error("expected a JSON body");
      expect(
        JSON.parse(new TextDecoder().decode(compiled.request.body.body)),
      ).toEqual({
        f: { a: "x", b: "y" },
        o: { _tag: "Some", value: { a: "o" } },
      });
    }),
  );

  it.effect(
    "retains refusal when a pending encoding gains a visible field",
    () =>
      Effect.gen(function* () {
        const value = {
          f: { a: "x" } as { a: string; b?: string },
          o: input().o,
        };
        const pending = Body.jsonSchema(Core).encode(value);
        value.f.b = "y";
        const result = yield* Effect.result(pending);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(String(result.failure)).toContain('["f"]["b"]');
      }),
  );

  it.effect("retains current field values when pending input changes", () =>
    Effect.gen(function* () {
      const value = input();
      const pending = Inputs.reader(Core, Schema.encodeEffect(Core))(value);
      value.f.a = "changed";
      const result = yield* pending;
      expect(result.lost).toEqual([["f", "b"]]);
      expect(result.output.f.a).toBe("changed");
    }),
  );

  it.effect(
    "does not substitute an older opaque identity while an Effect is pending",
    () =>
      Effect.gen(function* () {
        const external = { keep: "same" };
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.declare(
            (value): value is object =>
              typeof value === "object" && value !== null,
          ),
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== external,
          ),
        );
        const value = { ...input(), x: { keep: "same" } };
        const pending = Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )(value);
        value.x = external;
        const result = yield* pending;
        expect(result.lost).toEqual([["f", "b"]]);
        expect(result.output.x).toBe(external);
      }),
  );

  it.effect("retains changed record key order while an Effect is pending", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        ...Core.fields,
        x: Schema.Record(Schema.String, Schema.String),
      }).check(
        Schema.makeFilter(
          (value) =>
            !("b" in value.f) || Object.keys(value.x).join(",") !== "q,p",
        ),
      );
      const value = {
        ...input(),
        x: { p: "p", q: "q" } as Record<string, string>,
      };
      const pending = Inputs.reader(schema, Schema.encodeEffect(schema))(value);
      Reflect.deleteProperty(value.x, "p");
      value.x.p = "p";
      const result = yield* pending;
      expect(result.lost).toEqual([["f", "b"]]);
      expect(Object.keys(result.output.x)).toEqual(["q", "p"]);
    }),
  );

  it.effect("keeps whole-side priority rather than decoding each field", () =>
    Effect.gen(function* () {
      const Mixed = Schema.Struct({
        ...Core.fields,
        n: Schema.FiniteFromString,
        base64: Schema.StringFromBase64,
      });
      const read = Inputs.reader(Mixed, Schema.encodeEffect(Mixed));
      const encoded = yield* read({ ...input(), n: "1", base64: "eA==" });
      expect(encoded.output.base64).toBe("eA==");
      expect(encoded.lost).toEqual([["f", "b"]]);
      const failure = yield* Effect.flip(
        Body.jsonSchema(Mixed).encode({
          ...input(),
          n: "1",
          base64: "eA==",
        }),
      );
      expect(String(failure)).toContain('["f"]["b"]');
      expect(yield* json(Mixed, { ...input(), n: 1, base64: "eA==" })).toEqual({
        f: { a: "x", b: "y" },
        o: { _tag: "Some", value: { a: "o" } },
        n: "1",
        base64: "ZUE9PQ==",
      });
    }),
  );

  it.effect("leaves a Map's contents to its own ordinary reading", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        f: F,
        o: Schema.ReadonlyMap(Schema.String, A),
      });
      expect(
        yield* json(schema, {
          f: input().f,
          o: new Map([["k", { a: "o", zz: "z" }]]),
        }),
      ).toEqual({ f: { a: "x", b: "y" }, o: [["k", { a: "o" }]] });
    }),
  );

  it.effect(
    "keeps a null prototype while constructing omitted prototype-named defaults",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Core.fields,
          toString: Schema.optionalKey(Schema.Unknown).pipe(
            Schema.withConstructorDefault(Effect.succeed("25")),
          ),
        });
        const value = Object.assign(Object.create(null), input());
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )(value);
        expect(result.lost).toEqual([]);
        expect(result.output.f).toEqual({ a: "x", b: "y" });
        expect(
          Object.getOwnPropertyDescriptor(result.output, "toString")?.value,
        ).toBe("25");
      }),
  );

  it.effect("preserves the already successful renamed-sibling control", () =>
    Effect.gen(function* () {
      const renamed = Schema.Struct({
        f: F,
        o: A.pipe(Schema.encodeKeys({ a: "A" })),
      });
      expect(yield* json(renamed, { f: input().f, o: { A: "o" } })).toEqual({
        f: { a: "x", b: "y" },
        o: { A: "o" },
      });
    }),
  );

  it.effect("preserves parent checks and constructor defaults", () =>
    Effect.gen(function* () {
      const checked = Core.check(
        Schema.makeFilter((value) => !("b" in value.f)),
      );
      const original = yield* Inputs.reader(
        checked,
        Schema.encodeEffect(checked),
      )(input());
      expect(original.lost).toEqual([["f", "b"]]);
      expect(original.output.f).toEqual({ a: "x" });
      const defaulted = Schema.Struct({
        ...Core.fields,
        d: Schema.String.pipe(
          Schema.withConstructorDefault(Effect.succeed("default")),
        ),
      });
      expect(yield* json(defaulted, input())).toMatchObject({
        f: { a: "x", b: "y" },
        d: "default",
      });
    }),
  );

  it.effect("does not repeat callbacks for an already successful read", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const schema = Schema.Struct({
        ...Core.fields,
        d: Schema.String.pipe(
          Schema.withConstructorDefault(
            Effect.sync(() => {
              trace.push("default");
              return "d";
            }),
          ),
        ),
      }).check(
        Schema.makeFilter((value) => {
          trace.push(`parent:${Object.keys(value.f).join(",")}`);
          return true;
        }),
      );
      expect(
        yield* json(schema, { f: { a: "x" }, o: Option.some({ a: "o" }) }),
      ).toMatchObject({ f: { a: "x" }, d: "d" });
      expect(trace).toEqual(["default", "parent:a", "parent:a"]);
    }),
  );

  it.effect("retains the explicit JSON-text decoding limit", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ f: F, o: Schema.fromJsonString(A) });
      const result = yield* Inputs.reader(
        schema,
        Schema.encodeEffect(schema),
      )({
        f: input().f,
        o: '{"a":"o","zz":"z"}',
      });
      expect(result.output.o).toBe('{"a":"o"}');
      expect(result.lost).toEqual([["f", "b"]]);
    }),
  );

  it.effect(
    "copies full input rather than projecting unstated root or nested fields",
    () =>
      Effect.gen(function* () {
        for (const value of [
          { ...input(), unknown: "root" },
          { ...input(), f: { ...input().f, unknown: "nested" } },
        ]) {
          const result = yield* Inputs.reader(
            Core,
            Schema.encodeEffect(Core),
          )(value);
          expect(result.lost).toEqual([["f", "b"]]);
          expect(result.output.f).toEqual({ a: "x" });
        }
        const impossible = Schema.Struct({
          f: Schema.Union([A, Schema.Struct({ b: Schema.String })]),
          o: Schema.Option(A),
        });
        const result = yield* Inputs.reader(
          impossible,
          Schema.encodeEffect(impossible),
        )(input());
        expect(result.lost).toEqual([["f", "b"]]);
        const failure = yield* Effect.flip(
          Inputs.refuseLost(impossible, result.lost, new Set(["f", "b"])),
        );
        expect(failure.message).toContain('["f"]["b"]');
      }),
  );

  for (const name of [
    "__proto__",
    "constructor",
    "toString",
    Symbol("field"),
  ]) {
    it.effect(`writes ${String(name)} safely as an own field`, () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({ ...Core.fields, [name]: Schema.String });
        const value = { ...input(), [name]: "kept" };
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )(value);
        expect(result.lost).toEqual([]);
        expect(
          Object.getOwnPropertyDescriptor(result.output, name)?.value,
        ).toBe("kept");
        expect(result.output.f).toEqual({ a: "x", b: "y" });
        expect(Object.getPrototypeOf(result.output)).toBe(Object.prototype);
      }),
    );
  }

  it.effect(
    "retains the original loss when a candidate writer still drops a field",
    () =>
      Effect.gen(function* () {
        const originalInput = input();
        let writes = 0;
        const read = Inputs.reader(Core, (value, options) =>
          Effect.map(Schema.encodeEffect(Core)(value, options), (output) => {
            writes++;
            if (writes === 2) {
              // A callback mutates the caller's value while also producing a lossy candidate.
              Reflect.deleteProperty(originalInput.f, "b");
              Reflect.deleteProperty(value.f, "b");
              return { ...output, f: { a: "x" } };
            }
            return output;
          }),
        );
        const result = yield* read(originalInput);
        expect(writes).toBe(2);
        expect(originalInput.f).toEqual({ a: "x" });
        expect(result.lost).toEqual([["f", "b"]]);
        expect(result.output.f).toEqual({ a: "x" });
      }),
  );

  it.effect(
    "keeps pre-callback full input when a callback deletes an unknown root field",
    () =>
      Effect.gen(function* () {
        const originalInput = { ...input(), unknown: "root" };
        let writes = 0;
        const read = Inputs.reader(Core, (value, options) =>
          Effect.map(Schema.encodeEffect(Core)(value, options), (output) => {
            writes++;
            Reflect.deleteProperty(originalInput, "unknown");
            return output;
          }),
        );
        const result = yield* read(originalInput);
        expect(writes).toBe(1);
        expect(result.lost).toEqual([["f", "b"]]);
      }),
  );

  it.effect(
    "retains typed candidate failures while propagating defects and interruption",
    () =>
      Effect.gen(function* () {
        const boom = new Error("candidate defect");
        for (const mode of ["typed", "defect", "interrupt"] as const) {
          const read = Inputs.reader(Core, (value, options) => {
            if ("b" in value.f) {
              if (mode === "defect") return Effect.die(boom);
              if (mode === "interrupt") return Effect.interrupt;
              return Effect.fail(
                new Schema.SchemaError(
                  new SchemaIssue.InvalidValue({
                    message: "candidate refused",
                  }),
                ),
              );
            }
            return Schema.encodeEffect(Core)(value, options);
          });
          const result = yield* Effect.exit(read(input()));
          if (mode === "typed") {
            expect(result).toMatchObject({
              _tag: "Success",
              value: { lost: [["f", "b"]] },
            });
          } else {
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) {
              if (mode === "defect")
                expect(Cause.squash(result.cause)).toBe(boom);
              else expect(Cause.hasInterrupts(result.cause)).toBe(true);
            }
          }
        }
      }),
  );

  it.effect(
    "keeps schema services and failures isolated under concurrent use",
    () =>
      Effect.gen(function* () {
        class Tenant extends Context.Service<Tenant, string>()(
          "opaque/Tenant",
        ) {}
        const schema = Schema.Struct({
          ...Core.fields,
          d: Schema.String.pipe(
            Schema.decodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transformEffect(() =>
                Effect.gen(function* () {
                  const tenant = yield* Tenant;
                  yield* Effect.promise(() => Promise.resolve());
                  return tenant;
                }),
              ),
            }),
            Schema.withConstructorDefault(Effect.succeed("d")),
          ),
        });
        const read = Inputs.reader(schema, (value, options) =>
          Effect.gen(function* () {
            const tenant = yield* Tenant;
            if (tenant === "bad" && "b" in value.f)
              return yield* Effect.fail(
                new Schema.SchemaError(
                  new SchemaIssue.InvalidValue({ message: "tenant refused" }),
                ),
              );
            return yield* Schema.encodeEffect(schema)(value, options);
          }),
        );
        const results = yield* Effect.all(
          ["one", "bad", "two"].map((tenant) =>
            read(input()).pipe(Effect.provideService(Tenant, tenant)),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.map(({ output }) => output.d)).toEqual([
          "one",
          "bad",
          "two",
        ]);
        expect(results.map(({ lost }) => lost)).toEqual([[], [["f", "b"]], []]);
      }),
  );

  it.effect("interrupts an in-progress constructor recovery", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let recovering = false;
      const schema = Schema.Struct({
        ...Core.fields,
        d: Schema.String.pipe(
          Schema.withConstructorDefault(
            Effect.suspend(() =>
              recovering
                ? Effect.ensuring(
                    Effect.andThen(
                      Deferred.succeed(started, undefined),
                      Effect.never,
                    ),
                    Deferred.succeed(released, undefined),
                  )
                : Effect.succeed("d"),
            ),
          ),
        ),
      });
      const read = Inputs.reader(schema, (value, options) =>
        Effect.tap(Schema.encodeEffect(schema)(value, options), () =>
          Effect.sync(() => {
            recovering = true;
          }),
        ),
      );
      const fiber = yield* read(input()).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const result = yield* Fiber.await(fiber);
      yield* Deferred.await(released);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.hasInterrupts(result.cause)).toBe(true);
    }),
  );

  it.effect(
    "keeps evidence independent of mutations by candidate constructors",
    () =>
      Effect.gen(function* () {
        let recovering = false;
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.Struct({ keep: Schema.optionalKey(Schema.String) }).check(
            Schema.makeFilter((value) => {
              if (recovering) Reflect.deleteProperty(value, "keep");
              return true;
            }),
          ),
        });
        const read = Inputs.reader(schema, (value, options) =>
          Effect.tap(Schema.encodeEffect(schema)(value, options), () =>
            Effect.sync(() => {
              recovering = true;
            }),
          ),
        );
        const result = yield* read({ ...input(), x: { keep: "y" } });
        expect(result.lost).toEqual([["f", "b"]]);
        expect(result.output.x).toEqual({ keep: "y" });
      }),
  );

  it.effect(
    "does not split shared references to bypass the parent's check",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.Unknown,
          y: Schema.Unknown,
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== value.y,
          ),
        );
        const shared = { keep: "shared" };
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x: shared,
          y: shared,
        });
        expect(result.lost).toEqual([["f", "b"]]);
      }),
  );

  it.effect("retains the refusal for repeated visible references", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        rows: Schema.Array(F),
        o: Schema.Option(A),
      });
      const shared = { a: "x", b: "y" };
      const result = yield* Inputs.reader(
        schema,
        Schema.encodeEffect(schema),
      )({
        rows: [shared, shared],
        o: input().o,
      });
      expect(result.lost).toEqual([
        ["rows", 0, "b"],
        ["rows", 1, "b"],
      ]);
    }),
  );

  it.effect(
    "does not lose an inherited array value or bypass its parent check",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.Array(Schema.UndefinedOr(Schema.String)),
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x[0] !== "original",
          ),
        );
        const prototype: object = Object.create(Array.prototype);
        Object.defineProperty(prototype, "0", { value: "original" });
        const x = sparseStrings();
        Object.setPrototypeOf(x, prototype);
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x,
        });
        expect(result.lost).toEqual([["f", "b"]]);
        expect(result.output.x).toEqual(["original"]);
      }),
  );

  it.effect(
    "keeps ordinary sparse arrays eligible for constructor recovery",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.Array(Schema.UndefinedOr(Schema.String)),
        });
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x: sparseStrings(),
        });
        expect(result.lost).toEqual([]);
        expect(result.output.x).toEqual([undefined]);
      }),
  );

  it("declines inherited sparse indices without evaluating their getters", () => {
    const schema = Schema.Struct({
      ...Core.fields,
      x: Schema.Array(Schema.UndefinedOr(Schema.String)),
    });
    const capture = snapshotter([schema.ast]);
    expect(capture({ ...input(), x: [undefined] })).toBeDefined();
    let gets = 0;
    const prototype: object = Object.create(Array.prototype);
    Object.defineProperty(prototype, "0", {
      get: () => {
        gets++;
        return "original";
      },
    });
    const custom = sparseStrings();
    Object.setPrototypeOf(custom, prototype);
    expect(capture({ ...input(), x: custom })).toBeUndefined();
    expect(gets).toBe(0);
    for (const polluted of [Array.prototype, Object.prototype]) {
      const previous = Object.getOwnPropertyDescriptor(polluted, "0");
      let captured: unknown;
      try {
        Object.defineProperty(polluted, "0", {
          value: "original",
          configurable: true,
          writable: true,
        });
        captured = capture({ ...input(), x: sparseStrings() });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(polluted, "0");
        else Object.defineProperty(polluted, "0", previous);
      }
      expect(captured).toBeUndefined();
    }
  });

  it("captures sparse array evidence without visiting every missing element", () => {
    const schema = Schema.Struct({
      ...Core.fields,
      x: Schema.Array(Schema.UndefinedOr(Schema.String)),
    });
    const x: (string | undefined)[] = [];
    x.length = 1_000_000_000;
    const original = { ...input(), x };
    const captured = snapshotter([schema.ast])(original);
    expect(captured).toBeDefined();
    const value = captured!.value as { readonly x: ReadonlyArray<unknown> };
    expect(value.x.length).toBe(x.length);
    expect(Object.hasOwn(value.x, "0")).toBe(false);
    expect(captured!.matches(original)).toBe(true);
  });

  for (const [name, opaque] of [
    ["Unknown", Schema.Unknown],
    ["Any", Schema.Any],
    ["ObjectKeyword", Schema.ObjectKeyword],
    ["empty Struct", Schema.Struct({})],
    ["union with empty Struct", Schema.Union([Schema.Struct({}), A])],
    ["union with Unknown", Schema.Union([Schema.Unknown, A])],
    [
      "union with Declaration",
      Schema.Union([
        Schema.declare(
          (value): value is object =>
            typeof value === "object" && value !== null,
        ),
        A,
      ]),
    ],
  ] as const) {
    it.effect(`does not clone ${name} past an external identity check`, () =>
      Effect.gen(function* () {
        const external = { keep: "external" };
        const schema = Schema.Struct({ ...Core.fields, x: opaque }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== external,
          ),
        );
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x: external,
        });
        expect(result.lost).toEqual([["f", "b"]]);
      }),
    );
  }

  it.effect("excludes transformed, union, open and iterable parents", () =>
    Effect.gen(function* () {
      const schemas = [
        Core.pipe(Schema.encodeKeys({ f: "f" })),
        Schema.Union([Core, Schema.Struct({ unrelated: Schema.String })]),
        Schema.StructWithRest(Core, [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
        Schema.Struct({
          ...Core.fields,
          [Symbol.iterator]: Schema.optionalKey(Schema.Unknown),
        }),
      ];
      for (const schema of schemas) {
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )(input());
        expect(result.lost).toEqual([["f", "b"]]);
      }
      const iterable = {
        ...input(),
        [Symbol.iterator]() {
          throw new Error("must not iterate recovery input");
        },
      };
      const result = yield* Inputs.reader(
        Core,
        Schema.encodeEffect(Core),
      )(iterable);
      expect(result.lost).toEqual([["f", "b"]]);
    }),
  );

  it.effect(
    "retains the refusal for accessor and inherited visible input",
    () =>
      Effect.gen(function* () {
        let gets = 0;
        const accessor = {
          ...input(),
          get f() {
            gets++;
            return { a: "x", b: "y" };
          },
        };
        const inherited = Object.create(input()) as ReturnType<typeof input>;
        for (const value of [accessor, inherited]) {
          const result = yield* Inputs.reader(
            Core,
            Schema.encodeEffect(Core),
          )(value);
          expect(result.lost).toEqual([["f", "b"]]);
        }
        expect(gets).toBeGreaterThan(0);
      }),
  );
});
