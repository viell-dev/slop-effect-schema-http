import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Exit,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaParser,
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
  strictOnlyCheck,
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

/** A value that inherits a field from its own prototype, beside its own fields. */
const inheriting = (name: string, fields: object): object =>
  Object.assign(Object.create({ [name]: "x" }) as object, fields);

/** A value that holds the list `[{ limit: "x" }]` behind an accessor named `items`. */
const gettingItems = (fields: object): object =>
  Object.defineProperty(fields, "items", {
    enumerable: true,
    get: () => [{ limit: "x" }],
  });

/** A field written under the wire name `__proto__`, given as `JSON.parse` makes it. */
const protoWire = (): never =>
  JSON.parse('{"n":1,"m":"2","__proto__":"x"}') as never;

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

  it.effect(
    "prepares a deep recursive struct with a renamed key reading its self-reference a fixed number of times a level, on either side",
    () =>
      Effect.gen(function* () {
        // 0.20.0 read each level below a renamed field about twice as often as the level above it,
        // so 20 levels took seconds and 200 would never finish
        // (https://github.com/viell-dev/slop-effect-schema-http/issues/355). Counting the reads
        // of the self-reference, which Effect's encoded projection of it makes through the same
        // property, measures that work without timing it. Preparation reads it 3 times a level;
        // 0.19.0 read it more often the deeper the value. Past the budget the read throws, so a
        // walk that repeats work fails here at once instead of running on.
        const depth = 200;
        const budget = 10 * depth;
        const rows = {
          text: {
            held: Schema.String,
            decoded: (at: number) => `x${at}`,
            encoded: (at: number) => `x${at}`,
          },
          option: {
            held: Schema.OptionFromNullOr(Schema.Struct({ a: Schema.String })),
            decoded: (at: number) =>
              at % 2 === 0 ? Option.some({ a: `x${at}` }) : Option.none(),
            encoded: (at: number) => (at % 2 === 0 ? { a: `x${at}` } : null),
          },
        };
        for (const [kind, { held, decoded, encoded }] of Object.entries(rows))
          for (const list of [false, true])
            for (const side of ["decoded", "encoded"] as const) {
              let reads = 0;
              const self = Schema.suspend(
                (): Schema.Codec<unknown, unknown> => Row,
              );
              const target = self.ast.thunk;
              Object.assign(self.ast, {
                thunk: () => {
                  if (++reads > budget)
                    throw new Error(`read the self-reference ${reads} times`);
                  return target();
                },
              });
              const Row: Schema.Codec<unknown, unknown> = Schema.Struct({
                held,
                child: list ? Schema.Array(self) : Schema.NullOr(self),
              }).pipe(Schema.encodeKeys({ held: "wire_held" }));
              // Built from the deepest row up: each row holds the one below it as its child.
              let child: unknown = list ? [] : null;
              let written = list ? "[]" : "null";
              let body: unknown;
              let sent = "";
              for (let at = depth - 1; at >= 0; at--) {
                body =
                  side === "decoded"
                    ? { held: decoded(at), child }
                    : { wire_held: encoded(at), child };
                sent = `{"wire_held":${JSON.stringify(encoded(at))},"child":${written}}`;
                child = list ? [body] : body;
                written = list ? `[${sent}]` : sent;
              }
              const request = Request.post("/rows").pipe(
                Request.body(Body.jsonSchema(Row)),
              );
              expect(
                yield* bodyOf(request, { body }),
                `${kind}, ${list ? "list" : "nullable"}, ${side}`,
              ).toBe(sent);
              expect(reads).toBeLessThanOrEqual(budget);
              // At least once a level, so the count measures the walk and a cache in front of
              // the thunk cannot pass this unmeasured.
              expect(reads).toBeGreaterThanOrEqual(depth);
            }
      }),
    // The budget above is the check. This limit only leaves room for slow machines: the eight
    // requests take about a second here, and their time still grows faster than the depth
    // (https://github.com/viell-dev/slop-effect-schema-http/issues/366).
    60_000,
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

  it.effect("refuses a name beside its encoded twin", () =>
    Effect.gen(function* () {
      for (const A of ["1", "2"])
        expect(
          yield* schemaFailure(queried(Renamed), { query: { a: "1", A } }),
        ).toContain('["A"]');
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

// https://github.com/viell-dev/slop-effect-schema-http/issues/241
describe("a field a part lost under a parent read field by field", () => {
  const Filter = Schema.Struct({
    limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
      Schema.withConstructorDefault(Effect.succeed(25)),
    ),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const n = Schema.FiniteFromString;
  const Inner = Schema.Struct({ m: n, f: Filter });
  const Cursor = Schema.Struct({ cursor: Schema.String });
  /**
   * A decoded `n: 1` beside the part makes its parent read field by field. Each refusal gives the
   * decoded side's own error, except where the item it is in also holds an encoded value, which
   * stops the decoded side before it reaches the field.
   */
  const decodedLost = [
    [
      Schema.Struct({ n, f: Filter }),
      { n: 1, f: { limit: "x" } },
      '["f"]["limit"]',
      "Expected number",
    ],
    [
      Schema.Struct({ n, f: Schema.optionalKey(Filter) }),
      { n: 1, f: { limit: "x" } },
      '["f"]["limit"]',
      "Expected number",
    ],
    [
      Schema.Struct({ n, r: Schema.Record(Schema.String, Filter) }),
      { n: 1, r: { a: { limit: "x" } } },
      '["r"]["a"]["limit"]',
      "Expected number",
    ],
    [
      Schema.Struct({ n, t: Schema.Tuple([Filter]) }),
      { n: 1, t: [{ limit: "x" }] },
      '["t"][0]["limit"]',
      "Expected number",
    ],
    [
      Schema.Struct({ n, items: Schema.Array(Inner) }),
      { n: 1, items: [{ m: "1", f: { limit: "x" } }] },
      '["items"][0]["f"]["limit"]',
      "The schema cannot keep this field with the rest of the value",
    ],
    [
      Schema.Struct({ n, inner: Inner }),
      { n: 1, inner: { m: 1, f: { limit: "x" } } },
      '["inner"]["f"]["limit"]',
      "Expected number",
    ],
    [
      Schema.Struct({ n, f: Schema.Union([Filter, Cursor]) }),
      { n: 1, f: { limit: "x" } },
      '["f"]["limit"]',
      "Expected number",
    ],
    [
      Schema.Union([Schema.Struct({ n, f: Filter }), Cursor]),
      { n: 1, f: { limit: "x" } },
      '["f"]["limit"]',
      "Expected number",
    ],
  ] as const;
  /**
   * Encoded names throughout, which the part's own constructor reads as excess keys. Only a strict
   * read refuses the value, so each refusal gives the generic message.
   */
  const encodedLost = [
    [
      Schema.Struct({ n, f: Filter }),
      { n: "1", f: { page_size: "many" } },
      '["f"]["page_size"]',
      "The schema cannot keep this field with the rest of the value",
    ],
    [
      Schema.Struct({ n, items: Schema.Array(Filter) }),
      { n: "1", items: [{ page_size: "many" }] },
      '["items"][0]["page_size"]',
      "The schema cannot keep this field with the rest of the value",
    ],
  ] as const;
  /** Valid fields on either side, and defaults for fields the caller left out. */
  const kept = [
    [
      Schema.Struct({ n, f: Filter }),
      { n: 1, f: {} },
      '{"n":"1","f":{"page_size":"25"}}',
    ],
    [
      Schema.Struct({ n, items: Schema.Array(Filter) }),
      { n: 1, items: [{ limit: 5 }, {}] },
      '{"n":"1","items":[{"page_size":"5"},{"page_size":"25"}]}',
    ],
    // A second decoded field keeps the whole decode from reading the valid alias.
    [
      Schema.Struct({ n, m: n, f: Filter }),
      { n: "1", m: 1, f: { page_size: "05" } },
      '{"n":"1","m":"1","f":{"page_size":"5"}}',
    ],
    [
      Schema.Struct({ n, inner: Inner }),
      { n: 1, inner: { m: 1, f: { page_size: "03" } } },
      '{"n":"1","inner":{"m":"1","f":{"page_size":"3"}}}',
    ],
    [
      Schema.Struct({ n, m: n, e: Schema.Struct({}) }),
      { n: "1", m: 1, e: { tag: "a" } },
      '{"n":"1","m":"1","e":{"tag":"a"}}',
    ],
  ] as const;

  // https://github.com/viell-dev/slop-effect-schema-http/issues/275
  it.effect("refuses the field the part lost, as at the root", () =>
    Effect.gen(function* () {
      for (const [schema, input, field, message] of [
        ...decodedLost,
        ...encodedLost,
      ])
        expect(
          yield* schemaFailure(posted(schema), { body: input } as never),
        ).toBe(`${message}\n  at ${field}`);
      const pathed = Request.get("").pipe(
        Request.path(decodedLost[0][0], () => "/x"),
      );
      expect(
        yield* schemaFailure(pathed, { path: decodedLost[0][1] } as never),
      ).toContain('["f"]["limit"]');
    }),
  );

  it.effect("keeps valid parts and fills defaults for omitted fields", () =>
    Effect.gen(function* () {
      for (const [schema, input, sent] of kept)
        expect(yield* sentBy(schema, input as never)).toBe(sent);
    }),
  );

  it.effect(
    "reads a part on its encoded side where its constructor would lose a field",
    () =>
      Effect.gen(function* () {
        // The instance's own property fails the strict write, so the whole value is read again
        // as Effect reads it. The part's constructor then strips `page_size` for a default.
        class Counted extends Schema.Class<Counted>("Counted")({
          a: Schema.String,
        }) {
          readonly reads = 1;
        }
        const schema = Schema.Struct({ n, m: n, f: Filter, c: Counted });
        const c = new Counted({ a: "x" });
        expect(
          yield* sentBy(schema, { n: "1", m: 1, f: { page_size: "05" }, c }),
        ).toBe('{"n":"1","m":"1","f":{"page_size":"5"},"c":{"a":"x"}}');
        expect(
          yield* schemaFailure(posted(schema), {
            body: { n: "1", m: 1, f: { page_size: "many" }, c },
          }),
        ).toContain('["f"]["page_size"]');
        expect(
          yield* schemaFailure(posted(schema), {
            body: { n: 1, m: 1, f: { limit: "x" }, c } as never,
          }),
        ).toContain('["f"]["limit"]');
        // Both names for one field cannot both be kept.
        expect(
          yield* schemaFailure(posted(schema), {
            body: { n: "1", m: 1, f: { page_size: "3", limit: 5 }, c } as never,
          }),
        ).toContain('["f"]["page_size"]');
      }),
  );

  it.effect(
    "keeps a member's loss when another member reads the field loosely",
    () =>
      Effect.gen(function* () {
        // A loose read gives `{}` through `MaybeCursor`, and the parent's constructor would then fill
        // the default through `Filter`.
        const MaybeCursor = Schema.Struct({
          cursor: Schema.optionalKey(Schema.String),
        });
        const f = Schema.Union([Filter, MaybeCursor]);
        for (const [schema, wrap, field] of [
          [Schema.Struct({ n, m: n, f }), (item: object) => item, '["f"]'],
          [
            Schema.Struct({ n, m: n, f: Schema.Array(f) }),
            (item: object) => [item],
            '["f"][0]',
          ],
        ] as const) {
          expect(
            yield* schemaFailure(posted(schema), {
              body: { n: 1, m: "1", f: wrap({ page_size: "many" }) },
            } as never),
          ).toBe(
            `The schema cannot keep this field with the rest of the value\n  at ${field}["page_size"]`,
          );
          expect(
            JSON.parse(
              (yield* sentBy(schema, {
                n: 1,
                m: "1",
                f: wrap({ page_size: "05" }),
              } as never))!,
            ),
          ).toEqual({ n: "1", m: "1", f: wrap({ page_size: "5" }) });
        }
      }),
  );

  it.effect("does not count a decoding default as the field a part lost", () =>
    Effect.gen(function* () {
      const Defaulted = Schema.Struct({
        limit: n.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("25")),
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
      }).pipe(Schema.encodeKeys({ limit: "page_size" }));
      expect(
        yield* schemaFailure(posted(Schema.Struct({ n, m: n, f: Defaulted })), {
          body: { n: 1, m: "1", f: { limit: "x" } },
        } as never),
      ).toContain('["f"]["limit"]');
    }),
  );

  it.effect("reads nothing inside an opaque field it does not change", () =>
    Effect.gen(function* () {
      const opaque = Schema.declare(
        (input): input is object => typeof input === "object" && input !== null,
      );
      const schema = Schema.Struct({ n, m: n, opaque });
      const path = Request.get("").pipe(
        Request.path(schema, ({ n: first, m }) => `/${first}/${m}`),
      );
      let reads = 0;
      for (const get of [
        () => {
          reads++;
          return "v";
        },
        () => {
          throw new Error("read an opaque field");
        },
      ]) {
        const value = Object.defineProperty({}, "annotation", {
          enumerable: true,
          get,
        });
        expect(
          yield* urlOf(path, {
            path: { n: 1, m: "2", opaque: value },
          } as never),
        ).toBe("/1/2");
      }
      expect(reads).toBe(0);
    }),
  );

  it.effect("adds no reads of an opaque field on the fieldwise fallback", () =>
    Effect.gen(function* () {
      class Counted extends Schema.Class<Counted>("Counted")({
        a: Schema.String,
      }) {
        readonly reads = 1;
      }
      const opaque = Schema.declare(
        (input): input is object => typeof input === "object" && input !== null,
      );
      // The instance's own property fails the strict write, so the value is read again by field.
      for (const [schema, place] of [
        [
          Schema.Struct({ n, m: n, f: Filter, o: opaque, c: Counted }),
          (o: object) => ({ o }),
        ],
        [
          Schema.Struct({
            n,
            m: n,
            f: Filter,
            inner: Schema.Struct({ o: opaque }),
            c: Counted,
          }),
          (o: object) => ({ inner: { o } }),
        ],
      ] as const) {
        let reads = 0;
        const o = Object.defineProperty({}, "annotation", {
          enumerable: true,
          get: () => {
            reads++;
            return "v";
          },
        });
        const path = Request.get("").pipe(
          Request.path(schema, (value) => `/${JSON.stringify(value.f)}`),
        );
        expect(
          yield* urlOf(path, {
            path: {
              n: "1",
              m: 1,
              f: { page_size: "05" },
              ...place(o),
              c: new Counted({ a: "x" }),
            },
          } as never),
        ).toBe('/{"page_size":"5"}');
        // The root's own normalisation reads it; the fallback reads nothing it keeps unchanged.
        expect(reads).toBeLessThanOrEqual(2);
      }
    }),
  );

  /** A field that only the relaxed write can send: the strict write refuses the `b` it carries. */
  const Relaxing = Schema.Struct({ a: Schema.String }).pipe(
    Schema.decodeTo(
      Schema.Struct({ b: Schema.String }),
      SchemaTransformation.transform({
        decode: ({ a }) => ({ b: a }),
        encode: (value) => ({ ...value, a: value.b }),
      }),
    ),
  );
  /** A field schema that needs no services. */
  type Field = Schema.Codec<unknown, unknown>;
  /** Each place a part can be read in, with and without a sibling that relaxes the write. */
  const placings = [
    [(part: Field): Field => part, (value: object) => value, ""],
    [
      (part: Field): Field => Schema.Struct({ part }),
      (value: object) => ({ part: value }),
      '["part"]',
    ],
    [
      (part: Field): Field => Schema.Array(part),
      (value: object) => [value],
      "[0]",
    ],
  ] as const;
  /**
   * A parent read field by field around a part, as a decoded `n` beside an encoded `m` makes it, and
   * optionally a sibling that relaxes the write.
   */
  const parentOf = (field: Field, relaxing: boolean) => ({
    schema: relaxing
      ? Schema.Struct({ n, m: n, f: field, rename: Relaxing })
      : Schema.Struct({ n, m: n, f: field }),
    /** The caller's value around the part's input. */
    body: (f: object) =>
      ({
        n: 1,
        m: "2",
        f,
        ...(relaxing && { rename: { b: "ok" } }),
      }) as never,
    /** What the parent sends around what the part writes. */
    sent: (f: object) =>
      JSON.stringify({
        n: "1",
        m: "2",
        f,
        ...(relaxing && { rename: { a: "ok" } }),
      }),
  });

  it.effect("does not count a key a part's decoder makes as the caller's", () =>
    Effect.gen(function* () {
      const Scratch = Schema.Struct({ p: Schema.String }).pipe(
        Schema.decodeTo(
          Schema.Struct({ p: Schema.Number }),
          SchemaTransformation.transform({
            // The decoder leaves a working key behind on the value it makes.
            decode: ({ p }): { readonly p: number } =>
              Object.assign({ p: Number(p) }, { scratch: 99 }),
            encode: ({ p }) => ({ p: String(p) }),
          }),
        ),
      );
      const Echo = Schema.Struct({ a: Schema.String }).pipe(
        Schema.decodeTo(
          Schema.Struct({ b: Schema.String }),
          SchemaTransformation.transform({
            // The decoder keeps its input's `a` beside the `b` it makes.
            decode: ({ a }): { readonly b: string } =>
              Object.assign({ b: a }, { a }),
            encode: ({ b }) => ({ a: b }),
          }),
        ),
      );
      for (const [field, input] of [
        [Scratch, { p: "2" }],
        [Echo, { a: "x" }],
      ] as const)
        for (const [place, wrap] of placings)
          for (const relaxing of [false, true]) {
            const parent = parentOf(place(field), relaxing);
            expect(yield* sentBy(parent.schema, parent.body(wrap(input)))).toBe(
              parent.sent(wrap(input)),
            );
          }
    }),
  );

  /** A second reading of `page_size`, as a word, which `Filter` would replace with its default. */
  const Word = Schema.Struct({ word: Schema.String }).pipe(
    Schema.encodeKeys({ word: "page_size" }),
  );

  it.effect(
    "keeps the member a part was read by when its parent is made again",
    () =>
      Effect.gen(function* () {
        const f = Schema.Union([Filter, Word]);
        for (const [place, wrap] of placings) {
          for (const relaxing of [false, true]) {
            const parent = parentOf(place(f), relaxing);
            expect(
              yield* sentBy(
                parent.schema,
                parent.body(wrap({ page_size: "05" })),
              ),
            ).toBe(parent.sent(wrap({ page_size: "5" })));
          }
          const alone = parentOf(place(f), false);
          expect(
            yield* sentBy(
              alone.schema,
              alone.body(wrap({ page_size: "many" })),
            ),
          ).toBe(alone.sent(wrap({ page_size: "many" })));
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/250
  it.effect(
    "sends a part through the member it was read by beside a relaxing sibling",
    () =>
      Effect.gen(function* () {
        const f = Schema.Union([Filter, Word]);
        for (const [place, wrap] of placings) {
          const parent = parentOf(place(f), true);
          expect(
            yield* sentBy(
              parent.schema,
              parent.body(wrap({ page_size: "many" })),
            ),
          ).toBe(parent.sent(wrap({ page_size: "many" })));
        }
      }),
  );

  /** Two fields, one decoded and one encoded, which no single side reads. */
  const Pair = Schema.Struct({ p: n, q: n });
  const pair = { p: 1, q: "2" };

  it.effect(
    "takes a later member's lossless reading over an earlier lossy one",
    () =>
      Effect.gen(function* () {
        // `Short` reads the pair by dropping `q`, but cannot write `p` as one character.
        const Short = Schema.Struct({
          p: n.pipe(
            Schema.encodeTo(Schema.String.check(Schema.isMinLength(2)), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.passthrough(),
            }),
          ),
        });
        for (const relaxing of [false, true]) {
          const parent = parentOf(Schema.Union([Short, Pair]), relaxing);
          expect(yield* sentBy(parent.schema, parent.body(pair))).toBe(
            parent.sent({ p: "1", q: "2" }),
          );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/250
  it.effect(
    "sends a lossless reading through its member beside a relaxing sibling",
    () =>
      Effect.gen(function* () {
        const MaybeCursor = Schema.Struct({
          cursor: Schema.optionalKey(Schema.String),
        });
        for (const relaxing of [false, true]) {
          const parent = parentOf(Schema.Union([MaybeCursor, Pair]), relaxing);
          expect(yield* sentBy(parent.schema, parent.body(pair))).toBe(
            parent.sent({ p: "1", q: "2" }),
          );
        }
      }),
  );

  // A part is checked only where it is plain data throughout: own data properties of plain objects
  // and lists, and a schema that names no field every object has. Elsewhere it reads as Effect
  // reads it, as the root does where its own value is not plain data.

  it.effect(
    "reads a part whose schema names a field every object has as Effect reads it",
    () =>
      Effect.gen(function* () {
        for (const name of [
          "label",
          "toString",
          "constructor",
          "valueOf",
          "hasOwnProperty",
        ]) {
          const Renamed = Schema.Struct({
            [name]: Schema.String,
            a: Schema.String,
          }).pipe(Schema.encodeKeys({ [name]: "w" })) as unknown as Field;
          const parent = parentOf(Renamed, false);
          expect(
            yield* sentBy(parent.schema, parent.body({ w: "x", a: "y" })),
          ).toBe(parent.sent({ w: "x", a: "y" }));
        }
        // Effect 4.1.4 reads only a `constructor` the value holds, and Effect 4.0.7 reads the
        // inherited one and refuses it.
        const Optional = Schema.Struct({
          a: Schema.Number,
          b: n,
          constructor: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ b: "w_b" } as never));
        const part = { a: 1, w_b: "1" };
        const sent = yield* Effect.exit(
          sentBy(Schema.Struct({ a: Optional, rename: Relaxing }), {
            a: part,
            rename: { b: "go" },
          } as never),
        );
        if (Exit.isSuccess(Schema.decodeUnknownExit(Optional)(part)))
          expect(sent).toEqual(
            Exit.succeed('{"a":{"a":1,"w_b":"1"},"rename":{"a":"go"}}'),
          );
        else expect(Exit.isFailure(sent)).toBe(true);
      }),
  );

  it.effect(
    "reads a field a part's value inherits from its own prototype as Effect reads it",
    () =>
      Effect.gen(function* () {
        // Effect 4.1.4 reads a field named after an `Object.prototype` member only as the value's
        // own; Effect 4.0.7 also reads one the value inherits from its own prototype. A strict read
        // takes an inherited field for a key, so a value inside plain data keeps it, and a field that
        // is no plain data itself reads as the installed Effect does.
        for (const name of [
          "toString",
          "constructor",
          "valueOf",
          "hasOwnProperty",
        ]) {
          const read = Object.hasOwn(
            Schema.decodeUnknownSync(
              Schema.Struct({ [name]: Schema.optionalKey(Schema.String) }),
            )(inheriting(name, {})),
            name,
          );
          const Item = Schema.Struct({
            a: n,
            [name]: Schema.optionalKey(Schema.String),
          }) as unknown as Field;
          const item = () => inheriting(name, { a: "6" });
          const written = { a: "6", [name]: "x" };
          for (const [field, value, sent] of [
            [
              Schema.Tuple([Item, n]) as unknown as Field,
              () => [item(), "1"],
              [written, "1"],
            ],
            [Schema.Array(Item) as Field, () => [item()], [written]],
            [
              Schema.Record(Schema.String, Item) as Field,
              () => ({ k: item() }),
              { k: written },
            ],
            [
              Schema.Union([Schema.Array(Item), Schema.String]) as Field,
              () => [item()],
              [written],
            ],
          ] as const) {
            const parent = parentOf(field, true);
            expect(yield* sentBy(parent.schema, parent.body(value()))).toBe(
              parent.sent(sent),
            );
          }
          // The same tuple where only the relaxing sibling makes the root read field by field.
          expect(
            yield* sentBy(
              Schema.Struct({
                f: Schema.Tuple([Item, n]) as unknown as Field,
                rename: Relaxing,
              }),
              { f: [item(), "1"], rename: { b: "ok" } } as never,
            ),
          ).toBe(JSON.stringify({ f: [written, "1"], rename: { a: "ok" } }));
          // A field whose wire name is the inherited one: Effect 4.1.4 sees no `text` there.
          const Wire = Schema.Struct({ text: Schema.String, a: n }).pipe(
            Schema.encodeKeys({ text: name } as never),
          ) as unknown as Field;
          const parent = parentOf(Wire, true);
          const outcome = yield* Effect.exit(
            sentBy(parent.schema, parent.body(inheriting(name, { a: "5" }))),
          );
          if (read)
            expect(outcome).toEqual(
              Exit.succeed(parent.sent({ [name]: "x", a: "5" })),
            );
          else expect(Exit.isFailure(outcome)).toBe(true);
        }
      }),
  );

  it.effect(
    "reads a class instance as Effect reads it, running its getter no more often",
    () =>
      Effect.gen(function* () {
        for (const name of ["label", "constructor", "toString"]) {
          let reads = 0;
          class Holder {
            readonly a = "5";
            get text() {
              reads++;
              return "x";
            }
          }
          const Wire = Schema.Struct({ text: Schema.String, a: n }).pipe(
            Schema.encodeKeys({ text: name } as never),
          ) as unknown as Field;
          for (const relaxing of [false, true]) {
            reads = 0;
            const parent = parentOf(Wire, relaxing);
            expect(
              yield* sentBy(parent.schema, parent.body(new Holder())),
            ).toBe(parent.sent({ [name]: "x", a: "5" }));
            // Effect's own reads run the getter, and preparation runs it no more.
            expect(reads).toBeLessThanOrEqual(7);
          }
        }
        // A class whose method another union member states as a field.
        for (const name of ["toString", "valueOf"]) {
          class Methods {
            readonly a = "";
            readonly b = true;
          }
          Object.defineProperty(Methods.prototype, name, {
            value: () => "v",
            configurable: true,
          });
          const parent = parentOf(
            Schema.Union([
              Schema.Struct({ b: n, [name]: Schema.Boolean }),
              Schema.Struct({ a: Schema.String, b: Schema.Boolean }),
            ]) as unknown as Field,
            false,
          );
          expect(yield* sentBy(parent.schema, parent.body(new Methods()))).toBe(
            parent.sent({ a: "", b: true }),
          );
        }
      }),
  );

  it.effect("reads a part held behind a getter as Effect reads it", () =>
    Effect.gen(function* () {
      for (const name of ["label", "toString", "constructor", "valueOf"]) {
        const Wire = Schema.Struct({ text: Schema.String, a: n }).pipe(
          Schema.encodeKeys({ text: name } as never),
        ) as unknown as Field;
        const parent = parentOf(Wire, false);
        const sent = parent.sent({ [name]: "x", a: "5" });
        const held = Object.defineProperty({ n: 1, m: "2" }, "f", {
          enumerable: true,
          get: () => ({ text: "x", a: "5" }),
        });
        expect(yield* sentBy(parent.schema, held as never)).toBe(sent);
        class Getting {
          readonly n = 1;
          readonly m = "2";
          get f() {
            return { text: "x", a: "5" };
          }
        }
        expect(yield* sentBy(parent.schema, new Getting() as never)).toBe(sent);
      }
    }),
  );

  it.effect("keeps an own __proto__ field as Effect does", () =>
    Effect.gen(function* () {
      // `JSON.parse` makes `__proto__` an own field. Effect keeps it, and so does each part.
      const optional = Schema.optionalKey(Schema.String);
      expect(
        yield* sentBy(
          Schema.Struct({ n, m: n, ["__proto__"]: optional, rename: Relaxing }),
          JSON.parse(
            '{"n":1,"m":"2","__proto__":"x","rename":{"b":"ok"}}',
          ) as never,
        ),
      ).toBe('{"n":"1","m":"2","__proto__":"x","rename":{"a":"ok"}}');
      expect(
        yield* sentBy(
          Schema.Struct({
            n,
            m: n,
            f: Schema.Struct({ a: n, b: n, ["__proto__"]: optional }),
            rename: Relaxing,
          }),
          JSON.parse(
            '{"n":1,"m":"2","f":{"a":1,"b":"2","__proto__":"x"},"rename":{"b":"ok"}}',
          ) as never,
        ),
      ).toBe(
        '{"n":"1","m":"2","f":{"a":"1","b":"2","__proto__":"x"},"rename":{"a":"ok"}}',
      );
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/275
  it.effect("refuses a field given under both names", () =>
    Effect.gen(function* () {
      const Wire = Schema.Struct({ text: Schema.String, a: n }).pipe(
        Schema.encodeKeys({ text: "label" }),
      ) as unknown as Field;
      const parent = parentOf(Wire, false);
      expect(
        yield* schemaFailure(posted(parent.schema), {
          body: parent.body({ text: "x", label: "y", a: "5" }),
        }),
      ).toBe(
        'This field is given under both "text" and "label"; give it under one name\n  at ["f"]["label"]',
      );
    }),
  );

  /** `text` written as a name every object has, and the body that gives both of its names. */
  const bothNames = (name: string) => {
    const parent = parentOf(
      Schema.Struct({ text: Schema.String, a: n }).pipe(
        Schema.encodeKeys({ text: name } as never),
      ) as unknown as Field,
      false,
    );
    return {
      schema: parent.schema,
      body: parent.body({ text: "x", [name]: "y", a: "5" }),
      sent: parent.sent({ [name]: "y", a: "5" }),
    };
  };

  // https://github.com/viell-dev/slop-effect-schema-http/issues/241
  it.effect("reads a wire name every object has as Effect does", () =>
    Effect.gen(function* () {
      for (const name of ["toString", "constructor"]) {
        const { schema, body, sent } = bothNames(name);
        expect(yield* sentBy(schema, body)).toBe(sent);
      }
    }),
  );

  const Page = Schema.Struct({ n, items: Schema.Array(Filter) });
  const Wrapped = Schema.Struct({
    n,
    page: Schema.Struct({ items: Schema.Array(Filter) }),
  });

  /**
   * The list `Filter` loses a field of, behind a getter or in a class instance, at the root and
   * in a field of a plain root: each schema, the caller's value, what is sent, and where it fails.
   */
  const notPlain = () => {
    class Root {
      readonly n = 1;
      readonly items = [{ limit: "x" }];
    }
    class List {
      readonly items = [{ limit: "x" }];
    }
    const root = '{"n":"1","items":[{"page_size":"25"}]}';
    const inField = '{"n":"1","page":{"items":[{"page_size":"25"}]}}';
    return [
      [Page, gettingItems({ n: 1 }), root, '["items"][0]["limit"]'],
      [Page, new Root(), root, '["items"][0]["limit"]'],
      [
        Wrapped,
        { n: 1, page: gettingItems({}) },
        inField,
        '["page"]["items"][0]["limit"]',
      ],
      [
        Wrapped,
        { n: 1, page: new List() },
        inField,
        '["page"]["items"][0]["limit"]',
      ],
    ] as const;
  };

  // https://github.com/viell-dev/slop-effect-schema-http/issues/241
  it.effect("reads a part that is not plain data as Effect does", () =>
    Effect.gen(function* () {
      for (const [schema, body, sent] of notPlain())
        expect(yield* sentBy(schema as Field, body as never)).toBe(sent);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/262
  it.effect("names the innermost fields a refusal covers", () =>
    Effect.gen(function* () {
      // The relaxed write drops the list that the field's own reading already lost items of.
      const schema = Schema.Struct({
        n,
        c: Schema.Union([
          Schema.Struct({ b: Schema.Array(Filter), meta: Schema.Unknown }),
          Schema.Struct({ x: Schema.optionalKey(Schema.String) }),
        ]),
      });
      const items = [{ page_size: "many" }, { page_size: "x" }];
      const message = yield* schemaFailure(posted(schema), {
        body: { n: 1, c: { b: items, meta: 1n } },
      } as never);
      expect(message.match(/at .*/g)).toEqual([
        'at ["c"]["b"][0]["page_size"]',
        'at ["c"]["b"][1]["page_size"]',
        'at ["c"]["meta"]',
      ]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/262
  it.effect("checks a part a proxy holds as its target", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ n, f: Filter });
      const proxied = (f: object) => ({ body: { n: 1, f: new Proxy(f, {}) } });
      expect(yield* sentBy(schema, proxied({ limit: 5 }).body as never)).toBe(
        '{"n":"1","f":{"page_size":"5"}}',
      );
      for (const f of [
        { limit: "x" },
        Object.freeze({ limit: "x" }),
        Object.assign({ limit: "x" }, { [Symbol("s")]: undefined }),
      ])
        for (const body of [{ n: 1, f }, proxied(f).body])
          expect(
            yield* schemaFailure(posted(schema), { body } as never),
          ).toContain('["f"]["limit"]');
    }),
  );

  /** A field written under the wire name `__proto__`. */
  const ProtoWire = Schema.Struct({
    n,
    m: n,
    text: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ text: "__proto__" }));

  // https://github.com/viell-dev/slop-effect-schema-http/issues/241
  it.effect(
    "drops a field given under the wire name __proto__, as Effect does",
    () =>
      Effect.gen(function* () {
        expect(yield* sentBy(ProtoWire, protoWire())).toBe('{"n":"1","m":"2"}');
      }),
  );
});

/** A request that binds the schema in each place a group can be, and what each refuses. */
const bindings = (schema: Schema.Top) =>
  [
    (value: object) =>
      schemaFailure(posted(schema as never), { body: value } as never),
    (value: object) =>
      schemaFailure(queried(schema as never), { query: value } as never),
    (value: object) =>
      schemaFailure(Request.get("/x").pipe(Request.headers(schema as never)), {
        headers: value,
      } as never),
    (value: object) =>
      schemaFailure(
        Request.get("").pipe(Request.path(schema as never, () => "/sent")),
        { path: value } as never,
      ),
  ] as const;

/** The library's message for a field it cannot keep, where nothing more is known. */
const generic = (at: string) =>
  `The schema cannot keep this field with the rest of the value\n  at ${at}`;

/** An author's message that quotes the value it refuses. */
const rejected = (value: string) => `Rejected ${value}`;

/** A struct of these fields that writes `limit` as `page_size`. */
const pageSized = (fields: Schema.Struct.Fields) =>
  Schema.Struct(fields).pipe(Schema.encodeKeys({ limit: "page_size" }));

// https://github.com/viell-dev/slop-effect-schema-http/issues/275
describe("a refusal says why it cannot keep a field", () => {
  const Filter = Schema.Struct({
    limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
      Schema.withConstructorDefault(Effect.succeed(25)),
    ),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const Required = Schema.Struct({
    limit: Schema.FiniteFromString,
    count: Schema.FiniteFromString,
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  it.effect("names both names of a field given under both", () =>
    Effect.gen(function* () {
      for (const refuse of bindings(Filter))
        for (const value of [
          { limit: 5, page_size: "6" },
          { limit: 5, page_size: "5" },
        ])
          expect(yield* refuse(value)).toBe(
            'This field is given under both "limit" and "page_size"; give it under one name\n  at ["page_size"]',
          );
    }),
  );

  it.effect(
    "gives the loose read's error for a wire-named value beside a stray key",
    () =>
      Effect.gen(function* () {
        // The decoder strips the stray key reading with the caller's options, and that read reports
        // the value. `count` is a stray key to `Filter`.
        for (const refuse of bindings(Filter))
          expect(yield* refuse({ page_size: "many", count: "1" })).toBe(
            'Expected a finite number\n  at ["page_size"]',
          );
        for (const refuse of bindings(Required)) {
          expect(
            yield* refuse({ page_size: "many", count: "1", stray: "1" }),
          ).toBe('Expected a finite number\n  at ["page_size"]');
          expect(
            yield* refuse({ page_size: "5", count: "x", stray: "1" }),
          ).toBe('Expected a finite number\n  at ["count"]');
        }
      }),
  );

  it.effect(
    "keeps the earlier message where only a strict read refuses a wire-named value",
    () =>
      Effect.gen(function* () {
        // Optional, the field is lost; required, the decoded side reports its name missing. Only the
        // strict read, whose parse options are not the caller's, reads these values on their side.
        for (const value of [{ page_size: "many" }, { page_size: 5 }]) {
          for (const refuse of bindings(Filter))
            expect(yield* refuse(value)).toBe(generic('["page_size"]'));
          for (const refuse of bindings(Required))
            expect(yield* refuse({ ...value, count: "1" })).toBe(
              'Missing key\n  at ["limit"]',
            );
        }
        // A decoded value beside the wire name is read as given, so only the decoded side's own
        // reading of the whole object fails, and on that side `limit` is missing.
        for (const refuse of bindings(Required))
          expect(yield* refuse({ page_size: "5", count: 3 })).toBe(
            'Missing key\n  at ["limit"]',
          );
        // A list's items are read with the whole list, never field by field, so no reading with
        // the caller's options reads the invalid `count` here either.
        expect(
          yield* schemaFailure(posted(Schema.Array(Required)), {
            body: [{ page_size: "5", count: "x" }],
          } as never),
        ).toBe('Missing key\n  at [0]["limit"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/313
  it.effect(
    "gives a sibling's own error beside a wire-named value where no reading reads that sibling",
    () =>
      Effect.gen(function* () {
        // Read field by field with the caller's options, a sibling that no route reads refuses with
        // its own error, at its own name, in place of `Missing key` at the decoded name.
        const Two = Schema.Struct({
          limit: Schema.FiniteFromString,
          term: Schema.String,
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        // The same error as beside the decoded name, where the decoded side reports it.
        for (const refuse of bindings(Two))
          for (const value of [
            { page_size: "x", term: 1 },
            { page_size: "5", term: 1 },
            { limit: 5, term: 1 },
          ])
            expect(yield* refuse(value)).toBe('Expected string\n  at ["term"]');
        // The decoded side already gives that error where the sibling comes first.
        for (const refuse of bindings(
          pageSized({ term: Schema.String, limit: Schema.FiniteFromString }),
        ))
          expect(yield* refuse({ page_size: "x", term: 1 })).toBe(
            'Expected string\n  at ["term"]',
          );
        // A codec gives its decoded side's error there, as beside the decoded name.
        for (const refuse of bindings(Required))
          for (const value of [
            { page_size: "5", count: "x" },
            { limit: 5, count: "x" },
          ])
            expect(yield* refuse(value)).toBe(
              'Expected number\n  at ["count"]',
            );
        // A parent read field by field keeps the sibling's path inside it.
        expect(
          yield* schemaFailure(posted(Schema.Struct({ f: Two })), {
            body: { f: { page_size: "5", term: 1 } },
          } as never),
        ).toBe('Expected string\n  at ["f"]["term"]');
        // Currently, below a wrapper the parent does not read field by field, such as
        // `Schema.optional`, `Missing key` stays (#313).
        expect(
          yield* schemaFailure(
            posted(Schema.Struct({ f: Schema.optional(Two) })),
            { body: { f: { page_size: "5", term: 1 } } } as never,
          ),
        ).toBe('Missing key\n  at ["f"]["limit"]');
        // Beside a Void, where both fields read the generic message, the member's own error names
        // the sibling alone, and the valid `page_size`, which the reading read, is not named.
        const BesideVoid = pageSized({
          limit: Schema.FiniteFromString,
          extra: Schema.Union([
            Schema.Void,
            Schema.Struct({ a: Schema.Number }),
          ]),
        });
        for (const refuse of bindings(BesideVoid))
          for (const page_size of ["5", "many"])
            expect(yield* refuse({ page_size, extra: { a: "x" } })).toBe(
              'Expected number\n  at ["extra"]["a"]',
            );
        // Valid values on either side still send.
        for (const value of [
          { page_size: "5", term: "ok" },
          { limit: 5, term: "ok" },
        ])
          expect(yield* sentBy(Two, value as never)).toBe(
            '{"page_size":"5","term":"ok"}',
          );
      }),
  );

  it.effect(
    "runs no schema step again to say why a wire-named value is refused",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let lastRead = Infinity;
        // A sibling whose decoder has an effect of its own, which fails after `lastRead` reads.
        const side = Schema.String.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transformEffect((value: string) =>
              Effect.suspend(() =>
                ++reads > lastRead
                  ? Effect.die("read again")
                  : Effect.succeed(Number(value)),
              ),
            ),
            encode: SchemaGetter.transform(String),
          }),
        );
        const schema = Schema.Struct({
          limit: Schema.FiniteFromString,
          side,
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        for (const refuse of bindings(schema)) {
          reads = 0;
          lastRead = Infinity;
          const value = { page_size: "many", side: "42" };
          expect(yield* refuse(value)).toBe('Missing key\n  at ["limit"]');
          // The routes before the refusal read the sibling three times, as 0.19.0 does, and the
          // refusal reads nothing more.
          expect(reads).toBe(3);
          reads = 0;
          lastRead = 3;
          expect(yield* refuse(value)).toBe('Missing key\n  at ["limit"]');
        }
        // https://github.com/viell-dev/slop-effect-schema-http/issues/313
        // A sibling that every route refuses gives its own error from the read already made.
        const refusing = Schema.String.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transformEffect(() =>
              Effect.suspend(() =>
                ++reads > lastRead
                  ? Effect.die("read again")
                  : Effect.fail(
                      new SchemaIssue.InvalidValue({ message: "Refused text" }),
                    ),
              ),
            ),
            encode: SchemaGetter.transform(String),
          }),
        );
        const besideRefusing = pageSized({
          limit: Schema.FiniteFromString,
          side: refusing,
        });
        for (const refuse of bindings(besideRefusing)) {
          reads = 0;
          lastRead = Infinity;
          const value = { page_size: "5", side: "nope" };
          expect(yield* refuse(value)).toBe('Expected number\n  at ["side"]');
          // Four reads, as 0.20.0 makes them, and none for the message.
          expect(reads).toBe(4);
          reads = 0;
          lastRead = 4;
          expect(yield* refuse(value)).toBe('Expected number\n  at ["side"]');
        }
      }),
  );

  it.effect(
    "takes no cause from a strict read where a step sees the parse options",
    () =>
      Effect.gen(function* () {
        let reads: Array<boolean> = [];
        // A decoder whose failure depends on the options Effect gives it: on every read, or only on
        // a strict one, which refuses keys a loose read strips.
        const sensitive = (strictOnly: boolean) =>
          Schema.String.pipe(
            Schema.decodeTo(Schema.Number, {
              decode: SchemaGetter.transformEffect((value: string, options) =>
                Effect.suspend(() => {
                  const strict = options.onExcessProperty === "error";
                  reads.push(strict);
                  return strictOnly && !strict
                    ? Effect.succeed(Number(value))
                    : Effect.fail(
                        new SchemaIssue.InvalidValue({
                          message: strict
                            ? "Strict-only refusal"
                            : "Caller-options refusal",
                        }),
                      );
                }),
              ),
              encode: SchemaGetter.transform(String),
            }),
          );
        const required = pageSized({ limit: sensitive(false) });
        const beside = pageSized({
          limit: Schema.FiniteFromString,
          side: sensitive(true),
        });
        const optional = pageSized({
          limit: Schema.optionalKey(sensitive(false)),
        });
        const cases: ReadonlyArray<{
          readonly schema: Schema.Top;
          readonly value: object;
          readonly expected: string;
          /** Whether each read of the decoder was strict, where that is what the case shows. */
          readonly reads?: ReadonlyArray<boolean>;
        }> = [
          // Only strict reads ran, so the decoded side's own error stays.
          {
            schema: required,
            value: { page_size: "many" },
            expected: 'Missing key\n  at ["limit"]',
            reads: [true, true],
          },
          // A loose read with the caller's options ran, where a stray key is stripped.
          {
            schema: required,
            value: { page_size: "many", stray: "1" },
            expected: 'Caller-options refusal\n  at ["page_size"]',
          },
          // Only the strict read decides that the sibling fails, so neither that read's error nor
          // the sibling's strict-only refusal is taken. No route reads the sibling, so it gives its
          // decoded side's error, read with the caller's options, as it does beside the decoded
          // name (#313).
          {
            schema: beside,
            value: { page_size: "many", side: "42" },
            expected: 'Expected number\n  at ["side"]',
          },
          {
            schema: beside,
            value: { page_size: "5", side: "42" },
            expected: 'Expected number\n  at ["side"]',
          },
          {
            schema: beside,
            value: { limit: 5, side: "42" },
            expected: 'Expected number\n  at ["side"]',
          },
          // A field the decoded side would lose is named with the generic message.
          {
            schema: optional,
            value: { page_size: "many" },
            expected: generic('["page_size"]'),
          },
        ];
        for (const { schema, value, expected, reads: strictness } of cases)
          for (const refuse of bindings(schema)) {
            reads = [];
            expect(yield* refuse(value)).toBe(expected);
            if (strictness !== undefined) expect(reads).toEqual(strictness);
          }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/335
  // A wire name puts the value on its encoded side. There the library reads it strictly to find the
  // keys a loose read would strip, and a step that fails only under those options fails that read
  // for another reason, so the read with the request's own options does not run.
  it.effect(
    "currently refuses a wire-named value whose step fails only under strict options",
    () =>
      Effect.gen(function* () {
        const side = strictOnlyCheck(
          "Option-sensitive side",
          Schema.FiniteFromString,
        );
        const renamed = Schema.Struct({ side }).pipe(
          Schema.encodeKeys({ side: "s" }),
        );
        const keyed = Schema.Record(Schema.String, Schema.Number).check(
          Schema.isPropertyNames(
            strictOnlyCheck("Option-sensitive key refusal", Schema.String),
          ),
        );
        const member = Schema.Union([
          Schema.Struct({ a: keyed }).pipe(Schema.encodeKeys({ a: "A" })),
          Schema.Struct({ other: Schema.String }),
        ]);
        // Effect reads both with the request's own options.
        expect(Schema.decodeUnknownSync(renamed)({ s: "42" })).toEqual({
          side: 42,
        });
        expect(Schema.decodeUnknownSync(member)({ A: { foo: 1 } })).toEqual({
          a: { foo: 1 },
        });
        for (const refuse of bindings(renamed))
          expect(yield* refuse({ s: "42" })).toBe('Missing key\n  at ["side"]');
        expect(
          yield* schemaFailure(posted(Schema.Struct({ f: renamed })), {
            body: { f: { s: "42" } } as never,
          }),
        ).toBe('Missing key\n  at ["f"]["side"]');
        expect(
          yield* schemaFailure(posted(member), {
            body: { A: { foo: 1 } } as never,
          }),
        ).toBe('Missing key\n  at ["a"]\nMissing key\n  at ["other"]');
        // On the decoded side both are sent.
        expect(yield* bodyOf(posted(renamed), { body: { side: 42 } })).toBe(
          '{"s":"42"}',
        );
        expect(yield* bodyOf(posted(member), { body: { a: { foo: 1 } } })).toBe(
          '{"A":{"foo":1}}',
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/335
  it.effect.fails(
    "sends a wire-named value whose step fails only under strict options",
    () =>
      Effect.gen(function* () {
        const side = strictOnlyCheck(
          "Option-sensitive side",
          Schema.FiniteFromString,
        );
        const renamed = Schema.Struct({ side }).pipe(
          Schema.encodeKeys({ side: "s" }),
        );
        expect(
          yield* bodyOf(posted(renamed), { body: { s: "42" } as never }),
        ).toBe('{"s":"42"}');
      }),
  );

  it.effect(
    "takes no cause from a strict read where the options change what Effect's own steps report",
    () =>
      Effect.gen(function* () {
        const strict = { errors: "all", onExcessProperty: "error" } as const;
        // A declaration that hands the options to another parser, whose issue Effect returns as its
        // own: a number under strict options, any text otherwise.
        const declared = Schema.declareConstructor<string | number>()(
          [],
          () => (input, _ast, options) =>
            SchemaParser.decodeUnknownEffect(
              options.onExcessProperty === "error"
                ? Schema.Number
                : Schema.String,
            )(input, options),
        );
        // Effect's own check, which gives the options to a key filter it is given.
        const keyed = Schema.Record(Schema.String, Schema.Number).check(
          Schema.isPropertyNames(
            Schema.String.check(
              Schema.makeFilter(
                (_key, _ast, options) =>
                  options.onExcessProperty !== "error" ||
                  "Strict-only key refusal",
              ),
            ),
          ),
        );
        // Built-ins only: loosely the first member strips `b`, strictly the second keeps it and fails
        // the check.
        const chosen = Schema.Union([
          Schema.Struct({ a: Schema.optionalKey(Schema.Number) }),
          Schema.Struct({
            a: Schema.optionalKey(Schema.Number),
            b: Schema.Number,
          }),
        ]).check(Schema.isMaxProperties(1));
        for (const [field, value] of [
          [declared, "synthetic"],
          [keyed, { foo: 1 }],
          [chosen, { a: 1, b: 2 }],
        ] as const) {
          // The caller's options read the value; strict ones refuse it.
          const decode = Schema.decodeUnknownExit(
            field as Schema.Codec<unknown>,
          );
          expect(Exit.isSuccess(decode(value))).toBe(true);
          expect(Exit.isFailure(decode(value, strict))).toBe(true);
          for (const [schema, expected] of [
            [pageSized({ limit: field }), 'Missing key\n  at ["limit"]'],
            [
              pageSized({ limit: Schema.optionalKey(field) }),
              generic('["page_size"]'),
            ],
          ] as const)
            for (const refuse of bindings(schema))
              expect(yield* refuse({ page_size: value })).toBe(expected);
        }
        // A strict-only refusal at a valid sibling names nothing there.
        for (const refuse of bindings(
          pageSized({ limit: Schema.FiniteFromString, side: keyed }),
        ))
          expect(
            yield* refuse({ page_size: "invalid", side: { foo: 1 } }),
          ).toBe('Missing key\n  at ["limit"]');
        // https://github.com/viell-dev/slop-effect-schema-http/issues/313
        // A sibling that no route reads gives the error the caller's options report, where the strict
        // read reports another: the declaration expects text, not a number, and each union member
        // reports only its first error, not also the missing `b`.
        const failureOf = (
          field: Schema.Top,
          value: unknown,
          options?: typeof strict,
        ) =>
          Effect.map(
            Effect.flip(
              Schema.decodeUnknownEffect(field as Schema.Codec<unknown>)(
                value,
                options,
              ),
            ),
            (error) => error.message,
          );
        for (const [field, value, expected, strictOnly] of [
          [declared, true, 'Expected string\n  at ["side"]', "Expected number"],
          [
            chosen,
            { a: "x" },
            'Expected number\n  at ["side"]["a"]\nExpected number\n  at ["side"]["a"]',
            'Missing key\n  at ["b"]',
          ],
        ] as const) {
          expect(yield* failureOf(field, value)).not.toContain(strictOnly);
          expect(yield* failureOf(field, value, strict)).toContain(strictOnly);
          for (const refuse of bindings(
            pageSized({ limit: Schema.FiniteFromString, side: field }),
          ))
            for (const page_size of ["5", "invalid"])
              expect(yield* refuse({ page_size, side: value })).toBe(expected);
        }
      }),
  );

  it.effect(
    "gives the decoded side's own error for a decoded-named value",
    () =>
      Effect.gen(function* () {
        for (const refuse of bindings(Filter))
          expect(yield* refuse({ limit: "x" })).toBe(
            'Expected number\n  at ["limit"]',
          );
      }),
  );

  it.effect(
    "still names a renamed field beside another's error where no reading kept it",
    () =>
      Effect.gen(function* () {
        const Two = Schema.Struct({
          a: Schema.optionalKey(Schema.String),
          b: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ a: "A", b: "B" }));
        // Each value here would be kept once the other is corrected, but no reading that refused it
        // read it, so it is named with the generic message. Only the strict read reports `B`'s value.
        expect(
          yield* schemaFailure(posted(Two), {
            body: { A: "x", B: 5 },
          } as never),
        ).toBe(`${generic('["A"]')}\n${generic('["B"]')}`);
        expect(
          yield* schemaFailure(posted(Two), {
            body: { a: 5, b: "x" },
          } as never),
        ).toBe(`Expected string\n  at ["a"]\n${generic('["b"]')}`);
        expect(
          yield* schemaFailure(posted(Schema.Array(Filter)), {
            body: [{ limit: 5 }, { limit: "x" }],
          } as never),
        ).toBe(
          `${generic('[0]["limit"]')}\nExpected number\n  at [1]["limit"]`,
        );
        // Names from both sides in one object have no more specific cause.
        expect(
          yield* schemaFailure(posted(Two), {
            body: { a: "x", B: "y" },
          } as never),
        ).toBe(
          'The schema cannot keep this field with the rest of the value\n  at ["B"]',
        );
      }),
  );

  it.effect("says that the items of a list or record use different sides", () =>
    Effect.gen(function* () {
      const message =
        "The items of this field's list or record use different sides; give every item on one side";
      for (const [schema, body, at] of [
        [Schema.Array(Filter), [{ limit: 5 }, { page_size: "6" }], "[1]"],
        [Schema.Array(Filter), [{ page_size: "6" }, { limit: 5 }], "[0]"],
        [
          Schema.Tuple([Filter, Filter]),
          [{ limit: 5 }, { page_size: "6" }],
          "[1]",
        ],
        [
          Schema.Record(Schema.String, Filter),
          { a: { limit: 5 }, b: { page_size: "6" } },
          '["b"]',
        ],
        [
          Schema.Struct({
            n: Schema.FiniteFromString,
            items: Schema.Array(Filter),
          }),
          { n: 1, items: [{ limit: 5 }, { page_size: "6" }] },
          '["items"][1]',
        ],
      ] as const)
        expect(
          yield* schemaFailure(posted(schema as Schema.Codec<unknown>), {
            body: body as never,
          }),
        ).toBe(`${message}\n  at ${at}["page_size"]`);
      // Items on one side that only a strict read refuses keep the generic message.
      expect(
        yield* schemaFailure(posted(Schema.Array(Filter)), {
          body: [{ page_size: "many" }, { page_size: "x" }],
        } as never),
      ).toBe(`${generic('[0]["page_size"]')}\n${generic('[1]["page_size"]')}`);
    }),
  );

  it.effect("names the kind of a built-in a record cannot rebuild", () =>
    Effect.gen(function* () {
      const record = Schema.Record(Schema.String, Schema.Number);
      expect(
        yield* schemaFailure(posted(record), {
          body: new Map([["a", 1]]),
        } as never),
      ).toBe("The schema cannot keep this Map as a record");
      expect(
        yield* schemaFailure(posted(Schema.Struct({ r: record })), {
          body: { r: new Set([1]) },
        } as never),
      ).toBe('The schema cannot keep this Set as a record\n  at ["r"]');
    }),
  );

  it.effect("adds no value the caller gave", () =>
    Effect.gen(function* () {
      const secret = "s3cret-value";
      const record = Schema.Record(Schema.String, Schema.String);
      // The required field's error comes from a read that kept its input, as Effect's `got …` shows.
      for (const [schema, body] of [
        [Filter, { page_size: secret }],
        [Filter, { limit: secret }],
        [Filter, { limit: 5, page_size: secret }],
        [Required, { page_size: secret, count: "1" }],
        [Schema.Array(Filter), [{ limit: 5 }, { page_size: secret }]],
        [record, new Map([[secret, secret]])],
      ] as const) {
        const message = yield* schemaFailure(
          posted(schema as Schema.Codec<unknown>),
          { body: body as never },
        );
        expect(message).not.toContain(secret);
        expect(message).not.toContain("got");
      }
    }),
  );

  it.effect("shows a message the schema's author wrote as written", () =>
    Effect.gen(function* () {
      const secret = "s3cret-value";
      // As on any other schema failure, an author's message can quote the value it refuses.
      const Checked = Schema.String.check(
        Schema.makeFilter((value) => value.startsWith("ok") || rejected(value)),
      );
      const Quoting = Schema.String.pipe(
        Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.transformEffect((value: string) =>
            Effect.fail(
              new SchemaIssue.InvalidValue({ message: rejected(value) }),
            ),
          ),
          encode: SchemaGetter.transform(String),
        }),
      );
      for (const [schema, value, key] of [
        // An ordinary schema failure.
        [Schema.Struct({ note: Checked }), { note: secret }, "note"],
        // A wire-named value the decoded side would lose or report missing, which the encoded side
        // refuses as it reads the value with the caller's options, where a stray key is stripped.
        [
          pageSized({ limit: Schema.optionalKey(Quoting) }),
          { page_size: secret, stray: "1" },
          "page_size",
        ],
        [
          pageSized({ limit: Quoting }),
          { page_size: secret, stray: "1" },
          "page_size",
        ],
      ] as const)
        for (const refuse of bindings(schema))
          expect(yield* refuse(value)).toBe(
            `${rejected(secret)}\n  at ["${key}"]`,
          );
    }),
  );
});

/** A number whose check records every value it reads. */
const counting = () => {
  const runs: Array<number> = [];
  const Counted = Schema.Number.check(
    Schema.makeFilter((value) => {
      runs.push(value);
      return true;
    }),
  );
  return { runs, Counted };
};

/** What a request sends for the value: its JSON body, or the value its path is rendered from. */
const prepared = (schema: Schema.Top, input: object, kind: "body" | "path") => {
  if (kind === "body")
    return Effect.map(
      bodyOf(posted(schema as never), { body: input } as never),
      (text) => JSON.parse(text!) as unknown,
    );
  let output: unknown;
  const request = Request.get("").pipe(
    Request.path(schema as never, (value) => {
      output = value;
      return "/sent";
    }),
  );
  return Effect.map(compile(request, { path: input } as never), () => output);
};

// A strict read of a value's exposed spelling runs only where the read of its normalised value does
// not write. These are 0.19.0's runs; 0.20.0 also read the exposed value up front, beside any key
// the schema does not state, and ran a check once more.
// https://github.com/viell-dev/slop-effect-schema-http/issues/331
describe("check runs beside a key the schema does not state", () => {
  const Owner = Schema.Struct({ owner: Schema.String }).pipe(
    Schema.encodeKeys({ owner: "OWNER_w" }),
  );
  for (const kind of ["body", "path"] as const) {
    it.effect(
      `runs a check as often as before beside a renamed struct with a stray key, ${kind}`,
      () =>
        Effect.gen(function* () {
          const { runs, Counted } = counting();
          const schema = Schema.Struct({ c: Counted, b: Owner });
          expect(
            yield* prepared(schema, { c: 1, b: { OWNER_w: "x", zz: 1 } }, kind),
          ).toEqual({ c: 1, b: { OWNER_w: "x" } });
          expect(runs).toEqual([1, 1, 1]);
        }),
    );

    it.effect(
      `runs a check as often as before beside a union member with a stray key, ${kind}`,
      () =>
        Effect.gen(function* () {
          const { runs, Counted } = counting();
          const schema = Schema.Struct({
            c: Counted,
            u: Schema.Union([
              Schema.Struct({ a: Schema.String }),
              Schema.Struct({ b: Schema.String }),
            ]),
          });
          expect(
            yield* prepared(schema, { c: 1, u: { b: "x", zz: 1 } }, kind),
          ).toEqual({ c: 1, u: { b: "x" } });
          expect(runs).toEqual([1, 1]);
          runs.length = 0;
          // Its renamed member is chosen the same way, with the same runs as the struct above.
          const renamed = Schema.Struct({
            c: Counted,
            b: Schema.Union([Owner, Schema.Struct({ id: Schema.String })]),
          });
          expect(
            yield* prepared(
              renamed,
              { c: 1, b: { OWNER_w: "x", zz: 1 } },
              kind,
            ),
          ).toEqual({ c: 1, b: { OWNER_w: "x" } });
          expect(runs).toEqual([1, 1, 1]);
        }),
    );
  }

  // Decided: a loose read that fails on a value holding a key the schema does not state is tried
  // once more without that key, which may be what failed it, so a decoder runs once more there.
  it.effect(
    "reads a value once more where its loose read fails beside a stray key",
    () =>
      Effect.gen(function* () {
        const reads: Array<string> = [];
        const Limit = Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transform((text) => {
              reads.push(text);
              return text;
            }),
            encode: SchemaGetter.transform((text) => text),
          }),
          Schema.decodeTo(Schema.FiniteFromString),
        );
        // `token` takes the value `limit` cannot read, under the same wire name.
        const request = stacked(
          Schema.Struct({ limit: Schema.optionalKey(Limit) }).pipe(
            Schema.encodeKeys({ limit: "page_size" }),
          ),
          Schema.Struct({ token: Schema.StringFromBase64 }).pipe(
            Schema.encodeKeys({ token: "page_size" }),
          ),
        );
        expect(
          yield* urlOf(request, { query: { page_size: "eA==" } } as never),
        ).toBe("/x?page_size=eA%3D%3D");
        expect(reads).toEqual(["eA==", "eA=="]);
        reads.length = 0;
        expect(
          yield* urlOf(request, {
            query: { page_size: "eA==", stray: "1" },
          } as never),
        ).toBe("/x?page_size=eA%3D%3D");
        // 0.19.0 read it three times here.
        expect(reads).toEqual(["eA==", "eA==", "eA==", "eA=="]);
      }),
  );
});
