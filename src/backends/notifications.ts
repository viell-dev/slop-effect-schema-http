/**
 * The notification service. The handler applies the layers in the order they were stacked: CORS
 * preflights and decoration around the application router, then within each route the CSRF check,
 * the Token check and, for announcements, the signature check. Every call to {@link handler}
 * creates fresh state.
 *
 * Service documentation: services/notifications.md
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

/** The `announce` test option. */
export interface AnnounceFailurePoint {
  readonly unavailable?:
    | {
        readonly times: number;
        readonly retryAfter?: string | undefined;
      }
    | undefined;
  readonly fail?: "error" | "frozen" | undefined;
  readonly holdMs?: number | undefined;
}

/** The `cors` test option: each hostile CORS behaviour, on unless set to `false`. */
export interface CorsQuirks {
  readonly subscriptionsOmitContentType?: boolean | undefined;
  readonly strictAnnouncements?: boolean | undefined;
  readonly v1ContainerOptions?: boolean | undefined;
  readonly v1ExposeWarningOnly?: boolean | undefined;
}

/** The test options, documented under "Test options" in the service page. */
export interface Options {
  readonly acceptedToken: string;
  readonly signingSecret: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly windowMs?: number | undefined;
  readonly clockOffsetMs?: number | undefined;
  readonly announce?: AnnounceFailurePoint | undefined;
  readonly cors?: CorsQuirks | undefined;
  readonly csrfCookieSameSite?: "Lax" | "None" | undefined;
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

/** The CSRF middleware's own HTML page. */
const csrfPage = (reason: string): Reply =>
  textReply(
    403,
    `<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body>\n<h1>Forbidden (403)</h1>\n<p>CSRF verification failed. Request aborted.</p>\n<p>Reason: ${reason}</p>\n</body></html>\n`,
    "text/html; charset=utf-8",
  );

/** The Token layer's refusal. */
const tokenChallenge = (): Reply =>
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

/** The legacy v1 retirement headers. */
const retirement = (deprecation: string): Lines => [
  ["Deprecation", deprecation],
  ["Sunset", "Sun, 31 Jan 2027 23:59:59 GMT"],
  [
    "Warning",
    '299 - "Deprecated API: \\"/v1\\" retires 2026-06-30; use /v2" "Wed, 31 Dec 2025 23:59:59 GMT"',
  ],
  [
    "Warning",
    '299 notify-gw.example.test:8443 "v1 traffic is metered, billed per call"',
  ],
  ["Link", '</v2/subscriptions>; rel="successor-version"'],
];

/** The CORS filter's answer for an allowed origin, credentials included. */
const corsLines = (origin: string): Lines => [
  ["Access-Control-Allow-Origin", origin],
  ["Access-Control-Allow-Credentials", "true"],
];

/** The hand-rolled filter's preflight answer, listing `headers` and checking nothing else. */
const filterAnswer = (origin: string | undefined, headers: string): Reply => ({
  status: 204,
  lines: [
    ...(origin === undefined ? [] : corsLines(origin)),
    ["Access-Control-Allow-Methods", "GET, POST, OPTIONS"],
    ["Access-Control-Allow-Headers", headers],
    ["Access-Control-Max-Age", "600"],
    ["Vary", "Origin"],
  ],
});

/** Fresh service state per call. */
export const handler = (given?: Options): Handler => {
  if (
    given === undefined ||
    typeof given.acceptedToken !== "string" ||
    typeof given.signingSecret !== "string" ||
    !Array.isArray(given.allowedOrigins)
  )
    throw new Error(
      "notifications: the test must pass acceptedToken, signingSecret and allowedOrigins",
    );
  const options = given;
  const sameSite =
    options.csrfCookieSameSite === "None"
      ? "SameSite=None; Secure"
      : "SameSite=Lax";
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
    // Remembered until its timestamp leaves the window, after which a replay fails that check.
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
        return json(200, { csrfToken: token }, [
          [
            "Set-Cookie",
            `XSRF-TOKEN=${encodeURIComponent(token)}; Path=/; ${sameSite}`,
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
      // The servlet container's answer, written before the application or its filter runs.
      return {
        status: 200,
        lines: [
          ["Allow", "GET, OPTIONS"],
          ["Content-Length", "0"],
        ],
      };
    if (target === "/v2/announcements" && quirks.strictAnnouncements) {
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
    // The CORS filter decorates every application response for allowed origins.
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
