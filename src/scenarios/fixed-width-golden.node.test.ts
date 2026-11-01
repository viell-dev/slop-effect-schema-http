/**
 * The consumer against a hand-authored contract referee (#47), not bytes made by either codec.
 * Node-only because this test reads the binary fixture from disk; the existing PAY-4c, PAY-8 and
 * APP-2 scenarios continue to exercise these same operations in Node and Chromium.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { Credentials, Services } from "../clients/flows/index.js";
import { Extract, Rpc } from "../clients/gateway/index.js";
import { bodyText, header } from "../harness/lane.js";

const golden = new Uint8Array(
  readFileSync(
    new URL("../../fixtures/gateway/month-end.DAT", import.meta.url),
  ),
);
const TOKEN = "golden+Opaque/fixture=";
const PERIOD = "202402";
const utc = (iso: string) => DateTime.makeUnsafe(iso);

// Copied from the independent fixture worksheet, in the gateway's public option format.
// No backend implementation, conformance helper or consumer encoder supplied these inputs.
const fixture = {
  token: TOKEN,
  extracts: {
    [PERIOD]: {
      runDate: "20240301",
      lastModified: "2024-03-01T02:03:04Z",
      records: [
        {
          account: "00010001",
          title: "Café",
          cents: 123456,
          due: "20240229",
          status: "O",
        },
        {
          account: "00010002",
          title: "Müller & Söhne",
          cents: 0,
          due: "00000000",
          status: "P",
        },
        {
          account: "00010003",
          title: "Niño",
          cents: 789,
          due: "20240315",
          status: "X",
        },
        {
          account: "00010004",
          title: "Ångström",
          cents: 98765432100,
          due: "00000000",
          status: "O",
        },
      ],
    },
  },
};

// Semantic expectations come from the worksheet, independently of decoding or encoding the file.
const expected = {
  period: PERIOD,
  runDate: utc("2024-03-01T00:00:00Z"),
  items: [
    {
      account: "00010001",
      title: "Café",
      amount: 123456,
      due: Option.some(utc("2024-02-29T00:00:00Z")),
      status: "open",
    },
    {
      account: "00010002",
      title: "Müller & Söhne",
      amount: 0,
      due: Option.none(),
      status: "paid",
    },
    {
      account: "00010003",
      title: "Niño",
      amount: 789,
      due: Option.some(utc("2024-03-15T00:00:00Z")),
      status: "cancelled",
    },
    {
      account: "00010004",
      title: "Ångström",
      amount: 98765432100,
      due: Option.none(),
      status: "open",
    },
  ],
};

const narrow = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

describe("independent fixed-width golden", () => {
  it("[PAY-4c] the hand-authored file decodes to the worksheet and encodes to its exact bytes", () => {
    expect(golden.length).toBe(384);
    expect(createHash("sha256").update(golden).digest("hex")).toBe(
      "0591a50f962e58e2d0c3f71b244f0dbc6d2d8eaa00e36e1a4b80b3fce72f02ea",
    );
    const decoded = Schema.decodeUnknownSync(Extract.MonthEndExtract)(golden);
    expect(decoded).toEqual(expected);
    expect(Schema.encodeSync(Extract.MonthEndExtract)(decoded)).toEqual(golden);
  });

  it("[PAY-4c] corrupted golden count, total, filler and record length fail independently", () => {
    const decode = Schema.decodeUnknownSync(Extract.MonthEndExtract);
    for (const [offset, replacement, reason] of [
      [326, 0x35, /trailer counts 5 records, but the file has 4/],
      [
        339,
        0x36,
        /control total 98765556346 differs from the records' 98765556345/,
      ],
      [63, 0x58, /filler at offset 23 is not blank/],
    ] as const) {
      const corrupt = golden.slice();
      corrupt[offset] = replacement;
      expect(() => decode(corrupt)).toThrow(reason);
    }
    expect(() => decode(golden.subarray(0, -1))).toThrow(
      /not a whole number of 64-byte records/,
    );
  });

  for (const [provider, client] of lane.clients) {
    it.live(
      `[PAY-4c] ${provider}: the HTTP download agrees with the independent file`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("gateway", fixture);
          const outcome = yield* Extract.extract(backend.origin).execute({
            session: TOKEN,
            period: PERIOD,
          });
          const decoded = narrow(outcome, "Extract").value;
          expect(decoded).toEqual(expected);
          expect(Schema.encodeSync(Extract.MonthEndExtract)(decoded)).toEqual(
            golden,
          );
          const raw = yield* Operation.make(
            Request.get(
              `${backend.origin}/cgi-bin/extract.cgi?session=${encodeURIComponent(TOKEN)}&period=${PERIOD}`,
            ),
            Response.status(200, Body.bytes),
          ).execute(undefined);
          expect(raw).toEqual(golden);
          const ledger = yield* backend.ledger;
          expect(ledger.map(({ method, target }) => [method, target])).toEqual([
            [
              "GET",
              `/cgi-bin/extract.cgi?session=${encodeURIComponent(TOKEN)}&period=${PERIOD}`,
            ],
            [
              "GET",
              `/cgi-bin/extract.cgi?session=${encodeURIComponent(TOKEN)}&period=${PERIOD}`,
            ],
          ]);
          expect(header(ledger[0]!.lines, "accept")).toBe(
            "application/octet-stream",
          );
          expect(ledger.every(({ body }) => body.length === 0)).toBe(true);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[PAY-8] ${provider}: XML-RPC's decoded extract agrees with the independent file`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("gateway", fixture);
          const outcome = yield* Rpc.extractFetch(backend.origin).execute({
            session: TOKEN,
            params: [PERIOD],
          });
          const decoded = narrow(outcome, "Result").value;
          expect(decoded).toEqual(expected);
          expect(Schema.encodeSync(Extract.MonthEndExtract)(decoded)).toEqual(
            golden,
          );
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("POST");
          expect(ledger[0]!.target).toBe(
            `/RPC2?session=${encodeURIComponent(TOKEN)}`,
          );
          expect(header(ledger[0]!.lines, "content-type")).toBe("text/xml");
          expect(bodyText(ledger[0]!)).toContain(
            "<methodName>extract.fetch</methodName>",
          );
          expect(bodyText(ledger[0]!)).toContain("<string>202402</string>");
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[APP-2] ${provider}: the saga's first-step operation preserves the independent file and metadata`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("gateway", fixture);
          const source = yield* Credentials.source(TOKEN);
          const outcome = yield* Services.extract(
            backend.origin,
            source,
          ).execute({ period: PERIOD });
          const download = narrow(outcome, "Extract").value;
          expect(download.extract).toEqual(expected);
          expect(download.bytes).toEqual(golden);
          expect(download.file).toEqual({
            name: "ME202402.DAT",
            modified: utc("2024-03-01T02:03:04Z"),
            size: 384,
          });
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("GET");
          expect(ledger[0]!.target).toBe(
            `/cgi-bin/extract.cgi?period=${PERIOD}&session=${encodeURIComponent(TOKEN)}`,
          );
          expect(header(ledger[0]!.lines, "accept")).toBe(
            "application/octet-stream",
          );
          expect(ledger[0]!.body).toHaveLength(0);
        }).pipe(Effect.provide(client)),
    );
  }
});
