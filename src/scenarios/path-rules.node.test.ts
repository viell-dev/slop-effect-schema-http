/**
 * EXT-18m and EXT-18n: what the library hands over, seen past the URL parsing of `fetch`. These
 * run in the Node lane only, because only Node has a client that does not go through a browser's
 * or `fetch`'s own URL handling: the raw client writes the request line itself, and the
 * line-preserving provider is built on `node:http`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { Help } from "../clients/gateway/index.js";
import { watching } from "../clients/received.js";

const id = Request.pathValue("id");

/** A request whose value `..` would leave the customer, and whose status is all that is asked. */
const regionsOf = (origin: string) =>
  Operation.make(
    Request.get("/customers").pipe(
      Request.baseUrl(`${origin}/v1`),
      Request.path`/${id}/regions`,
    ),
    Response.when(() => true, Response.tag("Answer", Body.text)),
  )
    .execute({ path: { id: ".." } })
    .pipe(Effect.map(({ metadata }) => metadata.status));

describe("paths past fetch (node)", () => {
  it.live(
    "[EXT-18m] the raw client sends a value of .. as written, and the service answers 404, not its regions",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const status = yield* regionsOf(backend.origin).pipe(
          Effect.provide(lane.rawClient!(backend.origin)),
        );
        const [entry, ...rest] = yield* backend.ledger;
        expect(rest).toEqual([]);
        expect(entry!.target).toBe("/v1/customers/../regions");
        expect(status).toBe(404);
      }),
  );

  it.live(
    "[EXT-18m] the line-preserving provider resolves a value of .. as fetch does, because it reads the parsed URL",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const status = yield* regionsOf(backend.origin).pipe(
          Effect.provide(lane.linesClient!),
        );
        const [entry, ...rest] = yield* backend.ledger;
        expect(rest).toEqual([]);
        expect(entry!.target).toBe("/v1/regions");
        expect(status).toBe(200);
      }),
  );

  it.live(
    "[EXT-18n] what a piece adds after a # stays in the fragment, and help.cgi answers that section",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("gateway");
        const watched = watching();
        const answer = yield* Operation.make(
          Request.get("/cgi-bin/help.cgi").pipe(
            Request.baseUrl(backend.origin),
            Request.path(Schema.String, (text) => text),
            Request.path`sing`,
          ),
          Help.response,
          { transformClient: watched.last },
        )
          .execute({ path: "/accounts#clo" })
          .pipe(Effect.provide(lane.rawClient!(backend.origin)));
        expect(watched.received).toEqual([
          {
            method: "GET",
            url: `${backend.origin}/cgi-bin/help.cgi/accounts`,
            hash: "closing",
          },
        ]);
        const [entry, ...rest] = yield* backend.ledger;
        expect(rest).toEqual([]);
        expect(entry!.target).toBe("/cgi-bin/help.cgi/accounts#closing");
        expect(answer).toEqual({
          _tag: "Help",
          sections: [
            {
              topic: "accounts",
              section: "closing",
              text: "Close an account at month end.",
            },
          ],
        });
      }),
  );
});
