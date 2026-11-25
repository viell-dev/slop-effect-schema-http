import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect";
import * as Body from "./Body.js";
import * as Request from "./Request.js";
import { bodyOf, compile } from "../../test/request.js";
import { bodyText } from "../../test/support.js";

const limit = Schema.optionalKey(Schema.FiniteFromString).pipe(
  Schema.withConstructorDefault(Effect.succeed(25)),
);
/** A renamed field whose constructor default could stand in for a lost value. */
const Filter = Schema.Struct({ limit }).pipe(
  Schema.encodeKeys({ limit: "page_size" }),
);
/** A renamed field whose decoding default could. */
const Page = Schema.Struct({
  limit: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("30")),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
/** A class whose own member a strict write refuses, so a value beside it is written loosely. */
class Counted extends Schema.Class<Counted>("Counted")({ a: Schema.String }) {
  readonly reads = 1;
}

type Any = Schema.Codec<unknown, unknown>;

/** What a JSON body and a path renderer are given, or the fields a refusal names. */
const outcomes = (schema: Schema.Top, input: unknown) =>
  Effect.gen(function* () {
    const refused = (error: unknown) =>
      error instanceof Schema.SchemaError
        ? Effect.succeed(
            (error.message.match(/at .*/g) ?? [error.message]).join(" "),
          )
        : Effect.die(error);
    const body = yield* Effect.catch(
      bodyOf(
        Request.post("/x").pipe(Request.body(Body.jsonSchema(schema as Any))),
        { body: input as never },
      ),
      refused,
    );
    let rendered: unknown;
    const path = yield* Effect.catch(
      Effect.map(
        compile(
          Request.get("").pipe(
            Request.path(schema as Any, (value) => {
              rendered = value;
              return "/x";
            }),
          ),
          { path: input as never },
        ),
        () => JSON.stringify(rendered),
      ),
      refused,
    );
    return [body, path];
  });

/** The same outcome in a body and a path. */
const both = (outcome: string) => [outcome, outcome];
const written = (value: unknown) => both(JSON.stringify(value));

const wrappings = [
  {
    name: "a root",
    wrap: (schema: Schema.Top): Schema.Top => schema,
    put: (value: unknown): unknown => value,
    at: "",
  },
  {
    name: "a field",
    wrap: (schema: Schema.Top): Schema.Top => Schema.Struct({ f: schema }),
    put: (value: unknown): unknown => ({ f: value }),
    at: '["f"]',
  },
  {
    name: "a list",
    wrap: (schema: Schema.Top): Schema.Top => Schema.Array(schema),
    put: (value: unknown): unknown => [value],
    at: "[0]",
  },
  {
    name: "a tuple",
    wrap: (schema: Schema.Top): Schema.Top => Schema.Tuple([schema]),
    put: (value: unknown): unknown => [value],
    at: "[0]",
  },
  {
    name: "a record",
    wrap: (schema: Schema.Top): Schema.Top =>
      Schema.Record(Schema.String, schema),
    put: (value: unknown): unknown => ({ k: value }),
    at: '["k"]',
  },
  {
    name: "a suspension",
    wrap: (schema: Schema.Top): Schema.Top =>
      Schema.suspend(() => schema as Any),
    put: (value: unknown): unknown => value,
    at: "",
  },
  {
    name: "a class field",
    wrap: (schema: Schema.Top): Schema.Top =>
      class extends Schema.Class<{ readonly f: unknown }>("Wrapping")({
        f: schema,
      }) {},
    put: (value: unknown): unknown => ({ f: value }),
    at: '["f"]',
  },
] as const;

describe("a default never takes the place of a supplied field", () => {
  for (const { name, wrap, put, at } of wrappings) {
    // https://github.com/viell-dev/slop-effect-schema-http/issues/170
    it.effect(`refuses a constructor default in ${name}`, () =>
      Effect.gen(function* () {
        for (const schema of [
          Filter,
          Schema.Union([Filter, Cursor]),
          Schema.Union([Cursor, Filter]),
          Schema.Union([Filter, Schema.FiniteFromString]),
          Schema.NullOr(Filter),
        ]) {
          for (const [value, field] of [
            [{ page_size: "many" }, '["page_size"]'],
            [{ page_size: null }, '["page_size"]'],
            [{ limit: 5, page_size: "5" }, '["page_size"]'],
            [{ limit: 5, page_size: "6" }, '["page_size"]'],
            // The default's own spelling is no reading of it.
            [{ page_size: "25", limit: "x" }, '["limit"]'],
          ] as const)
            expect(yield* outcomes(wrap(schema), put(value))).toEqual(
              both(`at ${at}${field}`),
            );
          for (const value of [{ limit: 5 }, { page_size: "05" }])
            expect(yield* outcomes(wrap(schema), put(value))).toEqual(
              written(put({ page_size: "5" })),
            );
          // The caller gave neither name.
          expect(yield* outcomes(wrap(Filter), put({}))).toEqual(
            written(put({ page_size: "25" })),
          );
        }
      }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/259
    it.effect(`refuses a decoding default in ${name}`, () =>
      Effect.gen(function* () {
        for (const schema of [
          Page,
          Schema.Union([Page, Cursor]),
          Schema.Union([Cursor, Page]),
          Schema.NullOr(Page),
        ]) {
          for (const value of [{ limit: "x" }, { limit: "x", page_size: "7" }])
            expect(yield* outcomes(wrap(schema), put(value))).toEqual(
              both(`at ${at}["limit"]`),
            );
          for (const value of [{ limit: 5 }, { page_size: "05" }])
            expect(yield* outcomes(wrap(schema), put(value))).toEqual(
              written(put({ page_size: "5" })),
            );
          expect(yield* outcomes(wrap(Page), put({}))).toEqual(
            written(put({ page_size: "30" })),
          );
        }
      }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/258
    it.effect(`keeps or refuses beside a relaxing class in ${name}`, () =>
      Effect.gen(function* () {
        const schema = wrap(Schema.Struct({ f: Filter, c: Counted }));
        for (const c of [{ a: "x" }, new Counted({ a: "x" })]) {
          for (const f of [{ page_size: "05" }, { limit: 5 }])
            expect(yield* outcomes(schema, put({ f, c }))).toEqual(
              written(put({ f: { page_size: "5" }, c: { a: "x" } })),
            );
          expect(
            yield* outcomes(schema, put({ f: { page_size: "many" }, c })),
          ).toEqual(both(`at ${at}["f"]["page_size"]`));
        }
      }),
    );
  }

  // https://github.com/viell-dev/slop-effect-schema-http/issues/258
  it.effect("keeps or refuses a root alias beside a relaxing class", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ limit, c: Counted }).pipe(
        Schema.encodeKeys({ limit: "page_size" }),
      );
      for (const c of [{ a: "x" }, new Counted({ a: "x" })]) {
        expect(yield* outcomes(schema, { page_size: "05", c })).toEqual(
          written({ page_size: "5", c: { a: "x" } }),
        );
        expect(yield* outcomes(schema, { page_size: "many", c })).toEqual(
          both('at ["page_size"]'),
        );
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/259
  it.effect("refuses a decoded item beside one the decoder needs", () =>
    Effect.gen(function* () {
      // Neither side reads the whole list, and its decoder would drop the decoded item's value.
      for (const [items, field] of [
        [[{ limit: 5 }, {}], "[0]"],
        [[{ limit: 5 }, { page_size: "6" }], "[0]"],
        [[{}, { limit: "x" }], "[1]"],
      ] as const)
        expect(yield* outcomes(Schema.Array(Page), items)).toEqual(
          both(`at ${field}["limit"]`),
        );
      for (const items of [
        [{ limit: 5 }, { limit: 6 }],
        [{ page_size: "05" }, { page_size: "06" }],
      ])
        expect(yield* outcomes(Schema.Array(Page), items)).toEqual(
          written([{ page_size: "5" }, { page_size: "6" }]),
        );
    }),
  );

  // Shapes the schema alone does not tell apart.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses beside alternatives that could also read the value", () =>
    Effect.gen(function* () {
      const list = (other: Schema.Top) =>
        Schema.Union([Schema.Array(Filter), other]);
      const shared = Schema.Union([
        Cursor.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transform(() => "x"),
            encode: SchemaGetter.transform(() => ({ cursor: "x" })),
          }),
        ),
        Schema.Void,
      ]);
      for (const [schema, value, at] of [
        [list(Schema.Array(Cursor)), [{ page_size: "many" }], "[0]"],
        [
          list(Schema.Array(Schema.Struct({ z: Schema.Number }))),
          [{ page_size: "many" }],
          "[0]",
        ],
        [list(Counted), [{ page_size: "many" }], "[0]"],
        [list(Schema.Option(Cursor)), [{ page_size: "many" }], "[0]"],
        [
          Schema.Struct({
            guarded: Schema.optionalKey(list(shared)),
            loose: Schema.optionalKey(
              Schema.Union([Schema.Array(Filter), shared], { mode: "oneOf" }),
            ),
          }),
          { guarded: [{ page_size: "many" }] },
          '["guarded"][0]',
        ],
      ] as const)
        expect((yield* outcomes(schema, value))[1]).toBe(
          `at ${at}["page_size"]`,
        );
      // An empty struct keeps the alias as given.
      expect(
        yield* outcomes(list(Schema.Struct({})), [{ page_size: "many" }]),
      ).toEqual(written([{ page_size: "many" }]));
    }),
  );

  it.effect("refuses a decoded name below a name the parent writes", () =>
    Effect.gen(function* () {
      const schemas = [Filter, Page, Schema.Array(Filter)] as const;
      for (const field of schemas) {
        const list = field === schemas[2];
        const put = (value: object) => (list ? [value] : value);
        const schema = Schema.Struct({ f: field }).pipe(
          Schema.encodeKeys({ f: "w" }),
        );
        const at = `at ["w"]${list ? "[0]" : ""}["limit"]`;
        expect(yield* outcomes(schema, { w: put({ limit: 5 }) })).toEqual(
          both(at),
        );
        expect(yield* outcomes(schema, { f: put({ limit: 5 }) })).toEqual(
          written({ w: put({ page_size: "5" }) }),
        );
        // A key no side of the field states is still stripped.
        expect(
          yield* outcomes(schema, { w: put({ page_size: "05", stray: 1 }) }),
        ).toEqual(written({ w: put({ page_size: "5" }) }));
      }
    }),
  );

  it.effect("refuses in a query and in headers", () =>
    Effect.gen(function* () {
      const refused = <I>(
        request: Request.Request<I, unknown>,
        input: I,
        field: string,
      ) =>
        Effect.map(Effect.flip(compile(request, input)), (error) => {
          expect(error).toBeInstanceOf(Schema.SchemaError);
          expect((error as Schema.SchemaError).message).toContain(field);
        });
      for (const value of [{ page_size: "many" }, { limit: 5, page_size: "6" }])
        for (const request of [
          Request.get("/x").pipe(
            Request.query(Filter),
            Request.mapInput((given: object) => ({ query: given })),
          ),
          Request.get("/x").pipe(
            Request.headers(Filter),
            Request.mapInput((given: object) => ({ headers: given })),
          ),
        ])
          yield* refused(request, value, '["page_size"]');
      for (const request of [
        Request.get("/x").pipe(
          Request.query(Page),
          Request.mapInput((given: object) => ({ query: given as never })),
        ),
        Request.get("/x").pipe(
          Request.headers(Page),
          Request.mapInput((given: object) => ({ headers: given as never })),
        ),
      ])
        yield* refused(request, { limit: "x" }, '["limit"]');
    }),
  );

  it.effect("leaves a field another stacked schema takes", () =>
    Effect.gen(function* () {
      const request = Request.get("/x").pipe(
        Request.query(Schema.Union([Filter, Cursor])),
        Request.query(Cursor),
      );
      const { request: sent } = yield* compile(request, {
        query: { page_size: "05", cursor: "next" },
      });
      expect(sent.url).toBe("/x?page_size=5&cursor=next");
      const error = yield* Effect.flip(
        compile(request, { query: { page_size: "many", cursor: "next" } }),
      );
      expect(error.message).toContain('["page_size"]');
    }),
  );
});

describe("a field lost in a stacked group", () => {
  const text = Schema.String;
  const url = (schemas: ReadonlyArray<Schema.Top>, query: unknown) =>
    Effect.forEach([schemas, [...schemas].reverse()], (order) =>
      Effect.catch(
        Effect.map(
          compile(
            order.reduce<Request.Request<never, unknown, unknown>>(
              (request, schema) =>
                Request.query(
                  schema as Schema.Codec<unknown, Record<string, string>>,
                )(request) as never,
              Request.get("/x") as never,
            ) as Request.Request<unknown>,
            { query },
          ),
          ({ request }) => request.url,
        ),
        (error: unknown) =>
          error instanceof Schema.SchemaError
            ? Effect.succeed((error.message.match(/at .*/g) ?? []).join(" "))
            : Effect.die(error),
      ),
    );

  it.effect("is refused where the schema that lost it writes its name", () =>
    Effect.gen(function* () {
      // The sibling took what the caller gave, but this schema would send its default there too.
      for (const schemas of [
        [Schema.Record(text, text), Schema.Union([Filter, Cursor])],
        [Schema.Struct({}), Schema.Union([Filter, Cursor])],
        [Schema.Union([Schema.Struct({ page_size: text }), Cursor]), Filter],
        [Schema.Struct({ page_size: Schema.optionalKey(text) }), Filter],
      ])
        expect(yield* url(schemas, { page_size: "many" })).toEqual(
          both('at ["page_size"]'),
        );
      const B = Schema.Union([
        Schema.Struct({ b: Schema.FiniteFromString }).pipe(
          Schema.encodeKeys({ b: "w_b" }),
        ),
        Schema.Struct({ b: text }),
      ]);
      expect(yield* url([Schema.Struct({}), B], { b: 1, w_b: "2" })).toEqual(
        both('at ["w_b"]'),
      );
      const headers = Request.get("/x").pipe(
        Request.headers(Schema.Record(text, text)),
        Request.headers(Schema.Union([Filter, Cursor])),
      );
      const refusal = yield* Effect.flip(
        Effect.mapError(
          compile(headers as Request.Request<unknown, unknown>, {
            headers: { page_size: "many" },
          }),
          String,
        ),
      );
      expect(refusal).toContain('["page_size"]');
    }),
  );

  it.effect("is left to a sibling that takes it, with or without a union", () =>
    Effect.gen(function* () {
      const taking = Schema.Struct({ limit: Schema.optionalKey(text) });
      for (const sibling of [taking, Schema.Union([taking, Cursor])])
        expect(
          (yield* url([sibling, Page], { limit: "x" })).map((sent) =>
            Array.from(new URL(sent, "https://x.test").searchParams).sort(),
          ),
        ).toEqual(
          both([
            ["limit", "x"],
            ["page_size", "30"],
          ] as never),
        );
      for (const schemas of [
        [taking, Filter],
        [Schema.Struct({ other: Schema.optionalKey(text) }), Page],
      ])
        for (const sent of yield* url(schemas, { page_size: "05" }))
          expect(sent).toBe("/x?page_size=5");
    }),
  );
});

describe("the cost of accounting", () => {
  it.effect("runs a default a few times a level under refused unions", () =>
    Effect.gen(function* () {
      for (const depth of [2, 4, 8]) {
        let runs = 0;
        let schema: Schema.Top = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.sync(() => ++runs)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        let input: unknown = { page_size: "many" };
        for (let level = 0; level < depth; level++) {
          const x = schema;
          schema = Schema.Union([
            Schema.Struct({ x, a: Schema.optionalKey(Schema.String) }),
            Schema.Struct({ x, b: Schema.optionalKey(Schema.String) }),
          ]);
          input = { x: input };
        }
        for (const outcome of yield* outcomes(schema, input))
          expect(outcome).toContain('["page_size"]');
        expect(runs).toBeLessThanOrEqual(8 * (depth + 1));
      }
    }),
  );

  it.effect("reads a list's own keys a fixed number of times", () =>
    Effect.gen(function* () {
      const reads = (length: number) =>
        Effect.gen(function* () {
          let descriptors = 0;
          const list = new Proxy(
            Array.from({ length }, () => ({ page_size: "many" })),
            {
              getOwnPropertyDescriptor(target, key) {
                descriptors++;
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            },
          );
          yield* outcomes(Schema.Array(Filter), list);
          return descriptors;
        });
      const [short, long] = [yield* reads(50), yield* reads(400)];
      expect(long).toBeLessThan(short * 10);
    }),
  );

  it.effect("names the item that keeps a list from being decoded", () =>
    Effect.gen(function* () {
      const list = Array.from({ length: 30 }, (_, index) => ({
        page_size: index === 20 ? "many" : String(index),
      }));
      expect(yield* outcomes(Schema.Array(Filter), list)).toEqual(
        both('at [20]["page_size"]'),
      );
      expect(
        yield* outcomes(Schema.Struct({ rows: Schema.Array(Filter) }), {
          rows: list,
        }),
      ).toEqual(both('at ["rows"][20]["page_size"]'));
      // A refusal elsewhere is still named.
      expect(
        yield* outcomes(
          Schema.Struct({
            rows: Schema.Array(Filter),
            g: Schema.Struct({ h: Schema.Struct({ f: Filter }) }),
          }),
          { rows: list, g: { h: { f: { page_size: "many" } } } },
        ),
      ).toEqual(
        both('at ["rows"][20]["page_size"] at ["g"]["h"]["f"]["page_size"]'),
      );
      // A union is named by what the member that keeps most of it loses.
      expect(
        yield* outcomes(
          Schema.Union([
            Schema.Struct({ a: Schema.optionalKey(Schema.String) }),
            Page,
          ]),
          { limit: 5, page_size: "7" },
        ),
      ).toEqual(both('at ["page_size"]'));
    }),
  );
});

describe("a reading that keeps everything", () => {
  it.effect("keeps its fields beside a value it cannot see into", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        f: Schema.Union([
          Schema.Struct({ a: Schema.String }),
          Schema.Struct({ a: Schema.String, b: Schema.String }),
        ]),
        page: Schema.Struct({ f: Filter }),
        o: Schema.Option(Cursor),
      });
      // The Option's own reading drops `z`, which a strict read of the whole refuses.
      const o = Option.some({ cursor: "c", z: 1 });
      const f = { a: "x", b: "y" };
      expect(
        (yield* outcomes(schema, {
          f,
          page: { f: { page_size: "05" } },
          o,
        }))[0],
      ).toContain('"f":{"a":"x","b":"y"},"page":{"f":{"page_size":"5"}}');
      expect(
        yield* outcomes(schema, { f, page: { f: { page_size: "many" } }, o }),
      ).toEqual(both('at ["page"]["f"]["page_size"]'));
    }),
  );

  it.effect("reads a field both sides can hold as the whole does", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        f: Schema.Union([
          Schema.Struct({ a: Schema.String }),
          Schema.Struct({ a: Schema.String, b: Schema.String }),
        ]),
        n: Schema.FiniteFromString,
        shared: Schema.StringFromBase64,
        o: Schema.Option(Cursor),
      });
      const o = Option.some({ cursor: "c", z: 1 });
      const value = { f: { a: "x", b: "y" }, shared: "eA==", o };
      // Read by its constructor, `shared` is decoded; a decoded whole could not say the same.
      expect((yield* outcomes(schema, { ...value, n: 1 }))[0]).toContain(
        '"shared":"ZUE9PQ=="',
      );
      expect(yield* outcomes(schema, { ...value, n: "1" })).toEqual(
        both('at ["f"]["b"]'),
      );
    }),
  );

  it.effect("is written by the member that holds it, beside a class", () =>
    Effect.gen(function* () {
      // Only a relaxed write can send the class. It writes each union strictly where a member can.
      const Title = Schema.Struct({ title: Schema.optionalKey(Schema.String) });
      const AB = Schema.Struct({ a: Schema.String, b: Schema.String });
      const A = Schema.Struct({ a: Schema.String });
      const Other = Schema.Struct({ limit });
      for (const [schema, f, sent] of [
        [Schema.Union([Title, Counted]), { a: "x" }, { a: "x" }],
        [Schema.Union([Page, Counted]), new Counted({ a: "x" }), { a: "x" }],
        [Schema.Union([Page, Other]), { limit: "6" }, { page_size: "6" }],
        [
          Schema.Array(Schema.Union([A, Schema.Array(Schema.String), AB])),
          [{ a: "1", b: "2" }],
          [{ a: "1", b: "2" }],
        ],
        [
          Schema.Union([A, Schema.Union([Schema.Null, AB])]),
          { a: "1", b: "2" },
          { a: "1", b: "2" },
        ],
      ] as const) {
        const fields = { f: schema as Schema.Top, c: Counted };
        const input = { f, c: { a: "y" } };
        expect(yield* outcomes(Schema.Struct(fields), input)).toEqual(
          written({ f: sent, c: { a: "y" } }),
        );
        expect(
          yield* outcomes(
            Schema.Struct(fields).pipe(Schema.encodeKeys({ f: "w" })),
            input,
          ),
        ).toEqual(written({ w: sent, c: { a: "y" } }));
      }
    }),
  );

  it.effect("is kept beside a union nothing in it goes through", () =>
    Effect.gen(function* () {
      const either = Schema.Union([
        Schema.Struct({ a: Schema.String }),
        Schema.Struct({ b: Schema.String }),
      ]);
      const schema = Schema.Struct({
        f: Filter,
        c: Counted,
        u: Schema.optionalKey(either),
      });
      for (const u of [undefined, { b: "x" }])
        expect(
          yield* outcomes(schema, {
            f: { page_size: "05" },
            c: { a: "y" },
            ...(u && { u }),
          }),
        ).toEqual(
          written({ f: { page_size: "5" }, c: { a: "y" }, ...(u && { u }) }),
        );
    }),
  );

  it.effect(
    "takes a union's strict member beside a value it cannot see into",
    () =>
      Effect.gen(function* () {
        const A = Schema.Struct({ a: Schema.String });
        const AB = Schema.Struct({ a: Schema.String, b: Schema.String });
        const Title = Schema.Struct({
          title: Schema.optionalKey(Schema.String),
        });
        const schema = Schema.Struct({
          rows: Schema.Array(Schema.Union([A, AB])),
          mixed: Schema.Array(
            Schema.Union([Title, Schema.Struct({ f: Filter })]),
          ),
          o: Schema.Option(A),
        });
        const rows = [{ a: "1", b: "2" }, { a: "3" }];
        // Only the constructor reads a decoded name, and loosely it would take the first member.
        const [body] = yield* outcomes(schema, {
          rows,
          mixed: [{ f: { limit: 5 } }],
          o: Option.some({ a: "x", z: 1 }),
        });
        expect(JSON.parse(body!)).toMatchObject({
          rows,
          mixed: [{ f: { page_size: "5" } }],
        });
      }),
  );

  it.effect("is not replaced by a looser member's reading", () =>
    Effect.gen(function* () {
      // A loose decode would take `Filter`, which strips `limit` with no error.
      const schema = Schema.Struct({
        o: Schema.Option(Schema.Struct({ a: Schema.String })),
        b: Schema.Union([Filter, Schema.Unknown]),
      });
      const b = { limit: 5, page_size: "7" };
      const [body] = yield* outcomes(schema, {
        o: Option.some({ a: "o", z: 1 }),
        b,
      });
      expect(JSON.parse(body!)).toMatchObject({ b });
    }),
  );

  it.effect("keeps a value a Void beside a class would read", () =>
    Effect.gen(function* () {
      const list = Schema.Array(
        Schema.Union([Schema.Void, Schema.Array(Counted)]),
      );
      expect(yield* outcomes(list, [[{ a: "x" }]])).toEqual(
        written([[{ a: "x" }]]),
      );
      // A value that holds nothing is kept as the Void reads it.
      expect((yield* outcomes(list, [null, [{ a: "x" }]]))[0]).toBe(
        '[null,[{"a":"x"}]]',
      );
    }),
  );

  it.effect("is refused where its own member cannot write it", () =>
    Effect.gen(function* () {
      // Read loosely, the value would be a `Page` that strips `limit` and sends its default.
      const ReadOnly = Schema.Struct({
        limit: Schema.String.pipe(
          Schema.decodeTo(Schema.Struct({ text: Schema.String }), {
            decode: SchemaGetter.transform((text: string) => ({ text })),
            encode: SchemaGetter.fail<string, { readonly text: string }>(
              () => new SchemaIssue.InvalidValue({ message: "read only" }),
            ),
          }),
        ),
      });
      const f = Schema.Union([Page, ReadOnly]);
      for (const [schema, input] of [
        [f, { limit: "6" }],
        [
          Schema.Struct({ f, c: Counted }),
          { f: { limit: "6" }, c: { a: "x" } },
        ],
        [Schema.Array(f), [{ limit: "6" }]],
      ] as const)
        for (const outcome of yield* outcomes(schema, input))
          expect(outcome).toMatch(/^at |read only|^Expected/);
    }),
  );

  it.effect("reads an input whose undefined key its decoder needs", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        inner: Schema.UndefinedOr(Schema.String),
        f: Filter,
        c: Counted,
      });
      const input = {
        inner: undefined,
        f: { page_size: "05" },
        c: { a: "x" },
      };
      const body = { inner: null, f: { page_size: "5" }, c: { a: "x" } };
      const path = { f: { page_size: "5" }, c: { a: "x" } };
      expect(yield* outcomes(schema, input)).toEqual([
        JSON.stringify(body),
        JSON.stringify(path),
      ]);
      expect(yield* outcomes(Schema.Array(schema), [input])).toEqual([
        JSON.stringify([body]),
        JSON.stringify([path]),
      ]);
    }),
  );

  it.effect("accounts for nothing inside a value that is not plain data", () =>
    Effect.gen(function* () {
      class Rows {
        readonly items = [{ page_size: "many" }];
      }
      const page = Schema.Struct({ items: Schema.Array(Filter) });
      const sent = { items: [{ page_size: "25" }] };
      for (const [schema, input, output] of [
        [page, new Rows(), sent],
        [Schema.Struct({ page }), { page: new Rows() }, { page: sent }],
        [Schema.Array(page), [new Rows()], [sent]],
      ] as const)
        expect(yield* outcomes(schema, input)).toEqual(written(output));
    }),
  );

  it.effect("keeps what a transformation beside it would discard", () =>
    Effect.gen(function* () {
      const Discard = Schema.Unknown.pipe(
        Schema.decodeTo(Schema.Undefined, {
          decode: SchemaGetter.transform(() => undefined),
          encode: SchemaGetter.transform((): unknown => undefined),
        }),
      );
      const schema = Schema.Union([Discard, Filter]);
      expect((yield* outcomes(schema, { page_size: "05" }))[0]).toBe(
        '{"page_size":"5"}',
      );
      expect((yield* outcomes(schema, { page_size: "many" }))[0]).toBe(
        'at ["page_size"]',
      );
    }),
  );

  it.effect("does not notice a value that changes during preparation", () =>
    Effect.gen(function* () {
      // The value has to stay unchanged. Nothing promises which of its states is sent.
      const input = { f: { page_size: "05" }, touch: "x", c: { a: "y" } };
      const schema = Schema.Struct({
        f: Filter,
        touch: Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transformEffect((text: string) =>
              Effect.sync(() => {
                input.f = { page_size: "07" };
                return text;
              }),
            ),
            encode: SchemaGetter.passthrough(),
          }),
        ),
        c: Counted,
      });
      const [body] = yield* outcomes(schema, input);
      expect(["5", "7"]).toContain(JSON.parse(body!).f.page_size);
    }),
  );

  it.effect("runs with each call's own services", () =>
    Effect.gen(function* () {
      class Tenant extends Context.Service<Tenant, string>()(
        "accounting/Tenant",
      ) {}
      const owned = Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformEffect((text: string) =>
            Effect.map(Tenant, (tenant) => `${tenant}:${text}`),
          ),
          encode: SchemaGetter.transform((text: string) => text),
        }),
      );
      const schema = Schema.Struct({ f: Filter, owned, c: Counted });
      const request = Request.post("/x").pipe(
        Request.body(Body.jsonSchema(schema)),
      );
      const results = yield* Effect.forEach(
        ["one", "two", "three"],
        (tenant) =>
          Effect.map(
            compile(request, {
              body: { f: { page_size: "05" }, owned: "v", c: { a: "x" } },
            }),
            (compiled) => bodyText(compiled.request),
          ).pipe(Effect.provideService(Tenant, tenant)),
        { concurrency: "unbounded" },
      );
      expect(results).toEqual(
        ["one", "two", "three"].map((tenant) =>
          JSON.stringify({
            f: { page_size: "5" },
            owned: `${tenant}:v`,
            c: { a: "x" },
          }),
        ),
      );
    }),
  );
});
