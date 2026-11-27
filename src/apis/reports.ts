/**
 * Reports: a CGI-style reporting gateway, written as a Warded route table.
 *
 * An old reporting application keeps its CGI script, `/cgi-bin/report.cgi`, and a gateway in front
 * of it has added clean report URLs, an audit area and redirects from the old pages. It sits behind
 * an edge proxy that ends TLS and records each request's hop in forwarded fields. So its answers mix
 * the conventions of three eras: CGI's query parsing and plain-text refusals, JSONP for a dashboard
 * that predates CORS, a Digest challenge, and the redirects of every move since. Every route and
 * reply says which real-world convention it imitates. Names, addresses, ids and data are synthetic.
 *
 * Warded matches exact bytes and leaves parsing to the handler, and the suite's handlers answer
 * from the table alone. So where a real gateway would parse a field, this one names the spellings it
 * serves, as an application does that routes on them, and each route says which.
 */
import {
  and,
  type Definition,
  exactPath,
  get,
  headerEq,
  lookupRoute,
  or,
  paramPair,
  paramPresent,
  path,
  post,
  type Reply,
  route,
} from "../harness/routes.js";
import { json, type Lines } from "./replies.js";

/** A CGI script's refusal: a `Status` line and a sentence of plain text. */
const refusal = (status: number, sentence: string): Reply => ({
  status,
  headers: [["content-type", "text/plain; charset=utf-8"]],
  body: `${sentence}\n`,
});

/** A redirect as CGI writes one: a `Location` and no content. */
const redirect = (status: number, location: string): Reply => ({
  status,
  headers: [["location", location]],
});

/** The web server's own pages are HTML, whatever the client asked for. */
const page = (status: number, title: string, headers: Lines = []): Reply => ({
  status,
  headers: [["content-type", "text/html; charset=iso-8859-1"], ...headers],
  body: `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`,
});

/** The daily report, as the application answers it. */
export const dailyReport = {
  name: "daily",
  date: "2026-11-27",
  rows: [
    { region: "north", orders: 41 },
    { region: "south", orders: 37 },
  ],
} as const;

/** The same report as the CSV export writes it, with CRLF line ends as RFC 4180 has them. */
export const dailyCsv = "region,orders\r\nnorth,41\r\nsouth,37\r\n";

/** The dashboard's callback, the one name the JSONP endpoint serves. */
export const callback = "renderDaily";

/**
 * The JSONP answer, in the shape Express's `res.jsonp` writes: a comment first, so that the body
 * cannot begin with bytes a plug-in would read as another format, and a call that does nothing when
 * the page has no such function.
 */
export const dailyScript = `/**/ typeof ${callback} === 'function' && ${callback}(${JSON.stringify(dailyReport)});`;

/** The report that only the office network may read. */
export const internalReport = {
  name: "margins",
  internal: true,
  rows: [{ region: "north", margin: 0.18 }],
} as const;

/**
 * The hop the gateway trusts: the office VPN, which the edge records as the client of the requests
 * it forwards. Over IPv4 the edge writes the de facto `X-Forwarded-For` and `X-Forwarded-Proto`;
 * over IPv6 it writes RFC 7239's `Forwarded`, which must quote an address in brackets.
 */
export const trustedHop = {
  "x-forwarded-for": "10.0.0.5",
  "x-forwarded-proto": "https",
  forwarded: 'for="[2001:db8:cafe::5]";proto=https',
} as const;

/** The Digest realm and the values of the one challenge the gateway issues. */
export const challenge = {
  realm: "reports@gateway.test",
  nonce: "bm9uY2UtMjAyNi0xMS0yNy1yZXBvcnRz",
  opaque: "b3BhcXVlLXJlcG9ydHM",
} as const;

/**
 * The two challenges of RFC 7616 section 3.7, the one the gateway prefers first, each on a line of
 * its own: a comma inside a challenge's parameters is why servers do not join them.
 */
