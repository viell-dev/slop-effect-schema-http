import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  DateTime,
  Deferred,
  Effect,
  Schema,
  SchemaTransformation,
} from "effect";
import { HttpClientRequest } from "effect/http";
import {
  compile,
  linesOf,
  loneSurrogate,
  MomentFromSelf,
  refusal,
  Tenant,
  urlOf,
} from "../../test/request.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

/** A point that each of `parties` fibers passes only once all of them have reached it. */
const meeting = (parties: number) =>
  Effect.map(Deferred.make<void>(), (everyone) => {
    let arrived = 0;
    return Effect.suspend(() =>
      ++arrived === parties
        ? Deferred.succeed(everyone, undefined)
        : Effect.void,
    ).pipe(Effect.andThen(Deferred.await(everyone)));
  });

describe("raw headers", () => {
  it.effect("setHeader replaces every line of a case-insensitive name", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.appendHeader("X-Scope", "read"),
          Request.appendHeader("x-scope", "write"),
          Request.setHeader("X-SCOPE", "admin"),
        ),
        undefined,
      );
      expect(compiled.request.headers["x-scope"]).toBe("admin");
      expect(compiled.headerLines).toEqual([["X-SCOPE", "admin"]]);
    }),
  );

  it.effect(
    "appendHeader keeps repeated lines for providers and joins them natively",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("https://api.test/").pipe(
            Request.appendHeader("X-Scope", "read"),
            Request.setHeader("Accept", "text/xml"),
            Request.appendHeader("X-Scope", "write"),
          ),
          undefined,
        );
        expect(compiled.request.headers["x-scope"]).toBe("read, write");
        expect(compiled.headerLines).toEqual([
          ["X-Scope", "read"],
          ["Accept", "text/xml"],
          ["X-Scope", "write"],
        ]);
      }),
  );

  it.effect(
    "removeHeader removes a name, or only its matching static lines",
    () =>
      Effect.gen(function* () {
        const base = Request.get("https://api.test/").pipe(
          Request.appendHeader("X-Scope", "read"),
          Request.appendHeader("X-Scope", "write"),
          Request.appendHeader("X-Other", "1"),
        );
        const all = yield* compile(
          base.pipe(Request.removeHeader("x-scope")),
          undefined,
        );
        expect(all.headerLines).toEqual([["X-Other", "1"]]);
        const one = yield* compile(
          base.pipe(Request.removeHeader("X-SCOPE", "read")),
          undefined,
        );
        expect(one.headerLines).toEqual([
          ["X-Scope", "write"],
          ["X-Other", "1"],
        ]);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("keeps each line of a repeated name in its own spelling", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.appendHeader("X-Tag", "a"),
          Request.appendHeader("x-tag", "b"),
          Request.appendHeader("X-TAG", "c"),
        ),
        undefined,
      );
      expect(compiled.headerLines).toEqual([
        ["X-Tag", "a"],
        ["x-tag", "b"],
        ["X-TAG", "c"],
      ]);
      expect(compiled.request.headers["x-tag"]).toBe("a, b, c");
      expect(compiled.request.headers["X-Tag"]).toBeUndefined();
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("replaces at the first position and takes the new spelling", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.appendHeader("x-thing", "old"),
          Request.setHeader("X-Kept", "k"),
          Request.appendHeader("X-THING", "older"),
          Request.setHeader("X-Thing", "new"),
        ),
        undefined,
      );
      expect(compiled.headerLines).toEqual([
        ["X-Thing", "new"],
        ["X-Kept", "k"],
      ]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("removes across spellings, with or without a value", () =>
    Effect.gen(function* () {
      const base = Request.get("https://api.test/").pipe(
        Request.appendHeader("X-Tag", "a"),
        Request.appendHeader("x-tag", "b"),
        Request.appendHeader("X-TAG", "a"),
      );
      const all = yield* compile(
        base.pipe(Request.removeHeader("x-TaG")),
        undefined,
      );
      expect(all.headerLines).toEqual([]);
      const value = yield* compile(
        base.pipe(Request.removeHeader("x-TaG", "a")),
        undefined,
      );
      expect(value.headerLines).toEqual([["x-tag", "b"]]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/101
  it.effect("keeps a spelling through a computed value", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.get("https://api.test/").pipe(
          Request.setHeader("X-API-Key", () => "k"),
        ),
        undefined,
      );
      expect(compiled.headerLines).toEqual([["X-API-Key", "k"]]);
      expect(compiled.request.headers["x-api-key"]).toBe("k");
    }),
  );

  it("records the spelling on the declaration", () => {
    expect(
      Request.get("/").pipe(Request.setHeader("X-Thing", "1")).declaration
        .headers,
    ).toEqual([["X-Thing", "1"]]);
  });

  it.effect("evaluates computed values once per compilation", () =>
    Effect.gen(function* () {
      let token = 0;
      const request = Request.get("https://api.test/").pipe(
        Request.setHeader("Authorization", () => `Bearer t${++token}`),
      );
      expect(token).toBe(0);
      const first = yield* compile(request, undefined);
      const second = yield* compile(request, undefined);
      expect(first.request.headers.authorization).toBe("Bearer t1");
      expect(second.request.headers.authorization).toBe("Bearer t2");
      expect(token).toBe(2);
    }),
  );

  it.effect(
    "omits a computed value that is undefined instead of sending 'undefined'",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("https://api.test/").pipe(
            Request.setHeader("Authorization", () => undefined),
          ),
          undefined,
        );
        expect(compiled.request.headers.authorization).toBeUndefined();
        expect(compiled.headerLines).toEqual([]);
      }),
  );

  it.effect("fails with InvalidRequest when a computed value throws", () =>
    Effect.gen(function* () {
      const failure = new Error("credential store unavailable");
      const error = yield* Effect.flip(
        compile(
          Request.get("https://api.test/").pipe(
            Request.setHeader("Authorization", () => {
              throw failure;
            }),
          ),
          undefined,
        ),
      );
      expect(error).toBeInstanceOf(Request.InvalidRequest);
      expect(error.message).toBe("Failed to materialize request fields");
      expect(error.cause).toBe(failure);
    }),
  );
});

