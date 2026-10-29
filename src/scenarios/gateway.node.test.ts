/**
 * Gateway scenarios that need the line-preserving `node:http` provider, which exists only in the
 * Node lane: it follows no redirects by itself and sends the library's header lines exactly as
 * declared. Their Fetch counterparts, which run in both lanes, are in `gateway.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import type { HttpClient } from "effect/http";
import { lane } from "#lane";
import { Operation } from "viell-effect-schema-http";
import { Digest, Session } from "../clients/gateway/index.js";
import { header, type Json } from "../harness/lane.js";

const TOKEN = "sso-7f3a9c41";
const AUDITOR = { username: "auditor", password: "Secr3t!" } as const;

const fixture = {
  token: TOKEN,
  realm: "Reporting Gateway",
  auditors: { [AUDITOR.username]: AUDITOR.password },
  accounts: [
    {
      account: "00012345",
      title: "Café Müller",
      cents: 123450,
      due: "20261115",
    },
  ],
  extracts: {
    "202610": {
      runDate: "20261101",
      lastModified: "2026-11-01T02:15:00Z",
      records: [
        {
          account: "00012345",
          title: "Café Müller",
          cents: 123450,
          due: "20261115",
          status: "O",
        },
      ],
    },
  },
} satisfies Json;

/** Header lines without the per-request trace context. */
const untraced = (lines: ReadonlyArray<readonly [string, string]>) =>
  lines.filter(([name]) => name !== "traceparent" && name !== "b3");

/** Start the gateway for the current test's scope. */
const start = (options: Json = fixture) => lane.backend("gateway", options);

const viaLines = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.provide(effect, lane.linesClient!);

describe("gateway through the line-preserving provider (node)", () => {
  // lane: node-only — the line-preserving provider does not exist in a browser.
  it.live(
    "[STAT-10] the line-preserving provider observes the 301 itself",
    () =>
      Effect.gen(function* () {
        const gateway = yield* start();
        const outcome = yield* viaLines(
          Session.legacyBalance(gateway.origin).execute({
            session: TOKEN,
            account: "00012345",
          }),
        );
        expect(outcome._tag).toBe("Moved");
        expect(outcome.value).toEqual({
          location: `${gateway.origin}/cgi-bin/report.cgi?session=${TOKEN}&report=balance&account=00012345`,
        });
        expect(Option.isSome(outcome.metadata.headerLines)).toBe(true);
        const ledger = yield* gateway.ledger;
        expect(ledger.map((entry) => entry.target.split("?")[0])).toEqual([
          "/cgi-bin/rpt.exe",
        ]);
      }),
  );

  // lane: node-only — only this provider sends the declared lines without the platform's own.
  it.live(
    "[AUTH-7] through the line-preserving provider, the authorized request is the cold request's lines plus one",
    () =>
      Effect.gen(function* () {
        const gateway = yield* start();
        const request = Digest.auditRequest(gateway.origin);
        const run = Digest.withDigest(
          request,
          Operation.make(request, Digest.auditResponse),
          AUDITOR,
        );
        const report = yield* viaLines(
          run({ query: { period: "202610" }, headers: {} }),
        );
        expect(report).toMatchObject({
          _tag: "Report",
          value: { records: 1, controlTotal: 123450 },
        });
        const [cold, authorized] = yield* gateway.ledger;
        // The header schema owns the Authorization line, so it sits with the declared headers,
        // ahead of the automatic Accept; without it, the two requests carry the same lines.
        const added = authorized!.lines.filter(
          ([name]) => name === "authorization",
        );
        expect(added).toEqual([
          ["authorization", header(authorized!.lines, "authorization")!],
        ]);
        expect(
          untraced(
            authorized!.lines.filter(([name]) => name !== "authorization"),
          ),
        ).toEqual(untraced(cold!.lines));
      }),
  );
});
