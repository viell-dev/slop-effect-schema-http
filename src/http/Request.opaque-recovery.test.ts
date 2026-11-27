import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Option,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
import * as Request from "./Request.js";

const A = Schema.Struct({ a: Schema.String });
const AB = Schema.Struct({ a: Schema.String, b: Schema.String });
const F = Schema.Union([A, AB]);
const Core = Schema.Struct({ f: F, o: Schema.Option(A) });
const input = () => ({
  f: { a: "x", b: "y" },
  o: Option.some({ a: "o", zz: "z" }),
});
const sparseStrings = () => {
  const value: (string | undefined)[] = [];
  value.length = 1;
  return value;
};
const jsonText = <S extends Schema.Top>(schema: S, value: Inputs.Input<S>) =>
  Effect.map(Body.jsonSchema(schema).encode(value), (body) => {
    if (body._tag !== "Uint8Array") throw new Error("expected a JSON body");
    return new TextDecoder().decode(body.body);
  });
const json = <S extends Schema.Top>(schema: S, value: Inputs.Input<S>) =>
  Effect.map(jsonText(schema, value), (text) => JSON.parse(text) as unknown);
/** The library's own message for a field it cannot keep with the rest of the value. */
const notHeld = (path: string) =>
  `The schema cannot keep this field with the rest of the value\n  at ${path}`;
/** `held` beside these fields and `n`, written as `wire_n`, which puts the value on its encoded side. */
const besideWireN = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({
    held: Schema.OptionFromNullOr(Schema.Any),
    n: Schema.String,
    ...fields,
  }).pipe(Schema.encodeKeys({ n: "wire_n" }));
