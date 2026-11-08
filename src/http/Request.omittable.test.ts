import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import type * as Transport from "./Transport.js";

const Optional = Schema.Struct({ limit: Schema.optionalKey(Schema.String) });

// https://github.com/viell-dev/slop-effect-schema-http/issues/135
describe("omittable query and header groups", () => {
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
      ) =>
        group === "query"
          ? self.pipe(Request.query(schema))
          : self.pipe(Request.headers(schema));
    // Runtime cases include invalid inputs; the separate type test checks the public inference.
    const compile = (
      request: Request.Request<
        never,
        Schema.SchemaError | Request.InvalidRequest
      >,
      input: unknown,
    ) => Request.compile(request, input as never);
    const request = Request.get("https://api.test/things").pipe(bind(Optional));
    const inspect = (compiled: Request.Compiled) => ({
      url: compiled.request.url,
      headers: compiled.headerLines,
    });

    it.effect(`treats absent and undefined ${group} as an empty group`, () =>
      Effect.gen(function* () {
        const explicit = inspect(yield* compile(request, { [group]: {} }));
        expect(inspect(yield* compile(request, {}))).toEqual(explicit);
        expect(
          inspect(yield* compile(request, { [group]: undefined })),
        ).toEqual(explicit);
      }),
    );

    it.effect(`validates explicit invalid ${group} values`, () =>
      Effect.gen(function* () {
        for (const value of [null, false, 1, "invalid"]) {
          const error = yield* Effect.flip(
            compile(request, { [group]: value }),
          );
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }
      }),
    );

    it.effect(`preserves and validates raw defaults in absent ${group}`, () =>
      Effect.gen(function* () {
        const set = group === "query" ? Request.setQuery : Request.setHeader;
        const withDefault = request.pipe(set("limit", "25"));
        const explicit = inspect(yield* compile(withDefault, { [group]: {} }));
        expect(inspect(yield* compile(withDefault, {}))).toEqual(explicit);
        expect(
          inspect(yield* compile(withDefault, { [group]: { limit: "5" } })),
        ).not.toEqual(explicit);
        const invalid = Request.get("/things").pipe(
          bind(
            Schema.Struct({
              limit: Schema.optionalKey(
                Schema.String.check(Schema.isMaxLength(1)),
              ),
            }),
          ),
          set("limit", "25"),
        );
        expect(yield* Effect.flip(compile(invalid, {}))).toBeInstanceOf(
          Request.InvalidRequest,
        );
      }),
    );

    it.effect(`still runs refinements of an absent ${group}`, () =>
      Effect.gen(function* () {
        const refined = Request.get("/things").pipe(
          bind(
            Optional.check(
              Schema.makeFilter((value) => value.limit !== undefined),
            ),
          ),
        );
        const omitted = yield* Effect.flip(compile(refined, {}));
        const explicit = yield* Effect.flip(compile(refined, { [group]: {} }));
        expect(omitted).toBeInstanceOf(Schema.SchemaError);
        expect(omitted.message).toBe(explicit.message);
      }),
    );

    it.effect(`constructs defaults in an absent ${group}`, () =>
      Effect.gen(function* () {
        const defaulted = Request.get("/things").pipe(
          bind(
            Schema.Struct({
              limit: Schema.String.pipe(
                Schema.withConstructorDefault(Effect.succeed("25")),
              ),
            }),
          ),
        );
        const compiled = yield* compile(defaulted, {});
        expect(inspect(compiled)).toEqual(
          inspect(yield* compile(defaulted, { [group]: {} })),
        );
        expect(
          group === "query" ? compiled.request.url : compiled.headerLines,
        ).toEqual(group === "query" ? "/things?limit=25" : [["limit", "25"]]);
      }),
    );

    it.effect(
      `normalizes ${group} before stacked unions record consumption`,
      () =>
        Effect.gen(function* () {
          const union = Schema.Union([
            Optional,
            Schema.Struct({ cursor: Schema.String }),
          ]);
          const other = Schema.Struct({
            trace: Schema.optionalKey(Schema.String),
          });
          for (const bindings of [
            [union, other],
            [other, union],
          ] as const) {
            const stacked = Request.get("/things").pipe(
              bind(bindings[0]),
              bind(bindings[1]),
            );
            expect(inspect(yield* compile(stacked, {}))).toEqual(
              inspect(yield* compile(stacked, { [group]: {} })),
            );
          }
        }),
    );

    it.effect(
      `validates required ${group} fields even when untyped input omits the group`,
      () =>
        Effect.gen(function* () {
          const required = Request.get("/things").pipe(
            bind(Schema.Struct({ limit: Schema.String })),
          );
          for (const input of [{}, { [group]: undefined }, { [group]: {} }]) {
            const error = yield* Effect.flip(compile(required, input));
            expect(error).toBeInstanceOf(Schema.SchemaError);
            expect(error.message).toContain("limit");
          }
        }),
    );
  }

  it.effect("executes with both groups omitted", () =>
    Effect.gen(function* () {
      const transport = synthetic(() => empty(204));
      const operation = Operation.make(
        Request.get("https://api.test/things").pipe(
          Request.query(Optional),
          Request.headers(Optional),
        ),
        Response.status(204, Body.empty),
      );
      yield* operation.execute({}).pipe(Effect.provide(transport.layer));
      expect(transport.exchanges).toHaveLength(1);
      expect(transport.exchanges[0]?.url).toBe("https://api.test/things");
      expect(transport.exchanges[0]?.headerLines).toEqual([]);
      // @ts-expect-error: the invocation object is still required
      void operation.execute();
    }),
  );

  it.effect(
    "keeps mapInput's declared argument and clears an optional binding",
    () =>
      Effect.gen(function* () {
        const mapped = Request.get("/things").pipe(
          Request.query(Optional),
          Request.mapInput((input: { readonly token: string }) => {
            expect(input.token).toBe("ok");
            return {};
          }),
        );
        expectTypeOf<Request.InputOf<typeof mapped>>().toEqualTypeOf<{
          readonly token: string;
        }>();
        expect(
          (yield* Request.compile(mapped, { token: "ok" })).request.url,
        ).toBe("/things");
        const unbound = Request.get("/things").pipe(
          Request.query(Optional),
          Request.unbind("query"),
        );
        expectTypeOf<
          Request.InputOf<typeof unbound>
        >().toEqualTypeOf<unknown>();
        expect((yield* Request.compile(unbound, undefined)).request.url).toBe(
          "/things",
        );
      }),
  );

  it("infers optional keys from the whole schema input and intersects bindings", () => {
    const optional = Request.get("/").pipe(Request.query(Optional));
    expectTypeOf<Request.InputOf<typeof optional>>().toEqualTypeOf<{
      readonly query?: Request.Input<typeof Optional>;
    }>();
    void Request.compile(optional, {});
    void Request.compile(optional, { query: { limit: "5" } });
    // @ts-expect-error: exactOptionalPropertyTypes still follows the schema's input
    void Request.compile(optional, { query: undefined });
    // @ts-expect-error: null is on neither side of this schema
    void Request.compile(optional, { query: null });

    const headers = Request.get("/").pipe(Request.headers(Optional));
    expectTypeOf<Request.InputOf<typeof headers>>().toEqualTypeOf<{
      readonly headers?: Request.Input<typeof Optional>;
    }>();
    void Request.compile(headers, {});
    // @ts-expect-error: an explicit undefined is not this schema's input
    void Request.compile(headers, { headers: undefined });

    const stacked = optional.pipe(
      Request.query(Schema.Struct({ page: Schema.String })),
    );
    // @ts-expect-error: a required stacked binding keeps the group required
    void Request.compile(stacked, {});
    void Request.compile(stacked, { query: { page: "1" } });

    const required = Request.get("/?page=1").pipe(
      Request.query(Schema.Struct({ page: Schema.String })),
    );
    // @ts-expect-error: a raw default does not satisfy a required input
    void Request.compile(required, {});

    const union = optional.pipe(
      Request.headers(
        Schema.Union([Optional, Schema.Struct({ key: Schema.String })]),
      ),
    );
    void Request.compile(union, {});
    void Request.compile(union, { headers: { key: "k" } });

    const record = Request.get("/").pipe(
      Request.query(Schema.Record(Schema.String, Schema.String)),
    );
    void Request.compile(record, {});
    const pairs = Request.get("/").pipe(
      Request.query(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
    );
    // @ts-expect-error: an array input does not accept an empty object
    void Request.compile(pairs, {});

    const path = Request.get("").pipe(Request.path(Optional, () => "/things"));
    // @ts-expect-error: path keeps its input key even when the schema takes {}
    void Request.compile(path, {});
    const body = Request.post("/").pipe(
      Request.body(Body.jsonSchema(Optional)),
    );
    // @ts-expect-error: body keeps its input key even when the schema takes {}
    void Request.compile(body, {});
  });

  it.effect(
    "keeps runtime validation when a broad schema type permits omission",
    () =>
      Effect.gen(function* () {
        // Widening forgets the constructor input, so {} fits the remaining unknown input.
        const broad: Schema.Top &
          Schema.ConstraintCodec<unknown, Transport.HeaderInput, never, never> =
          Schema.Struct({ limit: Schema.String });
        const request = Request.get("/").pipe(Request.headers(broad));
        const error = yield* Effect.flip(Request.compile(request, {}));
        expect(error).toBeInstanceOf(Schema.SchemaError);
        expect(error.message).toContain("limit");
      }),
  );

  it("uses constructor input and either side without inspecting schema fields", () => {
    class Defaults extends Schema.Class<Defaults>("Defaults")({
      limit: Schema.String.pipe(
        Schema.withConstructorDefault(Effect.succeed("25")),
      ),
    }) {}
    void Request.compile(Request.get("/").pipe(Request.query(Defaults)), {});

    const decoded = Schema.Struct({
      limit: Schema.String.pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("25")),
      ),
    });
    void Request.compile(Request.get("/").pipe(Request.headers(decoded)), {});

    const any = Request.get("/").pipe(Request.headers(Schema.Any));
    void Request.compile(any, {});
    const never = Request.get("/").pipe(Request.query(Schema.Never));
    expectTypeOf<Request.InputOf<typeof never>>().toEqualTypeOf<{
      readonly query: never;
    }>();
    // @ts-expect-error: an impossible schema does not make its key optional
    void Request.compile(never, {});
  });
});
