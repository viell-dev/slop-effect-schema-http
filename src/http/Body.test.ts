import { runInNewContext } from "node:vm";
import { describe, expect, expectTypeOf, it, vi } from "@effect/vitest";
import {
  Chunk,
  DateTime,
  Effect,
  Exit,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpBody, HttpClientError, UrlParams } from "effect/http";
import {
  empty as emptyReply,
  probeBody,
  response,
} from "../../test/support.js";
import * as Body from "./Body.js";

const bytesOf = (body: HttpBody.HttpBody): Uint8Array => {
  if (body._tag !== "Uint8Array") throw new Error(`body is ${body._tag}`);
  return body.body;
};

const textOf = (body: HttpBody.HttpBody): string =>
  new TextDecoder().decode(bytesOf(body));

const contentTypeOf = (body: HttpBody.HttpBody): string | undefined =>
  "contentType" in body ? body.contentType : undefined;

const reply = (body: BodyInit | null, contentType?: string) =>
  response(
    new globalThis.Response(body, {
      status: 200,
      ...(contentType === undefined
        ? {}
        : { headers: { "content-type": contentType } }),
    }),
  );

const decodeErrorReason = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined || error._tag !== "Fail")
    throw new Error("expected a typed failure");
  if (!HttpClientError.isHttpClientError(error.error))
    throw new Error("expected an HttpClientError");
  return error.error.reason;
};

const jsonRefusal = (
  write: Effect.Effect<
    HttpBody.HttpBody,
    HttpBody.HttpBodyError | Schema.SchemaError
  >,
  message: string,
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(write);
    expect(error).toBeInstanceOf(HttpBody.HttpBodyError);
    expect(error).toHaveProperty("reason._tag", "JsonError");
    expect(error).toHaveProperty(
      "cause.message",
      expect.stringContaining(message),
    );
    expect(error.message).toContain(message);
  });

describe("writer protection for open schemas", () => {
  const open = Schema.Struct({});
  const json = Body.jsonSchema(open);
  const composed = Body.json.pipe(Body.encodeSchema(open));
  const multipart = Body.formData.pipe(
    Body.encodeSchema(Schema.fromFormData(open)),
  );
  const symbol = Symbol("extra");
  const sparse = [1, 2, 3];
  delete sparse[1];
  const cases = [
    [NaN, '$["v"] must be a finite number'],
    [Infinity, '$["v"] must be a finite number'],
    [-Infinity, '$["v"] must be a finite number'],
    [[1, undefined], '$["v"][1] cannot encode undefined'],
    [sparse, '$["v"][1] cannot encode undefined'],
    [[Symbol("v")], '$["v"][0] cannot encode a symbol'],
    [[() => 1], '$["v"][0] cannot encode a function'],
    [Symbol("v"), '$["v"] cannot encode a symbol'],
    [() => 1, '$["v"] cannot encode a function'],
    [1n, '$["v"] cannot encode a bigint'],
    [Object(1n), '$["v"] cannot encode a bigint'],
    [Object(NaN), '$["v"] must be a finite number'],
  ] as const;

  // https://github.com/viell-dev/slop-effect-schema-http/issues/256
  it.effect("refuses lossy positions in canonical and composed open JSON", () =>
    Effect.gen(function* () {
      for (const [v, message] of cases) {
        yield* jsonRefusal(json.encode({ v }), message);
        yield* jsonRefusal(composed.encode({ v }), message);
      }
    }),
  );

  it.effect("refuses a symbol field under all three open JSON readings", () =>
    Effect.gen(function* () {
      const input = { a: 1, [symbol]: "kept" };
      for (const codec of [json, Body.jsonSchema(Schema.Unknown)]) {
        yield* jsonRefusal(
          codec.encode(input),
          "$[Symbol(extra)] cannot encode a symbol field name",
        );
      }
      const indexed = Body.jsonSchema(
        Schema.Record(Schema.String, Schema.Unknown),
      );
      const error = yield* Effect.flip(indexed.encode(input));
      expect(error).toBeInstanceOf(Schema.SchemaError);
      expect(error.message).toContain("[Symbol(extra)]");
      const nested = Schema.Union([
        Schema.Struct({ p: Schema.Struct({ v: Schema.Finite }) }),
        Schema.Struct({ p: open }),
      ]);
      yield* jsonRefusal(
        Body.jsonSchema(nested).encode({ p: { v: NaN, extra: "keep" } }),
        '$["p"]["v"] must be a finite number',
      );
    }),
  );

  it.effect(
    "validates the value JSON would write without reading an array position or getter twice",
    () =>
      Effect.gen(function* () {
        const hidden = Object.defineProperty([1], "0", {
          value: NaN,
          enumerable: false,
        });
        const inherited = [1];
        delete inherited[0];
        Object.setPrototypeOf(inherited, { 0: NaN });
        const custom = Object.defineProperty({}, "toJSON", {
          value: () => ({ v: NaN }),
        });
        for (const array of [hidden, inherited])
          yield* jsonRefusal(
            Body.json.encode(array),
            "$[0] must be a finite number",
          );
        yield* jsonRefusal(
          Body.json.encode(custom),
          '$["v"] must be a finite number',
        );

        for (const first of [NaN, 1]) {
          let reads = 0;
          const read = () => (++reads === 1 ? first : first === 1 ? NaN : 1);
          const changing = {
            get v() {
              return read();
            },
          };
          if (first === 1)
            expect(textOf(yield* Body.json.encode(changing))).toBe('{"v":1}');
          else
            yield* jsonRefusal(
              Body.json.encode(changing),
              '$["v"] must be a finite number',
            );
          expect(reads).toBe(1);
        }

        let calls = 0;
        const keep = {
          v: NaN,
          [symbol]: "original",
          toJSON() {
            calls++;
            return { v: 42 };
          },
        };
        expect(
          textOf(
            yield* Body.json.encode({
              keep,
              absent: undefined,
              [symbol]: undefined,
            }),
          ),
        ).toBe('{"keep":{"v":42}}');
        expect(calls).toBe(1);
      }),
  );

  it.effect(
    "preserves a typed failure for cycles and accepts shared values",
    () =>
      Effect.gen(function* () {
        const shared = { v: 1 };
        expect(textOf(yield* Body.json.encode([shared, shared]))).toBe(
          '[{"v":1},{"v":1}]',
        );
        const cycle: { next?: unknown } = {};
        cycle.next = cycle;
        yield* jsonRefusal(
          Body.json.encode(cycle),
          '$["next"] contains a circular reference',
        );
      }),
  );

  it.effect("keeps JSON writer exceptions from caller code as defects", () =>
    Effect.gen(function* () {
      const defect = new TypeError("caller code");
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      for (const value of [
        {
          toJSON() {
            throw defect;
          },
        },
        {
          get v() {
            throw defect;
          },
        },
        new Proxy(
          {},
          {
            ownKeys() {
              throw defect;
            },
          },
        ),
      ]) {
        expect(yield* Effect.exit(Body.json.encode(value))).toEqual(
          Exit.die(defect),
        );
      }
      expect(yield* Effect.exit(Body.json.encode(revoked.proxy))).toMatchObject(
        {
          cause: { reasons: [{ _tag: "Die", defect: expect.any(TypeError) }] },
        },
      );
    }),
  );

  it.effect("refuses values that multipart would omit, with their path", () =>
    Effect.gen(function* () {
      const leaf = "must be text, a Blob or File, or a form container";
      for (const [input, message] of [
        [{ v: NaN, extra: "keep" }, `$["v"] ${leaf}`],
        [{ v: null }, `$["v"] ${leaf}`],
        [{ v: new Date(0) }, '$["v"] cannot encode Date'],
        [{ v: ["keep", { inner: 1 }] }, `$["v"][1]["inner"] ${leaf}`],
        [
          { v: ["keep", undefined] },
          '$["v"][1] cannot encode undefined in a list',
        ],
        [{ [symbol]: "v" }, "$[Symbol(extra)] must have a string field name"],
      ] as const) {
        const error = yield* Effect.flip(multipart.encode(input));
        expect(error).toBeInstanceOf(HttpBody.HttpBodyError);
        expect(error.message).toBe(`Multipart body at ${message}`);
      }
    }),
  );

  it.effect(
    "writes existing multipart bracket paths, repeated values and files",
    () =>
      Effect.gen(function* () {
        const file = new File(["content"], "sample.txt");
        const body = yield* multipart.encode({
          person: { name: "Ada", absent: undefined },
          tags: ["first", "second"],
          mixed: ["text", { name: "other" }],
          file,
        });
        expect(
          body._tag === "FormData" && Array.from(body.formData.entries()),
        ).toEqual([
          ["person[name]", "Ada"],
          ["tags", "first"],
          ["tags", "second"],
          ["mixed[0]", "text"],
          ["mixed[1][name]", "other"],
          ["file", file],
        ]);
      }),
  );

  it.effect(
    "checks a form schema through a lazy link and lets caller exceptions die",
    () =>
      Effect.gen(function* () {
        const defect = new TypeError("caller getter");
        let contract: Schema.fromFormData<typeof open> | undefined = undefined;
        const suspended = Schema.suspend(() => {
          if (!contract) throw new Error("encoder construction must stay lazy");
          return contract;
        });
        const lazy = Body.formData.pipe(Body.encodeSchema(suspended));
        contract = Schema.fromFormData(open);
        const error = yield* Effect.flip(lazy.encode({ bad: true }));
        expect(error.message).toContain('["bad"]');
        const result = yield* Effect.exit(
          lazy.encode({
            nested: {
              get bad() {
                throw defect;
              },
            },
          }),
        );
        expect(result).toEqual(Exit.die(defect));
      }),
  );

  it.effect(
    "checks both schema-backed and prepared URL-encoded form fields",
    () =>
      Effect.gen(function* () {
        const fromSearchParams = Body.encoder((params: URLSearchParams) =>
          Effect.sync(() => HttpBody.urlParams(params)),
        ).pipe(Body.encodeSchema(Schema.fromURLSearchParams(open)));
        const failure = yield* Effect.flip(
          fromSearchParams.encode({ bad: false }),
        );
        expect(failure.message).toContain('["bad"]');
        expect(textOf(yield* fromSearchParams.encode({ k: ["a", "b"] }))).toBe(
          "k=a&k=b",
        );
        const prepared = new URLSearchParams("k=a&k=b");
        expect(textOf(yield* fromSearchParams.encode(prepared))).toBe(
          "k=a&k=b",
        );

        const record = Body.urlEncoded.pipe(
          Body.encodeSchema(Schema.RecordFromUrlParams),
        );
        expect(textOf(yield* record.encode({ k: ["a", "b"] }))).toBe("k=a&k=b");
        const bad = yield* Effect.flip(
          Body.urlEncoded.encode(UrlParams.make([["k", { x: 1 } as never]])),
        );
        expect(bad.message).toContain('["k"]');
        expect(
          textOf(
            yield* Body.urlEncoded.encode(
              UrlParams.make([["k", Redacted.make("a+b")]]),
            ),
          ),
        ).toBe("k=a%2Bb");
      }),
  );
});

