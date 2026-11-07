/**
 * EXT-23: answers that fail after their headers arrive, or that never arrive, through every provider
 * of the lane. The same failure on the wire can be a different failure at the library, so each test
 * runs twice: with `Policy.none` for the failure itself, and with a new region and one retry for
 * what `Policy.transient` makes of it, which the ledger shows as a second arrival. Each ends with
 * the failed connection closed and a further call on the same client.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schedule } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Bookings from "../clients/bookings/index.js";
import type { Backend, Json } from "../harness/lane.js";

const inBrowser = lane.name === "browser";
const retrying = Policy.make(Schedule.recurs(1));

/**
 * Long enough for a request to reach the backend and a head to come back on a slow runner, because
 * a request aborted before it arrived shows nothing in a ledger. The answers these tests time out
 * never finish, so the limit decides nothing else.
 */
const limit = "1 second";

/** A rule that damages the manifest's next answer, or every one with `times` left out. */
const manifestFault = (fault: string, times: number | undefined = 1) => ({
  edge: [
    {
      route: "GET /v1/manifest",
      fault,
      ...(times === undefined ? {} : { times }),
    },
  ],
});

const everyManifest = (fault: string) => ({
  edge: [{ route: "GET /v1/manifest", fault }],
});

const missingFault = (fault: string, times?: number) => ({
  edge: [
    {
      route: "GET /v1/bookings/missing",
      fault,
      ...(times === undefined ? {} : { times }),
    },
  ],
});

const region = (options: Json = {}) => lane.backend("bookings", options);

const transport: Bookings.Described = { kind: "TransportError" };

/** What a failed body is at the library, once a head reached it. */
const failedBody = (status: number): Bookings.Described => ({
  kind: "DecodeError",
  status,
  inner: "DecodeError",
});

/**
 * What a client does with the connection afterwards. A gzip fault's framing is whole, so even a
 * stream that cannot be read leaves a connection that the next call can use.
 */
type Afterwards = "closed" | "reused";

interface Verdict {
  readonly failure: Bookings.Described;
  /** The platform's messages, outermost first. */
  readonly causes: ReadonlyArray<string>;
  /** Whether `Policy.transient` retries it. */
  readonly retried: boolean;
  readonly connection?: Afterwards;
}

/** Fetch hands a response over at its head, and `lines` reads the body before it hands one over. */
const brokenBody = (
  provider: string,
  fetchCause: string,
  linesCause: string,
): Verdict =>
  provider === "lines"
    ? { failure: transport, causes: [linesCause], retried: true }
    : {
        failure: failedBody(200),
        causes: inBrowser ? ["Failed to fetch"] : ["terminated", fetchCause],
        retried: false,
      };

/** The first arrival's connection ends as `connection` says, and a further call is whole. */
const recovers = (
  backend: Backend,
  call: Effect.Effect<string, unknown, HttpClient.HttpClient>,
  connection: Afterwards = "closed",
) =>
  Effect.gen(function* () {
    const before =
      connection === "closed"
        ? yield* Bookings.closed(backend, 0)
        : yield* backend.ledger;
    expect(before[0]?.connectionOpen).toBe(connection === "reused");
    expect(yield* call).toBe(Bookings.manifestText);
    const after = yield* backend.ledger;
    expect(after).toHaveLength(before.length + 1);
    const [first, last] = [before[0]?.connection, after.at(-1)?.connection];
    if (connection === "closed") expect(last).not.toBe(first);
    else expect(last).toBe(first);
  });

/** A further call on a connection the failure has closed is whole, with its own arrival. */
const recoversAfter = (
  backend: Backend,
  call: Effect.Effect<string, unknown, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const before = yield* backend.ledger;
    expect(yield* call).toBe(Bookings.manifestText);
    expect(yield* backend.ledger).toHaveLength(before.length + 1);
  });

