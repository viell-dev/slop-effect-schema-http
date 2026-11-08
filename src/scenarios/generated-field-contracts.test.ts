/**
 * EXT-33: direct structs that generate omitted fields, checked through the customer list's public
 * contract and real HTTP in both lanes. Iterable output is consumed as entries, not own fields.
 * Service documentation: services/business.md
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaGetter } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const customers = [
  { id: 1001, name: "Wire Works", tier: "STANDARD" },
  { id: 1002, name: "Cedar Trading", tier: "GOLD" },
  { id: 1003, name: "Other Imports", tier: "SILVER" },
];
const start = () =>
  lane.backend(
    "business",
    { envelopes: { customers } },
    { listener: "socket" },
  );
const at = (origin: string) => Request.get(`${origin}/v1/customers`);
const response = Response.status(
  200,
  Body.jsonSchema(
    Schema.Struct({
      customers: Schema.Array(
        Schema.Struct({ id: Schema.Number, name: Schema.String }),
      ),
    }),
  ),
);
const sent = <I, E>(
  build: (origin: string) => Request.Request<I, E>,
  input: I,
) =>
  Effect.gen(function* () {
    const backend = yield* start();
    const value = yield* Operation.make(build(backend.origin), response)
      .execute(input)
      .pipe(Effect.provide(lane.fetchClient));
    return { value, ledger: yield* backend.ledger };
  });
type Checked = Request.Request<
  never,
  Schema.SchemaError | Request.InvalidRequest
>;
const refused = (build: (origin: string) => Checked, input: unknown) =>
  Effect.gen(function* () {
    const backend = yield* start();
    const error = yield* Operation.make(build(backend.origin), response)
      .execute(input as never)
      .pipe(
        Effect.provide(lane.fetchClient),
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => undefined,
        }),
      );
    return { error, ledger: yield* backend.ledger };
  });
const expectRefusal = (
  result: { readonly error: unknown; readonly ledger: ReadonlyArray<Recorded> },
  name: string,
) => {
  expect(result.ledger).toEqual([]);
  expect(result.error).toBeInstanceOf(Request.InvalidRequest);
  expect(String(result.error)).toContain(JSON.stringify(name));
  expect(JSON.stringify(result.error)).not.toContain("hidden-edit");
};
const expectWire = (ledger: ReadonlyArray<Recorded>, target: string) => {
  expect(ledger).toHaveLength(1);
  const entry = ledger[0]!;
  expect(entry.method).toBe("GET");
  expect(entry.target).toBe(target);
  expect(headerValues(entry.lines, "accept")).toEqual(["application/json"]);
  expect(entry.body.byteLength).toBe(0);
};
const names = (value: {
  readonly customers: ReadonlyArray<{ readonly name: string }>;
}) => value.customers.map(({ name }) => name);

/** A handwritten default with a genuine encode step rather than a passthrough marker. */
const decodingDefault = () =>
  Schema.optionalKey(Schema.String).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformOptional((input) => {
        if (Option.isSome(input)) return input;
        return Option.some("1");
      }),
      encode: SchemaGetter.transform((value) => value),
    }),
  );
const GeneratedQuery = Schema.Struct({ per_page: decodingDefault() });
const GeneratedHeaders = Schema.Struct({
  Accept: Schema.optionalKey(Schema.String).pipe(
    Schema.encodeTo(Schema.optionalKey(Schema.String), {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.transformOptional((input) =>
        Option.isSome(input) ? input : Option.some("application/json"),
      ),
    }),
  ),
});
const empty = function* (): Generator<readonly [string, string]> {};

