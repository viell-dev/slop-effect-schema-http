/**
 * Parcels over the providers that record what came back: the host's HTTP/2 and HTTP/3 clients,
 * whose exchanges hold the response's fields and content as the server wrote them, and the
 * line-preserving provider, which attaches the lines it read. They show what the server did with a
 * handler's answer before the library saw it, which `parcels.test.ts` can only infer.
 *
 * Over HTTP/2 the comparison has three servers: the Warded Server over TLS on `https` and with
 * prior knowledge on `http`, and Hyper under `axum::serve` on `plain`, which runs none of the
 * Warded Server's finishing. Over HTTP/3 there is only `https`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Operation, Request } from "viell-effect-schema-http";
import { lane } from "#lane";
import { diagnostics, parcels, sessionCookies } from "../apis/parcels.js";
import { getDiagnostic, login } from "../apis/parcels-client.js";
import {
  type H2Received,
  type H3Received,
  values,
} from "../harness/evidence.js";
import type { H2Provider, H3Provider } from "../harness/lane.js";
import { serve } from "../harness/matrix.js";
import { only, send } from "../harness/send.js";
import type { Table } from "../harness/table.js";

const { h2, h3, lines } = lane;

/** The text of a received body, which the host's clients give in base64. */
const content = (received: H2Received | H3Received) =>
  received.is === "response"
    ? Buffer.from(received.body, "base64").toString("latin1")
    : undefined;

/** The received fields, without `date`, whose value changes. */
const fieldsOf = (received: H2Received | H3Received) =>
  received.is === "response"
    ? received.fields.filter(([name]) => name !== "date")
    : undefined;

const protocols = [
  { name: "HTTP/2", listener: "https", server: "warded" },
  { name: "HTTP/2", listener: "http", server: "warded" },
  { name: "HTTP/2", listener: "plain", server: "hyper" },
  { name: "HTTP/3", listener: "https", server: "warded" },
] as const;

