/**
 * Reports over the providers that record the fields on both sides: the host's HTTP/2 and HTTP/3
 * clients, which write each request field as given and keep the response's fields as the server
 * wrote them. They show that the gateway's repeated fields cross HTTP/2 and HTTP/3 apart, in both
 * directions, which `reports.test.ts` sees only through HTTP/1.1's lines.
 *
 * Over HTTP/2 there are three servers: the Warded Server over TLS on `https` and with prior
 * knowledge on `http`, and Hyper under `axum::serve` on `plain`. Over HTTP/3 there is only `https`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Operation, Request } from "viell-effect-schema-http";
import { lane } from "#lane";
import {
  archive,
  challenges,
  dailyReport,
  gateway,
  queuedReport,
  unauthorized,
} from "../apis/reports.js";
import {
  audit,
  auditAnswers,
  followRedirects,
  internal,
  internalAnswers,
  latest,
  queue,
} from "../apis/reports-client.js";
import {
  type Field,
  type H2Received,
  type H3Received,
  values,
} from "../harness/evidence.js";
import type { H2Provider, H3Provider } from "../harness/lane.js";
import { serve } from "../harness/matrix.js";
import { only, send } from "../harness/send.js";
import type { Table } from "../harness/table.js";

const { h2, h3 } = lane;

/** The received fields, without `date`, whose value changes, and `alt-svc`, which `https` adds. */
const fieldsOf = (received: H2Received | H3Received): ReadonlyArray<Field> =>
  received.is === "response"
    ? received.fields.filter(([name]) => name !== "date" && name !== "alt-svc")
    : [];

/** The fields a request was written with, without the pseudo-header fields. */
const regular = (fields: ReadonlyArray<Field>) =>
  fields.filter(([name]) => !name.startsWith(":"));

const protocols = [
  { name: "HTTP/2", listener: "https", server: "warded" },
  { name: "HTTP/2", listener: "http", server: "warded" },
  { name: "HTTP/2", listener: "plain", server: "hyper" },
  { name: "HTTP/3", listener: "https", server: "warded" },
] as const;

