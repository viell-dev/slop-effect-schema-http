import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaTransformation } from "effect";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

// https://github.com/viell-dev/slop-effect-schema-http/issues/143
describe("a renamed union tag on either side", () => {
  const Tagged = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), x: Schema.String }).pipe(
      Schema.encodeKeys({ kind: "k" }),
    ),
    Schema.Struct({ kind: Schema.Literal("c") }).pipe(
      Schema.encodeKeys({ kind: "k" }),
    ),
  ]);

  it.effect(
    "lets the encoded tag rule out the member that alone states a field",
    () =>
      Effect.gen(function* () {
        const query = { k: "c", x: "from-a-wider-value" } as const;
        const compiled = yield* Request.compile(
          Request.get("/x").pipe(Request.query(Tagged)),
          { query },
        );
        expect(compiled.request.url).toBe("/x?k=c");
      }),
  );

  it.effect("reads the encoded tag inside a list and nested object", () =>
    Effect.gen(function* () {
      const body = { items: [{ k: "c", x: "from-a-wider-value" }] } as const;
      const compiled = yield* Request.compile(
        Request.post("/x").pipe(
          Request.body(
            Body.jsonSchema(Schema.Struct({ items: Schema.Array(Tagged) })),
          ),
        ),
        { body },
      );
      expect(bodyText(compiled.request)).toBe('{"items":[{"k":"c"}]}');
    }),
  );

  it.effect(
    "checks a tag changed by an object transformation on its encoded side",
    () =>
      Effect.gen(function* () {
        const Changed = Schema.Struct({ kind: Schema.Literal("a") }).pipe(
          Schema.decodeTo(
            Schema.Struct({ kind: Schema.Literal("A") }),
            SchemaTransformation.transform({
              decode: () => ({ kind: "A" as const }),
              encode: () => ({ kind: "a" as const }),
            }),
          ),
        );
        const Either = Schema.Union([
          Changed,
          Schema.Struct({ kind: Schema.Literal("b"), x: Schema.String }),
        ]);
        const query = { kind: "a", x: "from-a-wider-value" } as const;
        const compiled = yield* Request.compile(
          Request.get("/x").pipe(Request.query(Either)),
          { query },
        );
        expect(compiled.request.url).toBe("/x?kind=a");
      }),
  );

  it.effect(
    "does not guess through an encoded literal member inside a tag union",
    () =>
      Effect.gen(function* () {
        const Converted = Schema.Literal("wire").pipe(
          Schema.decodeTo(
            Schema.Literal("decoded"),
            SchemaTransformation.transform({
              decode: () => "decoded" as const,
              encode: () => "wire" as const,
            }),
          ),
        );
        const Either = Schema.Union([
          Schema.Struct({ kind: Schema.Literal("wire") }).pipe(
            Schema.encodeKeys({ kind: "k" }),
          ),
          Schema.Struct({
            kind: Schema.Union([Converted, Schema.Literal("other")]),
            x: Schema.String,
          }).pipe(Schema.encodeKeys({ kind: "k" })),
        ]);
        const compiled = yield* Request.compile(
          Request.get("/x").pipe(Request.query(Either)),
          { query: { kind: "wire", x: "kept" } },
        );
        expect(compiled.request.url).toBe("/x?k=wire&x=kept");
      }),
  );
});
