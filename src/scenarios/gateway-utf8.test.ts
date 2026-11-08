import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { Help, Session } from "../clients/gateway/index.js";
import { header } from "../harness/lane.js";

// Consumer regression: https://github.com/viell-dev/slop-effect-schema-http/issues/149.
const contracts = [
  [
    "pipe",
    (url: string) =>
      Operation.make(
        Request.get(url),
        Response.status(200, Session.balanceBody),
      )
        .execute(undefined)
        .pipe(Effect.map((reply): unknown => reply)),
  ],
  [
    "help",
    (url: string) =>
      Operation.make(Request.get(url), Help.response)
        .execute(undefined)
        .pipe(Effect.map((reply): unknown => reply)),
  ],
] as const;

const readBody = <A, E>(url: string, decoder: Body.Decoder<A, E>) =>
  Operation.make(Request.get(url), Response.status(200, decoder)).execute(
    undefined,
  );

const prefix = new TextEncoder().encode("ERROR|E_SECTION|no section ");
const replyBytes = (value: ReadonlyArray<number>) =>
  new Uint8Array([...prefix, ...value, 0x0a]);

describe(`gateway pipe UTF-8 (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    for (const [escaped, text, bytes] of [
      ["unknown", "unknown", [...new TextEncoder().encode("unknown")]],
      ["%C3%A4", "ä", [0xc3, 0xa4]],
      ["%F0%9F%98%80", "😀", [0xf0, 0x9f, 0x98, 0x80]],
      ["%EF%BF%BD", "\ufffd", [0xef, 0xbf, 0xbd]],
    ] as const)
      it.live(
        `[EXT-31b] ${provider}: pipe and help contracts preserve valid UTF-8 ${escaped}`,
        () =>
          Effect.gen(function* () {
            const gateway = yield* lane.backend("gateway");
            const target = `/cgi-bin/go.cgi?section=${escaped}`;
            const url = `${gateway.origin}${target}`;
            expect(yield* readBody(url, Body.bytes)).toEqual(replyBytes(bytes));
            for (const [name, execute] of contracts)
              expect(yield* execute(url), name).toEqual({
                _tag: "GatewayError",
                code: "E_SECTION",
                message: `no section ${text}`,
              });
            const ledger = yield* gateway.ledger;
            expect(ledger.map((entry) => [entry.method, entry.target])).toEqual(
              Array.from({ length: 3 }, () => ["GET", target]),
            );
            expect(
              ledger.slice(1).map(({ lines }) => header(lines, "accept")),
            ).toEqual(["text/plain", "text/plain"]);
          }).pipe(Effect.provide(client)),
      );

    for (const [escaped, bytes] of [
      ["%E4", [0xe4]],
      ["%80", [0x80]],
      ["%C0%AF", [0xc0, 0xaf]],
      ["%ED%A0%80", [0xed, 0xa0, 0x80]],
      ["%F4%90%80%80", [0xf4, 0x90, 0x80, 0x80]],
    ] as const)
      it.live(
        `[EXT-31b] ${provider}: pipe and help contracts refuse malformed UTF-8 ${escaped}, while Body.text replaces it`,
        () =>
          Effect.gen(function* () {
            const gateway = yield* lane.backend("gateway");
            const target = `/cgi-bin/go.cgi?section=${escaped}`;
            const url = `${gateway.origin}${target}`;
            const expected = replyBytes(bytes);
            expect(yield* readBody(url, Body.bytes)).toEqual(expected);
            // Body.text deliberately remains the library's transparent, lenient control.
            const text = yield* readBody(url, Body.text);
            expect(text).toBe(new TextDecoder().decode(expected));
            expect(text).toContain("\ufffd");
            for (const [name, execute] of contracts) {
              const error = yield* execute(url).pipe(Effect.flip);
              expect(error._tag, name).toBe("DecodeError");
              if (error._tag !== "DecodeError")
                throw new Error(`expected DecodeError, got ${error._tag}`);
              expect(error.metadata.status).toBe(200);
              expect(String(error.cause)).toContain("not UTF-8");
            }
            const ledger = yield* gateway.ledger;
            expect(ledger.map((entry) => [entry.method, entry.target])).toEqual(
              Array.from({ length: 4 }, () => ["GET", target]),
            );
          }).pipe(Effect.provide(client)),
      );
  }
});
