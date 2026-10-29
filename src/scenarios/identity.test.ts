import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { Cookies, HttpClient } from "effect/http";
import * as Identity from "../backends/identity.js";
import {
  AccessToken,
  Assignee,
  controls,
  discover,
  formGrant,
  type FormGrant,
  FormTokenSet,
  forwardedFor,
  jsonGrant,
  JsonTokenSet,
  login,
  lookupUser,
  profile,
  register,
  requests,
} from "../clients/identity/index.js";
import { fetchClient, linesLayer } from "../harness/providers.js";
import { header, headerValues, path, serve, text } from "../harness/server.js";
import { Issuer } from "../values/identity.js";

/** The one place this file starts the provider. */
const start = (options?: Identity.Options) => serve(Identity.handler(options));

// Fixture values chosen by these tests and passed to the provider as options.
const reporting = { id: "reporting", secret: "reporting-secret" } as const;
/** A pinned opaque token: Base64-like, with characters that would tempt a parser. */
const pinned = "v1.Zm9v+YmFy/YmF6==";
const ada = { username: "alovelace", password: "analytical-engine" } as const;

const secret = (value: string) => Redacted.make(value);
const pinnedCredentials = () => ({
  tokenType: "Bearer" as const,
  accessToken: Schema.decodeSync(AccessToken)(pinned),
});
const passwordGrant = (password: string = ada.password) =>
  ({
    grantType: "password",
    username: ada.username,
    password: secret(password),
    scope: ["openid", "profile"],
  }) satisfies FormGrant;
const loginInput = {
  body: { username: ada.username, password: secret(ada.password) },
};
const jsonGrantInput = (scopes: ReadonlyArray<string>) => ({
  headers: { scopes },
  body: {
    grantType: "password" as const,
    username: ada.username,
    password: secret(ada.password),
  },
});

/** Assert the case a union value decoded to, and narrow it. */
const narrow = <A extends { readonly _tag: string }, T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

const decodeJwtSegment = (segment: string): unknown =>
  JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")));