export const challenges = [
  `Digest realm="${challenge.realm}", qop="auth", algorithm=SHA-256, nonce="${challenge.nonce}", opaque="${challenge.opaque}"`,
  `Digest realm="${challenge.realm}", qop="auth", algorithm=MD5, nonce="${challenge.nonce}", opaque="${challenge.opaque}"`,
] as const;

/**
 * The credentials the gateway knows, and the one answer to its challenge that it accepts.
 *
 * A real gateway parses `Authorization`, issues a fresh nonce for each challenge and checks the
 * hash. Warded compares a field's bytes, and the suite's handlers answer from the table, so this one
 * issues one nonce and serves the audit to the one field the dashboard's client writes, for the
 * client nonce and count that client uses. The response is RFC 7616's, with SHA-256:
 * `H(H(user:realm:password):nonce:nc:cnonce:qop:H(GET:/reports/audit))`.
 */
export const credentials = {
  username: "analyst-1",
  password: "synthetic-passphrase",
  cnonce: "Y2xpZW50LW5vbmNlLTE",
  nc: "00000001",
  response: "e4face0089f8149f95a72ec266815485be1cb6897a844278eeff694c1d2cda35",
} as const;

/** The `Authorization` field the dashboard's client writes, in the order it writes it. */
export const digestAuthorization = (response: string) =>
  `Digest username="${credentials.username}", realm="${challenge.realm}", uri="/reports/audit", algorithm=SHA-256, nonce="${challenge.nonce}", nc=${credentials.nc}, cnonce="${credentials.cnonce}", qop=auth, response="${response}", opaque="${challenge.opaque}"`;

export const auditLog = {
  entries: [{ at: "2026-11-27T07:00:00Z", user: "analyst-1", report: "daily" }],
} as const;

/** The queued report a form submission creates. */
export const queuedReport = {
  id: "q-1",
  name: "daily",
  state: "queued",
} as const;

/** The annual report, which moved to the archive's own origin. */
export const annualReport = {
  name: "annual",
  year: "2025",
  rows: [{ region: "north", orders: 14_812 }],
} as const;

const notFound = page(404, "Not Found");

/** Apache's page for a 401, which the challenges arrive with. */
export const unauthorized = page(401, "401 Unauthorized");

const cgi = exactPath("/cgi-bin/report.cgi");

/**
 * The gateway, which redirects the annual reports to `archiveOrigin`, the origin they moved to.
 * That origin is another table's, opened first, so a client that follows the redirect crosses
 * origins.
 */
