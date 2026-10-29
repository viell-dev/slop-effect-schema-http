/**
 * The consumer's contracts for the JSON business API's operations era (`/v2/`): shared request
 * transforms, schemas and operations. Everything here is written against the library's public API,
 * Effect, and Web-standard APIs only, so it also runs in a browser.
 *
 * Operations are factories over a {@link Connection}, so the cross-service flows can point them at
 * any server and credential.
 */
import { Clock, Duration, Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Values from "../../values/business.js";

/** Where the service lives and how to authenticate. */
export interface Connection {
  /** The service root, including `/v2`, such as `http://127.0.0.1:1234/v2`. */
  readonly baseUrl: string;
  /**
   * The bearer token, read once per operation evaluation; `undefined` omits the header. It is a
   * function so a rotated token reaches the next evaluation without rebuilding operations.
   */
  readonly credential: () => string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Shared request transforms
// ---------------------------------------------------------------------------------------------

/** The base URL and bearer credential of a connection, applied to any request with raw headers. */
export const at =
  (connection: Connection) =>
  <I, E, R, Q extends boolean>(
    request: Request.Request<I, E, R, false, Q>,
  ): Request.Request<I, E, R, false, Q> =>
    request.pipe(
      Request.setHeader("Authorization", () => {
        const token = connection.credential();
        return token === undefined ? undefined : `Bearer ${token}`;
      }),
      Request.baseUrl(connection.baseUrl),
    );

const tunnelled = new Set(["PUT", "PATCH", "DELETE"]);

/**
 * STAT-11: the method-override tunnel. The gateway strips PUT, PATCH and DELETE and the service
 * refuses them raw, so the request goes out as POST with `X-HTTP-Method-Override` naming the
 * intended method. Other methods pass unchanged. It ignores the request's input, so this one
 * value is reused on every request, rollback included.
 */
export const tunnel = Request.mapEffect(
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      tunnelled.has(request.method)
        ? request.pipe(
            HttpClientRequest.setHeader(
              "x-http-method-override",
              request.method,
            ),
            HttpClientRequest.setMethod("POST"),
          )
        : request,
    ),
);

/** A fresh cache key for each attempt; Web-standard, so it also runs in a browser. */
const randomCacheKey = (): string => crypto.randomUUID();

/**
 * The Fetch transport's cache mode for every attempt, merged over any `RequestInit` already
 * provided. It governs the HTTP cache of the platform's `fetch`: a browser's, which honours
 * `max-age` and guesses freshness from `Last-Modified`. Fetch also adds `Cache-Control` and
 * `Pragma` request headers for some modes. Other transports ignore it. Pass it as
 * `transformClient`.
 */
export const transportCache =
  (mode: RequestCache) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.transform(client, (effect) =>
      Effect.flatMap(
        Effect.serviceOption(FetchHttpClient.RequestInit),
        (init) =>
          Effect.provideService(effect, FetchHttpClient.RequestInit, {
            ...Option.getOrElse(init, () => ({})),
            cache: mode,
          }),
      ),
    );

/**
 * HDR-8: read past an edge cache that ignores request `Cache-Control` and keys only on the `v`
 * parameter, and past the platform's own HTTP cache. One client transform carries all three parts,
 * per attempt: the `Cache-Control: no-cache` header for caches that honour it, a fresh `v`
 * appended to the composed URL for the edge, and the `no-store` transport cache mode for the
 * browser. Pass it as `transformClient`.
 */
export const bypassEdgeCache =
  (nextKey: () => string = randomCacheKey) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    transportCache("no-store")(
      HttpClient.mapRequest(client, (request) => {
        // Edit the composed URL as text: appending through `urlParams` would make the client
        // re-serialize the whole query with form encoding.
        const separator = request.url.includes("?") ? "&" : "?";
        return request.pipe(
          HttpClientRequest.setHeader("cache-control", "no-cache"),
          HttpClientRequest.setUrl(
            `${request.url}${separator}v=${encodeURIComponent(nextKey())}`,
          ),
        );
      }),
    );

type ClientTransform = (client: HttpClient.HttpClient) => HttpClient.HttpClient;

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const encodedBody = (
  request: HttpClientRequest.HttpClientRequest,
): Uint8Array => {
  const body = request.body;
  if (body._tag === "Uint8Array") return body.body;
  if (body._tag === "Raw" && typeof body.body === "string")
    return new TextEncoder().encode(body.body);
  return new Uint8Array();
};

/**
 * RET-1: set `X-Nonce` and `X-Signature` (hex HMAC-SHA256 keyed by the bearer token over
 * `<nonce>.` and the encoded body bytes) on a native request. It reads the credential the request
 * already carries, so a token resolved once per evaluation signs every attempt.
 */
export const signWithNonce = (
  request: HttpClientRequest.HttpClientRequest,
  nonce: string,
): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
  Effect.promise(async () => {
    const token =
      /^Bearer (.+)$/.exec(request.headers["authorization"] ?? "")?.[1] ?? "";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const prefix = new TextEncoder().encode(`${nonce}.`);
    const body = encodedBody(request);
    const message = new Uint8Array(prefix.length + body.length);
    message.set(prefix);
    message.set(body, prefix.length);
    const signature = hex(await crypto.subtle.sign("HMAC", key, message));
    return request.pipe(
      HttpClientRequest.setHeader("x-nonce", nonce),
      HttpClientRequest.setHeader("x-signature", signature),
    );
  });

/** RET-1: client middleware that takes a fresh nonce and signs every attempt. */
export const nonceEachAttempt =
  (nonces: () => bigint) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequestEffect(client, (request) =>
      signWithNonce(request, nonces().toString()),
    );

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

/** The error object most routes answer with; extra members vary by route and are ignored. */
export const Problem = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
});

