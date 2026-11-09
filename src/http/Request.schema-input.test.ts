import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Option,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect";
import {
  bodyOf,
  compile,
  linesOf,
  Moment,
  MomentFromSelf,
  MomentFromString,
  queried,
  schemaFailure,
  stacked,
  takes,
  Tenant,
  urlOf,
} from "../../test/request.js";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Excess from "./internal/excess.js";
import * as Request from "./Request.js";

/** A request to `/x` with a JSON body schema bound. */
const posted = <
  S extends Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  },
>(
  schema: S,
) => Request.post("/x").pipe(Request.body(Body.jsonSchema(schema)));

/** The body a JSON schema sends for a value. */
const sentBy = <
  S extends Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  },
>(
  schema: S,
  body: Request.Input<S>,
) =>
  Effect.map(
    compile(Request.post("/x").pipe(Request.body(Body.jsonSchema(schema))), {
      body,
    }),
    ({ request }) => bodyText(request),
  );

/** A schema that reads one object into another. */
const reshaped = <E, T>(
  from: Schema.Codec<E, E>,
  to: Schema.Codec<T, T>,
  decode: (value: E) => T,
  encode: (value: T) => E,
) =>
  from.pipe(
    Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })),
  );

/** A generic path binding, a form that must keep compiling. */
const pathOf = <S extends Schema.Top>(schema: S) =>
  Request.path(schema, () => "/x");

/** The same bound by `Schema.Constraint`, which has no constructor. */
const pathOfConstraint = <S extends Schema.Constraint>(schema: S) =>
  // @ts-expect-error: only `Schema.Top` has `makeEffect`
  Request.path(schema, () => "/x");

// https://github.com/viell-dev/slop-effect-schema-http/issues/91
describe("a schema's value is built before it is encoded", () => {
  class Filter extends Schema.Class<Filter>("Filter")({
    page: Schema.NumberFromString,
  }) {}
  class Trace extends Schema.Class<Trace>("Trace")({
    "X-Trace": Schema.String,
  }) {}
  class Key extends Schema.Class<Key>("Key")({ id: Schema.NumberFromString }) {
    get path() {
      return `/things/${this.id}`;
    }
  }
  const byKey = Request.path(Key, ({ id }, encode) => `/things/${encode(id)}`);

  it.effect("takes a plain object for a class in each binding", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("/x").pipe(Request.query(Filter)), {
          query: { page: 2 },
        }),
      ).toBe("/x?page=2");
      expect(
        yield* linesOf(Request.get("/x").pipe(Request.headers(Trace)), {
          headers: { "X-Trace": "t" },
        }),
      ).toEqual([["X-Trace", "t"]]);
      expect(
        yield* urlOf(Request.get("").pipe(byKey), { path: { id: 7 } }),
      ).toBe("/things/7");
    }),
  );

  it.effect("takes an existing instance in each binding", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get("/x").pipe(Request.query(Filter)), {
          query: new Filter({ page: 2 }),
        }),
      ).toBe("/x?page=2");
      expect(
        yield* linesOf(Request.get("/x").pipe(Request.headers(Trace)), {
          headers: new Trace({ "X-Trace": "t" }),
        }),
      ).toEqual([["X-Trace", "t"]]);
      expect(
        yield* urlOf(Request.get("").pipe(byKey), {
          path: new Key({ id: 7 }),
        }),
      ).toBe("/things/7");
    }),
  );

  it.effect("takes a plain object for a class nested in a struct", () =>
    Effect.gen(function* () {
      const request = Request.post("/x").pipe(
        Request.body(
          Body.jsonSchema(
            Schema.Struct({ filter: Filter, size: Schema.Number }),
          ),
        ),
      );
      const compiled = yield* compile(request, {
        body: { filter: { page: 2 }, size: 1 },
      });
      expect(bodyText(compiled.request)).toBe(
        '{"filter":{"page":"2"},"size":1}',
      );
    }),
  );

  it.effect("fails with SchemaError before anything else happens", () =>
    Effect.gen(function* () {
      let prepared = 0;
      const request = Request.get("/x").pipe(
        Request.mapEffect((native) =>
          Effect.sync(() => {
            prepared++;
            return native;
          }),
        ),
        Request.query(Filter),
      );
      const error = yield* Effect.flip(
        compile(request, { query: { page: true as never } }),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
      expect(prepared).toBe(0);
    }),
  );

  it.effect("fills in a field with a constructor default", () =>
    Effect.gen(function* () {
      const Paging = Schema.Struct({
        limit: Schema.FiniteFromString.pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
      });
      const request = Request.get("/x").pipe(Request.query(Paging));
      expect(yield* urlOf(request, { query: {} })).toBe("/x?limit=25");
      expect(yield* urlOf(request, { query: { limit: 5 } })).toBe("/x?limit=5");
    }),
  );

  it.effect("stacks classes and structs on one input", () =>
    Effect.gen(function* () {
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ a: Schema.String })),
        Request.query(Filter),
      );
      expect(yield* urlOf(request, { query: { a: "1", page: 2 } })).toBe(
        "/x?a=1&page=2",
      );
    }),
  );

  it("takes the constructor's input in the type", () => {
    const query = Request.get("/x").pipe(Request.query(Filter));
    expectTypeOf<{ readonly page: number }>().toExtend<
      Parameters<typeof query.prepare>[0]["query"]
    >();
    const path = Request.get("/x").pipe(byKey);
    void Request.compile(path, { path: { id: 7 } });
    // @ts-expect-error: the field is missing
    void Request.compile(path, { path: {} });
  });

  it("needs a full schema, so a generic helper is bound by Schema.Top", () => {
    void pathOf(Schema.String);
    void pathOfConstraint;
  });
});

const reverse = (text: string) => Array.from(text).toReversed().join("");

