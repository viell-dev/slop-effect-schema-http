/**
 * EXT-6b: the gateway's audit endpoint against httpd 2.4.68's mod_auth_digest with
 * `AuthDigestQop none`, recorded with curl computing the Authorization (`recordings/httpd-digest`).
 * Node-only: the recordings are read from disk and compared with the raw status and header lines
 * the gateway sends, and the RFC 2069 response is computed with `node:crypto`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json } from "../harness/lane.js";
import {
  data,
  date,
  differences,
  header,
  maskHeader,
  masked,
  recorded,
  replaceHeader,
  requestHeader,
  send,
} from "./recordings.js";

const REALM = "Reporting Gateway";
const URI = "/admin/audit.cgi?period=202610";

/** The audit CGI prints the totals of the gateway data's one extract. */
const options = {
  realm: REALM,
  auditors: { auditor: "Secr3t!" },
  extracts: (data("frontier-rpc2", "data.json") as { extracts: Json }).extracts,
} satisfies Json;

/** A challenge's nonce, of the shape mod_auth_digest writes, changes with every challenge. */
const nonce = maskHeader(
  "nonce",
  "WWW-Authenticate",
  /nonce="([^"]*)"/,
  /^[A-Za-z0-9+/]{11}=[0-9a-f]{40}$/,
);

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

/** RFC 2069's response: MD5(MD5(user:realm:password):nonce:MD5(method:uri)). */
const rfc2069 = (password: string, challenge: string) =>
  md5(
    `${md5(`auditor:${REALM}:${password}`)}:${challenge}:${md5(`GET:${URI}`)}`,
  );

const nonceOf = (value: string | undefined) =>
  /nonce="([^"]*)"/.exec(value ?? "")![1]!;

/** The header lines a gateway 401 differs in from httpd's. */
const PAGE = [
  // Kept: Node's server keeps curl's connection open and says so; httpd answers an HTTP/1.1
  // request without either line (recordings/README.md, "Comparing").
  "header connection",
  "header content-length",
  "header keep-alive",
  // Kept: the gateway is Apache 1.3, whose page and signature it writes (services/gateway.md,
  // "Recordings").
  "header server",
  "body",
];

/**
 * curl's authorized request, sent to a fresh gateway after its own challenge. Adapted: the nonce
 * is the gateway's, and the response is computed from it as curl computed its own.
 */
const authorized = (name: string, password: string) =>
  Effect.gen(function* () {
    const gateway = yield* lane.backend("gateway", options);
    const challenge = yield* send(
      gateway.origin,
      recorded("httpd-digest", "challenge").request,
    );
    const issued = nonceOf(header(challenge, "www-authenticate")[0]);
    const request = recorded("httpd-digest", name).request;
    const authorization = requestHeader(request, "authorization")!
      .replace(/nonce="[^"]*"/, `nonce="${issued}"`)
      .replace(/response="[^"]*"/, `response="${rfc2069(password, issued)}"`);
    return {
      origin: gateway.origin,
      request: replaceHeader(request, "Authorization", authorization),
    };
  });

describe("[EXT-6b] the gateway's audit Digest against httpd 2.4.68's mod_auth_digest", () => {
  it("[EXT-6b] curl's recorded responses are RFC 2069's, computed from the nonce it was given", () => {
    for (const [challenge, answer, password] of [
      ["challenge", "accepted", "Secr3t!"],
      ["wrong-challenge", "wrong-password", "wrong"],
    ] as const) {
      const given = nonceOf(
        header(
          recorded("httpd-digest", challenge).response,
          "www-authenticate",
        )[0],
      );
      const sent = requestHeader(
        recorded("httpd-digest", answer).request,
        "authorization",
      );
      expect(sent).toBe(
        `Digest username="auditor", realm="${REALM}", nonce="${given}", uri="${URI}", response="${rfc2069(password, given)}", algorithm=MD5`,
      );
    }
  });

  for (const name of ["challenge", "wrong-challenge"])
    it.live(
      `[EXT-6b] ${name}: the same challenge, without opaque, qop or domain`,
      () =>
        Effect.gen(function* () {
          const exchange = recorded("httpd-digest", name);
          const gateway = yield* lane.backend("gateway", options);
          const actual = yield* send(gateway.origin, exchange.request);
          const [expected, got] = masked(
            [exchange.response, actual],
            [date, nonce],
          );
          expect(differences(expected, got)).toEqual(PAGE);
          expect(header(got, "www-authenticate")).toEqual([
            `Digest realm="${REALM}", nonce="<nonce>", algorithm=MD5`,
          ]);
          expect(header(expected, "server")).toEqual(["Apache/2.4.68 (Unix)"]);
          expect(header(got, "server")).toEqual(["Apache/1.3.41 (Unix)"]);
        }),
    );

  it.live(
    "[EXT-6b] accepted: curl's computation authorizes the request, answered without httpd's Authentication-Info",
    () =>
      Effect.gen(function* () {
        const { origin, request } = yield* authorized("accepted", "Secr3t!");
        const actual = yield* send(origin, request);
        const [expected, got] = masked(
          [recorded("httpd-digest", "accepted").response, actual],
          [date],
        );
        expect(differences(expected, got)).toEqual([
          // Kept: httpd 2.4 offers the next nonce, with a stray leading comma when there is no
          // qop; Apache 1.3's mod_digest sends none (services/gateway.md, "The audit endpoint").
          "header authentication-info",
          "header connection",
          "header keep-alive",
          "header server",
        ]);
        expect(header(expected, "authentication-info")[0]).toMatch(
          /^, nextnonce="[A-Za-z0-9+/]{11}=[0-9a-f]{40}"$/,
        );
        expect(got.body.toString("latin1")).toBe("OK|202610|3|173457\n");
      }),
  );

  it.live(
    "[EXT-6b] replayed: httpd accepts the same Authorization again within the nonce's lifetime; the gateway's spent nonce answers as httpd's stale one",
    () =>
      Effect.gen(function* () {
        const { origin, request } = yield* authorized("accepted", "Secr3t!");
        expect((yield* send(origin, request)).status).toBe(200);
        const actual = yield* send(origin, request);
        // Kept: the gateway's nonces are single-use (services/gateway.md, "The audit endpoint").
        expect(recorded("httpd-digest", "replayed").response.status).toBe(200);
        const [expected, got] = masked(
          [recorded("httpd-digest", "stale").response, actual],
          [date, nonce],
        );
        expect(differences(expected, got)).toEqual(PAGE);
        expect(header(got, "www-authenticate")).toEqual([
          `Digest realm="${REALM}", nonce="<nonce>", algorithm=MD5, stale=true`,
        ]);
      }),
  );

  it.live(
    "[EXT-6b] wrong-password: a fresh challenge without stale, as httpd answers",
    () =>
      Effect.gen(function* () {
        const { origin, request } = yield* authorized(
          "wrong-password",
          "wrong",
        );
        const actual = yield* send(origin, request);
        const [expected, got] = masked(
          [recorded("httpd-digest", "wrong-password").response, actual],
          [date, nonce],
        );
        expect(differences(expected, got)).toEqual(PAGE);
      }),
  );
});
