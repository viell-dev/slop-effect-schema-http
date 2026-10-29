/**
 * HTTP Digest in its 1997 form (RFC 2069), as the gateway's `/admin` speaks it (AUTH-7, RET-4).
 *
 * The 401 challenge is a declared response, selected by status and `WWW-Authenticate` and decoded
 * from the header map, so it arrives in the success union instead of failing the operation. A
 * caller-driven loop reads the nonce and executes the same cold request again with one added
 * header. Each nonce authorizes one request, so every call costs two round trips; a reused nonce is
 * answered with `stale=true`, which the loop answers once more, and a challenge without `stale`
 * after an attempt means the credentials are wrong.
 */
import {
  Data,
  Effect,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import {
  Body,
  type Operation,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Md5 from "../../formats/md5.js";
import { CentsFromImpliedInteger } from "../../values/gateway.js";
import { Period, pipeBody } from "./pipe.js";

export interface Challenge {
  readonly realm: string;
  readonly nonce: string;
  readonly opaque: string | undefined;
  readonly stale: boolean;
}

/** Parse `Digest k=v, k="v"` parameters with quoted-string escapes, or explain the refusal. */
const parameters = (value: string): Map<string, string> | string => {
  const scheme = /^Digest\s+/i.exec(value);
  if (scheme === null) return "not a Digest challenge";
  const result = new Map<string, string>();
  const pattern =
    /\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))\s*(,|$)/y;
  pattern.lastIndex = scheme[0].length;
  while (pattern.lastIndex < value.length) {
    const part = pattern.exec(value);
    if (part === null)
      return `malformed parameter at offset ${pattern.lastIndex}`;
    const name = part[1]!.toLowerCase();
    if (result.has(name)) return `repeated parameter ${name}`;
    result.set(name, part[2]?.replace(/\\(.)/g, "$1") ?? part[3]!);
  }
  return result;
};

/** A quoted string: backslash and double quote escaped, as the parameter parser reads them. */
const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** A `WWW-Authenticate` value in the RFC 2069 form: MD5 only, and no `qop` this client cannot answer. */
export const ChallengeFromHeader = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({
      realm: Schema.String,
      nonce: Schema.String,
      opaque: Schema.UndefinedOr(Schema.String),
      stale: Schema.Boolean,
    }),
    SchemaTransformation.transformEffect<Challenge, string>({
      decode: (value, options) => {
        const fields = parameters(value);
        const refuse = (message: string) =>
          Effect.fail(
            new SchemaIssue.InvalidValue({ message }, value, options),
          );
        if (typeof fields === "string") return refuse(fields);
        const realm = fields.get("realm");
        const nonce = fields.get("nonce");
        if (realm === undefined || nonce === undefined)
          return refuse("a challenge needs realm and nonce");
        const algorithm = fields.get("algorithm");
        if (algorithm !== undefined && algorithm.toUpperCase() !== "MD5")
          return refuse(`unsupported algorithm ${algorithm}`);
        if (fields.has("qop"))
          return refuse(
            "an RFC 2617 qop challenge, which this RFC 2069 client cannot answer",
          );
        const stale = fields.get("stale")?.toLowerCase();
        if (stale !== undefined && stale !== "true" && stale !== "false")
          return refuse(`stale must be true or false, got ${stale}`);
        return Effect.succeed({
          realm,
          nonce,
          opaque: fields.get("opaque"),
          stale: stale === "true",
        });
      },
      encode: (challenge) =>
        Effect.succeed(
          `Digest realm=${quote(challenge.realm)}, nonce=${quote(challenge.nonce)}` +
            (challenge.opaque === undefined
              ? ""
              : `, opaque=${quote(challenge.opaque)}`) +
            ", algorithm=MD5" +
            (challenge.stale ? ", stale=true" : ""),
        ),
    }),
  ),
);

/** A 401 that carries a Digest challenge; any other 401 stays unmatched. */
export const isDigestChallenge = (metadata: Response.Metadata): boolean =>
  metadata.status === 401 &&
  /^Digest\s/i.test(metadata.headers["www-authenticate"] ?? "");

