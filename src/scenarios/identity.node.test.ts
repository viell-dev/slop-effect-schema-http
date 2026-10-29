/**
 * Identity scenarios that need Node itself, so they run in the Node lane only:
 *
 * - the line-preserving provider is a `node:http` client, which a browser does not have;
 * - a browser never exposes `Set-Cookie` to scripts, so cookie parsing can only be observed here.
 *
 * Their Fetch counterparts, which a browser can run, are in `identity.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";
import { Cookies } from "effect/http";
import { lane } from "#lane";
import { jsonGrant } from "../clients/identity/index.js";
import { type Json } from "../harness/lane.js";

/** The one place this file starts the provider. */
const start = (options?: Json) => lane.backend("identity", options);

const grantInput = (scopes: ReadonlyArray<string>) => ({
  headers: { scopes },
  body: {
    grantType: "password" as const,
    username: "alovelace",
    password: Redacted.make("analytical-engine"),
  },
});

const narrow = <A extends { readonly _tag: string }, T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

describe(`identity provider (${lane.name} only)`, () => {
  // lane: node-only — the line-preserving provider is a node:http client.
  it.live(
    "[HDR-1] the line-preserving provider sends one scope per line and reads four granted lines",
    () =>
      Effect.gen(function* () {
        const lines = lane.linesClient;
        if (lines === undefined) return yield* Effect.die("Node lane only");
        const backend = yield* start();
        const result = yield* jsonGrant(backend.origin)
          .execute(grantInput(["directory:read", "directory:write"]))
          .pipe(Effect.provide(lines));
        const granted = narrow(result, "Granted");
        const [received] = yield* backend.ledger;
        expect(
          received!.lines.filter(([name]) => name === "X-OAuth-Scope"),
        ).toEqual([
          ["X-OAuth-Scope", "directory:read"],
          ["X-OAuth-Scope", "directory:write"],
        ]);
        expect(granted.value.granted).toEqual({
          _tag: "Lines",
          scopes: ["openid", "profile", "directory:read", "directory:write"],
        });
        expect(
          Option.map(granted.metadata.headerLines, (observed) =>
            observed.filter(([name]) => name === "X-OAuth-Scope"),
          ),
        ).toEqual(
          Option.some([
            ["X-OAuth-Scope", "openid"],
            ["X-OAuth-Scope", "profile"],
            ["X-OAuth-Scope", "directory:read"],
            ["X-OAuth-Scope", "directory:write"],
          ]),
        );
        // The normalized view still joins them; only the lines keep them apart.
        expect(granted.metadata.headers["x-oauth-scope"]).toBe(
          "openid, profile, directory:read, directory:write",
        );
      }),
  );

  // lane: node-only — a browser never exposes Set-Cookie to scripts.
  it.live(
    "[HDR-1] parses each Set-Cookie line separately in Node, through both providers",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        for (const [name, provider] of lane.clients) {
          const granted = narrow(
            yield* jsonGrant(backend.origin)
              .execute(grantInput(["directory:read"]))
              .pipe(Effect.provide(provider)),
            "Granted",
          );
          const { cookies, headers, headerLines } = granted.metadata;
          const affinity = Cookies.get(cookies, "IDPLB");
          const session = Cookies.get(cookies, "IDPSESSION");
          expect(Option.map(affinity, (cookie) => cookie.value)).toEqual(
            Option.some("node-3"),
          );
          // The comma inside Expires is why the lines cannot be joined and split again.
          expect(
            Option.map(affinity, (cookie) => cookie.options?.expires),
          ).toEqual(Option.some(new Date("2038-01-01T00:00:00Z")));
          expect(
            Option.map(session, (cookie) => cookie.options?.httpOnly),
          ).toEqual(Option.some(true));
          expect(granted.value.session).toEqual(
            Option.map(session, (cookie) => cookie.value),
          );
          // Effect's normalized map keeps one Set-Cookie value; only the parsed cookies are whole.
          expect(headers["set-cookie"]).toBe(
            "IDPLB=node-3; Path=/; Expires=Fri, 01 Jan 2038 00:00:00 GMT",
          );
          expect(
            Option.map(
              headerLines,
              (lines) => lines.filter(([line]) => line === "Set-Cookie").length,
            ),
          ).toEqual(name === "lines" ? Option.some(2) : Option.none());
        }
      }),
  );
});