/** Fields whose own read refuses the wrapper `refused` beside a value on the encoded side. */
const refusingFields = (refused: Option.Option<unknown>) => {
  const codec = Schema.OptionFromNullOr(Schema.Any);
  return [
    [{ l: Schema.Array(codec) }, { l: [refused, null] }, '["l"][0]'],
    [{ l: Schema.Array(codec) }, { l: [null, refused] }, '["l"][1]'],
    [
      { r: Schema.Record(Schema.String, codec) },
      { r: { k: refused, j: null } },
      '["r"]["k"]',
    ],
    [{ t: Schema.Tuple([codec, codec]) }, { t: [refused, null] }, '["t"][0]'],
    [
      {
        f: Schema.Struct({ a: codec, m: Schema.String }).pipe(
          Schema.encodeKeys({ m: "wire_m" }),
        ),
      },
      { f: { a: refused, wire_m: "y" } },
      '["f"]["a"]',
    ],
  ] as const;
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/143
describe("visible unions beside opaque fields", () => {
  it.effect("keeps the visible wider member through Body.jsonSchema", () =>
    Effect.gen(function* () {
      expect(yield* json(Core, input())).toEqual({
        f: { a: "x", b: "y" },
        o: { _tag: "Some", value: { a: "o" } },
      });
    }),
  );

  it.effect("keeps the wider member through Request.compile", () =>
    Effect.gen(function* () {
      const request = Request.post("/x").pipe(
        Request.body(Body.jsonSchema(Core)),
      );
      const compiled = yield* Request.compile(request, { body: input() });
      if (compiled.request.body._tag !== "Uint8Array")
        throw new Error("expected a JSON body");
      expect(
        JSON.parse(new TextDecoder().decode(compiled.request.body.body)),
      ).toEqual({
        f: { a: "x", b: "y" },
        o: { _tag: "Some", value: { a: "o" } },
      });
    }),
  );

  it.effect("keeps a field the value gains before its encoding runs", () =>
    Effect.gen(function* () {
      const value = {
        f: { a: "x" } as { a: string; b?: string },
        o: input().o,
      };
      const pending = Body.jsonSchema(Core).encode(value);
      value.f.b = "y";
      const body = yield* pending;
      if (body._tag !== "Uint8Array") throw new Error("expected a JSON body");
      expect(JSON.parse(new TextDecoder().decode(body.body))).toMatchObject({
        f: { a: "x", b: "y" },
      });
    }),
  );

  it.effect(
    "does not substitute an older opaque identity while an Effect is pending",
    () =>
      Effect.gen(function* () {
        const external = { keep: "same" };
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.declare(
            (value): value is object =>
              typeof value === "object" && value !== null,
          ),
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== external,
          ),
        );
        const value = { ...input(), x: { keep: "same" } };
        const pending = Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )(value);
        value.x = external;
        const result = yield* pending;
        expect(result.lost).toEqual([["f", "b"]]);
        expect(result.output.x).toBe(external);
      }),
  );

  it.effect("retains changed record key order while an Effect is pending", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        ...Core.fields,
        x: Schema.Record(Schema.String, Schema.String),
      }).check(
        Schema.makeFilter(
          (value) =>
            !("b" in value.f) || Object.keys(value.x).join(",") !== "q,p",
        ),
      );
      const value = {
        ...input(),
        x: { p: "p", q: "q" } as Record<string, string>,
      };
      const pending = Inputs.reader(schema, Schema.encodeEffect(schema))(value);
      Reflect.deleteProperty(value.x, "p");
      value.x.p = "p";
      const result = yield* pending;
      expect(result.lost).toEqual([["f", "b"]]);
      expect(Object.keys(result.output.x)).toEqual(["q", "p"]);
    }),
  );

  it.effect("keeps whole-side priority rather than decoding each field", () =>
    Effect.gen(function* () {
      const Mixed = Schema.Struct({
        ...Core.fields,
        n: Schema.FiniteFromString,
        base64: Schema.StringFromBase64,
      });
      const read = Inputs.reader(Mixed, Schema.encodeEffect(Mixed));
      const encoded = yield* read({ ...input(), n: "1", base64: "eA==" });
      expect(encoded.output.base64).toBe("eA==");
      expect(encoded.lost).toEqual([["f", "b"]]);
      const failure = yield* Effect.flip(
        Body.jsonSchema(Mixed).encode({
          ...input(),
          n: "1",
          base64: "eA==",
        }),
      );
      expect(String(failure)).toContain('["f"]["b"]');
      expect(yield* json(Mixed, { ...input(), n: 1, base64: "eA==" })).toEqual({
        f: { a: "x", b: "y" },
        o: { _tag: "Some", value: { a: "o" } },
        n: "1",
        base64: "ZUE9PQ==",
      });
    }),
  );

  it.effect("leaves a Map's contents to its own ordinary reading", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        f: F,
        o: Schema.ReadonlyMap(Schema.String, A),
      });
      expect(
        yield* json(schema, {
          f: input().f,
          o: new Map([["k", { a: "o", zz: "z" }]]),
        }),
      ).toEqual({ f: { a: "x", b: "y" }, o: [["k", { a: "o" }]] });
    }),
  );

  it.effect("preserves the already successful renamed-sibling control", () =>
    Effect.gen(function* () {
      const renamed = Schema.Struct({
        f: F,
        o: A.pipe(Schema.encodeKeys({ a: "A" })),
      });
      expect(yield* json(renamed, { f: input().f, o: { A: "o" } })).toEqual({
        f: { a: "x", b: "y" },
        o: { A: "o" },
      });
    }),
  );

  it.effect("preserves parent checks and constructor defaults", () =>
    Effect.gen(function* () {
      const checked = Core.check(
        Schema.makeFilter((value) => !("b" in value.f)),
      );
      const original = yield* Inputs.reader(
        checked,
        Schema.encodeEffect(checked),
      )(input());
      expect(original.lost).toEqual([["f", "b"]]);
      expect(original.output.f).toEqual({ a: "x" });
      const defaulted = Schema.Struct({
        ...Core.fields,
        d: Schema.String.pipe(
          Schema.withConstructorDefault(Effect.succeed("default")),
        ),
      });
      expect(yield* json(defaulted, input())).toMatchObject({
        f: { a: "x", b: "y" },
        d: "default",
      });
    }),
  );

  it.effect("does not repeat callbacks for an already successful read", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const schema = Schema.Struct({
        ...Core.fields,
        d: Schema.String.pipe(
          Schema.withConstructorDefault(
            Effect.sync(() => {
              trace.push("default");
              return "d";
            }),
          ),
        ),
      }).check(
        Schema.makeFilter((value) => {
          trace.push(`parent:${Object.keys(value.f).join(",")}`);
          return true;
        }),
      );
      expect(
        yield* json(schema, { f: { a: "x" }, o: Option.some({ a: "o" }) }),
      ).toMatchObject({ f: { a: "x" }, d: "d" });
      expect(trace).toEqual(["default", "parent:a", "parent:a"]);
    }),
  );

  it.effect("retains the explicit JSON-text decoding limit", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ f: F, o: Schema.fromJsonString(A) });
      const result = yield* Inputs.reader(
        schema,
        Schema.encodeEffect(schema),
      )({
        f: input().f,
        o: '{"a":"o","zz":"z"}',
      });
      expect(result.output.o).toBe('{"a":"o"}');
      expect(result.lost).toEqual([["f", "b"]]);
    }),
  );

  it.effect("leaves out only what no member states", () =>
    Effect.gen(function* () {
      for (const value of [
        { ...input(), unknown: "root" },
        { ...input(), f: { ...input().f, unknown: "nested" } },
      ]) {
        const result = yield* Inputs.reader(
          Core,
          Schema.encodeEffect(Core),
        )(value);
        expect(result.lost).toEqual([]);
        expect(result.output.f).toEqual({ a: "x", b: "y" });
      }
      const impossible = Schema.Struct({
        f: Schema.Union([A, Schema.Struct({ b: Schema.String })]),
        o: Schema.Option(A),
      });
      const result = yield* Inputs.reader(
        impossible,
        Schema.encodeEffect(impossible),
      )(input());
      expect(result.lost).toEqual([["f", "b"]]);
      const failure = yield* Effect.flip(
        Inputs.refuseLost(impossible, result, () => true),
      );
      expect(failure.message).toContain('["f"]["b"]');
    }),
  );

  it.effect("keeps a symbol field beside the opaque value", () =>
    Effect.gen(function* () {
      const name = Symbol("field");
      const schema = Schema.Struct({ ...Core.fields, [name]: Schema.String });
      const result = yield* Inputs.reader(
        schema,
        Schema.encodeEffect(schema),
      )({ ...input(), [name]: "kept" });
      expect(result.lost).toEqual([]);
      expect(result.output[name]).toBe("kept");
      expect(result.output.f).toEqual({ a: "x", b: "y" });
    }),
  );

  // Effect 4.0.7 and 4.1.4 read such names differently, so a schema that states one is read as
  // Effect reads it, and what that loses is refused.
  for (const name of ["__proto__", "constructor", "toString"])
    it.effect(`refuses the narrower member beside a field named ${name}`, () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({ ...Core.fields, [name]: Schema.String });
        const value = Object.defineProperty(input(), name, {
          value: "kept",
          enumerable: true,
        });
        const { lost } = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )(value as never);
        expect(lost).toContainEqual(["f", "b"]);
      }),
    );

  it.effect(
    "does not split shared references to bypass the parent's check",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.Unknown,
          y: Schema.Unknown,
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== value.y,
          ),
        );
        const shared = { keep: "shared" };
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x: shared,
          y: shared,
        });
        expect(result.lost).toEqual([["f", "b"]]);
      }),
  );

  it.effect("keeps every field of repeated visible references", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        rows: Schema.Array(F),
        o: Schema.Option(A),
      });
      const shared = { a: "x", b: "y" };
      const result = yield* Inputs.reader(
        schema,
        Schema.encodeEffect(schema),
      )({
        rows: [shared, shared],
        o: input().o,
      });
      expect(result.lost).toEqual([]);
      expect(result.output.rows).toEqual([shared, shared]);
    }),
  );

  it.effect(
    "does not lose an inherited array value or bypass its parent check",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.Array(Schema.UndefinedOr(Schema.String)),
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x[0] !== "original",
          ),
        );
        const prototype: object = Object.create(Array.prototype);
        Object.defineProperty(prototype, "0", { value: "original" });
        const x = sparseStrings();
        Object.setPrototypeOf(x, prototype);
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x,
        });
        expect(result.lost).toEqual([["f", "b"]]);
        expect(result.output.x).toEqual(["original"]);
      }),
  );

  it.effect(
    "keeps ordinary sparse arrays eligible for constructor recovery",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Core.fields,
          x: Schema.Array(Schema.UndefinedOr(Schema.String)),
        });
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x: sparseStrings(),
        });
        expect(result.lost).toEqual([]);
        expect(result.output.x).toEqual([undefined]);
      }),
  );

  for (const [name, opaque] of [
    ["Unknown", Schema.Unknown],
    ["Any", Schema.Any],
    ["ObjectKeyword", Schema.ObjectKeyword],
    ["empty Struct", Schema.Struct({})],
    ["union with empty Struct", Schema.Union([Schema.Struct({}), A])],
    ["union with Unknown", Schema.Union([Schema.Unknown, A])],
    [
      "union with Declaration",
      Schema.Union([
        Schema.declare(
          (value): value is object =>
            typeof value === "object" && value !== null,
        ),
        A,
      ]),
    ],
  ] as const) {
    it.effect(`does not clone ${name} past an external identity check`, () =>
      Effect.gen(function* () {
        const external = { keep: "external" };
        const schema = Schema.Struct({ ...Core.fields, x: opaque }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== external,
          ),
        );
        const result = yield* Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({
          ...input(),
          x: external,
        });
        expect(result.lost).toEqual([["f", "b"]]);
      }),
    );
  }

  it.effect(
    "keeps the wider member under transformed, union and iterable parents",
    () =>
      Effect.gen(function* () {
        const schemas = [
          Core.pipe(Schema.encodeKeys({ f: "f" })),
          Schema.Union([Core, Schema.Struct({ unrelated: Schema.String })]),
          Schema.StructWithRest(Core, [
            Schema.Record(Schema.String, Schema.Unknown),
          ]),
          Schema.Struct({
            ...Core.fields,
            [Symbol.iterator]: Schema.optionalKey(Schema.Unknown),
          }),
        ];
        for (const schema of schemas) {
          const result = yield* Inputs.reader(
            schema,
            Schema.encodeEffect(schema),
          )(input());
          expect(result.lost).toEqual([]);
        }
        const iterable = {
          ...input(),
          [Symbol.iterator]() {
            throw new Error("must not iterate recovery input");
          },
        };
        const result = yield* Inputs.reader(
          Core,
          Schema.encodeEffect(Core),
        )(iterable);
        expect(result.lost).toEqual([]);
      }),
  );

  it.effect(
    "retains the refusal for accessor and inherited visible input",
    () =>
      Effect.gen(function* () {
        let gets = 0;
        const accessor = {
          ...input(),
          get f() {
            gets++;
            return { a: "x", b: "y" };
          },
        };
        const inherited = Object.create(input()) as ReturnType<typeof input>;
        for (const value of [accessor, inherited]) {
          const result = yield* Inputs.reader(
            Core,
            Schema.encodeEffect(Core),
          )(value);
          expect(result.lost).toEqual([["f", "b"]]);
        }
        expect(gets).toBeGreaterThan(0);
      }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/292
const Owner = Schema.Struct({ owner: Schema.String });
const Wide = Schema.Struct({ owner: Schema.String, limit: Schema.String });
const Filter = Schema.Union([Owner, Wide]);
const Held = Schema.Struct({
  held: Schema.OptionFromNullOr(Owner),
  filter: Filter,
});
const filter = { owner: "grace", limit: "y" };
const owner = { owner: "ada" };
const stray = { ...owner, stray: "x" };

describe("a stray key inside an Option with a visible encoded object", () => {
  it.effect("leaves out the stray key and keeps the visible union", () =>
    Effect.gen(function* () {
      const input = { held: Option.some(stray), filter };
      for (const value of [input, { ...input, strayAtRoot: "x" }]) {
        expect(yield* json(Held, value)).toEqual({ held: owner, filter });
      }
    }),
  );

  it.effect(
    "also sends without the visible union, without the stray key, or with None",
    () =>
      Effect.gen(function* () {
        const Alone = Schema.Struct({ held: Schema.OptionFromNullOr(Owner) });
        expect(yield* json(Alone, { held: Option.some(stray) })).toEqual({
          held: owner,
        });
        expect(yield* json(Held, { held: Option.some(owner), filter })).toEqual(
          { held: owner, filter },
        );
        expect(yield* json(Held, { held: Option.none(), filter })).toEqual({
          held: null,
          filter,
        });
      }),
  );

  it.effect("leaves out a stray key inside a Some in a struct and list", () =>
    Effect.gen(function* () {
      const Nested = Schema.Struct({
        items: Schema.Array(
          Schema.Struct({ held: Schema.OptionFromNullOr(Owner) }),
        ),
        filter: Filter,
      });
      expect(
        yield* json(Nested, { items: [{ held: Option.some(stray) }], filter }),
      ).toEqual({
        items: [{ held: owner }],
        filter,
      });
    }),
  );

  it.effect(
    "leaves out a stray key but still recognizes a declared wire name",
    () =>
      Effect.gen(function* () {
        const Renamed = Schema.Struct({
          held: Schema.OptionFromNullOr(
            Owner.pipe(Schema.encodeKeys({ owner: "OWNER" })),
          ),
          filter: Filter,
        });
        expect(
          yield* json(Renamed, { held: Option.some(stray), filter }),
        ).toEqual({
          held: { OWNER: "ada" },
          filter,
        });
        const mixed = { ...stray, OWNER: "wire" };
        const failure = yield* Effect.flip(
          json(Renamed, { held: Option.some(mixed), filter }),
        );
        expect(failure.message).toContain('["held"]["value"]["OWNER"]');
      }),
  );

  it.effect(
    "leaves out a key neither union member states, in both orders",
    () =>
      Effect.gen(function* () {
        const wider = { ...owner, limit: "z" };
        for (const contents of [Filter, Schema.Union([Wide, Owner])]) {
          const schema = Schema.Struct({
            held: Schema.OptionFromNullOr(contents),
          });
          expect(yield* json(schema, { held: Option.some(stray) })).toEqual({
            held: owner,
          });
          expect(
            yield* json(schema, {
              held: Option.some({ ...wider, stray: "x" }),
            }),
          ).toEqual({ held: wider });
        }
      }),
  );

  it.effect(
    "uses the same comparison for Effect's other unwrapping Option codecs",
    () =>
      Effect.gen(function* () {
        for (const [held, none] of [
          [Schema.OptionFromUndefinedOr(Owner), { held: null, filter }],
          [Schema.OptionFromNullishOr(Owner), { held: null, filter }],
          [Schema.OptionFromOptionalKey(Owner), { filter }],
          [Schema.OptionFromOptional(Owner), { filter }],
          [Schema.OptionFromOptionalNullOr(Owner), { filter }],
        ] as const) {
          const schema = Schema.Struct({ held, filter: Filter });
          expect(
            yield* json(schema, { held: Option.some(stray), filter }),
          ).toEqual({ held: owner, filter });
          expect(yield* json(schema, { held: Option.none(), filter })).toEqual(
            none,
          );
        }
      }),
  );

  it.effect(
    "writes a root Some as query and header fields when its encoded record fits",
    () =>
      Effect.gen(function* () {
        const schema = Schema.OptionFromOptionalKey(
          Schema.Union([Wide, Owner]),
        );
        const value = Option.some({ ...stray, limit: "z" });
        const request = Request.get("/x").pipe(
          Request.query(schema),
          Request.headers(schema),
        );
        const result = yield* Request.compile(request, {
          query: value,
          headers: value,
        });
        expect(result.request.url).toBe("/x?owner=ada&limit=z");
        expect(result.headerLines).toEqual([
          ["owner", "ada"],
          ["limit", "z"],
        ]);
      }),
  );

  it.effect(
    "keeps the refusal when a custom Option write replaces the payload",
    () =>
      Effect.gen(function* () {
        const Payload = Schema.Struct({
          owner: Schema.optionalKey(Schema.String),
        });
        const held = Schema.NullOr(Payload).pipe(
          Schema.decodeTo(
            Schema.Option(Schema.toType(Payload)),
            SchemaTransformation.transform<
              Option.Option<typeof Payload.Type>,
              typeof Payload.Encoded | null
            >({
              decode: Option.fromNullOr,
              encode: () => ({}),
            }),
          ),
        );
        const schema = Schema.Struct({ held, filter: Filter });
        const failure = yield* Effect.flip(
          json(schema, { held: Option.some(stray), filter }),
        );
        expect(failure.message).toContain('["held"]["value"]["stray"]');
      }),
  );

  it.effect(
    "lets a structural transformation decide what its payload writes strictly",
    () =>
      Effect.gen(function* () {
        const Decoded = Schema.Struct({
          owner: Schema.optionalKey(Schema.String),
        });
        const Encoded = Schema.Struct({
          OWNER: Schema.optionalKey(Schema.String),
        });
        for (const replacement of [{}, { OWNER: "replacement" }]) {
          const Payload = Encoded.pipe(
            Schema.decodeTo(
              Decoded,
              SchemaTransformation.transform<
                typeof Decoded.Type,
                typeof Encoded.Encoded
              >({
                decode: ({ OWNER }) =>
                  OWNER === undefined ? {} : { owner: OWNER },
                encode: () => replacement,
              }),
            ),
          );
          const schema = Schema.Struct({
            held: Schema.OptionFromNullOr(Payload),
            filter: Filter,
          });
          for (const payload of [owner, stray]) {
            expect(
              yield* json(schema, { held: Option.some(payload), filter }),
            ).toEqual({ held: replacement, filter });
          }
        }
      }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/299
it.effect("keeps a payload's value field separate from the Some wrapper", () =>
  Effect.gen(function* () {
    const Inner = Schema.Struct({ a: Schema.String });
    const Narrow = Schema.Struct({ value: Inner });
    const Apart = Schema.Struct({ c: Schema.String });
    const Wider = Schema.Struct({ value: Inner, a: Schema.String });
    const value = { a: "inner" };
    const held = { value, a: "outer" };
    const apart = Schema.Struct({
      held: Schema.OptionFromNullOr(Schema.Union([Narrow, Apart])),
    });
    expect(yield* json(apart, { held: Option.some(held) })).toEqual({
      held: { value },
    });
    for (const members of [
      [Narrow, Wider],
      [Wider, Narrow],
    ] as const) {
      const schema = Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Union(members)),
        filter: Filter,
      });
      for (const payload of [held, { ...held, stray: "x" }]) {
        expect(
          yield* json(schema, { held: Option.some(payload), filter }),
        ).toEqual({ held, filter });
      }
    }
  }),
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/305
it.effect(
  "keeps the wider choice when a nested or tagged Some has a stray key",
  () =>
    Effect.gen(function* () {
      const wide = { ...owner, limit: "l" };
      const TaggedOwner = Schema.TaggedStruct("A", Owner.fields);
      const TaggedWide = Schema.TaggedStruct("A", Wide.fields);
      const TaggedHolder = Schema.TaggedStruct("A", { f: Filter });
      const Nested = Schema.Struct({
        inner: Schema.OptionFromNullOr(Filter),
        tag: Schema.String,
      });
      const N = Schema.Struct({ held: Schema.OptionFromNullOr(Nested) });
      expect(
        yield* json(N, {
          held: Option.some({
            inner: Option.some({ ...wide, stray: "x" }),
            tag: "t",
          }),
        }),
      ).toEqual({ held: { inner: wide, tag: "t" } });
      const T = Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Union([TaggedOwner, TaggedWide])),
      });
      expect(
        yield* json(T, {
          held: Option.some({ _tag: "A", ...wide, stray: "x" } as const),
        }),
      ).toEqual({ held: { _tag: "A", ...wide } });
      const H = Schema.Struct({ held: Schema.OptionFromNullOr(TaggedHolder) });
      expect(
        yield* json(H, {
          held: Option.some({ _tag: "A", f: wide, stray: "x" } as const),
        }),
      ).toEqual({ held: { _tag: "A", f: wide } });
    }),
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/292
it.effect("writes the same body with a stray Some field as without it", () =>
  Effect.gen(function* () {
    const wide = { ...owner, limit: "l" };
    const TaggedOwner = Schema.TaggedStruct("A", Owner.fields);
    const TaggedWide = Schema.TaggedStruct("A", Wide.fields);
    const tagged = { _tag: "A" as const, ...wide };
    const holder = { _tag: "A" as const, f: wide };
    const withValue = { value: { a: "1" }, f: wide };
    const neighbours = [
      [Filter, wide, wide],
      [
        Schema.OptionFromNullOr(Schema.TaggedStruct("A", { f: Filter })),
        Option.some(holder),
        holder,
      ],
      [
        Schema.OptionFromNullOr(Schema.Union([TaggedOwner, TaggedWide])),
        Option.some(tagged),
        tagged,
      ],
      [
        Schema.OptionFromNullOr(Schema.Array(Filter)),
        Option.some([wide]),
        [wide],
      ],
      [
        Schema.OptionFromNullOr(
          Schema.Struct({
            value: Schema.Struct({ a: Schema.String }),
            f: Filter,
          }),
        ),
        Option.some(withValue),
        withValue,
      ],
      [Schema.Option(Filter), Option.some(wide), { _tag: "Some", value: wide }],
      [
        Schema.ReadonlyMap(Schema.String, Filter),
        new Map([["k", wide]]),
        [["k", wide]],
      ],
      [Schema.OptionFromNullOr(Filter), Option.some(wide), wide],
    ] as const;
    for (const codec of [
      Schema.OptionFromNullOr,
      Schema.OptionFromUndefinedOr,
      Schema.OptionFromNullishOr,
      Schema.OptionFromOptionalKey,
      Schema.OptionFromOptional,
      Schema.OptionFromOptionalNullOr,
    ]) {
      for (const [other, value, expected] of neighbours) {
        const schema = Schema.Struct({
          held: codec(Owner),
          other,
          filter: Filter,
        });
        for (const contents of [owner, stray]) {
          expect(
            yield* json(schema, {
              held: Option.some(contents),
              other: value,
              filter,
            }),
          ).toEqual({ held: owner, other: expected, filter });
        }
      }
      const Nested = Schema.Struct({
        inner: Schema.OptionFromNullOr(Filter),
        tag: Schema.String,
      });
      const schema = Schema.Struct({ held: codec(Nested), filter: Filter });
      const contents = { inner: Option.some(wide), tag: "t" };
      expect(
        yield* json(schema, {
          held: Option.some({ ...contents, stray: "x" }),
          filter,
        }),
      ).toEqual({ held: { inner: wide, tag: "t" }, filter });
    }
  }),
);

it.effect(
  "leaves opaque children and checked or suspended codecs to their own reading",
  () =>
    Effect.gen(function* () {
      class OwnerRow extends Schema.Class<OwnerRow>("OwnerRow")(Owner.fields) {}
      const Payload = Schema.Struct({
        ...Owner.fields,
        none: Schema.OptionFromOptionalKey(Schema.String),
        some: Schema.OptionFromNullOr(Schema.String),
        date: Schema.Date,
        big: Schema.BigInt,
        unknown: Schema.Unknown,
        row: OwnerRow,
      });
      const held = Schema.OptionFromNullOr(Schema.suspend(() => Payload)).check(
        Schema.makeFilter(() => true),
      );
      const schema = Schema.Struct({ held, filter: Filter });
      const contents = {
        ...stray,
        none: Option.none(),
        some: Option.some("s"),
        date: new Date(0),
        big: 5n,
        unknown: { any: 1 },
        row: new OwnerRow(owner),
      };
      expect(
        yield* json(schema, { held: Option.some(contents), filter }),
      ).toEqual({
        held: {
          ...owner,
          some: "s",
          date: "1970-01-01T00:00:00.000Z",
          big: "5",
          unknown: { any: 1 },
          row: owner,
        },
        filter,
      });
    }),
);

it.effect("retains fields an open payload alternative can hold", () =>
  Effect.gen(function* () {
    const held = Schema.OptionFromNullOr(Schema.Union([Owner, Schema.Unknown]));
    const schema = Schema.Struct({ held, filter: Filter });
    expect(yield* json(schema, { held: Option.some(stray), filter })).toEqual({
      held: stray,
      filter,
    });
  }),
);

it.effect("retries the original when a strict write fails", () =>
  Effect.gen(function* () {
    const extra = Schema.Struct({ a: Schema.String, b: Schema.String });
    const Encoded = Schema.Struct({ a: Schema.String });
    const codec = Encoded.pipe(
      Schema.decodeTo(
        extra,
        SchemaTransformation.transform({
          decode: ({ a }) => ({ a, b: "default" }),
          encode: (value) => value,
        }),
      ),
    );
    const schema = Schema.Struct({
      held: Schema.OptionFromNullOr(Owner),
      filter: Filter,
      codec,
    });
    const supplied = { a: "a", b: "b" };
    expect(
      yield* json(schema, {
        held: Option.some(owner),
        filter,
        codec: supplied,
      }),
    ).toEqual({ held: owner, filter, codec: { a: "a" } });
    const failure = yield* Effect.flip(
      json(schema, { held: Option.some(stray), filter, codec: supplied }),
    );
    expect(failure.message).toContain('["held"]["value"]["stray"]');
    const withWiderPayload = Schema.Struct({
      held: Schema.OptionFromNullOr(Filter),
      codec,
    });
    const wider = { ...owner, limit: "l" };
    expect(
      yield* json(withWiderPayload, {
        held: Option.some(wider),
        codec: supplied,
      }),
    ).toEqual({ held: wider, codec: { a: "a" } });
  }),
);

/** A built-in codec behind encoding middleware, which the writer follows to its unwrapping link. */
const caught = <S extends Schema.Top>(payload: S) =>
  Schema.OptionFromNullOr(payload).pipe(
    Schema.catchEncoding(() => Effect.succeedSome(null)),
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/308
describe("loose writes inside Some", () => {
  class Counted extends Schema.Class<Counted>("Counted")({ a: Schema.String }) {
    readonly reads = 1;
  }
  const who = new Counted({ a: "item" });
  const writtenWho = { a: "item" };
  const wide = { ...owner, limit: "l" };
  const classChoice = Schema.Union([A, Counted]);
  const direct = <S extends Schema.Top>(payload: S) =>
    Schema.NullOr(payload).pipe(
      Schema.decodeTo(
        Schema.Option(Schema.toType(payload)),
        SchemaTransformation.transform({
          decode: (value): Option.Option<S["Type"]> =>
            value === null ? Option.none() : Option.some(value),
          encode: (value) => Option.getOrNull(value),
        }),
      ),
    );
  const boxed = <S extends Schema.Top>(payload: S) =>
    Schema.Struct({ v: Schema.NullOr(payload) }).pipe(
      Schema.decodeTo(
        Schema.Option(Schema.toType(payload)),
        SchemaTransformation.transform({
          decode: ({ v }): Option.Option<S["Type"]> =>
            v === null ? Option.none() : Option.some(v),
          encode: (value) => ({ v: Option.getOrNull(value) }),
        }),
      ),
    );

  it.effect(
    "keeps a wider field and its narrow control below an index rename",
    () =>
      Effect.gen(function* () {
        const payload = Schema.Struct({ a: Schema.String, f: Filter }).pipe(
          Schema.encodeKeys({ a: "0" }),
        );
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(payload),
          who: Counted,
        });
        for (const f of [wide, owner]) {
          expect(
            yield* json(schema, { held: Option.some({ a: "x", f }), who }),
          ).toEqual({
            held: { "0": "x", f },
            who: writtenWho,
          });
        }
        const renamedRoot = Schema.Struct({
          a: Schema.String,
          held: Schema.OptionFromNullOr(Filter),
          who: Counted,
        }).pipe(Schema.encodeKeys({ a: "0" }));
        expect(
          yield* json(renamedRoot, { a: "x", held: Option.some(wide), who }),
        ).toEqual({
          "0": "x",
          held: wide,
          who: writtenWho,
        });
      }),
  );

  it.effect(
    "follows the inner codec through an outer Some's decoded projection",
    () =>
      Effect.gen(function* () {
        const payload = Schema.Struct({
          a: Schema.String,
          inner: Schema.OptionFromNullOr(Filter),
        }).pipe(Schema.encodeKeys({ a: "0" }));
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(payload),
          who: Counted,
        });
        expect(
          yield* json(schema, {
            held: Option.some({ a: "x", inner: Option.some(wide) }),
            who,
          }),
        ).toEqual({ held: { "0": "x", inner: wide }, who: writtenWho });
      }),
  );

  it.effect("keeps the wider field with either configured None encoding", () =>
    Effect.gen(function* () {
      for (const onNoneEncoding of [null, undefined]) {
        const schema = Schema.Struct({
          held: Schema.OptionFromOptionalNullOr(Filter, { onNoneEncoding }),
          who: Counted,
        });
        expect(yield* json(schema, { held: Option.some(wide), who })).toEqual({
          held: wide,
          who: writtenWho,
        });
      }
    }),
  );

  it.effect(
    "keeps both object and transformed scalar values at crossing wire names",
    () =>
      Effect.gen(function* () {
        const object = Schema.Struct({ n: Schema.String });
        for (const [field, x, y, writtenX, writtenY] of [
          [object, { n: "X" }, { n: "Y" }, { n: "X" }, { n: "Y" }],
          [Schema.FiniteFromString, 5, 7, "5", "7"],
        ] as const) {
          const narrow = Schema.Struct({ id: Schema.String, y: field }).pipe(
            Schema.encodeKeys({ y: "x" }),
          );
          const wider = Schema.Struct({
            id: Schema.String,
            y: field,
            x: field,
          });
          const schema = Schema.Struct({
            held: Schema.OptionFromNullOr(Schema.Union([narrow, wider])),
            who: Counted,
          });
          expect(
            yield* json(schema, { held: Option.some({ id: "1", x, y }), who }),
          ).toEqual({
            held: { id: "1", x: writtenX, y: writtenY },
            who: writtenWho,
          });
        }
      }),
  );

  const Page = Schema.Struct({
    owner: Schema.String,
    limit: Schema.String,
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const wirePage = { owner: "a", page_size: "5" };

  it.effect(
    "accepts a wire name inside Schema.Option under a renamed parent",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          held: Schema.Option(Page),
          who: Counted,
        }).pipe(Schema.encodeKeys({ held: "h" }));
        expect(
          // Exercise the encoded payload at runtime; this typed input expects decoded contents.
          yield* json(schema, { held: Option.some(wirePage), who } as never),
        ).toEqual({
          h: { _tag: "Some", value: wirePage },
          who: writtenWho,
        });
      }),
  );

  it.effect(
    "accepts an encoded scalar inside Schema.Option on the loose route",
    () =>
      Effect.gen(function* () {
        const Count = Schema.Struct({
          owner: Schema.String,
          n: Schema.FiniteFromString,
        });
        const schema = Schema.Struct({
          held: Schema.Option(Count),
          who: Counted,
        }).pipe(Schema.encodeKeys({ held: "h" }));
        const value = { owner: "a", n: "5" };
        expect(
          yield* json(schema, { held: Option.some(value), who } as never),
        ).toEqual({
          h: { _tag: "Some", value },
          who: writtenWho,
        });
      }),
  );

  it.effect(
    "keeps the class member beside an encoded Schema.Option payload",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          held: Schema.Option(Page),
          item: Schema.Union([Schema.Struct({ a: Schema.String }), Counted]),
        });
        expect(
          yield* json(schema, { held: Option.some(wirePage), item: who }),
        ).toEqual({
          held: { _tag: "Some", value: wirePage },
          item: writtenWho,
        });
      }),
  );

  it.effect("leaves names inside Schema.Option to Effect on loose writes", () =>
    Effect.gen(function* () {
      const Ids = Schema.Struct({
        id: Schema.String,
        externalId: Schema.String,
      }).pipe(Schema.encodeKeys({ id: "internal_id", externalId: "id" }));
      const Swap = AB.pipe(Schema.encodeKeys({ a: "b", b: "a" }));
      const Shift = Schema.Struct({
        a: Schema.String,
        b: Schema.optionalKey(Schema.String),
      }).pipe(Schema.encodeKeys({ a: "b", b: "c" }));
      const OnlyC = Schema.Struct({ b: Schema.String }).pipe(
        Schema.encodeKeys({ b: "c" }),
      );
      const Titled = Schema.Struct({ title: Schema.String }).pipe(
        Schema.encodeKeys({ title: "name" }),
      );
      const Named = Schema.Struct({ name: Schema.String, kind: Schema.String });
      const Keyed = Schema.Struct({
        m: Schema.Record(
          Schema.String.pipe(
            Schema.decodeTo(Schema.String, SchemaTransformation.snakeToCamel()),
          ),
          Schema.String,
        ),
        n: Schema.FiniteFromString,
      });
      const Blank = Schema.Struct({ a: Schema.String, n: Schema.String }).pipe(
        Schema.decodeTo(
          Schema.Struct({
            a: Schema.String,
            n: Schema.optionalKey(Schema.Finite),
          }),
          SchemaTransformation.transform({
            decode: ({ a, n }) => (n === "" ? { a } : { a, n: Number(n) }),
            encode: ({ a, n }) => ({ a, n: n === undefined ? "" : String(n) }),
          }),
        ),
      );
      const codec = A.pipe(
        Schema.decodeTo(
          AB,
          SchemaTransformation.transform({
            decode: ({ a }) => ({ a, b: "default" }),
            encode: (value) => value,
          }),
        ),
      );
      for (const [payload, given, written] of [
        [
          Schema.Union([Schema.Struct({ externalId: Schema.String }), Ids]),
          { id: "mine", externalId: "theirs" },
          { externalId: "theirs" },
        ],
        [Schema.Union([A, Swap]), { a: "A", b: "B" }, { a: "A" }],
        [Schema.Union([OnlyC, Shift]), { b: "A", c: "B" }, { c: "A" }],
        [Schema.Union([Titled, Named]), { name: "n" }, { name: "n" }],
        [Schema.Union([Named, Titled]), { name: "n" }, { name: "n" }],
        [
          Keyed,
          { m: { page_size: "v" }, n: "5" },
          { m: { page_size: "v" }, n: "5" },
        ],
        [Blank, { a: "a", n: "" }, { a: "a", n: "" }],
      ] as const) {
        const held = Schema.Option(payload);
        const renamed = Schema.Struct({ held, who: Counted }).pipe(
          Schema.encodeKeys({ held: "h" }),
        );
        const failingWrite = Schema.Struct({ held, codec });
        const value = Option.some(given);
        const expected = { _tag: "Some", value: written };
        expect(yield* json(renamed, { held: value, who } as never)).toEqual({
          h: expected,
          who: writtenWho,
        });
        expect(
          yield* json(failingWrite, {
            held: value,
            codec: { a: "a", b: "b" },
          } as never),
        ).toEqual({ held: expected, codec: { a: "a" } });
      }
    }),
  );

  it.effect(
    "stops loose recovery at a tagged Option around an unwrapping codec",
    () =>
      Effect.gen(function* () {
        const held = Schema.Option(
          Schema.Struct({
            n: Schema.FiniteFromString,
            inner: Schema.OptionFromNullOr(Filter),
          }),
        );
        const root = Schema.Struct({ held, who: Counted }).pipe(
          Schema.encodeKeys({ held: "h" }),
        );
        expect(
          yield* json(root, {
            held: Option.some({ n: 5, inner: Option.some(wide) }),
            who,
          }),
        ).toEqual({
          h: { _tag: "Some", value: { n: "5", inner: owner } },
          who: writtenWho,
        });
      }),
  );

  it.effect(
    "keeps a tagged Option opaque inside an unwrapping codec's decoded projection",
    () =>
      Effect.gen(function* () {
        const held = Schema.OptionFromNullOr(
          Schema.Struct({
            visible: Schema.OptionFromNullOr(Filter),
            opaque: Schema.Option(Filter),
          }),
        );
        const schema = Schema.Struct({ held, who: Counted });
        const some = Option.some(wide);
        expect(
          yield* json(schema, {
            held: Option.some({ visible: some, opaque: some }),
            who,
          }),
        ).toEqual({
          held: { visible: wide, opaque: { _tag: "Some", value: owner } },
          who: writtenWho,
        });
      }),
  );

  it.effect(
    "keeps Effect's loose selection beside an opaque Option alternative",
    () =>
      Effect.gen(function* () {
        const held = Schema.OptionFromNullOr(
          Schema.Struct({
            inner: Schema.Union([Schema.Option(Filter), Schema.String]),
          }),
        );
        const schema = Schema.Struct({ held, who: Counted, filter: Filter });
        expect(
          yield* json(schema, {
            held: Option.some({ inner: Option.some(wide) }),
            who,
            filter: wide,
          }),
        ).toEqual({
          held: { inner: { _tag: "Some", value: owner } },
          who: writtenWho,
          filter: wide,
        });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/312
  it.effect(
    "leaves a stray key inside a tagged Option to Effect after a failed strict write",
    () =>
      Effect.gen(function* () {
        const codec = A.pipe(
          Schema.decodeTo(
            AB,
            SchemaTransformation.transform({
              decode: ({ a }) => ({ a, b: "default" }),
              encode: (value) => value,
            }),
          ),
        );
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(
            Schema.Struct({ inner: Schema.Option(Filter) }),
          ),
          codec,
        });
        expect(
          yield* json(schema, {
            held: Option.some({ inner: Option.some({ ...wide, stray: "x" }) }),
            codec: { a: "a", b: "b" },
          }),
        ).toEqual({
          held: { inner: { _tag: "Some", value: owner } },
          codec: { a: "a" },
        });
      }),
  );

  it.effect(
    "keeps the wider encoded field in a tagged Option beside a scalar outside a payload",
    () =>
      Effect.gen(function* () {
        const payload = Schema.Union([
          Owner,
          Schema.Struct({
            owner: Schema.String,
            limit: Schema.FiniteFromString,
          }),
        ]);
        const schema = Schema.Struct({
          held: Schema.Union([Schema.Option(payload), Schema.String]),
          item: classChoice,
        });
        expect(
          yield* json(schema, {
            held: Option.some({ ...owner, limit: 5 }),
            item: who,
          }),
        ).toEqual({
          held: { _tag: "Some", value: { ...owner, limit: "5" } },
          item: writtenWho,
        });
      }),
  );

  it.effect(
    "keeps a tagged Option wide inside a payload beside an unwrapping alternative",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(
            Schema.Struct({
              inner: Schema.Union([
                Schema.Option(Filter),
                Schema.OptionFromNullOr(Filter),
              ]),
            }),
          ),
          item: classChoice,
        });
        expect(
          yield* json(schema, {
            held: Option.some({ inner: Option.some(wide) }),
            item: who,
          }),
        ).toEqual({
          held: { inner: { _tag: "Some", value: wide } },
          item: writtenWho,
        });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/312
  it.effect(
    "sends the class member and leaves a tagged sibling's member choice to Effect",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          held: Schema.Option(Filter),
          item: classChoice,
        });
        expect(
          yield* json(schema, { held: Option.some(wide), item: who }),
        ).toEqual({
          held: { _tag: "Some", value: owner },
          item: writtenWho,
        });
      }),
  );

  for (const [name, codec, wire] of [
    ["a direct transform", direct, wide],
    ["a single-field transform", boxed, { v: wide }],
    ["encoding middleware", caught, wide],
  ] as const) {
    it.effect(
      `keeps wider fields through ${name} at a field or inside another Some`,
      () =>
        Effect.gen(function* () {
          const inner = codec(Filter);
          const some = Option.some(wide);
          expect(
            yield* json(Schema.Struct({ held: inner, who: Counted }), {
              held: some,
              who,
            }),
          ).toEqual({
            held: wire,
            who: writtenWho,
          });
          const held = Schema.OptionFromNullOr(Schema.Struct({ inner }));
          expect(
            yield* json(Schema.Struct({ held, who: Counted }), {
              held: Option.some({ inner: some }),
              who,
            }),
          ).toEqual({
            held: { inner: wire },
            who: writtenWho,
          });
        }),
    );
  }

  for (const [name, codec] of [
    ["a direct transform", direct],
    ["encoding middleware", caught],
  ] as const) {
    it.effect(`keeps a wider same-tag member through ${name}`, () =>
      Effect.gen(function* () {
        const held = codec(
          Schema.Union([
            Schema.TaggedStruct("A", Owner.fields),
            Schema.TaggedStruct("A", Wide.fields),
          ]),
        );
        const value = { _tag: "A" as const, ...wide };
        expect(
          yield* json(Schema.Struct({ held, who: Counted }), {
            held: Option.some(value),
            who,
          }),
        ).toEqual({ held: value, who: writtenWho });
      }),
    );

    it.effect(`keeps a wider list item through ${name}`, () =>
      Effect.gen(function* () {
        const held = codec(Schema.Array(Filter));
        expect(
          yield* json(Schema.Struct({ held, who: Counted }), {
            held: Option.some([wide]),
            who,
          }),
        ).toEqual({ held: [wide], who: writtenWho });
      }),
    );
  }

  it.effect("compares caller names and values inside an unwrapping Some", () =>
    Effect.gen(function* () {
      for (const [payload, value, key] of [
        [
          Schema.Union([Owner, Page]),
          { owner: "a", page_size: "5" },
          "page_size",
        ],
        [
          Schema.Union([
            Owner,
            Schema.Struct({ owner: Schema.String, n: Schema.FiniteFromString }),
          ]),
          { owner: "a", n: "5" },
          "n",
        ],
      ] as const) {
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(payload),
          who: Counted,
        }).pipe(Schema.encodeKeys({ held: "h" }));
        const error = yield* Effect.flip(
          json(schema, { held: Option.some(value), who } as never),
        );
        expect(error.message).toContain(`["held"]["value"]["${key}"]`);
      }

      for (const member of [
        Schema.Struct({
          value: A,
          n: Schema.optionalKey(Schema.FiniteFromString),
        }),
        Schema.Struct({ value: A, n: Schema.optionalKey(Schema.String) }).pipe(
          Schema.encodeKeys({ n: "N" }),
        ),
      ]) {
        const held = Schema.OptionFromNullOr(
          Schema.Union([member, Schema.Struct({ c: Schema.String })]),
        );
        const value = Option.some({ value: { a: "inner" }, a: "outer" });
        expect(yield* json(Schema.Struct({ held }), { held: value })).toEqual({
          held: { value: { a: "inner" } },
        });
        const schema = Schema.Struct({ held, who: Counted }).pipe(
          Schema.encodeKeys({ held: "h" }),
        );
        const error = yield* Effect.flip(json(schema, { held: value, who }));
        expect(error.message).toContain('["held"]["value"]["a"]');
      }
    }),
  );

  it.effect(
    "keeps configured tagged and list payloads below a renamed parent",
    () =>
      Effect.gen(function* () {
        const tagged = Schema.Union([
          Schema.TaggedStruct("A", Owner.fields),
          Schema.TaggedStruct("A", Wide.fields),
        ]);
        const taggedRoot = Schema.Struct({
          held: Schema.OptionFromOptionalNullOr(tagged, {
            onNoneEncoding: null,
          }),
          who: Counted,
        }).pipe(Schema.encodeKeys({ held: "h" }));
        const listRoot = Schema.Struct({
          held: Schema.OptionFromOptionalNullOr(Schema.Array(Filter), {
            onNoneEncoding: null,
          }),
          who: Counted,
        }).pipe(Schema.encodeKeys({ held: "h" }));
        const payload = { _tag: "A" as const, ...wide };
        expect(
          yield* json(taggedRoot, { held: Option.some(payload), who }),
        ).toEqual({
          h: payload,
          who: writtenWho,
        });
        expect(
          yield* json(listRoot, { held: Option.some([wide]), who }),
        ).toEqual({
          h: [wide],
          who: writtenWho,
        });
      }),
  );

  it.effect("lets a configured codec write its payload's wire names", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        held: Schema.OptionFromOptionalNullOr(Page, { onNoneEncoding: null }),
        who: Counted,
      });
      expect(
        yield* json(schema, {
          held: Option.some({ owner: "a", limit: "5" }),
          who,
        }),
      ).toEqual({ held: wirePage, who: writtenWho });
    }),
  );

  it.effect("leaves map payloads opaque on either side of an Option", () =>
    Effect.gen(function* () {
      const OptionOfMap = Schema.Struct({
        held: Schema.Option(Schema.ReadonlyMap(Schema.String, Filter)),
        who: Counted,
        filter: Filter,
      });
      const MapOfOptions = Schema.Struct({
        held: Schema.ReadonlyMap(
          Schema.String,
          Schema.OptionFromNullOr(Filter),
        ),
        who: Counted,
        filter: Filter,
      });
      expect(
        yield* json(OptionOfMap, {
          held: Option.some(new Map([["k", wide]])),
          who,
          filter: wide,
        }),
      ).toEqual({
        held: { _tag: "Some", value: [["k", owner]] },
        who: writtenWho,
        filter: wide,
      });
      expect(
        yield* json(MapOfOptions, {
          held: new Map([["k", Option.some(wide)]]),
          who,
          filter: wide,
        }),
      ).toEqual({
        held: [["k", owner]],
        who: writtenWho,
        filter: wide,
      });
    }),
  );

  it.effect("keeps a configured tagged payload wide after a loose read", () =>
    Effect.gen(function* () {
      const tagged = Schema.Union([
        Schema.TaggedStruct("A", Owner.fields),
        Schema.TaggedStruct("A", Wide.fields),
      ]);
      const schema = Schema.Struct({
        held: Schema.OptionFromOptionalNullOr(tagged, { onNoneEncoding: null }),
        who: Counted,
      });
      const payload = { _tag: "A" as const, ...wide };
      expect(yield* json(schema, { held: Option.some(payload), who })).toEqual({
        held: payload,
        who: writtenWho,
      });
    }),
  );
});

