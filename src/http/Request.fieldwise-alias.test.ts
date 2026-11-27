import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import type { HttpBody } from "effect/http";
import { empty, synthetic } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Inputs from "./internal/input.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import type * as Transport from "./Transport.js";

type Checked = Request.Request<
  never,
  Schema.SchemaError | Request.InvalidRequest
>;
const compile = (request: Checked, input: unknown) =>
  Request.compile(request, input as never);
const Fields = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
  count: Schema.FiniteFromString,
  offset: Schema.FiniteFromString,
});
const Filters = Fields.pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });

// https://github.com/viell-dev/slop-effect-schema-http/issues/170
describe("encoded aliases lost by root fieldwise preparation", () => {
  for (const group of ["query", "headers"] as const) {
    const bind =
      <
        S extends Schema.Top &
          Schema.ConstraintCodec<unknown, Transport.HeaderInput, never, never>,
      >(
        schema: S,
      ) =>
      (request: Checked): Checked =>
        group === "query"
          ? request.pipe(Request.query(schema))
          : request.pipe(Request.headers(schema));
    const output = (result: Request.Compiled) =>
      group === "query" ? result.request.url : result.headerLines;
    const expected = (limit: string) =>
      group === "query"
        ? `/x?page_size=${limit}&count=7&offset=9`
        : [
            ["page_size", limit],
            ["count", "7"],
            ["offset", "9"],
          ];

    for (const [name, schema] of [
      ["direct", Filters],
      ["singleton", Schema.Union([Filters])],
      ["union", Schema.Union([Filters, Cursor])],
      ["reversed", Schema.Union([Cursor, Filters])],
    ] as const) {
      it.effect(
        `refuses ignored ${group} aliases after ${name} fieldwise preparation`,
        () =>
          Effect.gen(function* () {
            const request = Request.get("/x").pipe(bind(schema));
            // A valid alias still needs a valid whole encoded group.
            for (const page_size of ["many", "05"])
              for (const offset of [9, "09"] as const) {
                if (page_size !== "many" && typeof offset === "string")
                  continue;
                const value: Request.Input<typeof Filters> = {
                  page_size,
                  count: "07",
                  offset,
                };
                for (const input of [
                  value,
                  Object.assign(Object.create(null), value),
                ]) {
                  const error = yield* Effect.flip(
                    compile(request, { [group]: input }),
                  );
                  expect(error).toBeInstanceOf(Schema.SchemaError);
                  expect(error.message).toContain('["page_size"]');
                  expect(error.message).not.toContain("many");
                }
              }
          }),
      );
    }

    it.effect(
      `keeps whole sides, decoded-name mixes and omitted ${group} defaults`,
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(bind(Filters));
          for (const value of [
            { page_size: "05", count: "07", offset: "09" },
            { limit: 5, count: 7, offset: 9 },
            { limit: 5, count: "07", offset: 9 },
          ])
            expect(output(yield* compile(request, { [group]: value }))).toEqual(
              expected("5"),
            );
          expect(
            (yield* Effect.flip(
              compile(request, {
                [group]: {
                  limit: 5,
                  page_size: "many",
                  count: "07",
                  offset: 9,
                },
              }),
            )).message,
          ).toContain('["page_size"]');
          for (const value of [
            { count: "07", offset: 9 },
            { page_size: undefined, count: "07", offset: 9 },
          ])
            expect(output(yield* compile(request, { [group]: value }))).toEqual(
              expected("25"),
            );
        }),
    );

    it.effect(
      `keeps actual ${group} sibling consumption in either binding order`,
      () =>
        Effect.gen(function* () {
          for (const bindings of [
            [bind(Filters), bind(Cursor)],
            [bind(Cursor), bind(Filters)],
          ]) {
            const request = bindings.reduce(
              (current, binding) => binding(current),
              Request.get("/x") as Checked,
            );
            for (const value of [
              { page_size: "05", count: "07", offset: "09", cursor: "next" },
              { limit: 5, count: "07", offset: 9, cursor: "next" },
            ]) {
              const result = output(
                yield* compile(request, { [group]: value }),
              );
              if (group === "query") {
                expect(result).toContain("page_size=5");
                expect(result).toContain("cursor=next");
              } else
                expect(result).toEqual(
                  expect.arrayContaining([
                    ["page_size", "5"],
                    ["cursor", "next"],
                  ]),
                );
            }
            expect(
              yield* Effect.flip(
                compile(request, {
                  [group]: {
                    page_size: "many",
                    count: "07",
                    offset: 9,
                    cursor: "next",
                  },
                }),
              ),
            ).toBeInstanceOf(Schema.SchemaError);
          }
        }),
    );

    it.effect(
      `preserves earlier raw ${group} defaults and later optional edits`,
      () =>
        Effect.gen(function* () {
          const set = group === "query" ? Request.setQuery : Request.setHeader;
          const optional = Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString),
            count: Fields.fields.count,
            offset: Fields.fields.offset,
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          for (const value of [
            { count: 7, offset: 9 },
            { count: "07", offset: 9 },
          ]) {
            const earlier = Request.get("/x").pipe(
              set("page_size", "05"),
              bind(optional),
            );
            expect(output(yield* compile(earlier, { [group]: value }))).toEqual(
              expected("5"),
            );
            const invalid = Request.get("/x").pipe(
              set("page_size", "many"),
              bind(optional),
            );
            expect(
              yield* Effect.flip(compile(invalid, { [group]: value })),
            ).toBeInstanceOf(Request.InvalidRequest);
            for (const raw of ["05", "many"])
              for (const bindings of [
                [set("page_size", raw), bind(Filters)],
                [bind(Filters), set("page_size", raw)],
              ]) {
                const request = bindings.reduce(
                  (current, binding) => binding(current),
                  Request.get("/x") as Checked,
                );
                expect(
                  output(yield* compile(request, { [group]: value })),
                ).toEqual(expected("25"));
              }
          }
        }),
    );
  }

  it.effect(
    "preserves actual constructor failures, defects and interruption",
    () =>
      Effect.gen(function* () {
        const boom = new Error("default defect");
        for (const mode of ["typed", "defect", "interrupt"] as const) {
          let defaults = 0;
          const schema = Schema.Struct({
            ...Fields.fields,
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
          const result = yield* Effect.exit(
            Inputs.reader(
              schema,
              Schema.encodeEffect(schema),
            )({ page_size: "many", count: "07", offset: 9 }),
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
          expect(defaults).toBe(mode === "typed" ? 2 : 1);
        }
      }),
  );

  it.effect(
    "preserves strict writer fallback and terminal writer failures",
    () =>
      Effect.gen(function* () {
        const failure = new Schema.SchemaError(
          new SchemaIssue.InvalidValue({ message: "writer failed" }),
        );
        const boom = new Error("writer defect");
        for (const mode of [
          "fallback",
          "typed",
          "defect",
          "interrupt",
        ] as const) {
          const trace: string[] = [];
          const read = Inputs.reader(Filters, (value, options) => {
            trace.push(options ? "strict" : "ordinary");
            if (mode === "defect") return Effect.die(boom);
            if (mode === "interrupt") return Effect.interrupt;
            return mode === "typed" || options
              ? Effect.fail(failure)
              : Schema.encodeEffect(Filters)(value);
          });
          const result = yield* Effect.exit(
            read({ page_size: "many", count: "07", offset: 9 }),
          );
          if (mode === "fallback")
            expect(result).toMatchObject({
              _tag: "Success",
              value: { output: { page_size: "25" }, lost: [["page_size"]] },
            });
          else if (Exit.isFailure(result)) {
            if (mode === "typed")
              expect(Cause.squash(result.cause)).toBe(failure);
            else if (mode === "defect")
              expect(Cause.squash(result.cause)).toBe(boom);
            else expect(Cause.hasInterrupts(result.cause)).toBe(true);
          } else expect.fail("The writer must fail");
          expect(trace).toEqual(
            mode === "typed" || mode === "fallback"
              ? ["strict", "ordinary"]
              : ["strict"],
          );
        }
      }),
  );

  for (const winner of ["constructor", "decoder"] as const) {
    it.effect(
      `keeps a later member ${winner} success after an earlier fieldwise attempt fails`,
      () =>
        Effect.gen(function* () {
          let ready = false;
          const first = Filters.check(
            Schema.makeFilter(() => {
              ready = true;
              return false;
            }),
          );
          const numberFromAnyText = Schema.String.pipe(
            Schema.decodeTo(
              Schema.Number,
              SchemaTransformation.transform({
                decode: () => 25,
                encode: String,
              }),
            ),
          );
          const textFromNumber = Schema.Number.pipe(
            Schema.decodeTo(
              Schema.String,
              SchemaTransformation.transform({
                decode: String,
                encode: Number,
              }),
            ),
          );
          const later = Schema.Struct({
            limit: Schema.optionalKey(
              winner === "constructor"
                ? Schema.FiniteFromString
                : numberFromAnyText,
            ).pipe(
              Schema.withConstructorDefault(
                Effect.suspend(() => Effect.succeed(25)),
              ),
            ),
            count:
              winner === "constructor"
                ? Schema.String
                : Schema.FiniteFromString,
            offset: winner === "constructor" ? Schema.Number : textFromNumber,
          })
            .pipe(Schema.encodeKeys({ limit: "page_size" }))
            .check(Schema.makeFilter(() => ready));
          const schema = Schema.Union([first, later]);
          const value = yield* Inputs.toDecoded(schema)({
            page_size: "many",
            count: "07",
            offset: 9,
          });
          expect(value.limit).toBe(25);
          ready = false;
          const result = yield* Inputs.reader(
            schema,
            Schema.encodeEffect(schema),
          )({ page_size: "many", count: "07", offset: 9 });
          expect(result.output.page_size).toBe("25");
          expect(result.lost).toEqual(
            winner === "constructor" ? [["page_size"]] : [],
          );
        }),
    );
  }

  it.effect(
    "keeps whole decoder and fieldwise shared-string meanings separate",
    () =>
      Effect.gen(function* () {
        const schema = Schema.Struct({
          ...Fields.fields,
          shared: Schema.StringFromBase64,
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const request = Request.get("/x").pipe(Request.query(schema));
        expect(
          (yield* Request.compile(request, {
            query: {
              page_size: "05",
              count: "07",
              offset: "09",
              shared: "eA==",
            },
          })).request.url,
        ).toBe("/x?page_size=5&count=7&offset=9&shared=eA%3D%3D");
        expect(
          (yield* Request.compile(request, {
            query: { limit: 5, count: "07", offset: 9, shared: "eA==" },
          })).request.url,
        ).toBe("/x?page_size=5&count=7&offset=9&shared=ZUE9PQ%3D%3D");
      }),
  );

  it.effect(
    "keeps phase flags per repeated and concurrent evaluation with services",
    () =>
      Effect.gen(function* () {
        class Tenant extends Context.Service<Tenant, string>()(
          "fieldwise/Tenant",
        ) {}
        const traces: string[] = [];
        const count = Schema.String.pipe(
          Schema.decodeTo(
            Schema.Number,
            SchemaTransformation.transformEffect({
              decode: (value) =>
                Effect.gen(function* () {
                  const tenant = yield* Tenant;
                  traces.push(tenant);
                  yield* Effect.promise(() => Promise.resolve());
                  return tenant === "bad"
                    ? yield* Effect.fail(
                        new SchemaIssue.InvalidValue({
                          message: "count unavailable",
                        }),
                      )
                    : Number(value);
                }),
              encode: (value) => Effect.succeed(String(value)),
            }),
          ),
        );
        const schema = Schema.Struct({ ...Fields.fields, count }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const pending = Inputs.reader(
          schema,
          Schema.encodeEffect(schema),
        )({ page_size: "many", count: "07", offset: 9 });
        const results = yield* Effect.all(
          ["one", "bad", "two"].map((tenant) =>
            Effect.result(pending).pipe(Effect.provideService(Tenant, tenant)),
          ),
          { concurrency: "unbounded" },
        );
        for (const [index, result] of results.entries())
          if (index === 1) {
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure.message).toContain('["count"]');
          } else
            expect(result).toMatchObject({
              _tag: "Success",
              success: { lost: [["page_size"]] },
            });
        expect(traces.filter((tenant) => tenant === "one")).toHaveLength(
          traces.filter((tenant) => tenant === "two").length,
        );
        expect(
          (yield* pending.pipe(Effect.provideService(Tenant, "one"))).lost,
        ).toEqual([["page_size"]]);
      }),
  );

  it.effect(
    "keeps ineligible output descriptors and iterables on their original path",
    () =>
      Effect.gen(function* () {
        let iterations = 0;
        for (const output of [
          Object.defineProperty({ count: "7", offset: "9" }, "page_size", {
            value: "25",
          }),
          Object.defineProperty({ count: "7", offset: "9" }, "page_size", {
            enumerable: true,
            get: () => "25",
          }),
          { page_size: undefined, count: "7", offset: "9" },
          {
            page_size: "25",
            count: "7",
            offset: "9",
            [Symbol.iterator]: function* () {
              iterations++;
              yield* [];
            },
          },
        ]) {
          let writes = 0;
          const result = yield* Inputs.reader(Filters, () => {
            writes++;
            // Inject representations a codec's declared output type cannot describe.
            return Effect.succeed(output as typeof Filters.Encoded);
          })({ page_size: "many", count: "07", offset: 9 });
          expect(result.output).toBe(output);
          expect(writes).toBe(1);
        }
        expect(iterations).toBe(0);
      }),
  );

  it.effect(
    "refuses fieldwise aliases under exact symbol and numeric root names",
    () =>
      Effect.gen(function* () {
        for (const name of [1, Symbol("wire limit")] as const) {
          const schema = Fields.pipe(Schema.encodeKeys({ limit: name }));
          const { lost } = yield* Inputs.reader(
            schema,
            Schema.encodeEffect(schema),
          )({ [name]: "many", count: "07", offset: 9 });
          expect(lost).toEqual([
            [typeof name === "number" ? String(name) : name],
          ]);
        }
      }),
  );

  it.effect("interrupts pending fieldwise work and runs its cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let calls = 0;
      const count = Schema.String.pipe(
        Schema.decodeTo(
          Schema.Number,
          SchemaTransformation.transformEffect({
            decode: (value) =>
              Effect.suspend(() =>
                ++calls === 2
                  ? Effect.ensuring(
                      Effect.andThen(
                        Deferred.succeed(started, undefined),
                        Effect.never,
                      ),
                      Deferred.succeed(released, undefined),
                    )
                  : Effect.succeed(Number(value)),
              ),
            encode: (value) => Effect.succeed(String(value)),
          }),
        ),
      );
      const schema = Schema.Struct({ ...Fields.fields, count }).pipe(
        Schema.encodeKeys({ limit: "page_size" }),
      );
      const fiber = yield* Inputs.reader(
        schema,
        Schema.encodeEffect(schema),
      )({ page_size: "many", count: "07", offset: 9 }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(released);
      const result = yield* Fiber.await(fiber);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.hasInterrupts(result.cause)).toBe(true);
      expect(calls).toBe(2);
    }),
  );

  for (const kind of ["path", "body"] as const) {
    for (const [name, schema] of [
      ["direct", Filters],
      ["union", Schema.Union([Filters, Cursor])],
    ] as const) {
      it.effect(
        `refuses a ${name} fieldwise ${kind} before rendering or dispatch`,
        () =>
          Effect.gen(function* () {
            let renders = 0;
            const request: Request.Request<
              never,
              | Schema.SchemaError
              | Request.InvalidRequest
              | HttpBody.HttpBodyError
            > =
              kind === "path"
                ? Request.get("https://api.test").pipe(
                    Request.path(schema, (value) => {
                      renders++;
                      return "page_size" in value
                        ? `/${value.page_size}/${value.count}/${value.offset}`
                        : "/cursor";
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
            for (const page_size of ["many", "05"]) {
              const error = yield* Effect.flip(
                operation
                  .execute({
                    [kind]: { page_size, count: "07", offset: 9 },
                  } as never)
                  .pipe(Effect.provide(provider.layer)),
              );
              expect(error).toBeInstanceOf(Schema.SchemaError);
              expect(error.message).toContain('["page_size"]');
            }
            expect(provider.exchanges).toHaveLength(0);
            expect(renders).toBe(0);
            yield* operation
              .execute({
                [kind]: { page_size: "05", count: "07", offset: "09" },
              } as never)
              .pipe(Effect.provide(provider.layer));
            expect(provider.exchanges).toHaveLength(1);
            if (kind === "path") {
              expect(provider.exchanges[0]!.url).toBe("https://api.test/5/7/9");
              expect(renders).toBe(1);
            } else {
              const body = provider.exchanges[0]!.request.body;
              expect(body._tag).toBe("Uint8Array");
              if (body._tag === "Uint8Array")
                expect(new TextDecoder().decode(body.body)).toBe(
                  '{"page_size":"5","count":"7","offset":"9"}',
                );
            }
          }),
      );
    }
  }
});

/** A renamed field with a default of either kind, beside a decoded field and a checked one. */
const traced = (defaults: "constructor" | "decoding") => {
  const trace: Array<string> = [];
  const finite = (name: string) =>
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
      Schema.decodeTo(Schema.FiniteFromString),
    );
  const schema = Schema.Struct({
    limit:
      defaults === "constructor"
        ? Schema.optionalKey(finite("limit")).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                trace.push("limit.default");
                return 25;
              }),
            ),
          )
        : finite("limit").pipe(
            Schema.withDecodingDefaultKey(
              Effect.sync(() => {
                trace.push("limit.decodingDefault");
                return "30";
              }),
            ),
          ),
    gate: finite("gate"),
    c: Schema.String.check(
      Schema.makeFilter((value) => {
        trace.push(`c.check:${value}`);
        return true;
      }),
    ),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  return { schema, trace };
};

// Recording a read's failure to explain a refusal must not run the schema's steps. These traces
// are those from before #275's messages, whose recorded loose read ran even where no route read.
// https://github.com/viell-dev/slop-effect-schema-http/issues/317
describe("callback traces of a refused root fieldwise group", () => {
  const invalidDecoded = {
    input: { limit: "x", gate: 3, c: "z" },
    message: 'Expected number\n  at ["limit"]',
    trace: ["limit.read:x", "c.check:z", "limit.read:x"],
  };
  const cases = {
    constructor: [
      {
        input: { page_size: "many", gate: "03", c: "z" },
        message:
          'The schema cannot keep this field with the rest of the value\n  at ["page_size"]',
        trace: [
          "c.check:z",
          "limit.read:many",
          "gate.read:03",
          "c.check:z",
          "limit.default",
          "c.check:z",
          "limit.read:many",
          "gate.read:03",
          "c.check:z",
          "gate.read:03",
          "gate.read:03",
          "c.check:z",
          "limit.default",
          "c.check:z",
          "limit.write:25",
          "gate.write:3",
          "c.check:z",
          "c.check:z",
        ],
      },
      invalidDecoded,
    ],
    decoding: [
      {
        input: { page_size: "many", gate: "03", c: "z" },
        message: 'Missing key\n  at ["limit"]',
        trace: [
          "c.check:z",
          "limit.read:many",
          "gate.read:03",
          "c.check:z",
          "c.check:z",
          "limit.read:many",
          "gate.read:03",
          "c.check:z",
          "gate.read:03",
          "gate.read:03",
          "c.check:z",
        ],
      },
      invalidDecoded,
    ],
  } as const;
  for (const group of ["query", "headers"] as const)
    for (const defaults of ["constructor", "decoding"] as const)
      it.effect(
        `keeps the callback traces of refused ${group} fields beside a ${defaults} default`,
        () =>
          Effect.gen(function* () {
            for (const { input, message, trace: expected } of cases[defaults]) {
              const { schema, trace } = traced(defaults);
              const request: Checked =
                group === "query"
                  ? Request.get("/x").pipe(Request.query(schema))
                  : Request.get("/x").pipe(Request.headers(schema));
              const error = yield* Effect.flip(
                compile(request, { [group]: input }),
              );
              expect(error).toBeInstanceOf(Schema.SchemaError);
              expect(error.message).toBe(message);
              expect(trace).toEqual(expected);
            }
          }),
      );
});
