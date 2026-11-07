/**
 * EXT-9a to EXT-9d and EXT-9f: fragments on the request line. These run in the Node lane only,
 * because only Node has the raw client: nothing else writes a fragment on a socket. What the lane's
 * other providers do with the same declarations is in `fragments.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { lane } from "#lane";
import { Help } from "../clients/gateway/index.js";
import { type Received, receivedOf, watching } from "../clients/received.js";
import { header, type Recorded } from "../harness/lane.js";

const HELP = "/cgi-bin/help.cgi/accounts";

const opening = {
  topic: "accounts",
  section: "opening",
  text: "Open an account from the File menu.",
};
const closing = {
  topic: "accounts",
  section: "closing",
  text: "Close an account at month end.",
};

const requestLines = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map((entry) => `${entry.method} ${entry.target}`);

/** A declaration from `Help`, through the raw client. */
const throughRaw = <A, E>(
  origin: string,
  declared: (
    origin: string,
    last: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
  ) => Effect.Effect<A, E, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const watched = watching();
    const outcome = yield* declared(origin, watched.last).pipe(
      Effect.provide(lane.rawClient!(origin)),
    );
    return { outcome, received: watched.received };
  });

describe("fragments through the raw client (node)", () => {
  it.live(
    "[EXT-9a] a fragment in the base URL reaches help.cgi, which answers that section",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const { outcome, received } = yield* throughRaw(
          gateway.origin,
          Help.inBaseUrl,
        );
        expect(received).toEqual([
          {
            method: "GET",
            url: `${gateway.origin}${HELP}#closing`,
            hash: undefined,
          },
        ]);
        const ledger = yield* gateway.ledger;
        expect(requestLines(ledger)).toEqual([`GET ${HELP}#closing`]);
        expect(header(ledger[0]!.lines, "accept")).toBe("text/plain");
        expect(outcome).toEqual({ _tag: "Help", sections: [closing] });
      }),
  );

  it.live(
    "[EXT-9a] a fragment in path output reaches help.cgi, which answers that section",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const { outcome, received } = yield* throughRaw(
          gateway.origin,
          Help.inPathOutput,
        );
        expect(received).toEqual([
          {
            method: "GET",
            url: `${gateway.origin}${HELP}#closing`,
            hash: undefined,
          },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([
          `GET ${HELP}#closing`,
        ]);
        expect(outcome).toEqual({ _tag: "Help", sections: [closing] });
      }),
  );

  it.live(
    "[EXT-9b] setHash in transformClient puts the fragment after the query, and help.cgi answers that section in German",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const { outcome, received } = yield* throughRaw(
          gateway.origin,
          Help.inMiddleware,
        );
        expect(received).toEqual([
          {
            method: "GET",
            url: `${gateway.origin}${HELP}?lang=de`,
            hash: "closing",
          },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([
          `GET ${HELP}?lang=de#closing`,
        ]);
        expect(outcome).toEqual({
          _tag: "Help",
          sections: [
            {
              topic: "accounts",
              section: "closing",
              text: "Konten werden zum Monatsende geschlossen.",
            },
          ],
        });
      }),
  );

  it.live(
    "[EXT-9c] currently, the constructor removes a fragment before the client sees it, so help.cgi answers the whole topic",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const { outcome, received } = yield* throughRaw(
          gateway.origin,
          Help.inConstructor,
        );
        expect(received).toEqual([
          { method: "GET", url: `${gateway.origin}${HELP}`, hash: undefined },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([`GET ${HELP}`]);
        expect(outcome).toEqual({ _tag: "Help", sections: [opening, closing] });
      }),
  );

  it.live(
    "[EXT-9d] currently, a query goes after a fragment in path output, so help.cgi reads it as part of the section name",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const { outcome, received } = yield* throughRaw(
          gateway.origin,
          Help.inPathOutputWithQuery,
        );
        expect(received).toEqual([
          {
            method: "GET",
            url: `${gateway.origin}${HELP}#closing?lang=de`,
            hash: undefined,
          },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([
          `GET ${HELP}#closing?lang=de`,
        ]);
        expect(outcome).toEqual({
          _tag: "GatewayError",
          code: "E_SECTION",
          message: "no section closing?lang=de",
        });
      }),
  );

  it.live(
    "[EXT-9f] followRedirects moves a Location's fragment into the hash, and the raw client sends it to help.cgi",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const go = `${gateway.origin}/cgi-bin/go.cgi?section=closing`;
        // A `tapRequest` sees the request once, before any redirect, so each hop is read from
        // inside `followRedirects`: the title claims the hash, which the ledger alone cannot show.
        const hops: Array<Received> = [];
        const everyHop = (client: HttpClient.HttpClient) =>
          HttpClient.transform(client, (response, request) => {
            hops.push(receivedOf(request));
            return response;
          });
        const { outcome, received } = yield* throughRaw(
          gateway.origin,
          (origin, last) =>
            Help.throughGo(origin, (client) =>
              last(HttpClient.followRedirects(everyHop(client))),
            ),
        );
        expect(received).toEqual([{ method: "GET", url: go, hash: undefined }]);
        expect(hops).toEqual([
          { method: "GET", url: go, hash: undefined },
          { method: "GET", url: `${gateway.origin}${HELP}`, hash: "closing" },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([
          "GET /cgi-bin/go.cgi?section=closing",
          `GET ${HELP}#closing`,
        ]);
        expect(outcome).toEqual({ _tag: "Help", sections: [closing] });
      }),
  );
});
