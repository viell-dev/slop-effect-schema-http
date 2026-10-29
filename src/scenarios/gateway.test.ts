import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Option, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient } from "effect/http";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import {
  Accounts,
  Digest,
  Extract,
  Rpc,
  Session,
} from "../clients/gateway/index.js";
import * as Csv from "../formats/csv.js";
import { Cents } from "../values/gateway.js";
import * as XmlRpc from "../formats/xmlrpc.js";
import { header, type Json, type Recorded } from "../harness/lane.js";

/**
 * Fixture data in the gateway's own terms (cents, stored date strings, status letters). The
 * expected decoded values below are written independently in the consumer's terms.
 */
const PASSWORD = "p+ss w&rd;1";
const TOKEN = "sso-7f3a9c41";
const REALM = "Reporting Gateway";
const AUDITOR = { username: "auditor", password: "Secr3t!" } as const;

const fixture = {
  users: { jdoe: PASSWORD },
  token: TOKEN,
  realm: REALM,
  auditors: { [AUDITOR.username]: AUDITOR.password },
  accounts: [
    {
      account: "00012345",
      title: "Café Müller",
      cents: 123450,
      due: "20261115",
    },
    {
      account: "00012346",
      title: 'Müller; "Spezial" GmbH',
      cents: 9900,
      due: "00000000",
    },
    {
      account: "00012347",
      title: "Señor Peña Imports",
      cents: -1250,
      due: "20261130",
    },
  ],
  extracts: {
    "202610": {
      runDate: "20261101",
      lastModified: "2026-11-01T02:15:00Z",
      records: [
        {
          account: "00012345",
          title: "Café Müller",
          cents: 123450,
          due: "20261115",
          status: "O",
        },
        {
          account: "00012346",
          title: "Bäckerei Groß",
          cents: 9900,
          due: "00000000",
          status: "O",
        },
        {
          account: "00012347",
          title: "Señor Peña Imports",
          cents: 1000000,
          due: "20261130",
          status: "P",
        },
      ],
    },
    "202602": {
      runDate: "20260302",
      lastModified: "2026-03-02T02:15:00Z",
      records: [
        {
          account: "00012345",
          title: "Café Müller",
          cents: 5000,
          due: "20260315",
          status: "X",
        },
      ],
      trailer: { count: 2, cents: 5000 },
    },
    "202603": {
      runDate: "20260401",
      lastModified: "2026-04-01T02:15:00Z",
      records: [
        {
          account: "00012345",
          title: "Café Müller",
          cents: 5000,
          due: "20260415",
          status: "O",
        },
        {
          account: "00012346",
          title: "Bäckerei Groß",
          cents: 2500,
          due: "00000000",
          status: "O",
        },
      ],
      // The right count, and a total patched one cent short.
      trailer: { count: 2, cents: 7499 },
    },
  },
  invoices: [
    {
      id: 1001,
      account: "00012345",
      cents: 123450,
      paid: false,
      issued: "20261001T09:30:00",
      settled: "00000000T00:00:00",
      lines: [
        { text: "Kaffee & Kuchen <Oktober>", cents: 100000 },
        { text: "Lieferung", cents: 23450 },
      ],
    },
    {
      id: 1002,
      account: "00012347",
      cents: 1000000,
      paid: true,
      issued: "20260915T14:00:00",
      settled: "20261003T08:15:30",
      lines: [],
    },
    {
      id: 1999,
      account: "00012346",
      cents: 9900,
      paid: true,
      issued: "19980231T00:00:00",
      settled: "19980302T00:00:00",
      lines: [],
    },
  ],
} satisfies Json;

/** Start the gateway for the current test's scope. */
const start = (options: Json = fixture) => lane.backend("gateway", options);

const viaFetch = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.provide(effect, lane.fetchClient);

const utc = (iso: string) => DateTime.makeUnsafe(iso);

/** Narrow a tagged union to one member, failing the test otherwise. */
const narrow = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

const names = (recorded: Recorded): ReadonlyArray<string> =>
  recorded.lines
    .map(([name]) => name.toLowerCase())
    .filter((name) => name !== "traceparent" && name !== "b3");

/** The Digest-protected audit report: its request, operation, and the caller-driven loop. */
const audit = (origin: string) => {
  const request = Digest.auditRequest(origin);
  const operation = Operation.make(request, Digest.auditResponse);
  return {
    request,
    operation,
    run: Digest.withDigest(request, operation, AUDITOR),
  };
};

const period = { query: { period: "202610" }, headers: {} };

/** Log in and return the session id. */
const loginAs = (origin: string) =>
  Session.login(origin)
    .execute({ user: "jdoe", password: PASSWORD })
    .pipe(Effect.map((reply) => narrow(reply, "Session").session));

const expectedExtract = {
  period: "202610",
  runDate: utc("2026-11-01T00:00:00Z"),
  items: [
    {
      account: "00012345",
      title: "Café Müller",
      amount: 123450,
      due: Option.some(utc("2026-11-15T00:00:00Z")),
      status: "open",
    },
    {
      account: "00012346",
      title: "Bäckerei Groß",
      amount: 9900,
      due: Option.none(),
      status: "open",
    },
    {
      account: "00012347",
      title: "Señor Peña Imports",
      amount: 1000000,
      due: Option.some(utc("2026-11-30T00:00:00Z")),
      status: "paid",
    },
  ],
};

/** A raw download of a resource's bytes, for comparing with what the codecs produce. */
const rawBytes = (url: string) =>
  Operation.make(Request.get(url), Response.status(200, Body.bytes)).execute(
    undefined,
  );

const utf8 = new TextEncoder();

/** A report.count call with `period` written into its string parameter exactly as given. */
const countCall = (requested: string) =>
  `<?xml version="1.0"?>\n<methodCall><methodName>report.count</methodName><params><param><value><string>${requested}</string></value></param></params></methodCall>\n`;

/** POST bytes to /RPC2 as text/xml, bypassing the consumer's writer, and read the reply's bytes. */
const rawCall = (origin: string, body: Uint8Array) =>
  viaFetch(
    Operation.make(
      Request.post(`${origin}/RPC2?session=${TOKEN}`).pipe(
        Request.body(
          Body.encoder((bytes: Uint8Array) =>
            Effect.succeed(HttpBody.uint8Array(bytes, "text/xml")),
          ),
        ),
      ),
      Response.status(200, Body.bytes),
    ).execute({ body }),
  );

