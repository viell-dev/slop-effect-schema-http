/**
 * The flows' own operations against the other areas' services, where the flows need something the
 * area contract does not offer as is: the gateway download with the session late-bound and the
 * file facts read from its headers, the directory lookup with the token from the one source, and
 * the business's operational endpoint with the credential explicitly left off.
 */
import {
  Data,
  Effect,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as Ops from "../business/operations.js";
import { Extract } from "../gateway/index.js";
import { ErrorFromBytes, Period } from "../gateway/pipe.js";
import { AccessToken, Assignee, lookupUser } from "../identity/index.js";
import * as Credentials from "./credentials.js";
import { DownloadName, GatewayFile } from "./translate.js";

// ---------------------------------------------------------------------------------------------
// Gateway: the month-end download
// ---------------------------------------------------------------------------------------------

/** `attachment; filename="ME202610.DAT"`, as the gateway's extract script writes it. */
export const Disposition = Schema.String.pipe(
  Schema.decodeTo(
    DownloadName,
    SchemaTransformation.transformEffect({
      decode: (value: string) => {
        const match = /^attachment; filename="([^"\\]+)"$/.exec(value);
        return match === null
          ? Effect.fail(
              new SchemaIssue.InvalidValue(
                {
                  message:
                    'expected `attachment; filename="<name>"` with a quoted name',
                },
                value,
              ),
            )
          : Effect.succeed(match[1]!);
      },
      encode: (name: string) =>
        Effect.succeed(`attachment; filename="${name}"`),
    }),
  ),
);

/** The download's facts, from its response headers through an ordinary schema. */
export const DownloadHeaders = Schema.Struct({
  "content-disposition": Disposition,
  "last-modified": Schema.DateTimeUtcFromHttpDate,
  "content-length": Schema.NumberFromString.check(Schema.isInt()),
});

/** The decoded extract, the file it came from, and its exact bytes. */
export interface Download {
  readonly extract: Extract.MonthEnd;
  readonly file: GatewayFile;
  readonly bytes: Uint8Array;
}

const decodeHeaders = Schema.decodeUnknownEffect(DownloadHeaders);
const decodeFile = Schema.decodeUnknownEffect(GatewayFile);
const decodeExtract = Schema.decodeEffect(Extract.MonthEndExtract);

/** The bytes through the gateway's own fixed-width schema, and the file facts from the headers. */
export const download = Body.decoder(
  (response) =>
    Effect.gen(function* () {
      const headers = yield* decodeHeaders(response.headers);
      const bytes = new Uint8Array(yield* response.arrayBuffer);
      const extract = yield* decodeExtract(bytes);
      const file = yield* decodeFile({
        name: headers["content-disposition"],
        modified: headers["last-modified"],
        size: headers["content-length"],
      });
      return { extract, file, bytes } satisfies Download;
    }),
  "application/octet-stream",
);

/**
 * `GET cgi-bin/extract.cgi?period=…&session=…`. The period is the input; the session is the one
 * token, appended at send time by the gateway placement, and left off when there is none.
 */
export const extract = (origin: string, from: Credentials.Source) =>
  Operation.make(
    Request.get("cgi-bin/extract.cgi").pipe(
      Request.query(Schema.Struct({ period: Period })),
      Request.mapInput((input: { readonly period: string }) => ({
        query: input,
      })),
      Credentials.gatewaySession(from),
      Request.baseUrl(origin),
    ),
    Response.status(200, Response.tag("Extract", download)).pipe(
      Response.orElse(
        Response.when(
          (metadata) => [400, 403, 404].includes(metadata.status),
          Response.tag("Refused", Body.bytes.pipe(Body.schema(ErrorFromBytes))),
        ),
      ),
    ),
  );

// ---------------------------------------------------------------------------------------------
// Identity: the directory lookup
// ---------------------------------------------------------------------------------------------

/** The source held no token when the directory was asked. */
export class SignedOut extends Data.TaggedError("SignedOut") {}

const decodeToken = Schema.decodeEffect(AccessToken);

/**
 * A directory lookup with the bearer token from the one source, read when the lookup is evaluated.
 * The identity contract owns its header group with a schema, so the token enters as input; an
 * absent token never reaches the wire and fails as {@link SignedOut} instead.
 */
export const directory = (origin: string, from: Credentials.Source) => {
  const lookup = lookupUser(origin);
  return Operation.fromEffect((uid: string) =>
    Effect.gen(function* () {
      const token = from.read();
      if (token === undefined) return yield* new SignedOut();
      const accessToken = yield* decodeToken(token);
      return yield* lookup.execute({
        path: uid,
        headers: { tokenType: "Bearer", accessToken },
      });
    }),
  );
};

/** The directory's answer did not make the user assignable. */
export class NotAssignable extends Data.TaggedError("NotAssignable")<{
  readonly uid: string;
  readonly reason: string;
}> {}

const decodeAssignee = Schema.decodeUnknownEffect(Assignee);

/**
 * Resolve a uid to an assignable user through the directory. An inactive entry, including the blank
 * entry the directory answers for an unknown uid, is refused by the identity contract's `Assignee`.
 */
export const assignee = (origin: string, from: Credentials.Source) => {
  const lookup = directory(origin, from);
  return Operation.fromEffect((uid: string) =>
    Effect.gen(function* () {
      const entry = yield* lookup.execute(uid);
      if (entry._tag !== "Entry") return yield* Effect.fail(entry);
      return yield* decodeAssignee(entry).pipe(
        Effect.mapError(
          (error) =>
            new NotAssignable({
              uid,
              reason: entry.active
                ? error.message
                : entry.uid === null
                  ? "the directory has no such user"
                  : "the directory entry is inactive",
            }),
        ),
      );
    }),
  );
};

// ---------------------------------------------------------------------------------------------
// Business: the operational endpoint, explicitly anonymous
// ---------------------------------------------------------------------------------------------

/**
 * `GET /v2/ops/abandoned`: SRE's record of held requests whose client went away. It needs no
 * credential, so the shared business transform's `Authorization` is removed explicitly; a user's
 * token has no business on an operational endpoint whose access log the load balancer team reads.
 */
export const abandoned = (connection: Ops.Connection) =>
  Operation.make(
    Request.get("ops/abandoned").pipe(
      Ops.at(connection),
      Credentials.anonymous,
      Request.query(Schema.Struct({ atLeast: Schema.Int })),
      Request.mapInput((atLeast: number) => ({ query: { atLeast } })),
    ),
    Response.status(200, Body.jsonSchema(Ops.Abandoned)),
  );
