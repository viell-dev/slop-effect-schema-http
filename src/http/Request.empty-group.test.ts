import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import * as Shapes from "./internal/shape.js";
import * as Request from "./Request.js";
import type * as Transport from "./Transport.js";

const compile = (
  request: Request.Request<never, Schema.SchemaError | Request.InvalidRequest>,
  input: unknown,
) => Request.compile(request, input as never);

// https://github.com/viell-dev/slop-effect-schema-http/issues/143
describe("preparation proof from a strictly empty transformed group", () => {
  const Base = Schema.Struct({
    limit: Schema.optionalKey(Schema.String).pipe(
      Schema.withConstructorDefault(Effect.succeed("25")),
    ),
    other: Schema.optionalKey(Schema.String),
  });
  const Renamed = Base.pipe(Schema.encodeKeys({ limit: "page_size" }));

  for (const group of ["query", "headers"] as const) {
    const bind =
      <
        S extends Schema.Top &
          Schema.ConstraintCodec<unknown, Transport.HeaderInput, never, never>,
      >(
        schema: S,
      ) =>
      (
        self: Request.Request<
          never,
          Schema.SchemaError | Request.InvalidRequest
        >,
      ): Request.Request<never, Schema.SchemaError | Request.InvalidRequest> =>
        group === "query"
          ? self.pipe(Request.query(schema))
          : self.pipe(Request.headers(schema));
    const set = group === "query" ? Request.setQuery : Request.setHeader;
    const append =
      group === "query" ? Request.appendQuery : Request.appendHeader;
    const remove =
      group === "query" ? Request.removeQuery : Request.removeHeader;
    const name = group === "query" ? "page_size" : "PAGE_SIZE";
    const output = (compiled: Request.Compiled) =>
      group === "query" ? compiled.request.url : compiled.headerLines;
    const expected = (value: string) =>
      group === "query" ? `/x?page_size=${value}` : [["page_size", value]];

    it.effect(
      `refuses all replaced ${group} edits for absent, undefined, plain and null-prototype groups`,
      () =>
        Effect.gen(function* () {
          for (const edit of [
            set(name, "secret"),
            append(name, "secret"),
            remove(name),
            remove(name, "secret"),
            set({ [name]: undefined }),
          ]) {
            const request = Request.get("/x").pipe(bind(Renamed), edit);
            for (const input of [
              {},
              { [group]: undefined },
              { [group]: {} },
              { [group]: Object.create(null) },
            ]) {
              const failure = yield* Effect.flip(compile(request, input));
              expect(failure).toBeInstanceOf(Request.InvalidRequest);
              expect(failure.message).toContain('"page_size"');
              expect(failure.message).toContain("Schema preparation");
              expect(JSON.stringify(failure)).not.toContain("secret");
            }
          }
        }),
    );

    it.effect(
      `keeps explicit ${group} aliases, earlier defaults, mapInput, stacks, reuse and unbind`,
      () =>
        Effect.gen(function* () {
          const binding = bind(Renamed);
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
          const mapped = request.pipe(
            Request.mapInput(
              (input: { value: string }) =>
                ({ [group]: { limit: input.value } }) as never,
            ),
          );
          expect(output(yield* compile(mapped, { value: "7" }))).toEqual(
            expected("7"),
          );
          const stacked = request.pipe(
            bind(Schema.Struct({ other: Schema.optionalKey(Schema.String) })),
          );
          expect(yield* Effect.flip(compile(stacked, {}))).toBeInstanceOf(
            Request.InvalidRequest,
          );
          const cleared = request.pipe(Request.unbind(group));
          expect(output(yield* compile(cleared, undefined))).toEqual(
            group === "query" ? "/x?page_size=5" : [[name, "5"]],
          );
          expect(output(yield* compile(cleared.pipe(binding), {}))).toEqual(
            expected("25"),
          );
          const reused = request.pipe(
            Request.mapInput(() => ({ [group]: { limit: "7" } }) as never),
            binding,
          );
          expect(output(yield* compile(reused, {}))).toEqual(expected("25"));
        }),
    );

    it.effect(
      `retains the broader ${group} limit whenever any own key was supplied`,
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(bind(Renamed), remove(name));
          for (const value of [
            { other: "x" },
            { unknown: "x" },
            { limit: undefined },
            Object.defineProperty({}, "hidden", { value: "x" }),
            { [Symbol("unrelated")]: "x" },
          ]) {
            const result = output(yield* compile(request, { [group]: value }));
            expect(
              group === "query" ? result : JSON.stringify(result),
            ).toContain("25");
          }
        }),
    );

    it.effect(
      `adds no schema callback evaluations to the empty ${group} proof`,
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
          const base = Request.get("/x").pipe(bind(Counted));
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
  }

  it.effect(
    "checks every decoded and encoded endpoint name, including inherited toString",
    () =>
      Effect.gen(function* () {
        let encodes = 0;
        const Inherited = Schema.Struct({
          toString: Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.optionalKey(Schema.Unknown), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.transform((value) => {
                encodes++;
                return String(value);
              }),
            }),
          ),
        }).pipe(Schema.encodeKeys({ toString: "page_size" }));
        const base = Request.get("/x").pipe(Request.query(Inherited));
        const plain = yield* Request.compile(base, { query: {} });
        const baseline = encodes;
        encodes = 0;
        const edited = yield* Request.compile(
          base.pipe(Request.removeQuery("page_size")),
          { query: {} },
        );
        expect(edited.request.url).toBe(plain.request.url);
        expect(decodeURIComponent(edited.request.url)).toContain(
          "function toString()",
        );
        expect(encodes).toBe(baseline);
        // Effect 4.1.3 omits this absent builtin name; older peers encode String(undefined).
        // Only an actual generated field can contradict its raw removal.
        const absent = yield* Inherited.makeEffect(Object.create(null));
        const written = yield* Schema.encodeEffect(Inherited)(absent);
        const removed = Request.compile(
          base.pipe(Request.removeQuery("page_size")),
          { query: Object.create(null) },
        );
        if (Object.hasOwn(written, "page_size")) {
          expect(written.page_size).toBe("undefined");
          expect(yield* Effect.flip(removed)).toBeInstanceOf(
            Request.InvalidRequest,
          );
        } else {
          expect(written).toEqual({});
          expect((yield* removed).request.url).toBe("/x");
        }
      }),
  );

  it("snapshots all endpoint symbols and excludes accessors or inherited presence without reads", () => {
    const key = Symbol("endpoint");
    const WithSymbol = Schema.Struct({
      ...Base.fields,
      [key]: Schema.optionalKey(Schema.Unknown),
    }).pipe(Schema.encodeKeys({ limit: "page_size" }));
    const { candidates, filled } = Shapes.bind(WithSymbol, (name) => name);
    const edits = new Set(["page_size"]);
    expect(candidates({}, edits)).toEqual(["page_size"]);
    expect(candidates({}, new Set([String(key)]))).toEqual([]);
    let reads = 0;
    const input = Object.create({ [key]: undefined });
    expect(candidates(input, edits)).toEqual([]);
    const accessor = Object.defineProperty({}, key, {
      get: () => {
        reads++;
        return undefined;
      },
    });
    expect(candidates(accessor, edits)).toEqual([]);
    // oxlint-disable-next-line no-extend-native -- Exercise an ordinary object's inherited endpoint symbol, then restore it.
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get: () => {
        reads++;
        return undefined;
      },
    });
    try {
      expect(candidates({}, edits)).toEqual([]);
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
    const output = Object.defineProperty({}, "page_size", {
      enumerable: true,
      get: () => {
        reads++;
        return "25";
      },
    });
    expect(filled(["page_size"], output)).toEqual([]);
    expect(
      filled(["page_size"], {
        page_size: "25",
        [Symbol.iterator]: () => {
          throw new Error("iterator was read");
        },
      }),
    ).toEqual([]);
    expect(reads).toBe(0);
  });

  it.effect(
    "follows the encoded endpoint through multiple object transformation stages",
    () =>
      Effect.gen(function* () {
        const Wire = Schema.Struct({
          page_size: Schema.optionalKey(Schema.String),
        });
        const Middle = Schema.Struct({
          middle: Schema.optionalKey(Schema.String),
        });
        const stages = Wire.pipe(
          Schema.decodeTo(
            Middle,
            SchemaTransformation.transform({
              decode: ({ page_size }) =>
                page_size === undefined ? {} : { middle: page_size },
              encode: ({ middle }) =>
                middle === undefined ? {} : { page_size: middle },
            }),
          ),
          Schema.decodeTo(
            Base,
            SchemaTransformation.transform({
              decode: ({ middle }) =>
                middle === undefined ? {} : { limit: middle },
              encode: ({ limit }) =>
                limit === undefined ? {} : { middle: limit },
            }),
          ),
        );
        const request = Request.get("/x").pipe(
          Request.query(stages),
          Request.removeQuery("page_size"),
        );
        expect(yield* Effect.flip(Request.compile(request, {}))).toBeInstanceOf(
          Request.InvalidRequest,
        );
        expect(
          (yield* Request.compile(request, { query: { limit: "7" } })).request
            .url,
        ).toBe("/x?page_size=7");
      }),
  );

  it.effect(
    "does not call an empty endpoint's passthrough output generated when any caller key exists",
    () =>
      Effect.gen(function* () {
        const Empty = Schema.Struct({}).pipe(
          Schema.decodeTo(
            Schema.Struct({}),
            SchemaTransformation.transform({
              decode: (value) => value,
              encode: (value) => value,
            }),
          ),
        );
        const { candidates } = Shapes.bind(Empty, (name) => name);
        expect(candidates({ caller: "x" }, new Set(["caller"]))).toEqual([]);
        expect(
          (yield* Request.compile(
            Request.get("/x").pipe(Request.query(Empty)),
            { query: { caller: "x" } },
          )).request.url,
        ).toBe("/x?caller=x");
      }),
  );

  it.effect(
    "snapshots empty eligibility before callbacks add or remove caller keys",
    () =>
      Effect.gen(function* () {
        for (const initiallyEmpty of [true, false]) {
          const query: Record<string, unknown> = initiallyEmpty
            ? {}
            : { caller: "x" };
          const Changed = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.optionalKey(Schema.String), {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.withDefault(
                  Effect.sync(() => {
                    if (initiallyEmpty) query.caller = "x";
                    else delete query.caller;
                    return "25";
                  }),
                ),
              }),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const request = Request.get("/x").pipe(
            Request.query(Changed),
            Request.removeQuery("page_size"),
          );
          if (initiallyEmpty)
            expect(
              yield* Effect.flip(compile(request, { query })),
            ).toBeInstanceOf(Request.InvalidRequest);
          else
            expect((yield* compile(request, { query })).request.url).toBe(
              "/x?page_size=25",
            );
        }
      }),
  );

  it.effect(
    "requires an actual output value, preserving omission, undefined and failed defaults",
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
          Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(
              Effect.fail(
                new SchemaIssue.InvalidValue({ message: "failed default" }),
              ),
            ),
          ),
        ]) {
          const schema = Schema.Struct({ limit }).pipe(
            Schema.encodeKeys({ limit: "page_size" }),
          );
          const request = Request.get("/x").pipe(
            Request.query(schema),
            Request.removeQuery("page_size"),
          );
          expect((yield* compile(request, {})).request.url).toBe("/x");
        }
      }),
  );

  it.effect(
    "excludes iterable transformed output without rerunning its iterator",
    () =>
      Effect.gen(function* () {
        let iterations = 0;
        const Iterable = Schema.Struct({
          limit: Base.fields.limit,
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
        const base = Request.get("/x").pipe(Request.query(Iterable));
        expect((yield* Request.compile(base, {})).request.url).toBe("/x");
        const baseline = iterations;
        expect(baseline).toBeGreaterThan(0);
        iterations = 0;
        expect(
          (yield* Request.compile(
            base.pipe(Request.removeQuery("page_size")),
            {},
          )).request.url,
        ).toBe("/x");
        expect(iterations).toBe(baseline);
      }),
  );
});
