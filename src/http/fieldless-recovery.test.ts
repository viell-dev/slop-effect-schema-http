import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { vi } from "vitest";
import { bodyOf } from "../../test/request.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";
import { FieldlessOneOf, readFailure } from "./internal/ambiguity.js";
import * as Excess from "./internal/excess.js";
import { jsonEncoder, reader, toDecoded } from "./internal/input.js";
import { WriterError } from "./internal/writer-error.js";

const post = <S extends Schema.Top>(schema: S) =>
  Request.post("/x").pipe(Request.body(Body.jsonSchema(schema)));
const F = Schema.FiniteFromString;
const S = Schema.String;
const Filter = Schema.Struct({
  limit: Schema.optionalKey(F).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Adef = Schema.Struct({
  a: Schema.optionalKey(S).pipe(
    Schema.withConstructorDefault(Effect.succeed("x")),
  ),
});
const B = Schema.Struct({ b: Schema.optionalKey(S) });
// Reads {} only on its encoded side: the decoded side requires `code`.
const Encoded = Schema.Struct({ marker: Schema.optionalKey(S) }).pipe(
  Schema.decodeTo(Schema.Struct({ code: S }), {
    decode: SchemaGetter.transform(() => ({ code: "decoded" })),
    encode: SchemaGetter.transform(() => ({})),
  }),
);
const oneOf = <
  const Members extends ReadonlyArray<
    Schema.Top & Schema.ConstraintCodec<unknown, unknown, never, never>
  >,
>(
  ...members: Members
) => Schema.Union(members, { mode: "oneOf" });
const outcome = <I, E extends Error>(
  request: Request.Request<I, E, never>,
  body: unknown,
) =>
  Effect.match(bodyOf(request, { body } as never), {
    onSuccess: (sent) => `sent ${sent}`,
    onFailure: (error) =>
      `${"_tag" in error ? String(error._tag) : error.name}: ${error.message}`,
  });

describe("enclosing unions with an ambiguous member", () => {
  // M can never read the value: it lacks the required `r`, or takes `n` only as a number. K is the
  // only member that reads it. Effect's own oneOf counts a failing member as no match.
  for (const [name, members] of [
    ["Filter beside Void", [Filter, Schema.Void]],
    ["two optional-field structs", [Adef, B]],
  ] as const) {
    const u = oneOf(...members);
    it.effect(
      `reads the one member that fits, ${name}, required field missing`,
      () =>
        Effect.gen(function* () {
          const M = Schema.Struct({ f: u, a: F, b: F, r: S });
          const K = Schema.Struct({ f: Schema.Unknown, a: F, b: F });
          const body = { f: {}, a: "5", b: 6 };
          const alone = yield* outcome(post(K), body);
          expect(alone).toBe('sent {"f":{},"a":"5","b":"6"}');
          for (const order of [
            [M, K],
            [K, M],
          ])
            for (const mode of ["anyOf", "oneOf"] as const)
              expect(
                yield* outcome(post(Schema.Union(order, { mode })), body),
                `${mode}, ${order[0] === M ? "M first" : "K first"}`,
              ).toBe(alone);
        }),
    );
  }
  it.effect(
    "reads the one member that fits when it fits only the encoded side",
    () =>
      Effect.gen(function* () {
        const M = Schema.Struct({ f: oneOf(Adef, B), n: Schema.Finite });
        const K = Schema.Struct({ f: Schema.Unknown, n: F });
        for (const order of [
          [M, K],
          [K, M],
        ])
          expect(yield* outcome(post(oneOf(...order)), { f: {}, n: "5" })).toBe(
            'sent {"f":{},"n":"5"}',
          );
      }),
  );

  it.effect(
    "counts only the remaining complete readers in an enclosing oneOf",
    () =>
      Effect.gen(function* () {
        const M = Schema.Struct({ f: oneOf(Adef, B), a: F, b: F });
        const K = Schema.Struct({ f: Schema.Unknown, a: F, b: F });
        const L = Schema.Struct({ f: Schema.Struct({}), a: F, b: F });
        const body = { f: {}, a: "5", b: 6 };
        for (const order of [
          [M, K, L],
          [K, M, L],
          [K, L, M],
        ]) {
          const refused = yield* Effect.flip(toDecoded(oneOf(...order))(body));
          expect(refused.message).toBe("Expected exactly one member to match");
        }
        for (const order of [
          [M, S],
          [S, M],
        ]) {
          const refused = yield* Effect.flip(toDecoded(oneOf(...order))(body));
          expect(refused.message).toBe(
            'Expected exactly one member to match\n  at ["f"]',
          );
        }
      }),
  );

  it.effect("lets the anyOf writer choose the first matching member", () =>
    Effect.gen(function* () {
      const M = Schema.Struct({
        f: oneOf(Filter, Schema.Void),
        n: Schema.Finite,
      });
      const K = Schema.Struct({ f: Schema.Unknown, n: F });
      const body = { f: {}, n: "5" };
      for (const order of [
        [M, K],
        [K, M],
      ]) {
        const contract = Schema.Union(order);
        expect(yield* toDecoded(contract)(body)).toEqual({ f: {}, n: 5 });
        expect(yield* outcome(post(contract), body)).toBe(
          order[0] === M ? 'sent {"f":{},"n":5}' : 'sent {"f":{},"n":"5"}',
        );
      }
    }),
  );
});

describe("field reads beside an opaque neighbour", () => {
  // {} has one acceptor on the decoded side (Adef or B) and two on the encoded side. Alone, and
  // beside a clean neighbour, the constructor reads it. The neighbour's stray key and the field
  // order must not change that.
  const Inner = Schema.Struct({ a: S });
  for (const [name, members, written] of [
    ["Adef beside Encoded", [Adef, Encoded], '{"a":"x"}'],
    ["Encoded beside Adef", [Encoded, Adef], '{"a":"x"}'],
    ["B beside Encoded", [B, Encoded], "{}"],
  ] as const)
    it.effect(`reads the field the same way in every context, ${name}`, () =>
      Effect.gen(function* () {
        const u = oneOf(...members);
        expect(yield* outcome(post(Schema.Struct({ f: u })), { f: {} })).toBe(
          `sent {"f":${written}}`,
        );
        const o = Schema.Option(Inner);
        const some = '{"_tag":"Some","value":{"a":"x"}}';
        for (const neighbour of [
          () => Option.some({ a: "x" }),
          () => Option.some({ a: "x", extra: 1 }),
        ]) {
          expect(
            yield* outcome(post(Schema.Struct({ f: u, o })), {
              f: {},
              o: neighbour(),
            }),
            "f declared first",
          ).toBe(`sent {"f":${written},"o":${some}}`);
          expect(
            yield* outcome(post(Schema.Struct({ o, f: u })), {
              o: neighbour(),
              f: {},
            }),
            "f declared last",
          ).toBe(`sent {"o":${some},"f":${written}}`);
        }
      }),
    );
  it.effect("still refuses when the encoded side alone has two acceptors", () =>
    Effect.gen(function* () {
      const Encoded2 = Schema.Struct({ marker2: Schema.optionalKey(S) }).pipe(
        Schema.decodeTo(Schema.Struct({ code2: S }), {
          decode: SchemaGetter.transform(() => ({ code2: "decoded" })),
          encode: SchemaGetter.transform(() => ({})),
        }),
      );
      const u = oneOf(Encoded, Encoded2);
      const o = Schema.Option(Inner);
      const refused =
        'SchemaError: Expected exactly one member to match\n  at ["f"]';
      for (const neighbour of [
        () => Option.some({ a: "x" }),
        () => Option.some({ a: "x", extra: 1 }),
      ]) {
        expect(
          yield* outcome(post(Schema.Struct({ f: u, o })), {
            f: {},
            o: neighbour(),
          }),
        ).toBe(refused);
        expect(
          yield* outcome(post(Schema.Struct({ o, f: u })), {
            o: neighbour(),
            f: {},
          }),
        ).toBe(refused);
      }
    }),
  );
});

describe("write failures beside a readable field", () => {
  it.effect(
    "keeps the ambiguity when the only complete reader fails to write that field",
    () =>
      Effect.gen(function* () {
        // Both whole reads stop at a sibling before reaching f. The memberwise read discovers f's
        // ambiguity and must carry it through the successful read of K.
        const M = Schema.Struct({ a: F, b: F, f: oneOf(Adef, B) });
        const K = Schema.Struct({ a: F, b: F, f: Schema.Unknown });
        const contract = oneOf(M, K);
        const writerFailure = new Schema.SchemaError(
          new SchemaIssue.Pointer(
            ["f"],
            new SchemaIssue.InvalidValue({ message: "writer refused" }),
          ),
        );
        const write = reader(contract, () => Effect.fail(writerFailure));
        const refused = yield* Effect.flip(write({ a: "5", b: 6, f: {} }));
        expect(refused.message).toBe(
          'Expected exactly one member to match\n  at ["f"]',
        );
      }),
  );

  // K reads the whole value. JSON cannot write d, whichever member reads it, and K bound alone
  // says so. The refusal should name d, not the ambiguity of a member that did not read.
  it.effect("names the field the writer refused", () =>
    Effect.gen(function* () {
      const M = Schema.Struct({ f: oneOf(Adef, B), d: Schema.Any, a: F, b: F });
      const K = Schema.Struct({ f: Schema.Unknown, d: Schema.Any, a: F, b: F });
      const body = { f: {}, d: Number.NaN, a: "5", b: 6 };
      const alone = yield* outcome(post(K), body);
      expect(alone).toBe(
        'HttpBodyError: JSON body at $["d"] must be a finite number',
      );
      for (const order of [
        [M, K],
        [K, M],
      ])
        expect(yield* outcome(post(Schema.Union(order)), body)).toBe(alone);
    }),
  );

  it.effect(
    "keeps the schema writer's failure outside the ambiguous position",
    () =>
      Effect.gen(function* () {
        const M = Schema.Struct({
          f: oneOf(Adef, B),
          d: Schema.Unknown,
          a: F,
          b: F,
        });
        const K = Schema.Struct({
          f: Schema.Unknown,
          d: Schema.Unknown,
          a: F,
          b: F,
        });
        for (const order of [
          [M, K],
          [K, M],
        ]) {
          const result = yield* outcome(post(Schema.Union(order)), {
            f: {},
            d: new Date(0),
            a: "5",
            b: 6,
          });
          expect(result).toContain('Expected JSON value\n  at ["d"]');
        }
      }),
  );
});

const classify = (issue: SchemaIssue.Issue, given: unknown = {}) =>
  readFailure(new Schema.SchemaError(issue), given, () => ({}));

describe("classification of a reader's issues", () => {
  const inner = oneOf(Adef, B);
  const ambiguity = (seen: unknown) =>
    new SchemaIssue.OneOf(inner.ast, inner.ast.types, seen, {
      reportInput: true,
    });
  it("requires both the caller and the actual match input to be plain and fieldless", () => {
    for (const given of [{ a: "provided" }, new Map()])
      expect(classify(ambiguity({}), given)).toBeInstanceOf(Schema.SchemaError);
    for (const seen of [{ a: "produced" }, new Map()])
      expect(classify(ambiguity(seen))).toBeInstanceOf(Schema.SchemaError);
    expect(classify(ambiguity({}))).toBeInstanceOf(FieldlessOneOf);
  });

  it("distinguishes an invalid sibling from an excess key", () => {
    const shape = Schema.Struct({ f: inner, sibling: S });
    const f = new SchemaIssue.Pointer(["f"], ambiguity({}));
    const sibling = new SchemaIssue.Pointer(
      ["sibling"],
      new SchemaIssue.InvalidValue({ message: "invalid sibling" }),
    );
    const composite = new SchemaIssue.Composite(shape.ast, [f, sibling]);
    const given = { f: {} };
    expect(
      readFailure(new Schema.SchemaError(composite), given, () => given),
    ).toBeInstanceOf(Schema.SchemaError);
  });

  it("recognizes only a union with alternatives as enclosing another ambiguity", () => {
    for (const mode of ["anyOf", "oneOf"] as const)
      for (const members of [[inner], [inner, S]]) {
        const outer = Schema.Union(members, { mode });
        const issue = new SchemaIssue.AnyOf(outer.ast, [ambiguity({})]);
        const failure = classify(issue);
        expect(failure).toBeInstanceOf(FieldlessOneOf);
        expect((failure as FieldlessOneOf).insideUnion).toBe(
          members.length === 1 ? undefined : true,
        );
      }
  });
});

it.effect(
  "tries the exposed input when the normalized read cannot write strictly",
  () =>
    Effect.gen(function* () {
      const readModes: Array<string> = [];
      const first = Schema.Struct({
        tag: Schema.Literal("first"),
        x: Schema.optional(S),
      }).check(
        Schema.makeFilter((value, _, options) => {
          readModes.push(
            `${options.onExcessProperty}:${Object.hasOwn(value, "x")}`,
          );
          return true;
        }),
      );
      const second = Schema.Struct({ tag: Schema.Literal("second") });
      const contract = Schema.Union([first, second]);
      const failure = new Schema.SchemaError(
        new SchemaIssue.InvalidValue({ message: "strict write refused" }),
      );
      const modes: Array<string> = [];
      const read = reader(contract, (value, options) => {
        const mode = options?.onExcessProperty === "error" ? "strict" : "loose";
        const hasX = Object.hasOwn(value, "x");
        modes.push(`${mode}:${hasX}`);
        return mode === "strict" && hasX
          ? Effect.succeed(value)
          : Effect.fail(failure);
      });
      const result = yield* read({ tag: "first", x: undefined });
      expect(result.output).toEqual({ tag: "first", x: undefined });
      expect(modes).toEqual(["strict:false", "strict:true"]);
      expect(readModes.toSorted()).toEqual(["error:false", "error:true"]);
    }),
);

it.effect(
  "preserves Effect's reading of an opaque input copied during normalization",
  () =>
    Effect.gen(function* () {
      class Opaque {
        get limit() {
          return undefined;
        }
      }
      for (const f of [
        new Opaque(),
        Object.defineProperty({}, "extra", {
          get: () => 1,
          enumerable: true,
        }),
      ]) {
        for (const members of [
          [Filter, Schema.Void],
          [Schema.Void, Filter],
        ]) {
          const request = post(Schema.Struct({ f: oneOf(...members) }));
          expect(yield* outcome(request, { f })).toBe(
            members[0] === Filter
              ? 'sent {"f":{"page_size":"25"}}'
              : 'sent {"f":null}',
          );
        }
      }
      expect(
        yield* outcome(post(Schema.Struct({ f: oneOf(Adef, B) })), {
          f: new Map(),
        }),
      ).toBe('sent {"f":{"a":"x"}}');
    }),
);

it("treats an unresolved suspension as a possible oneOf without opening it", () => {
  let resolutions = 0;
  const schema = Schema.suspend(() => {
    resolutions++;
    return oneOf(Adef, B);
  });
  expect(Excess.mayHaveOneOf(schema.ast)).toBe(true);
  expect(Excess.choosesMemberResolved(Schema.Union([Adef, schema]).ast)).toBe(
    true,
  );
  expect(resolutions).toBe(0);
});

it.effect(
  "uses the successful normalized constructor when the raw constructor fails",
  () =>
    Effect.gen(function* () {
      const looseReads: Array<boolean> = [];
      const normalOnly = Schema.declareConstructor<object>()(
        [],
        () => (value, ast, options) => {
          const own =
            typeof value === "object" &&
            value !== null &&
            Object.hasOwn(value, "unused");
          if (options.onExcessProperty !== "error") {
            looseReads.push(own);
            if (!own && typeof value === "object" && value !== null)
              return Effect.succeed(value);
          }
          return Effect.fail(new SchemaIssue.InvalidType(ast));
        },
      );
      const contract = Schema.Union([
        normalOnly,
        Schema.Struct({ required: oneOf(Adef, B) }),
      ]);
      const read = reader(contract, Effect.succeed);
      expect((yield* read({ unused: undefined })).output).toEqual({});
      expect(looseReads).toEqual([false, true]);
    }),
);

it.effect("reports an ambiguity first found during memberwise recovery", () =>
  Effect.gen(function* () {
    const branch = Schema.Struct({ a: F, b: F, f: oneOf(Adef, B) });
    for (const mode of ["anyOf", "oneOf"] as const) {
      const contract = Schema.Union([branch, S], { mode });
      const failure = yield* Effect.flip(
        toDecoded(contract)({ a: "5", b: 6, f: {} }),
      );
      expect(failure.message).toBe(
        'Expected exactly one member to match\n  at ["f"]',
      );
    }
  }),
);

it.effect(
  "reads a named field while accounting for an encoded sibling and opaque excess",
  () =>
    Effect.gen(function* () {
      const o = Schema.Option(Schema.Struct({ a: S }));
      const f = oneOf(Adef, Encoded);
      const request = post(Schema.Struct({ n: F, o, f }));
      expect(
        yield* outcome(request, {
          n: "5",
          o: Option.some({ a: "x", extra: 1 }),
          f: {},
        }),
      ).toBe(
        'sent {"n":"5","o":{"_tag":"Some","value":{"a":"x"}},"f":{"a":"x"}}',
      );
    }),
);

it.effect(
  "keeps a fieldwise alternative's ambiguity through its enclosing field",
  () =>
    Effect.gen(function* () {
      const f = oneOf(Schema.Void, Schema.Struct({}));
      const branch = Schema.Struct({ a: F, b: F, f });
      const keeping = Schema.Struct({ a: F, b: F, f: Schema.Any });
      const p = Schema.Union([branch, keeping]);
      const o = Schema.Option(Schema.Struct({ a: S }));
      for (const neighbour of [
        Option.some({ a: "x" }),
        Option.some({ a: "x", extra: 1 }),
      ]) {
        const request = post(Schema.Struct({ n: F, o, p }));
        expect(
          yield* outcome(request, {
            n: 1,
            o: neighbour,
            p: { a: "5", b: 6, f: [undefined] },
          }),
        ).toBe(
          'SchemaError: Expected exactly one member to match\n  at ["p"]["f"]',
        );
      }
    }),
);

it.effect(
  "keeps the constructor ambiguity after an encoded alternative reads",
  () =>
    Effect.gen(function* () {
      const f = oneOf(Schema.Void, Schema.Struct({}));
      const branch = Schema.Struct({ f, n: Schema.Finite });
      const keeping = Schema.Struct({ f: Schema.Any, n: F });
      const request = post(Schema.Union([keeping, branch]));
      expect(yield* outcome(request, { f: [undefined], n: "5" })).toBe(
        'SchemaError: Expected exactly one member to match\n  at ["f"]',
      );
    }),
);

it.effect("rejects a normalized JSON retry that loses a supplied field", () =>
  Effect.gen(function* () {
    const f = Schema.Union([Schema.Struct({ c: S }), Schema.Unknown]);
    const o = Schema.Option(Schema.Struct({ a: S }));
    const request = post(Schema.Struct({ f, o, mark: S }));
    const body = {
      f: { c: undefined },
      o: Option.some({ a: "x", extra: 1 }),
      mark: "kept",
    };
    const missing = Excess.missing;
    let compared = 0;
    // Inject a loss in the comparison of the normalized retry's output.
    const instrumented = vi
      .spyOn(Excess, "missing")
      .mockImplementation((types, given, value, output, options) => {
        if (output !== undefined) {
          compared++;
          return [["mark"]];
        }
        return missing(types, given, value, output, options);
      });
    try {
      const result = yield* outcome(request, body);
      expect(compared).toBe(1);
      expect(result).toContain('Expected JSON value\n  at ["f"]');
    } finally {
      instrumented.mockRestore();
    }
  }),
);

it.effect(
  "retains the ambiguity for a field available only under its wire name",
  () =>
    Effect.gen(function* () {
      const contract = Schema.Struct({ f: oneOf(Adef, B) }).pipe(
        Schema.encodeKeys({ f: "wire" }),
      );
      const refusal = yield* Effect.flip(toDecoded(contract)({ wire: {} }));
      expect(refusal.message).toBe(
        'Expected exactly one member to match\n  at ["wire"]',
      );
    }),
);

// Reads {} only on its encoded side and writes it back as {}.
const EncodedOnly = Schema.Struct({}).pipe(
  Schema.decodeTo(Schema.Literal("encoded"), {
    decode: SchemaGetter.transform(() => "encoded" as const),
    encode: SchemaGetter.transform(() => ({})),
  }),
);
const Opaque = Schema.Option(Schema.Struct({ a: S }));
const clean = () => Option.some({ a: "x" });
// `extra` is a key the Option's schema does not state. Effect strips it; a strict pass refuses it.
const stray = () => Option.some({ a: "x", extra: 1 });
const some = '{"_tag":"Some","value":{"a":"x"}}';

describe("an enclosing reader beside an opaque neighbour's stray key", () => {
  // U is ambiguous for {}, so it does not read. The other member of the enclosing union reads {}
  // on its encoded side. A key the neighbour's schema does not state must not change that, in
  // either field order.
  for (const [name, members] of [
    ["Filter beside Void", [Filter, Schema.Void]],
    ["two optional-field structs", [Adef, B]],
  ] as const) {
    const U = oneOf(...members);
    for (const [label, enclosing] of [
      ["anyOf, ambiguous member first", Schema.Union([U, EncodedOnly])],
      ["anyOf, ambiguous member last", Schema.Union([EncodedOnly, U])],
      ["oneOf, ambiguous member first", oneOf(U, EncodedOnly)],
      ["oneOf, ambiguous member last", oneOf(EncodedOnly, U)],
    ] as const)
      it.effect(`reads f through the other member, ${name}, ${label}`, () =>
        Effect.gen(function* () {
          expect(
            yield* outcome(post(Schema.Struct({ f: enclosing })), { f: {} }),
          ).toBe('sent {"f":{}}');
          for (const neighbour of [clean, stray]) {
            expect(
              yield* outcome(post(Schema.Struct({ f: enclosing, o: Opaque })), {
                f: {},
                o: neighbour(),
              }),
              `f declared first, ${neighbour === stray ? "stray key" : "clean"}`,
            ).toBe(`sent {"f":{},"o":${some}}`);
            expect(
              yield* outcome(post(Schema.Struct({ o: Opaque, f: enclosing })), {
                o: neighbour(),
                f: {},
              }),
              `f declared last, ${neighbour === stray ? "stray key" : "clean"}`,
            ).toBe(`sent {"o":${some},"f":{}}`);
          }
        }),
      );

    // The enclosing union is the whole value. M holds the ambiguous field. K reads the value, and
    // both members state the opaque neighbour after f.
    for (const [scene, M, K, body] of [
      [
        "K fits only the encoded side",
        Schema.Struct({ f: U, n: Schema.Finite, o: Opaque }),
        Schema.Struct({ f: Schema.Unknown, n: F, o: Opaque }),
        (o: unknown) => ({ f: {}, n: "5", o }),
      ],
      [
        "mixed-side siblings",
        Schema.Struct({ f: U, a: F, b: F, o: Opaque }),
        Schema.Struct({ f: Schema.Unknown, a: F, b: F, o: Opaque }),
        (o: unknown) => ({ f: {}, a: "5", b: 6, o }),
      ],
      [
        "decoded siblings",
        Schema.Struct({ f: U, a: F, o: Opaque }),
        Schema.Struct({ f: Schema.Unknown, a: F, o: Opaque }),
        (o: unknown) => ({ f: {}, a: 5, o }),
      ],
    ] as const)
      it.effect(
        `gives the whole value the same result beside a stray key, ${name}, ${scene}`,
        () =>
          Effect.gen(function* () {
            for (const contract of [
              Schema.Union([M, K]),
              Schema.Union([K, M]),
              oneOf(M, K),
              oneOf(K, M),
            ]) {
              const beside = yield* outcome(post(contract), body(clean()));
              expect(yield* outcome(post(contract), body(stray()))).toBe(
                beside,
              );
            }
          }),
      );
  }

  // An undefined-valued key is left out when deciding what f holds, so { zz: undefined } is {}.
  // U is ambiguous for it and does not read; K is the one reader, and only K can write {}.
  it.effect(
    "does not count an ambiguous member as a reader of an undefined-valued key",
    () =>
      Effect.gen(function* () {
        const U = oneOf(Filter, Schema.Void, B);
        const enclosing = oneOf(U, Schema.Struct({}));
        const contract = Schema.Struct({ f: enclosing, o: Opaque });
        for (const f of [() => ({}), () => ({ zz: undefined })])
          for (const neighbour of [clean, stray])
            expect(
              yield* outcome(post(contract), { f: f(), o: neighbour() }),
            ).toBe(`sent {"f":{},"o":${some}}`);
      }),
  );

  it.effect(
    "keeps the one reader of an undefined-valued key beside an encoded-side sibling and a stray key",
    () =>
      Effect.gen(function* () {
        const U = oneOf(Filter, Schema.Void, B);
        const contract = post(
          Schema.Struct({ f: oneOf(U, Schema.Struct({})), o: Opaque, n: F }),
        );
        for (const f of [() => ({}), () => ({ zz: undefined })])
          for (const neighbour of [clean, stray])
            for (const n of ["5", 5])
              expect(
                yield* outcome(contract, { f: f(), o: neighbour(), n }),
              ).toBe(`sent {"f":{},"o":${some},"n":"5"}`);
      }),
  );

  it.effect(
    "retries a loose read on the normalized field before counting readers",
    () =>
      Effect.gen(function* () {
        const U = oneOf(Adef, B);
        for (const f of [oneOf(U, EncodedOnly), oneOf(EncodedOnly, U)]) {
          expect(
            yield* outcome(post(Schema.Struct({ f, o: Opaque })), {
              f: { a: undefined },
              o: stray(),
            }),
          ).toBe(`sent {"f":{},"o":${some}}`);
        }
      }),
  );

  it.effect(
    "uses the normalized reading when an exposed key would let Void read",
    () =>
      Effect.gen(function* () {
        const M = Schema.Struct({ f: oneOf(Filter, Schema.Void), a: F, b: F });
        const K = Schema.Struct({ f: Schema.Struct({}), a: F, b: F });
        for (const schema of [oneOf(M, K), oneOf(K, M)]) {
          expect(
            yield* outcome(post(schema), { f: { a: undefined }, a: "5", b: 6 }),
          ).toBe('sent {"f":{},"a":"5","b":"6"}');
        }
      }),
  );

  it.effect(
    "reuses the field reading that settled the whole decoder's ambiguity",
    () =>
      Effect.gen(function* () {
        let defaults = 0;
        const defaulted = Schema.Struct({
          a: Schema.optionalKey(S).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                defaults++;
                return "x";
              }),
            ),
          ),
        });
        // n needs decoding. The whole decoder finds two encoded matches at f, while
        // the field's constructor can take the defaulted member on its own.
        const schema = Schema.Struct({
          n: F,
          f: oneOf(defaulted, EncodedOnly),
        });
        expect(yield* outcome(post(schema), { n: "5", f: {} })).toBe(
          'sent {"n":"5","f":{"a":"x"}}',
        );
        expect(defaults).toBe(1);
      }),
  );
});

