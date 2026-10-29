/**
 * The notification service ("Notify"), built between 2014 and 2016 while the company moved its web
 * front end to a single-page app. Each layer was added by a different team for a different
 * client, and every one of them still has a caller somebody is afraid to break.
 *
 * ## Contract for the cross-service flows
 *
 * Start it with `handler(options)`; every call has fresh state. The fixture values (`acceptedToken`,
 * `signingSecret`, `allowedOrigins`) come from the test.
 *
 * - **Token scheme.** Every route except the CSRF bootstrap requires
 *   `Authorization: Token token="<opaque>"` (Rails' token form, scheme name case-sensitive, value
 *   quoted) whose value equals `acceptedToken`. Anything else answers 401 with
 *   `WWW-Authenticate: Token realm="Application"` and the text body `HTTP Token: Access denied.`.
 * - **CSRF.** Every POST requires the double-submit pair: the `XSRF-TOKEN` cookie and the same
 *   token in `X-XSRF-TOKEN`. `GET /v2/session/csrf` issues a token: in the JSON body as
 *   `csrfToken`, and as a cookie whose value is percent-encoded (`Set-Cookie: XSRF-TOKEN=...%3D%3D`).
 *   The header carries the decoded token. Only issued tokens are accepted. A failure answers 403
 *   with an HTML page whose `Reason:` line names the failed check.
 * - **Announce:** `POST /v2/announcements`, the month-end saga's announcement step. JSON body
 *   `{ "channel": string, "subject": string, "body": string }`, Token and CSRF as above, and an HMAC
 *   signature:
 *   - `X-Notify-Timestamp`: epoch milliseconds, within `windowMs` of the server clock;
 *   - `X-Notify-Signature`: `v1=` and the lowercase hex HMAC-SHA256, keyed with `signingSecret`,
 *     over `METHOD \n path \n timestamp \n` followed by the exact body bytes. The path is the raw
 *     request target without its query.
 *   - A signature is spent once verified, even when the announcement then fails, so an attempt
 *     must be signed again.
 *   - Success is 202 with `{ id, channel, subject, body, receivedAt }` and a `Location`.
 *   - Signature failures are 401 JSON `{ "error": { "code": ... } }` with the codes
 *     `signature_missing`, `timestamp_out_of_window` (plus `serverTime` and `windowMs`),
 *     `signature_mismatch` and `signature_replayed`, checked in that order.
 *   - A blank or missing field is 422 `invalid_announcement` with its `field`.
 *   - The failure point is `options.announce`: `unavailable` answers 503 `fanout_busy` for the
 *     first `times` verified announcements, with `Retry-After` when given; `fail: "error"` answers
 *     500 with an HTML page; `fail: "frozen"` answers 409 `channel_frozen`; `holdMs` holds each
 *     verified announcement before answering, and an abort during the hold records nothing.
 * - `GET /v2/announcements` lists the recorded announcements as `{ "announcements": [...] }`.
 *
 * Checks run in the order the layers were stacked: the CORS filter, the framework's CSRF
 * middleware, the Token authentication of the API layer, then the HMAC check of the announce
 * route.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { json, router, textReply } from "../harness/route.js";
import {
  header,
  headerValues,
  path,
  type Handler,
  type Received,
  type Reply,
} from "../harness/server.js";

export interface AnnounceFailurePoint {
  /** Answer the first `times` verified announcements with 503, after spending their signatures. */
  readonly unavailable?:
    | {
        readonly times: number;
        /** The `Retry-After` value to send, verbatim; omitted when undefined. */
        readonly retryAfter?: string | undefined;
      }
    | undefined;
  /** Fail every verified announcement: 500 with the platform's error page, or 409 frozen. */
  readonly fail?: "error" | "frozen" | undefined;
  /** Hold each verified announcement this long before answering. */
  readonly holdMs?: number | undefined;
}

