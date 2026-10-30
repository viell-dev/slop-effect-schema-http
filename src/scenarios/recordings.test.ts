import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as Envelopes from "../clients/business/envelopes.js";
import { Digest, Rpc, Session } from "../clients/gateway/index.js";
import { Actions, Soap } from "../clients/soap-store/index.js";
import * as XmlRpc from "../formats/xmlrpc.js";
import {
  bodyText,
  header,
  pathOf,
  type Backend,
  type Recorded,
} from "../harness/lane.js";

/*
 * The consumer's contracts against the bytes real server software wrote (EXT-8a to EXT-8d). The
 * `replay` backend (services/replay.md) serves responses recorded from Perl's Frontier::RPC2 and
 * XMLRPC::Lite, httpd 2.4, Tomcat 7 and the JAX-WS reference implementation
 * (recordings/README.md); each test sends the consumer's own request and decodes the answer
 * through the consumer's own operations. Every test runs in the Node lane and in Chromium.
 *
 * The replay backend answers a request with the first unused exchange of the same method and
 * target, whatever its headers and body. Where a consumer contract cannot produce a recorded
 * target, the test adapts the request on the wire and names the adaptation: the gateway's
 * `session` parameter, which the recorded Perl servers never took, and the SOAP 1.2 endpoint
 * `/soap12`, which the store serves at `/soap`.
 *
 * Expected values are written in the consumer's terms from the recordings' synthetic data
 * (`recordings/<set>/data.json`, `set.json`). Header values and Digest nonces are copied from the
 * recorded `.response.http` and `.request.http` files; a re-recording changes the nonces and the
 * Digest constants with them.
 */

/** Start the replay backend serving `names` from one recording set, each answering once. */
const replay = (
  set: string,
  names: ReadonlyArray<string>,
  options: { readonly reuse?: boolean } = {},
) =>
  lane.backend("replay", {
    exchanges: names.map((name) => `${set}/${name}`),
    ...(options.reuse === undefined ? {} : { reuse: options.reuse }),
  });

const utc = (iso: string) => DateTime.makeUnsafe(iso);

/** Narrow a tagged union to one member, failing the test otherwise. */
const narrow = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

/** The failure an effect ended with, failing the test if it succeeded. */
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    expect(Exit.isFailure(exit)).toBe(true);
    return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
  });

/** The metadata of every response the client receives while `effect` runs. */
const observing = <A, E, R>(
  seen: Array<Response.Metadata>,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.updateService(HttpClient.HttpClient, (client) =>
      HttpClient.tap(client, (response) =>
        Effect.sync(() => {
          seen.push(Response.metadata(response));
        }),
      ),
    ),
  );

/** The `Location` lines a provider that reports original lines observed, or none. */
const locationLines = (metadata: Response.Metadata) =>
  Option.map(metadata.headerLines, (lines) =>
    lines.filter(([name]) => name.toLowerCase() === "location"),
  );

const requestLine = (recorded: Recorded) =>
  `${recorded.method} ${recorded.target}`;

// ---------------------------------------------------------------------------------------------
// EXT-8a: XML-RPC from Frontier::RPC2 and XMLRPC::Lite
// ---------------------------------------------------------------------------------------------

/** Any session; the recorded servers took none, so the client below removes it again. */
const SESSION = "sso-7f3a9c41";

const rpcInput = <P>(params: P) => ({ session: SESSION, params });

/**
 * The one adaptation of the gateway's XML-RPC contracts: the recorded servers were called at
 * `/RPC2` without the gateway's `session` parameter, so the client drops it from the target.
 * Method, headers and body are the contract's own.
 */
const withoutSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.updateService(HttpClient.HttpClient, (client) =>
      HttpClient.mapRequest(client, (request) => {
        const url = new URL(request.url);
        url.searchParams.delete("session");
        return HttpClientRequest.setUrl(request, url.href);
      }),
    ),
  );

/** Through Fetch, without the session parameter. */
const rpc = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  effect.pipe(withoutSession, Effect.provide(lane.fetchClient));

/** POST a call's text as written, under `contentType`, and decode the reply as `method` does. */
const rawCall = <A, RD>(
  origin: string,
  text: string,
  contentType: string,
  result: Schema.Codec<A, XmlRpc.Value, RD, unknown>,
) =>
  Operation.make(
    Request.post(`${origin}/RPC2`).pipe(
      Request.body(
        Body.encoder((body: string) =>
          Effect.succeed(HttpBody.text(body, contentType)),
        ),
      ),
    ),
    Response.status(200, Rpc.answer(result)),
  ).execute({ body: text });

