/**
 * Negotiation edges: exclusions with `q=0`, wildcard precedence, `identity`, repeated and empty
 * fields, and malformed weights, against `accepts_media_type`, `accepts_encoding`,
 * `accepts_language` in both modes, and `Offers::selected` with and without `invalid_is_error`.
 *
 * Each input goes to three groups of routes: one path per offer that tests that offer's
 * acceptability alone, then the shared offer set under the lenient and the strict policy. An
 * invalid field falls through under the lenient policy, and fails the strict one with the 400 of
 * `warded_server::app`. `negotiation.test.ts` covers the ordinary automatic headers.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Request } from "viell-effect-schema-http";
import { lane } from "#lane";
import { values } from "../harness/evidence.js";
import { cases, serve } from "../harness/matrix.js";
import {
  acceptsEncoding,
  acceptsLanguage,
  acceptsMediaType,
  and,
  exactPath,
  route,
  selected,
} from "../harness/routes.js";
import type { Condition, Definition, OfferSet } from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";

interface Field {
  readonly name: string;
  readonly offers: OfferSet;
  readonly accepts: (offer: string) => Condition;
  readonly examples: ReadonlyArray<Example>;
}

// Indexes are in server offer order. A null choice is a valid miss, and "invalid" exercises
// both malformed-field policies. Independent conditions probe each offer on its own path.
type Example = readonly [
  value: string | ReadonlyArray<string>,
  acceptable: ReadonlyArray<number>,
  choice: number | null | "invalid",
];

const invalidWeights = (offer: string, other: string): ReadonlyArray<Example> =>
  ["2", "1.0001", "0.1234", "abc", ""].map((weight) => [
    `${offer};q=${weight}, ${other}`,
    [],
    "invalid",
  ]);

const media: Field = {
  name: "accept",
  offers: {
    field: "media_types",
    values: ["text/html;charset=UTF-8", "application/json"],
  },
  accepts: acceptsMediaType,
  examples: [
    ["*/*", [0, 1], 0],
    ["text/*", [0], 0],
    ["text/html;q=0", [], null],
    ["text/*;q=0", [], null],
    ["*/*;q=0", [], null],
    ["*/*, text/*;q=0", [1], 1],
    ["text/html;q=0, text/*", [], null],
    ["text/*;q=0, TEXT/hTmL;q=0.2", [0], 0],
    ["text/html;Q=0, text/*", [], null],
    ["text/html;charset=utf-8;q=0, text/html", [], null],
    ["text/html;q=0;charset=utf-8, text/html", [], null],
    // Warded treats parameters after q as media parameters too. An offer without profile
    // cannot match this range, even though its type, subtype and charset match.
    [
      "text/html;charset=utf-8;q=1;profile=print, application/json;q=0.5",
      [1],
      1,
    ],
    ["text/html;q=0, */*;q=0.5", [1], 1],
    [["text/html;q=0", "*/*;q=0.5"], [1], 1],
    ...invalidWeights("text/html", "application/json"),
  ],
};

const encoding: Field = {
  name: "accept-encoding",
  offers: { field: "encodings", values: ["gzip", "identity"] },
  accepts: acceptsEncoding,
  examples: [
    ["*", [0, 1], 0],
    ["gzip;q=0", [1], 1],
    ["*;q=0", [], null],
    ["*, gzip;q=0", [1], 1],
    ["gzip;q=0.2, *;q=0", [0], 0],
    ["*;q=0, identity;q=0.2", [1], 1],
    ["*, identity;q=0", [0], 0],
    ["gzip;Q=0, *", [1], 1],
    ["gzip;q=0.1", [0, 1], 0],
    ["br", [1], 1],
    ...invalidWeights("gzip", "identity"),
  ],
};

const language = (mode: "lookup" | "basic_filter"): Field => {
  const lookup = mode === "lookup";
  const french = lookup ? "fr" : "fr-CA";
  return {
    name: "accept-language",
    offers: { field: "languages", values: [french, "en"], mode },
    accepts: (offer) => acceptsLanguage(offer, mode),
    examples: [
      ["*", [0, 1], 0],
      [`${french};q=0`, [], null],
      ["*;q=0", [], null],
      [`*, ${french};q=0`, [1], 1],
      [`${french};q=0.2, *;q=0`, [0], 0],
      [`${french};Q=0, *`, [1], 1],
      ["*;q=1, en;q=0.3", [0, 1], lookup ? 1 : 0],
      ["fr;q=0.5, fr-CA;q=0", lookup ? [0] : [], lookup ? 0 : null],
      ["fr-FR;q=0, fr-CA;q=0.5", lookup ? [] : [0], lookup ? null : 0],
      ...invalidWeights(french, "en"),
    ],
  };
};

const rawCases = lane.raw
  ? (["plain", "http"] as const).map((listener) => ({
      client: undefined,
      listener,
      title: `raw on ${listener}`,
    }))
  : [];

