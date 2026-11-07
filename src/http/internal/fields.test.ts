import { describe, expect, it } from "@effect/vitest";
import * as Fields from "./fields.js";

const lowercase = (name: string) => name.toLowerCase();

describe("Fields.replace", () => {
  it("puts several values at the first position, together", () => {
    const fields: Fields.Fields = [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["b", "4"],
    ];
    expect(Fields.replace(fields, "b", ["x", "y"])).toEqual([
      ["a", "1"],
      ["b", "x"],
      ["b", "y"],
      ["c", "3"],
    ]);
  });

  it("appends values under a new name, in order", () => {
    expect(Fields.replace([["a", "1"]], "b", ["x", "y"])).toEqual([
      ["a", "1"],
      ["b", "x"],
      ["b", "y"],
    ]);
  });

  it("removes a name when given no values", () => {
    const fields: Fields.Fields = [
      ["a", "1"],
      ["b", "2"],
      ["a", "3"],
    ];
    expect(Fields.replace(fields, "a", [])).toEqual([["b", "2"]]);
    expect(Fields.replace(fields, "z", [])).toEqual(fields);
  });

  it("compares names through the fold and keeps the new spelling", () => {
    expect(
      Fields.replace([["X-A", "1"]], "x-a", ["2", "3"], lowercase),
    ).toEqual([
      ["x-a", "2"],
      ["x-a", "3"],
    ]);
  });
});

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

  // Query keys are case-sensitive; header combinators supply a fold.
  it("compares names exactly by default", () => {
    expect(Fields.set([["A", "1"]], "a", "2")).toEqual([
      ["A", "1"],
      ["a", "2"],
    ]);
  });

  it("compares folded names and takes the spelling it was given", () => {
    const fields: Fields.Fields = [
      ["X-A", "1"],
      ["b", "2"],
      ["x-a", "3"],
    ];
    expect(Fields.set(fields, "X-a", "new", lowercase)).toEqual([
      ["X-a", "new"],
      ["b", "2"],
    ]);
  });

  it("does not mutate its input", () => {
    const fields: Fields.Fields = [["a", "1"]];
    Fields.set(fields, "a", "2");
    Fields.set(fields, "b", "2");
    expect(fields).toEqual([["a", "1"]]);
  });
});

describe("written text", () => {
  const written: Fields.Fields<string | null> = [
    ["a", "b c", "a=b+c"],
    ["d", "e", "d=%65"],
  ];

  it("falls away from an entry that set replaces", () => {
    expect(Fields.set(written, "a", "new")).toEqual([
      ["a", "new"],
      ["d", "e", "d=%65"],
    ]);
  });

  it("stays on entries that append and remove leave alone", () => {
    expect(Fields.append(written, "a", "new")).toEqual([
      ...written,
      ["a", "new"],
    ]);
    expect(Fields.remove(written, "a")).toEqual([["d", "e", "d=%65"]]);
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

  it("compares folded names, with or without a value", () => {
    const mixed: Fields.Fields = [
      ["X-A", "1"],
      ["x-a", "2"],
      ["b", "3"],
    ];
    expect(Fields.remove(mixed, "x-A", undefined, lowercase)).toEqual([
      ["b", "3"],
    ]);
    expect(Fields.remove(mixed, "x-A", "1", lowercase)).toEqual([
      ["x-a", "2"],
      ["b", "3"],
    ]);
  });

  it("compares names exactly by default", () => {
    expect(Fields.remove([["A", "1"]], "a")).toEqual([["A", "1"]]);
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