export const gateway = (archiveOrigin: string): Definition => ({
  routes: [
    // Internal reports, only for a request the edge forwarded from the trusted hop over TLS. The
    // gateway compares the whole field, as `header_eq` does, so a client that sends its own
    // `X-Forwarded-For` gets the edge's address appended and is refused, and so is a repeated
    // field, which Warded's guide names as the reason `header_eq` misses one.
    route(
      "internal",
      and(
        get(),
        exactPath("/reports/internal"),
        or(
          and(
            headerEq("x-forwarded-for", trustedHop["x-forwarded-for"]),
            headerEq("x-forwarded-proto", trustedHop["x-forwarded-proto"]),
          ),
          headerEq("forwarded", trustedHop.forwarded),
        ),
      ),
      json(200, internalReport),
    ),
    route(
      "internal-denied",
      and(get(), exactPath("/reports/internal")),
      refusal(403, "Forbidden: internal reports are for the office network."),
    ),
    // The audit area behind HTTP Digest, with Apache's 401 page beside the challenges.
    route(
      "audit",
      and(
        get(),
        exactPath("/reports/audit"),
        headerEq("authorization", digestAuthorization(credentials.response)),
      ),
      json(200, auditLog, [["cache-control", "no-store"]]),
    ),
    route("audit-challenge", and(get(), exactPath("/reports/audit")), {
      ...unauthorized,
      headers: [
        ...challenges.map((line) => ["www-authenticate", line] as const),
        ...(unauthorized.headers ?? []),
      ],
    }),
    // JSONP for the dashboard, which loads the report with a script tag. The gateway serves its one
    // callback, and refuses any other name rather than echo it into a script.
    route(
      "jsonp",
      and(
        get(),
        cgi,
        paramPair("name", "daily"),
        paramPair("callback", callback),
      ),
      {
        status: 200,
        headers: [
          ["content-type", "text/javascript; charset=utf-8"],
          ["x-content-type-options", "nosniff"],
        ],
        body: dailyScript,
      },
    ),
    route(
      "jsonp-refused",
      and(get(), cgi, paramPresent("callback")),
      refusal(400, "report.cgi: invalid callback"),
    ),
    // The script reads `;` as well as `&`, as CGI libraries did after HTML 4.01's appendix B.2.2
    // asked servers to. Warded splits a query on `&` alone, so the piece `name=daily;format=csv` is
    // the key `name` with the value `daily;format=csv`, and the table names that spelling.
    route(
      "report-csv",
      and(
        get(),
        cgi,
        or(
          and(paramPair("name", "daily"), paramPair("format", "csv")),
          paramPair("name", "daily;format=csv"),
        ),
      ),
      {
        status: 200,
        headers: [
          ["content-type", "text/csv; charset=utf-8"],
          ["content-disposition", 'attachment; filename="daily.csv"'],
        ],
        body: dailyCsv,
      },
    ),
    route(
      "report",
      and(get(), cgi, paramPair("name", "daily")),
      json(200, dailyReport),
    ),
    // A form that queues a report answers 303 See Other to the queued report's page, so a reload
    // does not post again: the Post/Redirect/Get convention.
    route(
      "queue",
      and(post(), cgi),
      redirect(303, `/reports/queued/${queuedReport.id}`),
    ),
    route(
      "no-report",
      and(get(), cgi),
      refusal(400, "report.cgi: no report named"),
    ),
    // A temporary alias for the newest report, in an absolute path.
    route(
      "latest",
      and(get(), exactPath("/reports/latest")),
      redirect(302, `/reports/${dailyReport.date}`),
    ),
    // An alias that a configuration change pointed at itself.
    route(
      "loop",
      and(get(), exactPath("/reports/loop")),
      redirect(302, "/reports/loop"),
    ),
    // The CGI era's static pages moved permanently to clean URLs. The `Location` is a relative path,
    // which RFC 9110 allows, resolved against the page's own: `daily` next to `/reports/daily.html`.
    lookupRoute("legacy-page", and(get(), path("/reports/{name}.html")), {
      capture: "name",
      by: { daily: redirect(301, "daily") },
      otherwise: notFound,
    }),
    // The annual reports moved permanently to the archive's origin. 308 keeps the method.
    lookupRoute("archived", and(get(), path("/reports/archive/{year}")), {
      capture: "year",
      by: {
        [annualReport.year]: redirect(
          308,
          `${archiveOrigin}/${annualReport.year}/annual`,
        ),
      },
      otherwise: notFound,
    }),
    lookupRoute("queued", and(get(), path("/reports/queued/{id}")), {
      capture: "id",
      by: { [queuedReport.id]: json(200, queuedReport) },
      otherwise: notFound,
    }),
    // The clean URLs, by name or date.
    lookupRoute("dated", and(get(), path("/reports/{date}")), {
      capture: "date",
      by: {
        [dailyReport.name]: json(200, dailyReport),
        [dailyReport.date]: json(200, dailyReport),
      },
      otherwise: notFound,
    }),
  ],
  // The web server answers everything else with its own HTML 404.
  fallback: { name: "not-found", reply: notFound },
});

/** The archive the annual reports moved to, on an origin of its own. */
export const archive: Definition = {
  routes: [
    lookupRoute("annual", and(get(), path("/{year}/annual")), {
      capture: "year",
      by: { [annualReport.year]: json(200, annualReport) },
      otherwise: json(404, { error: "no such year" }),
    }),
  ],
};
