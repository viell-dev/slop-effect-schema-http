import { Data, Effect, Pipeable, Redacted, Schema } from "effect";
import {
  Headers,
  HttpClientRequest,
  type HttpMethod,
  UrlParams,
} from "effect/http";
import type * as Body from "./Body.js";
import * as Fields from "./internal/fields.js";
import * as Transport from "./Transport.js";
import * as UrlEncoding from "./UrlEncoding.js";

/**
 * Request preparation failed before dispatch.
 *
 * @remarks
 * Covers computed-field failures, URL-rendering exceptions, and a GET/HEAD body other than
 * `HttpBody.empty`. Schema encoding failures remain separate `SchemaError` values.
 */
export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A fixed header or query value, or a function that supplies it during preparation.
 *
 * @remarks
 * A function runs once each time the request is compiled, not once per retry. `undefined` omits
 * the field. Query fields also accept `null` for a bare key.
 */
export type FieldValue<A = string> = Fields.Value<A>;

/**
 * The method, URL and raw fields from which request preparation starts.
 *
 * @remarks
 * This is a low-level extension type. Prefer {@link make} and the request combinators.
 * `H` and `Q` record whether a schema owns each field group.
 */
export interface Declaration<
  H extends boolean = boolean,
  Q extends boolean = boolean,
> {
  readonly method: string;
  readonly url: string;
  readonly baseUrl: string;
  readonly headers: Fields.Fields;
  readonly query: Fields.Fields<string | null>;
  /** Whether a schema owns the header group; raw header setters are then unavailable. */
  readonly headersBound: H;
  /** Whether a schema owns the query group; raw query setters are then unavailable. */
  readonly queryBound: Q;
}

/**
 * One entry in Effect's native query collection.
 *
 * @remarks
 * Drafts use entry identity to distinguish bare keys from empty values.
 */
export type UrlParam = UrlParams.UrlParams["params"][number];

/**
 * The native request and representation details available during input preparation.
 *
 * @remarks
 * The base URL and final query text are applied after preparation. Prefer public combinators
 * unless implementing a low-level extension.
 */
export interface Draft {
  /** Method, path or URL, query parameters, normalized headers and body. */
  readonly request: HttpClientRequest.HttpClientRequest;
  /** The authoritative header lines; compilation reconciles them with the native headers. */
  readonly headerLines: Transport.Lines;
  /** Native query entries that render as bare keys. Replacing an entry loses its identity marker. */
  readonly bareKeys: ReadonlySet<UrlParam>;
}

/**
 * An immutable HTTP request description with typed application input.
 *
 * @remarks
 * Construction sends nothing. {@link compile} prepares it; `Operation.make` prepares and sends it.
 * `I` is the complete input, `E` its preparation errors, and `R` its required services.
 * `H` and `Q` record whether schemas own the header and query groups.
 * `declaration` and `prepare` are low-level extension points.
 */
export interface Request<
  in I,
  out E = never,
  out R = never,
  out H extends boolean = false,
  out Q extends boolean = false,
>
  extends Pipeable.Pipeable {
  readonly declaration: Declaration<H, Q>;
  readonly prepare: (input: I, draft: Draft) => Effect.Effect<Draft, E, R>;
}

const construct = <I, E, R, H extends boolean, Q extends boolean>(
  declaration: Declaration<H, Q>,
  prepare: (input: I, draft: Draft) => Effect.Effect<Draft, E, R>,
): Request<I, E, R, H, Q> => ({ ...Pipeable.Prototype, declaration, prepare });

/**
 * Describe a request with a method and URL, without sending it.
 *
 * @remarks
 * Use `undefined` as input until a binding adds required fields. A relative path can be combined
 * with {@link baseUrl}; {@link path} can supply the complete path from typed input.
 * Custom method strings pass through unchanged.
 *
 * A constructor query is parsed as form data: `+` becomes a space, percent escapes are decoded,
 * and empty `&` segments are dropped. Bare keys remain distinct from empty values. Compilation
 * renders these entries through `UrlEncoding.query`; a constructor fragment is discarded.
 */
