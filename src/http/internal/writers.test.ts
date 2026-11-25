import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Exit,
  Option,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect";
import { recordingInto, recordingWriter, type WriterNotes } from "./writers.js";

const text = Schema.String;

/** A field that counts each time its member runs, under the member's index. */
type Counter = (index: number) => Schema.Codec<string, string>;

interface Case {
  readonly name: string;
  /** The schema to write, built with the counting field for each member. */
  readonly schema: (seen: Counter) => Schema.Codec<unknown, unknown>;
  readonly value: unknown;
}

const tagged = (
  seen: Counter,
  index: number,
  fields: Schema.Struct.Fields,
): Schema.Codec<unknown, unknown> =>
  Schema.Struct({ v: seen(index), ...fields }) as never;

const symbol = Symbol.for("viell-effect-schema-http/test/tag");
const other = Symbol.for("viell-effect-schema-http/test/other");

/** A tag the value may leave out, which the wire always carries. */
const stamped = (literal: "a" | "b") =>
  Schema.optionalKey(Schema.Literal(literal)).pipe(
    Schema.encodeTo(Schema.Literal(literal), {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.transformOptional(() => Option.some(literal)),
    }),
  );

/** A member that renames `b` to `a` and hands its whole input on. */
const Renamer = Schema.Struct({ a: text }).pipe(
  Schema.decodeTo(
    Schema.Struct({ b: text }),
    SchemaTransformation.transform({
      decode: ({ a }) => ({ b: a }),
      encode: (value) => ({ ...value, a: value.b }),
    }),
  ),
);

const pair = (
  seen: Counter,
  left: Schema.Struct.Fields,
  right: Schema.Struct.Fields,
) => Schema.Union([tagged(seen, 0, left), tagged(seen, 1, right)]);

