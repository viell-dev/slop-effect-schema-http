/**
 * An independent reading of the SOAP document store's XML, in Chromium. The consumer and the store
 * each have their own small XML reader and writer, so a mistake they share would pass every other
 * test; the browser's `DOMParser` is a conforming XML parser that neither of them wrote. It exists
 * only in the browser, so these tests run only in the browser project (`*.browser.test.ts`).
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { Actions, Soap } from "../clients/soap-store/index.js";
import { bodyText } from "../harness/lane.js";

const fixture = {
  documents: [
    {
      name: "Prüfbericht.txt",
      title: "Prüfbericht für Café Größe – 5 €",
      contentType: "text/plain",
      text: "Prüfung bestanden.\n",
      modified: "2026-10-01T09:30:00Z",
    },
  ],
  clock: "2026-10-29T12:00:00Z",
} as const;

/** ISO-8859-1 by hand: one code point per byte. */
const latin1 = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

/** Parse with Chromium's XML parser; a well-formedness error yields a `parsererror` element. */
const parseXml = (text: string): Document =>
  new DOMParser().parseFromString(text, "text/xml");

const parserError = (document: Document): string | undefined =>
  document.querySelector("parsererror")?.textContent ?? undefined;

/** The text of the only element with the given local name. */
const textOf = (document: Document, local: string): string | null => {
  const found = document.getElementsByTagNameNS("*", local);
  expect(found).toHaveLength(1);
  return found[0]!.textContent;
};

describe("soap-store (browser only)", () => {
  it.live(
    "[PAY-4a] Chromium's DOMParser reads the store's replies and the consumer's requests without a parsererror",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("soap-store", fixture);
        const soap = Actions.operations(backend.origin);
        // White space the line-end rules would change, markup characters, a character above
        // U+00FF that the Latin-1 writer references, and one outside the Basic Multilingual Plane.
        const title =
          "Zeile 1\r\nZeile 2\tTab <&> \"Zitat\" 'x' – 5 € \u{1D11E}";
        const stored = yield* soap.storeDocument.execute({
          body: {
            name: "probe.txt",
            title,
            contentType: "text/plain",
            content: new TextEncoder().encode("x"),
          },
        });
        expect(stored._tag).toBe("Stored");
        if (stored._tag !== "Stored") return;
        const raw = <In>(
          protocol: Soap.Protocol,
          action: Soap.Framed<In>,
          status: number,
          input: In,
        ) =>
          Operation.make(
            protocol.request(action).pipe(Request.baseUrl(backend.origin)),
            Response.status(status, Body.bytes),
          ).execute({ body: input });

        const replies = {
          fetched: latin1(
            yield* raw(Soap.Soap11, Actions.FetchDocument, 200, {
              id: stored.id,
            }),
          ),
          listed: latin1(
            yield* raw(Soap.Soap11, Actions.ListDocuments, 200, {
              prefix: "",
            }),
          ),
          fault: latin1(
            yield* raw(Soap.Soap11, Actions.LockDocument, 500, {
              id: "DOC-999999",
              owner: "alice",
              seconds: 5,
            }),
          ),
          soap12: new TextDecoder().decode(
            yield* raw(Soap.Soap12, Actions.FetchDocument, 200, {
              id: stored.id,
            }),
          ),
        };
        for (const [name, reply] of Object.entries(replies))
          expect([name, parserError(parseXml(reply))]).toEqual([
            name,
            undefined,
          ]);
        // The browser reads the same title the consumer stored, CR included.
        expect(textOf(parseXml(replies.fetched), "Title")).toBe(title);
        expect(textOf(parseXml(replies.soap12), "Title")).toBe(title);
        expect(replies.fetched).toContain("&#119070;");

        // Every request the consumer wrote parses too.
        const ledger = yield* backend.ledger;
        expect(ledger).toHaveLength(5);
        for (const recorded of ledger)
          expect(parserError(parseXml(bodyText(recorded)))).toBeUndefined();
        expect(textOf(parseXml(bodyText(ledger[0]!)), "Title")).toBe(title);

        // The check can fail: the documents the readers now refuse are errors to Chromium too.
        for (const broken of [
          "<a>A\u0000B</a>",
          "<a>A&#0;B</a>",
          "<a>R & D</a>",
        ])
          expect(parserError(parseXml(broken))).toBeDefined();
      }).pipe(Effect.provide(lane.fetchClient)),
  );
});