export const make = (method: string, url: string): Request<unknown> => {
  const hash = url.indexOf("#");
  const withoutHash = hash < 0 ? url : url.slice(0, hash);
  const start = withoutHash.indexOf("?");
  const query: Array<readonly [string, string | null]> = [];
  if (start >= 0) {
    for (const segment of withoutHash.slice(start + 1).split("&")) {
      // URLSearchParams strips one leading query marker; a marker in the key is data.
      for (const [key, value] of new URLSearchParams(`?${segment}`))
        query.push([key, segment.includes("=") ? value : null]);
    }
  }
  return construct(
    {
      method,
      url: start < 0 ? withoutHash : withoutHash.slice(0, start),
      baseUrl: "",
      headers: [],
      query,
      headersBound: false,
      queryBound: false,
    },
    (_, draft) => Effect.succeed(draft),
  );
};

/**
 * Describe a GET request. Use {@link baseUrl} for a shared origin or path prefix.
 *
 * @example
 * ```ts
 * import { Request } from "viell-effect-schema-http";
 * const users = Request.get("/users").pipe(
 *   Request.baseUrl("https://api.example.test/api/v1"),
 * );
 * ```
 */
export const get = (url: string): Request<unknown> => make("GET", url);
/**
 * Describe a POST request. Add typed input with {@link body}, {@link path} or other bindings.
 */
export const post = (url: string): Request<unknown> => make("POST", url);
/**
 * Describe a PUT request. Add an outgoing representation with {@link body}.
 */
export const put = (url: string): Request<unknown> => make("PUT", url);
/**
 * Describe a PATCH request. Add an outgoing representation with {@link body}.
 */
export const patch = (url: string): Request<unknown> => make("PATCH", url);
/**
 * Describe a DELETE request. A response contract decides which deletion outcomes to accept.
 */
export const del = (url: string): Request<unknown> => make("DELETE", url);
/**
 * Describe a HEAD request. Its outgoing body must remain `HttpBody.empty`.
 */
export const head = (url: string): Request<unknown> => make("HEAD", url);
/**
 * Describe an OPTIONS request. The HTTP provider still controls browser preflight behavior.
 */
export const options = (url: string): Request<unknown> => make("OPTIONS", url);

/**
 * Set the shared origin and fixed path prefix for a request.
 *
 * @example
 * ```ts
 * import { Request } from "viell-effect-schema-http";
 * const api = Request.baseUrl("https://api.example.test/api/v1");
 * const users = Request.get("/users").pipe(api);
 * const teams = Request.get("/teams").pipe(api);
 * ```
 *
 * @remarks
 * The base is joined after path preparation. With the default URL policy, an absolute request
 * URL bypasses it; a leading `/` on a relative path keeps the base's prefix. Calling this again
 * replaces the base, rather than appending to it. Keep query fields in request combinators.
 */
export const baseUrl =
  (url: string) =>
  <I, E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<I, E, R, H, Q> =>
    construct({ ...self.declaration, baseUrl: url }, self.prepare);

const editHeaders =
  (edit: (fields: Fields.Fields) => Fields.Fields) =>
  <I, E, R, Q extends boolean>(
    self: Request<I, E, R, false, Q>,
  ): Request<I, E, R, false, Q> =>
    construct(
      { ...self.declaration, headers: edit(self.declaration.headers) },
      self.prepare,
    );

const editQuery =
  (
    edit: (
      fields: Fields.Fields<string | null>,
    ) => Fields.Fields<string | null>,
  ) =>
  <I, E, R, H extends boolean>(
    self: Request<I, E, R, H, false>,
  ): Request<I, E, R, H, false> =>
    construct(
      { ...self.declaration, query: edit(self.declaration.query) },
      self.prepare,
    );

/**
 * Set a raw header, replacing every existing line with that name.
 *
 * @remarks
 * Names compare without case and are stored lowercase. Unavailable after a header schema is
 * bound. The body encoder owns `Content-Type` and `Content-Length`.
 */
export const setHeader = (name: string, value: FieldValue) =>
  editHeaders((fields) => Fields.set(fields, name.toLowerCase(), value));

/**
 * Add a raw header line after the existing lines, preserving repetition.
 *
 * @remarks
 * Names are stored lowercase. Unavailable after a header schema is bound. Sending separate
 * lines requires a provider that supports them; Fetch may combine or restrict headers.
 */
export const appendHeader = (name: string, value: FieldValue) =>
  editHeaders((fields) => Fields.append(fields, name.toLowerCase(), value));

/**
 * Remove a raw header, or only its declarations with the supplied fixed value.
 *
 * @remarks
 * Names compare without case. Value functions are never evaluated to compare with `value`.
 * Unavailable after a header schema is bound.
 */
export const removeHeader = (name: string, value?: string) =>
  editHeaders((fields) => Fields.remove(fields, name.toLowerCase(), value));

