/**
 * HTTP/3, from a browser page: the lane's Chromium was started to use QUIC for one HTTPS port, and
 * this table's HTTPS listener takes that port. Browser-only, because no Node provider here speaks
 * HTTP/3. One table serves the whole test, since only one listener can hold the port.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
import { inject } from "vitest";
import { lane } from "#lane";
import { serve } from "../harness/matrix.js";
import {
  and,
  exactPath,
  headerAnyEq,
  paramPair,
  path,
  route,
  version,
} from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";

const id = Request.pathValue("id", Schema.String);

describe("HTTP/3", () => {
  it.live(
    "routes see HTTP/3, and paths, queries and headers arrive as over HTTP/1.1",
    () =>
      Effect.gen(function* () {
        const table = yield* serve(
          {
            routes: [
              route("http/3", and(exactPath("/v"), version("HTTP/3"))),
              route("http/2", and(exactPath("/v"), version("HTTP/2"))),
              route("user", and(version("HTTP/3"), path("/users/{id}"))),
              route(
                "csv",
                and(exactPath("/search"), paramPair("format", "csv")),
              ),
              route(
                "feature",
                and(
                  exactPath("/h"),
                  headerAnyEq("x-feature", "beta, dark-mode"),
                ),
              ),
            ],
          },
          { httpsPort: inject("quicPort") },
        );
        const at = <I, E>(request: Request.Request<I, E>, input: I) =>
          send(table, "https", lane.fetch, operation(request), input);

        const versioned = yield* at(Request.get("/v"), undefined);
        expect(only(versioned).seen).toMatchObject({
          version: "HTTP/3",
          security: "https",
        });
        expect(versioned.outcome).toMatchObject({ route: "http/3" });

        const getUser = Request.get("").pipe(Request.path`/users/${id}`);
        const failures: Array<string> = [];
        for (const value of ["42", "a b/c", "café", "%", "?x=1#y", "'", "~"]) {
          const sent = yield* at(getUser, { path: { id: value } });
          if (
            sent.outcome.kind !== "routed" ||
            sent.outcome.captures["id"] !== encodeURIComponent(value) ||
            JSON.stringify(only(sent).dispatched?.params) !==
              JSON.stringify({ Ok: { id: value } })
          )
            failures.push(
              `${JSON.stringify(value)}: ${JSON.stringify(sent.outcome)}`,
            );
        }
        expect(failures).toEqual([]);

        expect(
          (yield* at(
            Request.get("/search").pipe(Request.setQuery("format", "csv")),
            undefined,
          )).outcome,
        ).toMatchObject({ route: "csv" });
        // The browser's fetch joins repeated lines before any protocol is chosen.
        expect(
          (yield* at(
            Request.get("/h").pipe(
              Request.appendHeader("x-feature", "beta"),
              Request.appendHeader("x-feature", "dark-mode"),
            ),
            undefined,
          )).outcome,
        ).toMatchObject({ route: "feature" });
      }).pipe(Effect.scoped),
  );
});
