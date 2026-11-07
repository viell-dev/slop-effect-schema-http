/**
 * EXT-16: the table of #102 through `fetch`, in both lanes; the letters match EXT-15. A browser can
 * send all of these, so each row has the URL at the client and the target on the wire in each lane.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { type Declared, written } from "../clients/echoed.js";
import { watching } from "../clients/received.js";

/** An entry whose URL at the client and target on the wire are both `sent`. */
const sends = (title: string, declaration: Declared, sent: string) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const echo = yield* lane.backend("echo", undefined, {
        listener: "socket",
      });
      const watched = watching();
      const answer = yield* declaration(echo.origin, watched.last).pipe(
        Effect.provide(lane.fetchClient),
      );
      expect(answer).toBe("Not Found");
      expect(watched.received).toEqual([
        { method: "GET", url: `${echo.origin}${sent}`, hash: undefined },
      ]);
      const [entry, ...rest] = yield* echo.ledger;
      expect(rest).toEqual([]);
      expect(entry!.target).toBe(sent);
    }),
  );

describe(`a query written in the constructor through fetch (${lane.name})`, () => {
  sends(
    "[EXT-16a] fetch sends /x?a=1;b=2 as /x?a=1;b=2",
    written.a,
    "/x?a=1;b=2",
  );
  sends(
    "[EXT-16b] fetch sends /x?a=1&&b=2 as /x?a=1&&b=2",
    written.b,
    "/x?a=1&&b=2",
  );
  sends("[EXT-16c] fetch sends /x? as /x?", written.c, "/x?");
  sends("[EXT-16d] fetch sends /x?q=a+b as /x?q=a+b", written.d, "/x?q=a+b");
  sends(
    "[EXT-16e] fetch sends /x?a=%41&wsdl as /x?a=%41&wsdl",
    written.e,
    "/x?a=%41&wsdl",
  );
  sends(
    '[EXT-16f] fetch sends /x?a=%41&b=1;2 with setQuery("a", "new value") as /x?a=new%20value&b=1;2',
    written.f,
    "/x?a=new%20value&b=1;2",
  );
  sends(
    '[EXT-16g] fetch sends /x? with setQuery("b", "1") as /x?b=1',
    written.g,
    "/x?b=1",
  );
  sends(
    '[EXT-16h] fetch sends /x?a=1& with setQuery("b", "1") as /x?a=1&&b=1',
    written.h,
    "/x?a=1&&b=1",
  );
  sends(
    '[EXT-16i] fetch sends /x?a+b=1&c=%32 with setQuery("a b", "2") as /x?a%20b=2&c=%32',
    written.i,
    "/x?a%20b=2&c=%32",
  );
});