/** The challenge, from the header map; the HTML body of the 401 is drained. */
export const challengeDecoder = Body.decoder((response) =>
  Effect.andThen(
    Body.empty.decode(response),
    Schema.decodeUnknownEffect(
      Schema.Struct({ "www-authenticate": ChallengeFromHeader }),
    )(response.headers).pipe(
      Effect.map((headers) => headers["www-authenticate"]),
    ),
  ),
);

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/** The RFC 2069 `Authorization` value: `MD5(MD5(user:realm:password):nonce:MD5(method:uri))`. */
export const authorization = (
  credentials: Credentials,
  challenge: Challenge,
  method: string,
  uri: string,
): string => {
  const secret = Md5.hex(
    `${credentials.username}:${challenge.realm}:${credentials.password}`,
  );
  const response = Md5.hex(
    `${secret}:${challenge.nonce}:${Md5.hex(`${method}:${uri}`)}`,
  );
  return (
    `Digest username=${quote(credentials.username)}, realm=${quote(challenge.realm)}, ` +
    `nonce=${quote(challenge.nonce)}, uri=${quote(uri)}, response="${response}"` +
    (challenge.opaque === undefined
      ? ""
      : `, opaque=${quote(challenge.opaque)}`) +
    ", algorithm=MD5"
  );
};

/** The server kept challenging: wrong credentials, or a nonce spent again and again. */
export class DigestRejected extends Data.TaggedError("DigestRejected")<{
  readonly challenge: Challenge;
  readonly requests: number;
}> {}

type Challenged = Response.Tagged<"Challenge", Challenge>;

/** An input whose header group may carry one `Authorization` line. */
export interface Authorizable {
  readonly headers: { readonly authorization?: string };
}

/**
 * Run `operation` as Digest requires: without credentials first, then, for each challenge, the
 * same cold request again with an `Authorization` computed over the method and target that the
 * compiled request will send. A stale challenge is answered once more; any other repeated challenge
 * fails with {@link DigestRejected}. At most three requests.
 */
export const withDigest =
  <I extends Authorizable, A, E, R, E2, R2>(
    request: Request.Request<I, E2, R2, boolean, boolean>,
    operation: Operation.Operation<I, A | Challenged, E, R>,
    credentials: Credentials,
  ) =>
  (
    input: I,
  ): Effect.Effect<
    Exclude<A, Challenged>,
    E | E2 | Request.InvalidRequest | DigestRejected,
    R | R2
  > =>
    Effect.gen(function* () {
      let outcome = yield* operation.execute(input);
      let requests = 1;
      while (isChallenged(outcome)) {
        if (requests > 1 && (!outcome.value.stale || requests > 2))
          return yield* new DigestRejected({
            challenge: outcome.value,
            requests,
          });
        const compiled = yield* Request.compile(request, input);
        const url = new URL(compiled.request.url);
        const header = authorization(
          credentials,
          outcome.value,
          compiled.request.method,
          `${url.pathname}${url.search}`,
        );
        outcome = yield* operation.execute({
          ...input,
          headers: { ...input.headers, authorization: header },
        });
        requests++;
      }
      return outcome as Exclude<A, Challenged>;
    });

const isChallenged = (value: unknown): value is Challenged =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "Challenge";

// The audit report behind Digest.

const AuditFields = Schema.Tuple([
  Schema.Literal("OK"),
  Period,
  Schema.NumberFromString.check(Schema.isInt()),
  CentsFromImpliedInteger,
]);

export const AuditLine = AuditFields.pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Audit", {
      period: Schema.String,
      records: Schema.Number,
      controlTotal: Schema.toType(CentsFromImpliedInteger),
    }),
    SchemaTransformation.transform<
      {
        readonly _tag: "Audit";
        readonly period: string;
        readonly records: number;
        readonly controlTotal: (typeof CentsFromImpliedInteger)["Type"];
      },
      (typeof AuditFields)["Type"]
    >({
      decode: ([, period, records, controlTotal]) => ({
        _tag: "Audit",
        period,
        records,
        controlTotal,
      }),
      encode: ({ period, records, controlTotal }) => [
        "OK",
        period,
        records,
        controlTotal,
      ],
    }),
  ),
);

export const AuditHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
});

export interface AuditInput {
  readonly query: { readonly period: string };
  readonly headers: { readonly authorization?: string };
}

export const auditRequest = (origin: string) =>
  Request.get("admin/audit.cgi").pipe(
    Request.query(Schema.Struct({ period: Period })),
    Request.headers(AuditHeaders),
    Request.baseUrl(origin),
  );

/** The report, or the challenge that stands in front of it. */
export const auditResponse = Response.status(
  200,
  Response.tag("Report", pipeBody(AuditLine)),
).pipe(
  Response.orElse(
    Response.when(
      isDigestChallenge,
      Response.tag("Challenge", challengeDecoder),
    ),
  ),
);
