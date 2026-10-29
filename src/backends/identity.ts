/**
 * # The identity provider
 *
 * An OAuth-ish identity provider that three teams grew over fifteen years. Each era left a code
 * path that nobody can retire, because some client still depends on its exact behaviour:
 *
 * - **The directory gateway (2004).** `GET /directory/users/{uid}` fronts the corporate LDAP
 *   directory. It returns attributes under their upper-case LDAP names with LDAP generalized
 *   times, and renders an unknown uid as a blank entry with `ACTIVE: "N"` and status 200.
 * - **The OAuth token servlet (2012).** `POST /oauth/token` takes form-encoded grants
 *   (`password`, `client_credentials`, `refresh_token`) and answers with every value as a string,
 *   `token_type: "bearer"`, and OAuth error objects.
 * - **The mobile JSON API (2016).** `POST /api/v2/token` (JSON grant, requested scopes as
 *   repeated header lines, `token_type: "Bearer"`), `POST /api/v2/login` (ported from the 2009
 *   SSO gateway, `token_type: "BEARER"`), `POST /api/v2/users` (register, 201 with the entry)
 *   and `GET /api/v2/me` (the caller's directory entry). Errors are nested code-and-message
 *   objects, and 5xx answers are a bare JSON string.
 *
 * A 2012 servlet filter guards the directory and `/api/v2/me` and answers 401 with a bare message
 * object. A 2019 rate limiter in front of the three credential endpoints trusts
 * `X-Forwarded-For`. `GET /.well-known/openid-configuration` publishes an issuer with a trailing
 * slash.
 *
 * ## For cross-service flows
 *
 * - **Token issuance.** `POST /oauth/token` with the form
 *   `grant_type=client_credentials&client_id=<id>&client_secret=<secret>&scope=directory:read`
 *   answers 200 with one opaque `access_token` (and `token_type: "bearer"`). Register the client
 *   with `handler({ clients: [{ id, secret }] })`. With `handler({ token })`, that grant issues
 *   exactly `token`, so a test can configure other services with the same value.
 * - **Directory.** `GET /directory/users/{uid}` with `Authorization: Bearer <token>`. Seeded uids:
 *   `alovelace` and `ghopper` (active), `cbabbage` (inactive, `ACTIVE: "N"` with values),
 *   `kzuse` (active, imported from Active Directory with a fractional `CREATETIMESTAMP`, which a
 *   strict reader refuses). Any other uid answers 200 with the blank entry. Entries carry `UID`,
 *   `CN`, `MAIL`, `ACTIVE` (`Y` or `N`), `CREATETIMESTAMP` and `MODIFYTIMESTAMP`.
 * - **Token check.** The directory and `/api/v2/me` accept `Authorization: Bearer <token>` for
 *   `handler({ token })` without any grant, as well as for every token issued by this instance.
 *   The scheme is compared case-sensitively.
 *
 * Every call to {@link handler} creates fresh state: tokens, refresh families, registered users
 * and rate-limit buckets. Options are plain JSON data.
 */
import { createHash, randomBytes } from "node:crypto";
import { router } from "../harness/route.js";
import type { Context, Handler, Received, Reply } from "../harness/server.js";

/** An OAuth client registered for the `client_credentials` grant. */
export interface Client {
  readonly id: string;
  readonly secret: string;
  /**
   * `mac` reproduces the 2013 pilot of draft-ietf-oauth-v2-http-mac: the servlet answers
   * `token_type: "mac"` with a MAC key. Defaults to `bearer`.
   */
  readonly tokenType?: "bearer" | "mac";
}

export interface Options {
  /**
   * A pre-provisioned opaque access token. The token check accepts it without any grant, and the
   * first registered client's `client_credentials` grant issues exactly this value.
   */
  readonly token?: string;
  /** OAuth clients for `client_credentials`. Defaults to none. */
  readonly clients?: ReadonlyArray<Client>;
  /**
   * A fixed clock in epoch milliseconds for timestamps of registered users and rate-limit windows.
   * Defaults to the real time.
   */
  readonly now?: number;
  /**
   * The LDAP directory behind the gateway. `down` answers 503 with a bare JSON string; `stalled`
   * holds every directory-backed request open until the client gives up.
   */
  readonly ldap?: "up" | "down" | "stalled";
  readonly rateLimit?: {
    /** Requests per bucket per 60-second window. Defaults to 10. */
    readonly limit?: number;
    /** The address the server sees as its socket peer: the load balancer. Defaults to `10.20.0.5`. */
    readonly peer?: string;
    /** Buckets that other traffic has already spent for the current window. */
    readonly exhausted?: ReadonlyArray<string>;
  };
}

