/**
 * The CGI reporting gateway: one router for the scripts, the XML-RPC endpoint and the audit
 * endpoint, wrapped in the `delays` hold. `cgi.ts` holds what the scripts share, `files.ts` the
 * extract and CSV formats, `xmlrpc.ts` the XML-RPC reader and writer, and `digest.ts` the audit
 * endpoint's authentication. Every call to {@link handler} creates fresh state.
 *
 * Service documentation: services/gateway.md
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

/** An invoice of the `invoices` test option; its dates are served as stored. */
export interface Invoice {
  readonly id: number;
  readonly account: string;
  readonly cents: number;
  readonly paid: boolean;
  readonly issued: string;
  readonly settled: string;
  readonly lines: ReadonlyArray<InvoiceLine>;
}

/** An entry of the `delays` test option. */
export interface Delay {
  readonly path: string;
  readonly milliseconds: number;
  readonly authorized?: boolean;
  readonly times?: number;
}

/** The test options, documented under "Test options" in the service page. */
export interface Options {
  readonly users?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly realm?: string;
  readonly auditors?: Readonly<Record<string, string>>;
  readonly accounts?: ReadonlyArray<Account>;
  readonly extracts?: Readonly<Record<string, Extract>>;
  readonly invoices?: ReadonlyArray<Invoice>;
  readonly delays?: ReadonlyArray<Delay>;
}

const PERIOD = /^\d{4}(0[1-9]|1[0-2])$/;

/** The `Server` line Apache 1.3 writes on every reply. */
const SERVER = "Apache/1.3.41 (Unix)";

const METHODS = [
  "system.listMethods",
  "report.count",
  "account.title",
  "invoice.get",
  "extract.fetch",
];

/** extract.cgi's refusal: a real status with an ERROR line. */
const refuse = (status: number, code: string, message: string): Reply => ({
  ...pipeError(code, message),
  status,
});

/**
 * Apache's `Redirect permanent` for `rpt.exe`: the scheme, the host and port the request's `Host`
 * names (`UseCanonicalName Off`), or the server's own port when it names none and that port is not
 * 80, then the new path and the request's query. The page escapes the target as HTML.
 */
const legacy = (request: Received, origin: string): Reply => {
  const query = request.target.indexOf("?");
  const own = new URL(origin);
  const host = header(request.lines, "host") ?? own.host;
  const authority =
    /:\d*$/.test(host) || own.port === "" || own.port === "80"
      ? host
      : `${host}:${own.port}`;
  const location = `http://${authority}/cgi-bin/report.cgi${query < 0 ? "" : request.target.slice(query)}`;
  const escaped = location
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return apachePage(
    301,
    "Moved Permanently",
    `The document has moved <A HREF="${escaped}">here</A>.`,
    [["Location", location]],
  );
};

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
    if (!/^text\/xml\b/i.test(header(request.lines, "content-type") ?? ""))
      return apachePage(
        400,
        "Bad Request",
        "XML-RPC requests must be text/xml.",
      );
    let call: ReturnType<typeof Rpc.readCall>;
    try {
      // Bytes that are not UTF-8 are malformed like any other bad document.
      call = Rpc.readCall(
        new TextDecoder("utf-8", { fatal: true }).decode(request.body),
      );
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
        return Rpc.result({ array: METHODS.map((name) => ({ plain: name })) });
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
                    ["text", { plain: line.text }],
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

  const delays = (options.delays ?? []).map((delay) => ({
    delay,
    remaining: delay.times ?? Number.POSITIVE_INFINITY,
  }));

  return async (request, context) => {
    // The reply is computed first, so state changes such as a spent nonce happen on arrival.
    const reply = await routes(request, context);
    const authorized = header(request.lines, "authorization") !== undefined;
    const matched = delays.find(
      ({ delay, remaining }) =>
        remaining > 0 &&
        delay.path === path(request) &&
        (delay.authorized === undefined || delay.authorized === authorized),
    );
    if (matched !== undefined) {
      matched.remaining--;
      await hold(matched.delay.milliseconds, context.signal);
    }
    // Apache 1.3 fronts every script and signs every reply.
    return { ...reply, lines: [["Server", SERVER], ...(reply.lines ?? [])] };
  };
};
