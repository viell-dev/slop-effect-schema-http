import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ChallengeFromHeader } from "./digest.js";

const decode = Schema.decodeUnknownSync(ChallengeFromHeader);
const encode = Schema.encodeSync(ChallengeFromHeader);

describe("Digest challenge", () => {
  it("[AUTH-7] ChallengeFromHeader round-trips quotes and backslashes in realm, nonce and opaque", () => {
    // On the wire: realm="Ops \"Q4\" C:\\reports", nonce="n\\\"x", opaque="\"o\\".
    const header =
      'Digest realm="Ops \\"Q4\\" C:\\\\reports", nonce="n\\\\\\"x", opaque="\\"o\\\\", algorithm=MD5, stale=true';
    const challenge = {
      realm: 'Ops "Q4" C:\\reports',
      nonce: 'n\\"x',
      opaque: '"o\\',
      stale: true,
    };
    expect(decode(header)).toEqual(challenge);
    expect(encode(challenge)).toBe(header);
    expect(decode(encode(challenge))).toEqual(challenge);

    const plain = { realm: "\\", nonce: '"', opaque: undefined, stale: false };
    expect(encode(plain)).toBe(
      'Digest realm="\\\\", nonce="\\"", algorithm=MD5',
    );
    expect(decode(encode(plain))).toEqual(plain);
  });

  it("[AUTH-7] ChallengeFromHeader reads other parameter orders and spellings, and writes one form", () => {
    // Order, letter case, a token nonce and an absent algorithm are not kept.
    const challenge = decode(
      'digest NONCE=abc, Algorithm=md5, Realm="Reporting Gateway", stale=FALSE',
    );
    expect(challenge).toEqual({
      realm: "Reporting Gateway",
      nonce: "abc",
      opaque: undefined,
      stale: false,
    });
    expect(encode(challenge)).toBe(
      'Digest realm="Reporting Gateway", nonce="abc", algorithm=MD5',
    );
  });

  it("[AUTH-7] ChallengeFromHeader refuses malformed and unanswerable challenges", () => {
    for (const [header, reason] of [
      ['Basic realm="r"', /not a Digest challenge/],
      // An escaped quote cannot close the string; a bare one cannot sit inside it.
      ['Digest realm="r\\", nonce="n"', /malformed parameter/],
      ['Digest realm="a"b", nonce="n"', /malformed parameter/],
      ['Digest nonce="n"', /needs realm and nonce/],
      ['Digest realm="r", realm="s", nonce="n"', /repeated parameter realm/],
      ['Digest realm="r", nonce="n", qop="auth"', /qop challenge/],
      ['Digest realm="r", nonce="n", algorithm=SHA-256', /unsupported/],
      ['Digest realm="r", nonce="n", stale=maybe', /stale must be/],
    ] as const)
      expect(() => decode(header)).toThrow(reason);
  });

  it("[AUTH-7] ChallengeFromHeader reads RFC 7230 tokens unquoted and refuses any other unquoted value or separator", () => {
    // Every token character reads unquoted, and the value is written back quoted.
    const tchars = "!#$%&'*+-.^_`|~09AZaz";
    const token = decode(`Digest realm="r", nonce=${tchars}`);
    expect(token.nonce).toBe(tchars);
    expect(encode(token)).toBe(
      `Digest realm="r", nonce="${tchars}", algorithm=MD5`,
    );
    expect(decode(encode(token))).toEqual(token);
    for (const value of [
      "n\\x",
      "n/x",
      "n@x",
      "n=x",
      "n;x",
      "n:x",
      "n?x",
      "n(x)",
      "n[x]",
      "n{x}",
      "n x",
      "ñ",
    ])
      expect(() => decode(`Digest realm="r", nonce=${value}`)).toThrow(
        /malformed parameter/,
      );
    // Every parameter is held to the token syntax, not only the nonce.
    for (const header of [
      'Digest realm=r\\x, nonce="n"',
      'Digest realm="r", nonce="n", opaque=o/p',
      'Digest realm="r", nonce="n", algorithm=MD5@x',
      'Digest realm="r", nonce="n", stale=true\\',
    ])
      expect(() => decode(header)).toThrow(/malformed parameter/);
    // Only spaces and tabs separate: a no-break space is neither.
    expect(() => decode('Digest realm="r", nonce="n"')).toThrow(
      /malformed parameter/,
    );
    expect(() => decode('Digest realm="r", nonce="n"')).toThrow(
      /not a Digest challenge/,
    );
    expect(decode('Digest  realm="r"\t,\tnonce = n')).toEqual({
      realm: "r",
      nonce: "n",
      opaque: undefined,
      stale: false,
    });
  });
});