const bodyError = <A>(write: Effect.Effect<A, unknown>, message: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(write);
    expect(error).toBeInstanceOf(HttpBody.HttpBodyError);
    expect(error).toHaveProperty("message", message);
  });

const deepArray = (count: number) => {
  const root: unknown[] = [];
  let tail = root;
  for (let index = 0; index < count; index++) {
    const child: unknown[] = [];
    tail.push(child);
    tail = child;
  }
  return root;
};

const deepObject = (count: number) => {
  const root: Record<string, unknown> = {};
  let tail = root;
  for (let index = 0; index < count; index++) {
    const child: Record<string, unknown> = {};
    tail["n"] = child;
    tail = child;
  }
  return root;
};

const jsonText = (value: unknown) =>
  textOf(Effect.runSync(Body.json.encode(value)));

/** A built-in whose standard tag a tag property hides. */
const tagged = <A extends object>(value: A): A =>
  Object.defineProperty(value, Symbol.toStringTag, {
    value: "Object",
    configurable: true,
  });

/** The JSON writer as it loads without Node's brand helpers, as in a browser. */
const portableWriter = async () => {
  const builtin = Object.getOwnPropertyDescriptor(process, "getBuiltinModule")!;
  try {
    Object.defineProperty(process, "getBuiltinModule", {
      ...builtin,
      value: undefined,
    });
    vi.resetModules();
    return await import("./internal/json-body.js");
  } finally {
    Object.defineProperty(process, "getBuiltinModule", builtin);
    vi.resetModules();
  }
};

const taggedBuiltins = () =>
  [
    ["Map", tagged(new Map([["k", "v"]]))],
    ["Set", tagged(new Set(["v"]))],
    ["WeakMap", tagged(new WeakMap())],
    ["WeakSet", tagged(new WeakSet())],
    ["ArrayBuffer", tagged(new ArrayBuffer(1))],
    ["RegExp", tagged(/x/)],
    ["Error", tagged(new Error("hidden"))],
    ["Promise", tagged(Promise.resolve(1))],
    ["Array Iterator", tagged([1].values())],
    ["Map Iterator", tagged(new Map().keys())],
    ["Generator", tagged((function* () {})())],
  ] as const;

