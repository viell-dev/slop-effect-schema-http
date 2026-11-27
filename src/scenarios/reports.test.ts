/**
 * Reports: the library against a CGI-style reporting gateway built on Warded, the table in
 * `src/apis/reports.ts`, through every provider of the lane on every listener.
 *
 * Warded decides what each request reaches from its head: forwarded fields compared as whole bytes,
 * a query split on `&` alone, and an `Authorization` field. The handlers answer with the gateway's
 * conventions: JSONP, a Digest challenge, and redirects of every kind. The judge is the library's
 * documentation: a query written in a constructor goes out as written, and its entries are read
 * with semicolons as data; a decoder's media type does not check the response's; a contract
 * selects on metadata alone, and the metadata holds the response's headers as the provider shows
 * them; and redirects are the provider's, with Fetch's policies in a browser. Each exchange also
 * keeps the request's records and the status the handler answered.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { Operation, Request } from "viell-effect-schema-http";
import { lane } from "#lane";
import {
  annualReport,
  archive,
  auditLog,
  callback,
  challenge,
  challenges,
  credentials,
  dailyCsv,
  dailyReport,
  dailyScript,
  digestAuthorization,
  gateway,
  internalReport,
  queuedReport,
  trustedHop,
  unauthorized,
} from "../apis/reports.js";
import {
  annual,
  asJson,
  asScript,
  audit,
  auditAnswers,
  auditOnly,
  digestChallenges,
  digestResponse,
  followRedirects,
  forwardedInternal,
  internal,
  internalAnswers,
  jsonpRequest,
  latest,
  legacyPage,
  loop,
  queue,
  reportAnswers,
  script,
  semicolons,
  unwrapped,
} from "../apis/reports-client.js";
import { bodyText, values } from "../harness/evidence.js";
import type { Client, Listener } from "../harness/lane.js";
import { cases, onHttp3, serve } from "../harness/matrix.js";
import { collect, expectHops, type Sent, send } from "../harness/send.js";
import type { Table } from "../harness/table.js";

/**
 * Open the archive and the gateway that redirects to it, on the same kind of listener. These tests
 * count every request a call makes, so in a browser on `https` the gateway is used until Chromium
 * has moved to HTTP/3.
 */
const open = (
  client: Client,
  listener: Listener,
): Effect.Effect<
  { readonly routes: Table; readonly archived: Table },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const archived = yield* serve(archive);
    const routes = yield* serve(gateway(archived.origins[listener]));
    yield* onHttp3(
      routes,
      listener,
      client,
      Operation.make(Request.get("/reports/daily"), reportAnswers),
    );
    return { routes, archived };
  });

/** Fetch follows redirects itself; Effect's clients on undici and `node:http`, and this suite's, do not. */
const follows = (client: Client) => client.name === "fetch";

