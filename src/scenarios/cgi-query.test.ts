/**
 * AUTH-2: the consumer reads replies recorded from real CGI.pm, independently of the gateway's
 * imitation. All request targets below are taken literally from recordings/cgi-pm-query/set.json.
 * Each replay uses fresh state and real sockets, in both Node and Chromium.
 */
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Operation, Request, Response } from "viell-effect-schema-http";
import { Session } from "../clients/gateway/index.js";
import { header } from "../harness/lane.js";

const TOKEN = "sso+opaque;1=";
const cases = [
  [
    "encoded-token",
    "/cgi-bin/report.cgi?session=sso%2Bopaque%3B1%3D&report=balance&account=00012345",
    true,
  ],
  [
    "literal-plus",
    "/cgi-bin/report.cgi?session=sso+opaque%3B1%3D&report=balance&account=00012345",
    false,
  ],
  [
    "literal-semicolon",
    "/cgi-bin/report.cgi?session=sso%2Bopaque;1%3D&report=balance&account=00012345",
    false,
  ],
  [
    "semicolon-separators",
    "/cgi-bin/report.cgi?session=sso%2Bopaque%3B1%3D;report=balance;account=00012345",
    true,
  ],
  [
    "mixed-separators",
    "/cgi-bin/report.cgi?session=sso%2Bopaque%3B1%3D;report=balance&account=00012345",
    true,
  ],
  [
    "first-value-valid",
    "/cgi-bin/report.cgi?session=sso%2Bopaque%3B1%3D&session=revoked&report=balance&account=00012345",
    true,
  ],
  [
    "first-value-invalid",
    "/cgi-bin/report.cgi?session=revoked&session=sso%2Bopaque%3B1%3D&report=balance&account=00012345",
    false,
  ],
  [
    "name-only-session",
    "/cgi-bin/report.cgi?session&report=balance&account=00012345",
    false,
  ],
  [
    "empty-session",
    "/cgi-bin/report.cgi?session=&report=balance&account=00012345",
    false,
  ],
  [
    "literal-equals",
    "/cgi-bin/report.cgi?session=sso%2Bopaque%3B1=&report=balance&account=00012345",
    true,
  ],
  [
    "lowercase-escapes",
    "/cgi-bin/report.cgi?session=sso%2bopaque%3b1%3d&report=balance&account=00012345",
    true,
  ],
] as const;

const balance = {
  _tag: "Balance",
  account: "00012345",
  balance: 123450,
  due: Option.some(DateTime.makeUnsafe("2026-11-15T00:00:00Z")),
};
const refused = {
  _tag: "GatewayError",
  code: "E_SESSION",
  message: "session expired or unknown",
};

describe(`CGI.pm query recordings (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    it.live(
      `[AUTH-2] ${provider}: the ordinary balance contract encodes CGI-sensitive token characters`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("replay", {
            exchanges: ["cgi-pm-query/encoded-token"],
          });
          const outcome = yield* Session.balance(backend.origin).execute({
            session: TOKEN,
            account: "00012345",
          });
          expect(outcome).toEqual(balance);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("GET");
          expect(ledger[0]!.target).toBe(cases[0][1]);
          expect(header(ledger[0]!.lines, "accept")).toBe("text/plain");
          expect(ledger[0]!.body).toHaveLength(0);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    for (const [name, target, accepted] of cases) {
      it.live(
        `[AUTH-2] ${provider}: ${name} decodes CGI.pm's recorded outcome without rewriting its query`,
        () =>
          Effect.gen(function* () {
            const backend = yield* lane.backend("replay", {
              exchanges: [`cgi-pm-query/${name}`],
            });
            // Start without declared query fields, then install the recorded string URL through the
            // public native-request hook. Structured query declarations intentionally reserialize
            // their input; these controls must preserve semicolons, literal plus and escape case.
            const raw = Operation.make(
              Request.get("cgi-bin/report.cgi").pipe(
                Request.baseUrl(backend.origin),
                Request.mapEffect((request) =>
                  Effect.succeed(
                    HttpClientRequest.setUrl(
                      request,
                      `${backend.origin}${target}`,
                    ),
                  ),
                ),
              ),
              Response.status(200, Session.balanceBody),
            );
            expect(yield* raw.execute(undefined)).toEqual(
              accepted ? balance : refused,
            );
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(1);
            expect(ledger[0]!.method).toBe("GET");
            expect(ledger[0]!.target).toBe(target);
            expect(header(ledger[0]!.lines, "accept")).toBe("text/plain");
            expect(ledger[0]!.body).toHaveLength(0);
          }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
      );
    }
  }
});
