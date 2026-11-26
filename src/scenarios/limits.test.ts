/**
 * Boundaries from Warded's path and negotiation guides. Keep the inputs within the other
 * bounds so the strict verdict identifies the particular limit being exercised.
 */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
import { lane } from "#lane";
import { values } from "../harness/evidence.js";
import type { Listener } from "../harness/lane.js";
import { cases, serve } from "../harness/matrix.js";
import { and, exactPath, path, route, selected } from "../harness/routes.js";
import type { Definition } from "../harness/routes.js";
import { only, operation, send, type Sent } from "../harness/send.js";
import type { Table } from "../harness/table.js";

const matrix = [
  ...cases(),
  ...(lane.raw
    ? (["plain", "http"] as const).map((listener) => ({
        listener,
        title: `raw on ${listener}`,
        client: undefined,
      }))
    : []),
];

const captures = (count: number) =>
  Array.from({ length: count }, (_, index) => `p${index + 1}`);
const pattern = (count: number) =>
  "/items" +
  captures(count)
    .map((name) => `/{${name}}`)
    .join("");
const segments = (count: number) => captures(count).map((name) => `v${name}`);
const getItems = Request.get("/items").pipe(
  Request.path(Schema.Array(Schema.String), (parts, encode) =>
    parts.map((part) => `/${encode(part)}`).join(""),
  ),
);

const json = "application/json";
const policies = [
  { target: "/accept", strict: false },
  { target: "/strict-accept", strict: true },
] as const;
const negotiation: Definition = {
  offers: { formats: { field: "media_types", values: [json] } },
  routes: policies.map(({ target, strict }) =>
    route("json", and(exactPath(target), selected("formats", json, strict))),
  ),
};

const list = (count: number) => "text/plain,".repeat(count - 1) + json;
const empties = (count: number) => "text/plain" + ",".repeat(count + 1) + json;
// The last parameter is q. The other range still matches JSON, so ignoring the over-limit
// range, truncating it or omitting q from the count would incorrectly select a route.
const params = (count: number) =>
  json +
  ",text/plain" +
  Array.from({ length: count - 1 }, (_, index) => `;p${index}=x`).join("") +
  ";q=1";
const countLimits = [
  {
    name: "nonempty members",
    limit: 1024,
    field: list,
    error: "too many members",
  },
  {
    name: "empty elements",
    limit: 16,
    field: empties,
    error: "too many empty list elements",
  },
  {
    name: "parameters including q",
    limit: 64,
    field: params,
    error: "too many members",
  },
] as const;

const fieldLimit = 64 * 1024;
// Two valid media ranges. Vary the length of the nonmatching range's subtype by one byte.
const padding = (size: number) => "application/".padEnd(size, "x");
const single = (size: number) =>
  [json + "," + padding(size - json.length - 1)] as const;

type Fields = readonly [string, ...string[]];

const accept = (target: string, [first, ...rest]: Fields) =>
  rest.reduce(
    (request, field) => request.pipe(Request.appendHeader("accept", field)),
    Request.get(target).pipe(Request.setHeader("accept", first)),
  );

const expectWire = (sent: Sent, listener: Listener, target: string) => {
  if (listener === "https") {
    expect(sent.wire).toEqual([]);
    return;
  }
  expect(sent.wire).toHaveLength(1);
  expect(sent.wire[0]).toMatchObject({ listener, method: "GET", target });
};

