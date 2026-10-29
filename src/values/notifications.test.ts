import { describe, expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import {
  CorsAnswer,
  CsrfFailurePage,
  CsrfHeaders,
  PreflightRequest,
} from "../clients/notifications/index.js";
import {
  HttpDate,
  Retirement,
  StructuredDate,
  TokenCredential,
  tokenList,
  WarningList,
} from "./notifications.js";

/** Decode, then encode the result: a canonical spelling comes back unchanged. */
const roundTrip = <
  S extends Schema.ConstraintCodec<unknown, unknown, never, never>,
>(
  schema: S,
  encoded: S["Encoded"],
) => {
  const decoded = Schema.decodeUnknownSync(schema)(encoded);
  expect(Schema.encodeSync(schema)(decoded)).toEqual(encoded);
  expect(
    Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(decoded)),
  ).toEqual(decoded);
  return decoded;
};

/** The failure message of decoding `input`, which must fail. */
const refusal = (
  schema: Schema.Constraint & Schema.ConstraintDecoder<unknown>,
  input: unknown,
) => {
  const exit = Schema.decodeUnknownExit(schema)(input);
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit) ? String(exit.cause) : "";
};

/** The failure message of encoding `value`, which must fail. */
const encodeRefusal = (
  schema: Schema.Constraint & Schema.ConstraintEncoder<unknown>,
  value: unknown,
) => {
  const exit = Schema.encodeUnknownExit(schema)(value);
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit) ? String(exit.cause) : "";
};

/** A CSRF failure page in the framework's shape. */
const page = (reason: string) =>
  `<html><body><p>CSRF verification failed. Request aborted.</p>\n<p>Reason: ${reason}</p></body></html>`;