// https://github.com/viell-dev/slop-effect-schema-http/issues/256
describe("writers keep or refuse what they cannot write", () => {
  const symbol = Symbol("extra");
  const supplied = () => ({ a: 1, [symbol]: "kept" });
  const form = Body.formData.pipe(
    Body.encodeSchema(Schema.fromFormData(Schema.Struct({}))),
  );
  const urlForm = Body.encoder((params: URLSearchParams) =>
    Effect.sync(() =>
      HttpBody.text(params.toString(), "application/x-www-form-urlencoded"),
    ),
  ).pipe(Body.encodeSchema(Schema.fromURLSearchParams(Schema.Struct({}))));
  it.effect("refuses JSON objects whose content is not in their fields", () =>
    Effect.gen(function* () {
      for (const [kind, value] of [
        ["Map", new Map([["k", "v"]])],
        ["Set", new Set(["v"])],
        ["WeakMap", new WeakMap()],
        ["WeakSet", new WeakSet()],
        ["ArrayBuffer", new ArrayBuffer(1)],
        ["Uint8Array", new Uint8Array([65])],
        ["Float64Array", new Float64Array([1])],
        ["DataView", new DataView(new ArrayBuffer(1))],
        ["RegExp", /x/],
        ["Error", new Error("hidden")],
        ["URLSearchParams", new URLSearchParams("k=v")],
        ["FormData", new FormData()],
        ["Headers", new Headers({ k: "v" })],
        ["Blob", new Blob(["bytes"])],
        ["File", new File(["bytes"], "sample.txt")],
        ["Promise", Promise.resolve(1)],
        ["a boxed symbol", Object(Symbol("s")) as object],
      ] as const) {
        const message = `JSON body at $["v"] cannot encode ${kind}`;
        yield* jsonRefusal(Body.json.encode({ v: value }), message);
        yield* jsonRefusal(
          Body.json.encode({ v: { toJSON: () => value } }),
          message,
        );
      }
      const reparented = Object.setPrototypeOf(new Map([["k", 1]]), null);
      yield* jsonRefusal(
        Body.json.encode([reparented]),
        "$[0] cannot encode Map",
      );
      const map = Body.json.pipe(
        Body.encodeSchema(Schema.ReadonlyMap(Schema.String, Schema.Number)),
      );
      yield* jsonRefusal(
        map.encode(new Map([["k", 1]])),
        "$ cannot encode Map",
      );
    }),
  );

  it.effect(
    "writes objects whose content is their fields or their toJSON",
    () =>
      Effect.gen(function* () {
        class Point {
          constructor(
            readonly x: number,
            readonly y: number,
          ) {}
        }
        class Person extends Schema.Class<Person>("Person")({
          name: Schema.String,
        }) {}
        const omitted = { toJSON: () => undefined };
        const value = {
          plain: { a: 1 },
          empty: {},
          bare: Object.assign(Object.create(null) as object, { a: 1 }),
          point: new Point(1, 2),
          person: new Person({ name: "Ada" }),
          option: Option.some(1),
          chunk: Chunk.make("value"),
          stamp: DateTime.makeUnsafe("2026-01-01"),
          invalid: new Date(NaN),
          boxes: [Object(1), Object("s"), Object(false)],
          omitted,
        };
        const text = textOf(yield* Body.json.encode(value));
        expect(text).toBe(JSON.stringify(value));
        expect(JSON.parse(text)).toMatchObject({ invalid: null });
        yield* jsonRefusal(
          Body.json.encode([omitted]),
          "$[0] cannot encode undefined in an array",
        );
      }),
  );

  it("calls an inherited toJSON once per value, as native JSON does", () => {
    let calls = 0;
    // oxlint-disable-next-line no-extend-native -- Exercise an inherited toJSON, then remove it below.
    Object.defineProperty(Object.prototype, "toJSON", {
      value(this: unknown) {
        calls++;
        return this;
      },
      configurable: true,
      writable: true,
    });
    try {
      const value = { a: [1, { b: 2 }] };
      const text = textOf(Effect.runSync(Body.json.encode(value)));
      const written = calls;
      calls = 0;
      expect(text).toBe(JSON.stringify(value));
      expect(written).toBe(calls);
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it("copies fields that an assignment would not create", () => {
    const parsed: unknown = JSON.parse('{"__proto__":1,"toString":2,"a":[3]}');
    expect(jsonText(parsed)).toBe('{"__proto__":1,"toString":2,"a":[3]}');
    let sets = 0;
    const setter = {
      set() {
        sets++;
      },
      configurable: true,
    };
    // oxlint-disable-next-line no-extend-native -- Exercise inherited setters, then remove them below.
    Object.defineProperty(Object.prototype, "polluted", setter);
    try {
      expect(jsonText({ polluted: 1 })).toBe('{"polluted":1}');
      expect(sets).toBe(0);
    } finally {
      delete (Object.prototype as { polluted?: unknown }).polluted;
    }
    const hole: unknown[] = [];
    hole[1] = "b";
    // oxlint-disable-next-line no-extend-native -- Exercise an inherited position, then remove it below.
    Object.defineProperty(Array.prototype, "0", {
      value: "inherited",
      writable: true,
      configurable: true,
    });
    try {
      expect(jsonText({ hole })).toBe(JSON.stringify({ hole }));
    } finally {
      delete (Array.prototype as { 0?: unknown })[0];
      // Deleting a position leaves the prototype's length behind.
      // oxlint-disable-next-line no-extend-native -- Restore the prototype after this isolated test.
      Array.prototype.length = 0;
    }
  });

  it.effect(
    "refuses symbols a class, a linked record or the ObjectKeyword codec drops",
    () =>
      Effect.gen(function* () {
        const record = Schema.Record(Schema.String, Schema.Unknown);
        class Holder extends Schema.Class<Holder>("SymbolHolder")({
          meta: record,
        }) {}
        class KeywordHolder extends Schema.Class<KeywordHolder>(
          "KeywordHolder",
        )({
          o: Schema.ObjectKeyword,
        }) {}
        const linked = record.pipe(Schema.decodeTo(Schema.Struct({})));
        for (const [encode, path] of [
          [
            Body.jsonSchema(Holder).encode({ meta: supplied() }),
            '["meta"][Symbol(extra)]',
          ],
          [
            Body.json
              .pipe(Body.encodeSchema(Holder))
              .encode({ meta: supplied() }),
            '["meta"][Symbol(extra)]',
          ],
          [
            Body.jsonSchema(Schema.Array(Holder)).encode([
              { meta: supplied() },
            ]),
            '[0]["meta"][Symbol(extra)]',
          ],
          [
            Body.jsonSchema(Holder).encode({
              meta: {},
              [symbol]: "kept",
            } as never),
            "[Symbol(extra)]",
          ],
          [
            Body.jsonSchema(KeywordHolder).encode({ o: supplied() }),
            '["o"][Symbol(extra)]',
          ],
          [Body.jsonSchema(linked).encode(supplied()), "[Symbol(extra)]"],
          [
            Body.json.pipe(Body.encodeSchema(linked)).encode(supplied()),
            "[Symbol(extra)]",
          ],
          [
            Body.jsonSchema(Schema.ObjectKeyword).encode(
              Object.assign([1], { extra: "keep" }),
            ),
            '["extra"]',
          ],
          [
            Body.jsonSchema(Schema.ObjectKeyword).encode(
              Object.assign([1], { [symbol]: "keep" }),
            ),
            "[Symbol(extra)]",
          ],
        ] as const) {
          const error = yield* Effect.flip(encode);
          expect(error).toBeInstanceOf(Schema.SchemaError);
          expect(error.message).toContain("at " + path);
        }
        const instance = new Holder({ meta: { a: 1 } });
        expect(textOf(yield* Body.jsonSchema(Holder).encode(instance))).toBe(
          '{"meta":{"a":1}}',
        );
      }),
  );

  it.effect(
    "refuses built-ins a tag property disguises, and a reparented BigInt box with fields",
    () =>
      Effect.gen(function* () {
        for (const [kind, value] of taggedBuiltins())
          yield* jsonRefusal(
            Body.json.encode({ v: value }),
            `$["v"] cannot encode ${kind}`,
          );
        const box = Object.assign(
          Object.setPrototypeOf(Object(1n), Object.prototype),
          { a: 1 },
        );
        yield* jsonRefusal(
          Body.json.encode({ v: box }),
          '$["v"] cannot encode a bigint',
        );
      }),
  );

  it.effect(
    "refuses a deep value in linear time",
    () =>
      Effect.gen(function* () {
        // A quadratic path took about 15 s at 256,000 levels; a linear one takes about 1 s.
        const depth = 200_000;
        let list: unknown = Infinity;
        let record: unknown = Infinity;
        let nestedForm: unknown = null;
        for (let index = 0; index < depth; index++) {
          list = [list];
          record = { n: record };
          nestedForm = { n: nestedForm };
        }
        for (const [write, prefix] of [
          [Body.json.encode(list), "JSON body at $[0][0]"],
          [Body.json.encode(record), 'JSON body at $["n"]["n"]'],
          [
            Body.urlEncoded.encode(nestedForm as never),
            'URL-encoded body at $["n"]["n"]',
          ],
        ] as const) {
          const start = performance.now();
          const error = yield* Effect.flip(write);
          expect(performance.now() - start).toBeLessThan(6_000);
          expect(error.message.startsWith(prefix)).toBe(true);
        }
      }),
    60_000,
  );

  it.effect("refuses extra fields on arrays and boxes", () =>
    Effect.gen(function* () {
      const converted = Object.assign(Object(1), {
        [Symbol.toPrimitive]: () => 5,
      });
      expect(textOf(yield* Body.json.encode({ v: converted }))).toBe('{"v":5}');
      yield* jsonRefusal(
        Body.json.encode({ v: Object.assign([1], { extra: "kept" }) }),
        '$["v"]["extra"] cannot encode an extra array field',
      );
      yield* jsonRefusal(
        Body.json.encode({ v: Object.assign([1], { [symbol]: "kept" }) }),
        '$["v"][Symbol(extra)] cannot encode an extra array field',
      );
      yield* jsonRefusal(
        Body.json.encode({ v: Object.assign(Object(1), { extra: "kept" }) }),
        '$["v"]["extra"] cannot encode a field of a boxed number',
      );
      const accessor = Object.defineProperty([1], "extra", {
        get: () => {
          throw new Error("an accessor outside the positions is not read");
        },
        enumerable: true,
      });
      yield* jsonRefusal(
        Body.json.encode(accessor),
        '$["extra"] cannot encode an extra array field',
      );
      const absent = Object.assign([1], { extra: undefined });
      expect(textOf(yield* Body.json.encode(absent))).toBe("[1]");
    }),
  );

  it.effect("refuses symbol fields Effect drops before the JSON writer", () =>
    Effect.gen(function* () {
      const keyword = Body.jsonSchema(Schema.ObjectKeyword);
      const nested = Body.jsonSchema(
        Schema.Struct({ p: Schema.Array(Schema.ObjectKeyword) }),
      );
      const indexed = Body.jsonSchema(
        Schema.Record(Schema.String, Schema.FiniteFromString),
      );
      const suspended = Body.jsonSchema(
        Schema.suspend(() => Schema.Record(Schema.String, Schema.Unknown)),
      );
      for (const [encode, path] of [
        [keyword.encode({ a: "1", [symbol]: "kept" }), "at [Symbol(extra)]"],
        [
          nested.encode({ p: [{ a: "1", [symbol]: "kept" }] }),
          'at ["p"][0][Symbol(extra)]',
        ],
        [indexed.encode({ a: "1", [symbol]: "kept" }), "at [Symbol(extra)]"],
        [indexed.encode({ a: 1, [symbol]: "kept" }), "at [Symbol(extra)]"],
        [suspended.encode({ a: 1, [symbol]: "kept" }), "at [Symbol(extra)]"],
      ] as const) {
        const error = yield* Effect.flip(encode);
        expect(error).toBeInstanceOf(Schema.SchemaError);
        expect(error.message).toContain(path);
      }
      // A nested value keeps its identity through the ObjectKeyword codec, so the writer sees it.
      yield* jsonRefusal(
        keyword.encode({ a: { [symbol]: "kept" } }),
        '$["a"][Symbol(extra)] cannot encode a symbol field name',
      );
    }),
  );

  it.effect("adds no depth limit of its own and types the engine's", () =>
    Effect.gen(function* () {
      // Engines differ: recent ones write plain data at any depth, older ones run out of stack.
      // Effect's HttpBody.json, 0.18.0's writer, is the reference, in this same pipeline.
      // 4,000 levels fit Node 24's native limit, so a limit of the writer's own fails there too.
      for (const depth of [4_000, 2 ** 16])
        for (const nest of [deepArray, deepObject]) {
          const reference = yield* Effect.exit(HttpBody.json(nest(depth)));
          const exit = yield* Effect.exit(Body.json.encode(nest(depth)));
          if (Exit.isSuccess(reference)) {
            expect(Exit.isSuccess(exit) && textOf(exit.value)).toBe(
              textOf(reference.value),
            );
            continue;
          }
          expect(reference.cause.reasons[0]).toHaveProperty(
            "error.cause",
            expect.any(RangeError),
          );
          // Where the reference runs out of stack, the writer fails with a typed error, not a defect.
          const reason = Exit.isFailure(exit)
            ? exit.cause.reasons[0]
            : undefined;
          expect(reason?._tag).toBe("Fail");
          const failure = reason?._tag === "Fail" ? reason.error : undefined;
          expect(failure).toBeInstanceOf(HttpBody.HttpBodyError);
          expect(failure).toHaveProperty("reason._tag", "JsonError");
          expect(failure).toHaveProperty("cause", expect.any(RangeError));
          expect(failure).toHaveProperty(
            "message",
            expect.stringContaining("JSON body could not be written"),
          );
        }
      for (const box of [
        Object.setPrototypeOf(Object(5), null),
        Object.setPrototypeOf(Object("s"), null),
      ])
        yield* jsonRefusal(Body.json.encode(box), "$ cannot convert a boxed");
    }),
  );

  it.effect("refuses what text, bytes and empty bodies cannot write", () =>
    Effect.gen(function* () {
      for (const [write, message] of [
        [
          Body.text.encode({ a: "1" } as never),
          "Text body at $ must be a string",
        ],
        [
          Body.bytes.encode(["a", "b"] as never),
          "Bytes body at $ must be a Uint8Array",
        ],
        [
          Body.bytes.encode(new Uint16Array([1]) as never),
          "Bytes body at $ must be a Uint8Array",
        ],
        [
          Body.empty.encode("kept" as never),
          "Empty body at $ must have no value",
        ],
        [
          Body.text.pipe(Body.encodeSchema(Schema.Any)).encode({ a: 1 }),
          "Text body at $ must be a string",
        ],
      ] as const)
        yield* bodyError(write, message);
      const bytes = runInNewContext("new Uint8Array([65])") as Uint8Array;
      expect(textOf(yield* Body.bytes.encode(bytes))).toBe("A");
      expect(textOf(yield* Body.bytes.encode(Buffer.from("B")))).toBe("B");
      expect((yield* Body.empty.encode(undefined))._tag).toBe("Empty");
    }),
  );

  it.effect(
    "sends a form from another implementation and refuses a non-form",
    () =>
      Effect.gen(function* () {
        class OtherFormData {
          readonly #entries: Array<[string, string]> = [["k", "v"]];
          append(name: string, value: string) {
            this.#entries.push([name, value]);
          }
          entries() {
            return this.#entries[Symbol.iterator]();
          }
          get [Symbol.toStringTag]() {
            return "FormData";
          }
        }
        const other = new OtherFormData() as unknown as FormData;
        for (const write of [Body.formData.encode(other), form.encode(other)]) {
          const body = yield* write;
          expect(body._tag === "FormData" && body.formData).toBe(other);
        }
        for (const value of [{ k: "v" }, new URLSearchParams("k=v"), "k=v"])
          yield* bodyError(
            Body.formData.encode(value as never),
            "Multipart body at $ must be FormData",
          );
      }),
  );

  it.effect(
    "writes empty form containers as no entries and refuses what forms drop",
    () =>
      Effect.gen(function* () {
        const body = yield* form.encode({
          none: [],
          nothing: {},
          bare: Object.create(null) as object,
          foreign: runInNewContext("({})") as object,
          k: "v",
        });
        expect(
          body._tag === "FormData" && Array.from(body.formData.entries()),
        ).toEqual([["k", "v"]]);
        const cycle: Record<string, unknown> = { k: "v" };
        cycle["self"] = cycle;
        for (const [input, message] of [
          [
            { v: Object.assign(["a"], { extra: "keep" }) },
            '$["v"]["extra"] cannot encode an extra array field',
          ],
          [cycle, '$["self"] contains circular form data'],
          [new URLSearchParams("k=v"), "$ cannot encode URLSearchParams"],
          [new Map([["k", "v"]]), "$ cannot encode Map"],
          [{ v: Object("s") as object }, '$["v"] cannot encode a boxed string'],
          [
            { v: Redacted.make("secret") },
            '$["v"] must be text, a Blob or File, or a form container',
          ],
          [
            {
              v: new (class Sealed {
                readonly #secret = "kept";
                reveal() {
                  return this.#secret;
                }
              })(),
            },
            '$["v"] has no own fields a form can write',
          ],
        ] as const)
          yield* bodyError(form.encode(input), `Multipart body at ${message}`);
        yield* bodyError(
          urlForm.encode({ v: new Blob(["x"]) }),
          'URL-encoded body at $["v"] cannot encode Blob',
        );
        yield* bodyError(
          urlForm.encode({ v: 1 }),
          'URL-encoded body at $["v"] must be text or a form container',
        );
        let nested: Record<string, unknown> = { leaf: "v" };
        for (let index = 0; index < 5_000; index++) nested = { n: nested };
        const deepForm = yield* form.encode(nested);
        expect(
          deepForm._tag === "FormData" &&
            Array.from(deepForm.formData.keys()).map((key) => key.length),
        ).toEqual(["n".length + "[n]".length * 4_999 + "[leaf]".length]);
      }),
  );

  it.effect("reports URL-encoded pair refusals with their path", () =>
    Effect.gen(function* () {
      for (const [params, message] of [
        [
          UrlParams.make([["k", { x: 1 } as never]]),
          '$["k"] must be text, a number, a bigint or a boolean',
        ],
        [
          UrlParams.make(
            Object.assign([["k", "v"]], { extra: "keep" }) as never,
          ),
          '$["extra"] cannot encode an extra array field',
        ],
        [
          UrlParams.make([
            Object.assign(["k", "v"], { extra: "keep" }),
          ] as never),
          '$[0]["extra"] cannot encode an extra array field',
        ],
      ] as const)
        yield* bodyError(
          Body.urlEncoded.encode(params as never),
          `URL-encoded body at ${message}`,
        );
    }),
  );

  it("checks values in the portable JSON path without Node brand helpers", async () => {
    const portable = await portableWriter();
    const write = (value: unknown) =>
      Effect.runSync(Effect.exit(portable.encode(value)));
    const written = (value: unknown) => {
      const exit = write(value);
      if (!Exit.isSuccess(exit)) throw new Error("expected a body");
      return textOf(exit.value);
    };
    const refused = (value: unknown) => {
      const exit = write(value);
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
      return reason?._tag === "Fail" ? reason.error.message : "written";
    };
    expect(
      written(runInNewContext("({ k: new Number(4), other: { x: 1 } })")),
    ).toBe('{"k":4,"other":{"x":1}}');
    expect(written({ empty: {}, bare: Object.create(null) as object })).toBe(
      '{"empty":{},"bare":{}}',
    );
    for (const [expression, message] of [
      [
        "Object.setPrototypeOf(Object(2n), Object.prototype)",
        "cannot encode a bigint",
      ],
      ["Object.setPrototypeOf(Object(2n), null)", "cannot encode a bigint"],
      [
        'Object.setPrototypeOf(Object(Symbol("x")), null)',
        "cannot encode a boxed symbol",
      ],
      ["Object.setPrototypeOf(new Map([[1, 2]]), null)", "cannot encode Map"],
      [
        "Object.defineProperty(new Number(NaN), Symbol.toStringTag, { value: 'Plain' })",
        "must be a finite number",
      ],
      ["new Number(NaN)", "must be a finite number"],
      ['new Map([["k", "v"]])', "cannot encode Map"],
    ] as const)
      expect(refused({ v: runInNewContext(expression) })).toContain(message);
    expect(refused({ v: new Blob(["bytes"]) })).toContain("cannot encode Blob");
    for (const [kind, value] of taggedBuiltins())
      expect(refused({ v: value })).toContain(`cannot encode ${kind}`);
  });
});

describe("Body.json", () => {
  it.effect("encodes JSON with its content type", () =>
    Effect.gen(function* () {
      const body = yield* Body.json.encode({ name: "Ada", tags: ["x"] });
      expect(contentTypeOf(body)).toBe("application/json");
      expect(JSON.parse(textOf(body))).toEqual({ name: "Ada", tags: ["x"] });
    }),
  );

  it.effect("fails encoding a value JSON cannot represent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Body.json.encode({ id: 1n }));
      expect(error).toBeInstanceOf(HttpBody.HttpBodyError);
    }),
  );

  it.effect(
    "encodes undefined as an empty JSON body and refuses a function or symbol",
    () =>
      Effect.gen(function* () {
        const body = yield* Body.json.encode(undefined);
        expect(contentTypeOf(body)).toBe("application/json");
        expect(bytesOf(body).length).toBe(0);
        for (const value of [() => 1, Symbol("x")]) {
          const error = yield* Effect.flip(Body.json.encode(value));
          expect(error).toHaveProperty(
            "cause.message",
            expect.stringContaining("JSON body at $"),
          );
        }
      }),
  );

  it.effect("decodes any JSON value, including null", () =>
    Effect.gen(function* () {
      expect(yield* Body.json.decode(reply('{"a":[1,true,null]}'))).toEqual({
        a: [1, true, null],
      });
      expect(yield* Body.json.decode(reply("null"))).toBeNull();
      expect(yield* Body.json.decode(reply("42"))).toBe(42);
    }),
  );

  it.effect("ignores the response content type", () =>
    Effect.gen(function* () {
      expect(
        yield* Body.json.decode(reply('{"ok":true}', "text/html")),
      ).toEqual({ ok: true });
    }),
  );

  it.effect("rejects an empty body as a decode error rather than null", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Body.json.decode(reply("", "application/json")),
      );
      expect(decodeErrorReason(exit)._tag).toBe("DecodeError");
    }),
  );

  it.effect("rejects malformed JSON as a decode error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Body.json.decode(reply(")]}',\n{}", "application/json")),
      );
      const reason = decodeErrorReason(exit);
      expect(reason._tag).toBe("DecodeError");
      expect(reason).toMatchObject({ cause: expect.any(SyntaxError) });
    }),
  );

  it("advertises application/json", () => {
    expect(Body.json.mediaType).toBe("application/json");
  });
});