/**
 * Set a raw query field, replacing entries with the same case-sensitive name.
 *
 * @remarks
 * `null` produces a bare key, `""` an empty value, and `undefined` omits the entry.
 * Unavailable after a query schema is bound.
 */
export const setQuery = (name: string, value: FieldValue<string | null>) =>
  editQuery((fields) => Fields.set(fields, name, value));

/**
 * Append a raw query entry, preserving order and repeated names.
 *
 * @remarks
 * Uses the same value rules as {@link setQuery}. Unavailable after a query schema is bound.
 */
export const appendQuery = (name: string, value: FieldValue<string | null>) =>
  editQuery((fields) => Fields.append(fields, name, value));

/**
 * Remove a raw query field, or only declarations with the supplied fixed value.
 *
 * @remarks
 * Names compare with case. Value functions are not evaluated for comparison.
 * Unavailable after a query schema is bound.
 */
export const removeQuery = (name: string, value?: string | null) =>
  editQuery((fields) => Fields.remove(fields, name, value));

const replaceQuery = (draft: Draft, entries: UrlEncoding.Query): Draft => {
  const added = entries.map(([key, value]): UrlParam => [key, value ?? ""]);
  const keys = new Set(added.map(([key]) => key));
  const bareKeys = new Set(
    Array.from(draft.bareKeys).filter(([key]) => !keys.has(key)),
  );
  entries.forEach(([, value], index) => {
    if (value === null) bareKeys.add(added[index]!);
  });
  const { request } = draft;
  const params = [
    ...request.urlParams.params.filter(([key]) => !keys.has(key)),
    ...added,
  ];
  return {
    ...draft,
    request: HttpClientRequest.makeWith(
      request.method,
      request.url,
      UrlParams.make(params),
      request.hash,
      request.headers,
      request.body,
    ),
    bareKeys,
  };
};

/** Fields that describe the body itself rather than the request. */
const bodyFields = ["content-type", "content-length"] as const;

/** Give the body fields their values from `before`, removing those it lacks. */
const keepBodyFields = (
  headers: Headers.Headers,
  before: Headers.Headers,
): Headers.Headers =>
  bodyFields.reduce((result, name) => {
    const value = before[name];
    return value === undefined
      ? Headers.remove(result, name)
      : Headers.set(result, name, value);
  }, headers);

/**
 * Bind a schema to the call's `{ headers }` input.
 *
 * @remarks
 * Encoding produces ordered header lines. The schema replaces raw header declarations and owns
 * the group: later raw setters or another header schema are unavailable.
 * When a body is present, its `Content-Type` and `Content-Length` take precedence, regardless of
 * binding order. Without a body, the schema values apply; a later body binding, including
 * `Body.empty`, replaces those fields according to its encoder.
 */
export const headers = <
  S extends Schema.ConstraintCodec<
    unknown,
    Transport.HeaderInput,
    unknown,
    unknown
  >,
>(
  contract: S,
) => {
  const encode = Schema.encodeEffect(contract);
  return <I, E, R, Q extends boolean>(
    self: Request<I, E, R, false, Q>,
  ): Request<
    I & { readonly headers: S["Type"] },
    E | Schema.SchemaError,
    R | S["EncodingServices"],
    true,
    Q
  > =>
    construct(
      { ...self.declaration, headers: [], headersBound: true },
      Effect.fnUntraced(function* (
        input: I & { readonly headers: S["Type"] },
        draft: Draft,
      ) {
        const encoded = yield* encode(input.headers);
        const prepared = yield* self.prepare(input, draft);
        const headerLines = Transport.entries(encoded);
        const merged = HttpClientRequest.setHeaders(
          prepared.request,
          Transport.toHeaders(headerLines),
        );
        // Compilation then drops the schema's lines for any body field whose value was kept.
        return {
          ...prepared,
          request:
            prepared.request.body._tag === "Empty"
              ? merged
              : HttpClientRequest.updateHeaders(merged, (fields) =>
                  keepBodyFields(fields, prepared.request.headers),
                ),
          headerLines,
        };
      }),
    );
};

/**
 * Bind a schema to the call's `{ query }` input.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const search = Request.get("https://api.example.test/users").pipe(
 *   Request.query(Schema.Struct({ page: Schema.NumberFromString })),
 * );
 * // Input: { query: { page: 2 } }; URL query: ?page=2
 * ```
 *
 * @remarks
 * The schema encodes to `UrlEncoding.QueryInput`. It replaces raw query declarations, including
 * the constructor's query string, and owns the group. Later raw setters or another query schema
 * are unavailable. Use {@link mapInput} to supply application defaults.
 */
