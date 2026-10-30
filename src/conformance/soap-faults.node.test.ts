/**
 * EXT-6e: the SOAP store's LockDocument faults against the JAX-WS reference implementation in
 * JDK 8, recorded for the same three refusals in SOAP 1.1 and 1.2 (`recordings/jaxws-faults`).
 * Node-only: the recordings are read from disk and compared with the raw status and header lines
 * the store sends.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import {
  date,
  differences,
  header,
  infoset,
  masked,
  recorded,
  retarget,
  send,
} from "./recordings.js";

/** The recording's data: DOC-000001 exists, and archive-robot locks it until 12:05:00. */
const options = {
  documents: [
    {
      name: "contract.txt",
      title: "Contract",
      contentType: "text/plain",
      text: "synthetic",
    },
  ],
  clock: "2026-11-01T12:00:00Z",
};

const LOCK =
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><LockDocument xmlns="urn:docvault:store:2003"><Id>DOC-000001</Id><Owner>archive-robot</Owner></LockDocument></soap:Body></soap:Envelope>';

/** Setup, not compared: archive-robot takes DOC-000001's lock for the default 300 seconds. */
const lockByArchiveRobot = Buffer.from(
  [
    "POST /soap HTTP/1.1",
    "Host: soap-store.example",
    "Content-Type: text/xml; charset=utf-8",
    'SOAPAction: "urn:docvault:store:2003#LockDocument"',
    "Connection: close",
    `Content-Length: ${LOCK.length}`,
    "",
    LOCK,
  ].join("\r\n"),
  "latin1",
);

/** The elements whose text is a qualified name: SOAP 1.1's faultcode and SOAP 1.2's Value. */
const qualified = (name: string) =>
  name === "{}faultcode" ||
  name === "{http://www.w3.org/2003/05/soap-envelope}Value";

/**
 * Sends a recorded call to a fresh store whose DOC-000001 archive-robot has locked. Adapted: SOAP
 * 1.2 calls go to `/soap`, where the store serves both versions; the recorded runtime publishes
 * one binding per address.
 */
const call = (name: string) =>
  Effect.gen(function* () {
    const exchange = recorded("jaxws-faults", name);
    const store = yield* lane.backend("soap-store", options);
    const lock = yield* send(store.origin, lockByArchiveRobot);
    expect(lock.status).toBe(200);
    const actual = yield* send(
      store.origin,
      retarget(exchange.request, "/soap"),
    );
    return masked([exchange.response, actual], [date]);
  });

const NAMES = ["missing-owner", "not-found", "conflict"];

describe("[EXT-6e] the store's LockDocument faults against the JAX-WS RI in JDK 8", () => {
  for (const name of NAMES)
    it.live(
      `[EXT-6e] soap11-${name}: the same fault under HTTP 500, in the store's Latin-1 writer`,
      () =>
        Effect.gen(function* () {
          const [expected, actual] = yield* call(`soap11-${name}`);
          // Kept: Node's server answers a request to close with `Connection: close`, and the JDK's
          // spells its own header names (recordings/README.md, "Comparing").
          expect(differences(expected, actual)).toEqual([
            "header connection",
            "header content-type",
            "spelling transfer-encoding",
            "body",
          ]);
          // Kept: SOAP 1.1 replies are ISO-8859-1 under a charset-less text/xml
          // (services/soap-store.md, "Quirks, oldest first").
          expect(header(expected, "content-type")).toEqual([
            "text/xml; charset=utf-8",
          ]);
          expect(header(actual, "content-type")).toEqual(["text/xml"]);
          expect(infoset(actual.body, qualified)).toEqual(
            infoset(expected.body, qualified),
          );
        }),
    );

  for (const name of NAMES)
    it.live(
      `[EXT-6e] soap12-${name}: the same fault under HTTP 500, whatever the 1.2 binding says of sender faults`,
      () =>
        Effect.gen(function* () {
          const [expected, actual] = yield* call(`soap12-${name}`);
          // Kept: the JDK's HTTP server spells its own header names (recordings/README.md).
          expect(differences(expected, actual)).toEqual([
            "header connection",
            "spelling content-type",
            "spelling transfer-encoding",
            "body",
          ]);
          expect([expected.status, actual.status]).toEqual([500, 500]);
          expect(infoset(actual.body, qualified)).toEqual(
            infoset(expected.body, qualified),
          );
        }),
    );
});
