/**
 * EXT-34: bounded group-preservation repairs from #143, using the business service's public
 * customer-list contract and Fetch over real sockets in Node and Chromium.
 * Service documentation: services/business.md
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaGetter } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const customers = [
  { id: 1001, name: "Wire Works", tier: "STANDARD" },
  { id: 1002, name: "01", tier: "GOLD" },
  { id: 1003, name: "1", tier: "SILVER" },
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
      customers: Schema.Array(Schema.Struct({ name: Schema.String })),
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
    return {
      names: value.customers.map(({ name }) => name),
      ledger: yield* backend.ledger,
    };
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
const expectWire = (ledger: ReadonlyArray<Recorded>, target: string) => {
  expect(ledger).toHaveLength(1);
  expect(ledger[0]!.method).toBe("GET");
  expect(ledger[0]!.target).toBe(target);
  expect(headerValues(ledger[0]!.lines, "accept")).toEqual([
    "application/json",
  ]);
  expect(ledger[0]!.body.byteLength).toBe(0);
};
const expectRefusal = (
  result: { readonly error: unknown; readonly ledger: ReadonlyArray<Recorded> },
  tag: "InvalidRequest" | "SchemaError",
  field: string,
) => {
  expect(result.ledger).toEqual([]);
  expect(result.error).toMatchObject({ _tag: tag });
  expect(String(result.error)).toContain(JSON.stringify(field));
  expect(String(result.error)).not.toContain("hidden-edit");
};

const Renamed = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(2)),
  ),
}).pipe(Schema.encodeKeys({ limit: "per_page" }));
const Multistage = Renamed.pipe(
  Schema.decodeTo(
    Schema.Struct({
      desired: Schema.optionalKey(Schema.Number).pipe(
        Schema.withConstructorDefault(Effect.succeed(2)),
      ),
    }),
    {
      decode: SchemaGetter.transform(({ limit }) =>
        limit === undefined ? {} : { desired: limit },
      ),
      encode: SchemaGetter.transform(({ desired }) =>
        desired === undefined ? {} : { limit: desired },
      ),
    },
  ),
);
const Page = Schema.Struct({ page: Schema.FiniteFromString });
const Wide = Schema.Struct({
  per_page: Schema.FiniteFromString,
  name: Schema.String,
});
const NarrowFirst = Schema.Union([Page, Wide]);
const NumericWide = Schema.Struct({
  per_page: Schema.FiniteFromString,
  name: Schema.FiniteFromString,
});
const empty = function* (): Generator<readonly [string, string]> {};

describe(`bounded group preservation (${lane.name})`, () => {
  for (const [shape, Query] of [
    ["renamed", Renamed],
    ["multistage", Multistage],
  ] as const) {
    for (const [edit, apply] of [
      ["set", Request.setQuery("per_page", "hidden-edit")],
      ["append", Request.appendQuery("per_page", "hidden-edit")],
      ["remove", Request.removeQuery("per_page")],
    ] as const) {
      it.live(
        `[EXT-34a] an empty ${shape} group refuses a later query ${edit}`,
        () =>
          Effect.gen(function* () {
            const result = yield* refused(
              (origin) => at(origin).pipe(Request.query(Query), apply),
              { query: {} },
            );
            expectRefusal(result, "InvalidRequest", "per_page");
          }),
      );
    }
  }

  for (const [shape, input] of [
    ["omitted", {}],
    ["null-prototype", { query: Object.create(null) }],
  ] as const) {
    it.live(
      `[EXT-34a] an ${shape} empty group refuses replacement of its renamed default`,
      () =>
        Effect.gen(function* () {
          const result = yield* refused(
            (origin) =>
              at(origin).pipe(
                Request.query(Renamed),
                Request.setQuery("per_page", "hidden-edit"),
              ),
            input,
          );
          expectRefusal(result, "InvalidRequest", "per_page");
        }),
    );
  }

  it.live(
    "[EXT-34b] an empty renamed header group protects Accept without case sensitivity",
    () =>
      Effect.gen(function* () {
        const Headers = Schema.Struct({
          media: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("application/json")),
          ),
        }).pipe(Schema.encodeKeys({ media: "Accept" }));
        const ordinary = yield* sent(
          (origin) => at(origin).pipe(Request.headers(Headers)),
          {},
        );
        expect(ordinary.names).toEqual(["Wire Works", "01"]);
        expectWire(ordinary.ledger, "/v1/customers");
        for (const apply of [
          Request.setHeader("aCCEPT", "hidden-edit"),
          Request.removeHeader("ACCEPT"),
        ]) {
          const result = yield* refused(
            (origin) => at(origin).pipe(Request.headers(Headers), apply),
            {},
          );
          expectRefusal(result, "InvalidRequest", "accept");
        }
      }),
  );

  it.live(
    "[EXT-34c] empty-group evidence reuses ordinary default and transform evaluations",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const Query = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(
              Effect.sync(() => {
                trace.push("default");
                return 2;
              }),
            ),
          ),
        }).pipe(
          Schema.encodeKeys({ limit: "per_page" }),
          Schema.decodeTo(
            Schema.Struct({
              count: Schema.optionalKey(Schema.Number).pipe(
                Schema.withConstructorDefault(
                  Effect.sync(() => {
                    trace.push("outer default");
                    return 2;
                  }),
                ),
              ),
            }),
            {
              decode: SchemaGetter.transform(({ limit }) => {
                trace.push("decode");
                return limit === undefined ? {} : { count: limit };
              }),
              encode: SchemaGetter.transform(({ count }) => {
                trace.push("encode");
                return count === undefined ? {} : { limit: count };
              }),
            },
          ),
        );
        const ordinary = yield* sent(
          (origin) => at(origin).pipe(Request.query(Query)),
          { query: {} },
        );
        expect(ordinary.names).toEqual(["Wire Works", "01"]);
        expectWire(ordinary.ledger, "/v1/customers?per_page=2");
        const ordinaryTrace = [...trace];
        expect(ordinaryTrace.length).toBeGreaterThan(0);
        trace.length = 0;
        const result = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(Query),
              Request.setQuery("per_page", "hidden-edit"),
            ),
          { query: {} },
        );
        expectRefusal(result, "InvalidRequest", "per_page");
        expect(trace).toEqual(ordinaryTrace);
      }),
  );

  it.live(
    "[EXT-34d] control: explicit decoded and encoded values and earlier raw defaults retain precedence",
    () =>
      Effect.gen(function* () {
        for (const query of [{ limit: 1 }, { per_page: "1" }]) {
          const result = yield* sent(
            (origin) =>
              at(origin).pipe(
                Request.query(Renamed),
                Request.setQuery("per_page", "3"),
              ),
            { query },
          );
          expect(result.names).toEqual(["Wire Works"]);
          expectWire(result.ledger, "/v1/customers?per_page=1");
        }
        const before = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.setQuery("per_page", "1"),
              Request.query(Renamed),
            ),
          {},
        );
        expect(before.names).toEqual(["Wire Works", "01"]);
        expectWire(before.ledger, "/v1/customers?per_page=2");
      }),
  );

  for (const [shape, query] of [
    ["unrelated own field", { unrelated: "caller" }],
    [
      "nonenumerable own field",
      Object.defineProperty({}, "unrelated", { value: "caller" }),
    ],
    ["symbol own field", { [Symbol("unrelated")]: "caller" }],
    ["custom prototype", Object.create({ unrelated: "caller" })],
  ] as const) {
    it.live(
      `[EXT-34e] limit: an ${shape} disables the new empty-group proof`,
      () =>
        Effect.gen(function* () {
          const result = yield* sent(
            (origin) =>
              at(origin).pipe(
                Request.query(Renamed),
                Request.setQuery("per_page", "1"),
              ),
            { query } as never,
          );
          expect(result.names).toEqual(["Wire Works", "01"]);
          expectWire(result.ledger, "/v1/customers?per_page=2");
        }),
    );
  }

  for (const order of ["union first", "sibling first"] as const) {
    it.live(
      `[EXT-34f] ${order}: actual sibling consumption lets a union keep the remaining customer filters`,
      () =>
        Effect.gen(function* () {
          const result = yield* sent(
            (origin) =>
              order === "union first"
                ? at(origin).pipe(
                    Request.query(NarrowFirst),
                    Request.query(Page),
                  )
                : at(origin).pipe(
                    Request.query(Page),
                    Request.query(NarrowFirst),
                  ),
            { query: { page: 1, per_page: 2, name: "Wire" } },
          );
          expect(result.names).toEqual(["Wire Works"]);
          expectWire(
            result.ledger,
            order === "union first"
              ? "/v1/customers?per_page=2&name=Wire&page=1"
              : "/v1/customers?page=1&per_page=2&name=Wire",
          );
        }),
    );
  }

  it.live(
    "[EXT-34e] limit: a nonempty renamed group keeps the broader generated-field correspondence limit",
    () =>
      Effect.gen(function* () {
        const Query = Schema.Struct({
          page: Schema.FiniteFromString,
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(2)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "per_page" }));
        const result = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(Query),
              Request.setQuery("per_page", "1"),
            ),
          { query: { page: 1 } },
        );
        expect(result.names).toEqual(["Wire Works", "01"]);
        expectWire(result.ledger, "/v1/customers?page=1&per_page=2");
      }),
  );

  it.live(
    "[EXT-34e] control: an inherited encoded toString name disables empty-group evidence",
    () =>
      Effect.gen(function* () {
        // Object.prototype.toString is present despite the caller's zero own keys. This proof
        // must not infer that either declared endpoint name was absent through the prototype.
        const Query = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(2)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "toString" }));
        const echo = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const value = yield* Operation.make(
          Request.get(`${echo.origin}/x`).pipe(
            Request.query(Query),
            Request.setQuery("toString", "1"),
          ),
          Response.status(404, Body.text),
        )
          .execute({})
          .pipe(Effect.provide(lane.fetchClient));
        expect(value).toBe("Not Found");
        const ledger = yield* echo.ledger;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.method).toBe("GET");
        expect(ledger[0]!.target).toBe("/x?toString=2");
        expect(headerValues(ledger[0]!.lines, "accept")).toEqual([
          "text/plain",
        ]);
        expect(ledger[0]!.body.byteLength).toBe(0);
      }),
  );

  it.live(
    "[EXT-34e] control: a renamed iterable output still sends yielded entries rather than own fields",
    () =>
      Effect.gen(function* () {
        const Iterator = Schema.declare(
          (value): value is typeof empty => typeof value === "function",
        );
        const Query = Schema.Struct({
          limit: Schema.optionalKey(Schema.String).pipe(
            Schema.withConstructorDefault(Effect.succeed("1")),
          ),
          [Symbol.iterator]: Iterator.pipe(
            Schema.withConstructorDefault(Effect.succeed(empty)),
          ),
        }).pipe(Schema.encodeKeys({ limit: "per_page" }));
        const result = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(Query),
              Request.removeQuery("per_page"),
            ),
          {},
        );
        expect(result.names).toEqual(["Wire Works", "01"]);
        expectWire(result.ledger, "/v1/customers");
      }),
  );

  it.live(
    "[EXT-34g] whole-union constructor priority preserves literal 01 during recovery",
    () =>
      Effect.gen(function* () {
        const Union = Schema.Union([Page, NumericWide, Wide]);
        const result = yield* sent(
          (origin) =>
            at(origin).pipe(Request.query(Union), Request.query(Page)),
          { query: { page: 1, per_page: 2, name: "01" } },
        );
        expect(result.names).toEqual(["01"]);
        expectWire(result.ledger, "/v1/customers?per_page=2&name=01&page=1");
      }),
  );

  it.live(
    "[EXT-34g] control: directly binding the numeric member canonicalizes name 01 to 1",
    () =>
      Effect.gen(function* () {
        const direct = yield* sent(
          (origin) =>
            at(origin).pipe(Request.query(NumericWide), Request.query(Page)),
          { query: { page: 1, per_page: 2, name: "01" } },
        );
        expect(direct.names).toEqual(["01", "1"]);
        expectWire(direct.ledger, "/v1/customers?per_page=2&name=1&page=1");
      }),
  );

  it.live(
    "[EXT-34h] control: a wider-first successful union keeps its evaluation trace",
    () =>
      Effect.gen(function* () {
        const trace: string[] = [];
        const Name = Schema.String.check(
          Schema.makeFilter((value) => {
            trace.push(value);
            return true;
          }),
        );
        const First = Schema.Struct({
          per_page: Schema.FiniteFromString,
          name: Name,
        });
        const result = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(Schema.Union([First, Page])),
              Request.query(Page),
            ),
          { query: { page: 1, per_page: 2, name: "Wire" } },
        );
        expect(result.names).toEqual(["Wire Works"]);
        expectWire(result.ledger, "/v1/customers?per_page=2&name=Wire&page=1");
        // The released 0.5 baseline runs this check three times; recovery must not add a read.
        expect(trace).toEqual(["Wire", "Wire", "Wire"]);
      }),
  );

  it.live(
    "[EXT-34i] control: reused bindings cannot pre-credit all names merely stated by their unions",
    () =>
      Effect.gen(function* () {
        const bind = Request.query(
          Schema.Union([
            Page,
            Schema.Struct({ name: Schema.String }),
            Schema.Struct({ per_page: Schema.FiniteFromString }),
          ]),
        );
        // Each application can hold only one of three names. Reusing the binding factory does
        // not make its whole list of possible names a certificate of actual consumption.
        const result = yield* refused((origin) => at(origin).pipe(bind, bind), {
          query: { page: 1, name: "hidden-edit", per_page: 2 },
        });
        expectRefusal(result, "SchemaError", "name");
      }),
  );

  it.live(
    "[EXT-34j] recovery cannot withdraw generated credit already used after mapInput",
    () =>
      Effect.gen(function* () {
        const Outer = Schema.Union([
          Schema.Struct({
            page: Schema.FiniteFromString,
            name: Schema.optionalKey(Schema.String).pipe(
              Schema.withConstructorDefault(Effect.succeed("generated")),
            ),
          }),
          Schema.Struct({ per_page: Schema.FiniteFromString }),
        ]);
        const Inner = Schema.Union([
          Page,
          Schema.Struct({ name: Schema.String }),
        ]);
        const result = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(Inner),
              Request.mapInput(
                (input: { query: { page: number; per_page: number } }) => ({
                  query: { ...input.query, name: "hidden-edit" },
                }),
              ),
              Request.query(Outer),
            ),
          { query: { page: 1, per_page: 2 } },
        );
        expectRefusal(result, "SchemaError", "per_page");
      }),
  );

  it.live(
    "[EXT-34k] control: parent checks keep the bounded union recovery unavailable",
    () =>
      Effect.gen(function* () {
        const Query = NarrowFirst.check(Schema.makeFilter(() => true));
        const result = yield* refused(
          (origin) =>
            at(origin).pipe(Request.query(Query), Request.query(Page)),
          { query: { page: 1, per_page: 2, name: "hidden-edit" } },
        );
        expectRefusal(result, "SchemaError", "per_page");
      }),
  );
});
