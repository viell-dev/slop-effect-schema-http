/**
 * EXT-13 and EXT-14h: the declarations of `header-declarations.node.test.ts` through `fetch`, in both
 * lanes; the letters match EXT-12. A platform refuses or adds some of these, so each test states what
 * the client received as well as what arrived: the two differ only by what the platform did.
 *
 * Effect's Fetch provider takes a declared `Content-Length` off before `fetch` sees it, so what `fetch`
 * itself does with one needs a client that hands it over: `bareFetch` below.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { lane } from "#lane";
import { automatic, type Declared, spelling } from "../clients/echoed.js";
import { watching } from "../clients/received.js";
import { bodyText, header, type Recorded } from "../harness/lane.js";

/** `fetch` with a request's headers and bytes exactly as given, which Effect's provider does not do. */
const bareFetch: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, url, signal) =>
    Effect.tryPromise({
      try: () =>
        globalThis.fetch(url, {
          method: request.method,
          headers: { ...request.headers },
          body:
            request.body._tag === "Uint8Array"
              ? (request.body.body as BodyInit)
              : null,
          signal,
        }),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
);

/** Send one declaration to a fresh `echo`, and return all that came of it. */
const attempt = (
  declaration: Declared,
  client: Layer.Layer<HttpClient.HttpClient> = lane.fetchClient,
) =>
  Effect.gen(function* () {
    const echo = yield* lane.backend("echo", undefined, { listener: "socket" });
    const watched = watching();
    const exit = yield* declaration(echo.origin, watched.last).pipe(
      Effect.provide(client),
      Effect.exit,
    );
    return { exit, ledger: yield* echo.ledger, details: watched.details[0] };
  });

/** A declaration with the caller's own limit on it, for a request nothing else would end. */
const limited =
  (declaration: Declared): Declared =>
  (origin, last) =>
    Effect.timeout(declaration(origin, last), Duration.millis(500));

/** A declaration `fetch` delivers: `echo` saw exactly one, and answered it. */
const delivered = (
  declaration: Declared,
  client?: Layer.Layer<HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const { exit, ledger, details } = yield* attempt(declaration, client);
    expect(yield* exit).toBe("Not Found");
    expect(ledger).toHaveLength(1);
    return { entry: ledger[0]!, details: details! };
  });

/** The three headers in question, from any way of reading a header. */
const automaticOf = (read: (name: string) => string | undefined) => ({
  accept: read("accept"),
  "content-type": read("content-type"),
  "content-length": read("content-length"),
});

const wire = (entry: Recorded) =>
  automaticOf((name) => header(entry.lines, name));

type Automatic = ReturnType<typeof automaticOf>;

/**
 * An entry that compares what the client received with what arrived. Comparing all three headers
 * each time means a header gained or lost beside the one in the title also fails.
 */
const arrives = (
  title: string,
  declaration: Declared,
  received: Partial<Automatic>,
  arrived: Partial<Automatic>,
  body = "",
) =>
  it.live(title, () =>
    Effect.gen(function* () {
      const { entry, details } = yield* delivered(declaration);
      expect(automaticOf((name) => details.headers[name])).toEqual({
        accept: undefined,
        "content-type": undefined,
        "content-length": undefined,
        ...received,
      });
      expect(wire(entry)).toEqual({
        accept: undefined,
        "content-type": undefined,
        "content-length": undefined,
        ...arrived,
      });
      expect(bodyText(entry)).toBe(body);
    }),
  );

const plainBody = {
  accept: "text/plain",
  "content-type": "text/plain",
  "content-length": "5",
};
const weirdBody = { ...plainBody, "content-type": "application/weird" };

