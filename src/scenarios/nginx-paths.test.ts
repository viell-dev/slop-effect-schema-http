/**
 * QRY-3: real nginx selected these replies before the replay backend served them over sockets.
 * The consumer's existing history contract must distinguish global from individual history and
 * reject an empty task id before dispatch. No backend or conformance code is used here.
 */
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as Ops from "../clients/business/operations.js";
import { header, type Recorded } from "../harness/lane.js";

const token = "nginx-recording-token";
const globalEvents = [
  {
    task: "T-1001",
    action: "created",
    at: DateTime.makeUnsafe(1_700_000_000_000),
  },
  {
    task: "T-1002",
    action: "created",
    at: DateTime.makeUnsafe(1_700_000_060_000),
  },
];
const cases = [
  ["global-control", "/v2/tasks/history", "/v2/tasks/history", false],
  ["empty-id", "/v2/tasks//history", "/v2/tasks/history", false],
  ["many-slashes", "/v2///tasks////history", "/v2/tasks/history", false],
  [
    "query-slashes",
    "/v2/tasks//history?audit=//kept///",
    "/v2/tasks/history",
    false,
  ],
  [
    "task-control",
    "/v2/tasks/T-1001/history",
    "/v2/tasks/T-1001/history",
    true,
  ],
  [
    "task-slashes",
    "/v2//tasks///T-1001//history",
    "/v2/tasks/T-1001/history",
    true,
  ],
] as const;
const replay = (names: ReadonlyArray<string>) =>
  lane.backend("replay", {
    exchanges: names.map((name) => `nginx-paths/${name}`),
  });
const assertWire = (ledger: ReadonlyArray<Recorded>, target: string) => {
  expect(ledger).toHaveLength(1);
  expect(ledger[0]!.method).toBe("GET");
  expect(ledger[0]!.target).toBe(target);
  expect(header(ledger[0]!.lines, "authorization")).toBe(`Bearer ${token}`);
  expect(header(ledger[0]!.lines, "accept")).toBe("application/json");
  expect(ledger[0]!.body).toHaveLength(0);
};
const connection = (origin: string): Ops.Connection => ({
  baseUrl: `${origin}/v2`,
  credential: () => token,
});

describe(`nginx path recordings (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    for (const [name, target, normalized, individual] of cases) {
      it.live(`[QRY-3] ${provider}: nginx routes ${name}`, () =>
        Effect.gen(function* () {
          const backend = yield* replay([name]);
          // The native-request hook retains the literal query: URL construction normally
          // reserializes it. These controls compare recorded targets byte for byte.
          const operation = Operation.make(
            Request.get("v2/tasks/history").pipe(
              Request.baseUrl(backend.origin),
              Request.setHeader("Authorization", `Bearer ${token}`),
              Request.mapEffect((request) =>
                Effect.succeed(
                  HttpClientRequest.setUrl(
                    request,
                    `${backend.origin}${target}`,
                  ),
                ),
              ),
            ),
            Response.status(
              200,
              Response.tag("History", Body.jsonSchema(Ops.History)),
            ),
          );
          const result = yield* operation.execute(undefined);
          expect(result.value).toEqual({
            events: individual ? globalEvents.slice(0, 1) : globalEvents,
          });
          expect(result.metadata.headers["x-request-uri"]).toBe(target);
          expect(result.metadata.headers["x-normalized-uri"]).toBe(normalized);
          expect(result.metadata.headers["x-query-string"]).toBe(
            name === "query-slashes" ? "audit=//kept///" : undefined,
          );
          assertWire(yield* backend.ledger, target);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
      );
    }

    it.live(
      `[QRY-3] ${provider}: an unconstrained empty id reads nginx's global history`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["empty-id"]);
          const result = yield* Ops.taskHistoryAnyId(
            connection(backend.origin),
          ).execute({ path: { id: "" } });
          expect(result._tag).toBe("History");
          if (result._tag === "History") {
            expect(result.value).toEqual({ events: globalEvents });
            expect(result.metadata.headers["x-normalized-uri"]).toBe(
              "/v2/tasks/history",
            );
          }
          assertWire(yield* backend.ledger, "/v2/tasks//history");
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    it.live(
      `[QRY-3] ${provider}: the task contract rejects an empty id before nginx replay`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["empty-id", "task-control"]);
          const operation = Ops.taskHistory(connection(backend.origin));
          const error = yield* Effect.flip(
            operation.execute({ path: { id: "" as Ops.TaskId } }),
          );
          expect(Schema.isSchemaError(error)).toBe(true);
          expect(yield* backend.ledger).toHaveLength(0);
          const result = yield* operation.execute({
            path: { id: Schema.decodeSync(Ops.TaskId)("T-1001") },
          });
          expect(result._tag).toBe("History");
          if (result._tag === "History") {
            expect(result.value).toEqual({ events: globalEvents.slice(0, 1) });
            expect(result.metadata.headers["x-normalized-uri"]).toBe(
              "/v2/tasks/T-1001/history",
            );
          }
          assertWire(yield* backend.ledger, "/v2/tasks/T-1001/history");
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );
  }
});
