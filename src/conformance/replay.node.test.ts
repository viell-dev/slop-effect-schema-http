/**
 * The replay backend (services/replay.md) serves every recording as recorded, over a real socket,
 * and records each request in its ledger. Node-only: the recordings are read from disk and
 * compared with the raw status and header lines the backend sends.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import {
  data,
  type Lines,
  recorded,
  requestHeader,
  retarget,
  send,
} from "./recordings.js";

const SETS: ReadonlyArray<readonly [string, string]> = [
  ["EXT-6a", "frontier-rpc2"],
  ["EXT-6a", "xmlrpc-lite"],
  ["EXT-6b", "httpd-digest"],
  ["EXT-6c", "httpd-redirect"],
  ["EXT-6d", "tomcat7-redirect"],
  ["EXT-6e", "jaxws-faults"],
];

const exchanges = (set: string): ReadonlyArray<string> =>
  (
    data(set, "manifest.json") as {
      exchanges: ReadonlyArray<{ readonly name: string }>;
    }
  ).exchanges.map((exchange) => exchange.name);

/** Whether a recording has a header line of that name. */
const has = (lines: Lines, name: string) =>
  lines.some(([key]) => key.toLowerCase() === name);

/** The lines Node's server adds to a recording without a `Connection` line. */
const connection = (request: Buffer): Lines =>
  requestHeader(request, "connection")?.toLowerCase() === "close"
    ? [["Connection", "close"]]
    : [
        ["Connection", "keep-alive"],
        ["Keep-Alive", "timeout=5"],
      ];

describe("the replay backend", () => {
  for (const [id, set] of SETS)
    it.live(
      `[${id}] serves every exchange of ${set} as recorded: status line, header lines in order, body`,
      () =>
        Effect.gen(function* () {
          const names = exchanges(set);
          const replay = yield* lane.backend("replay", {
            exchanges: names.map((name) => `${set}/${name}`),
          });
          for (const name of names) {
            const { request, response } = recorded(set, name);
            const actual = yield* send(replay.origin, request);
            expect([actual.status, actual.reason]).toEqual([
              response.status,
              response.reason,
            ]);
            const added = has(response.lines, "connection")
              ? []
              : connection(request);
            expect(actual.lines).toEqual([...response.lines, ...added]);
            expect(actual.body.equals(response.body)).toBe(true);
          }
          const ledger = yield* replay.ledger;
          expect(
            ledger.map((entry) => `${entry.method} ${entry.target}`),
          ).toEqual(
            names.map((name) => {
              const line = recorded(set, name).request.toString("latin1");
              return line.slice(0, line.indexOf(" HTTP/1.1"));
            }),
          );
        }),
    );

  it.live(
    "[EXT-6b] answers a request no unused exchange matches with 404, and reuses exchanges only when asked",
    () =>
      Effect.gen(function* () {
        const { request } = recorded("httpd-digest", "challenge");
        const once = yield* lane.backend("replay", {
          exchanges: ["httpd-digest/challenge"],
        });
        expect((yield* send(once.origin, request)).status).toBe(401);
        const spent = yield* send(once.origin, request);
        expect([spent.status, spent.body.toString("latin1")]).toEqual([
          404,
          "no unused recorded exchange for GET /admin/audit.cgi?period=202610",
        ]);
        const elsewhere = yield* send(
          once.origin,
          retarget(request, "/admin/audit.cgi?period=202611"),
        );
        expect(elsewhere.status).toBe(404);
        const reused = yield* lane.backend("replay", {
          exchanges: ["httpd-digest/challenge"],
          reuse: true,
        });
        expect((yield* send(reused.origin, request)).status).toBe(401);
        expect((yield* send(reused.origin, request)).status).toBe(401);
      }),
  );
});