describe("reports: the fields on both sides", () => {
  for (const { name, listener, server } of protocols) {
    const title = `${name} on ${listener}`;
    // A redirect has no content. The Warded Server says so with a length of 0; Hyper's HTTP/2
    // under `axum::serve` ends the stream instead, which says the same.
    const empty: ReadonlyArray<Field> =
      server === "warded" ? [["content-length", "0"]] : [];
    const provider = (routes: Table): H2Provider | H3Provider =>
      name === "HTTP/2"
        ? h2!(routes.origins[listener])
        : h3!(routes.origins[listener]);
    const open = Effect.gen(function* () {
      const archived = yield* serve(archive);
      return yield* serve(gateway(archived.origins[listener]));
    });

    it.live(`${title}: the two Digest challenges arrive as two fields`, () =>
      Effect.gen(function* () {
        const routes = yield* open;
        const { layer, exchanges } = provider(routes);
        const sent = yield* send(
          routes,
          listener,
          layer,
          Operation.make(audit, auditAnswers),
          undefined,
        );
        const context = JSON.stringify({ sent, exchanges });
        const exchange = only(sent);
        expect(exchange.seen.version, context).toBe(name);
        expect(exchange.dispatched?.route, context).toBe("audit-challenge");
        expect(exchanges, context).toHaveLength(1);
        const { received } = exchanges[0]!;
        expect(received, context).toMatchObject({
          is: "response",
          status: 401,
        });
        expect(fieldsOf(received), context).toEqual([
          ...challenges.map((line) => ["www-authenticate", line] as const),
          ["content-type", "text/html; charset=iso-8859-1"],
          ["content-length", String(unauthorized.body!.length)],
        ]);
        // The provider attaches the fields it read, and the normalized view joins them.
        const { metadata } = sent.value!;
        expect(
          Option.map(metadata.headerLines, (lines) =>
            values(lines, "www-authenticate"),
          ),
          context,
        ).toEqual(Option.some(challenges));
        expect(metadata.headers["www-authenticate"], context).toBe(
          challenges.join(", "),
        );
      }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: two X-Forwarded-For fields stay two, which header_eq refuses`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open;
          const ask = (request: typeof internal) =>
            Effect.gen(function* () {
              const { layer, exchanges } = provider(routes);
              const sent = yield* send(
                routes,
                listener,
                layer,
                Operation.make(request, internalAnswers),
                undefined,
              );
              expect(exchanges, JSON.stringify(sent)).toHaveLength(1);
              return { sent, written: regular(exchanges[0]!.fields) };
            });

          const trusted = yield* ask(
            internal.pipe(
              Request.setHeader({
                "x-forwarded-for": "10.0.0.5",
                "x-forwarded-proto": "https",
              }),
            ),
          );
          expect(values(trusted.written, "x-forwarded-for")).toEqual([
            "10.0.0.5",
          ]);
          expect(only(trusted.sent).dispatched?.route).toBe("internal");
          expect(trusted.sent.value).toMatchObject({ _tag: "Internal" });

          // HTTP/2 and HTTP/3 have no lines to join: the provider writes the two declared lines as
          // two fields, the server keeps them apart, and `header_eq` misses a repeated field.
          const repeated = yield* ask(
            internal.pipe(
              Request.appendHeader("x-forwarded-for", "10.0.0.5"),
              Request.appendHeader("x-forwarded-for", "203.0.113.9"),
              Request.setHeader("x-forwarded-proto", "https"),
            ),
          );
          const context = JSON.stringify(repeated);
          expect(values(repeated.written, "x-forwarded-for"), context).toEqual([
            "10.0.0.5",
            "203.0.113.9",
          ]);
          const exchange = only(repeated.sent);
          expect(
            values(exchange.seen.headers, "x-forwarded-for"),
            context,
          ).toEqual(["10.0.0.5", "203.0.113.9"]);
          expect(exchange.dispatched?.route, context).toBe("internal-denied");
          expect(exchange.status, context).toBe(403);
          expect(repeated.sent.value, context).toMatchObject({
            _tag: "Forbidden",
            metadata: { status: 403 },
          });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a redirect's Location goes out as written, and Effect's middleware follows it on the same protocol`,
      () =>
        Effect.gen(function* () {
          const routes = yield* open;

          // The provider builds a Fetch response and follows nothing.
          const once = provider(routes);
          const handed = yield* send(
            routes,
            listener,
            once.layer,
            latest,
            undefined,
          );
          expect(once.exchanges, JSON.stringify(handed)).toHaveLength(1);
          expect(fieldsOf(once.exchanges[0]!.received)).toEqual([
            ["location", `/reports/${dailyReport.date}`],
            ...empty,
          ]);
          expect(handed.value, JSON.stringify(handed)).toMatchObject({
            _tag: "Redirect",
            metadata: {
              status: 302,
              headers: { location: `/reports/${dailyReport.date}` },
            },
          });

          const twice = provider(routes);
          const followed = yield* send(
            routes,
            listener,
            twice.layer,
            latest.pipe(Operation.mapOptions(() => followRedirects)),
            undefined,
          );
          const context = JSON.stringify({ followed, twice: twice.exchanges });
          expect(
            twice.exchanges.map(({ fields }) => values(fields, ":path")),
            context,
          ).toEqual([["/reports/latest"], [`/reports/${dailyReport.date}`]]);
          expect(
            followed.exchanges.map(({ seen, dispatched, status }) => [
              seen.version,
              dispatched?.route,
              status,
            ]),
            context,
          ).toEqual([
            [name, "latest", 302],
            [name, "dated", 200],
          ]);
          expect(followed.value, context).toMatchObject({
            _tag: "Report",
            value: dailyReport,
          });

          // After a 303 the middleware writes a GET with no content fields: the form's
          // `Content-Type` and `Content-Length` went with its body, and the contract's automatic
          // `Accept` stays.
          const form = provider(routes);
          const queued = yield* send(
            routes,
            listener,
            form.layer,
            queue.pipe(Operation.mapOptions(() => followRedirects)),
            { body: { name: "daily" } },
          );
          const written = JSON.stringify({ queued, form: form.exchanges });
          expect(
            form.exchanges.map(({ fields }) => [
              values(fields, ":method")[0],
              values(fields, ":path")[0],
              regular(fields),
            ]),
            written,
          ).toEqual([
            [
              "POST",
              "/cgi-bin/report.cgi",
              [
                ["content-type", "application/x-www-form-urlencoded"],
                ["content-length", "10"],
                ["accept", "application/json"],
              ],
            ],
            [
              "GET",
              `/reports/queued/${queuedReport.id}`,
              [["accept", "application/json"]],
            ],
          ]);
          expect(fieldsOf(form.exchanges[0]!.received), written).toEqual([
            ["location", `/reports/queued/${queuedReport.id}`],
            ...empty,
          ]);
          expect(queued.value, written).toMatchObject({
            _tag: "Queued",
            value: queuedReport,
          });
        }).pipe(Effect.scoped),
    );
  }
});