describe("Body.text", () => {
  it.effect("encodes UTF-8 text/plain", () =>
    Effect.gen(function* () {
      const body = yield* Body.text.encode("Grüße ✓");
      expect(contentTypeOf(body)).toBe("text/plain");
      expect(Array.from(bytesOf(body))).toEqual(
        Array.from(new TextEncoder().encode("Grüße ✓")),
      );
    }),
  );

  it.effect("decodes UTF-8 text", () =>
    Effect.gen(function* () {
      expect(yield* Body.text.decode(reply("Grüße ✓"))).toBe("Grüße ✓");
      expect(yield* Body.text.decode(reply(null))).toBe("");
    }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/27
  it.effect(
    "uses lenient UTF-8 decoding even when Content-Type names another charset",
    () =>
      Effect.gen(function* () {
        const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xe4, 0xff]);
        expect(
          yield* Body.text.decode(
            reply(input, "text/plain; charset=iso-8859-1"),
          ),
        ).toBe("A\ufffd\ufffd");
        expect(Array.from(yield* Body.bytes.decode(reply(input)))).toEqual(
          Array.from(input),
        );
      }),
  );

  it("advertises text/plain", () => {
    expect(Body.text.mediaType).toBe("text/plain");
  });
});

describe("Body.bytes", () => {
  it.effect("encodes the exact bytes as application/octet-stream", () =>
    Effect.gen(function* () {
      const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x00, 0xff]);
      const body = yield* Body.bytes.encode(input);
      expect(contentTypeOf(body)).toBe("application/octet-stream");
      expect(Array.from(bytesOf(body))).toEqual(Array.from(input));
    }),
  );

  it.effect("decodes the exact bytes, keeping a BOM and invalid UTF-8", () =>
    Effect.gen(function* () {
      const input = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xe4, 0xff]);
      const decoded = yield* Body.bytes.decode(reply(input, "text/csv"));
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(Array.from(decoded)).toEqual(Array.from(input));
    }),
  );

  it("advertises application/octet-stream", () => {
    expect(Body.bytes.mediaType).toBe("application/octet-stream");
  });
});

