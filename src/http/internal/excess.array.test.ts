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

  it("does not inspect prototypes when every position is own", () => {
    for (const stray of [false, true]) {
      const cell = stray
        ? { value: "kept", stray: "strip" }
        : { value: "kept" };
      const input = new Proxy([cell], {
        getPrototypeOf() {
          throw new Error("unnecessary prototype inspection");
        },
      });
      const result = normalised(input);
      expect(result.length).toBe(1);
      expect(result[0]).toEqual({ value: "kept" });
      if (!stray) expect(result).toBe(input);
    }
  });

  it("does not inspect array layout behind an opaque schema", () => {
    const input = new Proxy([{ value: "kept", stray: "opaque" }], {
      get(target, key, receiver) {
        if (key === "length") throw new Error("opaque length inspected");
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf() {
        throw new Error("opaque prototype inspected");
      },
    });
    expect(Excess.normalised([Schema.Unknown.ast], input)).toBe(input);
    expect(Excess.exposed([Schema.Unknown.ast], input)).toBe(input);
  });

  it("does not discover hidden or inherited cells through an opaque alternative", () => {
    for (const opaque of [
      Schema.Unknown,
      Schema.Any,
      Schema.ObjectKeyword,
      Schema.declare(Array.isArray),
    ]) {
      const schema = Schema.Union([opaque, List]);
      for (const inherited of [false, true]) {
        const cell = { value: "kept", stray: "opaque" };
        const input: Array<object> = [];
        input.length = 1;
        if (inherited)
          Object.setPrototypeOf(
            input,
            Object.create(Array.prototype, { "0": { value: cell } }),
          );
        else Object.defineProperty(input, "0", { value: cell });
        expect(Excess.normalised([schema.ast], input)).toBe(input);
        expect(Excess.exposed([schema.ast], input)).toBe(input);
        expect(input[0]).toBe(cell);
      }
    }
  });

  it("does not add array-layout reads to mixed opaque views", () => {
    for (const opaque of [
      Schema.Unknown,
      Schema.Any,
      Schema.ObjectKeyword,
      Schema.declare(Array.isArray),
    ]) {
      const schema = Schema.Union([opaque, List]);
      const target: Array<object> = [];
      target.length = 2;
      target[1] = { value: "kept" };
      Object.defineProperty(target, "0", {
        get() {
          throw new Error("opaque hidden position inspected");
        },
      });
      const input = new Proxy(target, {
        get(object, key, receiver) {
          if (key === "length") throw new Error("opaque length inspected");
          return Reflect.get(object, key, receiver);
        },
        getPrototypeOf() {
          throw new Error("opaque prototype inspected");
        },
      });
      expect(Excess.normalised([schema.ast], input)).toBe(input);
      expect(Excess.exposed([schema.ast], input)).toBe(input);
      expect(Excess.missing([schema.ast], input, input, input)).toEqual([]);
    }
  });

  it("does not read a mixed view's length getter when an enumerable child changes", () => {
    let checks = 0;
    const opaque = Schema.Unknown.check(
      Schema.makeFilter(() => {
        checks++;
        return false;
      }),
    );
    const schema = Schema.Union([opaque, List]);
    const input = new Proxy([{ value: "kept", stray: "strip" }], {
      get(object, key, receiver) {
        if (key === "length") throw new Error("opaque length inspected");
        return Reflect.get(object, key, receiver);
      },
    });
    const result = Excess.normalised([schema.ast], input) as Array<unknown>;
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({ value: "kept" });
    expect(checks).toBe(0);
  });

  it("uses a structural array's readable length rather than its descriptor", () => {
    const input = new Proxy([{ value: "kept", stray: "strip" }], {
      get(target, key, receiver) {
        return key === "length" ? 3 : Reflect.get(target, key, receiver);
      },
    });
    const result = normalised(input);
    expect(result.length).toBe(3);
    expect(result[0]).toEqual({ value: "kept" });
    expect(Object.hasOwn(result, "1")).toBe(false);
    expect(Object.hasOwn(result, "2")).toBe(false);
  });

  it("does not scan a million absent positions to retain a sparse layout", () => {
    const target: Array<object> = [];
    target.length = 1_000_000;
    target[500_000] = { value: "kept", stray: "strip" };
    let reads = 0;
    let enumerations = 0;
    const input = new Proxy(target, {
      get(object, key, receiver) {
        reads++;
        return Reflect.get(object, key, receiver);
      },
      has(object, key) {
        reads++;
        return Reflect.has(object, key);
      },
      ownKeys(object) {
        enumerations++;
        return Reflect.ownKeys(object);
      },
    });
    const result = normalised(input);
    expect(result).toHaveLength(1_000_000);
    expect(Object.hasOwn(result, "499999")).toBe(false);
    expect(Object.hasOwn(result, "500001")).toBe(false);
    expect(result[500_000]).toEqual({ value: "kept" });
    expect(reads).toBeLessThanOrEqual(12);
    expect(enumerations).toBeLessThanOrEqual(3);
    expect(target[500_000]).toHaveProperty("stray", "strip");
  });

  it("does not enlarge an incoherent proxy's array view", () => {
    const ghost = { value: "metadata" };
    const input = new Proxy([{ value: "kept", stray: "strip" }], {
      ownKeys(target) {
        return [...Reflect.ownKeys(target), "1000"];
      },
      getOwnPropertyDescriptor(target, key) {
        return key === "1000"
          ? {
              value: ghost,
              enumerable: true,
              configurable: true,
              writable: true,
            }
          : Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        return key === "1000" ? ghost : Reflect.get(target, key, receiver);
      },
    });
    expect(normalised(input)).toBe(input);
    expect(input.length).toBe(1);
    expect(Reflect.ownKeys(input)).toContain("1000");
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