it.effect(
  "keeps the original loss diagnostic when the writer is supplied separately",
  () =>
    Effect.gen(function* () {
      const read = Inputs.reader(Held, Schema.encodeEffect(Held));
      const result = yield* read({ held: Option.some(stray), filter });
      expect(result.lost).toContainEqual(["held", "value", "stray"]);
    }),
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/305
it.effect("refuses a stated wire name that a nested Some would strip", () =>
  Effect.gen(function* () {
    const Renamed = Schema.Struct({
      owner: Schema.String,
      limit: Schema.optionalKey(Schema.String),
    }).pipe(Schema.encodeKeys({ limit: "page_size" }));
    const held = Schema.OptionFromNullOr(
      Schema.Struct({
        inner: Schema.OptionFromNullOr(Renamed),
        tag: Schema.String,
      }),
    );
    const schema = Schema.Struct({ held, filter: Filter });
    const contents = {
      inner: Option.some({ ...owner, page_size: "5" }),
      tag: "t",
    };
    for (const payload of [contents, { ...contents, stray: "x" }]) {
      const failure = yield* Effect.flip(
        json(schema, { held: Option.some(payload), filter }),
      );
      expect(failure.message).toContain(
        '["held"]["value"]["inner"]["value"]["page_size"]',
      );
    }
  }),
);

it.effect(
  "keeps visible Some fields through scalar alternatives and suspension",
  () =>
    Effect.gen(function* () {
      const payload = Schema.Union([
        Schema.TaggedStruct("A", Owner.fields),
        Schema.TaggedStruct("A", Wide.fields),
      ]);
      const option = Schema.OptionFromNullOr(payload);
      const value = { _tag: "A" as const, ...owner, limit: "l" };
      class Holder extends Schema.Class<Holder>("Holder")({
        held: option,
        filter: Filter,
      }) {}
      for (const schema of [
        Schema.Struct({ held: Schema.optional(option), filter: Filter }),
        Schema.Struct({ held: Schema.NullOr(option), filter: Filter }),
        Schema.Struct({ held: Schema.UndefinedOr(option), filter: Filter }),
        Schema.Struct({
          held: Schema.Union([Schema.String, option]),
          filter: Filter,
        }),
        Schema.Struct({ held: Schema.suspend(() => option), filter: Filter }),
        Holder,
      ]) {
        expect(
          yield* json(schema, {
            held: Option.some({ ...value, stray: "x" }),
            filter,
          }),
        ).toEqual({ held: value, filter });
      }
    }),
);

it.effect(
  "keeps list and tuple contents of OptionFromOptionalKey through a renamed parent",
  () =>
    Effect.gen(function* () {
      const wide = { ...owner, limit: "l" };
      const value = { ...wide, stray: "x" };
      const list = Schema.Struct({
        held: Schema.OptionFromOptionalKey(Schema.Array(Filter)),
        sortBy: Schema.String,
      }).pipe(Schema.encodeKeys({ sortBy: "sort_by" }));
      expect(
        yield* json(list, { held: Option.some([value]), sortBy: "s" }),
      ).toEqual({
        held: [wide],
        sort_by: "s",
      });
      const tuple = Schema.Struct({
        held: Schema.OptionFromOptionalKey(
          Schema.Tuple([Filter, Schema.String]),
        ),
      }).pipe(Schema.encodeKeys({ held: "HELD" }));
      expect(
        yield* json(tuple, { held: Option.some([value, "s"] as const) }),
      ).toEqual({
        HELD: [wide, "s"],
      });
    }),
);

it.effect(
  "keeps the actual payload value under a class and an optional wire key",
  () =>
    Effect.gen(function* () {
      const Payload = Schema.Union([
        Schema.Struct({ value: Schema.Struct({ a: Schema.String }) }),
        Schema.Struct({ c: Schema.String }),
      ]);
      class Holder extends Schema.Class<Holder>("ValueHolder")({
        held: Schema.OptionFromNullOr(Payload),
      }) {}
      const Renamed = Schema.Struct({
        held: Schema.OptionFromOptionalKey(Payload),
      }).pipe(Schema.encodeKeys({ held: "HELD" }));
      const value = { a: "inner" };
      const input = { held: Option.some({ value, a: "outer" }) };
      expect(yield* json(Holder, input)).toEqual({ held: { value } });
      expect(yield* json(Renamed, input)).toEqual({ HELD: { value } });
    }),
);

it.effect(
  "uses the original read when an opaque neighbour prevents strict preparation",
  () =>
    Effect.gen(function* () {
      const Tagged = Schema.TaggedStruct("A", Owner.fields);
      const Opaque = Schema.Option(Schema.Struct({ x: Schema.String }));
      const tagged = { _tag: "A" as const, ...owner };
      const withStray = { ...tagged, stray: "x" };
      const other = { x: "1", stray2: "y" };
      const wrapped = Option.some(other);
      const written = { _tag: "Some", value: { x: "1" } };
      const schema = Schema.Struct({
        held: Schema.OptionFromNullOr(Tagged),
        other: Opaque,
        filter: Filter,
      });
      expect(
        yield* json(schema, {
          held: Option.some(withStray),
          other: wrapped,
          filter,
        }),
      ).toEqual({
        held: tagged,
        other: written,
        filter,
      });
      const list = Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Array(Tagged)),
        other: Opaque,
        filter: Filter,
      });
      expect(
        yield* json(list, {
          held: Option.some([withStray]),
          other: wrapped,
          filter,
        }),
      ).toEqual({
        held: [tagged],
        other: written,
        filter,
      });
      const nested = Schema.Struct({
        held: Schema.OptionFromNullOr(
          Schema.Struct({ inner: Schema.OptionFromNullOr(Tagged) }),
        ),
        other: Schema.ReadonlyMap(
          Schema.String,
          Schema.Struct({ x: Schema.String }),
        ),
        filter: Filter,
      });
      expect(
        yield* json(nested, {
          held: Option.some({ inner: Option.some(withStray) }),
          other: new Map([["k", other]]),
          filter,
        }),
      ).toEqual({
        held: { inner: tagged },
        other: [["k", written.value]],
        filter,
      });
    }),
);