describe("Body.formData", () => {
  // https://github.com/viell-dev/slop-effect-schema-http/issues/256
  it.effect(
    "keeps a prepared form through an open schema and refuses a non-form",
    () =>
      Effect.gen(function* () {
        const open = Body.formData.pipe(
          Body.encodeSchema(Schema.fromFormData(Schema.Struct({}))),
        );
        const prepared = new FormData();
        prepared.append("k", "v");
        const body = yield* open.encode(prepared);
        expect(
          body._tag === "FormData" && Array.from(body.formData.entries()),
        ).toEqual([["k", "v"]]);
        const failure = yield* Effect.flip(
          Body.formData.pipe(Body.encodeSchema(Schema.Any)).encode({ k: "v" }),
        );
        expect(failure).toBeInstanceOf(HttpBody.HttpBodyError);
        expect(failure.message).toBe("Multipart body at $ must be FormData");
      }),
  );

  it.effect(
    "encodes FormData and leaves its Content-Type to the transport",
    () =>
      Effect.gen(function* () {
        const form = new FormData();
        form.append("label", "report");
        const body = yield* Body.formData.encode(form);
        expect(body._tag).toBe("FormData");
        expect(contentTypeOf(body)).toBeUndefined();
      }),
  );

  it.effect("decodes a multipart response", () =>
    Effect.gen(function* () {
      const form = new FormData();
      form.append("meta", '{"id":1}');
      form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "data.bin");
      const decoded = yield* Body.formData.decode(
        response(new globalThis.Response(form)),
      );
      expect(decoded.get("meta")).toBe('{"id":1}');
      const file = decoded.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect(
        Array.from(
          new Uint8Array(
            yield* Effect.promise(() => (file as Blob).arrayBuffer()),
          ),
        ),
      ).toEqual([1, 2, 3]);
    }),
  );
});

describe("Body.urlEncoded", () => {
  it.effect("encodes ordered parameters as form-urlencoded", () =>
    Effect.gen(function* () {
      const body = yield* Body.urlEncoded.encode(
        UrlParams.fromInput([
          ["grant_type", "password"],
          ["scope", "a b"],
          ["scope", "c"],
        ]),
      );
      expect(contentTypeOf(body)).toBe("application/x-www-form-urlencoded");
      expect(textOf(body)).toBe("grant_type=password&scope=a+b&scope=c");
    }),
  );

  it.effect(
    "decodes a form-urlencoded response with every value as a string",
    () =>
      Effect.gen(function* () {
        const params = yield* Body.urlEncoded.decode(
          reply("access_token=t&expires_in=3600&scope=a&scope=b"),
        );
        expect(params.params).toEqual([
          ["access_token", "t"],
          ["expires_in", "3600"],
          ["scope", "a"],
          ["scope", "b"],
        ]);
      }),
  );
});

