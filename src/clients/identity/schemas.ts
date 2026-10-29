/**
 * The consumer's schemas for the identity provider. Wire names and spellings stay at this
 * boundary: the domain uses its own field names, one token type, numbers for durations, `Date`
 * for instants, `null` for blank attributes, and a `_tag` on every decoded response, which the
 * wire never carries.
 */
import {
  Effect,
  Redacted,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { UrlParams } from "effect/http";
import {
  blankAsNull,
  IntegerString,
  type Issuer,
  LdapTime,
  No,
  TokenType,
  Yes,
} from "../../values/identity.js";

// ---------------------------------------------------------------------------------------------
// Tokens and secrets
// ---------------------------------------------------------------------------------------------

/**
 * AUTH-4. An opaque access token. It is never parsed: only its presence is checked, and it is
 * kept redacted so it does not appear in logs or error output.
 */
export const AccessToken = Schema.RedactedFromValue(
  Schema.NonEmptyString.pipe(Schema.brand("AccessToken")),
  { label: "access_token" },
);
export type AccessToken = typeof AccessToken.Type;

/**
 * AUTH-4. A refresh token. The provider makes it JWT-shaped, but the client treats it as opaque
 * as well: its claims are the server's business, and they are wrong anyway.
 */
export const RefreshToken = Schema.RedactedFromValue(
  Schema.NonEmptyString.pipe(Schema.brand("RefreshToken")),
  { label: "refresh_token" },
);
export type RefreshToken = typeof RefreshToken.Type;

/** A password or client secret, supplied by the caller and kept redacted. */
export const Secret = Schema.RedactedFromValue(Schema.NonEmptyString);

/** A directory uid, as the provider allows it for registration. */
export const Uid = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]{2,15}$/),
);

/**
 * One OAuth scope token (RFC 6749 section 3.3) without the comma, which the provider refuses in
 * a scope line.
 */
export const ScopeToken = Schema.String.check(
  Schema.isPattern(/^[\x21\x23-\x2B\x2D-\x5B\x5D-\x7E]+$/),
);

/** RFC 6749's space-delimited scope string, split on single spaces only. */
export const ScopeList = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(ScopeToken),
    SchemaTransformation.transform<ReadonlyArray<string>, string>({
      decode: (text) => (text === "" ? [] : text.split(" ")),
      encode: (scopes) => scopes.join(" "),
    }),
  ),
);

/** The provider-independent token set that every grant path decodes into. */
const tokenSet = <Expiry extends Schema.Constraint>(expiry: Expiry) =>
  Schema.Struct({
    _tag: Schema.tagDefaultOmit("Tokens"),
    accessToken: AccessToken,
    tokenType: TokenType,
    expiresIn: expiry,
    refreshToken: Schema.optionalKey(RefreshToken),
    scope: Schema.optionalKey(ScopeList),
  }).pipe(
    Schema.encodeKeys({
      accessToken: "access_token",
      tokenType: "token_type",
      expiresIn: "expires_in",
      refreshToken: "refresh_token",
    }),
  );

/** PAY-9. The 2012 servlet's token response, where every value, including the expiry, is a string. */
export const FormTokenSet = tokenSet(IntegerString);

/** PAY-9. The 2016 API's token response, with a numeric expiry. */
export const JsonTokenSet = tokenSet(Schema.Natural);

export type TokenSet = typeof JsonTokenSet.Type;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * AUTH-3. The Authorization header for the resource endpoints. It is written from the normalized
 * token type, so a token set from any grant path can be passed as it is; the provider's filter
 * accepts only the RFC 6750 spelling.
 */
export const Credentials = Schema.Struct({ Authorization: Schema.String }).pipe(
  Schema.decodeTo(
    Schema.Struct({
      tokenType: Schema.Literal("Bearer"),
      accessToken: Schema.toType(AccessToken),
    }),
    SchemaTransformation.transformEffect({
      decode: ({ Authorization }, options) => {
        const match = /^Bearer (\S+)$/.exec(Authorization);
        return match === null
          ? Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "Expected `Bearer <token>`" },
                Authorization,
                options,
              ),
            )
          : Schema.decodeEffect(AccessToken)(match[1]!).pipe(
              Effect.mapError((error) => error.issue),
              Effect.map((accessToken) => ({
                tokenType: "Bearer" as const,
                accessToken,
              })),
            );
      },
      encode: ({ tokenType, accessToken }) =>
        Effect.succeed({
          Authorization: `${tokenType} ${Redacted.value(accessToken)}`,
        }),
    }),
  ),
);

