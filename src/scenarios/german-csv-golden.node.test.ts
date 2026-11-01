/**
 * Independent hand-authored German CSV reference for PAY-5/PAY-4b (#47).
 * Node-only because the exact binary fixture is read from disk; existing gateway scenarios run
 * these consumer operations in both Node and Chromium.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { Accounts } from "../clients/gateway/index.js";
import { bodyText, header } from "../harness/lane.js";

const golden = new Uint8Array(
  readFileSync(
    new URL("../../fixtures/gateway/german-accounts.csv", import.meta.url),
  ),
);
const TOKEN = "german-csv-golden";
const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
  golden,
);
const utc = (iso: string) => DateTime.makeUnsafe(iso);

// Independent fixture worksheet inputs, copied in the gateway's option format.
const options = {
  token: TOKEN,
  accounts: [
    { account: "00123456", title: "Café Müller", cents: 0, due: "00000000" },
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
    { account: "00000009", title: "Straße", cents: 9, due: "20270228" },
  ],
};

// Worksheet meanings, not values computed by either CSV implementation.
const expected = [
  { account: "00123456", title: "Café Müller", amount: 0, due: Option.none() },
  {
    account: "12345678",
    title: 'Büro; "Süd"',
    amount: 123456,
    due: Option.some(utc("2026-12-31T00:00:00Z")),
  },
  {
    account: "87654321",
    title: "Köln\r\nZweite Zeile",
    amount: -705,
    due: Option.some(utc("2026-11-30T00:00:00Z")),
  },
  {
    account: "00000009",
    title: "Straße",
    amount: 9,
    due: Option.some(utc("2027-02-28T00:00:00Z")),
  },
];

const narrow = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

describe("independent German CSV golden", () => {
  it("[PAY-5] the hand-authored German sheet decodes to the worksheet and encodes to its exact bytes", () => {
    expect(golden).toHaveLength(199);
    expect(createHash("sha256").update(golden).digest("hex")).toBe(
      "43398132edf2a05c036ad544ee3c81b05e77cfbb0e2805457647e525448a6224",
    );
    const rows = Schema.decodeUnknownSync(Accounts.GermanSheet)(golden);
    expect(rows).toEqual(expected);
    expect(Schema.encodeSync(Accounts.GermanSheet)(rows)).toEqual(golden);
  });

  it("[PAY-4b] the independent byte codec requires the BOM that a text decode discards", () => {
    expect(Array.from(golden.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(golden).startsWith("Konto;")).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(Accounts.GermanSheet)(golden.subarray(3)),
    ).toThrow(/no UTF-8 byte-order mark/);
  });

  it("[PAY-5] the independent file rejects invalid UTF-8, record endings and decimal points", () => {
    const decode = Schema.decodeUnknownSync(Accounts.GermanSheet);
    const badUtf8 = golden.slice();
    badUtf8[badUtf8.indexOf(0xc3)] = 0xff;
    expect(() => decode(badUtf8)).toThrow(/not valid UTF-8/);
    expect(() => decode(utf8.encode(text.replaceAll("\r\n", "\n")))).toThrow(
      /bare LF/,
    );
    expect(() => decode(golden.subarray(0, -2))).toThrow(
      /missing final line ending/,
    );
    expect(() =>
      decode(utf8.encode(text.replace("1234,56", "1234.56"))),
    ).toThrow(/exactly two decimals after ","/);
  });

  for (const [name, replacement] of [
    ["LF", "\n"],
    ["CR", "\r"],
  ] as const) {
    // #60: these exact inputs disproved an overly broad rejection expectation. They are valid
    // quoted field data; only record separators must be CRLF. Retain both byte-preserving controls.
    it(`[PAY-5] ${name} inside the golden quoted title is preserved as field data`, () => {
      const varied = utf8.encode(
        text.replace("Köln\r\nZweite", `Köln${replacement}Zweite`),
      );
      const rows = Schema.decodeUnknownSync(Accounts.GermanSheet)(varied);
      expect(rows).toEqual(
        expected.map((row, index) =>
          index === 2
            ? { ...row, title: `Köln${replacement}Zweite Zeile` }
            : row,
        ),
      );
      expect(Schema.encodeSync(Accounts.GermanSheet)(rows)).toEqual(varied);
    });
  }

  for (const [provider, client] of lane.clients) {
    it.live(
      `[PAY-5] ${provider}: the exported sheet agrees with the independent file`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("gateway", options);
          const outcome = yield* Accounts.exportAccounts(
            backend.origin,
            true,
          ).execute({ session: TOKEN, german: true });
          const rows = narrow(outcome, "Accounts").rows;
          expect(rows).toEqual(expected);
          expect(Schema.encodeSync(Accounts.GermanSheet)(rows)).toEqual(golden);
          const exportTarget = `/cgi-bin/report.cgi?session=${TOKEN}&report=accounts&format=csv&locale=de_DE`;
          const raw = yield* Operation.make(
            Request.get(`${backend.origin}${exportTarget}`),
            Response.status(200, Body.bytes),
          ).execute(undefined);
          expect(raw).toEqual(golden);
          const ledger = yield* backend.ledger;
          expect(ledger.map(({ method, target }) => [method, target])).toEqual([
            ["GET", exportTarget],
            ["GET", exportTarget],
          ]);
          expect(header(ledger[0]!.lines, "accept")).toBe("text/csv");
          expect(ledger.every(({ body }) => body.length === 0)).toBe(true);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[PAY-5] ${provider}: the independently decoded rows upload as the exact file and read back`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("gateway", {
            token: TOKEN,
            accounts: [],
          });
          const rows = Schema.decodeUnknownSync(Accounts.GermanSheet)(golden);
          expect(rows).toEqual(expected);
          const imported = yield* Accounts.importAccounts(
            backend.origin,
          ).execute({ session: TOKEN, rows });
          expect(imported).toEqual({ _tag: "Imported", rows: 4 });
          const outcome = yield* Accounts.exportAccounts(
            backend.origin,
            true,
          ).execute({ session: TOKEN, german: true });
          expect(narrow(outcome, "Accounts").rows).toEqual(expected);
          const ledger = yield* backend.ledger;
          expect(ledger.map(({ method, target }) => [method, target])).toEqual([
            ["POST", `/cgi-bin/import.cgi?session=${TOKEN}&locale=de_DE`],
            [
              "GET",
              `/cgi-bin/report.cgi?session=${TOKEN}&report=accounts&format=csv&locale=de_DE`,
            ],
          ]);
          expect(header(ledger[0]!.lines, "content-type")).toBe(
            "text/csv; charset=utf-8",
          );
          expect(ledger[0]!.body).toEqual(golden);
          expect(ledger[1]!.body).toHaveLength(0);
          expect(bodyText(ledger[0]!)).toContain('"Büro; ""Süd"""');
          expect(bodyText(ledger[0]!)).toContain('"Köln\r\nZweite Zeile"');
        }).pipe(Effect.provide(client)),
    );
  }
});