describe("notification value conventions", () => {
  it("[HDR-4] HttpDate round-trips IMF-fixdate and refuses the obsolete and malformed forms", () => {
    expect(roundTrip(HttpDate, "Sun, 31 Jan 2027 23:59:59 GMT")).toEqual(
      new Date("2027-01-31T23:59:59Z"),
    );
    expect(
      roundTrip(HttpDate, "Sat, 01 Jan 0000 00:00:00 GMT").getUTCFullYear(),
    ).toBe(0);
    expect(refusal(HttpDate, "Sunday, 31-Jan-27 23:59:59 GMT")).toContain(
      "RFC 850",
    );
    expect(refusal(HttpDate, "Sun Jan 31 23:59:59 2027")).toContain("asctime");
    expect(refusal(HttpDate, "Mon, 31 Jan 2027 23:59:59 GMT")).toContain(
      "is a Sun",
    );
    expect(refusal(HttpDate, "Tue, 30 Feb 2027 00:00:00 GMT")).toContain(
      "no day 30",
    );
    expect(refusal(HttpDate, "Sun, 31 jan 2027 23:59:59 GMT")).toContain(
      "IMF-fixdate",
    );
    expect(refusal(HttpDate, "Sun, 31 Jan 2027 23:59:59 +0000")).toContain(
      "IMF-fixdate",
    );
    expect(refusal(HttpDate, "Sun, 31 Jan 2027 23:59:60 GMT")).toContain(
      "leap second",
    );
    expect(refusal(HttpDate, "Sun, 31 Jan 2027 24:00:00 GMT")).toContain(
      "out of range",
    );
    expect(
      encodeRefusal(HttpDate, new Date("2027-01-31T23:59:59.500Z")),
    ).toContain("milliseconds");
    expect(
      encodeRefusal(HttpDate, new Date("+010000-01-01T00:00:00Z")),
    ).toContain("four-digit year");
  });

  it("[HDR-4] StructuredDate round-trips @seconds and refuses the draft and non-canonical forms", () => {
    expect(roundTrip(StructuredDate, "@1767225599")).toEqual(
      new Date("2025-12-31T23:59:59Z"),
    );
    expect(roundTrip(StructuredDate, "@0")).toEqual(new Date(0));
    expect(roundTrip(StructuredDate, "@-86400")).toEqual(
      new Date("1969-12-31T00:00:00Z"),
    );
    for (const draft of [
      "true",
      "Wed, 31 Dec 2025 23:59:59 GMT",
      "@01",
      "@1.5",
      "@1767225599;reason=v1",
      "1767225599",
      "@1234567890123456",
    ])
      expect(refusal(StructuredDate, draft)).toContain("Structured Field Date");
    expect(refusal(StructuredDate, "@-0")).toContain("not canonical");
    expect(encodeRefusal(StructuredDate, new Date(1500))).toContain(
      "milliseconds",
    );
  });

  it("[HDR-4] WarningList splits a joined field outside quoted strings and round-trips it", () => {
    // As a provider joins the service's two Warning lines with ", ".
    const joined =
      '299 - "Deprecated API: \\"/v1\\" retires 2026-06-30; use /v2" "Wed, 31 Dec 2025 23:59:59 GMT", 299 notify-gw.example.test:8443 "v1 traffic is metered, billed per call"';
    expect(roundTrip(WarningList, joined)).toEqual([
      {
        code: 299,
        agent: "-",
        text: 'Deprecated API: "/v1" retires 2026-06-30; use /v2',
        date: new Date("2025-12-31T23:59:59Z"),
      },
      {
        code: 299,
        agent: "notify-gw.example.test:8443",
        text: "v1 traffic is metered, billed per call",
      },
    ]);
    expect(roundTrip(WarningList, '099 [::1]:80 "low code"')).toEqual([
      { code: 99, agent: "[::1]:80", text: "low code" },
    ]);
    // Canonicalization: empty elements and spacing around commas are not kept, nor needless escapes.
    const loose = Schema.decodeUnknownSync(WarningList)(
      ',299 - "a" ,\t, 214 proxy "\\b"',
    );
    expect(Schema.encodeSync(WarningList)(loose)).toBe(
      '299 - "a", 214 proxy "b"',
    );
    expect(refusal(WarningList, "299 - unquoted")).toContain(
      "quoted warn-text",
    );
    expect(refusal(WarningList, '29 - "short code"')).toContain("three-digit");
    expect(refusal(WarningList, '299 - "a" 299 - "b"')).toContain("comma");
    expect(
      refusal(WarningList, '299 - "a" "Wednesday, 31-Dec-25 23:59:59 GMT"'),
    ).toContain("warn-date");
    expect(refusal(WarningList, '299 - "unterminated')).toContain(
      "quoted warn-text",
    );
    expect(refusal(WarningList, '299 two words "x"')).toContain(
      "quoted warn-text",
    );
    expect(refusal(WarningList, "")).toContain("empty");
    expect(encodeRefusal(WarningList, [])).toContain("at least one");
    expect(
      encodeRefusal(WarningList, [{ code: 299, agent: "a b", text: "x" }]),
    ).toContain("warn-agent");
    expect(
      encodeRefusal(WarningList, [
        { code: 299, agent: "-", text: "line\nbreak" },
      ]),
    ).toContain("quoted-string");
  });

  it("[HDR-4] Retirement reads all three headers from a header map and writes them back", () => {
    const headers = {
      deprecation: "@1767225599",
      sunset: "Sun, 31 Jan 2027 23:59:59 GMT",
      warning: '299 - "retiring"',
    };
    expect(roundTrip(Retirement, headers)).toEqual({
      deprecation: new Date("2025-12-31T23:59:59Z"),
      sunset: new Date("2027-01-31T23:59:59Z"),
      warning: [{ code: 299, agent: "-", text: "retiring" }],
    });
    expect(refusal(Retirement, { ...headers, deprecation: "true" })).toContain(
      "deprecation",
    );
    expect(
      refusal(Retirement, {
        deprecation: headers.deprecation,
        sunset: headers.sunset,
      }),
    ).toContain("warning");
  });

  it("[HDR-7a] token lists round-trip with their separator and refuse non-tokens", () => {
    expect(roundTrip(tokenList(", "), "Authorization, X-XSRF-TOKEN")).toEqual([
      "Authorization",
      "X-XSRF-TOKEN",
    ]);
    expect(roundTrip(tokenList(","), "authorization,content-type")).toEqual([
      "authorization",
      "content-type",
    ]);
    expect(roundTrip(tokenList(", "), "")).toEqual([]);
    // Canonicalization: whitespace around commas and empty elements are not kept.
    expect(Schema.decodeUnknownSync(tokenList(", "))(" GET ,,POST\t")).toEqual([
      "GET",
      "POST",
    ]);
    expect(refusal(tokenList(", "), "content type")).toContain("not a token");
    expect(refusal(tokenList(", "), '"quoted"')).toContain("not a token");
    expect(encodeRefusal(tokenList(","), ["x-ok", "x bad"])).toContain(
      "not a token",
    );
  });

  it("[HDR-7a] the preflight request and CORS answer schemas map fields to header names both ways", () => {
    expect(
      Schema.encodeSync(PreflightRequest)({
        origin: "https://app.example.test",
        method: "POST",
        headers: ["authorization", "content-type"],
      }),
    ).toEqual({
      Origin: "https://app.example.test",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    });
    roundTrip(PreflightRequest, {
      Origin: "https://a.test",
      "Access-Control-Request-Method": "GET",
    });
    expect(
      roundTrip(CorsAnswer, {
        "access-control-allow-origin": "https://app.example.test",
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "Authorization, X-XSRF-TOKEN",
      }),
    ).toEqual({
      allowOrigin: "https://app.example.test",
      allowCredentials: "true",
      allowHeaders: ["Authorization", "X-XSRF-TOKEN"],
    });
    expect(roundTrip(CorsAnswer, { allow: "GET, OPTIONS" })).toEqual({
      allow: ["GET", "OPTIONS"],
    });
    expect(
      refusal(CorsAnswer, { "access-control-allow-credentials": "yes" }),
    ).toContain("access-control-allow-credentials");
  });

  it("[AUTH-5] the CSRF header schema writes the cookie line verbatim, or leaves it to the transport", () => {
    expect(
      roundTrip(CsrfHeaders, {
        "X-XSRF-TOKEN": "a+b==",
        Cookie: "XSRF-TOKEN=a%2Bb%3D%3D",
      }),
    ).toEqual({ token: "a+b==", cookie: "a%2Bb%3D%3D" });
    expect(roundTrip(CsrfHeaders, { "X-XSRF-TOKEN": "a+b==" })).toEqual({
      token: "a+b==",
    });
    expect(
      refusal(CsrfHeaders, {
        "X-XSRF-TOKEN": "t",
        Cookie: "XSRF-TOKEN=a; other=1",
      }),
    ).toContain("XSRF-TOKEN=");
    expect(
      refusal(CsrfHeaders, { "X-XSRF-TOKEN": "t", Cookie: "session=1" }),
    ).toContain("XSRF-TOKEN=");
    expect(refusal(CsrfHeaders, { "X-XSRF-TOKEN": "" })).toContain(
      "X-XSRF-TOKEN",
    );
    expect(encodeRefusal(CsrfHeaders, { token: "t", cookie: "a b" })).toContain(
      "cookie-octets",
    );
  });

  it("[AUTH-5] the CSRF failure page decodes to its reason and refuses the reverse, with the reason", () => {
    const decode = Schema.decodeUnknownSync(CsrfFailurePage);
    expect(decode(page("CSRF cookie not set."))).toBe("cookie-missing");
    expect(decode(page("CSRF token missing."))).toBe("token-missing");
    expect(decode(page("CSRF token incorrect."))).toBe("token-incorrect");
    expect(decode(page("CSRF token not recognised."))).toBe(
      "token-unrecognised",
    );
    expect(
      refusal(CsrfFailurePage, page("Referer checking failed.")),
    ).toContain("not a recognised CSRF failure page");
    expect(refusal(CsrfFailurePage, "<h1>Forbidden</h1>")).toContain(
      "not a recognised",
    );
    expect(encodeRefusal(CsrfFailurePage, "cookie-missing")).toContain(
      "one-way",
    );
  });

  it("[AUTH-6] the Token credential round-trips its Rails form and refuses other spellings", () => {
    expect(
      roundTrip(TokenCredential, 'Token token="ntf_opaque-7Hq2x.Z~"'),
    ).toBe("ntf_opaque-7Hq2x.Z~");
    for (const looser of [
      "Token ntf_opaque",
      "Bearer ntf_opaque",
      'token token="ntf_opaque"',
      "Token token=ntf_opaque",
      'Token token="ntf_opaque", nonce="1"',
      'Token token=""',
      'Token  token="ntf_opaque"',
    ])
      expect(refusal(TokenCredential, looser)).toContain(
        'Token token="<opaque>"',
      );
    for (const unsafe of [
      'with"quote',
      "back\\slash",
      "with space",
      "",
      "undefined\n",
    ])
      expect(encodeRefusal(TokenCredential, unsafe)).toContain("visible ASCII");
  });
});
