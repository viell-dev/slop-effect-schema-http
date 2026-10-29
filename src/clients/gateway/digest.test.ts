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
});