const expectAccept = (
  sent: Sent,
  target: string,
  fields: ReadonlyArray<string>,
  strict: boolean,
  error?: string,
) => {
  const { seen, verdict, dispatched, status } = only(sent);
  expect(seen).toMatchObject({ method: "GET", path: target, query: null });
  expect(values(seen.headers, "accept")).toEqual(fields);
  if (error === undefined) {
    const index = strict ? 1 : 0;
    expect(verdict).toEqual({ is: "selected", index, captures: {} });
    expect(dispatched).toMatchObject({ index, route: "json", captures: {} });
    expect(status).toBe(200);
    expect(sent.outcome).toEqual({
      kind: "routed",
      route: "json",
      captures: {},
    });
    return;
  }
  if (strict) {
    expect(verdict).toMatchObject({
      is: "failed",
      error: expect.stringContaining(
        `InvalidHeader { name: "accept", detail: "${error}`,
      ),
    });
  } else {
    expect(verdict).toEqual({ is: "missed" });
  }
  expect(dispatched).toBeNull();
  expect(status).toBe(strict ? 400 : 404);
  expect(sent.outcome).toMatchObject({ kind: "answered", status });
};

describe("Warded limits", () => {
  for (const { invalid, parts, reason } of [
    {
      invalid: pattern(26),
      parts: segments(26),
      reason: "path patterns support at most 25 ordinary named parameters",
    },
    {
      invalid: "/items/{from}-{to}",
      parts: ["first-last"],
      reason:
        '"/items/{from}-{to}": Only one parameter is allowed per path segment',
    },
    {
      invalid: "/items/{*first}/{*second}",
      parts: ["first", "second"],
      reason:
        '"/items/{*first}/{*second}": Catch-all parameters are only allowed at the end of a route',
    },
  ]) {
    it.live(`path refuses ${invalid} when opening the table`, () =>
      Effect.gen(function* () {
        const request = yield* Request.compile(getItems, { path: parts });
        expect(request.request.url).toBe("/items/" + parts.join("/"));
        // The library can compose the target. The host validates the pattern before binding
        // sockets, so the refused table has no wire, head, verdict or dispatch.
        const refusal = yield* serve({
          routes: [route("items", path(invalid))],
        }).pipe(Effect.sandbox, Effect.flip);
        expect(Cause.pretty(refusal)).toContain(
          `control /tables: route "items": ${reason}`,
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const { client, listener, title } of matrix) {
    const provider = (table: Table) =>
      client ?? lane.raw!(table.origins[listener]);
    const preservesLines = client === undefined || client.name === "lines";
    const sendAccept = (table: Table, target: string, fields: Fields) =>
      Effect.gen(function* () {
        const request = accept(target, fields);
        const compiled = yield* Request.compile(request, undefined);
        expect(compiled.request.url).toBe(target);
        expect(values(compiled.headerLines, "accept")).toEqual(fields);

        // The standard providers send the library's normalized headers, which join with comma
        // and space. Lines and raw send separate fields, which Warded joins with just a comma.
        const normalized = fields.join(", ");
        expect(compiled.request.headers["accept"]).toBe(normalized);
        const sentFields = preservesLines ? fields : [normalized];
        const sent = yield* send(
          table,
          listener,
          provider(table),
          operation(request),
          undefined,
        );
        expectWire(sent, listener, target);
        if (listener !== "https") {
          expect(values(sent.wire[0]!.lines, "accept")).toEqual(sentFields);
        }
        return { sent, sentFields };
      });

    it.live(
      `${title}: 25 ordinary captures, with and without a final catch-all`,
      () =>
        Effect.gen(function* () {
          const taken = Object.fromEntries(
            captures(25).map((name) => [name, `v${name}`]),
          );
          const table = yield* serve({
            routes: [
              route("items", path(pattern(25))),
              route("items-rest", path(pattern(25) + "/{*rest}")),
            ],
          });
          for (const [index, tail] of [[], ["more", "items"]].entries()) {
            const parts = [...segments(25), ...tail];
            const target = "/items/" + parts.join("/");
            const expected =
              tail.length === 0 ? taken : { ...taken, rest: "more/items" };
            const input = { path: parts };
            expect((yield* Request.compile(getItems, input)).request.url).toBe(
              target,
            );
            const sent = yield* send(
              table,
              listener,
              provider(table),
              operation(getItems),
              input,
            );
            expectWire(sent, listener, target);
            const { seen, verdict, dispatched, status } = only(sent);
            expect(seen).toMatchObject({
              method: "GET",
              path: target,
              query: null,
            });
            expect(verdict).toEqual({
              is: "selected",
              index,
              captures: expected,
            });
            expect(dispatched).toMatchObject({
              index,
              route: table.definition.routes[index]!.name,
              captures: expected,
              params: { Ok: expected },
            });
            expect(status).toBe(200);
            expect(sent.outcome.kind).toBe("routed");
          }
        }).pipe(Effect.scoped),
    );

    for (const { name, limit, field, error } of countLimits) {
      it.live(`${title}: ${name} at ${limit} and ${limit + 1}`, () =>
        Effect.gen(function* () {
          const table = yield* serve(negotiation);
          for (const { target, strict } of policies) {
            for (const count of [limit, limit + 1]) {
              const { sent, sentFields } = yield* sendAccept(table, target, [
                field(count),
              ]);
              expectAccept(
                sent,
                target,
                sentFields,
                strict,
                count === limit ? undefined : error,
              );
            }
          }
        }).pipe(Effect.scoped),
      );
    }

    if (listener !== "plain") {
      it.live(
        `${title}: the default server head limit intercepts 64 KiB fields`,
        () =>
          Effect.gen(function* () {
            const table = yield* serve(negotiation);
            for (const size of [fieldLimit, fieldLimit + 1]) {
              const { sent } = yield* sendAccept(
                table,
                "/strict-accept",
                single(size),
              );
              expect(sent.exchanges).toEqual([]);
              if (
                lane.name === "browser" ||
                (client?.name === "undici" && listener === "https")
              ) {
                // The 32 KiB transport limit precedes the app. Chromium cannot read the refusal
                // without CORS headers. Undici's HTTP/2 path fails framing even at 128 KiB below.
                expect(sent.outcome).toMatchObject({
                  kind: "failure",
                  tag: "HttpClientError/TransportError",
                });
              } else {
                // Fetch, undici over cleartext, node-http, lines and raw see Hyper's HTTP/1.1 431.
                expect(sent.outcome).toMatchObject({
                  kind: "answered",
                  status: 431,
                });
              }
            }
          }).pipe(Effect.scoped),
      );
    }

    it.live(
      `${title}: negotiation handles 65536 and 65537 combined field bytes`,
      () =>
        Effect.gen(function* () {
          // Axum's plain listener uses Hyper's larger default HTTP/1 buffer. Give the Warded
          // listeners enough headroom for either field size plus the rest of the request head.
          const table = yield* serve(
            negotiation,
            listener === "plain" ? {} : { headBytes: 128 * 1024 },
          );
          for (const { target, strict } of policies) {
            for (const size of [fieldLimit, fieldLimit + 1]) {
              const split = [
                json,
                padding(size - json.length - (preservesLines ? 1 : 2)),
              ] as const;
              for (const fields of [single(size), split]) {
                const { sent, sentFields } = yield* sendAccept(
                  table,
                  target,
                  fields,
                );
                expect(sentFields.join(",")).toHaveLength(size);
                if (client?.name === "undici" && listener === "https") {
                  // Node's HTTP/2 stack reports FRAME_SIZE_ERROR on HEADERS before the Warded
                  // head recorder, even with head_bytes raised. The same provider over HTTP/1.1
                  // and Chromium over HTTPS carry these fields through to negotiation.
                  expect(sent.exchanges).toEqual([]);
                  expect(sent.outcome).toMatchObject({
                    kind: "failure",
                    tag: "HttpClientError/TransportError",
                  });
                } else {
                  expectAccept(
                    sent,
                    target,
                    sentFields,
                    strict,
                    size === fieldLimit
                      ? undefined
                      : "combined field exceeds configured byte limit",
                  );
                }
              }
            }
          }
        }).pipe(Effect.scoped),
    );
  }
});