// Each union is written for a value that one member's tag selects, or that a tag rules a member
// out for, unless the tag form is one Effect does not select by.
const cases: ReadonlyArray<Case> = [
  {
    name: "literal tags",
    schema: (seen) =>
      pair(seen, { tag: Schema.Literal("A") }, { tag: Schema.Literal("B") }),
    value: { v: "x", tag: "B" },
  },
  {
    name: "tagDefaultOmit tags",
    schema: (seen) =>
      pair(
        seen,
        { _tag: Schema.tagDefaultOmit("A") },
        { _tag: Schema.tagDefaultOmit("B") },
      ),
    value: { v: "x", _tag: "B" },
  },
  {
    name: "tags with a decoding default",
    schema: (seen) =>
      pair(
        seen,
        {
          kind: Schema.Literal("k1").pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("k1")),
          ),
        },
        {
          kind: Schema.Literal("k2").pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("k2")),
          ),
        },
      ),
    value: { v: "x", kind: "k2" },
  },
  {
    name: "a tag with a decoding default beside a plain member",
    schema: (seen) =>
      pair(
        seen,
        {
          kind: Schema.Literal("k1").pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("k1")),
          ),
        },
        { a: Schema.Number },
      ),
    value: { v: "x", a: 5 },
  },
  {
    name: "tags with a decoding default of the type",
    schema: (seen) =>
      pair(
        seen,
        {
          kind: Schema.Literal("k1").pipe(
            Schema.withDecodingDefaultTypeKey(Effect.succeed("k1" as const)),
          ),
        },
        {
          kind: Schema.Literal("k2").pipe(
            Schema.withDecodingDefaultTypeKey(Effect.succeed("k2" as const)),
          ),
        },
      ),
    value: { v: "x", kind: "k2" },
  },
  {
    name: "a tag the wire always carries",
    schema: (seen) => pair(seen, { kind: stamped("a"), p: text }, { q: text }),
    value: { v: "x", p: "y" },
  },
  {
    name: "renamed tags",
    schema: (seen) =>
      Schema.Union([
        Schema.Struct({ v: seen(0), tag: Schema.Literal("A") }).pipe(
          Schema.encodeKeys({ tag: "type" }),
        ),
        Schema.Struct({ v: seen(1), tag: Schema.Literal("B") }).pipe(
          Schema.encodeKeys({ tag: "type" }),
        ),
      ]) as never,
    value: { v: "x", tag: "B" },
  },
  {
    name: "symbol tags",
    schema: (seen) =>
      pair(
        seen,
        { tag: Schema.UniqueSymbol(symbol) },
        { tag: Schema.UniqueSymbol(other) },
      ),
    value: { v: "x", tag: other },
  },
  {
    name: "number tags",
    schema: (seen) =>
      pair(seen, { tag: Schema.Literal(1) }, { tag: Schema.Literal(2) }),
    value: { v: "x", tag: 2 },
  },
  {
    name: "boolean tags",
    schema: (seen) =>
      pair(seen, { tag: Schema.Literal(true) }, { tag: Schema.Literal(false) }),
    value: { v: "x", tag: false },
  },
  {
    name: "template tags, which select nothing",
    schema: (seen) =>
      pair(
        seen,
        { id: Schema.TemplateLiteral(["a-", Schema.String]) },
        { id: Schema.TemplateLiteral(["b-", Schema.String]) },
      ),
    value: { v: "x", id: "b-1" },
  },
  {
    name: "a second tag named after an inherited name",
    schema: (seen) =>
      pair(
        seen,
        { kind: Schema.Literal("y"), constructor: Schema.Literal("a") },
        { kind: Schema.Literal("y") },
      ),
    value: { v: "x", kind: "y" },
  },
  {
    name: "a tag named after an inherited name, given",
    schema: (seen) =>
      pair(
        seen,
        { toString: Schema.Literal("a") },
        { toString: Schema.Literal("b") },
      ),
    value: { v: "x", toString: "b" },
  },
  {
    name: "a tag named after an inherited name, left out",
    schema: (seen) =>
      pair(seen, { toString: Schema.Literal("a") }, { other: text }),
    value: { v: "x", other: "y" },
  },
  {
    name: "tags in a nested union",
    schema: (seen) =>
      Schema.Union([
        Schema.Union([
          tagged(seen, 0, { tag: Schema.Literal("A") }),
          tagged(seen, 1, { tag: Schema.Literal("B") }),
        ]),
        tagged(seen, 2, { tag: Schema.Literal("C") }),
      ]),
    value: { v: "x", tag: "C" },
  },
  {
    name: "tags behind a suspension",
    schema: (seen) =>
      Schema.Union([
        Schema.suspend(() => tagged(seen, 0, { tag: Schema.Literal("A") })),
        tagged(seen, 1, { tag: Schema.Literal("B") }),
      ]),
    value: { v: "x", tag: "B" },
  },
  {
    name: "a suspended union",
    schema: (seen) =>
      Schema.suspend(() =>
        pair(seen, { tag: Schema.Literal("A") }, { tag: Schema.Literal("B") }),
      ),
    value: { v: "x", tag: "B" },
  },
  {
    name: "one-of members with tags",
    schema: (seen) =>
      Schema.Union(
        [
          tagged(seen, 0, { tag: Schema.Literal("A") }),
          tagged(seen, 1, { tag: Schema.Literal("B") }),
        ],
        { mode: "oneOf" },
      ),
    value: { v: "x", tag: "A" },
  },
  {
    name: "tagged list members",
    schema: (seen) =>
      Schema.Union([
        Schema.Tuple([Schema.Literal("a"), seen(0)]),
        Schema.Tuple([Schema.Literal("b"), seen(1)]),
      ]) as never,
    value: ["b", "x"],
  },
  {
    name: "a class member's tag",
    schema: (seen) => {
      class Tagged extends Schema.Class<Tagged>("Tagged")({
        v: seen(0),
        tag: Schema.Literal("A"),
      }) {}
      return Schema.Union([
        Tagged,
        tagged(seen, 1, { tag: Schema.Literal("B") }),
      ]) as never;
    },
    value: { v: "x", tag: "B" },
  },
  {
    name: "a struct that states no field, beside null",
    schema: () =>
      Schema.Union([
        Schema.Struct({}),
        Schema.Null.pipe(
          Schema.encodeTo(text.check(Schema.isMinLength(9)), {
            decode: SchemaGetter.transform(() => null),
            encode: SchemaGetter.transform(() => "null"),
          }),
        ),
      ]) as never,
    value: null,
  },
  {
    name: "a renaming member after a tagged one",
    schema: (seen) =>
      Schema.Union([
        tagged(seen, 0, {
          kind: Schema.Literal("k1").pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("k1")),
          ),
        }),
        Renamer,
      ]) as never,
    value: { b: "go" },
  },
];

