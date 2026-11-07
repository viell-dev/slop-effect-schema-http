/**
 * EXT-12 and EXT-14: what a request's own headers do to the automatic ones, and how a name is
 * spelled, through the raw client. These run in the Node lane only, because only Node has the raw
 * client, and every other client changes what these entries are about: `fetch` adds and lowers, and
 * the line-preserving provider writes its own `Content-Length`. The same declarations through
 * `fetch`, in both lanes, are in `header-declarations.test.ts`.
 *
 * `echo`'s socket listener records `head`, the request as it arrived, which is the proof here.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { lane } from "#lane";
import { automatic, type Declared, spelling } from "../clients/echoed.js";
import { watching } from "../clients/received.js";
import { bodyText, type RawOptions } from "../harness/lane.js";

const POST = "POST /shape HTTP/1.1";
const GET = "GET /shape HTTP/1.1";

/** Send one declaration through the raw client to a fresh `echo`, which must see only that one. */
const sent = (declaration: Declared, options?: RawOptions) =>
  Effect.gen(function* () {
    const echo = yield* lane.backend("echo", undefined, { listener: "socket" });
    const watched = watching();
    const answer = yield* declaration(echo.origin, watched.last).pipe(
      Effect.provide(lane.rawClient!(echo.origin, options)),
    );
    expect(answer).toBe("Not Found");
    const [entry, ...rest] = yield* echo.ledger;
    expect(rest).toEqual([]);
    return {
      entry: entry!,
      details: watched.details[0]!,
      host: new URL(echo.origin).host,
    };
  });

/** An entry whose `head` is `requestLine`, then `host`, then exactly `lines`. */
const heads = (
  title: string,
  declaration: Declared,
  requestLine: string,
  lines: ReadonlyArray<string>,
  body = "",
  options?: RawOptions,
) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const { entry, host } = yield* sent(declaration, options);
      expect(entry.head).toBe(
        [requestLine, `host: ${host}`, ...lines].join("\r\n"),
      );
      expect(bodyText(entry)).toBe(body);
    }),
  );

