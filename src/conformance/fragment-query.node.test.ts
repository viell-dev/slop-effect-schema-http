/**
 * AUTH-2: the gateway's query ends at the target's first `#`, a `?` after it starts none, and only
 * `help.cgi` reads what follows it (services/gateway.md, "The help topics (1998)"). No recording
 * covers this, because no Apache 1.3 can be recorded, so the page is the referee: every expected
 * reply is the one it documents for that request, written out here rather than taken from a run
 * without the fragment, so a script that went wrong the same way in both would still fail.
 *
 * Node-only: a fragment on the request line needs a raw socket, and the replies are compared as
 * status, header lines and bytes.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json } from "../harness/lane.js";
import { header, type Response, send, xmlRpcValues } from "./recordings.js";

const TOKEN = "synthetic-token";
const PERIOD = "199812";
const REALM = "Reporting Gateway";
const HOST = "gateway.example:8080";

const account = {
  account: "00012345",
  title: "Synthetic account",
  cents: 123450,
  due: "19990115",
};

const options = {
  token: TOKEN,
  users: { ann: "pw" },
  auditors: { auditor: "pw" },
  accounts: [account],
  extracts: {
    [PERIOD]: {
      runDate: "19990104",
      lastModified: "1999-01-04T06:00:00Z",
      records: [{ ...account, status: "O" }],
    },
  },
} satisfies Json;

/** The extract's three 64-byte records, by the page's layout. */
const EXTRACT = [
  "H" + "MONTHEND" + PERIOD + "19990104",
  "D" +
    "00012345" +
    "Synthetic account".padEnd(30) +
    "00000123450" +
    "19990115" +
    "O",
  ["T", "000001", "0000000123450"].join(""),
]
  .map((record) => record.padEnd(64))
  .join("");

const CSV =
  "﻿account,title,amount,due\n" +
  "00012345,Synthetic account,1234.50,19990115\n";

const GERMAN_CSV =
  "﻿Konto;Bezeichnung;Betrag;Fällig\r\n" +
  "00012345;Synthetic account;1234,50;19990115\r\n";

const REPORT_COUNT =
  `<?xml version="1.0"?><methodCall><methodName>report.count</methodName><params>` +
  `<param><value><string>${PERIOD}</string></value></param></params></methodCall>`;

const SESSION_ERROR = "ERROR|E_SESSION|session expired or unknown\n";

interface Exchange {
  readonly about: string;
  readonly method?: "POST";
  /** The target, or for the first table the target a fragment is added to. */
  readonly target: string;
  readonly lines?: ReadonlyArray<string>;
  readonly body?: string;
  /** Asserts the reply the page documents for this request. */
  readonly documented: (response: Response) => void;
}

const wire = (exchange: Exchange, target: string, lines = exchange.lines) => {
  const body = Buffer.from(exchange.body ?? "");
  return Buffer.concat([
    Buffer.from(
      [
        `${exchange.method ?? "GET"} ${target} HTTP/1.1`,
        `Host: ${HOST}`,
        "Connection: close",
        ...(lines ?? []),
        ...(body.length === 0 ? [] : [`Content-Length: ${body.length}`]),
        "",
        "",
      ].join("\r\n"),
      "latin1",
    ),
    body,
  ]);
};

const pipeReply =
  (expected: string | RegExp, status = 200) =>
  (response: Response) => {
    expect(response.status).toBe(status);
    expect(header(response, "content-type")).toEqual(["text/plain"]);
    if (typeof expected === "string")
      expect(response.body.toString("latin1")).toBe(expected);
    else expect(response.body.toString("latin1")).toMatch(expected);
  };

const download = (file: string, contents: string) => (response: Response) => {
  expect(response.status).toBe(200);
  expect(header(response, "content-type")).toEqual([
    "application/octet-stream",
  ]);
  expect(header(response, "content-disposition")).toEqual([
    `attachment; filename="${file}"`,
  ]);
  expect(response.body).toEqual(Buffer.from(contents));
};

/** Apache's redirect: `status`, and the page linking the target with `&` escaped. */
const redirect = (status: number, location: string) => (response: Response) => {
  expect(response.status).toBe(status);
  expect(header(response, "location")).toEqual([location]);
  expect(response.body.toString("latin1")).toContain(
    `<A HREF="${location.replaceAll("&", "&amp;")}">here</A>`,
  );
};

/** A target's reply is the same with any of these after it, the first being no fragment at all. */
const FRAGMENTS = ["", "#closing", "#", "#closing?lang=de", "#closing#again"];

