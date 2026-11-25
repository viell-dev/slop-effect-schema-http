/**
 * Headers: the library's header declarations against Warded's `header_eq`, `header_any_eq` and
 * `header_present`.
 *
 * Warded compares raw values as bytes, names without case, and treats each field line as one
 * value, so `header_eq` misses a repeated field and `header_any_eq` finds one line among several.
 * The library keeps each declared line, and a provider decides whether lines stay separate on the
 * wire. Effect's standard clients send its normalized headers, which join repeated lines with `, `;
 * the line-preserving provider sends the original lines.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
import { values } from "../harness/evidence.js";
import { cases, serve } from "../harness/matrix.js";
import {
  and,
  exactPath,
  headerAnyEq,
  headerEq,
  headerPresent,
  not,
  route,
} from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";

const at = exactPath("/h");
const table = {
  routes: [
    route("tenant", and(at, headerEq("x-tenant", "acme"))),
    route("feature-line", and(at, headerAnyEq("x-feature", "beta"))),
    route("feature-joined", and(at, headerEq("x-feature", "beta, dark-mode"))),
    route("empty", and(at, headerEq("x-empty", ""))),
    route("present", and(at, headerPresent("x-present"))),
    route("latin-1", and(at, headerEq("x-latin-1", "café"))),
    route("json", and(at, headerEq("content-type", "application/json"))),
    route("text", and(at, headerEq("content-type", "text/plain"))),
    route(
      "vendor",
      and(at, headerEq("content-type", "application/vnd.example+json")),
    ),
    route("no-accept", and(at, not(headerPresent("accept")))),
    route("some-accept", and(at, headerEq("accept", "*/*"))),
    route("other", at),
  ],
};

const getting = Request.get("/h");

describe("headers", () => {
  for (const { client, listener, title } of cases()) {
    const run = <I, E>(request: Request.Request<I, E>, input: I) =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const sent = yield* send(
          routes,
          listener,
          client,
          operation(request),
          input,
        );
        return { outcome: sent.outcome, seen: only(sent).seen };
      }).pipe(Effect.scoped);

    it.live(`${title}: names compare without case, values as bytes`, () =>
      Effect.gen(function* () {
        expect(
          (yield* run(
            getting.pipe(Request.setHeader("X-Tenant", "acme")),
            undefined,
          )).outcome,
        ).toMatchObject({ route: "tenant" });
        expect(
          (yield* run(
            getting.pipe(Request.setHeader("x-tenant", "ACME")),
            undefined,
          )).outcome,
        ).toMatchObject({ route: "other" });
        // HTTP/1.1 parsers drop the whitespace around a field value. HTTP/2 has no such step: RFC
        // 9113 section 8.2.1 makes a value that starts or ends with whitespace malformed. Undici's
        // HTTP/2 client sends it as given, and the Warded Server hands it to the router as it
        // arrived, so `header_eq` sees ` acme `. This pins the current behaviour of
        // https://github.com/viell-dev/slop-warded-server/issues/25.
        const padded = yield* run(
          getting.pipe(Request.setHeader("x-tenant", " acme ")),
          undefined,
        );
        // Fetch trims a value itself, before any protocol is chosen.
        const untrimmed =
          padded.seen.version === "HTTP/2" && client.name !== "fetch";
        expect(values(padded.seen.headers, "x-tenant")).toEqual([
          untrimmed ? " acme " : "acme",
        ]);
        expect(padded.outcome).toMatchObject({
          route: untrimmed ? "other" : "tenant",
        });
        expect(
          (yield* run(
            getting.pipe(Request.setHeader("x-empty", "")),
            undefined,
          )).outcome,
        ).toMatchObject({ route: "empty" });
        expect(
          (yield* run(
            getting.pipe(Request.setHeader("x-present", "anything")),
            undefined,
          )).outcome,
        ).toMatchObject({ route: "present" });
        // A character up to U+00FF is one byte on the wire, and Warded compares that byte.
        expect(
          (yield* run(
            getting.pipe(Request.setHeader("x-latin-1", "café")),
            undefined,
          )).outcome,
        ).toMatchObject({ route: "latin-1" });
      }),
    );

    it.live(`${title}: header schemas write the lines a route expects`, () =>
      Effect.gen(function* () {
        const tenant = getting.pipe(
          Request.headers(
            Schema.Struct({ "x-tenant": Schema.Literals(["acme", "globex"]) }),
          ),
        );
        expect(
          (yield* run(tenant, { headers: { "x-tenant": "acme" } })).outcome,
        ).toMatchObject({ route: "tenant" });
        expect(
          (yield* run(tenant, { headers: { "x-tenant": "globex" } })).outcome,
        ).toMatchObject({ route: "other" });
      }),
    );

    const lines = client.name === "lines";
    it.live(
      `${title}: repeated lines ${lines ? "stay separate" : "are joined by the provider"}`,
      () =>
        Effect.gen(function* () {
          const twice = getting.pipe(
            Request.appendHeader("x-feature", "beta"),
            Request.appendHeader("x-feature", "dark-mode"),
          );
          const { outcome, seen } = yield* run(twice, undefined);
          expect(values(seen.headers, "x-feature")).toEqual(
            lines ? ["beta", "dark-mode"] : ["beta, dark-mode"],
          );
          expect(outcome).toMatchObject({
            route: lines ? "feature-line" : "feature-joined",
          });
          // The same value twice: header_eq refuses a repeated field even when the copies agree.
          const same = getting.pipe(
            Request.appendHeader("x-tenant", "acme"),
            Request.appendHeader("x-tenant", "acme"),
          );
          expect((yield* run(same, undefined)).outcome).toMatchObject({
            route: "other",
          });
        }),
    );

    it.live(
      `${title}: the library's automatic headers are what content routes see`,
      () =>
        Effect.gen(function* () {
          const json = Request.post("/h").pipe(
            Request.body(
              Body.jsonSchema(Schema.Struct({ name: Schema.String })),
            ),
          );
          expect(
            (yield* run(json, { body: { name: "Ada" } })).outcome,
          ).toMatchObject({
            route: "json",
          });
          const text = Request.post("/h").pipe(Request.body(Body.text));
          expect((yield* run(text, { body: "hello" })).outcome).toMatchObject({
            route: "text",
          });
          // A request's own Content-Type wins over the encoder's.
          const vendor = text.pipe(
            Request.setHeader("content-type", "application/vnd.example+json"),
          );
          expect((yield* run(vendor, { body: "{}" })).outcome).toMatchObject({
            route: "vendor",
          });
        }),
    );

    // Fetch sends `Accept: */*` when a request has none; the other providers send nothing.
    const fetchAccepts = client.name === "fetch";
    it.live(
      `${title}: removing the automatic Accept ${fetchAccepts ? "lets fetch add */*" : "leaves none"}`,
      () =>
        Effect.gen(function* () {
          const { outcome, seen } = yield* run(
            getting.pipe(Request.removeHeader("accept")),
            undefined,
          );
          expect(values(seen.headers, "accept")).toEqual(
            fetchAccepts ? ["*/*"] : [],
          );
          expect(outcome).toMatchObject({
            route: fetchAccepts ? "some-accept" : "no-accept",
          });
        }),
    );
  }
});