it.effect("preserves a final writer error that has no body position", () =>
  Effect.gen(function* () {
    const contract = Schema.Struct({
      f: Schema.Union([oneOf(Adef, B), EncodedOnly]),
    });
    const failure = new Error("the final writer refused", {
      cause: new WriterError("the writer supplied no body position"),
    });
    const encode = jsonEncoder(contract, contract, () => Effect.fail(failure));
    expect(yield* Effect.flip(encode({ f: {} }))).toBe(failure);
  }),
);

it.effect(
  "keeps a fieldless refusal when an exposed key would let Void read",
  () =>
    Effect.gen(function* () {
      for (const members of [
        [Filter, Schema.Void],
        [Schema.Void, Filter],
      ] as const) {
        const union = oneOf(...members);
        const optional = post(Schema.Struct({ f: Schema.optional(union) }));
        const renamed = post(
          Schema.Struct({ f: union }).pipe(Schema.encodeKeys({ f: "wire" })),
        );
        expect(yield* outcome(optional, { f: { a: undefined } })).toBe(
          'SchemaError: Expected exactly one member to match\n  at ["f"]',
        );
        expect(yield* outcome(renamed, { wire: { a: undefined } })).toBe(
          'SchemaError: Expected exactly one member to match\n  at ["wire"]',
        );
      }
    }),
);

