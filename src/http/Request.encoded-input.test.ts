import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Effect, Schema, SchemaTransformation } from "effect";
import { empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import type * as UrlEncoding from "./UrlEncoding.js";

const Partly = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

const Optional = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

const Required = Schema.Struct({
  term: Schema.String,
  limit: Schema.FiniteFromString,
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

// https://github.com/viell-dev/slop-effect-schema-http/issues/169
describe("encoded input names beside unchanged fields", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/172
  it.effect("accepts nested encoded types and executes their whole value", () =>
    Effect.gen(function* () {
      const Nested = Schema.Struct({
        filter: Schema.Struct({
          term: Schema.optionalKey(Schema.String),
          limit: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ limit: "page_size" })),
      });
      const input: Request.Input<typeof Nested> = {
        filter: {
          page_size: "05",
        },
      };
      const request = Request.get("").pipe(
        Request.path(Nested, (encoded) => `/${encoded.filter.page_size ?? ""}`),
      );
      expect(
        (yield* Request.compile(request, { path: input })).request.url,
      ).toBe("/05");
    }),
  );

  it.effect("accepts either side of a partly renamed defaulted query", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(Request.query(Partly));
      const encoded: Request.Input<typeof Partly> = { page_size: "05" };
      const decoded: Request.Input<typeof Partly> = { limit: 5 };
      const whole: Request.InputOf<typeof request> = { query: encoded };
      for (const input of [whole, { query: decoded }]) {
        const compiled = yield* Request.compile(request, input);
        expect(compiled.request.url).toBe("/things?page_size=5");
      }
      expect((yield* Request.compile(request, {})).request.url).toBe(
        "/things?page_size=25",
      );
      void (() => {
        // @ts-expect-error: the encoded alias takes text, not the decoded number
        void Request.compile(request, { query: { page_size: 5 } });
        // @ts-expect-error: unknown field names are not schema input
        void Request.compile(request, { query: { absent: "5" } });
      });
    }),
  );

  it.effect("accepts optional encoded header names without a default", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(Request.headers(Optional));
      const encoded: Request.Input<typeof Optional> = { page_size: "05" };
      for (const headers of [encoded, { limit: 5 }]) {
        expect(
          (yield* Request.compile(request, { headers })).headerLines,
        ).toEqual([["page_size", "5"]]);
      }
      expect((yield* Request.compile(request, {})).headerLines).toEqual([]);
    }),
  );

  it.effect("keeps encoded names in a singleton union", () =>
    Effect.gen(function* () {
      const Singleton = Schema.Union([Partly]);
      const request = Request.get("/things").pipe(Request.query(Singleton));
      const encoded: Request.Input<typeof Singleton> = { page_size: "05" };
      for (const query of [encoded, { limit: 5 }]) {
        expect((yield* Request.compile(request, { query })).request.url).toBe(
          "/things?page_size=5",
        );
      }
    }),
  );

  it.effect("keeps encoded names and the other union member", () =>
    Effect.gen(function* () {
      const Either = Schema.Union([
        Partly,
        Schema.Struct({ cursor: Schema.String }),
      ]);
      const request = Request.get("/things").pipe(Request.query(Either));
      const encoded: Request.Input<typeof Either> = { page_size: "05" };
      const decoded: Request.Input<typeof Either> = { limit: 5 };
      for (const query of [encoded, decoded]) {
        expect((yield* Request.compile(request, { query })).request.url).toBe(
          "/things?page_size=5",
        );
      }
      expect(
        (yield* Request.compile(request, { query: { cursor: "next" } })).request
          .url,
      ).toBe("/things?cursor=next");
      void (() => {
        // @ts-expect-error: another union member does not widen the alias value
        void Request.compile(request, { query: { page_size: 5 } });
      });
    }),
  );

  it.effect("accepts the all-string partly renamed migration shape", () =>
    Effect.gen(function* () {
      const Strings = Schema.Struct({
        term: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.String),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const request = Request.get("/things").pipe(Request.query(Strings));
      const encoded: Request.Input<typeof Strings> = { page_size: "5" };
      const compiled = yield* Request.compile(request, { query: encoded });
      expect(compiled.request.url).toBe("/things?page_size=5");
    }),
  );

  it.effect("keeps aliases exchanged between discriminated union members", () =>
    Effect.gen(function* () {
      const First = Schema.Struct({
        kind: Schema.Literal("a"),
        term: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.String),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const Second = Schema.Struct({
        kind: Schema.Literal("b"),
        term: Schema.optionalKey(Schema.String),
        page_size: Schema.optionalKey(Schema.String),
      }).pipe(Schema.encodeKeys({ page_size: "limit" }));
      const Either = Schema.Union([First, Second]);
      const first: Request.Input<typeof Either> = {
        kind: "a",
        page_size: "05",
      };
      const second: Request.Input<typeof Either> = { kind: "b", limit: "07" };
      const request = Request.get("/things").pipe(Request.query(Either));
      expect(
        (yield* Request.compile(request, { query: first })).request.url,
      ).toBe("/things?kind=a&page_size=05");
      expect(
        (yield* Request.compile(request, { query: second })).request.url,
      ).toBe("/things?kind=b&limit=07");
    }),
  );

  it.effect("preserves required siblings and entirely renamed inputs", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(Request.query(Required));
      for (const query of [
        { term: "x", page_size: "05" },
        { term: "x", limit: 5 },
      ]) {
        expect((yield* Request.compile(request, { query })).request.url).toBe(
          "/things?term=x&page_size=5",
        );
      }
      const Renamed = Schema.Struct({
        limit: Schema.optionalKey(Schema.FiniteFromString),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const all = Request.get("/things").pipe(Request.query(Renamed));
      expect(
        (yield* Request.compile(all, { query: { page_size: "05" } })).request
          .url,
      ).toBe("/things?page_size=5");
      void (() => {
        // @ts-expect-error: the unchanged sibling remains required
        void Request.compile(request, { query: { page_size: "5" } });
        // @ts-expect-error: the renamed field remains required too
        void Request.compile(request, { query: { term: "x" } });
      });
    }),
  );

  it.effect("keeps fieldwise mixing for unchanged names", () =>
    Effect.gen(function* () {
      const Mixed = Schema.Struct({
        limit: Schema.optionalKey(Schema.FiniteFromString),
        count: Schema.FiniteFromString,
        offset: Schema.FiniteFromString,
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const request = Request.get("/things").pipe(Request.query(Mixed));
      const mixed: Request.Input<typeof Mixed> = {
        limit: 5,
        count: "7",
        offset: 9,
      };
      expect(
        (yield* Request.compile(request, { query: mixed })).request.url,
      ).toBe("/things?page_size=5&count=7&offset=9");
      const encoded: Request.Input<typeof Mixed> = {
        page_size: "05",
        count: "7",
        offset: "9",
      };
      expect(
        (yield* Request.compile(request, { query: encoded })).request.url,
      ).toBe("/things?page_size=5&count=7&offset=9");
    }),
  );

  it.effect("carries encoded input through a named map and operation", () =>
    Effect.gen(function* () {
      const request = Request.get("https://api.test/things").pipe(
        Request.query(Partly),
      );
      type Input = Request.InputOf<typeof request>;
      const page = (size: string): Input => ({ query: { page_size: size } });
      const mapped = request.pipe(Request.mapInput(page));
      const operation = Operation.make(
        request,
        Response.status(204, Body.empty),
      );
      const adapted = Operation.make(mapped, Response.status(204, Body.empty));
      expectTypeOf<Request.InputOf<typeof mapped>>().toEqualTypeOf<string>();
      expectTypeOf<
        Operation.InputOf<typeof operation>
      >().toEqualTypeOf<Input>();
      const provider = synthetic(() => empty(204));
      yield* operation
        .execute({ query: { page_size: "05" } })
        .pipe(Effect.provide(provider.layer));
      yield* operation
        .execute({ query: { limit: 5 } })
        .pipe(Effect.provide(provider.layer));
      yield* adapted.execute("05").pipe(Effect.provide(provider.layer));
      expect(provider.exchanges.map(({ url }) => url)).toEqual([
        "https://api.test/things?page_size=5",
        "https://api.test/things?page_size=5",
        "https://api.test/things?page_size=5",
      ]);
      void (() => {
        // @ts-expect-error: operation execution retains the encoded value type
        void operation.execute({ query: { page_size: 5 } });
        // @ts-expect-error: mapping fixes the public input to text
        void adapted.execute(5);
      });
    }),
  );

  it.effect("preserves services and errors through a generic binding", () =>
    Effect.gen(function* () {
      class Prefix extends Context.Service<Prefix, string>()(
        "encoded/Prefix",
      ) {}
      const Text = Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transformEffect({
            decode: (value) => Effect.as(Prefix, value),
            encode: (value) => Effect.as(Prefix, value),
          }),
        ),
      );
      const Fields = Schema.Struct({
        term: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Text),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      const bind = <
        S extends Schema.Top &
          Schema.ConstraintCodec<
            unknown,
            UrlEncoding.QueryInput,
            unknown,
            unknown
          >,
      >(
        schema: S,
      ) => Request.query(schema);
      const request = Request.get("/things").pipe(bind(Fields));
      const compiling = Request.compile(request, { query: { page_size: "5" } });
      expectTypeOf<Effect.Services<typeof compiling>>().toEqualTypeOf<Prefix>();
      expectTypeOf<Effect.Error<typeof compiling>>().toEqualTypeOf<
        Schema.SchemaError | Request.InvalidRequest
      >();
      expect(
        (yield* compiling.pipe(Effect.provideService(Prefix, "ready"))).request
          .url,
      ).toBe("/things?page_size=5");
    }),
  );

  it.effect("lets decoded-only helpers declare their own input shape", () =>
    Effect.gen(function* () {
      const request = Request.get("/things").pipe(Request.query(Partly));
      void ((input: Request.Input<typeof Partly>) => {
        // @ts-expect-error: the encoded side has page_size instead of limit
        return input.limit ?? 25;
      });
      const defaultPage = (input: {
        readonly limit?: number;
      }): Request.InputOf<typeof request> => ({
        query: { limit: input.limit ?? 25 },
      });
      const mapped = request.pipe(Request.mapInput(defaultPage));
      expect((yield* Request.compile(mapped, { limit: 5 })).request.url).toBe(
        "/things?page_size=5",
      );
      expect((yield* Request.compile(mapped, {})).request.url).toBe(
        "/things?page_size=25",
      );
    }),
  );

  it("preserves primitives and whole-side arrays", () => {
    const List = Schema.Array(Schema.FiniteFromString);
    const Strings = Schema.Array(Schema.String);
    expectTypeOf<Request.Input<typeof Strings>>().toEqualTypeOf<
      ReadonlyArray<string>
    >();
    expectTypeOf<Request.Input<typeof Schema.String>>().toEqualTypeOf<string>();
    expectTypeOf<Request.Input<typeof Schema.FiniteFromString>>().toEqualTypeOf<
      string | number
    >();
    const encoded: Request.Input<typeof List> = ["5"];
    const decoded: Request.Input<typeof List> = [5];
    expect(encoded).toEqual(["5"]);
    expect(decoded).toEqual([5]);
    void (() => {
      // @ts-expect-error: array items cannot mix the two whole-value sides
      const mixed: Request.Input<typeof List> = [5, "7"];
      // @ts-expect-error: an unchanged primitive does not become an object mix
      const wrong: Request.Input<typeof Schema.String> = 5;
      void [mixed, wrong];
    });
  });

  it.effect("preserves class construction inputs", () =>
    Effect.gen(function* () {
      class Plain extends Schema.Class<Plain>("PlainInputFilter")({
        term: Schema.String,
      }) {}
      expectTypeOf<Request.Input<typeof Plain>>().toEqualTypeOf<{
        readonly term: string;
      }>();
      const plainRequest = Request.get("/things").pipe(Request.query(Plain));
      expect(
        (yield* Request.compile(plainRequest, { query: { term: "x" } })).request
          .url,
      ).toBe("/things?term=x");
      class Filter extends Schema.Class<Filter>("EncodedInputFilter")({
        limit: Schema.FiniteFromString,
      }) {}
      const request = Request.get("/things").pipe(Request.query(Filter));
      const plain: Request.Input<typeof Filter> = { limit: 5 };
      for (const query of [plain, { limit: "05" }, new Filter({ limit: 5 })]) {
        expect((yield* Request.compile(request, { query })).request.url).toBe(
          "/things?limit=5",
        );
      }
    }),
  );

  it("preserves an identical opaque nominal declaration", () => {
    class Token {
      private readonly value = "token";
      read() {
        return this.value;
      }
    }
    const Opaque = Schema.declare(
      (input): input is Token => input instanceof Token,
    );
    expectTypeOf<Request.Input<typeof Opaque>>().toEqualTypeOf<Token>();
    const Same = Schema.Union([Opaque, Opaque]);
    expectTypeOf<Request.Input<typeof Same>>().toEqualTypeOf<Token>();
    const token: Request.Input<typeof Opaque> = new Token();
    const request = Request.post("/things").pipe(
      Request.body(Body.jsonSchema(Opaque)),
    );
    void Request.compile(request, { body: token });
    void (() => {
      // @ts-expect-error: matching public members cannot forge the private identity
      const forged: Request.Input<typeof Opaque> = { read: () => "token" };
      // @ts-expect-error: body input also preserves the opaque identity
      void Request.compile(request, { body: { read: () => "token" } });
      void forged;
    });
    expect(token.read()).toBe("token");
  });

  it.effect("preserves nominal identity beside an optional encoded key", () =>
    Effect.gen(function* () {
      class Token {
        private readonly value = "token";
        read() {
          return this.value;
        }
      }
      const Native = Schema.declare(
        (input): input is Token => input instanceof Token,
      );
      const Wire = Schema.declare(
        (input): input is Token & { readonly hint?: string } =>
          input instanceof Token,
      );
      const TokenCodec = Wire.pipe(
        Schema.decodeTo(
          Native,
          SchemaTransformation.transform({
            decode: (input) => input,
            encode: (input) => input,
          }),
        ),
      );
      const native: Request.Input<typeof TokenCodec> = new Token();
      const hinted: Request.Input<typeof TokenCodec> = Object.assign(
        new Token(),
        {
          hint: "wire",
        },
      );
      const request = Request.get("").pipe(
        Request.path(TokenCodec, (input) => `/${input.read()}`),
      );
      for (const path of [native, hinted]) {
        expect((yield* Request.compile(request, { path })).request.url).toBe(
          "/token",
        );
      }
      void (() => {
        // @ts-expect-error: an optional encoded key cannot erase the private identity
        const forged: Request.Input<typeof TokenCodec> = {
          read: () => "forged",
        };
        // @ts-expect-error: request input also requires the original nominal value
        void Request.compile(request, { path: { read: () => "forged" } });
        void forged;
      });
    }),
  );
});
