/**
 * EXT-9e, EXT-9g and EXT-9o: what happens to a fragment when the platform writes the request, in
 * both lanes. The raw client's side of the same declarations is in `fragments.node.test.ts`. Each client
 * receives what the raw client receives, so a regression that lost a fragment only in a browser
 * shows up here even though no browser ever sends one.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { Help } from "../clients/gateway/index.js";
import { watching } from "../clients/received.js";
import type { Recorded } from "../harness/lane.js";

const HELP = "/cgi-bin/help.cgi/accounts";

const english = [
  {
    topic: "accounts",
    section: "opening",
    text: "Open an account from the File menu.",
  },
  {
    topic: "accounts",
    section: "closing",
    text: "Close an account at month end.",
  },
];
const german = [
  {
    topic: "accounts",
    section: "opening",
    text: "Konten werden im Dateimenue angelegt.",
  },
  {
    topic: "accounts",
    section: "closing",
    text: "Konten werden zum Monatsende geschlossen.",
  },
];

/** A declaration, what the client received from it, what arrived, and the answer. */
const cases = [
  ["the base URL", Help.inBaseUrl, HELP, "closing", HELP, english],
  ["path output", Help.inPathOutput, HELP, "closing", HELP, english],
  [
    "setHash in transformClient",
    Help.inMiddleware,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de`,
    german,
  ],
  ["the constructor", Help.inConstructor, HELP, "closing", HELP, english],
  [
    "path output with a query",
    Help.inPathOutputWithQuery,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de`,
    german,
  ],
  [
    "the constructor with a query",
    Help.inConstructorWithQuery,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de`,
    german,
  ],
  [
    "the constructor under Request.path",
    Help.inConstructorUnderPath,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de`,
    german,
  ],
  [
    "a base URL with a path and a query",
    Help.inBaseUrlWithPath,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de`,
    german,
  ],
  [
    "the constructor over path output",
    Help.constructorOverPathOutput,
    HELP,
    "closing",
    HELP,
    english,
  ],
  [
    "path output over the base URL",
    Help.pathOutputOverBaseUrl,
    HELP,
    "closing",
    HELP,
    english,
  ],
  [
    "a base URL that was bypassed",
    Help.inBypassedBaseUrl,
    HELP,
    "closing",
    HELP,
    english,
  ],
  [
    "a fragment holding a ?",
    Help.questionMarkInFragment,
    `${HELP}?lang=de`,
    "closing?x=1",
    `${HELP}?lang=de`,
    german,
  ],
  [
    "a fragment URL would encode",
    Help.unencodedFragment,
    HELP,
    'a b"c',
    HELP,
    english,
  ],
  ["an empty fragment", Help.emptyFragment, HELP, "", HELP, english],
] as const;

const requestLines = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map((entry) => `${entry.method} ${entry.target}`);

describe(`fragments through the platform (${lane.name})`, () => {
  for (const [provider, client] of lane.clients)
    for (const [declaration, declared, url, hash, target, sections] of cases)
      it.live(
        `[EXT-9e] ${provider} drops a fragment from ${declaration}, and help.cgi answers without it`,
        () =>
          Effect.gen(function* () {
            const gateway = yield* lane.backend("gateway");
            const watched = watching();
            const outcome = yield* declared(gateway.origin, watched.last).pipe(
              Effect.provide(client),
            );
            expect(watched.received).toEqual([
              { method: "GET", url: `${gateway.origin}${url}`, hash },
            ]);
            expect(requestLines(yield* gateway.ledger)).toEqual([
              `GET ${target}`,
            ]);
            expect(outcome).toEqual({ _tag: "Help", sections });
          }),
      );

  for (const [provider, client] of lane.clients)
    it.live(
      `[EXT-9o] removeHash in Request.mapEffect takes the constructor's fragment off before ${provider} receives the request`,
      () =>
        Effect.gen(function* () {
          const gateway = yield* lane.backend("gateway");
          const watched = watching();
          const outcome = yield* Help.fragmentRemoved(
            gateway.origin,
            watched.last,
          ).pipe(Effect.provide(client));
          expect(watched.received).toEqual([
            { method: "GET", url: `${gateway.origin}${HELP}`, hash: undefined },
          ]);
          expect(requestLines(yield* gateway.ledger)).toEqual([`GET ${HELP}`]);
          expect(outcome).toEqual({ _tag: "Help", sections: english });
        }),
    );

  it.live(
    "[EXT-9g] fetch follows go.cgi's redirect without the Location's fragment, and help.cgi answers the whole topic",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const watched = watching();
        const outcome = yield* Help.throughGo(
          gateway.origin,
          watched.last,
        ).pipe(Effect.provide(lane.fetchClient));
        expect(watched.received).toEqual([
          {
            method: "GET",
            url: `${gateway.origin}/cgi-bin/go.cgi?section=closing`,
            hash: undefined,
          },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([
          "GET /cgi-bin/go.cgi?section=closing",
          `GET ${HELP}`,
        ]);
        expect(outcome).toEqual({ _tag: "Help", sections: english });
      }),
  );
});