interface User {
  readonly uid: string;
  readonly cn: string;
  readonly mail: string;
  readonly active: boolean;
  readonly created: string;
  readonly modified: string;
  readonly password: string;
}

/**
 * The seeded directory. Times are stored as the gateway writes them. `kzuse` was imported from
 * Active Directory in 2009, which wrote a fractional second (`.0Z`); the import job copied the
 * string as is, and the LDAP schema's GeneralizedTime syntax accepts it.
 */
const seed: ReadonlyArray<User> = [
  {
    uid: "alovelace",
    cn: "Ada Lovelace",
    mail: "ada@identity.test",
    active: true,
    created: "20040315093000Z",
    modified: "20190102030405Z",
    password: "analytical-engine",
  },
  {
    uid: "cbabbage",
    cn: "Charles Babbage",
    mail: "charles@identity.test",
    active: false,
    created: "20040315093100Z",
    modified: "20121231235959Z",
    password: "difference-engine",
  },
  {
    uid: "ghopper",
    cn: "Grace Hopper",
    mail: "grace@identity.test",
    active: true,
    created: "20080229235959Z",
    modified: "20160601000000Z",
    password: "a-ship-in-port",
  },
  {
    uid: "kzuse",
    cn: "Konrad Zuse",
    mail: "konrad@identity.test",
    active: true,
    created: "20090601120000.0Z",
    modified: "20090601120000.0Z",
    password: "plankalkuel",
  },
];

const knownScopes = new Set([
  "openid",
  "profile",
  "email",
  "offline_access",
  "directory:read",
  "directory:write",
]);

const lifetimeSeconds = 3600;
const windowMillis = 60_000;

const pad = (value: number, width: number) =>
  String(value).padStart(width, "0");

/** The gateway's own GeneralizedTime writer: UTC, whole seconds, `Z`. */
const generalizedTime = (date: Date) =>
  pad(date.getUTCFullYear(), 4) +
  pad(date.getUTCMonth() + 1, 2) +
  pad(date.getUTCDate(), 2) +
  pad(date.getUTCHours(), 2) +
  pad(date.getUTCMinutes(), 2) +
  pad(date.getUTCSeconds(), 2) +
  "Z";

const first = (request: Received, name: string): string | undefined =>
  request.lines.find(([key]) => key.toLowerCase() === name)?.[1];

const all = (request: Received, name: string): ReadonlyArray<string> =>
  request.lines
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value);

