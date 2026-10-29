# Identity provider (`identity`)

An OAuth-ish identity provider that three teams grew over fifteen years. Each era left a code path
that nobody can retire, because some client still depends on its exact behaviour:

- **The directory gateway (2004)** fronts the corporate LDAP directory.
- **The OAuth token servlet (2012)** issues tokens for form-encoded grants.
- **The mobile JSON API (2016)** has its own token, login, registration and profile endpoints.

A 2012 servlet filter guards the directory and the profile, and a 2019 rate limiter sits in front of
the three credential endpoints. The [test options](#test-options) at the end are for the suite's
tests, not part of the published service.

## Endpoints

| Method and path                         | Part                     | Access       |
| --------------------------------------- | ------------------------ | ------------ |
| `GET /.well-known/openid-configuration` | Discovery                | none         |
| `POST /oauth/token`                     | Token servlet (2012)     | rate limited |
| `POST /api/v2/token`                    | Mobile JSON API (2016)   | rate limited |
| `POST /api/v2/login`                    | Mobile JSON API (2016)   | rate limited |
| `POST /api/v2/users`                    | Mobile JSON API (2016)   | none         |
| `GET /api/v2/me`                        | Mobile JSON API (2016)   | Bearer token |
| `GET /directory/users/{uid}`            | Directory gateway (2004) | Bearer token |

Any other path answers 404, and another method on a listed path answers 405 with `Allow`.

## Discovery

`GET /.well-known/openid-configuration` answers 200 with the `issuer`, `token_endpoint`
(`/oauth/token`) and `userinfo_endpoint` (`/api/v2/me`) as absolute URLs on the provider's origin,
`grant_types_supported` (`password`, `client_credentials`, `refresh_token`) and
`token_endpoint_auth_methods_supported` (`client_secret_post`).

The issuer has a trailing slash: `<origin>/`. It was configured in 2015 as the site root with its
slash. Relying parties compare it exactly and refresh tokens carry it, so dropping the slash would
log everybody out. The Jetty rewrite rules match the literal path, so a client that appends
`/.well-known/...` to the issuer asks for `//.well-known/...` and meets a 404.

## The OAuth token servlet (2012)

`POST /oauth/token` takes a form-encoded grant. Its media-type check predates the JSON API and was
never widened: any other content type answers 415 with an OAuth error. A repeated form parameter
answers 400 `invalid_request`.

| `grant_type`         | Parameters                                     | Default scope    |
| -------------------- | ---------------------------------------------- | ---------------- |
| `password`           | `username`, `password`, optional `scope`       | `openid profile` |
| `client_credentials` | `client_id`, `client_secret`, optional `scope` | `directory:read` |
| `refresh_token`      | `refresh_token`                                | the original one |

`scope` is a space-separated list of known scopes: `openid`, `profile`, `email`, `offline_access`,
`directory:read` and `directory:write`. An unknown one answers 400 `invalid_scope`.

A success answers 200 with `access_token`, `token_type`, `expires_in` and `scope`; the `password`
and `refresh_token` grants add a `refresh_token`. Every value is a string, including
`expires_in: "3600"`, and `token_type` is `"bearer"`. Every reply carries
`Content-Type: application/json;charset=UTF-8`, `Cache-Control: no-store` and `Pragma: no-cache`.
The servlet answered through Spring's message converter, which always added the charset, and RFC
6749 section 5.1 requires the no-store headers. Every value went through a `Map<String, String>`,
so numbers are strings too; the 2013 Android SDK parses `expires_in` with `Integer.parseInt` and
breaks on a number, so it stays a string.

Errors are OAuth error objects, `{ "error": …, "error_description": … }`:

- 400 `invalid_grant`: wrong credentials, or an inactive account, for the `password` grant; an
  unknown or already rotated refresh token.
- 400 `unsupported_grant_type`: any other `grant_type`.
- 401 `invalid_client` with `WWW-Authenticate: Basic realm="oauth"`: an unknown client or a wrong
  secret.

A client registered for the 2013 pilot of draft-ietf-oauth-v2-http-mac gets `token_type: "mac"`
from the `client_credentials` grant, with a `mac_key` and `mac_algorithm: "hmac-sha-256"`.

## Tokens

Access tokens are opaque: 24 random bytes in standard Base64, so `+` and `/` are common. The
resource servers look them up; nothing parses them.

The 2014 "stateless refresh" project made refresh tokens JWT-shaped. Revocation still needed the
family table, so the provider ignores the claims and checks the table. The `exp` claim is copied
from the account's first-ever session, a bug in the rollout, so it is always in the past. Mobile
apps that checked it broke in 2014 and stopped checking, and nobody fixed it. Each refresh token
works once: the `refresh_token` grant answers with a new one, and the old one is then refused as
already rotated.

## The resource filter (2012)

The directory and `GET /api/v2/me` accept `Authorization: Bearer <token>` for every access token
this provider issued. The filter compares the scheme case-sensitively with `startsWith("Bearer ")`,
against RFC 9110; it is a shared library jar in forty services, and changing it needs all of them
redeployed. Any other `Authorization` value, or none, answers 401 with
`WWW-Authenticate: Bearer realm="directory"` and a bare message object:

```json
{ "message": "Full authentication is required to access this resource" }
```

Spring Security's default entry point wrote that shape, and forty internal services match on its
text.

## The directory gateway (2004)

`GET /directory/users/{uid}` answers 200 with the entry, under the attributes' upper-case LDAP
names:

```json
{
  "DN": "uid=alovelace,ou=people,dc=identity,dc=test",
  "UID": "alovelace",
  "CN": "Ada Lovelace",
  "MAIL": "ada@identity.test",
  "ACTIVE": "Y",
  "CREATETIMESTAMP": "20040315093000Z",
  "MODIFYTIMESTAMP": "20190102030405Z"
}
```

- `ACTIVE` is `Y` or `N`. An inactive user keeps its values.
- Times are LDAP generalized times. The gateway writes UTC with whole seconds and `Z`. Entries
  imported from Active Directory in 2009 carry a fractional second (`.0Z`): the import job copied
  the string as is, and the LDAP schema's GeneralizedTime syntax accepts it.
- An unknown uid is answered with status 200 and a blank entry: every attribute is `""` and
  `ACTIVE` is `"N"`. The gateway's JSP template renders whatever entry the LDAP search returned; for
  no entry it renders the same template with nothing filled in, and `ACTIVE` defaults to `N`.
  Nightly reports count rows, so a 404 was never added.

The 2004 gateway has no read timeout towards LDAP: when the directory stalls, every request that
needs it waits until the caller hangs up.

## The mobile JSON API (2016)

The three `POST` endpoints take JSON bodies, which must be sent as `application/json` (415
otherwise) and must parse (400 `MALFORMED_JSON` otherwise). All four endpoints answer
`application/json`.

- 4xx errors nest a code and message: `{ "error": { "code": …, "message": … } }`. The mobile team
  nested the code so they could add fields later; they never did.
- 5xx errors are a bare JSON string, with `Retry-After: 30`. The exception mapper wrote
  `JSON.stringify(exception.getMessage())`, and the iOS client's error banner shows that string
  verbatim, so it stays.

### `POST /api/v2/token`

The mobile grant takes `{ "grant_type": "password", "username": …, "password": … }`. Requested
scopes travel as `X-OAuth-Scope` header lines, one scope per line; the API gateway's scope plugin
maps each line to one requested scope. In 2017 a comma-joined line was granted as one scope
literally named `profile, admin`, and the fix refuses any line containing a comma with 400
`INVALID_SCOPE`. An unknown scope is also 400 `INVALID_SCOPE`.

A success answers 200 with `access_token`, `token_type: "Bearer"`, `expires_in` as a number and
`refresh_token`. The granted scopes, `openid`, `profile` and the requested ones, come back the same
way, one `X-OAuth-Scope` response line each, because the plugin cannot write a body. The web SSO
also sets its session cookie and the balancer's affinity cookie here:

```http
Set-Cookie: IDPSESSION=<random>; Path=/; HttpOnly; SameSite=Lax
Set-Cookie: IDPLB=node-3; Path=/; Expires=Fri, 01 Jan 2038 00:00:00 GMT
```

Errors: 400 `UNSUPPORTED_GRANT` for another grant type, 401 `BAD_CREDENTIALS`, and 403
`ACCOUNT_DISABLED` for an inactive account.

### `POST /api/v2/login`

The web login, ported in 2016 from the 2009 SSO gateway, takes `{ "username": …, "password": … }`.
It answers 200 with tokens only, `access_token`, `refresh_token`, `token_type: "BEARER"` and
`expires_in` as a number; the profile is a separate request to `/api/v2/me`. The SSO gateway
upper-cased every response value for a mainframe terminal client, and the port kept `BEARER`
because the terminal emulator still logs in through it. Like the mobile grant, it answers 401
`BAD_CREDENTIALS` and 403 `ACCOUNT_DISABLED`.

### `POST /api/v2/users`

Self-registration takes `{ "uid": …, "cn": …, "mail": …, "password": … }`, writes the LDAP entry,
and answers 201 with the entry as the directory renders it, active and stamped with the time of
registration. Validation failures answer 400 `VALIDATION_FAILED`:

- `uid`: 3 to 16 lower-case letters or digits, starting with a letter;
- `cn`: not blank;
- `mail`: contains `@`;
- `password`: at least 8 characters.

A uid that exists answers 409 `UID_TAKEN`.

### `GET /api/v2/me`

The caller's directory entry, behind the resource filter. A token issued by the
`client_credentials` grant has no user and answers 401 with
`{ "message": "The token has no user" }`.

## Directory outages

Every request that needs the directory answers 503 with the mobile API's bare string while LDAP is
down, whichever part it reaches: the `password` grant of `/oauth/token`, the mobile grant, the
login, registration, `/api/v2/me` and the directory itself.

```json
"Directory unavailable: LDAP connection pool exhausted"
```

## The rate limiter (2019)

`POST /oauth/token`, `POST /api/v2/token` and `POST /api/v2/login` share a limiter of 10 requests
per bucket per 60-second window. A request counts before any other check, so malformed requests and
failed logins spend the bucket too. Past the limit, they answer 429 with
`{ "message": "Rate limit exceeded for <bucket>" }` and `Retry-After` in seconds until the window
ends.

The limiter was added in 2019 against credential stuffing. Ops put it behind the load balancer,
which appends the client address to `X-Forwarded-For`; the limiter keys on the first entry, which
the client controls. Without the header, every request comes from the balancer's address,
`10.20.0.5`, and shares one bucket. Fixing it would need the balancer team to overwrite the header,
which breaks two partners who send their own.

## Test options

Start the provider with `lane.backend("identity", options)`. Every start has fresh state: tokens,
refresh token families, registered users and rate-limit buckets. Options are plain JSON, and every
member is optional.

- `token`: a pre-provisioned opaque access token. The resource filter accepts it without any grant,
  as a token without a user, and the first registered client's `client_credentials` grant issues
  exactly this value, so a test can configure other services with the same token.
- `clients`: OAuth clients for the `client_credentials` grant, as `{ id, secret, tokenType? }`.
  `tokenType` is `"bearer"` (the default) or `"mac"`, for the 2013 MAC pilot. Defaults to none.
- `now`: a fixed clock in epoch milliseconds, for the timestamps of registered users and the
  rate-limit windows. Defaults to the real time.
- `ldap`: `"up"` (the default), `"down"` for the 503 outage, or `"stalled"` to hold every request
  that needs the directory until the client gives up.
- `rateLimit`: `{ limit?, peer?, exhausted? }`. `limit` is the requests per bucket per window
  (default 10); `peer` is the address the provider sees as its socket peer, the load balancer
  (default `10.20.0.5`); `exhausted` lists buckets that other traffic has already spent for the
  current window.

### Seeded directory

Every start has these users. Any other uid answers with the blank entry.

| uid         | `CN`            | `MAIL`                  | `ACTIVE` | Password            | `CREATETIMESTAMP`   | `MODIFYTIMESTAMP`   |
| ----------- | --------------- | ----------------------- | -------- | ------------------- | ------------------- | ------------------- |
| `alovelace` | Ada Lovelace    | `ada@identity.test`     | `Y`      | `analytical-engine` | `20040315093000Z`   | `20190102030405Z`   |
| `cbabbage`  | Charles Babbage | `charles@identity.test` | `N`      | `difference-engine` | `20040315093100Z`   | `20121231235959Z`   |
| `ghopper`   | Grace Hopper    | `grace@identity.test`   | `Y`      | `a-ship-in-port`    | `20080229235959Z`   | `20160601000000Z`   |
| `kzuse`     | Konrad Zuse     | `konrad@identity.test`  | `Y`      | `plankalkuel`       | `20090601120000.0Z` | `20090601120000.0Z` |

`kzuse` is the entry imported from Active Directory, whose fractional times a strict reader
refuses. `cbabbage` is inactive: the `password` grant, the mobile grant and the login refuse it.
