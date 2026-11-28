import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Option,
  Schema,
  SchemaAST,
  SchemaTransformation,
} from "effect";
import * as Excess from "./excess.js";
import * as Shapes from "./shape.js";
import { guardReading, notesWrapper } from "./void-member.js";

const text = Schema.String;
const Either = Schema.Union([
  Schema.Struct({ a: text }),
  Schema.Struct({ a: text, b: text }),
]);

const read = (value: unknown) => Excess.normalised([Either.ast], value);

const gone = (given: object, value: object, output: object) =>
  Excess.missing([Either.ast], given, value, output);

// https://github.com/viell-dev/slop-effect-schema-http/issues/355
describe("normalising a recursive union", () => {
  it("passes each member schema to the next level once", () => {
    // An untagged union of two recursive structs names the same field schemas once per member, so
    // a walk that passed on every occurrence would read each level twice as often as the one
    // above it. Counting reads of the self-reference measures that without timing it.
    const depth = 16;
    let reads = 0;
    const self = Schema.suspend((): Schema.Codec<unknown, unknown> => Node);
    const target = self.ast.thunk;
    Object.assign(self.ast, {
      thunk: () => {
        reads++;
        return target();
      },
    });
    const Node: Schema.Codec<unknown, unknown> = Schema.Union([
      Schema.Struct({ a: text, next: Schema.NullOr(self) }),
      Schema.Struct({ b: text, next: Schema.NullOr(self) }),
    ]);
    let value: unknown = null;
    for (let at = depth - 1; at >= 0; at--)
      value = { a: `x${at}`, next: value };
    expect(Excess.normalised([Node.ast], value)).toEqual(value);
    // Two reads a level; without passing each schema once it was 2^depth − 1.
    expect(reads).toBeGreaterThanOrEqual(depth);
    expect(reads).toBeLessThanOrEqual(4 * depth);
  });
});

