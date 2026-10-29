import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Exit, Redacted, Schema } from "effect";
import { UrlParams } from "effect/http";
import {
  AccessToken,
  CodedError,
  Credentials,
  DirectoryEntry,
  FormGrant,
  FormTokenSet,
  MessageError,
  OAuthError,
  RefreshToken,
  Registration,
  ScopeList,
  ServerFault,
} from "./schemas.js";

const refused = (exit: Exit.Exit<unknown, unknown>) =>
  expect(Exit.isFailure(exit)).toBe(true);

describe("identity contracts", () => {
  describe("ERR-5 error shapes", () => {
    // Each shape: the wire value decodes with a client-chosen tag, and encoding strips it again.
    const cases = [
      [
        OAuthError,
        { error: "invalid_grant", error_description: "Bad credentials" },
        {
          _tag: "OAuthError",
          error: "invalid_grant",
          description: "Bad credentials",
        },
      ],
      [
        OAuthError,
        { error: "invalid_client" },
        { _tag: "OAuthError", error: "invalid_client" },
      ],
      [
        MessageError,
        { message: "Unauthorized" },
        { _tag: "MessageError", message: "Unauthorized" },
      ],
      [
        CodedError,
        { error: { code: "UID_TAKEN", message: "taken" } },
        { _tag: "CodedError", code: "UID_TAKEN", message: "taken" },
      ],
      [
        ServerFault,
        "Directory unavailable",
        { _tag: "ServerFault", message: "Directory unavailable" },
      ],
    ] as const;

    it("[ERR-5] attaches the tag on decode and strips it on encode", () => {
      for (const [schema, wire, domain] of cases) {
        const codec = Schema.toCodecJson(
          schema as Schema.Codec<unknown, unknown>,
        );
        expect(Schema.decodeUnknownSync(codec)(wire)).toEqual(domain);
        expect(Schema.encodeUnknownSync(codec)(domain)).toEqual(wire);
      }
    });

    it("[ERR-5] refuses one organisation's shape under another's schema", () => {
      refused(
        Schema.decodeUnknownExit(OAuthError)({ message: "Unauthorized" }),
      );
      refused(
        Schema.decodeUnknownExit(MessageError)({ error: "invalid_grant" }),
      );
      refused(Schema.decodeUnknownExit(CodedError)({ error: "invalid_grant" }));
      refused(Schema.decodeUnknownExit(ServerFault)({ message: "x" }));
      refused(Schema.decodeUnknownExit(OAuthError)({ error: "" }));
    });
  });

  describe("ERR-4 and VAL-5a directory entries", () => {
    const active = {
      UID: "alovelace",
      CN: "Ada Lovelace",
      MAIL: "ada@identity.test",
      ACTIVE: "Y",
      CREATETIMESTAMP: "20040315093000Z",
      MODIFYTIMESTAMP: "20190102030405Z",
    };
    const blank = {
      UID: "",
      CN: "",
      MAIL: "",
      ACTIVE: "N",
      CREATETIMESTAMP: "",
      MODIFYTIMESTAMP: "",
    };

    it("[VAL-5a] round-trips upper-case attribute names, dropping only the unmodelled DN", () => {
      const codec = Schema.toCodecJson(DirectoryEntry);
      for (const wire of [active, blank, { ...active, ACTIVE: "N" }]) {
        const decoded = Schema.decodeUnknownSync(codec)({
          DN: "uid=x",
          ...wire,
        });
        // Stated loss: DN is derived from UID and is not part of the domain type.
        expect(Schema.encodeSync(codec)(decoded)).toEqual(wire);
        expect(
          Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(decoded)),
        ).toEqual(decoded);
      }
    });

    it("[ERR-4] refuses an active entry with a blank attribute instead of defaulting it", () => {
      for (const key of ["UID", "CN", "MAIL", "CREATETIMESTAMP"])
        refused(
          Schema.decodeUnknownExit(DirectoryEntry)({ ...active, [key]: "" }),
        );
    });

    it("[ERR-4] refuses flag spellings other than Y and N, and lower-case attribute names", () => {
      for (const flag of ["y", "n", "1", "true", ""])
        refused(
          Schema.decodeUnknownExit(DirectoryEntry)({ ...active, ACTIVE: flag }),
        );
      refused(
        Schema.decodeUnknownExit(DirectoryEntry)(
          Object.fromEntries(
            Object.entries(active).map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          ),
        ),
      );
    });
  });

  describe("AUTH-3 and AUTH-4 tokens", () => {
    it("[AUTH-3] normalizes the token type of a form token set and writes the RFC 6750 spelling back", () => {
      const wire = {
        access_token: "opaque+/=",
        token_type: "bearer",
        expires_in: "3600",
        refresh_token: "a.b.c",
        scope: "openid profile",
      };
      const codec = Schema.toCodecJson(FormTokenSet);
      const decoded = Schema.decodeUnknownSync(codec)(wire);
      expect(decoded.tokenType).toBe("Bearer");
      expect(decoded.expiresIn).toBe(3600);
      expect(decoded.scope).toEqual(["openid", "profile"]);
      // Stated loss: the spelling `bearer` is canonicalized.
      expect(Schema.encodeSync(codec)(decoded)).toEqual({
        ...wire,
        token_type: "Bearer",
      });
    });

    it("[AUTH-3] writes credentials as `Bearer <token>` and refuses other spellings on decode", () => {
      const credentials = {
        tokenType: "Bearer" as const,
        accessToken: Schema.decodeSync(AccessToken)("opaque+/="),
      };
      const encoded = Schema.encodeSync(Credentials)(credentials);
      expect(encoded).toEqual({ Authorization: "Bearer opaque+/=" });
      const decoded = Schema.decodeUnknownSync(Credentials)(encoded);
      expect(Redacted.value(decoded.accessToken)).toBe("opaque+/=");
      for (const value of [
        "BEARER opaque",
        "bearer opaque",
        "Bearer",
        "Bearer a b",
        "Basic abc",
      ])
        refused(
          Schema.decodeUnknownExit(Credentials)({ Authorization: value }),
        );
    });

    it("[AUTH-4] keeps tokens opaque, redacted, and not interchangeable", () => {
      const access = Schema.decodeSync(AccessToken)("not.a.jwt");
      const refresh = Schema.decodeSync(RefreshToken)("eyJ.eyJ.sig");
      expect(String(access)).toBe("<redacted:access_token>");
      expect(Redacted.value(refresh)).toBe("eyJ.eyJ.sig");
      refused(Schema.decodeUnknownExit(AccessToken)(""));
      expectTypeOf(access).not.toEqualTypeOf(refresh);
      const credentials: typeof Credentials.Type = {
        tokenType: "Bearer",
        accessToken: access,
      };
      expect(credentials.accessToken).toBe(access);
      const wrong: typeof Credentials.Type = {
        tokenType: "Bearer",
        // @ts-expect-error A refresh token cannot be sent as an access token.
        accessToken: refresh,
      };
      expect(wrong).toBeDefined();
    });
  });

  describe("PAY-9 form grants", () => {
    it("[PAY-9] encodes a grant as ordered single-valued parameters and decodes it back", () => {
      const grant = {
        grantType: "client_credentials" as const,
        clientId: "reporting",
        clientSecret: Redacted.make("s3cr&t"),
        scope: ["directory:read", "openid"],
      };
      const params = Schema.encodeSync(FormGrant)(grant);
      expect(params.params).toEqual([
        ["grant_type", "client_credentials"],
        ["client_id", "reporting"],
        ["client_secret", "s3cr&t"],
        ["scope", "directory:read openid"],
      ]);
      const decoded = Schema.decodeUnknownSync(FormGrant)(params);
      expect(decoded.grantType).toBe("client_credentials");
      expect(Schema.encodeSync(FormGrant)(decoded).params).toEqual(
        params.params,
      );
    });

    it("[PAY-9] refuses repeated parameters and unknown grant types", () => {
      refused(
        Schema.decodeUnknownExit(FormGrant)(
          UrlParams.make([
            ["grant_type", "refresh_token"],
            ["refresh_token", "a"],
            ["refresh_token", "b"],
          ]),
        ),
      );
      refused(
        Schema.decodeUnknownExit(FormGrant)(
          UrlParams.make([["grant_type", "implicit"]]),
        ),
      );
    });

    it("[PAY-9] round-trips space-delimited scopes and refuses loose spacing or commas", () => {
      expect(Schema.decodeUnknownSync(ScopeList)("openid profile")).toEqual([
        "openid",
        "profile",
      ]);
      expect(Schema.decodeUnknownSync(ScopeList)("")).toEqual([]);
      expect(Schema.encodeSync(ScopeList)(["openid", "profile"])).toBe(
        "openid profile",
      );
      for (const text of [
        "openid  profile",
        " openid",
        "openid ",
        "openid,profile",
        "a\tb",
      ])
        refused(Schema.decodeUnknownExit(ScopeList)(text));
    });
  });

  describe("STAT-1 registration", () => {
    it("[STAT-1] encodes the domain's commonName as the provider's cn", () => {
      const codec = Schema.toCodecJson(Registration);
      const body = {
        uid: "aturing",
        commonName: "Alan Turing",
        mail: "alan@identity.test",
        password: Redacted.make("enigma-machine"),
      };
      const wire = Schema.encodeSync(codec)(body);
      expect(wire).toEqual({
        uid: "aturing",
        cn: "Alan Turing",
        mail: "alan@identity.test",
        password: "enigma-machine",
      });
      const decoded = Schema.decodeUnknownSync(codec)(wire);
      expect({
        ...decoded,
        password: Redacted.value(decoded.password),
      }).toEqual({
        ...body,
        password: "enigma-machine",
      });
    });
  });
});