it.effect(
  "reports a stated field lost on the relaxed route at its Some path",
  () =>
    Effect.gen(function* () {
      const other = Schema.Option(Schema.Struct({ x: Schema.String }));
      const neighbour = { x: "1", stray: "x" };
      const wide = { ...owner, limit: "l" };
      const input = { other: Option.some(neighbour) };
      const tagged = Schema.TaggedStruct("A", { f: Filter });
      const holder = Schema.Struct({
        held: Schema.OptionFromNullOr(tagged),
        other,
      });
      const list = Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Array(Filter)),
        other,
      });
      const nested = Schema.Struct({
        held: Schema.OptionFromNullOr(
          Schema.Struct({ inner: Schema.OptionFromNullOr(Filter) }),
        ),
        other,
      });
      for (const [read, path] of [
        [
          json(holder, {
            ...input,
            held: Option.some({ _tag: "A" as const, f: wide }),
          }),
          '["held"]["value"]["f"]["limit"]',
        ],
        [
          json(list, { ...input, held: Option.some([wide]) }),
          '["held"]["value"][0]["limit"]',
        ],
        [
          json(nested, {
            ...input,
            held: Option.some({ inner: Option.some(wide) }),
          }),
          '["held"]["value"]["inner"]["value"]["limit"]',
        ],
      ] as const) {
        expect((yield* Effect.flip(read)).message).toContain(path);
      }
    }),
);

it.effect(
  "ignores names exclusive to a payload member ruled out by a literal tag",
  () =>
    Effect.gen(function* () {
      const held = Schema.OptionFromNullOr(
        Schema.Union([
          Schema.TaggedStruct("N", Owner.fields),
          Schema.TaggedStruct("W", { limit: Schema.String }),
        ]),
      );
      const schema = Schema.Struct({ held, filter: Filter });
      const value = { _tag: "N" as const, ...owner, limit: "wrong-variant" };
      for (const payload of [value, { ...value, stray: "x" }]) {
        expect(
          yield* json(schema, { held: Option.some(payload), filter }),
        ).toEqual({
          held: { _tag: "N", ...owner },
          filter,
        });
      }
    }),
);

it.effect("checks the written field under either candidate's wire name", () =>
  Effect.gen(function* () {
    const V1 = Schema.Struct({ id: Schema.String, limit: Schema.String });
    const V2 = Schema.Struct({ ...V1.fields, cursor: Schema.String }).pipe(
      Schema.encodeKeys({ limit: "page_size" }),
    );
    for (const payload of [Schema.Union([V1, V2]), Schema.Union([V2, V1])]) {
      const schema = Schema.Struct({ held: Schema.OptionFromNullOr(payload) });
      expect(
        yield* json(schema, {
          held: Option.some({ id: "1", limit: "5", cursor: "c", stray: "x" }),
        }),
      ).toEqual({ held: { id: "1", page_size: "5", cursor: "c" } });
    }
  }),
);

it.effect(
  "allows an undefined wire value where the fallback read still writes strictly",
  () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        held: Schema.OptionFromNullOr(
          Schema.TaggedStruct("A", {
            child: Schema.OptionFromOptionalKey(Schema.Undefined),
          }),
        ),
        other: Schema.Option(Schema.Struct({ x: Schema.String })),
        filter: Filter,
      });
      const result = yield* Inputs.reader(schema)({
        held: Option.some({
          _tag: "A" as const,
          child: Option.some(undefined),
        }),
        other: Option.some({ x: "1", stray: "x" }),
        filter,
      });
      expect(result.lost).toEqual([]);
      expect(result.output.held).toEqual({ _tag: "A", child: undefined });
    }),
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/292
it.effect("keeps schema-written payloads beside an opaque neighbour", () =>
  Effect.gen(function* () {
    const other = Schema.Option(Schema.Struct({ x: Schema.String }));
    const neighbour = Option.some({ x: "x", extra: "e" });
    const output = { other: { _tag: "Some", value: { x: "x" } }, filter };
    const Code = Schema.Struct({ code: Schema.String });
    const Upper = Code.pipe(
      Schema.encodeTo(
        Code,
        SchemaTransformation.transform({
          decode: ({ code }) => ({ code: code.toLowerCase() }),
          encode: ({ code }) => ({ code: code.toUpperCase() }),
        }),
      ),
    );
    const Indexed = Schema.Struct({ a: Schema.String, b: Schema.String }).pipe(
      Schema.encodeKeys({ b: "0" }),
    );
    const Ack = Schema.Struct({
      owner: Schema.String,
      ack: Schema.optionalKey(Schema.Union([Schema.Void, A])),
    });
    const check = <S extends Schema.Top>(
      schema: S,
      value: typeof schema.Type,
      held: unknown,
    ) => {
      const root = Schema.Struct({
        held: Schema.OptionFromNullOr(schema),
        other,
        filter: Filter,
      });
      return Effect.map(
        json(root, { held: Option.some(value), other: neighbour, filter }),
        (body) => expect(body).toEqual({ held, ...output }),
      );
    };
    yield* check(Upper, { code: "abc" }, { code: "ABC" });
    yield* check(Indexed, { a: "1", b: "2" }, { "0": "2", a: "1" });
    for (const ack of [{}, null])
      yield* check(Ack, { owner: "a", ack } as typeof Ack.Type, {
        owner: "a",
        ack: null,
      });
  }),
);

it.effect("lets a record key codec supply wire names on a loose write", () =>
  Effect.gen(function* () {
    const Key = Schema.String.pipe(
      Schema.encodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (key) => key.toLowerCase(),
          encode: (key) => key.toUpperCase(),
        }),
      ),
    );
    const codec = A.pipe(
      Schema.decodeTo(
        AB,
        SchemaTransformation.transform({
          decode: ({ a }) => ({ a, b: "default" }),
          encode: (value) => value,
        }),
      ),
    );
    const schema = Schema.Struct({
      held: Schema.OptionFromNullOr(Schema.Record(Key, Schema.String)),
      codec,
    });
    expect(
      yield* json(schema, {
        held: Option.some({ abc: "1" }),
        codec: { a: "a", b: "b" },
      }),
    ).toEqual({ held: { ABC: "1" }, codec: { a: "a" } });
  }),
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/312
describe("configured and same-payload Option codecs read a Some as the built-in codecs do", () => {
  const configured = [null, undefined].map(
    (onNoneEncoding) => (payload: Schema.Top) =>
      Schema.OptionFromOptionalNullOr(payload as typeof Filter, {
        onNoneEncoding,
      }),
  );
  const TaggedFilter = Schema.Union([
    Schema.TaggedStruct("A", Owner.fields),
    Schema.TaggedStruct("A", Wide.fields),
  ]);
  const wide = { ...owner, limit: "l" };

  it.effect("keeps a stated field beside a stray key at every position", () =>
    Effect.gen(function* () {
      for (const codec of configured) {
        const cases = [
          [codec(Filter), Option.some({ ...wide, stray: "x" }), wide],
          [
            codec(TaggedFilter),
            Option.some({ _tag: "A", ...wide, stray: "x" }),
            { _tag: "A", ...wide },
          ],
          [
            codec(Schema.Array(Filter)),
            Option.some([{ ...wide, stray: "x" }]),
            [wide],
          ],
          [
            Schema.OptionFromNullOr(Schema.Struct({ inner: codec(Filter) })),
            Option.some({ inner: Option.some({ ...wide, stray: "x" }) }),
            { inner: wide },
          ],
        ] as const;
        for (const [held, given, sent] of cases)
          expect(
            yield* json(Schema.Struct({ held, filter: Filter }), {
              held: given,
              filter,
            } as never),
          ).toEqual({ held: sent, filter });
      }
    }),
  );

  it.effect(
    "keeps a stated field between codecs that share their payload",
    () =>
      Effect.gen(function* () {
        const held = Schema.Union([
          Schema.OptionFromNullOr(Filter),
          Schema.OptionFromUndefinedOr(Filter),
        ]);
        expect(
          yield* json(Schema.Struct({ held, filter: Filter }), {
            held: Option.some({ ...wide, stray: "x" }),
            filter,
          }),
        ).toEqual({ held: wide, filter });
        // Payloads of different schemas could be written by either codec, so a stray key refuses.
        const Cursor = Schema.Struct({
          ...Owner.fields,
          cursor: Schema.String,
        });
        const apart = Schema.Union([
          Schema.OptionFromNullOr(Filter),
          Schema.OptionFromUndefinedOr(Schema.Union([Owner, Cursor])),
        ]);
        const failure = yield* Effect.flip(
          json(Schema.Struct({ held: apart, filter: Filter }), {
            held: Option.some({ ...wide, stray: "x" }),
            filter,
          } as never),
        );
        expect(failure.message).toContain('["held"]["value"]["limit"]');
      }),
  );

  it.effect(
    "keeps an optional-key codec beside one with the same payload",
    () =>
      Effect.gen(function* () {
        for (const optional of [
          Schema.OptionFromOptionalKey(TaggedFilter),
          Schema.OptionFromOptional(TaggedFilter),
        ])
          expect(
            yield* json(
              Schema.Struct({
                held: Schema.Union([
                  Schema.OptionFromNullOr(TaggedFilter),
                  optional,
                ]),
                filter: Filter,
              }),
              {
                held: Option.some({ _tag: "A", ...wide, stray: "x" }),
                filter,
              } as never,
            ),
          ).toEqual({ held: { _tag: "A", ...wide }, filter });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/312
  it.effect(
    "leaves a payload with its own encoding opaque beside OptionFromOptionalKey",
    () =>
      Effect.gen(function* () {
        const P = Schema.Struct({ f: Filter }).pipe(
          Schema.encodeKeys({ f: "F" }),
        );
        const held = Schema.Union([
          Schema.OptionFromNullOr(P),
          Schema.OptionFromOptionalKey(P),
        ]);
        const failure = yield* Effect.flip(
          json(Schema.Struct({ held, filter: Filter }), {
            held: Option.some({ f: wide, stray: "x" }),
            filter,
          } as never),
        );
        expect(failure.message).toContain('["held"]["value"]["f"]["limit"]');
      }),
  );

  it.effect("checks a cleaned payload's write as the built-in codecs do", () =>
    Effect.gen(function* () {
      const Payload = Schema.Struct({
        ...Owner.fields,
        limit: Schema.optionalKey(Schema.String),
      }).check(
        Schema.makeFilter((value) => {
          // Simulate a schema callback that changes the parsed copy before the writer sees it.
          Reflect.deleteProperty(value, "limit");
          return true;
        }),
      );
      for (const held of [
        ...configured.map((codec) => codec(Payload)),
        Schema.Union([
          configured[0]!(Payload),
          Schema.OptionFromUndefinedOr(Payload),
        ]),
      ]) {
        const failure = yield* Effect.flip(
          json(Schema.Struct({ held, filter: Filter }), {
            held: Option.some({ ...owner, limit: "l", stray: "x" }),
            filter,
          } as never),
        );
        expect(failure.message).toContain('["held"]["value"]["limit"]');
      }
    }),
  );

  it.effect("leaves out an unstated key as OptionFromNullOr does", () =>
    Effect.gen(function* () {
      const payload = Schema.Union([
        Schema.Struct({ value: A }),
        Schema.Struct({ c: Schema.String }),
      ]);
      const value = { a: "inner" };
      for (const held of [
        Schema.OptionFromNullOr(payload),
        ...configured.map((codec) => codec(payload)),
        // Competing codecs with one payload schema write a Some the same way.
        Schema.Union([
          Schema.OptionFromNullOr(payload),
          Schema.OptionFromUndefinedOr(payload),
        ]),
      ])
        for (const given of [
          { value, a: "outer" },
          { value, stray: "x" },
          { value },
        ])
          expect(
            yield* json(Schema.Struct({ held }), {
              held: Option.some(given),
            } as never),
          ).toEqual({ held: { value } });
      // Members whose codecs share the payload schema read the Some the same way too.
      const plain = Schema.OptionFromNullOr(payload);
      const members = Schema.Union([
        Schema.Struct({ held: plain, a: Schema.String }),
        Schema.Struct({
          held: Schema.OptionFromNullOr(payload),
          b: Schema.String,
        }),
      ]);
      for (const given of [
        { value, a: "outer" },
        { value, stray: "x" },
      ])
        expect(
          yield* json(members, { held: Option.some(given), a: "a" } as never),
        ).toEqual({ held: { value }, a: "a" });
    }),
  );
});

// Preparation cannot tell what these encoders write, so it leaves no key out of their Somes.
const fromNull = <S extends Schema.Top>(
  payload: S,
  encode: (value: Option.Option<S["Type"]>) => S["Type"] | null = (value) =>
    Option.getOrElse(value, () => null),
) =>
  Schema.NullOr(payload).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(payload)),
      SchemaTransformation.transform<
        Option.Option<S["Type"]>,
        S["Type"] | null
      >({ decode: Option.fromNullOr, encode }),
    ),
  );
const fromUndefined = <S extends Schema.Top>(payload: S) =>
  Schema.UndefinedOr(payload).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(payload)),
      SchemaTransformation.transform<
        Option.Option<S["Type"]>,
        S["Type"] | undefined
      >({
        decode: Option.fromUndefinedOr,
        encode: (value) => Option.getOrElse(value, () => undefined),
      }),
    ),
  );

/** A hand-written codec that can omit its key, as OptionFromOptional's encoder does. */
const optionalKey = <S extends Schema.Top>(
  payload: S,
  encode: (
    value: Option.Option<Option.Option<S["Type"]>>,
  ) => Option.Option<S["Type"]> = (value) =>
    Option.flatMap(value, (some) => some),
) =>
  Schema.optional(payload).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(payload)),
      SchemaTransformation.transformOptional<
        Option.Option<S["Type"]>,
        S["Type"]
      >({
        decode: (value) =>
          Option.some(Option.flatMap(value, Option.fromUndefinedOr)),
        encode,
      }),
    ),
  );

/** A `held` Some holding `inner` in a Some of its own. */
const inSome = (inner: object) =>
  ({ held: Option.some({ inner: Option.some(inner) }) }) as never;

