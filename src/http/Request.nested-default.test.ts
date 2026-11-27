import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect";
import type { HttpBody } from "effect/http";
import { empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const Inner = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Direct = Schema.Struct({ filter: Inner });
const Deeper = Schema.Struct({ wrapper: Direct });
const ChildUnion = Schema.Struct({
  filter: Schema.Union([Inner, Schema.Struct({ cursor: Schema.String })]),
});
const Optional = Schema.Struct({ filter: Schema.optionalKey(Inner) });

const prepare = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  kind: "path" | "body",
) => {
  if (kind === "path") {
    let output: unknown;
    const request = Request.get("/x").pipe(
      Request.path(schema, (value) => {
        output = value;
        return "/rendered";
      }),
    );
    return Request.compile(request, { path: input as Request.Input<S> }).pipe(
      Effect.map(() => output),
    );
  }
  return Request.compile(
    Request.post("/x").pipe(Request.body(Body.jsonSchema(schema))),
    { body: input as Request.Input<S> },
  ).pipe(
    Effect.map(({ request }) => {
      if (request.body._tag !== "Uint8Array")
        throw new Error("Expected JSON bytes");
      return JSON.parse(new TextDecoder().decode(request.body.body)) as unknown;
    }),
  );
};

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("nested aliases replaced during whole construction", () => {
  const shapes = [
    { name: "direct", schema: Direct, wrap: (filter: object) => ({ filter }) },
    {
      name: "deeper",
      schema: Deeper,
      wrap: (filter: object) => ({ wrapper: { filter } }),
    },
    {
      name: "terminal union",
      schema: ChildUnion,
      wrap: (filter: object) => ({ filter }),
    },
    {
      name: "optional field",
      schema: Optional,
      wrap: (filter: object) => ({ filter }),
    },
  ] as const;
  for (const kind of ["path", "body"] as const) {
    for (const { name, schema, wrap } of shapes) {
      it.effect(`refuses a ${name} invalid nested ${kind} alias`, () =>
        Effect.gen(function* () {
          for (const page_size of ["many", null]) {
            const error = yield* Effect.flip(
              prepare(schema, wrap({ page_size }), kind),
            );
            expect(error).toBeInstanceOf(Schema.SchemaError);
            expect(error.message).toContain('["filter"]["page_size"]');
            expect(error.message).not.toContain("many");
          }
        }),
      );
    }
    it.effect(
      `keeps valid nested ${kind} sides and omission, and refuses conflicting names`,
      () =>
        Effect.gen(function* () {
          for (const { schema, wrap } of shapes) {
            for (const filter of [{ page_size: "05" }, { limit: 5 }])
              expect(yield* prepare(schema, wrap(filter), kind)).toEqual(
                wrap({ page_size: "5" }),
              );
            expect(
              yield* Effect.flip(
                prepare(schema, wrap({ limit: 5, page_size: "many" }), kind),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
            for (const filter of [{}, { page_size: undefined }])
              expect(yield* prepare(schema, wrap(filter), kind)).toEqual(
                wrap({ page_size: "25" }),
              );
          }
          expect(yield* prepare(Optional, {}, kind)).toEqual({});
          expect(yield* prepare(Optional, { filter: undefined }, kind)).toEqual(
            {},
          );
        }),
    );
  }

  it.effect(
    "keeps a root fieldwise route that actually decodes the nested alias",
    () =>
      Effect.gen(function* () {
        let defaults = 0;
        const filter = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                defaults++;
                return 25;
              }),
            ),
          ),
          gate: Schema.FiniteFromString,
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Struct({
          filter,
          n: Schema.FiniteFromString,
          m: Schema.FiniteFromString,
          shared: Schema.StringFromBase64,
          opaque: Schema.Option(Schema.Struct({ keep: Schema.String })),
        });
        const input = {
          filter: { page_size: "05", gate: "03" },
          n: "07",
          m: 9,
          shared: "eA==",
          opaque: Option.some({ keep: "x", extra: "opaque" }),
        };
        const strict = yield* Effect.result(
          Inputs.toDecoded(schema, { onExcessProperty: "error" })(input),
        );
        expect(strict._tag).toBe("Failure");
        defaults = 0;
        expect(
          yield* Inputs.reader(schema, Schema.encodeEffect(schema))(input),
        ).toEqual({
          output: {
            filter: { page_size: "5", gate: "3" },
            n: "7",
            m: "9",
            shared: "ZUE9PQ==",
            opaque: Option.some({ keep: "x" }),
          },
          lost: [],
        });
        expect(defaults).toBe(2);
      }),
  );

  it.effect(
    "preserves constructor failures, defects, interruption and strict writer fallback",
    () =>
      Effect.gen(function* () {
        const boom = new Error("default defect");
        for (const mode of ["typed", "defect", "interrupt"] as const) {
          let defaults = 0;
          const filter = Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(
                Effect.suspend(() => {
                  defaults++;
                  return mode === "typed"
                    ? Effect.fail(
                        new SchemaIssue.InvalidValue({
                          message: "default failed",
                        }),
                      )
                    : mode === "defect"
                      ? Effect.die(boom)
                      : Effect.interrupt;
                }),
              ),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const schema = Schema.Struct({ filter });
          const result = yield* Effect.exit(
            Inputs.reader(
              schema,
              Schema.encodeEffect(schema),
            )({ filter: { page_size: "many" } }),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            if (mode === "typed")
              expect(String(Cause.squash(result.cause))).toContain(
                "default failed",
              );
            else if (mode === "defect")
              expect(Cause.squash(result.cause)).toBe(boom);
            else expect(Cause.hasInterrupts(result.cause)).toBe(true);
          }
          expect(defaults).toBe(mode === "typed" ? 3 : 1);
        }
        const failure = new Schema.SchemaError(
          new SchemaIssue.InvalidValue({ message: "strict writer failed" }),
        );
        const writes: string[] = [];
        const read = Inputs.reader(Direct, (value, options) => {
          writes.push(options ? "strict" : "ordinary");
          return options
            ? Effect.fail(failure)
            : Schema.encodeEffect(Direct)(value);
        });
        expect((yield* read({ filter: { page_size: "many" } })).output).toEqual(
          { filter: { page_size: "25" } },
        );
        expect(writes).toEqual(["strict", "ordinary"]);
      }),
  );

  it.effect("keeps valid strict successes and their callback traces", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const schema = Direct.check(
        Schema.makeFilter(() => {
          trace.push("parent");
          return true;
        }),
      );
      const read = Inputs.reader(schema, Schema.encodeEffect(schema));
      for (const input of [
        { filter: { page_size: "05" } },
        { filter: { limit: 5 } },
      ]) {
        trace.length = 0;
        expect((yield* read(input)).output).toEqual({
          filter: { page_size: "5" },
        });
        expect(trace).toEqual(["parent", "parent"]);
      }
    }),
  );

  it.effect(
    "declines stale ancestor and terminal evidence while an Effect is pending",
    () =>
      Effect.gen(function* () {
        for (const change of [
          (input: { filter: { page_size: string } }) => {
            input.filter = { page_size: "many" };
          },
          (input: { filter: { page_size: string } }) => {
            Object.defineProperty(input, "filter", { writable: false });
          },
          (input: { filter: { page_size: string } }) => {
            Object.setPrototypeOf(input, null);
          },
          (input: { filter: { page_size: string } }) => {
            input.filter.page_size = "still invalid";
          },
          (input: { filter: { page_size: string } }) => {
            Object.defineProperty(input.filter, "page_size", {
              writable: false,
            });
          },
          (input: { filter: { page_size: string } }) => {
            Object.setPrototypeOf(input.filter, null);
          },
        ]) {
          const input = { filter: { page_size: "many" } };
          const pending = Inputs.reader(
            Direct,
            Schema.encodeEffect(Direct),
          )(input);
          change(input);
          expect((yield* pending).output).toEqual({
            filter: { page_size: "25" },
          });
        }
      }),
  );

  it.effect(
    "declines mutations made during original construction or writing",
    () =>
      Effect.gen(function* () {
        for (const stage of ["constructor", "writer"] as const) {
          const input = { filter: { page_size: "many" } };
          const filter = Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  if (stage === "constructor")
                    input.filter.page_size = "changed";
                  return 25;
                }),
              ),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const schema = Schema.Struct({ filter });
          let writes = 0;
          const read = Inputs.reader(schema, (value, options) =>
            Effect.map(
              Schema.encodeEffect(schema)(value, options),
              (output) => {
                writes++;
                if (stage === "writer") input.filter = { page_size: "many" };
                return output;
              },
            ),
          );
          expect((yield* read(input)).output).toEqual({
            filter: { page_size: "25" },
          });
          expect(writes).toBe(1);
        }
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect(
    "refuses invalid nested input through an unambiguous parent union",
    () =>
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            prepare(
              Schema.Union([Direct, Schema.Struct({ cursor: Schema.String })]),
              { filter: { page_size: "many" } },
              "body",
            ),
          ),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/170
  it.effect("refuses invalid nested input through a dense array ancestor", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          prepare(
            Schema.Struct({ filters: Schema.Array(Inner) }),
            { filters: [{ page_size: "many" }] },
            "body",
          ),
        ),
      ).toBeInstanceOf(Schema.SchemaError);
    }),
  );

  it.effect(
    "refuses cyclic unknown extras without recursively copying them",
    () =>
      Effect.gen(function* () {
        const filter: Record<string, unknown> = { page_size: "many" };
        filter.self = filter;
        expect(
          yield* Effect.flip(prepare(Direct, { filter }, "body")),
        ).toBeInstanceOf(Schema.SchemaError);
      }),
  );

  for (const kind of ["path", "body"] as const) {
    it.effect(`refuses nested ${kind} input before rendering or dispatch`, () =>
      Effect.gen(function* () {
        for (const { schema, wrap } of shapes) {
          let rendered: unknown;
          let renders = 0;
          const request: Request.Request<
            never,
            Schema.SchemaError | Request.InvalidRequest | HttpBody.HttpBodyError
          > =
            kind === "path"
              ? Request.get("https://api.test").pipe(
                  Request.path(schema, (value) => {
                    renders++;
                    rendered = value;
                    return "/ok";
                  }),
                )
              : Request.post("https://api.test/x").pipe(
                  Request.body(Body.jsonSchema(schema)),
                );
          const operation = Operation.make(
            request,
            Response.status(204, Body.empty),
          );
          const provider = synthetic(() => empty(204));
          expect(
            yield* Effect.flip(
              operation
                .execute({ [kind]: wrap({ page_size: "many" }) } as never)
                .pipe(Effect.provide(provider.layer)),
            ),
          ).toBeInstanceOf(Schema.SchemaError);
          expect(provider.exchanges).toHaveLength(0);
          expect(renders).toBe(0);
          yield* operation
            .execute({ [kind]: wrap({ page_size: "05" }) } as never)
            .pipe(Effect.provide(provider.layer));
          expect(provider.exchanges).toHaveLength(1);
          if (kind === "path")
            expect(rendered).toEqual(wrap({ page_size: "5" }));
          else {
            const body = provider.exchanges[0]!.request.body;
            expect(body._tag).toBe("Uint8Array");
            if (body._tag === "Uint8Array")
              expect(JSON.parse(new TextDecoder().decode(body.body))).toEqual(
                wrap({ page_size: "5" }),
              );
          }
        }
      }),
    );
  }
});

