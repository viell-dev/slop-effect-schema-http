import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Option,
  Schema,
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
  const caught = <S extends Schema.Top>(payload: S) =>
    Schema.OptionFromNullOr(payload).pipe(
      Schema.catchEncoding(() => Effect.succeedSome(null)),
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
    const withA = Schema.Struct({ held: plain, a: Schema.String });
    const withB = Schema.Struct({
      held: Schema.OptionFromNullOr(payload),
      b: Schema.String,
    });
    for (const schema of [
      Schema.Struct({
        held: Schema.OptionFromOptionalNullOr(payload, {
          onNoneEncoding: null,
        }),
      }),
      Schema.Struct({
        held: Schema.OptionFromOptionalNullOr(payload, {
          onNoneEncoding: undefined,
        }),
      }),
      Schema.Struct({
        held: Schema.Union([plain, Schema.Struct({ z: Schema.String })]),
      }),
      Schema.Struct({
        held: Schema.Union([plain, Schema.OptionFromUndefinedOr(payload)]),
      }),
      Schema.Union([withA, withB]),
    ]) {
      const supplied =
        schema.ast._tag === "Union" ? { held, a: "a" } : { held };
      const failure = yield* Effect.flip(json(schema, supplied));
      expect(failure.message).toContain('["held"]["value"]["a"]');
      const unstated = {
        ...supplied,
        held: Option.some({ value, stray: "x" }),
      };
      const refused = yield* Effect.flip(json(schema, unstated));
      expect(refused.message).toContain('["held"]["value"]["stray"]');
      const control = { ...supplied, held: Option.some({ value }) };
      const expected =
        schema.ast._tag === "Union"
          ? { held: { value }, a: "a" }
          : { held: { value } };
      expect(yield* json(schema, control)).toEqual(expected);
    }
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

  it.effect(
    "names the field through a list, a rename and either union order",
    () =>
      Effect.gen(function* () {
        const renamed = payload.pipe(Schema.encodeKeys({ b: "wire_b" }));
        const choice = Schema.OptionFromNullOr(renamed);
        const withUnrelated = [
          Schema.Union([choice, Schema.String]),
          Schema.Union([Schema.String, choice]),
        ];
        for (const held of withUnrelated) {
          const schema = Schema.Struct({ rows: Schema.Array(held) });
          const failure = yield* Effect.flip(
            json(schema, { rows: [Option.some({ a: 5, b: "keep" })] } as never),
          );
          expect(failure.message).toContain('["rows"][0]["value"]["a"]');
          expect(
            yield* json(schema, { rows: [Option.some({ a: "a", b: "keep" })] }),
          ).toEqual({ rows: [{ a: "a", wire_b: "keep" }] });
        }
      }),
  );

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

  it.effect(
    "refuses a mixed read that would send a reinterpreted wrapper",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          held: Schema.OptionFromNullOr(payload),
          count: Schema.FiniteFromString,
        });
        const held = Option.some({ a: "a", b: "keep" });
        const failure = yield* Effect.flip(
          json(schema, { held, count: "2" } as never),
        );
        expect(failure.message).toContain('["count"]');
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
      }),
  );
});