/** A generic helper that names the input of its schema, a form that must keep compiling. */
const encodeBody = <S extends Schema.Top>(schema: S, value: Request.Input<S>) =>
  Body.jsonSchema(schema).encode(value);

// https://github.com/viell-dev/slop-effect-schema-http/issues/113
describe("a schema-backed input takes either side of its schema", () => {
  const MomentFromDate = Schema.Date.pipe(
    Schema.decodeTo(MomentFromSelf, {
      decode: SchemaGetter.transform(
        (date: Date) => new Moment(date.getTime()),
      ),
      encode: SchemaGetter.transform(
        (moment: Moment) => new Date(moment.minutes),
      ),
    }),
  );
  const Limit = Schema.Struct({ limit: Schema.FiniteFromString });
  const limited = Request.get("/things").pipe(Request.query(Limit));
  /** Both sides are text, so its two readings of a value cannot be told apart. */
  const Reversed = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform(reverse),
      encode: SchemaGetter.transform(reverse),
    }),
  );

  it.effect(
    "gives the same request from the decoded and the encoded side",
    () =>
      Effect.gen(function* () {
        expect(yield* urlOf(limited, { query: { limit: 5 } })).toBe(
          "/things?limit=5",
        );
        expect(yield* urlOf(limited, { query: { limit: "5" } })).toBe(
          "/things?limit=5",
        );
      }),
  );

  it.effect("takes a mix by field", () =>
    Effect.gen(function* () {
      const Picked = Schema.Struct({
        at: MomentFromString,
        limit: Schema.FiniteFromString,
        name: Schema.optional(Schema.String),
      });
      const request = Request.get("/slots").pipe(Request.query(Picked));
      const expected = "/slots?at=15%3A30%3A00&limit=5";
      expect(
        yield* urlOf(request, { query: { at: new Moment(930), limit: 5 } }),
      ).toBe(expected);
      expect(
        yield* urlOf(request, { query: { at: "15:30", limit: "5" } }),
      ).toBe(expected);
      expect(yield* urlOf(request, { query: { at: "t1530", limit: 5 } })).toBe(
        expected,
      );
      expect(
        yield* urlOf(request, { query: { at: new Moment(930), limit: "5" } }),
      ).toBe(expected);
    }),
  );

  it.effect("takes a schema's own type on either side, such as a Date", () =>
    Effect.gen(function* () {
      const noon = new Date("2026-11-07T12:00:00.000Z");
      const request = Request.post("/slots").pipe(
        Request.body(Body.jsonSchema(Schema.Struct({ from: MomentFromDate }))),
      );
      for (const from of [noon, new Moment(noon.getTime())]) {
        const compiled = yield* compile(request, { body: { from } });
        expect(bodyText(compiled.request)).toBe(
          '{"from":"2026-11-07T12:00:00.000Z"}',
        );
      }
    }),
  );

  it.effect("takes a value a decoder accepts and writes what it writes", () =>
    Effect.gen(function* () {
      expect(yield* urlOf(limited, { query: { limit: "05" } })).toBe(
        "/things?limit=5",
      );
      const Loose = Schema.Union([Schema.String, Schema.Number]).pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value: string | number) =>
            String(value),
          ),
          encode: SchemaGetter.passthrough(),
        }),
      );
      const request = Request.get("/things").pipe(
        Request.query(Schema.Struct({ id: Loose })),
      );
      expect(yield* urlOf(request, { query: { id: 7 } })).toBe("/things?id=7");
      expect(yield* urlOf(request, { query: { id: "7" } })).toBe(
        "/things?id=7",
      );
    }),
  );

  it.effect("validates both routes, so text cannot get past a schema", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(limited, { query: { limit: "many" } }),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  it.effect("reports the decoded side's error when every route fails", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(limited, { query: { limit: "many" } }),
      );
      expect(String(error)).toContain("Expected number");
      expect(String(error)).toContain('"limit"');
    }),
  );

  it.effect(
    "lets a weak schema through, as that is the definition's choice",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Schema.Struct({ limit: Schema.NumberFromString })),
        );
        expect(yield* urlOf(request, { query: { limit: "many" } })).toBe(
          "/things?limit=NaN",
        );
      }),
  );

  describe("when both sides share a type", () => {
    const Coded = Schema.Struct({ code: Reversed });
    const coded = Request.get("/things").pipe(Request.query(Coded));

    it.effect("reads a value as decoded, so it is encoded once", () =>
      Effect.gen(function* () {
        expect(yield* urlOf(coded, { query: { code: "abc" } })).toBe(
          "/things?code=cba",
        );
      }),
    );

    it.effect("encodes an already encoded value again, with no error", () =>
      Effect.gen(function* () {
        expect(yield* urlOf(coded, { query: { code: "cba" } })).toBe(
          "/things?code=abc",
        );
      }),
    );

    it.effect(
      "reads the value as encoded when the group only fits that way",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things").pipe(
            Request.query(
              Schema.Struct({ code: Reversed, limit: Schema.FiniteFromString }),
            ),
          );
          expect(
            yield* urlOf(request, { query: { code: "cba", limit: 5 } }),
          ).toBe("/things?code=abc&limit=5");
          expect(
            yield* urlOf(request, { query: { code: "cba", limit: "5" } }),
          ).toBe("/things?code=cba&limit=5");
        }),
    );

    it.effect(
      "keeps a default on its encoded side, as it is written text",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things?code=cba").pipe(
            Request.query(Schema.Struct({ code: Schema.optional(Reversed) })),
          );
          expect(yield* urlOf(request, { query: {} })).toBe("/things?code=cba");
        }),
    );
  });

  describe("the forms of a schema", () => {
    it.effect("takes a renamed field by its encoded name, with the rest", () =>
      Effect.gen(function* () {
        const Paging = Schema.Struct({
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
        }).pipe(Schema.encodeKeys({ page: "page_number" }));
        const request = Request.get("/things").pipe(Request.query(Paging));
        const expected = "/things?page_number=2&size=5";
        expect(yield* urlOf(request, { query: { page: 2, size: 5 } })).toBe(
          expected,
        );
        expect(
          yield* urlOf(request, { query: { page_number: "2", size: "5" } }),
        ).toBe(expected);
        expect(yield* urlOf(request, { query: { page: 2, size: "5" } })).toBe(
          expected,
        );
      }),
    );

    it.effect("takes each side of a class, and a mix by field", () =>
      Effect.gen(function* () {
        class Filter extends Schema.Class<Filter>("Filter")({
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
        }) {}
        const request = Request.get("/things").pipe(Request.query(Filter));
        const expected = "/things?page=2&size=5";
        for (const query of [
          new Filter({ page: 2, size: 5 }),
          { page: 2, size: 5 },
          { page: "2", size: "5" },
          { page: 2, size: "5" },
        ]) {
          expect(yield* urlOf(request, { query })).toBe(expected);
        }
      }),
    );

    it.effect("takes each side of a union, and a mix within one member", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("page"),
            page: Schema.FiniteFromString,
            size: Schema.FiniteFromString,
          }),
          Schema.Struct({
            kind: Schema.Literal("cursor"),
            cursor: Schema.String,
          }),
        ]);
        const request = Request.get("/things").pipe(Request.query(Either));
        const expected = "/things?kind=page&page=2&size=5";
        for (const query of [
          { kind: "page", page: 2, size: 5 },
          { kind: "page", page: "2", size: "5" },
          { kind: "page", page: 2, size: "5" },
        ] as const) {
          expect(yield* urlOf(request, { query })).toBe(expected);
        }
        expect(
          yield* urlOf(request, { query: { kind: "cursor", cursor: "c" } }),
        ).toBe("/things?kind=cursor&cursor=c");
      }),
    );

    it.effect("takes a field that is a class on either of its sides", () =>
      Effect.gen(function* () {
        class Stamp extends Schema.Class<Stamp>("Stamp")({
          at: Schema.DateFromString,
        }) {}
        const request = Request.post("/things").pipe(
          Request.body(
            Body.jsonSchema(
              Schema.Struct({ stamp: Stamp, size: Schema.FiniteFromString }),
            ),
          ),
        );
        const at = "2026-11-07T12:00:00.000Z";
        const expected = `{"stamp":{"at":"${at}"},"size":"5"}`;
        for (const body of [
          { stamp: new Stamp({ at: new Date(at) }), size: 5 },
          { stamp: { at }, size: "5" },
          { stamp: { at }, size: 5 },
        ]) {
          const compiled = yield* compile(request, { body });
          expect(bodyText(compiled.request)).toBe(expected);
        }
      }),
    );

    it.effect("fills in a tagged class's tag on a mix", () =>
      Effect.gen(function* () {
        class Tagged extends Schema.TaggedClass<Tagged>()("Tagged", {
          page: Schema.FiniteFromString,
        }) {}
        const request = Request.get("/things").pipe(Request.query(Tagged));
        for (const query of [
          { page: 1 },
          { _tag: "Tagged", page: "1" },
        ] as const) {
          expect(yield* urlOf(request, { query })).toBe(
            "/things?_tag=Tagged&page=1",
          );
        }
      }),
    );

    it.effect("fills in a constructor default on a mix", () =>
      Effect.gen(function* () {
        const Paging = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
        });
        const request = Request.get("/things").pipe(Request.query(Paging));
        expect(yield* urlOf(request, { query: { page: "2", size: 5 } })).toBe(
          "/things?limit=25&page=2&size=5",
        );
      }),
    );

    it.effect("leaves out an optional field a mix leaves undefined", () =>
      Effect.gen(function* () {
        const Paging = Schema.Struct({
          page: Schema.FiniteFromString,
          size: Schema.FiniteFromString,
          name: Schema.optional(Schema.FiniteFromString),
        });
        const request = Request.get("/things").pipe(Request.query(Paging));
        expect(
          yield* urlOf(request, {
            query: { page: "2", size: 5, name: undefined },
          }),
        ).toBe("/things?page=2&size=5");
      }),
    );
  });

  it.effect("applies to headers, paths and path structs", () =>
    Effect.gen(function* () {
      const headers = Request.get("/a").pipe(
        Request.headers(Schema.Struct({ "x-limit": Schema.FiniteFromString })),
      );
      for (const value of [5, "5"]) {
        expect(
          yield* linesOf(headers, { headers: { "x-limit": value } }),
        ).toEqual([["x-limit", "5"]]);
      }
      const scalar = Request.get("").pipe(
        Request.path(
          Schema.FiniteFromString,
          (id, encode) => `/things/${encode(id)}`,
        ),
      );
      const struct = Request.get("").pipe(
        Request.path(
          Schema.Struct({ id: Schema.FiniteFromString }),
          ({ id }, encode) => `/things/${encode(id)}`,
        ),
      );
      for (const id of [7, "7", "07"]) {
        expect(yield* urlOf(scalar, { path: id })).toBe("/things/7");
        expect(yield* urlOf(struct, { path: { id } })).toBe("/things/7");
      }
    }),
  );

  it.effect("reaches every stacked schema from one input", () =>
    Effect.gen(function* () {
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ a: Schema.FiniteFromString })),
        Request.query(Schema.Struct({ b: Schema.FiniteFromString })),
      );
      expect(yield* urlOf(request, { query: { a: 1, b: "2" } })).toBe(
        "/x?a=1&b=2",
      );
    }),
  );

  it.effect(
    "meets a default the same way, whichever side the caller gives",
    () =>
      Effect.gen(function* () {
        const request = Request.get("/x?size=2").pipe(
          Request.query(
            Schema.Struct({
              page: Schema.FiniteFromString,
              size: Schema.optional(Schema.FiniteFromString),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: { page: 1 } })).toBe(
          "/x?page=1&size=2",
        );
        expect(yield* urlOf(request, { query: { page: "1" } })).toBe(
          "/x?page=1&size=2",
        );
      }),
  );

  it.effect(
    "needs decoding services only for a value that takes that route",
    () =>
      Effect.gen(function* () {
        const Tenanted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (wire: string) =>
                Effect.gen(function* () {
                  return `${yield* Tenant}:${wire}`;
                }),
              encode: (value: string) => Effect.succeed(value),
            }),
          ),
        );
        const Who = Schema.Struct({
          who: Tenanted,
          limit: Schema.FiniteFromString,
        });
        const request = Request.get("/x").pipe(Request.query(Who));
        type Needs = Effect.Services<ReturnType<typeof request.prepare>>;
        expectTypeOf<Needs>().toEqualTypeOf<Tenant>();
        expect(
          yield* urlOf(request, { query: { who: "me", limit: "1" } }).pipe(
            Effect.provideService(Tenant, "t1"),
          ),
        ).toBe("/x?who=t1%3Ame&limit=1");
      }),
  );

  describe("types", () => {
    const Paged = Schema.Struct({
      page: Schema.FiniteFromString,
      name: Schema.String,
    });
    const paged = Request.get("/x").pipe(Request.query(Paged));

    it("accepts each side and a mix", () => {
      void Request.compile(paged, { query: { page: 1, name: "a" } });
      void Request.compile(paged, { query: { page: "1", name: "a" } });
    });

    it("rejects a value on neither side", () => {
      // @ts-expect-error: a boolean is on neither side of the schema
      void Request.compile(paged, { query: { page: true, name: "a" } });
      // @ts-expect-error: a field is missing on every side
      void Request.compile(paged, { query: { page: 1 } });
      void Request.compile(
        Request.get("/x").pipe(Request.path(Schema.Date, () => "/x")),
        // @ts-expect-error: `Schema.Date` encodes to a `Date`, so text is on neither side
        { path: "2026-11-07" },
      );
    });

    it("stays the plain shape when both sides are the same", () => {
      expectTypeOf<
        Request.Input<typeof Schema.String>
      >().toEqualTypeOf<string>();
      const Same = Schema.Struct({ a: Schema.String });
      expectTypeOf<Request.Input<typeof Same>>().toEqualTypeOf<{
        readonly a: string;
      }>();
    });

    it("is either side for a scalar", () => {
      expectTypeOf<
        Request.Input<typeof Schema.FiniteFromString>
      >().toEqualTypeOf<number | string>();
    });

    it("has no mix for a list, which has no fields", () => {
      const Ids = Schema.Array(Schema.FiniteFromString);
      expectTypeOf<Request.Input<typeof Ids>>().toEqualTypeOf<
        ReadonlyArray<number> | ReadonlyArray<string>
      >();
    });

    it("lets a generic helper name the input of a schema", () => {
      void encodeBody(Schema.FiniteFromString, "5");
      // @ts-expect-error: a boolean is on neither side of the schema
      void encodeBody(Schema.FiniteFromString, true);
    });

    it("lets a plain value into a branded field, on the encoded side", () => {
      const Id = Schema.String.pipe(Schema.brand("Id"));
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ id: Id })),
      );
      void Request.compile(request, { query: { id: Id.make("a") } });
      void Request.compile(request, { query: { id: "a" } });
    });

    describe("what each schema takes", () => {
      const Optional = Schema.Struct({
        limit: Schema.optional(Schema.FiniteFromString),
      });

      it("is one object where the mix takes all that each side does", () => {
        expectTypeOf<Request.Input<typeof Optional>>().toEqualTypeOf<{
          readonly limit?: string | number | undefined;
        }>();
        const Group = Schema.Struct({
          page: Schema.FiniteFromString,
          from: Schema.optional(Schema.DateFromString),
          name: Schema.String,
        });
        expectTypeOf<Request.Input<typeof Group>>().toEqualTypeOf<{
          readonly page: string | number;
          readonly from?: string | Date | undefined;
          readonly name: string;
        }>();
        const Defaulted = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        });
        expectTypeOf<Request.Input<typeof Defaulted>>().toEqualTypeOf<{
          readonly limit?: string | number;
        }>();
      });

      it("keeps each side where the mix does not take all that it does", () => {
        const Renamed = Schema.Struct({
          page: Schema.optional(Schema.FiniteFromString),
          size: Schema.optional(Schema.FiniteFromString),
        }).pipe(Schema.encodeKeys({ page: "page_number" }));
        expectTypeOf<{
          readonly page_number?: string | undefined;
          readonly size?: string | undefined;
        }>().toExtend<Request.Input<typeof Renamed>>();
        expectTypeOf<Request.Input<typeof Renamed>>().toEqualTypeOf<
          | {
              readonly page?: number | undefined;
              readonly size?: number | undefined;
            }
          | {
              readonly page_number?: string | undefined;
              readonly size?: string | undefined;
            }
          | {
              readonly page?: number | undefined;
              readonly size?: string | number | undefined;
            }
        >();
        const Defaulted = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("25")),
          ),
        });
        expectTypeOf<Request.Input<typeof Defaulted>>().toEqualTypeOf<
          | { readonly limit: number }
          | { readonly limit?: string }
          | { readonly limit: string | number | undefined }
        >();
      });

      it("takes each side of an optional field", () => {
        const input = takes(Optional);
        input({});
        input({ limit: 1 });
        input({ limit: "1" });
        input({ limit: undefined });
        // @ts-expect-error: a boolean is on neither side
        input({ limit: true });
        // @ts-expect-error: no side has this field
        input({ other: 1 });
        // @ts-expect-error: no side has this field, whatever else is there
        input({ limit: 1, other: 1 });
      });

      it("takes each side of a required field, and a mix", () => {
        const input = takes(
          Schema.Struct({
            a: Schema.FiniteFromString,
            b: Schema.FiniteFromString,
          }),
        );
        input({ a: 1, b: 2 });
        input({ a: "1", b: "2" });
        input({ a: 1, b: "2" });
        input({ a: "1", b: 2 });
        // @ts-expect-error: `b` is required on both sides
        input({ a: 1 });
        // @ts-expect-error: a boolean is on neither side
        input({ a: 1, b: true });
      });

      it("takes a renamed field under one name per side", () => {
        const input = takes(
          Schema.Struct({
            page: Schema.FiniteFromString,
            size: Schema.FiniteFromString,
          }).pipe(Schema.encodeKeys({ page: "page_number" })),
        );
        input({ page: 1, size: 2 });
        input({ page: 1, size: "2" });
        input({ page_number: "1", size: "2" });
        // @ts-expect-error: a mix cannot use an encoded name
        input({ page_number: "1", size: 2 });
        // @ts-expect-error: the decoded name takes only the decoded value
        input({ page: "1", size: 2 });
        // @ts-expect-error: the encoded name takes only the encoded value
        input({ page_number: 1, size: "2" });
      });

      it("takes an encoded name when every field is optional", () => {
        const input = takes(
          Schema.Struct({
            page: Schema.optional(Schema.FiniteFromString),
            size: Schema.optional(Schema.FiniteFromString),
          }).pipe(Schema.encodeKeys({ page: "page_number" })),
        );
        input({});
        input({ page: 1 });
        input({ size: 2 });
        input({ size: "2" });
        input({ page_number: "1" });
        input({ page_number: "1", size: "2" });
        // @ts-expect-error: the encoded name takes only the encoded value
        input({ page_number: 1 });
        // @ts-expect-error: no side has this field
        input({ other: "1" });
      });

      it("keeps the encoded side where a decoding default leaves a field out", () => {
        const input = takes(
          Schema.Struct({
            limit: Schema.FiniteFromString.pipe(
              Schema.withDecodingDefaultKey(Effect.succeed("25")),
            ),
          }),
        );
        input({});
        input({ limit: 1 });
        input({ limit: "1" });
        // @ts-expect-error: a boolean is on neither side
        input({ limit: true });
      });

      it("lets a constructor default leave a field out", () => {
        const input = takes(
          Schema.Struct({
            limit: Schema.FiniteFromString.pipe(
              Schema.withConstructorDefault(Effect.succeed(25)),
            ),
          }),
        );
        input({});
        input({ limit: 1 });
        input({ limit: "1" });
        // @ts-expect-error: a boolean is on neither side
        input({ limit: true });
      });

      it("takes a class's fields, or an instance of it", () => {
        class Filter extends Schema.Class<Filter>("Filter")({
          page: Schema.FiniteFromString,
          tag: Schema.optional(Schema.String),
        }) {
          get first() {
            return this.page === 1;
          }
        }
        const input = takes(Filter);
        input({ page: 1 });
        input({ page: "1", tag: "a" });
        input(new Filter({ page: 1 }));
        // @ts-expect-error: `page` is required on both sides
        input({});
        // @ts-expect-error: a boolean is on neither side
        input({ page: true });
        // @ts-expect-error: no side has this field
        input({ page: 1, other: 1 });
      });

      it("takes a `Date` or its text only where the encoded side is text", () => {
        const text = takes(Schema.Struct({ from: Schema.DateFromString }));
        text({ from: new Date(0) });
        text({ from: "2026-11-07" });
        // @ts-expect-error: a number is on neither side
        text({ from: 1 });
        const value = takes(Schema.Struct({ from: Schema.Date }));
        value({ from: new Date(0) });
        // @ts-expect-error: `Schema.Date` encodes to a `Date`, so text is on neither side
        value({ from: "2026-11-07" });
        const scalar = takes(Schema.DateFromString);
        scalar(new Date(0));
        scalar("2026-11-07");
        // @ts-expect-error: a number is on neither side
        scalar(1);
      });

      it("takes an application type, or the `Date` it encodes to", () => {
        const input = takes(
          Schema.Struct({ from: Schema.DateTimeUtcFromDate }),
        );
        input({ from: DateTime.makeUnsafe(0) });
        input({ from: new Date(0) });
        // @ts-expect-error: text is on neither side
        input({ from: "2026-11-07" });
      });

      it("takes each member of a union, on either side", () => {
        const input = takes(
          Schema.Union([
            Schema.Struct({
              kind: Schema.Literal("a"),
              n: Schema.FiniteFromString,
            }),
            Schema.Struct({
              kind: Schema.Literal("b"),
              m: Schema.optional(Schema.FiniteFromString),
            }),
          ]),
        );
        input({ kind: "a", n: 1 });
        input({ kind: "a", n: "1" });
        input({ kind: "b" });
        input({ kind: "b", m: "1" });
        // @ts-expect-error: a boolean is on neither side
        input({ kind: "a", n: true });
        // @ts-expect-error: no member has this field
        input({ kind: "b", other: 1 });
      });

      it("takes a member's encoded name under a union", () => {
        const input = takes(
          Schema.Union([
            Schema.Struct({ a: Schema.optional(Schema.FiniteFromString) }),
            Schema.Struct({
              b: Schema.optional(Schema.FiniteFromString),
              c: Schema.optional(Schema.FiniteFromString),
            }).pipe(Schema.encodeKeys({ b: "encoded_b" })),
          ]),
        );
        input({ a: "1" });
        input({ b: 1 });
        input({ encoded_b: "1" });
        input({ encoded_b: "1", c: "2" });
        // @ts-expect-error: no member has this field
        input({ other: "1" });
      });

      it("takes each side of a record and of a struct with rest", () => {
        const record = takes(
          Schema.Record(Schema.String, Schema.FiniteFromString),
        );
        record({ a: 1 });
        record({ a: "1" });
        record({ a: 1, b: "2" });
        // @ts-expect-error: a boolean is on neither side
        record({ a: true });
        const rest = takes(
          Schema.StructWithRest(Schema.Struct({ a: Schema.FiniteFromString }), [
            Schema.Record(
              Schema.String,
              Schema.Union([Schema.Number, Schema.String]),
            ),
          ]),
        );
        rest({ a: 1, b: 2 });
        rest({ a: "1", b: "2" });
        // @ts-expect-error: `a` is required on both sides
        rest({ b: 2 });
      });

      it("takes a nested struct's fields, side by side", () => {
        const input = takes(
          Schema.Struct({
            nested: Schema.Struct({ n: Schema.FiniteFromString }),
          }),
        );
        input({ nested: { n: 1 } });
        input({ nested: { n: "1" } });
        // @ts-expect-error: a boolean is on neither side
        input({ nested: { n: true } });
        // @ts-expect-error: no side has this field
        input({ nested: { n: 1, other: 1 } });
      });
    });
  });
});

