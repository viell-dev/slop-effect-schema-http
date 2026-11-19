import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Headers, HttpClientRequest } from "effect/http";
import { response, text } from "../../test/support.js";
import * as Transport from "./Transport.js";

describe("Transport.entries", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/236
  it.each([{ input: { "x-count": [1, 2] } }, { input: [["x-count", 1]] }])(
    "throws TypeError for a non-string header value",
    ({ input }) => {
      expect(() => Transport.entries(input as never)).toThrow(
        new TypeError("A header line must have a string value"),
      );
    },
  );

  it("expands a record, keeping spelling and turning arrays into repeated lines", () => {
    expect(
      Transport.entries({
        "X-Scope": ["read", "write"],
        Accept: "text/xml",
        Omitted: undefined,
      }),
    ).toEqual([
      ["X-Scope", "read"],
      ["X-Scope", "write"],
      ["Accept", "text/xml"],
    ]);
  });

  it("keeps the order and repetition of ordered pairs across names", () => {
    expect(
      Transport.entries([
        ["X-Scope", "read"],
        ["Accept", "text/xml"],
        ["x-scope", "write"],
      ]),
    ).toEqual([
      ["X-Scope", "read"],
      ["Accept", "text/xml"],
      ["x-scope", "write"],
    ]);
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/242
  it("reads arrays and their pairs by position", () => {
    const pair = ["X-Scope", "read"] as const;
    Object.defineProperty(pair, Symbol.iterator, {
      get: () => {
        throw new Error("must not read the iterator");
      },
    });
    const input = [pair, ["X-Scope", "write"] as const];
    Object.setPrototypeOf(input, null);
    expect(Transport.entries(input)).toEqual([
      ["X-Scope", "read"],
      ["X-Scope", "write"],
    ]);
  });

  it("reads repeated record values by position", () => {
    const values = ["one", "two"];
    Object.setPrototypeOf(values, null);
    Object.defineProperties(values, {
      map: { value: () => [["X-Scope", "substitute"]] },
      [Symbol.iterator]: { value: () => ["substitute"][Symbol.iterator]() },
    });
    expect(
      Transport.entries({ "X-Scope": values, [Symbol.iterator]: undefined }),
    ).toEqual([
      ["X-Scope", "one"],
      ["X-Scope", "two"],
    ]);
  });

  it("skips holes in repeated header values", () => {
    const k = ["a", "b", "c"];
    delete k[1];
    expect(Transport.entries({ k })).toEqual([
      ["k", "a"],
      ["k", "c"],
    ]);
  });

  it.each([
    { input: [["k", "v", "extra"]] },
    { input: ["ab"] },
    { input: [["k"]] },
    { input: [[1, "v"]] },
  ])("throws TypeError for a malformed array entry", ({ input }) => {
    expect(() => Transport.entries(input as never)).toThrow(
      new TypeError(
        "A field pair must be a two-position array with a string name",
      ),
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/236
  it("reports its own error for an invalid iterator", () => {
    const invalid = { [Symbol.iterator]: () => 5 };
    expect(() => Transport.entries(invalid as never)).toThrow(
      new TypeError(
        "A field pairs iterable must return an iterator with a callable next method",
      ),
    );
  });

  it("keeps a value that contains a comma as one line", () => {
    expect(Transport.entries({ "X-List": "a, b" })).toEqual([
      ["X-List", "a, b"],
    ]);
  });
});

describe("Transport.toHeaders", () => {
  it("lowercases names and joins repeated lines case-insensitively in order", () => {
    const headers = Transport.toHeaders([
      ["X-Scope", "read"],
      ["Accept", "text/xml"],
      ["x-scope", "write"],
    ]);
    expect({ ...headers }).toEqual({
      "x-scope": "read, write",
      accept: "text/xml",
    });
  });

  it("produces an empty collection from no lines", () => {
    expect({ ...Transport.toHeaders([]) }).toEqual({});
  });
});

describe("Transport.reconcile", () => {
  const lines: Transport.Lines = [
    ["X-Scope", "read"],
    ["Content-Type", "text/xml"],
    ["X-Scope", "write"],
  ];

  it("keeps the original lines of every unchanged field", () => {
    expect(Transport.reconcile(lines, Transport.toHeaders(lines))).toEqual(
      lines,
    );
  });

  it("replaces a changed field with its native value and keeps the others", () => {
    const headers = Headers.set(Transport.toHeaders(lines), "x-scope", "admin");
    expect(Transport.reconcile(lines, headers)).toEqual([
      ["Content-Type", "text/xml"],
      ["x-scope", "admin"],
    ]);
  });

  it("appends fields added natively", () => {
    const headers = Headers.set(
      Transport.toHeaders(lines),
      "x-signature",
      "abc",
    );
    expect(Transport.reconcile(lines, headers)).toEqual([
      ...lines,
      ["x-signature", "abc"],
    ]);
  });

  it("drops fields removed natively", () => {
    const headers = Headers.remove(Transport.toHeaders(lines), "x-scope");
    expect(Transport.reconcile(lines, headers)).toEqual([
      ["Content-Type", "text/xml"],
    ]);
  });

  it("uses the native headers alone when there are no lines", () => {
    expect(
      Transport.reconcile([], Headers.fromInput({ accept: "text/plain" })),
    ).toEqual([["accept", "text/plain"]]);
  });
});

describe("Transport.headerLines", () => {
  const request = HttpClientRequest.get("https://api.test/").pipe(
    HttpClientRequest.setHeader("x-scope", "read, write"),
  );

  it.effect("has no lines outside an operation evaluation", () =>
    Effect.gen(function* () {
      expect(yield* Transport.headerLines(HttpClientRequest.get("/"))).toEqual(
        [],
      );
    }),
  );

  it.effect("reconciles the provided lines with the request headers", () =>
    Effect.gen(function* () {
      const lines = yield* Transport.headerLines(
        request.pipe(HttpClientRequest.setHeader("x-added", "1")),
      ).pipe(
        Effect.provideService(Transport.HeaderLines, [
          ["X-Scope", "read"],
          ["X-Scope", "write"],
        ]),
      );
      expect(lines).toEqual([
        ["X-Scope", "read"],
        ["X-Scope", "write"],
        ["x-added", "1"],
      ]);
    }),
  );
});

describe("Transport response header lines", () => {
  it("reports None when the provider supplied no lines", () => {
    expect(
      Transport.responseHeaderLines(response(text(200, ""))),
    ).toStrictEqual(Option.none());
  });

  it("attaches a snapshot without changing the native headers", () => {
    const native = response(
      text(200, "", [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ]),
    );
    const before = { ...native.headers };
    const lines: Array<readonly [string, string]> = [
      ["Set-Cookie", "a=1"],
      ["Set-Cookie", "b=2"],
    ];
    const attached = Transport.withResponseHeaders(native, lines);
    lines.push(["Set-Cookie", "c=3"]);
    expect(attached).toBe(native);
    expect(Transport.responseHeaderLines(attached)).toStrictEqual(
      Option.some([
        ["Set-Cookie", "a=1"],
        ["Set-Cookie", "b=2"],
      ]),
    );
    expect({ ...attached.headers }).toEqual(before);
  });

  it("replaces previously attached lines", () => {
    const native = response(text(200, ""));
    Transport.withResponseHeaders(native, [["X-A", "1"]]);
    Transport.withResponseHeaders(native, [["X-A", "2"]]);
    expect(Transport.responseHeaderLines(native)).toStrictEqual(
      Option.some([["X-A", "2"]]),
    );
  });
});
