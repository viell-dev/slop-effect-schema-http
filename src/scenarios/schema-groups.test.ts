/**
 * EXT-17: raw values and schemas in one group, against a service that acts on them, in both lanes.
 * The library's own tests state each rule of #87 and #113. These show the three outcomes a consumer
 * meets at a real server: a shared default that reaches it, a declaration that never leaves, and a
 * value that arrives in the form the schema writes, whichever side of the schema it came from.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { headerValues } from "../harness/lane.js";

const token = "test-token-groups";

const start = () => lane.backend("business", { operations: { token } });

/** The service's answer to a good token and to a bad one. */
const listed = Response.status(200, Response.tag("Listed", Body.json)).pipe(
  Response.orElse(Response.status(401, Response.tag("Refused", Body.json))),
);

const OptionalCredential = Schema.Struct({
  Authorization: Schema.optional(Schema.String),
});

/** One place sets the credential for every request, and the schema allows that name. */
const tasks = (origin: string) =>
  Request.get(`${origin}/v2/tasks`).pipe(
    Request.setHeader("Authorization", `Bearer ${token}`),
    Request.headers(OptionalCredential),
  );

const Page = Schema.Struct({ page: Schema.FiniteFromString });
const OptionalPage = Schema.Struct({
  page: Schema.optional(Schema.FiniteFromString),
});

const customers = Response.status(200, Body.json);

describe(`raw values and schemas at a real service (${lane.name})`, () => {
  it.live(
    "[EXT-17a] a shared Authorization default under an optional header reaches the service, and a caller's value replaces it",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const list = Operation.make(tasks(backend.origin), listed);
        const kept = yield* list
          .execute({ headers: {} })
          .pipe(Effect.provide(lane.fetchClient));
        expect(kept._tag).toBe("Listed");
        const replaced = yield* list
          .execute({ headers: { Authorization: "Bearer wrong" } })
          .pipe(Effect.provide(lane.fetchClient));
        expect(replaced._tag).toBe("Refused");
        const [first, second] = yield* backend.ledger;
        expect(headerValues(first!.lines, "authorization")).toEqual([
          `Bearer ${token}`,
        ]);
        expect(headerValues(second!.lines, "authorization")).toEqual([
          "Bearer wrong",
        ]);
      }),
  );

  it.live(
    "[EXT-17b] a raw header no schema allows is refused before anything is sent, by its name and never its value",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const error = yield* Operation.make(
          tasks(backend.origin).pipe(Request.setHeader("X-Stray", "hidden")),
          listed,
        )
          .execute({ headers: {} })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        expect(error._tag).toBe("InvalidRequest");
        expect(error.message).toContain('"X-Stray"');
        expect(error.message).not.toContain("hidden");
        expect(yield* backend.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-17b] a query entry written in the constructor that no schema allows is refused before anything is sent",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const error = yield* Operation.make(
          Request.get(`${backend.origin}/v1/customers?fields=hidden`).pipe(
            Request.query(Page),
          ),
          customers,
        )
          .execute({ query: { page: 1 } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        expect(error._tag).toBe("InvalidRequest");
        expect(error.message).toContain('"fields"');
        expect(error.message).not.toContain("hidden");
        expect(yield* backend.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-17c] a caller's value reaches the service in the form the schema writes, from either side of the schema",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const list = Operation.make(
          Request.get(`${backend.origin}/v1/customers`).pipe(
            Request.query(Page),
          ),
          customers,
        );
        yield* list
          .execute({ query: { page: 2 } })
          .pipe(Effect.provide(lane.fetchClient));
        yield* list
          .execute({ query: { page: "02" } })
          .pipe(Effect.provide(lane.fetchClient));
        const ledger = yield* backend.ledger;
        expect(ledger.map((entry) => entry.target)).toEqual([
          "/v1/customers?page=2",
          "/v1/customers?page=2",
        ]);
      }),
  );

  it.live(
    "[EXT-17c] a default written in the constructor goes through the schema, which writes its own spelling",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        yield* Operation.make(
          Request.get(`${backend.origin}/v1/customers?page=02`).pipe(
            Request.query(OptionalPage),
          ),
          customers,
        )
          .execute({ query: {} })
          .pipe(Effect.provide(lane.fetchClient));
        const [entry] = yield* backend.ledger;
        expect(entry!.target).toBe("/v1/customers?page=2");
      }),
  );
});
