/**
 * AUTH-2: the gateway's query conventions against real CGI.pm 4.55 (`recordings/cgi-pm-query`).
 * Node-only: read recorded request bytes from disk and send them unchanged over a raw socket,
 * comparing the status, header lines and pipe body independently of consumer code.
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

// The synthetic session and balance documented by the recording's handler, not a query parser.
const options = {
  token: "sso+opaque;1=",
  accounts: [
    {
      account: "00012345",
      title: "Synthetic account",
      cents: 123450,
      due: "20261115",
    },
  ],
} satisfies Json;

const cases = [
  ["encoded-token", "encoded plus, semicolon and equals survive in the token"],
  ["literal-plus", "a raw plus changes the token to an unknown session"],
  ["literal-semicolon", "a raw semicolon splits the token into parameters"],
  ["semicolon-separators", "semicolons separate parameters before decoding"],
  ["mixed-separators", "ampersands and semicolons separate the same query"],
  ["first-value-valid", "a valid first session wins over a later invalid one"],
  [
    "first-value-invalid",
    "an invalid first session wins over a later valid one",
  ],
  ["name-only-session", "a name-only session is empty and refused"],
  ["empty-session", "an explicitly empty session is refused"],
  ["literal-equals", "an equals after the first remains token data"],
  ["lowercase-escapes", "lowercase percent escapes decode the same token"],
] as const;

describe("the gateway's query parsing against CGI.pm 4.55", () => {
  for (const [name, description] of cases)
    it.live(`[AUTH-2] CGI.pm ${name}: ${description}`, () =>
      Effect.gen(function* () {
        const exchange = recorded("cgi-pm-query", name);
        const gateway = yield* lane.backend("gateway", options);
        const actual = yield* send(gateway.origin, exchange.request);

        const target = exchange.request
          .subarray(0, exchange.request.indexOf("\r\n"))
          .toString("latin1")
          .split(" ")[1]!;
        // Verify the recording's complete request shape as well as the backend's observations.
        expect(exchange.request).toEqual(
          Buffer.from(
            `GET ${target} HTTP/1.1\r\nHost: gateway.example\r\nConnection: close\r\n\r\n`,
            "latin1",
          ),
        );
        const ledger = yield* gateway.ledger;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.method).toBe("GET");
        expect(ledger[0]!.target).toBe(target);
        expect(ledger[0]!.lines).toEqual([
          ["Host", "gateway.example"],
          ["Connection", "close"],
        ]);
        expect(Buffer.from(ledger[0]!.body)).toEqual(Buffer.alloc(0));

        // Only Date varies per run. Status, reason, content type and every body byte must agree.
        const [expected, got] = masked([exchange.response, actual], [date]);
        expect(expected.status).toBe(200);
        expect(got.status).toBe(200);
        expect(got.body).toEqual(expected.body);
        expect(header(expected, "content-type")).toEqual(["text/plain"]);
        // Kept: HTTP::Daemon counts its reply; the gateway's CGI reply is chunked by Node.
        // The gateway signs as Apache 1.3, and Node acknowledges Connection: close explicitly.
        // Every remaining metadata difference is pinned here (services/gateway.md, "Recordings").
        expect(differences(expected, got)).toEqual([
          "header connection",
          "header content-length",
          "header server",
          "header transfer-encoding",
        ]);
        expect(header(expected, "connection")).toEqual([]);
        expect(header(got, "connection")).toEqual(["close"]);
        expect(header(expected, "content-length")).toEqual([
          String(expected.body.length),
        ]);
        expect(header(got, "content-length")).toEqual([]);
        expect(header(expected, "server")).toEqual(["libwww-perl-daemon/6.16"]);
        expect(header(got, "server")).toEqual(["Apache/1.3.41 (Unix)"]);
        expect(header(expected, "transfer-encoding")).toEqual([]);
        expect(header(got, "transfer-encoding")).toEqual(["chunked"]);
      }).pipe(Effect.timeout("3 seconds")),
    );
});