describe("a request's own headers through the raw client (node)", () => {
  heads(
    "[EXT-12a] a request that declares nothing gets the automatic Accept, Content-Type and Content-Length",
    automatic.a,
    POST,
    ["content-type: text/plain", "content-length: 5", "accept: text/plain"],
    "hello",
  );

  heads(
    '[EXT-12b] removeHeader("accept") stops the automatic Accept',
    automatic.b,
    GET,
    [],
  );

  heads(
    "[EXT-12b] a computed value that returns undefined declares nothing, so the removal stays in force",
    automatic.bComputed,
    GET,
    [],
  );

  heads(
    "[EXT-12c] a declared Accept wins over the automatic one",
    automatic.c,
    GET,
    ["accept: text/weird"],
  );

  heads(
    "[EXT-12d] an empty declared Accept goes out empty, and the automatic one stays away",
    automatic.d,
    GET,
    ["accept: "],
  );

  heads(
    "[EXT-12e] a header schema that writes Accept wins over the automatic one",
    automatic.e,
    GET,
    ["accept: text/schema"],
  );

  heads(
    "[EXT-12f] an optional schema field left out declares nothing, so the automatic values stay",
    automatic.f,
    POST,
    ["content-type: text/plain", "content-length: 5", "accept: text/plain"],
    "hello",
  );

  heads(
    "[EXT-12g] a Content-Type declared before the body wins, with its spelling",
    automatic.gBefore,
    POST,
    [
      "Content-Type: application/weird",
      "content-length: 5",
      "accept: text/plain",
    ],
    "hello",
  );

  heads(
    "[EXT-12g] a Content-Type declared after the body wins, with its spelling",
    automatic.gAfter,
    POST,
    [
      "Content-Type: application/weird",
      "content-length: 5",
      "accept: text/plain",
    ],
    "hello",
  );

  heads(
    "[EXT-12g] two Content-Type lines declared with appendHeader both go out, as written",
    automatic.gLines,
    POST,
    [
      "content-type: application/one",
      "Content-Type: application/two",
      "content-length: 5",
      "accept: text/plain",
    ],
    "hello",
  );

  heads(
    "[EXT-12h] a header schema bound before the body wins over the codec's Content-Type",
    automatic.hBefore,
    POST,
    [
      "Content-Type: application/weird",
      "content-length: 5",
      "accept: text/plain",
    ],
    "hello",
  );

  heads(
    "[EXT-12h] a header schema bound after the body wins over the codec's Content-Type",
    automatic.hAfter,
    POST,
    [
      "Content-Type: application/weird",
      "content-length: 5",
      "accept: text/plain",
    ],
    "hello",
  );

  heads(
    '[EXT-12i] removeHeader("content-type") stops the codec\'s Content-Type',
    automatic.i,
    POST,
    ["content-length: 5", "accept: text/plain"],
    "hello",
  );

  heads(
    "[EXT-12j] a removal limited to one value stops nothing",
    automatic.j,
    POST,
    ["content-type: text/plain", "content-length: 5", "accept: text/plain"],
    "hello",
  );

  heads(
    "[EXT-12k] a declared Content-Type stays on a request with Body.empty",
    automatic.k,
    POST,
    ["content-type: application/weird", "accept: text/plain"],
  );

  it.live(
    "[EXT-12l] a declared Content-Type replaces the boundary a multipart body would have had",
    () =>
      Effect.gen(function* () {
        const plain = yield* sent(automatic.lDefault);
        expect(plain.entry.head).toMatch(
          /\r\ncontent-type: multipart\/form-data; boundary=[^\r]+\r\n/,
        );
        const declared = yield* sent(automatic.lDeclared);
        expect(declared.entry.head).toContain(
          "\r\ncontent-type: multipart/form-data\r\n",
        );
        // The body still has its boundary, which nothing on the request names any more.
        expect(bodyText(declared.entry)).toMatch(/^--/);
        expect(bodyText(declared.entry)).toContain('name="field"');
      }),
  );

  heads(
    "[EXT-12m] Request.mapEffect after the body has the last word",
    automatic.m,
    POST,
    [
      "content-type: application/mapped",
      "content-length: 5",
      "accept: text/plain",
    ],
    "hello",
  );

  heads(
    "[EXT-12n] Request.mapEffect before the body sees its edit replaced",
    automatic.nReplaced,
    POST,
    ["content-type: text/plain", "content-length: 5", "accept: text/plain"],
    "hello",
  );

  heads(
    "[EXT-12n] Request.mapEffect before the body keeps its edit when the request removed that name",
    automatic.nKept,
    POST,
    [
      "content-type: application/mapped",
      "content-length: 5",
      "accept: text/plain",
    ],
    "hello",
  );

  heads(
    "[EXT-12o] a later declaration still goes out after a removal",
    automatic.o,
    GET,
    ["accept: text/late"],
  );

  it.live(
    "[EXT-12p] removing a name a schema always writes, after that schema, is refused before anything is sent",
    () =>
      Effect.gen(function* () {
        const echo = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const exit = yield* automatic
          .pRequired(echo.origin, (client) => client)
          .pipe(Effect.provide(lane.rawClient!(echo.origin)), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* echo.ledger).toEqual([]);
      }),
  );

  heads(
    "[EXT-12p] a removal before a schema never discards what the schema writes",
    automatic.pBefore,
    GET,
    ["accept: text/schema"],
  );

  heads(
    "[EXT-12p] a removal after an optional schema field stays in force when the caller leaves it out",
    automatic.pOmitted,
    GET,
    [],
  );

  heads(
    "[EXT-12p] a removal after an optional schema field gives way to a caller's value",
    automatic.pPassed,
    GET,
    ["accept: text/schema"],
  );

  // A server reads what the line says, so it stops short of the body: the socket listener frames a
  // body by `Content-Length` alone, and these are its bytes.
  heads(
    "[EXT-12q] a declared Content-Length below the body's goes out, with the whole body, and the server reads that many bytes",
    automatic.q,
    POST,
    ["Content-Length: 3", "content-type: text/plain", "accept: text/plain"],
    "hel",
  );

  it.live(
    "[EXT-12r] a declared Content-Length above the body's goes out, and the server waits for bytes that never come",
    () =>
      Effect.gen(function* () {
        const echo = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const waiting = yield* automatic
          .r(echo.origin, (client) => client)
          .pipe(Effect.provide(lane.rawClient!(echo.origin)), Effect.forkChild);
        yield* echo.arrived(1);
        const [entry] = yield* echo.ledger;
        expect(entry!.head).toContain("\r\nContent-Length: 10\r\n");
        expect(entry!.aborted).toBe(false);
        // Nothing answers: the fiber is still waiting when it is stopped.
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(waiting);
      }),
  );

  heads(
    "[EXT-12s] an empty declared Content-Length goes out empty, and the server reads no body",
    automatic.s,
    POST,
    ["content-length: ", "content-type: text/plain", "accept: text/plain"],
  );

  heads(
    '[EXT-12t] removeHeader("content-length") leaves the provider to frame the body, and this one can decline',
    automatic.t,
    POST,
    ["content-type: text/plain", "accept: text/plain"],
    "",
    { framing: false },
  );

  heads(
    "[EXT-12t] the raw client frames a body whose Content-Length the request removed",
    automatic.t,
    POST,
    ["content-type: text/plain", "accept: text/plain", "content-length: 5"],
    "hello",
  );
});

describe("the spelling of a header name through the raw client (node)", () => {
  heads("[EXT-14a] setHeader keeps the name as written", spelling.a, GET, [
    "X-API-Key: v",
    "accept: text/plain",
  ]);

  heads("[EXT-14b] appendHeader keeps each line as written", spelling.b, GET, [
    "X-Multi: a",
    "x-multi: b",
    "accept: text/plain",
  ]);

  heads(
    "[EXT-14c] a replacing setHeader matches across spellings, keeps the first position and takes the new spelling",
    spelling.c,
    GET,
    ["X-Thing: 3", "X-Other: 2", "accept: text/plain"],
  );

  heads("[EXT-14d] removeHeader matches across spellings", spelling.d, GET, [
    "accept: text/plain",
  ]);

  heads(
    "[EXT-14e] a header schema writes the spelling it was given",
    spelling.e,
    GET,
    ["X-API-Key: v", "accept: text/plain"],
  );

  heads(
    "[EXT-14f] a raw default under a schema's name takes the schema's spelling",
    spelling.f,
    GET,
    ["X-Api-Key: v", "accept: text/plain"],
  );

  it.live(
    "[EXT-14g] middleware sees the lowercase view, and a value it changes replaces that field's lines alone",
    () =>
      Effect.gen(function* () {
        const { entry, details, host } = yield* sent(spelling.g);
        expect(details.headers).toEqual({
          "x-thing": "3",
          "x-other": "2",
          accept: "text/plain",
        });
        expect(entry.head).toBe(
          [
            GET,
            `host: ${host}`,
            "X-Other: 2",
            "x-thing: 3",
            "accept: text/plain",
          ].join("\r\n"),
        );
      }),
  );
});