/** The gateway's own refusal body, which is not the service's error shape. */
export const GatewayMessage = Schema.Struct({ message: Schema.String });

export const FieldErrors = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({ field: Schema.String, message: Schema.String }),
  ),
});

export const TaskId = Schema.String.check(
  Schema.isPattern(/^T-[1-9]\d*$/),
).pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;

export const Priority = Schema.Literals([1, 2, 3, 4]);

export const AssigneeId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._:@-]{1,64}$/),
);

export const Task = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  assigneeId: Schema.String,
  priority: Priority,
  due: Schema.NullOr(Values.AspNetDate),
  notes: Values.optionalText,
  done: Values.YesNo,
  created: Values.EpochMillis,
});
export type Task = typeof Task.Type;

/** What a task is created from. Blank titles are refused before any request is sent. */
export const NewTask = Schema.Struct({
  title: Schema.String.check(
    Schema.makeFilter((title: string) =>
      title.trim() === "" ? "a task needs a title" : undefined,
    ),
  ),
  assigneeId: AssigneeId,
  priority: Priority,
  due: Schema.optionalKey(Values.AspNetDate),
  notes: Values.optionalText,
});
export type NewTask = typeof NewTask.Type;

/** A full replacement, sent as PUT through the tunnel. */
export const TaskReplacement = Schema.Struct({
  ...NewTask.fields,
  done: Values.YesNo,
});
export type TaskReplacement = typeof TaskReplacement.Type;

export const TaskList = Schema.Struct({
  applied: Schema.Struct({
    assignee: Schema.NullOr(Schema.String),
    status: Schema.NullOr(Schema.Literals(["open", "done"])),
  }),
  items: Schema.Array(Task),
  count: Schema.Int,
});

/** Filters for listing tasks. A repeated status goes out as repeated parameters. */
export const TaskFilter = Schema.Struct({
  assignee: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Array(Schema.Literals(["open", "done"]))),
});

export const HistoryEvent = Schema.Struct({
  task: Schema.String,
  action: Schema.Literals(["created", "updated", "deleted"]),
  at: Values.EpochMillis,
});
export const History = Schema.Struct({ events: Schema.Array(HistoryEvent) });

export const SearchResult = Schema.Struct({
  query: Schema.String,
  hits: Schema.Array(Task),
});

export const Quote = Schema.Struct({
  pair: Schema.String,
  rate: Schema.String,
  asOf: Values.EpochMillis,
});

export const Pair = Schema.String.check(Schema.isPattern(/^[A-Z]{6}$/));

export const Report = Schema.Struct({
  report: Schema.String,
  rows: Schema.Array(Schema.Tuple([Schema.String, Values.DollarString])),
});

export const ExportStatus = Schema.Struct({
  export: Schema.String,
  status: Schema.String,
});

export const PriceList = Schema.Struct({
  version: Schema.Int,
  prices: Schema.Array(
    Schema.Struct({ sku: Schema.String, price: Values.DollarString }),
  ),
});

export const PriceChange = Schema.Struct({
  sku: Schema.String,
  price: Values.DollarString,
});