describe("a field outside a value's keys", () => {
  const text = Schema.String;
  const NarrowFirst = Schema.Union([
    Schema.Struct({ id: text }),
    Schema.Struct({ id: text, name: text }),
  ]);
  const Apart = Schema.Union([
    Schema.Struct({ id: text }),
    Schema.Struct({ name: text }),
  ]);
  class Person {
    readonly id = "1";
    get name() {
      return "ada";
    }
  }

  it.effect("keeps an accessor on a class, under a union", () =>
    Effect.gen(function* () {
      expect(yield* bodyOf(posted(NarrowFirst), { body: new Person() })).toBe(
        '{"id":"1","name":"ada"}',
      );
    }),
  );

  it.effect("keeps it at any depth", () =>
    Effect.gen(function* () {
      expect(
        yield* bodyOf(posted(Schema.Struct({ who: NarrowFirst })), {
          body: { who: new Person() },
        }),
      ).toBe('{"who":{"id":"1","name":"ada"}}');
      expect(
        yield* bodyOf(posted(Schema.Array(NarrowFirst)), {
          body: [new Person()],
        }),
      ).toBe('[{"id":"1","name":"ada"}]');
    }),
  );

  it.effect("keeps it by its encoded name", () =>
    Effect.gen(function* () {
      class Wire {
        get A() {
          return "x";
        }
      }
      const Renamed = Schema.Struct({ a: Schema.optionalKey(text) }).pipe(
        Schema.encodeKeys({ a: "A" }),
      );
      expect(yield* bodyOf(posted(Renamed), { body: new Wire() })).toBe(
        '{"A":"x"}',
      );
    }),
  );

  it.effect("keeps an inherited field and a hidden one", () =>
    Effect.gen(function* () {
      const inherited: { readonly id: string; readonly name: string } =
        Object.create(
          { name: "ada" },
          {
            id: { value: "1", enumerable: true },
          },
        );
      expect(yield* bodyOf(posted(NarrowFirst), { body: inherited })).toBe(
        '{"id":"1","name":"ada"}',
      );
      const hidden: { readonly id: string; readonly name: string } =
        Object.defineProperty({ id: "1" }, "name", { value: "ada" }) as never;
      expect(yield* bodyOf(posted(NarrowFirst), { body: hidden })).toBe(
        '{"id":"1","name":"ada"}',
      );
    }),
  );

  it.effect("is refused if no member holds it with the rest", () =>
    Effect.gen(function* () {
      expect(
        yield* schemaFailure(posted(Apart), { body: new Person() }),
      ).toContain('["name"]');
    }),
  );

  it.effect("is not taken by a stacked schema that does not state it", () =>
    Effect.gen(function* () {
      class Group {
        readonly a = "1";
        readonly b = "2";
        readonly c = "3";
      }
      const Either = Schema.Union([
        Schema.Struct({ a: text }),
        Schema.Struct({ b: text }),
      ]);
      const Other = Schema.Struct({ c: text });
      for (const request of [stacked(Either, Other), stacked(Other, Either)])
        expect(yield* schemaFailure(request, { query: new Group() })).toContain(
          '["b"]',
        );
    }),
  );

  it.effect("keeps it on a plain struct, field by field", () =>
    Effect.gen(function* () {
      // One field on each side, so neither side reads the whole value.
      class Mixed {
        get a() {
          return 1;
        }
        get b() {
          return "2";
        }
      }
      const Counts = Schema.Struct({
        a: Schema.optionalKey(Schema.FiniteFromString),
        b: Schema.optionalKey(Schema.FiniteFromString),
      });
      expect(Excess.choosing(Counts.ast)).toBe(false);
      expect(yield* bodyOf(posted(Counts), { body: new Mixed() })).toBe(
        '{"a":"1","b":"2"}',
      );
    }),
  );

  it.effect("keeps it inside an instance a declaration could read", () =>
    Effect.gen(function* () {
      class Thing extends Schema.Class<Thing>("OutsideKeysDeclared")({
        who: Schema.optionalKey(NarrowFirst),
      }) {}
      const Either = Schema.Union([Thing, Schema.Struct({ other: text })]);
      class Wrapper {
        readonly who = new Person();
      }
      expect(yield* bodyOf(posted(Either), { body: new Wrapper() })).toBe(
        '{"who":{"id":"1","name":"ada"}}',
      );
    }),
  );

  it.effect("compares an instance a class could read as well", () =>
    Effect.gen(function* () {
      class Thing extends Schema.Class<Thing>("OutsideKeysCompared")({
        a: Schema.optionalKey(Schema.FiniteFromString),
        b: Schema.optionalKey(Schema.FiniteFromString),
      }) {}
      // The list as a whole fits no side, and this member's encoded side would strip it all. The
      // types refuse a mix inside a list, so it comes in a wider value.
      const Either = Schema.Union([
        Thing,
        Schema.Struct({ z: Schema.optionalKey(text) }).pipe(
          Schema.encodeKeys({ z: "Z" }),
        ),
      ]);
      class Mixed {
        readonly a = 1;
        readonly b = "2";
      }
      expect(
        yield* schemaFailure(posted(Schema.Array(Either)), {
          body: [new Mixed() as never],
        }),
      ).toContain('[0]["a"]');
    }),
  );

  it.effect("leaves an accessor in an Option to the schema's own reading", () =>
    Effect.gen(function* () {
      const InOption = Schema.Struct({ who: Schema.Option(NarrowFirst) });
      expect(
        yield* bodyOf(posted(InOption), {
          body: { who: Option.some(new Person()) },
        }),
      ).toBe('{"who":{"_tag":"Some","value":{"id":"1"}}}');
    }),
  );

  it.effect("strips a key of a class instance that nothing states", () =>
    Effect.gen(function* () {
      class Wider {
        readonly id = "1";
        readonly extra = "z";
      }
      expect(yield* bodyOf(posted(NarrowFirst), { body: new Wider() })).toBe(
        '{"id":"1"}',
      );
      class Renaming {
        readonly A = "x";
        readonly extra = "z";
      }
      const Renamed = Schema.Struct({ a: Schema.optionalKey(text) }).pipe(
        Schema.encodeKeys({ a: "A" }),
      );
      expect(yield* bodyOf(posted(Renamed), { body: new Renaming() })).toBe(
        '{"A":"x"}',
      );
    }),
  );

  it.effect("leaves a class instance the schema states as it is", () =>
    Effect.gen(function* () {
      class Thing extends Schema.Class<Thing>("OutsideKeysThing")({
        id: text,
      }) {}
      const Either = Schema.Union([Thing, Schema.Struct({ name: text })]);
      expect(
        yield* bodyOf(posted(Either), { body: new Thing({ id: "1" }) }),
      ).toBe('{"id":"1"}');
    }),
  );
});