/** HDR-1. Requested scopes, one `X-OAuth-Scope` line per scope. */
export const RequestedScopes = Schema.Struct({
  scopes: Schema.Array(ScopeToken),
}).pipe(Schema.encodeKeys({ scopes: "X-OAuth-Scope" }));

const UrlParamsValue = Schema.declare(
  (input: unknown): input is UrlParams.UrlParams =>
    UrlParams.isUrlParams(input),
  { expected: "UrlParams" },
);

/**
 * Form parameters as a record with one value per key. A repeated key is refused on decode rather
 * than collapsed, as RFC 6749 forbids repeated parameters. Encoding keeps the record's key order.
 */
const FormRecord = UrlParamsValue.pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.String),
    SchemaTransformation.transformEffect({
      decode: (params: UrlParams.UrlParams, options) => {
        const record: Record<string, string> = {};
        for (const [key, value] of params.params) {
          if (Object.hasOwn(record, key))
            return Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: `Repeated form parameter ${key}` },
                params,
                options,
              ),
            );
          record[key] = Redacted.isRedacted(value)
            ? String(Redacted.value(value))
            : value;
        }
        return Effect.succeed(record);
      },
      encode: (record: Readonly<Record<string, string>>) =>
        Effect.succeed(UrlParams.make(Object.entries(record))),
    }),
  ),
);

const PasswordGrant = Schema.Struct({
  grantType: Schema.Literal("password"),
  username: Uid,
  password: Secret,
  scope: ScopeList,
}).pipe(Schema.encodeKeys({ grantType: "grant_type" }));

const ClientCredentialsGrant = Schema.Struct({
  grantType: Schema.Literal("client_credentials"),
  clientId: Schema.NonEmptyString,
  clientSecret: Secret,
  scope: ScopeList,
}).pipe(
  Schema.encodeKeys({
    grantType: "grant_type",
    clientId: "client_id",
    clientSecret: "client_secret",
  }),
);

const RefreshGrant = Schema.Struct({
  grantType: Schema.Literal("refresh_token"),
  refreshToken: RefreshToken,
}).pipe(
  Schema.encodeKeys({ grantType: "grant_type", refreshToken: "refresh_token" }),
);

/** PAY-9. The servlet's form-encoded grants. */
export const FormGrant = FormRecord.pipe(
  Schema.decodeTo(
    Schema.Union([PasswordGrant, ClientCredentialsGrant, RefreshGrant]),
  ),
);
export type FormGrant = typeof FormGrant.Type;

/** PAY-9. The 2016 API's JSON grant. Requested scopes travel as header lines, not in the body. */
export const JsonGrant = Schema.Struct({
  grantType: Schema.Literal("password"),
  username: Uid,
  password: Secret,
}).pipe(Schema.encodeKeys({ grantType: "grant_type" }));

/** STAT-1. The web login's body. */
export const Login = Schema.Struct({ username: Uid, password: Secret });

/** STAT-1. Self-registration. The provider also checks rules the client does not, such as length. */
export const Registration = Schema.Struct({
  uid: Uid,
  commonName: Schema.NonEmptyString,
  mail: Schema.NonEmptyString,
  password: Secret,
}).pipe(Schema.encodeKeys({ commonName: "cn" }));

// ---------------------------------------------------------------------------------------------
// Directory entries
// ---------------------------------------------------------------------------------------------

/** VAL-5a. The gateway's upper-case LDAP attribute names for the domain's own field names. */
const attributes = {
  active: "ACTIVE",
  uid: "UID",
  commonName: "CN",
  mail: "MAIL",
  created: "CREATETIMESTAMP",
  modified: "MODIFYTIMESTAMP",
} as const;