describe("reports", () => {
  for (const { client, listener, title } of cases()) {
    it.live(
      `${title}: only the trusted hop's forwarded fields reach the internal report`,
      () =>
        Effect.gen(function* () {
          const { routes } = yield* open(client, listener);
          const ask = (request: typeof internal) =>
            send(
              routes,
              listener,
              client,
              Operation.make(request, internalAnswers),
              undefined,
            );
          const reached = (sent: Sent) =>
            expectHops(routes, sent, listener, [
              { route: "internal", path: "/reports/internal", status: 200 },
            ])[0]!;
          const refused = (sent: Sent) => {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Forbidden",
              value:
                "Forbidden: internal reports are for the office network.\n",
              metadata: { status: 403 },
            });
            return expectHops(routes, sent, listener, [
              {
                route: "internal-denied",
                path: "/reports/internal",
                status: 403,
              },
            ])[0]!;
          };

          // The suite stands in for the edge and declares the fields it writes, which every
          // provider sends as declared, a browser's `fetch` included: Fetch forbids none of them.
          const legacy = yield* ask(
            internal.pipe(
              Request.setHeader({
                "x-forwarded-for": trustedHop["x-forwarded-for"],
                "x-forwarded-proto": trustedHop["x-forwarded-proto"],
              }),
            ),
          );
          expect(legacy.value, JSON.stringify(legacy)).toMatchObject({
            _tag: "Internal",
            value: internalReport,
            metadata: { status: 200 },
          });
          const { seen } = reached(legacy);
          expect(values(seen.headers, "x-forwarded-for")).toEqual(["10.0.0.5"]);
          expect(values(seen.headers, "x-forwarded-proto")).toEqual(["https"]);

          // RFC 7239's field through a header schema: its quotes and brackets reach Warded's byte
          // comparison as written.
          const standard = yield* send(
            routes,
            listener,
            client,
            Operation.make(forwardedInternal, internalAnswers),
            { headers: { forwarded: trustedHop.forwarded } },
          );
          expect(standard.value, JSON.stringify(standard)).toMatchObject({
            _tag: "Internal",
          });
          expect(values(reached(standard).seen.headers, "forwarded")).toEqual([
            'for="[2001:db8:cafe::5]";proto=https',
          ]);

          // A client that sent its own `X-Forwarded-For` has the edge's address appended to it. The
          // field no longer equals the trusted hop, so `header_eq` misses.
          const spoofed = yield* ask(
            internal.pipe(
              Request.setHeader({
                "x-forwarded-for": "10.0.0.5, 203.0.113.9",
                "x-forwarded-proto": "https",
              }),
            ),
          );
          expect(
            values(refused(spoofed).seen.headers, "x-forwarded-for"),
          ).toEqual(["10.0.0.5, 203.0.113.9"]);

          // The same two addresses on two lines. Effect's standard clients and Chromium join them
          // into the one field above; the line-preserving provider keeps two, which `header_eq`
          // refuses as a repeated field. Either way the gateway refuses them.
          const repeated = yield* ask(
            internal.pipe(
              Request.appendHeader("x-forwarded-for", "10.0.0.5"),
              Request.appendHeader("x-forwarded-for", "203.0.113.9"),
              Request.setHeader("x-forwarded-proto", "https"),
            ),
          );
          expect(
            values(refused(repeated).seen.headers, "x-forwarded-for"),
          ).toEqual(
            client.name === "lines"
              ? ["10.0.0.5", "203.0.113.9"]
              : ["10.0.0.5, 203.0.113.9"],
          );

          // The trusted hop without TLS at the edge, and a request with no forwarded fields at all.
          refused(
            yield* ask(
              internal.pipe(
                Request.setHeader({
                  "x-forwarded-for": "10.0.0.5",
                  "x-forwarded-proto": "http",
                }),
              ),
            ),
          );
          const direct = refused(yield* ask(internal));
          expect(values(direct.seen.headers, "x-forwarded-for")).toEqual([]);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: the script's ; is data to the library and to Warded alike`,
      () =>
        Effect.gen(function* () {
          const { routes } = yield* open(client, listener);
          const ask = <I, E>(request: Request.Request<I, E>, input: I) =>
            send(
              routes,
              listener,
              client,
              Operation.make(request, reportAnswers),
              input,
            );
          const at = { path: "/cgi-bin/report.cgi" } as const;
          const csv = (sent: Sent, query: string) => {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Csv",
              value: dailyCsv,
              metadata: { status: 200 },
            });
            return expectHops(routes, sent, listener, [
              { ...at, route: "report-csv", status: 200, query },
            ])[0]!;
          };
          const refused = (sent: Sent, query: string) => {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Refused",
              value: "report.cgi: no report named\n",
              metadata: { status: 400 },
            });
            expectHops(routes, sent, listener, [
              { ...at, route: "no-report", status: 400, query },
            ]);
          };

          // Entries from `setQuery` go out joined by `&`, which both conditions of the route read.
          const fields = yield* ask(
            script.pipe(Request.setQuery({ name: "daily", format: "csv" })),
            undefined,
          );
          const { seen } = csv(fields, "name=daily&format=csv");
          // Both decoders' media types, in declaration order.
          expect(values(seen.headers, "accept")).toEqual([
            "text/plain, application/json",
          ]);

          // A query written in the constructor goes out as written, so the `;` reaches the gateway.
          // Warded splits on `&` alone: the piece is the key `name` with the value
          // `daily;format=csv`, which is the spelling the route names.
          csv(
            yield* ask(
              Request.get("/cgi-bin/report.cgi?name=daily;format=csv"),
              undefined,
            ),
            "name=daily;format=csv",
          );
          // The same entries in the other order make the key `format`, and no route reads a report
          // name from it, though the script itself would.
          refused(
            yield* ask(
              Request.get("/cgi-bin/report.cgi?format=csv;name=daily"),
              undefined,
            ),
            "format=csv;name=daily",
          );
          // A query policy that joins entries with `;`, for a service that wants it.
          csv(
            yield* ask(
              script.pipe(Request.setQuery({ name: "daily", format: "csv" })),
              undefined,
            ).pipe(Effect.provide(semicolons)),
            "name=daily;format=csv",
          );
          // A `;` in a value is data, which the default encoding escapes, so it separates nothing.
          refused(
            yield* ask(
              script.pipe(Request.setQuery("name", "daily;format=csv")),
              undefined,
            ),
            "name=daily%3Bformat%3Dcsv",
          );
          // The library reads the written entry as Warded does: one entry `name` whose value holds
          // the `;`. So there is no `format` to remove, and `name` is replaced whole.
          csv(
            yield* ask(
              Request.get("/cgi-bin/report.cgi?name=daily;format=csv").pipe(
                Request.removeQuery("format"),
              ),
              undefined,
            ),
            "name=daily;format=csv",
          );
          const edited = yield* ask(
            Request.get("/cgi-bin/report.cgi?name=daily;format=csv").pipe(
              Request.setQuery("name", "daily"),
            ),
            undefined,
          );
          expect(edited.value, JSON.stringify(edited)).toMatchObject({
            _tag: "Report",
            value: dailyReport,
          });
          expectHops(routes, edited, listener, [
            { ...at, route: "report", status: 200, query: "name=daily" },
          ]);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: JSONP decodes as text, and through a schema once unwrapped`,
      () =>
        Effect.gen(function* () {
          const { routes } = yield* open(client, listener);
          const query = `name=daily&callback=${callback}`;
          const jsonp = {
            path: "/cgi-bin/report.cgi",
            route: "jsonp",
            status: 200,
            query,
          } as const;

          // `Body.text` reads the script whatever its media type, and asks for `text/plain`, which
          // the endpoint does not read.
          const script = yield* send(
            routes,
            listener,
            client,
            Operation.make(jsonpRequest(callback), asScript),
            undefined,
          );
          expect(script.value, JSON.stringify(script)).toMatchObject({
            _tag: "Script",
            value: dailyScript,
            metadata: {
              status: 200,
              headers: { "content-type": "text/javascript; charset=utf-8" },
            },
          });
          const [exchange] = expectHops(routes, script, listener, [jsonp]);
          expect(values(exchange!.seen.headers, "accept")).toEqual([
            "text/plain",
          ]);

          // The callback's argument, cut from the text and decoded with a schema.
          const report = yield* send(
            routes,
            listener,
            client,
            Operation.make(jsonpRequest(callback), unwrapped(callback)),
            undefined,
          );
          expect(report.value, JSON.stringify(report)).toMatchObject({
            _tag: "Report",
            value: dailyReport,
          });
          expectHops(routes, report, listener, [jsonp]);

          // A JSON decoder does not check the media type, so it is selected and fails on the
          // script, and that failure is final.
          const json = yield* send(
            routes,
            listener,
            client,
            Operation.make(jsonpRequest(callback), asJson),
            undefined,
          );
          expect(json.outcome).toEqual({
            kind: "failure",
            tag: "DecodeError",
            message:
              "The body of the status 200 response could not be read; see cause",
          });
          expectHops(routes, json, listener, [jsonp]);

          // Any other callback name is refused, not echoed into a script.
          const other = yield* send(
            routes,
            listener,
            client,
            Operation.make(jsonpRequest("steal"), asScript),
            undefined,
          );
          expect(other.value, JSON.stringify(other)).toMatchObject({
            _tag: "Refused",
            value: "report.cgi: invalid callback\n",
            metadata: { status: 400 },
          });
          expectHops(routes, other, listener, [
            {
              path: "/cgi-bin/report.cgi",
              route: "jsonp-refused",
              status: 400,
              query: "name=daily&callback=steal",
            },
          ]);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: the Digest challenge reaches the metadata, and its answer the audit`,
      () =>
        Effect.gen(function* () {
          const { routes } = yield* open(client, listener);
          const at = { path: "/reports/audit" } as const;

          const asked = yield* send(
            routes,
            listener,
            client,
            Operation.make(audit, auditAnswers),
            undefined,
          );
          const context = JSON.stringify(asked);
          expect(asked.value, context).toMatchObject({
            _tag: "Challenge",
            value: unauthorized.body,
            metadata: { status: 401 },
          });
          expectHops(routes, asked, listener, [
            { ...at, route: "audit-challenge", status: 401 },
          ]);
          const { metadata } = asked.value!;
          // Every provider shows the challenges, Chromium too, since the CORS layer exposes every
          // field to the page. The normalized view joins the two lines with ", ", which a client
          // can still split, since each challenge starts with its scheme; only the line-preserving
          // provider attaches them as they came.
          const www = metadata.headers["www-authenticate"]!;
          expect(www, context).toBe(challenges.join(", "));
          expect(
            Option.map(metadata.headerLines, (lines) =>
              values(lines, "www-authenticate"),
            ),
            context,
          ).toEqual(
            client.name === "lines" ? Option.some(challenges) : Option.none(),
          );

          // The client answers the challenge it prefers, the first, with SHA-256.
          const [preferred, fallback] = digestChallenges(www);
          expect(preferred).toEqual({
            realm: challenge.realm,
            qop: "auth",
            algorithm: "SHA-256",
            nonce: challenge.nonce,
            opaque: challenge.opaque,
          });
          expect(fallback).toMatchObject({ algorithm: "MD5" });
          const response = yield* digestResponse({
            username: credentials.username,
            password: credentials.password,
            realm: preferred!["realm"]!,
            nonce: preferred!["nonce"]!,
            nc: credentials.nc,
            cnonce: credentials.cnonce,
            method: "GET",
            uri: at.path,
          });
          expect(response).toBe(credentials.response);
          const signed = yield* send(
            routes,
            listener,
            client,
            Operation.make(
              audit.pipe(
                Request.setHeader(
                  "authorization",
                  digestAuthorization(response),
                ),
              ),
              auditAnswers,
            ),
            undefined,
          );
          expect(signed.value, JSON.stringify(signed)).toMatchObject({
            _tag: "Audit",
            value: auditLog,
            metadata: { status: 200 },
          });
          const [exchange] = expectHops(routes, signed, listener, [
            { ...at, route: "audit", status: 200 },
          ]);
          expect(values(exchange!.seen.headers, "authorization")).toEqual([
            digestAuthorization(credentials.response),
          ]);

          // A contract without the 401 fails with `UnexpectedResponse`, whose message gives the
          // status alone and whose metadata keeps the challenge.
          const unexpected = yield* collect(
            routes,
            Operation.make(
              Request.get(`${routes.origins[listener]}${at.path}`),
              auditOnly,
            )
              .execute(undefined)
              .pipe(Effect.flip, Effect.provide(client.layer)),
          );
          expect(unexpected.value, JSON.stringify(unexpected)).toMatchObject({
            _tag: "UnexpectedResponse",
            message: "No response case matched status 401",
            metadata: {
              status: 401,
              headers: { "www-authenticate": challenges.join(", ") },
            },
          });
          expectHops(routes, unexpected, listener, [
            { ...at, route: "audit-challenge", status: 401 },
          ]);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a temporary redirect ${follows(client) ? "is followed by fetch, before Effect's middleware sees it" : "is handed over, and Effect's middleware follows it"}`,
      () =>
        Effect.gen(function* () {
          const { routes } = yield* open(client, listener);
          const hops = [
            { route: "latest", path: "/reports/latest", status: 302 },
            {
              route: "dated",
              path: `/reports/${dailyReport.date}`,
              status: 200,
              captures: { date: dailyReport.date },
            },
          ] as const;

          const sent = yield* send(routes, listener, client, latest, undefined);
          if (follows(client)) {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Report",
              value: dailyReport,
              metadata: { status: 200 },
            });
            expectHops(routes, sent, listener, hops);
          } else {
            // The library receives the 302 itself, with `Location` as the server wrote it.
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Redirect",
              metadata: {
                status: 302,
                headers: { location: `/reports/${dailyReport.date}` },
              },
            });
            expectHops(routes, sent, listener, hops.slice(0, 1));
          }

          // With the middleware every provider ends at the report: Fetch has followed already, and
          // the middleware follows for the others.
          const followed = yield* send(
            routes,
            listener,
            client,
            latest.pipe(Operation.mapOptions(() => followRedirects)),
            undefined,
          );
          expect(followed.value, JSON.stringify(followed)).toMatchObject({
            _tag: "Report",
            value: dailyReport,
          });
          expectHops(routes, followed, listener, hops);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: permanent redirects to a relative path and to another origin`,
      () =>
        Effect.gen(function* () {
          const { routes, archived } = yield* open(client, listener);
          // Chromium caches a permanent redirect that carries no freshness of its own, as RFC 9111
          // allows for the statuses RFC 9110 makes heuristically cacheable, 301 and 308 among them.
          // So its second request for one goes straight to the target. Node's clients keep no cache.
          const cached = lane.name === "browser";
          const page = {
            route: "legacy-page",
            path: "/reports/daily.html",
            status: 301,
            captures: { name: "daily" },
          } as const;
          const daily = {
            route: "dated",
            path: "/reports/daily",
            status: 200,
            captures: { date: "daily" },
          } as const;

          // `Location: daily` is relative to `/reports/daily.html`. Fetch resolves it, and so does
          // Effect's middleware, against the request's URL.
          const moved = yield* send(
            routes,
            listener,
            client,
            legacyPage,
            undefined,
          );
          if (follows(client)) {
            expect(moved.value, JSON.stringify(moved)).toMatchObject({
              _tag: "Report",
              value: dailyReport,
            });
            expectHops(routes, moved, listener, [page, daily]);
          } else {
            expect(moved.value, JSON.stringify(moved)).toMatchObject({
              _tag: "Redirect",
              metadata: { status: 301, headers: { location: "daily" } },
            });
            expectHops(routes, moved, listener, [page]);
          }
          const resolved = yield* send(
            routes,
            listener,
            client,
            legacyPage.pipe(Operation.mapOptions(() => followRedirects)),
            undefined,
          );
          expect(resolved.value, JSON.stringify(resolved)).toMatchObject({
            _tag: "Report",
            value: dailyReport,
          });
          expectHops(
            routes,
            resolved,
            listener,
            cached ? [daily] : [page, daily],
          );

          // The annual report moved to the archive's origin. The dashboard sends its token and the
          // edge's scheme; a client that follows to another origin drops `Authorization`, Fetch as
          // its standard says and Effect's middleware too, and keeps the rest.
          const relocated = {
            route: "archived",
            path: "/reports/archive/2025",
            status: 308,
            captures: { year: "2025" },
          } as const;
          const target = {
            route: "annual",
            path: "/2025/annual",
            status: 200,
            captures: { year: "2025" },
          } as const;
          const location = `${archived.origins[listener]}/2025/annual`;
          const withToken = annual.pipe(
            Operation.mapRequest(
              Request.setHeader({
                authorization: "Bearer t-1",
                "x-forwarded-proto": "https",
              }),
            ),
          );
          const expectArchive = (outer: Sent<Sent>, reached: boolean): void => {
            const context = JSON.stringify(outer);
            const [exchange] = expectHops(
              archived,
              outer,
              listener,
              reached ? [target] : [],
            );
            if (exchange === undefined) return;
            expect(
              values(exchange.seen.headers, "authorization"),
              context,
            ).toEqual([]);
            expect(
              values(exchange.seen.headers, "x-forwarded-proto"),
              context,
            ).toEqual(["https"]);
            // A redirect to another origin taints a page's request, so its `Origin` is `null`.
            expect(values(exchange.seen.headers, "origin"), context).toEqual(
              lane.name === "browser" ? ["null"] : [],
            );
          };
          const crossed = yield* collect(
            archived,
            send(routes, listener, client, withToken, undefined),
          );
          const first = crossed.value!;
          if (follows(client)) {
            expect(first.value, JSON.stringify(first)).toMatchObject({
              _tag: "Annual",
              value: annualReport,
            });
          } else {
            expect(first.value, JSON.stringify(first)).toMatchObject({
              _tag: "Redirect",
              metadata: { status: 308, headers: { location } },
            });
          }
          const [sentOut] = expectHops(routes, first, listener, [relocated]);
          expect(values(sentOut!.seen.headers, "authorization")).toEqual([
            "Bearer t-1",
          ]);
          expectArchive(crossed, follows(client));

          const across = yield* collect(
            archived,
            send(
              routes,
              listener,
              client,
              withToken.pipe(Operation.mapOptions(() => followRedirects)),
              undefined,
            ),
          );
          expect(across.value!.value, JSON.stringify(across)).toMatchObject({
            _tag: "Annual",
            value: annualReport,
          });
          expectHops(
            routes,
            across.value!,
            listener,
            cached ? [] : [relocated],
          );
          expectArchive(across, true);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a form's 303 ${follows(client) ? "is followed with a GET" : "is handed over"}, and Effect's middleware follows it with a GET`,
      () =>
        Effect.gen(function* () {
          const { routes } = yield* open(client, listener);
          const posted = {
            route: "queue",
            method: "POST",
            path: "/cgi-bin/report.cgi",
            status: 303,
          } as const;
          const queued = {
            route: "queued",
            path: `/reports/queued/${queuedReport.id}`,
            status: 200,
            captures: { id: queuedReport.id },
          } as const;
          // The form went out once, as a POST with its body; the page it leads to is a GET with no
          // content and none of the form's content fields.
          const expectPostThenGet = (sent: Sent) => {
            const [form, page] = expectHops(routes, sent, listener, [
              posted,
              queued,
            ]);
            expect(bodyText(form!.dispatched)).toBe("name=daily");
            expect(values(form!.seen.headers, "content-type")).toEqual([
              "application/x-www-form-urlencoded",
            ]);
            expect(bodyText(page!.dispatched)).toBe("");
            expect(values(page!.seen.headers, "content-type")).toEqual([]);
            expect(values(page!.seen.headers, "content-length")).toEqual([]);
          };

          const sent = yield* send(routes, listener, client, queue, {
            body: { name: "daily" },
          });
          if (follows(client)) {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Queued",
              value: queuedReport,
            });
            expectPostThenGet(sent);
          } else {
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Redirect",
              metadata: {
                status: 303,
                headers: { location: `/reports/queued/${queuedReport.id}` },
              },
            });
            expectHops(routes, sent, listener, [posted]);
          }

          const followed = yield* send(
            routes,
            listener,
            client,
            queue.pipe(Operation.mapOptions(() => followRedirects)),
            { body: { name: "daily" } },
          );
          expect(followed.value, JSON.stringify(followed)).toMatchObject({
            _tag: "Queued",
            value: queuedReport,
          });
          expectPostThenGet(followed);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a redirect loop ${follows(client) ? "fails after Fetch's 20 redirects, before Effect's middleware sees one" : "is handed over, and Effect's middleware stops after 10"}`,
      () =>
        Effect.gen(function* () {
          const { routes } = yield* open(client, listener);
          const hop = {
            route: "loop",
            path: "/reports/loop",
            status: 302,
          } as const;
          const times = (count: number) =>
            Array.from({ length: count }, () => hop);
          const handedOver = (sent: Sent) =>
            expect(sent.value, JSON.stringify(sent)).toMatchObject({
              _tag: "Redirect",
              metadata: { status: 302, headers: { location: "/reports/loop" } },
            });

          // Fetch follows 20 redirects and fails at the 21st answer, as its standard says, so the
          // middleware never receives a redirect from it. Over the other providers the middleware
          // follows 10 and hands over the last, which the contract's case takes.
          const sent = yield* send(routes, listener, client, loop, undefined);
          if (follows(client)) {
            expect(sent.outcome, JSON.stringify(sent)).toMatchObject({
              kind: "failure",
              tag: "HttpClientError/TransportError",
            });
            expectHops(routes, sent, listener, times(21));
          } else {
            handedOver(sent);
            expectHops(routes, sent, listener, times(1));
          }

          const followed = yield* send(
            routes,
            listener,
            client,
            loop.pipe(Operation.mapOptions(() => followRedirects)),
            undefined,
          );
          if (follows(client)) {
            expect(followed.outcome, JSON.stringify(followed)).toMatchObject({
              kind: "failure",
              tag: "HttpClientError/TransportError",
            });
            expectHops(routes, followed, listener, times(21));
          } else {
            handedOver(followed);
            expectHops(routes, followed, listener, times(11));
          }
        }).pipe(Effect.scoped),
    );

    if (client.name === "fetch")
      it.live(
        `${title}: Fetch's manual redirect mode ${lane.name === "browser" ? "hides the redirect behind status 0" : "hands the redirect over"}`,
        () =>
          Effect.gen(function* () {
            const { routes } = yield* open(client, listener);
            const sent = yield* send(
              routes,
              listener,
              client,
              latest,
              undefined,
            ).pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "manual",
              }),
            );
            if (lane.name === "browser") {
              // An opaque redirect, as the library's browser limits say: status 0 and no visible
              // fields, so no case of the contract matches, the redirect one included.
              expect(sent.outcome).toEqual({
                kind: "failure",
                tag: "UnexpectedResponse",
                message: "No response case matched status 0",
              });
            } else {
              expect(sent.value, JSON.stringify(sent)).toMatchObject({
                _tag: "Redirect",
                metadata: {
                  status: 302,
                  headers: { location: `/reports/${dailyReport.date}` },
                },
              });
            }
            expectHops(routes, sent, listener, [
              { route: "latest", path: "/reports/latest", status: 302 },
            ]);
          }).pipe(Effect.scoped),
      );
  }
});
