/**
 * EXT-31: the gateway against its service page (`services/gateway.md`) where no recording reaches:
 * Apache's 404 and 405 pages (EXT-31a), query values as bytes (EXT-31b), and messages that quote
 * the request unescaped (EXT-31c). No Apache 1.3 can be recorded and the CGI.pm recording quotes
 * nothing, so the page is the referee: every expected answer is written out here from the page,
 * byte for byte, and nothing is shared with the backend.
 *
 * Node-only: the requests are written on a raw socket, some with bytes no client sends, and the
 * replies are compared as status, header lines and bytes. A string here is one character per byte,
 * so `"\xC3\xA4"` is the two bytes of UTF-8's `ä`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json } from "../harness/lane.js";
import { header, type Response, send } from "./recordings.js";

const TOKEN = "t\xF6k";
const PERIOD = "199812";

const account = {
  account: "00012345",
  title: "Synthetic account",
  cents: 123450,
  due: "19990115",
};

const options = {
  token: TOKEN,
  users: { "j\xF6rg": "p\xE4sswort" },
  accounts: [account],
  extracts: {
    [PERIOD]: {
      runDate: "19990104",
      lastModified: "1999-01-04T06:00:00Z",
      records: [{ ...account, status: "O" }],
    },
  },
} satisfies Json;

/** The token's UTF-8 bytes, percent-encoded. */
const SESSION = "t%C3%B6k";

type Listener = "http" | "socket";
const LISTENERS: ReadonlyArray<Listener> = ["http", "socket"];

interface Ask {
  readonly method?: string;
  readonly target: string;
  readonly lines?: ReadonlyArray<string>;
  readonly body?: string;
}

const wire = ({ method = "GET", target, lines = [], body = "" }: Ask) =>
  Buffer.from(
    [
      `${method} ${target} HTTP/1.1`,
      "Host: gateway.example:8080",
      "Connection: close",
      ...lines,
      ...(body === "" ? [] : [`Content-Length: ${body.length}`]),
      "",
      "",
    ].join("\r\n") + body,
    "latin1",
  );

/** Send one request to a fresh gateway, check that it arrived as written, and give the reply. */
const ask = (listener: Listener, request: Ask) =>
  Effect.gen(function* () {
    const gateway = yield* lane.backend("gateway", options, { listener });
    const response = yield* send(gateway.origin, wire(request));
    const ledger = yield* gateway.ledger;
    expect(ledger.map((received) => received.target)).toEqual([request.target]);
    return response;
  }).pipe(Effect.timeout("3 seconds"));

/** A pipe reply: 200, `text/plain`, Apache's signature, and exactly these bytes. */
const expectPipe = (response: Response, bytes: string) => {
  expect(response.status).toBe(200);
  expect(header(response, "content-type")).toEqual(["text/plain"]);
  expect(header(response, "server")).toEqual(["Apache/1.3.41 (Unix)"]);
  expect(response.body.toString("latin1")).toBe(bytes);
};

/** Apache's page, as the page's "Apache's pages" section gives it. */
const page = (status: number, reason: string, message: string) =>
  '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n' +
  "<HTML><HEAD>\n" +
  `<TITLE>${status} ${reason}</TITLE>\n` +
  "</HEAD><BODY>\n" +
  `<H1>${reason}</H1>\n` +
  `${message}<P>\n` +
  "<HR>\n" +
  "<ADDRESS>Apache/1.3.41 Server</ADDRESS>\n" +
  "</BODY></HTML>\n";

const expectPage = (
  response: Response,
  status: number,
  reason: string,
  message: string,
) => {
  const bytes = page(status, reason, message);
  expect(response.status).toBe(status);
  expect(response.reason).toBe(reason);
  expect(header(response, "content-type")).toEqual([
    "text/html; charset=iso-8859-1",
  ]);
  expect(header(response, "content-length")).toEqual([
    String(Buffer.byteLength(bytes, "latin1")),
  ]);
  expect(header(response, "transfer-encoding")).toEqual([]);
  expect(header(response, "server")).toEqual(["Apache/1.3.41 (Unix)"]);
  expect(response.body.toString("latin1")).toBe(bytes);
};

const notFound = (path: string) =>
  `The requested URL ${path} was not found on this server.`;

const notAllowed = (method: string, path: string) =>
  `The requested method ${method} is not allowed for the URL ${path}.`;

