/**
 * The consumer's contracts for the identity provider: requests, response contracts, and the
 * operations that pair them. Each response contract declares one rule per status family that
 * the endpoint really answers with, so the four error shapes of ERR-5 are decoded per operation
 * rather than guessed from the body.
 */
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import { Effect, Option, Schema } from "effect";
import {
  Body,
  Operation,
  Request,
  Response,
  Transport,
} from "viell-effect-schema-http";
import type { Issuer } from "../../values/identity.js";
import {
  CodedError,
  Credentials,
  DirectoryEntry,
  Discovery,
  FormGrant,
  FormTokenSet,
  GrantedScopes,
  JsonGrant,
  JsonTokenSet,
  Login,
  MessageError,
  OAuthError,
  Registration,
  RequestedScopes,
  ServerFault,
  Uid,
} from "./schemas.js";

const statuses =
  (...codes: ReadonlyArray<number>) =>
  (metadata: Response.Metadata) =>
    codes.includes(metadata.status);

/** Any 5xx: the 2016 API's bare string, which the gateway and servlet share since 2016. */
const serverFault = Response.when(
  (metadata) => metadata.status >= 500 && metadata.status <= 599,
  Body.jsonSchema(ServerFault),
);

/** The 2019 rate limiter's bare message. */
const rateLimited = Response.status(429, Body.jsonSchema(MessageError));

/** The 2012 filter's bare message. */
const unauthorized = Response.status(401, Body.jsonSchema(MessageError));

const formGrantBody = Body.urlEncoded.pipe(Body.encodeSchema(FormGrant));

/**
 * HDR-1. The JSON grant's 200: tokens from the body, granted scopes from the response lines when
 * the provider supplied them, and the SSO session cookie, read from the parsed `Set-Cookie`
 * lines rather than the joined header.
 */
const grantedBody = Body.decoder(
  (response) =>
    Effect.gen(function* () {
      const tokens = yield* Body.jsonSchema(JsonTokenSet).decode(response);
      const metadata = Response.metadata(response);
      const granted = yield* Schema.decodeUnknownEffect(GrantedScopes)(
        Option.match(metadata.headerLines, {
          onNone: () => ({
            _tag: "Joined",
            value: metadata.headers["x-oauth-scope"] ?? "",
          }),
          onSome: (lines: Transport.Lines) => ({
            _tag: "Lines",
            scopes: lines
              .filter(([name]) => name.toLowerCase() === "x-oauth-scope")
              .map(([, value]) => value),
          }),
        }),
      );
      return {
        tokens,
        granted,
        session: Cookies.getValue(metadata.cookies, "IDPSESSION"),
      };
    }),
  "application/json",
);

/** The request descriptions, for operations and for the raw controls below. */
export const requests = {
  formGrant: (origin: string) =>
    Request.post("oauth/token").pipe(
      Request.body(formGrantBody),
      Request.baseUrl(origin),
    ),
  jsonGrant: (origin: string) =>
    Request.post("api/v2/token").pipe(
      Request.headers(RequestedScopes),
      Request.body(Body.jsonSchema(JsonGrant)),
      Request.baseUrl(origin),
    ),
  login: (origin: string) =>
    Request.post("api/v2/login").pipe(
      Request.body(Body.jsonSchema(Login)),
      Request.baseUrl(origin),
    ),
  register: (origin: string) =>
    Request.post("api/v2/users").pipe(
      Request.body(Body.jsonSchema(Registration)),
      Request.baseUrl(origin),
    ),
  profile: (origin: string) =>
    Request.get("api/v2/me").pipe(
      Request.headers(Credentials),
      Request.baseUrl(origin),
    ),
  lookupUser: (origin: string) =>
    Request.get("").pipe(
      Request.path(Uid, (uid, encode) => `directory/users/${encode(uid)}`),
      Request.headers(Credentials),
      Request.baseUrl(origin),
    ),
  /** The issuer is the base URL; the default join keeps a single slash at the boundary. */
  discover: (issuer: Issuer) =>
    Request.get(".well-known/openid-configuration").pipe(
      Request.baseUrl(issuer),
    ),
};

/** PAY-9, AUTH-3, AUTH-4. The 2012 servlet: form-encoded grants, string values, OAuth errors. */
export const formGrant = (origin: string) =>
  Operation.make(
    requests.formGrant(origin),
    Response.status(200, Body.jsonSchema(FormTokenSet)).pipe(
      Response.orElse(
        Response.when(statuses(400, 401, 415), Body.jsonSchema(OAuthError)),
      ),
      Response.orElse(rateLimited),
      Response.orElse(serverFault),
    ),
  );

/**
 * PAY-9, HDR-1. The 2016 JSON grant. The success is tagged `Granted` and keeps its metadata, so a
 * caller can see whether the provider supplied original lines.
 */
