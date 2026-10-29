/**
 * The CGI reporting gateway: Apache 1.3 in front of Perl CGI scripts from 1998 onwards, a Frontier
 * XML-RPC endpoint, and a download directory fed by the mainframe's month-end job. Nobody owns the
 * whole of it any more; each convention below belongs to a team that has since moved on, and each
 * has a downstream consumer that would break if it changed. The consumer reaches it only over HTTP.
 *
 * Every call to {@link handler} creates fresh state: sessions, Digest nonces and the accounts table.
 * All options are plain JSON data supplied by the test.
 *
 * ## For the cross-service flows
 *
 * - **Month-end extract** (the first step of the month-end saga):
 *   `GET /cgi-bin/extract.cgi?session=<session>&period=<YYYYMM>` answers 200
 *   `application/octet-stream` with the fixed-width file for that period (layout in `files.ts`:
 *   64-byte ISO-8859-1 records without separators; `H` header with the period and run date, one `D`
 *   record per item with account, title, cents with implied decimals, due date and status `O`/`P`/
 *   `X`, then a `T` trailer with the record count and control total). `HEAD` answers the same
 *   headers without the body: `X-Record-Count`, `X-Control-Total` (13 digits, implied decimals),
 *   `Last-Modified` and `Content-Length`. An unknown or expired session is 403, a malformed period
 *   400, and a period without an extract 404, each with an `ERROR|<code>|<message>` text body. Pass
 *   the records as `options.extracts`, keyed by period.
 * - **Query-parameter token**: `options.token` is an opaque token minted by the 2009 SSO bridge.
 *   Every endpoint that takes `session=` accepts it as a session value, alongside the sessions
 *   `login.cgi` issues. It is the query-parameter form of the token other services take as a
 *   header. A request without `session` is treated like an unknown session.
 *
 * ## Endpoints
 *
 * - `GET /cgi-bin/login.cgi?user=&passwd=`: the password travels in the query string, because the
 *   1998 login page used a GET form. Answers `OK|<session>` or `ERROR|E_AUTH|…` as `text/plain` 200.
 * - `GET /cgi-bin/report.cgi?session=&report=balance&account=`: `OK|<account>|<cents>|<due>`, the
 *   amount as unpadded cents and the date as `YYYYMMDD` or `00000000`; `ERROR|<code>|…` otherwise,
 *   always 200.
 * - `GET /cgi-bin/report.cgi?session=&report=accounts&format=csv[&locale=de_DE]`: the accounts
 *   export, served as `application/octet-stream` because the 2012 script copied the extract
 *   download's headers. A session or parameter error is still a `text/plain` ERROR line in 200.
 * - `GET /cgi-bin/rpt.exe?…`: the compiled-in path of the 1998 Windows desktop client, kept alive
 *   as an Apache `Redirect permanent` to `/cgi-bin/report.cgi` with the same query; Apache writes
 *   the `Location` absolute.
 * - `POST /cgi-bin/import.cgi?session=&locale=de_DE`: the Frankfurt upload of the German accounts
 *   sheet; replaces the accounts table and answers `OK|<rows>` or `ERROR|E_FORMAT|<reason>`.
 * - `POST /RPC2?session=`: XML-RPC (`xmlrpc.ts`) with `system.listMethods`, `report.count`,
 *   `account.title`, `invoice.get` and `extract.fetch`.
 * - `GET /admin/audit.cgi?period=`: RFC 2069 Digest without `qop` and single-use nonces
 *   (`digest.ts`); answers `OK|<period>|<count>|<cents>` for an extract.
 */
import { randomBytes } from "node:crypto";
import { router } from "../../harness/route.js";
import {
  type Handler,
  header,
  path,
  type Received,
  type Reply,
} from "../../harness/server.js";
import { apachePage, hold, parseQuery, pipe, pipeError } from "./cgi.js";
import { digest } from "./digest.js";
import {
  type Account,
  accountsCsv,
  type Extract,
  extractBytes,
  importGerman,
  trailerOf,
} from "./files.js";
import * as Rpc from "./xmlrpc.js";

export type { Account, Extract, ExtractRecord } from "./files.js";

export interface InvoiceLine {
  readonly text: string;
  readonly cents: number;
}

export interface Invoice {
  readonly id: number;
  readonly account: string;
  readonly cents: number;
  readonly paid: boolean;
  /** As stored: `YYYYMMDDTHH:MM:SS`. Rows migrated from 1998 may hold impossible dates. */
  readonly issued: string;
  /** As stored, or `00000000T00:00:00` while unpaid. */
  readonly settled: string;
  readonly lines: ReadonlyArray<InvoiceLine>;
}

/** A reply hold for requests to `path`, optionally only those that do or do not carry `Authorization`. */
export interface Delay {
  readonly path: string;
  readonly milliseconds: number;
  readonly authorized?: boolean;
}

