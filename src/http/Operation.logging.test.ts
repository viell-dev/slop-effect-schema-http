import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, References, Schema } from "effect";
import { failureOf, recording, retries } from "../../test/operation.js";
import { empty, json, synthetic, text } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

/** A provider reply: a transient 503, then success. */
const flaky = (_: unknown, index: number) =>
  index === 0 ? empty(503) : json(200, {});

describe("Operation logging", () => {
  it.effect(
    "logs outcome categories without request or response contents",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = [];
        const capture = Logger.make((options) => {
          lines.push(Logger.formatJson.log(options));
        });
        const server = synthetic((_, index) =>
          index === 0
            ? text(503, "body-secret", { "x-leak": "header-secret" })
            : json(200, { token: "response-secret" }),
        );
        yield* Operation.make(
          Request.post("https://api.test/login?password=query-secret").pipe(
            Request.setHeader("Authorization", "Bearer header-credential"),
            Request.body(Body.json),
          ),
          Response.status(200, Body.json),
          { policy: retries(1) },
        )
          .execute({ body: { password: "body-credential" } })
          .pipe(
            Effect.provide(server.layer),
            Effect.provide(Logger.layer([capture])),
            Effect.provideService(References.MinimumLogLevel, "All"),
          );
        const output = lines.join("\n");
        expect(output).toContain("HTTP attempt completed");
        expect(output).toContain("HTTP operation completed");
        for (const secret of [
          "query-secret",
          "header-credential",
          "body-credential",
          "body-secret",
          "header-secret",
          "response-secret",
        ])
          expect(output).not.toContain(secret);
      }),
  );

  it.effect("records nothing at Effect's default minimum log level", () =>
    Effect.gen(function* () {
      const log = recording();
      const server = synthetic(flaky);
      yield* Operation.make(
        Request.get("https://api.test/items"),
        Response.status(200, Body.json),
        { policy: retries(1) },
      )
        .execute(undefined)
        .pipe(
          // A control entry at the default level shows that the logger records.
          Effect.andThen(Effect.logInfo("control")),
          Effect.provide(server.layer),
          Effect.provide(log.layer),
        );
      expect(server.exchanges).toHaveLength(2);
      expect(log.records.map((record) => record.message)).toEqual(["control"]);
    }),
  );

  it.effect(
    "records the attempt sequence at Debug with outcome annotations only",
    () =>
      Effect.gen(function* () {
        const log = recording();
        yield* Operation.make(
          Request.post("https://hidden-host.test/hidden-path"),
          Response.status(200, Body.json),
          { policy: retries(1) },
        )
          .execute(undefined)
          .pipe(
            Effect.provide(synthetic(flaky).layer),
            Effect.provide(log.layer),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
          );
        expect(
          log.records.map(({ message, level, annotations }) => ({
            message,
            level,
            annotations,
          })),
        ).toEqual([
          {
            message: "HTTP attempt started",
            level: "DEBUG",
            annotations: { "http.method": "POST", "http.attempt": 1 },
          },
          {
            message: "HTTP attempt completed",
            level: "DEBUG",
            annotations: {
              "http.method": "POST",
              "http.attempt": 1,
              "http.outcome": "failure",
              "http.status": 503,
            },
          },
          {
            message: "HTTP retrying",
            level: "DEBUG",
            annotations: { "http.attempt": 2 },
          },
          {
            message: "HTTP attempt started",
            level: "DEBUG",
            annotations: { "http.method": "POST", "http.attempt": 2 },
          },
          {
            message: "HTTP attempt completed",
            level: "DEBUG",
            annotations: {
              "http.method": "POST",
              "http.attempt": 2,
              "http.outcome": "success",
              "http.status": 200,
            },
          },
          {
            message: "HTTP operation completed",
            level: "DEBUG",
            annotations: { "http.outcome": "success" },
          },
        ]);
        for (const record of log.records) {
          expect(record.spans).toEqual(["schema-http.operation"]);
          expect(record.json).not.toContain("hidden-host");
          expect(record.json).not.toContain("hidden-path");
        }
      }),
  );

  it.effect("records only the completion when preparation fails", () =>
    Effect.gen(function* () {
      const log = recording();
      const server = synthetic(flaky);
      const exit = yield* Operation.make(
        Request.post("https://api.test/items").pipe(
          Request.body(Body.jsonSchema(Schema.Struct({ n: Schema.Finite }))),
        ),
        Response.status(200, Body.json),
        { policy: retries(1) },
      )
        .execute({ body: { n: Number.POSITIVE_INFINITY } })
        .pipe(
          Effect.provide(server.layer),
          Effect.provide(log.layer),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.exit,
        );
      expect(Schema.isSchemaError(failureOf(exit))).toBe(true);
      expect(server.exchanges).toHaveLength(0);
      expect(
        log.records.map(({ message, annotations }) => ({
          message,
          annotations,
        })),
      ).toEqual([
        {
          message: "HTTP operation completed",
          annotations: { "http.outcome": "failure" },
        },
      ]);
    }),
  );
});
