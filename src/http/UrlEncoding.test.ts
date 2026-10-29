import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as UrlEncoding from "./UrlEncoding.js";

describe("UrlEncoding.queryEntries", () => {
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