describe("EXT-31a: Apache's own refusals are its HTML pages", () => {
  const missing: ReadonlyArray<readonly [target: string, path: string]> = [
    ["/nope", "/nope"],
    ["/cgi-bin/nope.cgi?session=x#closing", "/cgi-bin/nope.cgi"],
    ["/cgi-bin/help.cgi/", "/cgi-bin/help.cgi/"],
    [
      "/cgi-bin/help.cgi/accounts/closing",
      "/cgi-bin/help.cgi/accounts/closing",
    ],
    ["/cgi-bin/report.cgi/balance", "/cgi-bin/report.cgi/balance"],
    ["/cgi-bin/login%2Ecgi", "/cgi-bin/login%2Ecgi"],
  ];

  for (const listener of LISTENERS)
    for (const [target, path] of missing)
      it.live(
        `[EXT-31a] ${listener}: ${target} reaches no script, and is Apache's 404 page naming ${path}`,
        () =>
          Effect.gen(function* () {
            const response = yield* ask(listener, { target });
            expectPage(response, 404, "Not Found", notFound(path));
            expect(header(response, "allow")).toEqual([]);
          }),
      );

  it.live(
    '[EXT-31a] the 404 page writes &, <, > and " as references and every other byte of the path as it arrived',
    () =>
      Effect.gen(function* () {
        // `node:http` refuses these bytes on the request line; the socket listener passes them.
        const response = yield* ask("socket", {
          target: "/a&b<c>d\"e'f%20g\xE4h?x=<y>",
        });
        expectPage(
          response,
          404,
          "Not Found",
          notFound("/a&amp;b&lt;c&gt;d&quot;e'f%20g\xE4h"),
        );
      }),
  );

  const refused: ReadonlyArray<
    readonly [method: string, target: string, path: string, allow: string]
  > = [
    ["POST", "/cgi-bin/login.cgi", "/cgi-bin/login.cgi", "GET"],
    ["POST", "/cgi-bin/login.cgi?user=ann#x", "/cgi-bin/login.cgi", "GET"],
    ["DELETE", "/cgi-bin/extract.cgi", "/cgi-bin/extract.cgi", "GET, HEAD"],
    ["GET", "/cgi-bin/import.cgi", "/cgi-bin/import.cgi", "POST"],
    ["POST", "/cgi-bin/help.cgi/accounts", "/cgi-bin/help.cgi/accounts", "GET"],
    ["PUT", "/cgi-bin/go.cgi?section=closing", "/cgi-bin/go.cgi", "GET"],
    ["GET", "/RPC2", "/RPC2", "POST"],
    ["POST", "/admin/audit.cgi", "/admin/audit.cgi", "GET"],
  ];

  for (const listener of LISTENERS)
    for (const [method, target, path, allow] of refused)
      it.live(
        `[EXT-31a] ${listener}: ${method} ${target} is Apache's 405 page with Allow: ${allow}`,
        () =>
          Effect.gen(function* () {
            const response = yield* ask(listener, { method, target });
            expectPage(
              response,
              405,
              "Method Not Allowed",
              notAllowed(method, path),
            );
            expect(header(response, "allow")).toEqual([allow]);
          }),
      );

  it.live(
    "[EXT-31a] the 405 page names the method as it arrived, unescaped, and escapes the path",
    () =>
      Effect.gen(function* () {
        // `node:http` refuses an unknown method; the socket listener takes it to the first space.
        const response = yield* ask("socket", {
          method: "<BREW>",
          target: "/cgi-bin/help.cgi/a&b",
        });
        expectPage(
          response,
          405,
          "Method Not Allowed",
          notAllowed("<BREW>", "/cgi-bin/help.cgi/a&amp;b"),
        );
        expect(header(response, "allow")).toEqual(["GET"]);
      }),
  );

  for (const method of ["DELETE", "PUT"])
    it.live(
      `[EXT-31a] rpt.exe takes every method, so ${method} is its 301 and never 405`,
      () =>
        Effect.gen(function* () {
          const response = yield* ask("http", {
            method,
            target: "/cgi-bin/rpt.exe?report=balance",
          });
          expect(response.status).toBe(301);
          expect(header(response, "location")).toEqual([
            "http://gateway.example:8080/cgi-bin/report.cgi?report=balance",
          ]);
        }),
    );

  it.live(
    "[EXT-31a] extract.cgi's own 404 stays its text/plain ERROR line, not Apache's page",
    () =>
      Effect.gen(function* () {
        const response = yield* ask("http", {
          target: `/cgi-bin/extract.cgi?session=${SESSION}&period=199901`,
        });
        expect(response.status).toBe(404);
        expect(header(response, "content-type")).toEqual(["text/plain"]);
        expect(response.body.toString("latin1")).toBe(
          "ERROR|E_NOPERIOD|no extract for 199901\n",
        );
      }),
  );
});

