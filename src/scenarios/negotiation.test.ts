/**
 * Negotiation: the library's automatic `Accept` and declared language and encoding preferences
 * against Warded's offer sets, and the server's answer against the library's ordered response cases.
 *
 * Both sides select in order: a Warded table tries its routes in declaration order, and a library
 * contract tries its cases in declaration order. An offer set's tie between equal weights goes to
 * the server's first offer, not the client's first range; the library writes its decoders' media
 * types in declaration order without weights, which states no preference.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { values } from "../harness/evidence.js";
import { cases, serve } from "../harness/matrix.js";
import { and, exactPath, get, route, selected } from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";
import type { Definition } from "../harness/routes.js";

const Report = Schema.Struct({ total: Schema.Number });

const reports: Definition = {
  offers: {
    formats: { field: "media_types", values: ["application/json", "text/csv"] },
  },
  routes: [
    route(
      "json",
      and(get(), exactPath("/report"), selected("formats", "application/json")),
      {
        status: 200,
        headers: [
          ["content-type", "application/json"],
          ["vary", "accept"],
        ],
        body: '{"total":3}',
      },
    ),
    route(
      "csv",
      and(get(), exactPath("/report"), selected("formats", "text/csv")),
      {
        status: 200,
        headers: [
          ["content-type", "text/csv"],
          ["vary", "accept"],
        ],
        body: "total\n3\n",
      },
    ),
    route("not-acceptable", and(get(), exactPath("/report")), { status: 406 }),
  ],
};

const contentType = (type: string) => (metadata: Response.Metadata) =>
  metadata.status === 200 &&
  metadata.headers["content-type"]?.split(";", 1)[0]?.trim() === type;
const asJson = Response.when(
  contentType("application/json"),
  Response.tag("Json", Body.jsonSchema(Report)),
);
const asCsv = Response.when(
  contentType("text/csv"),
  Response.tag("Csv", Body.decoder(Body.text.decode, "text/csv")),
);
const refused = Response.status(406, Response.tag("Refused", Body.empty));

const pages: Definition = {
  offers: {
    languages: {
      field: "languages",
      values: ["en", "fr", "de"],
      mode: "lookup",
    },
    strict: { field: "languages", values: ["en", "fr"], mode: "lookup" },
  },
  routes: [
    route("english", and(exactPath("/welcome"), selected("languages", "en"))),
    route("french", and(exactPath("/welcome"), selected("languages", "fr"))),
    route("german", and(exactPath("/welcome"), selected("languages", "de"))),
    route("default", exactPath("/welcome")),
    route(
      "strict-french",
      and(exactPath("/strict"), selected("strict", "fr", true)),
    ),
    route("strict-default", exactPath("/strict")),
  ],
};

const welcome = operation(Request.get("/welcome"));
const inFrench = welcome.pipe(
  Operation.mapRequest(Request.setHeader("accept-language", "fr")),
);

describe("negotiation", () => {
  for (const { client, listener, title } of cases()) {
    it.live(
      `${title}: the response contract's Accept chooses the representation`,
      () =>
        Effect.gen(function* () {
          const table = yield* serve(reports);
          const both = Operation.make(
            Request.get("/report"),
            asJson.pipe(Response.orElse(asCsv), Response.orElse(refused)),
          );
          const sent = yield* send(table, listener, client, both, undefined);
          expect(values(only(sent).seen.headers, "accept")).toEqual([
            "application/json, text/csv",
          ]);
          expect(sent.value).toMatchObject({
            _tag: "Json",
            value: { total: 3 },
          });

          // Only CSV is understood, so only CSV is asked for, and the CSV route answers.
          const csvOnly = Operation.make(
            Request.get("/report"),
            asCsv.pipe(Response.orElse(refused)),
          );
          const csv = yield* send(table, listener, client, csvOnly, undefined);
          expect(values(only(csv).seen.headers, "accept")).toEqual([
            "text/csv",
          ]);
          expect(csv.value).toMatchObject({ _tag: "Csv", value: "total\n3\n" });

          // Declaring CSV first states no preference: equal weights go to the server's first offer.
          const csvFirst = Operation.make(
            Request.get("/report"),
            asCsv.pipe(Response.orElse(asJson), Response.orElse(refused)),
          );
          const tie = yield* send(table, listener, client, csvFirst, undefined);
          expect(values(only(tie).seen.headers, "accept")).toEqual([
            "text/csv, application/json",
          ]);
          expect(tie.value).toMatchObject({ _tag: "Json" });

          // A weighted Accept the caller declares replaces the automatic one, and decides.
          const preferCsv = csvFirst.pipe(
            Operation.mapRequest(
              Request.setHeader("accept", "text/csv, application/json;q=0.5"),
            ),
          );
          expect(
            (yield* send(table, listener, client, preferCsv, undefined)).value,
          ).toMatchObject({ _tag: "Csv" });

          // Nothing the server offers is acceptable: its 406 is a case the contract declares.
          const xml = Operation.make(
            Request.get("/report").pipe(
              Request.setHeader("accept", "application/xml"),
            ),
            asJson.pipe(Response.orElse(refused)),
          );
          expect(
            (yield* send(table, listener, client, xml, undefined)).value,
          ).toMatchObject({ _tag: "Refused" });
        }).pipe(Effect.scoped),
    );

    it.live(`${title}: a variant's Accept-Language selects the language`, () =>
      Effect.gen(function* () {
        const table = yield* serve(pages);
        expect(
          (yield* send(table, listener, client, inFrench, undefined)).outcome,
        ).toMatchObject({ route: "french" });
        // The original is unchanged, and a client that sends no language, or `*`, gets the first
        // offer.
        const original = yield* send(
          table,
          listener,
          client,
          welcome,
          undefined,
        );
        expect(original.outcome).toMatchObject({ route: "english" });

        const weighted = welcome.pipe(
          Operation.mapRequest(
            Request.setHeader("accept-language", "fr-CA, fr;q=0.9, en;q=0.5"),
          ),
        );
        expect(
          (yield* send(table, listener, client, weighted, undefined)).outcome,
        ).toMatchObject({ route: "french" });
        const highest = welcome.pipe(
          Operation.mapRequest(
            Request.setHeader("accept-language", "en;q=0.2, de;q=0.8"),
          ),
        );
        expect(
          (yield* send(table, listener, client, highest, undefined)).outcome,
        ).toMatchObject({ route: "german" });
        // Nothing offered is acceptable, or the field is malformed: every language route misses.
        for (const field of ["es", "fr;q=2"]) {
          const other = welcome.pipe(
            Operation.mapRequest(Request.setHeader("accept-language", field)),
          );
          expect(
            (yield* send(table, listener, client, other, undefined)).outcome,
          ).toMatchObject({ route: "default" });
        }
      }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a malformed field that a route declares an error is a 400`,
      () =>
        Effect.gen(function* () {
          const table = yield* serve(pages);
          const strict = operation(
            Request.get("/strict").pipe(
              Request.setHeader("accept-language", "fr;q=2"),
            ),
          );
          const sent = yield* send(table, listener, client, strict, undefined);
          expect(sent.outcome).toMatchObject({ kind: "answered", status: 400 });
          expect(only(sent).verdict).toMatchObject({ is: "failed" });
          const valid = strict.pipe(
            Operation.mapRequest(Request.setHeader("accept-language", "fr")),
          );
          expect(
            (yield* send(table, listener, client, valid, undefined)).outcome,
          ).toMatchObject({ route: "strict-french" });
        }).pipe(Effect.scoped),
    );
  }
});
