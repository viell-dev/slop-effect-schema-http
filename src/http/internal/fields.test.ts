import { describe, expect, it } from "@effect/vitest";
import * as Fields from "./fields.js";

describe("Fields.set", () => {
  it("appends a new name", () => {
    expect(Fields.set([["a", "1"]], "b", "2")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("replaces at the first position and drops later entries of the name", () => {
    const fields: Fields.Fields = [
      ["a", "1"],
      ["b", "2"],
      ["a", "3"],
      ["c", "4"],
      ["a", "5"],
    ];
    expect(Fields.set(fields, "a", "x")).toEqual([
      ["a", "x"],
      ["b", "2"],
      ["c", "4"],
    ]);
  });

  it("compares names exactly", () => {
    expect(Fields.set([["A", "1"]], "a", "2")).toEqual([
      ["A", "1"],
      ["a", "2"],
    ]);
  });

  it("does not mutate its input", () => {
    const fields: Fields.Fields = [["a", "1"]];
    Fields.set(fields, "a", "2");
    Fields.set(fields, "b", "2");
    expect(fields).toEqual([["a", "1"]]);
  });
});

describe("Fields.append", () => {
  it("keeps existing entries and adds a repeated name at the end", () => {
    expect(
      Fields.append(
        [
          ["a", "1"],
          ["b", "2"],
        ],
        "a",
        "3",
      ),
    ).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["a", "3"],
    ]);
  });
});

describe("Fields.remove", () => {
  const fields: Fields.Fields = [
    ["a", "1"],
    ["b", "2"],
    ["a", "3"],
  ];

  it("removes every entry of a name without a value", () => {
    expect(Fields.remove(fields, "a")).toEqual([["b", "2"]]);
  });

  it("removes only static entries equal to the value", () => {
    expect(Fields.remove(fields, "a", "3")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("keeps computed entries when removing by value, without evaluating them", () => {
    let evaluated = 0;
    const computed = () => {
      evaluated++;
      return "3";
    };
    const result = Fields.remove(
      [
        ["a", computed],
        ["a", "3"],
      ],
      "a",
      "3",
    );
    expect(result).toEqual([["a", computed]]);
    expect(evaluated).toBe(0);
  });

  it("removes computed entries when removing the whole name", () => {
    expect(Fields.remove([["a", () => "1"]], "a")).toEqual([]);
  });

  it("matches a null value against bare query entries only", () => {
    const query: Fields.Fields<string | null> = [
      ["k", null],
      ["k", ""],
    ];
    expect(Fields.remove(query, "k", null)).toEqual([["k", ""]]);
    expect(Fields.remove(query, "k", "")).toEqual([["k", null]]);
  });
});

describe("Fields.resolve", () => {
  it("evaluates each computation once and preserves order and repetition", () => {
    let calls = 0;
    const resolved = Fields.resolve([
      ["a", "1"],
      [
        "b",
        () => {
          calls++;
          return `computed-${calls}`;
        },
      ],
      ["a", "2"],
    ]);
    expect(resolved).toEqual([
      ["a", "1"],
      ["b", "computed-1"],
      ["a", "2"],
    ]);
    expect(calls).toBe(1);
  });

  it("omits computations that produce undefined", () => {
    expect(
      Fields.resolve([
        ["a", () => undefined],
        ["b", "kept"],
      ]),
    ).toEqual([["b", "kept"]]);
  });

  it("keeps empty strings and null results", () => {
    expect(
      Fields.resolve<string | null>([
        ["empty", ""],
        ["bare", null],
        ["computedBare", () => null],
      ]),
    ).toEqual([
      ["empty", ""],
      ["bare", null],
      ["computedBare", null],
    ]);
  });

  it("propagates an exception from a computation", () => {
    expect(() =>
      Fields.resolve([
        [
          "a",
          () => {
            throw new Error("boom");
          },
        ],
      ]),
    ).toThrow("boom");
  });
});
