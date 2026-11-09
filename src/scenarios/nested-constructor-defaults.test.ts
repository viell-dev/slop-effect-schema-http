/**
 * EXT-42: bounded nested constructor-default validation under #170.
 * Consumer-authored from the public acceptance and the README's neutral echo contract.
 * Parent-union/array routes and unstable evidence remain outside this constructor-only subset.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { bodyText, headerValues, type Recorded } from "../harness/lane.js";

const Inner = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const terminals = [
  ["direct", Inner],
  ["child-union", Schema.Union([Inner, Cursor])],
] as const;
const Nested = Schema.Struct({ filter: Inner });
const Deep = Schema.Struct({ outer: Schema.Struct({ page: Nested }) });
const profiles = [
  "ordinary",
  "null prototype",
  "frozen",
  "hidden ancestor",
  "hidden alias",
] as const;
type Profile = (typeof profiles)[number];
const profile = <T extends { filter: { page_size: unknown } }>(
  input: T,
  shape: Profile,
): T => {
  if (shape === "null prototype") {
    Object.setPrototypeOf(input, null);
    Object.setPrototypeOf(input.filter, null);
  } else if (shape === "frozen") {
    Object.freeze(input.filter);
    Object.freeze(input);
  } else if (shape === "hidden ancestor") {
    Object.defineProperty(input, "filter", { enumerable: false });
  } else if (shape === "hidden alias") {
    Object.defineProperty(input.filter, "page_size", { enumerable: false });
  }
  return input;
};
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ kind: "failure" as const, error }),
      onSuccess: (value) => ({ kind: "success" as const, value }),
    }),
  );
const view = (entry: Recorded) => ({
  method: entry.method,
  target: entry.target,
  body: bodyText(entry),
});
const expectEntry = (entry: Recorded, target: string, json?: string) => {
  expect(entry.method).toBe(json === undefined ? "GET" : "POST");
  expect(entry.target).toBe(target);
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "content-type")).toEqual(
    json === undefined ? [] : ["application/json"],
  );
  expect(entry.body).toEqual(new TextEncoder().encode(json ?? ""));
};
const pagePath = (
  filter: typeof Inner.Encoded | typeof Cursor.Encoded,
  encode: (text: string) => string,
) =>
  "cursor" in filter
    ? `/cursor/${encode(filter.cursor)}`
    : `/page/${encode(filter.page_size ?? "none")}/${encode(filter.term ?? "none")}`;

// Observe public codec calls without changing the finite/Base64 conversions they delegate to.
const observedText = (trace: string[], name: string) =>
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
const fieldwiseFixture = () => {
  const trace: string[] = [];
  const finite = (name: string) =>
    observedText(trace, name).pipe(Schema.decodeTo(Schema.FiniteFromString));
  const Filter = Schema.Struct({
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
    filter: Filter,
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
// Observed on the independently authored 0.11.0 fixture in both binding directions below.
const fieldwiseTrace = [
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
  "limit.default",
  "limit.read:05",
  "gate.read:03",
  "n.read:07",
  "limit.write:5",
  "gate.write:3",
  "n.write:7",
  "m.write:9",
  "shared.write:YUdrPQ==",
];

const inputChecks = () => {
  const encoded: Request.Input<typeof Deep> = {
    outer: { page: { filter: { page_size: "05" } } },
  };
  const decoded: Request.Input<typeof Deep> = {
    outer: { page: { filter: { limit: 5 } } },
  };
  const wrongName: Request.Input<typeof Nested> = {
    // @ts-expect-error Unknown nested aliases remain unavailable.
    filter: { page_count: "05" },
  };
  const wrongValue: Request.Input<typeof Nested> = {
    // @ts-expect-error An encoded finite-number field requires text.
    filter: { page_size: true },
  };
  const Tagged = Schema.Struct({
    filter: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("page"), page: Inner }),
      Schema.Struct({ kind: Schema.Literal("cursor"), cursor: Schema.String }),
    ]),
  });
  const wrongMember: Request.Input<typeof Tagged> = {
    // @ts-expect-error The page discriminant cannot supply the cursor member's fields.
    filter: { kind: "page", cursor: "next" },
  };
  return { encoded, decoded, wrongName, wrongValue, wrongMember };
};
void inputChecks;

describe(`nested constructor defaults (${lane.name})`, () => {
  for (const [shape, terminal] of terminals) {
    const Root = Schema.Struct({ filter: terminal });
    it.live(
      `[EXT-42a] ${shape} nested path aliases refuse invalid values in stable own-data inputs`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(Root, ({ filter }, encode) =>
                pagePath(filter, encode),
              ),
            ),
            response,
          );
          const results = [];
          for (const inputShape of profiles) {
            const text = yield* operation
              .execute({
                path: profile({ filter: { page_size: "many" } }, inputShape),
              })
              .pipe(Effect.provide(lane.fetchClient), outcome);
            const nil = yield* operation
              // Deliberate runtime-negative input: null fits neither side of the finite codec.
              .execute({
                // @ts-expect-error The encoded alias requires text.
                path: profile({ filter: { page_size: null } }, inputShape),
              })
              .pipe(Effect.provide(lane.fetchClient), outcome);
            results.push({ shape: inputShape, text, nil });
          }
          expect({
            results,
            wire: (yield* backend.ledger).map(view),
          }).toMatchObject({
            results: profiles.map((inputShape) => ({
              shape: inputShape,
              text: { kind: "failure", error: { _tag: "SchemaError" } },
              nil: { kind: "failure", error: { _tag: "SchemaError" } },
            })),
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-42b] ${shape} nested JSON aliases refuse invalid values in stable own-data inputs`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(Root)),
            ),
            response,
          );
          const results = [];
          for (const inputShape of profiles) {
            const text = yield* operation
              .execute({
                body: profile({ filter: { page_size: "many" } }, inputShape),
              })
              .pipe(Effect.provide(lane.fetchClient), outcome);
            const nil = yield* operation
              // Deliberate runtime-negative input, retained independently of string validation.
              .execute({
                // @ts-expect-error The encoded alias requires text.
                body: profile({ filter: { page_size: null } }, inputShape),
              })
              .pipe(Effect.provide(lane.fetchClient), outcome);
            results.push({ shape: inputShape, text, nil });
          }
          expect({
            results,
            wire: (yield* backend.ledger).map(view),
          }).toMatchObject({
            results: profiles.map((inputShape) => ({
              shape: inputShape,
              text: { kind: "failure", error: { _tag: "SchemaError" } },
              nil: { kind: "failure", error: { _tag: "SchemaError" } },
            })),
            wire: [],
          });
        }),
    );

    it.live(
      `[EXT-42c] control: ${shape} nested path input retains encoded, decoded and omitted values`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(Root, ({ filter }, encode) =>
                pagePath(filter, encode),
              ),
            ),
            response,
          );
          for (const filter of [
            { page_size: "05", term: "a/b" },
            { limit: 5, term: "a/b" },
            {},
            { limit: 5, page_size: "many" },
          ] as const) {
            expect(
              yield* operation
                .execute({ path: { filter } })
                .pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(4);
          expectEntry(ledger[0]!, "/x/page/5/a%2Fb");
          expectEntry(ledger[1]!, "/x/page/5/a%2Fb");
          expectEntry(ledger[2]!, "/x/page/25/none");
          expectEntry(ledger[3]!, "/x/page/5/none");
        }),
    );

    it.live(
      `[EXT-42d] control: ${shape} nested JSON input retains encoded, decoded and omitted values`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const operation = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(Root)),
            ),
            response,
          );
          for (const filter of [
            { page_size: "05", term: "a/b" },
            { limit: 5, term: "a/b" },
            {},
            { limit: 5, page_size: "many" },
          ] as const) {
            expect(
              yield* operation
                .execute({ body: { filter } })
                .pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
          }
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(4);
          expectEntry(
            ledger[0]!,
            "/x",
            '{"filter":{"term":"a/b","page_size":"5"}}',
          );
          expectEntry(
            ledger[1]!,
            "/x",
            '{"filter":{"term":"a/b","page_size":"5"}}',
          );
          expectEntry(ledger[2]!, "/x", '{"filter":{"page_size":"25"}}');
          expectEntry(ledger[3]!, "/x", '{"filter":{"page_size":"5"}}');
        }),
    );
  }

  it.live(
    "[EXT-42e] transparent object ancestors retain the nested path refusal",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(Deep, ({ outer }, encode) =>
              pagePath(outer.page.filter, encode),
            ),
          ),
          response,
        );
        const input = { outer: { page: { filter: { page_size: "many" } } } };
        Object.freeze(input.outer.page.filter);
        Object.freeze(input.outer.page);
        Object.freeze(input.outer);
        Object.freeze(input);
        const text = yield* operation
          .execute({ path: input })
          .pipe(Effect.provide(lane.fetchClient), outcome);
        const nil = yield* operation
          .execute({
            // @ts-expect-error Deliberately exercise runtime validation outside the encoded type.
            path: { outer: { page: { filter: { page_size: null } } } },
          })
          .pipe(Effect.provide(lane.fetchClient), outcome);
        expect({
          text,
          nil,
          wire: (yield* backend.ledger).map(view),
        }).toMatchObject({
          text: { kind: "failure", error: { _tag: "SchemaError" } },
          nil: { kind: "failure", error: { _tag: "SchemaError" } },
          wire: [],
        });
      }),
  );

  it.live(
    "[EXT-42f] transparent object ancestors retain the nested JSON refusal",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Deep)),
          ),
          response,
        );
        const text = yield* operation
          .execute({
            body: { outer: { page: { filter: { page_size: "many" } } } },
          })
          .pipe(Effect.provide(lane.fetchClient), outcome);
        const nil = yield* operation
          .execute({
            // @ts-expect-error Deliberately exercise runtime validation outside the encoded type.
            body: { outer: { page: { filter: { page_size: null } } } },
          })
          .pipe(Effect.provide(lane.fetchClient), outcome);
        expect({
          text,
          nil,
          wire: (yield* backend.ledger).map(view),
        }).toMatchObject({
          text: { kind: "failure", error: { _tag: "SchemaError" } },
          nil: { kind: "failure", error: { _tag: "SchemaError" } },
          wire: [],
        });
      }),
  );

  it.live(
    "[EXT-42g] control: transparent ancestors preserve complete encoded and decoded paths",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(Deep, ({ outer }, encode) =>
              pagePath(outer.page.filter, encode),
            ),
          ),
          response,
        );
        for (const filter of [{ page_size: "05" }, { limit: 5 }, {}] as const) {
          expect(
            yield* operation
              .execute({ path: { outer: { page: { filter } } } })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        }
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectEntry(ledger[0]!, "/x/page/5/none");
        expectEntry(ledger[1]!, "/x/page/5/none");
        expectEntry(ledger[2]!, "/x/page/25/none");
      }),
  );

  it.live(
    "[EXT-42h] control: transparent ancestors preserve complete encoded and decoded JSON",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Deep)),
          ),
          response,
        );
        for (const filter of [{ page_size: "05" }, { limit: 5 }, {}] as const) {
          expect(
            yield* operation
              .execute({ body: { outer: { page: { filter } } } })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        }
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectEntry(
          ledger[0]!,
          "/x",
          '{"outer":{"page":{"filter":{"page_size":"5"}}}}',
        );
        expectEntry(
          ledger[1]!,
          "/x",
          '{"outer":{"page":{"filter":{"page_size":"5"}}}}',
        );
        expectEntry(
          ledger[2]!,
          "/x",
          '{"outer":{"page":{"filter":{"page_size":"25"}}}}',
        );
      }),
  );

  it.live(
    "[EXT-42i] control: absent optional and defaulted outer path fields invent no caller witness",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const Optional = Schema.Struct({ filter: Schema.optionalKey(Inner) });
        const Defaulted = Schema.Struct({
          filter: Schema.optionalKey(Inner).pipe(
            Schema.withConstructorDefault(Effect.succeed({ limit: 11 })),
          ),
        });
        const optional = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(Optional, ({ filter }, encode) =>
              filter === undefined ? "/absent" : pagePath(filter, encode),
            ),
          ),
          response,
        );
        const defaulted = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(Defaulted, ({ filter }, encode) =>
              filter === undefined ? "/absent" : pagePath(filter, encode),
            ),
          ),
          response,
        );
        expect(
          yield* optional
            .execute({ path: {} })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* optional
            .execute({ path: { filter: {} } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* defaulted
            .execute({ path: {} })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* defaulted
            .execute({ path: { filter: {} } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(4);
        for (const [i, target] of [
          "/x/absent",
          "/x/page/25/none",
          "/x/page/11/none",
          "/x/page/25/none",
        ].entries()) {
          expectEntry(ledger[i]!, target);
        }
      }),
  );

  it.live(
    "[EXT-42j] control: absent optional and defaulted outer JSON fields invent no caller witness",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const Optional = Schema.Struct({ filter: Schema.optionalKey(Inner) });
        const Defaulted = Schema.Struct({
          filter: Schema.optionalKey(Inner).pipe(
            Schema.withConstructorDefault(Effect.succeed({ limit: 11 })),
          ),
        });
        const optional = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Optional)),
          ),
          response,
        );
        const defaulted = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Defaulted)),
          ),
          response,
        );
        expect(
          yield* optional
            .execute({ body: {} })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* optional
            .execute({ body: { filter: {} } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* defaulted
            .execute({ body: {} })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* defaulted
            .execute({ body: { filter: {} } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(4);
        for (const [i, json] of [
          "{}",
          '{"filter":{"page_size":"25"}}',
          '{"filter":{"page_size":"11"}}',
          '{"filter":{"page_size":"25"}}',
        ].entries()) {
          expectEntry(ledger[i]!, "/x", json);
        }
      }),
  );
  it.live(
    "[EXT-42k] control: actual fieldwise nested decoding retains path meaning and callback order",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { schema, input, trace } = fieldwiseFixture();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              schema,
              (value, encode) => `/${encode(JSON.stringify(value))}`,
            ),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({ path: input })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const expected = {
          filter: { page_size: "5", gate: "3" },
          n: "7",
          m: "9",
          shared: "YUdrPQ==",
          neighbor: { _id: "Option", _tag: "Some", value: { keep: "ok" } },
        };
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expectEntry(
          ledger[0]!,
          `/x/${encodeURIComponent(JSON.stringify(expected))}`,
        );
        expect(trace).toEqual(fieldwiseTrace);
      }),
  );

  it.live(
    "[EXT-42l] control: actual fieldwise nested decoding retains JSON meaning and callback order",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { schema, input, trace } = fieldwiseFixture();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({ body: input })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const expected = {
          filter: { page_size: "5", gate: "3" },
          n: "7",
          m: "9",
          shared: "YUdrPQ==",
          neighbor: { _tag: "Some", value: { keep: "ok" } },
        };
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expectEntry(ledger[0]!, "/x", JSON.stringify(expected));
        expect(trace).toEqual(fieldwiseTrace);
      }),
  );

  for (const mutation of [
    "ancestor identity",
    "ancestor descriptor",
    "ancestor prototype",
    "terminal value",
  ] as const) {
    it.live(
      `[EXT-42m] control: ${mutation} changes during construction cannot authorize new nested decoding`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const trace: string[] = [];
          const input = { filter: { page_size: "many" } };
          const Filter = Schema.Struct({
            limit: Schema.optionalKey(
              observedText(trace, "limit").pipe(
                Schema.decodeTo(Schema.FiniteFromString),
              ),
            ).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  trace.push("default");
                  if (mutation === "ancestor identity")
                    input.filter = { page_size: "many" };
                  else if (mutation === "ancestor descriptor")
                    Object.defineProperty(input, "filter", {
                      enumerable: false,
                    });
                  else if (mutation === "ancestor prototype")
                    Object.setPrototypeOf(input, null);
                  else input.filter.page_size = "05";
                  return 25;
                }),
              ),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const Root = Schema.Struct({ filter: Filter });
          const operation = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(Root)),
            ),
            response,
          );
          expect(
            yield* operation
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expectEntry(ledger[0]!, "/x", '{"filter":{"page_size":"25"}}');
          expect(trace).toEqual([
            "limit.read:many",
            "limit.read:many",
            "default",
            "limit.write:25",
          ]);
        }),
    );
  }

  it.live(
    "[EXT-42n] control: an ancestor replaced while a default waits retains the baseline route",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const trace: string[] = [];
        const input = { filter: { page_size: "many" } };
        const Filter = Schema.Struct({
          limit: Schema.optionalKey(
            observedText(trace, "limit").pipe(
              Schema.decodeTo(Schema.FiniteFromString),
            ),
          ).pipe(
            Schema.withConstructorDefault(
              Effect.gen(function* () {
                trace.push("default.enter");
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                trace.push("default.exit");
                return 25;
              }),
            ),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const Root = Schema.Struct({ filter: Filter });
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Root)),
          ),
          response,
        );
        const running = yield* Effect.forkChild(
          operation
            .execute({ body: input })
            .pipe(Effect.provide(lane.fetchClient)),
        );
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
        input.filter = { page_size: "many" };
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(running)).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expectEntry(ledger[0]!, "/x", '{"filter":{"page_size":"25"}}');
        expect(trace).toEqual([
          "limit.read:many",
          "limit.read:many",
          "default.enter",
          "default.exit",
          "limit.write:25",
        ]);
      }),
  );

  it.live(
    "[EXT-42o] control: stale written left and stable unwritten right are not one witness",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const trace: string[] = [];
        const input = {
          left: { page_size: "many" },
          right: { page_size: "many" },
        };
        const LeftNumber = observedText(trace, "left").pipe(
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
        // Deliberately one-way: this field's writer omits its value; its reverse explicitly fails.
        const RightNumber = Schema.optionalKey(
          observedText(trace, "right").pipe(
            Schema.decodeTo(Schema.FiniteFromString),
          ),
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
        const Left = Schema.Struct({
          limit: Schema.optionalKey(LeftNumber).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                trace.push("left.default");
                return 25;
              }),
            ),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const Right = Schema.Struct({ limit: RightNumber }).pipe(
          Schema.encodeKeys({ limit: "page_size" }),
        );
        const Root = Schema.Struct({ left: Left, right: Right });
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Root)),
          ),
          response,
        );
        const result = yield* operation
          .execute({ body: input })
          .pipe(Effect.provide(lane.fetchClient), outcome);
        expect(result).toMatchObject({
          kind: "failure",
          error: { _tag: "SchemaError" },
        });
        expect(String("error" in result ? result.error : result)).toContain(
          '["right"]["page_size"]',
        );
        expect(yield* backend.ledger).toEqual([]);
        expect(trace).toEqual([
          "left.read:many",
          "left.read:many",
          "left.default",
          "right.default",
          "left.replace",
          "left.write:25",
          "right.omit:25",
        ]);
        const reverse = yield* Schema.decodeUnknownEffect(Right)({}).pipe(
          Effect.flip,
        );
        expect(String(reverse)).toContain(
          "The omitted right field has no inverse",
        );
        expect(yield* backend.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-42p] currently, a parent union retains its separately unproved nested replacement",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const ParentUnion = Schema.Union([
          Nested,
          Schema.Struct({ cursor: Schema.String }),
        ]);
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(ParentUnion)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({ body: { filter: { page_size: "many" } } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expectEntry(ledger[0]!, "/x", '{"filter":{"page_size":"25"}}');
      }),
  );

  it.live(
    "[EXT-42q] currently, an array ancestor retains its separately unproved nested replacement",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const ArrayParent = Schema.Struct({ filters: Schema.Array(Inner) });
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(ArrayParent)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({ body: { filters: [{ page_size: "many" }] } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expectEntry(ledger[0]!, "/x", '{"filters":[{"page_size":"25"}]}');
      }),
  );
  it.live(
    "[EXT-42r] control: a terminal child union preserves its cursor alternative on path and body",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const Child = Schema.Struct({ filter: Schema.Union([Inner, Cursor]) });
        const path = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(Child, ({ filter }, encode) =>
              pagePath(filter, encode),
            ),
          ),
          response,
        );
        const body = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Child)),
          ),
          response,
        );
        expect(
          yield* path
            .execute({ path: { filter: { cursor: "next/part" } } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(
          yield* body
            .execute({ body: { filter: { cursor: "next/part" } } })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(2);
        expectEntry(ledger[0]!, "/x/cursor/next%2Fpart");
        expectEntry(ledger[1]!, "/x", '{"filter":{"cursor":"next/part"}}');
      }),
  );
});