/**
 * The hostile CORS behaviours, each on by default. The browser lane switches one off to reach an
 * endpoint without the same-origin proxy.
 */
export interface CorsQuirks {
  /** `/v2/subscriptions` preflights omit `Content-Type` from the allowed headers. */
  readonly subscriptionsOmitContentType?: boolean | undefined;
  /** `/v2/announcements` preflights refuse any requested header outside the list, with 403. */
  readonly strictAnnouncements?: boolean | undefined;
  /** v1 `OPTIONS` is answered by the servlet container, without any application header. */
  readonly v1ContainerOptions?: boolean | undefined;
  /** v1 responses expose only `Warning` to browser scripts, not `Deprecation`, `Sunset` or `Link`. */
  readonly v1ExposeWarningOnly?: boolean | undefined;
}

/** Plain JSON data, so a browser test can pass it across a process boundary. */
export interface Options {
  /** The opaque token accepted under the `Token` scheme. */
  readonly acceptedToken: string;
  /** The shared HMAC-SHA256 key for announcement signatures. */
  readonly signingSecret: string;
  /** Browser origins the CORS filter answers for, with credentials allowed. */
  readonly allowedOrigins: ReadonlyArray<string>;
  /** Allowed distance between a signature's timestamp and the server clock. Default 5 minutes. */
  readonly windowMs?: number | undefined;
  /** Added to the real clock to form the server clock, to simulate clock skew. Default 0. */
  readonly clockOffsetMs?: number | undefined;
  readonly announce?: AnnounceFailurePoint | undefined;
  readonly cors?: CorsQuirks | undefined;
}

interface Subscription {
  readonly id: string;
  readonly channel: string;
  readonly address: string;
}

interface Announcement {
  readonly id: string;
  readonly channel: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
}

type Lines = ReadonlyArray<readonly [string, string]>;

const csrfPage = (reason: string): Reply =>
  // 2014: the CSRF check is the web framework's middleware, which predates the JSON API layer and
  // renders its own HTML page. The SPA's error interceptor matches on the status, so the page was
  // never replaced.
  textReply(
    403,
    `<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body>\n<h1>Forbidden (403)</h1>\n<p>CSRF verification failed. Request aborted.</p>\n<p>Reason: ${reason}</p>\n</body></html>\n`,
    "text/html; charset=utf-8",
  );

const tokenChallenge = (): Reply =>
  // 2015: the API layer reused Rails-style token authentication, realm and message included.
  textReply(401, "HTTP Token: Access denied.\n", "text/plain; charset=utf-8", [
    ["WWW-Authenticate", 'Token realm="Application"'],
  ]);

const signatureFailure = (
  code: string,
  extra: Readonly<Record<string, unknown>> = {},
): Reply => json(401, { error: { code, ...extra } });

const cookies = (request: Received): ReadonlyMap<string, string> => {
  // Browsers send one Cookie line; join any repeats the way Node's own parser would.
  const jar = new Map<string, string>();
  for (const pair of headerValues(request.lines, "cookie")
    .join("; ")
    .split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    // The first occurrence wins, as in the cookie parser the framework ships with.
    if (!jar.has(name)) jar.set(name, pair.slice(separator + 1).trim());
  }
  return jar;
};

const percentDecode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

const sameText = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const parseJson = (request: Received): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(request.body)) as unknown;
  } catch {
    return undefined;
  }
};

const blankField = (
  value: unknown,
  fields: ReadonlyArray<string>,
): string | undefined => {
  if (typeof value !== "object" || value === null) return fields[0];
  const record = value as Readonly<Record<string, unknown>>;
  return fields.find(
    (field) =>
      typeof record[field] !== "string" ||
      (record[field] as string).trim() === "",
  );
};