export const query = <
  S extends Schema.ConstraintCodec<
    unknown,
    UrlEncoding.QueryInput,
    unknown,
    unknown
  >,
>(
  contract: S,
) => {
  const encode = Schema.encodeEffect(contract);
  return <I, E, R, H extends boolean>(
    self: Request<I, E, R, H, false>,
  ): Request<
    I & { readonly query: S["Type"] },
    E | Schema.SchemaError,
    R | S["EncodingServices"],
    H,
    true
  > =>
    construct(
      { ...self.declaration, query: [], queryBound: true },
      Effect.fnUntraced(function* (
        input: I & { readonly query: S["Type"] },
        draft: Draft,
      ) {
        const encoded = yield* encode(input.query);
        const prepared = yield* self.prepare(input, draft);
        return replaceQuery(prepared, UrlEncoding.queryEntries(encoded));
      }),
    );
};

/**
 * Bind a schema to `{ path }` input and render the complete request path.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const user = Request.get("").pipe(
 *   Request.baseUrl("https://api.example.test"),
 *   Request.path(Schema.NumberFromString, (id, encode) => `/users/${encode(id)}`),
 * );
 * // Input: { path: 42 }; URL: https://api.example.test/users/42
 * ```
 *
 * @remarks
 * The value under `path` has the schema's application type. A scalar schema takes a scalar;
 * `Schema.Struct({ userId: Schema.NumberFromString })` takes `{ userId: number }`. Use a struct
 * to name one path value or group several. Renderer parameter names do not affect the input type.
 *
 * The renderer receives the schema-encoded value and the active path-value encoder. Escape each
 * dynamic value with that encoder. The returned path replaces the constructor's path; it does
 * not append to it. The shared base URL is joined afterwards. Reuse renderer functions for
 * nested resources rather than stacking path bindings.
 * Renderer or path-encoding exceptions become {@link InvalidRequest}; schema failures remain
 * `SchemaError` values.
 */
export const path = <S extends Schema.Constraint>(
  contract: S,
  render: (value: S["Encoded"], encode: UrlEncoding.Service["path"]) => string,
) => {
  const encode = Schema.encodeEffect(contract);
  return <I, E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<
    I & { readonly path: S["Type"] },
    E | Schema.SchemaError | InvalidRequest,
    R | S["EncodingServices"],
    H,
    Q
  > =>
    construct(
      self.declaration,
      Effect.fnUntraced(function* (
        input: I & { readonly path: S["Type"] },
        draft: Draft,
      ) {
        const encoded = yield* encode(input.path);
        const encoding = yield* UrlEncoding.UrlEncoding;
        const prepared = yield* self.prepare(input, draft);
        const url = yield* Effect.try({
          try: () => render(encoded, encoding.path),
          catch: (cause) =>
            new InvalidRequest({
              message: "Failed to render the request path",
              cause,
            }),
        });
        return {
          ...prepared,
          request: HttpClientRequest.setUrl(prepared.request, url),
        };
      }),
    );
};

/**
 * Bind an encoder to the call's `{ body }` input.
 *
 * @remarks
 * The body is encoded once per operation evaluation. Its encoder determines `Content-Type` and
 * `Content-Length`; multipart metadata is supplied by the transport.
 */
export const body =
  <A, E2, R2>(codec: Body.Encoder<A, E2, R2>) =>
  <I, E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<I & { readonly body: A }, E | E2, R | R2, H, Q> =>
    construct(
      self.declaration,
      Effect.fnUntraced(function* (
        input: I & { readonly body: A },
        draft: Draft,
      ) {
        const encoded = yield* codec.encode(input.body);
        const prepared = yield* self.prepare(input, draft);
        return {
          ...prepared,
          request: HttpClientRequest.setBody(prepared.request, encoded),
        };
      }),
    );

/**
 * Adapt your application's argument to this request's required input.
 *
 * @remarks
 * Use it to rename fields or supply defaults while preserving schema validation. The mapping
 * runs during preparation; a thrown exception is a defect.
 */
export const mapInput =
  <I, I2>(f: (input: I2) => I) =>
  <E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<I2, E, R, H, Q> =>
    construct(self.declaration, (input, draft) =>
      Effect.suspend(() => self.prepare(f(input), draft)),
    );