describe("identity provider", () => {
  describe("AUTH-3 token types", () => {
    it.live(
      "[AUTH-3] normalizes the three token-type spellings of the three grant paths",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const { origin } = server;
          // What the provider really sends, read without the consumer's schemas.
          const raw = [
            yield* controls
              .raw(requests.formGrant(origin))
              .execute({ body: passwordGrant() }),
            yield* controls
              .raw(requests.jsonGrant(origin))
              .execute(jsonGrantInput([])),
            yield* controls.raw(requests.login(origin)).execute(loginInput),
          ];
          expect(
            raw.map((body) => (body as { token_type: unknown }).token_type),
          ).toEqual(["bearer", "Bearer", "BEARER"]);

          const viaForm = narrow(
            yield* formGrant(origin).execute({ body: passwordGrant() }),
            "Tokens",
          );
          const viaJson = narrow(
            yield* jsonGrant(origin).execute(jsonGrantInput([])),
            "Granted",
          ).value.tokens;
          const viaLogin = narrow(
            yield* login(origin).execute(loginInput),
            "Tokens",
          );
          const all = [viaForm, viaJson, viaLogin];
          expect(all.map((tokens) => tokens.tokenType)).toEqual([
            "Bearer",
            "Bearer",
            "Bearer",
          ]);
          // Any grant path's token set works as credentials, written in one spelling.
          for (const tokens of all)
            narrow(
              yield* profile(origin).execute({ headers: tokens }),
              "Entry",
            );
          const profiles = server.ledger.slice(6);
          expect(profiles.map((received) => path(received))).toEqual([
            "/api/v2/me",
            "/api/v2/me",
            "/api/v2/me",
          ]);
          expect(
            profiles.map((received) => header(received.lines, "authorization")),
          ).toEqual(
            all.map((tokens) => `Bearer ${Redacted.value(tokens.accessToken)}`),
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[AUTH-3] refuses an unknown token scheme as a decode error instead of guessing",
      () =>
        Effect.gen(function* () {
          const server = yield* start({
            clients: [
              { id: "pilot-mac", secret: "pilot-mac-secret", tokenType: "mac" },
            ],
          });
          const error = yield* Effect.flip(
            formGrant(server.origin).execute({
              body: {
                grantType: "client_credentials",
                clientId: "pilot-mac",
                clientSecret: secret("pilot-mac-secret"),
                scope: ["directory:read"],
              },
            }),
          );
          const decode = narrow(error, "DecodeError");
          expect(decode.metadata.status).toBe(200);
          expect(Schema.isSchemaError(decode.cause)).toBe(true);
          expect(String(decode.cause)).toMatch(/token_type/);
          expect(server.ledger).toHaveLength(1);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[AUTH-3] the resource filter refuses the login's own spelling echoed verbatim",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const raw = (yield* controls
            .raw(requests.login(server.origin))
            .execute(loginInput)) as {
            readonly token_type: string;
            readonly access_token: string;
          };
          const echoed = yield* controls
            .profileWithAuthorization(server.origin)
            .execute({
              headers: {
                Authorization: `${raw.token_type} ${raw.access_token}`,
              },
            });
          expect(narrow(echoed, "MessageError").message).toBe(
            "Full authentication is required to access this resource",
          );
          const normalized = yield* controls
            .profileWithAuthorization(server.origin)
            .execute({
              headers: { Authorization: `Bearer ${raw.access_token}` },
            });
          expect(narrow(normalized, "Entry").uid).toBe("alovelace");
          expect(
            server.ledger
              .slice(1)
              .map((received) => header(received.lines, "authorization")),
          ).toEqual([
            `BEARER ${raw.access_token}`,
            `Bearer ${raw.access_token}`,
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("AUTH-4 opaque tokens", () => {
    it.live(
      "[AUTH-4] returns a JWT-shaped refresh token byte for byte without reading its stale claims",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const { origin } = server;
          const tokens = narrow(
            yield* login(origin).execute(loginInput),
            "Tokens",
          );
          const refresh = tokens.refreshToken!;
          expect(String(refresh)).toBe("<redacted:refresh_token>");
          expect(String(tokens.accessToken)).toBe("<redacted:access_token>");
          // The test reads the claims to show what the client ignores: an expiry in 2010.
          const segments = Redacted.value(refresh).split(".");
          expect(segments).toHaveLength(3);
          const claims = decodeJwtSegment(segments[1]!) as { exp: number };
          expect(claims.exp * 1000).toBeLessThan(Date.UTC(2011, 0, 1));

          const refreshed = narrow(
            yield* formGrant(origin).execute({
              body: { grantType: "refresh_token", refreshToken: refresh },
            }),
            "Tokens",
          );
          narrow(
            yield* profile(origin).execute({ headers: refreshed }),
            "Entry",
          );
          const [, refreshRequest, profileRequest] = server.ledger;
          expect(text(refreshRequest!)).toBe(
            `grant_type=refresh_token&refresh_token=${Redacted.value(refresh)}`,
          );
          expect(header(profileRequest!.lines, "authorization")).toBe(
            `Bearer ${Redacted.value(refreshed.accessToken)}`,
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[AUTH-4] a rotated refresh token is refused by the server, not judged by the client",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const { origin } = server;
          const tokens = narrow(
            yield* login(origin).execute(loginInput),
            "Tokens",
          );
          const refresh = {
            grantType: "refresh_token",
            refreshToken: tokens.refreshToken!,
          } as const;
          narrow(yield* formGrant(origin).execute({ body: refresh }), "Tokens");
          const replayed = yield* formGrant(origin).execute({ body: refresh });
          expect(narrow(replayed, "OAuthError")).toEqual({
            _tag: "OAuthError",
            error: "invalid_grant",
            description: "Refresh token was already rotated",
          });
          expect(text(server.ledger[1]!)).toBe(text(server.ledger[2]!));
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[AUTH-4] client credentials issue the pinned opaque token, which the directory accepts",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ token: pinned, clients: [reporting] });
          const { origin } = server;
          // The pinned token is accepted before any grant: other services can be configured with it.
          narrow(
            yield* lookupUser(origin).execute({
              path: "ghopper",
              headers: pinnedCredentials(),
            }),
            "Entry",
          );
          const tokens = narrow(
            yield* formGrant(origin).execute({
              body: {
                grantType: "client_credentials",
                clientId: reporting.id,
                clientSecret: secret(reporting.secret),
                scope: ["directory:read"],
              },
            }),
            "Tokens",
          );
          expect(Redacted.value(tokens.accessToken)).toBe(pinned);
          expect(tokens.refreshToken).toBeUndefined();
          expect(tokens.scope).toEqual(["directory:read"]);
          narrow(
            yield* lookupUser(origin).execute({
              path: "alovelace",
              headers: tokens,
            }),
            "Entry",
          );
          expect(
            server.ledger.map((received) =>
              header(received.lines, "authorization"),
            ),
          ).toEqual([`Bearer ${pinned}`, undefined, `Bearer ${pinned}`]);
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("AUTH-8 rate limiting", () => {
    const bucket = (address: string) =>
      Layer.effect(HttpClient.HttpClient)(
        Effect.map(HttpClient.HttpClient, forwardedFor(address)),
      ).pipe(Layer.provide(fetchClient));

    it.live(
      "[AUTH-8] a shared bucket spent by other traffic refuses an honest request with a bare message",
      () =>
        Effect.gen(function* () {
          const server = yield* start({
            rateLimit: {
              limit: 2,
              peer: "10.20.0.5",
              exhausted: ["10.20.0.5"],
            },
          });
          const result = yield* login(server.origin).execute(loginInput);
          expect(narrow(result, "MessageError").message).toBe(
            "Rate limit exceeded for 10.20.0.5",
          );
          expect(server.ledger).toHaveLength(1);
          expect(header(server.ledger[0]!.lines, "x-forwarded-for")).toBe(
            undefined,
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[AUTH-8] a forged X-Forwarded-For claims a private bucket of the test's own",
      () =>
        Effect.gen(function* () {
          const server = yield* start({
            rateLimit: {
              limit: 2,
              peer: "10.20.0.5",
              exhausted: ["10.20.0.5"],
            },
          });
          const attempt = (address: string) =>
            login(server.origin)
              .execute(loginInput)
              .pipe(Effect.provide(bucket(address)));
          const own = [
            yield* attempt("198.51.100.23"),
            yield* attempt("198.51.100.23"),
            yield* attempt("198.51.100.23"),
          ];
          expect(own.map((result) => result._tag)).toEqual([
            "Tokens",
            "Tokens",
            "MessageError",
          ]);
          expect(narrow(own[2]!, "MessageError").message).toBe(
            "Rate limit exceeded for 198.51.100.23",
          );
          // Another forged address is another fresh bucket.
          expect((yield* attempt("198.51.100.24"))._tag).toBe("Tokens");
          expect(
            server.ledger.map((received) =>
              headerValues(received.lines, "x-forwarded-for"),
            ),
          ).toEqual([
            ["198.51.100.23"],
            ["198.51.100.23"],
            ["198.51.100.23"],
            ["198.51.100.24"],
          ]);
        }),
    );
  });

  describe("ERR-4 missing users", () => {
    it.live(
      "[ERR-4] a missing user arrives as 200 with ACTIVE N and blank fields, and decodes to nulls",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ token: pinned });
          const input = { path: "nobody", headers: pinnedCredentials() };
          const raw = yield* controls
            .raw(requests.lookupUser(server.origin))
            .execute(input);
          expect(raw).toEqual({
            DN: "",
            UID: "",
            CN: "",
            MAIL: "",
            ACTIVE: "N",
            CREATETIMESTAMP: "",
            MODIFYTIMESTAMP: "",
          });
          const entry = narrow(
            yield* lookupUser(server.origin).execute(input),
            "Entry",
          );
          expect(entry).toEqual({
            _tag: "Entry",
            active: false,
            uid: null,
            commonName: null,
            mail: null,
            created: null,
            modified: null,
          });
          expect(server.ledger.map((received) => received.target)).toEqual([
            "/directory/users/nobody",
            "/directory/users/nobody",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[ERR-4] an inactive user keeps its values, and none reads as present until active is checked",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ token: pinned });
          const entry = narrow(
            yield* lookupUser(server.origin).execute({
              path: "cbabbage",
              headers: pinnedCredentials(),
            }),
            "Entry",
          );
          // @ts-expect-error An attribute may be null until `active` has been checked.
          const unchecked: string = entry.commonName;
          expect(unchecked).toBe("Charles Babbage");
          expect(entry.active).toBe(false);
          if (entry.active)
            expectTypeOf(entry.commonName).toEqualTypeOf<string>();
          else expectTypeOf(entry.commonName).toEqualTypeOf<string | null>();
          // Inactive entries cannot become assignees; active ones can.
          expect(
            Exit.isFailure(Schema.decodeUnknownExit(Assignee)(entry)),
          ).toBe(true);
          const active = narrow(
            yield* lookupUser(server.origin).execute({
              path: "alovelace",
              headers: pinnedCredentials(),
            }),
            "Entry",
          );
          expect(
            Exit.isSuccess(Schema.decodeUnknownExit(Assignee)(active)),
          ).toBe(true);
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("ERR-5 error shapes", () => {
    it.live(
      "[ERR-5] the token servlet's 400 decodes as a tagged OAuth error",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const result = yield* formGrant(server.origin).execute({
            body: passwordGrant("wrong-password"),
          });
          expect(narrow(result, "OAuthError")).toEqual({
            _tag: "OAuthError",
            error: "invalid_grant",
            description: "Bad credentials",
          });
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[ERR-5] the resource filter's 401 decodes as a tagged bare message",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ token: pinned });
          const result = yield* profile(server.origin).execute({
            headers: {
              tokenType: "Bearer",
              accessToken: Schema.decodeSync(AccessToken)("not-issued"),
            },
          });
          expect(narrow(result, "MessageError")).toEqual({
            _tag: "MessageError",
            message: "Full authentication is required to access this resource",
          });
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[ERR-5] the JSON API's 401 decodes as a tagged, flattened code and message",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const result = yield* login(server.origin).execute({
            body: {
              username: ada.username,
              password: secret("wrong-password"),
            },
          });
          expect(narrow(result, "CodedError")).toEqual({
            _tag: "CodedError",
            code: "BAD_CREDENTIALS",
            message: "Username or password is wrong",
          });
          const disabled = yield* login(server.origin).execute({
            body: {
              username: "cbabbage",
              password: secret("difference-engine"),
            },
          });
          expect(narrow(disabled, "CodedError").code).toBe("ACCOUNT_DISABLED");
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live("[ERR-5] a 5xx flat string decodes as a tagged server fault", () =>
      Effect.gen(function* () {
        const server = yield* start({ ldap: "down", token: pinned });
        const viaLogin = yield* login(server.origin).execute(loginInput);
        const viaDirectory = yield* lookupUser(server.origin).execute({
          path: "alovelace",
          headers: pinnedCredentials(),
        });
        for (const result of [viaLogin, viaDirectory])
          expect(narrow(result, "ServerFault")).toEqual({
            _tag: "ServerFault",
            message: "Directory unavailable: LDAP connection pool exhausted",
          });
        expect(server.ledger).toHaveLength(2);
      }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[ERR-5] a stalled directory surfaces as a timeout, not as a fifth error shape",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ ldap: "stalled", token: pinned });
          const error = yield* lookupUser(server.origin)
            .execute({ path: "alovelace", headers: pinnedCredentials() })
            .pipe(Effect.timeout("300 millis"), Effect.flip);
          expect(error._tag).toBe("TimeoutError");
          yield* Effect.promise(() => server.arrived(1));
          // The provider observes the abort: the attempt's request was closed, not abandoned.
          const aborted = yield* Effect.sync(() =>
            server.ledger[0]!.aborted(),
          ).pipe(
            Effect.repeat({
              until: (value) => value,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeoutOption(Duration.seconds(2)),
          );
          expect(aborted).toEqual(Option.some(true));
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("STAT-1 register, login, profile", () => {
    const now = Date.UTC(2026, 9, 29, 12, 34, 56);
    const turing = {
      uid: "aturing",
      commonName: "Alan Turing",
      mail: "alan@identity.test",
      password: secret("enigma-machine"),
    };

    it.live(
      "[STAT-1] register answers 201 with the entry, login only tokens, and the profile takes a third request",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ now });
          const { origin } = server;
          const registered = narrow(
            yield* register(origin).execute({ body: turing }),
            "Entry",
          );
          expect(registered).toEqual({
            _tag: "Entry",
            active: true,
            uid: "aturing",
            commonName: "Alan Turing",
            mail: "alan@identity.test",
            created: new Date(now),
            modified: new Date(now),
          });
          const tokens = narrow(
            yield* login(origin).execute({
              body: { username: "aturing", password: turing.password },
            }),
            "Tokens",
          );
          expect(Object.keys(tokens).toSorted()).toEqual([
            "_tag",
            "accessToken",
            "expiresIn",
            "refreshToken",
            "tokenType",
          ]);
          const me = narrow(
            yield* profile(origin).execute({ headers: tokens }),
            "Entry",
          );
          expect(me).toEqual(registered);
          expect(
            server.ledger.map(
              (received) => `${received.method} ${received.target}`,
            ),
          ).toEqual([
            "POST /api/v2/users",
            "POST /api/v2/login",
            "GET /api/v2/me",
          ]);
          expect(text(server.ledger[0]!)).toBe(
            `{"uid":"aturing","cn":"Alan Turing","mail":"alan@identity.test","password":"enigma-machine"}`,
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live("[STAT-1] refuses an invalid uid before dispatch", () =>
      Effect.gen(function* () {
        const server = yield* start({ now });
        const error = yield* Effect.flip(
          register(server.origin).execute({
            body: { ...turing, uid: "Alan Turing" },
          }),
        );
        expect(error._tag).toBe("SchemaError");
        expect(server.ledger).toHaveLength(0);
      }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[STAT-1] the provider refuses a short password the client let through, and a taken uid",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ now });
          const short = yield* register(server.origin).execute({
            body: { ...turing, password: secret("short") },
          });
          expect(narrow(short, "CodedError")).toEqual({
            _tag: "CodedError",
            code: "VALIDATION_FAILED",
            message: "password must have at least 8 characters",
          });
          const taken = yield* register(server.origin).execute({
            body: { ...turing, uid: "alovelace" },
          });
          expect(narrow(taken, "CodedError").code).toBe("UID_TAKEN");
          expect(server.ledger).toHaveLength(2);
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("HDR-1 repeated header lines", () => {
    it.live(
      "[HDR-1] Fetch joins the scope lines, and the provider rejects the comma-joined value",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const result = yield* jsonGrant(server.origin).execute(
            jsonGrantInput(["directory:read", "directory:write"]),
          );
          expect(narrow(result, "CodedError")).toEqual({
            _tag: "CodedError",
            code: "INVALID_SCOPE",
            message:
              "Send one scope per X-OAuth-Scope line; a comma-joined value is refused",
          });
          expect(
            headerValues(server.ledger[0]!.lines, "x-oauth-scope"),
          ).toEqual(["directory:read, directory:write"]);
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — the line-preserving provider is a node:http client.
    it.live(
      "[HDR-1] the line-preserving provider sends one scope per line and reads four granted lines",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const result = yield* jsonGrant(server.origin).execute(
            jsonGrantInput(["directory:read", "directory:write"]),
          );
          const granted = narrow(result, "Granted");
          expect(
            server.ledger[0]!.lines.filter(
              ([name]) => name === "X-OAuth-Scope",
            ),
          ).toEqual([
            ["X-OAuth-Scope", "directory:read"],
            ["X-OAuth-Scope", "directory:write"],
          ]);
          expect(granted.value.granted).toEqual({
            _tag: "Lines",
            scopes: ["openid", "profile", "directory:read", "directory:write"],
          });
          expect(Option.isSome(granted.metadata.headerLines)).toBe(true);
          expect(granted.metadata.headers["x-oauth-scope"]).toBe(
            "openid, profile, directory:read, directory:write",
          );
        }).pipe(Effect.provide(linesLayer)),
    );

    it.live(
      "[HDR-1] through Fetch the response metadata says no original lines exist",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const result = yield* jsonGrant(server.origin).execute(
            jsonGrantInput(["directory:read"]),
          );
          const granted = narrow(result, "Granted");
          expect(granted.metadata.headerLines).toEqual(Option.none());
          expect(granted.value.granted).toEqual({
            _tag: "Joined",
            value: "openid, profile, directory:read",
          });
          expect(
            headerValues(server.ledger[0]!.lines, "x-oauth-scope"),
          ).toEqual(["directory:read"]);
        }).pipe(Effect.provide(fetchClient)),
    );

    // lane: node-only — a browser never exposes Set-Cookie to scripts.
    it.live(
      "[HDR-1] parses each Set-Cookie line separately in Node, through both providers",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          for (const provider of [linesLayer, fetchClient]) {
            const granted = narrow(
              yield* jsonGrant(server.origin)
                .execute(jsonGrantInput(["directory:read"]))
                .pipe(Effect.provide(provider)),
              "Granted",
            );
            const { cookies, headers } = granted.metadata;
            const affinity = Cookies.get(cookies, "IDPLB");
            const session = Cookies.get(cookies, "IDPSESSION");
            expect(Option.map(affinity, (cookie) => cookie.value)).toEqual(
              Option.some("node-3"),
            );
            // The comma inside Expires is why the lines cannot be joined and split again.
            expect(
              Option.map(affinity, (cookie) => cookie.options?.expires),
            ).toEqual(Option.some(new Date("2038-01-01T00:00:00Z")));
            expect(
              Option.map(session, (cookie) => cookie.options?.httpOnly),
            ).toEqual(Option.some(true));
            expect(granted.value.session).toEqual(
              Option.map(session, (cookie) => cookie.value),
            );
            // Effect's normalized map keeps one Set-Cookie value; only the parsed cookies are whole.
            expect(headers["set-cookie"]).toBe(
              "IDPLB=node-3; Path=/; Expires=Fri, 01 Jan 2038 00:00:00 GMT",
            );
            if (provider === linesLayer)
              expect(
                Option.map(
                  granted.metadata.headerLines,
                  (lines) =>
                    lines.filter(([name]) => name === "Set-Cookie").length,
                ),
              ).toEqual(Option.some(2));
          }
        }),
    );

    it.live("[HDR-1] refuses a scope containing a comma before dispatch", () =>
      Effect.gen(function* () {
        const server = yield* start();
        const error = yield* Effect.flip(
          jsonGrant(server.origin).execute(
            jsonGrantInput(["directory:read,directory:write"]),
          ),
        );
        expect(error._tag).toBe("SchemaError");
        expect(server.ledger).toHaveLength(0);
      }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("PAY-9 form and JSON grants", () => {
    it.live(
      "[PAY-9] sends grants form-encoded and decodes string values, including the expiry",
      () =>
        Effect.gen(function* () {
          const odd = { id: "reporting", secret: "s3cr&t=+ %" };
          const server = yield* start({ clients: [odd] });
          const { origin } = server;
          const raw = (yield* controls
            .raw(requests.formGrant(origin))
            .execute({ body: passwordGrant() })) as Record<string, unknown>;
          expect(raw["expires_in"]).toBe("3600");
          expect(
            Object.values(raw).every((value) => typeof value === "string"),
          ).toBe(true);
          const tokens = narrow(
            yield* formGrant(origin).execute({
              body: {
                grantType: "client_credentials",
                clientId: odd.id,
                clientSecret: secret(odd.secret),
                scope: ["directory:read"],
              },
            }),
            "Tokens",
          );
          expect(tokens.expiresIn).toBe(3600);
          expect(tokens.scope).toEqual(["directory:read"]);
          const [passwordRequest, credentialsRequest] = server.ledger;
          expect(text(passwordRequest!)).toBe(
            "grant_type=password&username=alovelace&password=analytical-engine&scope=openid+profile",
          );
          expect(text(credentialsRequest!)).toBe(
            "grant_type=client_credentials&client_id=reporting&client_secret=s3cr%26t%3D%2B+%25&scope=directory%3Aread",
          );
          expect(header(credentialsRequest!.lines, "content-type")).toBe(
            "application/x-www-form-urlencoded",
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-9] sends the JSON grant as JSON and decodes a numeric expiry into the same domain type",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const raw = (yield* controls
            .raw(requests.jsonGrant(server.origin))
            .execute(jsonGrantInput([]))) as Record<string, unknown>;
          expect(raw["expires_in"]).toBe(3600);
          const granted = narrow(
            yield* jsonGrant(server.origin).execute(jsonGrantInput([])),
            "Granted",
          );
          expect(granted.value.tokens.expiresIn).toBe(3600);
          expectTypeOf<typeof FormTokenSet.Type>().toEqualTypeOf<
            typeof JsonTokenSet.Type
          >();
          const sent = server.ledger[1]!;
          expect(header(sent.lines, "content-type")).toBe("application/json");
          expect(text(sent)).toBe(
            `{"grant_type":"password","username":"alovelace","password":"analytical-engine"}`,
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-9] the form endpoint answers JSON with 415 and an OAuth error",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const result = yield* controls
            .jsonToFormEndpoint(server.origin)
            .execute(jsonGrantInput([]));
          expect(result).toEqual({
            _tag: "OAuthError",
            error: "invalid_request",
            description:
              "Content-Type must be application/x-www-form-urlencoded",
          });
          expect(header(server.ledger[0]!.lines, "content-type")).toBe(
            "application/json",
          );
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[PAY-9] the JSON endpoint answers a form with 415 and a coded error",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const result = yield* controls
            .formToJsonEndpoint(server.origin)
            .execute({ body: passwordGrant() });
          expect(result).toEqual({
            _tag: "CodedError",
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Expected application/json",
          });
          expect(header(server.ledger[0]!.lines, "content-type")).toBe(
            "application/x-www-form-urlencoded",
          );
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("VAL-1a LDAP times", () => {
    it.live("[VAL-1a] decodes the directory's LDAP times to instants", () =>
      Effect.gen(function* () {
        const server = yield* start({ token: pinned });
        const lookup = (uid: string) =>
          lookupUser(server.origin).execute({
            path: uid,
            headers: pinnedCredentials(),
          });
        const lovelace = narrow(yield* lookup("alovelace"), "Entry");
        const hopper = narrow(yield* lookup("ghopper"), "Entry");
        expect([lovelace.created, lovelace.modified, hopper.created]).toEqual([
          new Date("2004-03-15T09:30:00Z"),
          new Date("2019-01-02T03:04:05Z"),
          new Date("2008-02-29T23:59:59Z"),
        ]);
      }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[VAL-1a] refuses an imported entry's fractional time as a final decode error",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ token: pinned });
          const input = { path: "kzuse", headers: pinnedCredentials() };
          const raw = (yield* controls
            .raw(requests.lookupUser(server.origin))
            .execute(input)) as Record<string, unknown>;
          expect(raw["CREATETIMESTAMP"]).toBe("20090601120000.0Z");
          const error = yield* Effect.flip(
            lookupUser(server.origin).execute(input),
          );
          const decode = narrow(error, "DecodeError");
          expect(decode.metadata.status).toBe(200);
          expect(Schema.isSchemaError(decode.cause)).toBe(true);
          // Effect reports the path under the domain name: the rename runs before the value transform.
          expect(String(decode.cause)).toMatch(
            /Expected LDAP generalized time as YYYYMMDDHHMMSSZ\s+at \["created"\]/,
          );
          expect(server.ledger).toHaveLength(2);
        }).pipe(Effect.provide(fetchClient)),
    );
  });

  describe("VAL-5a attribute names and issuer", () => {
    it.live(
      "[VAL-5a] reads upper-case attribute names into the domain's own field names",
      () =>
        Effect.gen(function* () {
          const server = yield* start({ token: pinned });
          const input = { path: "alovelace", headers: pinnedCredentials() };
          const raw = (yield* controls
            .raw(requests.lookupUser(server.origin))
            .execute(input)) as Record<string, unknown>;
          expect(Object.keys(raw)).toEqual([
            "DN",
            "UID",
            "CN",
            "MAIL",
            "ACTIVE",
            "CREATETIMESTAMP",
            "MODIFYTIMESTAMP",
          ]);
          const entry = narrow(
            yield* lookupUser(server.origin).execute(input),
            "Entry",
          );
          expect(Object.keys(entry).toSorted()).toEqual([
            "_tag",
            "active",
            "commonName",
            "created",
            "mail",
            "modified",
            "uid",
          ]);
          expect(entry).toMatchObject({
            active: true,
            uid: "alovelace",
            commonName: "Ada Lovelace",
            mail: "ada@identity.test",
          });
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[VAL-5a] discovers from an issuer with a trailing slash without doubling it",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const issuer = Schema.decodeSync(Issuer)(`${server.origin}/`);
          const document = narrow(
            yield* discover(issuer).execute(undefined),
            "Discovery",
          );
          expect(document.issuer).toBe(`${server.origin}/`);
          expect(document.tokenEndpoint).toBe(`${server.origin}/oauth/token`);
          expect(server.ledger.map((received) => received.target)).toEqual([
            "/.well-known/openid-configuration",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[VAL-5a] refuses a discovery document whose issuer differs by the trailing slash",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const issuer = Schema.decodeSync(Issuer)(server.origin);
          const error = yield* Effect.flip(discover(issuer).execute(undefined));
          const decode = narrow(error, "DecodeError");
          expect(decode.metadata.status).toBe(200);
          expect(String(decode.cause)).toMatch(/issuer/);
          // The request itself was the same: the join adds the slash the issuer lacks.
          expect(server.ledger.map((received) => received.target)).toEqual([
            "/.well-known/openid-configuration",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );

    it.live(
      "[VAL-5a] string concatenation doubles the slash and meets an unexpected 404",
      () =>
        Effect.gen(function* () {
          const server = yield* start();
          const issuer = Schema.decodeSync(Issuer)(`${server.origin}/`);
          const error = yield* Effect.flip(
            controls.naiveDiscovery(issuer).execute(undefined),
          );
          expect(narrow(error, "UnexpectedResponse").metadata.status).toBe(404);
          expect(server.ledger.map((received) => received.target)).toEqual([
            "//.well-known/openid-configuration",
          ]);
        }).pipe(Effect.provide(fetchClient)),
    );
  });
});