/** Both parts: the failure under `Policy.none`, and its classification under one retry. */
const failsAndRecovers = (options: Json, verdict: Verdict) =>
  Effect.gen(function* () {
    const first = yield* region(options);
    const once = Bookings.manifest({ baseUrl: first.origin });
    const error = yield* Effect.flip(once.execute(undefined));
    expect(Bookings.described(error)).toEqual(verdict.failure);
    expect(Bookings.causes(error)).toEqual(verdict.causes);
    expect(yield* first.ledger).toHaveLength(1);
    yield* recovers(first, once.execute(undefined), verdict.connection);

    const second = yield* region(options);
    const retried = Bookings.manifest({
      baseUrl: second.origin,
      policy: retrying,
    });
    if (verdict.retried) {
      expect(yield* retried.execute(undefined)).toBe(Bookings.manifestText);
      const ledger = yield* Bookings.closed(second, 0);
      expect(ledger).toHaveLength(2);
      expect(ledger[1]?.connection).not.toBe(ledger[0]?.connection);
    } else {
      const again = yield* Effect.flip(retried.execute(undefined));
      expect(Bookings.described(again)).toEqual(verdict.failure);
      expect(yield* second.ledger).toHaveLength(1);
      yield* recovers(second, retried.execute(undefined), verdict.connection);
    }
  });

/**
 * `cut-body-reset` waits 50 ms and then resets, and a reset can overtake bytes a client has not read
 * yet, so on a loaded machine a client can meet the reset first. It has then seen no answer at all,
 * and what follows is EXT-23f's and not EXT-23a's: Chromium sends the request again and gets the
 * manifest, and Node's `fetch` fails at dispatch, which is retried. The test accepts those two
 * orders and no others, and the ledger has to agree with the one it saw.
 */
const resetBody = (provider: string) =>
  Effect.gen(function* () {
    const bytesFirst = brokenBody(
      provider,
      "read ECONNRESET",
      "read ECONNRESET",
    );
    for (const policy of [Policy.none, retrying]) {
      const backend = yield* region(manifestFault("cut-body-reset"));
      const manifest = Bookings.manifest({ baseUrl: backend.origin, policy });
      const exit = yield* Effect.exit(manifest.execute(undefined));
      const ledger = yield* Bookings.closed(backend, 0);
      if (Exit.isSuccess(exit)) {
        expect(inBrowser || policy === retrying).toBe(true);
        expect(exit.value).toBe(Bookings.manifestText);
        expect(ledger).toHaveLength(2);
        expect(ledger[1]?.connection).not.toBe(ledger[0]?.connection);
      } else {
        const error = exit.cause.reasons.find(
          (reason) => reason._tag === "Fail",
        )?.error;
        const overtaken =
          !inBrowser &&
          provider !== "lines" &&
          Bookings.described(error).kind === "TransportError";
        expect(Bookings.described(error)).toEqual(
          overtaken ? transport : bytesFirst.failure,
        );
        expect(Bookings.causes(error)).toEqual(
          overtaken ? ["fetch failed", "read ECONNRESET"] : bytesFirst.causes,
        );
        expect(ledger).toHaveLength(1);
        expect(policy === Policy.none || !bytesFirst.retried).toBe(true);
      }
      yield* recoversAfter(backend, manifest.execute(undefined));
    }
  });

/** A read of the manifest that succeeds, with one arrival, whatever the policy. */
const answers = (
  options: Json,
  check: (text: string) => void,
  connection: Afterwards,
) =>
  Effect.gen(function* () {
    for (const policy of [Policy.none, retrying]) {
      const backend = yield* region(options);
      const manifest = Bookings.manifest({ baseUrl: backend.origin, policy });
      check(yield* manifest.execute(undefined));
      expect(yield* backend.ledger).toHaveLength(1);
      yield* recovers(backend, manifest.execute(undefined), connection);
    }
  });

/** What every gzip fault gives `lines`: the stream itself, read as text, with no failure. */
const streamAsText = (first: string) => (text: string) => {
  expect(text.startsWith(first)).toBe(true);
  expect(text).not.toContain("line 001");
};

const gzipStart = "\u001f�\b";

const bytesOf = (origin: string) =>
  Operation.make(
    Request.get(`${origin}/v1/manifest`),
    Response.status(200, Body.bytes),
  ).execute(undefined);

const gunzip = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() =>
    new globalThis.Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  );

