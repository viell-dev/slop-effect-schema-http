/**
 * The consumer's schemas for the notification service, written from its observed wire behaviour.
 * Header schemas reuse the value conventions in `src/values/notifications.ts`.
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { tokenList } from "../../values/notifications.js";

// Request bodies.

export const SubscriptionDraft = Schema.Struct({
  channel: Schema.NonEmptyString,
  address: Schema.NonEmptyString,
});
export type SubscriptionDraft = typeof SubscriptionDraft.Type;

/** The client refuses an empty field before any network; the server also refuses blank ones. */
export const AnnouncementDraft = Schema.Struct({
  channel: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
});
export type AnnouncementDraft = typeof AnnouncementDraft.Type;

// Response bodies.

export const Subscription = Schema.Struct({
  id: Schema.String,
  channel: Schema.String,
  address: Schema.String,
});

export const SubscriptionList = Schema.Struct({
  subscriptions: Schema.Array(Subscription),
});

export const ChannelList = Schema.Struct({
  channels: Schema.Array(Schema.String),
});

export const Announcement = Schema.Struct({
  id: Schema.String,
  channel: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  receivedAt: Schema.String,
});

export const AnnouncementList = Schema.Struct({
  announcements: Schema.Array(Announcement),
});

export const CsrfBootstrap = Schema.Struct({
  csrfToken: Schema.NonEmptyString,
});

/** The four reasons a signature is refused, all 401 with the same metadata: a body-level union. */
export const SignatureFailure = Schema.Struct({
  error: Schema.Union([
    Schema.Struct({ code: Schema.Literal("signature_missing") }),
    Schema.Struct({
      code: Schema.Literal("timestamp_out_of_window"),
      serverTime: Schema.Int,
      windowMs: Schema.Int,
    }),
    Schema.Struct({ code: Schema.Literal("signature_mismatch") }),
    Schema.Struct({ code: Schema.Literal("signature_replayed") }),
  ]),
});

export const Invalid = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["invalid_announcement", "invalid_subscription"]),
    field: Schema.String,
  }),
});

export const Frozen = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("channel_frozen"),
    channel: Schema.String,
  }),
});

const csrfReasons = {
  "CSRF cookie not set.": "cookie-missing",
  "CSRF token missing.": "token-missing",
  "CSRF token incorrect.": "token-incorrect",
  "CSRF token not recognised.": "token-unrecognised",
} as const;

export const CsrfReason = Schema.Literals([
  "cookie-missing",
  "token-missing",
  "token-incorrect",
  "token-unrecognised",
]);

/**
 * The framework's 403 page, read for its `Reason:` line. One-way: the page's markup is not kept,
 * so encoding a reason back into a page fails with that reason.
 */
export const CsrfFailurePage = Schema.String.pipe(
  Schema.decodeTo(
    CsrfReason,
    SchemaTransformation.transformEffect({
      decode: (page, options) => {
        const line = /<p>Reason: ([^<]*)<\/p>/.exec(page)?.[1];
        const reason =
          line === undefined
            ? undefined
            : (csrfReasons as Readonly<Record<string, typeof CsrfReason.Type>>)[
                line
              ];
        return reason === undefined
          ? Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "not a recognised CSRF failure page" },
                page,
                options,
              ),
            )
          : Effect.succeed(reason);
      },
      encode: (reason, options) =>
        Effect.fail(
          new SchemaIssue.InvalidValue(
            {
              message:
                "one-way: the CSRF page's markup is not kept, so a reason cannot be encoded back into a page",
            },
            reason,
            options,
          ),
        ),
    }),
  ),
);

// Request header schemas.

const cookieOctets = /^[!#-+\--:<-[\]-~]+$/;

/**
 * The `Cookie` line carrying only the XSRF cookie, with its value exactly as the server set it
 * (still percent-encoded).
 */
const XsrfCookieLine = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (line, options) => {
        const match = /^XSRF-TOKEN=(.*)$/.exec(line);
        return match !== null && cookieOctets.test(match[1]!)
          ? Effect.succeed(match[1]!)
          : Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "expected `XSRF-TOKEN=<cookie-octets>`" },
                line,
                options,
              ),
            );
      },
      encode: (value, options) =>
        cookieOctets.test(value)
          ? Effect.succeed(`XSRF-TOKEN=${value}`)
          : Effect.fail(
              new SchemaIssue.InvalidValue(
                {
                  message:
                    "a cookie value is cookie-octets; it must stay as the server encoded it",
                },
                value,
                options,
              ),
            ),
    }),
  ),
);

/**
 * The double-submit pair a CSRF bootstrap yields: the body's token, and the cookie value exactly as
 * the server set it (still percent-encoded). `cookie` is absent where the transport hides
 * `Set-Cookie`, as a browser does.
 */
export const CsrfSession = Schema.Struct({
  token: Schema.NonEmptyString,
  cookie: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(cookieOctets)),
  ),
});
export type CsrfSession = typeof CsrfSession.Type;

/**
 * The CSRF header lines: the token in `X-XSRF-TOKEN`, and the cookie set by hand on a `Cookie` line
 * when `cookie` is given. Node's clients keep no cookies, so a Node consumer sets it by hand. A
 * browser forbids scripts from setting `Cookie`, so there `cookie` is left out and the browser's
 * own cookie handling carries it.
 */
export const CsrfHeaders = Schema.Struct({
  token: Schema.NonEmptyString,
  cookie: Schema.optionalKey(XsrfCookieLine),
}).pipe(Schema.encodeKeys({ token: "X-XSRF-TOKEN", cookie: "Cookie" }));
export type CsrfHeaders = typeof CsrfHeaders.Type;

/**
 * What a browser would send as a CORS preflight. Fetch lists the requested headers lowercased,
 * sorted and joined with `,`; this schema writes them in the given order.
 */
export const PreflightRequest = Schema.Struct({
  origin: Schema.String,
  method: Schema.String,
  headers: Schema.optionalKey(tokenList(",")),
}).pipe(
  Schema.encodeKeys({
    origin: "Origin",
    method: "Access-Control-Request-Method",
    headers: "Access-Control-Request-Headers",
  }),
);
export type PreflightRequest = typeof PreflightRequest.Type;

// Response header schemas, applied to the normalized (lowercase) header map.

/** The CORS answer of a response. Absent headers stay absent. */
export const CorsAnswer = Schema.Struct({
  allowOrigin: Schema.optionalKey(Schema.String),
  allowCredentials: Schema.optionalKey(Schema.Literal("true")),
  allowMethods: Schema.optionalKey(tokenList(", ")),
  allowHeaders: Schema.optionalKey(tokenList(", ")),
  exposeHeaders: Schema.optionalKey(tokenList(", ")),
  allow: Schema.optionalKey(tokenList(", ")),
}).pipe(
  Schema.encodeKeys({
    allowOrigin: "access-control-allow-origin",
    allowCredentials: "access-control-allow-credentials",
    allowMethods: "access-control-allow-methods",
    allowHeaders: "access-control-allow-headers",
    exposeHeaders: "access-control-expose-headers",
    allow: "allow",
  }),
);
export type CorsAnswer = typeof CorsAnswer.Type;
