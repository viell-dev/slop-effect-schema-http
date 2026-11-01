/**
 * QRY-3: the business gateway's adjacent-slash routing against stock nginx 1.30.6
 * (`recordings/nginx-paths`). Node-only: read recorded bytes from disk and compare replies over
 * raw sockets, independently of the consumer's contracts and URL construction.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json } from "../harness/lane.js";
import {
  date,
  differences,
  header,
  masked,
  recorded,
  send,
} from "./recordings.js";

// Seed the two creation events returned by nginx's exact-match locations, using only the
// service's documented plain-JSON options. Each test starts a fresh history.
const options = {
  operations: {
    token: "nginx-paths-token",
    tasks: [
      {
        title: "First synthetic task",
        assigneeId: "u-one",
        priority: 2,
        due: null,
        notes: null,
        done: false,
        created: 1700000000000,
      },
      {
        title: "Second synthetic task",
        assigneeId: "u-two",
        priority: 3,
        due: null,
        notes: null,
        done: false,
        created: 1700000060000,
      },
    ],
  },
} satisfies Json;

const globalHistory = {
  events: [
    { task: "T-1001", action: "created", at: 1700000000000 },
    { task: "T-1002", action: "created", at: 1700000060000 },
  ],
};
const taskHistory = {
  events: [{ task: "T-1001", action: "created", at: 1700000000000 }],
};

const cases = [
  {
    name: "global-control",
    target: "/v2/tasks/history",
    normalized: "/v2/tasks/history",
    history: globalHistory,
  },
  {
    name: "empty-id",
    target: "/v2/tasks//history",
    normalized: "/v2/tasks/history",
    history: globalHistory,
  },
  {
    name: "many-slashes",
    target: "/v2///tasks////history",
    normalized: "/v2/tasks/history",
    history: globalHistory,
  },
  {
    name: "query-slashes",
    target: "/v2/tasks//history?audit=//kept///",
    normalized: "/v2/tasks/history",
    history: globalHistory,
  },
  {
    name: "task-control",
    target: "/v2/tasks/T-1001/history",
    normalized: "/v2/tasks/T-1001/history",
    history: taskHistory,
  },
  {
    name: "task-slashes",
    target: "/v2//tasks///T-1001//history",
    normalized: "/v2/tasks/T-1001/history",
    history: taskHistory,
  },
] as const;

describe("the business gateway's path merging against nginx 1.30.6", () => {
  for (const { name, target, normalized, history } of cases)
    it.live(
      `[QRY-3] nginx ${name}: the same complete history after routing`,
      () =>
        Effect.gen(function* () {
          const exchange = recorded("nginx-paths", name);
          expect(exchange.request).toEqual(
            Buffer.from(
              `GET ${target} HTTP/1.1\r\nHost: business.example\r\nConnection: close\r\n\r\n`,
              "latin1",
            ),
          );

          // The recording has no application authentication. Add exactly one bearer line for
          // the imitation; retain the original target, Host, Connection, order and empty body.
          const request = Buffer.concat([
            exchange.request.subarray(0, exchange.request.length - 2),
            Buffer.from(
              "Authorization: Bearer nginx-paths-token\r\n\r\n",
              "latin1",
            ),
          ]);
          expect(request).toEqual(
            Buffer.from(
              `GET ${target} HTTP/1.1\r\nHost: business.example\r\nConnection: close\r\nAuthorization: Bearer nginx-paths-token\r\n\r\n`,
              "latin1",
            ),
          );
          const business = yield* lane.backend("business", options);
          const actual = yield* send(business.origin, request);
          const ledger = yield* business.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("GET");
          expect(ledger[0]!.target).toBe(target);
          expect(ledger[0]!.lines).toEqual([
            ["Host", "business.example"],
            ["Connection", "close"],
            ["Authorization", "Bearer nginx-paths-token"],
          ]);
          expect(Buffer.from(ledger[0]!.body)).toEqual(Buffer.alloc(0));

          // Only Date varies. Every event, field, order and body byte agrees with the real reply.
          const [expected, got] = masked([exchange.response, actual], [date]);
          expect(expected.status).toBe(200);
          expect(got.status).toBe(200);
          expect(expected.reason).toBe("OK");
          expect(got.reason).toBe("OK");
          expect(JSON.parse(expected.body.toString("utf8"))).toEqual(history);
          expect(JSON.parse(got.body.toString("utf8"))).toEqual(history);
          expect(expected.body).toEqual(Buffer.from(JSON.stringify(history)));
          expect(got.body).toEqual(expected.body);

          // nginx's diagnostics expose both the original target and normalized path. For the
          // query case, $args also proves that nginx preserved adjacent slashes in query data.
          // The imitation exposes the original query only in its ledger: this history endpoint
          // does not reveal the query text that its internal parser used.
          const query = name === "query-slashes" ? ["audit=//kept///"] : [];
          expect(header(expected, "x-request-uri")).toEqual([target]);
          expect(header(expected, "x-normalized-uri")).toEqual([normalized]);
          expect(header(expected, "x-query-string")).toEqual(query);
          expect(header(got, "x-request-uri")).toEqual([]);
          expect(header(got, "x-normalized-uri")).toEqual([]);
          expect(header(got, "x-query-string")).toEqual([]);

          // Pin, rather than mask, every deliberate difference (services/business.md, v2
          // "Recordings"): stock nginx identity and probe diagnostics, the application's JSON
          // charset, and Node's chunked framing in place of nginx's counted body.
          expect(header(expected, "server")).toEqual(["nginx/1.30.6"]);
          expect(header(got, "server")).toEqual([]);
          expect(header(expected, "content-type")).toEqual([
            "application/json",
          ]);
          expect(header(got, "content-type")).toEqual([
            "application/json; charset=utf-8",
          ]);
          expect(header(expected, "content-length")).toEqual([
            String(expected.body.length),
          ]);
          expect(header(got, "content-length")).toEqual([]);
          expect(header(expected, "transfer-encoding")).toEqual([]);
          expect(header(got, "transfer-encoding")).toEqual(["chunked"]);
          expect(header(expected, "connection")).toEqual(["close"]);
          expect(header(got, "connection")).toEqual(["close"]);
          expect(differences(expected, got)).toEqual([
            "header content-length",
            "header content-type",
            "header server",
            "header transfer-encoding",
            "header x-normalized-uri",
            ...(name === "query-slashes" ? ["header x-query-string"] : []),
            "header x-request-uri",
          ]);
        }).pipe(Effect.timeout("3 seconds")),
    );
});
