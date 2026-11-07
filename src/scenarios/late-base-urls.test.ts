/**
 * EXT-20: a base URL that arrives late, against real services, in both lanes (#89 and #81). The
 * library's own tests state each rule; these show what a consumer meets when the location comes
 * from a lookup that works, fails or never ends, and that nothing reaches a server until it has
 * answered.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  Data,
  Effect,
  Option,
  Schedule,
  Schema,
} from "effect";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Ops from "../clients/business/operations.js";
import type { Recorded } from "../harness/lane.js";

const regions = Response.status(200, Body.json);

/** Where the deployment was found, as an application's own service would say. */
class ApiOrigin extends Context.Service<ApiOrigin, string>()(
  "suite/ApiOrigin",
) {}

class Undiscovered extends Data.TaggedError("Undiscovered")<{
  readonly reason: string;
}> {}

const targets = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map(({ target }) => target);

const start = () => lane.backend("business");

/** A base's `/v1` prefix, added to whichever base the request holds. */
const inV1 = Request.mapBaseUrl((url) => `${url}/v1`);

/** Accepts only a program with nothing left to provide. */
const runnable = (_program: Effect.Effect<unknown, unknown, never>): void => {};

/** A retry budget that would show up in a count, if a policy touched what happens before it. */
const retrying = Policy.make(Schedule.recurs(3), { while: () => true });

