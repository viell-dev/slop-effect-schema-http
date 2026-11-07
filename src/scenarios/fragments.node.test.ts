/**
 * EXT-9a to EXT-9d, EXT-9f and EXT-9h to EXT-9o: fragments on the request line. These run in the Node lane only,
 * because only Node has the raw client: nothing else writes a fragment on a socket. What the lane's
 * other providers do with the same declarations is in `fragments.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import { HttpClient } from "effect/http";
import { lane } from "#lane";
import { Help } from "../clients/gateway/index.js";
import { type Received, receivedOf, watching } from "../clients/received.js";
import { type Backend, header, type Recorded } from "../harness/lane.js";

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
const schliessen = {
  topic: "accounts",
  section: "closing",
  text: "Konten werden zum Monatsende geschlossen.",
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

const inGerman = { _tag: "Help", sections: [schliessen] };

/** A declaration through the raw client: what the client received, what arrived, the answer. */
const reaches = <A, E>(
  title: string,
  declared: (
    origin: string,
    last: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
  ) => Effect.Effect<A, E, HttpClient.HttpClient>,
  url: string,
  hash: string | undefined,
  target: string,
  answer: unknown,
  start: Effect.Effect<Backend, never, Scope.Scope> = lane.backend("gateway"),
) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const gateway = yield* start;
      const { outcome, received } = yield* throughRaw(gateway.origin, declared);
      expect(received).toEqual([
        { method: "GET", url: `${gateway.origin}${url}`, hash },
      ]);
      expect(requestLines(yield* gateway.ledger)).toEqual([`GET ${target}`]);
      expect(outcome).toEqual(answer);
    }),
  );

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
          { method: "GET", url: `${gateway.origin}${HELP}`, hash: "closing" },
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
          { method: "GET", url: `${gateway.origin}${HELP}`, hash: "closing" },
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
        expect(outcome).toEqual({ _tag: "Help", sections: [schliessen] });
      }),
  );

  it.live(
    "[EXT-9c] a fragment in the constructor stays on the request and reaches help.cgi, which answers that section",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway");
        const { outcome, received } = yield* throughRaw(
          gateway.origin,
          Help.inConstructor,
        );
        expect(received).toEqual([
          { method: "GET", url: `${gateway.origin}${HELP}`, hash: "closing" },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([
          `GET ${HELP}#closing`,
        ]);
        expect(outcome).toEqual({ _tag: "Help", sections: [closing] });
      }),
  );

  it.live(
    "[EXT-9d] a query goes before a fragment in path output, and help.cgi answers that section in German",
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
            url: `${gateway.origin}${HELP}?lang=de`,
            hash: "closing",
          },
        ]);
        expect(requestLines(yield* gateway.ledger)).toEqual([
          `GET ${HELP}?lang=de#closing`,
        ]);
        expect(outcome).toEqual({ _tag: "Help", sections: [schliessen] });
      }),
  );

  reaches(
    "[EXT-9h] a constructor's fragment goes after a query set on it, and help.cgi answers that section in German",
    Help.inConstructorWithQuery,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de#closing`,
    inGerman,
  );

  reaches(
    "[EXT-9i] a constructor's query and fragment survive Request.path and the base URL",
    Help.inConstructorUnderPath,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de#closing`,
    inGerman,
  );

  reaches(
    "[EXT-9j] a joined path and a query both go before a base URL's fragment",
    Help.inBaseUrlWithPath,
    `${HELP}?lang=de`,
    "closing",
    `${HELP}?lang=de#closing`,
    inGerman,
  );

  reaches(
    "[EXT-9k] the constructor's fragment wins over path output's",
    Help.constructorOverPathOutput,
    HELP,
    "closing",
    `${HELP}#closing`,
    { _tag: "Help", sections: [closing] },
  );

  reaches(
    "[EXT-9k] path output's fragment wins over the base URL's",
    Help.pathOutputOverBaseUrl,
    HELP,
    "closing",
    `${HELP}#closing`,
    { _tag: "Help", sections: [closing] },
  );

  reaches(
    "[EXT-9k] a base URL's fragment still applies when an absolute URL bypassed that base",
    Help.inBypassedBaseUrl,
    HELP,
    "closing",
    `${HELP}#closing`,
    { _tag: "Help", sections: [closing] },
  );

  reaches(
    "[EXT-9l] a ? in a fragment stays in it and the query gets its own, so help.cgi looks up that whole section name",
    Help.questionMarkInFragment,
    `${HELP}?lang=de`,
    "closing?x=1",
    `${HELP}?lang=de#closing?x=1`,
    {
      _tag: "GatewayError",
      code: "E_SECTION",
      message: "no section closing?x=1",
    },
  );

  // `node:http` answers a raw space in a target with 400 before any script runs.
  reaches(
    "[EXT-9m] a fragment reaches the client and the socket as written, with what URL would encode",
    Help.unencodedFragment,
    HELP,
    'a b"c',
    `${HELP}#a b"c`,
    {
      _tag: "GatewayError",
      code: "E_SECTION",
      message: 'no section a b"c',
    },
    lane.backend("gateway", undefined, { listener: "socket" }),
  );

  reaches(
    "[EXT-9n] an empty fragment reaches the client and the socket, and help.cgi reads it as none",
    Help.emptyFragment,
    HELP,
    "",
    `${HELP}#`,
    { _tag: "Help", sections: [opening, closing] },
  );

  reaches(
    "[EXT-9o] removeHash in Request.mapEffect takes the constructor's fragment off before the raw client receives the request",
    Help.fragmentRemoved,
    HELP,
    undefined,
    HELP,
    { _tag: "Help", sections: [opening, closing] },
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
