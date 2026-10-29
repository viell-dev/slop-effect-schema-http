/**
 * The consumer's contract with the notification service. Every operation is built from the
 * library's public API, Effect, and this directory's schemas; nothing here knows the backend's code.
 *
 * Transport assumptions are explicit in the configuration: how the XSRF cookie travels, whether
 * Effect's trace propagation applies to this service, and an optional cookie jar.
 */
import { Effect, Option, type Ref, Schema } from "effect";
import {
  type Cookies,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
} from "effect/http";
import {
  Body,
  Operation,
  type Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import { Retirement, TokenCredential } from "../../values/notifications.js";
import {
  Announcement,
  AnnouncementDraft,
  AnnouncementList,
  ChannelList,
  CorsAnswer,
  CsrfBootstrap,
  CsrfFailurePage,
  CsrfHeaders,
  CsrfSession,
  Frozen,
  Invalid,
  PreflightRequest,
  SignatureFailure,
  Subscription,
  SubscriptionDraft,
  SubscriptionList,
} from "./schemas.js";
import { signAttempts, type SigningError } from "./signing.js";

export * from "./schemas.js";
export * from "./signing.js";
export * as Cors from "./cors.js";

export interface Config {
  readonly baseUrl: string;
  /**
   * The late-bound opaque token, resolved once per operation evaluation. `None` omits the
   * `Authorization` header.
   */
  readonly token: Effect.Effect<Option.Option<string>>;
  /** The shared HMAC secret for announcements. */
  readonly secret: string;
  /**
   * How the XSRF cookie travels: `by-hand` sets the `Cookie` line from the session (Node keeps no
   * cookies), `transport` leaves it to the transport's cookie handling (a jar, or a browser).
   */
  readonly csrfCookie: "by-hand" | "transport";
  /**
   * Whether Effect's client adds `b3` and `traceparent` to this service's requests. Default
   * `false`: the announcement preflight refuses both, so a browser could not call it.
   */
  readonly tracePropagation?: boolean | undefined;
  /** An explicit cookie jar shared by this service's operations (`HttpClient.withCookiesRef`). */
  readonly jar?: Ref.Ref<Cookies.Cookies> | undefined;
  /**
   * Node only: send this `Origin`, as a browser page on that origin would, so the service answers
   * with its CORS headers. Browsers set `Origin` themselves and forbid scripts from setting it.
   */
  readonly origin?: string | undefined;
}

const encodeCredential = Schema.encodeEffect(TokenCredential);

/**
 * Set `Authorization` under the `Token` scheme from a late-bound token, once per evaluation. A
 * transform that ignores its input, so it applies to any request.
 */
export const authorize = (token: Effect.Effect<Option.Option<string>>) =>
  Request.mapEffect((request: HttpClientRequest.HttpClientRequest) =>
    Effect.flatMap(
      token,
      Option.match({
        onNone: () => Effect.succeed(request),
        onSome: (value) =>
          Effect.map(encodeCredential(value), (credential) =>
            HttpClientRequest.setHeader(request, "authorization", credential),
          ),
      }),
    ),
  );

/** The 401 that the Token authentication layer answers, selected by its challenge header. */
export const tokenRejected = Response.when(
  (metadata) =>
    metadata.status === 401 &&
    /^Token\b/.test(metadata.headers["www-authenticate"] ?? ""),
  Response.tag("TokenRejected", Body.text),
);

/** The framework's CSRF page, read for its reason. */
export const csrfRejected = Response.status(
  403,
  Response.tag("CsrfRejected", Body.text.pipe(Body.schema(CsrfFailurePage))),
);

/**
 * The announcement contract. The Token challenge is a header rule declared ahead of the plain 401
 * rule, whose four signature failures share metadata and differ only in the body.
 */
export const announceResponse = Response.status(
  202,
  Response.tag("Announced", Body.jsonSchema(Announcement)),
).pipe(
  Response.orElse(tokenRejected),
  Response.orElse(
    Response.status(
      401,
      Response.tag("SignatureRejected", Body.jsonSchema(SignatureFailure)),
    ),
  ),
  Response.orElse(csrfRejected),
  Response.orElse(
    Response.status(409, Response.tag("Frozen", Body.jsonSchema(Frozen))),
  ),
  Response.orElse(
    Response.status(422, Response.tag("Invalid", Body.jsonSchema(Invalid))),
  ),
);

const decodeRetirement = Schema.decodeUnknownEffect(Retirement);
const decodeCors = Schema.decodeUnknownEffect(CorsAnswer);
const decodeSession = Schema.decodeUnknownEffect(CsrfSession);
const bootstrapBody = Body.jsonSchema(CsrfBootstrap);

/** A body decoder that first reads the retirement headers through their schema. */
const withRetirement = <A, E, R>(body: Body.Decoder<A, E, R>) =>
  Body.decoder(
    (response) =>
      Effect.gen(function* () {
        const retirement = yield* decodeRetirement(response.headers);
        const value = yield* body.decode(response);
        return { value, retirement };
      }),
    body.mediaType,
  );

/** The bootstrap body's token, with the `XSRF-TOKEN` cookie as set when the transport shows it. */
const csrfSession = Body.decoder(
  (response) =>
    Effect.gen(function* () {
      const { csrfToken } = yield* bootstrapBody.decode(response);
      const cookie = Option.getOrUndefined(
        Option.map(
          Option.fromUndefinedOr(response.cookies.cookies["XSRF-TOKEN"]),
          (found) => found.valueEncoded,
        ),
      );
      return yield* decodeSession(
        cookie === undefined
          ? { token: csrfToken }
          : { token: csrfToken, cookie },
      );
    }),
  bootstrapBody.mediaType,
);

/** Any preflight answer: its status, its CORS headers through a schema, and its text. */
const preflightAnswer = Body.decoder((response) =>
  Effect.gen(function* () {
    const answer = yield* decodeCors(response.headers);
    const text = yield* response.text;
    return { status: response.status, answer, text };
  }),
);

type ServiceClient = (
  client: HttpClient.HttpClient,
) => HttpClient.HttpClient.With<HttpClientError.HttpClientError>;

export const make = (config: Config) => {
  /** This service's client middleware: its cookie jar, Origin, and trace propagation. */
  const service: ServiceClient = (client) => {
    let result: HttpClient.HttpClient.With<HttpClientError.HttpClientError> =
      client;
    if (config.jar !== undefined)
      result = HttpClient.withCookiesRef(result, config.jar);
    const origin = config.origin;
    if (origin !== undefined)
      result = HttpClient.mapRequest(
        result,
        HttpClientRequest.setHeader("origin", origin),
      );
    if (config.tracePropagation !== true)
      result = HttpClient.transformResponse(
        result,
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      );
    return result;
  };

  const authorization = authorize(config.token);
  const signing = signAttempts({ secret: config.secret });

  /** The CSRF header input for a session, honouring how the cookie travels. */
  const csrfHeaders = (session: CsrfSession): CsrfHeaders =>
    config.csrfCookie === "by-hand" && session.cookie !== undefined
      ? { token: session.token, cookie: session.cookie }
      : { token: session.token };

  const announceRequest = Request.post("v2/announcements").pipe(
    Request.headers(CsrfHeaders),
    Request.body(Body.jsonSchema(AnnouncementDraft)),
    Request.mapInput(
      (input: {
        readonly csrf: CsrfSession;
        readonly announcement: AnnouncementDraft;
      }) => ({ headers: csrfHeaders(input.csrf), body: input.announcement }),
    ),
    authorization,
    Request.baseUrl(config.baseUrl),
  );

  type Signed = HttpClient.HttpClient.With<
    HttpClientError.HttpClientError | SigningError
  >;

  return {
    config,
    service,
    authorization,
    csrfHeaders,
    announceRequest,

    /** `GET /v2/session/csrf`: issue a double-submit token. Needs no credential. */
    csrf: Operation.make(
      Request.get("v2/session/csrf").pipe(Request.baseUrl(config.baseUrl)),
      Response.status(200, csrfSession),
      { transformClient: service },
    ),

    /** `POST /v2/subscriptions`: CSRF-protected and Token-authenticated. */
    subscribe: Operation.make(
      Request.post("v2/subscriptions").pipe(
        Request.headers(CsrfHeaders),
        Request.body(Body.jsonSchema(SubscriptionDraft)),
        Request.mapInput(
          (input: {
            readonly csrf: CsrfSession;
            readonly subscription: SubscriptionDraft;
          }) => ({
            headers: csrfHeaders(input.csrf),
            body: input.subscription,
          }),
        ),
        authorization,
        Request.baseUrl(config.baseUrl),
      ),
      Response.status(
        201,
        Response.tag("Created", Body.jsonSchema(Subscription)),
      ).pipe(
        Response.orElse(tokenRejected),
        Response.orElse(csrfRejected),
        Response.orElse(
          Response.status(
            422,
            Response.tag("Invalid", Body.jsonSchema(Invalid)),
          ),
        ),
      ),
      { transformClient: service },
    ),

    /** `GET /v1/subscriptions`, read with its retirement headers. */
    legacySubscriptions: Operation.make(
      Request.get("v1/subscriptions").pipe(
        authorization,
        Request.baseUrl(config.baseUrl),
      ),
      Response.status(
        200,
        Response.tag(
          "Listed",
          withRetirement(Body.jsonSchema(SubscriptionList)),
        ),
      ).pipe(Response.orElse(tokenRejected)),
      { transformClient: service },
    ),

    /** `GET /v1/channels`, read with its retirement headers. */
    legacyChannels: Operation.make(
      Request.get("v1/channels").pipe(
        authorization,
        Request.baseUrl(config.baseUrl),
      ),
      Response.status(
        200,
        Response.tag("Listed", withRetirement(Body.jsonSchema(ChannelList))),
      ).pipe(Response.orElse(tokenRejected)),
      { transformClient: service },
    ),

    /**
     * `POST /v2/announcements`, signed per attempt in client middleware. `transformClient` adds
     * middleware after the signer, and `policy` chooses retries.
     */
    announce: <EP = never, RP = never>(
      options: {
        readonly policy?: Policy.Policy<EP, RP> | undefined;
        readonly transformClient?: ((client: Signed) => Signed) | undefined;
      } = {},
    ) =>
      Operation.make(announceRequest, announceResponse, {
        policy: options.policy,
        transformClient: (client: HttpClient.HttpClient): Signed => {
          const signed: Signed = signing(service(client));
          return options.transformClient === undefined
            ? signed
            : options.transformClient(signed);
        },
      }),

    /** `GET /v2/announcements`. */
    announcements: Operation.make(
      Request.get("v2/announcements").pipe(
        authorization,
        Request.baseUrl(config.baseUrl),
      ),
      Response.status(
        200,
        Response.tag("Listed", Body.jsonSchema(AnnouncementList)),
      ).pipe(Response.orElse(tokenRejected)),
      { transformClient: service },
    ),

    /**
     * Node only: send the `OPTIONS` request a browser would send before a cross-origin call. A
     * browser sends preflights itself and forbids scripts from setting their headers.
     */
    preflight: Operation.make(
      Request.options("").pipe(
        Request.path(Schema.String, (path, encode) =>
          path.split("/").map(encode).join("/"),
        ),
        Request.headers(PreflightRequest),
        Request.mapInput(
          (input: {
            readonly path: string;
            readonly preflight: PreflightRequest;
          }) => ({ path: input.path, headers: input.preflight }),
        ),
        Request.baseUrl(config.baseUrl),
      ),
      Response.when(() => true, preflightAnswer),
      { transformClient: service },
    ),
  };
};

export type Client = ReturnType<typeof make>;