/** The calls the recorder sent, from `set.json`, as the consumer's reader parses them. */
const recordedCall = (methodName: string, params: Array<XmlRpc.Value>) => ({
  methodName,
  params,
});

/** Each ledger entry was the consumer's own text/xml call at `/RPC2`, without `session`. */
const expectCalls = (
  ledger: ReadonlyArray<Recorded>,
  calls: ReadonlyArray<XmlRpc.MethodCall>,
) => {
  expect(ledger.map(requestLine)).toEqual(calls.map(() => "POST /RPC2"));
  for (const [index, call] of calls.entries()) {
    expect(header(ledger[index]!.lines, "content-type")).toBe("text/xml");
    expect(XmlRpc.parseCall(bodyText(ledger[index]!))).toEqual(call);
  }
};

const methodNames = [
  "system.listMethods",
  "report.count",
  "account.title",
  "invoice.get",
  "extract.fetch",
];

const invoice7 = {
  id: 7,
  account: "00012345",
  amount: 98760,
  paid: true,
  issued: utc("1998-11-02T09:30:00Z"),
  settled: Option.some(utc("1998-11-30T16:45:10Z")),
  lines: [
    { text: 'Consulting "Q4" & <travel>', amount: 50000 },
    { text: "Überstunden", amount: 48760 },
  ],
};

const extract202610 = {
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
      account: "00067890",
      title: "Ölmühle Rhein",
      amount: 50000,
      due: Option.none(),
      status: "paid",
    },
    {
      account: "00024680",
      title: "Bäckerei Groß & Söhne",
      amount: 7,
      due: Option.some(utc("2026-12-01T00:00:00Z")),
      status: "cancelled",
    },
  ],
};

/** The recorded call with a bare `&`, which the consumer's writer cannot produce (set.json). */
const malformedCall =
  '<?xml version="1.0"?>\n<methodCall><methodName>account.title</methodName><params><param><value><string>A & B</string></value></param></params></methodCall>\n';

/** The recorded well-formed call that the recorder sent as `text/plain` (set.json). */
const countCall =
  '<?xml version="1.0"?>\n<methodCall><methodName>report.count</methodName><params><param><value><string>202610</string></value></param></params></methodCall>\n';

/** A Fault outcome, or the contract's decode error for a fault the specification does not allow. */
type Expected =
  | { readonly _tag: "Fault"; readonly code: number; readonly message: string }
  | { readonly _tag: "DecodeError" };

/** What each set answers to the fault exchanges and the text/plain call. */
const xmlRpcSets: ReadonlyArray<{
  readonly set: string;
  readonly spelling: string;
  readonly notFound: Expected;
  readonly unknownMethod: Expected;
  readonly malformed: Expected;
  readonly notXml: Expected | { readonly _tag: "Result"; readonly value: 3 };
}> = [
  {
    set: "frontier-rpc2",
    spelling:
      "<i4>, character references, MIME::Base64's 76-column lines, a line end after typed values",
    notFound: {
      _tag: "Fault",
      code: 4,
      message: "error executing RPC `invoice.get'.\nno such invoice 999\n",
    },
    unknownMethod: {
      _tag: "Fault",
      code: 3,
      message: "no such method `report.missing'\n",
    },
    malformed: {
      _tag: "Fault",
      code: 1,
      message:
        "error decoding RPC.\n\nnot well-formed (invalid token) at line 2, column 83, byte 105 at /usr/lib/x86_64-linux-gnu/perl5/5.36/XML/Parser.pm line 187.\n",
    },
    // Frontier::RPC2 decodes whatever arrives.
    notXml: { _tag: "Result", value: 3 },
  },
  {
    set: "xmlrpc-lite",
    spelling:
      "<int>, raw UTF-8, base64 on one line, <data />, no white space between elements",
    notFound: { _tag: "Fault", code: 404, message: "no such invoice 999" },
    // The specification makes faultCode an <int>; XMLRPC::Lite writes the string Client.
    unknownMethod: { _tag: "DecodeError" },
    malformed: { _tag: "DecodeError" },
    notXml: { _tag: "DecodeError" },
  },
];

