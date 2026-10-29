import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Duration, Effect, Option, Schedule, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
  Transport,
} from "viell-effect-schema-http";
import * as Business from "../backends/business/index.js";
import * as Dialect from "../clients/business/envelopes-dialects.js";
import * as Envelopes from "../clients/business/envelopes.js";
import { fetchClient, linesLayer } from "../harness/providers.js";
import { header, path, type Received, serve, text } from "../harness/server.js";

/*
 * The `/v1/` envelopes of the JSON business API, driven through the consumer's contracts in
 * `src/clients/business/envelopes.ts`. Provider choice per test:
 *
 * - `fetchClient` by default: it is what a browser runs, and fetch resolves a response as soon as its
 *   head arrives, so body reads are observable separately from selection.
 * - `linesLayer` where the original response lines matter.
 *
 * Tests that read a response header a cross-origin browser hides unless the server exposes it
 * (`Location`, `Link`, `Retry-After`, `X-Error-Code`, `X-Served-By`) are marked node-only: this
 * backend sends no `Access-Control-Expose-Headers`, and Node's fetch applies no CORS.
 */

/** Start the business API for one test. This file starts servers nowhere else. */
const start = Effect.gen(function* () {
  const server = yield* serve(Business.handler());
  return { server, api: Envelopes.make(server.origin) };
});

const body = (received: Received | undefined): string =>
  received === undefined ? "" : text(received);

/** Client middleware recording the metadata of every response an operation receives. */
const recording = () => {
  const seen: Array<Response.Metadata> = [];
  return {
    seen,
    transformClient: (client: HttpClient.HttpClient) =>
      HttpClient.tap(client, (response) =>
        Effect.sync(() => {
          seen.push(Response.metadata(response));
        }),
      ),
  };
};

/**
 * Client middleware that replaces each response body with a pass-through stream recording every
 * pull. `highWaterMark: 0` makes the stream pull only when somebody reads, so the events show exactly
 * when body bytes were consumed relative to rule selection.
 */
const watching =
  (events: Array<string>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.transformResponse(
      client,
      Effect.map((response) => {
        events.push(`response ${response.status}`);
        const web = Option.getOrThrow(HttpClientResponse.toWeb(response));
        const reader = web.body?.getReader();
        const watched =
          reader === undefined
            ? null
            : new ReadableStream<Uint8Array>(
                {
                  pull: async (controller) => {
                    const chunk = await reader.read();
                    if (chunk.done) {
                      events.push("body end");
                      controller.close();
                    } else {
                      events.push("body bytes");
                      controller.enqueue(chunk.value);
                    }
                  },
                  cancel: (reason) => reader.cancel(reason),
                },
                { highWaterMark: 0 },
              );
        const replaced = HttpClientResponse.fromWeb(
          response.request,
          new globalThis.Response(watched, {
            status: web.status,
            statusText: web.statusText,
            headers: web.headers,
          }),
        );
        return Option.match(Transport.responseHeaderLines(response), {
          onNone: () => replaced,
          onSome: (lines) => Transport.withResponseHeaders(replaced, lines),
        });
      }),
    );

/** A first rule that never matches and records when selection consults it. */
const selection = (events: Array<string>) =>
  Response.when((metadata) => {
    events.push(`select ${metadata.status}`);
    return false;
  }, Body.empty);

const firstBodyRead = (events: ReadonlyArray<string>) =>
  events.findIndex((event) => event.startsWith("body"));

/** The original value of a response header line, from a provider that reports lines. */
const rawLine = (metadata: Response.Metadata | undefined, name: string) =>
  Option.getOrThrow(metadata!.headerLines).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];

const isJsonParseFailure = (cause: unknown) =>
  HttpClientError.isHttpClientError(cause) &&
  cause.reason._tag === "DecodeError" &&
  cause.reason.cause instanceof SyntaxError;

const order = (
  customerId: number,
  poNumber: string,
  sku = "WID-100",
  quantity = 2,
): Envelopes.NewOrder => ({
  customerId,
  poNumber,
  lines: [{ sku, quantity }],
});