const scripts: ReadonlyArray<Exchange> = [
  {
    about: "login.cgi",
    target: "/cgi-bin/login.cgi?user=ann&passwd=pw",
    documented: pipeReply(/^OK\|[^|\n]+\n$/),
  },
  {
    about: "report.cgi's balance",
    target: `/cgi-bin/report.cgi?session=${TOKEN}&report=balance&account=00012345`,
    documented: pipeReply("OK|00012345|123450|19990115\n"),
  },
  {
    about: "report.cgi's accounts export",
    target: `/cgi-bin/report.cgi?session=${TOKEN}&report=accounts&format=csv`,
    documented: download("accounts.csv", CSV),
  },
  {
    about: "report.cgi's German accounts export",
    target: `/cgi-bin/report.cgi?session=${TOKEN}&report=accounts&format=csv&locale=de_DE`,
    documented: download("konten.csv", GERMAN_CSV),
  },
  {
    about: "extract.cgi",
    target: `/cgi-bin/extract.cgi?session=${TOKEN}&period=${PERIOD}`,
    documented: (response) => {
      download(`ME${PERIOD}.DAT`, EXTRACT)(response);
      expect(header(response, "content-length")).toEqual(["192"]);
      expect(header(response, "last-modified")).toEqual([
        "Mon, 04 Jan 1999 06:00:00 GMT",
      ]);
      expect(header(response, "x-record-count")).toEqual(["1"]);
      expect(header(response, "x-control-total")).toEqual(["0000000123450"]);
    },
  },
  {
    about: "import.cgi",
    method: "POST",
    target: `/cgi-bin/import.cgi?session=${TOKEN}&locale=de_DE`,
    body: GERMAN_CSV,
    documented: pipeReply("OK|1\n"),
  },
  {
    about: "/RPC2",
    method: "POST",
    target: `/RPC2?session=${TOKEN}`,
    lines: ["Content-Type: text/xml"],
    body: REPORT_COUNT,
    documented: (response) => {
      expect(response.status).toBe(200);
      expect(xmlRpcValues(response.body)).toEqual({ params: [{ int: "1" }] });
    },
  },
  {
    about: "rpt.exe",
    target: "/cgi-bin/rpt.exe?session=tok&report=balance",
    documented: redirect(
      301,
      `http://${HOST}/cgi-bin/report.cgi?session=tok&report=balance`,
    ),
  },
  {
    about: "rpt.exe by POST",
    method: "POST",
    target: "/cgi-bin/rpt.exe?session=tok&report=balance",
    documented: redirect(
      301,
      `http://${HOST}/cgi-bin/report.cgi?session=tok&report=balance`,
    ),
  },
  {
    about: "rpt.exe without a query",
    target: "/cgi-bin/rpt.exe",
    documented: redirect(301, `http://${HOST}/cgi-bin/report.cgi`),
  },
  {
    // Not `closing`, so a script that took the fragment for the section would answer differently.
    about: "go.cgi",
    target: "/cgi-bin/go.cgi?section=opening",
    documented: redirect(
      302,
      `http://${HOST}/cgi-bin/help.cgi/accounts#opening`,
    ),
  },
];

