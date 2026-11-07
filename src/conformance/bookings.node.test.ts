/**
 * EXT-29: the `bookings` backend against its service page (`services/bookings.md`), byte for byte.
 * Every expected answer here is written out from the page, and the gzip streams are damaged here,
 * so nothing is shared with the backend. The only mask is `date`, the `Date` line `node:http` adds
 * to a complete answer, which changes with every run.
 *
 * Node-only: a client would frame, decompress or refuse most of these, so the test reads a plain
 * socket, which also shows how each connection ended.
 */
import { connect } from "node:net";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schedule } from "effect";
import { lane } from "#lane";
import type { Json, StartOptions } from "../harness/lane.js";

interface Seen {
  /** Every byte, one character each, with the `date` mask applied. */
  readonly bytes: string;
  readonly ending: "closed" | "reset";
}

interface Ask {
  readonly lines?: ReadonlyArray<string>;
  readonly body?: string;
}

const ending = "\r\n\r\n";

const requestText = (
  origin: string,
  method: string,
  target: string,
  { lines = [], body = "" }: Ask = {},
) =>
  [
    `${method} ${target} HTTP/1.1`,
    `Host: ${new URL(origin).host}`,
    ...(body === "" ? [] : [`Content-Length: ${body.length}`]),
    ...lines,
    "",
    "",
  ].join("\r\n") + body;

/** The `Date` of a complete answer: the time it was written, as an IMF-fixdate. */
const date =
  /\r\nDate: (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\r\n/g;

const masked = (bytes: string) => bytes.replace(date, "\r\nDate: <date>\r\n");

/** Send `text` on a new connection and read until the connection ends. */
const exchange = (origin: string, text: string) =>
  Effect.promise(
    () =>
      new Promise<Seen>((resolve) => {
        const { hostname, port } = new URL(origin);
        const socket = connect(Number(port), hostname);
        const chunks: Array<Buffer> = [];
        let end: Seen["ending"] = "closed";
        socket.on("data", (data: Buffer) => chunks.push(data));
        socket.on("error", () => {
          end = "reset";
        });
        socket.on("close", () =>
          resolve({
            bytes: masked(Buffer.concat(chunks).toString("latin1")),
            ending: end,
          }),
        );
        socket.write(text, "latin1");
      }),
  ).pipe(Effect.timeout("3 seconds"));

/** One request on a connection the server closes after its answer. */
const ask = (origin: string, method: string, target: string, options?: Ask) =>
  exchange(
    origin,
    requestText(origin, method, target, {
      ...options,
      lines: [...(options?.lines ?? []), "Connection: close"],
    }),
  );

/** A client that stays connected, for answers that do not end. */
const staying = (origin: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const { hostname, port } = new URL(origin);
      const socket = connect(Number(port), hostname);
      const chunks: Array<Buffer> = [];
      const reads: Array<{ readonly at: number; readonly bytes: string }> = [];
      const state = { closed: false, closedAt: 0 };
      socket.on("data", (data: Buffer) => {
        chunks.push(data);
        reads.push({ at: performance.now(), bytes: data.toString("latin1") });
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        state.closed = true;
        state.closedAt = performance.now();
      });
      return {
        socket,
        reads,
        state,
        write: (text: string) => socket.write(text, "latin1"),
        received: () => masked(Buffer.concat(chunks).toString("latin1")),
      };
    }),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );

/** Re-check `condition` every 5 ms until it holds, failing after three seconds. */
const eventually = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 millis"),
      until: (held) => held,
      times: 600,
    }),
    Effect.flatMap((held) =>
      held ? Effect.void : Effect.die(new Error("condition never held")),
    ),
  );

const start = (options: Json = {}, startOptions?: StartOptions) =>
  lane.backend("bookings", options, startOptions);

/** The arrival at `index` shows the client went, once the server has seen its close. */
const clientWent = (
  backend: Effect.Success<ReturnType<typeof start>>,
  index: number,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const entry = (yield* backend.ledger)[index];
      if (entry?.aborted === true && !entry.connectionOpen) return;
      yield* Effect.sleep("10 millis");
    }
    expect.fail(`arrival ${index} never showed the client going`);
  });

/** A complete answer read with `Connection: close`, with what the server adds after its lines. */
const whole = (statusLine: string, lines: ReadonlyArray<string>, body = "") =>
  [
    statusLine,
    ...lines,
    `Content-Length: ${body.length}`,
    "Date: <date>",
    "Connection: close",
    "",
    "",
  ].join("\r\n") + body;

const OK = "HTTP/1.1 200 OK";
const JSON_TYPE = "Content-Type: application/json";
const PLAIN_TYPE = "Content-Type: text/plain";
const MANIFEST_TYPE = "Content-Type: text/plain; charset=utf-8";

const statusOf = (seen: Seen) => Number(seen.bytes.slice(9, 12));

const bodyOf = (seen: Seen) =>
  seen.bytes.slice(seen.bytes.indexOf(ending) + ending.length);

// The page's manifest and booking.

const manifest = Array.from(
  { length: 100 },
  (_, index) => `line ${String(index + 1).padStart(3, "0")}\n`,
).join("");

const firstHalf = manifest.slice(0, 450);
const secondHalf = manifest.slice(450);

const draft = {
  vessel: "MV Aurora",
  terminal: "rotterdam",
  slot: "2026-11-07T06:00",
};

const draftBody = JSON.stringify(draft);

const otherBody = JSON.stringify({ ...draft, slot: "2026-11-07T07:00" });

const booking = (
  id: string,
  region: string,
  key: string | null = null,
  replayed = false,
) => JSON.stringify({ id, region, ...draft, key, replayed });

const post = (
  origin: string,
  body = draftBody,
  lines?: ReadonlyArray<string>,
) =>
  ask(origin, "POST", "/v1/bookings", {
    body,
    lines: [JSON_TYPE, ...(lines ?? [])],
  });

const listing = (region: string, ...bookings: ReadonlyArray<string>) =>
  `{"region":"${region}","bookings":[${bookings.join(",")}]}`;

const list = (origin: string) => ask(origin, "GET", "/v1/bookings");

const expectList = (origin: string, expected: string) =>
  Effect.gen(function* () {
    expect(bodyOf(yield* list(origin))).toBe(expected);
  });

const boardBody = (terminal: string) =>
  `{"terminal":"${terminal}","open":["06:00","07:00","08:00","09:00"]}`;
const boardTarget = (terminal: string) =>
  `/v1/availability?terminal=${terminal}`;
const releaseTarget = (terminal: string) =>
  `/v1/availability/release?terminal=${terminal}`;