describe("business API: envelopes", () => {
  describe("errors outside the status line", () => {
    it.live(
      "[ERR-1d] decodes a found customer and a not-found 200 into one union",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const found = yield* api.getCustomer.execute({ path: 1001 });
          const missing = yield* api.getCustomer.execute({ path: 999 });
          expect(found).toEqual({
            result: "OK",
            customer: {
              id: 1001,
              name: "Northwind Traders",
              tier: "GOLD",
              archived: false,
            },
          });
          expect(missing).toEqual({
            result: "NOT_FOUND",
            message: "Customer 999 was not found",
          });
          // Both were 200s: only the body discriminates them.
          const required = yield* api.requireCustomer
            .execute({ path: 999 })
            .pipe(Effect.flip);
          expect(required).toBeInstanceOf(Envelopes.CustomerNotFound);
          expect(required).toMatchObject({
            message: "Customer 999 was not found",
          });
          expect(
            server.ledger.map(
              (request) => `${request.method} ${request.target}`,
            ),
          ).toEqual([
            "GET /v1/customers/1001",
            "GET /v1/customers/999",
            "GET /v1/customers/999",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — reads X-Error-Code and X-Error-Message, which a cross-origin browser hides
    // because the backend exposes no headers.
    it.live(
      "[ERR-2] selects the header error rule ahead of the plain 200 rule",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const place = Operation.make(
            api.requests.placeOrder,
            api.responses.placeOrder,
            {
              transformClient: record.transformClient,
            },
          );
          const held = yield* place.execute({ body: order(1002, "PO-HOLD") });
          const accepted = yield* place.execute({ body: order(1001, "PO-1") });
          const duplicate = yield* place.execute({ body: order(1001, "PO-1") });
          expect(held).toEqual({
            _tag: "Rejected",
            code: "CREDIT_HOLD",
            message: "Customer 1002 is on credit hold",
          });
          expect(accepted).toEqual({
            _tag: "Accepted",
            order: { orderId: "SO-5001", status: "ACCEPTED", totalCents: 2500 },
          });
          expect(duplicate).toMatchObject({
            _tag: "Rejected",
            code: "DUPLICATE_PO",
          });
          // Every answer was a 200 with a JSON content type; only the header told them apart.
          expect(record.seen.map((metadata) => metadata.status)).toEqual([
            200, 200, 200,
          ]);
          expect(
            record.seen.map((metadata) => metadata.headers["x-error-code"]),
          ).toEqual(["CREDIT_HOLD", undefined, "DUPLICATE_PO"]);
          expect(record.seen[0]?.headers["content-type"]).toBe(
            "application/json;charset=UTF-8",
          );
          expect(server.ledger).toHaveLength(3);
          expect(JSON.parse(body(server.ledger[0]))).toEqual(
            order(1002, "PO-HOLD"),
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — the error code travels in X-Error-Code, which a cross-origin browser hides.
    it.live(
      "[ERR-2] declared after the plain 200 rule, the header rule is unreachable and the decode failure is final",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const misordered = Operation.make(
            api.requests.placeOrder,
            Envelopes.orderAccepted.pipe(
              Response.orElse(Envelopes.orderRejected),
            ),
          );
          const error = yield* misordered
            .execute({ body: order(1002, "PO-HOLD") })
            .pipe(Effect.flip);
          expect(error._tag).toBe("DecodeError");
          if (error._tag !== "DecodeError") return;
          expect(error.metadata.status).toBe(200);
          expect(error.metadata.headers["x-error-code"]).toBe("CREDIT_HOLD");
          // The plain rule read the exception text as JSON and failed; nothing fell through.
          expect(isJsonParseFailure(error.cause)).toBe(true);
          expect(server.ledger).toHaveLength(1);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[ERR-3] discriminates per-item statuses inside an always-200 batch envelope",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const submit = Operation.make(
            api.requests.submitBatch,
            api.responses.submitBatch,
            {
              transformClient: record.transformClient,
            },
          );
          const batch = yield* submit.execute({
            body: {
              orders: [
                order(1001, "PO-A", "WID-100", 2),
                order(1001, "PO-A", "GAD-200", 1),
                order(1002, "PO-B"),
                order(1003, "PO-C", "NOPE-1"),
                order(9999, "PO-D"),
              ],
            },
          });
          expect(batch).toEqual({
            batchId: "B-9001",
            results: [
              {
                _tag: "Created",
                index: 0,
                order: {
                  orderId: "SO-5001",
                  status: "ACCEPTED",
                  totalCents: 2500,
                },
              },
              {
                _tag: "Failed",
                index: 1,
                status: 409,
                code: "DUPLICATE_PO",
                message:
                  "Purchase order PO-A was already placed for customer 1001",
              },
              {
                _tag: "Failed",
                index: 2,
                status: 403,
                code: "CREDIT_HOLD",
                message: "Customer 1002 is on credit hold",
              },
              {
                _tag: "Failed",
                index: 3,
                status: 422,
                code: "UNKNOWN_SKU",
                message: "SKU NOPE-1 is not in the catalogue",
              },
              {
                _tag: "Failed",
                index: 4,
                status: 404,
                code: "UNKNOWN_CUSTOMER",
                message: "Customer 9999 does not exist",
              },
            ],
          });
          // A batch where every item fails is still a 200 envelope.
          const failed = yield* submit.execute({
            body: { orders: [order(1001, "PO-A")] },
          });
          expect(failed.results.map((item) => item._tag)).toEqual(["Failed"]);
          expect(record.seen.map((metadata) => metadata.status)).toEqual([
            200, 200,
          ]);
          expect(
            server.ledger.map(
              (request) => `${request.method} ${request.target}`,
            ),
          ).toEqual(["POST /v1/orders/batch", "POST /v1/orders/batch"]);
          expect(JSON.parse(body(server.ledger[1]))).toEqual({
            orders: [order(1001, "PO-A")],
          });
        }).pipe(Effect.provide(fetchClient)),
    );

    it("[ERR-3] refuses a batch item whose status contradicts its payload", () => {
      const decode = Schema.decodeUnknownResult(Envelopes.BatchItem);
      const order = { orderId: "SO-1", status: "ACCEPTED", totalCents: 1 };
      const error = { code: "CREDIT_HOLD", message: "held" };
      expect(decode({ index: 0, status: 201, order })._tag).toBe("Success");
      expect(decode({ index: 0, status: 403, error })._tag).toBe("Success");
      expect(decode({ index: 0, status: 201, error })._tag).toBe("Failure");
      expect(decode({ index: 0, status: 200, order })._tag).toBe("Failure");
      expect(decode({ index: 0, status: 302, error })._tag).toBe("Failure");
    });

    // lane: node-only — the selected rule depends on X-Error-Code, which a cross-origin browser
    // hides.
    it.live(
      "[ERR-7] selects the header rule from metadata alone and never reads its body",
      () =>
        Effect.gen(function* () {
          const { api } = yield* start;
          const headerRule: Array<string> = [];
          const rejected = yield* Operation.make(
            api.requests.placeOrder,
            selection(headerRule).pipe(
              Response.orElse(api.responses.placeOrder),
            ),
            { transformClient: watching(headerRule) },
          ).execute({ body: order(1002, "PO-HOLD") });
          expect(rejected).toMatchObject({
            _tag: "Rejected",
            code: "CREDIT_HOLD",
          });
          // Selection ran on the response head, and the header rule's decoder needed no body byte.
          expect(headerRule).toEqual(["response 200", "select 200"]);
          // The same response shape does carry body bytes: a misordered contract reads them, and
          // only after selection.
          const plainFirst: Array<string> = [];
          const error = yield* Operation.make(
            api.requests.placeOrder,
            selection(plainFirst).pipe(
              Response.orElse(Envelopes.orderAccepted),
              Response.orElse(Envelopes.orderRejected),
            ),
            { transformClient: watching(plainFirst) },
          )
            .execute({ body: order(1002, "PO-HOLD-2") })
            .pipe(Effect.flip);
          expect(error._tag).toBe("DecodeError");
          expect(plainFirst.slice(0, 3)).toEqual([
            "response 200",
            "select 200",
            "body bytes",
          ]);
          expect(plainFirst).toContain("body end");
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[ERR-7] reads a selected or unmatched body only after selection has finished",
      () =>
        Effect.gen(function* () {
          const { api } = yield* start;
          const selected: Array<string> = [];
          const accepted = yield* Operation.make(
            api.requests.placeOrder,
            selection(selected).pipe(Response.orElse(api.responses.placeOrder)),
            { transformClient: watching(selected) },
          ).execute({ body: order(1001, "PO-7") });
          expect(accepted).toMatchObject({ _tag: "Accepted" });
          expect(selected.slice(0, 2)).toEqual(["response 200", "select 200"]);
          expect(firstBodyRead(selected)).toBe(2);
          expect(selected.at(-1)).toBe("body end");
          // An unmatched response: selection first, then the drain reads it to its end.
          const unmatched: Array<string> = [];
          const error = yield* Operation.make(
            api.requests.getCustomer,
            selection(unmatched).pipe(
              Response.orElse(Response.status(204, Body.empty)),
            ),
            { transformClient: watching(unmatched) },
          )
            .execute({ path: 1001 })
            .pipe(Effect.flip);
          expect(error._tag).toBe("UnexpectedResponse");
          expect(unmatched.slice(0, 2)).toEqual(["response 200", "select 200"]);
          expect(firstBodyRead(unmatched)).toBe(2);
          expect(unmatched.at(-1)).toBe("body end");
        }).pipe(Effect.provide(fetchClient)),
    );

    it("[ERR-7] rules see transport metadata only; the type offers no body", () => {
      expectTypeOf<keyof Response.Metadata>().toEqualTypeOf<
        "status" | "headers" | "cookies" | "headerLines"
      >();
      Response.when(
        // @ts-expect-error: a rule predicate has no access to the body.
        (metadata) => metadata.body !== undefined,
        Body.empty,
      );
    });
  });

  describe("status codes and envelopes", () => {
    // lane: node-only — reads Location, which a cross-origin browser hides because the backend
    // exposes no headers.
    it.live(
      "[STAT-2] resolves the relative Location of a 200 creation and follows it",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const created = yield* Operation.make(
            api.requests.createCustomer,
            api.responses.createCustomer,
            { transformClient: record.transformClient },
          ).execute({ body: { name: "Litware Inc", tier: "SILVER" } });
          if (created._tag !== "Created")
            throw new Error(`expected Created, got ${created._tag}`);
          expect(record.seen[0]?.status).toBe(200);
          expect(record.seen[0]?.headers["location"]).toBe(
            "/v1/customers/1006",
          );
          // Resolved against the request URL, not appended to the base URL.
          expect(created.location.href).toBe(
            `${server.origin}/v1/customers/1006`,
          );
          const followed = yield* api.getCustomerAt.execute({
            path: created.location,
          });
          expect(followed).toEqual({
            result: "OK",
            customer: {
              id: 1006,
              name: "Litware Inc",
              tier: "SILVER",
              archived: false,
            },
          });
          expect(
            server.ledger.map(
              (request) => `${request.method} ${request.target}`,
            ),
          ).toEqual(["POST /v1/customers", "GET /v1/customers/1006"]);
          expect(body(server.ledger[0])).toBe(
            `{"name":"Litware Inc","tier":"SILVER"}`,
          );
          expect(header(server.ledger[0]!.lines, "content-type")).toBe(
            "application/json",
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[STAT-3] declares the 204 honestly empty; declaring JSON exposes the debug body as fiction",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const archived = yield* api.archiveCustomer.execute({ path: 1004 });
          expect(archived).toEqual({ _tag: "Archived" });
          const reread = yield* api.requireCustomer.execute({ path: 1004 });
          expect(reread.archived).toBe(true);
          // The runbook's "archive receipt" would need a JSON body; there is none to decode.
          const asDocumented = Operation.make(
            api.requests.archiveCustomer,
            Response.status(204, Body.json),
          );
          const error = yield* asDocumented
            .execute({ path: 1005 })
            .pipe(Effect.flip);
          expect(error._tag).toBe("DecodeError");
          if (error._tag !== "DecodeError") return;
          expect(error.metadata.status).toBe(204);
          expect(isJsonParseFailure(error.cause)).toBe(true);
          expect(
            server.ledger.map(
              (request) => `${request.method} ${request.target}`,
            ),
          ).toEqual([
            "POST /v1/customers/1004/archive",
            "GET /v1/customers/1004",
            "POST /v1/customers/1005/archive",
          ]);
          expect(server.ledger[0]?.body).toHaveLength(0);
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — opens a raw TCP socket to observe the bytes the Node server sends.
    it.live(
      "[STAT-3] the fixture's 204 carries no body bytes on the wire",
      () =>
        Effect.gen(function* () {
          const { server } = yield* start;
          const { connect } = yield* Effect.promise(() => import("node:net"));
          const { hostname, port } = new URL(server.origin);
          const raw = yield* Effect.promise(
            () =>
              new Promise<string>((resolve, reject) => {
                const chunks: Array<Uint8Array> = [];
                const socket = connect(Number(port), hostname, () =>
                  socket.write(
                    `POST /v1/customers/1003/archive HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
                      "Content-Length: 0\r\nConnection: close\r\n\r\n",
                  ),
                );
                socket.on("data", (chunk: Uint8Array) => chunks.push(chunk));
                socket.on("end", () =>
                  resolve(
                    chunks
                      .map((chunk) => new TextDecoder("latin1").decode(chunk))
                      .join(""),
                  ),
                );
                socket.on("error", reject);
              }),
          );
          const [head, after] = raw.split("\r\n\r\n");
          expect(head?.split("\r\n")[0]).toBe("HTTP/1.1 204 No Content");
          expect(head).toContain(
            "Content-Type: application/json;charset=UTF-8",
          );
          expect(head).not.toMatch(/content-length|transfer-encoding/i);
          // The handler wrote a debug body; Node dropped it.
          expect(after).toBe("");
          expect(server.ledger).toHaveLength(1);
        }),
    );

    it.live(
      "[STAT-4] an explicit empty declaration accepts a 200 JSON response of zero bytes",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const saved = yield* Operation.make(
            api.requests.savePreferences,
            api.responses.savePreferences,
            { transformClient: record.transformClient },
          ).execute({
            path: 1001,
            body: { newsletter: true, invoiceFormat: "PDF" },
          });
          expect(saved).toEqual({ _tag: "Saved" });
          expect(record.seen[0]?.status).toBe(200);
          expect(record.seen[0]?.headers["content-type"]).toBe(
            "application/json;charset=UTF-8",
          );
          expect(record.seen[0]?.headers["content-length"]).toBe("0");
          const preferences = yield* api.getPreferences.execute({ path: 1001 });
          expect(preferences).toEqual({
            newsletter: true,
            invoiceFormat: "PDF",
          });
          // A JSON codec rightly rejects the empty payload.
          const asJson = Operation.make(
            api.requests.savePreferences,
            Response.status(200, Body.json),
          );
          const error = yield* asJson
            .execute({
              path: 1001,
              body: { newsletter: false, invoiceFormat: "EMAIL" },
            })
            .pipe(Effect.flip);
          expect(error._tag).toBe("DecodeError");
          if (error._tag === "DecodeError")
            expect(isJsonParseFailure(error.cause)).toBe(true);
          expect(
            server.ledger.map(
              (request) => `${request.method} ${request.target}`,
            ),
          ).toEqual([
            "PUT /v1/customers/1001/preferences",
            "GET /v1/customers/1001/preferences",
            "PUT /v1/customers/1001/preferences",
          ]);
          expect(body(server.ledger[0])).toBe(
            `{"newsletter":true,"invoiceFormat":"PDF"}`,
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — reads Location and Retry-After, which a cross-origin browser hides because
    // the backend exposes no headers.
    it.live(
      "[STAT-5] polls a 202 export with the same cold request until it is done",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const accepted = yield* api.startExport.execute({
            body: { report: "aging" },
          });
          expect(accepted.monitor.href).toBe(
            `${server.origin}/v1/exports/7001`,
          );
          expect(Duration.toMillis(accepted.retryAfter)).toBe(1000);
          // The server asks for whole seconds; the test waits a tenth of each to stay short.
          const requested: Array<number> = [];
          const startedAt = Date.now();
          const done = yield* api.awaitExport(accepted.monitor, {
            firstDelay: accepted.retryAfter,
            maxPolls: 5,
            pace: (delay) => {
              requested.push(Duration.toMillis(delay));
              return Duration.millis(Duration.toMillis(delay) / 10);
            },
          });
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
          expect(done.polls).toBe(3);
          expect(done.rows).toEqual([
            { customerId: 1001, overdue30: 0 },
            { customerId: 1002, overdue30: 98000 },
            { customerId: 1003, overdue30: 1500 },
          ]);
          // Every wait honoured the Retry-After of the response before it.
          expect(requested).toEqual([1000, 1000, 1000]);
          const polls = server.ledger.slice(1);
          expect(server.ledger[0]?.target).toBe("/v1/exports");
          expect(
            polls.map((request) => `${request.method} ${request.target}`),
          ).toEqual([
            "GET /v1/exports/7001",
            "GET /v1/exports/7001",
            "GET /v1/exports/7001",
          ]);
          // The cold request is re-executed unchanged. Only Effect's tracing headers differ, because
          // every poll is a new execution with its own span.
          const untraced = (request: Received | undefined) =>
            request?.lines.filter(
              ([name]) => !["b3", "traceparent"].includes(name.toLowerCase()),
            );
          expect(polls[0]?.lines.map(([name]) => name)).toContain(
            "traceparent",
          );
          expect(untraced(polls[1])).toEqual(untraced(polls[0]));
          expect(untraced(polls[2])).toEqual(untraced(polls[0]));
          expect(header(polls[1]!.lines, "traceparent")).not.toBe(
            header(polls[0]!.lines, "traceparent"),
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — reads Location and Retry-After, which a cross-origin browser hides.
    it.live(
      "[STAT-5] a retry policy does not poll: a pending 202 is a success",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const accepted = yield* api.startExport.execute({
            body: { report: "aging" },
          });
          const retried = Operation.make(
            api.requests.exportStatus,
            api.responses.exportStatus,
            {
              policy: Policy.make(Schedule.recurs(5)),
            },
          );
          const status = yield* retried.execute({ path: accepted.monitor });
          expect(status).toMatchObject({ _tag: "Pending", state: "QUEUED" });
          expect(server.ledger.map((request) => request.method)).toEqual([
            "POST",
            "GET",
          ]);
          // A poll budget that runs out is a typed failure, not a pending value.
          const exhausted = yield* api
            .awaitExport(accepted.monitor, {
              firstDelay: Duration.zero,
              maxPolls: 1,
            })
            .pipe(Effect.flip);
          expect(exhausted).toBeInstanceOf(Envelopes.ExportStillPending);
          expect(exhausted).toMatchObject({ polls: 1, state: "RUNNING" });
          expect(server.ledger.map((request) => request.method)).toEqual([
            "POST",
            "GET",
            "GET",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[STAT-13] re-reads after PATCH instead of trusting the pre-write state it returns",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const updated = yield* api.updateCustomer.execute({
            path: 1003,
            body: { name: "Fabrikam Fibers Ltd", tier: "GOLD" },
          });
          expect(updated).toEqual({
            _tag: "Reread",
            lookup: {
              result: "OK",
              customer: {
                id: 1003,
                name: "Fabrikam Fibers Ltd",
                tier: "GOLD",
                archived: false,
              },
            },
          });
          // What the PATCH itself says is the state before the write.
          const trusting = Operation.make(
            api.requests.patchCustomer,
            api.responses.lookup,
          );
          const claimed = yield* trusting.execute({
            path: 1003,
            body: { tier: "PLATINUM" },
          });
          const actual = yield* api.requireCustomer.execute({ path: 1003 });
          expect(claimed).toMatchObject({
            result: "OK",
            customer: { tier: "GOLD" },
          });
          expect(actual.tier).toBe("PLATINUM");
          expect(
            server.ledger.map(
              (request) => `${request.method} ${request.target}`,
            ),
          ).toEqual([
            "PATCH /v1/customers/1003",
            "GET /v1/customers/1003",
            "PATCH /v1/customers/1003",
            "GET /v1/customers/1003",
          ]);
          expect(body(server.ledger[0])).toBe(
            `{"name":"Fabrikam Fibers Ltd","tier":"GOLD"}`,
          );
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("headers", () => {
    // lane: node-only — reads Link, which a cross-origin browser hides because the backend exposes
    // no headers.
    it.live(
      "[HDR-2] walks Link pagination by converting zero-based offsets to one-based pages",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const seen: Array<number> = [];
          const pages: Array<Envelopes.Customer["id"]> = [];
          let page:
            { readonly page: number; readonly perPage: number } | undefined = {
            page: 1,
            perPage: 2,
          };
          while (page !== undefined) {
            const current: { readonly page: number; readonly perPage: number } =
              page;
            const listed = yield* api.listCustomers.execute({ query: current });
            seen.push(current.page);
            pages.push(...listed.customers.map((customer) => customer.id));
            expect(listed.links.first).toEqual({ page: 1, perPage: 2 });
            expect(listed.links.last).toEqual({ page: 3, perPage: 2 });
            page = listed.links.next;
          }
          expect(seen).toEqual([1, 2, 3]);
          expect(pages).toEqual([1001, 1002, 1003, 1004, 1005]);
          expect(server.ledger.map((request) => request.target)).toEqual([
            "/v1/customers?page=1&per_page=2",
            "/v1/customers?page=2&per_page=2",
            "/v1/customers?page=3&per_page=2",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — reads Link, which a cross-origin browser hides.
    it.live(
      "[HDR-2] following the Link target literally reads the first page again",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const first = yield* Operation.make(
            api.requests.listCustomers,
            api.responses.listCustomers,
            { transformClient: record.transformClient },
          ).execute({ query: { page: 1, perPage: 2 } });
          const links = Schema.decodeUnknownSync(Dialect.LinkHeader)(
            record.seen[0]?.headers["link"],
          );
          const next = links.find((link) => link.rel === "next");
          expect(next?.target).toBe("/v1/customers?offset=2&limit=2");
          const literal = yield* Operation.make(
            Request.get("{link}").pipe(
              Request.path(Schema.URLFromString, (href) => href),
            ),
            Response.status(
              200,
              Body.jsonSchema(
                Schema.Struct({ customers: Schema.Array(Envelopes.Customer) }),
              ),
            ),
          ).execute({ path: new URL(next!.target, server.origin) });
          expect(literal.customers).toEqual(first.customers);
          expect(server.ledger[1]?.target).toBe(
            "/v1/customers?offset=2&limit=2",
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — compares the original Location lines through linesLayer, and reads Location
    // and X-Served-By, which a cross-origin browser hides.
    it.live(
      "[HDR-3] resolves either Location form, as each container really sends it",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const create = Operation.make(
            api.requests.createCustomer,
            api.responses.createCustomer,
            {
              transformClient: record.transformClient,
            },
          );
          const first = yield* create.execute({
            body: { name: "Adatum", tier: "STANDARD" },
          });
          const second = yield* create.execute({
            body: { name: "Coho Winery", tier: "GOLD" },
          });
          expect(rawLine(record.seen[0], "location")).toBe(
            "/v1/customers/1006",
          );
          expect(rawLine(record.seen[0], "x-served-by")).toBe("app-1");
          expect(rawLine(record.seen[1], "location")).toBe(
            `${server.origin}/v1/customers/1007`,
          );
          expect(rawLine(record.seen[1], "x-served-by")).toBe("app-legacy-2");
          const locations = [first, second].map((outcome) =>
            outcome._tag === "Created" ? outcome.location : undefined,
          );
          expect(locations.map((location) => location?.href)).toEqual([
            `${server.origin}/v1/customers/1006`,
            `${server.origin}/v1/customers/1007`,
          ]);
          for (const [index, location] of locations.entries()) {
            const found = yield* api.getCustomerAt.execute({ path: location! });
            expect(found).toMatchObject({
              result: "OK",
              customer: { name: index === 0 ? "Adatum" : "Coho Winery" },
            });
          }
          expect(server.ledger.map((request) => path(request))).toEqual([
            "/v1/customers",
            "/v1/customers",
            "/v1/customers/1006",
            "/v1/customers/1007",
          ]);
        }).pipe(Effect.provide(linesLayer)),
    );

    // lane: node-only — reads Location and X-Served-By, which a cross-origin browser hides.
    it.live(
      "[HDR-3] Node's fetch passes either Location form through unresolved",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const create = Operation.make(
            api.requests.createCustomer,
            api.responses.createCustomer,
            {
              transformClient: record.transformClient,
            },
          );
          const outcomes = [
            yield* create.execute({
              body: { name: "Adatum", tier: "STANDARD" },
            }),
            yield* create.execute({
              body: { name: "Coho Winery", tier: "GOLD" },
            }),
          ];
          expect(record.seen.map((metadata) => metadata.headerLines)).toEqual([
            Option.none(),
            Option.none(),
          ]);
          expect(
            record.seen.map((metadata) => metadata.headers["location"]),
          ).toEqual([
            "/v1/customers/1006",
            `${server.origin}/v1/customers/1007`,
          ]);
          expect(
            outcomes.map((outcome) =>
              outcome._tag === "Created" ? outcome.location.href : "",
            ),
          ).toEqual([
            `${server.origin}/v1/customers/1006`,
            `${server.origin}/v1/customers/1007`,
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[HDR-5a] decodes JSON served as text/html, never dispatching on content type",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const regions = yield* Operation.make(
            api.requests.regions,
            api.responses.regions,
            {
              transformClient: record.transformClient,
            },
          ).execute(undefined);
          expect(regions.regions.map((region) => region.code)).toEqual([
            "EU",
            "APAC",
            "LATAM",
          ]);
          expect(record.seen[0]?.headers["content-type"]).toBe(
            "text/html; charset=UTF-8",
          );
          expect(header(server.ledger[0]!.lines, "accept")).toBe(
            "application/json",
          );
          // A rule that dispatched on the content type would never match this answer.
          const byContentType = Operation.make(
            api.requests.regions,
            Response.when(
              (metadata) =>
                metadata.headers["content-type"]?.startsWith(
                  "application/json",
                ) === true,
              Body.jsonSchema(Envelopes.Regions),
            ),
          );
          const error = yield* byContentType
            .execute(undefined)
            .pipe(Effect.flip);
          expect(error._tag).toBe("UnexpectedResponse");
          expect(server.ledger).toHaveLength(2);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live("[HDR-5b] decodes JSON served as text/json", () =>
      Effect.gen(function* () {
        const { server, api } = yield* start;
        const record = recording();
        const currencies = yield* Operation.make(
          api.requests.currencies,
          api.responses.currencies,
          { transformClient: record.transformClient },
        ).execute(undefined);
        expect(currencies.currencies).toContainEqual({
          code: "JPY",
          decimals: 0,
        });
        expect(record.seen[0]?.headers["content-type"]).toBe(
          "text/json; charset=utf-8",
        );
        expect(server.ledger.map((request) => request.target)).toEqual([
          "/v1/currencies",
        ]);
      }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[HDR-5c] decodes OData verbose JSON whatever its content-type parameters say",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const record = recording();
          const feed = yield* Operation.make(
            api.requests.products,
            api.responses.products,
            {
              transformClient: record.transformClient,
            },
          ).execute(undefined);
          expect(feed.d.results).toHaveLength(3);
          expect(record.seen[0]?.headers["content-type"]).toBe(
            "application/json;odata=verbose;charset=utf-8",
          );
          expect(header(server.ledger[0]!.lines, "accept")).toBe(
            "application/json",
          );
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("payload dialects", () => {
    it.live(
      "[PAY-1] strips the anti-hijacking prefix before parsing JSON",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const dashboard = yield* api.dashboard.execute(undefined);
          expect(dashboard).toEqual({ openOrders: 0, creditHolds: 1 });
          // Plain JSON parsing cannot read the guarded feed.
          const plain = Operation.make(
            api.requests.dashboard,
            Response.status(200, Body.jsonSchema(Envelopes.Dashboard)),
          );
          const error = yield* plain.execute(undefined).pipe(Effect.flip);
          expect(error._tag).toBe("DecodeError");
          if (error._tag === "DecodeError")
            expect(isJsonParseFailure(error.cause)).toBe(true);
          expect(server.ledger).toHaveLength(2);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-1] unwraps JSONP for the requested callback and refuses any other name",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const rates = yield* api.rates.execute({
            query: { callback: "showRates" },
          });
          expect(rates).toEqual({
            base: "USD",
            rates: { EUR: "0.9150", GBP: "0.7890", JPY: "149.2000" },
          });
          // The CDN answers a second caller with the first caller's callback.
          const error = yield* api.rates
            .execute({ query: { callback: "otherWidget" } })
            .pipe(Effect.flip);
          expect(error._tag).toBe("DecodeError");
          if (error._tag !== "DecodeError") return;
          expect(Schema.isSchemaError(error.cause)).toBe(true);
          expect(String(error.cause)).toMatch(
            /calls showRates, not the requested otherWidget/,
          );
          expect(server.ledger.map((request) => request.target)).toEqual([
            "/v1/rates?callback=showRates",
            "/v1/rates?callback=otherWidget",
          ]);
          expect(header(server.ledger[0]!.lines, "accept")).toBe(
            "application/javascript",
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-1] refuses a JSONP callback that is not an identifier before dispatch",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const error = yield* api.rates
            .execute({ query: { callback: "alert(1)//" } })
            .pipe(Effect.flip);
          expect(Schema.isSchemaError(error)).toBe(true);
          expect(server.ledger).toHaveLength(0);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-1] reads an OData v2 envelope with metadata and a stringified count",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const feed = yield* api.products.execute(undefined);
          expect(feed.d.__count).toBe(3);
          expect(feed.d.results[0]).toEqual({
            __metadata: {
              uri: `${server.origin}/v1/odata/Products(1)`,
              type: "Business.Product",
            },
            ProductID: 1,
            Name: "Widget",
            UnitPrice: "12.5000",
            Discontinued: false,
          });
          // `$` is percent-encoded by the default query encoding; the facade decodes it.
          expect(server.ledger[0]?.target).toBe(
            "/v1/odata/Products?%24inlinecount=allpages",
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-1] maps a column grid through its verified header in any column order",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const documented = yield* api.agingReport.execute({ query: {} });
          const finance = yield* api.agingReport.execute({
            query: { layout: "finance" },
          });
          expect(documented).toEqual(finance);
          expect(documented[1]).toEqual({
            customerId: 1002,
            name: "Contoso Pharmaceuticals",
            current: 4500,
            overdue30: 98000,
          });
          // A layout without a documented column is refused rather than half-read.
          const summary = yield* api.agingReport
            .execute({ query: { layout: "summary" } })
            .pipe(Effect.flip);
          expect(summary._tag).toBe("DecodeError");
          if (summary._tag === "DecodeError")
            expect(String(summary.cause)).toMatch(/missing column name/);
          // Trusting positions reads the finance layout without complaint and swaps the money.
          const positional = Operation.make(
            api.requests.agingReport,
            Response.status(
              200,
              Body.jsonSchema(
                Schema.Struct({
                  rows: Schema.Array(
                    Schema.Tuple([
                      Schema.Int,
                      Schema.String,
                      Schema.Int,
                      Schema.Int,
                    ]),
                  ),
                }),
              ).pipe(
                Body.map((grid) =>
                  grid.rows.map(([customerId, name, current, overdue30]) => ({
                    customerId,
                    name,
                    current,
                    overdue30,
                  })),
                ),
              ),
            ),
          );
          const trusted = yield* positional.execute({
            query: { layout: "finance" },
          });
          expect(trusted[1]).toMatchObject({ current: 98000, overdue30: 4500 });
          expect(server.ledger.map((request) => request.target)).toEqual([
            "/v1/reports/aging",
            "/v1/reports/aging?layout=finance",
            "/v1/reports/aging?layout=summary",
            "/v1/reports/aging?layout=finance",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-1] normalizes a single result unwrapped from its array, and none",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const [many, one, none] = yield* Effect.forEach(
            ["EU", "APAC", "LATAM"],
            (region) => api.warehouses.execute({ query: { region } }),
          );
          expect(many?.warehouses.map((warehouse) => warehouse.code)).toEqual([
            "AMS1",
            "FRA2",
          ]);
          expect(one?.warehouses).toEqual([
            { code: "SIN1", city: "Singapore" },
          ]);
          expect(none?.warehouses).toEqual([]);
          expect(server.ledger.map((request) => request.target)).toEqual([
            "/v1/warehouses?region=EU",
            "/v1/warehouses?region=APAC",
            "/v1/warehouses?region=LATAM",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-1] sends a tier as a name and reads it back from an ordinal",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const updated = yield* api.updateCustomer.execute({
            path: 1004,
            body: { tier: "PLATINUM" },
          });
          expect(updated).toMatchObject({
            _tag: "Reread",
            lookup: { customer: { tier: "PLATINUM" } },
          });
          const untyped = yield* Operation.make(
            api.requests.getCustomer,
            Response.status(200, Body.json),
          ).execute({ path: 1004 });
          expect(untyped).toMatchObject({ customer: { tier: 3 } });
          expect(body(server.ledger[0])).toBe(`{"tier":"PLATINUM"}`);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-2] parses 64-bit ledger ids losslessly and fetches the right row by id",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const ledger = yield* api.ledger.execute({
            query: { account: "4000" },
          });
          expect(ledger.entries.map((entry) => entry.id)).toEqual([
            9007199254740992n,
            9007199254740993n,
            9007199254740995n,
          ]);
          const refund = yield* api.ledgerEntry.execute({
            path: ledger.entries[1]!.id,
          });
          expect(refund.entry).toEqual({
            id: 9007199254740993n,
            amountCents: -2500,
            memo: "Refund RMA-77",
          });
          expect(server.ledger.map((request) => request.target)).toEqual([
            "/v1/ledger?account=4000",
            "/v1/ledger/9007199254740993",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-2] the platform JSON parser rounds an id into the previous row's (lossy control)",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const lossy = Operation.make(
            api.requests.ledger,
            Response.status(
              200,
              Body.jsonSchema(
                Schema.Struct({
                  entries: Schema.Array(
                    Schema.Struct({ id: Schema.Number, memo: Schema.String }),
                  ),
                }),
              ),
            ),
          );
          const { entries } = yield* lossy.execute({
            query: { account: "4000" },
          });
          expect(entries[1]?.id).toBe(entries[0]?.id);
          // Following the rounded id fetches a different entry without any error.
          const byNumber = Operation.make(
            Request.get("ledger/{id}").pipe(
              Request.path(
                Schema.Number,
                (id, encode) => `ledger/${encode(String(id))}`,
              ),
              Request.baseUrl(`${server.origin}/v1`),
            ),
            Response.status(200, Body.json),
          );
          const wrong = yield* byNumber.execute({ path: entries[1]!.id });
          expect(wrong).toMatchObject({ entry: { memo: "Opening balance" } });
          // The domain schema refuses a rounded id instead of passing it on.
          const guarded = Operation.make(
            api.requests.ledger,
            Response.status(200, Body.jsonSchema(Envelopes.Ledger)),
          );
          const refused = yield* guarded
            .execute({ query: { account: "4000" } })
            .pipe(Effect.flip);
          expect(refused._tag).toBe("DecodeError");
          if (refused._tag === "DecodeError")
            expect(Schema.isSchemaError(refused.cause)).toBe(true);
          expect(server.ledger.map((request) => request.target)).toEqual([
            "/v1/ledger?account=4000",
            "/v1/ledger/9007199254740992",
            "/v1/ledger?account=4000",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("application behaviour", () => {
    it.live(
      "[APP-4] drains an unmodelled firewall page and fails with UnexpectedResponse",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const events: Array<string> = [];
          const error = yield* Operation.make(
            api.requests.listCustomers,
            selection(events).pipe(
              Response.orElse(api.responses.listCustomers),
            ),
            { transformClient: watching(events) },
          )
            .execute({ query: { page: 1, perPage: 2, name: "R&D <Labs>" } })
            .pipe(Effect.flip);
          expect(error._tag).toBe("UnexpectedResponse");
          if (error._tag !== "UnexpectedResponse") return;
          expect(error.metadata.status).toBe(403);
          expect(error.metadata.headers["content-type"]).toBe(
            "text/html; charset=utf-8",
          );
          // The body was read to its end before the failure surfaced, and nothing of it is kept.
          expect(events.slice(0, 2)).toEqual(["response 403", "select 403"]);
          expect(events.at(-1)).toBe("body end");
          expect(Object.keys(error)).not.toContain("body");
          expect(server.ledger[0]?.target).toBe(
            "/v1/customers?page=1&per_page=2&name=R%26D%20%3CLabs%3E",
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[APP-4] an explicit fallback reads an unmodelled body as text inside the operation",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const withText = Operation.make(
            api.requests.listCustomers,
            api.responses.listCustomers.pipe(
              Response.orElse(Envelopes.readUnmodelled),
            ),
          );
          const outcome = yield* withText.execute({
            query: { page: 1, perPage: 2, name: "<script>" },
          });
          if (!("_tag" in outcome))
            throw new Error("expected the fallback case");
          expect(outcome).toMatchObject({
            _tag: "Unmodelled",
            status: 403,
            contentType: "text/html; charset=utf-8",
          });
          expect(outcome.text).toContain(
            "Your support ID is: 7385419920601300001",
          );
          // The fallback does not swallow modelled answers.
          const listed = yield* withText.execute({
            query: { page: 3, perPage: 2 },
          });
          expect(
            "customers" in listed &&
              listed.customers.map((customer) => customer.id),
          ).toEqual([1005]);
          expect(server.ledger).toHaveLength(2);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live("[APP-4] an explicit fallback can discard an unmodelled body", () =>
      Effect.gen(function* () {
        const { server, api } = yield* start;
        const discarding = Operation.make(
          api.requests.listCustomers,
          api.responses.listCustomers.pipe(
            Response.orElse(Envelopes.discardUnmodelled),
          ),
        );
        const outcome = yield* discarding.execute({
          query: { page: 1, perPage: 2, name: "<b>bold</b>" },
        });
        expect(outcome).toEqual({ _tag: "Discarded", status: 403 });
        expect(server.ledger).toHaveLength(1);
      }).pipe(Effect.provide(fetchClient)),
    );

    it.live("[APP-5] refuses an empty customer name before any network", () =>
      Effect.gen(function* () {
        const { server, api } = yield* start;
        const error = yield* api.createCustomer
          .execute({ body: { name: "", tier: "STANDARD" } })
          .pipe(Effect.flip);
        expect(Schema.isSchemaError(error)).toBe(true);
        const patched = yield* api.updateCustomer
          .execute({ path: 1001, body: { name: "" } })
          .pipe(Effect.flip);
        expect(Schema.isSchemaError(patched)).toBe(true);
        expect(server.ledger).toHaveLength(0);
      }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[APP-5] the server refuses a blank name that the client accepted",
      () =>
        Effect.gen(function* () {
          const { server, api } = yield* start;
          const created = yield* api.createCustomer.execute({
            body: { name: "   ", tier: "STANDARD" },
          });
          expect(created).toEqual({
            _tag: "Invalid",
            errors: [
              { field: "name", code: "blank", message: "must not be blank" },
            ],
          });
          const updated = yield* api.updateCustomer.execute({
            path: 1001,
            body: { name: "\t" },
          });
          expect(updated).toMatchObject({
            _tag: "Invalid",
            errors: [{ code: "blank" }],
          });
          // Both reached the server; nothing changed.
          const unchanged = yield* api.requireCustomer.execute({ path: 1001 });
          expect(unchanged.name).toBe("Northwind Traders");
          expect(
            server.ledger.map(
              (request) => `${request.method} ${request.target}`,
            ),
          ).toEqual([
            "POST /v1/customers",
            "PATCH /v1/customers/1001",
            "GET /v1/customers/1001",
          ]);
          expect(body(server.ledger[0])).toBe(
            `{"name":"   ","tier":"STANDARD"}`,
          );
        }).pipe(Effect.provide(fetchClient)),
    );
  });
});