// The library reads Effect's schema structure, which a newer Effect could change. A reading that
// came back empty would fall back to Effect's own reading with no error, so these say it held. They
// run in CI, on the oldest Effect in release qualification, and on each Dependabot bump.
describe("the reading of Effect's schema structure", () => {
  const narrow = Schema.Struct({ a: text });
  const renamed = narrow.pipe(Schema.encodeKeys({ a: "A" }));

  it("sees a choice where it can see, and none where it cannot", () => {
    expect(Excess.choosing(Either.ast)).toBe(true);
    expect(Excess.choosing(Schema.NullOr(narrow).ast)).toBe(false);
    expect(Excess.choosing(renamed.ast)).toBe(true);
    expect(Excess.choosesMember(renamed.ast)).toBe(false);
    expect(Excess.choosing(Schema.Array(Either).ast)).toBe(true);
    expect(Excess.choosing(Schema.Option(Either).ast)).toBe(false);
  });

  it("keeps a later member's field in a strict read", () => {
    expect(
      Schema.decodeUnknownSync(Either)({ a: "", b: "" }, Excess.strict),
    ).toHaveProperty("b");
  });

  it("finds a member's field, an unstated key and a lost field", () => {
    expect(read({ a: "", z: "" })).not.toHaveProperty("z");
    expect(read({ a: "", b: "" })).toHaveProperty("b");
    expect(gone({ a: "", b: "" }, { a: "" }, { a: "" })).toHaveLength(1);
  });

  it("reads which fields are always written", () => {
    const fallback = Effect.succeed("");
    const { shape } = Shapes.bind(
      Schema.Struct({
        always: text,
        defaulted: text.pipe(Schema.withDecodingDefaultKey(fallback)),
        maybe: Schema.OptionFromOptionalKey(text),
        omitted: text.pipe(
          Schema.withDecodingDefaultKey(fallback, { encodingStrategy: "omit" }),
        ),
      }),
      (name) => name,
    );
    expect(shape.required).toEqual(new Set(["always", "defaulted"]));
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/347
  it("gives a codec nested in a payload one decoded side, the one the payload's decoded side holds", () => {
    const nested = Schema.OptionFromNullOr(Either);
    const payload = Schema.Struct({ inner: nested });
    const decoded = SchemaAST.toType(payload.ast);
    if (decoded._tag !== "Objects") throw new Error("expected a struct");
    const inner = decoded.propertySignatures[0]!.type;
    expect(inner).toBe(SchemaAST.toType(nested.ast));
    expect(inner.encoding).toBeUndefined();
    expect(inner).not.toBe(SchemaAST.toType(Schema.Option(Either).ast));
  });
});

describe("Excess.choosing", () => {
  it("holds its reading for the Effect this runs on", () => {
    expect(Excess.choosing(Either.ast)).toBe(true);
    expect(Excess.choosing(text.ast)).toBe(false);
  });

  it("sees a choice of side as well as a choice of member", () => {
    const Named = Schema.Struct({ a: text });
    const Renamed = Named.pipe(Schema.encodeKeys({ a: "A" }));
    class Same extends Schema.Class<Same>("SameNames")({ a: text }) {}
    expect(Excess.choosing(Renamed.ast)).toBe(true);
    expect(Excess.choosing(Schema.Struct({ f: Renamed }).ast)).toBe(true);
    expect(Excess.choosing(Same.ast)).toBe(false);
    expect(Excess.choosing(Schema.fromJsonString(Named).ast)).toBe(false);
  });

  it("sees a rest on the encoded side, with the same names on both", () => {
    const optional = Schema.Struct({ a: Schema.optionalKey(text) });
    const Rest = Schema.StructWithRest(optional, [Schema.Record(text, text)]);
    const Reading = Rest.pipe(
      Schema.decodeTo(
        optional,
        SchemaTransformation.transform({
          decode: ({ a }) => (a === undefined ? {} : { a }),
          encode: (value) => value,
        }),
      ),
    );
    expect(Excess.choosing(Reading.ast)).toBe(true);
  });

  it("tells a choice of member from a choice of side", () => {
    const Renamed = Schema.Struct({ a: text }).pipe(
      Schema.encodeKeys({ a: "A" }),
    );
    expect(Excess.choosesMember(Renamed.ast)).toBe(false);
    expect(Excess.choosesMember(Either.ast)).toBe(true);
  });
});

describe("Excess.exposed", () => {
  class Wide {
    readonly a = "x";
    get b() {
      return "y";
    }
  }

  it("returns the value itself if nothing is outside its keys", () => {
    const value = { a: "x", stray: "z", b: undefined };
    expect(Excess.exposed([Either.ast], value)).toBe(value);
  });

  it("brings out a field and leaves the rest as it was given", () => {
    expect(Excess.exposed([Either.ast], new Wide())).toEqual({
      a: "x",
      b: "y",
    });
  });

  it("leaves a key a normalised value would lose", () => {
    const value = { a: "x", stray: "z", held: new Wide() };
    expect(
      Excess.exposed([Schema.Struct({ a: text, held: Either }).ast], value),
    ).toEqual({ a: "x", stray: "z", held: { a: "x", b: "y" } });
  });
});

describe("Excess.statedFields", () => {
  it("takes the fields of a group under either name", () => {
    const Renamed = Schema.Struct({ a: text }).pipe(
      Schema.encodeKeys({ a: "A" }),
    );
    expect(
      Excess.statedFields(Renamed.ast, {
        a: "1",
        A: "2",
        z: "3",
        b: undefined,
      }),
    ).toEqual(["a", "A"]);
  });

  it("takes a field outside the keys, and no key the schema does not state", () => {
    class Wide {
      readonly a = "x";
      readonly stray = "z";
      get b() {
        return "y";
      }
    }
    expect(Excess.statedFields(Either.ast, new Wide())).toEqual(["a", "b"]);
  });

  it("takes no field the caller left undefined", () => {
    expect(Excess.statedFields(Either.ast, { a: "1", b: undefined })).toEqual([
      "a",
    ]);
  });

  it("takes any key of a record", () => {
    const Open = Schema.Record(text, text);
    expect(Excess.statedFields(Open.ast, { a: "1" })).toEqual(["a"]);
  });

  it("finds no fields in a list or in text", () => {
    const Pairs = Schema.Array(Schema.Tuple([text, text]));
    expect(Excess.statedFields(Pairs.ast, [["a", "1"]])).toEqual([]);
    expect(Excess.statedFields(text.ast, "a")).toEqual([]);
  });
});

describe("Excess.normalised", () => {
  it("leaves an instance a declaration or an open schema may need", () => {
    const moment = new Date(0);
    const Open = Schema.Union([
      Schema.Struct({ a: text, when: Schema.Unknown }),
      Schema.Struct({ b: text }),
    ]);
    const open = { a: "x", when: moment };
    expect(Excess.normalised([Open.ast], open)).toBe(open);
    const Declared = Schema.Union([
      Schema.Struct({ a: text, when: Schema.Date }),
      Schema.Struct({ b: text }),
    ]);
    const declared = { a: "x", when: moment };
    expect(Excess.normalised([Declared.ast], declared)).toBe(declared);
  });

  it("keeps the keys of an instance a declaration may need", () => {
    class Foo {
      readonly x = "1";
    }
    const OrStruct = Schema.Union([
      Schema.instanceOf(Foo),
      Schema.Struct({ a: Schema.optionalKey(text) }),
    ]);
    const value = new Foo();
    expect(Excess.normalised([OrStruct.ast], value)).toBe(value);
  });

  it("reads a class instance only a struct can read as a plain object", () => {
    class Wide {
      readonly a = "x";
      readonly stray = "z";
    }
    expect(Excess.normalised([Either.ast], new Wide())).toEqual({ a: "x" });
  });

  it("does not take an object's prototype for a field", () => {
    const Named = Schema.Union([
      Schema.Struct({ ["__proto__"]: Schema.optionalKey(text) }),
      Schema.Struct({ a: text }),
    ]);
    const value = { a: "x" };
    expect(Excess.normalised([Named.ast], value)).toBe(value);
  });

  it("returns the value itself if there is nothing to take out", () => {
    const value = { a: "x", b: "y" };
    expect(read(value)).toBe(value);
  });

  it("takes out `undefined` and a key no member states", () => {
    expect(read({ a: "x", b: undefined, z: "stray" })).toEqual({ a: "x" });
  });

  it("leaves the value it was given alone", () => {
    const value = { a: "x", z: "stray" };
    read(value);
    expect(value).toEqual({ a: "x", z: "stray" });
  });

  it("goes through fields and lists, and keeps a list's length", () => {
    const List = Schema.Struct({ items: Schema.Array(Either) });
    expect(
      Excess.normalised([List.ast], {
        items: [{ a: "1", z: "stray" }, { a: "2" }],
        z: "stray",
      }),
    ).toEqual({ items: [{ a: "1" }, { a: "2" }] });
  });

  it("keeps a key only one side states", () => {
    const Renamed = Schema.Struct({ a: text }).pipe(
      Schema.encodeKeys({ a: "A" }),
    );
    const value = { A: "x", a: "y" };
    expect(Excess.normalised([Renamed.ast], value)).toBe(value);
  });

  it("leaves a key a record or an open member can hold", () => {
    const Open = Schema.Union([
      Schema.Struct({ a: text }),
      Schema.Record(text, text),
    ]);
    const value = { a: "x", z: "kept" };
    expect(Excess.normalised([Open.ast], value)).toBe(value);
    const Anything = Schema.Union([Schema.Struct({ a: text }), Schema.Unknown]);
    expect(Excess.normalised([Anything.ast], value)).toBe(value);
  });

  it("leaves what a tag rules out to the member the tag leaves", () => {
    const Tagged = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), x: text }),
      Schema.Struct({ kind: Schema.Literal("b") }),
    ]);
    expect(Excess.normalised([Tagged.ast], { kind: "b", x: "y" })).toEqual({
      kind: "b",
    });
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it("lets a renamed encoded tag rule a member out", () => {
    const Tagged = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), x: text }).pipe(
        Schema.encodeKeys({ kind: "k" }),
      ),
      Schema.Struct({ kind: Schema.Literal("c") }).pipe(
        Schema.encodeKeys({ kind: "k" }),
      ),
    ]);
    expect(Excess.normalised([Tagged.ast], { k: "c", x: "y" })).toEqual({
      k: "c",
    });
    const both = { kind: "a", k: "c", x: "y" };
    expect(Excess.normalised([Tagged.ast], both)).toBe(both);
  });

  it("does not guess a constructor tag's default or prune an untagged value", () => {
    let calls = 0;
    const Tagged = Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("a").pipe(
          Schema.withConstructorDefault(
            Effect.sync(() => {
              calls += 1;
              return "a" as const;
            }),
          ),
        ),
        x: text,
      }).pipe(Schema.encodeKeys({ kind: "k" })),
      Schema.Struct({ kind: Schema.Literal("c") }).pipe(
        Schema.encodeKeys({ kind: "k" }),
      ),
    ]);
    const value = { k: "c", x: "y" };
    expect(Excess.normalised([Tagged.ast], value)).toBe(value);
    const untagged = { x: "y" };
    expect(Excess.normalised([Tagged.ast], untagged)).toBe(untagged);
    expect(calls).toBe(0);
  });

  it("does not take a class instance apart", () => {
    class Held extends Schema.Class<Held>("Held")({ a: text }) {}
    const value = new Held({ a: "x" });
    expect(Excess.normalised([Held.ast], value)).toBe(value);
  });

  it("keeps an own `__proto__` key as data", () => {
    const Open = Schema.Record(text, text);
    const value = JSON.parse('{"__proto__":"x","gone":null}');
    delete value.gone;
    expect(Excess.normalised([Open.ast], value)).toBe(value);
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/351
describe("Excess.placesOf", () => {
  const Held = Schema.Struct({
    held: Schema.OptionFromNullOr(Schema.Any),
    other: Schema.Option(text),
  });
  const reading = guardReading(Held.ast);
  const none = Option.none();

  it("finds a target only where a reader takes it, at each place it is held", () => {
    const shared = { held: none, other: none };
    expect(
      Excess.placesOf(
        guardReading(Schema.Struct({ x: Held, y: Held }).ast),
        { x: shared, y: shared },
        new Set([none]),
        notesWrapper,
      ),
    ).toEqual([
      ["x", "held"],
      ["y", "held"],
    ]);
    expect(
      Excess.placesOf(
        reading,
        { held: null, other: none },
        new Set([none]),
        notesWrapper,
      ),
    ).toEqual([[]]);
  });

  it("finds a target only within the part that was read", () => {
    const schema = guardReading(
      Schema.Struct({
        held: Schema.OptionFromNullOr(Schema.Any),
        l: Schema.Array(Schema.OptionFromNullOr(Schema.Any)),
      }).ast,
    );
    const value = { held: none, l: [null, none] };
    expect(
      Excess.placesOf(schema, value, new Set([none]), notesWrapper),
    ).toEqual([["held"], ["l", 1]]);
    expect(
      Excess.placesOf(schema, value, new Set([none]), notesWrapper, ["l"]),
    ).toEqual([["l", 1]]);
    expect(
      Excess.placesOf(schema, { held: none }, new Set([none]), notesWrapper, [
        "l",
      ]),
    ).toEqual([[]]);
  });

  it("runs no accessor, and names the whole value for a target behind one", () => {
    const value = Object.defineProperty({ other: none }, "held", {
      enumerable: true,
      get: () => {
        throw new Error("read");
      },
    });
    expect(
      Excess.placesOf(reading, value, new Set([none]), notesWrapper),
    ).toEqual([[]]);
  });

  it("reads nothing where no reader takes a target or reads keys", () => {
    let traps = 0;
    const counted = new Proxy(
      { flag: none },
      {
        get: (target, key, receiver) => {
          traps++;
          return Reflect.get(target, key, receiver) as unknown;
        },
        getOwnPropertyDescriptor: (target, key) => {
          traps++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          traps++;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          traps++;
          return Reflect.ownKeys(target);
        },
      },
    );
    const schema = Schema.Struct({
      held: Schema.OptionFromNullOr(Schema.Any),
      meta: Schema.Any,
      name: text,
    });
    expect(
      Excess.placesOf(
        guardReading(schema.ast),
        { held: none, meta: counted, name: counted },
        new Set([none]),
        notesWrapper,
      ),
    ).toEqual([["held"]]);
    expect(traps).toBe(0);
  });
});

describe("Excess.missing", () => {
  it("finds a field in neither the value nor what was written", () => {
    expect(gone({ a: "x", b: "y" }, { a: "x" }, { a: "x" })).toEqual([["b"]]);
  });

  it("takes a field on either side as kept", () => {
    expect(gone({ a: "x" }, { a: "x" }, {})).toEqual([]);
    const Renamed = Schema.Struct({ a: text }).pipe(
      Schema.encodeKeys({ a: "A" }),
    );
    expect(
      Excess.missing([Renamed.ast], { A: "x" }, { a: "x" }, { A: "x" }),
    ).toEqual([]);
  });

  it("does not take another field's wire name for a decoded name", () => {
    const Swapped = Schema.Union([
      Schema.Struct({ a: text }).pipe(Schema.encodeKeys({ a: "b" })),
      Schema.Struct({ b: text }),
    ]);
    expect(
      Excess.missing([Swapped.ast], { a: "1", b: "2" }, { a: "1" }, { b: "1" }),
    ).toEqual([["b"]]);
  });

  it("has nothing to lose in an `undefined` list element", () => {
    const List = Schema.Array(Schema.UndefinedOr(Either));
    expect(
      Excess.missing([List.ast], [undefined], [undefined], [undefined]),
    ).toEqual([]);
  });

  it("names a place in a list by its number", () => {
    const List = Schema.Array(Either);
    expect(
      Excess.missing(
        [List.ast],
        [{ a: "x" }, { a: "x", b: "y" }],
        [{ a: "x" }, { a: "x" }],
        [{ a: "x" }, { a: "x" }],
      ),
    ).toEqual([[1, "b"]]);
  });

  it("leaves what it cannot see to the schema", () => {
    const InText = Schema.Struct({ filter: Schema.fromJsonString(Either) });
    expect(
      Excess.missing(
        [InText.ast],
        { filter: '{"a":"1","b":"2"}' },
        { filter: { a: "1" } },
        { filter: '{"a":"1"}' },
      ),
    ).toEqual([]);
    const InOption = Schema.Struct({ filter: Schema.Option(Either) });
    expect(
      Excess.missing(
        [InOption.ast],
        { filter: Option.some({ a: "1", b: "2" }) },
        { filter: Option.some({ a: "1" }) },
        { filter: Option.some({ a: "1" }) },
      ),
    ).toEqual([]);
  });

  it("compares an object under a decoded name as well", () => {
    const Inner = Schema.Struct({ x: text });
    const Swapped = Schema.Union([
      Schema.Struct({ a: Inner }).pipe(Schema.encodeKeys({ a: "b" })),
      Schema.Struct({ b: Inner }),
    ]);
    const lost = (b: string) =>
      Excess.missing(
        [Swapped.ast],
        { a: { x: "1" }, b: { x: b } },
        { a: { x: "1" } },
        { b: { x: "1" } },
      );
    expect(lost("2")).toEqual([["b"]]);
    expect(lost("1")).toEqual([]);
  });

  it("has nothing to say about a value with no choice under it", () => {
    const Plain = Schema.Struct({ at: Schema.DateFromString });
    expect(
      Excess.missing(
        [Plain.ast],
        { at: "2026-11-07T12:00:00.000Z" },
        { at: new Date(0) },
        { at: "x" },
      ),
    ).toEqual([]);
  });
});

describe("normalising visible Some payloads", () => {
  const Payload = Schema.Struct({ a: text });
  const Held = Schema.OptionFromNullOr(Payload);
  const extra = { a: "a", stray: "x" };

  it("does not copy an accessor, prototype-named field or a wrapper with its own state", () => {
    const access = Object.defineProperty({ a: "a" }, "stray", {
      enumerable: true,
      get: () => {
        throw new Error("read an accessor");
      },
    });
    const customPrototype = Option.some(extra);
    Object.setPrototypeOf(
      customPrototype,
      Object.create(Object.getPrototypeOf(customPrototype) as object) as object,
    );
    for (const input of [
      customPrototype,
      Option.some(access),
      Option.some({ ...extra, toString: "x" }),
      Object.assign(Option.some(extra), { note: "keep" }),
      Object.defineProperty(Option.some(extra), "value", { enumerable: false }),
    ]) {
      expect(Excess.normalisedOptions(Held.ast, input)).toBe(input);
    }
  });

  it("keeps data under prototype-named or open alternatives", () => {
    const input = Option.some(extra);
    for (const schema of [
      Schema.OptionFromNullOr(
        Schema.Struct({ a: text, toString: Schema.optionalKey(text) }),
      ),
      Schema.OptionFromNullOr(Schema.Union([Payload, Schema.Unknown])),
      Schema.OptionFromNullOr(Schema.Union([Payload, Schema.Struct({})])),
      Schema.OptionFromNullOr(Schema.Record(text, text)),
    ]) {
      expect(Excess.normalisedOptions(schema.ast, input)).toBe(input);
    }
  });

  it("only strips inside the payload and uses every member's names", () => {
    const Part = Schema.Struct({ a: text });
    const Tagged = Schema.TaggedStruct("B", { b: text });
    const TaggedHeld = Schema.OptionFromNullOr(Schema.Union([Part, Tagged]));
    const schema = Schema.Struct({ held: TaggedHeld });
    const input = { held: Option.some({ ...extra, b: "b" }), stray: "keep" };
    expect(Excess.normalisedOptions(schema.ast, input)).toEqual({
      held: Option.some({ a: "a", b: "b" }),
      stray: "keep",
    });
  });

  it("leaves out a payload's unstated keys beside a Void where no stated key is left", () => {
    const Filter = Schema.Struct({ limit: Schema.optionalKey(text) });
    for (const mode of ["anyOf", "oneOf"] as const) {
      const schema = Schema.OptionFromNullOr(
        Schema.Union([Filter, Schema.Void], { mode }),
      );
      // https://github.com/viell-dev/slop-effect-schema-http/issues/310
      for (const payload of [{ extra: 1 }, { zz: undefined }])
        expect(
          Excess.normalisedOptions(schema.ast, Option.some(payload)),
        ).toEqual(Option.some({}));
      // A stated key stays, set or not, and so does the stray key beside it.
      for (const payload of [{ limit: "5", extra: 1 }, { limit: undefined }]) {
        const input = Option.some(payload);
        expect(Excess.normalisedOptions(schema.ast, input)).toBe(input);
      }
    }
  });

  it("requires an Option declaration and the matching payload source", () => {
    const ast = Held.ast;
    if (ast._tag !== "Declaration" || ast.encoding === undefined)
      throw new Error("expected an unwrapping Option");
    const invalid = [
      new SchemaAST.Declaration(
        ast.typeParameters,
        ast.run,
        undefined,
        ast.checks,
        ast.encoding,
      ),
      new SchemaAST.Declaration(
        [Either.ast],
        ast.run,
        ast.annotations,
        ast.checks,
        ast.encoding,
      ),
      new SchemaAST.Declaration(
        ast.typeParameters,
        ast.run,
        ast.annotations,
        ast.checks,
        [ast.encoding[0], ast.encoding[0]],
      ),
    ];
    const input = Option.some(extra);
    for (const declaration of invalid)
      expect(Excess.normalisedOptions(declaration, input)).toBe(input);
    expect(Excess.normalisedOptions(Held.ast, { value: extra })).toEqual({
      value: extra,
    });
  });

  it("does not drop array metadata or read a non-enumerable payload field", () => {
    const list = Object.assign([{ ...extra }], { note: "keep" });
    Object.defineProperty(list[0]!, "hidden", { value: "kept" });
    const input = Option.some(list);
    const output = Excess.normalisedOptions(
      Schema.OptionFromNullOr(Schema.Array(Payload)).ast,
      input,
    );
    expect(Option.isOption(output) && Option.isSome(output)).toBe(true);
    if (
      !Option.isOption(output) ||
      !Option.isSome(output) ||
      !Array.isArray(output.value)
    )
      throw new Error("expected Some array");
    expect(Object.getOwnPropertyDescriptor(output.value, "note")?.value).toBe(
      "keep",
    );
    expect(
      Object.getOwnPropertyDescriptor(output.value[0] as object, "hidden")
        ?.value,
    ).toBe("kept");
  });

  it("reports fields the read or the loose write lost at the payload's own path", () => {
    const HeldWide = Schema.OptionFromNullOr(Either);
    const input = Option.some({ a: "inner", b: "b" });
    expect(
      Excess.optionLoss(
        HeldWide.ast,
        input,
        input,
        { a: "inner" },
        { checkWrite: true },
      ),
    ).toEqual([["value", "b"]]);
    expect(
      Excess.optionLoss(
        HeldWide.ast,
        input,
        Option.some({ a: "outer", b: "b" }),
        { a: "outer", b: "b" },
      ),
    ).toEqual([["value", "a"]]);
  });

  it("sees an Option wrapper only when all views agree about its codec", () => {
    const schema = Schema.Union([
      Schema.Struct({ held: Held }),
      Schema.Struct({ held: Schema.Option(Payload) }),
    ]);
    const input = { held: Option.some(extra) };
    expect(Excess.normalisedOptions(schema.ast, input)).toBe(input);
  });
});

describe("boundaries of a visible Some payload", () => {
  const Struct = Schema.Struct({ a: Schema.String });
  const input = Option.some({ a: "a", stray: "x" });

  it("requires matching payload bodies even with an actual Effect unwrapping getter", () => {
    const option = Schema.OptionFromOptionalKey(Struct).ast;
    const fields = Struct.ast;
    if (
      option._tag !== "Declaration" ||
      option.encoding === undefined ||
      fields._tag !== "Objects"
    )
      throw new Error("expected a struct and an unwrapping declaration");
    const { to, transformation } = option.encoding[0];
    const extra = Schema.Struct({ a: Schema.String, stray: Schema.String }).ast;
    const rest = Schema.Record(Schema.String, Schema.String).ast;
    if (extra._tag !== "Objects" || rest._tag !== "Objects")
      throw new Error("expected an object shape");
    for (const source of [
      Struct.pipe(Schema.annotateKey({ description: "required source" })).ast,
      Schema.optionalKey(Struct.annotate({ description: "other source" })).ast,
      Schema.optionalKey(Struct.check(Schema.makeFilter(() => true))).ast,
      new SchemaAST.Objects(
        extra.propertySignatures,
        fields.indexSignatures,
        undefined,
        undefined,
        undefined,
        to.context,
      ),
      new SchemaAST.Objects(
        fields.propertySignatures,
        rest.indexSignatures,
        undefined,
        undefined,
        undefined,
        to.context,
      ),
    ]) {
      const declaration = new SchemaAST.Declaration(
        option.typeParameters,
        option.run,
        option.annotations,
        option.checks,
        [new SchemaAST.Link(source, transformation)],
      );
      expect(Excess.mayUnwrapOption(declaration)).toBe(false);
      expect(Excess.normalisedOptions(declaration, input)).toBe(input);
    }
    const invalid = new SchemaAST.Declaration(
      [...option.typeParameters, Schema.String.ast],
      option.run,
      option.annotations,
      option.checks,
      option.encoding,
    );
    expect(Excess.mayUnwrapOption(invalid)).toBe(false);
  });

  it("requires the same union members and selection mode when a source key is optional", () => {
    const payload = Schema.Union([Struct, Schema.Struct({ b: text })]);
    const option = Schema.OptionFromOptionalKey(payload).ast;
    if (
      option._tag !== "Declaration" ||
      option.encoding === undefined ||
      payload.ast._tag !== "Union"
    )
      throw new Error("expected a union payload");
    const { to, transformation } = option.encoding[0];
    for (const source of [
      new SchemaAST.Union(
        [Struct.ast, Schema.Struct({ c: text }).ast],
        payload.ast.options,
        undefined,
        undefined,
        undefined,
        to.context,
      ),
      new SchemaAST.Union(
        payload.ast.types,
        { mode: "oneOf" },
        undefined,
        undefined,
        undefined,
        to.context,
      ),
    ]) {
      const declaration = new SchemaAST.Declaration(
        option.typeParameters,
        option.run,
        option.annotations,
        option.checks,
        [new SchemaAST.Link(source, transformation)],
      );
      expect(Excess.mayUnwrapOption(declaration)).toBe(false);
      expect(Excess.normalisedOptions(declaration, input)).toBe(input);
    }
  });

  it("does not look through a custom codec on a nullish Option source", () => {
    const option = Schema.OptionFromNullOr(Struct).ast;
    if (option._tag !== "Declaration" || option.encoding === undefined)
      throw new Error("expected an unwrapping declaration");
    const source = Schema.NullOr(Struct).pipe(
      Schema.middlewareEncoding((effect) => effect),
    );
    const declaration = new SchemaAST.Declaration(
      option.typeParameters,
      option.run,
      option.annotations,
      option.checks,
      [new SchemaAST.Link(source.ast, option.encoding[0].transformation)],
    );
    expect(Excess.mayUnwrapOption(declaration)).toBe(false);
    expect(Excess.normalisedOptions(declaration, input)).toBe(input);
  });

  it("requires a transformation even when middleware carries a familiar getter", () => {
    const option = Schema.OptionFromOptionalKey(Struct).ast;
    if (option._tag !== "Declaration" || option.encoding === undefined)
      throw new Error("expected an unwrapping declaration");
    const encode = Object.assign(<T>(effect: T): T => effect, {
      _tag: "TransformOptional",
      transform: Option.flatten,
    });
    const declaration = new SchemaAST.Declaration(
      option.typeParameters,
      option.run,
      option.annotations,
      option.checks,
      [
        new SchemaAST.Link(
          option.encoding[0].to,
          new SchemaTransformation.Middleware(encode, encode),
        ),
      ],
    );
    expect(Excess.mayUnwrapOption(declaration)).toBe(false);
  });

  it("keeps two object alternatives even when one is the Option's exact wire projection", () => {
    const option = Schema.OptionFromNullOr(Struct);
    const schema = Schema.Union([option, Schema.toEncoded(option)]);
    expect(Excess.normalisedOptions(schema.ast, input)).toBe(input);
  });

  it("does not follow an input cycle during normalization or loss comparison", () => {
    interface Node {
      a: string;
      next: Node;
    }
    const Node = Schema.suspend((): Schema.Codec<Node> =>
      Schema.Struct({ a: Schema.String, next: Node }),
    );
    const option = Schema.OptionFromNullOr(Node);
    const payload = { a: "a" } as Node;
    payload.next = payload;
    const some = Option.some(payload);
    expect(Excess.normalisedOptions(option.ast, some)).toBe(some);
    expect(
      Excess.optionLoss(option.ast, some, some, payload, { checkWrite: true }),
    ).toEqual([]);
  });

  it("does not follow a schema cycle at the same value", () => {
    const recursive: SchemaAST.Suspend = new SchemaAST.Suspend(() => recursive);
    expect(Excess.normalisedOptions(recursive, input)).toBe(input);
    expect(Excess.normalisedOptions(recursive, { a: "a" })).toEqual({ a: "a" });
  });

  it("reports an object payload field lost by the read even if the wire name exists", () => {
    const option = Schema.OptionFromNullOr(
      Schema.Struct({ nested: Schema.Unknown }),
    );
    const nested = { x: "x" };
    expect(
      Excess.optionLoss(option.ast, Option.some({ nested }), Option.some({}), {
        nested,
      }),
    ).toEqual([["value", "nested"]]);
  });

  it("leaves a suspension under an opaque codec unresolved at binding time", () => {
    let resolved = false;
    const suspended = Schema.suspend(() => {
      resolved = true;
      return Schema.OptionFromNullOr(Struct);
    });
    expect(Excess.mayUnwrapOption(Schema.Option(suspended).ast)).toBe(false);
    expect(Excess.mayUnwrapOption(suspended.ast)).toBe(true);
    expect(resolved).toBe(false);
  });
});

describe("accounting for written Some fields", () => {
  const Owner = Schema.Struct({ owner: Schema.String });

  it("leaves unrelated fields and non-plain payloads to their own reading", () => {
    const schema = Schema.Struct({
      bare: Owner,
      held: Schema.OptionFromNullOr(
        Schema.Struct({
          ...Owner.fields,
          limit: Schema.optionalKey(Schema.String),
        }),
      ),
    });
    const held = Option.some({ owner: "a" });
    const output = { held: { owner: "a" } };
    const assertKept = (given: unknown) =>
      expect(
        Excess.optionLoss(schema.ast, given, { held }, output, {
          checkWrite: true,
        }),
      ).toEqual([]);
    assertKept({ bare: { owner: "b" }, held });
    assertKept({
      held: Option.some({ owner: "a", limit: undefined, stray: "x" }),
    });
    assertKept({ held: { value: { owner: "b" } } });
    assertKept({
      held: Object.assign(Option.some({ owner: "b" }), { note: "keep" }),
    });
    assertKept({
      held: Option.some(
        Object.assign(Object.create({ inherited: true }) as object, {
          owner: "b",
        }),
      ),
    });
  });

  it("allows None to omit a wire key and a codec to change a scalar's representation", () => {
    const schema = Schema.OptionFromNullOr(
      Schema.Struct({
        option: Schema.OptionFromOptionalKey(Schema.String),
        size: Schema.NumberFromString,
        owner: Schema.String,
      }).pipe(Schema.encodeKeys({ size: "SIZE" })),
    );
    const input = Option.some({ option: Option.none(), size: 5, owner: "a" });
    expect(
      Excess.optionLoss(
        schema.ast,
        input,
        input,
        { SIZE: "5", owner: "a" },
        { checkWrite: true },
      ),
    ).toEqual([]);
    expect(
      Excess.optionLoss(
        schema.ast,
        input,
        input,
        { owner: "a" },
        { checkWrite: true },
      ),
    ).toEqual([["value", "size"]]);
  });

  it("keeps a list's null prototype when copying a cell's payload", () => {
    const schema = Schema.OptionFromNullOr(Schema.Array(Owner));
    const list = [{ owner: "a", stray: "x" }];
    Object.setPrototypeOf(list, null);
    const result = Excess.normalisedOptions(schema.ast, Option.some(list));
    if (!Option.isOption(result) || !Option.isSome(result))
      throw new Error("expected Some");
    expect(Object.getPrototypeOf(result.value as object)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(result.value, "0")?.value).toEqual({
      owner: "a",
    });
  });

  it("leaves alternative unwrapping codecs and middleware to their own reading", () => {
    const input = Option.some({ owner: "a", stray: "x" });
    const schema = Schema.Union([
      Schema.OptionFromNullOr(Owner),
      Schema.OptionFromNullOr(
        Schema.Struct({ owner: Schema.String, limit: Schema.String }),
      ),
    ]);
    expect(Excess.normalisedOptions(schema.ast, input)).toBe(input);
    const union = Schema.Union([
      Owner,
      Schema.Struct({ limit: Schema.String }),
    ]).pipe(Schema.middlewareEncoding((effect) => effect));
    expect(
      Excess.normalisedOptions(Schema.OptionFromNullOr(union).ast, input),
    ).toBe(input);
  });
});

it("keeps an object unchanged at an array-only payload position", () => {
  const schema = Schema.OptionFromNullOr(Schema.Array(Schema.String));
  const input = Option.some({ stray: "x" });
  expect(Excess.normalisedOptions(schema.ast, input)).toBe(input);
});

it("leaves a union with its own encoding opaque to the Option pre-pass", () => {
  const union = Schema.Union([
    Schema.OptionFromNullOr(Either),
    Schema.String,
  ]).pipe(Schema.middlewareEncoding((effect) => effect));
  expect(Excess.mayUnwrapOption(union.ast)).toBe(false);
});

it("requires a constructor before using a class declaration's fields", () => {
  class Item extends Schema.Class<Item>("Item")({
    held: Schema.OptionFromNullOr(Either),
  }) {}
  const ast = Item.ast;
  if (ast._tag !== "Declaration") throw new Error("expected class declaration");
  const typeWithoutConstructor = new SchemaAST.Declaration(
    ast.typeParameters,
    ast.run,
    { ...ast.annotations, "~constructor": undefined },
    ast.checks,
    ast.encoding,
  );
  const input = { held: Option.some({ a: "a", stray: "x" }) };
  expect(Excess.normalisedOptions(typeWithoutConstructor, input)).toBe(input);
  expect(Excess.mayUnwrapOption(typeWithoutConstructor)).toBe(false);
});

it("allows None to omit a field only where a visible codec unwraps it", () => {
  const schema = Schema.OptionFromNullOr(
    Schema.Struct({
      visible: Schema.OptionFromOptionalKey(Schema.String),
      opaque: Schema.Option(Schema.String),
    }),
  );
  const input = Option.some({ visible: Option.none(), opaque: Option.none() });
  expect(
    Excess.optionLoss(schema.ast, input, input, {}, { checkWrite: true }),
  ).toEqual([["value", "opaque"]]);
});

it("requires a single written candidate to hold every child", () => {
  const child = Schema.Struct({ a: Schema.String, b: Schema.String });
  const first = Schema.Struct({ kid: child });
  const second = first.pipe(Schema.encodeKeys({ kid: "child" }));
  const schema = Schema.OptionFromNullOr(Schema.Union([first, second]));
  const value = { a: "a", b: "b" };
  const some = Option.some({ kid: value });
  const lost = (output: unknown) =>
    Excess.optionLoss(schema.ast, some, some, output, { checkWrite: true });

  expect(lost({ child: { a: "a" } })).toEqual([["value", "kid", "b"]]);
  expect(lost({ kid: { a: "a" }, child: value })).toEqual([]);
  expect(lost({ kid: { a: "a" }, child: { b: "b" } })).toEqual([
    ["value", "kid", "b"],
  ]);
});

it("distinguishes a scalar from another field that can write its wire name", () => {
  const first = Schema.Struct({ limit: Schema.String }).pipe(
    Schema.encodeKeys({ limit: "page_size" }),
  );
  const second = Schema.Struct({ page_size: Schema.String });
  const schema = Schema.OptionFromNullOr(Schema.Union([first, second]));
  const some = Option.some({ limit: "caller" });
  const output = { page_size: "other" };
  expect(
    Excess.optionLoss(schema.ast, some, some, output, { checkWrite: true }),
  ).toEqual([["value", "limit"]]);
  expect(Excess.optionLoss(schema.ast, some, some, output)).toEqual([]);
});

it("lets a scalar codec change its representation at a shared wire name", () => {
  const first = Schema.Struct({ limit: Schema.NumberFromString }).pipe(
    Schema.encodeKeys({ limit: "page_size" }),
  );
  const second = Schema.Struct({ page_size: Schema.String });
  const schema = Schema.OptionFromNullOr(Schema.Union([first, second]));
  const input = Option.some({ limit: 5 });
  expect(
    Excess.optionLoss(
      schema.ast,
      input,
      input,
      { page_size: "5" },
      { checkWrite: true },
    ),
  ).toEqual([]);
});

it("does not pair a reordered wire name by position after a loose write", () => {
  const field = Schema.optionalKey(Schema.String);
  const payload = Schema.Struct({ a: field, b: field }).pipe(
    Schema.encodeKeys({ b: "0" }),
  );
  const schema = Schema.OptionFromNullOr(payload);
  const input = Option.some({ b: "2" });
  expect(
    Excess.optionLoss(
      schema.ast,
      input,
      input,
      { "0": "2" },
      { checkWrite: true },
    ),
  ).toEqual([]);
});

it("does not pair a reordered decoded name from a handwritten link", () => {
  const field = Schema.optionalKey(Schema.String);
  const payload = Schema.Struct({ B: field, zero: field }).pipe(
    Schema.decodeTo(
      Schema.Struct({ b: field, 0: field }),
      SchemaTransformation.transform({
        decode: ({ B, zero }) => ({
          ...(B === undefined ? {} : { b: B }),
          ...(zero === undefined ? {} : { 0: zero }),
        }),
        encode: (value) => ({
          ...(value.b === undefined ? {} : { B: value.b }),
          ...(value[0] === undefined ? {} : { zero: value[0] }),
        }),
      }),
    ),
  );
  const schema = Schema.OptionFromNullOr(payload);
  const b = Option.some({ b: "bee" });
  const zero = Option.some({ 0: "zed" });
  expect(
    Excess.optionLoss(schema.ast, b, b, { B: "bee" }, { checkWrite: true }),
  ).toEqual([]);
  expect(
    Excess.optionLoss(
      schema.ast,
      zero,
      zero,
      { zero: "zed" },
      { checkWrite: true },
    ),
  ).toEqual([]);
});

it("stops the loose comparison at Schema.Option", () => {
  const owner = Schema.Struct({ owner: text });
  const wide = Schema.Struct({ owner: text, limit: text }).pipe(
    Schema.encodeKeys({ limit: "page_size" }),
  );
  const schema = Schema.Option(Schema.Union([owner, wide]));
  const given = Option.some({ owner: "a", page_size: "5" });
  const narrowed = Option.some({ owner: "a" });
  expect(Excess.mayWriteUnwrappedOption(schema.ast)).toBe(false);
  expect(
    Excess.optionLoss(schema.ast, given, narrowed, undefined, {
      checkWrite: true,
    }),
  ).toEqual([]);
});

it("recognizes built-in unwrapping getters without running a custom getter", () => {
  const OptionalNull = Schema.optional(Schema.NullOr(text));
  const custom = OptionalNull.pipe(
    Schema.decodeTo(
      Schema.Option(text),
      SchemaTransformation.transformOptional({
        decode: () => Option.some(Option.some("custom")),
        encode: () => {
          throw new Error("preparation invoked a custom getter");
        },
      }),
    ),
  );
  // It is not one of Effect's codecs, but the writer follows it into its payload, as it follows a
  // hand-written codec that writes a value (#364). Neither reading runs its getter.
  expect(Excess.mayUnwrapOption(custom.ast)).toBe(false);
  expect(Excess.mayWriteUnwrappedOption(custom.ast)).toBe(true);
  for (const codec of [
    Schema.OptionFromOptional(text),
    Schema.OptionFromNullishOr(text),
    Schema.OptionFromNullishOr(text, { onNoneEncoding: null }),
    Schema.OptionFromOptionalNullOr(text, { onNoneEncoding: null }),
    Schema.OptionFromOptionalNullOr(text, { onNoneEncoding: undefined }),
  ]) {
    expect(Excess.mayWriteUnwrappedOption(codec.ast)).toBe(true);
  }
});

it("compares configured unwrapping codecs on the loose route", () => {
  const payload = Schema.Union([
    Schema.Struct({ a: Schema.String }),
    Schema.Struct({ a: Schema.String, b: Schema.String }),
  ]);
  const schema = Schema.OptionFromNullOr(
    Schema.Struct({
      inner: Schema.OptionFromOptionalNullOr(payload, { onNoneEncoding: null }),
    }),
  );
  const given = Option.some({ inner: Option.some({ a: "a", b: "b" }) });
  const narrowed = Option.some({ inner: Option.some({ a: "a" }) });
  const written = { inner: { a: "a" } };
  expect(Excess.optionLoss(schema.ast, given, narrowed, written)).toEqual([]);
  expect(
    Excess.optionLoss(schema.ast, given, narrowed, written, {
      checkWrite: true,
    }),
  ).toEqual([["value", "inner", "value", "b"]]);
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/334
it("compares a hand-written codec's read after a strict write, never what it writes", () => {
  const payload = Either;
  const handWritten = Schema.NullOr(payload).pipe(
    Schema.decodeTo(
      Schema.Option(payload),
      SchemaTransformation.transform<
        Option.Option<typeof payload.Type>,
        typeof payload.Type | null
      >({
        decode: Option.fromNullOr,
        encode: (value) => Option.getOrElse(value, () => null),
      }),
    ),
  );
  const schema = Schema.Struct({ held: handWritten });
  const given = { held: Option.some({ a: "a", b: "b" }) };
  const narrowed = { held: Option.some({ a: "a" }) };
  expect(Excess.optionLoss(schema.ast, given, narrowed, {})).toEqual([]);
  expect(
    Excess.optionLoss(
      schema.ast,
      given,
      narrowed,
      {},
      { codecsWithoutSource: true },
    ),
  ).toEqual([["held", "value", "b"]]);
  // What the read kept is not checked against what the codec wrote.
  expect(
    Excess.optionLoss(
      schema.ast,
      given,
      given,
      { held: {} },
      { codecsWithoutSource: true },
    ),
  ).toEqual([]);
  // Effect's own codecs keep the comparison their recognition gives: a configured codec is
  // recognised on a loose read only.
  const configured = Schema.Struct({
    held: Schema.OptionFromOptionalNullOr(payload, { onNoneEncoding: null }),
  });
  expect(
    Excess.optionLoss(
      configured.ast,
      given,
      narrowed,
      {},
      { codecsWithoutSource: true },
    ),
  ).toEqual([]);
  // The JSON codec of a built-in one whose payload has a JSON form of its own, such as a Date's,
  // puts another payload schema on the wire. Only the writer follows it, as it follows a
  // hand-written codec, where the built-in codec itself is compared on every route.
  const Dated = Schema.Union([
    Schema.Struct({ a: text, when: Schema.Date }),
    Schema.Struct({ a: text, when: Schema.Date, b: text }),
  ]);
  const when = new Date(0);
  const dated = { held: Option.some({ a: "a", when, b: "b" }) };
  const narrowedDated = { held: Option.some({ a: "a", when }) };
  const builtIn = Schema.Struct({ held: Schema.OptionFromNullOr(Dated) });
  expect(Excess.optionLoss(builtIn.ast, dated, narrowedDated, {})).toEqual([
    ["held", "value", "b"],
  ]);
  for (const json of [
    Schema.Struct({ held: Schema.toCodecJson(Schema.OptionFromNullOr(Dated)) }),
    Schema.toCodecJson(builtIn),
  ]) {
    expect(Excess.optionLoss(json.ast, dated, narrowedDated, {})).toEqual([]);
    expect(
      Excess.optionLoss(
        json.ast,
        dated,
        narrowedDated,
        {},
        { codecsWithoutSource: true },
      ),
    ).toEqual([["held", "value", "b"]]);
  }
});

const handWritten = <S extends Schema.Top>(payload: S) =>
  Schema.NullOr(payload).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(payload)),
      SchemaTransformation.transform<
        Option.Option<S["Type"]>,
        S["Type"] | null
      >({
        decode: Option.fromNullOr,
        encode: (value) => Option.getOrElse(value, () => null),
      }),
    ),
  );

/** A struct whose field is a hand-written codec over a struct holding `inner`. */
const holding = (inner: Schema.Top) =>
  Schema.Struct({ held: handWritten(Schema.Struct({ inner })) }).ast;

// https://github.com/viell-dev/slop-effect-schema-http/issues/364
it("follows a hand-written codec that can omit its key as one that writes a value", () => {
  const omitting = Schema.optionalKey(Either).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(Either)),
      SchemaTransformation.transformOptional<
        Option.Option<typeof Either.Type>,
        typeof Either.Type
      >({
        decode: Option.some,
        encode: (value) => Option.flatMap(value, (some) => some),
      }),
    ),
  );
  if (omitting.ast._tag !== "Declaration")
    throw new Error("expected a declaration");
  // The writer finds the payload where the codec writes it: the optional copy of it on the wire.
  expect(Excess.writtenOptionSource(omitting.ast)).toBe(
    omitting.ast.encoding?.[0]?.to,
  );
  const schema = Schema.Struct({ held: omitting });
  const given = { held: Option.some({ a: "a", b: "b" }) };
  const narrowed = { held: Option.some({ a: "a" }) };
  expect(
    Excess.optionLoss(
      schema.ast,
      given,
      narrowed,
      {},
      { codecsWithoutSource: true },
    ),
  ).toEqual([["held", "value", "b"]]);
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/364
it("compares what a renamed struct holding a codec that can omit its key wrote, apart from that codec", () => {
  const omitting = Schema.optional(Either).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(Either)),
      SchemaTransformation.transformOptional<
        Option.Option<typeof Either.Type>,
        typeof Either.Type | undefined
      >({
        decode: (value) =>
          Option.some(Option.flatMap(value, Option.fromUndefinedOr)),
        encode: (value) => Option.flatMap(value, (some) => some),
      }),
    ),
  );
  // Its wire key is optional, so the rename is a frame and pairs its names, as for the built-in
  // codecs that can omit theirs.
  const schema = Schema.Struct({
    held: Schema.OptionFromNullOr(
      Schema.Struct({ inner: omitting, other: text, n: text }).pipe(
        Schema.encodeKeys({ n: "wire_n" }),
      ),
    ),
  });
  const given = {
    held: Option.some({ inner: Option.none(), other: "o", n: "n" }),
  };
  const loss = (written: object) =>
    Excess.optionLoss(schema.ast, given, given, written, { checkWrite: true });
  expect(loss({ held: { other: "o", wire_n: "n" } })).toEqual([]);
  expect(loss({ held: { wire_n: "n" } })).toEqual([["held", "value", "other"]]);
  expect(loss({ held: { other: "o", n: "n" } })).toEqual([
    ["held", "value", "n"],
  ]);
  // What the codec writes is its own: its key can be missing for a Some too.
  const some = {
    held: Option.some({ inner: Option.some({ a: "a" }), other: "o", n: "n" }),
  };
  expect(
    Excess.optionLoss(
      schema.ast,
      some,
      some,
      { held: { other: "o", wire_n: "n" } },
      {
        checkWrite: true,
      },
    ),
  ).toEqual([]);
});

