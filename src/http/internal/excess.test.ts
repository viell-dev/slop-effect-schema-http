import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
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
});

describe("Excess.normalised", () => {
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