describe("a value on the encoded side stays there", () => {
  const text = Schema.String;
  const Renamed = Schema.Struct({ a: Schema.optionalKey(text) }).pipe(
    Schema.encodeKeys({ a: "A" }),
  );

  it.effect("keeps an optional field given by its encoded name", () =>
    Effect.gen(function* () {
      const request = queried(Renamed);
      expect(yield* urlOf(request, { query: { A: "x" } })).toBe("/x?A=x");
      expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?A=x");
      expect(yield* urlOf(request, { query: {} })).toBe("/x");
    }),
  );

  it.effect("keeps it beside a field with one name", () =>
    Effect.gen(function* () {
      const Wider = Schema.Struct({
        a: Schema.optionalKey(text),
        b: Schema.optionalKey(text),
      }).pipe(Schema.encodeKeys({ a: "A" }));
      expect(yield* urlOf(queried(Wider), { query: { A: "x", b: "y" } })).toBe(
        "/x?A=x&b=y",
      );
    }),
  );

  it.effect("keeps it in headers", () =>
    Effect.gen(function* () {
      const Named = Schema.Struct({ "x-a": Schema.optionalKey(text) }).pipe(
        Schema.encodeKeys({ "x-a": "x-wire" }),
      );
      expect(
        yield* linesOf(Request.get("/x").pipe(Request.headers(Named)), {
          headers: { "x-wire": "1" },
        }),
      ).toEqual([["x-wire", "1"]]);
    }),
  );

  it.effect("keeps it at any depth, and in a class's field", () =>
    Effect.gen(function* () {
      expect(
        yield* sentBy(Schema.Struct({ f: Renamed }), { f: { A: "x" } }),
      ).toBe('{"f":{"A":"x"}}');
      expect(yield* sentBy(Schema.Array(Renamed), [{ A: "x" }])).toBe(
        '[{"A":"x"}]',
      );
      class Held extends Schema.Class<Held>("HeldRenamed")({ f: Renamed }) {}
      expect(yield* sentBy(Held, { f: { A: "x" } })).toBe('{"f":{"A":"x"}}');
    }),
  );

  it.effect("keeps it from a constructor default that would stand in", () =>
    Effect.gen(function* () {
      const Defaulted = Schema.Struct({
        a: text.pipe(Schema.withConstructorDefault(Effect.succeed("d"))),
      }).pipe(Schema.encodeKeys({ a: "A" }));
      const request = queried(Defaulted);
      expect(yield* urlOf(request, { query: { A: "x" } })).toBe("/x?A=x");
      expect(yield* urlOf(request, { query: {} })).toBe("/x?A=d");
    }),
  );

  it.effect("keeps what a transformation between objects renames", () =>
    Effect.gen(function* () {
      const Reshaped = reshaped(
        Schema.Struct({ x: Schema.optionalKey(text) }),
        Schema.Struct({ y: Schema.optionalKey(text) }),
        ({ x }) => (x === undefined ? {} : { y: x }),
        ({ y }) => (y === undefined ? {} : { x: y }),
      );
      expect(yield* urlOf(queried(Reshaped), { query: { x: "1" } })).toBe(
        "/x?x=1",
      );
      expect(yield* urlOf(queried(Reshaped), { query: { y: "1" } })).toBe(
        "/x?x=1",
      );
    }),
  );

  it.effect("keeps a field only the encoded side states", () =>
    Effect.gen(function* () {
      const Fewer = reshaped(
        Schema.Struct({
          a: Schema.optionalKey(text),
          b: Schema.optionalKey(text),
        }),
        Schema.Struct({ a: Schema.optionalKey(text) }),
        ({ a, b }) => {
          const value = a ?? b;
          return value === undefined ? {} : { a: value };
        },
        (value) => value,
      );
      expect(yield* urlOf(queried(Fewer), { query: { b: "1" } })).toBe(
        "/x?a=1",
      );
    }),
  );

  it.effect("keeps a field under a record on the encoded side", () =>
    Effect.gen(function* () {
      const FromRecord = reshaped(
        Schema.Record(text, text),
        Schema.Struct({ y: Schema.optionalKey(text) }),
        ({ x }) => (x === undefined ? {} : { y: x }),
        ({ y }) => (y === undefined ? {} : { x: y }),
      );
      expect(yield* urlOf(queried(FromRecord), { query: { x: "1" } })).toBe(
        "/x?x=1",
      );
    }),
  );

  it.effect("keeps a field under a union on the encoded side", () =>
    Effect.gen(function* () {
      const FromEither = reshaped(
        Schema.Union([Schema.Struct({ x: Schema.optionalKey(text) }), text]),
        Schema.Struct({ y: Schema.optionalKey(text) }),
        (value) =>
          typeof value === "string"
            ? { y: value }
            : value.x === undefined
              ? {}
              : { y: value.x },
        ({ y }) => (y === undefined ? {} : { x: y }),
      );
      expect(yield* sentBy(FromEither, { x: "1" })).toBe('{"x":"1"}');
    }),
  );

  it.effect("leaves text under a wire name to the schema's own reading", () =>
    Effect.gen(function* () {
      const Apart = Schema.Union([
        Schema.Struct({ a: text }),
        Schema.Struct({ b: text }),
      ]);
      const InText = Schema.Struct({ f: Schema.fromJsonString(Apart) }).pipe(
        Schema.encodeKeys({ f: "F" }),
      );
      const url = yield* urlOf(queried(InText), {
        query: { F: '{"a":"1","b":"2"}' },
      });
      expect(new URL(url, "http://x.test").searchParams.get("F")).toBe(
        '{"a":"1"}',
      );
    }),
  );

  it.effect("reads a union under a wire name, and names the field", () =>
    Effect.gen(function* () {
      const Apart = Schema.Union([
        Schema.Struct({ a: text }),
        Schema.Struct({ b: text }),
      ]);
      const Plain = Schema.Struct({ f: Apart }).pipe(
        Schema.encodeKeys({ f: "F" }),
      );
      expect(yield* sentBy(Plain, { F: { b: "2" } })).toBe('{"F":{"b":"2"}}');
      expect(
        yield* schemaFailure(
          Request.post("/x").pipe(Request.body(Body.jsonSchema(Plain))),
          { body: { F: { a: "1", b: "2" } } },
        ),
      ).toContain('["F"]["b"]');
    }),
  );

  it.effect("leaves an Option of it to the schema's own reading", () =>
    Effect.gen(function* () {
      const InOption = Schema.Struct({ f: Schema.Option(Renamed) });
      expect(Excess.choosing(InOption.ast)).toBe(false);
      for (const value of [{ A: "x" }, { A: "x", z: "z" }])
        expect(yield* sentBy(InOption, { f: Option.some(value) })).toBe(
          '{"f":{"_tag":"Some","value":{}}}',
        );
      expect(yield* sentBy(InOption, { f: Option.none() })).toBe(
        '{"f":{"_tag":"None"}}',
      );
    }),
  );

  it.effect("still strips a key neither side states", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(queried(Renamed), { query: { a: "x", stray: "z" } }),
      ).toBe("/x?A=x");
      expect(
        yield* urlOf(queried(Renamed), { query: { A: "x", stray: "z" } }),
      ).toBe("/x?A=x");
    }),
  );

  it.effect("still strips a stray key inside text, as a struct does", () =>
    Effect.gen(function* () {
      const InText = Schema.Struct({
        f: Schema.fromJsonString(Schema.Struct({ g: Renamed })),
      });
      const { request } = yield* compile(queried(InText), {
        query: { f: '{"g":{"A":"x"},"z":"1"}' },
      });
      expect(new URL(request.url, "http://x.test").searchParams.get("f")).toBe(
        '{"g":{"A":"x"}}',
      );
    }),
  );

  it.effect("still strips a stray key in text under a wire name", () =>
    Effect.gen(function* () {
      const InText = Schema.Struct({
        f: Schema.fromJsonString(Schema.Struct({ a: text })),
      }).pipe(Schema.encodeKeys({ f: "F" }));
      const { request } = yield* compile(queried(InText), {
        query: { F: '{"a":"1","z":"2"}' },
      });
      expect(new URL(request.url, "http://x.test").searchParams.get("F")).toBe(
        '{"a":"1"}',
      );
    }),
  );

  it.effect("reads the decoded name beside its encoded twin", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(queried(Renamed), { query: { a: "1", A: "2" } }),
      ).toBe("/x?A=1");
    }),
  );

  it.effect("refuses a value that mixes two renamed fields' names", () =>
    Effect.gen(function* () {
      const Both = Schema.Struct({
        a: Schema.optionalKey(text),
        b: Schema.optionalKey(text),
      }).pipe(Schema.encodeKeys({ a: "A", b: "B" }));
      expect(
        yield* schemaFailure(queried(Both), { query: { a: "1", B: "2" } }),
      ).toContain('["B"]');
    }),
  );

  it.effect("stays on the plain read for a struct with one set of names", () =>
    Effect.gen(function* () {
      const Same = Schema.Struct({ a: Schema.optionalKey(text) });
      expect(Excess.choosing(Same.ast)).toBe(false);
      expect(yield* urlOf(queried(Same), { query: { a: "x" } })).toBe("/x?a=x");
    }),
  );
});