/** Assert an outcome against what a set answers: a fault, a result, or the contract's decode error. */
const expectOutcome = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  expected: Expected | { readonly _tag: "Result"; readonly value: unknown },
) =>
  Effect.gen(function* () {
    if (expected._tag !== "DecodeError") {
      expect(yield* effect).toEqual(expected);
      return;
    }
    const error = yield* failureOf(effect);
    expect(error).toBeInstanceOf(Response.DecodeError);
    // The decode error names the faultCode the specification does not allow.
    expect(String((error as Response.DecodeError<unknown>).cause)).toContain(
      '["fault"]["struct"]["faultCode"]',
    );
  });

// ---------------------------------------------------------------------------------------------
// EXT-8b: Digest from httpd 2.4.68's mod_auth_digest, with curl as the client
// ---------------------------------------------------------------------------------------------

/** The credentials curl was given (recordings/httpd-digest/set.json). */
const auditor = { username: "auditor", password: "Secr3t!" } as const;
const wrongAuditor = { username: "auditor", password: "wrong" } as const;
const auditTarget = "/admin/audit.cgi?period=202610";
const auditPeriod = { query: { period: "202610" }, headers: {} };

/** httpd's nonces, from the recorded challenges. */
const nonces = {
  challenge: "u1qQPANfBgA=6296e029f0559fecc13ade3fb4d6a3f64d64b238",
  stale: "Sn7jPANfBgA=2b3ddf55575caf8cd17b68087b8132249bace3a5",
  wrongChallenge: "v4f+PANfBgA=872b063378fd1054294036340db3fc419be75b0c",
  wrongPassword: "bJv+PANfBgA=7913f5075562d7809172f41ce66099dd81bafe11",
};

/** The `Authorization` lines curl sent, from accepted.request.http and wrong-password.request.http. */
const curl = {
  accepted: `Digest username="auditor", realm="Reporting Gateway", nonce="${nonces.challenge}", uri="${auditTarget}", response="a6d91b38fb38c522a176f55a5a0effdf", algorithm=MD5`,
  wrongPassword: `Digest username="auditor", realm="Reporting Gateway", nonce="${nonces.wrongChallenge}", uri="${auditTarget}", response="7eb552442f62c9137c4657319ab22c17", algorithm=MD5`,
};

/** The CGI's pipe line, `OK|202610|3|173457`, as the audit contract decodes it. */
const auditReport = {
  _tag: "Audit",
  period: "202610",
  records: 3,
  controlTotal: 173457,
};

/** The audit contract: the cold request, and the operation that declares the challenge. */
const audit = (origin: string) => {
  const request = Digest.auditRequest(origin);
  const operation = Operation.make(request, Digest.auditResponse);
  return { request, operation };
};

/** The `Authorization` each request carried, if any. */
const authorizations = (ledger: ReadonlyArray<Recorded>) =>
  ledger.map((entry) => header(entry.lines, "authorization"));

// ---------------------------------------------------------------------------------------------
// EXT-8c: redirects from httpd 2.4.69's Redirect permanent and Tomcat 7.0.109
// ---------------------------------------------------------------------------------------------

/** httpd's Location, built from the recorded request's `Host: gateway.example:8080`. */
const httpdLocation =
  "http://gateway.example:8080/cgi-bin/report.cgi?session=sso-7f3a9c41&report=balance&account=00012345";

/** Providers that hand a redirect to the caller instead of following it, per lane. */
const handing: ReadonlyArray<
  readonly [
    string,
    <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>>,
  ]
> = [
  ...(lane.linesClient === undefined
    ? []
    : [
        [
          "lines",
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.provide(effect, lane.linesClient!),
        ] as const,
      ]),
  [
    'fetch, redirect: "manual"',
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
        }),
        Effect.provide(lane.fetchClient),
      ),
  ],
];

/** The recorded body of every creation (tomcat7-redirect/*.request.http). */
const globex = { name: "Globex Corporation", tier: "GOLD" } as const;

/** sendRedirect's 302s: the exchange, the servlet's `variant`, the path, and the Location Tomcat wrote. */
const redirects = [
  ["redirect", "redirect", "/v1/customers", "/v1/customers/1006"],
  ["relative", "relative", "/v1/customers", "customers/1006"],
  [
    "redirect-then-200",
    "redirect-then-200",
    "/v1/customers",
    "/v1/customers/1006",
  ],
  [
    "legacy-redirect",
    "redirect",
    "/legacy/v1/customers",
    "http://business.example:8080/v1/customers/1006",
  ],
  [
    "legacy-relative",
    "relative",
    "/legacy/v1/customers",
    "http://business.example:8080/legacy/v1/customers/1006",
  ],
  [
    "legacy-redirect-then-200",
    "redirect-then-200",
    "/legacy/v1/customers",
    "http://business.example:8080/v1/customers/1006",
  ],
] as const;