/** A reply's text and tree, failing unless its bytes are NUL-free UTF-8 the strict reader accepts. */
const wellFormed = (bytes: Uint8Array) => {
  expect(bytes).not.toContain(0);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { text, response: XmlRpc.parseResponse(text) };
};

/** A fault as the wire tree carries it. */
const faultTree = (code: number, message: string) => ({
  fault: {
    struct: {
      faultCode: { i4: String(code) },
      faultString: { string: message },
    },
  },
});

describe(`gateway (${lane.name})`, () => {
  describe("sessions", () => {
    it.live(
      "[AUTH-2] logs in by GET with the password in the query string, then carries the session as a query parameter",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const session = yield* viaFetch(loginAs(gateway.origin));
          const balance = yield* viaFetch(
            Session.balance(gateway.origin).execute({
              session,
              account: "00012345",
            }),
          );
          expect(narrow(balance, "Balance").balance).toBe(123450);
          const [login, report, ...rest] = yield* gateway.ledger;
          expect(rest).toEqual([]);
          // `+`, space, `&` and `;` are all percent-encoded, so CGI.pm's decoding cannot alter them.
          expect(login!.method).toBe("GET");
          expect(login!.target).toBe(
            "/cgi-bin/login.cgi?user=jdoe&passwd=p%2Bss%20w%26rd%3B1",
          );
          expect(report!.target).toBe(
            `/cgi-bin/report.cgi?session=${session}&report=balance&account=00012345`,
          );
          expect(header(report!.lines, "accept")).toBe("text/plain");
        }),
    );

    it.live(
      "[AUTH-2] a wrong password and an unknown session are ERROR lines inside 200",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const refused = yield* viaFetch(
            Session.login(gateway.origin).execute({
              user: "jdoe",
              password: "p ss w&rd;1",
            }),
          );
          expect(refused).toEqual({
            _tag: "GatewayError",
            code: "E_AUTH",
            message: "invalid user or password",
          });
          const expired = yield* viaFetch(
            Session.balance(gateway.origin).execute({
              session: "0000",
              account: "00012345",
            }),
          );
          expect(expired).toEqual({
            _tag: "GatewayError",
            code: "E_SESSION",
            message: "session expired or unknown",
          });
          expect((yield* gateway.ledger).length).toBe(2);
        }),
    );

    it.live(
      "[AUTH-2] a blank user or a malformed account is refused before dispatch",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const blank = yield* viaFetch(
            Session.login(gateway.origin)
              .execute({ user: "", password: PASSWORD })
              .pipe(Effect.flip),
          );
          expect(blank._tag).toBe("SchemaError");
          const malformed = yield* viaFetch(
            Session.balance(gateway.origin)
              .execute({ session: TOKEN, account: "12345" })
              .pipe(Effect.flip),
          );
          expect(malformed._tag).toBe("SchemaError");
          expect(yield* gateway.ledger).toEqual([]);
        }),
    );

    it.live(
      "[AUTH-2] the configured SSO token is accepted wherever a session is",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const balance = yield* viaFetch(
            Session.balance(gateway.origin).execute({
              session: TOKEN,
              account: "00012347",
            }),
          );
          expect(narrow(balance, "Balance").balance).toBe(-1250);
          const extract = yield* viaFetch(
            Extract.extract(gateway.origin).execute({
              session: TOKEN,
              period: "202610",
            }),
          );
          expect(narrow(extract, "Extract").value.items).toHaveLength(3);
          const { token: _token, ...withoutToken } = fixture;
          const without = yield* start(withoutToken);
          const refused = yield* viaFetch(
            Session.balance(without.origin).execute({
              session: TOKEN,
              account: "00012347",
            }),
          );
          expect(narrow(refused, "GatewayError").code).toBe("E_SESSION");
          const targets = (yield* gateway.ledger).map((entry) => entry.target);
          expect(targets).toEqual([
            `/cgi-bin/report.cgi?session=${TOKEN}&report=balance&account=00012347`,
            `/cgi-bin/extract.cgi?session=${TOKEN}&period=202610`,
          ]);
        }),
    );
  });

  describe("pipe replies", () => {
    it.live(
      "[ERR-1c] an ERROR line inside 200 decodes as a gateway error beside the OK line",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const operation = Session.balance(gateway.origin);
          const ok = yield* viaFetch(
            operation.execute({ session: TOKEN, account: "00012346" }),
          );
          expect(ok).toEqual({
            _tag: "Balance",
            account: "00012346",
            balance: 9900,
            due: Option.none(),
          });
          const missing = yield* viaFetch(
            operation.execute({ session: TOKEN, account: "00099999" }),
          );
          expect(missing).toEqual({
            _tag: "GatewayError",
            code: "E_NOACCT",
            message: "no such account 00099999",
          });
          // Moving the body-level refusal into the failure channel is the consumer's choice.
          const strict = operation.pipe(
            Operation.mapEffect((reply) =>
              reply._tag === "GatewayError"
                ? Effect.fail(reply)
                : Effect.succeed(reply),
            ),
          );
          const failure = yield* viaFetch(
            strict
              .execute({ session: TOKEN, account: "00099999" })
              .pipe(Effect.flip),
          );
          expect(failure._tag).toBe("GatewayError");
          expect((yield* gateway.ledger).length).toBe(3);
        }),
    );

    it.live(
      "[ERR-1c] a reply that is neither an OK nor an ERROR line is a decode error",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          // Login answers `OK|<session>`; read with the balance contract, it fits neither OK nor ERROR.
          const misread = Operation.make(
            Request.get(
              `${gateway.origin}/cgi-bin/login.cgi?user=jdoe&passwd=${encodeURIComponent(PASSWORD)}`,
            ),
            Response.status(200, Session.balanceBody),
          );
          const error = yield* viaFetch(
            misread.execute(undefined).pipe(Effect.flip),
          );
          expect(error._tag).toBe("DecodeError");
        }),
    );
  });

  describe("XML-RPC", () => {
    it.live(
      "[PAY-3b] an invoice struct carries i4, double, boolean, dateTime.iso8601 and an array of structs",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const outcome = yield* viaFetch(
            Rpc.invoice(gateway.origin).execute({
              session: TOKEN,
              params: [1001],
            }),
          );
          expect(narrow(outcome, "Result").value).toEqual({
            id: 1001,
            account: "00012345",
            amount: 123450,
            paid: false,
            issued: utc("2026-10-01T09:30:00Z"),
            settled: Option.none(),
            lines: [
              { text: "Kaffee & Kuchen <Oktober>", amount: 100000 },
              { text: "Lieferung", amount: 23450 },
            ],
          });
          const [call] = yield* gateway.ledger;
          expect(call!.method).toBe("POST");
          expect(call!.target).toBe(`/RPC2?session=${TOKEN}`);
          expect(header(call!.lines, "content-type")).toBe("text/xml");
          expect(header(call!.lines, "accept")).toBe("text/xml");
          expect(
            XmlRpc.parseCall(new TextDecoder().decode(call!.body)),
          ).toEqual({
            methodName: "invoice.get",
            params: [{ i4: "1001" }],
          });
        }),
    );

    it.live(
      "[PAY-3b] bare scalar responses: an i4 count, an untyped string and an array of strings",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const count = yield* viaFetch(
            Rpc.reportCount(gateway.origin).execute({
              session: TOKEN,
              params: ["202610"],
            }),
          );
          expect(count).toEqual({ _tag: "Result", value: 3 });
          const title = yield* viaFetch(
            Rpc.accountTitle(gateway.origin).execute({
              session: TOKEN,
              params: ["00012347"],
            }),
          );
          expect(title).toEqual({
            _tag: "Result",
            value: "Señor Peña Imports",
          });
          const methods = yield* viaFetch(
            Rpc.listMethods(gateway.origin).execute({
              session: TOKEN,
              params: [],
            }),
          );
          expect(narrow(methods, "Result").value).toContain("invoice.get");
          // The wire really carries an untyped value for the title, and typed ones elsewhere.
          const raw = yield* viaFetch(
            Operation.make(
              Request.post(`${gateway.origin}/RPC2?session=${TOKEN}`).pipe(
                Request.body(
                  Rpc.call("account.title", Schema.Tuple([XmlRpc.Text])),
                ),
              ),
              Response.status(200, Body.text),
            ).execute({ body: ["00012347"] }),
          );
          expect(raw).toContain("<value>Señor Peña Imports</value>");
        }),
    );

    it.live(
      "[PAY-3b] a header declaration cannot relabel a text body, so the gateway refuses the call",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const relabelled = Operation.make(
            Request.post(`${gateway.origin}/RPC2?session=${TOKEN}`).pipe(
              Request.setHeader("Content-Type", "text/xml"),
              Request.body(Body.text),
            ),
            Response.status(200, Body.text),
          );
          const error = yield* viaFetch(
            relabelled
              .execute({
                body: XmlRpc.serializeCall({
                  methodName: "system.listMethods",
                  params: [],
                }),
              })
              .pipe(Effect.flip),
          );
          const unexpected = narrow(error, "UnexpectedResponse");
          expect(unexpected.metadata.status).toBe(400);
          const [call] = yield* gateway.ledger;
          expect(header(call!.lines, "content-type")).toBe("text/plain");
        }),
    );

    it.live(
      "[PAY-3b] a call holding a NUL or another character XML forbids, raw or as a reference, gets the parse-error fault in well-formed XML",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const malformed = [
            countCall("2026\u000010"),
            countCall("2026&#0;10"),
            countCall("2026&#x0;10"),
            countCall("2026￾10"),
            countCall("2026&#xFFFF;10"),
            countCall("2026&#xD800;10"),
            countCall("2026&#x110000;10"),
            // Malformed references: XML's x is lower-case, and an ampersand must start one.
            countCall("2026&#X31;0"),
            countCall("2026 & 10"),
            // Attribute values follow the same rules, though XML-RPC defines no attributes.
            ...["&#0;", "&#xD800;", "&#X31;", "R & D", "a<b"].map((value) =>
              countCall("202610").replace(
                "<methodCall>",
                `<methodCall review="${value}">`,
              ),
            ),
          ].map((text) => utf8.encode(text));
          // Bytes that are not UTF-8 at all.
          const [head, tail] = countCall("2026@10").split("@");
          malformed.push(
            new Uint8Array([
              ...utf8.encode(head!),
              0xff,
              ...utf8.encode(tail!),
            ]),
          );
          for (const body of malformed)
            expect(
              wellFormed(yield* rawCall(gateway.origin, body)).response,
            ).toEqual(faultTree(-32700, "parse error. not well formed"));
          // The controls: a well-formed call on the same path is answered, with or without a
          // well-formed attribute, which XML-RPC ignores.
          const control = utf8.encode(countCall("202610"));
          const attributed = utf8.encode(
            countCall("202610").replace(
              "<methodCall>",
              `<methodCall review='R &amp; D &#233;'>`,
            ),
          );
          for (const body of [control, attributed])
            expect(
              wellFormed(yield* rawCall(gateway.origin, body)).response,
            ).toEqual({ params: [{ i4: "3" }] });
          // Every call went out byte for byte, the raw NUL included.
          const ledger = yield* gateway.ledger;
          expect(ledger.map((entry) => Array.from(entry.body))).toEqual(
            [...malformed, control, attributed].map((body) => Array.from(body)),
          );
          expect(ledger[0]!.body).toContain(0);
        }),
    );

    it.live(
      "[PAY-3b] the gateway reads a call's line ends as LF, and writes a referenced carriage return back as a reference",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          // report.count's 404 fault echoes the period as the gateway read it.
          for (const lineEnd of ["2026\r\n13", "2026\r13", "2026\n13"]) {
            const reply = yield* rawCall(
              gateway.origin,
              utf8.encode(countCall(lineEnd)),
            );
            expect(reply).not.toContain(0x0d);
            expect(wellFormed(reply).response).toEqual(
              faultTree(404, "no extract for 2026\n13"),
            );
          }
          const referenced = wellFormed(
            yield* rawCall(
              gateway.origin,
              utf8.encode(countCall("2026&#13;13")),
            ),
          );
          expect(referenced.text).toContain(
            "<string>no extract for 2026&#13;13</string>",
          );
          expect(referenced.response).toEqual(
            faultTree(404, "no extract for 2026\r13"),
          );
          // The raw line ends really went out as written.
          const [crlf, cr] = yield* gateway.ledger;
          expect(crlf!.body).toContain(0x0d);
          expect(cr!.body).toContain(0x0d);
        }),
    );

    it.live(
      "[PAY-3b] a fixture value XML cannot carry is answered with the internal-error fault, never written",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start({
            ...fixture,
            accounts: [
              ...fixture.accounts,
              {
                account: "00012399",
                title: "Null\u0000Title",
                cents: 0,
                due: "00000000",
              },
            ],
          });
          // The consumer's strict reader decodes the reply, so a NUL on the wire would fail it.
          const title = yield* viaFetch(
            Rpc.accountTitle(gateway.origin).execute({
              session: TOKEN,
              params: ["00012399"],
            }),
          );
          expect(title).toEqual({
            _tag: "Fault",
            code: -32603,
            message: "server error. internal xml-rpc error",
          });
          const other = yield* viaFetch(
            Rpc.accountTitle(gateway.origin).execute({
              session: TOKEN,
              params: ["00012345"],
            }),
          );
          expect(other).toEqual({ _tag: "Result", value: "Café Müller" });
        }),
    );

    it.live(
      "[ERR-1b] an XML-RPC fault inside 200 is a member of the result union",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const missing = yield* viaFetch(
            Rpc.invoice(gateway.origin).execute({
              session: TOKEN,
              params: [9999],
            }),
          );
          expect(missing).toEqual({
            _tag: "Fault",
            code: 404,
            message: "no such invoice 9999",
          });
          expectTypeOf(missing).toExtend<
            { readonly _tag: "Fault" } | { readonly _tag: "Result" }
          >();
          // @ts-expect-error A result's fields are unreachable until the fault is ruled out.
          expect(missing.value).toBeUndefined();
          const unknown = yield* viaFetch(
            Rpc.method(
              "report.delete",
              Schema.Tuple([]),
              XmlRpc.Untyped,
            )(gateway.origin).execute({
              session: TOKEN,
              params: [],
            }),
          );
          expect(narrow(unknown, "Fault").code).toBe(-32601);
          const expired = yield* viaFetch(
            Rpc.reportCount(gateway.origin).execute({
              session: "0000",
              params: ["202610"],
            }),
          );
          expect(expired).toEqual({
            _tag: "Fault",
            code: 401,
            message: "session expired or unknown",
          });
          const ledger = yield* gateway.ledger;
          expect(
            ledger.map(
              (entry) => `${entry.method} ${entry.target.split("?")[0]}`,
            ),
          ).toEqual(["POST /RPC2", "POST /RPC2", "POST /RPC2"]);
        }),
    );

    it.live(
      "[ERR-1b] a fault can be moved into the failure channel by the consumer",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          class Fault extends Error {
            readonly _tag = "XmlRpcFault";
          }
          const strict = Rpc.invoice(gateway.origin).pipe(
            Operation.mapEffect((outcome) =>
              outcome._tag === "Fault"
                ? Effect.fail(new Fault(`${outcome.code} ${outcome.message}`))
                : Effect.succeed(outcome.value),
            ),
          );
          const error = yield* viaFetch(
            strict
              .execute({ session: TOKEN, params: [9999] })
              .pipe(Effect.flip),
          );
          expect(error).toBeInstanceOf(Fault);
          expect(error.message).toBe("404 no such invoice 9999");
        }),
    );

    it.live(
      "[PAY-8] base64 inside XML-RPC decodes through the same fixed-width schema as the download",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const viaRpc = yield* viaFetch(
            Rpc.extractFetch(gateway.origin).execute({
              session: TOKEN,
              params: ["202610"],
            }),
          );
          const viaHttp = yield* viaFetch(
            Extract.extract(gateway.origin).execute({
              session: TOKEN,
              period: "202610",
            }),
          );
          expect(narrow(viaRpc, "Result").value).toEqual(expectedExtract);
          expect(narrow(viaHttp, "Extract").value).toEqual(expectedExtract);
          // The base64 is wrapped at 76 columns, as MIME::Base64 writes it.
          const raw = yield* viaFetch(
            Operation.make(
              Request.post(`${gateway.origin}/RPC2?session=${TOKEN}`).pipe(
                Request.body(
                  Rpc.call("extract.fetch", Schema.Tuple([XmlRpc.Text])),
                ),
              ),
              Response.status(
                200,
                Body.text.pipe(Body.schema(XmlRpc.ResponseText)),
              ),
            ).execute({ body: ["202610"] }),
          );
          // 5 records of 64 bytes are 428 base64 characters: five full lines and one of 48.
          const value = (
            raw as { readonly params: readonly [{ readonly base64: string }] }
          ).params[0].base64;
          expect(value.split("\n").map((line) => line.length)).toEqual([
            76, 76, 76, 76, 76, 48, 0,
          ]);
        }),
    );
  });

  describe("CSV", () => {
    it.live(
      "[HDR-5d] CSV served as application/octet-stream decodes by status and body, never by content type",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const sheet = yield* viaFetch(
            Operation.make(
              Accounts.exportRequest.pipe(Request.baseUrl(gateway.origin)),
              Response.status(
                200,
                Response.tag("Sheet", Accounts.exportBody(false)),
              ),
            ).execute({ session: TOKEN, german: false }),
          );
          expect(sheet.metadata.headers["content-type"]).toBe(
            "application/octet-stream",
          );
          expect(narrow(sheet.value, "Accounts").rows).toEqual([
            {
              account: "00012345",
              title: "Café Müller",
              amount: 123450,
              due: Option.some(utc("2026-11-15T00:00:00Z")),
            },
            {
              account: "00012346",
              title: 'Müller; "Spezial" GmbH',
              amount: 9900,
              due: Option.none(),
            },
            {
              account: "00012347",
              title: "Señor Peña Imports",
              amount: -1250,
              due: Option.some(utc("2026-11-30T00:00:00Z")),
            },
          ]);
          const [request] = yield* gateway.ledger;
          expect(header(request!.lines, "accept")).toBe("text/csv");
          expect(request!.target).toBe(
            `/cgi-bin/report.cgi?session=${TOKEN}&report=accounts&format=csv`,
          );
        }),
    );

    it.live(
      "[HDR-5d] a rule keyed on the advertised CSV content type never matches",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const trusting = Operation.make(
            Accounts.exportRequest.pipe(Request.baseUrl(gateway.origin)),
            Response.when(
              (metadata) =>
                (metadata.headers["content-type"] ?? "").startsWith("text/csv"),
              Accounts.exportBody(false),
            ),
          );
          const error = yield* viaFetch(
            trusting
              .execute({ session: TOKEN, german: false })
              .pipe(Effect.flip),
          );
          const unexpected = narrow(error, "UnexpectedResponse");
          expect(unexpected.metadata.status).toBe(200);
          expect(unexpected.metadata.headers["content-type"]).toBe(
            "application/octet-stream",
          );
        }),
    );

    it.live(
      "[HDR-5d] a refused export is an ERROR line in 200 that the same body schema recognises",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const refused = yield* viaFetch(
            Accounts.exportAccounts(gateway.origin, false).execute({
              session: "0000",
              german: false,
            }),
          );
          expect(refused).toEqual({
            _tag: "GatewayError",
            code: "E_SESSION",
            message: "session expired or unknown",
          });
        }),
    );

    it.live(
      "[PAY-4b] a BOM-preserving decode poisons the first column name; the byte codec does not",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const naive = Body.bytes.pipe(
            Body.mapEffect((bytes) =>
              Schema.decodeUnknownEffect(
                Csv.table(["account", "title", "amount", "due"]),
              )(
                Csv.parse(
                  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
                  Csv.unix,
                ),
              ),
            ),
          );
          const poisoned = yield* viaFetch(
            Operation.make(
              Accounts.exportRequest.pipe(Request.baseUrl(gateway.origin)),
              Response.status(200, naive),
            )
              .execute({ session: TOKEN, german: false })
              .pipe(Effect.flip),
          );
          const decodeError = narrow(poisoned, "DecodeError");
          // JSON.stringify leaves U+FEFF unescaped, so the message carries the BOM itself.
          const bom = String.fromCharCode(0xfeff);
          expect(String(decodeError.cause)).toContain(`got ["${bom}account"`);
          const clean = yield* viaFetch(
            Accounts.exportAccounts(gateway.origin, false).execute({
              session: TOKEN,
              german: false,
            }),
          );
          expect(narrow(clean, "Accounts").rows[0]!.account).toBe("00012345");
        }),
    );

    it.live(
      "[PAY-4b] Fetch's text decoding drops the BOM silently, so a text codec cannot write it back",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const url = `${gateway.origin}/cgi-bin/report.cgi?session=${TOKEN}&report=accounts&format=csv`;
          const text = yield* viaFetch(
            Operation.make(
              Request.get(url),
              Response.status(200, Body.text),
            ).execute(undefined),
          );
          const bytes = yield* viaFetch(rawBytes(url));
          expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
          expect(text.startsWith("account,")).toBe(true);
          expect(new TextEncoder().encode(text).length).toBe(bytes.length - 3);
        }),
    );

    it.live(
      "[PAY-5] the German sheet round-trips byte for byte, BOM included, and the import accepts it",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const url = `${gateway.origin}/cgi-bin/report.cgi?session=${TOKEN}&report=accounts&format=csv&locale=de_DE`;
          const original = yield* viaFetch(rawBytes(url));
          const rows = Schema.decodeUnknownSync(Accounts.GermanSheet)(original);
          expect(rows.map((row) => row.amount)).toEqual([123450, 9900, -1250]);
          expect(rows[1]!.title).toBe('Müller; "Spezial" GmbH');
          expect(Schema.encodeSync(Accounts.GermanSheet)(rows)).toEqual(
            original,
          );
          const imported = yield* viaFetch(
            Accounts.importAccounts(gateway.origin).execute({
              session: TOKEN,
              rows,
            }),
          );
          expect(imported).toEqual({ _tag: "Imported", rows: 3 });
          const [, upload] = yield* gateway.ledger;
          expect(upload!.method).toBe("POST");
          expect(upload!.target).toBe(
            `/cgi-bin/import.cgi?session=${TOKEN}&locale=de_DE`,
          );
          expect(header(upload!.lines, "content-type")).toBe(
            "text/csv; charset=utf-8",
          );
          expect(upload!.body).toEqual(original);
        }),
    );

    it.live(
      "[PAY-5] an edited sheet uploads and reads back with the new amount and title",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const sheet = yield* viaFetch(
            Accounts.exportAccounts(gateway.origin, true).execute({
              session: TOKEN,
              german: true,
            }),
          );
          const rows = narrow(sheet, "Accounts").rows;
          const edited = rows.map((row, index) =>
            index === 0
              ? {
                  ...row,
                  title: "Café Müller; Filiale 2",
                  amount: Cents.make(-5),
                }
              : row,
          );
          yield* viaFetch(
            Accounts.importAccounts(gateway.origin).execute({
              session: TOKEN,
              rows: edited,
            }),
          );
          const again = yield* viaFetch(
            Accounts.exportAccounts(gateway.origin, true).execute({
              session: TOKEN,
              german: true,
            }),
          );
          expect(narrow(again, "Accounts").rows).toEqual(edited);
          const [, upload] = yield* gateway.ledger;
          expect(new TextDecoder().decode(upload!.body)).toContain(
            '00012345;"Café Müller; Filiale 2";-0,05;20261115\r\n',
          );
        }),
    );

    it.live(
      "[PAY-5] the importer refuses sheets German Excel would not write, as ERROR lines inside 200",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const upload = (text: string) =>
            viaFetch(
              Operation.make(
                Request.post(
                  `${gateway.origin}/cgi-bin/import.cgi?session=${TOKEN}&locale=de_DE`,
                ).pipe(Request.body(Body.bytes)),
                Response.status(200, Accounts.importBody),
              ).execute({ body: new TextEncoder().encode(text) }),
            );
          const columns = "Konto;Bezeichnung;Betrag;Fällig\r\n";
          expect(
            yield* upload(`${columns}00012345;Café;1234,50;20261115\r\n`),
          ).toEqual({
            _tag: "GatewayError",
            code: "E_FORMAT",
            message: "missing byte-order mark",
          });
          expect(
            yield* upload(`\uFEFF${columns}00012345;Café;1234.50;20261115\r\n`),
          ).toEqual({
            _tag: "GatewayError",
            code: "E_FORMAT",
            message: "line 2: Betrag needs a decimal comma",
          });
          expect(
            yield* upload(`\uFEFF${columns}00012345;Café;1234,50;20261115\n`),
          ).toEqual({
            _tag: "GatewayError",
            code: "E_FORMAT",
            message: "line 2: line breaks must be CRLF",
          });
        }),
    );
  });

  describe("month-end extract", () => {
    it.live(
      "[PAY-4c] the extract decodes from Latin-1 bytes with implied decimals and a verified trailer, and re-encodes to the same bytes",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const outcome = yield* viaFetch(
            Extract.extract(gateway.origin).execute({
              session: TOKEN,
              period: "202610",
            }),
          );
          const extract = narrow(outcome, "Extract").value;
          expect(extract).toEqual(expectedExtract);
          const bytes = yield* viaFetch(
            rawBytes(
              `${gateway.origin}/cgi-bin/extract.cgi?session=${TOKEN}&period=202610`,
            ),
          );
          expect(bytes.length).toBe(5 * 64);
          // "é" is the single byte 0xE9 at its fixed offset in the first detail record.
          expect(bytes[64 + 1 + 8 + 3]).toBe(0xe9);
          expect(Schema.encodeSync(Extract.MonthEndExtract)(extract)).toEqual(
            bytes,
          );
          const [download] = yield* gateway.ledger;
          expect(download!.method).toBe("GET");
          expect(header(download!.lines, "accept")).toBe(
            "application/octet-stream",
          );
        }),
    );

    it.live(
      "[PAY-4c] read as UTF-8 text, the same bytes corrupt every accented title without an error",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const text = yield* viaFetch(
            Operation.make(
              Request.get(
                `${gateway.origin}/cgi-bin/extract.cgi?session=${TOKEN}&period=202610`,
              ),
              Response.status(200, Body.text),
            ).execute(undefined),
          );
          // Each lone Latin-1 byte became U+FFFD; nothing failed, and the titles are gone.
          expect(text).toContain("Caf\uFFFD M\uFFFDller");
          expect(text).toContain("B\uFFFDckerei Gro\uFFFD");
          expect(text).not.toContain("Café");
        }),
    );

    it.live(
      "[PAY-4c] a trailer patched by hand fails the decode with the mismatch it found",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const error = yield* viaFetch(
            Extract.extract(gateway.origin)
              .execute({ session: TOKEN, period: "202602" })
              .pipe(Effect.flip),
          );
          const decodeError = narrow(error, "DecodeError");
          expect(String(decodeError.cause)).toContain(
            "the trailer counts 2 records, but the file has 1",
          );
        }),
    );

    it.live(
      "[PAY-4c] a trailer with the right count and a patched control total fails the decode with both totals",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          // The fixture as sent: two details and a trailer counting two, one cent short.
          const bytes = yield* viaFetch(
            rawBytes(
              `${gateway.origin}/cgi-bin/extract.cgi?session=${TOKEN}&period=202603`,
            ),
          );
          expect(bytes.length).toBe(4 * 64);
          expect(
            String.fromCharCode(...bytes.subarray(3 * 64, 3 * 64 + 20)),
          ).toBe("T0000020000000007499");
          const error = yield* viaFetch(
            Extract.extract(gateway.origin)
              .execute({ session: TOKEN, period: "202603" })
              .pipe(Effect.flip),
          );
          const decodeError = narrow(error, "DecodeError");
          expect(decodeError.metadata.status).toBe(200);
          expect(String(decodeError.cause)).toContain(
            "the trailer's control total 7499 differs from the records' 7500",
          );
        }),
    );

    it.live(
      "[PAY-4c] refusals are mapped statuses with ERROR lines, and a malformed period never leaves the client",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const operation = Extract.extract(gateway.origin);
          const missing = narrow(
            yield* viaFetch(
              operation.execute({ session: TOKEN, period: "202612" }),
            ),
            "Refused",
          );
          expect(missing.metadata.status).toBe(404);
          expect(missing.value).toEqual({
            _tag: "GatewayError",
            code: "E_NOPERIOD",
            message: "no extract for 202612",
          });
          const forbidden = narrow(
            yield* viaFetch(
              operation.execute({ session: "0000", period: "202610" }),
            ),
            "Refused",
          );
          expect(forbidden.metadata.status).toBe(403);
          const malformed = yield* viaFetch(
            operation
              .execute({ session: TOKEN, period: "2026-10" })
              .pipe(Effect.flip),
          );
          expect(malformed._tag).toBe("SchemaError");
          expect((yield* gateway.ledger).length).toBe(2);
        }),
    );

    it.live(
      "[STAT-6] a HEAD probe reads the extract's facts from its headers with an ordinary schema",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const probed = yield* viaFetch(
            Extract.probe(gateway.origin).execute({
              session: TOKEN,
              period: "202610",
            }),
          );
          const facts = narrow(probed, "Ready").value;
          expect(facts).toEqual({
            records: 3,
            controlTotal: 1133350,
            lastModified: utc("2026-11-01T02:15:00Z"),
            bytes: 320,
          });
          // The facts agree with the body they describe.
          const extract = narrow(
            yield* viaFetch(
              Extract.extract(gateway.origin).execute({
                session: TOKEN,
                period: "202610",
              }),
            ),
            "Extract",
          ).value;
          expect(extract.items.length).toBe(facts.records);
          expect(
            extract.items.reduce((total, item) => total + item.amount, 0),
          ).toBe(facts.controlTotal);
          const [head] = yield* gateway.ledger;
          expect(head!.method).toBe("HEAD");
          expect(head!.target).toBe(
            `/cgi-bin/extract.cgi?session=${TOKEN}&period=202610`,
          );
          expect(head!.body.length).toBe(0);
        }),
    );

    it.live(
      "[STAT-6] a probe of a missing period is a mapped 404, and a malformed one is never sent",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const missing = yield* viaFetch(
            Extract.probe(gateway.origin).execute({
              session: TOKEN,
              period: "202612",
            }),
          );
          expect(narrow(missing, "Refused").value).toBe(404);
          const malformed = yield* viaFetch(
            Extract.probe(gateway.origin)
              .execute({ session: TOKEN, period: "202613" })
              .pipe(Effect.flip),
          );
          expect(malformed._tag).toBe("SchemaError");
          expect((yield* gateway.ledger).length).toBe(1);
        }),
    );
  });

  describe("legacy path", () => {
    it.live(
      "[STAT-10] Fetch follows the 301, so the declared 301 case is unreachable",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const outcome = yield* viaFetch(
            Session.legacyBalance(gateway.origin).execute({
              session: TOKEN,
              account: "00012345",
            }),
          );
          expect(narrow(outcome, "Report").value).toEqual({
            _tag: "Balance",
            account: "00012345",
            balance: 123450,
            due: Option.some(utc("2026-11-15T00:00:00Z")),
          });
          const targets = (yield* gateway.ledger).map(
            (entry) => `${entry.method} ${entry.target}`,
          );
          expect(targets).toEqual([
            `GET /cgi-bin/rpt.exe?session=${TOKEN}&report=balance&account=00012345`,
            `GET /cgi-bin/report.cgi?session=${TOKEN}&report=balance&account=00012345`,
          ]);
        }),
    );

    it.live(
      '[STAT-10] Fetch with redirect: "manual", a per-request transport option outside the library',
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const exit = yield* Session.legacyBalance(gateway.origin)
            .execute({ session: TOKEN, account: "00012345" })
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "manual",
              }),
              Effect.provide(lane.fetchClient),
              Effect.exit,
            );
          const ledger = yield* gateway.ledger;
          expect(ledger.map((entry) => entry.target.split("?")[0])).toEqual([
            "/cgi-bin/rpt.exe",
          ]);
          if (lane.name === "node") {
            // Node's fetch hands the 301 itself to the caller, so the declared case is reached.
            expect(exit._tag).toBe("Success");
            const moved = narrow(
              (
                exit as {
                  readonly value: { readonly _tag: "Moved" | "Report" };
                }
              ).value,
              "Moved",
            );
            expect(moved).toMatchObject({
              value: {
                location: `${gateway.origin}/cgi-bin/report.cgi?session=${TOKEN}&report=balance&account=00012345`,
              },
            });
          } else {
            // A browser returns an opaque-redirect response: status 0 and no headers, so no case matches.
            expect(exit._tag).toBe("Failure");
            const error = Cause.squash(
              (exit as { readonly cause: Cause.Cause<unknown> }).cause,
            ) as {
              readonly _tag: string;
              readonly metadata?: { readonly status: number };
            };
            expect(error._tag).toBe("UnexpectedResponse");
            expect(error.metadata?.status).toBe(0);
          }
        }),
    );
  });

  describe("Digest", () => {
    it.live(
      "[AUTH-7] the 401 challenge is a declared response, and the same cold request runs again with one added header",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const { operation, run } = audit(gateway.origin);
          const first = yield* viaFetch(operation.execute(period));
          // @ts-expect-error The report's fields are unreachable until the challenge is ruled out.
          expect(first.value.records).toBeUndefined();
          const challenge = narrow(first, "Challenge").value;
          expect(challenge).toMatchObject({ realm: REALM, stale: false });
          const report = yield* viaFetch(run(period));
          expect(report).toMatchObject({
            _tag: "Report",
            value: {
              _tag: "Audit",
              period: "202610",
              records: 3,
              controlTotal: 1133350,
            },
          });
          const [, cold, authorized, ...rest] = yield* gateway.ledger;
          expect(rest).toEqual([]);
          expect(authorized!.method).toBe(cold!.method);
          expect(authorized!.target).toBe(cold!.target);
          expect(
            names(authorized!).filter((name) => !names(cold!).includes(name)),
          ).toEqual(["authorization"]);
          const value = header(authorized!.lines, "authorization")!;
          expect(value).toContain(`uri="${cold!.target}"`);
          expect(value).toContain(`realm="${REALM}"`);
          expect(value).toMatch(/response="[0-9a-f]{32}"/);
          expect(value).not.toMatch(/qop|nc=|cnonce/);
        }),
    );

    it.live(
      "[AUTH-7] a replayed Authorization is answered with stale=true and a fresh nonce",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const { operation, run } = audit(gateway.origin);
          yield* viaFetch(run(period));
          const [, spent] = yield* gateway.ledger;
          const replayed = yield* viaFetch(
            operation.execute({
              ...period,
              headers: {
                authorization: header(spent!.lines, "authorization")!,
              },
            }),
          );
          const stale = narrow(replayed, "Challenge").value;
          expect(stale.stale).toBe(true);
          expect(header(spent!.lines, "authorization")).not.toContain(
            `nonce="${stale.nonce}"`,
          );
        }),
    );

    it.live(
      "[AUTH-7] wrong credentials end the loop with a typed rejection after two requests",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const request = Digest.auditRequest(gateway.origin);
          const run = Digest.withDigest(
            request,
            Operation.make(request, Digest.auditResponse),
            {
              username: AUDITOR.username,
              password: "wrong",
            },
          );
          const error = yield* viaFetch(run(period).pipe(Effect.flip));
          const rejected = narrow(error, "DigestRejected");
          expect(rejected.requests).toBe(2);
          expect(rejected.challenge.stale).toBe(false);
          expect((yield* gateway.ledger).length).toBe(2);
        }),
    );

    it.live(
      "[AUTH-7] a response computed over another URI is refused by the server's uri check",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const { operation } = audit(gateway.origin);
          const challenge = narrow(
            yield* viaFetch(operation.execute(period)),
            "Challenge",
          ).value;
          const wrong = Digest.authorization(
            AUDITOR,
            challenge,
            "GET",
            "/admin/audit.cgi?period=202609",
          );
          const error = yield* viaFetch(
            operation
              .execute({ ...period, headers: { authorization: wrong } })
              .pipe(Effect.flip),
          );
          expect(narrow(error, "UnexpectedResponse").metadata.status).toBe(400);
        }),
    );

    it.live(
      "[RET-4] every Digest call costs two round trips: three calls, six requests",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const { run } = audit(gateway.origin);
          for (let call = 0; call < 3; call++)
            expect(
              narrow(yield* viaFetch(run(period)), "Report").value._tag,
            ).toBe("Audit");
          const ledger = yield* gateway.ledger;
          expect(ledger.length).toBe(6);
          expect(
            ledger.map(
              (entry) => header(entry.lines, "authorization") !== undefined,
            ),
          ).toEqual([false, true, false, true, false, true]);
          const nonces = ledger
            .filter(
              (entry) => header(entry.lines, "authorization") !== undefined,
            )
            .map(
              (entry) =>
                /nonce="([^"]+)"/.exec(
                  header(entry.lines, "authorization")!,
                )![1],
            );
          expect(new Set(nonces).size).toBe(3);
        }),
    );

    it.live(
      "[RET-4] sending the previous nonce pre-emptively saves nothing, because it is spent",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const { run } = audit(gateway.origin);
          yield* viaFetch(run(period));
          const [, spent] = yield* gateway.ledger;
          // Start the next call with the old Authorization instead of without one.
          const reused = {
            ...period,
            headers: { authorization: header(spent!.lines, "authorization")! },
          };
          const report = yield* viaFetch(run(reused));
          expect(narrow(report, "Report").value._tag).toBe("Audit");
          // Still two requests for this call: the stale replay, then a fresh nonce.
          const ledger = yield* gateway.ledger;
          expect(ledger.length).toBe(4);
          expect(header(ledger[2]!.lines, "authorization")).toBe(
            header(spent!.lines, "authorization"),
          );
        }),
    );

    it.live(
      "[RET-4] a timed-out authenticated request has still spent its nonce",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start({
            ...fixture,
            delays: [
              {
                path: "/admin/audit.cgi",
                milliseconds: 2000,
                authorized: true,
                times: 1,
              },
            ],
          });
          const { operation } = audit(gateway.origin);
          const challenge = narrow(
            yield* viaFetch(operation.execute(period)),
            "Challenge",
          ).value;
          const compiled = yield* Request.compile(
            Digest.auditRequest(gateway.origin),
            period,
          );
          const url = new URL(compiled.request.url);
          const signed = {
            ...period,
            headers: {
              authorization: Digest.authorization(
                AUDITOR,
                challenge,
                "GET",
                `${url.pathname}${url.search}`,
              ),
            },
          };
          const timedOut = yield* viaFetch(
            operation
              .execute(signed)
              .pipe(Effect.timeout("300 millis"), Effect.flip),
          );
          expect(Cause.isTimeoutError(timedOut)).toBe(true);
          // The server learns of the abort when the socket closes; poll the ledger until it has.
          const aborted = yield* gateway.ledger.pipe(
            Effect.map((ledger) => ledger[1]?.aborted === true),
            Effect.repeat({
              schedule: Schedule.spaced("25 millis"),
              until: (seen) => seen,
              times: 80,
            }),
          );
          expect(aborted).toBe(true);
          const replay = yield* viaFetch(operation.execute(signed));
          expect(narrow(replay, "Challenge").value.stale).toBe(true);
        }),
    );

    it.live(
      "[RET-4] a retry policy replays the encoded request, so its retry meets stale=true",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start({
            ...fixture,
            delays: [
              {
                path: "/admin/audit.cgi",
                milliseconds: 2000,
                authorized: true,
                times: 1,
              },
            ],
          });
          const { operation } = audit(gateway.origin);
          const challenge = narrow(
            yield* viaFetch(operation.execute(period)),
            "Challenge",
          ).value;
          const retrying = Operation.make(
            Digest.auditRequest(gateway.origin),
            Digest.auditResponse,
            {
              policy: Policy.make(Schedule.recurs(1), {
                attemptTimeout: "300 millis",
              }),
            },
          );
          const compiled = yield* Request.compile(
            Digest.auditRequest(gateway.origin),
            period,
          );
          const url = new URL(compiled.request.url);
          const outcome = yield* viaFetch(
            retrying.execute({
              ...period,
              headers: {
                authorization: Digest.authorization(
                  AUDITOR,
                  challenge,
                  "GET",
                  `${url.pathname}${url.search}`,
                ),
              },
            }),
          );
          // The timed-out attempt spent the nonce; the replayed attempt is challenged as stale.
          expect(narrow(outcome, "Challenge").value.stale).toBe(true);
          const ledger = yield* gateway.ledger;
          expect(ledger.length).toBe(3);
          expect(header(ledger[2]!.lines, "authorization")).toBe(
            header(ledger[1]!.lines, "authorization"),
          );
        }),
    );
  });

  describe("value conventions on the wire", () => {
    it.live(
      "[VAL-2b] one amount from five endpoints in four spellings decodes to the same cents",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const origin = gateway.origin;
          const invoice = narrow(
            yield* viaFetch(
              Rpc.invoice(origin).execute({ session: TOKEN, params: [1001] }),
            ),
            "Result",
          ).value.amount;
          const balance = narrow(
            yield* viaFetch(
              Session.balance(origin).execute({
                session: TOKEN,
                account: "00012345",
              }),
            ),
            "Balance",
          ).balance;
          const csv = narrow(
            yield* viaFetch(
              Accounts.exportAccounts(origin, false).execute({
                session: TOKEN,
                german: false,
              }),
            ),
            "Accounts",
          ).rows[0]!.amount;
          const german = narrow(
            yield* viaFetch(
              Accounts.exportAccounts(origin, true).execute({
                session: TOKEN,
                german: true,
              }),
            ),
            "Accounts",
          ).rows[0]!.amount;
          const extract = narrow(
            yield* viaFetch(
              Extract.extract(origin).execute({
                session: TOKEN,
                period: "202610",
              }),
            ),
            "Extract",
          ).value.items[0]!.amount;
          expect([invoice, balance, csv, german, extract]).toEqual([
            123450, 123450, 123450, 123450, 123450,
          ]);
        }),
    );

    it.live(
      "[VAL-1c] zero dates decode to none and others to UTC instants across XML-RPC, pipe and fixed width",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const settled = narrow(
            yield* viaFetch(
              Rpc.invoice(gateway.origin).execute({
                session: TOKEN,
                params: [1002],
              }),
            ),
            "Result",
          ).value;
          expect(settled.settled).toEqual(
            Option.some(utc("2026-10-03T08:15:30Z")),
          );
          expect(settled.paid).toBe(true);
          const open = narrow(
            yield* viaFetch(
              Rpc.invoice(gateway.origin).execute({
                session: TOKEN,
                params: [1001],
              }),
            ),
            "Result",
          ).value;
          expect(open.settled).toEqual(Option.none());
          expect(open.paid).toBe(false);
          const balance = narrow(
            yield* viaFetch(
              Session.balance(gateway.origin).execute({
                session: TOKEN,
                account: "00012346",
              }),
            ),
            "Balance",
          );
          expect(balance.due).toEqual(Option.none());
        }),
    );

    it.live(
      "[VAL-1c] a migrated invoice dated 31 February is a decode error, not a shifted date",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const error = yield* viaFetch(
            Rpc.invoice(gateway.origin)
              .execute({ session: TOKEN, params: [1999] })
              .pipe(Effect.flip),
          );
          expect(String(narrow(error, "DecodeError").cause)).toContain(
            '"19980231T00:00:00" is not a calendar date',
          );
        }),
    );

    it.live(
      "[VAL-3b] the paid flags travel as <boolean>1</boolean> and <boolean>0</boolean>",
      () =>
        Effect.gen(function* () {
          const gateway = yield* start();
          const raw = (id: number) =>
            viaFetch(
              Operation.make(
                Request.post(`${gateway.origin}/RPC2?session=${TOKEN}`).pipe(
                  Request.body(
                    Rpc.call("invoice.get", Schema.Tuple([XmlRpc.I4])),
                  ),
                ),
                Response.status(200, Body.text),
              ).execute({ body: [id] }),
            );
          expect(yield* raw(1001)).toContain("<boolean>0</boolean>");
          expect(yield* raw(1002)).toContain("<boolean>1</boolean>");
        }),
    );
  });
});
