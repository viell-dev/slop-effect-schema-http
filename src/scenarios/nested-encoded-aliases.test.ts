/**
 * EXT-40: complete encoded sides retain aliases nested below an unchanged outer name (#172).
 * Consumer-authored from the public report, path/body documentation and neutral echo contract.
 * These cases do not assert arbitrary recursive field mixing. Positive input errors on 0.9.0
 * deliberately remain unmasked: runtime already works, and the repair must change only typing.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues, type Recorded } from "../harness/lane.js";

const Inner = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Nested = Schema.Struct({ filter: Inner });
const Cursor = Schema.Struct({ cursor: Schema.String });
const NestedUnion = Schema.Struct({
  filter: Schema.Union([Inner, Cursor]),
});
const NumericInner = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const NumericNested = Schema.Struct({ filter: NumericInner });
const Tagged = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("page"), filter: NumericInner }),
  Schema.Struct({ kind: Schema.Literal("cursor"), filter: Cursor }),
]);
const response = Response.status(404, Body.text);
const start = () => lane.backend("echo", undefined, { listener: "socket" });

class RouteToken {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  get value(): string {
    return this.#value;
  }
}
const Token = Schema.declare(
  (value): value is RouteToken => value instanceof RouteToken,
);
const TokenEnvelope = Schema.Struct({ token: Token, filter: Inner });

// Unevaluated actual API calls: no HTTP dispatch, widening annotations or input casts.
const inputChecks = () => {
  const encoded: Request.Input<typeof Nested> = {
    filter: { page_size: "05" },
  };
  const decoded: Request.Input<typeof Nested> = {
    filter: { limit: "05" },
  };
  const tagged = Operation.make(
    Request.post("/x").pipe(Request.body(Body.jsonSchema(Tagged))),
    response,
  );
  const wrongMember = tagged.execute({
    body: {
      kind: "page",
      // @ts-expect-error A cursor belongs to the cursor-tagged member only.
      filter: { cursor: "next" },
    },
  });
  const wrongAlias = tagged.execute({
    body: {
      kind: "page",
      // @ts-expect-error Unknown nested names remain unavailable.
      filter: { page_count: "05" },
    },
  });
  const wrongValue = tagged.execute({
    body: {
      kind: "page",
      // @ts-expect-error A nested encoded numeric alias still takes text, not boolean.
      filter: { page_size: true },
    },
  });
  const nominal = Operation.make(
    Request.get("/x").pipe(
      Request.path(
        TokenEnvelope,
        ({ token, filter }, encode) =>
          `/${encode(token.value)}/${encode(filter.page_size ?? "none")}`,
      ),
    ),
    response,
  );
  const instance = nominal.execute({
    path: { token: new RouteToken("kept"), filter: { limit: "05" } },
  });
  const lookalike = nominal.execute({
    path: {
      // @ts-expect-error A public lookalike lacks RouteToken's private identity.
      token: { value: "kept" },
      filter: { limit: "05" },
    },
  });
  expectTypeOf<Request.Input<typeof Token>>().toEqualTypeOf<RouteToken>();
  return {
    encoded,
    decoded,
    wrongMember,
    wrongAlias,
    wrongValue,
    instance,
    lookalike,
  };
};
void inputChecks;

const expectWire = (entry: Recorded, method: string, target: string) => {
  expect(entry.method).toBe(method);
  expect(entry.target).toBe(target);
};
const expectJson = (entry: Recorded, text: string) => {
  expectWire(entry, "POST", "/x");
  expect(headerValues(entry.lines, "content-type")).toEqual([
    "application/json",
  ]);
  expect(entry.body).toEqual(new TextEncoder().encode(text));
};

describe(`nested encoded input aliases (${lane.name})`, () => {
  it.live(
    "[EXT-40a] a nested direct path accepts both complete sides and preserves literal text",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              Nested,
              ({ filter }, encode) =>
                `/${encode(filter.page_size ?? "none")}/${encode(filter.term ?? "none")}`,
            ),
          ),
          response,
        );
        const encoded = yield* operation
          .execute({ path: { filter: { page_size: "05", term: "a/b" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ path: { filter: { limit: "05", term: "a/b" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const omitted = yield* operation
          .execute({ path: { filter: {} } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([encoded, decoded, omitted]).toEqual([
          "Not Found",
          "Not Found",
          "Not Found",
        ]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectWire(ledger[0]!, "GET", "/x/05/a%2Fb");
        expectWire(ledger[1]!, "GET", "/x/05/a%2Fb");
        expectWire(ledger[2]!, "GET", "/x/none/none");
        for (const entry of ledger) expect(entry.body.byteLength).toBe(0);
      }),
  );

  it.live(
    "[EXT-40b] a nested union path retains encoded aliases and its cursor alternative",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(NestedUnion, ({ filter }, encode) =>
              "cursor" in filter
                ? `/cursor/${encode(filter.cursor)}`
                : `/page/${encode(filter.page_size ?? "none")}`,
            ),
          ),
          response,
        );
        const encoded = yield* operation
          .execute({ path: { filter: { page_size: "05" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ path: { filter: { limit: "05" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const cursor = yield* operation
          .execute({ path: { filter: { cursor: "next/part" } } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([encoded, decoded, cursor]).toEqual([
          "Not Found",
          "Not Found",
          "Not Found",
        ]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectWire(ledger[0]!, "GET", "/x/page/05");
        expectWire(ledger[1]!, "GET", "/x/page/05");
        expectWire(ledger[2]!, "GET", "/x/cursor/next%2Fpart");
        for (const entry of ledger) expect(entry.body.byteLength).toBe(0);
      }),
  );

  it.live(
    "[EXT-40c] a nested JSON body accepts both complete sides and writes canonical numeric text",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(NumericNested)),
          ),
          response,
        );
        const encoded = yield* operation
          .execute({ body: { filter: { page_size: "05", term: "a/b ü" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ body: { filter: { limit: 5, term: "a/b ü" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const omitted = yield* operation
          .execute({ body: { filter: {} } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([encoded, decoded, omitted]).toEqual([
          "Not Found",
          "Not Found",
          "Not Found",
        ]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectJson(ledger[0]!, '{"filter":{"term":"a/b ü","page_size":"5"}}');
        expectJson(ledger[1]!, '{"filter":{"term":"a/b ü","page_size":"5"}}');
        expectJson(ledger[2]!, '{"filter":{}}');
      }),
  );

  it.live(
    "[EXT-40d] a discriminated JSON body retains nested aliases and member correlation",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(Tagged)),
          ),
          response,
        );
        const encoded = yield* operation
          .execute({ body: { kind: "page", filter: { page_size: "05" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ body: { kind: "page", filter: { limit: 5 } } })
          .pipe(Effect.provide(lane.fetchClient));
        const cursor = yield* operation
          .execute({ body: { kind: "cursor", filter: { cursor: "next" } } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([encoded, decoded, cursor]).toEqual([
          "Not Found",
          "Not Found",
          "Not Found",
        ]);
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(3);
        expectJson(ledger[0]!, '{"kind":"page","filter":{"page_size":"5"}}');
        expectJson(ledger[1]!, '{"kind":"page","filter":{"page_size":"5"}}');
        expectJson(ledger[2]!, '{"kind":"cursor","filter":{"cursor":"next"}}');
      }),
  );

  it.live(
    "[EXT-40e] invalid nested encoded path values still fail before dispatch",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              NumericNested,
              ({ filter }, encode) => `/${encode(filter.page_size ?? "none")}`,
            ),
          ),
          response,
        );
        const text = yield* operation
          .execute({ path: { filter: { page_size: "many" } } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        const boolean = yield* operation
          // Deliberate runtime-negative input, beyond either schema side's type.
          // @ts-expect-error Encoded numeric text cannot be boolean.
          .execute({ path: { filter: { page_size: false } } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        expect(Schema.isSchemaError(text)).toBe(true);
        expect(Schema.isSchemaError(boolean)).toBe(true);
        expect(yield* backend.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-40f] invalid nested encoded JSON values still fail before dispatch",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const operation = Operation.make(
          Request.post(`${backend.origin}/x`).pipe(
            Request.body(Body.jsonSchema(NumericNested)),
          ),
          response,
        );
        const text = yield* operation
          .execute({ body: { filter: { page_size: "many" } } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        const boolean = yield* operation
          // Deliberate runtime-negative input, beyond either schema side's type.
          // @ts-expect-error Encoded numeric text cannot be boolean.
          .execute({ body: { filter: { page_size: false } } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        expect(Schema.isSchemaError(text)).toBe(true);
        expect(Schema.isSchemaError(boolean)).toBe(true);
        expect(yield* backend.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-40g] a nested invalid encoded value refuses before dispatch and retains valid controls",
    () =>
      Effect.gen(function* () {
        // #170's bounded nested constructor repair, distinct from #172's earlier typing repair.
        const DefaultedNested = Schema.Struct({
          filter: Schema.Struct({
            limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
              Schema.withConstructorDefault(Effect.succeed(25)),
            ),
            term: Schema.optionalKey(Schema.String),
          }).pipe(Schema.encodeKeys({ limit: "page_size" })),
        });
        const backend = yield* start();
        const operation = Operation.make(
          Request.get(`${backend.origin}/x`).pipe(
            Request.path(
              DefaultedNested,
              ({ filter }, encode) => `/${encode(filter.page_size ?? "none")}`,
            ),
          ),
          response,
        );
        const invalid = yield* operation
          .execute({ path: { filter: { page_size: "many" } } })
          .pipe(
            Effect.provide(lane.fetchClient),
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: (value) => ({ value }),
            }),
          );
        const beforeControls = yield* backend.ledger;
        const encoded = yield* operation
          .execute({ path: { filter: { page_size: "05" } } })
          .pipe(Effect.provide(lane.fetchClient));
        const decoded = yield* operation
          .execute({ path: { filter: { limit: 5 } } })
          .pipe(Effect.provide(lane.fetchClient));
        const omitted = yield* operation
          .execute({ path: { filter: {} } })
          .pipe(Effect.provide(lane.fetchClient));
        expect([encoded, decoded, omitted]).toEqual([
          "Not Found",
          "Not Found",
          "Not Found",
        ]);
        const ledger = yield* backend.ledger;
        expect({
          invalid,
          beforeControls: beforeControls.map(({ method, target }) => ({
            method,
            target,
          })),
          targets: ledger.map(({ target }) => target),
        }).toMatchObject({
          invalid: { error: { _tag: "SchemaError" } },
          beforeControls: [],
          targets: ["/x/5", "/x/5", "/x/25"],
        });
        expect(ledger).toHaveLength(3);
        expectWire(ledger[0]!, "GET", "/x/5");
        expectWire(ledger[1]!, "GET", "/x/5");
        expectWire(ledger[2]!, "GET", "/x/25");
        for (const entry of ledger) expect(entry.body.byteLength).toBe(0);
      }),
  );
});