/** The legacy v1 retirement announcements, each added by a different team. */
const retirement = (deprecation: string): Lines => [
  // 2025: API governance added RFC 9745's `Deprecation` to the routes it knew about. The 2019
  // gateway rule on `/v1/channels` still sends the draft-era `true`, and nobody owns that rule.
  ["Deprecation", deprecation],
  // 2019: the platform team added RFC 8594's `Sunset` when the retirement date was agreed.
  ["Sunset", "Sun, 31 Jan 2027 23:59:59 GMT"],
  // 2015: the original team announced the retirement in `Warning`, because the 2015 Android SDK
  // shows any 299 text as a banner. The text still has the first planned date; changing it needs
  // an SDK release nobody will ship.
  [
    "Warning",
    '299 - "Deprecated API: \\"/v1\\" retires 2026-06-30; use /v2" "Wed, 31 Dec 2025 23:59:59 GMT"',
  ],
  // 2021: the API gateway adds its own warning line for metered legacy traffic.
  [
    "Warning",
    '299 notify-gw.example.test:8443 "v1 traffic is metered, billed per call"',
  ],
  ["Link", '</v2/subscriptions>; rel="successor-version"'],
];

/** Fresh service state per call. */
export const handler = (options: Options): Handler => {
  const windowMs = options.windowMs ?? 300_000;
  const now = () => Date.now() + (options.clockOffsetMs ?? 0);
  const quirks = {
    subscriptionsOmitContentType:
      options.cors?.subscriptionsOmitContentType ?? true,
    strictAnnouncements: options.cors?.strictAnnouncements ?? true,
    v1ContainerOptions: options.cors?.v1ContainerOptions ?? true,
    v1ExposeWarningOnly: options.cors?.v1ExposeWarningOnly ?? true,
  };
  const issued = new Set<string>();
  const spent = new Map<string, number>();
  const subscriptions: Array<Subscription> = [
    { id: "sub_1", channel: "billing", address: "billing@example.test" },
    { id: "sub_2", channel: "incidents", address: "oncall@example.test" },
  ];
  const announcements: Array<Announcement> = [];
  let unavailable = options.announce?.unavailable?.times ?? 0;

  const csrf = (request: Received): Reply | undefined => {
    const cookie = cookies(request).get("XSRF-TOKEN");
    if (cookie === undefined) return csrfPage("CSRF cookie not set.");
    const token = header(request.lines, "x-xsrf-token");
    if (token === undefined || token === "")
      return csrfPage("CSRF token missing.");
    const decoded = percentDecode(cookie);
    if (decoded === undefined || !sameText(decoded, token))
      return csrfPage("CSRF token incorrect.");
    if (!issued.has(token)) return csrfPage("CSRF token not recognised.");
    return undefined;
  };

  const authenticate = (request: Received): Reply | undefined => {
    const values = headerValues(request.lines, "authorization");
    const match =
      values.length === 1
        ? /^Token token="([^"]*)"$/.exec(values[0]!)
        : undefined;
    return match?.[1] !== undefined && sameText(match[1], options.acceptedToken)
      ? undefined
      : tokenChallenge();
  };

  const verify = (request: Received): Reply | undefined => {
    // 2016: signed announcements, after a leaked token was used to page every on-call engineer.
    const timestamp = header(request.lines, "x-notify-timestamp");
    const signature = header(request.lines, "x-notify-signature");
    if (timestamp === undefined || signature === undefined)
      return signatureFailure("signature_missing");
    const current = now();
    const stamped = /^\d{1,16}$/.test(timestamp) ? Number(timestamp) : NaN;
    if (!(Math.abs(current - stamped) <= windowMs))
      return signatureFailure("timestamp_out_of_window", {
        serverTime: current,
        windowMs,
      });
    const expected = createHmac("sha256", options.signingSecret)
      .update(`${request.method}\n${path(request)}\n${timestamp}\n`)
      .update(request.body)
      .digest("hex");
    if (!sameText(signature, `v1=${expected}`))
      return signatureFailure("signature_mismatch");
    for (const [seen, expires] of spent)
      if (expires < current) spent.delete(seen);
    if (spent.has(expected)) return signatureFailure("signature_replayed");
    // The signature is spent as soon as it verifies, before the fan-out is even asked.
    spent.set(expected, stamped + windowMs);
    return undefined;
  };

  const app = router([
    {
      method: "GET",
      path: "/v2/session/csrf",
      handle: () => {
        const token = randomBytes(16).toString("base64");
        issued.add(token);
        // 2014: the framework's cookie helper percent-encodes values; the SPA's HTTP library
        // decodes the cookie before echoing it, so the header carries the decoded token.
        return json(200, { csrfToken: token }, [
          [
            "Set-Cookie",
            `XSRF-TOKEN=${encodeURIComponent(token)}; Path=/; SameSite=Lax`,
          ],
          ["Cache-Control", "no-store"],
        ]);
      },
    },
    {
      method: "POST",
      path: "/v2/subscriptions",
      handle: (request) => {
        const refused = csrf(request) ?? authenticate(request);
        if (refused !== undefined) return refused;
        const value = parseJson(request);
        const field = blankField(value, ["channel", "address"]);
        if (field !== undefined)
          return json(422, {
            error: { code: "invalid_subscription", field },
          });
        const { channel, address } = value as Readonly<Record<string, string>>;
        const created = {
          id: `sub_${subscriptions.length + 1}`,
          channel: channel!,
          address: address!,
        };
        subscriptions.push(created);
        return json(201, created, [
          ["Location", `/v2/subscriptions/${created.id}`],
        ]);
      },
    },
    {
      method: "GET",
      path: "/v1/subscriptions",
      handle: (request) =>
        authenticate(request) ??
        json(200, { subscriptions }, retirement("@1767225599")),
    },
    {
      method: "GET",
      path: "/v1/channels",
      handle: (request) =>
        authenticate(request) ??
        json(
          200,
          { channels: ["billing", "incidents", "month-end"] },
          retirement("true"),
        ),
    },
    {
      method: "POST",
      path: "/v2/announcements",
      handle: async (request, context) => {
        const refused =
          csrf(request) ?? authenticate(request) ?? verify(request);
        if (refused !== undefined) return refused;
        const value = parseJson(request);
        const field = blankField(value, ["channel", "subject", "body"]);
        if (field !== undefined)
          return json(422, {
            error: { code: "invalid_announcement", field },
          });
        const draft = value as Readonly<Record<string, string>>;
        if (unavailable > 0) {
          unavailable--;
          const retryAfter = options.announce?.unavailable?.retryAfter;
          return json(
            503,
            { error: { code: "fanout_busy" } },
            retryAfter === undefined ? [] : [["Retry-After", retryAfter]],
          );
        }
        if (options.announce?.fail === "error")
          return textReply(
            500,
            "<html><body><h1>500 Internal Server Error</h1></body></html>\n",
            "text/html",
          );
        if (options.announce?.fail === "frozen")
          return json(409, {
            error: { code: "channel_frozen", channel: draft["channel"] },
          });
        const holdMs = options.announce?.holdMs ?? 0;
        if (holdMs > 0) {
          await sleep(holdMs, context.signal);
          if (context.signal.aborted) return { status: 499 };
        }
        const recorded: Announcement = {
          id: `ann_${announcements.length + 1}`,
          channel: draft["channel"]!,
          subject: draft["subject"]!,
          body: draft["body"]!,
          receivedAt: new Date(now()).toISOString(),
        };
        announcements.push(recorded);
        return json(202, recorded, [
          ["Location", `/v2/announcements/${recorded.id}`],
        ]);
      },
    },
    {
      method: "GET",
      path: "/v2/announcements",
      handle: (request) =>
        authenticate(request) ?? json(200, { announcements }),
    },
  ]);

  const allowedOrigin = (request: Received): string | undefined => {
    const origin = header(request.lines, "origin");
    return origin !== undefined && options.allowedOrigins.includes(origin)
      ? origin
      : undefined;
  };

  const corsLines = (origin: string): Lines => [
    ["Access-Control-Allow-Origin", origin],
    ["Access-Control-Allow-Credentials", "true"],
  ];

  /** The hand-rolled filter's preflight answer, listing `headers` and checking nothing else. */
  const filterAnswer = (
    origin: string | undefined,
    headers: string,
  ): Reply => ({
    status: 204,
    lines: [
      ...(origin === undefined ? [] : corsLines(origin)),
      ["Access-Control-Allow-Methods", "GET, POST, OPTIONS"],
      ["Access-Control-Allow-Headers", headers],
      ["Access-Control-Max-Age", "600"],
      ["Vary", "Origin"],
    ],
  });

  const announcementHeaders = [
    "authorization",
    "content-type",
    "x-xsrf-token",
    "x-notify-timestamp",
    "x-notify-signature",
  ];

  const preflight = (request: Received): Reply => {
    const target = path(request);
    const origin = allowedOrigin(request);
    if (target.startsWith("/v1/") && quirks.v1ContainerOptions)
      // The v1 routes still run in the 2013 servlet container, which answers OPTIONS itself from
      // the methods the servlet implements. The application, and with it the CORS filter and every
      // header the application adds, never sees the request.
      return {
        status: 200,
        lines: [
          ["Allow", "GET, OPTIONS"],
          ["Content-Length", "0"],
        ],
      };
    if (target === "/v2/announcements" && quirks.strictAnnouncements) {
      // 2016: the security review of signed announcements demanded a strict filter that refuses
      // any header outside its list. Tracing arrived in 2021; the filter has not been re-reviewed.
      if (origin === undefined)
        return textReply(403, "CORS origin not allowed\n", "text/plain");
      const requested = (
        header(request.lines, "access-control-request-headers") ?? ""
      )
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== "");
      const refused = requested.find(
        (name) => !announcementHeaders.includes(name),
      );
      if (refused !== undefined)
        return textReply(
          403,
          `CORS request header "${refused}" is not allowed\n`,
          "text/plain",
        );
      return filterAnswer(
        origin,
        "Authorization, Content-Type, X-XSRF-TOKEN, X-Notify-Timestamp, X-Notify-Signature",
      );
    }
    if (target === "/v2/announcements")
      return filterAnswer(
        origin,
        "Authorization, Content-Type, X-XSRF-TOKEN, X-Notify-Timestamp, X-Notify-Signature, traceparent, b3",
      );
    // 2015: the v2 subscription endpoint copied its allowlist from the v1 form endpoint, whose
    // form-encoded bodies never needed Content-Type listed. Other routes list it.
    return filterAnswer(
      origin,
      target === "/v2/subscriptions" && quirks.subscriptionsOmitContentType
        ? "Authorization, X-XSRF-TOKEN, X-Requested-With"
        : "Authorization, Content-Type, X-XSRF-TOKEN, X-Requested-With",
    );
  };

  return async (request, context) => {
    if (request.method === "OPTIONS") return preflight(request);
    const reply = await app(request, context);
    const origin = allowedOrigin(request);
    if (origin === undefined) return reply;
    // The hand-rolled CORS filter decorates every application response for allowed origins. The
    // v1 routes expose only `Warning`, which the 2015 web banner read.
    const exposed = !path(request).startsWith("/v1/")
      ? []
      : quirks.v1ExposeWarningOnly
        ? ["Warning"]
        : ["Warning", "Deprecation", "Sunset", "Link"];
    return {
      ...reply,
      lines: [
        ...(reply.lines ?? []),
        ...corsLines(origin),
        ...(exposed.length === 0
          ? []
          : ([["Access-Control-Expose-Headers", exposed.join(", ")]] as const)),
        ["Vary", "Origin"],
      ],
    };
  };
};
