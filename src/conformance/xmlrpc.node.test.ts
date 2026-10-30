/**
 * EXT-6a: the gateway's XML-RPC endpoint against Frontier::RPC2 and XMLRPC::Lite, recorded serving
 * the same five methods over the same data (`recordings/frontier-rpc2`, `recordings/xmlrpc-lite`).
 * The gateway writes Frontier::RPC2's bytes; XMLRPC::Lite's replies carry the same values in
 * another spelling. Node-only: the recordings are read from disk and compared with the raw status
 * and header lines the gateway sends.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json } from "../harness/lane.js";
import {
  data,
  date,
  differences,
  header,
  maskBody,
  masked,
  recorded,
  type Response,
  retarget,
  send,
  sortStructMembers,
  xmlRpcValues,
} from "./recordings.js";

const SESSION = "sso-recording";

/** The data both Perl servers served, with the SSO token the gateway takes as its session. */
const options = {
  ...(data("frontier-rpc2", "data.json") as Record<string, Json>),
  token: SESSION,
} satisfies Json;

/** Masked on both sides: Perl writes a struct's members in hash order, which changes per process. */
const memberOrder = maskBody("struct member order", sortStructMembers);

/**
 * Sends a recorded call to a fresh gateway. Adapted: the target carries the gateway's `session`
 * parameter, which the recorded servers do not take.
 */
const call = (set: string, name: string) =>
  Effect.gen(function* () {
    const exchange = recorded(set, name);
    const gateway = yield* lane.backend("gateway", options);
    const actual = yield* send(
      gateway.origin,
      retarget(exchange.request, `/RPC2?session=${SESSION}`),
    );
    return masked([exchange.response, actual], [date, memberOrder]);
  });

/** The header lines every gateway reply differs in from a Perl daemon's, as the service page says. */
const DAEMON = [
  // Kept: HTTP::Daemon closes after each reply without saying so; Node's server, asked to close,
  // answers `Connection: close` (recordings/README.md, "Comparing").
  "header connection",
  // Kept: the gateway's replies come through Apache 1.3 (services/gateway.md, "Recordings").
  "header server",
];

/** A fault's code and string as values. */
const fault = ([code, text]: readonly [string, string]) => ({
  fault: {
    struct: [
      ["faultCode", { int: code }],
      ["faultString", { string: text }],
    ],
  },
});

/** A fault body without its code and string. */
const shape = (response: Response) =>
  response.body
    .toString("utf8")
    .replace(/<i4>[^<]*<\/i4>/, "<i4/>")
    .replace(/<string>[^<]*<\/string>/, "<string/>");

/** A recorded XMLRPC::Lite reply's text. */
const lite = (name: string) =>
  recorded("xmlrpc-lite", name).response.body.toString("utf8");

const SAME_BYTES = [
  "list-methods",
  "report-count",
  "invoice-get",
  "invoice-unpaid",
  "extract-fetch",
];

describe("[EXT-6a] the gateway's XML-RPC replies against Frontier::RPC2", () => {
  for (const name of SAME_BYTES)
    it.live(
      `[EXT-6a] ${name}: the gateway writes Frontier::RPC2's bytes, members in any order`,
      () =>
        Effect.gen(function* () {
          const [expected, actual] = yield* call("frontier-rpc2", name);
          expect(differences(expected, actual)).toEqual(DAEMON);
          expect(header(expected, "server")).toEqual([
            "libwww-perl-daemon/6.16",
          ]);
          expect(header(actual, "server")).toEqual(["Apache/1.3.41 (Unix)"]);
        }),
    );

  it.live(
    "[EXT-6a] account-title: Frontier::RPC2 types the title and writes character references; the gateway's hand-written reply does neither",
    () =>
      Effect.gen(function* () {
        const [expected, actual] = yield* call(
          "frontier-rpc2",
          "account-title",
        );
        // Kept: the 1999 handler prints its reply itself (services/gateway.md, "XML-RPC").
        expect(differences(expected, actual)).toEqual([
          "header connection",
          "header content-length",
          "header server",
          "body",
        ]);
        expect(expected.body.toString("latin1")).toContain(
          "<param><value><string>Caf&#233; M&#252;ller</string></value></param>\n",
        );
        expect(actual.body.toString("utf8")).toContain(
          "<param><value>Café Müller</value></param>\n",
        );
      }),
  );

  const faults: ReadonlyArray<
    readonly [string, readonly [string, string], readonly [string, string]]
  > = [
    [
      "fault-not-found",
      ["4", "error executing RPC `invoice.get'.\nno such invoice 999\n"],
      ["404", "no such invoice 999"],
    ],
    [
      "fault-unknown-method",
      ["3", "no such method `report.missing'\n"],
      ["-32601", "server error. requested method report.missing not found"],
    ],
    [
      "fault-malformed",
      [
        "1",
        "error decoding RPC.\n\nnot well-formed (invalid token) at line 2, column 83, byte 105 at /usr/lib/x86_64-linux-gnu/perl5/5.36/XML/Parser.pm line 187.\n",
      ],
      ["-32700", "parse error. not well formed"],
    ],
  ];
  for (const [name, frontier, gateway] of faults)
    it.live(
      `[EXT-6a] ${name}: the same fault layout, with the gateway's own code and string`,
      () =>
        Effect.gen(function* () {
          const [expected, actual] = yield* call("frontier-rpc2", name);
          // Kept: the gateway's dispatcher writes its own codes through encode_fault
          // (services/gateway.md, "Faults").
          expect(differences(expected, actual)).toEqual([
            "header connection",
            "header content-length",
            "header server",
            "body",
          ]);
          expect(xmlRpcValues(expected.body)).toEqual(fault(frontier));
          expect(xmlRpcValues(actual.body)).toEqual(fault(gateway));
          // Everything but the two values is Frontier::RPC2's encode_fault layout.
          expect(shape(actual)).toBe(shape(expected));
        }),
    );

  it.live(
    "[EXT-6a] not-xml: Frontier::RPC2 decodes a text/plain call; the gateway's Apache refuses it with 400",
    () =>
      Effect.gen(function* () {
        const [expected, actual] = yield* call("frontier-rpc2", "not-xml");
        // Kept: the refusal is the gateway's Apache configuration, not the module's
        // (services/gateway.md, "XML-RPC").
        expect(differences(expected, actual)).toEqual([
          "status",
          "reason",
          "header connection",
          "header content-length",
          "header content-type",
          "header server",
          "body",
        ]);
        expect([expected.status, actual.status]).toEqual([200, 400]);
        expect(xmlRpcValues(expected.body)).toEqual({ params: [{ int: "3" }] });
      }),
  );
});