export interface Options {
  /** login.cgi users: name to password. */
  readonly users?: Readonly<Record<string, string>>;
  /** An opaque SSO token accepted as a `session` value everywhere. */
  readonly token?: string;
  /** The Digest realm of `/admin`. */
  readonly realm?: string;
  /** Digest users of `/admin`: name to password. */
  readonly auditors?: Readonly<Record<string, string>>;
  /** The initial accounts table. */
  readonly accounts?: ReadonlyArray<Account>;
  /** Month-end extracts by period (`YYYYMM`). */
  readonly extracts?: Readonly<Record<string, Extract>>;
  readonly invoices?: ReadonlyArray<Invoice>;
  /** Replies to hold, to test timeouts and interruption. */
  readonly delays?: ReadonlyArray<Delay>;
}

const PERIOD = /^\d{4}(0[1-9]|1[0-2])$/;

const METHODS = [
  "system.listMethods",
  "report.count",
  "account.title",
  "invoice.get",
  "extract.fetch",
];

export const handler = (options: Options = {}): Handler => {
  const sessions = new Set<string>(
    options.token === undefined ? [] : [options.token],
  );
  let accounts: ReadonlyArray<Account> = options.accounts ?? [];
  const extracts = options.extracts ?? {};
  const invoices = options.invoices ?? [];
  const authenticate = digest({
    realm: options.realm ?? "Reporting Gateway",
    users: options.auditors ?? {},
  });

  const session = (request: Received): boolean => {
    const value = parseQuery(request.target).get("session");
    return value !== undefined && sessions.has(value);
  };

  const login = (request: Received): Reply => {
    const query = parseQuery(request.target);
    const user = query.get("user");
    const password = query.get("passwd");
    if (user === undefined || password === undefined || user === "")
      return pipeError("E_PARAM", "user and passwd required");
    if (options.users?.[user] !== password)
      return pipeError("E_AUTH", "invalid user or password");
    const id = randomBytes(12).toString("hex");
    sessions.add(id);
    return pipe("OK", id);
  };

  const report = (request: Received): Reply => {
    if (!session(request))
      return pipeError("E_SESSION", "session expired or unknown");
    const query = parseQuery(request.target);
    switch (query.get("report")) {
      case "balance": {
        const number = query.get("account");
        if (number === undefined || number === "")
          return pipeError("E_PARAM", "account required");
        const account = accounts.find((entry) => entry.account === number);
        if (account === undefined)
          return pipeError("E_NOACCT", `no such account ${number}`);
        return pipe("OK", account.account, account.cents, account.due);
      }
      case "accounts": {
        if (query.get("format") !== "csv")
          return pipeError("E_PARAM", "format=csv required");
        const german = query.get("locale") === "de_DE";
        return {
          status: 200,
          lines: [
            ["Content-Type", "application/octet-stream"],
            [
              "Content-Disposition",
              `attachment; filename="${german ? "konten" : "accounts"}.csv"`,
            ],
          ],
          body: accountsCsv(accounts, german),
        };
      }
      default:
        return pipeError(
          "E_PARAM",
          `unknown report ${query.get("report") ?? ""}`,
        );
    }
  };

  const extract = (request: Received): Reply => {
    const refuse = (status: number, code: string, message: string): Reply => ({
      ...pipeError(code, message),
      status,
    });
    if (!session(request))
      return refuse(403, "E_SESSION", "session expired or unknown");
    const period = parseQuery(request.target).get("period") ?? "";
    if (!PERIOD.test(period))
      return refuse(400, "E_PARAM", "period must be YYYYMM");
    const found = extracts[period];
    if (found === undefined)
      return refuse(404, "E_NOPERIOD", `no extract for ${period}`);
    const bytes = extractBytes(period, found);
    const trailer = trailerOf(found);
    return {
      status: 200,
      lines: [
        ["Content-Type", "application/octet-stream"],
        ["Content-Length", String(bytes.length)],
        ["Content-Disposition", `attachment; filename="ME${period}.DAT"`],
        ["Last-Modified", new Date(found.lastModified).toUTCString()],
        ["X-Record-Count", String(trailer.count)],
        ["X-Control-Total", String(trailer.cents).padStart(13, "0")],
      ],
      body: bytes,
    };
  };

  const importSheet = (request: Received): Reply => {
    if (!session(request))
      return pipeError("E_SESSION", "session expired or unknown");
    if (parseQuery(request.target).get("locale") !== "de_DE")
      return pipeError("E_PARAM", "only locale=de_DE imports are supported");
    const result = importGerman(request.body);
    if ("refusal" in result) return pipeError("E_FORMAT", result.refusal);
    accounts = result.accounts;
    return pipe("OK", result.accounts.length);
  };

  const rpc = (request: Received): Reply => {
    // xmlrpc-c and Frontier refuse anything but text/xml before parsing.
    if (!/^text\/xml\b/i.test(header(request.lines, "content-type") ?? ""))
      return apachePage(
        400,
        "Bad Request",
        "XML-RPC requests must be text/xml.",
      );
    let call: ReturnType<typeof Rpc.readCall>;
    try {
      call = Rpc.readCall(new TextDecoder().decode(request.body));
    } catch {
      return Rpc.fault(-32700, "parse error. not well formed");
    }
    if (!session(request)) return Rpc.fault(401, "session expired or unknown");
    const params = call.params;
    const one = (type: string) =>
      params.length === 1 && params[0]!.type === type
        ? params[0]!.text
        : undefined;
    switch (call.method) {
      case "system.listMethods":
        return Rpc.result({ array: METHODS.map((name) => ({ string: name })) });
      case "report.count": {
        const period = one("string");
        if (period === undefined)
          return Rpc.fault(-32602, "server error. invalid method parameters");
        const found = extracts[period];
        return found === undefined
          ? Rpc.fault(404, `no extract for ${period}`)
          : Rpc.result({ i4: found.records.length });
      }
      case "account.title": {
        const number = one("string");
        if (number === undefined)
          return Rpc.fault(-32602, "server error. invalid method parameters");
        const account = accounts.find((entry) => entry.account === number);
        // The 1999 handler returns the bare scalar without a type element.
        return account === undefined
          ? Rpc.fault(404, `no such account ${number}`)
          : Rpc.result({ untyped: account.title });
      }
      case "invoice.get": {
        const id = one("i4");
        if (id === undefined || !/^-?\d+$/.test(id.trim()))
          return Rpc.fault(-32602, "server error. invalid method parameters");
        const invoice = invoices.find((entry) => entry.id === Number(id));
        if (invoice === undefined)
          return Rpc.fault(404, `no such invoice ${Number(id)}`);
        return Rpc.result({
          struct: [
            ["id", { i4: invoice.id }],
            ["account", { string: invoice.account }],
            ["amount", { cents: invoice.cents }],
            ["paid", { boolean: invoice.paid }],
            ["issued", { dateTime: invoice.issued }],
            ["settled", { dateTime: invoice.settled }],
            [
              "lines",
              {
                array: invoice.lines.map((line) => ({
                  struct: [
                    ["text", { string: line.text }],
                    ["amount", { cents: line.cents }],
                  ] as const,
                })),
              },
            ],
          ],
        });
      }
      case "extract.fetch": {
        const period = one("string");
        if (period === undefined)
          return Rpc.fault(-32602, "server error. invalid method parameters");
        const found = extracts[period];
        return found === undefined
          ? Rpc.fault(404, `no extract for ${period}`)
          : Rpc.result({ base64: extractBytes(period, found) });
      }
      default:
        return Rpc.fault(
          -32601,
          `server error. requested method ${call.method} not found`,
        );
    }
  };

  const audit = (request: Received): Reply => {
    const verdict = authenticate(request);
    if (verdict._tag === "Refused") return verdict.reply;
    const period = parseQuery(request.target).get("period") ?? "";
    const found = extracts[period];
    if (found === undefined)
      return pipeError("E_NOPERIOD", `no extract for ${period}`);
    const trailer = trailerOf(found);
    return pipe("OK", period, trailer.count, trailer.cents);
  };

  const legacy = (request: Received, origin: string): Reply => {
    const query = request.target.indexOf("?");
    const location = `${origin}/cgi-bin/report.cgi${query < 0 ? "" : request.target.slice(query)}`;
    return apachePage(
      301,
      "Moved Permanently",
      `The document has moved <A HREF="${location}">here</A>.`,
      [["Location", location]],
    );
  };

  const routes = router([
    { method: "GET", path: "/cgi-bin/login.cgi", handle: login },
    { method: "GET", path: "/cgi-bin/report.cgi", handle: report },
    {
      method: "*",
      path: "/cgi-bin/rpt.exe",
      handle: (request, context) => legacy(request, context.origin),
    },
    { method: "GET", path: "/cgi-bin/extract.cgi", handle: extract },
    { method: "HEAD", path: "/cgi-bin/extract.cgi", handle: extract },
    { method: "POST", path: "/cgi-bin/import.cgi", handle: importSheet },
    { method: "POST", path: "/RPC2", handle: rpc },
    { method: "GET", path: "/admin/audit.cgi", handle: audit },
  ]);

  return async (request, context) => {
    const reply = await routes(request, context);
    const authorized = header(request.lines, "authorization") !== undefined;
    const delay = (options.delays ?? []).find(
      (entry) =>
        entry.path === path(request) &&
        (entry.authorized === undefined || entry.authorized === authorized),
    );
    if (delay !== undefined) await hold(delay.milliseconds, context.signal);
    return reply;
  };
};
