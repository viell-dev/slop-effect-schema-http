/**
 * Independent consumer authorship from public #189/#191, published 0.14 documentation,
 * the neutral echo contract and observed HTTP. No library/backend implementation was read.
 * These synthetic agent checks do not establish human expectations or general #170 recovery.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, SchemaGetter, type SchemaIssue } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Filters = Schema.Array(Filter);
const OptionalFilters = Schema.Array(Schema.optional(Filter));
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });
const pathFor = (json: string) => `/x/${encodeURIComponent(json)}`;
const wire = (entry: Recorded, binding: "path" | "JSON", json: string) => {
  expect(entry.method).toBe(binding === "path" ? "GET" : "POST");
  expect(entry.target).toBe(binding === "path" ? pathFor(json) : "/x");
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "content-type")).toEqual(
    binding === "path" ? [] : ["application/json"],
  );
  expect(entry.body).toEqual(
    new TextEncoder().encode(binding === "path" ? "" : json),
  );
};
const received = (entries: ReadonlyArray<Recorded>) =>
  entries.map((entry) => ({
    method: entry.method,
    target: entry.target,
    headers: entry.lines,
    body: new TextDecoder().decode(entry.body),
  }));
const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit))
        return { kind: "success" as const, value: exit.value };
      const reason = exit.cause.reasons[0];
      if (reason?._tag === "Fail")
        return {
          kind: "failure" as const,
          error: reason.error,
          message:
            reason.error instanceof Error ? reason.error.message : undefined,
        };
      if (reason?._tag === "Die")
        return {
          kind: "defect" as const,
          name: reason.defect instanceof Error ? reason.defect.name : undefined,
          message:
            reason.defect instanceof Error ? reason.defect.message : undefined,
        };
      return { kind: "interrupted" as const };
    }),
  );
const snapshot = (input: ReadonlyArray<unknown>) => ({
  length: input.length,
  properties: Reflect.ownKeys(input).map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(input, key)!,
  })),
});
const unchanged = (
  input: ReadonlyArray<unknown>,
  before: ReturnType<typeof snapshot>,
) => {
  expect(input.length).toBe(before.length);
  expect(Reflect.ownKeys(input)).toEqual(
    before.properties.map(({ key }) => key),
  );
  for (const { key, descriptor } of before.properties) {
    const actual = Object.getOwnPropertyDescriptor(input, key)!;
    expect(actual.enumerable).toBe(descriptor.enumerable);
    expect(actual.configurable).toBe(descriptor.configurable);
    if ("value" in descriptor) {
      expect(actual.writable).toBe(descriptor.writable);
      expect(actual.value).toBe(descriptor.value);
    } else {
      expect(actual.get).toBe(descriptor.get);
      expect(actual.set).toBe(descriptor.set);
    }
  }
};
type Cell = typeof Filter.Encoded & { readonly stray?: string };
const layoutInput = (layout: "audit" | "sparse" | "hidden", stray: boolean) => {
  const leaf: Cell = stray
    ? { page_size: "05", stray: "ignored" }
    : { page_size: "05" };
  const input: Array<Cell | undefined> = [];
  if (layout === "audit") {
    input.push(leaf);
    Object.defineProperty(input, "audit", { value: 7, enumerable: true });
  } else if (layout === "sparse") {
    input.length = 2;
    input[1] = leaf;
  } else {
    input.push({ page_size: "07" }, leaf);
    Object.defineProperty(input, "0", { enumerable: false });
  }
  return { input, leaf };
};

const positions = [
  {
    name: "array",
    schema: Filters,
    input: (leaf: unknown) => [leaf],
    json: (leaf: string) => `[${leaf}]`,
  },
  {
    name: "fixed",
    schema: Schema.Tuple([Schema.String, Filter, Schema.Boolean]),
    input: (leaf: unknown) => ["head/end", leaf, true],
    json: (leaf: string) => `["head/end",${leaf},true]`,
  },
  {
    name: "prefix",
    schema: Schema.TupleWithRest(Schema.Tuple([Filter]), [Schema.String]),
    input: (leaf: unknown) => [leaf, "tail/end"],
    json: (leaf: string) => `[${leaf},"tail/end"]`,
  },
  {
    name: "rest",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Filter]),
    input: (leaf: unknown) => ["head/end", leaf],
    json: (leaf: string) => `["head/end",${leaf}]`,
  },
  {
    name: "tail",
    schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
      Schema.Boolean,
      Filter,
    ]),
    input: (leaf: unknown) => ["head/end", false, true, leaf],
    json: (leaf: string) => `["head/end",false,true,${leaf}]`,
  },
] as const;
const symbolProfiles = [
  "normal iterator",
  "watched iterator",
  "ordinary symbol",
  "toStringTag",
  "undefined symbol",
  "hidden symbol",
  "equal descriptions",
] as const;
type SymbolProfile = (typeof symbolProfiles)[number];
const decorate = (input: unknown[], shape: SymbolProfile) => {
  let calls = 0;
  const first = Symbol("audit");
  const second = Symbol("audit");
  if (shape === "normal iterator" || shape === "watched iterator") {
    input[Symbol.iterator] = Array.prototype[Symbol.iterator];
    if (shape === "watched iterator")
      Object.defineProperty(input, Symbol.iterator, {
        value: () => {
          calls++;
          return Array.prototype[Symbol.iterator].call(input);
        },
      });
  } else {
    const key = shape === "toStringTag" ? Symbol.toStringTag : first;
    Object.defineProperty(input, key, {
      value:
        shape === "undefined symbol"
          ? undefined
          : shape === "toStringTag"
            ? "AuditArray"
            : 7,
      enumerable: shape !== "hidden symbol",
    });
    if (shape === "equal descriptions")
      Object.defineProperty(input, second, { value: 8, enumerable: true });
  }
  return { first, second, calls: () => calls };
};
const issueKeys = (issue: SchemaIssue.Issue): ReadonlyArray<PropertyKey> => {
  if (issue._tag === "Pointer")
    return [...issue.path, ...issueKeys(issue.issue)];
  if (issue._tag === "Composite") return issue.issues.flatMap(issueKeys);
  return [];
};
const MixedCell = Schema.Struct({ value: Schema.Number }).pipe(
  Schema.encodeKeys({ value: "VALUE" }),
);
const MixedCells = Schema.Array(MixedCell);
const OpaqueArray = Schema.declare((value): value is ReadonlyArray<unknown> =>
  Array.isArray(value),
);
const mixedViews = [
  ["Unknown", Schema.Union([Schema.Unknown, MixedCells])],
  ["Any", Schema.Union([Schema.Any, MixedCells])],
  ["ObjectKeyword", Schema.Union([Schema.ObjectKeyword, MixedCells])],
  ["Declaration", Schema.Union([OpaqueArray, MixedCells])],
  [
    "rejected array first",
    Schema.Union([
      MixedCells.check(Schema.makeFilter(() => false)),
      Schema.Unknown,
    ]),
  ],
] as const;
const mixedParent = <S extends Schema.Top>(values: S) =>
  Schema.Struct({
    values,
    count: Schema.FiniteFromString,
    tag: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ tag: "TAG" }));
const mixedArray = (profile: "hidden" | "inherited" | "enumerable") => {
  const cell = { VALUE: 5, additional: "retain" };
  const values = [cell];
  if (profile === "hidden")
    Object.defineProperty(values, "0", { enumerable: false });
  if (profile === "inherited") {
    delete values[0];
    Object.setPrototypeOf(
      values,
      Object.create(Array.prototype, {
        "0": { value: cell, enumerable: true },
      }),
    );
  }
  return { values, cell };
};
const textPathWire = (entry: Recorded, target: string) => {
  expect(entry.method).toBe("GET");
  expect(entry.target).toBe(target);
  expect(headerValues(entry.lines, "accept")).toEqual(["text/plain"]);
  expect(headerValues(entry.lines, "content-type")).toEqual([]);
  expect(entry.body).toEqual(new Uint8Array());
};

describe(`array key normalization (${lane.name})`, () => {
  for (const binding of ["path", "JSON"] as const) {
    it.live(
      `[EXT-45a] ${binding} complete-side and omission controls retain ordinary array bytes`,
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
          const encodedWithStray = [{ page_size: "05", stray: "ignored" }];
          const decodedWithStray = [{ limit: 5, stray: "ignored" }];
          for (const [input, json] of [
            [[{ page_size: "05" }], '[{"page_size":"5"}]'],
            [[{ limit: 5 }], '[{"page_size":"5"}]'],
            [encodedWithStray, '[{"page_size":"5"}]'],
            [decodedWithStray, '[{"page_size":"5"}]'],
            [[{}], '[{"page_size":"25"}]'],
            [[], "[]"],
          ] as const) {
            expect(
              yield* (
                binding === "path"
                  ? path.execute({ path: input })
                  : body.execute({ body: input })
              ).pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
            const ledger = yield* backend.ledger;
            wire(ledger[ledger.length - 1]!, binding, json);
          }
          expect(yield* backend.ledger).toHaveLength(6);
        }),
    );

    for (const layout of ["audit", "sparse", "hidden"] as const) {
      const schema = layout === "sparse" ? OptionalFilters : Filters;
      const expected =
        layout === "audit"
          ? '[{"page_size":"5"}]'
          : layout === "sparse"
            ? '[null,{"page_size":"5"}]'
            : '[{"page_size":"7"},{"page_size":"5"}]';
      it.live(
        `[EXT-45b] ${binding} ${layout} layout without an inner rewrite preserves actual cells`,
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
            const { input, leaf } = layoutInput(layout, false);
            const before = snapshot(input);
            // The fixture selects optional cells only for the sparse schema.
            const supplied = input as Request.Input<typeof schema>;
            expect(
              yield* (
                binding === "path"
                  ? path.execute({ path: supplied })
                  : body.execute({ body: supplied })
              ).pipe(Effect.provide(lane.fetchClient)),
            ).toBe("Not Found");
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(1);
            wire(ledger[0]!, binding, expected);
            unchanged(input, before);
            expect(input[layout === "audit" ? 0 : 1]).toBe(leaf);
            if (layout === "sparse")
              expect(Object.hasOwn(input, 0)).toBe(false);
          }),
      );
      it.live(
        `[EXT-45c] [EXT-45d] ${binding} ${layout} inner rewriting preserves real layout without phantom cells`,
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
            const { input, leaf } = layoutInput(layout, true);
            const before = snapshot(input);
            const supplied = input as Request.Input<typeof schema>;
            const outcome = yield* (
              binding === "path"
                ? path.execute({ path: supplied })
                : body.execute({ body: supplied })
            ).pipe(Effect.provide(lane.fetchClient), observe);
            const ledger = yield* backend.ledger;
            unchanged(input, before);
            expect(input[layout === "audit" ? 0 : 1]).toBe(leaf);
            if (layout === "sparse")
              expect(Object.hasOwn(input, 0)).toBe(false);
            expect({ outcome, requests: received(ledger) }).toMatchObject({
              outcome: { kind: "success", value: "Not Found" },
              requests: [{ method: binding === "path" ? "GET" : "POST" }],
            });
            expect(ledger).toHaveLength(1);
            wire(ledger[0]!, binding, expected);
          }),
      );
    }

    for (const position of positions) {
      const { schema } = position;
      for (const shape of symbolProfiles) {
        if (
          position.name !== "array" &&
          shape !== "normal iterator" &&
          shape !== "ordinary symbol"
        )
          continue;
        it.live(
          `[EXT-45e] ${binding} ${position.name} ${shape} valid input follows ordinary schema reading`,
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
              const outcomes = [];
              for (const leaf of [
                { page_size: "05", stray: "ignored" },
                { limit: 5, stray: "ignored" },
              ]) {
                const input = position.input(leaf);
                const watched = decorate(input, shape);
                const before = snapshot(input);
                const supplied = input as Request.Input<typeof schema>;
                outcomes.push(
                  yield* (
                    binding === "path"
                      ? path.execute({ path: supplied })
                      : body.execute({ body: supplied })
                  ).pipe(Effect.provide(lane.fetchClient), observe),
                );
                unchanged(input, before);
                expect(watched.calls()).toBe(0);
                if (shape === "equal descriptions") {
                  expect(watched.first).not.toBe(watched.second);
                  expect(
                    Object.getOwnPropertyDescriptor(input, watched.first)
                      ?.value,
                  ).toBe(7);
                  expect(
                    Object.getOwnPropertyDescriptor(input, watched.second)
                      ?.value,
                  ).toBe(8);
                }
              }
              const ledger = yield* backend.ledger;
              expect({ outcomes, requests: received(ledger) }).toMatchObject({
                outcomes: [
                  { kind: "success", value: "Not Found" },
                  { kind: "success", value: "Not Found" },
                ],
                requests: [{}, {}],
              });
              expect(ledger).toHaveLength(2);
              for (const entry of ledger)
                wire(entry, binding, position.json('{"page_size":"5"}'));
            }),
        );
      }
      it.live(
        `[EXT-45f] ${binding} ${position.name} string metadata cannot become an extra tuple cell`,
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
            const outcomes = [];
            const metadataNames =
              position.name === "array"
                ? ["audit", "01", "-1", "1.0", "4294967295"]
                : ["audit"];
            for (const name of metadataNames)
              for (const leaf of [
                { page_size: "05", stray: "ignored" },
                { limit: 5, stray: "ignored" },
              ]) {
                const input = position.input(leaf);
                const length = input.length;
                Object.defineProperty(input, name, {
                  value: 7,
                  enumerable: true,
                });
                expect(input.length).toBe(length);
                const before = snapshot(input);
                const supplied = input as Request.Input<typeof schema>;
                outcomes.push(
                  yield* (
                    binding === "path"
                      ? path.execute({ path: supplied })
                      : body.execute({ body: supplied })
                  ).pipe(Effect.provide(lane.fetchClient), observe),
                );
                unchanged(input, before);
              }
            const ledger = yield* backend.ledger;
            expect({ outcomes, requests: received(ledger) }).toMatchObject({
              outcomes: Array.from(
                { length: metadataNames.length * 2 },
                () => ({ kind: "success" }),
              ),
              requests: Array.from(
                { length: metadataNames.length * 2 },
                () => ({}),
              ),
            });
            expect(ledger).toHaveLength(metadataNames.length * 2);
            for (const entry of ledger)
              wire(entry, binding, position.json('{"page_size":"5"}'));
          }),
      );
    }
    it.live(
      `[EXT-45n] ${binding} valid inherited numeric cells remain readable with and without rewriting`,
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
          const outcomes = [];
          for (const stray of [false, true])
            for (const decoded of [false, true]) {
              const first = decoded ? { limit: 7 } : { page_size: "07" };
              const leaf = decoded
                ? { limit: 5, ...(stray ? { stray: "ignored" } : {}) }
                : { page_size: "05", ...(stray ? { stray: "ignored" } : {}) };
              const input = [first, leaf];
              delete input[0];
              const prototype = Object.create(Array.prototype, {
                "0": { value: first, enumerable: true },
              });
              Object.setPrototypeOf(input, prototype);
              const before = snapshot(input);
              const supplied = input as Request.Input<typeof Filters>;
              outcomes.push(
                yield* (
                  binding === "path"
                    ? path.execute({ path: supplied })
                    : body.execute({ body: supplied })
                ).pipe(Effect.provide(lane.fetchClient), observe),
              );
              unchanged(input, before);
              expect(Object.getPrototypeOf(input)).toBe(prototype);
              expect(Object.hasOwn(input, 0)).toBe(false);
              expect(
                Object.getOwnPropertyDescriptor(prototype, "0")?.value,
              ).toBe(first);
              expect(input[0]).toBe(first);
              expect(input[1]).toBe(leaf);
            }
          const ledger = yield* backend.ledger;
          expect({ outcomes, requests: received(ledger) }).toMatchObject({
            outcomes: Array.from({ length: 4 }, () => ({
              kind: "success",
              value: "Not Found",
            })),
            requests: [{}, {}, {}, {}],
          });
          expect(ledger).toHaveLength(4);
          for (const entry of ledger)
            wire(entry, binding, '[{"page_size":"7"},{"page_size":"5"}]');
        }),
    );

    for (const position of positions.filter(
      ({ name }) => name === "array" || name === "fixed" || name === "tail",
    )) {
      const { schema } = position;
      for (const shape of ["normal iterator", "watched iterator"] as const) {
        it.live(
          `[EXT-45o] currently ${binding} ${position.name} ${shape} invalid aliases expose unsupported defaults`,
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
              const outcomes = [];
              for (const stray of [false, true])
                for (const invalid of ["many", null]) {
                  const leaf = {
                    page_size: invalid,
                    ...(stray ? { stray: "ignored" } : {}),
                  };
                  const input = position.input(leaf);
                  const watched = decorate(input, shape);
                  const before = snapshot(input);
                  const supplied = input as Request.Input<typeof schema>;
                  outcomes.push(
                    yield* (
                      binding === "path"
                        ? path.execute({ path: supplied })
                        : body.execute({ body: supplied })
                    ).pipe(Effect.provide(lane.fetchClient), observe),
                  );
                  unchanged(input, before);
                  expect(watched.calls()).toBe(0);
                }
              const ledger = yield* backend.ledger;
              expect({ outcomes, requests: received(ledger) }).toMatchObject({
                outcomes: Array.from({ length: 4 }, () => ({
                  kind: "success",
                  value: "Not Found",
                })),
                requests: [{}, {}, {}, {}],
              });
              expect(ledger).toHaveLength(4);
              for (const entry of ledger)
                wire(entry, binding, position.json('{"page_size":"25"}'));
            }),
        );
      }
    }

    it.live.fails(
      `[EXT-45p] goal ${binding} invalid enumerable iterator aliases are kept or refused`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const outcomes = [];
          for (const position of positions.filter(
            ({ name }) =>
              name === "array" || name === "fixed" || name === "tail",
          )) {
            const { schema } = position;
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
            for (const shape of [
              "normal iterator",
              "watched iterator",
            ] as const)
              for (const stray of [false, true])
                for (const invalid of ["many", null]) {
                  const input = position.input({
                    page_size: invalid,
                    ...(stray ? { stray: "ignored" } : {}),
                  });
                  const watched = decorate(input, shape);
                  const before = snapshot(input);
                  const supplied = input as Request.Input<typeof schema>;
                  outcomes.push(
                    yield* (
                      binding === "path"
                        ? path.execute({ path: supplied })
                        : body.execute({ body: supplied })
                    ).pipe(Effect.provide(lane.fetchClient), observe),
                  );
                  unchanged(input, before);
                  expect(watched.calls()).toBe(0);
                }
          }
          // Invalid finite-number aliases cannot be kept by this schema. This known #170 goal
          // remains separate from the ordinary current-output pins using these exact fixtures.
          expect({
            outcomes,
            requests: received(yield* backend.ledger),
          }).toMatchObject({
            outcomes: Array.from({ length: 24 }, () => ({
              kind: "failure",
              error: { _tag: "SchemaError" },
            })),
            requests: [],
          });
        }),
    );

    it.live.fails(
      `[EXT-45q] goal ${binding} invalid sparse aliases are kept or refused with and without rewriting`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const path = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(
                OptionalFilters,
                (value, encode) => `/${encode(JSON.stringify(value))}`,
              ),
            ),
            response,
          );
          const body = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(OptionalFilters)),
            ),
            response,
          );
          const outcomes = [];
          for (const stray of [false, true]) {
            const input: Array<Cell | undefined> = [];
            input.length = 2;
            input[1] = {
              page_size: "many",
              ...(stray ? { stray: "ignored" } : {}),
            };
            const before = snapshot(input);
            outcomes.push(
              yield* (
                binding === "path"
                  ? path.execute({ path: input })
                  : body.execute({ body: input })
              ).pipe(Effect.provide(lane.fetchClient), observe),
            );
            unchanged(input, before);
            expect(Object.hasOwn(input, 0)).toBe(false);
          }
          expect({
            outcomes,
            requests: received(yield* backend.ledger),
          }).toMatchObject({
            outcomes: [
              { kind: "failure", error: { _tag: "SchemaError" } },
              { kind: "failure", error: { _tag: "SchemaError" } },
            ],
            requests: [],
          });
        }),
    );

    it.live(
      `[EXT-45g] ${binding} cyclic non-index metadata stays outside the real cells`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const cycle: { self?: unknown } = {};
          cycle.self = cycle;
          const leaf = { page_size: "05", stray: "ignored" };
          const input = [leaf];
          Object.defineProperty(input, "audit", {
            value: cycle,
            enumerable: true,
          });
          const before = snapshot(input);
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
          const outcome = yield* (
            binding === "path"
              ? path.execute({ path: input })
              : body.execute({ body: input })
          ).pipe(Effect.provide(lane.fetchClient), observe);
          const ledger = yield* backend.ledger;
          unchanged(input, before);
          expect(cycle.self).toBe(cycle);
          expect(input[0]).toBe(leaf);
          expect({ outcome, requests: received(ledger) }).toMatchObject({
            outcome: { kind: "success", value: "Not Found" },
            requests: [{}],
          });
          expect(ledger).toHaveLength(1);
          wire(ledger[0]!, binding, '[{"page_size":"5"}]');
        }),
    );

    it.live(
      `[EXT-45h] ${binding} covered invalid aliases with non-iterator symbol metadata refuse without dispatch`,
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
          const outcomes = [];
          for (const shape of ["ordinary symbol", "toStringTag"] as const)
            for (const value of ["many", null]) {
              const input = [{ page_size: value }];
              decorate(input, shape);
              const before = snapshot(input);
              const supplied = input as Request.Input<typeof Filters>;
              outcomes.push(
                yield* (
                  binding === "path"
                    ? path.execute({ path: supplied })
                    : body.execute({ body: supplied })
                ).pipe(Effect.provide(lane.fetchClient), observe),
              );
              unchanged(input, before);
            }
          expect({
            outcomes,
            requests: received(yield* backend.ledger),
          }).toMatchObject({
            outcomes: Array.from({ length: 4 }, () => ({
              kind: "failure",
              error: { _tag: "SchemaError" },
            })),
            requests: [],
          });
        }),
    );

    it.live(
      `[EXT-45i] currently ${binding} hidden iterators retain their unsupported default meaning`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const input = [{ page_size: "many" }];
          let calls = 0;
          Object.defineProperty(input, Symbol.iterator, {
            value: () => {
              calls++;
              return Array.prototype[Symbol.iterator].call(input);
            },
          });
          const before = snapshot(input);
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
            yield* (
              binding === "path"
                ? path.execute({ path: input })
                : body.execute({ body: input })
            ).pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          expect(calls).toBe(0);
          unchanged(input, before);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          wire(ledger[0]!, binding, '[{"page_size":"25"}]');
        }),
    );

    it.live(
      `[EXT-45j] currently ${binding} sparse invalid aliases take defaults with and without inner rewriting`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const path = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(
                OptionalFilters,
                (value, encode) => `/${encode(JSON.stringify(value))}`,
              ),
            ),
            response,
          );
          const body = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(OptionalFilters)),
            ),
            response,
          );
          const outcomes = [];
          for (const stray of [false, true]) {
            const input: Array<Cell | undefined> = [];
            input.length = 2;
            input[1] = stray
              ? { page_size: "many", stray: "ignored" }
              : { page_size: "many" };
            const before = snapshot(input);
            outcomes.push(
              yield* (
                binding === "path"
                  ? path.execute({ path: input })
                  : body.execute({ body: input })
              ).pipe(Effect.provide(lane.fetchClient), observe),
            );
            unchanged(input, before);
            expect(Object.hasOwn(input, 0)).toBe(false);
          }
          const ledger = yield* backend.ledger;
          expect(outcomes).toMatchObject([
            { kind: "success", value: "Not Found" },
            { kind: "success", value: "Not Found" },
          ]);
          // The inner-stray case refused on published14. Restored layout now exposes the
          // same unsupported sparse default as the no-stray control; #170 remains open.
          expect(ledger).toHaveLength(2);
          for (const entry of ledger)
            wire(entry, binding, '[null,{"page_size":"25"}]');
        }),
    );

    it.live(
      `[EXT-45k] ${binding} plain text arrays bypass rewriting and retain metadata access observations`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const input = ["a/b", "tail"];
          let reads = 0;
          const key = Symbol("audit");
          Object.defineProperty(input, key, {
            enumerable: true,
            get: () => {
              reads++;
              return 7;
            },
          });
          const before = snapshot(input);
          const schema = Schema.Array(Schema.String);
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
            yield* (
              binding === "path"
                ? path.execute({ path: input })
                : body.execute({ body: input })
            ).pipe(Effect.provide(lane.fetchClient)),
          ).toBe("Not Found");
          unchanged(input, before);
          // This is only the observed no-reader-choice route, not a general no-getter promise.
          expect(reads).toBe(0);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          wire(ledger[0]!, binding, '["a/b","tail"]');
        }),
    );
    it.live(
      `[EXT-45m] ${binding} a real numeric cell remains subject to its element schema`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const input = [{ page_size: "05" }, 7];
          const before = snapshot(input);
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
          // @ts-expect-error Deliberately test a real element that is invalid on either input side.
          const supplied: Request.Input<typeof Filters> = input;
          const effect =
            binding === "path"
              ? path.execute({ path: supplied })
              : body.execute({ body: supplied });
          const outcome = yield* effect.pipe(
            Effect.provide(lane.fetchClient),
            observe,
          );
          expect(outcome).toMatchObject({
            kind: "failure",
            error: { _tag: "SchemaError" },
          });
          expect("message" in outcome ? outcome.message : undefined).toContain(
            "[1]",
          );
          unchanged(input, before);
          expect(input.length).toBe(2);
          expect(Object.hasOwn(input, 1)).toBe(true);
          expect(yield* backend.ledger).toEqual([]);
        }),
    );

    it.live(
      `[EXT-45r] ${binding} fully own dense proxy arrays retain valid alias reading when prototype reflection throws`,
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
          const outcomes = [];
          const prototypeReads = [];
          for (const stray of [false, true]) {
            const leaf = {
              page_size: "05",
              ...(stray ? { stray: "ignored" } : {}),
            };
            const target = [leaf];
            let reads = 0;
            const input = new Proxy(target, {
              getPrototypeOf: () => {
                reads++;
                throw new Error("dense prototype unavailable");
              },
            });
            const before = snapshot(input);
            outcomes.push(
              yield* (
                binding === "path"
                  ? path.execute({ path: input })
                  : body.execute({ body: input })
              ).pipe(Effect.provide(lane.fetchClient), observe),
            );
            prototypeReads.push(reads);
            // Never pass this proxy to a deep-equality matcher: that would itself inspect its
            // prototype and replace the library observation with a test-fixture exception.
            unchanged(input, before);
            expect(input.length).toBe(1);
            expect(Object.hasOwn(input, 0)).toBe(true);
            expect(input[0]).toBe(leaf);
            expect(target[0]).toBe(leaf);
          }
          const ledger = yield* backend.ledger;
          // The observation records prototype probes, but promises no exact total reflection
          // count. Existing best-effort metadata probes can catch their own reflection errors.
          expect({
            outcomes,
            prototypeReads,
            requests: received(ledger),
          }).toMatchObject({
            outcomes: [
              { kind: "success", value: "Not Found" },
              { kind: "success", value: "Not Found" },
            ],
            requests: [{}, {}],
          });
          expect(ledger).toHaveLength(2);
          for (const entry of ledger)
            wire(entry, binding, '[{"page_size":"5"}]');
        }),
    );

    it.live(
      `[EXT-45t] ${binding} a virtual own index beyond array length keeps its control and refuses incoherent rewriting`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const rendered: Array<{
            length: number;
            first: unknown;
            second: unknown;
            high: unknown;
          }> = [];
          const path = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(OptionalFilters, (value, encode) => {
                rendered.push({
                  length: value.length,
                  first: value[0],
                  second: value[1],
                  high: value[1000],
                });
                return `/${encode(JSON.stringify(value))}`;
              }),
            ),
            response,
          );
          const body = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(OptionalFilters)),
            ),
            response,
          );
          for (const stray of [false, true]) {
            const leaf = {
              page_size: "05",
              ...(stray ? { stray: "ignored" } : {}),
            };
            const ghost = { page_size: "07" };
            const target = [leaf];
            const input = new Proxy(target, {
              ownKeys: (array) => [...Reflect.ownKeys(array), "1000"],
              getOwnPropertyDescriptor: (array, key) =>
                key === "1000"
                  ? {
                      value: ghost,
                      enumerable: true,
                      writable: true,
                      configurable: true,
                    }
                  : Reflect.getOwnPropertyDescriptor(array, key),
              get: (array, key, receiver) =>
                key === "1000" ? ghost : Reflect.get(array, key, receiver),
              has: (array, key) => key === "1000" || Reflect.has(array, key),
            });
            const before = snapshot(input);
            const outcome = yield* (
              binding === "path"
                ? path.execute({ path: input })
                : body.execute({ body: input })
            ).pipe(Effect.provide(lane.fetchClient), observe);
            const ledger = yield* backend.ledger;
            unchanged(input, before);
            expect(input.length).toBe(1);
            expect(input[0]).toBe(leaf);
            expect(input[1000]).toBe(ghost);
            expect(Object.hasOwn(input, 1000)).toBe(true);
            expect(1000 in input).toBe(true);
            expect(target.length).toBe(1);
            expect(Object.hasOwn(target, 1000)).toBe(false);
            if (!stray) {
              expect(outcome).toEqual({ kind: "success", value: "Not Found" });
              expect(ledger).toHaveLength(1);
              wire(ledger[0]!, binding, '[{"page_size":"5"}]');
              if (binding === "path")
                expect(rendered).toEqual([
                  {
                    length: 1,
                    first: { page_size: "5" },
                    second: undefined,
                    high: undefined,
                  },
                ]);
              rendered.length = 0;
            } else {
              const extra = ledger.slice(1);
              const delivered = extra.map((entry) => {
                const json =
                  binding === "path"
                    ? decodeURIComponent(entry.target.slice("/x/".length))
                    : new TextDecoder().decode(entry.body);
                const cells: unknown[] = JSON.parse(json);
                return {
                  length: cells.length,
                  first: cells[0],
                  second: cells[1],
                  high: cells[1000],
                  json,
                };
              });
              expect({
                outcome,
                rendered,
                delivered,
                requests: received(extra),
              }).toMatchObject({
                outcome: { kind: "failure", error: { _tag: "SchemaError" } },
                rendered: [],
                delivered: [],
                requests: [],
              });
              expect(ledger).toHaveLength(1);
            }
          }
        }),
    );

    it.live(
      `[EXT-45u] ${binding} sparse proxy prototype failure propagates its original evaluation defect`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const leaf = { page_size: "05", stray: "ignored" };
          const target: Array<Cell | undefined> = [];
          target.length = 2;
          target[1] = leaf;
          const reflectionError = new Error("sparse prototype unavailable");
          let prototypeReads = 0;
          const input = new Proxy(target, {
            getPrototypeOf: () => {
              prototypeReads++;
              throw reflectionError;
            },
          });
          const before = snapshot(input);
          let renders = 0;
          const path = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(OptionalFilters, (value, encode) => {
                renders++;
                return `/${encode(JSON.stringify(value))}`;
              }),
            ),
            response,
          );
          const body = Operation.make(
            Request.post(`${backend.origin}/x`).pipe(
              Request.body(Body.jsonSchema(OptionalFilters)),
            ),
            response,
          );
          let phase = "execute call";
          const exit = yield* Effect.suspend(() => {
            const effect =
              binding === "path"
                ? path.execute({ path: input })
                : body.execute({ body: input });
            phase = "effect evaluation";
            return effect;
          }).pipe(Effect.provide(lane.fetchClient), Effect.exit);
          unchanged(input, before);
          expect(input.length).toBe(2);
          expect(Object.hasOwn(input, 0)).toBe(false);
          expect(input[1]).toBe(leaf);
          expect({
            phase,
            tag: exit._tag,
            renders,
            requests: received(yield* backend.ledger),
          }).toMatchObject({
            phase: "effect evaluation",
            tag: "Failure",
            renders: 0,
            requests: [],
          });
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons).toHaveLength(1);
            const reason = exit.cause.reasons[0];
            expect(reason?._tag).toBe("Die");
            if (reason?._tag === "Die")
              expect(reason.defect).toBe(reflectionError);
          }
          expect(prototypeReads).toBeGreaterThan(0);
        }),
    );
  }

  it.live(
    "[EXT-45s] an opaque throwing array retains identity behind a parent rename and encoded count",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const cell = { keep: "opaque" };
        const target = [cell];
        let lengthReads = 0;
        let prototypeReads = 0;
        const opaque = new Proxy(target, {
          get: (array, key, receiver) => {
            if (key === "length") {
              lengthReads++;
              throw new Error("opaque length unavailable");
            }
            return Reflect.get(array, key, receiver);
          },
          getPrototypeOf: () => {
            prototypeReads++;
            throw new Error("opaque prototype unavailable");
          },
        });
        const schema = Schema.Struct({
          values: Schema.Unknown,
          count: Schema.FiniteFromString,
          tag: Schema.optionalKey(Schema.String),
        }).pipe(Schema.encodeKeys({ tag: "TAG" }));
        const identities: boolean[] = [];
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(schema, (value, encode) => {
              identities.push(value.values === opaque);
              return `/count/${encode(value.count)}`;
            }),
          ),
          response,
        );
        const input = { values: opaque, count: "05" };
        const outcome = yield* operation
          .execute({ path: input })
          .pipe(Effect.provide(lane.fetchClient), observe);
        const ledger = yield* backend.ledger;
        expect(input.values === opaque).toBe(true);
        expect(input.count).toBe("05");
        expect(target.length).toBe(1);
        expect(target[0]).toBe(cell);
        expect({
          outcome,
          identities,
          lengthReads,
          prototypeReads,
          requests: received(ledger),
        }).toMatchObject({
          outcome: { kind: "success", value: "Not Found" },
          identities: [true],
          lengthReads: 0,
          prototypeReads: 0,
          requests: [{ method: "GET", target: "/x/count/5" }],
        });
        expect(ledger).toHaveLength(1);
        expect(headerValues(ledger[0]!.lines, "accept")).toEqual([
          "text/plain",
        ]);
        expect(headerValues(ledger[0]!.lines, "content-type")).toEqual([]);
        expect(ledger[0]!.body).toEqual(new Uint8Array());
      }),
  );

  it.live(
    "[EXT-45l] declared object symbols retain identity in path reading and error locations",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const first = Symbol("field");
        const second = Symbol("field");
        const schema = Schema.Struct({
          [first]: Schema.FiniteFromString,
          [second]: Schema.String,
        });
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              schema,
              (value, encode) =>
                `/${encode(value[first])}/${encode(value[second])}`,
            ),
          ),
          response,
        );
        const good = { [first]: "05", [second]: "keep/second" };
        expect(
          yield* operation
            .execute({ path: good })
            .pipe(Effect.provide(lane.fetchClient)),
        ).toBe("Not Found");
        const invalid = yield* operation
          .execute({ path: { [first]: "many", [second]: "keep/second" } })
          .pipe(Effect.provide(lane.fetchClient), observe);
        expect(invalid).toMatchObject({
          kind: "failure",
          error: { _tag: "SchemaError" },
        });
        if (invalid.kind === "failure" && Schema.isSchemaError(invalid.error)) {
          const keys = issueKeys(invalid.error.issue);
          expect(keys).toContain(first);
          expect(keys).not.toContain(second);
          expect(keys).not.toContain("Symbol(field)");
        }
        expect(first).not.toBe(second);
        expect(Reflect.ownKeys(good)).toEqual([first, second]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.method).toBe("GET");
        expect(ledger[0]!.target).toBe("/x/5/keep%2Fsecond");
        expect(headerValues(ledger[0]!.lines, "accept")).toEqual([
          "text/plain",
        ]);
        expect(headerValues(ledger[0]!.lines, "content-type")).toEqual([]);
        expect(ledger[0]!.body).toEqual(new Uint8Array());
      }),
  );

  for (const [name, view] of mixedViews) {
    const schema = mixedParent(view);
    for (const profile of ["hidden", "inherited"] as const) {
      it.live(
        `[EXT-45v] ${name} keeps ${profile} opaque array cells and extras before reading another alternative`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const { values, cell } = mixedArray(profile);
            const before = snapshot(values);
            const rendered: Array<{
              sameArray: boolean;
              sameCell: boolean;
              extra: unknown;
            }> = [];
            const operation = Operation.make(
              Request.get(`${backend.origin}/x`).pipe(
                Request.path(schema, (value, encode) => {
                  if (!Array.isArray(value.values))
                    throw new Error("expected the mixed array value");
                  rendered.push({
                    sameArray: value.values === values,
                    sameCell: value.values[0] === cell,
                    extra: value.values[0]?.additional,
                  });
                  return `/mixed/${encode(value.count)}/${encode(JSON.stringify(value.values))}`;
                }),
              ),
              response,
            );
            const outcome = yield* operation
              .execute({ path: { values, count: "05" } })
              .pipe(Effect.provide(lane.fetchClient), observe);
            const ledger = yield* backend.ledger;
            unchanged(values, before);
            expect(values[0]).toBe(cell);
            expect(cell.additional).toBe("retain");
            expect({
              outcome,
              rendered,
              requests: received(ledger),
            }).toMatchObject({
              outcome: { kind: "success", value: "Not Found" },
              rendered: [{ sameArray: true, sameCell: true, extra: "retain" }],
              requests: [{}],
            });
            expect(ledger).toHaveLength(1);
            textPathWire(
              ledger[0]!,
              `/x/mixed/5/${encodeURIComponent('[{"VALUE":5,"additional":"retain"}]')}`,
            );
          }),
      );
    }
    it.live(
      `[EXT-45w] control ${name} enumerable mixed cells retain their existing normalized interpretation`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const { values, cell } = mixedArray("enumerable");
          const before = snapshot(values);
          const rendered: Array<{
            sameArray: boolean;
            sameCell: boolean;
            extra: unknown;
          }> = [];
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(schema, (value, encode) => {
                if (!Array.isArray(value.values))
                  throw new Error("expected the mixed array value");
                rendered.push({
                  sameArray: value.values === values,
                  sameCell: value.values[0] === cell,
                  extra: value.values[0]?.additional,
                });
                return `/mixed/${encode(value.count)}/${encode(JSON.stringify(value.values))}`;
              }),
            ),
            response,
          );
          const outcome = yield* operation
            .execute({ path: { values, count: "05" } })
            .pipe(Effect.provide(lane.fetchClient), observe);
          const ledger = yield* backend.ledger;
          unchanged(values, before);
          expect(cell.additional).toBe("retain");
          expect({
            outcome,
            rendered,
            requests: received(ledger),
          }).toMatchObject({
            outcome: { kind: "success", value: "Not Found" },
            rendered: [{ sameArray: false, sameCell: false, extra: undefined }],
            requests: [{}],
          });
          expect(ledger).toHaveLength(1);
          textPathWire(
            ledger[0]!,
            `/x/mixed/5/${encodeURIComponent('[{"VALUE":5}]')}`,
          );
        }),
    );
  }

  for (const opaque of [
    "checked Unknown",
    "Declaration",
    "closed array",
  ] as const) {
    for (const binding of ["path", "JSON"] as const) {
      // Keep the Declaration case on the path API so its opaque reading, checks and array
      // alternative are tested directly without adding a serialization contract to the fixture.
      if (opaque === "Declaration" && binding === "JSON") continue;
      it.live(
        `[EXT-45x] ${binding} ${opaque} rejection still permits valid dense array reading and rejects invalid cells`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            let rejected = 0;
            const RejectUnknown = Schema.Unknown.check(
              Schema.makeFilter(() => {
                rejected++;
                return false;
              }),
            );
            const RejectDeclaration = Schema.declare(
              (_value): _value is ReadonlyArray<unknown> => {
                rejected++;
                return false;
              },
            );
            const member =
              opaque === "closed array"
                ? MixedCells
                : opaque === "checked Unknown"
                  ? Schema.Union([RejectUnknown, MixedCells])
                  : Schema.Union([RejectDeclaration, MixedCells]);
            const schema = mixedParent(member);
            const path = Operation.make(
              Request.get(`${backend.origin}/x`).pipe(
                Request.path(
                  schema,
                  (value, encode) => `/${encode(JSON.stringify(value))}`,
                ),
              ),
              response,
            );
            const body =
              binding === "JSON"
                ? Operation.make(
                    Request.post(`${backend.origin}/x`).pipe(
                      Request.body(Body.jsonSchema(schema)),
                    ),
                    response,
                  )
                : undefined;
            const outcomes = [];
            for (const decoded of [false, true])
              for (const valid of [true, false]) {
                const value = valid ? 5 : "many";
                const values = [
                  decoded
                    ? { value, additional: "ignored" }
                    : { VALUE: value, additional: "ignored" },
                ];
                Object.defineProperty(values, "audit", {
                  value: 7,
                  enumerable: true,
                });
                const before = snapshot(values);
                const supplied = {
                  values,
                  count: decoded ? 5 : "05",
                } as Request.Input<typeof schema>;
                outcomes.push(
                  yield* (
                    binding === "path"
                      ? path.execute({ path: supplied })
                      : body!.execute({ body: supplied })
                  ).pipe(Effect.provide(lane.fetchClient), observe),
                );
                unchanged(values, before);
              }
            const ledger = yield* backend.ledger;
            if (opaque !== "closed array") expect(rejected).toBeGreaterThan(0);
            expect({ outcomes, requests: received(ledger) }).toMatchObject({
              outcomes: [
                { kind: "success", value: "Not Found" },
                { kind: "failure", error: { _tag: "SchemaError" } },
                { kind: "success", value: "Not Found" },
                { kind: "failure", error: { _tag: "SchemaError" } },
              ],
              requests: [{}, {}],
            });
            expect(ledger).toHaveLength(2);
            for (const entry of ledger)
              wire(entry, binding, '{"values":[{"VALUE":5}],"count":"5"}');
          }),
      );
    }
  }

  for (const reflection of ["length", "hidden cell", "prototype"] as const) {
    it.live(
      `[EXT-45y] an accepting opaque alternative avoids ${reflection} reflection through a mixed array view`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const cell = { VALUE: 5, additional: "retain" };
          const target: unknown[] = [];
          if (reflection === "prototype") {
            target.length = 2;
            target[1] = cell;
          } else {
            target.push(cell);
            Object.defineProperty(target, "0", { enumerable: false });
          }
          let forbiddenReads = 0;
          const values = new Proxy(target, {
            get: (array, key, receiver) => {
              if (
                (reflection === "length" && key === "length") ||
                (reflection === "hidden cell" && key === "0")
              ) {
                forbiddenReads++;
                throw new Error(`mixed ${reflection} unavailable`);
              }
              return Reflect.get(array, key, receiver);
            },
            getPrototypeOf: (array) => {
              if (reflection === "prototype") {
                forbiddenReads++;
                throw new Error("mixed prototype unavailable");
              }
              return Reflect.getPrototypeOf(array);
            },
          });
          const schema = mixedParent(
            Schema.Union([Schema.Unknown, MixedCells]),
          );
          const identities: boolean[] = [];
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(schema, (value, encode) => {
                identities.push(value.values === values);
                return `/mixed/${encode(value.count)}`;
              }),
            ),
            response,
          );
          const input = { values, count: "05" };
          const outcome = yield* operation
            .execute({ path: input })
            .pipe(Effect.provide(lane.fetchClient), observe);
          const ledger = yield* backend.ledger;
          expect(input.values === values).toBe(true);
          expect(target.length).toBe(reflection === "prototype" ? 2 : 1);
          expect(target[reflection === "prototype" ? 1 : 0]).toBe(cell);
          expect(cell.additional).toBe("retain");
          // The prototype fixture has an enumerable rewriting cell: its existing normalized
          // clone is intentional. Hidden cells in the other two profiles retain the opaque value.
          expect({
            outcome,
            identities,
            forbiddenReads,
            requests: received(ledger),
          }).toMatchObject({
            outcome: { kind: "success", value: "Not Found" },
            identities: [reflection !== "prototype"],
            forbiddenReads: 0,
            requests: [{}],
          });
          expect(ledger).toHaveLength(1);
          textPathWire(ledger[0]!, "/x/mixed/5");
        }),
    );
  }

  it.live(
    "[EXT-45z] an encoded-array-backed Declaration keeps ordinary reading without unnecessary prototype reflection",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const codec = Schema.Array(Schema.Unknown).pipe(
          Schema.decodeTo(OpaqueArray, {
            decode: SchemaGetter.transform((value) => value),
            encode: SchemaGetter.transform((value) => value),
          }),
        );
        const ordinary = [{ keep: "round trip" }];
        const decoded = yield* Schema.decodeUnknownEffect(codec)(ordinary);
        const encoded = yield* Schema.encodeEffect(codec)(decoded);
        expect(encoded).toHaveLength(1);
        expect(encoded[0]).toBe(ordinary[0]);
        const target: unknown[] = [];
        target.length = 1;
        const values = new Proxy(target, {
          getPrototypeOf: () => {
            throw new Error("declaration prototype unavailable");
          },
        });
        const schema = mixedParent(codec);
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              schema,
              (value, encode) => `/mixed/${encode(value.count)}`,
            ),
          ),
          response,
        );
        const outcome = yield* operation
          .execute({ path: { values, count: "05" } })
          .pipe(Effect.provide(lane.fetchClient), observe);
        const ledger = yield* backend.ledger;
        expect(target.length).toBe(1);
        expect(Object.hasOwn(target, 0)).toBe(false);
        expect({ outcome, requests: received(ledger) }).toMatchObject({
          outcome: { kind: "success", value: "Not Found" },
          requests: [{}],
        });
        expect(ledger).toHaveLength(1);
        textPathWire(ledger[0]!, "/x/mixed/5");
        const invalid =
          yield* Schema.decodeUnknownEffect(codec)("not an array").pipe(
            observe,
          );
        expect(invalid).toMatchObject({
          kind: "failure",
          error: { _tag: "SchemaError" },
        });
        expect(yield* backend.ledger).toHaveLength(1);
      }),
  );

  it.live(
    "[EXT-46a] mixed opaque enumerable rewriting avoids adding a length getter read",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const schema = mixedParent(Schema.Union([Schema.Unknown, MixedCells]));
        const outcomes = [];
        const identities: boolean[] = [];
        const reads: number[] = [];
        for (const rewrite of [false, true]) {
          const cell = {
            VALUE: 5,
            ...(rewrite ? { additional: "retain" } : {}),
          };
          const target = [cell];
          let lengthReads = 0;
          const values = new Proxy(target, {
            get: (array, key, receiver) => {
              if (key === "length") {
                lengthReads++;
                throw new Error("mixed clone length unavailable");
              }
              return Reflect.get(array, key, receiver);
            },
          });
          const operation = Operation.make(
            Request.get(`${backend.origin}/x`).pipe(
              Request.path(schema, (value, encode) => {
                identities.push(value.values === values);
                return `/mixed/${encode(value.count)}`;
              }),
            ),
            response,
          );
          outcomes.push(
            yield* operation
              .execute({ path: { values, count: "05" } })
              .pipe(Effect.provide(lane.fetchClient), observe),
          );
          reads.push(lengthReads);
          expect(Object.getOwnPropertyDescriptor(values, "length")?.value).toBe(
            1,
          );
          expect(target.length).toBe(1);
          expect(target[0]).toBe(cell);
          expect(Object.getOwnPropertyDescriptor(target, "0")?.enumerable).toBe(
            true,
          );
        }
        const ledger = yield* backend.ledger;
        expect({
          outcomes,
          identities,
          reads,
          requests: received(ledger),
        }).toMatchObject({
          outcomes: [
            { kind: "success", value: "Not Found" },
            { kind: "success", value: "Not Found" },
          ],
          identities: [true, false],
          reads: [0, 0],
          requests: [{}, {}],
        });
        expect(ledger).toHaveLength(2);
        for (const entry of ledger) textPathWire(entry, "/x/mixed/5");
      }),
  );

  for (const binding of ["path", "JSON"] as const) {
    it.live(
      `[EXT-46b] ${binding} structural array reading preserves readable length beyond its native descriptor`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const cell = { VALUE: 5, additional: "ignored" };
          const target = [cell];
          const values = new Proxy(target, {
            get: (array, key, receiver) =>
              key === "length" ? 3 : Reflect.get(array, key, receiver),
          });
          const before = snapshot(values);
          const schema = mixedParent(Schema.Array(Schema.optional(MixedCell)));
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
          const outcome = yield* (
            binding === "path"
              ? path.execute({ path: { values, count: "05" } })
              : body.execute({ body: { values, count: "05" } })
          ).pipe(Effect.provide(lane.fetchClient), observe);
          const ledger = yield* backend.ledger;
          unchanged(values, before);
          expect(values.length).toBe(3);
          expect(Object.getOwnPropertyDescriptor(values, "length")?.value).toBe(
            1,
          );
          expect(target.length).toBe(1);
          expect(target[0]).toBe(cell);
          expect(Object.hasOwn(target, 1)).toBe(false);
          expect(Object.hasOwn(target, 2)).toBe(false);
          expect({ outcome, requests: received(ledger) }).toMatchObject({
            outcome: { kind: "success", value: "Not Found" },
            requests: [{}],
          });
          expect(ledger).toHaveLength(1);
          wire(
            ledger[0]!,
            binding,
            '{"values":[{"VALUE":5},null,null],"count":"5"}',
          );
        }),
    );
  }
});