describe("an enclosing union with a reader in a later member", () => {
  for (const [name, members] of [
    ["Filter beside Void", [Filter, Schema.Void]],
    ["two optional-field structs", [Adef, B]],
  ] as const) {
    const U = oneOf(...members);
    // First is ambiguous at f and has nothing else to try. The reader sits in a nested union.
    const First = Schema.Struct({ f: U, o: Opaque, x: Schema.optionalKey(S) });
    const M = Schema.Struct({ f: U, o: Opaque });
    for (const [kname, K] of [
      ["Unknown", Schema.Struct({ f: Schema.Unknown, o: Opaque })],
      ["an empty struct", Schema.Struct({ f: Schema.Struct({}), o: Opaque })],
    ] as const)
      for (const [label, contract] of [
        [
          "nested anyOf, ambiguous member first",
          Schema.Union([First, Schema.Union([M, K])]),
        ],
        [
          "nested anyOf, ambiguous member last",
          Schema.Union([Schema.Union([M, K]), First]),
        ],
        [
          "nested oneOf, ambiguous member first",
          Schema.Union([First, oneOf(M, K)]),
        ],
      ] as const)
        it.effect(
          `reads through the nested union's reader, ${name}, K holds f as ${kname}, ${label}`,
          () =>
            Effect.gen(function* () {
              for (const neighbour of [clean, stray])
                expect(
                  yield* outcome(post(contract), { f: {}, o: neighbour() }),
                  neighbour === stray ? "stray key" : "clean",
                ).toBe(`sent {"f":{},"o":${some}}`);
            }),
        );

    // A states f as the bare inner oneOf. Bm states it as an enclosing union whose other member
    // reads {} on its encoded side.
    const A = Schema.Struct({ f: U, o: Opaque });
    for (const [label, Bm] of [
      [
        "anyOf",
        Schema.Struct({ f: Schema.Union([U, EncodedOnly]), o: Opaque }),
      ],
      ["oneOf", Schema.Struct({ f: oneOf(U, EncodedOnly), o: Opaque })],
    ] as const)
      it.effect(
        `reads f through the second member's own enclosing ${label}, ${name}`,
        () =>
          Effect.gen(function* () {
            for (const contract of [
              Schema.Union([A, Bm]),
              Schema.Union([Bm, A]),
              oneOf(A, Bm),
              oneOf(Bm, A),
            ])
              for (const neighbour of [clean, stray])
                expect(
                  yield* outcome(post(contract), { f: {}, o: neighbour() }),
                  neighbour === stray ? "stray key" : "clean",
                ).toBe(`sent {"f":{},"o":${some}}`);
          }),
      );
  }
});