/** ERR-4. An active entry: every attribute is required and non-blank. */
export const ActiveEntry = Schema.Struct({
  _tag: Schema.tagDefaultOmit("Entry"),
  active: Yes,
  uid: Uid,
  commonName: Schema.NonEmptyString,
  mail: Schema.NonEmptyString,
  created: LdapTime,
  modified: LdapTime,
}).pipe(Schema.encodeKeys(attributes));

/**
 * ERR-4. An inactive entry. The gateway also answers a missing uid this way, with every attribute
 * blank, so each attribute may be `null`; a missing user is an inactive entry whose `uid` is
 * `null`.
 */
export const InactiveEntry = Schema.Struct({
  _tag: Schema.tagDefaultOmit("Entry"),
  active: No,
  uid: blankAsNull(Uid),
  commonName: blankAsNull(Schema.NonEmptyString),
  mail: blankAsNull(Schema.NonEmptyString),
  created: blankAsNull(LdapTime),
  modified: blankAsNull(LdapTime),
}).pipe(Schema.encodeKeys(attributes));

/**
 * ERR-4. A directory entry, discriminated by `active`: its attributes cannot be read as present
 * values without checking the flag first.
 */
export const DirectoryEntry = Schema.Union([ActiveEntry, InactiveEntry]);
export type DirectoryEntry = typeof DirectoryEntry.Type;

/**
 * A decoded entry that may be assigned work: decoding refuses an inactive entry, including the
 * blank entry of a missing user.
 */
export const Assignee = Schema.toType(ActiveEntry);
export type Assignee = typeof Assignee.Type;

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

/**
 * VAL-5a. The discovery document, valid only when its issuer is exactly the configured one,
 * trailing slash included (OpenID Connect Discovery section 4.3).
 */
export const Discovery = (issuer: Issuer) =>
  Schema.Struct({
    _tag: Schema.tagDefaultOmit("Discovery"),
    issuer: Schema.Literal(issuer),
    tokenEndpoint: Schema.NonEmptyString,
    userinfoEndpoint: Schema.NonEmptyString,
  }).pipe(
    Schema.encodeKeys({
      tokenEndpoint: "token_endpoint",
      userinfoEndpoint: "userinfo_endpoint",
    }),
  );

// ---------------------------------------------------------------------------------------------
// ERR-5: four error shapes. The wire carries no discriminant; each schema attaches its own `_tag`
// on decode and strips it on encode.
// ---------------------------------------------------------------------------------------------

/** The 2012 servlet's OAuth error object (RFC 6749 section 5.2). */
export const OAuthError = Schema.Struct({
  _tag: Schema.tagDefaultOmit("OAuthError"),
  error: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ description: "error_description" }));

/** The 2012 filter's and the rate limiter's bare message object. */
export const MessageError = Schema.Struct({
  _tag: Schema.tagDefaultOmit("MessageError"),
  message: Schema.String,
});

/** The 2016 API's nested code and message for 4xx, flattened. */
export const CodedError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.NonEmptyString,
    message: Schema.String,
  }),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      _tag: Schema.tag("CodedError"),
      code: Schema.NonEmptyString,
      message: Schema.String,
    }),
    SchemaTransformation.transform({
      decode: ({ error }) => ({
        _tag: "CodedError" as const,
        code: error.code,
        message: error.message,
      }),
      encode: ({ code, message }) => ({ error: { code, message } }),
    }),
  ),
);

/** The 2016 API's 5xx: a bare JSON string. */
export const ServerFault = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ _tag: Schema.tag("ServerFault"), message: Schema.String }),
    SchemaTransformation.transform({
      decode: (message: string) => ({ _tag: "ServerFault" as const, message }),
      encode: ({ message }) => message,
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// HDR-1: granted scopes from response lines
// ---------------------------------------------------------------------------------------------

/**
 * HDR-1. The granted scopes, as far as the provider's response lines can be known. `Lines` holds
 * one scope per physical line. `Joined` means the provider supplied no original lines, only the
 * normalized value with repeated lines joined by `, `; a scope token may contain a comma, so the
 * value is reported as is rather than split.
 */
export const GrantedScopes = Schema.Union([
  Schema.TaggedStruct("Lines", { scopes: Schema.Array(ScopeToken) }),
  Schema.TaggedStruct("Joined", { value: Schema.String }),
]);
export type GrantedScopes = typeof GrantedScopes.Type;
