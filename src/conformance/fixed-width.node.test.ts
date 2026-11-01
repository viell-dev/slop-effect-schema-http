/**
 * Backend-side month-end checks against an independently hand-authored contract referee.
 * Node-only: read literal fixture bytes from disk and send HTTP without the consumer's codecs.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json } from "../harness/lane.js";
import { header, type Response, send } from "./recordings.js";

const golden = readFileSync(
  new URL("../../fixtures/gateway/month-end.DAT", import.meta.url),
);

// Copied from the referee's documented gateway input, independently of the consumer-side tests.
// No trailer override: the writer must calculate the four details' count and control total.
const options = {
  token: "fixed-width-referee",
  extracts: {
    "202402": {
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
} satisfies Json;

const target = "/cgi-bin/extract.cgi?session=fixed-width-referee&period=202402";
const rpcTarget = "/RPC2?session=fixed-width-referee";
const call =
  '<?xml version="1.0"?><methodCall><methodName>extract.fetch</methodName>' +
  "<params><param><value><string>202402</string></value></param></params></methodCall>";

/**
 * Node's HTTP parser knows a HEAD response has no body despite its Content-Length. The neutral
 * conformance send() reads arbitrary raw requests, so cannot infer that exception from a reply.
 */
const sendHead = (origin: string): Effect.Effect<Response> =>
  Effect.promise(
    () =>
      new Promise<Response>((resolve, reject) => {
        const outgoing = request(
          new URL(target, origin),
          {
            method: "HEAD",
            headers: { Host: "gateway.test", Connection: "close" },
            agent: false,
            signal: AbortSignal.timeout(3000),
          },
          (incoming) => {
            const chunks: Array<Buffer> = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("error", reject);
            incoming.on("end", () =>
              resolve({
                status: incoming.statusCode!,
                reason: incoming.statusMessage!,
                lines: Array.from(
                  { length: incoming.rawHeaders.length / 2 },
                  (_, index) =>
                    [
                      incoming.rawHeaders[index * 2]!,
                      incoming.rawHeaders[index * 2 + 1]!,
                    ] as const,
                ),
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      }),
  );

const expectMetadata = (response: Response): void => {
  expect(response.status).toBe(200);
  expect(header(response, "content-type")).toEqual([
    "application/octet-stream",
  ]);
  expect(header(response, "content-length")).toEqual(["384"]);
  expect(header(response, "last-modified")).toEqual([
    "Fri, 01 Mar 2024 02:03:04 GMT",
  ]);
  expect(header(response, "content-disposition")).toEqual([
    'attachment; filename="ME202402.DAT"',
  ]);
  expect(header(response, "x-record-count")).toEqual(["4"]);
  expect(header(response, "x-control-total")).toEqual(["0098765556345"]);
};

describe("the gateway's independent month-end contract referee", () => {
  it.live(
    "[PAY-4c] GET writes every byte of the hand-authored month-end extract",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway", options);
        const actual = yield* send(
          gateway.origin,
          Buffer.from(
            `GET ${target} HTTP/1.1\r\nHost: gateway.test\r\nConnection: close\r\n\r\n`,
          ),
        );
        expectMetadata(actual);
        expect(golden).toHaveLength(384);
        expect(actual.body).toEqual(golden);

        const ledger = yield* gateway.ledger;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.method).toBe("GET");
        expect(ledger[0]!.target).toBe(target);
        expect(ledger[0]!.lines).toEqual([
          ["Host", "gateway.test"],
          ["Connection", "close"],
        ]);
        expect(ledger[0]!.body).toHaveLength(0);
      }),
  );

  it.live(
    "[PAY-4c] HEAD reports the hand-authored extract's count, total and download metadata",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway", options);
        const actual = yield* sendHead(gateway.origin);
        expectMetadata(actual);
        expect(actual.body).toHaveLength(0);

        const ledger = yield* gateway.ledger;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.method).toBe("HEAD");
        expect(ledger[0]!.target).toBe(target);
        expect(ledger[0]!.lines).toEqual([
          ["Host", "gateway.test"],
          ["Connection", "close"],
        ]);
        expect(ledger[0]!.body).toHaveLength(0);
      }),
  );

  it.live(
    "[PAY-8] extract.fetch embeds the hand-authored month-end bytes as base64",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway", options);
        const actual = yield* send(
          gateway.origin,
          Buffer.from(
            `POST ${rpcTarget} HTTP/1.1\r\nHost: gateway.test\r\nConnection: close\r\n` +
              `Content-Type: text/xml\r\nContent-Length: ${Buffer.byteLength(call)}\r\n\r\n${call}`,
          ),
        );
        expect(actual.status).toBe(200);
        expect(header(actual, "content-type")).toEqual(["text/xml"]);
        const xml = actual.body.toString("utf8");
        expect(xml).toMatch(
          /^<\?xml version="1\.0"\?>\s*<methodResponse>\s*<params>\s*<param>\s*<value><base64>[A-Za-z0-9+/=\s]+<\/base64><\/value>\s*<\/param>\s*<\/params>\s*<\/methodResponse>\s*$/,
        );
        const base64 = /<base64>([A-Za-z0-9+/=\s]+)<\/base64>/.exec(xml)![1]!;
        // Buffer decodes the embedded bytes; no consumer XML-RPC or fixed-width codec is used.
        expect(Buffer.from(base64, "base64")).toEqual(golden);

        const ledger = yield* gateway.ledger;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.method).toBe("POST");
        expect(ledger[0]!.target).toBe(rpcTarget);
        expect(ledger[0]!.lines).toEqual([
          ["Host", "gateway.test"],
          ["Connection", "close"],
          ["Content-Type", "text/xml"],
          ["Content-Length", String(Buffer.byteLength(call))],
        ]);
        expect(Buffer.from(ledger[0]!.body)).toEqual(Buffer.from(call));
      }),
  );
});