/** Requests whose parameters stand after the `#`, so that the scripts must not see them. */
const cutShort: ReadonlyArray<Exchange> = [
  {
    about: "login.cgi: a ? after the # starts no query",
    target: "/cgi-bin/login.cgi#closing?user=ann&passwd=pw",
    documented: pipeReply(/^ERROR\|E_PARAM\|/),
  },
  {
    about: "report.cgi: a ? after the # starts no query",
    target: `/cgi-bin/report.cgi#closing?session=${TOKEN}&report=balance&account=00012345`,
    documented: pipeReply(SESSION_ERROR),
  },
  {
    about: "report.cgi: the query ends at the #",
    target: `/cgi-bin/report.cgi?session=${TOKEN}&report=balance#&account=00012345`,
    documented: pipeReply(/^ERROR\|E_PARAM\|/),
  },
  {
    about: "extract.cgi: a ? after the # starts no query",
    target: `/cgi-bin/extract.cgi#closing?session=${TOKEN}&period=${PERIOD}`,
    documented: pipeReply(SESSION_ERROR, 403),
  },
  {
    about: "extract.cgi: the query ends at the #",
    target: `/cgi-bin/extract.cgi?session=${TOKEN}#&period=${PERIOD}`,
    documented: pipeReply(/^ERROR\|E_PARAM\|/, 400),
  },
  {
    about: "import.cgi: a ? after the # starts no query",
    method: "POST",
    target: `/cgi-bin/import.cgi#closing?session=${TOKEN}&locale=de_DE`,
    body: GERMAN_CSV,
    documented: pipeReply(SESSION_ERROR),
  },
  {
    about: "/RPC2: a ? after the # starts no query",
    method: "POST",
    target: `/RPC2#closing?session=${TOKEN}`,
    lines: ["Content-Type: text/xml"],
    body: REPORT_COUNT,
    documented: (response) => {
      expect(response.status).toBe(200);
      expect(xmlRpcValues(response.body)).toEqual({
        fault: {
          struct: [
            ["faultCode", { int: "401" }],
            ["faultString", { string: "session expired or unknown" }],
          ],
        },
      });
    },
  },
  {
    about: "rpt.exe: a ? after the # starts no query",
    target: "/cgi-bin/rpt.exe#closing?session=tok",
    documented: redirect(301, `http://${HOST}/cgi-bin/report.cgi`),
  },
  {
    about: "rpt.exe: the query ends at the #",
    target: "/cgi-bin/rpt.exe?session=tok#closing?report=balance",
    documented: redirect(301, `http://${HOST}/cgi-bin/report.cgi?session=tok`),
  },
  {
    about: "go.cgi: a ? after the # starts no query",
    target: "/cgi-bin/go.cgi#closing?section=closing",
    documented: pipeReply("ERROR|E_PARAM|section missing\n"),
  },
];

const check = (exchange: Exchange, target: string) =>
  Effect.gen(function* () {
    const gateway = yield* lane.backend("gateway", options);
    const response = yield* send(gateway.origin, wire(exchange, target));
    const ledger = yield* gateway.ledger;
    expect(ledger.map((received) => received.target)).toEqual([target]);
    exchange.documented(response);
  }).pipe(Effect.timeout("3 seconds"));

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/** Authorization by the page's RFC 2069 formula, for the `uri` the client claims. */
const authorization = (nonce: string, uri: string) => {
  const response = md5(
    `${md5(`auditor:${REALM}:pw`)}:${nonce}:${md5(`GET:${uri}`)}`,
  );
  return `Authorization: Digest username="auditor", realm="${REALM}", nonce="${nonce}", uri="${uri}", response="${response}"`;
};

const audit: Exchange = {
  about: "audit.cgi",
  target: `/admin/audit.cgi?period=${PERIOD}`,
  documented: pipeReply(`OK|${PERIOD}|1|123450\n`),
};

/** A challenge for `target`, answered with credentials that claim `uri`. */
const audited = (target: string, uri: string) =>
  Effect.gen(function* () {
    const gateway = yield* lane.backend("gateway", options);
    const challenge = yield* send(gateway.origin, wire(audit, target));
    expect(challenge.status).toBe(401);
    const [offered] = header(challenge, "www-authenticate");
    const nonce = /nonce="([^"]*)"/.exec(offered ?? "")![1]!;
    return yield* send(
      gateway.origin,
      wire(audit, target, [authorization(nonce, uri)]),
    );
  }).pipe(Effect.timeout("3 seconds"));

describe("the gateway's query ends at the first #", () => {
  for (const script of scripts)
    for (const fragment of FRAGMENTS)
      it.live(
        `[AUTH-2] ${script.about}, ${fragment === "" ? "without a fragment" : `with ${fragment} after it`}: the reply its page documents`,
        () => check(script, `${script.target}${fragment}`),
      );

  for (const exchange of cutShort)
    it.live(`[AUTH-2] ${exchange.about}`, () =>
      check(exchange, exchange.target),
    );

  for (const fragment of FRAGMENTS)
    it.live(
      `[AUTH-2] audit.cgi, ${fragment === "" ? "without a fragment" : `with ${fragment} in the target and in uri`}: the extract's totals`,
      () =>
        Effect.gen(function* () {
          const target = `${audit.target}${fragment}`;
          audit.documented(yield* audited(target, target));
        }),
    );

  it.live(
    "[AUTH-2] audit.cgi: mod_digest compares uri with the whole target, so a fragment left out of uri is Apache's 400",
    () =>
      Effect.gen(function* () {
        const response = yield* audited(
          `${audit.target}#closing`,
          audit.target,
        );
        expect(response.status).toBe(400);
        expect(header(response, "content-type")).toEqual([
          "text/html; charset=iso-8859-1",
        ]);
      }),
  );
});