describe("raw query", () => {
  it.effect(
    "setQuery replaces every entry of a key at its first position",
    () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("https://api.test/s?a=1&b=2&a=3").pipe(
              Request.setQuery("a", "x"),
            ),
            undefined,
          ),
        ).toBe("https://api.test/s?a=x&b=2");
      }),
  );

  it.effect("appendQuery adds repeated entries, and null is a bare key", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/s").pipe(
            Request.appendQuery("id", "1"),
            Request.appendQuery("debug", null),
            Request.appendQuery("id", "2"),
            Request.appendQuery("empty", ""),
          ),
          undefined,
        ),
      ).toBe("https://api.test/s?id=1&debug&id=2&empty=");
    }),
  );

  it.effect(
    "removeQuery removes a key, or only its matching static entries",
    () =>
      Effect.gen(function* () {
        const base = Request.get("https://api.test/s?k&k=&k=v&j=1");
        expect(
          yield* urlOf(base.pipe(Request.removeQuery("k")), undefined),
        ).toBe("https://api.test/s?j=1");
        expect(
          yield* urlOf(base.pipe(Request.removeQuery("k", null)), undefined),
        ).toBe("https://api.test/s?k=&k=v&j=1");
        expect(
          yield* urlOf(base.pipe(Request.removeQuery("k", "")), undefined),
        ).toBe("https://api.test/s?k&k=v&j=1");
      }),
  );

  it.effect(
    "evaluates computed entries per compilation and omits undefined",
    () =>
      Effect.gen(function* () {
        let bust = 0;
        const request = Request.get("https://cdn.test/asset").pipe(
          Request.setQuery("cb", () => String(++bust)),
          Request.setQuery("absent", () => undefined),
          Request.setQuery("bare", () => null),
        );
        expect(yield* urlOf(request, undefined)).toBe(
          "https://cdn.test/asset?cb=1&bare",
        );
        expect(yield* urlOf(request, undefined)).toBe(
          "https://cdn.test/asset?cb=2&bare",
        );
      }),
  );

  it.effect(
    "fails with InvalidRequest when a value cannot be percent-encoded",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(
            Request.get("https://api.test/s").pipe(
              Request.setQuery("q", loneSurrogate),
            ),
            undefined,
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.message).toBe("Failed to encode request URL");
      }),
  );
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/85
describe("declaring fields from a plain object", () => {
  describe("Request.setQuery", () => {
    it.effect("applies each value rule, in key order", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.setQuery({
                page: 2,
                sort: "name",
                tag: ["a", "b"],
                flag: null,
                empty: "",
                gone: undefined,
                late: () => "x",
              }),
            ),
            undefined,
          ),
        ).toBe("/x?page=2&sort=name&tag=a&tag=b&flag&empty=&late=x");
      }),
    );

    it.effect.each([
      ["a number", 2, "2"],
      ["a negative number", -1.5, "-1.5"],
      ["a bigint", 90071992547409931n, "90071992547409931"],
      ["true", true, "true"],
      ["false", false, "false"],
    ] as const)("writes %s as text", ([, value, expected]) =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(Request.setQuery({ a: value })),
            undefined,
          ),
        ).toBe(`/x?a=${expected}`);
      }),
    );

    it.effect("replaces each key and leaves other names alone", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?a=%41&b=2&a=3&c=%43").pipe(
              Request.setQuery({ a: "new", d: "added" }),
            ),
            undefined,
          ),
        ).toBe("/x?a=new&b=2&c=%43&d=added");
      }),
    );

    it.effect("keeps a repeated name together at its first position", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?a=1&tag=old&b=2").pipe(
              Request.setQuery({ tag: ["p", "q"] }),
            ),
            undefined,
          ),
        ).toBe("/x?a=1&tag=p&tag=q&b=2");
      }),
    );

    it.effect(
      "removes earlier declarations for undefined or an empty list",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1&b=2&c=3");
          expect(
            yield* urlOf(
              request.pipe(Request.setQuery({ a: undefined })),
              undefined,
            ),
          ).toBe("/x?b=2&c=3");
          expect(
            yield* urlOf(request.pipe(Request.setQuery({ a: [] })), undefined),
          ).toBe("/x?b=2&c=3");
        }),
    );

    it.effect("keeps nulls and drops undefined inside a list", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.setQuery({ a: [null, undefined, "b", 3] }),
            ),
            undefined,
          ),
        ).toBe("/x?a&a=b&a=3");
      }),
    );

    it.effect("runs a function during preparation, once per compilation", () =>
      Effect.gen(function* () {
        let calls = 0;
        const request = Request.get("/x").pipe(
          Request.setQuery({
            n: () => String(++calls),
            nothing: () => undefined,
            bare: () => null,
          }),
        );
        expect(calls).toBe(0);
        expect(yield* urlOf(request, undefined)).toBe("/x?n=1&bare");
        expect(yield* urlOf(request, undefined)).toBe("/x?n=2&bare");
      }),
    );

    it.effect("reads the object when called, not when applied", () =>
      Effect.gen(function* () {
        const fields: Record<string, string> = { a: "1" };
        const edit = Request.setQuery(fields);
        fields["a"] = "2";
        fields["b"] = "3";
        expect(yield* urlOf(Request.get("/x").pipe(edit), undefined)).toBe(
          "/x?a=1",
        );
      }),
    );

    it.effect("takes a name a plain object would inherit", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              Request.setQuery({
                constructor: "a",
                ["__proto__"]: "b",
                toString: "c",
              }),
            ),
            undefined,
          ),
        ).toBe("/x?constructor=a&__proto__=b&toString=c");
      }),
    );

    it.effect("does nothing for an empty object", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?a=%41").pipe(Request.setQuery({})),
            undefined,
          ),
        ).toBe("/x?a=%41");
      }),
    );

    it.effect("is checked against a schema like any other edit", () =>
      Effect.gen(function* () {
        const typed = Request.get("/x").pipe(
          Request.query(
            Schema.Struct({
              page: Schema.FiniteFromString,
              limit: Schema.optional(Schema.FiniteFromString),
            }),
          ),
        );
        const input = { query: { page: 1 } };
        expect(
          yield* urlOf(typed.pipe(Request.setQuery({ limit: 5 })), input),
        ).toBe("/x?page=1&limit=5");
        const stray = yield* Effect.flip(
          compile(typed.pipe(Request.setQuery({ other: "1" })), input),
        );
        expect(stray.message).toContain('"other"');
        for (const value of ["2", undefined]) {
          const required = yield* Effect.flip(
            compile(typed.pipe(Request.setQuery({ page: value })), input),
          );
          expect(required.message).toContain("could never reach the client");
        }
      }),
    );

    it("accepts the values a query schema may encode to, or a function", () => {
      Request.setQuery({
        a: 1,
        b: 1n,
        c: true,
        d: null,
        e: undefined,
        f: "x",
        g: [1, "x", null, undefined],
        h: () => "x",
        i: () => null,
        j: () => undefined,
        k: () => 1,
        l: () => 1n,
        m: () => true,
        n: () => new Date(0),
      });
      // @ts-expect-error: a nested object has no query representation
      Request.setQuery({ a: { b: "1" } });
      // @ts-expect-error: nor does a function's result
      Request.setQuery({ a: () => ({ b: "1" }) });
      // @ts-expect-error: a function supplies one value, so it cannot repeat a name
      Request.setQuery({ a: () => ["x", "y"] });
      // @ts-expect-error: a list holds query values, not functions
      Request.setQuery({ a: [() => "x"] });
      // @ts-expect-error: the two-argument form still takes text
      Request.setQuery("a", 1);
      // @ts-expect-error: and so does its function
      Request.setQuery("a", () => 1);
      // @ts-expect-error: and a `Date`, or a function returning one, stays in the object form
      Request.setQuery("a", () => new Date(0));
    });

    it.effect("writes a function's result as it writes the same value", () =>
      Effect.gen(function* () {
        const date = new Date("2026-11-07T00:00:00.000Z");
        const fixed = {
          a: 2,
          b: 3n,
          c: true,
          d: false,
          e: date,
          f: null,
          g: "",
          h: "x y",
          i: 0,
        };
        const computed = {
          a: () => 2,
          b: () => 3n,
          c: () => true,
          d: () => false,
          e: () => date,
          f: () => null,
          g: () => "",
          h: () => "x y",
          i: () => 0,
        };
        const url = yield* urlOf(
          Request.get("/x").pipe(Request.setQuery(computed)),
          undefined,
        );
        expect(url).toBe(
          yield* urlOf(
            Request.get("/x").pipe(Request.setQuery(fixed)),
            undefined,
          ),
        );
        expect(url).toBe(
          "/x?a=2&b=3&c=true&d=false&e=2026-11-07T00%3A00%3A00.000Z&f&g=&h=x%20y&i=0",
        );
      }),
    );

    it.effect(
      "writes an invalid `Date` from a function as the value form does",
      () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.setQuery({ at: () => new Date(Number.NaN) }),
              ),
              undefined,
            ),
          ).toBe("/x?at=Invalid%20Date");
        }),
    );

    it.effect("takes a function's number as a default under a schema", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.setQuery({ limit: () => 25 }),
          Request.query(
            Schema.Struct({ limit: Schema.optional(Schema.FiniteFromString) }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/x?limit=25");
        expect(yield* urlOf(request, { query: { limit: 5 } })).toBe(
          "/x?limit=5",
        );
      }),
    );
  });

  describe("Request.setHeader", () => {
    it.effect("sets each field, in key order, keeping spelling", () =>
      Effect.gen(function* () {
        expect(
          yield* linesOf(
            Request.get("/x").pipe(
              Request.setHeader({ "X-One": "1", "X-Two": () => "2" }),
            ),
            undefined,
          ),
        ).toEqual([
          ["X-One", "1"],
          ["X-Two", "2"],
        ]);
      }),
    );

    it.effect(
      "replaces each key without case, and leaves other names alone",
      () =>
        Effect.gen(function* () {
          expect(
            yield* linesOf(
              Request.get("/x").pipe(
                Request.appendHeader("x-tag", "a"),
                Request.setHeader("X-Kept", "k"),
                Request.appendHeader("X-TAG", "b"),
                Request.setHeader({ "X-Tag": "c" }),
              ),
              undefined,
            ),
          ).toEqual([
            ["X-Tag", "c"],
            ["X-Kept", "k"],
          ]);
        }),
    );

    it.effect("removes earlier declarations of an undefined key", () =>
      Effect.gen(function* () {
        expect(
          yield* linesOf(
            Request.get("/x").pipe(
              Request.setHeader("X-Gone", "1"),
              Request.setHeader("X-Kept", "k"),
              Request.setHeader({ "x-gone": undefined }),
            ),
            undefined,
          ),
        ).toEqual([["X-Kept", "k"]]);
      }),
    );

    it.effect("leaves an automatic value in place for an undefined key", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/x").pipe(
            Request.body(Body.text),
            Request.setHeader({ "Content-Type": undefined }),
          ),
          { body: "b" },
        );
        expect(compiled.request.headers["content-type"]).toBe("text/plain");
        expect(compiled.removedHeaders).toEqual(new Set());
      }),
    );

    it.effect("wins over an automatic value, like the two-argument form", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/x").pipe(
            Request.body(Body.text),
            Request.setHeader({ "Content-Type": "application/weird" }),
          ),
          { body: "b" },
        );
        expect(compiled.request.headers["content-type"]).toBe(
          "application/weird",
        );
      }),
    );

    it.effect("is checked against a schema like any other edit", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.headers(Schema.Struct({ "x-limit": Schema.String })),
          Request.setHeader({ "X-LIMIT": "1" }),
        );
        const error = yield* Effect.flip(
          compile(request, { headers: { "x-limit": "2" } }),
        );
        expect(error.message).toContain("could never reach the client");
      }),
    );

    it("accepts text or a function", () => {
      Request.setHeader({
        a: "1",
        b: () => "2",
        c: () => undefined,
        d: undefined,
      });
      // @ts-expect-error: header values are text
      Request.setHeader({ a: 1 });
      // @ts-expect-error: a header has no bare form
      Request.setHeader({ a: null });
      // @ts-expect-error: use `appendHeader` for repeated lines
      Request.setHeader({ a: ["1", "2"] });
    });
  });

  it("keeps every raw edit one type, so they compose as a list", () => {
    const edits = [
      Request.setQuery({ a: "1" }),
      Request.setQuery("b", "2"),
      Request.appendQuery("c", "3"),
      Request.removeQuery("d"),
      Request.setHeader({ a: "1" }),
      Request.setHeader("b", "2"),
      Request.appendHeader("c", "3"),
      Request.removeHeader("d"),
    ];
    const reduced = edits.reduce(
      (request, edit) => edit(request),
      Request.get("/x"),
    );
    expectTypeOf(reduced).toEqualTypeOf<Request.Request<unknown>>();
  });
});

