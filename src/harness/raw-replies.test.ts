/**
 * What each raw reply does to the platform's own `fetch`, in each lane, without the library. These
 * pin what the harness can put in front of a client, so a scenario that gets another result knows
 * the difference is not the harness. The results are `fetch`'s, measured with the versions the
 * suite pins, and a lane's differences are the point: do not carry one over to the other.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { lane } from "#lane";

/** How far a response got. */
type Outcome =
  | { readonly stage: "text"; readonly status: number; readonly text: string }
  | { readonly stage: "body failed"; readonly status: number }
  | { readonly stage: "fetch failed" };

const read = (url: string, init?: RequestInit) =>
  Effect.promise(async (): Promise<Outcome> => {
    const signal = AbortSignal.timeout(2000);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch {
      return { stage: "fetch failed" };
    }
    try {
      return {
        stage: "text",
        status: response.status,
        text: await response.text(),
      };
    } catch {
      return { stage: "body failed", status: response.status };
    }
  });

const text = (value: string): Outcome => ({
  stage: "text",
  status: 200,
  text: value,
});
const bodyFailed: Outcome = { stage: "body failed", status: 200 };
const fetchFailed: Outcome = { stage: "fetch failed" };

/** Each shape's result in both lanes, or in each. */
const expected: ReadonlyArray<
  readonly [name: string, node: Outcome, browser?: Outcome]
> = [
  ["whole", text("hello world")],
  ["raw-whole", text("hello world")],
  ["chunked", text("hello world")],
  ["truncated-length", bodyFailed],
  ["truncated-reset", bodyFailed],
  // Nothing declares a length, so the end of the connection is the end of the body.
  ["close-delimited", text("hello")],
  ["truncated-chunked", bodyFailed],
  ["bad-chunk-terminator", bodyFailed],
  ["gzip", text("hello world")],
  ["gzip-magic", bodyFailed],
  ["gzip-block", bodyFailed],
  // Chromium does not check the CRC; undici does.
  ["gzip-checksum", bodyFailed, text("hello world")],
  // Neither checks that the stream ended, so what arrived is the whole answer.
  ["gzip-trailer", text("hello world")],
  ["no-reply", fetchFailed],
  ["no-reply-reset", fetchFailed],
  // Chromium takes a head cut off by the end of the connection as a complete, empty reply.
  ["cut-head", fetchFailed, text("")],
  ["nul-in-value", fetchFailed],
  ["split-utf8", text("ä")],
];

/** Read the ledger until `condition` holds of it, for what a server learns from its socket. */
const until = <A>(
  ledger: Effect.Effect<A>,
  condition: (entries: A) => boolean,
) =>
  ledger.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: condition,
      times: 80,
    }),
  );

describe(`raw replies through fetch (${lane.name})`, () => {
  for (const [name, node, browser = node] of expected)
    it.live(
      `${name}: ${JSON.stringify(lane.name === "node" ? node : browser)}`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("raw-replies");
          const outcome = yield* read(`${backend.origin}/${name}`);
          expect(outcome).toEqual(lane.name === "node" ? node : browser);
          expect((yield* backend.ledger).length).toBeGreaterThan(0);
        }),
    );

  it.live(
    "gzip-truncated: both platforms answer with what they could decompress, and no failure",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("raw-replies");
        const outcome = yield* read(`${backend.origin}/gzip-truncated`);
        if (outcome.stage !== "text") throw new Error(outcome.stage);
        expect(outcome.status).toBe(200);
        expect("hello world".startsWith(outcome.text)).toBe(true);
        expect(outcome.text).not.toBe("hello world");
      }),
  );

  it.live(
    "trickled: a client that gives up reads the head, and the backend sees it go",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("raw-replies");
        const outcome = yield* Effect.promise(async (): Promise<number> => {
          const controller = new AbortController();
          const response = await fetch(`${backend.origin}/trickled`, {
            signal: controller.signal,
          });
          const reader = response.body!.getReader();
          await reader.read();
          controller.abort();
          return response.status;
        });
        expect(outcome).toBe(200);
        const ledger = yield* until(backend.ledger, (entries) =>
          entries.every(({ aborted }) => aborted),
        );
        expect(ledger.map(({ aborted }) => aborted)).toEqual([true]);
        expect(ledger.map(({ connectionOpen }) => connectionOpen)).toEqual([
          false,
        ]);
      }),
  );

  const post = { method: "POST", body: "commit" };

  /** A POST with no preflight, on a connection a first request has left open. */
  const reusing = (origin: string) =>
    read(`${origin}/whole`).pipe(
      Effect.andThen(read(`${origin}/no-reply`, post)),
    );

  it.live(
    `no-reply on a POST over a reused connection: ${lane.name === "browser" ? "Chromium sends it again by itself, on a new connection" : "Node's fetch sends it once"}`,
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("raw-replies");
        expect(yield* reusing(backend.origin)).toEqual(fetchFailed);
        const posts = (yield* backend.ledger).filter(
          ({ method }) => method === "POST",
        );
        expect(posts.length).toBe(lane.name === "browser" ? 2 : 1);
        expect(new Set(posts.map(({ connection }) => connection)).size).toBe(
          posts.length,
        );
      }),
  );

  it.live(
    "no-reply on a POST behind the socket listener: no connection is reused, so it arrives once",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("raw-replies", undefined, {
          listener: "socket",
        });
        expect(yield* reusing(backend.origin)).toEqual(fetchFailed);
        expect(
          (yield* backend.ledger).filter(({ method }) => method === "POST"),
        ).toHaveLength(1);
      }),
  );
});