/**
 * The creation contract with the servlet's `variant` query, which selects sendRedirect in the
 * recording: the one adaptation of the consumer's request.
 */
const creation = (origin: string, path: string, variant: string) => {
  const api = Envelopes.make(
    path.startsWith("/legacy/") ? `${origin}/legacy` : origin,
  );
  return Operation.make(
    api.requests.createCustomer.pipe(Request.appendQuery("variant", variant)),
    api.responses.createCustomer,
  );
};

// ---------------------------------------------------------------------------------------------
// EXT-8d: SOAP faults from the JAX-WS reference implementation in JDK 8
// ---------------------------------------------------------------------------------------------

const NS = "urn:docvault:store:2003";

/** The calls the recording made, as the consumer writes them. */
const lockCalls = [
  // The consumer refuses a missing owner before dispatch, so it asks with one.
  { id: "DOC-000001", owner: "clerk-7", seconds: 300 },
  { id: "DOC-999999", owner: "clerk-7", seconds: 300 },
  { id: "DOC-000001", owner: "clerk-7", seconds: 300 },
];

/** The faults the RI answered, in the consumer's terms, in both SOAP versions. */
const lockFaults = [
  {
    _tag: "SoapFault",
    code: "Sender",
    message: "Id and Owner are required",
  },
  {
    _tag: "DocumentNotFound",
    code: "Sender",
    message: "No document with id DOC-999999",
    id: "DOC-999999",
  },
  {
    _tag: "LockConflict",
    code: "Receiver",
    message: "Document DOC-000001 is locked by archive-robot",
    heldBy: "archive-robot",
    expires: "2026-11-01T12:05:00Z",
  },
];

/** Each call in turn through the consumer's LockDocument operation. */
const locks = (backend: Backend, soap: Soap.Protocol) =>
  Effect.forEach(lockCalls, (body) =>
    Actions.operations(backend.origin, soap).lockDocument.execute({
      body,
    }),
  );