describe("negotiation edges", () => {
  for (const { client, listener, title } of [...cases(), ...rawCases]) {
    for (const field of [
      media,
      encoding,
      language("lookup"),
      language("basic_filter"),
    ]) {
      const { name, offers, accepts } = field;
      const mode = offers.field === "languages" ? ` (${offers.mode})` : "";
      it.live(`${title}: ${name}${mode} negotiation edges`, () =>
        Effect.gen(function* () {
          const independent = offers.values.map((offer, index) =>
            route(
              `accepts-${index}`,
              and(exactPath(`/accepts/${index}`), accepts(offer)),
            ),
          );
          const definition: Definition = {
            offers: { alternatives: offers },
            routes: [
              ...independent,
              ...[false, true].flatMap((strict) => {
                const path = strict ? "/strict" : "/lenient";
                return offers.values.map((offer, index) =>
                  route(
                    `${path}/${index}`,
                    and(
                      exactPath(path),
                      selected("alternatives", offer, strict),
                    ),
                  ),
                );
              }),
            ],
            fallback: { name: "fallthrough" },
          };
          const table = yield* serve(definition);
          const provider = client ?? lane.raw!(table.origins[listener]);
          const trimsWhitespace = client?.name === "fetch";
          const splitLines = client === undefined || client.name === "lines";
          const h2 = client?.name === "undici" && listener === "https";
          const browserEncoding = lane.name === "browser" && field === encoding;
          const empty: Example =
            field === encoding ? ["", [1], 1] : ["", [], null];
          const examples: ReadonlyArray<Example> = browserEncoding
            ? [["gzip;q=0, *;q=0", [0, 1], 0]]
            : [
                ...field.examples,
                empty,
                [", ,", empty[1], empty[2]],
                ["  ", empty[1], empty[2]],
              ];

          for (const [value, acceptable, choice] of examples) {
            const supplied = typeof value === "string" ? [value] : value;
            // The line-preserving and raw clients send the library's two lines; Effect's standard
            // providers (Node Fetch, Chromium Fetch, undici and node-http) send the joined view.
            // Explicit empty Accept survives both Fetch implementations. They trim spaces before
            // sending, while undici, node-http, lines and raw preserve spaces on HTTP/1.1.
            const written = splitLines ? supplied : [supplied.join(", ")];
            // Chromium controls Accept-Encoding, even when the operation supplies an explicit value.
            const expected = browserEncoding
              ? ["gzip, deflate, br, zstd"]
              : written.map((line) => line.trim());
            const checks = [
              ...offers.values.map((_, index) => ({
                path: `/accepts/${index}`,
                target: acceptable.includes(index) ? `accepts-${index}` : null,
              })),
              ...["/lenient", "/strict"].map((path) => ({
                path,
                target: typeof choice === "number" ? `${path}/${choice}` : null,
              })),
            ];
            for (const { path, target } of checks) {
              const context = `${name}: ${JSON.stringify(value)} on ${path}`;
              const request = supplied.reduce(
                (request, line) =>
                  request.pipe(Request.appendHeader(name, line)),
                Request.get(path),
              );
              const sent = yield* send(
                table,
                listener,
                provider,
                operation(request),
                undefined,
              );
              if (listener === "https") {
                expect(sent.wire, context).toEqual([]);
              } else {
                expect(sent.wire, context).toHaveLength(1);
                const [wire] = sent.wire;
                expect(wire!.target, context).toBe(path);
                expect(values(wire!.lines, name), context).toEqual(expected);
                if (value === "  " && !browserEncoding) {
                  expect(wire!.head, context).toContain(
                    `\r\n${name}: ${trimsWhitespace ? "" : value}\r\n`,
                  );
                }
              }
              // Undici sends whitespace as given over HTTP/2. Warded Server rejects a padded
              // HTTP/2 field before the app sees it, as required by
              // https://github.com/viell-dev/slop-warded-server/issues/25.
              if (h2 && value === "  ") {
                expect(sent.exchanges, context).toEqual([]);
                expect(sent.outcome, context).toEqual({
                  kind: "answered",
                  status: 400,
                  text: "Malformed request: a field value begins or ends with whitespace.\n",
                });
                continue;
              }

              const exchange = only(sent);
              expect(exchange.seen, context).toMatchObject({
                method: "GET",
                path,
              });
              if (lane.name === "browser" && listener === "https") {
                // Chromium starts on HTTP/2, and follows the server's `Alt-Svc` to HTTP/3 once it
                // has learned it, which happens within the many requests this test sends to one
                // table. Both carry the same fields.
                expect(["HTTP/2", "HTTP/3"], context).toContain(
                  exchange.seen.version,
                );
              } else {
                expect(exchange.seen.version, context).toBe(
                  h2 ? "HTTP/2" : "HTTP/1.1",
                );
              }
              expect(values(exchange.seen.headers, name), context).toEqual(
                expected,
              );
              if (path === "/strict" && choice === "invalid") {
                expect(exchange.verdict, context).toMatchObject({
                  is: "failed",
                  error: expect.stringContaining(
                    `InvalidHeader { name: "${name}"`,
                  ),
                });
                expect(exchange.dispatched, context).toBeNull();
                expect(exchange.status, context).toBe(400);
                expect(sent.outcome, context).toEqual({
                  kind: "answered",
                  status: 400,
                  text: "",
                });
              } else {
                expect(exchange.verdict, context).toEqual(
                  target === null
                    ? { is: "missed" }
                    : {
                        is: "selected",
                        index: definition.routes.findIndex(
                          (route) => route.name === target,
                        ),
                        captures: {},
                      },
                );
                expect(exchange.dispatched, context).toMatchObject({
                  route: target ?? "fallthrough",
                  captures: {},
                });
                expect(exchange.status, context).toBe(200);
                expect(sent.outcome, context).toEqual({
                  kind: "routed",
                  route: target ?? "fallthrough",
                  captures: {},
                });
              }
            }
          }
        }).pipe(Effect.scoped),
      );
    }
  }
});
