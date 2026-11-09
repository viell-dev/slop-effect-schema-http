/**
 * Consumer-authored from the public accepted array/tuple subset and neutral echo contract:
 * https://github.com/viell-dev/slop-effect-schema-http/issues/170#issuecomment-6734230849
 * These are physical-wire checks of bounded constructor behavior, not general array recovery.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Schema, SchemaGetter } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Cursor = Schema.Struct({ cursor: Schema.String });
const Filters = Schema.Array(Filter);
const companion = (leaf: unknown) =>
  typeof leaf === "object" &&
  leaf !== null &&
  "page_size" in leaf &&
  !("limit" in leaf)
    ? { page_size: "02" }
    : { limit: 2 };
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
const result = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ error }),
      onSuccess: (value) => ({ value }),
    }),
  );
const wire = (entry: Recorded, target: string, json?: string) => {
  expect(entry.method).toBe(json === undefined ? "GET" : "POST");
  expect(entry.target).toBe(target);
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "content-type")).toEqual(
    json === undefined ? [] : ["application/json"],
  );
  expect(entry.body).toEqual(new TextEncoder().encode(json ?? ""));
};
const pathFor = (json: string) => `/x/${encodeURIComponent(json)}`;
const profiles = [
  "ordinary",
  "null prototype",
  "frozen",
  "hidden position",
  "hidden alias",
] as const;
type Profile = (typeof profiles)[number];
// Fixtures contain only fresh own-data objects. This changes descriptors without invoking an
// iterator or serializing a caller to make a copy; cyclic extras have a separate check below.
const profile = (value: unknown, shape: Profile): void => {
  if (typeof value !== "object" || value === null) return;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ("value" in descriptor) profile(descriptor.value, shape);
    if (
      (shape === "hidden position" &&
        Array.isArray(value) &&
        key !== "length") ||
      (shape === "hidden alias" && key === "page_size")
    )
      Object.defineProperty(value, key, { enumerable: false });
  }
  if (shape === "null prototype") Object.setPrototypeOf(value, null);
  if (shape === "frozen") Object.freeze(value);
};

const fixtures = [
  {
    name: "root",
    schema: Filters,
    input: (leaf: unknown) => [leaf],
    json: (leaf: string) => `[${leaf}]`,
  },
  {
    name: "last array index",
    schema: Filters,
    input: (leaf: unknown) => [companion(leaf), leaf],
    json: (leaf: string) => `[{"page_size":"2"},${leaf}]`,
  },
  {
    name: "double array",
    schema: Schema.Array(Filters),
    input: (leaf: unknown) => [[leaf]],
    json: (leaf: string) => `[[${leaf}]]`,
  },
  {
    name: "wrapped array",
    schema: Schema.Struct({
      batches: Schema.Array(Schema.Struct({ filter: Filter })),
    }),
    input: (leaf: unknown) => ({ batches: [{ filter: leaf }] }),
    json: (leaf: string) => `{"batches":[{"filter":${leaf}}]}`,
  },
  {
    name: "object union",
    schema: Schema.Union([Schema.Struct({ filters: Filters }), Cursor]),
    input: (leaf: unknown) => ({ filters: [leaf] }),
    json: (leaf: string) => `{"filters":[${leaf}]}`,
  },
  {
    name: "reversed object union",
    schema: Schema.Union([Cursor, Schema.Struct({ filters: Filters })]),
    input: (leaf: unknown) => ({ filters: [leaf] }),
    json: (leaf: string) => `{"filters":[${leaf}]}`,
  },
  {
    name: "terminal element union",
    schema: Schema.Array(Schema.Union([Filter, Cursor])),
    input: (leaf: unknown) => [leaf],
    json: (leaf: string) => `[${leaf}]`,
  },
  {
    name: "fixed middle tuple",
    schema: Schema.Tuple([Schema.String, Filter, Schema.Boolean]),
    input: (leaf: unknown) => ["start/end", leaf, true],
    json: (leaf: string) => `["start/end",${leaf},true]`,
  },
  {
    name: "prefix before rest",
    schema: Schema.TupleWithRest(Schema.Tuple([Filter]), [Schema.String]),
    input: (leaf: unknown) => [leaf, "a/b", "tail"],
    json: (leaf: string) => `[${leaf},"a/b","tail"]`,
  },
  {
    name: "homogeneous rest",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Filter]),
    input: (leaf: unknown) => ["a/b", companion(leaf), leaf],
    json: (leaf: string) => `["a/b",{"page_size":"2"},${leaf}]`,
  },
  {
    name: "post-rest with empty rest",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.Boolean,
      Filter,
    ]),
    input: (leaf: unknown) => ["a/b", leaf],
    json: (leaf: string) => `["a/b",${leaf}]`,
  },
  {
    name: "post-rest with two rest positions",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.Boolean,
      Filter,
    ]),
    input: (leaf: unknown) => ["a/b", false, true, leaf],
    json: (leaf: string) => `["a/b",false,true,${leaf}]`,
  },
  {
    name: "optional tuple position",
    schema: Schema.Tuple([Schema.String, Schema.optionalKey(Filter)]),
    input: (leaf: unknown) => ["a/b", leaf],
    json: (leaf: string) => `["a/b",${leaf}]`,
  },
] as const;
const leafControls = [
  [{ page_size: "05" }, '{"page_size":"5"}'],
  [{ limit: 5 }, '{"page_size":"5"}'],
  [{}, '{"page_size":"25"}'],
  [{ limit: 5, page_size: "many" }, '{"page_size":"5"}'],
] as const;

const inputTypes = () => {
  const encoded: Request.Input<typeof Filters> = [{ page_size: "05" }];
  const decoded: Request.Input<typeof Filters> = [{ limit: 5 }];
  const badName: Request.Input<typeof Filters> = [
    // @ts-expect-error Array members retain their declared input names.
    { page_count: "05" },
  ];
  const badValue: Request.Input<typeof Filters> = [
    // @ts-expect-error An encoded finite-number field still requires text.
    { page_size: true },
  ];
  return { encoded, decoded, badName, badValue };
};
void inputTypes;

describe(`array constructor defaults (${lane.name})`, () => {
  for (const fixture of fixtures) {
    const { schema } = fixture;
    it.live(
      `[EXT-44a] ${fixture.name} controls preserve encoded decoded default and priority bytes`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const path = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(
                schema,
                (value, encode) => `/${encode(JSON.stringify(value))}`,
              ),
            ),
            response,
          );
          const body = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(schema)),
            ),
            response,
          );
          for (const [leaf, expectedLeaf] of leafControls) {
            // The table combines different public schemas; each builder supplies that schema's
            // whole shape. Runtime-negative cases below use this same explicit boundary cast.
            const input = fixture.input({ ...leaf }) as Request.Input<
              typeof schema
            >;
            expect(
              yield* path
                .execute({ path: input })
                .pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
            expect(
              yield* body
                .execute({ body: input })
                .pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
            const ledger = yield* backend.ledger;
            const expected = fixture.json(expectedLeaf);
            wire(ledger[ledger.length - 2]!, pathFor(expected));
            wire(ledger[ledger.length - 1]!, "/x", expected);
          }
          expect(yield* backend.ledger).toHaveLength(8);
        }),
    );
    for (const binding of ["path", "JSON"] as const) {
      it.live(
        `[EXT-44b] ${fixture.name} ${binding} refuses invalid stable aliases without dispatch`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const path = Operation.make(
              Request.get(`${backend.origin}/x`).pipe(
                Request.path(
                  schema,
                  (value, encode) => `/${encode(JSON.stringify(value))}`,
                ),
              ),
              response,
            );
            const body = Operation.make(
              Request.post(`${backend.origin}/x`).pipe(
                Request.body(Body.jsonSchema(schema)),
              ),
              response,
            );
            // A successful complete encoded call in this exact operation precedes the refusal.
            const good = fixture.input({ page_size: "05" }) as Request.Input<
              typeof schema
            >;
            expect(
              yield* (
                binding === "path"
                  ? path.execute({ path: good })
                  : body.execute({ body: good })
              ).pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
            const before = yield* backend.ledger;
            expect(before).toHaveLength(1);
            const expected = fixture.json('{"page_size":"5"}');
            wire(
              before[0]!,
              binding === "path" ? pathFor(expected) : "/x",
              binding === "path" ? undefined : expected,
            );
            const outcomes = [];
            for (const shape of profiles)
              for (const invalid of ["many", null]) {
                const input = fixture.input({ page_size: invalid });
                profile(input, shape);
                const supplied = input as Request.Input<typeof schema>;
                outcomes.push({
                  shape,
                  invalid,
                  outcome: yield* (
                    binding === "path"
                      ? path.execute({ path: supplied })
                      : body.execute({ body: supplied })
                  ).pipe(Effect.provide(lane.fetchClient), result),
                });
              }
            expect({
              outcomes,
              extraRequests: (yield* backend.ledger).length - before.length,
              received: (yield* backend.ledger)
                .slice(before.length)
                .map((entry) => ({
                  method: entry.method,
                  target: entry.target,
                  headers: entry.lines,
                  body: new TextDecoder().decode(entry.body),
                })),
            }).toMatchObject({
              outcomes: profiles.flatMap((shape) =>
                ["many", null].map((invalid) => ({
                  shape,
                  invalid,
                  outcome: { error: { _tag: "SchemaError" } },
                })),
              ),
              extraRequests: 0,
              received: [],
            });
          }),
      );
    }
  }

  it.live(
    "[EXT-44c] stable profiles retain valid aliases and terminal or parent alternatives",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const schema = Schema.Union([
          Schema.Struct({
            filters: Schema.Array(Schema.Union([Filter, Cursor])),
          }),
          Cursor,
        ]);
        const path = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              schema,
              (value, encode) => `/${encode(JSON.stringify(value))}`,
            ),
          ),
          response,
        );
        const body = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        for (const shape of profiles) {
          const input = { filters: [{ page_size: "05" }] };
          profile(input, shape);
          expect(
            yield* path
              .execute({ path: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          expect(
            yield* body
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        }
        for (const input of [
          { filters: [{ cursor: "next/part" }] },
          { cursor: "parent/part" },
        ]) {
          expect(
            yield* path
              .execute({ path: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          expect(
            yield* body
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        }
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(14);
        const expected = [
          ...profiles.map(() => '{"filters":[{"page_size":"5"}]}'),
          '{"filters":[{"cursor":"next/part"}]}',
          '{"cursor":"parent/part"}',
        ];
        for (const [index, json] of expected.entries()) {
          wire(ledger[index * 2]!, pathFor(json));
          wire(ledger[index * 2 + 1]!, "/x", json);
        }
      }),
  );

  it.live(
    "[EXT-44d] omitted optional positions and whole encoded omission retain distinct meanings",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const tuple = Schema.Tuple([Schema.String, Schema.optionalKey(Filter)]);
        const tupleOperation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(tuple)),
          ),
          response,
        );
        const arrayOperation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Filters)),
          ),
          response,
        );
        for (const input of [["a/b"], ["a/b", {}]] as const)
          expect(
            yield* tupleOperation
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        // The encoded companion forces ordinary whole decoding; that decoder does not construct
        // a default for the omitted second limit. This is an existing route, not a new guarantee.
        expect(
          yield* arrayOperation
            .execute({ body: [{ page_size: "02" }, {}] })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        wire(ledger[0]!, "/x", '["a/b"]');
        wire(ledger[1]!, "/x", '["a/b",{"page_size":"25"}]');
        wire(ledger[2]!, "/x", '[{"page_size":"2"},{}]');
      }),
  );

  for (const shape of [
    "accessor",
    "inherited",
    "subclass",
    "custom iterator",
  ] as const) {
    it.live(
      `[EXT-44e] currently ${shape} arrays retain their unsupported default overwrite`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const input = [{ page_size: "many" }];
          let reads = 0;
          let iterations = 0;
          if (shape === "accessor")
            Object.defineProperty(input, "0", {
              configurable: true,
              enumerable: true,
              get: () => {
                reads++;
                return { page_size: "many" };
              },
            });
          if (shape === "inherited") {
            delete input[0];
            Object.setPrototypeOf(
              input,
              Object.create(Array.prototype, {
                "0": { value: { page_size: "many" }, enumerable: true },
              }),
            );
          }
          if (shape === "subclass") {
            class ConsumerArray extends Array<{ page_size: string }> {}
            Object.setPrototypeOf(input, ConsumerArray.prototype);
          }
          if (shape === "custom iterator")
            Object.defineProperty(input, Symbol.iterator, {
              value: function* () {
                iterations++;
                yield { page_size: "many" };
              },
            });
          const path = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(
                Filters,
                (value, encode) => `/${encode(JSON.stringify(value))}`,
              ),
            ),
            response,
          );
          const body = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(Filters)),
            ),
            response,
          );
          expect(
            yield* path
              .execute({ path: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          expect(
            yield* body
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(2);
          wire(ledger[0]!, pathFor('[{"page_size":"25"}]'));
          wire(ledger[1]!, "/x", '[{"page_size":"25"}]');
          if (shape === "accessor") expect(reads).toBeGreaterThan(0);
          // No new evidence collector is permitted to execute this iterator. Baseline schemas
          // consume indices; neither operation invokes this deliberately different iterator.
          expect(iterations).toBe(0);
        }),
    );
  }

  it.live(
    "[EXT-44f] sparse own-cell aliases refuse instead of dispatching constructor defaults",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const schema = Schema.Array(Schema.optional(Filter));
        const input: Array<typeof Filter.Encoded | undefined> = [];
        input.length = 2;
        input[1] = { page_size: "many" };
        const path = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              schema,
              (value, encode) => `/${encode(JSON.stringify(value))}`,
            ),
          ),
          response,
        );
        const body = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        expect(
          yield* path
            .execute({ path: input })
            .pipe(Effect.provide(lane.fetchClient), result),
        ).toMatchObject({ error: { _tag: "SchemaError" } });
        expect(
          yield* body
            .execute({ body: input })
            .pipe(Effect.provide(lane.fetchClient), result),
        ).toMatchObject({ error: { _tag: "SchemaError" } });
        const ledger = yield* backend.ledger;
        expect(ledger).toEqual([]);
        expect(Object.hasOwn(input, 0)).toBe(false);
      }),
  );

  it.live(
    "[EXT-44g] currently an array-shaped union ancestor retains its unproved overwrite",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const schema = Schema.Union([Filters, Cursor]);
        const path = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              schema,
              (value, encode) => `/${encode(JSON.stringify(value))}`,
            ),
          ),
          response,
        );
        const body = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        for (const input of [
          [{ page_size: "many" }],
          { cursor: "other/part" },
        ]) {
          expect(
            yield* path
              .execute({ path: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          expect(
            yield* body
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        }
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(4);
        wire(ledger[0]!, pathFor('[{"page_size":"25"}]'));
        wire(ledger[1]!, "/x", '[{"page_size":"25"}]');
        wire(ledger[2]!, pathFor('{"cursor":"other/part"}'));
        wire(ledger[3]!, "/x", '{"cursor":"other/part"}');
      }),
  );

  for (const mutation of ["length", "order"] as const) {
    it.live(
      `[EXT-44h] ${mutation} changes during a tail default retain their original constructor route`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const trace: string[] = [];
          const input: [...boolean[], { page_size: string }] = [
            false,
            true,
            { page_size: "many" },
          ];
          const Tail = Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(
                Effect.sync(() => {
                  trace.push("default");
                  if (mutation === "length") input.push(false);
                  else [input[0], input[1]] = [input[1]!, input[0]!];
                  return 25;
                }),
              ),
            ),
          }).pipe(Schema.encodeKeys({ limit: "page_size" }));
          const schema = Schema.TupleWithRest(Schema.Tuple([]), [
            Schema.Boolean,
            Tail,
          ]);
          const operation = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(schema)),
            ),
            response,
          );
          const actual = yield* operation
            .execute({ body: input })
            .pipe(Effect.provide(lane.fetchClient), result);
          expect(trace).toEqual(["default"]);
          const ledger = yield* backend.ledger;
          if (mutation === "length") {
            // The existing loss check already refuses the new caller position. Preserve that
            // refusal independently of the added constructor-only evidence.
            expect(actual).toMatchObject({ error: { _tag: "SchemaError" } });
            expect(ledger).toEqual([]);
          } else {
            expect(actual).toEqual({ value: "Not Found" });
            expect(ledger).toHaveLength(1);
            wire(ledger[0]!, "/x", '[false,true,{"page_size":"25"}]');
          }
          expect(input.length).toBe(mutation === "length" ? 4 : 3);
          expect(input[0]).toBe(mutation !== "length");
        }),
    );
  }

  it.live(
    "[EXT-44i] unknown cyclic extras preserve caller identity and cannot hide covered aliases",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const extra: { self?: unknown } = {};
        extra.self = extra;
        const path = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              Filters,
              (value, encode) => `/${encode(JSON.stringify(value))}`,
            ),
          ),
          response,
        );
        const good = [{ page_size: "05", extra }];
        expect(
          yield* path
            .execute({ path: good })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const before = yield* backend.ledger;
        expect(before).toHaveLength(1);
        wire(before[0]!, pathFor('[{"page_size":"5"}]'));
        const invalid = [{ page_size: "many", extra }];
        const refused = yield* path
          .execute({ path: invalid })
          .pipe(Effect.provide(lane.fetchClient), result);
        expect({
          refused,
          count: (yield* backend.ledger).length,
        }).toMatchObject({
          refused: { error: { _tag: "SchemaError" } },
          count: 1,
        });
        expect(good[0]!.extra).toBe(extra);
        expect(invalid[0]!.extra).toBe(extra);
        expect(extra.self).toBe(extra);
      }),
  );

  it.live(
    "[EXT-44j] actual member fieldwise array consumption preserves shared decoded text",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const reads: string[] = [];
        const observed = Schema.String.pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transform((text) => {
              reads.push(text);
              return text;
            }),
            encode: SchemaGetter.transform((text) => text),
          }),
          Schema.decodeTo(Schema.FiniteFromString),
        );
        const Consumed = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
          gate: Schema.FiniteFromString,
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Union([
          Schema.Struct({
            filters: Schema.Array(Consumed),
            left: observed,
            right: Schema.FiniteFromString,
            shared: Schema.StringFromBase64,
            neighbor: Schema.Option(Schema.Struct({ keep: Schema.String })),
          }),
          Cursor,
        ]);
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        expect(
          yield* operation
            .execute({
              body: {
                filters: [{ page_size: "08", gate: "02" }],
                left: "06",
                right: 4,
                shared: "eA==",
                neighbor: Option.some({ keep: "ok", stray: "strip" }),
              },
            })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(reads).toEqual(["06", "06", "06", "06", "06", "06"]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        wire(
          ledger[0]!,
          "/x",
          '{"filters":[{"page_size":"8","gate":"2"}],"left":"6","right":"4","shared":"ZUE9PQ==","neighbor":{"_tag":"Some","value":{"keep":"ok"}}}',
        );
      }),
  );

  it.live(
    "[EXT-44k] whole array decoding refuses valid mixed input while complete sides and named mapping retain meaning",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const schema = Schema.Struct({
          filters: Filters,
          count: Schema.FiniteFromString,
          shared: Schema.StringFromBase64,
          neighbor: Schema.Option(Schema.Struct({ keep: Schema.String })),
        });
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        const neighbor = Option.some({ keep: "ok", stray: "strip" });
        // Complete-side controls precede the newly rejected mixed call. Shared text explicitly
        // retains its decoded-string meaning here, including Base64 being encoded a second time.
        expect(
          yield* operation
            .execute({
              body: {
                filters: [{ limit: 25 }],
                count: 3,
                shared: "eA==",
                neighbor,
              },
            })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const readForm = Schema.decodeUnknownEffect(
          Schema.Struct({
            filters: Schema.Array(
              Schema.Struct({
                limit: Schema.optionalKey(Schema.FiniteFromString),
              }),
            ),
            count: Schema.FiniteFromString,
          }),
        );
        const submitForm = Effect.fn("submitArrayForm")(function* (form: {
          readonly filters: ReadonlyArray<{ readonly limit?: string }>;
          readonly count: string;
        }) {
          const decoded = yield* readForm(form);
          return yield* operation.execute({
            body: { ...decoded, shared: "eA==", neighbor },
          });
        });
        expect(
          yield* submitForm({ filters: [{ limit: "25" }], count: "03" }).pipe(
            Effect.provide(lane.fetchClient),
          ),
        ).toBe("Not Found");
        const invalidForm = yield* submitForm({
          filters: [{ limit: "many" }],
          count: "03",
        }).pipe(Effect.provide(lane.fetchClient), result);
        expect(invalidForm).toMatchObject({ error: { _tag: "SchemaError" } });
        const controls = yield* backend.ledger;
        expect(controls).toHaveLength(2);
        const decodedJson =
          '{"filters":[{"page_size":"25"}],"count":"3","shared":"ZUE9PQ==","neighbor":{"_tag":"Some","value":{"keep":"ok"}}}';
        for (const entry of controls) wire(entry, "/x", decodedJson);
        const mixed = yield* operation
          .execute({
            body: {
              filters: [{ page_size: "25" }],
              count: 3,
              shared: "eA==",
              neighbor,
            },
          })
          .pipe(Effect.provide(lane.fetchClient), result);
        expect({ mixed, count: (yield* backend.ledger).length }).toMatchObject({
          mixed: { error: { _tag: "SchemaError" } },
          count: 2,
        });
      }),
  );

  it.live(
    "[EXT-44l] whole array decoding selects encoded shared text after its actual constructor",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let defaults = 0;
        const Observed = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                defaults++;
                return 25;
              }),
            ),
          ),
        }).pipe(Schema.encodeKeys({ limit: "page_size" }));
        const schema = Schema.Struct({
          filters: Schema.Array(Observed),
          shared: Schema.StringFromBase64,
          neighbor: Schema.Option(Schema.Struct({ keep: Schema.String })),
        });
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        const neighbor = Option.some({ keep: "ok", stray: "strip" });
        expect(
          yield* operation
            .execute({
              body: { filters: [{ limit: 25 }], shared: "eA==", neighbor },
            })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(defaults).toBe(0);
        expect(
          yield* operation
            .execute({
              body: {
                filters: [{ page_size: "25" }],
                shared: "eA==",
                neighbor,
              },
            })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        expect(defaults).toBe(1);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(2);
        wire(
          ledger[0]!,
          "/x",
          '{"filters":[{"page_size":"25"}],"shared":"ZUE9PQ==","neighbor":{"_tag":"Some","value":{"keep":"ok"}}}',
        );
        wire(
          ledger[1]!,
          "/x",
          '{"filters":[{"page_size":"25"}],"shared":"eA==","neighbor":{"_tag":"Some","value":{"keep":"ok"}}}',
        );
      }),
  );

  it.live(
    "[EXT-44m] mixed array members refuse instead of replacing valid encoded text",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Filters)),
          ),
          response,
        );
        for (const input of [
          [{ page_size: "02" }, { page_size: "05" }],
          [{ limit: 2 }, { limit: 5 }],
        ])
          expect(
            yield* operation
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        const controls = yield* backend.ledger;
        expect(controls).toHaveLength(2);
        for (const entry of controls)
          wire(entry, "/x", '[{"page_size":"2"},{"page_size":"5"}]');
        const mixed = yield* operation
          // @ts-expect-error Whole-side array typing excludes this deliberate runtime mixed-side probe.
          .execute({ body: [{ limit: 2 }, { page_size: "05" }] })
          .pipe(Effect.provide(lane.fetchClient), result);
        expect({ mixed, count: (yield* backend.ledger).length }).toMatchObject({
          mixed: { error: { _tag: "SchemaError" } },
          count: 2,
        });
      }),
  );

  it.live(
    "[EXT-44n] currently transformed array groups retain their unsupported overwrite",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const DecodedFilters = Schema.Array(
          Schema.Struct({
            limit: Schema.optionalKey(Schema.Number).pipe(
              Schema.withConstructorDefault(Effect.succeed(25)),
            ),
          }),
        );
        const schema = Filters.pipe(
          Schema.decodeTo(DecodedFilters, {
            decode: SchemaGetter.transform((value) => value),
            encode: SchemaGetter.transform((value) => value),
          }),
        );
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(schema)),
          ),
          response,
        );
        for (const input of [[{ page_size: "05" }], [{ limit: 5 }]])
          expect(
            yield* operation
              .execute({ body: input })
              .pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
        expect(
          yield* operation
            .execute({ body: [{ page_size: "many" }] })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        wire(ledger[0]!, "/x", '[{"page_size":"5"}]');
        wire(ledger[1]!, "/x", '[{"page_size":"5"}]');
        wire(ledger[2]!, "/x", '[{"page_size":"25"}]');
      }),
  );

  for (const binding of ["path", "JSON"] as const) {
    it.live(
      `[EXT-44o] currently ${binding} whole array decoding changes a typed neighboring dual-name choice`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const path = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(
                Filters,
                (value, encode) => `/${encode(JSON.stringify(value))}`,
              ),
            ),
            response,
          );
          const body = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(Filters)),
            ),
            response,
          );
          const examples = [
            {
              input: [{ page_size: "01" }, { page_size: "25" }],
              json: '[{"page_size":"1"},{"page_size":"25"}]',
            },
            {
              input: [{ limit: 1 }, { limit: 25 }],
              json: '[{"page_size":"1"},{"page_size":"25"}]',
            },
            {
              input: [{ limit: 1, page_size: "02" }],
              json: '[{"page_size":"1"}]',
            },
            {
              input: [{ limit: 1, page_size: "02" }, { limit: 25 }],
              json: '[{"page_size":"1"},{"page_size":"25"}]',
            },
            {
              input: [{ limit: 1, page_size: "02" }, {}],
              json: '[{"page_size":"1"},{"page_size":"25"}]',
            },
          ];
          for (const { input, json } of examples) {
            expect(
              yield* (
                binding === "path"
                  ? path.execute({ path: input })
                  : body.execute({ body: input })
              ).pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
            const ledger = yield* backend.ledger;
            wire(
              ledger[ledger.length - 1]!,
              binding === "path" ? pathFor(json) : "/x",
              binding === "path" ? undefined : json,
            );
          }
          // Public #143 reproduction: this nonliteral input typechecks without a cast. A
          // second encoded-only alias can select whole encoded reading of the first member.
          // This changed conflict choice is a known limit, not a conflict-refusal repair.
          const input = [{ limit: 1, page_size: "02" }, { page_size: "25" }];
          expect(
            yield* (
              binding === "path"
                ? path.execute({ path: input })
                : body.execute({ body: input })
            ).pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(6);
          const json = '[{"page_size":"2"},{"page_size":"25"}]';
          wire(
            ledger[5]!,
            binding === "path" ? pathFor(json) : "/x",
            binding === "path" ? undefined : json,
          );
        }),
    );

    for (const iterator of ["normal", "watched"] as const) {
      it.live(
        iterator === "normal"
          ? `[EXT-44p] ${binding} exact native own iterator refuses invalid aliases and retains valid controls`
          : `[EXT-44p] currently ${binding} watched own iterator retains its unsupported default and valid controls`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const path = Operation.make(
              Request.get(`${backend.origin}/x`).pipe(
                Request.path(
                  Filters,
                  (value, encode) => `/${encode(JSON.stringify(value))}`,
                ),
              ),
              response,
            );
            const body = Operation.make(
              Request.post(`${backend.origin}/x`).pipe(
                Request.body(Body.jsonSchema(Filters)),
              ),
              response,
            );
            let requests = 0;
            for (const [makeInput, json, invalid] of [
              [() => [{ page_size: "many" }], '[{"page_size":"25"}]', true],
              [() => [{ page_size: "05" }], '[{"page_size":"5"}]', false],
              [() => [{ limit: 5 }], '[{"page_size":"5"}]', false],
            ] as const) {
              const input = makeInput();
              let calls = 0;
              // Ordinary assignment creates an own enumerable property; no hostile iterator
              // is needed. The watched variant delegates to precisely the same Array iterator.
              input[Symbol.iterator] = Array.prototype[Symbol.iterator];
              if (iterator === "watched")
                Object.defineProperty(input, Symbol.iterator, {
                  value: () => {
                    calls++;
                    return Array.prototype[Symbol.iterator].call(input);
                  },
                });
              expect(
                Object.getOwnPropertyDescriptor(input, Symbol.iterator),
              ).toMatchObject({ enumerable: true });
              let phase = "execute call";
              const exit = yield* Effect.suspend(() => {
                const effect =
                  binding === "path"
                    ? path.execute({ path: input })
                    : body.execute({ body: input });
                phase = "effect evaluation";
                return effect;
              }).pipe(Effect.provide(lane.fetchClient), Effect.exit);
              // Exact native data now supplies bounded constructor evidence. The watched
              // wrapper remains excluded, with its original default and zero invocations.
              // Earlier TypeError and exposed-default reports remain separate evidence.
              expect(phase).toBe("effect evaluation");
              expect(calls).toBe(0);
              const ledger = yield* backend.ledger;
              if (iterator === "normal" && invalid) {
                expect(Exit.isFailure(exit)).toBe(true);
                if (Exit.isFailure(exit))
                  expect(exit.cause.reasons).toMatchObject([
                    { _tag: "Fail", error: { _tag: "SchemaError" } },
                  ]);
                expect(ledger).toHaveLength(requests);
              } else {
                expect(Exit.isSuccess(exit)).toBe(true);
                if (Exit.isSuccess(exit)) expect(exit.value).toBe("Not Found");
                expect(ledger).toHaveLength(++requests);
                wire(
                  ledger[requests - 1]!,
                  binding === "path" ? pathFor(json) : "/x",
                  binding === "path" ? undefined : json,
                );
              }
            }
          }),
      );
    }
  }
});
