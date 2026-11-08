/**
 * EXT-35: constructor-only recovery beside opaque values, accepted in #143:
 * https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6725100255
 * Consumer-authored from the public API and the README's neutral echo contract only.
 * The socket ledger, rather than echo's fixed 404 reply, establishes request composition.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { bodyText, headerValues, type Recorded } from "../harness/lane.js";

const notFound = Response.status(404, Body.text);
const secret = "hidden-neighbor-value";
const Small = Schema.Struct({ a: Schema.String });
const Wide = Schema.Struct({ a: Schema.String, b: Schema.String });
const Choice = Schema.Union([Small, Wide]);
const Opaque = Schema.Option(Small);
const Parent = Schema.Struct({ f: Choice, o: Opaque });
const input = () => ({
  f: { a: "x", b: "y" },
  o: Option.some({ a: "o", zz: "z" }),
});
const optionWire = { _tag: "Some", value: { a: "o" } };
const completeWire = { f: { a: "x", b: "y" }, o: optionWire };
// A path renderer serializes the encoded Option itself; the JSON body codec normalizes it.
const completePathWire = {
  f: { a: "x", b: "y" },
  o: { _id: "Option", ...optionWire },
};
const empty = function* (): Generator<readonly [string, string]> {};

const sent = <I, E>(
  build: (origin: string) => Request.Request<I, E>,
  value: I,
) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(build(backend.origin), notFound)
      .execute(value)
      .pipe(
        Effect.provide(lane.fetchClient),
        // Preserve dispatch evidence when an intended success reproduces the baseline refusal.
        Effect.tapError(() =>
          Effect.gen(function* () {
            expect(yield* backend.ledger).toEqual([]);
          }),
        ),
      );
    expect(result).toBe("Not Found");
    return yield* backend.ledger;
  });

const refused = <E>(
  build: (origin: string) => Request.Request<never, E>,
  value: unknown,
) =>
  Effect.gen(function* () {
    const backend = yield* lane.backend("echo", undefined, {
      listener: "socket",
    });
    const result = yield* Operation.make(build(backend.origin), notFound)
      .execute(value as never)
      .pipe(
        Effect.provide(lane.fetchClient),
        Effect.match({
          onFailure: (error) => error,
          onSuccess: (reply) => {
            expect(reply).toBe("Not Found");
            return undefined;
          },
        }),
      );
    // Read and assert the ledger first so a regression records the unexpected wire request.
    const ledger = yield* backend.ledger;
    expect(
      ledger.map((entry) => ({
        method: entry.method,
        target: entry.target,
        lines: entry.lines,
        body: bodyText(entry),
      })),
    ).toEqual([]);
    expect(result).toMatchObject({ _tag: "SchemaError" });
    expect(String(result)).not.toContain(secret);
    return String(result);
  });

const expectWire = (
  ledger: ReadonlyArray<Recorded>,
  target: string,
  body?: unknown,
) => {
  expect(ledger).toHaveLength(1);
  const entry = ledger[0]!;
  expect(entry.method).toBe(body === undefined ? "GET" : "POST");
  expect(entry.target).toBe(target);
  expect(entry.head).toContain(`${entry.method} ${target} HTTP/1.1\r\n`);
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "x-consumer-case")).toEqual(["opaque"]);
  if (body === undefined) {
    expect(entry.body.byteLength).toBe(0);
    expect(headerValues(entry.lines, "content-type")).toEqual([]);
  } else {
    const text = JSON.stringify(body);
    expect(bodyText(entry)).toBe(text);
    expect(Array.from(entry.body)).toEqual(
      Array.from(new TextEncoder().encode(text)),
    );
    expect(headerValues(entry.lines, "content-type")).toEqual([
      "application/json",
    ]);
    expect(headerValues(entry.lines, "content-length")).toEqual([
      String(new TextEncoder().encode(text).byteLength),
    ]);
  }
};
const post = (origin: string) =>
  Request.post(`${origin}/x`).pipe(
    Request.setHeader("X-Consumer-Case", "opaque"),
  );
const get = (origin: string) =>
  Request.get(origin).pipe(Request.setHeader("X-Consumer-Case", "opaque"));

describe(`opaque neighbors and visible request fields (${lane.name})`, () => {
  it.live(
    "[EXT-35a] a direct Option neighbor preserves the wider JSON body member",
    () =>
      Effect.gen(function* () {
        const ledger = yield* sent(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Parent))),
          { body: input() },
        );
        expectWire(ledger, "/x", completeWire);
      }),
  );

  it.live(
    "[EXT-35a] a direct Option neighbor preserves the wider path renderer member",
    () =>
      Effect.gen(function* () {
        const ledger = yield* sent(
          (origin) =>
            get(origin).pipe(
              Request.path(
                Parent,
                (value, encode) => `/x/${encode(JSON.stringify(value))}`,
              ),
            ),
          { path: input() },
        );
        expectWire(
          ledger,
          `/x/${encodeURIComponent(JSON.stringify(completePathWire))}`,
        );
      }),
  );

  it.live(
    "[EXT-35b] a ReadonlyMap neighbor preserves the visible member and its own ordinary reading",
    () =>
      Effect.gen(function* () {
        const MapParent = Schema.Struct({
          f: Choice,
          o: Schema.ReadonlyMap(Schema.String, Small),
        });
        const ledger = yield* sent(
          (origin) =>
            get(origin).pipe(
              Request.path(
                MapParent,
                (value, encode) =>
                  `/x/${encode(JSON.stringify({ f: value.f, o: Array.from(value.o) }))}`,
              ),
            ),
          {
            path: {
              f: { a: "x", b: "y" },
              o: new Map([["key", { a: "o", zz: "z" }]]),
            },
          },
        );
        expectWire(
          ledger,
          `/x/${encodeURIComponent('{"f":{"a":"x","b":"y"},"o":[["key",{"a":"o"}]]}')}`,
        );
      }),
  );

  it.live(
    "[EXT-35c] encoded numeric input cannot force a new fieldwise base64 interpretation",
    () =>
      Effect.gen(function* () {
        const Mixed = Schema.Struct({
          f: Choice,
          o: Opaque,
          n: Schema.FiniteFromString,
          base64: Schema.StringFromBase64,
        });
        const error = yield* refused(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Mixed))),
          { body: { ...input(), n: "1", base64: "eA==" } },
        );
        expect(error).toContain('["f"]["b"]');
      }),
  );

  it.live(
    "[EXT-35c] decoded numeric input recovers with the constructor's double-encoded base64",
    () =>
      Effect.gen(function* () {
        const Mixed = Schema.Struct({
          f: Choice,
          o: Opaque,
          n: Schema.FiniteFromString,
          base64: Schema.StringFromBase64,
        });
        const ledger = yield* sent(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Mixed))),
          { body: { ...input(), n: 1, base64: "eA==" } },
        );
        expectWire(ledger, "/x", {
          ...completeWire,
          n: "1",
          base64: "ZUE9PQ==",
        });
      }),
  );

  it.live(
    "[EXT-35d] control: an existing successful read retains its checks and bytes",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const Checked = Schema.String.check(
          Schema.makeFilter((value) => {
            trace.push(value);
            return true;
          }),
        );
        const Successful = Schema.Struct({
          f: Schema.Union([Schema.Struct({ a: Checked }), Wide]),
          o: Opaque,
        });
        const ledger = yield* sent(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(Successful))),
          { body: { f: { a: "x" }, o: Option.some({ a: "o" }) } },
        );
        expectWire(ledger, "/x", { f: { a: "x" }, o: optionWire });
        expect(trace).toEqual(["x", "x"]);
      }),
  );

  it.live(
    "[EXT-35d] control: a successful loose read with opaque excess retains its check trace",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const Checked = Schema.String.check(
          Schema.makeFilter((value) => {
            trace.push(value);
            return true;
          }),
        );
        const Successful = Schema.Struct({
          f: Schema.Union([Schema.Struct({ a: Checked }), Wide]),
          o: Opaque,
        });
        const ledger = yield* sent(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(Successful))),
          { body: { f: { a: "x" }, o: Option.some({ a: "o", zz: "z" }) } },
        );
        expectWire(ledger, "/x", { f: { a: "x" }, o: optionWire });
        // Published 0.6.0 takes five checks on this successful fallback path.
        expect(trace).toEqual(["x", "x", "x", "x", "x"]);
      }),
  );

  it.live(
    "[EXT-35e] a parent's rejection of the wider member still refuses dispatch",
    () =>
      Effect.gen(function* () {
        const NarrowOnly = Parent.check(
          Schema.makeFilter((value) => !("b" in value.f)),
        );
        yield* refused(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(NarrowOnly))),
          {
            body: {
              f: { a: "x", b: secret },
              o: Option.some({ a: "o", zz: secret }),
            },
          },
        );
      }),
  );

  it.live(
    "[EXT-35e] recovery preserves an omitted parent's constructor default",
    () =>
      Effect.gen(function* () {
        const Defaulted = Schema.Struct({
          f: Choice,
          o: Opaque,
          marker: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("generated")),
          ),
        });
        const ledger = yield* sent(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(Defaulted))),
          { body: input() },
        );
        expectWire(ledger, "/x", { ...completeWire, marker: "generated" });
      }),
  );

  it.live(
    "[EXT-35f] fields no visible member can hold together still refuse by path without their values",
    () =>
      Effect.gen(function* () {
        const Unholdable = Schema.Struct({
          f: Schema.Union([Small, Schema.Struct({ b: Schema.String })]),
          o: Opaque,
        });
        const error = yield* refused(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(Unholdable))),
          {
            body: {
              f: { a: "x", b: secret },
              o: Option.some({ a: "o", zz: secret }),
            },
          },
        );
        expect(error).toContain('["f"]["b"]');
      }),
  );

  it.live(
    "[EXT-35g] a root sibling named b cannot excuse losing nested f.b",
    () =>
      Effect.gen(function* () {
        const Unholdable = Schema.Struct({
          f: Schema.Union([Small, Schema.Struct({ b: Schema.String })]),
          o: Opaque,
        });
        const error = yield* refused(
          (origin) =>
            get(origin).pipe(
              Request.path(
                Unholdable,
                (value, encode) => `/x/${encode(JSON.stringify(value))}`,
              ),
              Request.path(
                Schema.Struct({ b: Schema.String }),
                (value, encode) => `/${encode(value.b)}`,
              ),
            ),
          {
            path: {
              f: { a: "x", b: secret },
              o: Option.some({ a: "o", zz: secret }),
              b: "root",
            },
          },
        );
        expect(error).toContain('["f"]["b"]');
      }),
  );

  it.live(
    "[EXT-35h] control: a renamed visible sibling already works without opaque excess",
    () =>
      Effect.gen(function* () {
        const Renamed = Schema.Struct({
          f: Wide.pipe(Schema.encodeKeys({ a: "A", b: "B" })),
          o: Opaque,
        });
        const ledger = yield* sent(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Renamed))),
          { body: { f: { a: "x", b: "y" }, o: Option.some({ a: "o" }) } },
        );
        expectWire(ledger, "/x", { f: { A: "x", B: "y" }, o: optionWire });
      }),
  );

  it.live(
    "[EXT-35h] a renamed visible sibling keeps its decoded values beside opaque excess",
    () =>
      Effect.gen(function* () {
        const Renamed = Schema.Struct({
          f: Schema.Union([
            Small.pipe(Schema.encodeKeys({ a: "A" })),
            Wide.pipe(Schema.encodeKeys({ a: "A", b: "B" })),
          ]),
          o: Opaque,
        });
        const ledger = yield* sent(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Renamed))),
          { body: input() },
        );
        expectWire(ledger, "/x", { f: { A: "x", B: "y" }, o: optionWire });
      }),
  );

  it.live(
    "[EXT-35i] control: JSON text remains subject to its schema's own member choice",
    () =>
      Effect.gen(function* () {
        const TextParent = Schema.Struct({
          f: Schema.fromJsonString(Choice),
          o: Opaque,
        });
        const ledger = yield* sent(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(TextParent))),
          {
            body: {
              f: '{"a":"x","b":"y"}',
              o: Option.some({ a: "o", zz: "z" }),
            },
          },
        );
        expectWire(ledger, "/x", { f: '{"a":"x"}', o: optionWire });
      }),
  );

  it.live(
    "[EXT-35j] recovery retains own prototype-named fields as JSON data",
    () =>
      Effect.gen(function* () {
        const Named = Schema.Struct({
          f: Choice,
          o: Opaque,
          ["__proto__"]: Schema.String,
          constructor: Schema.String,
        });
        const ledger = yield* sent(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Named))),
          { body: { ...input(), ["__proto__"]: "data", constructor: "own" } },
        );
        expectWire(ledger, "/x", {
          ...completeWire,
          ["__proto__"]: "data",
          constructor: "own",
        });
        expect(Object.prototype).not.toHaveProperty("f");
      }),
  );

  it.live(
    "[EXT-35j] recovery keeps a symbol field consumed by a path renderer",
    () =>
      Effect.gen(function* () {
        const key = Symbol("consumer path");
        const Symbolic = Schema.Struct({
          f: Choice,
          o: Opaque,
          [key]: Schema.String,
        });
        const ledger = yield* sent(
          (origin) =>
            get(origin).pipe(
              Request.path(
                Symbolic,
                (value, encode) =>
                  `/x/${encode(value[key])}/${encode(JSON.stringify(value))}`,
              ),
            ),
          { path: { ...input(), [key]: "symbol/data" } },
        );
        expectWire(
          ledger,
          `/x/symbol%2Fdata/${encodeURIComponent(JSON.stringify(completePathWire))}`,
        );
      }),
  );

  it.live(
    "[EXT-35k] control: the original wider member works when its Option neighbor has no excess",
    () =>
      Effect.gen(function* () {
        const ledger = yield* sent(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Parent))),
          { body: { f: { a: "x", b: "y" }, o: Option.some({ a: "o" }) } },
        );
        expectWire(ledger, "/x", completeWire);
        const pathLedger = yield* sent(
          (origin) =>
            get(origin).pipe(
              Request.path(
                Parent,
                (value, encode) => `/x/${encode(JSON.stringify(value))}`,
              ),
            ),
          { path: { f: { a: "x", b: "y" }, o: Option.some({ a: "o" }) } },
        );
        expectWire(
          pathLedger,
          `/x/${encodeURIComponent(JSON.stringify(completePathWire))}`,
        );
      }),
  );

  it.live(
    "[EXT-35l] control: a visible field whose value the wider member rejects remains refused",
    () =>
      Effect.gen(function* () {
        const Rejecting = Schema.Struct({
          f: Schema.Union([
            Small,
            Schema.Struct({ a: Schema.String, b: Schema.FiniteFromString }),
          ]),
          o: Opaque,
        });
        const error = yield* refused(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(Rejecting))),
          {
            body: {
              f: { a: "x", b: secret },
              o: Option.some({ a: "o", zz: secret }),
            },
          },
        );
        expect(error).toContain('["f"]["b"]');
      }),
  );

  it.live(
    "[EXT-35m] limit: accessor input retains its original refusal rather than manufacturing stable evidence",
    () =>
      Effect.gen(function* () {
        const body = {
          get f() {
            return { a: "x", b: secret };
          },
          o: Option.some({ a: "o", zz: secret }),
        };
        const error = yield* refused(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Parent))),
          { body },
        );
        expect(error).toContain('["f"]["b"]');
      }),
  );

  it.live(
    "[EXT-35n] limit: an iterable parent is not reconstructed as an ordinary record",
    () =>
      Effect.gen(function* () {
        const Iterable = Schema.Struct({
          f: Choice,
          o: Opaque,
          [Symbol.iterator]: Schema.declare(
            (value): value is typeof empty => typeof value === "function",
          ),
        });
        const error = yield* refused(
          (origin) => get(origin).pipe(Request.path(Iterable, () => "/x")),
          { path: { ...input(), [Symbol.iterator]: empty } },
        );
        expect(error).toContain('["f"]["b"]');
      }),
  );

  it.live(
    "[EXT-35o] null-prototype recovery keeps a missing toString field's constructor default",
    () =>
      Effect.gen(function* () {
        // Independent wire regression for the pre-publication candidate defect in:
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6725476571
        const Defaulted = Schema.Struct({
          f: Choice,
          o: Opaque,
          toString: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("25")),
          ),
        });
        const body = Object.assign(
          Object.create(null) as ReturnType<typeof input> & {
            readonly toString?: string;
          },
          input(),
        );
        expect(Object.getPrototypeOf(body)).toBeNull();
        expect(Object.hasOwn(body, "toString")).toBe(false);
        const ledger = yield* sent(
          (origin) =>
            post(origin).pipe(Request.body(Body.jsonSchema(Defaulted))),
          { body },
        );
        expectWire(ledger, "/x", { ...completeWire, toString: "25" });
        expect(bodyText(ledger[0]!)).not.toContain("[native code]");
        expect(Object.hasOwn(body, "toString")).toBe(false);
      }),
  );

  it.live(
    "[EXT-35p] an inherited sparse-array element cannot be copied away to bypass a parent check",
    () =>
      Effect.gen(function* () {
        // Public deep-review finding; use an array-local prototype, never Array.prototype edits.
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6725666937
        const x: Array<string | undefined> = [];
        x.length = 1;
        const prototype = Object.create(Array.prototype) as object;
        Object.defineProperty(prototype, "0", {
          value: "original",
          enumerable: true,
        });
        Object.setPrototypeOf(x, prototype);
        expect(Object.hasOwn(x, "0")).toBe(false);
        expect(x[0]).toBe("original");
        const Checked = Schema.Struct({
          f: Choice,
          o: Opaque,
          x: Schema.Array(Schema.UndefinedOr(Schema.String)),
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x[0] !== "original",
          ),
        );
        const error = yield* refused(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Checked))),
          { body: { ...input(), x } },
        );
        expect(error).toContain('["f"]["b"]');
        expect(x[0]).toBe("original");
        expect(Object.hasOwn(x, "0")).toBe(false);
      }),
  );

  it.live(
    "[EXT-35q] an empty Struct's external identity cannot be copied away to bypass a parent check",
    () =>
      Effect.gen(function* () {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6725666937
        const external = {};
        const Checked = Schema.Struct({
          f: Choice,
          o: Opaque,
          x: Schema.Struct({}),
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== external,
          ),
        );
        const error = yield* refused(
          (origin) => post(origin).pipe(Request.body(Body.jsonSchema(Checked))),
          { body: { ...input(), x: external } },
        );
        expect(error).toContain('["f"]["b"]');
      }),
  );

  it.live(
    "[EXT-35r] a visible field added after creating a pending body cannot disappear during recovery",
    () =>
      Effect.gen(function* () {
        // Public pending-input regression, exercised through the Body.encoder extension point:
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726041080
        const value = {
          f: { a: "x" } as { a: string; b?: string },
          o: Option.some({ a: "o", zz: "z" }),
        };
        const pending = Body.jsonSchema(Parent).encode(value);
        value.f.b = "y";
        const error = yield* refused(
          (origin) =>
            post(origin).pipe(
              Request.body(Body.encoder((_body: void) => pending)),
            ),
          { body: undefined },
        );
        expect(error).toContain('["f"]["b"]');
        expect(value.f).toEqual({ a: "x", b: "y" });
      }),
  );

  it.live(
    "[EXT-35s] a visible value changed after creating a pending body cannot recover its old value",
    () =>
      Effect.gen(function* () {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726041080
        const value = input();
        const pending = Body.jsonSchema(Parent).encode(value);
        value.f.a = "current";
        const error = yield* refused(
          (origin) =>
            post(origin).pipe(
              Request.body(Body.encoder((_body: void) => pending)),
            ),
          { body: undefined },
        );
        expect(error).toContain('["f"]["b"]');
        expect(value.f.a).toBe("current");
      }),
  );

  it.live(
    "[EXT-35t] an opaque identity replaced after creating a pending body cannot bypass a parent check",
    () =>
      Effect.gen(function* () {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726041080
        const external = Option.some("replacement");
        const Checked = Schema.Struct({
          f: Choice,
          o: Opaque,
          x: Schema.Option(Schema.String),
        }).check(
          Schema.makeFilter(
            (value) => !("b" in value.f) || value.x !== external,
          ),
        );
        const value = { ...input(), x: Option.some("before") };
        const pending = Body.jsonSchema(Checked).encode(value);
        value.x = external;
        const error = yield* refused(
          (origin) =>
            post(origin).pipe(
              Request.body(Body.encoder((_body: void) => pending)),
            ),
          { body: undefined },
        );
        expect(error).toContain('["f"]["b"]');
        expect(value.x).toBe(external);
      }),
  );

  it.live(
    "[EXT-35u] record keys reordered after creating a pending body cannot bypass a parent check",
    () =>
      Effect.gen(function* () {
        // https://github.com/viell-dev/slop-effect-schema-http/issues/143#issuecomment-6726073336
        const Checked = Schema.Struct({
          f: Choice,
          o: Opaque,
          x: Schema.Record(Schema.String, Schema.String),
        }).check(
          Schema.makeFilter(
            (value) =>
              !("b" in value.f) || Object.keys(value.x).join(",") !== "q,p",
          ),
        );
        const x: Record<string, string> = { p: "p", q: "q" };
        const value = { ...input(), x };
        const pending = Body.jsonSchema(Checked).encode(value);
        delete x.p;
        x.p = "p";
        expect(Object.keys(x)).toEqual(["q", "p"]);
        const error = yield* refused(
          (origin) =>
            post(origin).pipe(
              Request.body(Body.encoder((_body: void) => pending)),
            ),
          { body: undefined },
        );
        expect(error).toContain('["f"]["b"]');
        expect(Object.keys(x)).toEqual(["q", "p"]);
      }),
  );
});