describe("[EXT-6a] the gateway's XML-RPC replies against XMLRPC::Lite", () => {
  /** The header lines a gateway reply differs in from XMLRPC::Lite's daemon. */
  const LITE = [
    "header connection",
    "header content-length",
    "header server",
    // Kept: XMLRPC::Lite names itself in SOAPServer; Frontier::RPC2 and Apache do not.
    "header soapserver",
    "body",
  ];

  for (const name of SAME_BYTES)
    it.live(
      `[EXT-6a] ${name}: XMLRPC::Lite sends the gateway's values in its own spelling`,
      () =>
        Effect.gen(function* () {
          const [expected, actual] = yield* call("xmlrpc-lite", name);
          expect(differences(expected, actual)).toEqual(LITE);
          expect(xmlRpcValues(actual.body)).toEqual(
            xmlRpcValues(expected.body),
          );
        }),
    );

  it.live(
    "[EXT-6a] XMLRPC::Lite writes <int>, base64 on one line, raw UTF-8 and no white space between elements",
    () =>
      Effect.gen(function* () {
        expect(lite("report-count")).toBe(
          '<?xml version="1.0" encoding="UTF-8"?><methodResponse><params><param><value><int>3</int></value></param></params></methodResponse>',
        );
        expect(lite("extract-fetch")).toMatch(
          /<base64>[A-Za-z0-9+/=]{428}<\/base64>/,
        );
        expect(lite("account-title")).toContain("<string>Café Müller</string>");
        expect(lite("invoice-unpaid")).toContain("<array><data /></array>");
        // The gateway's spelling of the same values is Frontier::RPC2's.
        const [, actual] = yield* call("xmlrpc-lite", "extract-fetch");
        expect(actual.body.toString("utf8")).toMatch(
          /<base64>(?:[A-Za-z0-9+/]{76}\n){5}[A-Za-z0-9+/=]{48}\n<\/base64>/,
        );
      }),
  );

  it.live(
    "[EXT-6a] account-title: XMLRPC::Lite types the title as a string, which the gateway leaves untyped",
    () =>
      Effect.gen(function* () {
        const [expected, actual] = yield* call("xmlrpc-lite", "account-title");
        expect(differences(expected, actual)).toEqual(LITE);
        expect(xmlRpcValues(expected.body)).toEqual({
          params: [{ string: "Café Müller" }],
        });
        expect(xmlRpcValues(actual.body)).toEqual({
          params: [{ untyped: "Café Müller" }],
        });
      }),
  );

  const faults: ReadonlyArray<readonly [string, string, string]> = [
    ["fault-not-found", "404", "404"],
    ["fault-unknown-method", "Client", "-32601"],
    ["fault-malformed", "Client", "-32700"],
    ["not-xml", "Client", ""],
  ];
  for (const [name, liteCode, gateway] of faults)
    it.live(
      `[EXT-6a] ${name}: XMLRPC::Lite's fault code is ${liteCode}; the gateway's ${gateway === "" ? "Apache answers 400" : gateway}`,
      () =>
        Effect.gen(function* () {
          const [expected, actual] = yield* call("xmlrpc-lite", name);
          // Kept: the gateway's codes and its Apache refusal (services/gateway.md, "Faults").
          expect(differences(expected, actual)).toEqual(
            gateway === ""
              ? [
                  "status",
                  "reason",
                  ...LITE.slice(0, 2),
                  "header content-type",
                  ...LITE.slice(2),
                ]
              : LITE,
          );
          expect(xmlRpcValues(expected.body)).toMatchObject({
            fault: {
              struct: [
                [
                  "faultCode",
                  liteCode === "Client"
                    ? { string: liteCode }
                    : { int: liteCode },
                ],
                ["faultString", {}],
              ],
            },
          });
          if (gateway === "") expect(actual.status).toBe(400);
          else
            expect(xmlRpcValues(actual.body)).toMatchObject({
              fault: {
                struct: [
                  ["faultCode", { int: gateway }],
                  ["faultString", {}],
                ],
              },
            });
        }),
    );
});