/**
 * Edit the native request with an Effect during preparation.
 *
 * @remarks
 * Runs once per evaluation, before attempts, after preceding preparation steps. The base URL
 * and separate query parameters are not yet rendered. Use `Operation.make`'s `transformClient`
 * for per-attempt credentials or signing the materialized URL. Provider normalization still
 * applies afterwards.
 *
 * A transform can be reused on requests whose input contains what its function reads. Inline
 * callbacks in `pipe` infer their input from the request.
 */
export const mapEffect =
  <I, E2, R2>(
    f: (
      request: HttpClientRequest.HttpClientRequest,
      input: I,
    ) => Effect.Effect<HttpClientRequest.HttpClientRequest, E2, R2>,
  ) =>
  <E, R, H extends boolean, Q extends boolean, I2 extends I = I>(
    self: Request<I, E, R, H, Q> | Request<I2, E, R, H, Q>,
  ): Request<I2, E | E2, R | R2, H, Q> =>
    construct(self.declaration, (input: I2, draft) =>
      Effect.flatMap(self.prepare(input, draft), (prepared) =>
        Effect.map(f(prepared.request, input), (request) => ({
          ...prepared,
          request,
        })),
      ),
    );

/**
 * A prepared native request and the header lines a supporting provider can send.
 */
export interface Compiled {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly headerLines: Transport.Lines;
}

const initialDraft = (declaration: Declaration): Draft => {
  // Custom method strings pass through at runtime; the method union is narrower than the transport.
  const native = HttpClientRequest.make(
    declaration.method as HttpMethod.HttpMethod,
  )(declaration.url);
  const headerLines = Fields.resolve(declaration.headers);
  return replaceQuery(
    {
      request: HttpClientRequest.setHeaders(
        native,
        Transport.toHeaders(headerLines),
      ),
      headerLines,
      bareKeys: new Set(),
    },
    Fields.resolve(declaration.query),
  );
};

const finalize = (
  draft: Draft,
  base: string,
  encoding: UrlEncoding.Service,
): Compiled => {
  const { request } = draft;
  const url = encoding.join(base, request.url);
  const search = encoding.query(
    request.urlParams.params.map((param) => [
      param[0],
      draft.bareKeys.has(param)
        ? null
        : Redacted.isRedacted(param[1])
          ? Redacted.value(param[1])
          : param[1],
    ]),
  );
  const compiled = HttpClientRequest.makeWith(
    request.method,
    search === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${search}`,
    UrlParams.empty,
    request.hash,
    request.headers,
    request.body,
  );
  return {
    request: compiled,
    headerLines: Transport.reconcile(draft.headerLines, compiled.headers),
  };
};

/**
 * Prepare a request and its header lines without sending it.
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const result = await Effect.runPromise(
 *   Request.compile(Request.get("https://api.example.test/health"), undefined),
 * );
 * // result.request.url === "https://api.example.test/health"
 * ```
 *
 * @remarks
 * Each evaluation resolves computed fields and encodes input once. The returned Effect requires
 * any services used by the input schemas or preparation. Use {@link materialize} when only the
 * native request is needed.
 */
export const compile = Effect.fnUntraced(function* <
  I,
  E,
  R,
  H extends boolean,
  Q extends boolean,
>(
  self: Request<I, E, R, H, Q>,
  input: I,
): Effect.fn.Return<Compiled, E | InvalidRequest, R> {
  const encoding = yield* UrlEncoding.UrlEncoding;
  const initial = yield* Effect.try({
    try: () => initialDraft(self.declaration),
    catch: (cause) =>
      new InvalidRequest({
        message: "Failed to materialize request fields",
        cause,
      }),
  });
  const draft = yield* self.prepare(input, initial);
  const { method } = draft.request;
  if (
    (method === "GET" || method === "HEAD") &&
    draft.request.body._tag !== "Empty"
  ) {
    return yield* new InvalidRequest({
      message: `${method} cannot carry a request body`,
    });
  }
  return yield* Effect.try({
    try: () => finalize(draft, self.declaration.baseUrl, encoding),
    catch: (cause) =>
      new InvalidRequest({ message: "Failed to encode request URL", cause }),
  });
});

/**
 * Prepare only the native request, without sending it.
 *
 * @remarks
 * Use {@link compile} to retain the original header-line representation as well.
 */
export const materialize = <I, E, R, H extends boolean, Q extends boolean>(
  self: Request<I, E, R, H, Q>,
  input: I,
): Effect.Effect<HttpClientRequest.HttpClientRequest, E | InvalidRequest, R> =>
  Effect.map(compile(self, input), (compiled) => compiled.request);