describe("EXT-31b: query values are bytes", () => {
  const decoded: ReadonlyArray<readonly [query: string, quoted: string]> = [
    ["section=%E4", "\xE4"],
    ["section=%e4", "\xE4"],
    ["section=%C3%A4", "\xC3\xA4"],
    ["section=%FF%00%80", "\xFF\x00\x80"],
    ["section=a%20%G1%", "a %G1%"],
    ["section=%E", "%E"],
    ["section=a+b%2Bc", "a b+c"],
    ["section=%u00E4", "%u00E4"],
    ["section=%25E4", "%E4"],
  ];

  for (const listener of LISTENERS)
    for (const [query, quoted] of decoded)
      it.live(
        `[EXT-31b] ${listener}: go.cgi?${query} quotes the section as the bytes CGI.pm decodes`,
        () =>
          Effect.gen(function* () {
            const response = yield* ask(listener, {
              target: `/cgi-bin/go.cgi?${query}`,
            });
            expectPipe(response, `ERROR|E_SECTION|no section ${quoted}\n`);
          }),
      );

  const raw: ReadonlyArray<readonly [query: string, quoted: string]> = [
    ["section=\xE4", "\xE4"],
    ["section=\xC3\xA4", "\xC3\xA4"],
    ["section=\xC3%A4", "\xC3\xA4"],
  ];

  for (const [query, quoted] of raw)
    it.live(
      `[EXT-31b] socket: a raw byte outside ASCII is that byte, as its escape would be (${JSON.stringify(query)})`,
      () =>
        Effect.gen(function* () {
          const response = yield* ask("socket", {
            target: `/cgi-bin/go.cgi?${query}`,
          });
          expectPipe(response, `ERROR|E_SECTION|no section ${quoted}\n`);
        }),
    );

  it.live(
    "[EXT-31b] http: node:http answers a raw byte outside ASCII with its own 400 before any script runs",
    () =>
      Effect.gen(function* () {
        const gateway = yield* lane.backend("gateway", options);
        const response = yield* send(
          gateway.origin,
          wire({ target: "/cgi-bin/go.cgi?section=\xE4" }),
        );
        expect(response.status).toBe(400);
        expect(header(response, "server")).toEqual([]);
        expect(response.body.length).toBe(0);
      }).pipe(Effect.timeout("3 seconds")),
  );

  for (const listener of LISTENERS) {
    it.live(
      `[EXT-31b] ${listener}: report.cgi quotes an account and a report name as the decoded bytes`,
      () =>
        Effect.gen(function* () {
          expectPipe(
            yield* ask(listener, {
              target: `/cgi-bin/report.cgi?session=${SESSION}&report=balance&account=%E4`,
            }),
            "ERROR|E_NOACCT|no such account \xE4\n",
          );
          expectPipe(
            yield* ask(listener, {
              target: `/cgi-bin/report.cgi?session=${SESSION}&report=%C3%BC`,
            }),
            "ERROR|E_PARAM|unknown report \xC3\xBC\n",
          );
        }),
    );

    it.live(
      `[EXT-31b] ${listener}: a value matches stored text by its UTF-8 bytes, and Latin-1 escapes do not`,
      () =>
        Effect.gen(function* () {
          const login = yield* ask(listener, {
            target: "/cgi-bin/login.cgi?user=j%C3%B6rg&passwd=p%C3%A4sswort",
          });
          expect(login.body.toString("latin1")).toMatch(/^OK\|[0-9a-f]{24}\n$/);
          expectPipe(
            yield* ask(listener, {
              target: "/cgi-bin/login.cgi?user=j%F6rg&passwd=p%E4sswort",
            }),
            "ERROR|E_AUTH|invalid user or password\n",
          );
          expectPipe(
            yield* ask(listener, {
              target: `/cgi-bin/report.cgi?session=${SESSION}&report=balance&account=00012345`,
            }),
            "OK|00012345|123450|19990115\n",
          );
          expectPipe(
            yield* ask(listener, {
              target:
                "/cgi-bin/report.cgi?session=t%F6k&report=balance&account=00012345",
            }),
            "ERROR|E_SESSION|session expired or unknown\n",
          );
        }),
    );
  }

  it.live(
    "[EXT-31b] socket: raw UTF-8 bytes match stored text the same as their escapes",
    () =>
      Effect.gen(function* () {
        const login = yield* ask("socket", {
          target: "/cgi-bin/login.cgi?user=j\xC3\xB6rg&passwd=p\xC3\xA4sswort",
        });
        expect(login.body.toString("latin1")).toMatch(/^OK\|[0-9a-f]{24}\n$/);
        expectPipe(
          yield* ask("socket", {
            target:
              "/cgi-bin/report.cgi?session=t\xC3\xB6k&report=balance&account=00012345",
          }),
          "OK|00012345|123450|19990115\n",
        );
      }),
  );

  it.live(
    "[EXT-31b] a message's own text stays UTF-8: import.cgi's refusal spells Fällig in UTF-8",
    () =>
      Effect.gen(function* () {
        const response = yield* ask("http", {
          method: "POST",
          target: `/cgi-bin/import.cgi?session=${SESSION}&locale=de_DE`,
          body: "\xEF\xBB\xBFKonto;Bezeichnung;Betrag;Due\r\n",
        });
        expectPipe(
          response,
          "ERROR|E_FORMAT|line 1: expected Konto;Bezeichnung;Betrag;F\xC3\xA4llig\n",
        );
      }),
  );
});

