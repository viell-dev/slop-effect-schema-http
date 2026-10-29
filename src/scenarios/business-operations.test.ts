import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Fiber, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { lane } from "#lane";
import { Policy, Response } from "viell-effect-schema-http";
import * as Ops from "../clients/business/operations.js";
import { bodyText, header, queryOf, type Recorded } from "../harness/lane.js";
import * as Values from "../values/business.js";

// ---------------------------------------------------------------------------------------------
// Fixture values, passed to the backend as options
// ---------------------------------------------------------------------------------------------

const token = "test-token-ops-v2";

const tasks = [
  {
    title: "Reconcile the October ledger",
    assigneeId: "u-ada",
    priority: 2,
    due: { epochMillis: 1_701_388_800_000, offsetMinutes: null },
    notes: null,
    done: false,
    created: 1_698_796_800_000,
  },
  {
    title: "Archive the September exports",
    assigneeId: "u-grace",
    priority: 4,
    due: null,
    notes: "Moved to cold storage",
    done: true,
    created: 1_696_118_400_000,
  },
];

const customers = [
  { id: 7, name: "Acme Corporation", country: "US" },
  { id: 9, name: "Globex", country: "CA" },
];

/** Invoices in the service's model; `poNumber` carries the absent spellings the service writes. */
const invoices = [
  {
    id: 1,
    customerId: 7,
    amountCents: 123_456,
    paid: false,
    issued: 1_699_999_200_000,
    due: { epochMillis: 1_702_591_200_000, offsetMinutes: -300 },
    printed: {
      year: 2023,
      month: 11,
      day: 14,
      hour: 17,
      minute: 13,
      second: 20,
    },
    tags: ["urgent", "overdue"],
    poNumber: "PO-4471",
    seatLimit: 25,
  },
  {
    id: 2,
    customerId: 7,
    amountCents: 99,
    paid: true,
    issued: 1_700_085_600_000,
    due: { epochMillis: 1_702_677_600_000, offsetMinutes: null },
    printed: { year: 2024, month: 1, day: 5, hour: 0, minute: 0, second: 0 },
    tags: [],
    poNumber: null,
    seatLimit: "unlimited",
  },
  {
    id: 3,
    customerId: 9,
    amountCents: -1_250,
    paid: false,
    issued: 1_700_172_000_000,
    due: { epochMillis: 1_702_764_000_000, offsetMinutes: 330 },
    printed: { year: 2024, month: 2, day: 29, hour: 12, minute: 30, second: 5 },
    tags: ["credit"],
    poNumber: "",
    seatLimit: 0,
  },
  {
    id: 4,
    customerId: 9,
    amountCents: 100_000_000,
    paid: true,
    issued: 1_700_258_400_000,
    due: { epochMillis: 1_702_850_400_000, offsetMinutes: 0 },
    printed: {
      year: 2023,
      month: 12,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
    },
    tags: ["annual"],
    poNumber: "null",
    seatLimit: 1_000,
  },
  {
    id: 5,
    customerId: 7,
    amountCents: 500,
    paid: false,
    issued: 1_700_344_800_000,
    due: { epochMillis: 1_702_936_800_000, offsetMinutes: null },
    printed: { year: 2024, month: 7, day: 4, hour: 9, minute: 5, second: 0 },
    tags: ["trial"],
    seatLimit: 3,
  },
  {
    id: 6,
    customerId: 9,
    amountCents: 7_525,
    paid: false,
    issued: 1_700_431_200_000,
    due: { epochMillis: 1_703_023_200_000, offsetMinutes: null },
    printed: {
      year: 2024,
      month: 10,
      day: 10,
      hour: 10,
      minute: 10,
      second: 10,
    },
    tags: ["renewal", "manual"],
    poNumber: "   ",
    seatLimit: 10,
  },
];

const invoicesModified = Date.UTC(2023, 10, 14, 22, 13, 20);

type Json = Parameters<typeof lane.backend>[1];

/** Start the business API's operations part with this test's fixture values (plain JSON). */
const start = (options: { readonly [key: string]: Json } = {}) =>
  lane.backend("business", {
    operations: {
      token,
      tasks,
      customers,
      invoices,
      invoicesModified,
      ...options,
    },
  });

const connect = (
  backend: { readonly origin: string },
  credential: () => string | undefined = () => token,
): Ops.Connection => ({ baseUrl: `${backend.origin}/v2`, credential });

const elapsedSince = (startedAt: number) => Date.now() - startedAt;

const taskId = Schema.decodeSync(Ops.TaskId);

const unexpectedStatus = (error: unknown) =>
  error instanceof Response.UnexpectedResponse
    ? error.metadata.status
    : undefined;

const override = (request: Recorded) =>
  header(request.lines, "x-http-method-override");

/** Reads that must see the service's current state skip the platform's own HTTP cache. */
const uncached = Ops.transportCache("no-store");