const heldHead = (body: string, lines: ReadonlyArray<string> = []) =>
  [
    OK,
    JSON_TYPE,
    ...lines,
    `Content-Length: ${body.length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
const halfOf = (body: string) => body.slice(0, Math.floor(body.length / 2));

const manifestRule = (fault: string) => ({
  edge: [{ route: "GET /v1/manifest", fault, times: 1 }],
});

const chunkOf = (text: string, end = "\r\n") =>
  `${text.length.toString(16)}\r\n${text}${end}`;

const manifestStream = () => gzipSync(manifest);

const lenient = (bytes: Buffer) =>
  gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).toString();

const healthStatus = (origin: string) =>
  ask(origin, "GET", "/v1/health").pipe(Effect.map(statusOf));

const startFails = (rule: Json) =>
  Effect.gen(function* () {
    const started = yield* Effect.exit(Effect.scoped(start({ edge: [rule] })));
    expect(Exit.isFailure(started)).toBe(true);
  });

const statuses = (origin: string, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => healthStatus(origin));

describe("[EXT-29] the bookings backend against its page", () => {
  describe("routes", () => {
    it.live("[EXT-29] health names the service and the region", () =>
      Effect.gen(function* () {
        const eu = yield* start();
        const us = yield* start({ region: "us" });
        expect(yield* ask(eu.origin, "GET", "/v1/health")).toEqual({
          bytes: whole(
            OK,
            [JSON_TYPE],
            '{"service":"berth","region":"eu","status":"ok"}',
          ),
          ending: "closed",
        });
        expect(bodyOf(yield* ask(us.origin, "GET", "/v1/health"))).toBe(
          '{"service":"berth","region":"us","status":"ok"}',
        );
      }),
    );

    it.live("[EXT-29] the manifest is 100 lines of nine bytes", () =>
      Effect.gen(function* () {
        const eu = yield* start();
        expect(manifest.length).toBe(900);
        expect((yield* ask(eu.origin, "GET", "/v1/manifest")).bytes).toBe(
          whole(OK, [MANIFEST_TYPE], manifest),
        );
      }),
    );

    it.live(
      "[EXT-29] a commit answers 201 with a relative Location, numbers by commit order and lists",
      () =>
        Effect.gen(function* () {
          const eu = yield* start();
          expect((yield* list(eu.origin)).bytes).toBe(
            whole(OK, [JSON_TYPE], listing("eu")),
          );
          expect((yield* post(eu.origin)).bytes).toBe(
            whole(
              "HTTP/1.1 201 Created",
              [JSON_TYPE, "Location: /v1/bookings/eu-000001"],
              booking("eu-000001", "eu"),
            ),
          );
          // Operators overbook on purpose.
          expect(bodyOf(yield* post(eu.origin))).toBe(
            booking("eu-000002", "eu"),
          );
          yield* expectList(
            eu.origin,
            listing(
              "eu",
              booking("eu-000001", "eu"),
              booking("eu-000002", "eu"),
            ),
          );
          expect(
            (yield* ask(eu.origin, "GET", "/v1/bookings/eu-000002")).bytes,
          ).toBe(whole(OK, [JSON_TYPE], booking("eu-000002", "eu")));
          expect(
            (yield* ask(eu.origin, "GET", "/v1/bookings/eu-000003")).bytes,
          ).toBe(
            whole(
              "HTTP/1.1 404 Not Found",
              [JSON_TYPE],
              '{"error":"not_found"}',
            ),
          );
        }),
    );

    for (const [about, body] of [
      ["no JSON", "{"],
      ["no object", "[]"],
      ["null", "null"],
      ["a missing field", '{"vessel":"a","terminal":"b"}'],
      ["an empty field", '{"vessel":"","terminal":"b","slot":"c"}'],
      ["a field that is no string", '{"vessel":1,"terminal":"b","slot":"c"}'],
      [
        "bytes that are not UTF-8",
        '{"vessel":"\xff","terminal":"b","slot":"c"}',
      ],
    ] as const)
      it.live(`[EXT-29] ${about} answers 400 and commits nothing`, () =>
        Effect.gen(function* () {
          const eu = yield* start();
          expect((yield* post(eu.origin, body)).bytes).toBe(
            whole(
              "HTTP/1.1 400 Bad Request",
              [JSON_TYPE],
              '{"error":"invalid_booking"}',
            ),
          );
          yield* expectList(eu.origin, listing("eu"));
        }),
      );

    it.live("[EXT-29] any other member of a booking's object is ignored", () =>
      Effect.gen(function* () {
        const eu = yield* start();
        const body = JSON.stringify({ ...draft, id: "x", key: "y", extra: 1 });
        expect(bodyOf(yield* post(eu.origin, body))).toBe(
          booking("eu-000001", "eu"),
        );
      }),
    );

    it.live("[EXT-29] each row of the repeat-key table", () =>
      Effect.gen(function* () {
        const eu = yield* start();
        const key = ["Idempotency-Key: Key-1"];
        expect(bodyOf(yield* post(eu.origin, draftBody, key))).toBe(
          booking("eu-000001", "eu", "Key-1"),
        );
        expect((yield* post(eu.origin, draftBody, key)).bytes).toBe(
          whole(
            OK,
            [JSON_TYPE, "Idempotent-Replay: true"],
            booking("eu-000001", "eu", "Key-1", true),
          ),
        );
        expect((yield* post(eu.origin, otherBody, key)).bytes).toBe(
          whole("HTTP/1.1 409 Conflict", [JSON_TYPE], '{"error":"key_reused"}'),
        );
        expect(statusOf(yield* post(eu.origin, "not a booking", key))).toBe(
          409,
        );
        yield* expectList(
          eu.origin,
          listing("eu", booking("eu-000001", "eu", "Key-1")),
        );
        expect((yield* ask(eu.origin, "GET", "/v1/keys/Key-1")).bytes).toBe(
          whole(OK, [JSON_TYPE], booking("eu-000001", "eu", "Key-1")),
        );
        expect((yield* ask(eu.origin, "GET", "/v1/keys/Key-2")).bytes).toBe(
          whole(
            "HTTP/1.1 404 Not Found",
            [JSON_TYPE],
            '{"error":"unknown_key"}',
          ),
        );
      }),
    );

    for (const [about, key] of [
      ["an underscore", "a_b"],
      ["65 characters", "a".repeat(65)],
      ["no characters", ""],
      ["a letter outside ASCII", "\xe4"],
    ] as const)
      it.live(`[EXT-29] a key with ${about} answers 400`, () =>
        Effect.gen(function* () {
          const eu = yield* start();
          expect(
            (yield* post(eu.origin, draftBody, [`Idempotency-Key: ${key}`]))
              .bytes,
          ).toBe(
            whole(
              "HTTP/1.1 400 Bad Request",
              [JSON_TYPE],
              '{"error":"invalid_key"}',
            ),
          );
          yield* expectList(eu.origin, listing("eu"));
        }),
      );

    it.live("[EXT-29] a key of 64 characters is a key", () =>
      Effect.gen(function* () {
        const eu = yield* start();
        const key = "a-Z-0".repeat(13).slice(0, 64);
        expect(
          statusOf(
            yield* post(eu.origin, draftBody, [`Idempotency-Key: ${key}`]),
          ),
        ).toBe(201);
      }),
    );

    it.live(
      "[EXT-29] anything else answers 404, and another method on a path 405 with Allow",
      () =>
        Effect.gen(function* () {
          const eu = yield* start();
          const notFound = whole(
            "HTTP/1.1 404 Not Found",
            [PLAIN_TYPE],
            "Not Found",
          );
          for (const target of [
            "/v2/health",
            "/v1/keys/",
            "/v1/export/no-such-export",
            "/v1/export/constructor",
            "/v1/availability",
            "/v1/availability?terminal=",
          ])
            expect((yield* ask(eu.origin, "GET", target)).bytes).toBe(notFound);
          expect(
            (yield* ask(eu.origin, "POST", "/v1/availability/release")).bytes,
          ).toBe(notFound);
          const refused = (allow: string) =>
            whole(
              "HTTP/1.1 405 Method Not Allowed",
              [PLAIN_TYPE, `Allow: ${allow}`],
              "Method Not Allowed",
            );
          expect((yield* ask(eu.origin, "DELETE", "/v1/health")).bytes).toBe(
            refused("GET"),
          );
          expect((yield* ask(eu.origin, "DELETE", "/v1/bookings")).bytes).toBe(
            refused("POST, GET"),
          );
          expect(
            (yield* ask(eu.origin, "POST", "/v1/export/no-type")).bytes,
          ).toBe(refused("GET"));
        }),
    );
  });

  describe("the peer link", () => {
    it.live(
      "[EXT-29] a key known to the peer answers the peer's booking, with nothing committed here",
      () =>
        Effect.gen(function* () {
          const eu = yield* start();
          const us = yield* start({ region: "us", peer: eu.origin });
          const key = ["Idempotency-Key: k-1"];
          yield* post(eu.origin, draftBody, key);
          // Bodies are not compared across regions.
          expect((yield* post(us.origin, otherBody, key)).bytes).toBe(
            whole(
              OK,
              [JSON_TYPE, "Idempotent-Replay: true"],
              booking("eu-000001", "eu", "k-1", true),
            ),
          );
          yield* expectList(us.origin, listing("us"));
          const asked = (yield* eu.ledger).find(
            ({ target }) => target === "/v1/keys/k-1",
          );
          expect(asked?.method).toBe("GET");
        }),
    );

    it.live(
      "[EXT-29] the link is used only for a keyed booking about to commit",
      () =>
        Effect.gen(function* () {
          const eu = yield* start();
          const us = yield* start({ region: "us", peer: eu.origin });
          const key = ["Idempotency-Key: k-1"];
          yield* post(us.origin);
          yield* post(us.origin, "not a booking", key);
          yield* post(us.origin, draftBody, ["Idempotency-Key: a_b"]);
          expect(yield* eu.ledger).toEqual([]);
          yield* post(us.origin, draftBody, key);
          yield* post(us.origin, draftBody, key);
          expect((yield* eu.ledger).length).toBe(1);
        }),
    );

    it.live("[EXT-29] a link that cannot connect commits", () =>
      Effect.gen(function* () {
        const closed = yield* Effect.scoped(
          start().pipe(Effect.map(({ origin }) => origin)),
        );
        const us = yield* start({ region: "us", peer: closed });
        expect(
          bodyOf(yield* post(us.origin, draftBody, ["Idempotency-Key: k-1"])),
        ).toBe(booking("us-000001", "us", "k-1"));
      }),
    );

    for (const fault of [
      "closed",
      "reset",
      "cut-head",
      "cut-body",
      "cut-body-reset",
      "cut-chunked",
      "cut-unframed",
      "cut-unavailable",
      "bad-chunk",
      "gzip",
      "bad-gateway",
      "unavailable",
      "parked",
      "other-service",
    ])
      it.live(
        `[EXT-29] a peer that knows the key but answers ${fault} counts as not knowing it`,
        () =>
          Effect.gen(function* () {
            const eu = yield* start({
              edge: [{ route: "GET /v1/keys/k-1", fault }],
            });
            const us = yield* start({ region: "us", peer: eu.origin });
            const key = ["Idempotency-Key: k-1"];
            yield* post(eu.origin, draftBody, key);
            expect(bodyOf(yield* post(us.origin, draftBody, key))).toBe(
              booking("us-000001", "us", "k-1"),
            );
          }),
      );

    it.live("[EXT-29] the link follows no redirect", () =>
      Effect.gen(function* () {
        const eu = yield* start({
          redirects: {
            "/v1/keys/k-1": { status: 307, location: "/v1/keys/k-2" },
          },
        });
        const us = yield* start({ region: "us", peer: eu.origin });
        yield* post(eu.origin, draftBody, ["Idempotency-Key: k-2"]);
        expect(
          bodyOf(yield* post(us.origin, draftBody, ["Idempotency-Key: k-1"])),
        ).toBe(booking("us-000001", "us", "k-1"));
        const targets = (yield* eu.ledger).map(({ target }) => target);
        expect(targets).toEqual(["/v1/bookings", "/v1/keys/k-1"]);
      }),
    );

    for (const fault of ["hang", "trickle"])
      it.live(
        `[EXT-29] a peer that answers ${fault} is given up on after a second`,
        () =>
          Effect.gen(function* () {
            const eu = yield* start({
              edge: [{ route: "GET /v1/keys/k-1", fault }],
            });
            const us = yield* start({ region: "us", peer: eu.origin });
            const sent = performance.now();
            expect(
              bodyOf(
                yield* post(us.origin, draftBody, ["Idempotency-Key: k-1"]),
              ),
            ).toBe(booking("us-000001", "us", "k-1"));
            expect(performance.now() - sent).toBeGreaterThanOrEqual(950);
            yield* clientWent(eu, 0);
          }),
      );

    it.live(
      "[EXT-29] two bookings under one key at once commit once, whatever the link took",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [
              { route: "GET /v1/keys/k-1", fault: "hang", phase: "before" },
            ],
          });
          const us = yield* start({ region: "us", peer: eu.origin });
          const key = ["Idempotency-Key: k-1"];
          const seen = yield* Effect.all(
            [post(us.origin, draftBody, key), post(us.origin, draftBody, key)],
            { concurrency: "unbounded" },
          );
          expect(seen.map(statusOf).toSorted()).toEqual([200, 201]);
          yield* expectList(
            us.origin,
            listing("us", booking("us-000001", "us", "k-1")),
          );
        }),
    );
  });

  describe("moved paths", () => {
    const redirects = {
      "/v1/reserve": { status: 307, location: "/v1/bookings" },
      "/v1/away": { status: 301, location: "http://other.test:8080/v1/health" },
      "/v1/self": { status: 302, location: "/v1/self" },
      "/v1/health": { status: 308, location: "/v2/health" },
    };

    for (const method of ["GET", "POST", "DELETE", "OPTIONS"])
      it.live(
        `[EXT-29] ${method} on a moved path answers the table's status and Location`,
        () =>
          Effect.gen(function* () {
            const eu = yield* start({ redirects });
            expect((yield* ask(eu.origin, method, "/v1/reserve")).bytes).toBe(
              whole("HTTP/1.1 307 Temporary Redirect", [
                "Location: /v1/bookings",
              ]),
            );
          }),
      );

    it.live(
      "[EXT-29] a path is compared without its query, and the table comes before the routes",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({ redirects });
          expect((yield* ask(eu.origin, "GET", "/v1/away?x=1")).bytes).toBe(
            whole("HTTP/1.1 301 Moved Permanently", [
              "Location: http://other.test:8080/v1/health",
            ]),
          );
          expect((yield* ask(eu.origin, "GET", "/v1/self")).bytes).toBe(
            whole("HTTP/1.1 302 Found", ["Location: /v1/self"]),
          );
          expect((yield* ask(eu.origin, "GET", "/v1/health")).bytes).toBe(
            whole("HTTP/1.1 308 Permanent Redirect", ["Location: /v2/health"]),
          );
        }),
    );
  });

  describe("the availability board", () => {
    it.live("[EXT-29] a terminal that is not held answers at once", () =>
      Effect.gen(function* () {
        const eu = yield* start({ held: ["rotterdam"] });
        expect(
          (yield* ask(eu.origin, "GET", boardTarget("hamburg"))).bytes,
        ).toBe(whole(OK, [JSON_TYPE], boardBody("hamburg")));
      }),
    );

    it.live(
      "[EXT-29] a held answer waits at half its body, and release finishes every waiting answer",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({ held: ["rotterdam"] });
          const body = boardBody("rotterdam");
          const first = yield* staying(eu.origin);
          const second = yield* staying(eu.origin);
          const get = requestText(eu.origin, "GET", boardTarget("rotterdam"));
          first.write(get);
          second.write(get);
          for (const client of [first, second])
            yield* eventually(() => client.received().endsWith(halfOf(body)));
          yield* Effect.sleep("40 millis");
          for (const client of [first, second])
            expect(client.received()).toBe(heldHead(body) + halfOf(body));
          // Another terminal's release leaves them waiting.
          expect(
            (yield* ask(eu.origin, "POST", releaseTarget("hamburg"))).bytes,
          ).toBe(
            [
              "HTTP/1.1 204 No Content",
              "Date: <date>",
              "Connection: close",
              "",
              "",
            ].join("\r\n"),
          );
          yield* Effect.sleep("40 millis");
          expect(first.received()).toBe(heldHead(body) + halfOf(body));
          yield* ask(eu.origin, "POST", releaseTarget("rotterdam"));
          for (const client of [first, second]) {
            yield* eventually(() => client.state.closed);
            expect(client.received()).toBe(heldHead(body) + body);
          }
          // The next request is held again.
          const third = yield* staying(eu.origin);
          third.write(get);
          yield* eventually(() => third.received().endsWith(halfOf(body)));
          yield* Effect.sleep("40 millis");
          expect(third.received()).toBe(heldHead(body) + halfOf(body));
          yield* ask(eu.origin, "POST", releaseTarget("rotterdam"));
          yield* eventually(() => third.state.closed);
          expect(third.received()).toBe(heldHead(body) + body);
        }),
    );

    it.live("[EXT-29] a client that goes first ends the wait", () =>
      Effect.gen(function* () {
        const eu = yield* start({ held: ["rotterdam"] });
        const client = yield* staying(eu.origin);
        client.write(requestText(eu.origin, "GET", boardTarget("rotterdam")));
        yield* eu.arrived(1);
        yield* eventually(() => client.received() !== "");
        client.socket.destroy();
        yield* clientWent(eu, 0);
      }),
    );
  });

  describe("the exports", () => {
    const J = '{"ok":true}';
    const CT = JSON_TYPE;
    const length = "Content-Length: 11";
    const row = (statusLine: string, ...lines: ReadonlyArray<string>) =>
      [statusLine, ...lines, "", ""].join("\r\n") + J;

    const table: ReadonlyArray<readonly [string, string]> = [
      ["two-types", row(OK, PLAIN_TYPE, CT, length)],
      ["same-type-twice", row(OK, CT, CT, length)],
      ["no-type", row(OK, length)],
      [
        "odd-charset",
        row(OK, "Content-Type: text/plain; charset=no-such-charset", length),
      ],
      ["latin1-value", row(OK, CT, "X-Vessel: M\xfcller", length)],
      ["utf8-value", row(OK, CT, "X-Vessel: M\xc3\xbcller", length)],
      ["nul-value", row(OK, CT, "X-Vessel: a\0b", length)],
      ["ctl-value", row(OK, CT, "X-Vessel: a\x01b", length)],
      ["folded-value", row(OK, CT, "X-Vessel: a", " b", length)],
      [
        "bare-lf",
        `HTTP/1.1 200 OK\n${CT}\nX-Vessel: a\nContent-Length: 11\n\n${J}`,
      ],
      ["no-colon", row(OK, CT, "garbage", length)],
      ["two-lengths", row(OK, CT, length, "Content-Length: 5")],
      ["same-length-twice", row(OK, CT, length, length)],
      [
        "length-and-chunked",
        [
          OK,
          CT,
          "Content-Length: 3",
          "Transfer-Encoding: chunked",
          "",
          `b\r\n${J}\r\n0\r\n\r\n`,
        ].join("\r\n"),
      ],
      ["no-reason", row("HTTP/1.1 200", CT, length)],
      ["http10", row("HTTP/1.0 200 OK", CT)],
      ["bad-status", row("HTTP/1.1 abc OK", CT, length)],
      ["status-99", row("HTTP/1.1 99 Odd", CT, length)],
      ["no-version", row("200 OK", CT, length)],
      [
        "cut-utf8",
        `HTTP/1.1 200 OK\r\n${MANIFEST_TYPE}\r\nContent-Length: 3\r\n\r\nGr\xc3`,
      ],
    ];

    for (const [name, expected] of table)
      it.live(`[EXT-29] ${name} goes out as it stands, and closes`, () =>
        Effect.gen(function* () {
          const eu = yield* start();
          expect(
            yield* exchange(
              eu.origin,
              requestText(eu.origin, "GET", `/v1/export/${name}`),
            ),
          ).toEqual({ bytes: expected, ending: "closed" });
        }),
      );

    const splits = [
      ["split-utf8", "3\r\nGr\xc3\r\n", "4\r\n\xbc\xc3\x9fe\r\n"],
      ["split-emoji", "7\r\nship \xf0\x9f\r\n", "5\r\n\x9a\xa2 ok\r\n"],
      ["split-bom", "1\r\n\xef\r\n", "4\r\n\xbb\xbfok\r\n"],
    ] as const;

    for (const [name, first, second] of splits)
      it.live(`[EXT-29] ${name} pauses at its split`, () =>
        Effect.gen(function* () {
          const eu = yield* start();
          const client = yield* staying(eu.origin);
          const head = `HTTP/1.1 200 OK\r\n${MANIFEST_TYPE}\r\nTransfer-Encoding: chunked\r\n\r\n`;
          const sent = performance.now();
          client.write(requestText(eu.origin, "GET", `/v1/export/${name}`));
          yield* eventually(() => client.state.closed);
          expect(client.received()).toBe(`${head}${first}${second}0\r\n\r\n`);
          // On Linux a stalled loop can read both pieces at once, so only the pause is asserted.
          const split = client.reads.findIndex(({ bytes }) =>
            bytes.includes(second),
          );
          expect(split).toBeGreaterThanOrEqual(0);
          expect(client.reads[split]!.at - sent).toBeGreaterThanOrEqual(20);
        }),
      );
  });

  describe("the faults", () => {
    const head = (...framing: ReadonlyArray<string>) =>
      [OK, MANIFEST_TYPE, ...framing, "", ""].join("\r\n");

    const ended: ReadonlyArray<
      readonly [fault: string, bytes: string, ending: Seen["ending"]]
    > = [
      ["closed", "", "closed"],
      ["reset", "", "reset"],
      ["cut-head", "HTTP/1.1 200 OK\r\nContent-Ty", "closed"],
      ["cut-body", head("Content-Length: 900") + firstHalf, "closed"],
      ["cut-body-reset", head("Content-Length: 900") + firstHalf, "reset"],
      [
        "cut-chunked",
        head("Transfer-Encoding: chunked") + chunkOf(firstHalf),
        "closed",
      ],
      ["cut-unframed", head("Connection: close") + firstHalf, "closed"],
      [
        "cut-unavailable",
        [
          "HTTP/1.1 503 Service Unavailable",
          PLAIN_TYPE,
          "Retry-After: 60",
          "Content-Length: 16",
          "",
          "Try agai",
        ].join("\r\n"),
        "closed",
      ],
      [
        "bad-chunk",
        head("Transfer-Encoding: chunked") +
          chunkOf(firstHalf, "XX") +
          chunkOf(secondHalf) +
          "0\r\n\r\n",
        "closed",
      ],
    ];

    for (const [fault, bytes, end] of ended)
      it.live(`[EXT-29] ${fault} on the manifest, then the manifest`, () =>
        Effect.gen(function* () {
          const eu = yield* start(manifestRule(fault));
          expect(
            yield* exchange(
              eu.origin,
              requestText(eu.origin, "GET", "/v1/manifest"),
            ),
          ).toEqual({ bytes, ending: end });
          expect(bodyOf(yield* ask(eu.origin, "GET", "/v1/manifest"))).toBe(
            manifest,
          );
        }),
      );

    it.live("[EXT-29] cut-body-reset resets 50 ms after the cut body", () =>
      Effect.gen(function* () {
        const eu = yield* start(manifestRule("cut-body-reset"));
        const client = yield* staying(eu.origin);
        const sent = performance.now();
        client.write(requestText(eu.origin, "GET", "/v1/manifest"));
        yield* eventually(() => client.state.closed);
        expect(client.received().endsWith(firstHalf)).toBe(true);
        expect(client.state.closedAt - sent).toBeGreaterThanOrEqual(45);
      }),
    );

    /** The server's lines on a connection that stays open. */
    const open = [
      "Date: <date>",
      "Connection: keep-alive",
      "Keep-Alive: timeout=5",
    ];
    const complete = (
      statusLine: string,
      lines: ReadonlyArray<string>,
      body: string,
    ) =>
      [
        statusLine,
        ...lines,
        `Content-Length: ${body.length}`,
        ...open,
        "",
        "",
      ].join("\r\n") + body;

    const damaged = (change: (bytes: Buffer) => void) => {
      const bytes = manifestStream();
      change(bytes);
      return bytes;
    };
    const streams: Readonly<Record<string, () => Buffer>> = {
      gzip: manifestStream,
      "gzip-magic": () =>
        damaged((bytes) => {
          bytes[0] = 0;
        }),
      // BFINAL, then BTYPE in the next two bits, after the ten-byte header.
      "gzip-block": () =>
        damaged((bytes) => {
          bytes[10]! |= 0b110;
        }),
      "gzip-checksum": () =>
        damaged((bytes) => {
          bytes[bytes.length - 8]! ^= 0xff;
        }),
      "gzip-truncated": () =>
        manifestStream().subarray(0, Math.floor(manifestStream().length / 2)),
      "gzip-trailer": () =>
        manifestStream().subarray(0, manifestStream().length - 8),
    };
    const pages: ReadonlyArray<readonly [string, string]> = [
      ...Object.entries(streams).map(
        ([name, bytes]) =>
          [
            name,
            complete(
              OK,
              [MANIFEST_TYPE, "Content-Encoding: gzip"],
              bytes().toString("latin1"),
            ),
          ] as const,
      ),
      [
        "bad-gateway",
        complete(
          "HTTP/1.1 502 Bad Gateway",
          ["Content-Type: text/html"],
          "<html><body>502 Bad Gateway</body></html>",
        ),
      ],
      [
        "unavailable",
        complete(
          "HTTP/1.1 503 Service Unavailable",
          [PLAIN_TYPE, "Retry-After: 60"],
          "Try again later.",
        ),
      ],
      [
        "parked",
        complete(
          OK,
          ["Content-Type: text/html"],
          "<html><body>This domain is parked.</body></html>",
        ),
      ],
      [
        "other-service",
        complete(OK, [JSON_TYPE], '{"service":"tides","status":"ok"}'),
      ],
    ];

    for (const [fault, expected] of pages)
      it.live(
        `[EXT-29] ${fault} is a complete answer, and its connection takes another`,
        () =>
          Effect.gen(function* () {
            const eu = yield* start(manifestRule(fault));
            const client = yield* staying(eu.origin);
            const get = requestText(eu.origin, "GET", "/v1/manifest");
            client.write(get);
            yield* eventually(
              () => client.received().length >= expected.length,
            );
            expect(client.received()).toBe(expected);
            client.write(get);
            const next = complete(OK, [MANIFEST_TYPE], manifest);
            yield* eventually(
              () => client.received().length >= expected.length + next.length,
            );
            expect(client.received().slice(expected.length)).toBe(next);
            const ledger = yield* eu.ledger;
            expect(ledger.map(({ connection }) => connection)).toEqual([1, 1]);
          }),
      );

    const body = (fault: string) =>
      Buffer.from(
        bodyOf({
          bytes: pages.find(([name]) => name === fault)![1],
          ending: "closed",
        }),
        "latin1",
      );

    it("[EXT-29] each stream fails a reader where the page says", () => {
      expect(gunzipSync(body("gzip")).toString()).toBe(manifest);
      expect(() => gunzipSync(body("gzip-magic"))).toThrow(
        /incorrect header check/,
      );
      expect(() => gunzipSync(body("gzip-block"))).toThrow(
        /invalid block type/,
      );
      expect(() => gunzipSync(body("gzip-checksum"))).toThrow(
        /incorrect data check/,
      );
      expect(() => gunzipSync(body("gzip-trailer"))).toThrow(
        /unexpected end of file/,
      );
      expect(lenient(body("gzip-trailer"))).toBe(manifest);
      expect(() => gunzipSync(body("gzip-truncated"))).toThrow(
        /unexpected end of file/,
      );
      expect(manifest.startsWith(lenient(body("gzip-truncated")))).toBe(true);
      expect(lenient(body("gzip-truncated"))).not.toBe(manifest);
    });

    it.live(
      "[EXT-29] trickle sends B a byte at a time under a length one too long, and never finishes",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [{ route: "GET /v1/bookings/missing", fault: "trickle" }],
          });
          const error = '{"error":"not_found"}';
          const client = yield* staying(eu.origin);
          const sent = performance.now();
          client.write(requestText(eu.origin, "GET", "/v1/bookings/missing"));
          const expected =
            [
              "HTTP/1.1 404 Not Found",
              JSON_TYPE,
              `Content-Length: ${error.length + 1}`,
              "",
              "",
            ].join("\r\n") + error;
          yield* eventually(() => client.received() === expected);
          // Twenty pauses of 20 ms lie between the first byte and the last.
          expect(client.reads.at(-1)!.at - sent).toBeGreaterThanOrEqual(350);
          yield* Effect.sleep("60 millis");
          expect(client.received()).toBe(expected);
          expect(client.state.closed).toBe(false);
          client.socket.destroy();
          yield* clientWent(eu, 0);
        }),
    );

    it.live("[EXT-29] hang stays open with nothing until the client goes", () =>
      Effect.gen(function* () {
        const eu = yield* start(manifestRule("hang"));
        const client = yield* staying(eu.origin);
        client.write(requestText(eu.origin, "GET", "/v1/manifest"));
        yield* eu.arrived(1);
        yield* Effect.sleep("60 millis");
        expect(client.received()).toBe("");
        expect(client.state.closed).toBe(false);
        expect((yield* eu.ledger)[0]!.connectionOpen).toBe(true);
        client.socket.destroy();
        yield* clientWent(eu, 0);
      }),
    );

    it.live(
      "[EXT-29] a cut answer keeps A's own status and lines, and the booking stays committed",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [{ route: "POST /v1/bookings", fault: "cut-body" }],
          });
          const answer = booking("eu-000001", "eu");
          expect(
            yield* exchange(
              eu.origin,
              requestText(eu.origin, "POST", "/v1/bookings", {
                body: draftBody,
              }),
            ),
          ).toEqual({
            bytes:
              [
                "HTTP/1.1 201 Created",
                JSON_TYPE,
                "Location: /v1/bookings/eu-000001",
                `Content-Length: ${answer.length}`,
                "",
                "",
              ].join("\r\n") + answer.slice(0, Math.floor(answer.length / 2)),
            ending: "closed",
          });
          yield* expectList(eu.origin, listing("eu", answer));
        }),
    );

    it.live(
      "[EXT-29] a fault on an answer with no body: a moved path and a release",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            redirects: {
              "/v1/old": { status: 302, location: "/v1/new" },
            },
            edge: [
              { route: "GET /v1/old", fault: "cut-chunked", times: 1 },
              { route: "GET /v1/old", fault: "gzip", times: 1 },
              { route: "POST /v1/availability/release", fault: "cut-body" },
            ],
          });
          const get = requestText(eu.origin, "GET", "/v1/old");
          // No chunk at all: a chunk of nothing would be a last chunk, and this answer has none.
          expect((yield* exchange(eu.origin, get)).bytes).toBe(
            [
              "HTTP/1.1 302 Found",
              "Location: /v1/new",
              "Transfer-Encoding: chunked",
              "",
              "",
            ].join("\r\n"),
          );
          const empty = gzipSync("").toString("latin1");
          expect((yield* ask(eu.origin, "GET", "/v1/old")).bytes).toBe(
            whole(
              "HTTP/1.1 302 Found",
              ["Location: /v1/new", "Content-Encoding: gzip"],
              empty,
            ),
          );
          expect(
            (yield* exchange(
              eu.origin,
              requestText(
                eu.origin,
                "POST",
                "/v1/availability/release?terminal=rotterdam",
              ),
            )).bytes,
          ).toBe("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
        }),
    );

    it.live(
      "[EXT-29] a fault takes the place of a held answer, which then waits for nothing",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            held: ["rotterdam"],
            edge: [
              { route: "GET /v1/availability", fault: "cut-body", times: 1 },
              { route: "GET /v1/availability", fault: "gzip", times: 1 },
            ],
          });
          const target = "/v1/availability?terminal=rotterdam";
          const board =
            '{"terminal":"rotterdam","open":["06:00","07:00","08:00","09:00"]}';
          expect(
            (yield* exchange(eu.origin, requestText(eu.origin, "GET", target)))
              .bytes,
          ).toBe(
            [OK, JSON_TYPE, `Content-Length: ${board.length}`, "", ""].join(
              "\r\n",
            ) + board.slice(0, Math.floor(board.length / 2)),
          );
          const seen = yield* ask(eu.origin, "GET", target);
          expect(
            gunzipSync(Buffer.from(bodyOf(seen), "latin1")).toString(),
          ).toBe(board);
        }),
    );

    it.live(
      "[EXT-29] a fault on an export reads its lines without their framing, and its chunks as B",
      () =>
        Effect.gen(function* () {
          const J = '{"ok":true}';
          const eu = yield* start({
            edge: [
              { route: "GET /v1/export/no-colon", fault: "cut-body" },
              { route: "GET /v1/export/no-version", fault: "cut-head" },
              { route: "GET /v1/export/split-utf8", fault: "cut-unframed" },
              { route: "GET /v1/export/length-and-chunked", fault: "gzip" },
            ],
          });
          const get = (name: string) =>
            exchange(
              eu.origin,
              requestText(eu.origin, "GET", `/v1/export/${name}`),
            );
          expect((yield* get("no-colon")).bytes).toBe(
            [OK, JSON_TYPE, "garbage", "Content-Length: 11", "", ""].join(
              "\r\n",
            ) + J.slice(0, 5),
          );
          expect((yield* get("no-version")).bytes).toBe("200 OK\r\nContent-Ty");
          expect((yield* get("split-utf8")).bytes).toBe(
            [OK, MANIFEST_TYPE, "Connection: close", "", ""].join("\r\n") +
              "Gr\xc3",
          );
          const packed = gzipSync(J);
          expect(yield* get("length-and-chunked")).toEqual({
            bytes:
              [
                OK,
                JSON_TYPE,
                "Content-Encoding: gzip",
                `Content-Length: ${packed.length}`,
                "",
                "",
              ].join("\r\n") + packed.toString("latin1"),
            ending: "closed",
          });
        }),
    );

    it.live(
      "[EXT-29] raw faults and complete ones under the socket listener",
      () =>
        Effect.gen(function* () {
          const eu = yield* start(
            {
              edge: [
                { route: "POST /v1/bookings", fault: "closed", times: 1 },
                { route: "GET /v1/manifest", fault: "gzip", times: 1 },
              ],
            },
            { listener: "socket" },
          );
          expect(
            yield* exchange(
              eu.origin,
              requestText(eu.origin, "POST", "/v1/bookings", {
                body: draftBody,
              }),
            ),
          ).toEqual({ bytes: "", ending: "closed" });
          yield* expectList(
            eu.origin,
            listing("eu", booking("eu-000001", "eu")),
          );
          const seen = yield* exchange(
            eu.origin,
            requestText(eu.origin, "GET", "/v1/manifest"),
          );
          expect(seen.bytes).toBe(
            whole(
              OK,
              [MANIFEST_TYPE, "Content-Encoding: gzip"],
              manifestStream().toString("latin1"),
            ),
          );
        }),
    );
  });

  describe("rules", () => {
    const route = "GET /v1/health";

    it.live(
      "[EXT-29] after lets requests past, and times limits the rest",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [{ route, fault: "bad-gateway", after: 1, times: 2 }],
          });
          expect(yield* statuses(eu.origin, 4)).toEqual([200, 502, 502, 200]);
        }),
    );

    it.live("[EXT-29] a fault with no times goes on applying", () =>
      Effect.gen(function* () {
        const eu = yield* start({ edge: [{ route, fault: "bad-gateway" }] });
        expect(yield* statuses(eu.origin, 3)).toEqual([502, 502, 502]);
      }),
    );

    it.live(
      "[EXT-29] a rule below the one that applies does not count the request",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [
              { route, fault: "bad-gateway", times: 1 },
              { route, fault: "unavailable", after: 1 },
            ],
          });
          expect(yield* statuses(eu.origin, 3)).toEqual([502, 200, 503]);
        }),
    );

    it.live(
      "[EXT-29] a rule that matches counts even when it does not apply",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [
              { route, fault: "bad-gateway", after: 2 },
              { route, fault: "unavailable", times: 1 },
            ],
          });
          expect(yield* statuses(eu.origin, 3)).toEqual([503, 200, 502]);
        }),
    );

    it.live(
      "[EXT-29] the pick is made once over both phases, so a before rule below does not act",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [
              { route: "POST /v1/bookings", fault: "parked", times: 1 },
              {
                route: "POST /v1/bookings",
                fault: "unavailable",
                phase: "before",
              },
            ],
          });
          expect(statusOf(yield* post(eu.origin))).toBe(200);
          expect(statusOf(yield* post(eu.origin))).toBe(503);
          yield* expectList(
            eu.origin,
            listing("eu", booking("eu-000001", "eu")),
          );
        }),
    );

    it.live(
      '[EXT-29] a route compares the method and the path without its query, and "*" takes everything',
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            edge: [{ route: "GET /v1/availability", fault: "bad-gateway" }],
          });
          const target = "/v1/availability?terminal=hamburg";
          expect(statusOf(yield* ask(eu.origin, "GET", target))).toBe(502);
          expect(statusOf(yield* ask(eu.origin, "POST", target))).toBe(405);
          const all = yield* start({
            edge: [{ route: "*", fault: "unavailable" }],
          });
          for (const [method, path] of [
            ["GET", "/v1/health"],
            ["POST", "/no/such/path"],
            ["OPTIONS", "/v1/health"],
          ] as const)
            expect(statusOf(yield* ask(all.origin, method, path))).toBe(503);
        }),
    );

    const allowed = [
      "closed",
      "reset",
      "hang",
      "bad-gateway",
      "unavailable",
      "parked",
      "other-service",
    ];

    for (const fault of allowed)
      it.live(
        `[EXT-29] phase "before" takes ${fault}, and commits nothing`,
        () =>
          Effect.gen(function* () {
            const eu = yield* start({
              edge: [
                {
                  route: "POST /v1/bookings",
                  fault,
                  phase: "before",
                  times: 1,
                },
              ],
            });
            const client = yield* staying(eu.origin);
            client.write(
              requestText(eu.origin, "POST", "/v1/bookings", {
                body: draftBody,
              }),
            );
            yield* eu.arrived(1);
            yield* Effect.sleep("30 millis");
            client.socket.destroy();
            yield* expectList(eu.origin, listing("eu"));
          }),
      );

    it.live(
      '[EXT-29] phase "after", the default, commits before the fault',
      () =>
        Effect.gen(function* () {
          for (const phase of [undefined, "after"]) {
            const eu = yield* start({
              edge: [
                {
                  route: "POST /v1/bookings",
                  fault: "closed",
                  times: 1,
                  ...(phase === undefined ? {} : { phase }),
                },
              ],
            });
            expect((yield* post(eu.origin)).bytes).toBe("");
            yield* expectList(
              eu.origin,
              listing("eu", booking("eu-000001", "eu")),
            );
          }
        }),
    );

    for (const fault of [
      "cut-head",
      "cut-body",
      "cut-body-reset",
      "cut-chunked",
      "cut-unframed",
      "cut-unavailable",
      "bad-chunk",
      "gzip",
      "gzip-magic",
      "gzip-block",
      "gzip-checksum",
      "gzip-truncated",
      "gzip-trailer",
      "trickle",
    ])
      it.live(`[EXT-29] phase "before" with ${fault} fails the start`, () =>
        Effect.gen(function* () {
          yield* startFails({ route: "*", fault, phase: "before" });
          // The same rule without the phase is a good one.
          yield* Effect.scoped(start({ edge: [{ route: "*", fault }] }));
        }),
      );

    it.live("[EXT-29] other mistakes in a rule fail the start as well", () =>
      Effect.gen(function* () {
        yield* startFails({ route: "*", fault: "no-such-fault" });
        yield* startFails({ route: "*", fault: "constructor" });
        yield* startFails({ route: "/v1/health", fault: "closed" });
        yield* startFails({ route: "*", fault: "closed", phase: "during" });
        yield* startFails({ route: "*", fault: "closed", after: -1 });
        yield* startFails({ route: "*", fault: "closed", times: 1.5 });
      }),
    );
  });

  describe("CORS", () => {
    const page = "http://page.test";
    const fromPage = { lines: [`Origin: ${page}`] };
    const gained = [`Access-Control-Allow-Origin: ${page}`, "Vary: Origin"];
    const cors = { allowHeaders: ["content-type", "b3"] };

    it.live(
      "[EXT-29] with the filter off, OPTIONS is any other method and no answer has CORS lines",
      () =>
        Effect.gen(function* () {
          const eu = yield* start();
          expect(
            (yield* ask(eu.origin, "OPTIONS", "/v1/health", fromPage)).bytes,
          ).toBe(
            whole(
              "HTTP/1.1 405 Method Not Allowed",
              [PLAIN_TYPE, "Allow: GET"],
              "Method Not Allowed",
            ),
          );
          expect(
            statusOf(yield* ask(eu.origin, "OPTIONS", "/nothing", fromPage)),
          ).toBe(404);
          expect(
            (yield* ask(eu.origin, "GET", "/v1/manifest", fromPage)).bytes,
          ).toBe(whole(OK, [MANIFEST_TYPE], manifest));
        }),
    );

    it.live(
      "[EXT-29] with it on, OPTIONS on any path answers 204 and goes to no edge fault",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            cors,
            redirects: { "/v1/old": { status: 302, location: "/v1/new" } },
            edge: [{ route: "*", fault: "reset" }],
          });
          for (const target of ["/v1/health", "/nothing", "/v1/old"])
            expect(
              (yield* ask(eu.origin, "OPTIONS", target, fromPage)).bytes,
            ).toBe(
              [
                "HTTP/1.1 204 No Content",
                `Access-Control-Allow-Origin: ${page}`,
                "Access-Control-Allow-Methods: GET, POST",
                "Access-Control-Allow-Headers: content-type, b3",
                "Vary: Origin",
                "Date: <date>",
                "Connection: close",
                "",
                "",
              ].join("\r\n"),
            );
        }),
    );

    it.live("[EXT-29] OPTIONS with no Origin has nothing to echo", () =>
      Effect.gen(function* () {
        const eu = yield* start({ cors });
        expect((yield* ask(eu.origin, "OPTIONS", "/v1/health")).bytes).toBe(
          [
            "HTTP/1.1 204 No Content",
            "Access-Control-Allow-Methods: GET, POST",
            "Access-Control-Allow-Headers: content-type, b3",
            "Vary: Origin",
            "Date: <date>",
            "Connection: close",
            "",
            "",
          ].join("\r\n"),
        );
      }),
    );

    it.live(
      "[EXT-29] the region's answers gain the lines, for a request with an Origin alone",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            cors,
            redirects: { "/v1/old": { status: 302, location: "/v1/new" } },
          });
          expect(
            (yield* ask(eu.origin, "GET", "/v1/manifest", fromPage)).bytes,
          ).toBe(whole(OK, [MANIFEST_TYPE, ...gained], manifest));
          expect((yield* ask(eu.origin, "GET", "/v1/manifest")).bytes).toBe(
            whole(OK, [MANIFEST_TYPE], manifest),
          );
          expect(
            (yield* ask(eu.origin, "GET", "/nothing", fromPage)).bytes,
          ).toBe(
            whole(
              "HTTP/1.1 404 Not Found",
              [PLAIN_TYPE, ...gained],
              "Not Found",
            ),
          );
          expect(
            (yield* ask(eu.origin, "GET", "/v1/old", fromPage)).bytes,
          ).toBe(whole("HTTP/1.1 302 Found", ["Location: /v1/new", ...gained]));
          expect(
            (yield* ask(
              eu.origin,
              "POST",
              "/v1/availability/release?terminal=x",
              fromPage,
            )).bytes,
          ).toBe(
            [
              "HTTP/1.1 204 No Content",
              ...gained,
              "Date: <date>",
              "Connection: close",
              "",
              "",
            ].join("\r\n"),
          );
        }),
    );

    it.live("[EXT-29] a held answer carries them too", () =>
      Effect.gen(function* () {
        const eu = yield* start({ cors, held: ["rotterdam"] });
        const client = yield* staying(eu.origin);
        client.write(
          requestText(
            eu.origin,
            "GET",
            "/v1/availability?terminal=rotterdam",
            fromPage,
          ),
        );
        yield* eventually(() => client.received().includes(ending));
        expect(client.received()).toContain(`\r\n${gained.join("\r\n")}\r\n`);
      }),
    );

    it.live("[EXT-29] an export gets none: nothing reads it", () =>
      Effect.gen(function* () {
        const eu = yield* start({ cors });
        expect(
          (yield* exchange(
            eu.origin,
            requestText(eu.origin, "GET", "/v1/export/no-type", fromPage),
          )).bytes,
        ).toBe('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"ok":true}');
      }),
    );

    it.live(
      "[EXT-29] A's lines hold the filter's, so a fault that writes them keeps them",
      () =>
        Effect.gen(function* () {
          const eu = yield* start({
            cors,
            edge: [
              { route: "GET /v1/manifest", fault: "cut-body", times: 1 },
              { route: "GET /v1/manifest", fault: "gzip", times: 1 },
            ],
          });
          expect(
            (yield* exchange(
              eu.origin,
              requestText(eu.origin, "GET", "/v1/manifest", fromPage),
            )).bytes,
          ).toBe(
            [OK, MANIFEST_TYPE, ...gained, "Content-Length: 900", "", ""].join(
              "\r\n",
            ) + firstHalf,
          );
          const compressed = gzipSync(manifest).toString("latin1");
          expect(
            (yield* ask(eu.origin, "GET", "/v1/manifest", fromPage)).bytes,
          ).toBe(
            whole(
              OK,
              [MANIFEST_TYPE, ...gained, "Content-Encoding: gzip"],
              compressed,
            ),
          );
        }),
    );

    for (const [fault, first] of [
      ["cut-head", "HTTP/1.1 200 OK\r\nContent-Ty"],
      ["cut-unavailable", "HTTP/1.1 503 Service Unavailable"],
      ["bad-gateway", "HTTP/1.1 502 Bad Gateway"],
      ["unavailable", "HTTP/1.1 503 Service Unavailable"],
      ["parked", OK],
      ["other-service", OK],
    ] as const)
      it.live(`[EXT-29] ${fault}'s own head has no CORS lines`, () =>
        Effect.gen(function* () {
          const eu = yield* start({
            cors,
            edge: [{ route: "GET /v1/manifest", fault }],
          });
          const { bytes } = yield* ask(
            eu.origin,
            "GET",
            "/v1/manifest",
            fromPage,
          );
          expect(bytes.startsWith(first)).toBe(true);
          expect(bytes).not.toContain("Access-Control");
          expect(bytes).not.toContain("Vary");
        }),
      );
  });
});