const missingBody = (origin: string, policy: Policy.Policy) =>
  Operation.make(
    Request.get(`${origin}/v1/bookings/missing`),
    Response.status(200, Body.text),
    { policy },
  );

/** The manifest under a contract that also declares the 503. */
const declaring = (origin: string, policy: Policy.Policy) =>
  Operation.make(
    Request.get(`${origin}/v1/manifest`),
    Response.status(200, Body.text).pipe(
      Response.orElse(Response.status(503, Body.text)),
    ),
    { policy },
  );

describe(`failures after response headers arrive (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    const inFetch = provider !== "lines";

    it.live(
      `[EXT-23a] ${provider}: cut-body stops at 450 of 900 bytes and ${inFetch ? "is a DecodeError at the body, not retried" : "is a TransportError before any response, retried"}`,
      () =>
        failsAndRecovers(
          manifestFault("cut-body"),
          brokenBody(provider, "other side closed", "aborted"),
        ).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-23b] ${provider}: a reset after half the body fails as cut-body does, unless it overtakes the bytes`,
      () => resetBody(provider).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-23c] ${provider}: a chunk with no last chunk fails as cut-body does`,
      () =>
        failsAndRecovers(
          manifestFault("cut-chunked"),
          brokenBody(provider, "other side closed", "aborted"),
        ).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-23d] ${provider}: a chunk followed by XX fails as cut-body does, with the parser's refusal in Node`,
      () =>
        failsAndRecovers(
          manifestFault("bad-chunk"),
          brokenBody(
            provider,
            "Response does not match the HTTP/1.1 protocol (Expected LF after chunk data)",
            "Parse Error: Expected LF after chunk data",
          ),
        ).pipe(Effect.provide(client)),
    );

    if (inBrowser)
      it.live(
        `[EXT-23e] ${provider}: Chromium takes a cut head under harness CORS for a complete one, an empty body with no failure`,
        () =>
          answers(
            manifestFault("cut-head"),
            (text) => expect(text).toBe(""),
            "closed",
          ).pipe(Effect.provide(client)),
      );
    else
      it.live(
        `[EXT-23e] ${provider}: a cut head is a TransportError with no metadata, retried`,
        () =>
          failsAndRecovers(manifestFault("cut-head"), {
            failure: transport,
            causes:
              provider === "lines"
                ? ["socket hang up"]
                : ["fetch failed", "other side closed"],
            retried: true,
          }).pipe(Effect.provide(client)),
      );

    for (const [fault, cause] of [
      ["closed", "other side closed"],
      ["reset", "read ECONNRESET"],
    ] as const) {
      if (inBrowser) {
        it.live(
          `[EXT-23f] ${provider}: ${fault} on one GET is hidden, because Chromium sends it again on a new connection and the library sees a success`,
          () =>
            Effect.gen(function* () {
              const backend = yield* region(manifestFault(fault));
              expect(
                yield* Bookings.manifest({
                  baseUrl: backend.origin,
                }).execute(undefined),
              ).toBe(Bookings.manifestText);
              const ledger = yield* backend.ledger;
              expect(ledger).toHaveLength(2);
              expect(ledger[1]?.connection).not.toBe(ledger[0]?.connection);
            }).pipe(Effect.provide(client)),
        );
        it.live(
          `[EXT-23f] ${provider}: it takes ${fault} twice for a page to see a TransportError, and one retry then gets the manifest`,
          () =>
            Effect.gen(function* () {
              const first = yield* region(manifestFault(fault, 2));
              const once = Bookings.manifest({ baseUrl: first.origin });
              const error = yield* Effect.flip(once.execute(undefined));
              expect(Bookings.described(error)).toEqual(transport);
              expect(Bookings.causes(error)).toEqual(["Failed to fetch"]);
              expect(yield* first.ledger).toHaveLength(2);
              yield* recovers(first, once.execute(undefined));

              const second = yield* region(manifestFault(fault, 2));
              expect(
                yield* Bookings.manifest({
                  baseUrl: second.origin,
                  policy: retrying,
                }).execute(undefined),
              ).toBe(Bookings.manifestText);
              expect(yield* second.ledger).toHaveLength(3);
            }).pipe(Effect.provide(client)),
        );
      } else
        it.live(
          `[EXT-23f] ${provider}: ${fault} is a TransportError with no metadata, retried`,
          () =>
            failsAndRecovers(manifestFault(fault), {
              failure: transport,
              causes:
                provider === "lines"
                  ? [fault === "closed" ? "socket hang up" : "read ECONNRESET"]
                  : ["fetch failed", cause],
              retried: true,
            }).pipe(Effect.provide(client)),
        );
    }

    it.live(
      `[EXT-23g] ${provider}: an answer with no framing that stops half-way is a success holding 450 bytes`,
      () =>
        answers(
          manifestFault("cut-unframed"),
          (text) => expect(text).toBe(Bookings.manifestText.slice(0, 450)),
          "closed",
        ).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-23g] ${provider}: only the consumer's own check of the lines finds it, as a DecodeError, not retried`,
      () =>
        Effect.gen(function* () {
          const backend = yield* region(manifestFault("cut-unframed"));
          const checked = Bookings.checkedManifest({
            baseUrl: backend.origin,
            policy: retrying,
          });
          const error = yield* Effect.flip(checked.execute(undefined));
          expect(Bookings.described(error)).toEqual({
            kind: "DecodeError",
            status: 200,
            inner: "SchemaError",
          });
          expect(yield* backend.ledger).toHaveLength(1);
          yield* Bookings.closed(backend, 0);
          expect(yield* checked.execute(undefined)).toBe(Bookings.manifestText);
        }).pipe(Effect.provide(client)),
    );

    if (inFetch)
      it.live(
        `[EXT-23h] ${provider}: a valid gzip stream gives the manifest`,
        () =>
          answers(
            manifestFault("gzip"),
            (text) => expect(text).toBe(Bookings.manifestText),
            "reused",
          ).pipe(Effect.provide(client)),
      );
    else {
      it.live(
        `[EXT-23h] ${provider}: asks for nothing and decompresses nothing, so Body.text is the stream read as text`,
        () =>
          answers(
            manifestFault("gzip"),
            streamAsText(gzipStart),
            "reused",
          ).pipe(Effect.provide(client)),
      );
      it.live(
        `[EXT-23h] ${provider}: Body.bytes is the stream itself, which the consumer can decompress`,
        () =>
          Effect.gen(function* () {
            const backend = yield* region(manifestFault("gzip"));
            const bytes = yield* bytesOf(backend.origin);
            expect(bytes.slice(0, 2)).toEqual(Uint8Array.of(0x1f, 0x8b));
            expect(yield* gunzip(new Uint8Array(bytes))).toBe(
              Bookings.manifestText,
            );
          }).pipe(Effect.provide(client)),
      );
    }

    for (const [fault, cause, start] of [
      ["gzip-magic", "incorrect header check", "\u0000�\b"],
      ["gzip-block", "invalid block type", gzipStart],
    ] as const)
      if (inFetch)
        it.live(
          `[EXT-23i] ${provider}: ${fault} is a DecodeError, not retried, with Node's cause naming it`,
          () =>
            failsAndRecovers(manifestFault(fault), {
              ...brokenBody(provider, cause, ""),
              connection: "reused",
            }).pipe(Effect.provide(client)),
        );
      else
        it.live(
          `[EXT-23i] ${provider}: ${fault} is a success holding the stream`,
          () =>
            answers(manifestFault(fault), streamAsText(start), "reused").pipe(
              Effect.provide(client),
            ),
        );

    if (provider === "lines")
      it.live(
        `[EXT-23j] ${provider}: gzip-checksum is a success holding the stream`,
        () =>
          answers(
            manifestFault("gzip-checksum"),
            streamAsText(gzipStart),
            "reused",
          ).pipe(Effect.provide(client)),
      );
    else if (inBrowser)
      it.live(
        `[EXT-23j] ${provider}: Chromium never checks the CRC, so gzip-checksum gives the manifest with no failure`,
        () =>
          answers(
            manifestFault("gzip-checksum"),
            (text) => expect(text).toBe(Bookings.manifestText),
            "reused",
          ).pipe(Effect.provide(client)),
      );
    else
      it.live(
        `[EXT-23j] ${provider}: gzip-checksum is a DecodeError in Node, with the cause incorrect data check`,
        () =>
          failsAndRecovers(manifestFault("gzip-checksum"), {
            ...brokenBody(provider, "incorrect data check", ""),
            connection: "reused",
          }).pipe(Effect.provide(client)),
      );

    if (inFetch) {
      it.live(
        `[EXT-23k] ${provider}: gzip-trailer gives the manifest with no failure, because nothing checks that a stream ended`,
        () =>
          answers(
            manifestFault("gzip-trailer"),
            (text) => expect(text).toBe(Bookings.manifestText),
            "reused",
          ).pipe(Effect.provide(client)),
      );
      it.live(
        `[EXT-23k] ${provider}: gzip-truncated gives a proper prefix of the manifest as a success`,
        () =>
          answers(
            manifestFault("gzip-truncated"),
            (text) => {
              expect(text.length).toBeGreaterThan(0);
              expect(text.length).toBeLessThan(Bookings.manifestText.length);
              expect(Bookings.manifestText.startsWith(text)).toBe(true);
            },
            "reused",
          ).pipe(Effect.provide(client)),
      );
    } else
      for (const fault of ["gzip-trailer", "gzip-truncated"])
        it.live(
          `[EXT-23k] ${provider}: ${fault} is a success holding the stream`,
          () =>
            answers(
              manifestFault(fault),
              streamAsText(gzipStart),
              "reused",
            ).pipe(Effect.provide(client)),
        );

    for (const [id, fault, seen] of [
      ["[EXT-23l]", "trickle", inFetch ? 200 : undefined],
      ["[EXT-23m]", "hang", undefined],
    ] as const) {
      it.live(
        `${id} ${provider}: ${fault} under an attempt timeout is a TimeoutError on two connections, and a classifier sees ${seen === undefined ? "no metadata" : `status ${seen}`}`,
        () =>
          Effect.gen(function* () {
            const backend = yield* region(everyManifest(fault));
            const reasons: Array<number | undefined> = [];
            const error = yield* Effect.flip(
              Bookings.manifest({
                baseUrl: backend.origin,
                policy: Policy.make(Schedule.recurs(1), {
                  attemptTimeout: limit,
                  while: (reason) => {
                    reasons.push(reason.metadata?.status);
                    return Policy.transient(reason);
                  },
                }),
              }).execute(undefined),
            );
            expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
            expect(reasons).toEqual([seen, seen]);
            yield* Bookings.aborted(backend, 0);
            const ledger = yield* Bookings.aborted(backend, 1);
            expect(ledger).toHaveLength(2);
            expect(ledger[1]?.connection).not.toBe(ledger[0]?.connection);
            // Every manifest answer fails under this rule, so the further call reads another path.
            const health = yield* Bookings.health({
              baseUrl: backend.origin,
            }).execute(undefined);
            expect(health.service).toBe("berth");
          }).pipe(Effect.provide(client)),
      );

      it.live(
        `${id} ${provider}: a caller's Effect.timeout around ${fault} is not retried`,
        () =>
          Effect.gen(function* () {
            const backend = yield* region(everyManifest(fault));
            const error = yield* Effect.flip(
              Bookings.manifest({
                baseUrl: backend.origin,
                policy: retrying,
              })
                .execute(undefined)
                .pipe(Effect.timeout(limit)),
            );
            expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
            const ledger = yield* Bookings.aborted(backend, 0);
            expect(ledger).toHaveLength(1);
          }).pipe(Effect.provide(client)),
      );
    }

    if (inFetch)
      it.live(
        `[EXT-23l] ${provider}: an attempt's request is already aborted when its outcome is classified`,
        () =>
          Effect.gen(function* () {
            const backend = yield* region(everyManifest("trickle"));
            const signals: Array<AbortSignal | null | undefined> = [];
            const seen: Array<boolean | undefined> = [];
            const error = yield* Effect.flip(
              Bookings.manifest({
                baseUrl: backend.origin,
                policy: Policy.make(Schedule.recurs(0), {
                  attemptTimeout: limit,
                  while: (reason) => {
                    seen.push(signals.at(-1)?.aborted);
                    return Policy.transient(reason);
                  },
                }),
              })
                .execute(undefined)
                .pipe(
                  Effect.provideService(
                    FetchHttpClient.Fetch,
                    (input, init) => {
                      signals.push(init?.signal);
                      return fetch(input, init);
                    },
                  ),
                ),
            );
            expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
            expect(seen).toEqual([true]);
          }).pipe(Effect.provide(client)),
      );

    it.live(
      `[EXT-23n] ${provider}: a cut body on a status the contract does not declare ${inFetch ? "fails the drain, a DecodeError with status 404" : "is a TransportError, because the body was read before anything was selected"}`,
      () =>
        Effect.gen(function* () {
          const backend = yield* region(missingFault("cut-body", 1));
          const once = missingBody(backend.origin, Policy.none);
          const error = yield* Effect.flip(once.execute(undefined));
          expect(Bookings.described(error)).toEqual(
            inFetch ? failedBody(404) : transport,
          );
          yield* Bookings.closed(backend, 0);
          const later = yield* Effect.flip(once.execute(undefined));
          expect(Bookings.described(later)).toEqual({
            kind: "UnexpectedResponse",
            status: 404,
          });

          const second = yield* region(missingFault("cut-body", 1));
          const retried = yield* Effect.flip(
            missingBody(second.origin, retrying).execute(undefined),
          );
          expect(Bookings.described(retried)).toEqual(
            inFetch
              ? failedBody(404)
              : { kind: "UnexpectedResponse", status: 404 },
          );
          expect(yield* second.ledger).toHaveLength(inFetch ? 1 : 2);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-23o] ${provider}: a 503 cut half-way ${inFetch ? "is a DecodeError that Policy.transient retries by the status in its metadata" : "is a TransportError, retried"}, and the retry gets the manifest`,
      () =>
        Effect.gen(function* () {
          const first = yield* region(manifestFault("cut-unavailable"));
          const once = declaring(first.origin, Policy.none);
          const error = yield* Effect.flip(once.execute(undefined));
          expect(Bookings.described(error)).toEqual(
            inFetch ? failedBody(503) : transport,
          );
          yield* recovers(first, once.execute(undefined));

          const second = yield* region(manifestFault("cut-unavailable"));
          const retried = declaring(
            second.origin,
            Policy.make(Schedule.recurs(1), { retryAfter: false }),
          );
          expect(yield* retried.execute(undefined)).toBe(Bookings.manifestText);
          const ledger = yield* Bookings.closed(second, 0);
          expect(ledger).toHaveLength(2);
          expect(ledger[1]?.connection).not.toBe(ledger[0]?.connection);
        }).pipe(Effect.provide(client)),
    );

    it.live(
      `[EXT-23p] ${provider}: a body that never ends on an undeclared status holds the attempt until its timeout`,
      () =>
        Effect.gen(function* () {
          const backend = yield* region(missingFault("trickle"));
          const error = yield* Effect.flip(
            missingBody(
              backend.origin,
              Policy.make(Schedule.recurs(0), { attemptTimeout: limit }),
            ).execute(undefined),
          );
          expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
          yield* Bookings.aborted(backend, 0);
        }).pipe(Effect.provide(client)),
    );

    it.live(`[EXT-23p] ${provider}: so does a caller's limit`, () =>
      Effect.gen(function* () {
        const backend = yield* region(missingFault("trickle"));
        const error = yield* Effect.flip(
          missingBody(backend.origin, Policy.none)
            .execute(undefined)
            .pipe(Effect.timeout(limit)),
        );
        expect(Bookings.described(error)).toEqual({ kind: "TimeoutError" });
        const ledger = yield* Bookings.aborted(backend, 0);
        expect(ledger).toHaveLength(1);
        expect(
          yield* Bookings.manifest({ baseUrl: backend.origin }).execute(
            undefined,
          ),
        ).toBe(Bookings.manifestText);
      }).pipe(Effect.provide(client)),
    );
  }
});
