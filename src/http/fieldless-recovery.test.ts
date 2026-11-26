import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { bodyOf } from "../../test/request.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";
import { FieldlessOneOf, readFailure } from "./internal/ambiguity.js";
import { reader, toDecoded } from "./internal/input.js";

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
      const first = Schema.Struct({
        tag: Schema.Literal("first"),
        x: Schema.optional(S),
      });
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
    }),
);
