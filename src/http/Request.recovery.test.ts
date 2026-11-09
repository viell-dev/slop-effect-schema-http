import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as Groups from "./internal/group.js";
import * as Inputs from "./internal/input.js";
import * as Shapes from "./internal/shape.js";
import * as Request from "./Request.js";

// https://github.com/viell-dev/slop-effect-schema-http/issues/143
describe("remaining group-field recovery", () => {
  const B = Schema.Struct({ b: Schema.String });
  const AC = Schema.Struct({ a: Schema.String, c: Schema.String });
  const input = { query: { a: "x", b: "y", c: "z" } };

  it.effect(
    "does not repeat the unchanged member order before trying an alternative",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const traced = (name: string) =>
          Schema.String.pipe(
            Schema.decodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transform((value) => {
                trace.push(name);
                return value;
              }),
            }),
          );
        const request = Request.get("/x").pipe(
          Request.query(
            Schema.Union([
              Schema.Struct({ b: traced("b") }),
              Schema.Struct({ a: traced("ac"), c: Schema.String }),
            ]),
          ),
          Request.query(B),
        );
        expect((yield* Request.compile(request, input)).request.url).toBe(
          "/x?a=x&c=z&b=y",
        );
        expect(trace).toEqual(["b", "ac"]);
      }),
  );

  it.effect(
    "recovers the original input and preserves the reordered whole-union control",
    () =>
      Effect.gen(function* () {
        const original = Request.get("/x").pipe(
          Request.query(Schema.Union([B, AC])),
          Request.query(B),
        );
        expect((yield* Request.compile(original, input)).request.url).toBe(
          "/x?a=x&c=z&b=y",
        );
        const reordered = Request.get("/x").pipe(
          Request.query(Schema.Union([AC, B])),
          Request.query(B),
        );
        expect((yield* Request.compile(reordered, input)).request.url).toBe(
          "/x?a=x&c=z&b=y",
        );
      }),
  );

  const Renamed = Schema.Struct({
    limit: Schema.optionalKey(Schema.String).pipe(
      Schema.withConstructorDefault(Effect.succeed("25")),
    ),
    other: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));

  it.effect(
    "refuses the original empty renamed default while accepting explicit aliases",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.query(Renamed),
          Request.setQuery("page_size", "5"),
        );
        expect(
          yield* Effect.flip(Request.compile(request, { query: {} })),
        ).toBeInstanceOf(Request.InvalidRequest);
        for (const query of [{ limit: "7" }, { page_size: "7" }])
          expect((yield* Request.compile(request, { query })).request.url).toBe(
            "/x?page_size=7",
          );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect(
    "currently misses a renamed generated default beside nonempty unrelated input",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.query(Renamed),
          Request.setQuery("page_size", "5"),
        );
        expect(
          (yield* Request.compile(request, { query: { other: "x" } })).request
            .url,
        ).toBe("/x?page_size=25&other=x");
        expect(
          (yield* Request.compile(request, {
            query: { other: "x", limit: "7" },
          })).request.url,
        ).toBe("/x?page_size=7&other=x");
      }),
  );

  for (const group of ["query", "headers"] as const) {
    it.effect(
      `recovers ${group} with the original full input and constructor priority`,
      () =>
        Effect.gen(function* () {
          const NumericAC = Schema.Struct({
            a: Schema.FiniteFromString,
            c: Schema.String,
          });
          const Union = Schema.Union([B, NumericAC, AC]);
          const request =
            group === "query"
              ? Request.get("/x").pipe(Request.query(Union), Request.query(B))
              : Request.get("/x").pipe(
                  Request.headers(Union),
                  Request.headers(B),
                );
          const compiled = yield* Request.compile(
            request as Request.Request<
              never,
              Schema.SchemaError | Request.InvalidRequest
            >,
            { [group]: { a: "01", b: "b", c: "c" } } as never,
          );
          expect(
            group === "query" ? compiled.request.url : compiled.headerLines,
          ).toEqual(
            group === "query"
              ? "/x?a=01&c=c&b=b"
              : [
                  ["a", "01"],
                  ["c", "c"],
                  ["b", "b"],
                ],
          );
        }),
    );
  }

  it.effect(
    "gives each applied occurrence its own certificate when reusing a factory",
    () =>
      Effect.gen(function* () {
        const Union = Schema.Union([Schema.Struct({ a: Schema.String }), B]);
        const bind = Request.query(Union);
        const request = Request.get("/x").pipe(bind, bind);
        expect(
          (yield* Request.compile(request, { query: { a: "a", b: "b" } }))
            .request.url,
        ).toBe("/x?b=b&a=a");
        const cleared = request.pipe(Request.unbind("query"), bind);
        expect(
          (yield* Request.compile(cleared, { query: { b: "b" } })).request.url,
        ).toBe("/x?b=b");
      }),
  );

  it.effect(
    "does not let two claims to b stand in for an actual holder of a and c",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.query(Schema.Union([B, Schema.Struct({ a: Schema.String })])),
          Request.query(Schema.Union([B, Schema.Struct({ c: Schema.String })])),
        );
        const failure = yield* Effect.flip(
          Request.compile(request, input as never),
        );
        expect(failure).toBeInstanceOf(Schema.SchemaError);
        expect(failure.message).toContain("The schema cannot keep this field");
      }),
  );

  it.effect(
    "rejects recovery that removes the sole certificate an inner binding already used",
    () =>
      Effect.gen(function* () {
        const Inner = Schema.Union([B, Schema.Struct({ x: Schema.String })]);
        const Outer = Schema.Union([
          Schema.Struct({
            b: Schema.String,
            x: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(Effect.succeed("generated-x")),
            ),
          }),
          AC,
        ]);
        const request = Request.get("/x").pipe(
          Request.query(Inner),
          Request.mapInput((value: typeof input) => ({
            query: { ...value.query, x: "caller-x" },
          })),
          Request.query(Outer),
        );
        const error = yield* Effect.flip(Request.compile(request, input));
        expect(error).toBeInstanceOf(Schema.SchemaError);
        expect(error.message).toContain('["a"]');
        expect(error.message).toContain('["c"]');
        expect(error.message).not.toContain("caller-x");
      }),
  );

  it.effect("requires exact caller keys even where header names fold", () =>
    Effect.gen(function* () {
      const Union = Schema.Union([B, AC]);
      const request = Request.get("/x").pipe(
        Request.headers(Union),
        Request.headers(
          Schema.Struct({ B: Schema.optionalKey(Schema.String) }),
        ),
      );
      const error = yield* Effect.flip(
        Request.compile(request, { headers: input.query }),
      );
      expect(error).toBeInstanceOf(Schema.SchemaError);
      expect(error.message).toContain('["a"]');
      expect(error.message).toContain('["c"]');
    }),
  );

  const bare = Schema.Union([B, AC]);
  for (const group of ["query", "headers"] as const) {
    const compile = (schema: typeof bare) =>
      group === "query"
        ? Request.compile(
            Request.get("/x").pipe(Request.query(schema), Request.query(B)),
            input,
          )
        : Request.compile(
            Request.get("/x").pipe(Request.headers(schema), Request.headers(B)),
            { headers: input.query },
          );
    for (const metadata of [
      "checks",
      "encoding checks",
      "context",
      "constructor default",
      "combined",
    ] as const) {
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.effect(`recovers ${group} while retaining parent ${metadata}`, () =>
        Effect.gen(function* () {
          const marker = Symbol("parent metadata");
          const annotations = { title: "validated choice", [marker]: {} };
          let defaults = 0;
          const context =
            metadata === "context" ||
            metadata === "constructor default" ||
            metadata === "combined"
              ? new SchemaAST.Context(
                  false,
                  false,
                  metadata === "context"
                    ? undefined
                    : Effect.sync(() => {
                        defaults++;
                        return { b: "default" };
                      }),
                  { title: "parent context" },
                )
              : undefined;
          const trace: string[] = [];
          const check = (side: string) =>
            Schema.makeFilter<typeof bare.Type>((value, ast) => {
              expect(ast.annotations).toBe(annotations);
              expect(ast.context).toBe(context);
              trace.push(`${side}:${Object.keys(value).join(",")}`);
              return true;
            });
          const schema = Schema.make<typeof bare>(
            new SchemaAST.Union(
              bare.ast.types,
              bare.ast.options,
              annotations,
              metadata === "checks" || metadata === "combined"
                ? [check("decoded")]
                : undefined,
              undefined,
              context,
              metadata === "encoding checks" || metadata === "combined"
                ? [check("encoded")]
                : undefined,
            ),
          );
          const compiled = yield* compile(schema);
          expect(
            group === "query" ? compiled.request.url : compiled.headerLines,
          ).toEqual(
            group === "query"
              ? "/x?a=x&c=z&b=y"
              : [
                  ["a", "x"],
                  ["c", "z"],
                  ["b", "y"],
                ],
          );
          if (metadata === "checks" || metadata === "combined")
            expect(trace).toContain("decoded:a,c");
          if (metadata === "encoding checks" || metadata === "combined")
            expect(trace).toContain("encoded:a,c");
          expect(defaults).toBe(0);
        }),
      );
    }
    for (const side of ["decoded", "encoded"] as const) {
      it.effect(
        `honors rejecting ${side} parent checks during ${group} recovery`,
        () =>
          Effect.gen(function* () {
            const trace: string[] = [];
            const guard = Schema.makeFilter<typeof bare.Type>((value) => {
              trace.push(Object.keys(value).join(","));
              return "b" in value;
            });
            const schema = Schema.make<typeof bare>(
              new SchemaAST.Union(
                bare.ast.types,
                undefined,
                undefined,
                side === "decoded" ? [guard] : undefined,
                undefined,
                undefined,
                side === "encoded" ? [guard] : undefined,
              ),
            );
            const failure = yield* Effect.flip(compile(schema));
            expect(failure).toBeInstanceOf(Schema.SchemaError);
            expect(failure.message).toContain('["a"]');
            expect(failure.message).toContain('["c"]');
            expect(trace).toContain("b");
            expect(trace).toContain("a,c");
          }),
      );
    }
    it.effect(
      `does not start ${group} recovery after initial parent validation fails`,
      () =>
        Effect.gen(function* () {
          const trace: string[] = [];
          const schema = bare.check(
            Schema.makeFilter((value) => {
              trace.push(Object.keys(value).join(","));
              return "a" in value;
            }),
          );
          expect(yield* Effect.flip(compile(schema))).toBeInstanceOf(
            Schema.SchemaError,
          );
          expect(trace.length).toBeGreaterThan(0);
          expect(trace.every((keys) => keys === "b")).toBe(true);
        }),
    );
    it.effect(`propagates a parent-check defect during ${group} recovery`, () =>
      Effect.gen(function* () {
        const defect = new Error("parent recovery defect");
        const schema = bare.check(
          Schema.makeFilter((value) => {
            if ("a" in value) throw defect;
            return true;
          }),
        );
        const exit = yield* Effect.exit(compile(schema));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
      }),
    );
  }
  for (const [name, schema] of [
    [
      "group transformation",
      bare.pipe(
        Schema.decodeTo(
          bare,
          SchemaTransformation.transform({
            decode: (value) => value,
            encode: (value) => value,
          }),
        ),
      ),
    ],
    [
      "oneOf",
      Schema.make<typeof bare>(
        new SchemaAST.Union(bare.ast.types, { mode: "oneOf" }),
      ),
    ],
    [
      "member rest",
      Schema.Union([
        B,
        Schema.StructWithRest(AC, [
          Schema.Record(Schema.String, Schema.String),
        ]),
      ]),
    ],
  ] as const) {
    it.effect(`keeps the recovery boundary for ${name}`, () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.query(schema),
          Request.query(B),
        );
        const result = yield* Effect.result(Request.compile(request, input));
        // The open member keeps everything on the ordinary strict path; other parents still refuse.
        if (name === "member rest") {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success")
            expect(result.success.request.url).toBe("/x?a=x&c=z&b=y");
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toBeInstanceOf(Schema.SchemaError);
        }
      }),
    );
  }

  it.effect(
    "keeps a checked-parent success in the already fitting member order",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const request = Request.get("/x").pipe(
          Request.query(
            Schema.Union([AC, B]).check(
              Schema.makeFilter((value) => {
                trace.push(Object.keys(value).join(","));
                return true;
              }),
            ),
          ),
          Request.query(B),
        );
        expect((yield* Request.compile(request, input)).request.url).toBe(
          "/x?a=x&c=z&b=y",
        );
        expect(trace).toEqual(["a,c", "a,c"]);
      }),
  );

  it.effect("does not recover nested losses", () =>
    Effect.gen(function* () {
      const Nested = Schema.Union([
        Schema.Struct({
          b: Schema.fromJsonString(
            Schema.Union([
              Schema.Struct({ x: Schema.String }),
              Schema.Struct({ y: Schema.String }),
            ]),
          ),
        }),
        AC,
      ]);
      const request = Request.get("/x").pipe(
        Request.query(Nested),
        Request.query(Schema.Struct({ a: Schema.String })),
      );
      const error = yield* Effect.flip(
        Request.compile(request, {
          query: { b: { x: "x", y: "y" }, a: "a", c: "c" },
        }),
      );
      expect(error).toBeInstanceOf(Schema.SchemaError);
      expect(error.message).toContain('["b"]["y"]');
    }),
  );

  it.effect("preserves caller overrides of raw defaults after recovery", () =>
    Effect.gen(function* () {
      for (const raw of ["b", "bad"]) {
        const request = Request.get("/x").pipe(
          Request.setQuery("b", raw),
          Request.query(bare),
          Request.query(Schema.Struct({ b: Schema.Literal("b") })),
        );
        expect(
          (yield* Request.compile(request, {
            query: { a: "a", b: "b", c: "c" },
          })).request.url,
        ).toBe("/x?a=a&c=c&b=b");
      }
    }),
  );

  it.effect("still validates a raw default left to the recovered member", () =>
    Effect.gen(function* () {
      const union = Schema.Union([
        B,
        Schema.Struct({
          ...AC.fields,
          d: Schema.optionalKey(Schema.FiniteFromString),
        }),
      ]);
      const base = Request.get("/x").pipe(
        Request.query(union),
        Request.query(B),
      );
      const good = yield* Request.compile(
        base.pipe(Request.setQuery("d", "2")),
        input,
      );
      expect(good.request.url).toBe("/x?a=x&c=z&d=2&b=y");
      const error = yield* Effect.flip(
        Request.compile(base.pipe(Request.setQuery("d", "bad")), input),
      );
      expect(error).toBeInstanceOf(Request.InvalidRequest);
      expect(error.message).toContain('"d"');
    }),
  );

  it("replaces only its own certificate and retains legacy Taken compatibility", () => {
    const first = {};
    const second = {};
    const legacy: Request.Taken = {
      fields: new Set(["a"]),
      settled: new Set(),
    };
    expect(Shapes.retaking(legacy, new Set(["b"]), first)).toBeUndefined();
    expect(Shapes.taking(legacy, new Set(["b"]), first).fields).toEqual(
      new Set(["a", "b"]),
    );
    let taken: Request.Taken = {
      fields: new Set(),
      settled: new Set(),
      certificates: new Map(),
    };
    taken = Shapes.taking(taken, new Set(["a"]), first);
    taken = Shapes.taking(taken, new Set(["a"]), second);
    const replaced = Shapes.retaking(taken, new Set(["b"]), first);
    expect(replaced?.fields).toEqual(new Set(["a", "b"]));
    expect(Shapes.certifiedElsewhere(replaced!, first)).toEqual(new Set(["a"]));
    expect(Shapes.retaking(replaced!, new Set(["b"]), second)).toBeUndefined();
  });

  it.effect(
    "keeps successful evaluation traces unchanged, including covered root losses",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const a = Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.transform((value) => {
              trace.push(`encode:${value}`);
              return value;
            }),
          }),
        );
        const union = Schema.Union([Schema.Struct({ a }), B]);
        const request = Request.get("/x").pipe(
          Request.query(union),
          Request.query(B),
        );
        expect(
          (yield* Request.compile(request, { query: { a: "a", b: "b" } }))
            .request.url,
        ).toBe("/x?a=a&b=b");
        expect(trace).toEqual(["encode:a"]);
      }),
  );

  it.effect(
    "skips a typed schema failure in a new attempt and never swallows defects",
    () =>
      Effect.gen(function* () {
        for (const defect of [false, true]) {
          let recovering = false;
          const boom = new Error("recovery defect");
          const a = Schema.String.pipe(
            Schema.decodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transformEffect((value: string) =>
                Effect.suspend(() =>
                  !recovering
                    ? Effect.succeed(value)
                    : defect
                      ? Effect.die(boom)
                      : Effect.fail(
                          new SchemaIssue.InvalidValue({
                            message: "retry failed",
                          }),
                        ),
                ),
              ),
            }),
          );
          const request = Request.get("/x").pipe(
            Request.query(B),
            Request.mapEffect((native) =>
              Effect.sync(() => {
                recovering = true;
                return native;
              }),
            ),
            Request.query(
              Schema.Union([B, Schema.Struct({ a, c: Schema.String }), AC]),
            ),
          );
          const result = yield* Effect.exit(Request.compile(request, input));
          if (defect) {
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result))
              expect(Cause.squash(result.cause)).toBe(boom);
          } else {
            expect(Exit.isSuccess(result)).toBe(true);
            if (Exit.isSuccess(result))
              expect(result.value.request.url).toBe("/x?b=y&a=x&c=z");
          }
        }
      }),
  );

  it.effect(
    "isolates recovery certificates, services and errors between concurrent evaluations",
    () =>
      Effect.gen(function* () {
        class Tenant extends Context.Service<Tenant, string>()(
          "recovery/Tenant",
        ) {}
        const a = Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.transformEffect((value: string) =>
              Effect.gen(function* () {
                const tenant = yield* Tenant;
                yield* Effect.promise(() => Promise.resolve());
                if (tenant === "bad")
                  return yield* Effect.fail(
                    new SchemaIssue.InvalidValue({ message: "tenant failed" }),
                  );
                return `${value}-${tenant}`;
              }),
            ),
          }),
        );
        const union = Schema.Union([B, Schema.Struct({ a, c: Schema.String })]);
        for (const schema of [
          union,
          union.check(Schema.makeFilter(() => true)),
        ]) {
          const request = Request.get("/x").pipe(
            Request.query(schema),
            Request.query(B),
          );
          const results = yield* Effect.all(
            ["one", "bad", "two"].map((tenant) =>
              Effect.result(Request.compile(request, input)).pipe(
                Effect.provideService(Tenant, tenant),
              ),
            ),
            { concurrency: "unbounded" },
          );
          expect(results.map((result) => result._tag)).toEqual([
            "Success",
            "Failure",
            "Success",
          ]);
          expect(results[0]).toMatchObject({
            success: { request: { url: "/x?a=x-one&c=z&b=y" } },
          });
          expect(results[2]).toMatchObject({
            success: { request: { url: "/x?a=x-two&c=z&b=y" } },
          });
        }
      }),
  );

  it.effect(
    "does not use iterable output or a legacy custom draft as recovery evidence",
    () =>
      Effect.gen(function* () {
        const token = {};
        const sibling = {};
        const taken: Request.Taken = {
          fields: new Set(["b"]),
          settled: new Set(),
          certificates: new Map([
            [token, new Set(["b"])],
            [sibling, new Set(["b"])],
          ]),
        };
        const { taken: claim } = Shapes.bind(bare, (name) => name);
        const original = { output: { b: "y" }, lost: [["a"], ["c"]] };
        const recover = Groups.recovery(bare);
        const iterableOutput = {
          ...original.output,
          [Symbol.iterator]: () => {
            throw new Error("must not iterate");
          },
        };
        expect(
          yield* recover(
            input.query,
            { ...original, output: iterableOutput },
            taken,
            token,
            claim,
          ),
        ).toBeUndefined();
        const legacy: Request.Taken = {
          fields: taken.fields,
          settled: taken.settled,
        };
        expect(
          yield* recover(input.query, original, legacy, token, claim),
        ).toBeUndefined();
        expect(
          (yield* recover(input.query, original, taken, token, claim))?.reading
            .output,
        ).toEqual({ a: "x", c: "z" });
      }),
  );

  it("excludes transformed members, open members and iterable members", () => {
    const transformedMember = Schema.Union([
      B,
      AC.pipe(Schema.encodeKeys({ a: "a" })),
    ]);
    const open = Schema.Union([
      B,
      Schema.StructWithRest(AC, [Schema.Record(Schema.String, Schema.String)]),
    ]);
    const iterable = Schema.Union([
      B,
      Schema.Struct({
        ...AC.fields,
        [Symbol.iterator]: Schema.optionalKey(Schema.Unknown),
      }),
    ]);
    for (const schema of [transformedMember, open, iterable])
      expect(Inputs.reorderedReaders(schema)).toEqual([]);
  });

  it.effect(
    "rejects a retry that introduces a nested loss after an initial root-only loss",
    () =>
      Effect.gen(function* () {
        const a = Schema.fromJsonString(
          Schema.Union([
            Schema.Struct({ x: Schema.String }),
            Schema.Struct({ y: Schema.String }),
          ]),
        );
        const request = Request.get("/x").pipe(
          Request.query(
            Schema.Union([B, Schema.Struct({ a, c: Schema.String })]),
          ),
          Request.query(B),
        );
        const error = yield* Effect.flip(
          Request.compile(request, {
            query: { a: { x: "x", y: "y" }, b: "b", c: "c" },
          }),
        );
        expect(error).toBeInstanceOf(Schema.SchemaError);
        expect(error.message).toContain('["a"]');
        expect(error.message).toContain('["c"]');
        expect(error.message).not.toContain('["a"]["y"]');
      }),
  );
});