describe("reassembling fields beside an encoded-side sibling", () => {
  for (const [kname, K] of [
    ["an empty struct", Schema.Struct({})],
    ["Unknown", Schema.Unknown],
    ["a record", Schema.Record(S, Schema.Unknown)],
  ] as const)
    it.effect(
      `reads an undefined-valued key through K beside an encoded-side sibling, K is ${kname}`,
      () =>
        Effect.gen(function* () {
          const U = oneOf(Filter, Schema.Void);
          for (const enclosing of [oneOf(U, K), oneOf(K, U)]) {
            // No sibling needs decoding: this already sends on 44725e4.
            expect(
              yield* outcome(post(Schema.Struct({ f: enclosing, n: F })), {
                f: { zz: undefined },
                n: 5,
              }),
            ).toBe('sent {"f":{},"n":"5"}');
            expect(
              yield* outcome(post(Schema.Struct({ f: enclosing, n: F })), {
                f: { zz: undefined },
                n: "5",
              }),
            ).toBe('sent {"f":{},"n":"5"}');
            expect(
              yield* outcome(
                post(Schema.Struct({ f: enclosing, a: F, b: F })),
                { f: { a: undefined }, a: "5", b: 6 },
              ),
            ).toBe('sent {"f":{},"a":"5","b":"6"}');
          }
        }),
    );
});

