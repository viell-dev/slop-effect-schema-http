import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import * as Request from "./Request.js";
import type * as Transport from "./Transport.js";

type Checked = Request.Request<
  never,
  Schema.SchemaError | Request.InvalidRequest
>;
const compile = (request: Checked, input: unknown) =>
  Request.compile(request, input as never);

// https://github.com/viell-dev/slop-effect-schema-http/issues/143
describe("raw edits after schema preparation supplies a field", () => {
  const Defaulted = Schema.Struct({
    limit: Schema.optionalKey(Schema.String).pipe(
      Schema.withConstructorDefault(Effect.succeed("25")),
    ),
  });

  it.effect(
    "refuses a query edit the successful constructor and encoder replace",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Defaulted),
          Request.setQuery("limit", "secret"),
        );
        const error = yield* Effect.flip(Request.compile(request, {}));
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.message).toContain('"limit"');
        expect(error.message).not.toContain("secret");
      }),
  );

  it.effect(
    "refuses a header removal the successful constructor and encoder replace",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.headers(Defaulted),
          Request.removeHeader("LIMIT"),
        );
        const error = yield* Effect.flip(Request.compile(request, {}));
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.message).toContain('"limit"');
      }),
  );

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
    const name = group === "query" ? "limit" : "LIMIT";
    const entries = (result: Request.Compiled) =>
      group === "query" ? result.request.url : result.headerLines;
    const expected = (value: string) =>
      group === "query" ? `/things?limit=${value}` : [["limit", value]];

    it.effect(
      `refuses all ${group} edits replaced by a handwritten decoding default`,
      () =>
        Effect.gen(function* () {
          let defaults = 0;
          let encodes = 0;
          const Handwritten = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.withDefault(
                  Effect.sync(() => {
                    defaults++;
                    return "secret-default";
                  }),
                ),
                encode: SchemaGetter.transform((value) => {
                  encodes++;
                  return `${value}!`;
                }),
              }),
            ),
          });
          for (const edit of [
            set(name, "secret-edit"),
            append(name, "secret-edit"),
            remove(name),
            remove(name, "secret-edit"),
            set({ [name]: undefined }),
          ]) {
            for (const input of [{}, { [group]: {} }]) {
              const beforeDefaults = defaults;
              const beforeEncodes = encodes;
              const error = yield* Effect.flip(
                compile(
                  Request.get("/things").pipe(bind(Handwritten), edit),
                  input,
                ),
              );
              expect(error).toBeInstanceOf(Request.InvalidRequest);
              expect(error.message).toContain('"limit"');
              expect(error.message).toContain("Schema preparation");
              expect(error.cause).toBeUndefined();
              expect(JSON.stringify(error)).not.toContain("secret");
              expect(defaults - beforeDefaults).toBe(1);
              expect(encodes - beforeEncodes).toBe(1);
            }
          }
          const before = Request.get("/things").pipe(
            set(name, "5"),
            bind(Handwritten),
          );
          expect(entries(yield* compile(before, {}))).toEqual(
            expected("secret-default!"),
          );
          const after = Request.get("/things").pipe(
            bind(Handwritten),
            set(name, "5"),
          );
          expect(
            entries(yield* compile(after, { [group]: { limit: "7" } })),
          ).toEqual(expected("7!"));
          // This handwritten default fills a missing key, but does not accept explicit undefined.
          expect(
            yield* Effect.flip(
              compile(after, { [group]: { limit: undefined } }),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
        }),
    );

    it.effect(
      `refuses an encode-only generated ${group} field without decoded evidence`,
      () =>
        Effect.gen(function* () {
          let calls = 0;
          const EncodeOnly = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.optionalKey(Schema.String), {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.withDefault(
                  Effect.sync(() => {
                    calls++;
                    return "25";
                  }),
                ),
              }),
            ),
          });
          const request = Request.get("/things").pipe(
            bind(EncodeOnly),
            remove(name),
          );
          expect(yield* Effect.flip(compile(request, {}))).toBeInstanceOf(
            Request.InvalidRequest,
          );
          expect(calls).toBe(1);
          expect(
            entries(yield* compile(request, { [group]: { limit: "7" } })),
          ).toEqual(expected("7"));
          expect(calls).toBe(1);
        }),
    );

    it.effect(
      `refuses a generated ${group} field written after whole-decoder fallback`,
      () =>
        Effect.gen(function* () {
          let defaults = 0;
          let encodes = 0;
          const WholeDecoder = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.withDefault(
                  Effect.sync(() => {
                    defaults++;
                    return "25";
                  }),
                ),
                encode: SchemaGetter.transform((value) => {
                  encodes++;
                  return `${value}!`;
                }),
              }),
            ),
            page: Schema.FiniteFromString,
          });
          const request = Request.get("/things").pipe(
            bind(WholeDecoder),
            set(name, "5"),
          );
          expect(
            yield* Effect.flip(compile(request, { [group]: { page: "1" } })),
          ).toBeInstanceOf(Request.InvalidRequest);
          expect(defaults).toBe(1);
          expect(encodes).toBe(1);
        }),
    );

    it.effect(
      `allows ${group} removal when a handwritten default is omitted or undefined on output`,
      () =>
        Effect.gen(function* () {
          const Omitted = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.withDefault(Effect.succeed("25")),
                encode: SchemaGetter.omit(),
              }),
            ),
          });
          const Undefined = Schema.Struct({
            limit: Schema.optionalKey(Schema.UndefinedOr(Schema.String)).pipe(
              Schema.decodeTo(
                Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
                {
                  decode: SchemaGetter.passthrough(),
                  encode: SchemaGetter.withDefault<string | undefined>(
                    Effect.succeed(undefined),
                  ),
                },
              ),
            ),
          });
          for (const schema of [Omitted, Undefined]) {
            const result = yield* compile(
              Request.get("/things").pipe(bind(schema), remove(name)),
              {},
            );
            expect(entries(result)).toEqual(group === "query" ? "/things" : []);
          }
        }),
    );

    it.effect(
      `keeps iterable ${group} output and does not evaluate its iterator for proof`,
      () =>
        Effect.gen(function* () {
          const handwritten = Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.String, {
              decode: SchemaGetter.withDefault(Effect.succeed("25")),
              encode: SchemaGetter.transform((value) => `${value}!`),
            }),
          );
          for (const limit of [Defaulted.fields.limit, handwritten]) {
            let iterations = 0;
            const Iterable = Schema.Struct({
              limit,
              [Symbol.iterator]: Schema.declare(
                (value): value is () => Generator<readonly [string, string]> =>
                  typeof value === "function",
              ),
            });
            const input = {
              [group]: {
                [Symbol.iterator]: function* () {
                  iterations++;
                  yield* [];
                },
              },
            };
            const base = Request.get("/things").pipe(bind(Iterable));
            expect(entries(yield* compile(base, input))).toEqual(
              group === "query" ? "/things" : [],
            );
            const baseline = iterations;
            expect(baseline).toBeGreaterThan(0);
            iterations = 0;
            expect(
              entries(yield* compile(base.pipe(remove(name)), input)),
            ).toEqual(group === "query" ? "/things" : []);
            expect(iterations).toBe(baseline);
          }
        }),
    );

    it.effect(`keeps ${group} name comparisons exact to the group`, () =>
      Effect.gen(function* () {
        const Generated = Schema.Struct({
          limit: Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.optionalKey(Schema.String), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.withDefault(Effect.succeed("25")),
            }),
          ),
          LIMIT: Schema.optionalKey(Schema.String),
        });
        const request = Request.get("/things").pipe(
          bind(Generated),
          remove("LIMIT"),
        );
        if (group === "headers") {
          expect(yield* Effect.flip(compile(request, {}))).toBeInstanceOf(
            Request.InvalidRequest,
          );
        } else {
          expect(entries(yield* compile(request, {}))).toEqual(expected("25"));
        }
      }),
    );

    it.effect(`records every kind of post-binding ${group} edit`, () =>
      Effect.gen(function* () {
        for (const edit of [
          set(name, "secret"),
          append(name, "secret"),
          remove(name),
          remove(name, "secret"),
          set({ [name]: undefined }),
        ]) {
          const request = Request.get("/things").pipe(bind(Defaulted), edit);
          for (const input of [
            {},
            { [group]: {} },
            { [group]: { limit: undefined } },
          ]) {
            const error = yield* Effect.flip(compile(request, input));
            expect(error).toBeInstanceOf(Request.InvalidRequest);
            expect(error.message).toContain("Schema preparation");
            expect(error.message).toContain('"limit"');
            expect(error.cause).toBeUndefined();
            expect(JSON.stringify(error)).not.toContain("secret");
          }
        }
      }),
    );

    it.effect(
      `keeps earlier raw ${group} defaults and explicit caller overrides`,
      () =>
        Effect.gen(function* () {
          const before = Request.get("/things").pipe(
            set(name, "5"),
            bind(Defaulted),
          );
          expect(entries(yield* compile(before, {}))).toEqual(expected("25"));
          const after = Request.get("/things").pipe(
            bind(Defaulted),
            set(name, "5"),
          );
          expect(
            entries(yield* compile(after, { [group]: { limit: "7" } })),
          ).toEqual(expected("7"));
        }),
    );

    it.effect(
      `does not reevaluate an undefined-producing ${group} default`,
      () =>
        Effect.gen(function* () {
          let calls = 0;
          const UndefinedDefault = Schema.Struct({
            limit: Schema.optionalKey(Schema.UndefinedOr(Schema.String)).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  calls++;
                  return undefined;
                }),
              ),
            ),
          });
          const request = Request.get("/things").pipe(
            bind(UndefinedDefault),
            set(name, "5"),
          );
          expect(calls).toBe(0);
          expect(entries(yield* compile(request, {}))).toEqual(expected("5"));
          expect(calls).toBe(1);
        }),
    );

    it.effect(
      `does not treat a failed ${group} default as successful construction`,
      () =>
        Effect.gen(function* () {
          let calls = 0;
          const FailedDefault = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(
                Effect.suspend(() => {
                  calls++;
                  return Effect.fail(
                    new SchemaIssue.InvalidValue({ message: "default failed" }),
                  );
                }),
              ),
            ),
          });
          const request = Request.get("/things").pipe(
            bind(FailedDefault),
            set(name, "5"),
          );
          expect(calls).toBe(0);
          expect(entries(yield* compile(request, {}))).toEqual(expected("5"));
          expect(calls).toBe(1);
        }),
    );

    it.effect(
      `does not reuse ${group} construction from a failed sibling parse`,
      () =>
        Effect.gen(function* () {
          let calls = 0;
          const Fallback = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  calls++;
                  return "25";
                }),
              ),
            ),
            page: Schema.FiniteFromString,
          });
          const request = Request.get("/things").pipe(
            bind(Fallback),
            set(name, "5"),
          );
          const result = yield* compile(request, { [group]: { page: "1" } });
          expect(
            group === "query"
              ? result.request.url
              : result.request.headers.limit,
          ).toBe(group === "query" ? "/things?limit=5&page=1" : "5");
          expect(calls).toBe(1);
        }),
    );

    it.effect(
      `refuses a ${group} edit replaced after fieldwise fallback without extra default calls`,
      () =>
        Effect.gen(function* () {
          let calls = 0;
          const Mixed = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  calls++;
                  return "25";
                }),
              ),
            ),
            a: Schema.FiniteFromString,
            b: Schema.FiniteFromString,
          });
          const request = Request.get("/things").pipe(
            bind(Mixed),
            set(name, "5"),
          );
          const error = yield* Effect.flip(
            compile(request, { [group]: { a: "1", b: 2 } }),
          );
          expect(error).toBeInstanceOf(Request.InvalidRequest);
          expect(error.message).toContain('"limit"');
          expect(calls).toBe(2);
        }),
    );

    it.effect(
      `does not refuse a ${group} removal when encoding omits the filled field`,
      () =>
        Effect.gen(function* () {
          const Omitted = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.optionalKey(Schema.String), {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.omit(),
              }),
              Schema.withConstructorDefault(Effect.succeed("25")),
            ),
          });
          const request = Request.get("/things").pipe(
            bind(Omitted),
            remove(name),
          );
          const result = yield* compile(request, {});
          expect(entries(result)).toEqual(group === "query" ? "/things" : []);
        }),
    );

    it.effect(
      `counts a ${group} default once and preserves static required conflicts`,
      () =>
        Effect.gen(function* () {
          let calls = 0;
          const counted = Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  calls++;
                  return "25";
                }),
              ),
            ),
          });
          const request = Request.get("/things").pipe(
            bind(counted),
            set(name, "5"),
          );
          expect(calls).toBe(0);
          expect(yield* Effect.flip(compile(request, {}))).toBeInstanceOf(
            Request.InvalidRequest,
          );
          expect(calls).toBe(1);
          const required = Request.get("/things").pipe(
            bind(Schema.Struct({ limit: Schema.String })),
            set(name, "5"),
          );
          const error = yield* Effect.flip(
            compile(required, { [group]: { limit: "7" } }),
          );
          expect(error.message).toContain("always writes");
        }),
    );
  }

  it.effect(
    "keeps provenance across pure transforms, mapInput and stacked bindings",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Defaulted),
          Request.query(
            Schema.Struct({ other: Schema.optionalKey(Schema.String) }),
          ),
          Request.mapBaseUrl((base) => base),
          Request.mapEffect((native) => Effect.succeed(native)),
          Request.setQuery("limit", "5"),
          Request.mapInput((input: { readonly override?: string }) => ({
            query:
              input.override === undefined ? {} : { limit: input.override },
          })),
        );
        expect(yield* Effect.flip(Request.compile(request, {}))).toBeInstanceOf(
          Request.InvalidRequest,
        );
        expect(
          (yield* Request.compile(request, { override: "7" })).request.url,
        ).toBe("/things?limit=7");
      }),
  );

  it.effect(
    "does not assign an earlier edit to a later reuse of a binding factory",
    () =>
      Effect.gen(function* () {
        const bind = Request.query(Defaulted);
        const request = Request.get("/things").pipe(
          bind,
          Request.setQuery("limit", "5"),
          Request.mapInput(() => ({ query: { limit: "7" } })),
          bind,
        );
        expect((yield* Request.compile(request, {})).request.url).toBe(
          "/things?limit=25",
        );
        const unbound = Request.get("/things").pipe(
          bind,
          Request.setQuery("limit", "5"),
          Request.unbind("query"),
          bind,
        );
        expect((yield* Request.compile(unbound, {})).request.url).toBe(
          "/things?limit=25",
        );
        const cleared = Request.get("/things").pipe(
          bind,
          Request.setQuery("limit", "5"),
          Request.unbind("query"),
        );
        expect((yield* Request.compile(cleared, undefined)).request.url).toBe(
          "/things?limit=5",
        );
      }),
  );

  it.effect(
    "isolates provenance and construction evidence between parallel evaluations",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const asynchronous = Schema.Struct({
          limit: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(
              Effect.promise(async () => {
                calls++;
                await Promise.resolve();
                return "25";
              }),
            ),
          ),
        });
        const base = Request.get("/things").pipe(Request.query(asynchronous));
        const edited = base.pipe(Request.setQuery("limit", "5"));
        const [refused, plain, explicit] = yield* Effect.all(
          [
            Effect.result(Request.compile(edited, {})),
            Effect.result(Request.compile(base, {})),
            Effect.result(Request.compile(edited, { query: { limit: "7" } })),
          ],
          { concurrency: "unbounded" },
        );
        expect(refused._tag).toBe("Failure");
        expect(plain._tag).toBe("Success");
        expect(explicit._tag).toBe("Success");
        expect(calls).toBe(2);
      }),
  );

  it.effect("proves an empty transformed group while excluding classes", () =>
    Effect.gen(function* () {
      class DefaultClass extends Schema.Class<DefaultClass>("DefaultClass")({
        limit: Schema.optionalKey(Schema.String).pipe(
          Schema.withConstructorDefault(Effect.succeed("25")),
        ),
      }) {}
      expect(
        yield* Effect.flip(
          Request.compile(
            Request.get("/things").pipe(
              Request.query(
                Defaulted.pipe(Schema.encodeKeys({ limit: "limit" })),
              ),
              Request.setQuery("limit", "5"),
            ),
            {},
          ),
        ),
      ).toBeInstanceOf(Request.InvalidRequest);
      const request = Request.get("/things").pipe(
        Request.query(DefaultClass),
        Request.setQuery("limit", "5"),
      );
      expect((yield* Request.compile(request, {})).request.url).toBe(
        "/things?limit=25",
      );
    }),
  );

  it.effect(
    "does not use accessor or inherited input properties as omission evidence",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Defaulted),
          Request.setQuery("limit", "5"),
        );
        for (const query of [
          Object.create({ limit: undefined }),
          Object.defineProperty({}, "limit", {
            get: () => undefined,
            enumerable: true,
          }),
        ]) {
          expect((yield* Request.compile(request, { query })).request.url).toBe(
            "/things?limit=25",
          );
        }
        let reads = 0;
        const query = Object.defineProperty({}, "limit", {
          get: () => {
            reads++;
            return undefined;
          },
          enumerable: true,
        });
        yield* Request.compile(
          Request.get("/things").pipe(Request.query(Defaulted)),
          { query },
        );
        const baseline = reads;
        expect(baseline).toBeGreaterThan(0);
        reads = 0;
        yield* Request.compile(request, { query });
        expect(reads).toBe(baseline);
      }),
  );
  it.effect(
    "snapshots caller omission before an encoder can mutate the supplied object",
    () =>
      Effect.gen(function* () {
        const query: { limit?: string } = { limit: "7" };
        const Mutating = Schema.Struct({
          limit: Schema.optionalKey(
            Schema.String.pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.transform((value) => {
                  delete query.limit;
                  return value;
                }),
              }),
            ),
          ).pipe(Schema.withConstructorDefault(Effect.succeed("25"))),
        });
        const request = Request.get("/things").pipe(
          Request.query(Mutating),
          Request.setQuery("limit", "5"),
        );
        expect((yield* Request.compile(request, { query })).request.url).toBe(
          "/things?limit=7",
        );
      }),
  );
  it.effect(
    "does not mistake an inherited output name for an encoded field",
    () =>
      Effect.gen(function* () {
        const Omitted = Schema.Struct({
          toString: Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.optionalKey(Schema.String), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.omit(),
            }),
            Schema.withConstructorDefault(Effect.succeed("25")),
          ),
        });
        const request = Request.get("/things").pipe(
          Request.query(Omitted),
          Request.removeQuery("toString"),
        );
        expect(
          (yield* Request.compile(request, { query: Object.create(null) }))
            .request.url,
        ).toBe("/things");
      }),
  );

  it.effect(
    "keeps omission evidence when an encoder adds a property to the original input",
    () =>
      Effect.gen(function* () {
        const query: { limit?: string } = {};
        let calls = 0;
        const Mutating = Schema.Struct({
          limit: Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.optionalKey(Schema.String), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.withDefault(
                Effect.sync(() => {
                  calls++;
                  query.limit = "mutation";
                  return "25";
                }),
              ),
            }),
          ),
        });
        const request = Request.get("/things").pipe(
          Request.query(Mutating),
          Request.setQuery("limit", "5"),
        );
        expect(
          yield* Effect.flip(Request.compile(request, { query })),
        ).toBeInstanceOf(Request.InvalidRequest);
        expect(calls).toBe(1);
        expect(query.limit).toBe("mutation");
      }),
  );

  it.effect(
    "uses own omitted prototype names without confusing inherited input values",
    () =>
      Effect.gen(function* () {
        for (const name of ["toString", "constructor", "__proto__"]) {
          const Generated = Schema.Struct({
            [name]: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(Effect.succeed("25")),
            ),
          });
          const request = Request.get("/things").pipe(
            Request.query(Generated),
            Request.removeQuery(name),
          );
          const query = Object.create(null);
          const error = yield* Effect.flip(Request.compile(request, { query }));
          expect(error).toBeInstanceOf(Request.InvalidRequest);
          expect(error.message).toContain(JSON.stringify(name));
          query[name] = "7";
          expect((yield* Request.compile(request, { query })).request.url).toBe(
            `/things?${name}=7`,
          );
        }
      }),
  );

  it.effect(
    "keeps generated-field provenance per binding with rest fields, stacking and unbind",
    () =>
      Effect.gen(function* () {
        const Generated = Schema.StructWithRest(
          Schema.Struct({
            limit: Schema.optionalKey(Schema.String).pipe(
              Schema.decodeTo(Schema.optionalKey(Schema.String), {
                decode: SchemaGetter.passthrough(),
                encode: SchemaGetter.withDefault(Effect.succeed("25")),
              }),
            ),
          }),
          [Schema.Record(Schema.String, Schema.String)],
        );
        const bind = Request.query(Generated);
        const base = Request.get("/things").pipe(
          bind,
          Request.query(
            Schema.Struct({ limit: Schema.optionalKey(Schema.String) }),
          ),
          Request.setQuery("limit", "5"),
        );
        expect(
          yield* Effect.flip(Request.compile(base, { query: { other: "x" } })),
        ).toBeInstanceOf(Request.InvalidRequest);
        const mapped = base.pipe(
          Request.mapInput((input: { limit: string }) => ({
            query: { limit: input.limit },
          })),
        );
        expect(
          (yield* Request.compile(mapped, { limit: "7" })).request.url,
        ).toBe("/things?limit=7");
        const reused = Request.get("/things").pipe(
          bind,
          Request.setQuery("limit", "5"),
          Request.mapInput(() => ({ query: { limit: "7" } })),
          bind,
        );
        expect((yield* Request.compile(reused, {})).request.url).toBe(
          "/things?limit=25",
        );
        const cleared = base.pipe(Request.unbind("query"));
        expect((yield* Request.compile(cleared, undefined)).request.url).toBe(
          "/things?limit=5",
        );
        expect(
          (yield* Request.compile(cleared.pipe(bind), {})).request.url,
        ).toBe("/things?limit=25");
      }),
  );
});
