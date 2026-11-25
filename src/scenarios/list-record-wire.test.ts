/**
 * Consumer-side coverage derived from #240's public description, the schema-input guide's
 * "A list stays a list" section and the neutral echo contract in README.md.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Backend } from "../harness/lane.js";

const Plain = Schema.Array(
  Schema.Struct({ limit: Schema.optionalKey(Schema.String) }),
);
const Filter = Schema.Array(
  Schema.Struct({
    limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
      Schema.withConstructorDefault(Effect.succeed(25)),
    ),
  }).pipe(Schema.encodeKeys({ limit: "page_size" })),
);
const Open = Schema.Record(Schema.String, Schema.Unknown);
const Pairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const PairRecord = Schema.Record(Schema.String, Schema.Array(Schema.String));
const EmptyOrPairs = Schema.Union([Schema.Struct({}), Pairs]);

const start = () => lane.backend("echo", undefined, { listener: "socket" });
const response = Response.status(404, Body.text);
const bindings = ["JSON", "path"] as const;
type Binding = (typeof bindings)[number];
const groups = ["query", "headers"] as const;
type Group = (typeof groups)[number];
type WireSchema = Schema.Top &
  Schema.ConstraintCodec<unknown, unknown, never, never>;

// Invalid caller values model JavaScript input crossing the public API.
const send = <S extends WireSchema>(
  backend: Backend,
  binding: Binding,
  schema: S,
  input: unknown,
) => {
  const url = `${backend.origin}/x`;
  const value = input as Request.Input<S>;
  return (
    binding === "JSON"
      ? Operation.make(
          Request.post(url).pipe(Request.body(Body.jsonSchema(schema))),
          response,
        ).execute({ body: value })
      : Operation.make(
          Request.get(url).pipe(
            Request.path(
              schema,
              (part, encode) => `/${encode(JSON.stringify(part))}`,
            ),
          ),
          response,
        ).execute({ path: value })
  ).pipe(Effect.provide(lane.fetchClient));
};

const sendGroup = (
  backend: Backend,
  group: Group,
  schema:
    | typeof Pairs
    | Schema.Union<
        | readonly [typeof Pairs, typeof PairRecord]
        | readonly [typeof PairRecord, typeof Pairs]
      >
    | typeof EmptyOrPairs,
  input: unknown,
) => {
  const get = Request.get(`${backend.origin}/x`);
  const value = input as ReadonlyArray<readonly [string, string]>;
  return (
    group === "query"
      ? Operation.make(get.pipe(Request.query(schema)), response).execute({
          query: value,
        })
      : Operation.make(get.pipe(Request.headers(schema)), response).execute({
          headers: value,
        })
  ).pipe(Effect.provide(lane.fetchClient));
};

const refuse = <A, E>(backend: Backend, request: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(request);
    const ledger = yield* backend.ledger;
    expect({
      schemaError:
        result._tag === "Failure" && Schema.isSchemaError(result.failure),
      requests: ledger.map(({ method, target, lines, body }) => ({
        method,
        target,
        testedHeaders: lines.filter(([name]) =>
          /^(0|x-list|x-other)$/i.test(name),
        ),
        body: new TextDecoder().decode(body),
      })),
    }).toEqual({ schemaError: true, requests: [] });
    return result;
  });

const wire = (
  backend: Backend,
  method: "GET" | "POST",
  target: string,
  body?: string,
  headers: ReadonlyArray<
    readonly [name: string, values: readonly string[]]
  > = [],
) =>
  Effect.gen(function* () {
    const ledger = yield* backend.ledger;
    expect(ledger).toHaveLength(1);
    const entry = ledger[0]!;
    expect(entry.method).toBe(method);
    expect(entry.target).toBe(target);
    expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
    expect(headerValues(entry.lines, "content-type")).toEqual(
      body === undefined ? [] : ["application/json"],
    );
    for (const [name, values] of headers) {
      expect(headerValues(entry.lines, name)).toEqual(values);
    }
    expect(
      entry.body,
      `received body: ${new TextDecoder().decode(entry.body)}`,
    ).toEqual(new TextEncoder().encode(body ?? ""));
  });

const jsonWire = (backend: Backend, binding: Binding, json: string) =>
  binding === "JSON"
    ? wire(backend, "POST", "/x", json)
    : wire(backend, "GET", `/x/${encodeURIComponent(json)}`);

const orders = ["list first", "record first"] as const;
type Order = (typeof orders)[number];
const ordered = <L, R>(list: L, record: R, order: Order) =>
  order === "list first"
    ? ([list, record] as const)
    : ([record, list] as const);

const positions = [
  {
    name: "root",
    wrapSchema: (schema: WireSchema) => schema,
    wrapInput: (value: unknown) => value,
    wrapJSON: (json: string) => json,
  },
  {
    name: "struct field",
    wrapSchema: (schema: WireSchema) => Schema.Struct({ items: schema }),
    wrapInput: (value: unknown) => ({ items: value }),
    wrapJSON: (json: string) => `{"items":${json}}`,
  },
  {
    name: "array element",
    wrapSchema: (schema: WireSchema) => Schema.Array(schema),
    wrapInput: (value: unknown) => [value],
    wrapJSON: (json: string) => `[${json}]`,
  },
];

describe("Lists beside records on the wire", () => {
  for (const binding of bindings) {
    for (const order of orders) {
      const listed = Schema.Union(ordered(Plain, Open, order));
      const filtered = Schema.Union(ordered(Filter, Open, order));
      for (const { name, wrapSchema, wrapInput, wrapJSON } of positions) {
        const schema = wrapSchema(listed);
        it.live(
          `[EXT-51a] ${binding} ${name} ${order} refuses an invalid item`,
          () =>
            Effect.gen(function* () {
              const backend = yield* start();
              yield* refuse(
                backend,
                send(backend, binding, schema, wrapInput([{ limit: 5 }])),
              );
            }),
        );
        for (const { name: control, input, json } of [
          {
            name: "valid list",
            input: [{ limit: "x" }],
            json: '[{"limit":"x"}]',
          },
          {
            name: "numeric-key object",
            input: { "0": { limit: 5 }, "1": [] },
            json: '{"0":{"limit":5},"1":[]}',
          },
        ]) {
          it.live(
            `[EXT-51b] ${binding} ${name} ${order} preserves a ${control}`,
            () =>
              Effect.gen(function* () {
                const backend = yield* start();
                yield* send(backend, binding, schema, wrapInput(input));
                yield* jsonWire(backend, binding, wrapJSON(json));
              }),
          );
        }
      }

      it.live(
        `[EXT-51c] ${binding} ${order} refuses a list in competing member fields`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const schema = Schema.Union(
              ordered(
                Schema.Struct({ items: Plain }),
                Schema.Struct({ items: Open }),
                order,
              ),
            );
            yield* refuse(
              backend,
              send(backend, binding, schema, { items: [{ limit: 5 }] }),
            );
          }),
      );

      it.live(
        `[EXT-51f] ${binding} ${order} refuses an invalid item under a fieldwise parent`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const schema = Schema.Struct({
              n: Schema.FiniteFromString,
              items: filtered,
            });
            const result = yield* refuse(
              backend,
              send(backend, binding, schema, { n: 1, items: [{ limit: "x" }] }),
            );
            expect(
              result._tag === "Failure" && String(result.failure),
            ).toContain('["items"][0]["limit"]');
          }),
      );

      it.live(
        `[EXT-51h] ${binding} ${order} reads a list with an unstated item key as the list member does`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const input = [{ limit: "x", extra: 1 }];
            yield* send(backend, binding, listed, input);
            yield* jsonWire(backend, binding, '[{"limit":"x"}]');
          }),
      );

      it.live(
        `[EXT-51i] ${binding} ${order} refuses an invalid encoded list item alias before dispatch`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const input = [{ page_size: "many" }];
            yield* refuse(backend, send(backend, binding, Filter, input));
            yield* refuse(backend, send(backend, binding, filtered, input));
          }),
      );
    }

    for (const { name, input } of [
      { name: "an empty list", input: [] },
      { name: "a populated list", input: [{ limit: "x" }] },
    ]) {
      it.live(`[EXT-51d] ${binding} record alone refuses ${name}`, () =>
        Effect.gen(function* () {
          const backend = yield* start();
          yield* refuse(backend, send(backend, binding, Open, input));
        }),
      );
    }
  }

  for (const group of groups) {
    for (const order of orders) {
      const schema = Schema.Union(ordered(Pairs, PairRecord, order));
      it.live(`[EXT-51e] ${group} ${order} refuses a three-cell pair`, () =>
        Effect.gen(function* () {
          const backend = yield* start();
          yield* refuse(
            backend,
            sendGroup(backend, group, schema, [["x-list", "a", "b"]]),
          );
        }),
      );
      it.live(
        `[EXT-51e] ${group} ${order} sends valid pairs under their names`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            yield* sendGroup(backend, group, schema, [
              ["x-list", "a"],
              ["x-other", "b"],
            ]);
            yield* wire(
              backend,
              "GET",
              group === "query" ? "/x?x-list=a&x-other=b" : "/x",
              undefined,
              [
                ["0", []],
                ["1", []],
                ["x-list", group === "headers" ? ["a"] : []],
                ["x-other", group === "headers" ? ["b"] : []],
              ],
            );
          }),
      );
    }

    it.live(
      `[EXT-51g] ${group} writes a null-prototype pairs list under its field name beside an empty struct`,
      () =>
        Effect.gen(function* () {
          const input = Object.setPrototypeOf([["x-list", "a"]], null);
          const control = yield* start();
          yield* sendGroup(control, group, Pairs, input);
          yield* wire(
            control,
            "GET",
            group === "query" ? "/x?x-list=a" : "/x",
            undefined,
            [
              ["0", []],
              ["x-list", group === "headers" ? ["a"] : []],
            ],
          );

          const backend = yield* start();
          yield* sendGroup(backend, group, EmptyOrPairs, input);
          yield* wire(
            backend,
            "GET",
            group === "query" ? "/x?x-list=a" : "/x",
            undefined,
            [
              ["0", []],
              ["x-list", group === "headers" ? ["a"] : []],
            ],
          );
        }),
    );
  }
});