const mediaType = (request: Received): string =>
  (first(request, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();

const bodyText = (request: Received) => new TextDecoder().decode(request.body);

const reply = (
  status: number,
  body: string,
  lines: ReadonlyArray<readonly [string, string]>,
): Reply => ({ status, lines, body });

/**
 * The 2012 servlet answered through Spring's message converter, which always added the charset,
 * and RFC 6749 section 5.1 requires the no-store headers. Every value went through a
 * `Map<String, String>`, so numbers are strings too; the Android SDK of 2013 parses
 * `expires_in` with `Integer.parseInt` and breaks on a number, so it stays a string.
 */
const servlet = (
  status: number,
  value: Readonly<Record<string, string>>,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply =>
  reply(status, JSON.stringify(value), [
    ["Content-Type", "application/json;charset=UTF-8"],
    ["Cache-Control", "no-store"],
    ["Pragma", "no-cache"],
    ...lines,
  ]);

const oauthError = (
  status: number,
  error: string,
  description: string,
  lines: ReadonlyArray<readonly [string, string]> = [],
) => servlet(status, { error, error_description: description }, lines);

/** The 2016 API's JSON writer. */
const api = (
  status: number,
  value: unknown,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply =>
  reply(status, JSON.stringify(value), [
    ["Content-Type", "application/json"],
    ...lines,
  ]);

/**
 * The 2016 API's 4xx shape. The mobile team nested the code so they could add fields later; they
 * never did.
 */
const coded = (status: number, code: string, message: string) =>
  api(status, { error: { code, message } });

/**
 * The 2016 API's 5xx shape: its exception mapper wrote `JSON.stringify(exception.getMessage())`,
 * a bare JSON string. The iOS client's error banner shows that string verbatim, so it stays.
 */
const fault = (status: number, message: string) =>
  api(status, message, [["Retry-After", "30"]]);

/**
 * The 2012 filter's 401. Spring Security's default entry point wrote a bare message object, and
 * forty internal services match on its text.
 */
const unauthorized = (message: string) =>
  api(401, { message }, [["WWW-Authenticate", 'Bearer realm="directory"']]);

const segment = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The gateway's JSP template renders whatever entry the LDAP search returned. For no entry it
 * renders the same template with nothing filled in, and `ACTIVE` defaults to `N`. Nightly
 * reports count rows, so a 404 was never added.
 */
const entry = (user: User | undefined) =>
  user === undefined
    ? {
        DN: "",
        UID: "",
        CN: "",
        MAIL: "",
        ACTIVE: "N",
        CREATETIMESTAMP: "",
        MODIFYTIMESTAMP: "",
      }
    : {
        DN: `uid=${user.uid},ou=people,dc=identity,dc=test`,
        UID: user.uid,
        CN: user.cn,
        MAIL: user.mail,
        ACTIVE: user.active ? "Y" : "N",
        CREATETIMESTAMP: user.created,
        MODIFYTIMESTAMP: user.modified,
      };

const parseJson = (request: Received): unknown => {
  try {
    return JSON.parse(bodyText(request));
  } catch {
    return undefined;
  }
};

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

const isReply = (value: unknown): value is Reply =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  "lines" in value;

/**
 * The issuer was configured in 2015 as the site root with its slash. Relying parties compare it
 * exactly and refresh tokens carry it, so dropping the slash would log everybody out. The
 * Jetty rewrite rules match the literal path, so `//.well-known/...` is a 404.
 */
const discovery = (_: Received, context: Context): Reply =>
  api(200, {
    issuer: `${context.origin}/`,
    token_endpoint: `${context.origin}/oauth/token`,
    userinfo_endpoint: `${context.origin}/api/v2/me`,
    grant_types_supported: ["password", "client_credentials", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });

const jsonBody = (request: Received) =>
  mediaType(request) === "application/json"
    ? parseJson(request)
    : coded(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json");

export const handler = (options: Options = {}): Handler => {
  const fixed = options.now;
  const now = () => (fixed === undefined ? new Date() : new Date(fixed));
  const ldap = options.ldap ?? "up";
  const clients = options.clients ?? [];
  const limit = options.rateLimit?.limit ?? 10;
  const peer = options.rateLimit?.peer ?? "10.20.0.5";

  const users = new Map(seed.map((user) => [user.uid, user]));
  const accessTokens = new Map<
    string,
    { readonly subject: string | null; readonly client: string | null }
  >();
  const refreshTokens = new Map<
    string,
    {
      readonly subject: string;
      readonly family: string;
      readonly generation: number;
      readonly scope: string;
      current: boolean;
    }
  >();
  const buckets = new Map<string, { count: number; resetAt: number }>();
  if (options.token !== undefined)
    accessTokens.set(options.token, {
      subject: null,
      client: clients[0]?.id ?? null,
    });
  for (const key of options.rateLimit?.exhausted ?? [])
    buckets.set(key, {
      count: limit,
      resetAt: now().getTime() + windowMillis,
    });

  // Opaque access tokens: 24 random bytes in standard Base64, so `+` and `/` are common. The
  // resource servers look them up; nothing parses them.
  const issueAccess = (subject: string | null, client: string | null) => {
    const token =
      subject === null &&
      options.token !== undefined &&
      client === (clients[0]?.id ?? null)
        ? options.token
        : randomBytes(24).toString("base64");
    accessTokens.set(token, { subject, client });
    return token;
  };

  // The 2014 "stateless refresh" project made refresh tokens JWT-shaped. Revocation still needed
  // the family table, so the server ignores the claims and checks the table. Its `exp` claim is
  // copied from the account's first-ever session (a bug in the rollout), so it is always in the
  // past; mobile apps that checked it broke in 2014 and stopped checking, and nobody fixed it.
  const issueRefresh = (
    origin: string,
    subject: string,
    scope: string,
    family = randomBytes(6).toString("hex"),
    generation = 1,
  ) => {
    const token = [
      segment({ alg: "HS256", typ: "JWT", kid: "rt-2014" }),
      segment({
        iss: `${origin}/`,
        sub: subject,
        fam: family,
        gen: generation,
        iat: 1262304000,
        exp: 1262307600,
      }),
      randomBytes(32).toString("base64url"),
    ].join(".");
    refreshTokens.set(token, {
      subject,
      family,
      generation,
      scope,
      current: true,
    });
    return token;
  };

  /**
   * Added in 2019 against credential stuffing. Ops put it behind the load balancer, which appends
   * the client address to `X-Forwarded-For`; the limiter keys on the first entry, which the client
   * controls. Without the header, every request comes from the balancer's address and shares one
   * bucket. Fixing it would need the balancer team to overwrite the header, which breaks two
   * partners who send their own.
   */
  const rateLimited = (request: Received): Reply | undefined => {
    const forwarded = first(request, "x-forwarded-for")?.split(",")[0]?.trim();
    const key = forwarded === undefined || forwarded === "" ? peer : forwarded;
    const time = now().getTime();
    let bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= time) {
      bucket = { count: 0, resetAt: time + windowMillis };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit)
      return api(429, { message: `Rate limit exceeded for ${key}` }, [
        ["Retry-After", String(Math.ceil((bucket.resetAt - time) / 1000))],
      ]);
    bucket.count++;
    return undefined;
  };

  /** The LDAP backend, as every directory-backed path sees it. */
  const directory = async (context: Context): Promise<Reply | "up"> => {
    if (ldap === "down")
      return fault(
        503,
        "Directory unavailable: LDAP connection pool exhausted",
      );
    if (ldap === "stalled") {
      // The 2004 gateway has no read timeout towards LDAP; it waits until the caller hangs up.
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener("abort", () => resolve());
      });
      return fault(504, "Directory timed out");
    }
    return "up";
  };

  /**
   * The 2012 filter. It compares the scheme case-sensitively with `startsWith("Bearer ")`, against
   * RFC 9110; the filter is a shared library jar in forty services, and changing it needs all of
   * them redeployed.
   */
  const authenticated = (request: Received) => {
    const authorization = first(request, "authorization");
    if (authorization === undefined || !authorization.startsWith("Bearer "))
      return undefined;
    return accessTokens.get(authorization.slice("Bearer ".length));
  };

  const credentials = (username: unknown, password: unknown) => {
    const user = typeof username === "string" ? users.get(username) : undefined;
    return user !== undefined && user.password === password ? user : undefined;
  };

  const formToken = async (
    request: Received,
    context: Context,
  ): Promise<Reply> => {
    const limited = rateLimited(request);
    if (limited !== undefined) return limited;
    // The servlet's MediaType check predates the JSON API and was never widened.
    if (mediaType(request) !== "application/x-www-form-urlencoded")
      return oauthError(
        415,
        "invalid_request",
        "Content-Type must be application/x-www-form-urlencoded",
      );
    const form = new URLSearchParams(bodyText(request));
    const keys = Array.from(form.keys());
    if (new Set(keys).size !== keys.length)
      return oauthError(400, "invalid_request", "Repeated parameter");
    const scopeOf = (fallback: string) => {
      const requested = form.get("scope");
      if (requested === null || requested === "") return fallback;
      const scopes = requested.split(" ");
      return scopes.every((scope) => knownScopes.has(scope))
        ? requested
        : undefined;
    };
    switch (form.get("grant_type")) {
      case "password": {
        const scope = scopeOf("openid profile");
        if (scope === undefined)
          return oauthError(400, "invalid_scope", "Unknown scope");
        const state = await directory(context);
        if (state !== "up") return state;
        const user = credentials(form.get("username"), form.get("password"));
        if (user === undefined || !user.active)
          return oauthError(400, "invalid_grant", "Bad credentials");
        return servlet(200, {
          access_token: issueAccess(user.uid, null),
          token_type: "bearer",
          expires_in: String(lifetimeSeconds),
          refresh_token: issueRefresh(context.origin, user.uid, scope),
          scope,
        });
      }
      case "client_credentials": {
        const client = clients.find(
          (candidate) =>
            candidate.id === form.get("client_id") &&
            candidate.secret === form.get("client_secret"),
        );
        if (client === undefined)
          return oauthError(
            401,
            "invalid_client",
            "Client authentication failed",
            [["WWW-Authenticate", 'Basic realm="oauth"']],
          );
        const scope = scopeOf("directory:read");
        if (scope === undefined)
          return oauthError(400, "invalid_scope", "Unknown scope");
        const accessToken = issueAccess(null, client.id);
        return servlet(
          200,
          client.tokenType === "mac"
            ? {
                access_token: accessToken,
                token_type: "mac",
                expires_in: String(lifetimeSeconds),
                mac_key: createHash("sha256")
                  .update(accessToken)
                  .digest("base64"),
                mac_algorithm: "hmac-sha-256",
                scope,
              }
            : {
                access_token: accessToken,
                token_type: "bearer",
                expires_in: String(lifetimeSeconds),
                scope,
              },
        );
      }
      case "refresh_token": {
        const presented = form.get("refresh_token") ?? "";
        const family = refreshTokens.get(presented);
        if (family === undefined || !family.current)
          return oauthError(
            400,
            "invalid_grant",
            family === undefined
              ? "Unknown refresh token"
              : "Refresh token was already rotated",
          );
        family.current = false;
        return servlet(200, {
          access_token: issueAccess(family.subject, null),
          token_type: "bearer",
          expires_in: String(lifetimeSeconds),
          refresh_token: issueRefresh(
            context.origin,
            family.subject,
            family.scope,
            family.family,
            family.generation + 1,
          ),
          scope: family.scope,
        });
      }
      default:
        return oauthError(
          400,
          "unsupported_grant_type",
          "Unsupported grant type",
        );
    }
  };

  /**
   * The 2016 mobile grant. The API gateway's scope plugin maps each `X-OAuth-Scope` line to one
   * requested scope. In 2017 a comma-joined line was granted as one scope literally named
   * `profile, admin`; the fix refuses any line containing a comma. Granted scopes come back the
   * same way, one line each, because the plugin cannot write a body. The web SSO also sets its
   * session cookie and the balancer's affinity cookie here.
   */
  const jsonToken = async (
    request: Received,
    context: Context,
  ): Promise<Reply> => {
    const limited = rateLimited(request);
    if (limited !== undefined) return limited;
    const body = jsonBody(request);
    if (isReply(body)) return body;
    if (body === undefined)
      return coded(400, "MALFORMED_JSON", "Request body is not JSON");
    const requested = all(request, "x-oauth-scope");
    if (requested.some((line) => line.includes(",")))
      return coded(
        400,
        "INVALID_SCOPE",
        "Send one scope per X-OAuth-Scope line; a comma-joined value is refused",
      );
    if (requested.some((scope) => !knownScopes.has(scope)))
      return coded(400, "INVALID_SCOPE", "Unknown scope");
    if (field(body, "grant_type") !== "password")
      return coded(
        400,
        "UNSUPPORTED_GRANT",
        "Only the password grant is supported",
      );
    const state = await directory(context);
    if (state !== "up") return state;
    const user = credentials(field(body, "username"), field(body, "password"));
    if (user === undefined)
      return coded(401, "BAD_CREDENTIALS", "Username or password is wrong");
    if (!user.active)
      return coded(403, "ACCOUNT_DISABLED", "The account is disabled");
    const granted = Array.from(new Set(["openid", "profile", ...requested]));
    return api(
      200,
      {
        access_token: issueAccess(user.uid, null),
        token_type: "Bearer",
        expires_in: lifetimeSeconds,
        refresh_token: issueRefresh(
          context.origin,
          user.uid,
          granted.join(" "),
        ),
      },
      [
        ...granted.map((scope) => ["X-OAuth-Scope", scope] as const),
        [
          "Set-Cookie",
          `IDPSESSION=${randomBytes(12).toString("base64url")}; Path=/; HttpOnly; SameSite=Lax`,
        ],
        [
          "Set-Cookie",
          "IDPLB=node-3; Path=/; Expires=Fri, 01 Jan 2038 00:00:00 GMT",
        ],
      ],
    );
  };

  /**
   * The web login, ported in 2016 from the 2009 SSO gateway. That gateway upper-cased every
   * response value for a mainframe terminal client, and the port kept `BEARER` because the
   * terminal emulator still logs in through it. It answers with tokens only; the profile is a
   * separate request.
   */
  const login = async (request: Received, context: Context): Promise<Reply> => {
    const limited = rateLimited(request);
    if (limited !== undefined) return limited;
    const body = jsonBody(request);
    if (isReply(body)) return body;
    if (body === undefined)
      return coded(400, "MALFORMED_JSON", "Request body is not JSON");
    const state = await directory(context);
    if (state !== "up") return state;
    const user = credentials(field(body, "username"), field(body, "password"));
    if (user === undefined)
      return coded(401, "BAD_CREDENTIALS", "Username or password is wrong");
    if (!user.active)
      return coded(403, "ACCOUNT_DISABLED", "The account is disabled");
    return api(200, {
      access_token: issueAccess(user.uid, null),
      refresh_token: issueRefresh(context.origin, user.uid, "openid profile"),
      token_type: "BEARER",
      expires_in: lifetimeSeconds,
    });
  };

  /** Self-registration writes the LDAP entry and answers 201 with it, as the gateway renders it. */
  const register = async (
    request: Received,
    context: Context,
  ): Promise<Reply> => {
    const body = jsonBody(request);
    if (isReply(body)) return body;
    if (body === undefined)
      return coded(400, "MALFORMED_JSON", "Request body is not JSON");
    const uid = field(body, "uid");
    const cn = field(body, "cn");
    const mail = field(body, "mail");
    const password = field(body, "password");
    if (typeof uid !== "string" || !/^[a-z][a-z0-9]{2,15}$/.test(uid))
      return coded(
        400,
        "VALIDATION_FAILED",
        "uid must be 3-16 lower-case letters or digits",
      );
    if (typeof cn !== "string" || cn.trim() === "")
      return coded(400, "VALIDATION_FAILED", "cn must not be blank");
    if (typeof mail !== "string" || !mail.includes("@"))
      return coded(400, "VALIDATION_FAILED", "mail must be an address");
    if (typeof password !== "string" || password.length < 8)
      return coded(
        400,
        "VALIDATION_FAILED",
        "password must have at least 8 characters",
      );
    const state = await directory(context);
    if (state !== "up") return state;
    if (users.has(uid))
      return coded(409, "UID_TAKEN", `uid ${uid} is already registered`);
    const stamp = generalizedTime(now());
    const user: User = {
      uid,
      cn,
      mail,
      active: true,
      created: stamp,
      modified: stamp,
      password,
    };
    users.set(uid, user);
    return api(201, entry(user));
  };

  const me = async (request: Received, context: Context): Promise<Reply> => {
    const grant = authenticated(request);
    if (grant === undefined)
      return unauthorized(
        "Full authentication is required to access this resource",
      );
    if (grant.subject === null) return unauthorized("The token has no user");
    const state = await directory(context);
    if (state !== "up") return state;
    return api(200, entry(users.get(grant.subject)));
  };

  const lookup = async (
    request: Received,
    context: Context & { readonly params: Readonly<Record<string, string>> },
  ): Promise<Reply> => {
    if (authenticated(request) === undefined)
      return unauthorized(
        "Full authentication is required to access this resource",
      );
    const state = await directory(context);
    if (state !== "up") return state;
    let uid: string;
    try {
      uid = decodeURIComponent(context.params["uid"] ?? "");
    } catch {
      uid = "";
    }
    return api(200, entry(users.get(uid)));
  };

  return router([
    {
      method: "GET",
      path: "/.well-known/openid-configuration",
      handle: discovery,
    },
    { method: "POST", path: "/oauth/token", handle: formToken },
    { method: "POST", path: "/api/v2/token", handle: jsonToken },
    { method: "POST", path: "/api/v2/login", handle: login },
    { method: "POST", path: "/api/v2/users", handle: register },
    { method: "GET", path: "/api/v2/me", handle: me },
    {
      method: "GET",
      path: /^\/directory\/users\/(?<uid>[^/]+)$/,
      handle: lookup,
    },
  ]);
};
