/**
 * PAY-1: decode real Express replies over replay sockets, without executing JSONP as JavaScript.
 * The existing application operation and dialect reader are held to software outside their pair.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as Dialect from "../clients/business/envelopes-dialects.js";
import * as Envelopes from "../clients/business/envelopes.js";
import { header, type Recorded } from "../harness/lane.js";

const rates = {
  base: "USD",
  rates: { EUR: "0.9150", GBP: "0.7890", JPY: "149.2000" },
};
const cases = [
  ["plain-json", "/v1/rates", null, false],
  ["show-rates", "/v1/rates?callback=showRates", "showRates", false],
  ["other-widget", "/v1/rates?callback=otherWidget", "otherWidget", false],
  ["identifier-symbols", "/v1/rates?callback=_%24rates2", "_$rates2", false],
  ["empty-callback", "/v1/rates?callback=", null, false],
  [
    "sanitized-callback",
    "/v1/rates?callback=alert%281%29%2F%2F",
    "alert(1)//",
    true,
  ],
  [
    "dotted-callback",
    "/v1/rates?callback=widget.showRates",
    "widget.showRates",
    true,
  ],
  [
    "repeated-callback",
    "/v1/rates?callback=showRates&callback=otherWidget",
    "showRates",
    false,
  ],
] as const;
const replay = (names: ReadonlyArray<string>) =>
  lane.backend("replay", {
    exchanges: names.map((name) => `express-jsonp/${name}`),
  });
const assertWire = (
  ledger: ReadonlyArray<Recorded>,
  target: string,
  accept = "application/javascript",
) => {
  expect(ledger).toHaveLength(1);
  expect(ledger[0]!.method).toBe("GET");
  expect(ledger[0]!.target).toBe(target);
  expect(header(ledger[0]!.lines, "accept")).toBe(accept);
  expect(ledger[0]!.body).toHaveLength(0);
};
const jsonpBody = (callback: string) =>
  Body.decoder(
    Body.text.pipe(
      Body.schema(
        Dialect.jsonp(callback).pipe(
          Schema.decodeTo(Schema.fromJsonString(Envelopes.Rates)),
        ),
      ),
    ).decode,
    "application/javascript",
  );
const literalRequest = (origin: string, target: string) =>
  Request.get("v1/rates").pipe(
    Request.baseUrl(origin),
    // Preserve the recorded query byte for byte, including percent spelling and repeats.
    Request.mapEffect((request) =>
      Effect.succeed(HttpClientRequest.setUrl(request, `${origin}${target}`)),
    ),
  );

describe(`Express JSONP recordings (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    for (const [name, target, callback, refused] of cases) {
      it.live(`[PAY-1] ${provider}: decode stock Express ${name}`, () =>
        Effect.gen(function* () {
          const backend = yield* replay([name]);
          const body =
            callback === null
              ? Body.jsonSchema(Envelopes.Rates)
              : jsonpBody(callback);
          const operation = Operation.make(
            literalRequest(backend.origin, target),
            Response.status(200, Response.tag("Rates", body)),
          );
          if (refused) {
            const error = yield* Effect.flip(operation.execute(undefined));
            expect(error).toBeInstanceOf(Response.DecodeError);
            if (error._tag === "DecodeError") {
              expect(error.metadata.status).toBe(200);
              expect(error.metadata.headers["content-type"]).toBe(
                "text/javascript; charset=utf-8",
              );
              expect(Schema.isSchemaError(error.cause)).toBe(true);
              expect(String(error.cause)).toMatch(
                name === "sanitized-callback"
                  ? /calls alert1, not the requested/
                  : /Express JSONP frame/,
              );
            }
          } else {
            const result = yield* operation.execute(undefined);
            expect(result.value).toEqual(rates);
            expect(result.metadata.headers["content-type"]).toBe(
              callback === null
                ? "application/json; charset=utf-8"
                : "text/javascript; charset=utf-8",
            );
            expect(result.metadata.headers["x-powered-by"]).toBe("Express");
            expect(result.metadata.headers["x-content-type-options"]).toBe(
              "nosniff",
            );
          }
          assertWire(
            yield* backend.ledger,
            target,
            callback === null ? "application/json" : "application/javascript",
          );
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
      );
    }

    for (const [name, target, callback] of cases.slice(1, 4)) {
      it.live(
        `[PAY-1] ${provider}: the existing rates operation reads Express ${name}`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay([name]);
            const api = Envelopes.make(backend.origin);
            expect(
              yield* api.rates.execute({ query: { callback: callback! } }),
            ).toEqual(rates);
            assertWire(yield* backend.ledger, target);
          }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
      );
    }

    it.live(
      `[PAY-1] ${provider}: the rates contract rejects non-identifiers before Express replay`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["show-rates"]);
          const api = Envelopes.make(backend.origin);
          for (const callback of ["", "widget.showRates", "alert(1)//"]) {
            const error = yield* Effect.flip(
              api.rates.execute({ query: { callback } }),
            );
            expect(Schema.isSchemaError(error)).toBe(true);
            expect(yield* backend.ledger).toHaveLength(0);
          }
          expect(
            yield* api.rates.execute({ query: { callback: "showRates" } }),
          ).toEqual(rates);
          assertWire(yield* backend.ledger, "/v1/rates?callback=showRates");
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    for (const [name, target] of [
      ["other-widget", "/v1/rates?callback=otherWidget"],
      ["plain-json", "/v1/rates"],
    ] as const) {
      it.live(
        `[PAY-1] ${provider}: a showRates decoder refuses Express ${name}`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay([name]);
            // Deliberately mismatch the decoder's expected callback with a real recorded response.
            // This tests rejection, without pretending the replay backend implements a CDN cache.
            const operation = Operation.make(
              literalRequest(backend.origin, target),
              Response.status(200, jsonpBody("showRates")),
            );
            const error = yield* Effect.flip(operation.execute(undefined));
            expect(error).toBeInstanceOf(Response.DecodeError);
            if (error._tag === "DecodeError") {
              expect(error.metadata.status).toBe(200);
              expect(Schema.isSchemaError(error.cause)).toBe(true);
              expect(String(error.cause)).toMatch(
                name === "other-widget"
                  ? /calls otherWidget, not the requested showRates/
                  : /Express JSONP frame/,
              );
            }
            assertWire(yield* backend.ledger, target);
          }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
      );
    }
  }
});