describe("EXT-31c: messages quote the request unescaped", () => {
  const quoted: ReadonlyArray<readonly [target: string, bytes: string]> = [
    ["/cgi-bin/help.cgi/accounts#a|b", "ERROR|E_SECTION|no section a|b\n"],
    [
      "/cgi-bin/help.cgi/accounts?lang=de#a|b|c",
      "ERROR|E_SECTION|no section a|b|c\n",
    ],
    ["/cgi-bin/help.cgi/accounts#a%7Cb", "ERROR|E_SECTION|no section a%7Cb\n"],
    ["/cgi-bin/help.cgi/a|b", "ERROR|E_TOPIC|no topic a|b\n"],
    ["/cgi-bin/help.cgi/a%7Cb#closing", "ERROR|E_TOPIC|no topic a%7Cb\n"],
    ["/cgi-bin/go.cgi?section=a%7Cb", "ERROR|E_SECTION|no section a|b\n"],
    ["/cgi-bin/go.cgi?section=a|b", "ERROR|E_SECTION|no section a|b\n"],
    [
      `/cgi-bin/report.cgi?session=${SESSION}&report=x%7Cy`,
      "ERROR|E_PARAM|unknown report x|y\n",
    ],
    [
      `/cgi-bin/report.cgi?session=${SESSION}&report=balance&account=1|2`,
      "ERROR|E_NOACCT|no such account 1|2\n",
    ],
  ];

  for (const listener of LISTENERS)
    for (const [target, bytes] of quoted)
      it.live(
        `[EXT-31c] ${listener}: ${target} quotes its | in the message as it is`,
        () =>
          Effect.gen(function* () {
            expectPipe(yield* ask(listener, { target }), bytes);
          }),
      );

  it.live(
    "[EXT-31c] the page's example: #a|b answers 31 bytes, whose message after the second | is no section a|b",
    () =>
      Effect.gen(function* () {
        const response = yield* ask("http", {
          target: "/cgi-bin/help.cgi/accounts#a|b",
        });
        expect(response.body.length).toBe(31);
        const line = response.body.toString("latin1").slice(0, -1);
        expect(line.split("|")).toEqual([
          "ERROR",
          "E_SECTION",
          "no section a",
          "b",
        ]);
        const [, code, ...message] = line.split("|");
        expect([code, message.join("|")]).toEqual([
          "E_SECTION",
          "no section a|b",
        ]);
      }),
  );

  for (const listener of LISTENERS)
    for (const [query, bytes] of [
      ["section=a%0Ab", "ERROR|E_SECTION|no section a\nb\n"],
      ["section=a%0D%0Ab", "ERROR|E_SECTION|no section a\r\nb\n"],
    ] as const)
      it.live(
        `[EXT-31c] ${listener}: go.cgi?${query} ends the line inside the message`,
        () =>
          Effect.gen(function* () {
            expectPipe(
              yield* ask(listener, { target: `/cgi-bin/go.cgi?${query}` }),
              bytes,
            );
          }),
      );
});