export const Purged = Schema.Struct({
  status: Schema.Literal("ok"),
  purged: Schema.Int,
});

export const Invoice = Schema.Struct({
  id: Schema.Int,
  customer: Values.CustomerRef,
  amount: Values.DollarString,
  paid: Values.YesNo,
  issued: Values.EpochMillis,
  due: Values.AspNetDate,
  printed: Values.UsLocalDateTime,
  tags: Values.SpaceDelimited,
  poNumber: Values.optionalText,
  seatLimit: Values.Limit,
});
export type Invoice = typeof Invoice.Type;

export const InvoiceList = Schema.Struct({ invoices: Schema.Array(Invoice) });

/** The response header the invoice routes carry, read through a header schema. */
export const InvoiceHeaders = Schema.Struct({
  "last-modified": Values.HttpDate,
});

export const NewPayout = Schema.Struct({
  amount: Values.DollarString,
  to: Schema.String,
});

export const Payout = Schema.Struct({
  payout: Schema.String,
  amount: Values.DollarString,
  to: Schema.String,
  nonce: Schema.String,
});

export const Events = Schema.Struct({
  events: Schema.Array(Schema.Struct({ id: Schema.Int, type: Schema.String })),
  next: Schema.Int,
});

export const Abandoned = Schema.Struct({
  abandoned: Schema.Array(
    Schema.Struct({
      route: Schema.Literals(["search", "events"]),
      target: Schema.String,
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// Response cases
// ---------------------------------------------------------------------------------------------

const unauthorized = Response.status(
  401,
  Response.tag("Unauthorized", Body.jsonSchema(Problem)),
);
const notFound = Response.status(
  404,
  Response.tag("NotFound", Body.jsonSchema(Problem)),
);
const badRequest = Response.status(
  400,
  Response.tag("BadRequest", Body.jsonSchema(Problem)),
);
const invalid = Response.status(
  422,
  Response.tag("Invalid", Body.jsonSchema(FieldErrors)),
);
/** The gateway's refusal, with `Allow` in the tagged metadata. */
const methodNotAllowed = Response.status(
  405,
  Response.tag("MethodNotAllowed", Body.jsonSchema(GatewayMessage)),
);

/** The rejections every authenticated task route can produce. */
const taskRejections = unauthorized.pipe(
  Response.orElse(notFound),
  Response.orElse(invalid),
  Response.orElse(badRequest),
  Response.orElse(methodNotAllowed),
);

const taskPath = <S extends Schema.Constraint & { readonly Encoded: string }>(
  schema: S,
  suffix = "",
) =>
  Request.path(schema, (id: string, encode) => `tasks/${encode(id)}${suffix}`);

// ---------------------------------------------------------------------------------------------
// Tasks (for the cross-service flows as well)
// ---------------------------------------------------------------------------------------------

export const createTask = (connection: Connection) =>
  Operation.make(
    Request.post("tasks").pipe(
      at(connection),
      Request.body(Body.jsonSchema(NewTask)),
    ),
    Response.status(201, Response.tag("Created", Body.jsonSchema(Task))).pipe(
      Response.orElse(taskRejections),
    ),
  );

export const readTask = (connection: Connection) =>
  Operation.make(
    Request.get("tasks").pipe(at(connection), taskPath(TaskId)),
    Response.status(200, Response.tag("Task", Body.jsonSchema(Task))).pipe(
      Response.orElse(taskRejections),
    ),
  );

export const listTasks = (connection: Connection) =>
  Operation.make(
    Request.get("tasks").pipe(at(connection), Request.query(TaskFilter)),
    Response.status(200, Response.tag("Tasks", Body.jsonSchema(TaskList))).pipe(
      Response.orElse(taskRejections),
    ),
  );

/** Replace a task: a PUT, tunnelled. */
export const replaceTask = (connection: Connection) =>
  Operation.make(
    Request.put("tasks").pipe(
      at(connection),
      taskPath(TaskId),
      Request.body(Body.jsonSchema(TaskReplacement)),
      tunnel,
    ),
    Response.status(200, Response.tag("Task", Body.jsonSchema(Task))).pipe(
      Response.orElse(taskRejections),
    ),
  );

/** Delete a task: a DELETE, tunnelled. Also the compensation of the cross-service flows. */
export const deleteTask = (connection: Connection) =>
  Operation.make(
    Request.del("tasks").pipe(at(connection), taskPath(TaskId), tunnel),
    Response.status(204, Response.tag("Deleted", Body.empty)).pipe(
      Response.orElse(taskRejections),
    ),
  );

/**
 * EXT-1: one tag for two statuses. A tunnelled write answers `200` with the task or `204` with no
 * body, and the caller learns the same thing from both: the change was applied, with the task when
 * the service returned it. Both cases are `Changed`; the status selects the decoder, so a tag names
 * what the caller learns, not which case matched.
 */
export const changed = Response.status(
  200,
  Response.tag(
    "Changed",
    Body.jsonSchema(Task).pipe(Body.map((task) => Option.some(task))),
  ),
).pipe(
  Response.orElse(
    Response.status(
      204,
      Response.tag(
        "Changed",
        Body.empty.pipe(Body.map(() => Option.none<Task>())),
      ),
    ),
  ),
  Response.orElse(taskRejections),
);

/** Replace a task through the tunnel, answered with {@link changed}. */
export const replaceTaskChanged = (connection: Connection) =>
  Operation.make(
    Request.put("tasks").pipe(
      at(connection),
      taskPath(TaskId),
      Request.body(Body.jsonSchema(TaskReplacement)),
      tunnel,
    ),
    changed,
  );

/** Delete a task through the tunnel, answered with {@link changed}. */
export const deleteTaskChanged = (connection: Connection) =>
  Operation.make(
    Request.del("tasks").pipe(at(connection), taskPath(TaskId), tunnel),
    changed,
  );

/** A raw PUT without the tunnel: the control case that the gateway refuses. */
export const replaceTaskUntunnelled = (connection: Connection) =>
  Operation.make(
    Request.put("tasks").pipe(
      at(connection),
      taskPath(TaskId),
      Request.body(Body.jsonSchema(TaskReplacement)),
    ),
    Response.status(200, Response.tag("Task", Body.jsonSchema(Task))).pipe(
      Response.orElse(taskRejections),
    ),
  );

/** A raw DELETE without the tunnel: the control case that the gateway refuses. */
export const deleteTaskUntunnelled = (connection: Connection) =>
  Operation.make(
    Request.del("tasks").pipe(at(connection), taskPath(TaskId)),
    Response.status(204, Response.tag("Deleted", Body.empty)).pipe(
      Response.orElse(taskRejections),
    ),
  );

/** QRY-3: one task's history, with the application contract refusing an empty or malformed id. */
export const taskHistory = (connection: Connection) =>
  Operation.make(
    Request.get("tasks").pipe(at(connection), taskPath(TaskId, "/history")),
    Response.status(
      200,
      Response.tag("History", Body.jsonSchema(History)),
    ).pipe(Response.orElse(taskRejections)),
  );

/**
 * QRY-3 control: the same route with any string as the id. The library leaves an empty segment
 * in place (`tasks//history`); what the server makes of it is the server's business.
 */
export const taskHistoryAnyId = (connection: Connection) =>
  Operation.make(
    Request.get("tasks").pipe(
      at(connection),
      taskPath(Schema.String, "/history"),
    ),
    Response.status(
      200,
      Response.tag("History", Body.jsonSchema(History)),
    ).pipe(Response.orElse(taskRejections)),
  );

export const searchTasks = (connection: Connection) =>
  Operation.make(
    Request.get("search").pipe(
      at(connection),
      Request.query(Schema.Struct({ q: Schema.String })),
    ),
    Response.status(
      200,
      Response.tag("Results", Body.jsonSchema(SearchResult)),
    ).pipe(Response.orElse(taskRejections)),
  );

// ---------------------------------------------------------------------------------------------
// Rates, reports and exports (STAT-8, STAT-9)
// ---------------------------------------------------------------------------------------------

/** STAT-8: the built-in transient cases plus the unregistered 420 this service uses. */
export const transientOrCalm = (reason: Policy.Reason): boolean =>
  Policy.transient(reason) || reason.metadata?.status === 420;

export const quote = <EP, RP>(
  connection: Connection,
  policy: Policy.Policy<EP, RP>,
) =>
  Operation.make(
    Request.get("rates").pipe(
      at(connection),
      Request.path(Pair, (pair, encode) => `rates/${encode(pair)}`),
    ),
    Response.status(200, Body.jsonSchema(Quote)),
    { policy },
  );

export const report = <EP, RP>(
  connection: Connection,
  policy: Policy.Policy<EP, RP>,
) =>
  Operation.make(
    Request.get("reports").pipe(
      at(connection),
      Request.path(Schema.String, (name, encode) => `reports/${encode(name)}`),
    ),
    Response.status(200, Body.jsonSchema(Report)),
    { policy },
  );

export const exportStatus = <EP, RP>(
  connection: Connection,
  policy: Policy.Policy<EP, RP>,
) =>
  Operation.make(
    Request.get("exports").pipe(
      at(connection),
      Request.path(Schema.String, (name, encode) => `exports/${encode(name)}`),
    ),
    Response.status(200, Body.jsonSchema(ExportStatus)),
    { policy },
  );

// ---------------------------------------------------------------------------------------------
// Catalog behind the edge cache (HDR-8)
// ---------------------------------------------------------------------------------------------

/** Read the prices, through the edge. Pass {@link bypassEdgeCache} to read past it. */
export const prices = (
  connection: Connection,
  transformClient?: ClientTransform,
) =>
  Operation.make(
    Request.get("catalog/prices").pipe(at(connection)),
    Response.status(200, Response.tag("Prices", Body.jsonSchema(PriceList))),
    { transformClient },
  );

/** Empty the edge's variants of the price list: the custom PURGE method. */
export const purgePrices = (connection: Connection) =>
  Operation.make(
    Request.make("PURGE", "catalog/prices").pipe(at(connection)),
    Response.status(200, Body.jsonSchema(Purged)),
  );

/** Change a price at the origin. The edge is not told. */
export const changePrice = (connection: Connection) =>
  Operation.make(
    Request.post("catalog/prices").pipe(
      at(connection),
      Request.body(Body.jsonSchema(PriceChange)),
    ),
    Response.status(200, Body.jsonSchema(PriceList)),
  );

// ---------------------------------------------------------------------------------------------
// Invoices (VAL-1b to VAL-5b)
// ---------------------------------------------------------------------------------------------

/** Decode a body and the invoice headers together. */
const withLastModified = <A, E, R>(body: Body.Decoder<A, E, R>) =>
  Body.decoder(
    (response) =>
      Effect.all({
        value: body.decode(response),
        lastModified: Effect.map(
          Schema.decodeUnknownEffect(InvoiceHeaders)(response.headers),
          (headers) => headers["last-modified"],
        ),
      }),
    body.mediaType,
  );

/**
 * List invoices. The service sends `Last-Modified` without `Cache-Control`, so a browser may
 * answer from its own cache by heuristic freshness; pass {@link transportCache} as
 * `transformClient` to choose otherwise. QRY-3: invoices older than a year live on the archive
 * deployment; `archiveBaseUrl` replaces the connection's base URL for this one operation while the
 * shared credential stays.
 */
export const listInvoices = (
  connection: Connection,
  options?: {
    readonly archiveBaseUrl?: string;
    readonly transformClient?: ClientTransform;
  },
) =>
  Operation.make(
    Request.get("invoices").pipe(
      at(connection),
      options?.archiveBaseUrl === undefined
        ? (request) => request
        : Request.baseUrl(options.archiveBaseUrl),
    ),
    Response.status(200, withLastModified(Body.jsonSchema(InvoiceList))),
    { transformClient: options?.transformClient },
  );

/** The invoice list as text, for asserting the service's spellings. */
export const listInvoicesText = (
  connection: Connection,
  transformClient?: ClientTransform,
) =>
  Operation.make(
    Request.get("invoices").pipe(at(connection)),
    Response.status(200, Body.text),
    {
      transformClient,
    },
  );

const invoicePath = Request.path(
  Schema.Int,
  (id, encode) => `invoices/${encode(String(id))}`,
);

/** Replace an invoice, tunnelled, encoding every value through its schema. */
export const replaceInvoice = (connection: Connection) =>
  Operation.make(
    Request.put("invoices").pipe(
      at(connection),
      invoicePath,
      Request.body(Body.jsonSchema(Invoice)),
      tunnel,
    ),
    Response.status(
      200,
      Response.tag("Invoice", withLastModified(Body.jsonSchema(Invoice))),
    ).pipe(Response.orElse(invalid), Response.orElse(notFound)),
  );

/** Replace an invoice with an untyped body: the control for the service's own validation. */
export const replaceInvoiceUnchecked = (connection: Connection) =>
  Operation.make(
    Request.put("invoices").pipe(
      at(connection),
      invoicePath,
      Request.body(Body.json),
      tunnel,
    ),
    Response.status(
      200,
      Response.tag("Invoice", Body.jsonSchema(Invoice)),
    ).pipe(Response.orElse(invalid), Response.orElse(notFound)),
  );

// ---------------------------------------------------------------------------------------------
// Payouts (RET-1)
// ---------------------------------------------------------------------------------------------

const payoutRequest = (connection: Connection) =>
  Request.post("payouts").pipe(
    at(connection),
    Request.body(Body.jsonSchema(NewPayout)),
  );

const payoutResponse = Response.status(
  201,
  Response.tag("Paid", Body.jsonSchema(Payout)),
).pipe(
  Response.orElse(
    Response.status(503, Response.tag("WarmingUp", Body.jsonSchema(Problem))),
  ),
  Response.orElse(
    Response.status(409, Response.tag("Replayed", Body.jsonSchema(Problem))),
  ),
  Response.orElse(unauthorized),
  Response.orElse(badRequest),
);

/**
 * A payout signed once per evaluation, in request preparation. Retrying it under a policy replays
 * the same nonce, which the service then refuses as a replay (the pinned RET-1 failure).
 */
export const payoutSignedPerEvaluation = <EP = never, RP = never>(
  connection: Connection,
  nonces: () => bigint,
  policy: Policy.Policy<EP, RP> = Policy.none as Policy.Policy<EP, RP>,
) =>
  Operation.make(
    payoutRequest(connection).pipe(
      Request.mapEffect((request: HttpClientRequest.HttpClientRequest) =>
        signWithNonce(request, nonces().toString()),
      ),
    ),
    payoutResponse,
    { policy },
  );

/** A payout whose client middleware takes a fresh nonce and signs every attempt. */
export const payoutSignedPerAttempt = <EP, RP>(
  connection: Connection,
  nonces: () => bigint,
  policy: Policy.Policy<EP, RP>,
) =>
  Operation.make(payoutRequest(connection), payoutResponse, {
    policy,
    transformClient: nonceEachAttempt(nonces),
  });

/**
 * RET-1, caller-driven: execute a payout signed per evaluation until it is no longer warming up,
 * at most `budget` more times, waiting at least what each `Retry-After` asks. Each execution is a
 * new evaluation, so it takes a new nonce and signature.
 */
export const payoutUntilReady = (
  connection: Connection,
  nonces: () => bigint,
  budget: number,
) => {
  const operation = payoutSignedPerEvaluation(connection, nonces);
  const attempt = (
    input: { readonly body: typeof NewPayout.Type },
    remaining: number,
  ): ReturnType<typeof operation.execute> =>
    Effect.flatMap(operation.execute(input), (result) =>
      result._tag !== "WarmingUp" || remaining <= 0
        ? Effect.succeed(result)
        : Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sleep(
              Duration.max(
                Duration.millis(10),
                Policy.retryAfterDelay(result.metadata, now),
              ),
            ),
          ).pipe(Effect.andThen(attempt(input, remaining - 1))),
    );
  return Operation.fromEffect(
    (input: { readonly body: typeof NewPayout.Type }) => attempt(input, budget),
  );
};

// ---------------------------------------------------------------------------------------------
// Long poll (RET-2) and abandoned requests
// ---------------------------------------------------------------------------------------------

/** Long-poll for events after the start. The policy defaults to a single attempt. */
export const pollEvents = <EP = never, RP = never>(
  connection: Connection,
  policy: Policy.Policy<EP, RP> = Policy.none as Policy.Policy<EP, RP>,
) =>
  Operation.make(
    Request.get("events").pipe(at(connection), Request.setQuery("after", "0")),
    Response.status(200, Response.tag("Events", Body.jsonSchema(Events))),
    { policy },
  );

export const publishEvent = (connection: Connection) =>
  Operation.make(
    Request.post("events").pipe(
      at(connection),
      Request.body(Body.jsonSchema(Schema.Struct({ type: Schema.String }))),
    ),
    Response.status(
      202,
      Body.jsonSchema(Schema.Struct({ accepted: Schema.Int })),
    ),
  );

/** The service's own record of held requests whose client went away, waiting for `atLeast`. */
export const abandonedRequests = (connection: Connection) =>
  Operation.make(
    Request.get("ops/abandoned").pipe(
      at(connection),
      Request.query(Schema.Struct({ atLeast: Schema.Int })),
    ),
    Response.status(200, Body.jsonSchema(Abandoned)),
  );