describe("Request.headers", () => {
  const ApiHeaders = Schema.Struct({
    "X-Api-Key": Schema.NonEmptyString,
    "X-Scope": Schema.Array(Schema.String),
    "X-Optional": Schema.optional(Schema.String),
  });

  it.effect(
    "encodes input into ordered lines, keeping spelling and repetition",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("https://api.test/").pipe(Request.headers(ApiHeaders)),
          { headers: { "X-Api-Key": "k", "X-Scope": ["read", "write"] } },
        );
        expect(compiled.headerLines).toEqual([
          ["X-Api-Key", "k"],
          ["X-Scope", "read"],
          ["X-Scope", "write"],
        ]);
        expect(compiled.request.headers["x-scope"]).toBe("read, write");
        expect(compiled.request.headers["x-optional"]).toBeUndefined();
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect("refuses a raw header the schema does not allow", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        compile(
          Request.get("https://api.test/").pipe(
            Request.setHeader("X-Raw", "dropped"),
            Request.headers(ApiHeaders),
          ),
          { headers: { "X-Api-Key": "k", "X-Scope": [] } },
        ),
      );
      expect(error).toBeInstanceOf(Request.InvalidRequest);
    }),
  );

  it.effect(
    "refuses invalid input before materialization with a SchemaError",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(
            Request.get("https://api.test/").pipe(Request.headers(ApiHeaders)),
            { headers: { "X-Api-Key": "", "X-Scope": [] } },
          ),
        );
        expect(Schema.isSchemaError(error)).toBe(true);
      }),
  );

  it.effect("applies the schema's encoding transformation", () =>
    Effect.gen(function* () {
      const compiled = yield* compile(
        Request.head("https://api.test/").pipe(
          Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString })),
        ),
        { headers: { "X-Page": 3 } },
      );
      expect(compiled.headerLines).toEqual([["X-Page", "3"]]);
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it("keeps raw setters and further schemas in the type", () => {
    const bound = Request.get("/").pipe(Request.headers(ApiHeaders));
    bound.pipe(Request.setHeader("X-Optional", "1"));
    bound.pipe(Request.appendHeader("X-Optional", "1"));
    bound.pipe(Request.removeHeader("X-Optional"));
    bound.pipe(Request.headers(ApiHeaders));
  });

  it("requires a schema whose encoded side is header fields", () => {
    const NumericPage = Schema.Struct({ "X-Page": Schema.Number });
    // @ts-expect-error: a plain string is not a set of header fields
    Request.headers(Schema.String);
    // @ts-expect-error: header values encode to strings, not numbers
    Request.headers(NumericPage);
    Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString }));
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/113
  it("takes either side of the schema as input, and nothing else", () => {
    const paged = Request.get("/").pipe(
      Request.headers(Schema.Struct({ "X-Page": Schema.NumberFromString })),
    );
    void Request.compile(paged, { headers: { "X-Page": 3 } });
    void Request.compile(paged, { headers: { "X-Page": "3" } });
    // @ts-expect-error: a boolean is on neither side of the schema
    void Request.compile(paged, { headers: { "X-Page": true } });
  });

  it.effect(
    "encodes through an effectful schema without sharing state between compilations",
    () =>
      Effect.gen(function* () {
        // Both compilations meet while encoding, and again between encoding and the header merge,
        // so each step runs with the other compilation in flight.
        const encoding = yield* meeting(2);
        const merging = yield* meeting(2);
        const Signed = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (wire: string) => Effect.succeed(wire),
              encode: (value: string) =>
                Effect.gen(function* () {
                  const tenant = yield* Tenant;
                  yield* encoding;
                  return `${tenant}:${value}`;
                }),
            }),
          ),
        );
        const request = Request.get("https://api.test/").pipe(
          Request.mapEffect((native) => Effect.as(merging, native)),
          Request.headers(Schema.Struct({ "X-Signed": Signed })),
        );
        const compiling = (value: string) =>
          compile(request, { headers: { "X-Signed": value } });
        expectTypeOf<
          Effect.Services<ReturnType<typeof compiling>>
        >().toEqualTypeOf<Tenant>();
        const [a, b] = yield* Effect.all([compiling("a"), compiling("b")], {
          concurrency: "unbounded",
        }).pipe(Effect.provideService(Tenant, "t1"));
        expect(a.headerLines).toEqual([["X-Signed", "t1:a"]]);
        expect(a.request.headers["x-signed"]).toBe("t1:a");
        expect(b.headerLines).toEqual([["X-Signed", "t1:b"]]);
        expect(b.request.headers["x-signed"]).toBe("t1:b");
      }),
  );
});

