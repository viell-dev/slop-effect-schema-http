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
describe("raw edits after a constructor default", () => {
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
            expect(error.message).toContain("constructor");
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
      `skips construction proof after a ${group} fieldwise fallback`,
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
          const result = yield* compile(request, { [group]: { a: "1", b: 2 } });
          expect(
            group === "query"
              ? result.request.url
              : result.request.headers.limit,
          ).toBe(group === "query" ? "/things?limit=25&a=1&b=2" : "25");
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

  it.effect(
    "does not infer construction through a group transform, class or union",
    () =>
      Effect.gen(function* () {
        class DefaultClass extends Schema.Class<DefaultClass>("DefaultClass")({
          limit: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("25")),
          ),
        }) {}
        for (const schema of [
          Defaulted.pipe(Schema.encodeKeys({ limit: "limit" })),
          DefaultClass,
          Schema.Union([Defaulted, Schema.Struct({ other: Schema.String })]),
        ]) {
          const request = Request.get("/things").pipe(
            Request.query(schema),
            Request.setQuery("limit", "5"),
          );
          expect((yield* Request.compile(request, {})).request.url).toBe(
            "/things?limit=25",
          );
        }
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
});
