/**
 * AUTH-1: one opaque token, three services, three placements. The identity provider issues one
 * token that the business API takes as `Authorization: Bearer <token>`, the notification service
 * as `Authorization: Token token="<token>"`, and the reporting gateway as the `session` query
 * parameter.
 *
 * The token lives in one {@link Source}. Each service reads it through its own placement when an
 * operation is evaluated, never when an operation is built, so a refreshed or revoked token reaches
 * the next evaluation without rebuilding anything, and an interaction that captured the source at
 * acquisition keeps working after the token changes. Within one evaluation the token is read once,
 * so every retry carries the same credential.
 *
 * An absent token omits the credential: no header line and no query parameter, never the string
 * `"undefined"`. Endpoints that must not carry the token opt out explicitly with {@link anonymous}.
 */
import { Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { Request } from "viell-effect-schema-http";
import type { Connection } from "../business/operations.js";

/** The application's one credential source: the current opaque token, or none when signed out. */
export interface Source {
  /** The token at this moment. Placements call it at send time, once per evaluation. */
  readonly read: () => string | undefined;
  /** Replace the token, or sign out with `undefined`. Later evaluations see the new value. */
  readonly set: (token: string | undefined) => Effect.Effect<void>;
}

/** A source held in memory, as a single-page app keeps its session. */
export const source = (initial?: string): Effect.Effect<Source> =>
  Effect.sync(() => {
    let current = initial;
    return {
      read: () => current,
      set: (token) =>
        Effect.sync(() => {
          current = token;
        }),
    };
  });

/**
 * The business API (`/v2`): a bearer header. The business contracts already take a late-bound
 * `credential` function and declare it as a computed header field, which the library evaluates once
 * per materialization and omits when it returns `undefined`.
 */
export const business = (from: Source, baseUrl: string): Connection => ({
  baseUrl,
  credential: from.read,
});

/**
 * The notification service: the `Token` scheme. The notification contracts take the token as an
 * effect evaluated once per operation evaluation; `None` omits the header.
 */
export const notifications = (
  from: Source,
): Effect.Effect<Option.Option<string>> =>
  Effect.sync(() => Option.fromUndefinedOr(from.read()));

/**
 * The reporting gateway: the token as the `session` query parameter, appended to the native request
 * once per evaluation, after the request's own query. With no token, no parameter is added.
 */
export const gatewaySession = (from: Source) =>
  Request.mapEffect((request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      const token = from.read();
      return token === undefined
        ? request
        : HttpClientRequest.appendUrlParam(request, "session", token);
    }),
  );

/**
 * The explicit opt-out for endpoints that must not carry the token, such as an operational endpoint
 * that needs no credential. It removes the `Authorization` field that a shared service transform
 * declared, without evaluating it, so the source is not even read. Apply it after that transform
 * and before any header schema takes over the group.
 */
export const anonymous = Request.removeHeader("authorization");