/** The message of `Body.urlEncoded`'s refusal of a value only JavaScript can pass. */
const urlEncodedRefusal = (value: unknown) =>
  Effect.map(
    Effect.flip(Body.urlEncoded.encode(value as never)),
    (error) => error.message,
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/256
describe("Body.urlEncoded from untyped callers", () => {
  it.effect("writes what UrlParams.fromInput reads, as 0.18.0 did", () =>
    Effect.gen(function* () {
      for (const [value, text] of [
        [{ k: "v" }, "k=v"],
        [
          {
            k: "a b",
            n: 1,
            on: true,
            big: 10n,
            list: ["x", "y"],
            absent: undefined,
          },
          "k=a+b&n=1&on=true&big=10&list=x&list=y",
        ],
        [{ a: { b: "1", c: { d: "2" } } }, "a%5Bb%5D=1&a%5Bc%5D%5Bd%5D=2"],
        [
          { token: Redacted.make("secret"), none: [], nothing: {} },
          "token=secret",
        ],
        [new URLSearchParams("k=v&k=w&e=a+b"), "k=v&k=w&e=a+b"],
        [
          [
            ["k", "v"],
            ["k", "w"],
          ],
          "k=v&k=w",
        ],
        [{ m: new Map([["k", "v"]]) }, "m%5Bk%5D=v"],
        [UrlParams.make([["n", 1 as never]]), "n=1"],
      ] as const)
        expect(textOf(yield* Body.urlEncoded.encode(value as never))).toBe(
          text,
        );
    }),
  );

  it.effect(
    "refuses what that reading would drop or write as something else",
    () =>
      Effect.gen(function* () {
        const scalar =
          "must be text, a number, a bigint, a boolean, or a record of them";
        for (const [value, message] of [
          [{ k: "v", d: new Date(0) }, '$["d"] cannot encode Date'],
          [{ k: null }, `$["k"] ${scalar}`],
          [{ k: Symbol("s") }, `$["k"] ${scalar}`],
          [{ k: Redacted.make({ a: 1 }) }, `$["k"] ${scalar}`],
          [
            { k: [["a"]] },
            '$["k"][0] cannot encode a list or an object inside a list',
          ],
          [
            { k: ["a", undefined] },
            '$["k"][1] cannot encode undefined in a list',
          ],
          [
            { k: Object.assign(["a"], { extra: "keep" }) },
            '$["k"]["extra"] cannot encode an extra array field',
          ],
          [
            { k: "v", [Symbol("s")]: "x" },
            "$[Symbol(s)] must have a string field name",
          ],
          [[["k", "v", "x"]], "$[0] must be a pair"],
          [[[1, "v"]], "$[0][0] must have a string name"],
          [
            UrlParams.make([["k", { a: 1 } as never]]),
            '$["k"] must be text, a number, a bigint or a boolean',
          ],
          ["k=v", "$ must be UrlParams, a record or field pairs"],
          [{ k: ["a", null] }, `$["k"][1] ${scalar}`],
          [
            Object.assign([["k", "v"]], { extra: "keep" }),
            '$["extra"] cannot encode an extra array field',
          ],
          [
            Object.assign([["k", "v"]], { [Symbol.for("extra")]: "keep" }),
            "$[Symbol(extra)] cannot encode an extra array field",
          ],
        ] as const)
          expect(yield* urlEncodedRefusal(value)).toBe(
            `URL-encoded body at ${message}`,
          );
      }),
  );
});

describe("Body.empty", () => {
  it.effect("encodes no body", () =>
    Effect.gen(function* () {
      expect((yield* Body.empty.encode())._tag).toBe("Empty");
    }),
  );

  it.effect("accepts a response without a body", () =>
    Effect.gen(function* () {
      yield* Body.empty.decode(response(emptyReply(204)));
      yield* Body.empty.decode(reply(null, "application/json"));
    }),
  );

  it.effect("drains an unexpected body completely", () =>
    Effect.gen(function* () {
      const probe = probeBody(["debug ", "output ", "that nobody declared"]);
      yield* Body.empty.decode(response(new globalThis.Response(probe.body)));
      expect(probe.chunksRead()).toBe(3);
      expect(probe.finished()).toBe(true);
    }),
  );

  it("contributes no media type", () => {
    expect(Body.empty.mediaType).toBeUndefined();
  });
});

describe("Body.map and Body.mapEffect", () => {
  it.effect("transform the decoded value and keep the media type", () =>
    Effect.gen(function* () {
      const length = Body.text.pipe(Body.map((value) => value.length));
      expect(length.mediaType).toBe("text/plain");
      expect(yield* length.decode(reply("abcd"))).toBe(4);

      const checked = Body.text.pipe(
        Body.mapEffect((value) =>
          value === "ok"
            ? Effect.succeed(true)
            : Effect.fail("not ok" as const),
        ),
      );
      expect(checked.mediaType).toBe("text/plain");
      expect(yield* checked.decode(reply("ok"))).toBe(true);
      expect(yield* Effect.flip(checked.decode(reply("no")))).toBe("not ok");
    }),
  );
});

describe("Body.decoder, encoder and make", () => {
  it.effect("build pipeable codecs from functions", () =>
    Effect.gen(function* () {
      const decoder = Body.decoder(
        (res) => Effect.map(res.text, (value) => value.toUpperCase()),
        "text/x-shout",
      );
      expect(decoder.mediaType).toBe("text/x-shout");
      expect(
        yield* decoder
          .pipe(Body.map((value) => `${value}!`))
          .decode(reply("hi")),
      ).toBe("HI!");
      expect(Body.decoder(() => Effect.void).mediaType).toBeUndefined();

      const encoder = Body.encoder((value: number) =>
        Effect.succeed(HttpBody.text(String(value), "text/x-number")),
      );
      expect(contentTypeOf(yield* encoder.encode(7))).toBe("text/x-number");

      const codec = Body.make({
        encode: (value: number) => Effect.succeed(HttpBody.text(String(value))),
        decode: (res) => Effect.map(res.text, Number),
      });
      expect(codec.mediaType).toBeUndefined();
      expect(yield* codec.decode(reply("12"))).toBe(12);
    }),
  );
});

describe("Body.schema", () => {
  const User = Schema.Struct({
    id: Schema.Number,
    name: Schema.NonEmptyString,
  });
  const users = Body.json.pipe(Body.schema(User));

  it.effect("validates the decoded value", () =>
    Effect.gen(function* () {
      expect(yield* users.decode(reply('{"id":1,"name":"Ada"}'))).toEqual({
        id: 1,
        name: "Ada",
      });
      expect(users.mediaType).toBe("application/json");
    }),
  );

  it.effect("fails with a SchemaError for an invalid value", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        users.decode(reply('{"id":1,"name":""}')),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  it.effect("applies the schema's decoding transformation", () =>
    Effect.gen(function* () {
      const count = Body.text.pipe(Body.schema(Schema.FiniteFromString));
      expect(yield* count.decode(reply("42"))).toBe(42);
      expect(
        Schema.isSchemaError(yield* Effect.flip(count.decode(reply("x")))),
      ).toBe(true);
    }),
  );
});

describe("Body.encodeSchema", () => {
  it.effect("encodes through the schema before the wire encoder", () =>
    Effect.gen(function* () {
      const count = Body.text.pipe(Body.encodeSchema(Schema.NumberFromString));
      expect(textOf(yield* count.encode(42))).toBe("42");
    }),
  );

  it.effect(
    "fails with a SchemaError before wire encoding for invalid input",
    () =>
      Effect.gen(function* () {
        let encoded = 0;
        const wire = Body.encoder((value: string) =>
          Effect.sync(() => {
            encoded++;
            return HttpBody.text(value);
          }),
        );
        const name = wire.pipe(Body.encodeSchema(Schema.NonEmptyString));
        const error = yield* Effect.flip(name.encode(""));
        expect(Schema.isSchemaError(error)).toBe(true);
        expect(encoded).toBe(0);
      }),
  );
});

describe("Body.jsonSchema", () => {
  const Event = Schema.Struct({
    id: Schema.BigInt,
    at: Schema.Date,
    note: Schema.optional(Schema.String),
  });
  const events = Body.jsonSchema(Event);

  it.effect("encodes through the schema's canonical JSON codec", () =>
    Effect.gen(function* () {
      const body = yield* events.encode({
        id: 9007199254740993n,
        at: new Date(Date.UTC(2026, 9, 29)),
      });
      expect(contentTypeOf(body)).toBe("application/json");
      expect(JSON.parse(textOf(body))).toEqual({
        id: "9007199254740993",
        at: "2026-10-29T00:00:00.000Z",
      });
    }),
  );

  it.effect("round-trips values that plain JSON would lose", () =>
    Effect.gen(function* () {
      const value = {
        id: 9007199254740993n,
        at: new Date(Date.UTC(2026, 9, 29, 1, 2, 3)),
        note: "",
      };
      const body = yield* events.encode(value);
      const decoded = yield* events.decode(reply(textOf(body)));
      expect(decoded).toEqual(value);
      expect(decoded.id).toBe(9007199254740993n);
    }),
  );

  it.effect("rejects invalid input on both sides with SchemaError", () =>
    Effect.gen(function* () {
      const encodeError = yield* Effect.flip(
        events.encode({ id: 1n, at: new Date(Number.NaN) }),
      );
      expect(Schema.isSchemaError(encodeError)).toBe(true);
      const decodeError = yield* Effect.flip(
        events.decode(reply('{"id":"not a number","at":"2026-10-29"}')),
      );
      expect(Schema.isSchemaError(decodeError)).toBe(true);
    }),
  );

  it.effect("keeps decode errors from the wire as client errors", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(events.decode(reply("")));
      expect(HttpClientError.isHttpClientError(error)).toBe(true);
    }),
  );

  it("advertises application/json", () => {
    expect(events.mediaType).toBe("application/json");
  });
});

const latin1 = new TextDecoder("iso-8859-1");

const bigEndianUint64 = (bytes: Uint8Array): bigint =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
    0,
  );

/** A generic codec, a form that must keep compiling. */
const jsonOf = <S extends Schema.Top>(schema: S) => Body.jsonSchema(schema);

/** The same bound by `Schema.Constraint`, which has no constructor. */
const jsonOfConstraint = <S extends Schema.Constraint>(schema: S) =>
  // @ts-expect-error: only `Schema.Top` has `makeEffect`
  Body.jsonSchema(schema);