describe("Request.query", () => {
  const Search = Schema.Struct({
    q: Schema.String,
    page: Schema.optional(Schema.NumberFromString),
    tag: Schema.optional(Schema.Array(Schema.String)),
    wsdl: Schema.optional(Schema.Null),
  });

  it.effect("encodes a record into ordered entries", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/search").pipe(Request.query(Search)),
          { query: { q: "a b", page: 2, tag: ["x", "y"], wsdl: null } },
        ),
      ).toBe("https://api.test/search?q=a%20b&page=2&tag=x&tag=y&wsdl");
    }),
  );

  it.effect("omits absent optional entries", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/search").pipe(Request.query(Search)),
          { query: { q: "" } },
        ),
      ).toBe("https://api.test/search?q=");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it.effect(
    "refuses raw entries the schema does not allow, including the URL's query string",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(
            Request.get("https://api.test/search?legacy=1").pipe(
              Request.setQuery("raw", "dropped"),
              Request.query(Search),
            ),
            { query: { q: "x" } },
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.message).toContain('"legacy", "raw"');
      }),
  );

  it.effect(
    "replaces native parameters of the same key and keeps the others",
    () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("https://api.test/search").pipe(
              Request.mapEffect((request) =>
                Effect.succeed(
                  request.pipe(
                    HttpClientRequest.appendUrlParam("q", "native"),
                    HttpClientRequest.appendUrlParam("trace", "1"),
                  ),
                ),
              ),
              Request.query(Search),
            ),
            { query: { q: "schema" } },
          ),
        ).toBe("https://api.test/search?trace=1&q=schema");
      }),
  );

  it.effect("accepts ordered pairs from the schema", () =>
    Effect.gen(function* () {
      const Pairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
      expect(
        yield* urlOf(
          Request.get("https://api.test/s").pipe(Request.query(Pairs)),
          {
            query: [
              ["b", "1"],
              ["a", "2"],
              ["b", "3"],
            ],
          },
        ),
      ).toBe("https://api.test/s?b=1&a=2&b=3");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/87
  it("keeps raw setters and further schemas in the type", () => {
    const bound = Request.get("/").pipe(Request.query(Search));
    bound.pipe(Request.setQuery("tag", "1"));
    bound.pipe(Request.appendQuery("tag", "1"));
    bound.pipe(Request.removeQuery("tag"));
    bound.pipe(Request.query(Search));
  });

  it("requires a schema whose encoded side is flat query entries", () => {
    const Nested = Schema.Struct({
      filter: Schema.Struct({ owner: Schema.String }),
    });
    // @ts-expect-error: a nested struct has no query representation
    Request.query(Nested);
    Request.query(
      Schema.Struct({ page: Schema.Number, tag: Schema.Array(Schema.String) }),
    );
  });

  // https://github.com/viell-dev/slop-effect-schema-http/issues/113
  it("takes either side of the schema as input, and nothing else", () => {
    const paged = Request.get("/").pipe(
      Request.query(Schema.Struct({ page: Schema.NumberFromString })),
    );
    void Request.compile(paged, { query: { page: 2 } });
    void Request.compile(paged, { query: { page: "2" } });
    // @ts-expect-error: a boolean is on neither side of the schema
    void Request.compile(paged, { query: { page: true } });
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/110
describe("dates in a query", () => {
  const noon = new Date("2026-11-07T12:00:00.000Z");
  const iso = "2026-11-07T12%3A00%3A00.000Z";
  const noonUtc = DateTime.makeUnsafe(noon);

  describe("the sides of a schema", () => {
    it.effect("`Schema.Date` takes a `Date` and carries ISO text", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.Date })),
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
      }),
    );

    it.effect("`Schema.DateFromString` takes a `Date` or its text", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.DateFromString })),
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
        expect(
          yield* urlOf(request, { query: { from: noon.toISOString() } }),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("a schema from a `Date` to another type takes either", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.DateTimeUtcFromDate })),
        );
        expect(yield* urlOf(request, { query: { from: noonUtc } })).toBe(
          `/slots?from=${iso}`,
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
      }),
    );

    it.effect("takes either side of such a schema beside another field", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(
            Schema.Struct({
              from: Schema.DateTimeUtcFromDate,
              limit: Schema.FiniteFromString,
            }),
          ),
        );
        for (const query of [
          { from: noonUtc, limit: 5 },
          { from: noon, limit: "5" },
          { from: noon, limit: 5 },
          { from: noonUtc, limit: "5" },
        ])
          expect(yield* urlOf(request, { query })).toBe(
            `/slots?from=${iso}&limit=5`,
          );
      }),
    );

    it.effect("mixes with other fields, and repeats in a list", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(
            Schema.Struct({
              at: Schema.Array(Schema.Date),
              limit: Schema.FiniteFromString,
            }),
          ),
        );
        expect(
          yield* urlOf(request, { query: { at: [noon, noon], limit: "5" } }),
        ).toBe(`/slots?at=${iso}&at=${iso}&limit=5`);
      }),
    );

    it.effect("writes a `Date` in a record or a list of pairs", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.query(Schema.Record(Schema.String, Schema.Date)),
            ),
            { query: { from: noon } },
          ),
        ).toBe(`/slots?from=${iso}`);
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.query(
                Schema.Array(Schema.Tuple([Schema.String, Schema.Date])),
              ),
            ),
            { query: [["from", noon]] },
          ),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("still keeps a `null` as a bare key beside a `Date`", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.query(Schema.Struct({ from: Schema.NullOr(Schema.Date) })),
        );
        expect(yield* urlOf(request, { query: { from: null } })).toBe(
          "/slots?from",
        );
      }),
    );

    it.effect("refuses an invalid `Date` with a schema error", () =>
      Effect.gen(function* () {
        const invalid = new Date(Number.NaN);
        for (const contract of [
          Schema.Date,
          Schema.DateFromString,
          Schema.DateTimeUtcFromDate,
        ]) {
          const error = yield* Effect.flip(
            urlOf(
              Request.get("/slots").pipe(
                Request.query(Schema.Struct({ from: contract })),
              ),
              { query: { from: invalid } } as never,
            ),
          );
          expect(error._tag).toBe("SchemaError");
        }
      }),
    );

    it("takes a `Date` only where a schema says so", () => {
      const request = Request.get("/").pipe(
        Request.query(Schema.Struct({ from: Schema.Date })),
      );
      void Request.compile(request, { query: { from: noon } });
      // @ts-expect-error: `Schema.Date` is a `Date` on both sides, so text is on neither
      void Request.compile(request, { query: { from: "2026-11-07" } });
    });
  });

  describe("a default under a field that encodes to a `Date`", () => {
    const Slots = Schema.Struct({ from: Schema.optional(Schema.Date) });

    it.effect("is read from its text and goes through the schema", () =>
      Effect.gen(function* () {
        const request = Request.get(
          "/slots?from=2026-11-07T12:00:00.000Z",
        ).pipe(Request.query(Slots));
        expect(yield* urlOf(request, { query: {} })).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("loses its exact spelling, as a number's does", () =>
      Effect.gen(function* () {
        for (const written of [
          "2026-11-07",
          "2026-11-07T12:00Z",
          "2026-11-07T14:00:00+02:00",
        ]) {
          const request = Request.get("/slots").pipe(
            Request.setQuery("from", written),
            Request.query(Slots),
          );
          const url = yield* urlOf(request, { query: {} });
          expect(url).toBe(
            `/slots?from=${encodeURIComponent(new Date(written).toISOString())}`,
          );
        }
      }),
    );

    it.effect("gives way to what the caller passes", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=soon").pipe(
          Request.query(Slots),
        );
        expect(yield* urlOf(request, { query: { from: noon } })).toBe(
          `/slots?from=${iso}`,
        );
      }),
    );

    it.effect("is refused when it holds no date, and never repeated", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=soon").pipe(
          Request.query(Slots),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"from"');
        expect(error.message).not.toContain("soon");
      }),
    );

    it.effect("is refused under a declaration that accepts any `Date`", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=soon").pipe(
          Request.query(
            Schema.Struct({ from: Schema.optional(Schema.instanceOf(Date)) }),
          ),
        );
        expect((yield* refusal(request, { query: {} })).message).toContain(
          '"from"',
        );
      }),
    );

    it.effect("is refused when a check on the `Date` refuses it", () =>
      Effect.gen(function* () {
        const early = new Date("2026-01-01T00:00:00.000Z");
        const Early = Schema.Date.check(
          Schema.makeFilter((date: Date) => date.getTime() <= early.getTime()),
        );
        const fields = Schema.Struct({ from: Schema.optional(Early) });
        expect(
          yield* urlOf(
            Request.get("/slots?from=2025-01-01").pipe(Request.query(fields)),
            { query: {} },
          ),
        ).toBe("/slots?from=2025-01-01T00%3A00%3A00.000Z");
        yield* refusal(
          Request.get("/slots?from=2026-11-07").pipe(Request.query(fields)),
          { query: {} },
        );
      }),
    );

    it.effect("fits a list, and each repeat is read", () =>
      Effect.gen(function* () {
        const Days = Schema.Struct({
          day: Schema.optional(Schema.Array(Schema.Date)),
        });
        expect(
          yield* urlOf(
            Request.get("/slots?day=2026-11-07").pipe(Request.query(Days)),
            { query: {} },
          ),
        ).toBe("/slots?day=2026-11-07T00%3A00%3A00.000Z");
        expect(
          yield* urlOf(
            Request.get("/slots?day=2026-11-07&day=2026-11-08").pipe(
              Request.query(Days),
            ),
            { query: {} },
          ),
        ).toBe(
          "/slots?day=2026-11-07T00%3A00%3A00.000Z&day=2026-11-08T00%3A00%3A00.000Z",
        );
      }),
    );

    it.effect("works under a schema to another type, and under a record", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots?from=2026-11-07T12:00:00.000Z").pipe(
              Request.query(
                Schema.Struct({
                  from: Schema.optional(Schema.DateTimeUtcFromDate),
                }),
              ),
            ),
            { query: {} },
          ),
        ).toBe(`/slots?from=${iso}`);
        expect(
          yield* urlOf(
            Request.get("/slots?from=2026-11-07T12:00:00.000Z").pipe(
              Request.query(Schema.Record(Schema.String, Schema.Date)),
            ),
            { query: {} },
          ),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("keeps a bare key for a field that also takes `null`", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from").pipe(
          Request.query(
            Schema.Struct({
              from: Schema.optional(Schema.NullOr(Schema.Date)),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/slots?from");
      }),
    );

    it.effect("stays text where the field can hold text", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots?from=2026-11-07").pipe(
          Request.query(
            Schema.Struct({
              from: Schema.optional(Schema.Union([Schema.Date, Schema.String])),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/slots?from=2026-11-07",
        );
      }),
    );

    it.effect("stays text under a declaration of text", () =>
      Effect.gen(function* () {
        const Day = Schema.declare(
          (input): input is string =>
            typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input),
        );
        const request = Request.get("/slots?day=2026-11-07").pipe(
          Request.query(Schema.Struct({ day: Schema.optional(Day) })),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/slots?day=2026-11-07",
        );
      }),
    );

    it.effect("leaves another declaration's field to refuse the text", () =>
      Effect.gen(function* () {
        // A `Moment` is not a query value, so only a cast can get this far.
        const request = Request.get("/slots?from=2026-11-07").pipe(
          Request.query(
            Schema.Struct({ from: Schema.optional(MomentFromSelf) as never }),
          ),
        );
        yield* refusal(request, { query: {} });
      }),
    );
  });

  describe("a raw record", () => {
    it.effect("writes a `Date` as ISO text", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(Request.setQuery({ from: noon })),
            undefined,
          ),
        ).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect(
      "writes a computed `Date` as ISO text, each time it is prepared",
      () =>
        Effect.gen(function* () {
          const dates = [noon, new Date("2026-11-08T12:00:00.000Z")];
          const request = Request.get("/slots").pipe(
            Request.setQuery({ from: () => dates.shift() }),
          );
          expect(yield* urlOf(request, undefined)).toBe(`/slots?from=${iso}`);
          expect(yield* urlOf(request, undefined)).toBe(
            "/slots?from=2026-11-08T12%3A00%3A00.000Z",
          );
          expect(yield* urlOf(request, undefined)).toBe("/slots");
        }),
    );

    it.effect("repeats a list of them", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.setQuery({ at: [noon, null, noon] }),
            ),
            undefined,
          ),
        ).toBe(`/slots?at=${iso}&at&at=${iso}`);
      }),
    );

    it.effect("is not changed by a later edit of the `Date`", () =>
      Effect.gen(function* () {
        const date = new Date(noon);
        const request = Request.get("/slots").pipe(
          Request.setQuery({ from: date }),
        );
        date.setTime(0);
        expect(yield* urlOf(request, undefined)).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("goes through a schema like any other default", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.setQuery({ from: noon }),
          Request.query(Schema.Struct({ from: Schema.optional(Schema.Date) })),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(`/slots?from=${iso}`);
      }),
    );

    it.effect("sends an invalid `Date` as its text, with no schema", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/slots").pipe(
              Request.setQuery({ from: new Date(Number.NaN) }),
            ),
            undefined,
          ),
        ).toBe("/slots?from=Invalid%20Date");
      }),
    );

    it.effect("is refused for an invalid `Date` under a schema", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.setQuery({ from: new Date(Number.NaN) }),
          Request.query(Schema.Struct({ from: Schema.optional(Schema.Date) })),
        );
        yield* refusal(request, { query: {} });
      }),
    );

    it("takes a `Date` only in the object form", () => {
      void Request.setQuery({ from: noon });
      void Request.setQuery({ from: [noon, noon] });
      void Request.setQuery({ from: () => noon });
      // @ts-expect-error: the two-argument form takes text, as it always has
      void Request.setQuery("from", noon);
      // @ts-expect-error: as does its function
      void Request.setQuery("from", () => noon);
    });
  });

  // `If-Modified-Since` and its kind use the HTTP date format, which is not ISO.
  describe("headers stay text", () => {
    it("refuses a header schema that encodes to a `Date`", () => {
      void Request.headers(
        // @ts-expect-error: the schema has to write its own text
        Schema.Struct({ "If-Modified-Since": Schema.Date }),
      );
      // @ts-expect-error: header values are text
      void Request.setHeader({ "If-Modified-Since": noon });
    });

    it.effect("writes what a schema's own text says", () =>
      Effect.gen(function* () {
        const request = Request.get("/slots").pipe(
          Request.headers(
            Schema.Struct({
              "If-Modified-Since": Schema.DateTimeUtcFromHttpDate,
            }),
          ),
        );
        const compiled = yield* compile(request, {
          headers: { "If-Modified-Since": noonUtc },
        });
        expect(compiled.headerLines).toEqual([
          ["If-Modified-Since", "Sat, 07 Nov 2026 12:00:00 GMT"],
        ]);
      }),
    );
  });
});
