/**
 * Backend-side German CSV checks against an independently hand-authored contract referee.
 * Node-only: read literal fixture bytes from disk and send HTTP without the consumer's codecs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json, Recorded } from "../harness/lane.js";
import { header, type Response, send } from "./recordings.js";

const golden = readFileSync(
  new URL("../../fixtures/gateway/german-accounts.csv", import.meta.url),
);

// Copied from the referee's documented gateway input, independently of the consumer-side tests.
const options = {
  token: "german-csv-golden",
  accounts: [
    {
      account: "00123456",
      title: "Café Müller",
      cents: 0,
      due: "00000000",
    },
    {
      account: "12345678",
      title: 'Büro; "Süd"',
      cents: 123456,
      due: "20261231",
    },
    {
      account: "87654321",
      title: "Köln\r\nZweite Zeile",
      cents: -705,
      due: "20261130",
    },
    {
      account: "00000009",
      title: "Straße",
      cents: 9,
      due: "20270228",
    },
  ],
} satisfies Json;

const exportTarget =
  "/cgi-bin/report.cgi?session=german-csv-golden&report=accounts&format=csv&locale=de_DE";
const importTarget =
  "/cgi-bin/import.cgi?session=german-csv-golden&locale=de_DE";
const exportRequest = Buffer.from(
  `GET ${exportTarget} HTTP/1.1\r\nHost: gateway.test\r\nConnection: close\r\n\r\n`,
);
const importRequest = (body: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(
      `POST ${importTarget} HTTP/1.1\r\nHost: gateway.test\r\nConnection: close\r\n` +
        `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`,
    ),
    body,
  ]);

const expectExport = (response: Response, expected: Buffer = golden): void => {
  expect(response.status).toBe(200);
  expect(header(response, "content-type")).toEqual([
    "application/octet-stream",
  ]);
  expect(header(response, "content-disposition")).toEqual([
    'attachment; filename="konten.csv"',
  ]);
  expect(response.body).toEqual(expected);
};

const expectExportWire = (request: Recorded): void => {
  expect(request.method).toBe("GET");
  expect(request.target).toBe(exportTarget);
  expect(request.lines).toEqual([
    ["Host", "gateway.test"],
    ["Connection", "close"],
  ]);
  expect(request.body).toHaveLength(0);
};

const expectImportWire = (request: Recorded, body: Buffer): void => {
  expect(request.method).toBe("POST");
  expect(request.target).toBe(importTarget);
  expect(request.lines).toEqual([
    ["Host", "gateway.test"],
    ["Connection", "close"],
    ["Content-Type", "application/octet-stream"],
    ["Content-Length", String(body.length)],
  ]);
  expect(Buffer.from(request.body)).toEqual(body);
};

/** Change one literal byte sequence, without parsing or serializing CSV. */
const replaceBytes = (before: Buffer, after: Buffer): Buffer => {
  const at = golden.indexOf(before);
  if (at < 0 || golden.indexOf(before, at + 1) >= 0)
    throw new Error(
      "the golden file must hold the mutation's byte sequence once",
    );
  return Buffer.concat([
    golden.subarray(0, at),
    after,
    golden.subarray(at + before.length),
  ]);
};

// #60: CRLF separates records; quoted CR and LF are field data, preserved verbatim.
const quotedBreaks = [
  ["a bare LF", replaceBytes(Buffer.from("Köln\r\n"), Buffer.from("Köln\n"))],
  ["a bare CR", replaceBytes(Buffer.from("Köln\r\n"), Buffer.from("Köln\r"))],
] as const;

const invalidFiles = [
  ["missing UTF-8 BOM", golden.subarray(3)],
  [
    "invalid UTF-8 in a title",
    replaceBytes(Buffer.from("Café"), Buffer.from([0x43, 0x61, 0x66, 0xff])),
  ],
  [
    "a bare LF between rows",
    replaceBytes(Buffer.from("Fällig\r\n"), Buffer.from("Fällig\n")),
  ],
  [
    "a bare CR between rows",
    replaceBytes(Buffer.from("Fällig\r\n"), Buffer.from("Fällig\r")),
  ],
  ["missing terminal CRLF", golden.subarray(0, -2)],
  [
    "a decimal point instead of a comma",
    replaceBytes(Buffer.from("1234,56"), Buffer.from("1234.56")),
  ],
  [
    "only one decimal digit",
    replaceBytes(Buffer.from("0,09"), Buffer.from("0,9")),
  ],
] as const;

describe("the gateway's independent German CSV contract referee", () => {
  it.live(
    "[PAY-4b] GET writes every byte of the hand-authored German accounts sheet",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway", options);
        const response = yield* send(gateway.origin, exportRequest);
        expect(golden).toHaveLength(199);
        expectExport(response);

        const ledger = yield* gateway.ledger;
        expect(ledger).toHaveLength(1);
        expectExportWire(ledger[0]!);
      }).pipe(Effect.timeout("3 seconds")),
  );

  it.live(
    "[PAY-5] importing the hand-authored German sheet replaces a different accounts table",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway", {
          token: "german-csv-golden",
          accounts: [
            {
              account: "99999999",
              title: "Before import",
              cents: 100,
              due: "00000000",
            },
          ],
        });
        const imported = yield* send(gateway.origin, importRequest(golden));
        expect(imported.status).toBe(200);
        expect(header(imported, "content-type")).toEqual(["text/plain"]);
        expect(imported.body.toString("utf8")).toBe("OK|4\n");
        expectExport(yield* send(gateway.origin, exportRequest));

        const ledger = yield* gateway.ledger;
        expect(ledger).toHaveLength(2);
        expectImportWire(ledger[0]!, golden);
        expectExportWire(ledger[1]!);
      }).pipe(Effect.timeout("3 seconds")),
  );

  for (const [name, body] of quotedBreaks)
    it.live(
      `[PAY-5] import and export preserve ${name} inside a quoted title`,
      () =>
        Effect.gen(function* () {
          const gateway = yield* lane.backend("gateway", {
            token: "german-csv-golden",
            accounts: [],
          });
          const response = yield* send(gateway.origin, importRequest(body));
          expect(response.status).toBe(200);
          expect(header(response, "content-type")).toEqual(["text/plain"]);
          expect(response.body.toString("utf8")).toBe("OK|4\n");
          expectExport(yield* send(gateway.origin, exportRequest), body);

          const ledger = yield* gateway.ledger;
          expect(ledger).toHaveLength(2);
          expectImportWire(ledger[0]!, body);
          expectExportWire(ledger[1]!);
        }).pipe(Effect.timeout("3 seconds")),
    );

  for (const [name, body] of invalidFiles)
    it.live(`[PAY-5] import refuses ${name} on the wire`, () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway", {
          token: "german-csv-golden",
          accounts: [],
        });
        const response = yield* send(gateway.origin, importRequest(body));
        expect(response.status).toBe(200);
        expect(header(response, "content-type")).toEqual(["text/plain"]);
        expect(response.body.toString("utf8")).toMatch(
          /^ERROR\|E_FORMAT\|[^\n]+\n$/,
        );

        const ledger = yield* gateway.ledger;
        expect(ledger).toHaveLength(1);
        expectImportWire(ledger[0]!, body);
      }).pipe(Effect.timeout("3 seconds")),
    );
});