// https://github.com/viell-dev/slop-effect-schema-http/issues/334
describe("a codec whose payload preparation cannot find on the wire keeps or refuses its payload's fields", () => {
  const TaggedOwner = Schema.TaggedStruct("A", Owner.fields);
  const TaggedWide = Schema.TaggedStruct("A", Wide.fields);
  const Tagged = Schema.Union([TaggedOwner, TaggedWide]);
  const wide = { ...owner, limit: "l" };
  const withStray = { ...wide, stray: "x" };
  const ownerOnly = (value: typeof Owner.Type) => ({ owner: value.owner });

  type Codec = Schema.Codec<unknown, unknown>;
  type Fields = Readonly<Record<string, Codec>>;
  interface Position {
    readonly held: Codec;
    readonly give: (payload: object) => unknown;
    readonly sent: (payload: object) => unknown;
    readonly limit: string;
  }
  /** A same-tag union, a list of unions, and a union inside another Some, each held by a codec. */
  const positions = (held: {
    readonly tagged: Codec;
    readonly list: Codec;
    readonly inner: Codec;
  }): ReadonlyArray<Position> => [
    {
      held: held.tagged,
      give: (payload) => Option.some({ _tag: "A", ...payload }),
      sent: (payload) => ({ _tag: "A", ...payload }),
      limit: '["held"]["value"]["limit"]',
    },
    {
      held: held.list,
      give: (payload) => Option.some([payload]),
      sent: (payload) => [payload],
      limit: '["held"]["value"][0]["limit"]',
    },
    {
      held: Schema.OptionFromNullOr(Schema.Struct({ inner: held.inner })),
      give: (payload) => Option.some({ inner: Option.some(payload) }),
      sent: (payload) => ({ inner: payload }),
      limit: '["held"]["value"]["inner"]["value"]["limit"]',
    },
  ];
  const through = (
    codec: (payload: Codec) => Codec,
    {
      wideFirst = false,
      wideFields = Wide.fields,
    }: {
      readonly wideFirst?: boolean;
      /** The fields of the member that states `limit`. */
      readonly wideFields?: Fields;
    } = {},
  ) => {
    const order = <A, B>(narrow: A, wider: B) =>
      wideFirst ? ([wider, narrow] as const) : ([narrow, wider] as const);
    const choice = Schema.Union(order(Owner, Schema.Struct(wideFields)));
    return positions({
      tagged: codec(
        Schema.Union(order(TaggedOwner, Schema.TaggedStruct("A", wideFields))),
      ),
      list: codec(Schema.Array(choice)),
      inner: codec(choice),
    });
  };
  // Preparation cannot find the payload of a built-in codec behind middleware on the wire, as it
  // cannot find a hand-written one's, including one that can omit its key.
  const codecs = [fromNull, fromUndefined, caught, optionalKey] as const;
  const send = ({ held, give }: Position, payload: object) =>
    json(Schema.Struct({ held }), { held: give(payload) } as never);
  /** A same-tag Some holding a stray key beside `limit` and the given fields. */
  const strayTagged = (fields: object) => ({
    held: Option.some({ _tag: "A", ...withStray, ...fields }),
  });

  it.effect(
    "refuses a stated field a stray key costs, as a direct union does",
    () =>
      Effect.gen(function* () {
        for (const codec of codecs) {
          for (const position of through(codec)) {
            const failure = yield* Effect.flip(send(position, withStray));
            expect(failure.message).toContain(position.limit);
            // The stray key is left out, as a key no member states.
            expect(failure.message).not.toContain("stray");
          }
          const direct = yield* Effect.flip(
            json(Schema.Struct({ held: codec(Filter) }), {
              held: Option.some(withStray),
            } as never),
          );
          expect(direct.message).toContain('["held"]["value"]["limit"]');
        }
      }),
  );

  // Nothing in the codec's own Some has to be unstated: the relaxed read is checked wherever it
  // follows a failed strict attempt, as it is for OptionFromNullOr.
  it.effect(
    "refuses a stated field the read lost whatever made the strict attempt fail",
    () =>
      Effect.gen(function* () {
        const defaulted = Schema.String.pipe(
          Schema.withConstructorDefault(Effect.succeed("d")),
        );
        const triggers = [
          // A stray key only in a sibling Schema.Option.
          {
            wideFields: Wide.fields,
            given: wide,
            o: Option.some({ ...owner, zz: "z" }),
          },
          // A value the wider member refuses.
          {
            wideFields: { ...Owner.fields, limit: Schema.Number },
            given: { ...owner, limit: "not a number" },
            o: Option.none(),
          },
          // A field the wider member defaults only on construction, left out.
          {
            wideFields: { ...Wide.fields, extra: defaulted },
            given: wide,
            o: Option.none(),
          },
        ];
        for (const codec of [...codecs, Schema.OptionFromNullOr])
          for (const { wideFields, given, o } of triggers)
            for (const position of through(codec, { wideFields })) {
              const failure = yield* Effect.flip(
                json(
                  Schema.Struct({
                    held: position.held,
                    o: Schema.Option(Owner),
                  }),
                  { held: position.give(given), o } as never,
                ),
              );
              expect(failure.message).toContain(position.limit);
            }
      }),
  );

  it.effect("keeps every stated field the read keeps", () =>
    Effect.gen(function* () {
      for (const codec of codecs) {
        for (const position of through(codec)) {
          expect(yield* send(position, wide)).toEqual({
            held: position.sent(wide),
          });
          expect(yield* send(position, { ...owner, stray: "x" })).toEqual({
            held: position.sent(owner),
          });
        }
        // With the wider member first, the read keeps `limit` and leaves out only the stray key,
        // in the codec's own Some or in a sibling's.
        for (const position of through(codec, { wideFirst: true })) {
          expect(yield* send(position, withStray)).toEqual({
            held: position.sent(wide),
          });
          expect(
            yield* json(
              Schema.Struct({ held: position.held, o: Schema.Option(Owner) }),
              {
                held: position.give(wide),
                o: Option.some({ ...owner, zz: "z" }),
              } as never,
            ),
          ).toEqual({
            held: position.sent(wide),
            o: { _tag: "Some", value: owner },
          });
        }
      }
    }),
  );

  // The JSON codec gives a payload with a JSON form of its own, such as a Date or a BigInt, and a
  // suspended payload, a schema of their own on the wire, where preparation cannot find the payload
  // as it finds it for the built-in codec. So nothing leaves a key out of that Some either.
  it.effect(
    "reads the JSON codec of a built-in codec that rebuilds its payload as it reads a hand-written one",
    () =>
      Effect.gen(function* () {
        const when = new Date(0);
        const dated = { given: { when }, sent: { when: when.toISOString() } };
        const payloads = (
          wideFirst: boolean,
        ): ReadonlyArray<{
          readonly schema: Codec;
          readonly given: object;
          readonly sent: object;
        }> => {
          const union = (extra: Fields) => {
            const members = [
              Schema.TaggedStruct("A", { ...Owner.fields, ...extra }),
              Schema.TaggedStruct("A", { ...Wide.fields, ...extra }),
            ] as const;
            return Schema.Union(wideFirst ? [members[1], members[0]] : members);
          };
          const Dated = union({ when: Schema.Date });
          const Counted = union({ count: Schema.BigInt });
          const Suspended = Schema.suspend(() => union({}));
          return [
            {
              schema: Schema.Struct({
                held: Schema.toCodecJson(Schema.OptionFromNullOr(Dated)),
              }),
              ...dated,
            },
            {
              schema: Schema.Struct({
                held: Schema.toCodecJson(
                  Schema.OptionFromOptionalNullOr(Dated, {
                    onNoneEncoding: null,
                  }),
                ),
              }),
              ...dated,
            },
            {
              schema: Schema.toCodecJson(
                Schema.Struct({ held: Schema.OptionFromNullOr(Dated) }),
              ),
              ...dated,
            },
            {
              schema: Schema.Struct({
                held: Schema.toCodecJson(Schema.OptionFromNullOr(Counted)),
              }),
              given: { count: 5n },
              sent: { count: "5" },
            },
            {
              schema: Schema.Struct({
                held: Schema.toCodecJson(Schema.OptionFromNullOr(Suspended)),
              }),
              given: {},
              sent: {},
            },
          ];
        };
        for (const { schema, given } of payloads(false)) {
          const failure = yield* Effect.flip(
            json(schema, strayTagged(given) as never),
          );
          expect(failure.message).toContain('["held"]["value"]["limit"]');
          expect(failure.message).not.toContain("stray");
        }
        for (const { schema, given, sent } of payloads(true))
          expect(yield* json(schema, strayTagged(given) as never)).toEqual({
            held: { _tag: "A", ...wide, ...sent },
          });
        // The built-in codec itself leaves the stray key out and keeps `limit`.
        const Dated = Schema.Union([
          Schema.TaggedStruct("A", { ...Owner.fields, when: Schema.Date }),
          Schema.TaggedStruct("A", { ...Wide.fields, when: Schema.Date }),
        ]);
        expect(
          yield* json(
            Schema.Struct({ held: Schema.OptionFromNullOr(Dated) }),
            strayTagged(dated.given) as never,
          ),
        ).toEqual({ held: { _tag: "A", ...wide, ...dated.sent } });
      }),
  );

  it.effect(
    "lets a narrowing encoder write what it writes and refuses what the read lost",
    () =>
      Effect.gen(function* () {
        const narrowing = positions({
          tagged: fromNull(
            Tagged,
            Option.match({
              onNone: () => null,
              onSome: (value) => ({ _tag: value._tag, owner: value.owner }),
            }),
          ),
          list: fromNull(
            Schema.Array(Filter),
            Option.match({
              onNone: () => null,
              onSome: (items) => items.map(ownerOnly),
            }),
          ),
          inner: fromNull(
            Filter,
            Option.match({ onNone: () => null, onSome: ownerOnly }),
          ),
        });
        for (const position of narrowing) {
          expect(yield* send(position, wide)).toEqual({
            held: position.sent(owner),
          });
          const failure = yield* Effect.flip(send(position, withStray));
          expect(failure.message).toContain(position.limit);
        }
        // A direct union, which already refused, gives the same results.
        const direct = Schema.Struct({
          held: fromNull(
            Filter,
            Option.match({ onNone: () => null, onSome: ownerOnly }),
          ),
        });
        expect(yield* json(direct, { held: Option.some(wide) })).toEqual({
          held: owner,
        });
        const failure = yield* Effect.flip(
          json(direct, { held: Option.some(withStray) } as never),
        );
        expect(failure.message).toContain('["held"]["value"]["limit"]');
        // An encoder that can omit the key narrows in the same way.
        const omitting = positions({
          tagged: optionalKey(Tagged, (value) =>
            Option.map(Option.flatten(value), (some) => ({
              _tag: some._tag,
              owner: some.owner,
            })),
          ),
          list: optionalKey(Schema.Array(Filter), (value) =>
            Option.map(Option.flatten(value), (items) => items.map(ownerOnly)),
          ),
          inner: optionalKey(Filter, (value) =>
            Option.map(Option.flatten(value), ownerOnly),
          ),
        });
        for (const position of omitting) {
          expect(yield* send(position, wide)).toEqual({
            held: position.sent(owner),
          });
          const refused = yield* Effect.flip(send(position, withStray));
          expect(refused.message).toContain(position.limit);
        }
      }),
  );

  // A sibling whose encoder adds a key its wire struct does not state fails the strict write of a
  // value the strict read kept whole, so the value is written loosely.
  const extra = { extra: "e" };
  const Adds = Schema.Struct({ a: Schema.String }).pipe(
    Schema.encodeTo(
      Schema.Struct({ a: Schema.String }),
      SchemaTransformation.transform({
        decode: (value) => value,
        encode: (value) => ({ ...value, ...extra }),
      }),
    ),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/364
  it.effect(
    "keeps what the read kept when a sibling's strict write fails",
    () =>
      Effect.gen(function* () {
        for (const codec of codecs)
          for (const position of through(codec))
            expect(
              yield* json(Schema.Struct({ held: position.held, s: Adds }), {
                held: position.give(wide),
                s: { a: "a" },
              } as never),
            ).toEqual({ held: position.sent(wide), s: { a: "a" } });
      }),
  );

  /** A codec the loose writer does not follow: its encoder is effectful. */
  const effectful = (payload: Codec) =>
    Schema.NullOr(payload).pipe(
      Schema.decodeTo(
        Schema.Option(Schema.toType(payload)),
        new SchemaTransformation.Transformation(
          SchemaGetter.transform<Option.Option<unknown>, unknown>(
            Option.fromNullOr,
          ),
          SchemaGetter.transformEffect<unknown, Option.Option<unknown>>(
            (value) => Effect.succeed(Option.getOrElse(value, () => null)),
          ),
        ),
      ),
    );
  const Numbered = Schema.Union([
    Owner,
    Schema.Struct({ owner: Schema.String, limit: Schema.Number }),
  ]);
  const numbered = { ...owner, limit: 7 };
  /** A codec the loose writer does not follow into its payload, given a Some holding `limit`. */
  interface NotFollowed {
    readonly held: Codec;
    readonly given: unknown;
    readonly whole: unknown;
    readonly narrowed: unknown;
    readonly limit: string;
  }
  const notFollowed: ReadonlyArray<NotFollowed> = [
    ...through(effectful).map((position) => ({
      held: position.held,
      given: position.give(wide),
      whole: position.sent(wide),
      narrowed: position.sent(owner),
      limit: position.limit,
    })),
    // `Body.jsonSchema` applies the JSON codec first, which rebuilds a payload holding a `Number`
    // field, or a codec that writes `undefined`, so the writer no longer finds the payload the
    // hand-written codec was built over.
    {
      held: fromNull(Numbered),
      given: Option.some(numbered),
      whole: numbered,
      narrowed: owner,
      limit: '["held"]["value"]["limit"]',
    },
    {
      held: optionalKey(Numbered),
      given: Option.some(numbered),
      whole: numbered,
      narrowed: owner,
      limit: '["held"]["value"]["limit"]',
    },
    {
      held: fromNull(
        Schema.Struct({ inner: Schema.OptionFromOptional(Filter) }),
      ),
      given: Option.some({ inner: Option.some(wide) }),
      whole: { inner: wide },
      narrowed: { inner: owner },
      limit: '["held"]["value"]["inner"]["value"]["limit"]',
    },
  ];
  const besideAdds = ({ held, given }: NotFollowed) =>
    json(Schema.Struct({ held, s: Adds }), {
      held: given,
      s: { a: "a" },
    } as never);

  // https://github.com/viell-dev/slop-effect-schema-http/issues/364
  it.effect(
    "refuses a stated field a stray key costs through a codec the writer does not follow",
    () =>
      Effect.gen(function* () {
        // What its encoder writes plays no part in the check, so the codec need not be followed.
        for (const position of through(effectful)) {
          const failure = yield* Effect.flip(send(position, withStray));
          expect(failure.message).toContain(position.limit);
          expect(failure.message).not.toContain("stray");
          expect(yield* send(position, wide)).toEqual({
            held: position.sent(wide),
          });
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/378
  it.effect(
    "currently loses what the read kept through a codec the writer does not follow when a sibling's strict write fails",
    () =>
      Effect.gen(function* () {
        for (const row of notFollowed)
          expect(yield* besideAdds(row)).toEqual({
            held: row.narrowed,
            s: { a: "a" },
          });
        // Without the failing sibling, the strict write keeps `limit`.
        for (const { held, given, whole } of notFollowed)
          expect(
            yield* json(Schema.Struct({ held }), { held: given } as never),
          ).toEqual({ held: whole });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/378
  it.effect.fails(
    "keeps or refuses what the read kept through a codec the writer does not follow when a sibling's strict write fails",
    () =>
      Effect.gen(function* () {
        for (const row of notFollowed)
          yield* Effect.match(besideAdds(row), {
            onSuccess: (body) =>
              expect(body).toEqual({ held: row.whole, s: { a: "a" } }),
            onFailure: (failure) =>
              expect(failure.message).toContain(row.limit),
          });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/379
  it.effect(
    "currently loses a stated field through a codec that writes its payload as text",
    () =>
      Effect.gen(function* () {
        const asText = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Option(Schema.toType(Tagged)),
            SchemaTransformation.transform<
              Option.Option<typeof Tagged.Type>,
              string
            >({
              decode: (text) =>
                text === ""
                  ? Option.none()
                  : Option.some(JSON.parse(text) as typeof Tagged.Type),
              encode: (value) =>
                Option.match(value, {
                  onNone: () => "",
                  onSome: (some) => JSON.stringify(some),
                }),
            }),
          ),
        );
        expect(
          yield* json(Schema.Struct({ held: asText }), {
            held: Option.some({ _tag: "A" as const, ...wide }),
          }),
        ).toEqual({ held: JSON.stringify({ _tag: "A", ...owner }) });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/380
  it.effect(
    "currently names a given field where a codec that can omit its key has its own field renamed",
    () =>
      Effect.gen(function* () {
        for (const codec of [Schema.OptionFromOptional, optionalKey]) {
          const schema = Schema.Struct({
            held: codec(Wide),
            n: Schema.String,
          }).pipe(Schema.encodeKeys({ held: "h" }));
          const failure = yield* Effect.flip(
            json(schema, { held: Option.some(owner), n: "n" } as never),
          );
          expect(failure.message).toContain('["held"]["value"]["owner"]');
          expect(failure.message).not.toContain("Missing key");
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/380
  it.effect.fails(
    "names the missing field where a codec that can omit its key has its own field renamed",
    () =>
      Effect.gen(function* () {
        for (const codec of [Schema.OptionFromOptional, optionalKey]) {
          const schema = Schema.Struct({
            held: codec(Wide),
            n: Schema.String,
          }).pipe(Schema.encodeKeys({ held: "h" }));
          const failure = yield* Effect.flip(
            json(schema, { held: Option.some(owner), n: "n" } as never),
          );
          expect(failure.message).toContain("Missing key");
          expect(failure.message).toContain('["held"]["value"]["limit"]');
          expect(failure.message).not.toContain('["held"]["value"]["owner"]');
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/364
  it.effect(
    "refuses through a renamed struct holding a codec that can omit its key",
    () =>
      Effect.gen(function* () {
        const held = optionalKey(Tagged);
        const renamed = [
          [
            Schema.Struct({ held, n: Schema.String }).pipe(
              Schema.encodeKeys({ held: "h" }),
            ),
            (sent: object) => ({ h: sent, n: "n" }),
          ],
          [
            Schema.Struct({ held, n: Schema.String }).pipe(
              Schema.encodeKeys({ n: "wire_n" }),
            ),
            (sent: object) => ({ held: sent, wire_n: "n" }),
          ],
        ] as const;
        for (const [schema, sent] of renamed) {
          const failure = yield* Effect.flip(
            json(schema, {
              held: Option.some({ _tag: "A", ...withStray }),
              n: "n",
            } as never),
          );
          expect(failure.message).toContain('["held"]["value"]["limit"]');
          expect(
            yield* json(schema, {
              held: Option.some({ _tag: "A", ...wide }),
              n: "n",
            } as never),
          ).toEqual(sent({ _tag: "A", ...wide }));
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/364
  it.effect(
    "reads the other fields of a renamed struct holding a codec that can omit its key as beside the built-in one",
    () =>
      Effect.gen(function* () {
        const other = Option.some({ owner: "b", limit: "m", stray: "x" });
        const sentOther = { owner: "b", limit: "m" };
        for (const codec of [optionalKey, Schema.OptionFromOptional]) {
          const holding = (payload: Codec) =>
            Schema.Struct({
              held: codec(payload),
              other: Schema.OptionFromNullOr(Filter),
              n: Schema.String,
            }).pipe(Schema.encodeKeys({ n: "wire_n" }));
          // The struct is a frame, so the built-in sibling leaves its stray key out and keeps
          // `limit`, as it does with no `held` beside it.
          expect(
            yield* json(holding(Filter), {
              held: Option.none(),
              other,
              n: "n",
            } as never),
          ).toEqual({ other: sentOther, wire_n: "n" });
          // Inside an Option, Void is the schema's own and takes the payload first, as Effect's
          // own encoding does: `null` with or without the sibling's stray key.
          const voidFirst = holding(Schema.Union([Schema.Void, Wide]));
          for (const given of [other, Option.some(sentOther)])
            expect(
              yield* json(voidFirst, {
                held: Option.some(wide),
                other: given,
                n: "n",
              } as never),
            ).toEqual({ held: null, other: sentOther, wire_n: "n" });
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/364
  it.effect(
    "refuses a field the read loses through a codec that writes none of its payload",
    () =>
      Effect.gen(function* () {
        // A presence flag: its encoder writes whether there is a Some, never what the Some holds.
        // The read is compared, never what the codec writes, as for an encoder that narrows.
        const Flag = Schema.Boolean.pipe(
          Schema.decodeTo(
            Schema.Option(Schema.toType(Filter)),
            SchemaTransformation.transform<
              Option.Option<typeof Filter.Type>,
              boolean
            >({
              decode: (flag) => (flag ? Option.some(owner) : Option.none()),
              encode: Option.isSome,
            }),
          ),
        );
        const schema = Schema.Struct({ held: Flag, n: Schema.String }).pipe(
          Schema.encodeKeys({ n: "wire_n" }),
        );
        const failure = yield* Effect.flip(
          json(schema, { held: Option.some(withStray), n: "n" } as never),
        );
        expect(failure.message).toContain('["held"]["value"]["limit"]');
        expect(failure.message).not.toContain("stray");
        for (const given of [wide, { ...owner, stray: "x" }])
          expect(
            yield* json(schema, { held: Option.some(given), n: "n" } as never),
          ).toEqual({ held: true, wire_n: "n" });
      }),
  );

  /** `held` beside `Adds`: a built-in codec's Some holding `inner`, written loosely. */
  const besideAddsIn = (codec: Codec, given: unknown) => ({
    schema: Schema.Struct({
      held: Schema.OptionFromNullOr(Schema.Struct({ inner: codec })),
      s: Adds,
    }),
    given: { held: Option.some({ inner: given }), s: { a: "a" } },
  });
  /** The same with a renamed sibling of `inner`. */
  const besideAddsInRenamed = (codec: Codec, given: unknown) => ({
    schema: Schema.Struct({
      held: Schema.OptionFromNullOr(
        Schema.Struct({ inner: codec, n: Schema.String }).pipe(
          Schema.encodeKeys({ n: "wire_n" }),
        ),
      ),
      s: Adds,
    }),
    given: { held: Option.some({ inner: given, n: "n" }), s: { a: "a" } },
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/386
  it.effect(
    "sends what a codec that can omit its key writes inside a Some written loosely",
    () =>
      Effect.gen(function* () {
        // Inside a built-in codec's Some, the loose write is compared with what the read kept, but
        // what a codec without a source writes is its own, including leaving its key out.
        const writesNothing = optionalKey(Filter, () => Option.none());
        const cases = [
          [besideAddsIn(optionalKey(Filter), Option.none()), {}],
          [besideAddsIn(writesNothing, Option.some(wide)), {}],
          [besideAddsIn(Schema.OptionFromOptional(Filter), Option.none()), {}],
          [
            besideAddsInRenamed(optionalKey(Filter), Option.none()),
            { wire_n: "n" },
          ],
          [
            besideAddsInRenamed(writesNothing, Option.some(wide)),
            { wire_n: "n" },
          ],
        ] as const;
        for (const [{ schema, given }, held] of cases)
          expect(yield* json(schema, given as never)).toEqual({
            held,
            s: { a: "a" },
          });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/385
  it.effect(
    "currently runs a payload member's encoder four times through a followed codec when its strict write fails",
    () =>
      Effect.gen(function* () {
        let runs = 0;
        const more = { more: "m" };
        // Its encoder adds a key its wire struct does not state, so its strict write fails.
        const Member = Schema.Struct({ owner: Schema.String }).pipe(
          Schema.encodeTo(
            Schema.Struct({ owner: Schema.String }),
            new SchemaTransformation.Transformation(
              SchemaGetter.transform<typeof Owner.Type, typeof Owner.Type>(
                (value) => value,
              ),
              SchemaGetter.transformEffect<
                typeof Owner.Type,
                typeof Owner.Type
              >((value) =>
                Effect.sync(() => {
                  runs += 1;
                  return { ...value, ...more };
                }),
              ),
            ),
          ),
        );
        const payload = Schema.Union([Member, Wide]);
        // The writer follows a codec that can omit its key, so it runs the encoder as often as the
        // other followed codecs and a plain field do.
        for (const held of [
          optionalKey(payload),
          fromNull(payload),
          Schema.OptionFromOptional(payload),
          Schema.OptionFromNullOr(payload),
        ]) {
          runs = 0;
          expect(
            yield* json(Schema.Struct({ held }), {
              held: Option.some(owner),
            } as never),
          ).toEqual({ held: owner });
          expect(runs).toBe(4);
        }
        runs = 0;
        expect(
          yield* json(Schema.Struct({ held: payload }), {
            held: owner,
          } as never),
        ).toEqual({ held: owner });
        expect(runs).toBe(4);
      }),
  );

  const direct = Schema.Struct({ held: fromNull(Filter) });
  const lone = { held: Option.some({ ...owner, stray: "x" }) } as never;

  // https://github.com/viell-dev/slop-effect-schema-http/issues/346
  it.effect("currently refuses a lone stray key beside a direct union", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(json(direct, lone));
      expect(failure.message).toContain('["held"]["value"]["stray"]');
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/346
  it.effect.fails("leaves out a lone stray key beside a direct union", () =>
    Effect.gen(function* () {
      expect(yield* json(direct, lone)).toEqual({ held: owner });
    }),
  );

  /** A codec inside a Some that a hand-written codec reads, over a union, a same-tag union and a list. */
  const insideHandWritten = (
    outer: (payload: Codec) => Codec,
    inner: (payload: Codec) => Codec,
  ): ReadonlyArray<Position> =>
    [
      { payload: Filter, place: (given: object) => given, at: "" },
      {
        payload: Tagged,
        place: (given: object) => ({ _tag: "A", ...given }),
        at: "",
      },
      {
        payload: Schema.Array(Filter),
        place: (given: object) => [given],
        at: "[0]",
      },
    ].map(({ payload, place, at }) => ({
      held: outer(Schema.Struct({ inner: inner(payload) })),
      give: (given) => Option.some({ inner: Option.some(place(given)) }),
      sent: (given) => ({ inner: place(given) }),
      limit: `["held"]["value"]["inner"]["value"]${at}["limit"]`,
    }));
  const outers = [fromNull, optionalKey] as const;
  const inners = [
    Schema.OptionFromNullOr,
    (payload: Codec) =>
      Schema.OptionFromOptionalNullOr(payload, { onNoneEncoding: null }),
    fromNull,
    optionalKey,
  ] as const;
  const nestedPositions = outers.flatMap((outer) =>
    inners.flatMap((inner) => insideHandWritten(outer, inner)),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/347
  it.effect(
    "refuses a stated field a codec inside a hand-written Some loses, whatever made the strict attempt fail",
    () =>
      Effect.gen(function* () {
        // A stray key in the inner Some, or only in a sibling Schema.Option, defeats the strict
        // read, and nothing leaves a key out of a Some a hand-written codec reads.
        const triggers = [
          [withStray, Option.none()],
          [wide, Option.some({ ...owner, zz: "z" })],
        ] as const;
        for (const position of nestedPositions)
          for (const [held, o] of triggers) {
            const failure = yield* Effect.flip(
              json(
                Schema.Struct({ held: position.held, o: Schema.Option(Owner) }),
                { held: position.give(held), o } as never,
              ),
            );
            expect(failure.message).toContain(position.limit);
            expect(failure.message).not.toContain("stray");
          }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/347
  it.effect(
    "keeps every stated field a codec inside a hand-written Some reads",
    () =>
      Effect.gen(function* () {
        for (const position of nestedPositions) {
          expect(yield* send(position, wide)).toEqual({
            held: position.sent(wide),
          });
          expect(yield* send(position, { ...owner, stray: "x" })).toEqual({
            held: position.sent(owner),
          });
        }
        // With the wider member first, the read keeps `limit` and leaves out the stray key.
        for (const outer of outers) {
          const schema = Schema.Struct({
            held: outer(
              Schema.Struct({
                inner: Schema.OptionFromNullOr(Schema.Union([Wide, Owner])),
              }),
            ),
          });
          expect(
            yield* json(schema, {
              held: Option.some({ inner: Option.some(withStray) }),
            } as never),
          ).toEqual({ held: { inner: wide } });
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/347
  it.effect(
    "leaves a Schema.Option inside a hand-written Some to Effect's reading",
    () =>
      Effect.gen(function* () {
        // A codec's decoded side given as a schema of its own reads as Schema.Option does.
        for (const inner of [
          Schema.Option(Filter),
          Schema.toType(Schema.OptionFromNullOr(Filter)),
        ])
          for (const outer of [...outers, Schema.OptionFromNullOr])
            expect(
              yield* json(
                Schema.Struct({ held: outer(Schema.Struct({ inner })) }),
                {
                  held: Option.some({ inner: Option.some(withStray) }),
                } as never,
              ),
            ).toEqual({
              held: { inner: { _tag: "Some", value: owner } },
            });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/347
  it.effect(
    "compares a codec's decoded side beside that codec in a hand-written Some, as the one schema they share",
    () =>
      Effect.gen(function* () {
        // In the decoded payload both fields are the same node, so identity cannot tell them apart.
        const Inner = Schema.OptionFromNullOr(Filter);
        for (const outer of outers) {
          const schema = Schema.Struct({
            held: outer(
              Schema.Struct({ inner: Inner, plain: Schema.toType(Inner) }),
            ),
          });
          const failure = yield* Effect.flip(
            json(schema, {
              held: Option.some({
                inner: Option.some(wide),
                plain: Option.some(withStray),
              }),
            } as never),
          );
          expect(failure.message).toContain(
            '["held"]["value"]["plain"]["value"]["limit"]',
          );
          expect(
            yield* json(schema, {
              held: Option.some({
                inner: Option.some(wide),
                plain: Option.some(wide),
              }),
            } as never),
          ).toEqual({
            held: { inner: wide, plain: { _tag: "Some", value: wide } },
          });
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/347
  it.effect(
    "compares a renamed payload inside a codec in a hand-written Some under its decoded names",
    () =>
      Effect.gen(function* () {
        const Renamed = Wide.pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Struct({
          held: fromNull(
            Schema.Struct({
              inner: Schema.OptionFromNullOr(Schema.Union([Owner, Renamed])),
            }),
          ),
        });
        const failure = yield* Effect.flip(json(schema, inSome(withStray)));
        expect(failure.message).toContain(
          '["held"]["value"]["inner"]["value"]["limit"]',
        );
        expect(yield* json(schema, inSome(wide))).toEqual({
          held: { inner: { ...owner, page_size: "l" } },
        });
        // Its decoded side does not state the wire name, so the read leaves it out, as before.
        expect(
          yield* json(schema, inSome({ ...owner, page_size: "l", stray: "x" })),
        ).toEqual({ held: { inner: owner } });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/347
  it.effect(
    "finds a codec behind a suspension in a hand-written Some, resolving no other suspension",
    () =>
      Effect.gen(function* () {
        let unread = 0;
        const Other = Schema.Struct({
          kind: Schema.Literal("other"),
          x: Schema.suspend(() => {
            unread += 1;
            return Schema.String;
          }),
        });
        const schema = Schema.Struct({
          held: fromNull(
            Schema.Union([
              Schema.Struct({
                inner: Schema.suspend(() => Schema.OptionFromNullOr(Filter)),
              }),
              Other,
            ]),
          ),
        });
        const failure = yield* Effect.flip(
          json(schema, {
            held: Option.some({ inner: Option.some(withStray) }),
          } as never),
        );
        expect(failure.message).toContain(
          '["held"]["value"]["inner"]["value"]["limit"]',
        );
        // The member the value does not take is never resolved, as the read never resolves it.
        expect(unread).toBe(0);
      }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/299
it.effect("refuses wrapper collisions at opaque Option positions", () =>
  Effect.gen(function* () {
    const payload = Schema.Union([
      Schema.Struct({ value: A }),
      Schema.Struct({ c: Schema.String }),
    ]);
    const value = { a: "inner" };
    const held = Option.some({ value, a: "outer" });
    const plain = Schema.OptionFromNullOr(payload);
    // A struct alternative beside the codec can take the Some itself.
    const schema = Schema.Struct({
      held: Schema.Union([plain, Schema.Struct({ z: Schema.String })]),
    });
    const failure = yield* Effect.flip(json(schema, { held }));
    expect(failure.message).toContain('["held"]["value"]["a"]');
    const refused = yield* Effect.flip(
      json(schema, { held: Option.some({ value, stray: "x" }) }),
    );
    expect(refused.message).toContain('["held"]["value"]["stray"]');
    expect(yield* json(schema, { held: Option.some({ value }) })).toEqual({
      held: { value },
    });
  }),
);

it.effect("keeps encoded input at an unwrapping Option position readable", () =>
  Effect.gen(function* () {
    const root = Schema.OptionFromNullOr(Filter);
    const value = { ...owner, limit: "l" };
    const encoded = { ...value, stray: "x" };
    expect(yield* json(root, encoded)).toEqual(value);
  }),
);

it.effect("propagates a defect from the strict attempt on a cleaned Some", () =>
  Effect.gen(function* () {
    const defect = new Error("payload check defect");
    let checks = 0;
    const payload = Owner.check(
      Schema.makeFilter(() => {
        if (++checks === 1) throw defect;
        return true;
      }),
    );
    const schema = Schema.Struct({
      held: Schema.OptionFromNullOr(payload),
      filter: Filter,
    });
    const result = yield* Effect.exit(
      json(schema, { held: Option.some(stray), filter }),
    );
    expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true);
    expect(checks).toBe(1);
  }),
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/305
it.effect(
  "refuses a same-tag payload when no member can keep its stated field",
  () =>
    Effect.gen(function* () {
      const Narrow = Schema.TaggedStruct("A", Owner.fields);
      const NeedsCursor = Schema.TaggedStruct("A", {
        ...Wide.fields,
        cursor: Schema.String,
      });
      const schema = Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Union([Narrow, NeedsCursor])),
      });
      const wide = { _tag: "A" as const, ...owner, limit: "l" };
      for (const payload of [wide, { ...wide, stray: "x" }]) {
        const failure = yield* Effect.flip(
          json(schema, { held: Option.some(payload) }),
        );
        expect(failure.message).toContain('["held"]["value"]["limit"]');
      }
    }),
);

it.effect(
  "checks the payload on either strict attempt after removing a stray key",
  () =>
    Effect.gen(function* () {
      const Payload = Schema.Struct({
        ...Owner.fields,
        limit: Schema.optionalKey(Schema.String),
      }).check(
        Schema.makeFilter((value) => {
          // Simulate a schema callback that changes the parsed copy before the writer sees it.
          Reflect.deleteProperty(value, "limit");
          return true;
        }),
      );
      const root = Schema.Struct({
        held: Schema.OptionFromNullOr(Payload),
        explicit: Schema.optional(Schema.Undefined),
        filter: Filter,
      });
      const input = { held: Option.some({ ...stray, limit: "l" }), filter };
      // The first strict input omits undefined keys. This check requires the second input,
      // which exposes the original field.
      const requiresExplicit = root.check(
        Schema.makeFilter((value) => Object.hasOwn(value, "explicit")),
      );
      for (const attempt of [
        json(root, input),
        json(requiresExplicit, { ...input, explicit: undefined }),
      ]) {
        const failure = yield* Effect.flip(attempt);
        expect(failure.message).toContain('["held"]["value"]["limit"]');
      }
    }),
);

it.effect(
  "keeps struct reading when the caller supplies a Some as the object",
  () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ value: Filter });
      const value = Option.some({ ...stray, limit: "l" });
      if (!Option.isSome(value)) throw new Error("expected Some");
      expect(yield* json(schema, value)).toEqual({
        value: { ...owner, limit: "l" },
      });
    }),
);

// https://github.com/viell-dev/slop-effect-schema-http/issues/309
describe("an invalid Some payload keeps its decoded error", () => {
  const payload = Schema.Struct({
    a: Schema.optionalKey(Schema.String),
    b: Schema.optionalKey(Schema.String),
  });

  it.effect("names the invalid field through each Option codec", () =>
    Effect.gen(function* () {
      for (const held of [
        Schema.OptionFromNullOr(payload),
        Schema.OptionFromUndefinedOr(payload),
        Schema.OptionFromNullishOr(payload),
        Schema.OptionFromOptionalKey(payload),
        Schema.OptionFromOptional(payload),
        Schema.OptionFromOptionalNullOr(payload),
        Schema.OptionFromOptionalNullOr(payload, { onNoneEncoding: "omit" }),
        Schema.OptionFromOptionalNullOr(payload, { onNoneEncoding: null }),
        Schema.OptionFromOptionalNullOr(payload, { onNoneEncoding: undefined }),
        Schema.Option(payload),
        Schema.toCodecJson(Schema.Option(payload)),
      ]) {
        const schema = Schema.Struct({ held });
        for (const invalid of [{ a: 5 }, { a: 5, b: "keep" }]) {
          const failure = yield* Effect.flip(
            json(schema, { held: Option.some(invalid) } as never),
          );
          expect(failure.message).toContain('["held"]["value"]["a"]');
        }
      }
    }),
  );

  it.effect("names the field through a list and either union order", () =>
    Effect.gen(function* () {
      const choice = Schema.OptionFromNullOr(payload);
      for (const held of [
        Schema.Union([choice, Schema.String]),
        Schema.Union([Schema.String, choice]),
      ]) {
        const schema = Schema.Struct({ rows: Schema.Array(held) });
        const failure = yield* Effect.flip(
          json(schema, { rows: [Option.some({ a: 5, b: "keep" })] } as never),
        );
        expect(failure.message).toContain('["rows"][0]["value"]["a"]');
        expect(
          yield* json(schema, { rows: [Option.some({ a: "a", b: "keep" })] }),
        ).toEqual({ rows: [{ a: "a", b: "keep" }] });
      }
    }),
  );

  const renamed = Schema.Struct({
    held: Schema.OptionFromNullOr(payload),
  }).pipe(Schema.encodeKeys({ held: "wire_held" }));

  // https://github.com/viell-dev/slop-effect-schema-http/issues/321
  it.effect("refuses a wrapper given under a renamed key", () =>
    Effect.gen(function* () {
      const record = Schema.Struct({
        held: Schema.OptionFromNullOr(
          Schema.Record(Schema.String, Schema.Number),
        ),
      }).pipe(Schema.encodeKeys({ held: "wire_held" }));
      for (const [schema, wire_held] of [
        [renamed, Option.some({ a: 5, b: "keep" })],
        [renamed, Option.some({ a: "a", b: "keep" })],
        [renamed, Option.none()],
        [record, Option.some({ a: 1 })],
      ] as const) {
        const failure = yield* Effect.flip(
          json(schema, { wire_held } as never),
        );
        expect(failure).toBeInstanceOf(Schema.SchemaError);
      }
      expect(
        yield* json(renamed, { held: Option.some({ a: "a", b: "keep" }) }),
      ).toEqual({ wire_held: { a: "a", b: "keep" } });
      expect(yield* json(renamed, { held: Option.none() })).toEqual({
        wire_held: null,
      });
      expect(yield* json(renamed, { wire_held: { a: "a" } } as never)).toEqual({
        wire_held: { a: "a" },
      });
      expect(yield* json(renamed, { wire_held: null } as never)).toEqual({
        wire_held: null,
      });
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/321
  it.effect(
    "refuses a wrapper beside a renamed sibling or below a renamed parent",
    () =>
      Effect.gen(function* () {
        const sibling = Schema.Struct({
          held: Schema.OptionFromNullOr(payload),
          n: Schema.String,
        }).pipe(Schema.encodeKeys({ n: "wire_n" }));
        const parent = Schema.Struct({
          row: Schema.Struct({
            held: Schema.OptionFromNullOr(payload),
            m: Schema.String,
          }),
          n: Schema.String,
        }).pipe(Schema.encodeKeys({ n: "wire_n" }));
        for (const [schema, body] of [
          [sibling, { held: Option.none(), wire_n: "3" }],
          [sibling, { held: Option.some({ a: "a", b: "keep" }), wire_n: "3" }],
          [parent, { row: { held: Option.none(), m: "1" }, wire_n: "2" }],
        ] as const) {
          const failure = yield* Effect.flip(json(schema, body as never));
          expect(failure).toBeInstanceOf(Schema.SchemaError);
        }
        // Through a suspension, a nested rename and containers below a renamed ancestor too.
        const held = Schema.OptionFromNullOr(payload);
        const Row = Schema.Struct({ held });
        const RenamedRow = Schema.Struct({ held }).pipe(
          Schema.encodeKeys({ held: "wire_held" }),
        );
        interface Recursive {
          readonly held: Option.Option<typeof payload.Type>;
          readonly next?: Recursive;
        }
        const Recursive: Schema.Codec<Recursive, unknown> = Schema.Struct({
          held,
          next: Schema.optionalKey(Schema.suspend(() => Recursive)),
        });
        class ClassRow extends Schema.Class<ClassRow>("ClassRow")({ held }) {}
        interface RenamedRecursive {
          readonly held: Option.Option<typeof payload.Type>;
          readonly next?: RenamedRecursive;
        }
        const RenamedRecursive: Schema.Codec<RenamedRecursive, unknown> =
          Schema.Struct({
            held,
            next: Schema.optionalKey(Schema.suspend(() => RenamedRecursive)),
          }).pipe(Schema.encodeKeys({ held: "wire_held" }));
        const below = (row: Schema.Top) =>
          Schema.Struct({ row, n: Schema.String }).pipe(
            Schema.encodeKeys({ n: "wire_n" }),
          );
        for (const [schema, row] of [
          [below(Schema.suspend(() => Row)), { held: Option.none() }],
          [
            below(Schema.Struct({ held: Schema.suspend(() => held) })),
            { held: Option.none() },
          ],
          [below(RenamedRow), { wire_held: Option.none() }],
          [
            below(ClassRow.pipe(Schema.encodeKeys({ held: "wire_held" }))),
            { wire_held: Option.some({ a: 5, b: "keep" }) },
          ],
          [
            below(ClassRow.pipe(Schema.encodeKeys({ held: "wire_held" }))),
            { wire_held: Option.none() },
          ],
          [
            below(RenamedRecursive),
            { wire_held: null, next: { wire_held: Option.none() } },
          ],
          [
            below(Recursive),
            { held: Option.some({ a: "a" }), next: { held: Option.none() } },
          ],
          [below(Schema.Array(RenamedRow)), [{ wire_held: Option.none() }]],
          [
            below(Schema.Union([RenamedRow, Schema.String])),
            { wire_held: Option.none() },
          ],
        ] as const) {
          const failure = yield* Effect.flip(
            json(
              schema as unknown as typeof Row,
              { row, wire_n: "x" } as never,
            ),
          );
          expect(failure).toBeInstanceOf(Schema.SchemaError);
        }
        // On the decoded side the wrapper is the field's own value.
        expect(yield* json(sibling, { held: Option.none(), n: "3" })).toEqual({
          held: null,
          wire_n: "3",
        });
        expect(
          yield* json(parent, { row: { held: Option.none(), m: "1" }, n: "2" }),
        ).toEqual({ row: { held: null, m: "1" }, wire_n: "2" });
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/351
  it.effect(
    "names a wrapper the strict pass refuses, without that pass's own error",
    () =>
      Effect.gen(function* () {
        for (const wire of [Schema.Any, Schema.Unknown]) {
          // Only the strict pass reads these: its decoder takes the wrapper as the open wire value,
          // and its constructor, run with `onExcessProperty: "error"`, calls `wire_n` excess.
          const sibling = Schema.Struct({
            held: Schema.OptionFromNullOr(wire),
            n: Schema.String,
          }).pipe(Schema.encodeKeys({ n: "wire_n" }));
          const atWireName = Schema.Struct({
            held: Schema.OptionFromNullOr(wire),
          }).pipe(Schema.encodeKeys({ held: "wire_held" }));
          for (const held of [Option.some({ a: 1 }), Option.none()]) {
            const given = { held, wire_n: "x" };
            for (const [schema, body, path] of [
              [sibling, given, '["held"]'],
              [Schema.Struct({ f: sibling }), { f: given }, '["f"]["held"]'],
              [Schema.Array(sibling), [given], '[0]["held"]'],
              [
                Schema.Record(Schema.String, sibling),
                { r: given },
                '["r"]["held"]',
              ],
              [
                Schema.Union([sibling, Schema.Struct({ z: Schema.String })]),
                given,
                '["held"]',
              ],
              [atWireName, { wire_held: held }, '["wire_held"]'],
            ] as const) {
              const failure = yield* Effect.flip(
                json(schema as typeof sibling, body as never),
              );
              expect(failure.message).toBe(notHeld(path));
            }
            const query = yield* Effect.flip(
              Request.compile(Request.get("/x").pipe(Request.query(sibling)), {
                query: given as never,
              }),
            );
            expect(query.message).toBe(notHeld('["held"]'));
          }
          // Each place a wrapper is given is named.
          const shared = Option.some({ a: 1 });
          const twice = yield* Effect.flip(
            json(
              Schema.Struct({
                held: Schema.OptionFromNullOr(wire),
                other: Schema.OptionFromNullOr(wire),
                n: Schema.String,
              }).pipe(Schema.encodeKeys({ n: "wire_n" })),
              { held: shared, other: shared, wire_n: "x" } as never,
            ),
          );
          expect(twice.message).toBe(
            `${notHeld('["held"]')}\n${notHeld('["other"]')}`,
          );
          // On one side throughout, the value is sent.
          expect(
            yield* json(sibling, { held: Option.some({ a: 1 }), n: "x" }),
          ).toEqual({ held: { a: 1 }, wire_n: "x" });
          expect(
            yield* json(sibling, { held: { a: 1 }, wire_n: "x" } as never),
          ).toEqual({ held: { a: 1 }, wire_n: "x" });
        }
        // Where the encoded side cannot take the wrapper, the request's own reading still names
        // the decoded field the wire name stands for.
        const struct = Schema.Struct({
          held: Schema.OptionFromNullOr(Schema.Struct({ a: Schema.Number })),
          n: Schema.String,
        }).pipe(Schema.encodeKeys({ n: "wire_n" }));
        const failure = yield* Effect.flip(
          json(struct, { held: Option.some({ a: 1 }), wire_n: "x" } as never),
        );
        expect(failure.message).toBe('Missing key\n  at ["n"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/351
  it.effect(
    "names only the wrapper a reader took, though every None is one object",
    () =>
      Effect.gen(function* () {
        // `Option.none()` is one object, but none of these places reads a wrapper as a wire value:
        // Schema.Option keeps its own on both sides, and Schema.Any reads nothing inside.
        const layouts = [
          [
            besideWireN({ other: Schema.Option(Schema.String) }),
            (inner: Option.Option<string>) => ({ other: inner }),
          ],
          [
            besideWireN({ tags: Schema.Array(Schema.Option(Schema.String)) }),
            (inner: Option.Option<string>) => ({
              tags: [inner, Option.some("a"), inner],
            }),
          ],
          [
            besideWireN({ meta: Schema.Any }),
            (inner: Option.Option<string>) => ({ meta: { flag: inner } }),
          ],
          [
            besideWireN({
              other: Schema.Union([
                Schema.OptionFromNullOr(Schema.String),
                Schema.Option(Schema.String),
              ]),
            }),
            (inner: Option.Option<string>) => ({ other: inner }),
          ],
        ] as const;
        for (const [schema, beside] of layouts)
          for (const held of [Option.none(), Option.some({ a: 1 })])
            for (const inner of [Option.none(), Option.some("b")]) {
              const failure = yield* Effect.flip(
                json(
                  schema as never,
                  {
                    held,
                    wire_n: "x",
                    ...beside(inner),
                  } as never,
                ),
              );
              expect(failure.message).toBe(notHeld('["held"]'));
            }
        // Where another reader does take a None as its wire value, that place is named too.
        const twoCodecs = yield* Effect.flip(
          json(
            besideWireN({
              other: Schema.OptionFromNullOr(Schema.Any),
              items: Schema.Array(Schema.OptionFromNullOr(Schema.Any)),
            }),
            {
              held: Option.none(),
              other: Option.none(),
              items: [Option.none()],
              wire_n: "x",
            } as never,
          ),
        );
        expect(twoCodecs.message).toBe(
          [
            notHeld('["held"]'),
            notHeld('["other"]'),
            notHeld('["items"][0]'),
          ].join("\n"),
        );
        // A struct in a union can read a Some's own payload, so a wrapper taken there is named
        // inside the Some that holds it.
        const inside = yield* Effect.flip(
          json(
            besideWireN({
              other: Schema.Union([
                Schema.Struct({ value: Schema.OptionFromNullOr(Schema.Any) }),
                Schema.OptionFromNullOr(Schema.Any),
              ]),
            }),
            {
              held: Option.none(),
              other: Option.some(Option.some(1)),
              wire_n: "x",
            } as never,
          ),
        );
        expect(inside.message).toBe(
          [
            notHeld('["held"]'),
            notHeld('["other"]'),
            notHeld('["other"]["value"]'),
          ].join("\n"),
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/351
  it.effect(
    "names the whole value for a wrapper it cannot find without running an accessor",
    () =>
      Effect.gen(function* () {
        const schema = besideWireN({
          f: Schema.Struct({ other: Schema.OptionFromNullOr(Schema.Any) }),
        });
        // The decoder reads `other` through its accessor; finding where it was given would not.
        const f = Object.defineProperty({}, "other", {
          enumerable: true,
          get: () => Option.some({ a: 2 }),
        });
        const alone = yield* Effect.flip(
          json(schema, { held: null, f, wire_n: "x" } as never),
        );
        expect(alone.message).toBe(
          "The schema cannot keep the content of this value",
        );
        // A wrapper found where it was given is named beside it, and neither is left out.
        const beside = yield* Effect.flip(
          json(schema, {
            held: Option.some({ a: 1 }),
            f,
            wire_n: "x",
          } as never),
        );
        expect(beside.message).toBe(
          `${notHeld('["held"]')}\nThe schema cannot keep the content of this value`,
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/383
  it.effect(
    "currently names a valid None that Schema.Option reads before a codec that could take it",
    () =>
      Effect.gen(function* () {
        const schema = besideWireN({
          other: Schema.Union([
            Schema.Option(Schema.String),
            Schema.OptionFromNullOr(Schema.Any),
          ]),
        });
        const none = yield* Effect.flip(
          json(schema, {
            held: Option.none(),
            other: Option.none(),
            wire_n: "x",
          } as never),
        );
        expect(none.message).toBe(
          `${notHeld('["held"]')}\n${notHeld('["other"]')}`,
        );
        const some = yield* Effect.flip(
          json(schema, {
            held: Option.none(),
            other: Option.some("b"),
            wire_n: "x",
          } as never),
        );
        expect(some.message).toBe(notHeld('["held"]'));
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/383
  it.effect.fails(
    "names only the refused None where Schema.Option reads one before a codec that could take it",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          json(
            besideWireN({
              other: Schema.Union([
                Schema.Option(Schema.String),
                Schema.OptionFromNullOr(Schema.Any),
              ]),
            }),
            {
              held: Option.none(),
              other: Option.none(),
              wire_n: "x",
            } as never,
          ),
        );
        expect(failure.message).toBe(notHeld('["held"]'));
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/387
  it.effect(
    "currently names only a field's wrappers where that field's own read refuses one",
    () =>
      Effect.gen(function* () {
        for (const refused of [Option.none(), Option.some(2)])
          for (const [fields, given, path] of refusingFields(refused)) {
            const failure = yield* Effect.flip(
              json(
                besideWireN(fields) as never,
                {
                  held: Option.some({ a: 1 }),
                  wire_n: "x",
                  ...given,
                } as never,
              ),
            );
            expect(failure.message).toBe(notHeld(path));
          }
        // A None elsewhere, refused just as much, is not named either, though it is the same object.
        const list = besideWireN({
          l: Schema.Array(Schema.OptionFromNullOr(Schema.Any)),
        });
        const none = yield* Effect.flip(
          json(list, {
            held: Option.none(),
            l: [Option.none(), null],
            wire_n: "x",
          } as never),
        );
        expect(none.message).toBe(notHeld('["l"][0]'));
        // Of two fields that refuse their own wrappers, the first read is named.
        const sibling = besideWireN({});
        const shared = Option.some({ a: 1 });
        const two = yield* Effect.flip(
          json(Schema.Struct({ x: sibling, y: sibling }), {
            x: { held: shared, wire_n: "x" },
            y: { held: shared, wire_n: "y" },
          } as never),
        );
        expect(two.message).toBe(notHeld('["x"]["held"]'));
        // Once that field is fixed, `held` is named.
        const fixed = yield* Effect.flip(
          json(list, {
            held: Option.some({ a: 1 }),
            l: [null, null],
            wire_n: "x",
          } as never),
        );
        expect(fixed.message).toBe(notHeld('["held"]'));
        // Where the list's own read does not refuse, both are named.
        const whole = yield* Effect.flip(
          json(list, {
            held: Option.some({ a: 1 }),
            l: [Option.some(2), Option.some(3)],
            wire_n: "x",
          } as never),
        );
        expect(whole.message).toBe(
          [notHeld('["held"]'), notHeld('["l"][0]'), notHeld('["l"][1]')].join(
            "\n",
          ),
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/387
  it.effect.fails(
    "names every refused wrapper where a field's own read refuses one",
    () =>
      Effect.gen(function* () {
        for (const [fields, given, path] of refusingFields(Option.some(2))) {
          const failure = yield* Effect.flip(
            json(
              besideWireN(fields) as never,
              { held: Option.some({ a: 1 }), wire_n: "x", ...given } as never,
            ),
          );
          expect(failure.message).toBe(
            `${notHeld('["held"]')}\n${notHeld(path)}`,
          );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/387
  it.effect(
    "names no wrapper the fields keep beside a field whose own read refuses one",
    () =>
      Effect.gen(function* () {
        // `n` can be read on its own, so the fields keep `held` as their decoded value, though the
        // whole value's read took it too. A None there is the same object as the list's.
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(Schema.Any),
          n: Schema.FiniteFromString,
          l: Schema.Array(Schema.OptionFromNullOr(Schema.Any)),
          z: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ z: "wire_z" }));
        for (const [held, sent] of [
          [Option.some({ a: 1 }), { a: 1 }],
          [Option.none(), null],
        ] as const)
          for (const refused of [Option.some(2), Option.none()]) {
            const failure = yield* Effect.flip(
              json(schema, { held, n: "1", l: [refused, null] } as never),
            );
            expect(failure.message).toBe(notHeld('["l"][0]'));
            expect(
              yield* json(schema, { held, n: "1", l: [null, null] } as never),
            ).toEqual({ held: sent, n: "1", l: [null, null] });
          }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/351
  it.effect(
    "reports another error in the value once its refused wrappers are fixed",
    () =>
      Effect.gen(function* () {
        const schema = besideWireN({
          l: Schema.Array(Schema.OptionFromNullOr(Schema.Any)),
        });
        // `n` is left out, under either name.
        const refused = yield* Effect.flip(
          json(schema, {
            held: Option.some({ a: 1 }),
            l: [Option.none(), null],
          } as never),
        );
        expect(refused.message).toBe(notHeld('["l"][0]'));
        const fixed = yield* Effect.flip(
          json(schema, {
            held: Option.some({ a: 1 }),
            l: [null, null],
          } as never),
        );
        expect(fixed.message).toBe('Missing key\n  at ["n"]');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/351
  it.effect("reads nothing inside Schema.Any to name a refused wrapper", () =>
    Effect.gen(function* () {
      let traps = 0;
      const counted = <T extends object>(target: T) =>
        new Proxy(target, {
          get: (inner, key, receiver) => {
            traps++;
            return Reflect.get(inner, key, receiver) as unknown;
          },
          getOwnPropertyDescriptor: (inner, key) => {
            traps++;
            return Reflect.getOwnPropertyDescriptor(inner, key);
          },
          getPrototypeOf: (inner) => {
            traps++;
            return Reflect.getPrototypeOf(inner);
          },
          has: (inner, key) => {
            traps++;
            return Reflect.has(inner, key);
          },
          ownKeys: (inner) => {
            traps++;
            return Reflect.ownKeys(inner);
          },
        });
      // 0.20.0 runs the same traps for these values, refusing them with the strict read's error.
      for (const [held, meta, runs] of [
        [Option.some({ a: 1 }), { flag: Option.none(), b: 1 }, 7],
        [Option.none(), { flag: Option.none() }, 5],
      ] as const) {
        traps = 0;
        const failure = yield* Effect.flip(
          json(besideWireN({ meta: Schema.Any }), {
            held,
            meta: counted(meta),
            wire_n: "x",
          } as never),
        );
        expect(failure.message).toBe(notHeld('["held"]'));
        expect(traps).toBe(runs);
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/321
  it.effect(
    "pairs a projected field with its own decoded field, in any order",
    () =>
      Effect.gen(function* () {
        const Held = Schema.Any.pipe(
          Schema.decodeTo(
            Schema.Option(payload),
            SchemaTransformation.transform({
              decode: (value) => Option.some(value),
              encode: (value) => (Option.isSome(value) ? value.value : null),
            }),
          ),
        );
        const input = {
          held: { a: "x" },
          other: Option.some({ b: "keep" }),
          wire_n: "x",
        };
        const sent = {
          held: { a: "x" },
          other: { _id: "Option", _tag: "Some", value: { b: "keep" } },
          wire_n: "x",
        };
        // A property named like a position is not the index signature's counterpart.
        const rest = Schema.Struct({
          row: Schema.StructWithRest(Schema.Struct({ "index 0": Held }), [
            Schema.Record(Schema.String, Schema.Any),
          ]),
          n: Schema.String,
        }).pipe(Schema.encodeKeys({ n: "wire_n" }));
        expect(
          yield* json(rest, {
            row: { "index 0": { a: "x" }, extra: Option.some({ b: "keep" }) },
            wire_n: "x",
          } as never),
        ).toEqual({
          row: { "index 0": { a: "x" }, extra: sent.other },
          wire_n: "x",
        });
        for (const fields of [
          { held: Held, other: Schema.Any, n: Schema.String },
          { other: Schema.Any, held: Held, n: Schema.String },
        ])
          expect(
            yield* json(
              Schema.Struct(fields).pipe(Schema.encodeKeys({ n: "wire_n" })),
              input as never,
            ),
          ).toEqual(sent);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/321
  it.effect("pairs renamed fields by their place in the rename", () =>
    Effect.gen(function* () {
      const held = Schema.suspend(() => Schema.OptionFromNullOr(payload));
      const below = (row: Schema.Top) =>
        Schema.Struct({ row, n: Schema.String }).pipe(
          Schema.encodeKeys({ n: "wire_n" }),
        );
      for (const fields of [
        { held, other: Schema.suspend(() => Schema.String) },
        { other: Schema.suspend(() => Schema.String), held },
      ]) {
        const renamedAway = below(
          Schema.Struct(fields).pipe(
            Schema.encodeKeys({ held: "wire_held", other: "wire_other" }),
          ),
        );
        const failure = yield* Effect.flip(
          json(
            renamedAway as unknown as typeof renamed,
            {
              row: { wire_held: Option.none(), wire_other: "ok" },
              wire_n: "x",
            } as never,
          ),
        );
        expect(failure).toBeInstanceOf(Schema.SchemaError);
      }
      // Swapped names: the wire `held` is the decoded `other`, an open schema.
      for (const fields of [
        { held, other: Schema.suspend(() => Schema.Any) },
        { other: Schema.suspend(() => Schema.Any), held },
      ]) {
        const swapped = below(
          Schema.Struct(fields).pipe(
            Schema.encodeKeys({ held: "other", other: "held" }),
          ),
        );
        for (const option of [Option.none(), Option.some({ b: "keep" })])
          expect(
            yield* json(
              swapped as unknown as typeof renamed,
              {
                row: { other: { a: "a" }, held: option },
                wire_n: "x",
              } as never,
            ),
          ).toEqual({
            row: {
              other: { a: "a" },
              held: JSON.parse(JSON.stringify(option)),
            },
            wire_n: "x",
          });
      }
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/321
  it.effect(
    "pairs integer-like wire names by projection, and nothing across other transforms",
    () =>
      Effect.gen(function* () {
        const Held = Schema.Any.pipe(
          Schema.decodeTo(
            Schema.Option(payload),
            SchemaTransformation.transform({
              decode: (value) => Option.some(value),
              encode: (value) => (Option.isSome(value) ? value.value : null),
            }),
          ),
        );
        const below = (row: Schema.Top) =>
          Schema.Struct({ row, n: Schema.String }).pipe(
            Schema.encodeKeys({ n: "wire_n" }),
          ) as unknown as typeof renamed;
        // JavaScript lists "0" before "1", whatever order the rename wrote them in.
        const numeric = below(
          Schema.Struct({
            held: Schema.OptionFromNullOr(payload),
            other: Schema.String,
          }).pipe(Schema.encodeKeys({ held: "1", other: "0" })),
        );
        const failure = yield* Effect.flip(
          json(numeric, {
            row: { "1": Option.none(), "0": "ok" },
            wire_n: "x",
          } as never),
        );
        expect(failure).toBeInstanceOf(Schema.SchemaError);
        const some = Option.some({ b: "keep" });
        const sentSome = { _id: "Option", _tag: "Some", value: { b: "keep" } };
        const ambiguous = below(
          Schema.Struct({ held: Held, other: Schema.Any }).pipe(
            Schema.encodeKeys({ held: "1", other: "0" }),
          ),
        );
        // Both fields are written as Any, so either could be the Option codec: a wrapper refuses
        // at either name rather than risk its loss.
        expect(
          yield* Effect.flip(
            json(ambiguous, {
              row: { "1": { a: "a" }, "0": some },
              wire_n: "x",
            } as never),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
        expect(
          yield* json(ambiguous, {
            row: { "1": { a: "a" }, "0": { b: "keep" } },
            n: "x",
          } as never),
        ).toEqual({
          row: { "0": { b: "keep" }, "1": { a: "a" } },
          wire_n: "x",
        });
        // Fields sharing a projection, suspended or not, refuse a wrapper too.
        const H = Schema.OptionFromNullOr(payload);
        for (const fields of [
          {
            held: Schema.suspend(() => H),
            other: Schema.suspend(() => Schema.String),
          },
          { held: H, other: Schema.toEncoded(H) },
        ])
          for (const mapping of [
            { held: "1", other: "0" },
            { held: "1", other: "wire_other" },
          ] as const)
            for (const option of [Option.none(), Option.some({ b: "keep" })]) {
              const shared = below(
                Schema.Struct(fields).pipe(Schema.encodeKeys(mapping)),
              );
              const failure = yield* Effect.flip(
                json(shared, {
                  row: { "1": option, [mapping.other]: "ok" },
                  wire_n: "x",
                } as never),
              );
              expect(failure).toBeInstanceOf(Schema.SchemaError);
            }
        // A hand-written transformation between same-shaped structs is not a rename.
        const swapped = below(
          Schema.Struct({ x: Schema.Any, y: Schema.Any }).pipe(
            Schema.decodeTo(
              Schema.Struct({ held: Held, other: Schema.Any }),
              SchemaTransformation.transform({
                decode: ({ x, y }) => ({ held: y, other: x }),
                encode: ({ held, other }) => ({ x: other, y: held }),
              }),
            ),
          ),
        );
        expect(
          yield* json(swapped, {
            row: { x: some, y: { a: "a" } },
            wire_n: "x",
          } as never),
        ).toEqual({ row: { x: sentSome, y: { a: "a" } }, wire_n: "x" });
      }),
  );

  it.effect("refuses an invalid Some under a hand-written codec", () =>
    Effect.gen(function* () {
      const held = Schema.NullOr(payload).pipe(
        Schema.decodeTo(
          Schema.Option(payload),
          SchemaTransformation.transform({
            decode: (value) =>
              value === null ? Option.none() : Option.some(value),
            encode: (option) => (Option.isSome(option) ? option.value : null),
          }),
        ),
      );
      const schema = Schema.Struct({ held });
      const failure = yield* Effect.flip(
        json(schema, { held: Option.some({ a: 5, b: "keep" }) } as never),
      );
      expect(failure.message).toContain('["held"]["value"]["a"]');
      expect(yield* json(schema, { held: { a: "a", b: "keep" } })).toEqual({
        held: { a: "a", b: "keep" },
      });
      expect(yield* json(schema, { held: Option.none() })).toEqual({
        held: null,
      });
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/319
  it.effect("never reads the wrapper as the encoded side's open object", () =>
    Effect.gen(function* () {
      for (const wire of [
        Schema.Any,
        Schema.ObjectKeyword,
        Schema.Union([Schema.String, Schema.ObjectKeyword]),
      ]) {
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(wire),
          count: Schema.FiniteFromString,
        });
        // Read field by field, the wrapper is the field's own decoded value (#318).
        expect(
          yield* json(schema, {
            held: Option.some({ a: 1 }),
            count: "2",
          } as never),
        ).toEqual({ held: { a: 1 }, count: "2" });
        expect(
          yield* json(schema, { held: Option.none(), count: "2" } as never),
        ).toEqual({ held: null, count: "2" });
        expect(
          yield* json(schema, { held: Option.some({ a: 1 }), count: 2 }),
        ).toEqual({
          held: { a: 1 },
          count: "2",
        });
        expect(yield* json(schema, { held: { a: 1 }, count: "2" })).toEqual({
          held: { a: 1 },
          count: "2",
        });
      }
    }),
  );

  it.effect("keeps a native Option explicitly declared on the wire side", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Option(Schema.String)),
      });
      const held = Option.some("keep");
      expect(yield* json(schema, { held })).toEqual({
        held: { _tag: "Some", value: "keep" },
      });
      expect(yield* json(schema, { held: Option.some(held) })).toEqual({
        held: { _tag: "Some", value: "keep" },
      });
    }),
  );

  it.effect("discards wrapper notes from a failed union member", () =>
    Effect.gen(function* () {
      let checked = 0;
      const count = Schema.FiniteFromString;
      const unwrapped = Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Any),
        count,
      }).check(
        Schema.makeFilter(() => {
          checked++;
          return false;
        }),
      );
      const tagged = Schema.Struct({ held: Schema.Option(payload), count });
      const schema = Schema.Union([unwrapped, tagged]);
      expect(
        yield* json(schema, {
          held: Option.some({ a: "a" }),
          count: "2",
        } as never),
      ).toEqual({
        held: { _tag: "Some", value: { a: "a" } },
        count: "2",
      });
      expect(checked).toBeGreaterThan(0);
    }),
  );

  it.effect(
    "keeps the wrapper note from a successful asynchronous union member",
    () =>
      Effect.gen(function* () {
        const count = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (value) => Effect.as(Effect.yieldNow, Number(value)),
              encode: (value) => Effect.succeed(String(value)),
            }),
          ),
        );
        const schema = Schema.Union([
          Schema.Struct({ held: Schema.OptionFromNullOr(Schema.Any), count }),
          Schema.Struct({ held: Schema.Option(payload), count }),
        ]);
        expect(yield* json(schema, { held: { a: "a" }, count: "2" })).toEqual({
          held: { a: "a" },
          count: "2",
        });
        const failure = yield* Effect.flip(
          json(schema, { held: Option.some({ a: "a" }), count: "2" } as never),
        );
        expect(failure).toBeInstanceOf(Schema.SchemaError);
        // Only the strict pass reads it, so the wrapper is named rather than that pass's error
        // (https://github.com/viell-dev/slop-effect-schema-http/issues/351).
        expect(failure.message).toBe(notHeld('["held"]'));
      }),
  );

  it.effect("keeps the wrapper note across decoding recovery", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        held: Schema.OptionFromNullOr(payload),
        n: Schema.FiniteFromString,
      }).pipe(
        Schema.catchDecoding(() =>
          Effect.succeedSome({ held: Option.none(), n: 0 }),
        ),
      );
      expect(yield* json(schema, { held: { a: "a" }, n: {} } as never)).toEqual(
        {
          held: null,
          n: "0",
        },
      );
      const failure = yield* Effect.flip(
        json(schema, { held: Option.some({ a: "a" }), n: {} } as never),
      );
      expect(failure).toBeInstanceOf(Schema.SchemaError);
      expect(failure.message).toContain('["n"]');
    }),
  );

  for (const binding of ["body", "path", "query", "headers"] as const) {
    it.effect(`runs each reading once for ${binding} preparation`, () =>
      Effect.gen(function* () {
        let decoderRuns = 0;
        let defaultRuns = 0;
        const counted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (value) =>
                Effect.sync(() => {
                  if (++decoderRuns > 2) throw new Error("repeated decoder");
                  return Number(value);
                }),
              encode: (value) => Effect.succeed(String(value)),
            }),
          ),
        );
        const flatPayload = Schema.Any.pipe(
          Schema.decodeTo(
            payload,
            SchemaTransformation.transform({
              decode: () => ({}),
              encode: (decoded) => JSON.stringify(decoded),
            }),
          ),
        );
        const schema = Schema.Struct({
          pre: counted,
          held: Schema.OptionFromOptionalKey(flatPayload),
          post: Schema.FiniteFromString,
          dflt: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                defaultRuns++;
                return "7";
              }),
            ),
          ),
        });
        const base = Request.post("/x");
        const compile = (held: Option.Option<unknown>) => {
          const supplied = { pre: "1", held, post: 2 } as never;
          switch (binding) {
            case "body":
              return Request.compile(
                base.pipe(Request.body(Body.jsonSchema(schema))),
                { body: supplied },
              );
            case "path":
              return Request.compile(
                base.pipe(
                  Request.path(schema, ({ pre, post }) => `/${pre}/${post}`),
                ),
                { path: supplied },
              );
            case "query":
              return Request.compile(base.pipe(Request.query(schema)), {
                query: supplied,
              });
            case "headers":
              return Request.compile(base.pipe(Request.headers(schema)), {
                headers: supplied,
              });
          }
        };
        yield* compile(Option.none());
        expect([decoderRuns, defaultRuns]).toEqual([2, 1]);

        decoderRuns = 0;
        defaultRuns = 0;
        const failure = yield* Effect.flip(
          compile(Option.some({ a: 5, b: "keep" })),
        );
        expect(failure).toBeInstanceOf(Schema.SchemaError);
        // Only the strict pass reads it, so the wrapper is named rather than that pass's error
        // (https://github.com/viell-dev/slop-effect-schema-http/issues/351).
        expect(failure.message).toBe(notHeld('["held"]'));
        expect([decoderRuns, defaultRuns]).toEqual([2, 0]);
      }),
    );
  }

  it.effect("refuses the payload before rendering query, headers or path", () =>
    Effect.gen(function* () {
      const schema = Schema.OptionFromOptionalKey(payload);
      const base = Request.get("/x");
      const query = base.pipe(Request.query(schema));
      const headers = base.pipe(Request.headers(schema));
      const path = base.pipe(Request.path(schema, ({ a }) => `/${a ?? ""}`));
      const invalid = Option.some({ a: 5, b: "keep" }) as never;
      for (const attempt of [
        Request.compile(query, { query: invalid }),
        Request.compile(headers, { headers: invalid }),
        Request.compile(path, { path: invalid }),
      ]) {
        const failure = yield* Effect.flip(attempt);
        expect(failure).toBeInstanceOf(Schema.SchemaError);
        expect(failure.message).toContain('["value"]["a"]');
      }
    }),
  );

  it.effect("names an invalid field through two unwrapping codecs", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        outer: Schema.OptionFromNullOr(
          Schema.Struct({ held: Schema.OptionFromOptionalKey(payload) }),
        ),
      });
      const failure = yield* Effect.flip(
        json(schema, {
          outer: Option.some({ held: Option.some({ a: 5, b: "keep" }) }),
        } as never),
      );
      expect(failure.message).toContain(
        '["outer"]["value"]["held"]["value"]["a"]',
      );
      expect(
        yield* json(schema, { outer: Option.some({ held: Option.none() }) }),
      ).toEqual({ outer: {} });
      expect(yield* json(schema, { outer: { held: { b: "keep" } } })).toEqual({
        outer: { held: { b: "keep" } },
      });
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/318
  it.effect(
    "keeps a wrapper beside an encoded sibling by reading each field on its side",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(payload),
          count: Schema.FiniteFromString,
        });
        const held = Option.some({ a: "a", b: "keep" });
        expect(yield* json(schema, { held, count: "2" } as never)).toEqual({
          held: { a: "a", b: "keep" },
          count: "2",
        });
        expect(
          yield* json(schema, { held: Option.none(), count: "2" } as never),
        ).toEqual({ held: null, count: "2" });
        expect(
          yield* json(
            Schema.Struct({ row: schema, tag: Schema.FiniteFromString }),
            {
              row: { held, count: "2" },
              tag: "1",
            } as never,
          ),
        ).toEqual({
          row: { held: { a: "a", b: "keep" }, count: "2" },
          tag: "1",
        });
        // A hand-written codec whose wire struct has a `value` key writes the wrapper itself.
        const byHand = Schema.Struct({
          value: Schema.optionalKey(payload),
        }).pipe(
          Schema.decodeTo(
            Schema.Option(payload),
            SchemaTransformation.transform({
              decode: ({ value }) =>
                value === undefined ? Option.none() : Option.some(value),
              encode: (option) =>
                Option.isSome(option) ? { value: option.value } : {},
            }),
          ),
        );
        const handSchema = Schema.Struct({
          held: byHand,
          count: Schema.FiniteFromString,
        });
        expect(yield* json(handSchema, { held, count: "2" } as never)).toEqual({
          held: { value: { a: "a", b: "keep" } },
          count: "2",
        });
        expect(
          yield* json(handSchema, { held: Option.none(), count: "2" } as never),
        ).toEqual({ held: {}, count: "2" });
        // The fields are read again after the whole read, as on every recovery route.
        let runs = 0;
        const counted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (value) =>
                Effect.sync(() => {
                  runs++;
                  return Number(value);
                }),
              encode: (value) => Effect.succeed(String(value)),
            }),
          ),
        );
        const withPre = Schema.Struct({ pre: counted, ...schema.fields });
        expect(
          yield* json(withPre, { pre: "1", held, count: "2" } as never),
        ).toEqual({ pre: "1", held: { a: "a", b: "keep" }, count: "2" });
        expect(runs).toBe(2);
        runs = 0;
        yield* Effect.flip(
          json(withPre, {
            pre: "1",
            held: Option.some({ a: 5, b: "keep" }),
            count: "2",
          } as never),
        );
        expect(runs).toBe(2);
        // An invalid payload and an invalid sibling still refuse.
        const invalid = yield* Effect.flip(
          json(schema, {
            held: Option.some({ a: 5, b: "keep" }),
            count: "2",
          } as never),
        );
        expect(invalid.message).toContain('["held"]["value"]["a"]');
        const sibling = yield* Effect.flip(
          json(schema, { held, count: "x" } as never),
        );
        expect(sibling.message).toContain('["count"]');
        expect(yield* json(schema, { held, count: 2 })).toEqual({
          held: { a: "a", b: "keep" },
          count: "2",
        });
        for (const fields of [{}, { stray: "leave out" }]) {
          expect(
            yield* json(schema, {
              held: Option.some(fields),
              count: "2",
            } as never),
          ).toEqual({ held: {}, count: "2" });
        }
        const checked = Schema.Struct({
          held: Schema.OptionFromNullOr(
            payload.check(Schema.makeFilter(({ a }) => a === "a")),
          ),
          count: Schema.FiniteFromString,
        });
        expect(yield* json(checked, { held, count: "2" })).toEqual({
          held: { a: "a", b: "keep" },
          count: "2",
        });
        const optional = Schema.Struct({
          a: Schema.optionalKey(Schema.NumberFromString),
        }).check(Schema.makeFilter(({ a }) => a === undefined || a > 0));
        const optionalChecked = Schema.Struct({
          held: Schema.OptionFromNullOr(optional),
          count: Schema.FiniteFromString,
        });
        expect(
          yield* json(optionalChecked, { held: Option.some({}), count: "2" }),
        ).toEqual({ held: {}, count: "2" });
      }),
  );
});