describe(`recordings (${lane.name})`, () => {
  describe("EXT-8a: XML-RPC", () => {
    for (const { set, spelling, ...answers } of xmlRpcSets) {
      it.live(
        `[EXT-8a] ${set}: the method list, the integer and the title decode through the gateway's contracts (${spelling})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay(set, [
              "list-methods",
              "report-count",
              "account-title",
            ]);
            expect(
              yield* rpc(
                Rpc.listMethods(backend.origin).execute(rpcInput([] as const)),
              ),
            ).toEqual({ _tag: "Result", value: methodNames });
            expect(
              yield* rpc(
                Rpc.reportCount(backend.origin).execute(rpcInput(["202610"])),
              ),
            ).toEqual({ _tag: "Result", value: 3 });
            // Typed as <string> by both modules, where the gateway's hand-written reply is untyped.
            expect(
              yield* rpc(
                Rpc.accountTitle(backend.origin).execute(
                  rpcInput(["00012345"]),
                ),
              ),
            ).toEqual({ _tag: "Result", value: "Café Müller" });
            expectCalls(yield* backend.ledger, [
              recordedCall("system.listMethods", []),
              recordedCall("report.count", [{ string: "202610" }]),
              recordedCall("account.title", [{ string: "00012345" }]),
            ]);
          }),
      );

      it.live(
        `[EXT-8a] ${set}: invoice 7 decodes through the gateway's struct contract, its members in Perl's hash order`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay(set, ["invoice-get"]);
            const outcome = yield* rpc(
              Rpc.invoice(backend.origin).execute({
                session: SESSION,
                params: [7],
              }),
            );
            expect(narrow(outcome, "Result").value).toEqual(invoice7);
            expectCalls(yield* backend.ledger, [
              recordedCall("invoice.get", [{ i4: "7" }]),
            ]);
          }),
      );

      it.live(
        `[EXT-8a] ${set}: invoice 8's migrated 31 February is the contract's decode error, and its other members decode`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay(set, ["invoice-unpaid"], {
              reuse: true,
            });
            const error = yield* failureOf(
              rpc(
                Rpc.invoice(backend.origin).execute({
                  session: SESSION,
                  params: [8],
                }),
              ),
            );
            expect(error).toBeInstanceOf(Response.DecodeError);
            expect(
              String((error as Response.DecodeError<unknown>).cause),
            ).toMatch(/"19980231T00:00:00" is not a calendar date/);
            // The same reply read with `issued` left as its lexical text: every other member,
            // including the false flag, the zero date and the empty array, decodes as declared.
            const rest = yield* rpc(
              Rpc.method(
                "invoice.get",
                Schema.Tuple([XmlRpc.I4]),
                XmlRpc.struct({
                  ...Rpc.InvoiceFields,
                  issued: XmlRpc.DateTimeText,
                }),
              )(backend.origin).execute({ session: SESSION, params: [8] }),
            );
            expect(narrow(rest, "Result").value).toEqual({
              id: 8,
              account: "00067890",
              amount: 5,
              paid: false,
              issued: "19980231T00:00:00",
              settled: Option.none(),
              lines: [],
            });
          }),
      );

      it.live(
        `[EXT-8a] ${set}: the extract's base64 decodes through the same fixed-width schema as the download`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay(set, ["extract-fetch"]);
            const outcome = yield* rpc(
              Rpc.extractFetch(backend.origin).execute({
                session: SESSION,
                params: ["202610"],
              }),
            );
            expect(narrow(outcome, "Result").value).toEqual(extract202610);
          }),
      );

      it.live(
        `[EXT-8a] ${set}: its faults are Fault outcomes where faultCode is an integer, and the contract's decode error where it is not`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay(set, [
              "fault-not-found",
              "fault-unknown-method",
              "fault-malformed",
            ]);
            yield* expectOutcome(
              rpc(
                Rpc.invoice(backend.origin).execute({
                  session: SESSION,
                  params: [999],
                }),
              ),
              answers.notFound,
            );
            yield* expectOutcome(
              rpc(
                Rpc.method(
                  "report.missing",
                  Schema.Tuple([]),
                  XmlRpc.I4,
                )(backend.origin).execute({ session: SESSION, params: [] }),
              ),
              answers.unknownMethod,
            );
            // The consumer's writer escapes `&`, so the recorded malformed call is sent as written.
            yield* expectOutcome(
              rpc(
                rawCall(
                  backend.origin,
                  malformedCall,
                  "text/xml",
                  XmlRpc.StringValue,
                ),
              ),
              answers.malformed,
            );
            const ledger = yield* backend.ledger;
            expectCalls(ledger.slice(0, 2), [
              recordedCall("invoice.get", [{ i4: "999" }]),
              recordedCall("report.missing", []),
            ]);
            expect(bodyText(ledger[2]!)).toBe(malformedCall);
          }),
      );

      it.live(
        `[EXT-8a] ${set}: the answer to a call sent as text/plain, decoded by report.count's decoder`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay(set, ["not-xml"]);
            yield* expectOutcome(
              rpc(rawCall(backend.origin, countCall, "text/plain", XmlRpc.I4)),
              answers.notXml,
            );
            const [call] = yield* backend.ledger;
            expect(requestLine(call!)).toBe("POST /RPC2");
            expect(header(call!.lines, "content-type")).toBe("text/plain");
            expect(bodyText(call!)).toBe(countCall);
          }),
      );
    }
  });

  describe("EXT-8b: Digest", () => {
    it.live(
      "[EXT-8b] the consumer's parser reads httpd's challenges: realm, a nonce holding + / and =, algorithm=MD5, stale=true unquoted, no opaque",
      () =>
        Effect.gen(function* () {
          const backend = yield* replay("httpd-digest", [
            "challenge",
            "stale",
            "wrong-challenge",
            "wrong-password",
          ]);
          const { operation } = audit(backend.origin);
          const challenges: Array<Digest.Challenge> = [];
          for (let index = 0; index < 4; index++)
            challenges.push(
              narrow(
                yield* operation
                  .execute(auditPeriod)
                  .pipe(Effect.provide(lane.fetchClient)),
                "Challenge",
              ).value,
            );
          const realm = "Reporting Gateway";
          expect(challenges).toEqual([
            { realm, nonce: nonces.challenge, opaque: undefined, stale: false },
            { realm, nonce: nonces.stale, opaque: undefined, stale: true },
            {
              realm,
              nonce: nonces.wrongChallenge,
              opaque: undefined,
              stale: false,
            },
            {
              realm,
              nonce: nonces.wrongPassword,
              opaque: undefined,
              stale: false,
            },
          ]);
          expect(authorizations(yield* backend.ledger)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
          ]);
        }),
    );

    it.live(
      "[EXT-8b] withDigest answers httpd's challenge with the Authorization curl sent, byte for byte, and reads the report under httpd's Authentication-Info",
      () =>
        Effect.gen(function* () {
          const backend = yield* replay("httpd-digest", [
            "challenge",
            "accepted",
            "replayed",
          ]);
          const { request, operation } = audit(backend.origin);
          const run = Digest.withDigest(request, operation, auditor);
          expect(narrow(yield* run(auditPeriod), "Report").value).toEqual(
            auditReport,
          );
          // httpd accepts the same Authorization again within the nonce's lifetime; the gateway
          // does not (AUTH-7). The consumer's report decodes the same either way.
          const again = yield* operation.execute({
            ...auditPeriod,
            headers: { authorization: curl.accepted },
          });
          expect(narrow(again, "Report").value).toEqual(auditReport);
          const ledger = yield* backend.ledger;
          expect(ledger.map(requestLine)).toEqual([
            `GET ${auditTarget}`,
            `GET ${auditTarget}`,
            `GET ${auditTarget}`,
          ]);
          expect(authorizations(ledger)).toEqual([
            undefined,
            curl.accepted,
            curl.accepted,
          ]);
        }).pipe(Effect.provide(lane.fetchClient)),
    );

    it.live(
      "[EXT-8b] httpd's stale=true challenge is answered once more, with the new nonce",
      () =>
        Effect.gen(function* () {
          const backend = yield* replay("httpd-digest", [
            "challenge",
            "stale",
            "accepted",
          ]);
          const { request, operation } = audit(backend.origin);
          const outcome = yield* Digest.withDigest(
            request,
            operation,
            auditor,
          )(auditPeriod);
          expect(narrow(outcome, "Report").value).toEqual(auditReport);
          const sent = authorizations(yield* backend.ledger);
          expect(sent.slice(0, 2)).toEqual([undefined, curl.accepted]);
          expect(sent[2]).toBe(
            Digest.authorization(
              auditor,
              {
                realm: "Reporting Gateway",
                nonce: nonces.stale,
                opaque: undefined,
                stale: true,
              },
              "GET",
              auditTarget,
            ),
          );
          expect(sent[2]).toContain(`nonce="${nonces.stale}"`);
        }).pipe(Effect.provide(lane.fetchClient)),
    );

    it.live(
      "[EXT-8b] a wrong password computes the response curl sent, and httpd's fresh challenge without stale ends the loop",
      () =>
        Effect.gen(function* () {
          const backend = yield* replay("httpd-digest", [
            "wrong-challenge",
            "wrong-password",
          ]);
          const { request, operation } = audit(backend.origin);
          const error = yield* Digest.withDigest(
            request,
            operation,
            wrongAuditor,
          )(auditPeriod).pipe(Effect.flip);
          expect(error).toBeInstanceOf(Digest.DigestRejected);
          expect(error).toMatchObject({
            requests: 2,
            challenge: { nonce: nonces.wrongPassword, stale: false },
          });
          expect(authorizations(yield* backend.ledger)).toEqual([
            undefined,
            curl.wrongPassword,
          ]);
        }).pipe(Effect.provide(lane.fetchClient)),
    );
  });

  describe("EXT-8c: redirects", () => {
    for (const [provider, via] of handing)
      it.live(
        `[EXT-8c] httpd-redirect/get: httpd's 301 reaches legacyBalance as ${provider} hands it over`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay("httpd-redirect", ["get"]);
            const seen: Array<Response.Metadata> = [];
            const exit = yield* via(
              observing(
                seen,
                // The recorded target's session and account, as the desktop client sent them.
                Session.legacyBalance(backend.origin).execute({
                  session: "sso-7f3a9c41",
                  account: "00012345",
                }),
              ),
            ).pipe(Effect.exit);
            const ledger = yield* backend.ledger;
            expect(ledger.map(requestLine)).toEqual([
              "GET /cgi-bin/rpt.exe?session=sso-7f3a9c41&report=balance&account=00012345",
            ]);
            if (lane.name === "node") {
              // Node hands the 301 over: the declared case, with the Location httpd wrote.
              expect(Exit.isSuccess(exit)).toBe(true);
              if (Exit.isSuccess(exit))
                expect(narrow(exit.value, "Moved").value).toEqual({
                  location: httpdLocation,
                });
              expect(seen.map((metadata) => metadata.status)).toEqual([301]);
              Option.match(locationLines(seen[0]!), {
                onNone: () => expect(provider).not.toBe("lines"),
                onSome: (lines) =>
                  expect(lines).toEqual([["Location", httpdLocation]]),
              });
            } else {
              // Chromium returns an opaque redirect: status 0 and no headers, so no case matches.
              const error = Exit.isFailure(exit)
                ? Cause.squash(exit.cause)
                : undefined;
              expect(error).toBeInstanceOf(Response.UnexpectedResponse);
              const metadata = (error as Response.UnexpectedResponse).metadata;
              expect(metadata.status).toBe(0);
              expect(metadata.headers["location"]).toBeUndefined();
            }
          }),
      );

    for (const [provider, client] of lane.clients)
      it.live(
        `[EXT-8c] tomcat7-redirect: a Location set on a 200, as Tomcat leaves it in both modes, reaches createCustomer's Created case (${provider})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay("tomcat7-redirect", [
              "header",
              "legacy-header",
            ]);
            const seen: Array<Response.Metadata> = [];
            const current = Envelopes.make(backend.origin);
            // The useRelativeRedirects="false" mode is served at the context path /legacy.
            const legacy = Envelopes.make(`${backend.origin}/legacy`);
            const outcomes = yield* observing(
              seen,
              Effect.all([
                current.createCustomer.execute({ body: globex }),
                legacy.createCustomer.execute({ body: globex }),
              ]),
            );
            for (const outcome of outcomes) {
              const created = narrow(outcome, "Created");
              // Tomcat sends no X-Served-By: the balancer adds it, and a creation is no less one
              // without it.
              expect(created.servedBy).toEqual(Option.none());
              // Root-relative, so even the legacy context's resolves outside /legacy.
              expect(created.location.href).toBe(
                `${backend.origin}/v1/customers/1006`,
              );
            }
            expect(
              seen.map((metadata) => metadata.headers["location"]),
            ).toEqual(["/v1/customers/1006", "/v1/customers/1006"]);
            for (const metadata of seen)
              Option.match(locationLines(metadata), {
                onNone: () => expect(provider).not.toBe("lines"),
                onSome: (lines) =>
                  expect(lines).toEqual([["Location", "/v1/customers/1006"]]),
              });
            const ledger = yield* backend.ledger;
            expect(ledger.map(requestLine)).toEqual([
              "POST /v1/customers",
              "POST /legacy/v1/customers",
            ]);
            for (const entry of ledger) {
              expect(header(entry.lines, "content-type")).toBe(
                "application/json",
              );
              expect(bodyText(entry)).toBe(
                '{"name":"Globex Corporation","tier":"GOLD"}',
              );
            }
          }).pipe(Effect.provide(client)),
      );

    for (const [provider, via] of handing)
      it.live(
        `[EXT-8c] tomcat7-redirect: sendRedirect's 302s are no case of the creation contract; ${provider} hands each over with the Location Tomcat wrote`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay(
              "tomcat7-redirect",
              redirects.map(([name]) => name),
            );
            for (const [, variant, path, location] of redirects) {
              const error = yield* failureOf(
                via(
                  creation(backend.origin, path, variant).execute({
                    body: globex,
                  }),
                ),
              );
              expect(error).toBeInstanceOf(Response.UnexpectedResponse);
              const metadata = (error as Response.UnexpectedResponse).metadata;
              if (lane.name === "node") {
                expect(metadata.status).toBe(302);
                expect(metadata.headers["location"]).toBe(location);
                Option.match(locationLines(metadata), {
                  onNone: () => expect(provider).not.toBe("lines"),
                  onSome: (lines) =>
                    expect(lines).toEqual([["Location", location]]),
                });
              } else {
                // Chromium's opaque redirect again: no status and no Location to read.
                expect(metadata.status).toBe(0);
                expect(metadata.headers["location"]).toBeUndefined();
              }
            }
            expect((yield* backend.ledger).map(requestLine)).toEqual(
              redirects.map(
                ([, variant, path]) => `POST ${path}?variant=${variant}`,
              ),
            );
          }),
      );

    it.live(
      "[EXT-8c] tomcat7-redirect: Fetch follows sendRedirect's 302 to the path Tomcat wrote, or to the relative one resolved against the request, as a GET",
      () =>
        Effect.gen(function* () {
          // Only the 302s whose Location stays on the replay backend's origin are followed here;
          // the legacy ones name business.example:8080, which no test reaches.
          const followed = redirects.filter(
            ([, , , location]) => !location.startsWith("http://"),
          );
          const backend = yield* replay(
            "tomcat7-redirect",
            followed.map(([name]) => name),
          );
          for (const [, variant, path] of followed) {
            const error = yield* failureOf(
              creation(backend.origin, path, variant).execute({
                body: globex,
              }),
            );
            // The replay backend holds no GET of the new customer, so the followed GET is a 404.
            expect(error).toBeInstanceOf(Response.UnexpectedResponse);
            expect((error as Response.UnexpectedResponse).metadata.status).toBe(
              404,
            );
          }
          const ledger = yield* backend.ledger;
          expect(ledger.map(requestLine)).toEqual(
            followed.flatMap(([, variant, path]) => [
              `POST ${path}?variant=${variant}`,
              "GET /v1/customers/1006",
            ]),
          );
          // The GET carries no body: Fetch turns a 302 after POST into a GET.
          for (const entry of ledger.filter(
            (recorded) => recorded.method === "GET",
          ))
            expect(entry.body).toEqual(new Uint8Array());
        }).pipe(Effect.provide(lane.fetchClient)),
    );
  });

  describe("EXT-8d: SOAP faults", () => {
    it.live(
      "[EXT-8d] jaxws-faults: the RI's SOAP 1.1 faults under 500 decode through LockDocument's fault rule: S:Client and S:Server, with and without detail",
      () =>
        Effect.gen(function* () {
          const backend = yield* replay("jaxws-faults", [
            "soap11-missing-owner",
            "soap11-not-found",
            "soap11-conflict",
          ]);
          const refused = yield* failureOf(
            Actions.operations(
              backend.origin,
              Soap.Soap11,
            ).lockDocument.execute({
              body: { id: "DOC-000001", owner: "", seconds: 300 },
            }),
          );
          // The request's body codec refuses the empty owner; nothing is sent.
          expect(refused).toMatchObject({ _tag: "SchemaError" });
          expect(yield* backend.ledger).toEqual([]);
          expect(yield* locks(backend, Soap.Soap11)).toEqual(lockFaults);
          const ledger = yield* backend.ledger;
          expect(ledger.map(requestLine)).toEqual([
            "POST /soap",
            "POST /soap",
            "POST /soap",
          ]);
          for (const entry of ledger) {
            expect(header(entry.lines, "content-type")).toBe(
              "text/xml; charset=utf-8",
            );
            expect(header(entry.lines, "soapaction")).toBe(
              `"${NS}#LockDocument"`,
            );
          }
        }).pipe(Effect.provide(lane.fetchClient)),
    );

    it.live(
      "[EXT-8d] jaxws-faults: the RI's SOAP 1.2 faults under 500 decode through LockDocument's fault rule: S:Sender and S:Receiver, with and without Detail",
      () =>
        Effect.gen(function* () {
          const backend = yield* replay("jaxws-faults", [
            "soap12-missing-owner",
            "soap12-not-found",
            "soap12-conflict",
          ]);
          // The RI's SOAP 1.2 binding was published at /soap12; the store serves both at /soap.
          const toSoap12 = Effect.updateService(
            HttpClient.HttpClient,
            (client: HttpClient.HttpClient) =>
              HttpClient.mapRequest(client, (request) =>
                HttpClientRequest.setUrl(
                  request,
                  request.url.replace(/\/soap$/, "/soap12"),
                ),
              ),
          );
          expect(yield* locks(backend, Soap.Soap12).pipe(toSoap12)).toEqual(
            lockFaults,
          );
          const ledger = yield* backend.ledger;
          expect(ledger.map(pathOf)).toEqual(["/soap12", "/soap12", "/soap12"]);
          for (const entry of ledger)
            expect(header(entry.lines, "content-type")).toBe(
              `application/soap+xml; charset=utf-8; action="${NS}#LockDocument"`,
            );
        }).pipe(Effect.provide(lane.fetchClient)),
    );
  });
});
