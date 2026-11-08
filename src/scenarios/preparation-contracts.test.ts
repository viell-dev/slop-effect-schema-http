/**
 * EXT-32: candidate request preparation over real sockets in both lanes. The business service's
 * documented customer list reads page/per_page/name and always answers JSON. Seeded customers
 * supply the response controls.
 * Service documentation: services/business.md
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
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
      .pipe(Effect.provide(lane.fetchClient), Effect.flip);
    return { error, ledger: yield* backend.ledger };
  });

/** Every successful call sends one complete GET with no body and one JSON Accept line. */
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

const OptionalQuery = Schema.Struct({
  page: Schema.optionalKey(Schema.FiniteFromString),
  per_page: Schema.optionalKey(Schema.FiniteFromString),
});
const OptionalHeaders = Schema.Struct({
  Accept: Schema.optionalKey(Schema.String),
});
const ConstructorQuery = Schema.Struct({
  per_page: Schema.optionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed("1")),
  ),
});
const ConstructorHeaders = Schema.Struct({
  Accept: Schema.optionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed("application/json")),
  ),
});

const optionalAt = (origin: string) =>
  at(origin).pipe(
    Request.query(OptionalQuery),
    Request.headers(OptionalHeaders),
  );
const optionalWithDefaults = (origin: string) =>
  at(origin).pipe(
    Request.setQuery("per_page", "1"),
    Request.setHeader("Accept", "application/json"),
    Request.query(OptionalQuery),
    Request.headers(OptionalHeaders),
  );

