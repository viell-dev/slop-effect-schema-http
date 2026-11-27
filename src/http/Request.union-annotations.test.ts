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
} from "effect";
import * as Inputs from "./internal/input.js";
import * as Request from "./Request.js";

const B = Schema.Struct({ b: Schema.String });
const AC = Schema.Struct({ a: Schema.String, c: Schema.String });
const given = { a: "x", b: "y", c: "z" };
const annotations = [
  { title: "Customer filters" },
  { description: "Fields retained across bindings" },
  {
    title: "Customer filters",
    description: "Visible filter fields",
    identifier: "Filters",
    expected: "customer filters",
    examples: [{ a: "x", c: "z" }],
  },
] as const;

// https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726559103
describe("annotated whole-union recovery", () => {
  for (const group of ["query", "headers"] as const) {
    for (const unionFirst of [true, false]) {
      it.effect(`keeps annotated ${group}, union first ${unionFirst}`, () =>
        Effect.gen(function* () {
          for (const metadata of annotations) {
            const union = Schema.Union([B, AC]).annotate(metadata);
            const result = yield* group === "query"
              ? Request.compile(
                  unionFirst
                    ? Request.get("/x").pipe(
                        Request.query(union),
                        Request.query(B),
                      )
                    : Request.get("/x").pipe(
                        Request.query(B),
                        Request.query(union),
                      ),
                  { query: given },
                )
              : Request.compile(
                  unionFirst
                    ? Request.get("/x").pipe(
                        Request.headers(union),
                        Request.headers(B),
                      )
                    : Request.get("/x").pipe(
                        Request.headers(B),
                        Request.headers(union),
                      ),
                  { headers: given },
                );
            if (group === "query")
              expect(
                Object.fromEntries(
                  new URL(result.request.url, "https://probe.invalid")
                    .searchParams,
                ),
              ).toEqual(given);
            else expect(result.request.headers).toEqual(given);
          }
        }),
      );
    }
  }

  it.effect(
    "retains diagnostic annotations and unfamiliar metadata by identity",
    () =>
      Effect.gen(function* () {
        const marker = Symbol("annotation marker");
        const metadata = {
          expected: "customer filter alternatives",
          custom: { keep: "same object" },
          [marker]: { keep: "symbol metadata" },
        };
        const base = Schema.Union([B, AC]);
        const annotated = Schema.make<typeof base>(
          new SchemaAST.Union(base.ast.types, undefined, metadata),
        );
        const readers = Inputs.reorderedReaders(annotated);
        expect(readers).toHaveLength(1);
        const error = yield* Effect.flip(readers[0]!(0 as never));
        if (error._tag !== "SchemaError") throw error;
        expect(error.issue._tag).toBe("AnyOf");
        if (error.issue._tag === "AnyOf") {
          expect(error.issue.ast.annotations).toBe(metadata);
          expect(
            Object.getOwnPropertyDescriptor(
              error.issue.ast.annotations!,
              marker,
            )?.value,
          ).toBe(metadata[marker]);
        }
        expect(error.message).toContain("customer filter alternatives");
      }),
  );

  it.effect("leaves an already successful read's evaluations unchanged", () =>
    Effect.gen(function* () {
      const run = (annotated: boolean) =>
        Effect.gen(function* () {
          const trace: string[] = [];
          const a = Schema.String.pipe(
            Schema.decodeTo(Schema.String, {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transform((value) => {
                trace.push(value);
                return value;
              }),
            }),
          );
          const base = Schema.Union([
            Schema.Struct({ a, c: Schema.String }),
            B,
          ]);
          const schema = annotated ? base.annotate(annotations[0]!) : base;
          const result = yield* Request.compile(
            Request.get("/x").pipe(Request.query(schema), Request.query(B)),
            { query: given },
          );
          return { url: result.request.url, trace };
        });
      const before = yield* run(false);
      expect(before).toEqual({ url: "/x?a=x&c=z&b=y", trace: ["x"] });
      expect(yield* run(true)).toEqual(before);
    }),
  );

  it.effect(
    "keeps whole-union constructor priority with an ambiguous field",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Union([
          B,
          Schema.Struct({ a: Schema.FiniteFromString, c: Schema.String }),
          AC,
        ]).annotate(annotations[0]!);
        const result = yield* Request.compile(
          Request.get("/x").pipe(Request.query(schema), Request.query(B)),
          { query: { ...given, a: "01" } },
        );
        expect(result.request.url).toBe("/x?a=01&c=z&b=y");
      }),
  );

  it.effect("does not let annotations excuse a nested loss", () =>
    Effect.gen(function* () {
      const schema = Schema.Union([
        B,
        Schema.Struct({
          a: Schema.fromJsonString(
            Schema.Union([
              Schema.Struct({ x: Schema.String }),
              Schema.Struct({ y: Schema.String }),
            ]),
          ),
          c: Schema.String,
        }),
      ]).annotate({
        ...annotations[0],
        parseOptions: { onExcessProperty: "ignore" },
      });
      const error = yield* Effect.flip(
        Request.compile(
          Request.get("/x").pipe(Request.query(schema), Request.query(B)),
          { query: { ...given, a: { x: "x", y: "private value" } } },
        ),
      );
      expect(error).toBeInstanceOf(Schema.SchemaError);
      expect(error.message).toContain('["a"]');
      expect(error.message).not.toContain("private value");
    }),
  );

  for (const defect of [false, true]) {
    it.effect(`retains retry error behavior, defect ${defect}`, () =>
      Effect.gen(function* () {
        const boom = new Error("annotated member defect");
        const a = Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.passthrough(),
            encode: SchemaGetter.transformEffect(() =>
              defect
                ? Effect.die(boom)
                : Effect.fail(
                    new SchemaIssue.InvalidValue({ message: "unavailable" }),
                  ),
            ),
          }),
        );
        const schema = Schema.Union([
          B,
          Schema.Struct({ a, c: Schema.String }),
        ]).annotate(annotations[0]!);
        const result = yield* Effect.exit(
          Request.compile(
            Request.get("/x").pipe(Request.query(schema), Request.query(B)),
            { query: given },
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause);
          if (defect) expect(error).toBe(boom);
          else {
            expect(error).toBeInstanceOf(Schema.SchemaError);
            expect(String(error)).toContain('["a"]');
            expect(String(error)).not.toContain("unavailable");
          }
        }
      }),
    );
  }

  it.effect("keeps services and errors separate between concurrent reads", () =>
    Effect.gen(function* () {
      class Tenant extends Context.Service<Tenant, string>()(
        "annotated/Tenant",
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
      const schema = Schema.Union([
        B,
        Schema.Struct({ a, c: Schema.String }),
      ]).annotate(annotations[0]!);
      const request = Request.get("/x").pipe(
        Request.query(schema),
        Request.query(B),
      );
      const results = yield* Effect.all(
        ["one", "bad", "two"].map((tenant) =>
          Effect.result(Request.compile(request, { query: given })).pipe(
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
      const urls = results.map((result) =>
        result._tag === "Success" ? result.success.request.url : undefined,
      );
      expect(urls).toEqual([
        "/x?a=x-one&c=z&b=y",
        undefined,
        "/x?a=x-two&c=z&b=y",
      ]);
    }),
  );
});

// Recording a read's failure to explain a refusal must not run the schema's steps. These traces
// are those from before #275's messages, whose recorded loose read ran even where no route read.
// https://github.com/viell-dev/slop-effect-schema-http/issues/317
describe("check runs of an annotated union beside a sibling", () => {
  const names = {
    query: { a: "a", b: "b", c: "c" },
    headers: { a: "X-A", b: "X-B", c: "X-C" },
  } as const;
  for (const group of ["query", "headers"] as const)
    for (const [members, runs] of [
      ["wider first", 7],
      ["narrower first", 12],
    ] as const)
      for (const unionFirst of [true, false])
        it.effect(
          `keeps the check runs of an annotated ${group} union, ${members}, union first ${unionFirst}`,
          () =>
            Effect.gen(function* () {
              const name = names[group];
              const checks: Array<string> = [];
              const wide = Schema.Struct({
                [name.a]: Schema.String,
                [name.c]: Schema.String.check(
                  Schema.makeFilter((value) => {
                    checks.push(value);
                    return true;
                  }),
                ),
              });
              const narrow = Schema.Struct({ [name.b]: Schema.String });
              const union = Schema.Union(
                members === "wider first" ? [wide, narrow] : [narrow, wide],
              ).annotate(annotations[0]!);
              const input = { [name.a]: "x /+", [name.b]: "y", [name.c]: "z" };
              const result = yield* group === "query"
                ? Request.compile(
                    unionFirst
                      ? Request.get("/x").pipe(
                          Request.query(union),
                          Request.query(narrow),
                        )
                      : Request.get("/x").pipe(
                          Request.query(narrow),
                          Request.query(union),
                        ),
                    { query: input },
                  )
                : Request.compile(
                    unionFirst
                      ? Request.get("/x").pipe(
                          Request.headers(union),
                          Request.headers(narrow),
                        )
                      : Request.get("/x").pipe(
                          Request.headers(narrow),
                          Request.headers(union),
                        ),
                    { headers: input },
                  );
              if (group === "query")
                expect(result.request.url).toBe(
                  unionFirst
                    ? "/x?a=x%20%2F%2B&c=z&b=y"
                    : "/x?b=y&a=x%20%2F%2B&c=z",
                );
              else
                expect(result.request.headers).toEqual({
                  "x-a": "x /+",
                  "x-b": "y",
                  "x-c": "z",
                });
              expect(checks).toEqual(Array<string>(runs).fill("z"));
            }),
        );
});
