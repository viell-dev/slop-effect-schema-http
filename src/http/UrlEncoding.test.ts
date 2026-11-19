import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runInNewContext } from "node:vm";
import * as UrlEncoding from "./UrlEncoding.js";

describe("UrlEncoding.queryEntries", () => {
  it("refuses a defined enumerable symbol key in a record", () => {
    expect(() =>
      UrlEncoding.queryEntries({ k: "v", [Symbol("extra")]: "keep" }),
    ).toThrow(
      new TypeError("The query field [Symbol(extra)] must have a string name"),
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/256
  it("refuses extra fields on value lists, pair lists and pairs", () => {
    expect(() =>
      UrlEncoding.queryEntries({ k: Object.assign(["v"], { extra: "keep" }) }),
    ).toThrow(
      new TypeError(
        'The query field "k" has an extra array field at $["extra"]',
      ),
    );
    expect(() =>
      UrlEncoding.queryEntries(
        Object.assign([["k", "v"]], { extra: "keep" }) as never,
      ),
    ).toThrow(
      new TypeError(
        'The field pairs list has an extra array field at $["extra"]',
      ),
    );
    expect(() =>
      UrlEncoding.queryEntries([
        Object.assign(["k", "v"], { extra: "keep" }),
      ] as never),
    ).toThrow(
      new TypeError(
        'The field pair "k" has an extra array field at $["extra"]',
      ),
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/255
  it("refuses unsupported values in records and pair groups", () => {
    const dateLookalike = Object.setPrototypeOf(
      { getTime: () => 0, toISOString: () => "date text" },
      Date.prototype,
    ) as object;
    for (const b of [
      { x: 1 },
      [{ x: 1 }],
      () => 1,
      Symbol("s"),
      [[1, 2]],
      Object("x") as object,
      Object(1) as object,
      Object(true) as object,
      Object(2n) as object,
      dateLookalike,
    ]) {
      const expected = new TypeError(
        'The query field "b" must encode a scalar value or a list of scalar values',
      );
      expect(() => UrlEncoding.queryEntries({ b } as never)).toThrow(expected);
      expect(() => UrlEncoding.queryEntries([["b", b]] as never)).toThrow(
        expected,
      );
    }
  });

  it("does not call conversion methods on unsupported objects", () => {
    let conversions = 0;
    const b = {
      [Symbol.toPrimitive]() {
        conversions++;
        return "text";
      },
    };
    expect(() => UrlEncoding.queryEntries({ b } as never)).toThrow(
      new TypeError(
        'The query field "b" must encode a scalar value or a list of scalar values',
      ),
    );
    expect(conversions).toBe(0);
  });

  it("expands a record in key order, stringifying scalars", () => {
    expect(
      UrlEncoding.queryEntries({
        text: "a",
        number: 0,
        bigint: 9007199254740993n,
        yes: true,
        no: false,
        empty: "",
      }),
    ).toEqual([
      ["text", "a"],
      ["number", "0"],
      ["bigint", "9007199254740993"],
      ["yes", "true"],
      ["no", "false"],
      ["empty", ""],
    ]);
  });

  it("keeps null as a bare key, distinct from an empty value", () => {
    expect(UrlEncoding.queryEntries({ bare: null, empty: "" })).toEqual([
      ["bare", null],
      ["empty", ""],
    ]);
  });

  it("omits undefined values, alone or inside arrays", () => {
    expect(
      UrlEncoding.queryEntries({
        absent: undefined,
        list: ["a", undefined, "b"],
      }),
    ).toEqual([
      ["list", "a"],
      ["list", "b"],
    ]);
  });

  it("expands arrays into repeated entries, including bare keys", () => {
    expect(UrlEncoding.queryEntries({ id: [1, null, 3] })).toEqual([
      ["id", "1"],
      ["id", null],
      ["id", "3"],
    ]);
  });

  it("expands an empty array to no entries", () => {
    expect(UrlEncoding.queryEntries({ id: [] })).toEqual([]);
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/110
  describe("a Date", () => {
    const noon = new Date("2026-11-07T12:00:00.000Z");

    it("is written as ISO text, alone, in a list and in pairs", () => {
      expect(
        UrlEncoding.queryEntries({ from: noon, at: [noon, null] }),
      ).toEqual([
        ["from", "2026-11-07T12:00:00.000Z"],
        ["at", "2026-11-07T12:00:00.000Z"],
        ["at", null],
      ]);
      expect(UrlEncoding.queryEntries([["from", noon]])).toEqual([
        ["from", "2026-11-07T12:00:00.000Z"],
      ]);
    });

    it("keeps its text at the far end of the range", () => {
      expect(
        UrlEncoding.queryEntries({ from: new Date(8640000000000000) }),
      ).toEqual([["from", "+275760-09-13T00:00:00.000Z"]]);
    });

    it("uses the literal Invalid Date for an invalid date", () => {
      const from = Object.assign(new Date(Number.NaN), {
        toString: () => "substituted",
      });
      expect(UrlEncoding.queryEntries({ from })).toEqual([
        ["from", "Invalid Date"],
      ]);
    });

    it("reads a date from another realm as ISO text", () => {
      const from = runInNewContext("new Date(0)") as Date;
      expect(UrlEncoding.queryEntries({ from })).toEqual([
        ["from", "1970-01-01T00:00:00.000Z"],
      ]);
    });

    it("reads the date itself when its own methods or prototype differ", () => {
      const bare = new Date(0);
      Object.setPrototypeOf(bare, null);
      for (const from of [
        bare,
        Object.assign(new Date(0), { toISOString: () => "substituted" }),
        Object.assign(new Date(0), { getTime: () => Number.NaN }),
      ]) {
        expect(UrlEncoding.queryEntries({ from })).toEqual([
          ["from", "1970-01-01T00:00:00.000Z"],
        ]);
      }
    });

    it("is escaped later, by the query renderer", () => {
      expect(
        UrlEncoding.defaults.query(UrlEncoding.queryEntries({ from: noon })),
      ).toBe("from=2026-11-07T12%3A00%3A00.000Z");
    });
  });

  it("preserves the order and repetition of ordered pairs across names", () => {
    expect(
      UrlEncoding.queryEntries([
        ["a", "1"],
        ["b", "2"],
        ["a", ["3", "4"]],
      ]),
    ).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["a", "3"],
      ["a", "4"],
    ]);
  });

  it("accepts other iterables of pairs, such as a Map", () => {
    expect(
      UrlEncoding.queryEntries(
        new Map<string, UrlEncoding.QueryValue>([
          ["x", 1],
          ["y", null],
        ]),
      ),
    ).toEqual([
      ["x", "1"],
      ["y", null],
    ]);
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/242
  it("reads an array with its own iterator and a prototype-free pair by position", () => {
    const pair = ["flag", null] as const;
    Object.setPrototypeOf(pair, null);
    const input = [pair, ["skip", undefined] as const];
    Object.defineProperty(input, Symbol.iterator, {
      get: () => {
        throw new Error("must not read the iterator");
      },
    });
    expect(UrlEncoding.queryEntries(input)).toEqual([["flag", null]]);
    expect(() => UrlEncoding.queryEntries([["missing"]] as never)).toThrow(
      new TypeError(
        "A field pair must be a two-position array with a string name",
      ),
    );
  });

  it("reads repeated values without array methods", () => {
    const values = ["one", "two"];
    Object.setPrototypeOf(values, null);
    Object.defineProperties(values, {
      flatMap: { value: () => [["k", "substitute"]] },
      [Symbol.iterator]: { value: () => ["substitute"][Symbol.iterator]() },
    });
    const expected = [
      ["k", "one"],
      ["k", "two"],
    ];
    expect(
      UrlEncoding.queryEntries({ k: values, [Symbol.iterator]: undefined }),
    ).toEqual(expected);
    expect(UrlEncoding.queryEntries([["k", values]])).toEqual(expected);
  });

  it.each([
    { input: [["k", "v", "extra"]] },
    { input: ["ab"] },
    { input: [["k"]] },
    { input: [[1, "v"]] },
  ])("throws TypeError for a malformed array entry", ({ input }) => {
    expect(() => UrlEncoding.queryEntries(input as never)).toThrow(
      new TypeError(
        "A field pair must be a two-position array with a string name",
      ),
    );
  });

  it("reads the pairs array length once", () => {
    let reads = 0;
    const pairs = new Proxy(
      [
        ["k", "a"],
        ["k", "b"],
      ] as const,
      {
        get(target, key, receiver) {
          if (key === "length") reads++;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    expect(UrlEncoding.queryEntries(pairs)).toEqual([
      ["k", "a"],
      ["k", "b"],
    ]);
    expect(reads).toBe(1);
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/236
  it("reports its own error for an invalid iterator and closes a malformed iterable", () => {
    const invalid = { [Symbol.iterator]: () => 5 };
    expect(() => UrlEncoding.queryEntries(invalid as never)).toThrow(
      new TypeError(
        "A field pairs iterable must return an iterator with a callable next method",
      ),
    );
    let closed = false;
    const pairs = {
      *[Symbol.iterator]() {
        try {
          yield ["k", "v"];
          yield "malformed";
        } finally {
          closed = true;
        }
      },
    };
    expect(() => UrlEncoding.queryEntries(pairs as never)).toThrow(
      new TypeError(
        "A field pair must be a two-position array with a string name",
      ),
    );
    expect(closed).toBe(true);
  });
});

describe("UrlEncoding.defaults", () => {
  const { path, query, join } = UrlEncoding.defaults;

  it("percent-encodes path values, including reserved separators", () => {
    expect(path("a/b c?d#e%")).toBe("a%2Fb%20c%3Fd%23e%25");
  });

  it("leaves empty values and dot segments unchanged", () => {
    expect(path("")).toBe("");
    expect(path(".")).toBe(".");
    expect(path("..")).toBe("..");
  });

  it("renders bare keys without '=' and empty values with '='", () => {
    expect(
      query([
        ["wsdl", null],
        ["empty", ""],
        ["k", "v"],
      ]),
    ).toBe("wsdl&empty=&k=v");
  });

  it("percent-encodes query keys and values, using %20 for spaces", () => {
    expect(query([["a b&c", "d=e f+g/h"]])).toBe("a%20b%26c=d%3De%20f%2Bg%2Fh");
  });

  it("preserves repeated keys in order", () => {
    expect(
      query([
        ["k", "1"],
        ["j", "2"],
        ["k", "3"],
      ]),
    ).toBe("k=1&j=2&k=3");
  });

  it("renders no entries as an empty string", () => {
    expect(query([])).toBe("");
  });

  it("joins a base and a path with exactly one separating slash", () => {
    expect(join("https://api.test/v1", "users")).toBe(
      "https://api.test/v1/users",
    );
    expect(join("https://api.test/v1/", "/users")).toBe(
      "https://api.test/v1/users",
    );
    expect(join("https://api.test/v1/", "users")).toBe(
      "https://api.test/v1/users",
    );
    expect(join("https://api.test/v1", "/users")).toBe(
      "https://api.test/v1/users",
    );
  });

  it("uses the path alone without a base", () => {
    expect(join("", "/users")).toBe("/users");
  });

  it("uses the base alone for an empty path", () => {
    expect(join("https://api.test/v1/", "")).toBe("https://api.test/v1/");
  });

  it("ignores the base for an absolute path, in any scheme case", () => {
    expect(join("https://api.test/v1", "https://other.test/x")).toBe(
      "https://other.test/x",
    );
    expect(join("https://api.test/v1", "HTTP://other.test/x")).toBe(
      "HTTP://other.test/x",
    );
  });

  it("leaves additional empty path segments to the application", () => {
    expect(join("https://api.test/v1//", "//users")).toBe(
      "https://api.test/v1///users",
    );
    expect(join("https://api.test/v1", "a//b/")).toBe(
      "https://api.test/v1/a//b/",
    );
  });
});

describe("UrlEncoding.UrlEncoding", () => {
  it.effect("defaults to the default policy", () =>
    Effect.gen(function* () {
      expect(yield* UrlEncoding.UrlEncoding).toBe(UrlEncoding.defaults);
    }),
  );

  it.effect("is replaced through its layer", () =>
    Effect.gen(function* () {
      const custom: UrlEncoding.Service = {
        ...UrlEncoding.defaults,
        path: (value) => value,
      };
      const service = yield* UrlEncoding.UrlEncoding.pipe(
        Effect.provide(UrlEncoding.layer(custom)),
      );
      expect(service).toBe(custom);
    }),
  );
});