/** A Fetch implementation that records each request's cache mode, then sends it for real. */
const recordingFetch = () => {
  const modes: Array<RequestCache | undefined> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    modes.push(init?.cache);
    return globalThis.fetch(input, init);
  };
  return { modes, fetch };
};

const counterKeys = () => {
  let next = 0;
  return () => `k${++next}`;
};

const listed = (backend: { readonly origin: string }) =>
  Ops.listInvoices(connect(backend), { transformClient: uncached }).execute(
    undefined,
  );
const wireOf = (backend: { readonly origin: string }) =>
  Ops.listInvoicesText(connect(backend), uncached).execute(undefined);

const counter = (from: bigint) => {
  let next = from;
  return () => next++;
};
const nonces = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map((request) => header(request.lines, "x-nonce"));
const signatures = (ledger: ReadonlyArray<Recorded>) =>
  new Set(ledger.map((request) => header(request.lines, "x-signature"))).size;

// ---------------------------------------------------------------------------------------------
// STAT-11: the method-override tunnel
// ---------------------------------------------------------------------------------------------

describe(`business operations: method override (STAT-11, ${lane.name})`, () => {
  const replacement: Ops.TaskReplacement = {
    title: "Reconcile the October ledger (revised)",
    assigneeId: "u-ada",
    priority: 1,
    done: true,
  };

  for (const [provider, layer] of lane.clients) {
    it.live(
      `[STAT-11] the gateway refuses a raw PUT and DELETE (${provider})`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const connection = connect(backend);
          const id = taskId("T-1001");
          const put = yield* Ops.replaceTaskUntunnelled(connection).execute({
            path: id,
            body: replacement,
          });
          const del = yield* Ops.deleteTaskUntunnelled(connection).execute({
            path: id,
          });
          const still = yield* Ops.readTask(connection).execute({ path: id });
          for (const refused of [put, del]) {
            expect(refused._tag).toBe("MethodNotAllowed");
            if (refused._tag === "MethodNotAllowed") {
              expect(refused.metadata.headers["allow"]).toBe(
                "GET, HEAD, POST, OPTIONS",
              );
              expect(refused.metadata.headers["via"]).toBe("1.1 api-gateway");
              expect(refused.value.message).toBe("Method Not Allowed");
            }
          }
          expect(still._tag === "Task" && still.value.title).toBe(
            "Reconcile the October ledger",
          );
          const ledger = yield* backend.ledger;
          expect(
            ledger.map((request) => `${request.method} ${request.target}`),
          ).toEqual([
            "PUT /v2/tasks/T-1001",
            "DELETE /v2/tasks/T-1001",
            "GET /v2/tasks/T-1001",
          ]);
        }).pipe(Effect.provide(layer)),
    );

    it.live(
      `[STAT-11] the tunnel sends PUT and DELETE as POST with an override (${provider})`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const connection = connect(backend);
          const id = taskId("T-1001");
          const replaced = yield* Ops.replaceTask(connection).execute({
            path: id,
            body: replacement,
          });
          expect(replaced._tag).toBe("Task");
          if (replaced._tag === "Task") {
            expect(replaced.value.title).toBe(
              "Reconcile the October ledger (revised)",
            );
            expect(replaced.value.done).toBe(true);
            expect(replaced.value.due).toBeNull();
          }
          const deleted = yield* Ops.deleteTask(connection).execute({
            path: id,
          });
          expect(deleted._tag).toBe("Deleted");
          const gone = yield* Ops.readTask(connection).execute({ path: id });
          expect(gone._tag).toBe("NotFound");
          const ledger = yield* backend.ledger;
          expect(
            ledger.map((request) => [
              request.method,
              request.target,
              override(request),
            ]),
          ).toEqual([
            ["POST", "/v2/tasks/T-1001", "PUT"],
            ["POST", "/v2/tasks/T-1001", "DELETE"],
            ["GET", "/v2/tasks/T-1001", undefined],
          ]);
          expect(JSON.parse(bodyText(ledger[0]!))).toEqual({
            title: "Reconcile the October ledger (revised)",
            assigneeId: "u-ada",
            priority: 1,
            done: "Y",
          });
          expect(ledger[1]!.body).toHaveLength(0);
        }).pipe(Effect.provide(layer)),
    );
  }

  it.live(
    "[STAT-11] a rollback deletes the created tasks through the tunnel after a failure",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const connection = connect(backend);
        const create = Ops.createTask(connection);
        const remove = Ops.deleteTask(connection);
        const created: Array<Ops.TaskId> = [];
        const inputs: ReadonlyArray<Ops.NewTask> = [
          {
            title: "Month-end: post accruals",
            assigneeId: "u-ada",
            priority: 2,
          },
          {
            title: "Month-end: close the books",
            assigneeId: "u-ada",
            priority: 2,
          },
          // The client refuses only a blank title; the service also caps the length at 200.
          {
            title: `Month-end: ${"x".repeat(200)}`,
            assigneeId: "u-ada",
            priority: 2,
          },
        ];
        const saga = Effect.forEach(inputs, (body) =>
          Effect.flatMap(create.execute({ body }), (result) =>
            result._tag === "Created"
              ? Effect.sync(() => created.push(result.value.id))
              : Effect.fail(result),
          ),
        ).pipe(
          Effect.onError(() =>
            Effect.forEach(
              created.toReversed(),
              (path) => remove.execute({ path }),
              {
                discard: true,
              },
            ).pipe(Effect.orDie),
          ),
        );
        const failure = yield* Effect.flip(saga);
        expect(failure._tag).toBe("Invalid");
        if (failure._tag === "Invalid")
          expect(failure.value.errors).toEqual([
            { field: "title", message: "at most 200 characters" },
          ]);
        expect(created).toEqual(["T-1003", "T-1004"]);
        const search = yield* Ops.searchTasks(connection).execute({
          query: { q: "month-end" },
        });
        expect(search._tag === "Results" && search.value.hits).toEqual([]);
        const ledger = yield* backend.ledger;
        expect(
          ledger.map((request) => [
            request.method,
            request.target,
            override(request),
          ]),
        ).toEqual([
          ["POST", "/v2/tasks", undefined],
          ["POST", "/v2/tasks", undefined],
          ["POST", "/v2/tasks", undefined],
          ["POST", "/v2/tasks/T-1004", "DELETE"],
          ["POST", "/v2/tasks/T-1003", "DELETE"],
          ["GET", "/v2/search?q=month-end", undefined],
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});

// ---------------------------------------------------------------------------------------------
// QRY-2 and QRY-3: query and path composition
// ---------------------------------------------------------------------------------------------

describe(`business operations: query and path (QRY-2, QRY-3, ${lane.name})`, () => {
  for (const [provider, layer] of lane.clients)
    it.live(
      `[QRY-2] repeated parameters reach the server, which keeps the last (${provider})`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const list = Ops.listTasks(connect(backend));
          const doneLast = yield* list.execute({
            query: { status: ["open", "done"] },
          });
          const openLast = yield* list.execute({
            query: { status: ["done", "open"] },
          });
          expect(
            doneLast._tag === "Tasks" && doneLast.value.applied.status,
          ).toBe("done");
          expect(
            doneLast._tag === "Tasks" &&
              doneLast.value.items.map((task) => task.id),
          ).toEqual(["T-1002"]);
          expect(
            openLast._tag === "Tasks" && openLast.value.applied.status,
          ).toBe("open");
          expect(
            openLast._tag === "Tasks" &&
              openLast.value.items.map((task) => task.id),
          ).toEqual(["T-1001"]);
          // Both entries were on the wire; the collapse happened in the server.
          const ledger = yield* backend.ledger;
          expect(ledger.map((request) => request.target)).toEqual([
            "/v2/tasks?status=open&status=done",
            "/v2/tasks?status=done&status=open",
          ]);
          expect(queryOf(ledger[0]!).getAll("status")).toEqual([
            "open",
            "done",
          ]);
          // Keeping the last is this fixture's PHP-era rule; the URL parser's `get` keeps the first.
          expect(queryOf(ledger[0]!).get("status")).toBe("open");
        }).pipe(Effect.provide(layer)),
    );

  it.live(
    "[QRY-3] an empty id leaves an empty segment, and merged slashes answer another resource",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const result = yield* Ops.taskHistoryAnyId(connect(backend)).execute({
          path: "",
        });
        const ledger = yield* backend.ledger;
        expect(ledger.map((request) => request.target)).toEqual([
          "/v2/tasks//history",
        ]);
        // The gateway merged the slashes and answered with the history of every task, as a 200.
        expect(result._tag).toBe("History");
        expect(
          result._tag === "History" &&
            result.value.events.map((event) => event.task),
        ).toEqual(["T-1001", "T-1002"]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[QRY-3] the application contract refuses an empty id before dispatch",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const history = Ops.taskHistory(connect(backend));
        const refused = yield* Effect.flip(
          history.execute({ path: "" as Ops.TaskId }),
        );
        expect(Schema.isSchemaError(refused)).toBe(true);
        expect(yield* backend.ledger).toHaveLength(0);
        const one = yield* history.execute({ path: taskId("T-1001") });
        expect(
          one._tag === "History" && one.value.events.map((event) => event.task),
        ).toEqual(["T-1001"]);
        const ledger = yield* backend.ledger;
        expect(ledger.map((request) => request.target)).toEqual([
          "/v2/tasks/T-1001/history",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[QRY-3] one operation replaces the shared base URL and keeps the credential",
    () =>
      Effect.gen(function* () {
        const primary = yield* start();
        const archive = yield* start({ invoices: invoices.slice(0, 1) });
        const connection = connect(primary);
        const fromPrimary = yield* Ops.listInvoices(connection, {
          transformClient: uncached,
        }).execute(undefined);
        const fromArchive = yield* Ops.listInvoices(connection, {
          archiveBaseUrl: `${archive.origin}/v2/`,
          transformClient: uncached,
        }).execute(undefined);
        expect(fromPrimary.value.invoices).toHaveLength(6);
        expect(fromArchive.value.invoices.map((invoice) => invoice.id)).toEqual(
          [1],
        );
        expect(yield* primary.ledger).toHaveLength(1);
        const archived = yield* archive.ledger;
        // The trailing slash of the replacement base joins without doubling.
        expect(archived.map((request) => request.target)).toEqual([
          "/v2/invoices",
        ]);
        expect(header(archived[0]!.lines, "authorization")).toBe(
          `Bearer ${token}`,
        );
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});

// ---------------------------------------------------------------------------------------------
// STAT-8 and STAT-9: retry classification and Retry-After
// ---------------------------------------------------------------------------------------------

describe(`business operations: retry classification (STAT-8, STAT-9, ${lane.name})`, () => {
  it.live("[STAT-8] the unregistered 420 is not transient by default", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      const error = yield* Effect.flip(
        Ops.quote(connect(backend), Policy.make(Schedule.recurs(3))).execute({
          path: "EURUSD",
        }),
      );
      expect(error).toBeInstanceOf(Response.UnexpectedResponse);
      if (error instanceof Response.UnexpectedResponse) {
        expect(error.metadata.status).toBe(420);
        expect(error.metadata.headers["retry-after"]).toBe("1");
      }
      expect(yield* backend.ledger).toHaveLength(1);
    }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[STAT-8] a classifier adds 420 and keeps the built-in 503, honouring Retry-After",
    () =>
      Effect.gen(function* () {
        const backend = yield* start({ clock: 1_700_000_000_000 });
        const startedAt = Date.now();
        // Three attempts in total: an early return to the limiter would meet 420 again and run out.
        const quote = yield* Ops.quote(
          connect(backend),
          Policy.make(Schedule.recurs(2), { while: Ops.transientOrCalm }),
        ).execute({ path: "EURUSD" });
        expect(quote.rate).toBe("1.0842");
        expect(DateTime.toEpochMillis(quote.asOf)).toBe(1_700_000_000_000);
        expect(elapsedSince(startedAt)).toBeGreaterThanOrEqual(950);
        const ledger = yield* backend.ledger;
        expect(ledger.map((request) => request.target)).toEqual([
          "/v2/rates/EURUSD",
          "/v2/rates/EURUSD",
          "/v2/rates/EURUSD",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[STAT-8] a classifier that replaces the built-in cases loses the 503 that follows",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const error = yield* Effect.flip(
          Ops.quote(
            connect(backend),
            Policy.make(Schedule.recurs(3), {
              while: (reason) => reason.metadata?.status === 420,
            }),
          ).execute({ path: "EURUSD" }),
        );
        expect(unexpectedStatus(error)).toBe(503);
        expect(yield* backend.ledger).toHaveLength(2);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[STAT-9] Retry-After in seconds and as an HTTP-date are both honoured unaided",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const startedAt = Date.now();
        // Exactly two retries: an early return meets the same 429 or 503 again and runs out.
        const report = yield* Ops.report(
          connect(backend),
          Policy.make(Schedule.recurs(2)),
        ).execute({
          path: "month-end",
        });
        expect(report.rows).toEqual([["2023-11", 123_456]]);
        expect(elapsedSince(startedAt)).toBeGreaterThanOrEqual(1_450);
        expect(yield* backend.ledger).toHaveLength(3);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[STAT-9] a 429 with an HTTP-date Retry-After is honoured", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      const exportStatus = (policy: Policy.Policy) =>
        Ops.exportStatus(connect(backend), policy).execute({
          path: "ledger-2023-11",
        });
      const first = yield* Effect.flip(exportStatus(Policy.none));
      expect(unexpectedStatus(first)).toBe(429);
      const retryAfter =
        first instanceof Response.UnexpectedResponse
          ? first.metadata.headers["retry-after"]
          : undefined;
      // The servlet's date form, read with the strict HTTP-date schema: a whole second ahead.
      const until = DateTime.toEpochMillis(
        Schema.decodeUnknownSync(Values.HttpDate)(retryAfter),
      );
      expect(until % 1_000).toBe(0);
      expect(until - Date.now()).toBeGreaterThan(0);
      expect(until - Date.now()).toBeLessThanOrEqual(1_500);
      const ready = yield* exportStatus(Policy.make(Schedule.recurs(1)));
      expect(ready.status).toBe("ready");
      expect(Date.now()).toBeGreaterThanOrEqual(until - 50);
      expect(yield* backend.ledger).toHaveLength(3);
    }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[STAT-9] ignoring Retry-After meets the same refusal until the budget runs out",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const startedAt = Date.now();
        const error = yield* Effect.flip(
          Ops.report(
            connect(backend),
            Policy.make(Schedule.recurs(2), { retryAfter: false }),
          ).execute({ path: "month-end" }),
        );
        expect(unexpectedStatus(error)).toBe(429);
        expect(yield* backend.ledger).toHaveLength(3);
        expect(elapsedSince(startedAt)).toBeLessThan(900);
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});

// ---------------------------------------------------------------------------------------------
// HDR-8: the edge cache
// ---------------------------------------------------------------------------------------------

describe(`business operations: edge cache (HDR-8, ${lane.name})`, () => {
  const catalog = {
    prices: [{ sku: "A-100", cents: 1_000 }],
    stale: [{ sku: "A-100", cents: 900 }],
  };

  type Prices = {
    readonly value: typeof Ops.PriceList.Type;
    readonly metadata: Response.Metadata;
  };
  const seen = (result: Prices) => [
    result.metadata.headers["x-cache"],
    result.value.prices[0]!.price,
  ];

  it.live(
    "[HDR-8] the edge ignores Cache-Control and the cache mode, and honours only the cache key",
    () => {
      const recorder = recordingFetch();
      return Effect.gen(function* () {
        const backend = yield* start({ catalog });
        const connection = connect(backend);
        // Every read here skips the platform's own cache, so each one reaches the edge in both lanes.
        const noKey = Ops.prices(connection, Ops.transportCache("no-store"));
        const bypass = Ops.prices(
          connection,
          Ops.bypassEdgeCache(counterKeys()),
        );

        const warm = yield* noKey.execute(undefined);
        expect(seen(warm)).toEqual(["HIT", 900]);
        expect(Number(warm.metadata.headers["age"])).toBeGreaterThanOrEqual(
          3_600,
        );
        // Purge first, for a known state.
        expect(
          (yield* Ops.purgePrices(connection).execute(undefined)).purged,
        ).toBe(1);
        expect(seen(yield* noKey.execute(undefined))).toEqual(["MISS", 1_000]);
        yield* Ops.changePrice(connection).execute({
          body: { sku: "A-100", price: Values.Cents.make(1_250) },
        });
        // `no-store` makes Fetch send `Cache-Control: no-cache`; the edge ignores it.
        expect(seen(yield* noKey.execute(undefined))).toEqual(["HIT", 1_000]);
        expect(seen(yield* bypass.execute(undefined))).toEqual(["MISS", 1_250]);
        expect(seen(yield* bypass.execute(undefined))).toEqual(["MISS", 1_250]);

        const ledger = yield* backend.ledger;
        expect(
          ledger.map((request) => `${request.method} ${request.target}`),
        ).toEqual([
          "GET /v2/catalog/prices",
          "PURGE /v2/catalog/prices",
          "GET /v2/catalog/prices",
          "POST /v2/catalog/prices",
          "GET /v2/catalog/prices",
          "GET /v2/catalog/prices?v=k1",
          "GET /v2/catalog/prices?v=k2",
        ]);
        for (const index of [0, 2, 4, 5, 6]) {
          expect(header(ledger[index]!.lines, "cache-control")).toBe(
            "no-cache",
          );
          expect(header(ledger[index]!.lines, "pragma")).toBe("no-cache");
        }
        expect(recorder.modes).toEqual([
          "no-store",
          undefined,
          "no-store",
          undefined,
          "no-store",
          "no-store",
          "no-store",
        ]);
      }).pipe(
        Effect.provide(lane.fetchClient),
        Effect.provideService(FetchHttpClient.Fetch, recorder.fetch),
      );
    },
  );

  it.live(
    "[HDR-8] purging the edge leaves the platform cache, which the transform's cache mode skips",
    () =>
      Effect.gen(function* () {
        const backend = yield* start({ catalog });
        const connection = connect(backend);
        const plain = Ops.prices(connection);

        // The edge's stale copy carries `max-age=86400`, which a browser's HTTP cache honours.
        expect(seen(yield* plain.execute(undefined))).toEqual(["HIT", 900]);
        expect(
          (yield* Ops.purgePrices(connection).execute(undefined)).purged,
        ).toBe(1);
        const after = yield* plain.execute(undefined);
        const skip = yield* Ops.prices(
          connection,
          Ops.transportCache("no-store"),
        ).execute(undefined);
        const bypassed = yield* Ops.prices(
          connection,
          Ops.bypassEdgeCache(counterKeys()),
        ).execute(undefined);
        const ledger = yield* backend.ledger;
        if (lane.name === "browser") {
          // Chromium answered from its own cache: the purge did not reach it, and nothing was sent.
          expect(seen(after)).toEqual(["HIT", 900]);
          expect(
            ledger.map((request) => `${request.method} ${request.target}`),
          ).toEqual([
            "GET /v2/catalog/prices",
            "PURGE /v2/catalog/prices",
            "GET /v2/catalog/prices",
            "GET /v2/catalog/prices?v=k1",
          ]);
          expect(seen(skip)).toEqual(["MISS", 1_000]);
        } else {
          // Node's Fetch keeps no HTTP cache, so the plain read reached the purged edge.
          expect(seen(after)).toEqual(["MISS", 1_000]);
          expect(
            ledger.map((request) => `${request.method} ${request.target}`),
          ).toEqual([
            "GET /v2/catalog/prices",
            "PURGE /v2/catalog/prices",
            "GET /v2/catalog/prices",
            "GET /v2/catalog/prices",
            "GET /v2/catalog/prices?v=k1",
          ]);
          expect(seen(skip)).toEqual(["HIT", 1_000]);
        }
        expect(seen(bypassed)).toEqual(["MISS", 1_000]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});

// ---------------------------------------------------------------------------------------------
// VAL-1b to VAL-5b: value conventions over the wire
// ---------------------------------------------------------------------------------------------

describe(`business operations: value conventions (VAL-1b to VAL-5b, ${lane.name})`, () => {
  it.live(
    "[VAL-1b] invoice dates decode from epoch, ASP.NET, US local and HTTP-date forms",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { value, lastModified } = yield* listed(backend);
        expect(DateTime.toEpochMillis(lastModified)).toBe(invoicesModified);
        value.invoices.forEach((invoice, index) => {
          const seed = invoices[index]!;
          expect(DateTime.toEpochMillis(invoice.issued)).toBe(seed.issued);
          expect(DateTime.toEpochMillis(invoice.due)).toBe(
            seed.due.epochMillis,
          );
          if (seed.due.offsetMinutes === null)
            expect(DateTime.isUtc(invoice.due)).toBe(true);
          else
            expect(
              DateTime.isZoned(invoice.due) &&
                DateTime.zonedOffset(invoice.due),
            ).toBe(seed.due.offsetMinutes * 60_000);
          expect(invoice.printed).toEqual(seed.printed);
        });
        // The service escapes the slashes of its ASP.NET dates; JSON parsing removed them.
        const wire = yield* wireOf(backend);
        expect(wire).toContain(
          String.raw`"due":"\/Date(1702591200000-0500)\/"`,
        );
        expect(wire).toContain(
          String.raw`"due":"\/Date(1702764000000+0530)\/"`,
        );
        expect(wire).toContain(String.raw`"due":"\/Date(1702677600000)\/"`);
        expect(wire).toContain(`"printed":"11/14/2023 5:13:20 PM"`);
        expect(wire).toContain(`"printed":"1/5/2024 12:00:00 AM"`);
        expect(wire).toContain(`"issued":1699999200000`);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[VAL-2a] amounts decode to branded cents from the service's dollar strings",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { value } = yield* listed(backend);
        expect(value.invoices.map((invoice) => invoice.amount)).toEqual(
          invoices.map((seed) => seed.amountCents),
        );
        const wire = yield* wireOf(backend);
        for (const spelling of [
          "$1,234.56",
          "$0.99",
          "-$12.50",
          "$1,000,000.00",
          "$75.25",
        ])
          expect(wire).toContain(`"amount":"${spelling}"`);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[VAL-2a] the service refuses unformatted money and loose spellings from an untyped body",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const result = yield* Ops.replaceInvoiceUnchecked(
          connect(backend),
        ).execute({
          path: 1,
          body: {
            customer: 7,
            amount: "1234.56",
            paid: "y",
            issued: invoices[0]!.issued,
            due: "/Date(1702591200000-0500)/",
            printed: "11/14/2023 17:13:20",
            tags: "urgent overdue",
            seatLimit: 25,
          },
        });
        expect(result._tag).toBe("Invalid");
        expect(
          result._tag === "Invalid" &&
            result.value.errors.map((error) => error.field),
        ).toEqual(["amount", "paid", "printed"]);
        const after = yield* listed(backend);
        expect(after.value.invoices[0]!.amount).toBe(123_456);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[VAL-3a] Y and N flags decode to booleans", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      const { value } = yield* listed(backend);
      expect(value.invoices.map((invoice) => invoice.paid)).toEqual(
        invoices.map((seed) => seed.paid),
      );
      const wire = yield* wireOf(backend);
      expect(wire).toContain(`"paid":"Y"`);
      expect(wire).toContain(`"paid":"N"`);
    }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[VAL-4] five spellings of absence collapse, and unlimited stays distinct from zero",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const wire = yield* wireOf(backend);
        for (const spelling of [
          `"poNumber":null`,
          `"poNumber":""`,
          `"poNumber":"null"`,
          `"poNumber":"   "`,
        ])
          expect(wire).toContain(spelling);
        expect(JSON.parse(wire).invoices[4]).not.toHaveProperty("poNumber");
        expect(wire).toContain(`"seatLimit":-1`);
        expect(wire).toContain(`"seatLimit":0`);
        const { value } = yield* listed(backend);
        expect(value.invoices.map((invoice) => invoice.poNumber)).toEqual([
          "PO-4471",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
        expect(value.invoices.map((invoice) => "poNumber" in invoice)).toEqual([
          true,
          false,
          false,
          false,
          false,
          false,
        ]);
        expect(value.invoices.map((invoice) => invoice.seatLimit)).toEqual([
          25,
          "unlimited",
          0,
          1_000,
          3,
          10,
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[VAL-4] re-encoding writes the canonical absence, which the service stores and serves",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const connection = connect(backend);
        // A plain read: the platform's cache decides whether it may keep the answer.
        const { value } =
          yield* Ops.listInvoices(connection).execute(undefined);
        const original = value.invoices[2]!;
        const replaced = yield* Ops.replaceInvoice(connection).execute({
          path: 3,
          body: original,
        });
        expect(replaced._tag).toBe("Invoice");
        if (replaced._tag === "Invoice") {
          expect(replaced.value.value).toEqual(original);
          expect(
            DateTime.toEpochMillis(replaced.value.lastModified),
          ).toBeGreaterThan(invoicesModified);
        }
        const ledger = yield* backend.ledger;
        expect([ledger[1]!.method, override(ledger[1]!)]).toEqual([
          "POST",
          "PUT",
        ]);
        expect(JSON.parse(bodyText(ledger[1]!))).toEqual({
          id: 3,
          customer: { id: 9, name: "Globex", country: "CA" },
          amount: "-$12.50",
          paid: "N",
          issued: 1_700_172_000_000,
          due: "/Date(1702764000000+0530)/",
          printed: "2/29/2024 12:30:05 PM",
          tags: "credit",
          seatLimit: 0,
        });
        // The empty-string spelling became the canonical missing key: the stated loss.
        const wire = yield* wireOf(backend);
        expect(JSON.parse(wire).invoices[2]).not.toHaveProperty("poNumber");
        const plainReread = JSON.parse(
          yield* Ops.listInvoicesText(connection).execute(undefined),
        );
        if (lane.name === "browser")
          // `Last-Modified` without `Cache-Control` let Chromium reuse the list it read before the
          // write, by heuristic freshness, without asking the service.
          expect(plainReread.invoices[2].poNumber).toBe("");
        else expect(plainReread.invoices[2]).not.toHaveProperty("poNumber");
        // A present value that the wire would read back as absent never leaves the client.
        const before = (yield* backend.ledger).length;
        const refused = yield* Effect.flip(
          Ops.replaceInvoice(connection).execute({
            path: 3,
            body: { ...original, poNumber: "null" },
          }),
        );
        expect(Schema.isSchemaError(refused)).toBe(true);
        expect(yield* backend.ledger).toHaveLength(before);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[VAL-5b] customers arrive expanded once, then as bare ids, and tags as words",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { value } = yield* listed(backend);
        expect(value.invoices.map((invoice) => invoice.customer)).toEqual([
          { _tag: "Expanded", id: 7, name: "Acme Corporation", country: "US" },
          { _tag: "Reference", id: 7 },
          { _tag: "Expanded", id: 9, name: "Globex", country: "CA" },
          { _tag: "Reference", id: 9 },
          { _tag: "Reference", id: 7 },
          { _tag: "Reference", id: 9 },
        ]);
        expect(value.invoices.map((invoice) => invoice.tags)).toEqual(
          invoices.map((seed) => seed.tags),
        );
        const wire = yield* wireOf(backend);
        expect(wire).toContain(`"customer":7,`);
        expect(wire).toContain(`"tags":"renewal manual"`);
        expect(wire).toContain(`"tags":""`);
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});

// ---------------------------------------------------------------------------------------------
// RET-1: nonces, warm-ups and retries
// ---------------------------------------------------------------------------------------------

describe(`business operations: nonce and warm-up (RET-1, ${lane.name})`, () => {
  const body = { amount: Values.Cents.make(1_200), to: "acct-ada" };

  it.live(
    "[RET-1] a policy that replays the encoded request turns the warm-up into a permanent replay",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const startedAt = Date.now();
        const result = yield* Ops.payoutSignedPerEvaluation(
          connect(backend),
          counter(1n),
          Policy.make(Schedule.recurs(3)),
        ).execute({ body });
        expect(result._tag).toBe("Replayed");
        if (result._tag === "Replayed")
          expect(result.value.error).toBe("nonce_replayed");
        // The retry waited for the warm-up's HTTP-date, then sent the same nonce and signature.
        expect(elapsedSince(startedAt)).toBeGreaterThanOrEqual(200);
        const ledger = yield* backend.ledger;
        expect(nonces(ledger)).toEqual(["1", "1"]);
        expect(signatures(ledger)).toBe(1);
        expect(bodyText(ledger[0]!)).toBe(bodyText(ledger[1]!));
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[RET-1] a caller-driven loop takes a new nonce per execution and honours Retry-After",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const startedAt = Date.now();
        const result = yield* Ops.payoutUntilReady(
          connect(backend),
          counter(41n),
          3,
        ).execute({
          body,
        });
        expect(result._tag).toBe("Paid");
        if (result._tag === "Paid") expect(result.value.nonce).toBe("43");
        expect(elapsedSince(startedAt)).toBeGreaterThanOrEqual(450);
        const ledger = yield* backend.ledger;
        expect(nonces(ledger)).toEqual(["41", "42", "43"]);
        expect(signatures(ledger)).toBe(3);
        expect(new Set(ledger.map((request) => bodyText(request))).size).toBe(
          1,
        );
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[RET-1] the caller-driven loop stops at its own budget", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      const result = yield* Ops.payoutUntilReady(
        connect(backend),
        counter(5n),
        1,
      ).execute({ body });
      expect(result._tag).toBe("WarmingUp");
      expect(nonces(yield* backend.ledger)).toEqual(["5", "6"]);
    }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[RET-1] per-attempt middleware advances the nonce while the credential resolves once",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        let reads = 0;
        // The token source rotates right after the first read; a re-read mid-retry would send it.
        const connection = connect(backend, () =>
          reads++ === 0 ? token : "rotated-token",
        );
        const payout = Ops.payoutSignedPerAttempt(
          connection,
          counter(100n),
          Policy.make(Schedule.recurs(2)),
        );
        const result = yield* payout.execute({ body });
        expect(result._tag).toBe("Paid");
        expect(reads).toBe(1);
        const ledger = yield* backend.ledger;
        expect(nonces(ledger)).toEqual(["100", "101", "102"]);
        expect(signatures(ledger)).toBe(3);
        expect(
          new Set(
            ledger.map((request) => header(request.lines, "authorization")),
          ),
        ).toEqual(new Set([`Bearer ${token}`]));
        // The next evaluation reads the credential again and gets the rotated token.
        const next = yield* payout.execute({ body });
        expect(next._tag).toBe("Unauthorized");
        expect(reads).toBe(2);
        const after = yield* backend.ledger;
        expect(header(after[3]!.lines, "authorization")).toBe(
          "Bearer rotated-token",
        );
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live("[RET-1] the policy's budget still bounds per-attempt retries", () =>
    Effect.gen(function* () {
      const backend = yield* start();
      const result = yield* Ops.payoutSignedPerAttempt(
        connect(backend),
        counter(7n),
        Policy.make(Schedule.recurs(1)),
      ).execute({ body });
      expect(result._tag).toBe("WarmingUp");
      expect(nonces(yield* backend.ledger)).toEqual(["7", "8"]);
    }).pipe(Effect.provide(lane.fetchClient)),
  );
});

// ---------------------------------------------------------------------------------------------
// RET-2: the long poll
// ---------------------------------------------------------------------------------------------

describe(`business operations: long poll (RET-2, ${lane.name})`, () => {
  it.live(
    "[RET-2] a whole-operation timeout fails as a timeout, and the server sees the abort",
    () =>
      Effect.gen(function* () {
        const backend = yield* start({ longPollHold: 10_000 });
        const connection = connect(backend);
        const startedAt = Date.now();
        const error = yield* Effect.flip(
          Ops.pollEvents(connection)
            .execute(undefined)
            .pipe(Effect.timeout("300 millis")),
        );
        expect(Cause.isTimeoutError(error)).toBe(true);
        expect(elapsedSince(startedAt)).toBeLessThan(2_000);
        // The service's own record of the client going away, waited for over HTTP.
        const seen = yield* Ops.abandonedRequests(connection).execute({
          query: { atLeast: 1 },
        });
        expect(seen.abandoned).toEqual([
          { route: "events", target: "/v2/events?after=0" },
        ]);
        const [poll] = yield* backend.ledger;
        expect(poll!.aborted).toBe(true);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[RET-2] a per-attempt timeout is transient and retried, then surfaces as a timeout",
    () =>
      Effect.gen(function* () {
        const backend = yield* start({ longPollHold: 10_000 });
        const connection = connect(backend);
        const error = yield* Effect.flip(
          Ops.pollEvents(
            connection,
            Policy.make(Schedule.recurs(1), { attemptTimeout: "200 millis" }),
          ).execute(undefined),
        );
        expect(Cause.isTimeoutError(error)).toBe(true);
        const seen = yield* Ops.abandonedRequests(connection).execute({
          query: { atLeast: 2 },
        });
        expect(seen.abandoned.map((entry) => entry.route)).toEqual([
          "events",
          "events",
        ]);
      }).pipe(Effect.provide(lane.fetchClient)),
  );

  it.live(
    "[RET-2] a poll the server ends, or an event releases, decodes as the mapped answer",
    () =>
      Effect.gen(function* () {
        const backend = yield* start({ longPollHold: 150 });
        const connection = connect(backend);
        const empty = yield* Ops.pollEvents(connection).execute(undefined);
        expect(empty.value).toEqual({ events: [], next: 0 });
        const held = yield* Ops.pollEvents(connection)
          .execute(undefined)
          .pipe(Effect.forkChild);
        yield* backend.arrived(2);
        yield* Ops.publishEvent(connection).execute({
          body: { type: "ledger.closed" },
        });
        const released = yield* Fiber.join(held);
        expect(released.value).toEqual({
          events: [{ id: 1, type: "ledger.closed" }],
          next: 1,
        });
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});
