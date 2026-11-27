/**
 * The reporting gateway as an application describes it with the library: the consumer side of
 * `reports.ts`. It uses only the library's package root and Effect.
 */
import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import {
  Body,
  Operation,
  Request,
  Response,
  UrlEncoding,
} from "viell-effect-schema-http";
import { mediaType } from "./metadata.js";

export const Report = Schema.Struct({
  name: Schema.String,
  date: Schema.String,
  rows: Schema.Array(
    Schema.Struct({ region: Schema.String, orders: Schema.Number }),
  ),
});

export const InternalReport = Schema.Struct({
  name: Schema.String,
  internal: Schema.Boolean,
  rows: Schema.Array(
    Schema.Struct({ region: Schema.String, margin: Schema.Number }),
  ),
});

export const AuditLog = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      user: Schema.String,
      report: Schema.String,
    }),
  ),
});

export const Queued = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
});

export const AnnualReport = Schema.Struct({
  name: Schema.String,
  year: Schema.String,
  rows: Schema.Array(
    Schema.Struct({ region: Schema.String, orders: Schema.Number }),
  ),
});

/** Any redirect, with its `Location` in the metadata. Its content is of no use. */
export const redirected = Response.when(
  (info) => info.status >= 300 && info.status < 400,
  Response.tag("Redirect", Body.empty),
  { key: "redirect" },
);

// --- Forwarded fields -----------------------------------------------------------------------------

/** The internal report, or the gateway's refusal. */
export const internalAnswers = Response.status(
  200,
  Response.tag("Internal", Body.jsonSchema(InternalReport)),
).pipe(
  Response.orElse(Response.status(403, Response.tag("Forbidden", Body.text))),
);

/** The request as the edge forwards it: the suite stands in for the edge and declares its fields. */
export const internal = Request.get("/reports/internal");

/** `Forwarded` through a header schema, the way a caller supplies a group of fields. */
export const forwardedInternal = internal.pipe(
  Request.headers(Schema.Struct({ forwarded: Schema.String })),
);

// --- The CGI script's queries --------------------------------------------------------------------

/**
 * Every answer of the report script. A CSV export and a JSON report are both 200, so the media
 * type tells them apart; the script's refusals are plain text.
 */
export const reportAnswers = Response.when(
  (info) => info.status === 200 && mediaType(info) === "text/csv",
  Response.tag("Csv", Body.text),
  { key: "csv" },
).pipe(
  Response.orElse(
    Response.status(200, Response.tag("Report", Body.jsonSchema(Report))),
  ),
  Response.orElse(Response.status(400, Response.tag("Refused", Body.text))),
);

export const script = Request.get("/cgi-bin/report.cgi");

/**
 * A query policy for a service that reads `;` between entries, as CGI scripts did. It keeps the
 * default encoding of each entry, which writes a `;` inside a value as `%3B`.
 */
export const semicolons = UrlEncoding.layer({
  ...UrlEncoding.defaults,
  query: (entries) =>
    entries.map((entry) => UrlEncoding.defaults.query([entry])).join(";"),
});

// --- JSONP ---------------------------------------------------------------------------------------

export const jsonpRequest = (name: string) =>
  script.pipe(Request.setQuery({ name: "daily", callback: name }));

/** The script as text, which is what JSONP is. */
export const asScript = Response.status(
  200,
  Response.tag("Script", Body.text),
).pipe(
  Response.orElse(Response.status(400, Response.tag("Refused", Body.text))),
);

/**
 * The argument of the callback, read from the script's text: Express's shape, with the callback
 * the request named. Anything else is not this endpoint's JSONP.
 */
const argumentOf = (name: string) => (text: string) =>
  Effect.gen(function* () {
    const prefix = `/**/ typeof ${name} === 'function' && ${name}(`;
    if (!text.startsWith(prefix) || !text.endsWith(");"))
      return yield* Effect.fail(new Error("not a JSONP call of the callback"));
    return text.slice(prefix.length, -2);
  });

/** The report inside the callback, decoded from the text with a schema. */
export const unwrapped = (name: string) =>
  Response.status(
    200,
    Response.tag(
      "Report",
      Body.text.pipe(
        Body.mapEffect(argumentOf(name)),
        Body.schema(Schema.fromJsonString(Report)),
      ),
    ),
  );

/** The report read as JSON, which the script is not. */
export const asJson = Response.status(
  200,
  Response.tag("Report", Body.jsonSchema(Report)),
);

// --- The Digest challenge ------------------------------------------------------------------------

export const audit = Request.get("/reports/audit");

/** The audit log, or the challenge to authenticate. */
export const auditAnswers = Response.status(
  200,
  Response.tag("Audit", Body.jsonSchema(AuditLog)),
).pipe(
  Response.orElse(Response.status(401, Response.tag("Challenge", Body.text))),
);

/** The audit log alone, as a consumer would write it who expected to be signed in. */
export const auditOnly = Response.status(
  200,
  Response.tag("Audit", Body.jsonSchema(AuditLog)),
);

/** The parameters of each Digest challenge in a `WWW-Authenticate` value, joined or not. */
export const digestChallenges = (
  value: string,
): ReadonlyArray<Readonly<Record<string, string>>> =>
  value
    .split(/(?:^|,\s*)Digest\s+/)
    .filter((part) => part.trim() !== "")
    .map((part) =>
      Object.fromEntries(
        Array.from(
          part.matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/gi),
          ([, name, quoted, token]) => [name!.toLowerCase(), quoted ?? token!],
        ),
      ),
    );

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).pipe(Effect.map(hex));

/** RFC 7616's response for `qop=auth` with SHA-256. */
export const digestResponse = (input: {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
  readonly nonce: string;
  readonly nc: string;
  readonly cnonce: string;
  readonly method: string;
  readonly uri: string;
}) =>
  Effect.gen(function* () {
    const ha1 = yield* sha256(
      `${input.username}:${input.realm}:${input.password}`,
    );
    const ha2 = yield* sha256(`${input.method}:${input.uri}`);
    return yield* sha256(
      `${ha1}:${input.nonce}:${input.nc}:${input.cnonce}:auth:${ha2}`,
    );
  });

// --- Redirects -----------------------------------------------------------------------------------

/** A report, or a redirect that the client handed over. */
export const reportOrRedirect = Response.status(
  200,
  Response.tag("Report", Body.jsonSchema(Report)),
).pipe(Response.orElse(redirected));

export const latest = Operation.make(
  Request.get("/reports/latest"),
  reportOrRedirect,
);

export const legacyPage = Operation.make(
  Request.get("/reports/daily.html"),
  reportOrRedirect,
);

export const loop = Operation.make(
  Request.get("/reports/loop"),
  reportOrRedirect,
);

export const annual = Operation.make(
  Request.get("/reports/archive/2025"),
  Response.status(
    200,
    Response.tag("Annual", Body.jsonSchema(AnnualReport)),
  ).pipe(Response.orElse(redirected)),
);

/** A form that queues the daily report, and the page it is sent to. */
export const queue = Operation.make(
  Request.post("/cgi-bin/report.cgi").pipe(Request.body(Body.urlEncoded)),
  Response.status(200, Response.tag("Queued", Body.jsonSchema(Queued))).pipe(
    Response.orElse(redirected),
  ),
);

/**
 * Options that add Effect's redirect middleware, which follows what the provider hands over: it
 * resolves a relative `Location` against the request's URL, turns a 303's POST into a GET, and drops
 * `Authorization` and `Cookie` on the way to another origin.
 */
export const followRedirects = {
  transformClient: (client: HttpClient.HttpClient) =>
    HttpClient.followRedirects(client),
};