describe("parcels: what the server wrote", () => {
  for (const { name, listener, server } of protocols) {
    const title = `${name} on ${listener}`;
    const provider = (routes: Table): H2Provider | H3Provider =>
      name === "HTTP/2"
        ? h2!(routes.origins[listener])
        : h3!(routes.origins[listener]);
    const diagnose = (routes: Table, status: number) =>
      Effect.gen(function* () {
        const { layer, exchanges } = provider(routes);
        const sent = yield* send(routes, listener, layer, getDiagnostic, {
          path: { code: String(status) },
        });
        expect(exchanges, JSON.stringify(sent)).toHaveLength(1);
        const exchange = only(sent);
        expect(exchange.seen.version).toBe(name);
        // The handler's own status, whatever went out.
        expect(exchange.status).toBe(status);
        return { sent, received: exchanges[0]!.received };
      });

    it.live(
      `${title}: an informational status goes out as the server's own 500, or not at all`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          for (const status of [100, 101, 103, 199]) {
            const { sent, received } = yield* diagnose(routes, status);
            const context = `${status}: ${JSON.stringify({ sent, received })}`;
            if (server === "warded") {
              // A 500 of the server's own, with none of the response's fields: not the `link` of
              // the 103, and not the `alt-svc` that every other answer on `https` carries.
              expect(received, context).toMatchObject({
                is: "response",
                status: 500,
                body: "",
              });
              expect(fieldsOf(received), context).toEqual([
                ["content-length", "0"],
              ]);
              expect(sent.value, context).toMatchObject({
                _tag: "Answer",
                value: "",
                metadata: { status: 500 },
              });
            } else {
              // Hyper's HTTP/2 sends the informational head and ends the stream, which RFC 9113
              // section 8.1 makes a malformed response. The provider fails it as a transport error.
              expect(received, context).toEqual({
                is: "interim",
                statuses: [status],
              });
              expect(sent.outcome, context).toMatchObject({
                kind: "failure",
                tag: "HttpClientError/TransportError",
              });
            }
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: 204, 205 and 304 go out without content where the server finishes them`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          for (const status of [204, 205, 304]) {
            const { sent, received } = yield* diagnose(routes, status);
            const context = `${status}: ${JSON.stringify({ sent, received })}`;
            const written = diagnostics[String(status)]!;
            const type = written.headers?.find(
              ([field]) => field === "content-type",
            )?.[1];
            expect(received, context).toMatchObject({ is: "response", status });
            const fields = (fieldsOf(received) ?? []).filter(
              ([field]) => field !== "alt-svc",
            );
            if (server === "warded") {
              // The content is gone, and a 205 says so with a length of 0, as RFC 9110 section
              // 15.3.6 asks.
              expect(content(received), context).toBe("");
              expect(fields, context).toEqual([
                ["content-type", type!],
                ...(status === 205 ? [["content-length", "0"]] : []),
              ]);
            } else {
              // Hyper's HTTP/2 sends the handler's content, with its length, for all three. Not
              // either project's: the Warded Server's finishing exists for this.
              expect(content(received), context).toBe(written.body);
              expect(fields, context).toEqual([
                ["content-type", type!],
                ["content-length", String(written.body!.length)],
              ]);
            }
            // Like Fetch, the provider gives these statuses no body.
            expect(sent.value, context).toMatchObject({
              _tag: "Answer",
              value: "",
              metadata: { status },
            });
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: 600 and 999 go out as written, past what a Fetch response can hold`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(parcels);
          for (const status of [600, 999]) {
            const { sent, received } = yield* diagnose(routes, status);
            const context = `${status}: ${JSON.stringify({ sent, received })}`;
            expect(received, context).toMatchObject({ is: "response", status });
            expect(content(received), context).toBe(
              diagnostics[String(status)]!.body,
            );
            // The provider builds a Fetch `Response`, which takes 200 to 599 only.
            expect(sent.outcome, context).toMatchObject({
              kind: "failure",
              tag: "HttpClientError/TransportError",
            });
          }
        }).pipe(Effect.scoped),
    );

    it.live(`${title}: the login's Set-Cookie fields stay apart`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(parcels);
        const { layer, exchanges } = provider(routes);
        const sent = yield* send(routes, listener, layer, login, undefined);
        const context = JSON.stringify({ sent, exchanges });
        expect(only(sent).dispatched?.route, context).toBe("session");
        const received = exchanges[0]!.received;
        expect(values(fieldsOf(received) ?? [], "set-cookie"), context).toEqual(
          sessionCookies,
        );
        const { metadata } = sent.value!;
        expect(
          Option.map(metadata.headerLines, (attached) =>
            values(attached, "set-cookie"),
          ),
          context,
        ).toEqual(Option.some(sessionCookies));
        // As through every provider: one cookie for each name, the later `sid`'s, pinned in
        // `parcels.test.ts` with its issue.
        expect(
          Object.fromEntries(
            Object.entries(metadata.cookies.cookies).map(([cookie, value]) => [
              cookie,
              value.value,
            ]),
          ),
          context,
        ).toEqual({ sid: "", csrf: "c-2" });
      }).pipe(Effect.scoped),
    );
  }

  for (const listener of ["plain", "http"] as const) {
    it.live(
      `lines on ${listener}: the 500 for an informational status keeps none of the response's fields`,
      () =>
        Effect.gen(function* () {
          // As the browser lane serves it: CORS fields on every answer to a page's origin.
          const routes = yield* serve(parcels, { cors: true });
          const fromPage = getDiagnostic.pipe(
            Operation.mapRequest(
              Request.setHeader("origin", "http://page.test"),
            ),
          );
          const linesOf = (status: number) =>
            send(routes, listener, lines!, fromPage, {
              path: { code: String(status) },
            }).pipe(
              Effect.map((sent) => {
                expect(only(sent).status).toBe(status);
                const { metadata } = sent.value!;
                return {
                  status: metadata.status,
                  origin: Option.map(metadata.headerLines, (attached) =>
                    values(attached, "access-control-allow-origin"),
                  ),
                };
              }),
            );
          // This is why a page cannot read it: the replacement drops what the CORS layer added.
          expect(yield* linesOf(103)).toEqual({
            status: 500,
            origin: Option.some([]),
          });
          expect(yield* linesOf(299)).toEqual({
            status: 299,
            origin: Option.some(["http://page.test"]),
          });
        }).pipe(Effect.scoped),
    );
  }
});
