import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaTransformation } from "effect";
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
const json = <S extends Schema.Top>(schema: S, value: Inputs.Input<S>) =>
  Effect.map(Body.jsonSchema(schema).encode(value), (body) => {
    if (body._tag !== "Uint8Array") throw new Error("expected a JSON body");
    return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
  });

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
        Inputs.refuseLost(impossible, result.lost, () => true),
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
      expect(yield* json(Held, { held: Option.some(stray), filter })).toEqual({
        held: owner,
        filter,
      });
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
        expect(failure.message).not.toContain('["stray"]');
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
    "keeps the refusal when a structural link writes away a supplied field",
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
          const failure = yield* Effect.flip(
            json(schema, { held: Option.some(stray), filter }),
          );
          expect(failure.message).toContain('["held"]["value"]["owner"]');
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
    const neighbours = [
      [Filter, wide],
      [
        Schema.OptionFromNullOr(Schema.TaggedStruct("A", { f: Filter })),
        Option.some({ _tag: "A" as const, f: wide }),
      ],
      [
        Schema.OptionFromNullOr(Schema.Union([TaggedOwner, TaggedWide])),
        Option.some({ _tag: "A" as const, ...wide }),
      ],
      [Schema.OptionFromNullOr(Schema.Array(Filter)), Option.some([wide])],
      [
        Schema.OptionFromNullOr(
          Schema.Struct({
            value: Schema.Struct({ a: Schema.String }),
            f: Filter,
          }),
        ),
        Option.some({ value: { a: "1" }, f: wide }),
      ],
      [Schema.Option(Filter), Option.some(wide)],
      [Schema.ReadonlyMap(Schema.String, Filter), new Map([["k", wide]])],
      [Schema.OptionFromNullOr(Filter), Option.some(wide)],
    ] as const;
    for (const codec of [
      Schema.OptionFromNullOr,
      Schema.OptionFromUndefinedOr,
      Schema.OptionFromNullishOr,
      Schema.OptionFromOptionalKey,
      Schema.OptionFromOptional,
      Schema.OptionFromOptionalNullOr,
    ]) {
      for (const [other, value] of neighbours) {
        const schema = Schema.Struct({
          held: codec(Owner),
          other,
          filter: Filter,
        });
        const control = yield* json(schema, {
          held: Option.some(owner),
          other: value,
          filter,
        });
        expect(
          yield* json(schema, {
            held: Option.some(stray),
            other: value,
            filter,
          }),
        ).toEqual(control);
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

it.effect("refuses a repaired input when an unrelated strict write fails", () =>
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
    expect(failure.message).toContain('["codec"]["b"]');
  }),
);

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
