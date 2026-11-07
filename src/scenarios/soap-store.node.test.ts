import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer } from "effect";
import type { HttpClient } from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { Actions, Soap } from "../clients/soap-store/index.js";
import { bodyText, headerValues } from "../harness/lane.js";

/**
 * Node-only scenarios of the SOAP document store. Each needs a provider that does not exist in a
 * browser, the line-preserving `node:http` one or the raw one; the fetch variants live in
 * `soap-store.test.ts`.
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

/** The providers that send a GET with a body, by name, for the server at an origin. */
const providers: ReadonlyArray<
  readonly [string, (origin: string) => Layer.Layer<HttpClient.HttpClient>]
> = [
  ["lines", () => lane.linesClient!],
  ["raw", (origin) => lane.rawClient!(origin)],
];

describe("soap-store (node only)", () => {
  // lane: node-only — fetch refuses a GET with a body in both lanes, which `soap-store.test.ts`
  // pins, and only these two providers send one.
  for (const [client, layerOf] of providers)
    it.live(
      `[STAT-12] the documented GET download with a SOAP body reaches the servlet (${client})`,
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const layer = layerOf(backend.origin);
          const id = yield* Actions.operations(backend.origin)
            .listDocuments.execute({ body: { prefix: "contract" } })
            .pipe(
              Effect.provide(layer),
              Effect.map((listed) =>
                listed._tag === "Listed" ? listed.documents[0]!.id : "",
              ),
            );
          const bytes = yield* Operation.make(
            Request.get("soap/download").pipe(
              Request.baseUrl(backend.origin),
              Request.setHeader(
                "SOAPAction",
                `"${Actions.DownloadDocument.uri}"`,
              ),
              Request.body(Soap.Soap11.body(Actions.DownloadDocument)),
            ),
            Response.status(200, Body.bytes),
          )
            .execute({ body: { id } })
            .pipe(Effect.provide(layer));
          expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4 contract");
          const [, recorded] = yield* backend.ledger;
          expect(recorded!.method).toBe("GET");
          expect(recorded!.target).toBe("/soap/download");
          expect(bodyText(recorded!)).toContain(`<Id>${id}</Id>`);
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