describe(`a base URL known late (${lane.name})`, () => {
  it.live(
    "[EXT-20a] a service supplies the location when the program runs, and the definition stays a plain value",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const regionList = Operation.make(
          Request.get("/v1/regions").pipe(Request.baseUrl(ApiOrigin)),
          regions,
        );
        yield* regionList
          .execute(undefined)
          .pipe(Effect.provideService(ApiOrigin, backend.origin));
        expect(targets(yield* backend.ledger)).toEqual(["/v1/regions"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[EXT-20a] a Config value supplies it the same way", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      const regionList = Operation.make(
        Request.get("/v1/regions").pipe(
          Request.baseUrl(Config.String("API_ORIGIN")),
        ),
        regions,
      );
      yield* regionList
        .execute(undefined)
        .pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ API_ORIGIN: backend.origin }),
            ),
          ),
        );
      expect(targets(yield* backend.ledger)).toEqual(["/v1/regions"]);
      const error = yield* Effect.flip(
        regionList
          .execute(undefined)
          .pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({})),
            ),
          ),
      );
      expect(error).toBeInstanceOf(Config.ConfigError);
      expect(yield* backend.ledger).toHaveLength(1);
    }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[EXT-20a] forgetting the location is a compile error", () =>
    Effect.sync(() => {
      const regionList = Operation.make(
        Request.get("/v1/regions").pipe(Request.baseUrl(ApiOrigin)),
        regions,
      );
      // @ts-expect-error the program still needs `ApiOrigin`, as well as a client
      runnable(regionList.execute(undefined));
      expect(regionList).toBeDefined();
    }),
  );

  it.live(
    "[EXT-20b] a lookup that fails comes back as itself: nothing is sent, and a policy does not repeat it",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let lookups = 0;
        const lookup = Effect.suspend(() => {
          lookups += 1;
          return Effect.fail(new Undiscovered({ reason: "no such zone" }));
        });
        const error = yield* Effect.flip(
          Operation.make(
            Request.get("/v1/regions").pipe(Request.baseUrl(lookup)),
            regions,
            { policy: retrying },
          ).execute(undefined),
        );
        expect(error).toBeInstanceOf(Undiscovered);
        expect(lookups).toBe(1);
        expect(yield* backend.ledger).toEqual([]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20b] a lookup that fails stops a request with an absolute URL too, though the join would bypass it",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const error = yield* Effect.flip(
          Operation.make(
            Request.get(`${backend.origin}/v1/regions`).pipe(
              Request.baseUrl(
                Effect.fail(new Undiscovered({ reason: "offline" })),
              ),
            ),
            regions,
          ).execute(undefined),
        );
        expect(error).toBeInstanceOf(Undiscovered);
        expect(yield* backend.ledger).toEqual([]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20c] a lookup that hangs is not under the attempt timeout, and only the caller's limit ends it",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let released = false;
        const hanging = Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              released = true;
            }),
          ),
        );
        const result = yield* Operation.make(
          Request.get("/v1/regions").pipe(Request.baseUrl(hanging)),
          regions,
          {
            policy: Policy.make(Schedule.recurs(3), {
              attemptTimeout: "50 millis",
            }),
          },
        )
          .execute(undefined)
          .pipe(Effect.timeoutOption("400 millis"));
        expect(Option.isNone(result)).toBe(true);
        expect(released).toBe(true);
        expect(yield* backend.ledger).toEqual([]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20c] a caller's Effect.timeout turns a hanging lookup into a timeout, with nothing sent",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const error = yield* Effect.flip(
          Operation.make(
            Request.get("/v1/regions").pipe(Request.baseUrl(Effect.never)),
            regions,
          )
            .execute(undefined)
            .pipe(Effect.timeout("150 millis")),
        );
        expect(Cause.isTimeoutError(error)).toBe(true);
        expect(yield* backend.ledger).toEqual([]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20d] a lookup runs once for three real attempts, and again for the next evaluation",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business", {
          operations: { token: "late-token" },
        });
        let lookups = 0;
        const lookup = Effect.sync(() => {
          lookups += 1;
          return `${backend.origin}/v2`;
        });
        const quote = Operation.make(
          Request.get("/rates").pipe(
            Request.baseUrl(lookup),
            Request.path`/${Request.pathValue("pair", Ops.Pair)}`,
          ),
          Response.status(200, Body.jsonSchema(Ops.Quote)),
          {
            policy: Policy.make(Schedule.recurs(2), {
              while: Ops.transientOrCalm,
            }),
          },
        );
        const input = { path: { pair: "EURUSD" } };
        yield* quote.execute(input);
        expect(lookups).toBe(1);
        expect(targets(yield* backend.ledger)).toEqual(
          Array.from({ length: 3 }, () => "/v2/rates/EURUSD"),
        );
        yield* quote.execute(input);
        expect(lookups).toBe(2);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[EXT-20d] input the schema refuses costs no lookup", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      let lookups = 0;
      const lookup = Effect.sync(() => {
        lookups += 1;
        return backend.origin;
      });
      const error = yield* Effect.flip(
        Operation.make(
          Request.get("/v1/customers").pipe(
            Request.baseUrl(lookup),
            Request.path`/${Request.pathValue("id", Schema.Int)}`,
          ),
          regions,
        ).execute({ path: { id: 1.5 } }),
      );
      expect(Schema.isSchemaError(error)).toBe(true);
      expect(lookups).toBe(0);
      expect(yield* backend.ledger).toEqual([]);
    }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20e] Request.mapBaseUrl extends a base given as text, and the request it came from keeps its own",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const original = Request.get("/regions").pipe(
          Request.baseUrl(backend.origin),
        );
        yield* Operation.make(original.pipe(inV1), regions).execute(undefined);
        const status = yield* Operation.make(
          original,
          Response.when(() => true, Response.tag("Answer", Body.text)),
        )
          .execute(undefined)
          .pipe(Effect.map(({ metadata }) => metadata.status));
        expect(status).toBe(404);
        expect(targets(yield* backend.ledger)).toEqual([
          "/v1/regions",
          "/regions",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20e] Request.mapBaseUrl extends a base that is not known yet, at the moment it is",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        yield* Operation.make(
          Request.get("/regions").pipe(
            Request.baseUrl(
              Effect.suspend(() => Effect.succeed(backend.origin)),
            ),
            inV1,
          ),
          regions,
        ).execute(undefined);
        expect(targets(yield* backend.ledger)).toEqual(["/v1/regions"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20e] with no base set, Request.mapBaseUrl receives the empty text and can supply one",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const given: Array<string> = [];
        yield* Operation.make(
          Request.get("/v1/regions").pipe(
            Request.mapBaseUrl((url) => {
              given.push(url);
              return backend.origin;
            }),
          ),
          regions,
        ).execute(undefined);
        expect(given).toEqual([""]);
        expect(targets(yield* backend.ledger)).toEqual(["/v1/regions"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20e] a Request.mapBaseUrl function that throws is Request.InvalidRequest, with nothing sent",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const error = yield* Effect.flip(
          Operation.make(
            Request.get("/v1/regions").pipe(
              Request.baseUrl(backend.origin),
              Request.mapBaseUrl(() => {
                throw new Error("no such prefix");
              }),
            ),
            regions,
          ).execute(undefined),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(yield* backend.ledger).toEqual([]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[EXT-20e] a later Request.baseUrl replaces what Request.mapBaseUrl made, and a lookup behind it never runs",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let lookups = 0;
        const lookup = Effect.sync(() => {
          lookups += 1;
          return "http://elsewhere.test";
        });
        yield* Operation.make(
          Request.get("/v1/regions").pipe(
            Request.baseUrl(lookup),
            Request.mapBaseUrl((url) => `${url}/prefix`),
            Request.baseUrl(backend.origin),
          ),
          regions,
        ).execute(undefined);
        expect(lookups).toBe(0);
        expect(targets(yield* backend.ledger)).toEqual(["/v1/regions"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});