/** A hand-written codec over `Schema.optional(payload)`, which can omit its key. */
const omittingOver = <S extends Schema.Top>(payload: S) =>
  Schema.optional(payload).pipe(
    Schema.decodeTo(
      Schema.Option(Schema.toType(payload)),
      SchemaTransformation.transformOptional<
        Option.Option<S["Type"]>,
        S["Type"] | undefined
      >({
        decode: (value) =>
          Option.some(Option.flatMap(value, Option.fromUndefinedOr)),
        encode: (value) => Option.flatMap(value, (some) => some),
      }),
    ),
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/386
it("takes a codec's missing Some as its own only where every member states its field", () => {
  const omitting = omittingOver(Either);
  const n = { n: text };
  const written = { held: { n: "n" } };
  const loss = (members: ReadonlyArray<Schema.Top>, inner: unknown) => {
    const given = { held: Option.some({ n: "n", inner }) };
    return Excess.optionLoss(
      Schema.Struct({ held: Schema.OptionFromNullOr(Schema.Union(members)) })
        .ast,
      given,
      given,
      written,
      { checkWrite: true },
    );
  };
  // A narrower member that does not state `inner` may have written the struct, without the codec.
  const narrowFirst = [
    Schema.Struct(n),
    Schema.Struct({ ...n, inner: omitting }),
  ] as const;
  expect(loss(narrowFirst, Option.some({ a: "a" }))).toEqual([
    ["held", "value", "inner"],
  ]);
  // A None holds nothing a member could lose.
  expect(loss(narrowFirst, Option.none())).toEqual([]);
  const bothState = [
    Schema.Struct({ ...n, inner: omitting, k: Schema.optionalKey(text) }),
    Schema.Struct({ ...n, inner: omitting }),
  ] as const;
  expect(loss(bothState, Option.some({ a: "a" }))).toEqual([]);
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/364
it("leaves nothing out below a rename that only a codec without a source makes a frame", () => {
  const renamed = (tag: string, held: Schema.Top) =>
    Schema.Struct({ tag: Schema.Literal(tag), held, n: text }).pipe(
      Schema.encodeKeys({ n: "wire_n" }),
    );
  const omitting = renamed("a", omittingOver(Either));
  const builtIn = renamed("a", Schema.OptionFromOptional(Either));
  const other = Schema.Struct({ tag: Schema.Literal("b"), b: text });
  const given = Option.some({ tag: "a", held: Option.none(), n: "n", x: 1 });
  expect(
    Excess.normalisedOptions(Schema.OptionFromNullOr(omitting).ast, given),
  ).toBe(given);
  // A built-in codec that can omit its key made the rename a frame before, and still does.
  expect(
    Excess.normalisedOptions(Schema.OptionFromNullOr(builtIn).ast, given),
  ).toEqual(Option.some({ tag: "a", held: Option.none(), n: "n" }));
  // A member whose tag rules it out still keeps the union unknown, as before such a codec made it
  // a frame, so the stray key beside the member that reads the value stays too.
  const besideOther = Option.some({ tag: "b", b: "b", x: 1 });
  expect(
    Excess.normalisedOptions(
      Schema.OptionFromNullOr(Schema.Union([omitting, other])).ast,
      besideOther,
    ),
  ).toBe(besideOther);
  expect(
    Excess.normalisedOptions(
      Schema.OptionFromNullOr(Schema.Union([builtIn, other])).ast,
      besideOther,
    ),
  ).toEqual(Option.some({ tag: "b", b: "b" }));
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/347
it("compares a codec inside a hand-written codec's decoded payload, never a Schema.Option there", () => {
  const given = {
    held: Option.some({ inner: Option.some({ a: "a", b: "b" }) }),
  };
  const narrowed = { held: Option.some({ inner: Option.some({ a: "a" }) }) };
  for (const inner of [Schema.OptionFromNullOr(Either), handWritten(Either)])
    expect(
      Excess.optionLoss(
        holding(inner),
        given,
        narrowed,
        {},
        {
          codecsWithoutSource: true,
        },
      ),
    ).toEqual([["held", "value", "inner", "value", "b"]]);
  // A codec's decoded side given as a schema of its own, without the codec in the same payload, reads
  // as Schema.Option does.
  for (const inner of [
    Schema.Option(Either),
    Schema.toType(Schema.OptionFromNullOr(Either)),
  ])
    expect(
      Excess.optionLoss(
        holding(inner),
        given,
        narrowed,
        {},
        {
          codecsWithoutSource: true,
        },
      ),
    ).toEqual([]);
});

it("uses another written name when only one candidate shares its name", () => {
  const first = Schema.Struct({ code: Schema.String }).pipe(
    Schema.encodeTo(
      Schema.Struct({ CODE: Schema.String }),
      SchemaTransformation.transform({
        decode: ({ CODE }) => ({ code: CODE.toLowerCase() }),
        encode: ({ code }) => ({ CODE: code.toUpperCase() }),
      }),
    ),
  );
  const other = Schema.Struct({ alias: Schema.String }).pipe(
    Schema.encodeKeys({ alias: "code" }),
  );
  const payload = Schema.Union([
    first,
    Schema.Struct({ code: Schema.String }),
    other,
  ]);
  const schema = Schema.OptionFromNullOr(payload);
  const value = Option.some({ code: "abc" });
  expect(
    Excess.optionLoss(
      schema.ast,
      value,
      value,
      { CODE: "ABC" },
      { checkWrite: true },
    ),
  ).toEqual([]);
});

it("accounts for each list cell when a loose Option write omits it", () => {
  const schema = Schema.OptionFromNullOr(Schema.Array(Schema.String));
  const input = Option.some(["given"]);
  expect(
    Excess.optionLoss(schema.ast, input, input, ["given"], {
      checkWrite: true,
    }),
  ).toEqual([]);
  expect(
    Excess.optionLoss(schema.ast, input, input, [], { checkWrite: true }),
  ).toEqual([["value", 0]]);
});

it("accepts the key a record retains beside a renamed alternative", () => {
  const renamed = Schema.Struct({ a: text }).pipe(
    Schema.encodeKeys({ a: "A" }),
  );
  const record = Schema.Record(Schema.String, Schema.String);
  const schema = Schema.OptionFromNullOr(Schema.Union([renamed, record]));
  const input = Option.some({ a: "given" });
  expect(
    Excess.optionLoss(
      schema.ast,
      input,
      input,
      { a: "given" },
      { checkWrite: true },
    ),
  ).toEqual([]);
});

it("distinguishes a missing null from an empty value held as undefined", () => {
  const schema = Schema.OptionFromNullOr(
    Schema.Struct({
      x: Schema.optionalKey(Schema.Union([Schema.Null, Schema.Void])),
    }),
  );
  const input = Option.some({ x: null });
  expect(Excess.optionLoss(schema.ast, input, Option.some({}), {})).toEqual([
    ["value", "x"],
  ]);
  expect(
    Excess.optionLoss(schema.ast, input, Option.some({ x: undefined }), {}),
  ).toEqual([]);
});

it("recognizes a native Option across suspension, encoding and recursive alternatives", () => {
  const Struct = Schema.Struct({ value: Schema.Struct({ a: text }) });
  const option = Schema.Option(Schema.Number);
  const suspended = Schema.suspend(() => option);
  const encoded = option.pipe(
    Schema.decodeTo(
      Struct,
      SchemaTransformation.transform({
        decode: () => ({ value: { a: "canonical" } }),
        encode: () => Option.none<number>(),
      }),
    ),
  );
  const recursive: SchemaAST.Suspend = new SchemaAST.Suspend(() => recursive);
  const input = Option.some({ a: "a", stray: "x" });

  for (const ast of [
    Schema.Union([suspended, Struct]).ast,
    encoded.ast,
    new SchemaAST.Union([recursive, option.ast, Struct.ast], undefined),
  ]) {
    expect(Excess.normalised([ast], input)).toBe(input);
  }
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/275
describe("Excess.refusal", () => {
  const Wire = Schema.Struct({ page_size: Schema.String, b: Schema.String });
  const failure = (value: unknown) =>
    Effect.runSync(
      Effect.flip(
        Schema.decodeUnknownEffect(Wire)(value, {
          errors: "all",
          onExcessProperty: "error",
          reportInput: true,
        }),
      ),
    );
  const message = (
    paths: readonly [Excess.Path, ...ReadonlyArray<Excess.Path>],
    causes?: ReadonlyArray<Excess.Cause>,
  ) => Excess.refusal(Wire.ast, paths, causes).message;

  it("names a field the schema cannot keep where nothing says why", () => {
    expect(message([["page_size"]])).toBe(
      'The schema cannot keep this field with the rest of the value\n  at ["page_size"]',
    );
    expect(message([[]])).toBe(
      "The schema cannot keep the content of this value",
    );
  });

  it("names a field with another reading's error, without its value", () => {
    const value = { page_size: 5, b: "kept", extra: "stray-value" };
    const error = failure(value);
    // The reading reported its input, so Effect's own message shows the value.
    expect(error.message).toContain("got 5");
    const named = message(
      [["page_size"]],
      [Excess.failureCause(error, [Wire.ast], value)],
    );
    expect(named).toBe('Expected string\n  at ["page_size"]');
    // A key the reading does not state says nothing of why a field is lost.
    expect(
      message([["extra"]], [Excess.failureCause(error, [Wire.ast], value)]),
    ).toBe(
      'The schema cannot keep this field with the rest of the value\n  at ["extra"]',
    );
  });

  it("names the field the reading's error is inside", () => {
    const Outer = Schema.Struct({ x: Wire });
    const value = { x: { page_size: "kept", b: 7 } };
    const error = Effect.runSync(
      Effect.flip(Schema.decodeUnknownEffect(Outer)(value)),
    );
    expect(
      Excess.refusal(
        Outer.ast,
        [["x"]],
        [Excess.failureCause(error, [Outer.ast], value)],
      ).message,
    ).toBe('Expected string\n  at ["x"]["b"]');
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/275
describe("Excess.readUnderOtherName", () => {
  const Filter = Schema.Struct({
    limit: Schema.optionalKey(Schema.FiniteFromString),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const Outer = Schema.Struct({ filter: Filter });
  const readUnder = (given: unknown, value: unknown) =>
    Excess.readUnderOtherName([Outer.ast], given, value, [
      ["filter", "page_size"],
      ["filter", "limit"],
    ]);

  it("finds a wire-named field the reading holds under its decoded name", () => {
    expect(
      readUnder({ filter: { page_size: "6" } }, { filter: { limit: 6 } }),
    ).toEqual([["filter", "page_size"]]);
  });

  it("finds nothing the reading did not read, or a field under both names", () => {
    expect(readUnder({ filter: { page_size: "6" } }, { filter: {} })).toEqual(
      [],
    );
    expect(readUnder({ filter: { limit: 5 } }, { filter: {} })).toEqual([]);
    expect(
      readUnder(
        { filter: { limit: 5, page_size: "6" } },
        { filter: { limit: 6 } },
      ),
    ).toEqual([]);
  });

  it("leaves such a field out only beside another reading's error", () => {
    const given = { extra: "x", filter: { page_size: "6" } };
    const Wire = Schema.Struct({ extra: Schema.Number, filter: Filter });
    const failure = Effect.runSync(
      Effect.flip(Schema.decodeUnknownEffect(Wire)(given)),
    );
    const paths = [["extra"], ["filter", "page_size"]] as const;
    const readPaths = [["filter", "page_size"]] as const;
    expect(
      Excess.refusal(
        Wire.ast,
        paths,
        [Excess.failureCause(failure, [Wire.ast], given)],
        readPaths,
      ).message,
    ).toBe('Expected number\n  at ["extra"]');
    // Without an error that explains the refusal, every lost field is named.
    const generic =
      "The schema cannot keep this field with the rest of the value";
    expect(Excess.refusal(Wire.ast, paths, [], readPaths).message).toBe(
      `${generic}\n  at ["extra"]\n${generic}\n  at ["filter"]["page_size"]`,
    );
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/275
describe("Excess.failureWithin", () => {
  it("takes the parts that name what the caller gave, under the names they gave", () => {
    const Wire = Schema.Struct({ limit: Schema.FiniteFromString }).pipe(
      Schema.encodeKeys({ limit: "page_size" }),
    );
    const Outer = Schema.Struct({ f: Wire, g: Wire, n: Schema.Number });
    const given = { f: { page_size: "many" }, g: { page_size: "x" } };
    const failure = Effect.runSync(
      Effect.flip(
        Schema.decodeUnknownEffect(Outer)(given, {
          errors: "all",
          reportInput: true,
        }),
      ),
    );
    // Effect names each field's own error by its decoded name, and reports `n` missing.
    expect(failure.message).toContain('at ["f"]["limit"]');
    expect(failure.message).toContain('Missing key\n  at ["n"]');
    const within = (places: ReadonlyArray<Excess.Path>) =>
      Excess.entriesError(
        Outer.ast,
        Excess.failureWithin(failure.issue, [Outer.ast], given, places),
      ).message;
    expect(within([[]])).toBe(
      'Expected a finite number\n  at ["f"]["page_size"]\nExpected a finite number\n  at ["g"]["page_size"]',
    );
    expect(within([["g"]])).toBe(
      'Expected a finite number\n  at ["g"]["page_size"]',
    );
  });
});
