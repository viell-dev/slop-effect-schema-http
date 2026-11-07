/**
 * EXT-15: the table of #102 through the raw client, which puts the URL it received on the request
 * line as it stands. These run in the Node lane only, because only Node has that client. The same
 * rows through `fetch`, in both lanes, are in `written-queries.test.ts`; the letters match.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { type Declared, written } from "../clients/echoed.js";
import { watching } from "../clients/received.js";

/** An entry whose URL at the client and request line are both `sent`. */
const sends = (title: string, declaration: Declared, sent: string) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const echo = yield* lane.backend("echo", undefined, {
        listener: "socket",
      });
      const watched = watching();
      const answer = yield* declaration(echo.origin, watched.last).pipe(
        Effect.provide(lane.rawClient!(echo.origin)),
      );
      expect(answer).toBe("Not Found");
      expect(watched.received).toEqual([
        { method: "GET", url: `${echo.origin}${sent}`, hash: undefined },
      ]);
      const [entry, ...rest] = yield* echo.ledger;
      expect(rest).toEqual([]);
      expect(entry!.head?.split("\r\n")[0]).toBe(`GET ${sent} HTTP/1.1`);
    }),
  );

describe("a query written in the constructor through the raw client (node)", () => {
  sends(
    "[EXT-15a] the raw client sends /x?a=1;b=2 as /x?a=1;b=2",
    written.a,
    "/x?a=1;b=2",
  );
  sends(
    "[EXT-15b] the raw client sends /x?a=1&&b=2 as /x?a=1&&b=2",
    written.b,
    "/x?a=1&&b=2",
  );
  sends("[EXT-15c] the raw client sends /x? as /x?", written.c, "/x?");
  sends(
    "[EXT-15d] the raw client sends /x?q=a+b as /x?q=a+b",
    written.d,
    "/x?q=a+b",
  );
  sends(
    "[EXT-15e] the raw client sends /x?a=%41&wsdl as /x?a=%41&wsdl",
    written.e,
    "/x?a=%41&wsdl",
  );
  sends(
    '[EXT-15f] the raw client sends /x?a=%41&b=1;2 with setQuery("a", "new value") as /x?a=new%20value&b=1;2',
    written.f,
    "/x?a=new%20value&b=1;2",
  );
  sends(
    '[EXT-15g] the raw client sends /x? with setQuery("b", "1") as /x?b=1',
    written.g,
    "/x?b=1",
  );
  sends(
    '[EXT-15h] the raw client sends /x?a=1& with setQuery("b", "1") as /x?a=1&&b=1',
    written.h,
    "/x?a=1&&b=1",
  );
  sends(
    '[EXT-15i] the raw client sends /x?a+b=1&c=%32 with setQuery("a b", "2") as /x?a%20b=2&c=%32',
    written.i,
    "/x?a%20b=2&c=%32",
  );

  // `node:http` takes a parsed `URL`, whose `search` has no place for a `?` with nothing after it.
  it.live(
    "[EXT-15c] the line-preserving provider receives /x? as written, and sends /x",
    () =>
      Effect.gen(function* () {
        const echo = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const watched = watching();
        yield* written
          .c(echo.origin, watched.last)
          .pipe(Effect.provide(lane.linesClient!));
        expect(watched.received[0]!.url).toBe(`${echo.origin}/x?`);
        const [entry] = yield* echo.ledger;
        expect(entry!.target).toBe("/x");
      }),
  );
});