it.effect(
  "keeps a value that is not plain data out of the fieldless refusal beside a stray key",
  () =>
    Effect.gen(function* () {
      class Empty {}
      const contract = Schema.Struct({
        f: oneOf(Filter, Schema.Void),
        o: Opaque,
      });
      for (const neighbour of [clean, stray])
        expect(
          yield* outcome(post(contract), { f: new Empty(), o: neighbour() }),
          neighbour === stray ? "stray key" : "clean",
        ).toBe(`sent {"f":{"page_size":"25"},"o":${some}}`);
    }),
);

it.effect(
  "reports the sibling's failure after reading an unaccounted field on its decoded side",
  () =>
    Effect.gen(function* () {
      // `constructor` is a name every object has, so this root is not accounted for. The whole
      // decoder finds two encoded matches at f; f reads on its decoded side; n is what fails.
      const contract = Schema.Struct({
        f: oneOf(Adef, EncodedOnly),
        n: F,
        constructor: Schema.optionalKey(S),
      });
      expect(yield* outcome(post(contract), { f: {}, n: "5" })).toBe(
        'SchemaError: Expected number\n  at ["n"]',
      );
    }),
);

describe("enclosing union limits", () => {
  const U = oneOf(Filter, Schema.Void);
  const M = Schema.Struct({ f: U });
  const K = Schema.Struct({ f: Schema.Struct({}) });
  const opaqueWithAlternative = post(
    Schema.Struct({ f: Schema.Union([U, EncodedOnly]), o: Opaque }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/310
  it.effect(
    "currently writes null or an object depending on enclosing oneOf order",
    () =>
      Effect.gen(function* () {
        const input = { f: { zz: undefined } };
        expect(yield* outcome(post(oneOf(M, K)), input)).toBe(
          'sent {"f":null}',
        );
        expect(yield* outcome(post(oneOf(K, M)), input)).toBe('sent {"f":{}}');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/310
  it.effect.fails(
    "writes the object through the only reader in either enclosing oneOf order",
    () =>
      Effect.gen(function* () {
        for (const contract of [oneOf(M, K), oneOf(K, M)]) {
          expect(yield* outcome(post(contract), { f: { zz: undefined } })).toBe(
            'sent {"f":{}}',
          );
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/310
  it.effect(
    "currently writes null through Void beside an opaque neighbour's stray key",
    () =>
      Effect.gen(function* () {
        const f = { page_size: undefined };
        expect(yield* outcome(opaqueWithAlternative, { f, o: clean() })).toBe(
          `sent {"f":{},"o":${some}}`,
        );
        expect(yield* outcome(opaqueWithAlternative, { f, o: stray() })).toBe(
          `sent {"f":null,"o":${some}}`,
        );
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/310
  it.effect.fails(
    "writes the object through the encoded reader beside a stray key",
    () =>
      Effect.gen(function* () {
        for (const neighbour of [clean, stray]) {
          expect(
            yield* outcome(opaqueWithAlternative, {
              f: { page_size: undefined },
              o: neighbour(),
            }),
          ).toBe(`sent {"f":{},"o":${some}}`);
        }
      }),
  );
});

const spelled = (f: object) =>
  JSON.stringify(f, (_key, value: unknown) => value ?? "undefined");
const ambiguous = (at: string) =>
  `SchemaError: Expected exactly one member to match\n  at ${at}`;

describe("a Some payload beside Void", () => {
  const strays = [{ extra: 1 }, { zz: undefined }, { a: "y" }];
  // A key no member of the payload states is left out, as Effect leaves it out, so the payload
  // gives the result of Some({}).
  // https://github.com/viell-dev/slop-effect-schema-http/issues/310
  for (const [name, codec] of [
    [
      "OptionFromNullOr, Filter first",
      Schema.OptionFromNullOr(oneOf(Filter, Schema.Void)),
    ],
    [
      "OptionFromNullOr, Void first",
      Schema.OptionFromNullOr(oneOf(Schema.Void, Filter)),
    ],
    [
      "OptionFromUndefinedOr",
      Schema.OptionFromUndefinedOr(oneOf(Filter, Schema.Void)),
    ],
  ] as const)
    it.effect(`refuses a payload of unstated keys as Some({}), ${name}`, () =>
      Effect.gen(function* () {
        for (const payload of [{}, ...strays]) {
          const label = spelled(payload);
          expect(
            yield* outcome(post(Schema.Struct({ f: codec })), {
              f: Option.some(payload),
            }),
            label,
          ).toBe(ambiguous('["f"]["value"]'));
          expect(
            yield* outcome(
              post(Schema.Struct({ g: Schema.Struct({ f: codec }) })),
              { g: { f: Option.some(payload) } },
            ),
            `nested, ${label}`,
          ).toBe(ambiguous('["g"]["f"]["value"]'));
          expect(
            yield* outcome(post(codec), Option.some(payload)),
            `whole body, ${label}`,
          ).toBe(ambiguous('["value"]'));
          for (const neighbour of [clean, stray]) {
            const beside = `${label}, ${neighbour === stray ? "stray key" : "clean"}`;
            expect(
              yield* outcome(post(Schema.Struct({ f: codec, o: Opaque })), {
                f: Option.some(payload),
                o: neighbour(),
              }),
              `f declared first, ${beside}`,
            ).toBe(ambiguous('["f"]["value"]'));
            expect(
              yield* outcome(post(Schema.Struct({ o: Opaque, f: codec })), {
                o: neighbour(),
                f: Option.some(payload),
              }),
              `f declared last, ${beside}`,
            ).toBe(ambiguous('["f"]["value"]'));
          }
        }
      }),
    );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/310
  it.effect("writes such a payload as its anyOf writes Some({})", () =>
    Effect.gen(function* () {
      for (const [members, sent] of [
        [[Filter, Schema.Void], "{}"],
        [[Schema.Void, Filter], "null"],
      ] as const) {
        const codec = Schema.OptionFromNullOr(Schema.Union(members));
        for (const payload of [{}, ...strays]) {
          const label = spelled(payload);
          expect(
            yield* outcome(post(Schema.Struct({ f: codec })), {
              f: Option.some(payload),
            }),
            label,
          ).toBe(`sent {"f":${sent}}`);
          expect(
            yield* outcome(post(Schema.Struct({ f: codec, o: Opaque })), {
              f: Option.some(payload),
              o: clean(),
            }),
            `f declared first, ${label}`,
          ).toBe(`sent {"f":${sent},"o":${some}}`);
          expect(
            yield* outcome(post(Schema.Struct({ o: Opaque, f: codec })), {
              o: clean(),
              f: Option.some(payload),
            }),
            `f declared last, ${label}`,
          ).toBe(`sent {"o":${some},"f":${sent}}`);
        }
      }
    }),
  );

  it.effect("keeps a payload's stated field and None as before", () =>
    Effect.gen(function* () {
      const either = Schema.Struct({
        f: Schema.OptionFromNullOr(Schema.Union([Filter, Schema.Void])),
      });
      expect(
        yield* outcome(post(either), { f: Option.some({ limit: 5 }) }),
      ).toBe('sent {"f":{"page_size":"5"}}');
      expect(yield* outcome(post(either), { f: Option.none() })).toBe(
        'sent {"f":null}',
      );
      const alone = Schema.Struct({ f: Schema.OptionFromNullOr(Filter) });
      expect(
        yield* outcome(post(alone), {
          f: Option.some({ limit: 5, extra: 1 }),
        }),
      ).toBe('sent {"f":{"page_size":"5"}}');
      const structs = Schema.Struct({
        f: Schema.OptionFromNullOr(oneOf(Adef, B)),
      });
      expect(
        yield* outcome(post(structs), { f: Option.some({ a: "y" }) }),
      ).toBe('sent {"f":{"a":"y"}}');
    }),
  );

  const U = Schema.OptionFromNullOr(oneOf(Filter, Schema.Void));
  // https://github.com/viell-dev/slop-effect-schema-http/issues/340
  it.effect(
    "currently writes null for a payload whose only key is a stated one set to undefined",
    () =>
      Effect.gen(function* () {
        for (const payload of [{ limit: undefined }, { page_size: undefined }])
          expect(
            yield* outcome(post(Schema.Struct({ f: U })), {
              f: Option.some(payload),
            }),
            spelled(payload),
          ).toBe('sent {"f":null}');
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/340
  it.effect.fails(
    "refuses a payload whose only key is a stated one set to undefined, as Some({})",
    () =>
      Effect.gen(function* () {
        for (const payload of [{ limit: undefined }, { page_size: undefined }])
          expect(
            yield* outcome(post(Schema.Struct({ f: U })), {
              f: Option.some(payload),
            }),
            spelled(payload),
          ).toBe(ambiguous('["f"]["value"]'));
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/341
  it.effect(
    "currently writes null for a payload with a stated field and an unstated key",
    () =>
      Effect.gen(function* () {
        for (const members of [
          Schema.Union([Filter, Schema.Void]),
          oneOf(Filter, Schema.Void),
        ])
          expect(
            yield* outcome(
              post(Schema.Struct({ f: Schema.OptionFromNullOr(members) })),
              { f: Option.some({ limit: 5, extra: 1 }) },
            ),
          ).toBe('sent {"f":null}');
      }),
  );
});