describe(`a request's own headers through fetch (${lane.name})`, () => {
  arrives(
    "[EXT-13a] a request that declares nothing gets the automatic Accept, Content-Type and Content-Length",
    automatic.a,
    plainBody,
    plainBody,
    "hello",
  );

  arrives(
    '[EXT-13b] removeHeader("accept") reaches the client with no Accept, and the platform adds its own',
    automatic.b,
    {},
    { accept: "*/*" },
  );

  arrives(
    "[EXT-13b] a computed value that returns undefined leaves the removal in force, and the platform adds its own",
    automatic.bComputed,
    {},
    { accept: "*/*" },
  );

  arrives(
    "[EXT-13c] a declared Accept wins over the automatic one",
    automatic.c,
    { accept: "text/weird" },
    { accept: "text/weird" },
  );

  arrives(
    "[EXT-13d] an empty declared Accept goes out empty, and the automatic one stays away",
    automatic.d,
    { accept: "" },
    { accept: "" },
  );

  arrives(
    "[EXT-13e] a header schema that writes Accept wins over the automatic one",
    automatic.e,
    { accept: "text/schema" },
    { accept: "text/schema" },
  );

  arrives(
    "[EXT-13f] an optional schema field left out declares nothing, so the automatic values stay",
    automatic.f,
    plainBody,
    plainBody,
    "hello",
  );

  arrives(
    "[EXT-13g] a Content-Type declared before the body wins",
    automatic.gBefore,
    weirdBody,
    weirdBody,
    "hello",
  );

  arrives(
    "[EXT-13g] a Content-Type declared after the body wins",
    automatic.gAfter,
    weirdBody,
    weirdBody,
    "hello",
  );

  arrives(
    "[EXT-13g] two Content-Type lines declared with appendHeader reach fetch joined, and go out as one",
    automatic.gLines,
    {
      ...plainBody,
      "content-type": "application/one, application/two",
    },
    {
      ...plainBody,
      "content-type": "application/one, application/two",
    },
    "hello",
  );

  arrives(
    "[EXT-13h] a header schema bound before the body wins over the codec's Content-Type",
    automatic.hBefore,
    weirdBody,
    weirdBody,
    "hello",
  );

  arrives(
    "[EXT-13h] a header schema bound after the body wins over the codec's Content-Type",
    automatic.hAfter,
    weirdBody,
    weirdBody,
    "hello",
  );

  arrives(
    '[EXT-13i] removeHeader("content-type") stops the codec\'s Content-Type, and a body of bytes gets none from fetch',
    automatic.i,
    { accept: "text/plain", "content-length": "5" },
    { accept: "text/plain", "content-length": "5" },
    "hello",
  );

  arrives(
    "[EXT-13j] a removal limited to one value stops nothing",
    automatic.j,
    plainBody,
    plainBody,
    "hello",
  );

  arrives(
    "[EXT-13k] a declared Content-Type stays on a request with Body.empty, and the platform frames the empty body",
    automatic.k,
    { accept: "text/plain", "content-type": "application/weird" },
    {
      accept: "text/plain",
      "content-type": "application/weird",
      "content-length": "0",
    },
  );

  it.live(
    "[EXT-13l] a declared Content-Type replaces the boundary fetch would have supplied",
    () =>
      Effect.gen(function* () {
        const plain = yield* delivered(automatic.lDefault);
        expect(plain.details.headers["content-type"]).toBeUndefined();
        expect(header(plain.entry.lines, "content-type")).toMatch(
          /^multipart\/form-data; boundary=/,
        );
        const declared = yield* delivered(automatic.lDeclared);
        expect(declared.details.headers["content-type"]).toBe(
          "multipart/form-data",
        );
        expect(header(declared.entry.lines, "content-type")).toBe(
          "multipart/form-data",
        );
        // The body still has its boundary, which nothing on the request names any more.
        expect(bodyText(declared.entry)).toMatch(/^--/);
        expect(bodyText(declared.entry)).toContain('name="field"');
      }),
  );

  arrives(
    "[EXT-13m] Request.mapEffect after the body has the last word",
    automatic.m,
    { ...plainBody, "content-type": "application/mapped" },
    { ...plainBody, "content-type": "application/mapped" },
    "hello",
  );

  arrives(
    "[EXT-13n] Request.mapEffect before the body sees its edit replaced",
    automatic.nReplaced,
    plainBody,
    plainBody,
    "hello",
  );

  arrives(
    "[EXT-13n] Request.mapEffect before the body keeps its edit when the request removed that name",
    automatic.nKept,
    { ...plainBody, "content-type": "application/mapped" },
    { ...plainBody, "content-type": "application/mapped" },
    "hello",
  );

  arrives(
    "[EXT-13o] a later declaration still goes out after a removal",
    automatic.o,
    { accept: "text/late" },
    { accept: "text/late" },
  );

  it.live(
    "[EXT-13p] removing a name a schema always writes, after that schema, is refused before the client receives anything",
    () =>
      Effect.gen(function* () {
        const { exit, ledger, details } = yield* attempt(automatic.pRequired);
        expect(details).toBeUndefined();
        expect(ledger).toEqual([]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = exit.cause.reasons[0];
        expect(error?._tag).toBe("Fail");
        if (error?._tag !== "Fail") return;
        expect((error.error as { _tag: string })._tag).toBe("InvalidRequest");
      }),
  );

  arrives(
    "[EXT-13p] a removal before a schema never discards what the schema writes",
    automatic.pBefore,
    { accept: "text/schema" },
    { accept: "text/schema" },
  );

  arrives(
    "[EXT-13p] a removal after an optional schema field stays in force when the caller leaves it out, and the platform adds its own",
    automatic.pOmitted,
    {},
    { accept: "*/*" },
  );

  arrives(
    "[EXT-13p] a removal after an optional schema field gives way to a caller's value",
    automatic.pPassed,
    { accept: "text/schema" },
    { accept: "text/schema" },
  );

  arrives(
    "[EXT-13q] Effect's Fetch provider takes off a Content-Length below the body's, and the platform writes the true one",
    automatic.q,
    { ...plainBody, "content-length": "3" },
    plainBody,
    "hello",
  );

  it.live(
    "[EXT-13q] fetch on its own stalls in Node on a Content-Length below the body's, and Chromium writes the true one",
    () =>
      Effect.gen(function* () {
        const { exit, ledger, details } = yield* attempt(
          limited(automatic.q),
          bareFetch,
        );
        expect(details?.headers["content-length"]).toBe("3");
        if (lane.name === "node") {
          // Nothing reaches the socket, and nothing fails until the caller's own limit.
          expect(ledger).toEqual([]);
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const error = exit.cause.reasons[0];
          expect(error?._tag).toBe("Fail");
          if (error?._tag !== "Fail") return;
          expect((error.error as { _tag: string })._tag).toBe("TimeoutError");
        } else {
          expect(yield* exit).toBe("Not Found");
          expect(header(ledger[0]!.lines, "content-length")).toBe("5");
        }
      }),
  );

  arrives(
    "[EXT-13r] Effect's Fetch provider takes off a Content-Length above the body's, and the platform writes the true one",
    automatic.r,
    { ...plainBody, "content-length": "10" },
    plainBody,
    "hello",
  );

  it.live(
    "[EXT-13r] fetch on its own refuses a Content-Length above the body's in Node, and Chromium writes the true one",
    () =>
      Effect.gen(function* () {
        const { exit, ledger, details } = yield* attempt(
          automatic.r,
          bareFetch,
        );
        expect(details?.headers["content-length"]).toBe("10");
        if (lane.name === "node") {
          expect(ledger).toEqual([]);
          expect(transportCode(exit)).toBe(
            "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
          );
        } else {
          expect(yield* exit).toBe("Not Found");
          expect(header(ledger[0]!.lines, "content-length")).toBe("5");
        }
      }),
  );

  // Effect's provider takes the header off only when it has a value, so `fetch` sees this one.
  it.live(
    "[EXT-13s] an empty Content-Length reaches fetch, which Node refuses and Chromium replaces with the true one",
    () =>
      Effect.gen(function* () {
        const { exit, ledger, details } = yield* attempt(automatic.s);
        expect(details?.headers["content-length"]).toBe("");
        if (lane.name === "node") {
          expect(ledger).toEqual([]);
          expect(transportCode(exit)).toBe("UND_ERR_INVALID_ARG");
        } else {
          expect(yield* exit).toBe("Not Found");
          expect(header(ledger[0]!.lines, "content-length")).toBe("5");
          expect(bodyText(ledger[0]!)).toBe("hello");
        }
      }),
  );

  arrives(
    '[EXT-13t] removeHeader("content-length") reaches the client with none, and the platform writes the true one',
    automatic.t,
    { accept: "text/plain", "content-type": "text/plain" },
    plainBody,
    "hello",
  );
});

describe(`the spelling of a header name through fetch (${lane.name})`, () => {
  it.live(
    "[EXT-14h] fetch sends a lowercase name, whatever the client's lines say",
    () =>
      Effect.gen(function* () {
        const { entry, details } = yield* delivered(spelling.a);
        expect(details.lines).toContainEqual(["X-API-Key", "v"]);
        expect(details.headers["x-api-key"]).toBe("v");
        expect(entry.lines).toContainEqual(["x-api-key", "v"]);
      }),
  );
});

/** The code of the Node error behind a failed `fetch`, which Node keeps as the `TypeError`'s cause. */
function transportCode(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) return undefined;
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") return undefined;
  const failure = reason.error as HttpClientError.HttpClientError;
  const cause =
    failure.reason._tag === "TransportError" ? failure.reason.cause : undefined;
  return (cause as { readonly cause?: { readonly code?: unknown } }).cause
    ?.code;
}
