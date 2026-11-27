import { describe, expect, it } from "@effect/vitest";
import { mayHoldFieldless } from "./ambiguity.js";

// https://github.com/viell-dev/slop-effect-schema-http/issues/331
describe("mayHoldFieldless", () => {
  it("finds a fieldless object or list at any depth", () => {
    expect(mayHoldFieldless({})).toBe(true);
    expect(mayHoldFieldless([])).toBe(true);
    expect(mayHoldFieldless({ a: { b: [{ c: {} }] } })).toBe(true);
    expect(mayHoldFieldless({ a: 1, b: ["x", { c: 2 }] })).toBe(false);
    expect(mayHoldFieldless("text")).toBe(false);
    expect(mayHoldFieldless(null)).toBe(false);
  });

  it("reaches through keys that are not enumerable or are symbols, as a read does", () => {
    const hidden = Object.defineProperty({ a: 1 }, "hidden", {
      value: {},
      enumerable: false,
    });
    expect(mayHoldFieldless(hidden)).toBe(true);
    expect(mayHoldFieldless({ a: 1, [Symbol("s")]: {} })).toBe(true);
  });

  it("does not run a caller's getter", () => {
    let calls = 0;
    const value = {
      a: 1,
      get held() {
        calls++;
        return {};
      },
    };
    // The getter would hand back a fieldless object; a read does not run it either.
    expect(mayHoldFieldless(value)).toBe(false);
    expect(calls).toBe(0);
  });

  it("looks into an object that is not plain data through its own data fields", () => {
    class Box {
      constructor(readonly inner: unknown) {}
    }
    expect(mayHoldFieldless(new Box({}))).toBe(true);
    expect(mayHoldFieldless(new Box({ a: 1 }))).toBe(false);
    // A typed array counts as holding one without being looked into.
    expect(mayHoldFieldless({ a: new Uint8Array([1]) })).toBe(true);
  });

  it("finishes on a cycle and on a deep chain", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(mayHoldFieldless(cyclic)).toBe(false);
    let deep: unknown = { end: 1 };
    for (let at = 0; at < 100_000; at++) deep = { next: deep };
    expect(mayHoldFieldless(deep)).toBe(false);
  });
});
