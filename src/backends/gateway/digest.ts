/**
 * The audit endpoint's RFC 2069 Digest check. Each instance keeps its issued nonces and marks one
 * spent when a request presents it, before the response is checked.
 *
 * Service documentation: services/gateway.md
 */
import { createHash, randomBytes } from "node:crypto";
import { header, type Received, type Reply } from "../../harness/server.js";
import { apachePage } from "./cgi.js";

const md5 = (text: string): string =>
  createHash("md5").update(text, "utf8").digest("hex");

/** Parse `Digest k=v, k="v"` parameters with RFC 2069's quoted strings. */
const parseAuthorization = (
  value: string,
): ReadonlyMap<string, string> | undefined => {
  const match = /^Digest\s+/i.exec(value);
  if (match === null) return undefined;
  const result = new Map<string, string>();
  const pattern =
    /\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]*))\s*(?:,|$)/y;
  pattern.lastIndex = match[0].length;
  while (pattern.lastIndex < value.length) {
    const part = pattern.exec(value);
    if (part === null) return undefined;
    result.set(
      part[1]!.toLowerCase(),
      part[2]?.replace(/\\(.)/g, "$1") ?? part[3]!,
    );
  }
  return result;
};

export interface DigestOptions {
  readonly realm: string;
  /** User name to password. */
  readonly users: Readonly<Record<string, string>>;
}

export type Verdict =
  | { readonly _tag: "Authorized"; readonly user: string }
  | { readonly _tag: "Refused"; readonly reply: Reply };

/** mod_digest's refusal of a malformed or mismatched Authorization. */
const badRequest = (reason: string): Verdict => ({
  _tag: "Refused",
  reply: apachePage(
    400,
    "Bad Request",
    `Your browser sent a request that this server could not understand.<P>\n${reason}`,
  ),
});

/** Per-instance Digest state: the nonces issued and whether each has been used. */
export const digest = (options: DigestOptions) => {
  const nonces = new Map<string, "fresh" | "spent">();
  const opaque = randomBytes(16).toString("hex");

  const challenge = (stale: boolean): Verdict => {
    const nonce = randomBytes(18).toString("base64");
    nonces.set(nonce, "fresh");
    // The realm is interpolated unescaped, as the service page documents; the fixtures use plain
    // realms, so a malformed challenge is never exercised.
    return {
      _tag: "Refused",
      reply: apachePage(
        401,
        "Authorization Required",
        "This server could not verify that you\nare authorized to access the document\nrequested.",
        [
          [
            "WWW-Authenticate",
            `Digest realm="${options.realm}", nonce="${nonce}", opaque="${opaque}", algorithm=MD5` +
              (stale ? ", stale=true" : ""),
          ],
        ],
      ),
    };
  };

  return (request: Received): Verdict => {
    const authorization = header(request.lines, "authorization");
    if (authorization === undefined) return challenge(false);
    const fields = parseAuthorization(authorization);
    if (fields === undefined) return challenge(false);
    const [user, realm, nonce, uri, response] = [
      "username",
      "realm",
      "nonce",
      "uri",
      "response",
    ].map((name) => fields.get(name));
    if (
      user === undefined ||
      realm === undefined ||
      nonce === undefined ||
      uri === undefined ||
      response === undefined
    )
      return badRequest("Digest: missing directive");
    if (uri !== request.target) return badRequest("Digest: uri mismatch");
    if (realm !== options.realm || fields.get("opaque") !== opaque)
      return challenge(false);
    const state = nonces.get(nonce);
    if (state === undefined) return challenge(false);
    nonces.set(nonce, "spent");
    const password = options.users[user];
    const correct =
      password !== undefined &&
      response.toLowerCase() ===
        md5(
          `${md5(`${user}:${options.realm}:${password}`)}:${nonce}:${md5(`${request.method}:${uri}`)}`,
        );
    if (!correct) return challenge(false);
    if (state === "spent") return challenge(true);
    return { _tag: "Authorized", user };
  };
};