describe(`generated field contracts (${lane.name})`, () => {
  for (const [edit, apply] of [
    ["set", Request.setQuery("per_page", "hidden-edit")],
    ["append", Request.appendQuery("per_page", "hidden-edit")],
    ["remove", Request.removeQuery("per_page")],
  ] as const) {
    it.live(
      `[EXT-33a] a handwritten decoding default refuses a later query ${edit} before dispatch`,
      () =>
        Effect.gen(function* () {
          const result = yield* refused(
            (origin) => at(origin).pipe(Request.query(GeneratedQuery), apply),
            {},
          );
          expectRefusal(result, "per_page");
        }),
    );
  }

  it.live(
    "[EXT-33b] an encode-only generated header refuses later set and removal regardless of case",
    () =>
      Effect.gen(function* () {
        for (const apply of [
          Request.setHeader("aCCEPT", "hidden-edit"),
          Request.removeHeader("ACCEPT"),
        ]) {
          const result = yield* refused(
            (origin) =>
              at(origin).pipe(Request.headers(GeneratedHeaders), apply),
            {},
          );
          expectRefusal(result, "accept");
        }
      }),
  );

  it.live(
    "[EXT-33c] mixed decoded input still refuses a generated field's later raw edit without rerunning its default",
    () =>
      Effect.gen(function* () {
        let defaults = 0;
        const Query = Schema.Struct({
          name: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                defaults++;
                return "Wire";
              }),
            ),
          ),
          page: Schema.FiniteFromString,
          per_page: Schema.FiniteFromString,
        });
        // One numeric field needs decoding while the other is already decoded.
        const ordinary = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(Query),
              Request.setHeader("Accept", "application/json"),
            ),
          { query: { page: "1", per_page: 2 } },
        );
        expect(names(ordinary.value)).toEqual(["Wire Works"]);
        expectWire(
          ordinary.ledger,
          "/v1/customers?name=Wire&page=1&per_page=2",
        );
        const ordinaryCalls = defaults;
        expect(ordinaryCalls).toBeGreaterThan(0);
        defaults = 0;
        const result = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(Query),
              Request.setQuery("name", "hidden-edit"),
            ),
          { query: { page: "1", per_page: 2 } },
        );
        expectRefusal(result, "name");
        expect(defaults).toBe(ordinaryCalls);
      }),
  );

  it.live(
    "[EXT-33d] control: generated values, pre-binding defaults and explicit caller values reach the customer list",
    () =>
      Effect.gen(function* () {
        const ordinary = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(GeneratedQuery),
              Request.headers(GeneratedHeaders),
            ),
          {},
        );
        expect(names(ordinary.value)).toEqual(["Wire Works"]);
        expectWire(ordinary.ledger, "/v1/customers?per_page=1");
        const before = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.setQuery("per_page", "2"),
              Request.setHeader("Accept", "text/plain"),
              Request.query(GeneratedQuery),
              Request.headers(GeneratedHeaders),
            ),
          {},
        );
        expect(names(before.value)).toEqual(["Wire Works"]);
        expectWire(before.ledger, "/v1/customers?per_page=1");
        const explicit = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(GeneratedQuery),
              Request.headers(GeneratedHeaders),
              Request.setQuery("per_page", "2"),
              Request.setHeader("Accept", "text/plain"),
            ),
          { query: { per_page: "3" }, headers: { Accept: "application/json" } },
        );
        expect(names(explicit.value)).toEqual(
          customers.map(({ name }) => name),
        );
        expectWire(explicit.ledger, "/v1/customers?per_page=3");
      }),
  );

  it.live(
    "[EXT-33e] control: a decoder fallback that generates no field keeps a later raw query value",
    () =>
      Effect.gen(function* () {
        const Query = Schema.Struct({
          per_page: Schema.optionalKey(Schema.String),
          page: Schema.FiniteFromString,
        });
        const { value, ledger } = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(Query),
              Request.setQuery("per_page", "2"),
              Request.setHeader("Accept", "application/json"),
            ),
          { query: { page: "1" } },
        );
        expect(names(value)).toEqual(["Wire Works", "Cedar Trading"]);
        expectWire(ledger, "/v1/customers?per_page=2&page=1");
      }),
  );

  it.live(
    "[EXT-33f] control: an empty iterable direct struct sends no own generated query field and permits removal",
    () =>
      Effect.gen(function* () {
        const Iterator = Schema.declare(
          (value): value is typeof empty => typeof value === "function",
        );
        const Query = Schema.Struct({
          per_page: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("1")),
          ),
          [Symbol.iterator]: Iterator.pipe(
            Schema.withConstructorDefault(Effect.succeed(empty)),
          ),
        });
        const { value, ledger } = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(Query),
              Request.removeQuery("per_page"),
              Request.setHeader("Accept", "application/json"),
            ),
          {},
        );
        expect(names(value)).toEqual(["Wire Works", "Cedar Trading"]);
        expectWire(ledger, "/v1/customers");
      }),
  );
});