export const jsonGrant = (origin: string) =>
  Operation.make(
    requests.jsonGrant(origin),
    Response.status(200, Response.tag("Granted", grantedBody)).pipe(
      Response.orElse(
        Response.when(
          statuses(400, 401, 403, 415),
          Body.jsonSchema(CodedError),
        ),
      ),
      Response.orElse(rateLimited),
      Response.orElse(serverFault),
    ),
  );

/** STAT-1, AUTH-3. The web login: 200 with tokens only. */
export const login = (origin: string) =>
  Operation.make(
    requests.login(origin),
    Response.status(200, Body.jsonSchema(JsonTokenSet)).pipe(
      Response.orElse(
        Response.when(
          statuses(400, 401, 403, 415),
          Body.jsonSchema(CodedError),
        ),
      ),
      Response.orElse(rateLimited),
      Response.orElse(serverFault),
    ),
  );

/** STAT-1. Registration: 201 with the new directory entry. */
export const register = (origin: string) =>
  Operation.make(
    requests.register(origin),
    Response.status(201, Body.jsonSchema(DirectoryEntry)).pipe(
      Response.orElse(
        Response.when(statuses(400, 409, 415), Body.jsonSchema(CodedError)),
      ),
      Response.orElse(serverFault),
    ),
  );

/** STAT-1. The caller's own entry, fetched separately from login. */
export const profile = (origin: string) =>
  Operation.make(
    requests.profile(origin),
    Response.status(200, Body.jsonSchema(DirectoryEntry)).pipe(
      Response.orElse(unauthorized),
      Response.orElse(serverFault),
    ),
  );

/** ERR-4, VAL-1a, VAL-5a. A directory entry by uid. A missing uid is a 200 inactive entry. */
export const lookupUser = (origin: string) =>
  Operation.make(
    requests.lookupUser(origin),
    Response.status(200, Body.jsonSchema(DirectoryEntry)).pipe(
      Response.orElse(unauthorized),
      Response.orElse(serverFault),
    ),
  );

/** VAL-5a. Discovery from the configured issuer, refusing a document for any other issuer. */
export const discover = (issuer: Issuer) =>
  Operation.make(
    requests.discover(issuer),
    Response.status(200, Body.jsonSchema(Discovery(issuer))),
  );

/**
 * AUTH-8. Client middleware that sends `X-Forwarded-For`. The provider's rate limiter trusts it,
 * so a test run can claim a bucket of its own instead of sharing the load balancer's.
 */
export const forwardedFor =
  (address: string) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
    client.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("X-Forwarded-For", address),
      ),
    );

/**
 * Deliberate mis-declarations and diagnostic views. They are not part of the consumer's normal
 * contract; tests use them to observe how the provider rejects what a careless consumer sends.
 */
export const controls = {
  /** Any status, decoded as untyped JSON: the provider's own spellings, before normalization. */
  raw: <I, E, R, H extends boolean, Q extends boolean>(
    request: Request.Request<I, E, R, H, Q>,
  ) =>
    Operation.make(
      request,
      Response.when(() => true, Body.json),
    ),
  /** PAY-9. The 2016 JSON grant body sent to the 2012 form endpoint. */
  jsonToFormEndpoint: (origin: string) =>
    Operation.make(
      Request.post("oauth/token").pipe(
        Request.body(Body.jsonSchema(JsonGrant)),
        Request.baseUrl(origin),
      ),
      Response.when(statuses(400, 401, 415), Body.jsonSchema(OAuthError)),
    ),
  /** PAY-9. The 2012 form grant sent to the 2016 JSON endpoint. */
  formToJsonEndpoint: (origin: string) =>
    Operation.make(
      Request.post("api/v2/token").pipe(
        Request.body(formGrantBody),
        Request.baseUrl(origin),
      ),
      Response.when(statuses(400, 401, 415), Body.jsonSchema(CodedError)),
    ),
  /** AUTH-3. The profile with a hand-written Authorization header, such as a raw token type. */
  profileWithAuthorization: (origin: string) =>
    Operation.make(
      Request.get("api/v2/me").pipe(
        Request.headers(Schema.Struct({ Authorization: Schema.String })),
        Request.baseUrl(origin),
      ),
      Response.status(200, Body.jsonSchema(DirectoryEntry)).pipe(
        Response.orElse(unauthorized),
      ),
    ),
  /** VAL-5a. Discovery by string concatenation, which doubles the issuer's trailing slash. */
  naiveDiscovery: (issuer: Issuer) =>
    Operation.make(
      Request.get(`${issuer}/.well-known/openid-configuration`),
      Response.status(200, Body.jsonSchema(Discovery(issuer))),
    ),
};