/** What a write sent, or its error's message. */
const outcome = (exit: Exit.Exit<unknown, Schema.SchemaError>) =>
  Exit.isSuccess(exit) ? { sent: exit.value } : { refused: String(exit.cause) };

// `candidates.ts` reimplements how Effect selects a union's members, which Effect keeps internal.
// These run on every supported Effect in CI, so the reimplementation is checked against the
// installed version's own writes.
describe("the recording writer", () => {
  it("writes a union strictly where a member can, and else as Effect does", () => {
    const write = (schema: Schema.Top, value: unknown) =>
      Schema.encodeUnknownExit(
        Schema.make<Schema.Codec<unknown, unknown>>(
          recordingWriter(schema.ast),
        ),
      )(value, recordingInto([]));
    const A = Schema.Struct({ a: text });
    const AB = Schema.Struct({ a: text, b: text });
    const value = { a: "x", b: "y" };
    const sent = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isSuccess(exit) ? exit.value : "refused";
    for (const schema of [
      Schema.Union([A, AB]),
      Schema.Union([A, Schema.Union([Schema.Null, AB])]),
      Schema.Union([A, AB], { mode: "oneOf" }),
      Schema.Union([Schema.Void, A, AB]),
    ])
      expect(sent(write(schema, value))).toEqual(value);
    // No member writes the stray key, so the first that fits strips it, as Effect has it.
    expect(sent(write(Schema.Union([A, AB]), { ...value, z: 1 }))).toEqual({
      a: "x",
    });
    // Two members still write it strictly, so one-of refuses, as Effect does.
    const loose = Schema.Struct({ a: text, b: Schema.optionalKey(text) });
    expect(
      sent(write(Schema.Union([A, loose], { mode: "oneOf" }), { a: "x" })),
    ).toBe("refused");
    class Own extends Schema.Class<Own>("Own")({ a: text }) {
      readonly own = 1;
    }
    for (const schema of [
      Schema.Union([A, Own]),
      Schema.Union([Own, Schema.Struct({})]),
      Schema.Union([Schema.Null, Schema.Union([Own, Schema.Struct({})])]),
    ])
      expect(sent(write(schema, new Own({ a: "x" })))).toEqual({ a: "x" });
  });

  it.each(cases)(
    "selects, runs and writes as Effect does: $name",
    ({ schema, value }) => {
      let runs: Array<number> = [];
      const seen: Counter = (index) =>
        text.pipe(
          Schema.middlewareEncoding((effect) =>
            Effect.andThen(
              Effect.sync(() => {
                runs[index] = (runs[index] ?? 0) + 1;
              }),
              effect,
            ),
          ),
        );
      const plain = schema(seen);
      const plainOutcome = outcome(Schema.encodeUnknownExit(plain)(value));
      const plainRuns = runs;
      runs = [];
      const notes: WriterNotes = [];
      const recorded = Schema.make<Schema.Codec<unknown, unknown>>(
        recordingWriter(schema(seen).ast),
      );
      const recordedOutcome = outcome(
        Schema.encodeUnknownExit(recorded)(value, recordingInto(notes)),
      );
      expect({ outcome: recordedOutcome, runs }).toEqual({
        outcome: plainOutcome,
        runs: plainRuns,
      });
    },
  );
});
