// lane: node-only. This file verifies what the business backend really writes to its socket, which
// needs a raw TCP connection; a browser cannot open one, and every HTTP client, Fetch included,
// discards any bytes after a 204 by protocol.
import { connect } from "node:net";
import { lane } from "#lane";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { pathOf } from "../harness/lane.js";

/** Start the business API for one test. This file starts backends nowhere else. */
const start = lane.backend("business", {
  envelopes: {
    customers: [{ id: 1003, name: "Fabrikam Fibres", tier: "SILVER" }],
  },
});

/** Send one raw HTTP/1.1 request and collect every byte until the server closes. */
const exchange = (origin: string, request: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const { hostname, port } = new URL(origin);
        const chunks: Array<Uint8Array> = [];
        const socket = connect(Number(port), hostname, () =>
          socket.write(request.replaceAll("{host}", `${hostname}:${port}`)),
        );
        socket.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        socket.on("end", () =>
          resolve(
            chunks
              .map((chunk) => new TextDecoder("latin1").decode(chunk))
              .join(""),
          ),
        );
        socket.on("error", reject);
      }),
  );

describe("business API: envelopes (node only)", () => {
  it.live("[STAT-3] the fixture's 204 carries no body bytes on the wire", () =>
    Effect.gen(function* () {
      const backend = yield* start;
      const raw = yield* exchange(
        backend.origin,
        "POST /v1/customers/1003/archive HTTP/1.1\r\nHost: {host}\r\n" +
          "Content-Length: 0\r\nConnection: close\r\n\r\n",
      );
      const [head, ...rest] = raw.split("\r\n\r\n");
      expect(head?.split("\r\n")[0]).toBe("HTTP/1.1 204 No Content");
      expect(head).toContain("Content-Type: application/json;charset=UTF-8");
      expect(head).not.toMatch(/content-length|transfer-encoding/i);
      // The handler wrote a debug body; Node's server dropped it before the socket.
      expect(rest.join("\r\n\r\n")).toBe("");
      const ledger = yield* backend.ledger;
      expect(ledger.map(pathOf)).toEqual(["/v1/customers/1003/archive"]);
    }),
  );
});