// https://github.com/viell-dev/slop-effect-schema-http/issues/91
describe("a schema's value is built before it is encoded", () => {
  class User extends Schema.Class<User>("User")({
    id: Schema.Number,
    name: Schema.String,
  }) {}
  /** A class whose type has more than its fields, so a plain object is not structurally one. */
  class Member extends Schema.Class<Member>("Member")({
    id: Schema.Number,
    name: Schema.String,
  }) {
    get label() {
      return `${this.id}: ${this.name}`;
    }
    greet() {
      return `Hello ${this.name}`;
    }
  }
  const Team = Schema.Struct({ lead: User, size: Schema.Number });
  const expected = '{"id":1,"name":"Ada"}';

  const encoders = [
    ["Body.jsonSchema", Body.jsonSchema(User)],
    ["Body.encodeSchema", Body.json.pipe(Body.encodeSchema(User))],
  ] as const;

  it.effect.each(encoders)("%s takes a plain object for a class", ([, codec]) =>
    Effect.gen(function* () {
      const body = yield* codec.encode({ id: 1, name: "Ada" });
      expect(textOf(body)).toBe(expected);
    }),
  );

  it.effect.each(encoders)("%s takes an existing instance", ([, codec]) =>
    Effect.gen(function* () {
      const body = yield* codec.encode(new User({ id: 1, name: "Ada" }));
      expect(textOf(body)).toBe(expected);
    }),
  );

  it.effect.each(encoders)("%s still refuses an invalid object", ([, codec]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        codec.encode({ id: "x" as never, name: "Ada" }),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  it.effect("takes a plain object for a nested class", () =>
    Effect.gen(function* () {
      const body = yield* Body.jsonSchema(Team).encode({
        lead: { id: 1, name: "Ada" },
        size: 2,
      });
      expect(textOf(body)).toBe(`{"lead":${expected},"size":2}`);
    }),
  );

  it.effect("takes a plain object for a class with a getter and a method", () =>
    Effect.gen(function* () {
      const body = yield* Body.jsonSchema(Member).encode({
        id: 1,
        name: "Ada",
      });
      expect(textOf(body)).toBe(expected);
    }),
  );

  it.effect("fills in a field the schema's constructor defaults", () =>
    Effect.gen(function* () {
      const Page = Schema.Struct({
        size: Schema.Number.pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
        q: Schema.String,
      });
      const codec = Body.jsonSchema(Page);
      expect(textOf(yield* codec.encode({ q: "a" }))).toBe(
        '{"size":25,"q":"a"}',
      );
      expect(textOf(yield* codec.encode({ size: 5, q: "a" }))).toBe(
        '{"size":5,"q":"a"}',
      );
    }),
  );

  it.effect("fills in a default for a class", () =>
    Effect.gen(function* () {
      class Paging extends Schema.Class<Paging>("Paging")({
        size: Schema.Number.pipe(
          Schema.withConstructorDefault(Effect.succeed(25)),
        ),
      }) {}
      const body = yield* Body.jsonSchema(Paging).encode({});
      expect(textOf(body)).toBe('{"size":25}');
    }),
  );

  it.effect("returns an instance when decoding, as before", () =>
    Effect.gen(function* () {
      const decoded = yield* Body.jsonSchema(User).decode(reply(expected));
      expect(decoded).toBeInstanceOf(User);
    }),
  );

  it("separates what a codec takes from what it returns", () => {
    const codec = Body.jsonSchema(Member);
    expectTypeOf<Parameters<typeof codec.encode>[0]>().toEqualTypeOf<{
      readonly id: number;
      readonly name: string;
    }>();
    expectTypeOf<
      Effect.Success<ReturnType<typeof codec.decode>>
    >().toEqualTypeOf<Member>();
  });

  it("keeps an annotation with five parameters valid", () => {
    const codec: Body.Codec<
      string,
      HttpBody.HttpBodyError,
      HttpClientError.HttpClientError,
      never,
      never
    > = Body.text;
    expectTypeOf<Parameters<typeof codec.encode>[0]>().toEqualTypeOf<string>();
  });

  it("lets Body.make take more than it returns", () => {
    const codec = Body.make({
      encode: (value: string | number) => Body.text.encode(String(value)),
      decode: (incoming) => incoming.text,
    });
    expectTypeOf<Parameters<typeof codec.encode>[0]>().toEqualTypeOf<
      string | number
    >();
    expectTypeOf<
      Effect.Success<ReturnType<typeof codec.decode>>
    >().toEqualTypeOf<string>();
  });

  it("needs a full schema, so a generic helper is bound by Schema.Top", () => {
    void jsonOf(User);
    void jsonOfConstraint;
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/113
describe("a schema-backed body takes either side of its schema", () => {
  const at = "2026-11-07T12:00:00.000Z";
  const Slot = Schema.Struct({
    at: Schema.DateFromString,
    limit: Schema.FiniteFromString,
  });
  const expected = `{"at":"${at}","limit":"5"}`;

  it.effect.each([
    ["the decoded side", { at: new Date(at), limit: 5 }],
    ["the encoded side", { at, limit: "5" }],
    ["a mix by field", { at: new Date(at), limit: "5" }],
  ] as const)("Body.jsonSchema takes %s", ([, value]) =>
    Effect.gen(function* () {
      const body = yield* Body.jsonSchema(Slot).encode(value);
      expect(textOf(body)).toBe(expected);
    }),
  );

  it.effect("Body.encodeSchema passes on what the schema writes", () =>
    Effect.gen(function* () {
      const count = Body.text.pipe(Body.encodeSchema(Schema.FiniteFromString));
      for (const value of [42, "42", "042"]) {
        expect(textOf(yield* count.encode(value))).toBe("42");
      }
    }),
  );

  it.effect("reports the decoded side's error when every route fails", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Body.jsonSchema(Slot).encode({ at: new Date(at), limit: "many" }),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
      expect(String(error)).toContain("Expected number");
    }),
  );

  it.effect("takes the schema's own encoded side, not the JSON text", () =>
    Effect.gen(function* () {
      const Stamp = Schema.Struct({ at: Schema.Date });
      const codec = Body.jsonSchema(Stamp);
      expect(textOf(yield* codec.encode({ at: new Date(at) }))).toBe(
        `{"at":"${at}"}`,
      );
      const error = yield* Effect.flip(codec.encode({ at: at as never }));
      expect(Schema.isSchemaError(error)).toBe(true);
    }),
  );

  it("takes what the schema's two sides take, and returns its decoded side", () => {
    const codec = Body.jsonSchema(Schema.FiniteFromString);
    expectTypeOf<Parameters<typeof codec.encode>[0]>().toEqualTypeOf<
      number | string
    >();
    expectTypeOf<
      Effect.Success<ReturnType<typeof codec.decode>>
    >().toEqualTypeOf<number>();
    // @ts-expect-error: a boolean is on neither side of the schema
    void codec.encode(true);
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/134
describe("a caller's field under a union in a body", () => {
  const NarrowFirst = Schema.Union([
    Schema.Struct({ a: Schema.String }),
    Schema.Struct({ a: Schema.String, b: Schema.String }),
  ]);
  const Apart = Schema.Union([
    Schema.Struct({ a: Schema.String }),
    Schema.Struct({ b: Schema.String }),
  ]);

  it.effect("keeps it, in both schema encoders", () =>
    Effect.gen(function* () {
      for (const encoder of [
        Body.jsonSchema(NarrowFirst),
        Body.json.pipe(Body.encodeSchema(NarrowFirst)),
      ]) {
        const body = yield* encoder.encode({ a: "x", b: "y" });
        expect(textOf(body)).toBe('{"a":"x","b":"y"}');
      }
    }),
  );

  it.effect("keeps it in a field, a list and a record", () =>
    Effect.gen(function* () {
      const InField = Schema.Struct({ filter: NarrowFirst });
      expect(
        textOf(
          yield* Body.jsonSchema(InField).encode({
            filter: { a: "x", b: "y" },
          }),
        ),
      ).toBe('{"filter":{"a":"x","b":"y"}}');
      const List = Schema.Array(NarrowFirst);
      expect(
        textOf(
          yield* Body.jsonSchema(List).encode([{ a: "1" }, { a: "2", b: "3" }]),
        ),
      ).toBe('[{"a":"1"},{"a":"2","b":"3"}]');
      const Named = Schema.Record(Schema.String, NarrowFirst);
      expect(
        textOf(
          yield* Body.jsonSchema(Named).encode({ one: { a: "1", b: "2" } }),
        ),
      ).toBe('{"one":{"a":"1","b":"2"}}');
    }),
  );

  it.effect("keeps it beside a key no member states, at any depth", () =>
    Effect.gen(function* () {
      const InField = Schema.Struct({ filter: NarrowFirst });
      for (const value of [
        { filter: { a: "x", b: "y" }, stray: 1 },
        { filter: { a: "x", b: "y", stray: 1 } },
      ])
        expect(textOf(yield* Body.jsonSchema(InField).encode(value))).toBe(
          '{"filter":{"a":"x","b":"y"}}',
        );
      const wider = { a: "x", b: "y", stray: 1 };
      const inList = yield* Body.jsonSchema(Schema.Array(NarrowFirst)).encode([
        wider,
      ]);
      expect(textOf(inList)).toBe('[{"a":"x","b":"y"}]');
    }),
  );

  it.effect("takes a mix by field around a nested union", () =>
    Effect.gen(function* () {
      const Numbers = Schema.Union([
        Schema.Struct({ n: Schema.FiniteFromString }),
        Schema.Struct({
          n: Schema.FiniteFromString,
          d: Schema.FiniteFromString,
        }),
      ]);
      const InField = Schema.Struct({
        at: Schema.DateFromString,
        numbers: Numbers,
      });
      const at = "2026-11-07T12:00:00.000Z";
      expect(
        textOf(
          yield* Body.jsonSchema(InField).encode({
            at,
            numbers: { n: 1, d: 2 },
          }),
        ),
      ).toBe(`{"at":"${at}","numbers":{"n":"1","d":"2"}}`);
    }),
  );

  it.effect("keeps a subclass's field under its base class", () =>
    Effect.gen(function* () {
      class Base extends Schema.Class<Base>("Base")({ a: Schema.String }) {}
      class Derived extends Base.extend<Derived>("Derived")({
        b: Schema.String,
      }) {}
      const body = yield* Body.jsonSchema(Schema.Union([Base, Derived])).encode(
        new Derived({ a: "x", b: "y" }),
      );
      expect(textOf(body)).toBe('{"a":"x","b":"y"}');
    }),
  );

  it.effect("refuses a field no member can keep, wherever it is", () =>
    Effect.gen(function* () {
      for (const encoder of [
        Body.jsonSchema(Apart),
        Body.json.pipe(Body.encodeSchema(Apart)),
      ]) {
        const error = yield* Effect.flip(encoder.encode({ a: "1", b: "2" }));
        expect(error).toBeInstanceOf(Schema.SchemaError);
        expect(String(error)).toContain("The schema cannot keep this field");
        expect(String(error)).toContain('["b"]');
      }
      const inField = yield* Effect.flip(
        Body.jsonSchema(Schema.Struct({ filter: Apart })).encode({
          filter: { a: "secret", b: "secret" },
        }),
      );
      expect(String(inField)).toContain('["filter"]["b"]');
      expect(String(inField)).not.toContain("secret");
      const inList = yield* Effect.flip(
        Body.jsonSchema(Schema.Array(Apart)).encode([
          { a: "1" },
          { a: "1", b: "2" },
        ]),
      );
      expect(String(inList)).toContain('[1]["b"]');
    }),
  );

  it.effect("leaves what a Map and an Option hold to their own reading", () =>
    Effect.gen(function* () {
      const value = { a: "x", b: "y" };
      expect(
        textOf(
          yield* Body.jsonSchema(
            Schema.ReadonlyMap(Schema.String, NarrowFirst),
          ).encode(new Map([["k", value]])),
        ),
      ).toBe('[["k",{"a":"x"}]]');
      expect(
        textOf(
          yield* Body.jsonSchema(
            Schema.ReadonlyMap(Schema.String, Apart),
          ).encode(new Map([["k", value]])),
        ),
      ).toBe('[["k",{"a":"x"}]]');
      expect(
        textOf(
          yield* Body.jsonSchema(Schema.Option(Apart)).encode(
            Option.some(value),
          ),
        ),
      ).toBe('{"_tag":"Some","value":{"a":"x"}}');
    }),
  );

  it.effect("still reads what it can see beside a Map", () =>
    Effect.gen(function* () {
      const Beside = Schema.Struct({
        held: Schema.ReadonlyMap(
          Schema.String,
          Schema.Struct({ a: Schema.String }),
        ),
        filter: NarrowFirst,
      });
      expect(
        textOf(
          yield* Body.jsonSchema(Beside).encode({
            held: new Map([["k", { a: "x" }]]),
            filter: { a: "x", b: "y" },
          }),
        ),
      ).toBe('{"held":[["k",{"a":"x"}]],"filter":{"a":"x","b":"y"}}');
    }),
  );

  it.effect("takes `undefined` as no field, at any depth", () =>
    Effect.gen(function* () {
      const Either = Schema.Union([
        Schema.Struct({ a: Schema.String, b: Schema.optional(Schema.String) }),
        Schema.Struct({ a: Schema.String, c: Schema.String }),
      ]);
      const value = { a: "x", b: undefined, c: "z" };
      expect(textOf(yield* Body.jsonSchema(Either).encode(value))).toBe(
        '{"a":"x","c":"z"}',
      );
      expect(
        textOf(
          yield* Body.jsonSchema(Schema.Struct({ filter: Either })).encode({
            filter: value,
          }),
        ),
      ).toBe('{"filter":{"a":"x","c":"z"}}');
      expect(
        textOf(yield* Body.jsonSchema(Schema.Array(Either)).encode([value])),
      ).toBe('[{"a":"x","c":"z"}]');
    }),
  );

  it.effect("fails as a SchemaError under an empty union", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Body.jsonSchema(Schema.Union([])).encode({ a: "1" } as never),
      );
      expect(error).toBeInstanceOf(Schema.SchemaError);
    }),
  );

  it.effect("does not let a member that reads no keys state one", () =>
    Effect.gen(function* () {
      const WithDate = Schema.Union([Schema.Date, NarrowFirst]);
      const wider = { a: "x", stray: 1 };
      expect(
        textOf(
          yield* Body.json.pipe(Body.encodeSchema(WithDate)).encode(wider),
        ),
      ).toBe('{"a":"x"}');
    }),
  );

  it.effect("does not shorten a list to make it fit", () =>
    Effect.gen(function* () {
      const Pair = Schema.Tuple([Schema.Struct({ a: Schema.String })]);
      const Either = Schema.Union([Pair, Schema.Struct({ b: Schema.String })]);
      const tooLong = [{ a: "1" }, { a: "2" }] as unknown as typeof Either.Type;
      const error = yield* Effect.flip(Body.jsonSchema(Either).encode(tooLong));
      expect(error).toBeInstanceOf(Schema.SchemaError);
    }),
  );

  it.effect("refuses it where only a read by field can take the value", () =>
    Effect.gen(function* () {
      const Mixed = Schema.Struct({
        at: Schema.DateFromString,
        limit: Schema.FiniteFromString,
        filter: Apart,
      });
      // `at` is decoded and `limit` encoded, so neither side takes the whole value.
      const at = new Date("2026-11-07T12:00:00.000Z");
      const error = yield* Effect.flip(
        Body.jsonSchema(Mixed).encode({
          at,
          limit: "5",
          filter: { a: "1", b: "2" },
        }),
      );
      expect(String(error)).toContain('["filter"]["b"]');
      expect(
        textOf(
          yield* Body.jsonSchema(Mixed).encode({
            at,
            limit: "5",
            filter: { a: "1" },
          }),
        ),
      ).toBe(
        '{"at":"2026-11-07T12:00:00.000Z","limit":"5","filter":{"a":"1"}}',
      );
    }),
  );

  it.effect("leaves a struct's excess key and an `Option.none()` alone", () =>
    Effect.gen(function* () {
      const Plain = Schema.Struct({ a: Schema.String });
      const wider = { a: "x", stray: 1 };
      expect(textOf(yield* Body.jsonSchema(Plain).encode(wider))).toBe(
        '{"a":"x"}',
      );
      const Maybe = Schema.Union([
        Schema.Struct({ a: Schema.OptionFromOptionalKey(Schema.String) }),
        Schema.Struct({
          a: Schema.OptionFromOptionalKey(Schema.String),
          b: Schema.String,
        }),
      ]);
      expect(
        textOf(yield* Body.jsonSchema(Maybe).encode({ a: Option.none() })),
      ).toBe("{}");
    }),
  );

  // Only input has a caller to lose a field, so a response still reads as Effect reads it. The
  // choice of member there is outside this fix.
  // https://github.com/viell-dev/slop-effect-schema-http/issues/143
  it.effect("currently takes the first member that fits for a response", () =>
    Effect.gen(function* () {
      const decoded = yield* Body.jsonSchema(NarrowFirst).decode(
        reply('{"a":"x","b":"y"}'),
      );
      expect(decoded).toEqual({ a: "x" });
    }),
  );
});

describe("non-text payloads through Body.bytes and a schema", () => {
  it.effect("reads Latin-1 text that UTF-8 text decoding would garble", () =>
    Effect.gen(function* () {
      const city = Body.bytes.pipe(
        Body.map((bytes) => latin1.decode(bytes)),
        Body.schema(Schema.NonEmptyString),
      );
      // "Köln" in ISO-8859-1; 0xf6 alone is not valid UTF-8.
      const encoded = new Uint8Array([0x4b, 0xf6, 0x6c, 0x6e]);
      expect(
        yield* city.decode(reply(encoded, "text/plain; charset=iso-8859-1")),
      ).toBe("Köln");
      expect(yield* Body.text.decode(reply(encoded))).toBe("K\uFFFDln");
    }),
  );

  it("finds that the label iso-8859-1 selects windows-1252, not exact Latin-1", () => {
    expect(latin1.encoding).toBe("windows-1252");
    expect(latin1.decode(new Uint8Array([0x80]))).toBe("\u20AC");
  });

  it.effect("reads 64-bit integers without losing precision", () =>
    Effect.gen(function* () {
      const exceedsDouble = 9007199254740993n;
      const binary = new Uint8Array(8);
      new DataView(binary.buffer).setBigUint64(0, exceedsDouble);
      const counter = Body.bytes.pipe(
        Body.map(bigEndianUint64),
        Body.schema(Schema.BigInt),
      );
      expect(yield* counter.decode(reply(binary))).toBe(exceedsDouble);

      const textual = Body.text.pipe(Body.schema(Schema.BigIntFromString));
      expect(yield* textual.decode(reply(String(exceedsDouble)))).toBe(
        exceedsDouble,
      );
    }),
  );

  it.effect("reads HEAD facts from headers after draining the body", () =>
    Effect.gen(function* () {
      const facts = Body.decoder((res) =>
        Effect.as(Body.empty.decode(res), res.headers),
      ).pipe(
        Body.schema(
          Schema.Struct({
            "content-length": Schema.NumberFromString,
            etag: Schema.String,
          }),
        ),
      );
      const head = response(
        new globalThis.Response(null, {
          status: 200,
          headers: { "content-length": "1048576", etag: '"v7"' },
        }),
      );
      expect(yield* facts.decode(head)).toEqual({
        "content-length": 1048576,
        etag: '"v7"',
      });
    }),
  );
});

describe("Body.text and Body.bytes", () => {
  // The BOM stripping comes from the platform's Response.text(), not from this library.
  it.effect(
    "text decoding inherits the platform's BOM stripping; bytes keep it",
    () =>
      Effect.gen(function* () {
        const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x3b, 0x62]);
        const asText = yield* Body.text.decode(reply(withBom));
        const asBytes = yield* Body.bytes.decode(reply(withBom));
        expect(asText).toBe("a;b");
        expect(asBytes.length).toBe(6);
      }),
  );
});
