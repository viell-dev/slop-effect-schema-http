import { describe, expect, it } from "@effect/vitest";
import { Schema, SchemaTransformation } from "effect";
import * as Excess from "./excess.js";

const text = Schema.String;
const Either = Schema.Union([
  Schema.Struct({ a: text }),
  Schema.Struct({ a: text, b: text }),
]);

const read = (value: unknown) => Excess.normalised([Either.ast], value);

const gone = (given: object, value: object, output: object) =>
  Excess.missing([Either.ast], given, value, output).map(({ path }) => path);

describe("Excess.assume", () => {
  it("passes readings that hold", () => {
    expect(() => {
      Excess.assume({ "a reading": true });
    }).not.toThrow();
  });

  it("stops at a reading that does not, and names it", () => {
    expect(() => {
      Excess.assume({ "a reading": true, "another reading": false });
    }).toThrow(/cannot read this version of Effect.*another reading/);
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
    const Either = Schema.Union([
      Schema.instanceOf(Foo),
      Schema.Struct({ a: Schema.optionalKey(text) }),
    ]);
    const value = new Foo();
    expect(Excess.normalised([Either.ast], value)).toBe(value);
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
      Excess.missing(
        [Swapped.ast],
        { a: "1", b: "2" },
        { a: "1" },
        { b: "1" },
      ).map(({ path }) => path),
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
      ).map(({ path }) => path),
    ).toEqual([[1, "b"]]);
  });

  it("hands back what it cannot compare, with what can read it", () => {
    const InText = Schema.Struct({ filter: Schema.fromJsonString(Either) });
    const [found, ...others] = Excess.missing(
      [InText.ast],
      { filter: "{}" },
      { filter: {} },
      { filter: "{}" },
    );
    expect(others).toEqual([]);
    expect(found?.path).toEqual(["filter"]);
    expect(found?.value).toBe("{}");
    expect(found?.types).toHaveLength(1);
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
