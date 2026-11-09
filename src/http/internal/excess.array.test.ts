import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Excess from "./excess.js";

const Cell = Schema.Struct({ value: Schema.String });
const List = Schema.Array(Cell);
const normalised = (input: unknown) =>
  Excess.normalised([List.ast], input) as Array<unknown>;

// https://github.com/viell-dev/slop-effect-schema-http/issues/191
describe("array positions during input normalization", () => {
  it("keeps metadata separate from rewritten cells", () => {
    const metadata = { stray: "metadata" };
    const input = [{ value: "kept", stray: "strip" }];
    Object.defineProperty(input, "audit", {
      value: metadata,
      enumerable: true,
    });
    const result = normalised(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ value: "kept" });
    expect(Object.getOwnPropertyDescriptor(result, "audit")?.value).toBe(
      metadata,
    );
    expect(input[0]).toEqual({ value: "kept", stray: "strip" });
  });

  it("retains length and holes when a later cell changes", () => {
    const input: Array<object> = [];
    input.length = 4;
    input[1] = { value: "kept", stray: "strip" };
    const result = normalised(input);
    expect(result).toHaveLength(4);
    expect(Object.hasOwn(result, "0")).toBe(false);
    expect(Object.hasOwn(result, "2")).toBe(false);
    expect(Object.hasOwn(result, "3")).toBe(false);
    expect(result[1]).toEqual({ value: "kept" });
    expect(input).toHaveLength(4);
    expect(input[1]).toHaveProperty("stray", "strip");
  });

  for (const inherited of [false, true]) {
    it(`retains a ${inherited ? "inherited" : "hidden own"} earlier cell`, () => {
      const first = { value: "first" };
      const input: Array<object> = [];
      input.length = 2;
      input[1] = { value: "second", stray: "strip" };
      if (inherited)
        Object.setPrototypeOf(
          input,
          Object.create(Array.prototype, { "0": { value: first } }),
        );
      else Object.defineProperty(input, "0", { value: first });
      const result = normalised(input);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(first);
      expect(result[1]).toEqual({ value: "second" });
      expect(Object.hasOwn(input, "0")).toBe(!inherited);
      expect(Object.getOwnPropertyDescriptor(input, "0")?.enumerable).toBe(
        inherited ? undefined : false,
      );
    });
  }

  it("does not execute an iterator while rebuilding", () => {
    let calls = 0;
    const iterator = function* () {
      calls++;
      yield { value: "wrong" };
    };
    const input = [{ value: "kept", stray: "strip" }];
    Object.defineProperty(input, Symbol.iterator, {
      value: iterator,
      enumerable: true,
    });
    const result = normalised(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ value: "kept" });
    expect(
      Object.getOwnPropertyDescriptor(result, Symbol.iterator)?.value,
    ).toBe(iterator);
    expect(calls).toBe(0);
  });

  it("retains the original array when no cell needs rewriting", () => {
    const input: Array<object> = [];
    input.length = 3;
    Object.defineProperty(input, "1", { value: { value: "kept" } });
    Object.freeze(input);
    expect(normalised(input)).toBe(input);
    expect(Excess.exposed([List.ast], input)).toBe(input);
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/189
describe("array symbol keys", () => {
  it("keeps symbol identities without treating their values as cells", () => {
    const first = Symbol("audit");
    const second = Symbol("audit");
    const metadata = { stray: "metadata" };
    const input = [{ value: "kept", stray: "strip" }];
    Object.defineProperties(input, {
      [first]: { value: metadata, enumerable: true },
      [second]: { value: undefined, enumerable: true },
    });
    const result = normalised(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ value: "kept" });
    expect(Object.getOwnPropertyDescriptor(result, first)?.value).toBe(
      metadata,
    );
    expect(Object.hasOwn(result, second)).toBe(true);
    expect(Object.hasOwn(result, String(first))).toBe(false);
  });

  it("retains real symbol and string keys in loss diagnostics", () => {
    const first = Symbol("audit");
    const second = Symbol("audit");
    const input: Array<unknown> = [];
    Object.defineProperties(input, {
      [first]: { value: 1, enumerable: true },
      [second]: { value: 2, enumerable: true },
      audit: { value: 3, enumerable: true },
    });
    const lost = Excess.missing([List.ast], input, [], []);
    expect(lost).toEqual([["audit"], [first], [second]]);
    expect(lost[1]![0]).toBe(first);
    expect(lost[2]![0]).toBe(second);
    expect(() =>
      String(Excess.refusal(List.ast, [lost[0]!, ...lost.slice(1)])),
    ).not.toThrow();
  });

  it("preserves declared symbol fields on ordinary objects", () => {
    const key = Symbol("field");
    const schema = Schema.Struct({ [key]: Schema.String });
    const input = { [key]: "kept", stray: "strip" };
    expect(Excess.normalised([schema.ast], input)).toEqual({ [key]: "kept" });
    expect(Excess.missing([schema.ast], { [key]: "kept" }, {}, {})).toEqual([
      [key],
    ]);
  });
});