/** Text that records each value it reads and writes under `name`. */
const observedText = (trace: Array<string>, name: string) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((text) => {
        trace.push(`${name}.read:${text}`);
        return text;
      }),
      encode: SchemaGetter.transform((text) => {
        trace.push(`${name}.write:${text}`);
        return text;
      }),
    }),
  );
/** A renamed field with a constructor default, beside fields on both sides and an opaque one. */
const fieldwise = () => {
  const trace: Array<string> = [];
  const finite = (name: string) =>
    observedText(trace, name).pipe(Schema.decodeTo(Schema.FiniteFromString));
  const filter = Schema.Struct({
    limit: Schema.optionalKey(finite("limit")).pipe(
      Schema.withConstructorDefault(
        Effect.sync(() => {
          trace.push("limit.default");
          return 25;
        }),
      ),
    ),
    gate: finite("gate"),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const schema = Schema.Struct({
    filter,
    n: finite("n"),
    m: finite("m"),
    shared: observedText(trace, "shared").pipe(
      Schema.decodeTo(Schema.StringFromBase64),
    ),
    neighbor: Schema.Option(Schema.Struct({ keep: Schema.String })),
  });
  const input = {
    filter: { page_size: "05", gate: "03" },
    n: "07",
    m: 9,
    shared: "aGk=",
    neighbor: Option.some({ keep: "ok", stray: "schema-owned" }),
  };
  return { schema, input, trace };
};
/**
 * Two renamed fields given invalid wire values: the left's writer replaces the input, and the
 * right's decoder cannot invert what its writer omits, so the right one is refused.
 */
const refusedPair = () => {
  const trace: Array<string> = [];
  const input = {
    left: { page_size: "many" },
    right: { page_size: "many" },
  };
  const leftNumber = observedText(trace, "left").pipe(
    Schema.decodeTo(Schema.FiniteFromString),
    Schema.decodeTo(Schema.Number, {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.transform((value) => {
        trace.push("left.replace");
        input.left = { page_size: "many" };
        return value;
      }),
    }),
  );
  const rightNumber = Schema.optionalKey(
    observedText(trace, "right").pipe(Schema.decodeTo(Schema.FiniteFromString)),
  ).pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.Number), {
      decode: SchemaGetter.transformOptionalEffect(() =>
        Effect.fail(
          new SchemaIssue.InvalidValue({
            message: "The omitted right field has no inverse",
          }),
        ),
      ),
      encode: SchemaGetter.transformOptional((value) => {
        trace.push(`right.omit:${Option.getOrElse(value, () => -1)}`);
        return Option.none();
      }),
    }),
    Schema.withConstructorDefault(
      Effect.sync(() => {
        trace.push("right.default");
        return 25;
      }),
    ),
  );
  const left = Schema.Struct({
    limit: Schema.optionalKey(leftNumber).pipe(
      Schema.withConstructorDefault(
        Effect.sync(() => {
          trace.push("left.default");
          return 25;
        }),
      ),
    ),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const right = Schema.Struct({ limit: rightNumber }).pipe(
    Schema.encodeKeys({ limit: "page_size" }),
  );
  return { schema: Schema.Struct({ left, right }), input, trace };
};

// Recording a read's failure to explain a refusal must not run the schema's steps. These traces
// are those from before #275's messages, whose recorded loose read ran even where no route read.
// https://github.com/viell-dev/slop-effect-schema-http/issues/317
describe("callback traces of fieldwise nested reads", () => {
  for (const kind of ["path", "body"] as const) {
    it.effect(`keeps the callback trace of a fieldwise ${kind} read`, () =>
      Effect.gen(function* () {
        const { schema, input, trace } = fieldwise();
        expect(yield* prepare(schema, input, kind)).toEqual({
          filter: { page_size: "5", gate: "3" },
          n: "7",
          m: "9",
          shared: "YUdrPQ==",
          neighbor:
            kind === "path"
              ? Option.some({ keep: "ok" })
              : { _tag: "Some", value: { keep: "ok" } },
        });
        expect(trace).toEqual([
          "limit.read:05",
          "gate.read:03",
          "n.read:07",
          "limit.read:05",
          "gate.read:03",
          "n.read:07",
          "limit.default",
          "limit.read:05",
          "gate.read:03",
          "n.read:07",
          "shared.read:aGk=",
          "limit.default",
          "limit.read:05",
          "gate.read:03",
          "limit.read:05",
          "gate.read:03",
          "n.read:07",
          "n.read:07",
          "limit.write:5",
          "gate.write:3",
          "n.write:7",
          "m.write:9",
          "shared.write:YUdrPQ==",
        ]);
      }),
    );

    it.effect(
      `keeps the callback trace where a fieldwise ${kind} read refuses`,
      () =>
        Effect.gen(function* () {
          const { schema, input, trace } = refusedPair();
          const error = yield* Effect.flip(prepare(schema, input, kind));
          expect(error).toBeInstanceOf(Schema.SchemaError);
          expect(error.message).toContain('["right"]["page_size"]');
          expect(trace).toEqual([
            "left.read:many",
            "left.read:many",
            "left.default",
            "right.default",
            "left.read:many",
            "right.read:many",
            "left.default",
            "left.read:many",
            "right.default",
            "right.read:many",
            "left.replace",
            "left.write:25",
            "right.omit:25",
          ]);
        }),
    );
  }
});