describe(`candidate preparation contracts (${lane.name})`, () => {
  it.live(
    "[EXT-32a] omitted and undefined optional query/header groups reach the customer list",
    () =>
      Effect.gen(function* () {
        for (const input of [
          {},
          { query: undefined, headers: undefined } as never,
        ]) {
          const { value, ledger } = yield* sent(optionalAt, input);
          expect(names(value)).toEqual(["Wire Works", "Cedar Trading"]);
          expectWire(ledger, "/v1/customers");
        }
      }),
  );

  it.live(
    "[EXT-32a] omitted optional groups keep validated raw defaults and accept explicit overrides",
    () =>
      Effect.gen(function* () {
        const omitted = yield* sent(optionalWithDefaults, {});
        expect(names(omitted.value)).toEqual(["Wire Works"]);
        expectWire(omitted.ledger, "/v1/customers?per_page=1");
        const explicit = yield* sent(optionalWithDefaults, {
          query: { per_page: 3 },
          headers: { Accept: "application/json" },
        });
        expect(names(explicit.value)).toEqual(
          customers.map(({ name }) => name),
        );
        expectWire(explicit.ledger, "/v1/customers?per_page=3");
      }),
  );

  it.live(
    "[EXT-32a] omission still validates refinements and explicit null before dispatch",
    () =>
      Effect.gen(function* () {
        const refined = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(
                OptionalQuery.check(
                  Schema.makeFilter((value) => value.page !== undefined),
                ),
              ),
            ),
          {},
        );
        expect(refined.error).toBeInstanceOf(Schema.SchemaError);
        expect(refined.ledger).toEqual([]);
        const explicit = yield* refused(
          (origin) => at(origin).pipe(Request.headers(OptionalHeaders)),
          { headers: null },
        );
        expect(explicit.error).toBeInstanceOf(Schema.SchemaError);
        expect(explicit.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-32b] constructor-filled query/header fields refuse post-binding raw edits with nothing sent",
    () =>
      Effect.gen(function* () {
        const secret = "hidden-edit";
        const cases: ReadonlyArray<
          readonly [string, (origin: string) => Checked]
        > = [
          [
            "per_page",
            (origin) =>
              at(origin).pipe(
                Request.query(ConstructorQuery),
                Request.setQuery("per_page", secret),
              ),
          ],
          [
            "per_page",
            (origin) =>
              at(origin).pipe(
                Request.query(ConstructorQuery),
                Request.appendQuery("per_page", secret),
              ),
          ],
          [
            "per_page",
            (origin) =>
              at(origin).pipe(
                Request.query(ConstructorQuery),
                Request.removeQuery("per_page"),
              ),
          ],
          [
            "per_page",
            (origin) =>
              at(origin).pipe(
                Request.query(ConstructorQuery),
                Request.removeQuery("per_page", secret),
              ),
          ],
          [
            "accept",
            (origin) =>
              at(origin).pipe(
                Request.headers(ConstructorHeaders),
                Request.setHeader("aCCEPT", secret),
              ),
          ],
          [
            "accept",
            (origin) =>
              at(origin).pipe(
                Request.headers(ConstructorHeaders),
                Request.removeHeader("ACCEPT"),
              ),
          ],
        ];
        for (const [field, build] of cases) {
          const { error, ledger } = yield* refused(build, {});
          expect(error).toBeInstanceOf(Request.InvalidRequest);
          expect(error.message).toContain(
            "Schema preparation supplied and wrote",
          );
          expect(error.message).toContain(JSON.stringify(field));
          expect(JSON.stringify(error)).not.toContain(secret);
          expect(ledger).toEqual([]);
        }
      }),
  );

  it.live(
    "[EXT-32b] control: pre-binding defaults and explicit caller values reach the wire",
    () =>
      Effect.gen(function* () {
        const before = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.setQuery("per_page", "2"),
              Request.setHeader("Accept", "text/plain"),
              Request.query(ConstructorQuery),
              Request.headers(ConstructorHeaders),
            ),
          {},
        );
        expect(names(before.value)).toEqual(["Wire Works"]);
        expectWire(before.ledger, "/v1/customers?per_page=1");
        const explicit = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(ConstructorQuery),
              Request.headers(ConstructorHeaders),
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
    "[EXT-32b] control: decoder fallback and undefined-producing defaults leave raw values to stand",
    () =>
      Effect.gen(function* () {
        const sibling = Schema.Struct({
          per_page: ConstructorQuery.fields.per_page,
          page: Schema.FiniteFromString,
        });
        const fallback = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(sibling),
              Request.setQuery("per_page", "2"),
            ),
          { query: { page: "1" } },
        );
        expect(names(fallback.value)).toEqual(["Wire Works", "Cedar Trading"]);
        expectWire(fallback.ledger, "/v1/customers?per_page=2&page=1");
        const undefinedDefault = Schema.Struct({
          per_page: Schema.optionalKey(Schema.UndefinedOr(Schema.String)).pipe(
            Schema.withConstructorDefault(Effect.succeed(undefined)),
          ),
        });
        const undefinedValue = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(undefinedDefault),
              Request.setQuery("per_page", "2"),
            ),
          {},
        );
        expect(names(undefinedValue.value)).toEqual([
          "Wire Works",
          "Cedar Trading",
        ]);
        expectWire(undefinedValue.ledger, "/v1/customers?per_page=2");
        const failedDefault = Schema.Struct({
          per_page: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(
              Effect.fail(
                new SchemaIssue.InvalidValue({
                  message: "default unavailable",
                }),
              ),
            ),
          ),
        });
        const failedValue = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(failedDefault),
              Request.setQuery("per_page", "2"),
            ),
          {},
        );
        expect(names(failedValue.value)).toEqual([
          "Wire Works",
          "Cedar Trading",
        ]);
        expectWire(failedValue.ledger, "/v1/customers?per_page=2");
      }),
  );

  it.live(
    "[EXT-32c] an encoded renamed tag rules out the other member's query field",
    () =>
      Effect.gen(function* () {
        const Tagged = Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("wire"),
            per_page: Schema.String,
          }).pipe(Schema.encodeKeys({ kind: "name" })),
          Schema.Struct({ kind: Schema.Literal("cedar") }).pipe(
            Schema.encodeKeys({ kind: "name" }),
          ),
        ]);
        const query = {
          name: "cedar",
          per_page: "from-another-member",
        } as const;
        const { value, ledger } = yield* sent(
          (origin) => at(origin).pipe(Request.query(Tagged)),
          { query },
        );
        expect(names(value)).toEqual(["Cedar Trading"]);
        expectWire(ledger, "/v1/customers?name=cedar");
      }),
  );

  it.live(
    "[EXT-32d] a transformed literal inside a tag union keeps its wider member's query field",
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
        const Tagged = Schema.Union([
          Schema.Struct({ kind: Schema.Literal("wire") }).pipe(
            Schema.encodeKeys({ kind: "name" }),
          ),
          Schema.Struct({
            kind: Schema.Union([Converted, Schema.Literal("other")]),
            per_page: Schema.String,
          }).pipe(Schema.encodeKeys({ kind: "name" })),
        ]);
        const { value, ledger } = yield* sent(
          (origin) => at(origin).pipe(Request.query(Tagged)),
          { query: { kind: "wire", per_page: "1" } },
        );
        expect(names(value)).toEqual(["Wire Works"]);
        expectWire(ledger, "/v1/customers?name=wire&per_page=1");
      }),
  );
});
