import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { Actions, Soap } from "../clients/soap-store/index.js";
import { bodyText, headerValues } from "../harness/lane.js";

/**
 * Node-only scenarios of the SOAP document store. Each needs the line-preserving `node:http`
 * provider, which does not exist in a browser; the fetch variants live in `soap-store.test.ts`.
 */

const start = () =>
  lane.backend("soap-store", {
    documents: [
      {
        name: "contract-acme.pdf",
        title: "Rahmenvertrag ACME",
        contentType: "application/pdf",
        text: "%PDF-1.4 contract",
      },
    ],
  });

const NS = "urn:docvault:store:2003";

describe("soap-store (node only)", () => {
  // lane: node-only — browsers refuse to send a GET with a body, and only the node:http provider
  // sends one.
  it.live(
    "[STAT-12] the fixture really serves a GET with a SOAP body, reachable only by rewriting the method in client middleware",
    () =>
      Effect.gen(function* () {
        const lines = lane.linesClient!;
        const backend = yield* start();
        const id = yield* Actions.operations(backend.origin)
          .listDocuments.execute({ body: { prefix: "contract" } })
          .pipe(
            Effect.provide(lines),
            Effect.map((listed) =>
              listed._tag === "Listed" ? listed.documents[0]!.id : "",
            ),
          );
        // The library checks the method before dispatch; client middleware runs after that check.
        const download = Operation.make(
          Request.post("soap/download").pipe(
            Request.baseUrl(backend.origin),
            Request.setHeader(
              "SOAPAction",
              `"${Actions.DownloadDocument.uri}"`,
            ),
            Request.body(Soap.Soap11.body(Actions.DownloadDocument)),
          ),
          Response.status(200, Body.bytes),
          {
            transformClient: HttpClient.mapRequest(
              HttpClientRequest.setMethod("GET"),
            ),
          },
        );
        const bytes = yield* download
          .execute({ body: { id } })
          .pipe(Effect.provide(lines));
        expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4 contract");
        const [, recorded] = yield* backend.ledger;
        expect(recorded!.method).toBe("GET");
        expect(recorded!.target).toBe("/soap/download");
        expect(bodyText(recorded!)).toContain(`<Id>${id}</Id>`);
        // Node's fetch refuses the same rewritten request as a transport error.
        const error = yield* download
          .execute({ body: { id } })
          .pipe(Effect.provide(lane.fetchClient), Effect.flip);
        expect(error._tag).toBe("HttpClientError");
        expect(
          error._tag === "HttpClientError" ? error.reason._tag : undefined,
        ).toBe("TransportError");
        expect(yield* backend.ledger).toHaveLength(2);
      }),
  );

  // lane: node-only — only the node:http provider sends repeated header lines unjoined.
  it.live(
    "[HDR-6] two SOAPAction lines are refused as repeated through the line-preserving provider",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const reason = yield* Operation.make(
          Request.post("soap").pipe(
            Request.baseUrl(backend.origin),
            Request.appendHeader("SOAPAction", `"${NS}#FetchDocument"`),
            Request.appendHeader("SOAPAction", `"${NS}#FetchDocument"`),
            Request.body(Soap.Soap11.body(Actions.FetchDocument)),
          ),
          Response.status(400, Body.text),
        )
          .execute({ body: { id: "DOC-000001" } })
          .pipe(Effect.provide(lane.linesClient!));
        expect(reason).toBe("SOAPAction header must appear exactly once\r\n");
        const [recorded] = yield* backend.ledger;
        expect(headerValues(recorded!.lines, "soapaction")).toEqual([
          `"${NS}#FetchDocument"`,
          `"${NS}#FetchDocument"`,
        ]);
      }),
  );
});
