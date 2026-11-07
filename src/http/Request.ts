import { Data, Effect, Option, Pipeable, Redacted, Schema } from "effect";
import {
  Headers,
  HttpClientRequest,
  type HttpMethod,
  UrlParams,
} from "effect/http";
import type * as Body from "./Body.js";
import * as Fields from "./internal/fields.js";
import * as Inputs from "./internal/input.js";
import * as Shapes from "./internal/shape.js";
import * as Transport from "./Transport.js";
import * as UrlEncoding from "./UrlEncoding.js";

/**
 * Request preparation failed before dispatch.
 *
 * @remarks
 * Covers computed-field failures, URL-rendering exceptions, and fields that do not fit the schemas
 * bound to their group. Schema failures of the caller's input remain separate `SchemaError` values.
 * A failed check of a group names its fields and leaves out their values, which may be credentials.
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
 * Headers declared together: a name's value, or `undefined` to remove its declarations.
 *
 * @remarks
 * Use with {@link setHeader}. A value is text or a function that supplies it, as in {@link FieldValue}.
 */
export type HeaderFields = Readonly<Record<string, FieldValue | undefined>>;

/**
 * Query fields declared together: what a query schema may encode to, or a function.
 *
 * @remarks
 * Use with {@link setQuery}. Numbers, bigints and booleans become text, `null` is a bare key, an
 * array repeats the name, and `undefined` removes the name's declarations. A function supplies its
 * value during preparation, as in {@link FieldValue}.
 */
export type QueryFields = Readonly<
  Record<
    string,
    | UrlEncoding.QueryValue
    | ReadonlyArray<UrlEncoding.QueryValue>
    | (() => string | null | undefined)
  >
>;

/**
 * What a schema-backed input takes: the schema's decoded side, its encoded side, or a mix by field.
 *
 * @remarks
 * The decoded side is what the schema's constructor takes, so a plain object works for a
 * `Schema.Class`, and a field with a constructor default can be left out. The encoded side is what
 * goes on the wire, and {@link path}, {@link query}, {@link headers} and the schema body encoders
 * all take it. The request always carries what the schema writes.
 *
 * Preparation tries the decoded side first, then the decoder as a whole, then the decoder field by
 * field. If all fail, it reports the decoded side's error, a `SchemaError` before dispatch. Both
 * routes validate, so text cannot get past a schema, but a weak schema lets more through:
 * `Schema.NumberFromString` turns `"many"` into `NaN`, and `Schema.FiniteFromString` refuses it.
 *
 * A value that fits the decoded side is read as decoded. Under a schema whose two sides share a
 * type, such as one from text to text, an already encoded value fits the decoded side, so it is
 * encoded again, with no error. A mix is one level deep in the type. Renamed fields take their
 * encoded names only when the whole value is on the encoded side.
 */
export type Input<S extends Schema.Top> = Inputs.Input<S>;

/**
 * The method, URL and raw fields from which request preparation starts.
 *
 * @remarks
 * This is a low-level extension type. Prefer {@link make} and the request combinators.
 */
export interface Declaration {
  readonly method: string;
  readonly url: string;
  /** The fragment written in the constructor, without its `#`. */
  readonly hash: string | undefined;
  readonly baseUrl: string;
  readonly headers: Fields.Fields;
  readonly query: Fields.Fields<string | null>;
  /** The constructor wrote a `?` with nothing after it, which holds no entries. */
  readonly emptyQuery: boolean;
  /** Lowercase header names the request removed, so the library adds no automatic value. */
  readonly removedHeaders: ReadonlySet<string>;
  /** The schemas bound to the header group, which together state its shape. */
  readonly headerShapes: ReadonlyArray<Shape>;
  /** The schemas bound to the query group, which together state its shape. */
  readonly queryShapes: ReadonlyArray<Shape>;
  /** Raw edits made after a schema of a name it always writes, which could never reach the client. */
  readonly conflicts: ReadonlyArray<
    readonly [group: "query" | "headers", name: string]
  >;
}

/**
 * What one header or query schema says about its group: the names it allows, whether it allows
 * others, and the names it always writes.
 *
 * @remarks
 * This is a low-level extension type, read from the schema's encoded side when it is bound. Header
 * names are lowercase.
 */
export type Shape = Shapes.Shape;

/** A part of a request that a binding can supply, and that {@link unbind} can clear. */
export type Group = "path" | "query" | "headers" | "body";

/**
 * One entry in Effect's native query collection.
 *
 * @remarks
 * Drafts use entry identity to distinguish bare keys from empty values, and to keep the text a
 * constructor entry was written with.
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
  /** Native query entries that keep their written text. Replacing an entry loses that text. */
  readonly queryText: ReadonlyMap<UrlParam, string>;
  /**
   * Native query entries the request declared, which a bound schema checks. A native edit makes a
   * new entry, so {@link mapEffect} stays outside the check.
   */
  readonly declaredQuery: ReadonlySet<UrlParam>;
  /** Lowercase header names the request removed, so the library adds no automatic value. */
  readonly removedHeaders: ReadonlySet<string>;
  /** The groups a later {@link unbind} cleared, so their earlier bindings skip themselves. */
  readonly unbound: ReadonlySet<Group>;
}

/**
 * An immutable HTTP request description with typed application input.
 *
 * @remarks
 * Construction sends nothing. {@link compile} prepares it; `Operation.make` prepares and sends it.
 * `I` is the complete input, `E` its preparation errors, and `R` its required services.
 * `declaration` and `prepare` are low-level extension points.
 */
export interface Request<in I, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly declaration: Declaration;
  readonly prepare: (input: I, draft: Draft) => Effect.Effect<Draft, E, R>;
}

const construct = <I, E, R>(
  declaration: Declaration,
  prepare: (input: I, draft: Draft) => Effect.Effect<Draft, E, R>,
): Request<I, E, R> => ({ ...Pipeable.Prototype, declaration, prepare });

/** Split URL text at its first `#`, which ends the path and query. */
const splitFragment = (url: string): readonly [string, string | undefined] => {
  const position = url.indexOf("#");
  return position < 0
    ? [url, undefined]
    : [url.slice(0, position), url.slice(position + 1)];
};

/** Read one written query segment as an entry that keeps its text. */
const readSegment = (segment: string): Fields.Field<string | null> => {
  // URLSearchParams strips one leading query marker; a marker in the key is data. An empty segment
  // yields no pair, so its name is the empty string.
  const [[key, value] = ["", ""]] = new URLSearchParams(`?${segment}`);
  return [key, segment.includes("=") ? value : null, segment];
};

/**
 * Describe a request with a method and URL, without sending it.
 *
 * @remarks
 * Use `undefined` as input until a binding adds required fields. A relative path can be combined
 * with {@link baseUrl}; {@link path} can supply the complete path from typed input.
 * Custom method strings pass through unchanged.
 *
 * A constructor query is passed to the client as written until something edits that entry, so
 * `?a=1;b=2`, `?q=a+b` and `?a=%41` keep their spelling, as do empty `&` segments and a lone `?`.
 * Each entry also has a form-decoded name and value, which {@link setQuery} and {@link removeQuery}
 * compare against. An entry that is edited, or added, is rendered through `UrlEncoding.query`. An
 * entry under a name a {@link query} schema allows goes through that schema, and one under a name no
 * bound schema allows is an incompatible shape. The name is the decoded name, so a written empty
 * segment counts as a field called `""`.
 *
 * A fragment stays on the request, exactly as written, in the native request's `hash` field. It
 * survives {@link path} and query edits, and wins over a fragment in path output or a base URL.
 * Whether it goes out is up to the client; `fetch` does not send one.
 */
export const make = (method: string, url: string): Request<unknown> => {
  const [withoutHash, hash] = splitFragment(url);
  const start = withoutHash.indexOf("?");
  const written = start < 0 ? "" : withoutHash.slice(start + 1);
  return construct(
    {
      method,
      url: start < 0 ? withoutHash : withoutHash.slice(0, start),
      hash,
      baseUrl: "",
      headers: [],
      query: written === "" ? [] : written.split("&").map(readSegment),
      emptyQuery: start >= 0 && written === "",
      removedHeaders: new Set(),
      headerShapes: [],
      queryShapes: [],
      conflicts: [],
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
 * Describe a HEAD request. A {@link body} is passed on as for any method; the client may refuse it.
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
 * A fragment in the base is taken off before joining and used if the request has none of its own.
 */
export const baseUrl =
  (url: string) =>
  <I, E, R>(self: Request<I, E, R>): Request<I, E, R> =>
    construct({ ...self.declaration, baseUrl: url }, self.prepare);

/** Header names compare without case; each line keeps the spelling it was given. */
const foldHeader: Fields.Fold = (name) => name.toLowerCase();

/** Query names compare exactly. */
const foldQuery: Fields.Fold = (name) => name;

/** A raw edit: a request's fields change, and its input, errors and services stay. */
type Edit = <I, E, R>(self: Request<I, E, R>) => Request<I, E, R>;

const editHeaders =
  (
    edited: ReadonlyArray<string>,
    edit: (fields: Fields.Fields) => Fields.Fields,
    removed: (names: ReadonlySet<string>) => ReadonlySet<string> = (names) =>
      names,
  ): Edit =>
  (self) =>
    construct(
      {
        ...self.declaration,
        headers: edit(self.declaration.headers),
        removedHeaders: removed(self.declaration.removedHeaders),
        conflicts: [
          ...self.declaration.conflicts,
          ...Shapes.required(
            edited,
            self.declaration.headerShapes,
            foldHeader,
          ).map((name) => ["headers", name] as const),
        ],
      },
      self.prepare,
    );

const editQuery =
  (
    names: ReadonlyArray<string>,
    edit: (
      fields: Fields.Fields<string | null>,
    ) => Fields.Fields<string | null>,
  ): Edit =>
  (self) =>
    construct(
      {
        ...self.declaration,
        query: edit(self.declaration.query),
        conflicts: [
          ...self.declaration.conflicts,
          ...Shapes.required(
            names,
            self.declaration.queryShapes,
            foldQuery,
          ).map((name) => ["query", name] as const),
        ],
      },
      self.prepare,
    );

/**
 * Set a raw header, replacing every existing line with that name, or set several from an object.
 *
 * @example
 * ```ts
 * import { Request } from "viell-effect-schema-http";
 * const request = Request.get("https://api.example.test/things").pipe(
 *   Request.setHeader("X-One", "1"),
 *   Request.setHeader({ "X-Two": "2", "X-Three": () => "3" }),
 * );
 * ```
 *
 * @remarks
 * Names compare without case, and the new line keeps the spelling of this call. A declared
 * `Accept`, `Content-Type` or `Content-Length` replaces the automatic value, before or after the
 * body.
 *
 * With a {@link headers} schema bound, in either order, the name has to be one a schema allows, and
 * the value is a default that goes through the schema. Setting a name the schema always writes,
 * after that schema, is an {@link InvalidRequest}, because the value could never reach the client.
 *
 * In the object form each key replaces its name as above, in key order, and other names stay. A key
 * set to `undefined` removes that name's declarations and stops no automatic value, which is what
 * {@link removeHeader} is for.
 */
export const setHeader: {
  (name: string, value: FieldValue): Edit;
  (fields: HeaderFields): Edit;
} = (first: string | HeaderFields, value?: FieldValue) => {
  const entries =
    typeof first === "string"
      ? [[first, value] as const]
      : Object.entries(first);
  return editHeaders(
    entries.map(([name]) => name),
    (fields) =>
      entries.reduce(
        (result, [name, entry]) =>
          Fields.replace(
            result,
            name,
            entry === undefined ? [] : [entry],
            foldHeader,
          ),
        fields,
      ),
  );
};

/**
 * Add a raw header line after the existing lines, preserving repetition.
 *
 * @remarks
 * Each line keeps the spelling of its call. A bound {@link headers} schema checks it as it does
 * {@link setHeader}. Sending separate lines requires a provider that supports them; Fetch may
 * combine or restrict headers.
 */
export const appendHeader = (name: string, value: FieldValue) =>
  editHeaders([name], (fields) => Fields.append(fields, name, value));

/**
 * Remove a raw header, or only its declarations with the supplied fixed value.
 *
 * @remarks
 * Names compare without case. Value functions are never evaluated to compare with `value`. Removing
 * a name a {@link headers} schema always writes, after that schema, is an {@link InvalidRequest},
 * because the schema puts the value back. Removing an optional field clears its default.
 *
 * Without a value, this also stops the library's automatic value for that name: an operation's
 * `Accept`, or a body's `Content-Type` and `Content-Length`. It stops only that. A value that a
 * later declaration, a header schema or {@link mapEffect} supplies still goes out, and the client
 * may add its own. A computed value that returns `undefined` declares nothing, so the removal stays
 * in force. A removal limited to one value stops nothing, as the name may still be declared.
 */
export const removeHeader = (name: string, value?: string) =>
  editHeaders(
    [name],
    (fields) => Fields.remove(fields, name, value, foldHeader),
    (names) =>
      value === undefined ? new Set([...names, foldHeader(name)]) : names,
  );

/**
 * Set a raw query field, replacing entries with the same case-sensitive name, or set several from an
 * object.
 *
 * @example
 * ```ts
 * import { Request } from "viell-effect-schema-http";
 * const search = Request.get("https://api.example.test/users").pipe(
 *   Request.setQuery({ page: 2, tag: ["a", "b"], preview: null }),
 * );
 * // URL query: ?page=2&tag=a&tag=b&preview
 * ```
 *
 * @remarks
 * `null` produces a bare key, `""` an empty value, and `undefined` omits the entry. Names compare
 * with an entry's decoded name, so this can replace an entry written in the constructor; other
 * entries stay as written.
 *
 * With a {@link query} schema bound, in either order, the name has to be one a schema allows, and
 * the value is a default that goes through the schema. Setting a name the schema always writes,
 * after that schema, is an {@link InvalidRequest}, because the value could never reach the client.
 *
 * The object form takes {@link QueryFields}. Each key replaces its name as above, in key order, and
 * other names stay. Use {@link appendQuery} for exact order across repeated names.
 */
export const setQuery: {
  (name: string, value: FieldValue<string | null>): Edit;
  (fields: QueryFields): Edit;
} = (first: string | QueryFields, value?: FieldValue<string | null>) => {
  const entries: ReadonlyArray<readonly [string, QueryFields[string]]> =
    typeof first === "string" ? [[first, value]] : Object.entries(first);
  return editQuery(
    entries.map(([name]) => name),
    (fields) =>
      entries.reduce(
        (result, [name, entry]) =>
          Fields.replace(
            result,
            name,
            typeof entry === "function"
              ? [entry]
              : UrlEncoding.queryEntries([[name, entry]]).map(
                  ([, text]) => text,
                ),
          ),
        fields,
      ),
  );
};

/**
 * Append a raw query entry, preserving order and repeated names.
 *
 * @remarks
 * Uses the same value rules as {@link setQuery}, and a bound {@link query} schema checks it the same
 * way.
 */
export const appendQuery = (name: string, value: FieldValue<string | null>) =>
  editQuery([name], (fields) => Fields.append(fields, name, value));

/**
 * Remove a raw query field, or only declarations with the supplied fixed value.
 *
 * @remarks
 * Names compare with case, and both names and values compare with an entry's decoded form. Value
 * functions are not evaluated for comparison. Removing a name a {@link query} schema always writes,
 * after that schema, is an {@link InvalidRequest}, because the schema puts the value back. Removing
 * an optional field clears its default.
 */
export const removeQuery = (name: string, value?: string | null) =>
  editQuery([name], (fields) => Fields.remove(fields, name, value));

/** Put entries after the existing ones, in place of every entry under the `keys` names. */
const replaceQuery = (
  draft: Draft,
  entries: ReadonlyArray<
    readonly [string, string | null, written?: string | undefined]
  >,
  keys: ReadonlySet<string> = new Set(entries.map(([key]) => key)),
): Draft => {
  const added = entries.map(([key, value]): UrlParam => [key, value ?? ""]);
  const bareKeys = new Set(
    Array.from(draft.bareKeys).filter(([key]) => !keys.has(key)),
  );
  const queryText = new Map(
    Array.from(draft.queryText).filter(([[key]]) => !keys.has(key)),
  );
  const declaredQuery = new Set([
    ...Array.from(draft.declaredQuery).filter(([key]) => !keys.has(key)),
    ...added,
  ]);
  entries.forEach(([, value, written], index) => {
    if (value === null) bareKeys.add(added[index]!);
    if (written !== undefined) queryText.set(added[index]!, written);
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
    queryText,
    declaredQuery,
  };
};

/** What a native query entry holds: text, or `null` for a bare key. */
const queryValue = (draft: Draft, param: UrlParam): string | null =>
  draft.bareKeys.has(param)
    ? null
    : Redacted.isRedacted(param[1])
      ? Redacted.value(param[1])
      : param[1];

const listNames = (names: ReadonlyArray<string>): string =>
  Array.from(new Set(names), (name) => JSON.stringify(name)).join(", ");

/** Names only: a default's value may be a credential, and a schema's error would repeat it. */
const misfit = (
  group: string,
  defaults: ReadonlyArray<readonly [string, unknown]>,
): InvalidRequest =>
  new InvalidRequest({
    message: `These declared ${group} values do not fit the schema bound to that group: ${listNames(defaults.map(([name]) => name))}.`,
  });

/** Fields a body's encoder supplies unless the request says otherwise. */
const bodyFields = ["content-type", "content-length"] as const;

/** After an encoder set the body fields, apply what the request itself says about them. */
const applyDeclaredBodyFields = (
  encoded: HttpClientRequest.HttpClientRequest,
  prepared: Draft,
): HttpClientRequest.HttpClientRequest => {
  const declared = Transport.toHeaders(prepared.headerLines);
  return HttpClientRequest.updateHeaders(encoded, (fields) =>
    bodyFields.reduce((result, name) => {
      const value =
        declared[name] ??
        (prepared.removedHeaders.has(name)
          ? prepared.request.headers[name]
          : result[name]);
      return value === undefined
        ? Headers.remove(result, name)
        : Headers.set(result, name, value);
    }, fields),
  );
};

/**
 * Bind a schema to the call's `{ headers }` input.
 *
 * @remarks
 * The input is an {@link Input} of the schema. Encoding produces ordered header lines. The schema states the shape of the group, whatever the
 * order of the calls. A raw header under a name it allows is a default: what the schema writes
 * replaces it, and otherwise it goes through the schema, which writes its value, spelling and order.
 * An omitted optional field therefore leaves the default in place. A raw header under a name no
 * schema allows is an {@link InvalidRequest} before anything is sent. A record or
 * `Schema.StructWithRest` allows any name. Names compare without case.
 *
 * Header schemas stack: a second one adds its fields, and together they state the shape. Use
 * {@link unbind} to start again.
 *
 * A field the schema produces wins over an automatic `Accept`, `Content-Type` or `Content-Length`,
 * whether the schema is bound before or after the body. An optional field the caller leaves out
 * declares nothing, so the automatic value still applies.
 */
export const headers = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, Transport.HeaderInput, unknown, unknown>,
>(
  contract: S,
) => {
  const encode = Inputs.encoder(contract, Schema.encodeEffect(contract));
  const { shape, settle } = Shapes.bind(contract, foldHeader);
  return <I, E, R>(
    self: Request<I, E, R>,
  ): Request<
    I & { readonly headers: Input<S> },
    E | Schema.SchemaError | InvalidRequest,
    R | S["EncodingServices"] | S["DecodingServices"]
  > =>
    construct(
      {
        ...self.declaration,
        headerShapes: [...self.declaration.headerShapes, shape],
      },
      Effect.fnUntraced(function* (
        input: I & { readonly headers: Input<S> },
        draft: Draft,
      ) {
        if (draft.unbound.has("headers"))
          return yield* self.prepare(input, draft);
        const output = yield* encode(input.headers);
        const prepared = yield* self.prepare(input, draft);
        const names = Shapes.written(output, foldHeader);
        const defaults = prepared.headerLines.filter(
          ([name]) =>
            !names.has(foldHeader(name)) &&
            Shapes.allows(shape, foldHeader(name)),
        );
        const settled = yield* Effect.mapError(settle(output, defaults), () =>
          misfit("header", defaults),
        );
        const lines = Transport.entries(settled);
        const replaced = new Set([
          ...names,
          ...defaults.map(([name]) => foldHeader(name)),
        ]);
        const cleared = HttpClientRequest.updateHeaders(
          prepared.request,
          (fields) =>
            prepared.headerLines
              .map(([name]) => foldHeader(name))
              .filter((name) => replaced.has(name))
              .reduce((result, name) => Headers.remove(result, name), fields),
        );
        return {
          ...prepared,
          request: HttpClientRequest.setHeaders(
            cleared,
            Transport.toHeaders(lines),
          ),
          headerLines: [
            ...prepared.headerLines.filter(
              ([name]) => !replaced.has(foldHeader(name)),
            ),
            ...lines,
          ],
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
 * The input is an {@link Input} of the schema. The schema encodes to `UrlEncoding.QueryInput` and states the shape of the group, whatever the
 * order of the calls. A raw entry under a name it allows is a default, including one written in the
 * constructor: what the schema writes replaces it, and otherwise it goes through the schema, which
 * writes its value and order. An omitted optional field therefore leaves the default in place. A
 * raw entry under a name no schema allows is an {@link InvalidRequest} before anything is sent. A
 * record, `Schema.StructWithRest` or a list of pairs allows any name.
 *
 * Text under a field that encodes to a number, boolean or bigint is read as one first, and a single
 * value under a list field fits it. The check is as strict as the schema. A `?` in a base URL or
 * path output is text in the URL, not a field, so it is outside this check.
 *
 * Query schemas stack: a second one adds its fields, and together they state the shape. Use
 * {@link unbind} to start again, and {@link mapInput} to supply a required field's value.
 */
export const query = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, UrlEncoding.QueryInput, unknown, unknown>,
>(
  contract: S,
) => {
  const encode = Inputs.encoder(contract, Schema.encodeEffect(contract));
  const { shape, settle } = Shapes.bind(contract, foldQuery);
  return <I, E, R>(
    self: Request<I, E, R>,
  ): Request<
    I & { readonly query: Input<S> },
    E | Schema.SchemaError | InvalidRequest,
    R | S["EncodingServices"] | S["DecodingServices"]
  > =>
    construct(
      {
        ...self.declaration,
        queryShapes: [...self.declaration.queryShapes, shape],
      },
      Effect.fnUntraced(function* (
        input: I & { readonly query: Input<S> },
        draft: Draft,
      ) {
        if (draft.unbound.has("query"))
          return yield* self.prepare(input, draft);
        const output = yield* encode(input.query);
        const prepared = yield* self.prepare(input, draft);
        const names = Shapes.written(output, foldQuery);
        const defaults = prepared.request.urlParams.params
          .filter(
            (param) =>
              prepared.declaredQuery.has(param) &&
              !names.has(param[0]) &&
              Shapes.allows(shape, param[0]),
          )
          .map((param) => [param[0], queryValue(prepared, param)] as const);
        const settled = yield* Effect.mapError(settle(output, defaults), () =>
          misfit("query", defaults),
        );
        return replaceQuery(
          prepared,
          UrlEncoding.queryEntries(settled),
          new Set([...names, ...defaults.map(([name]) => name)]),
        );
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
 * The value under `path` is an {@link Input} of the schema. A scalar schema takes a scalar;
 * `Schema.Struct({ userId: Schema.NumberFromString })` takes `{ userId: 42 }` or
 * `{ userId: "42" }`. Use a struct to name one path value or group several. Renderer parameter
 * names do not affect the input type.
 *
 * The renderer receives the schema-encoded value and the active path-value encoder. Escape each
 * dynamic value with that encoder. The returned path replaces the constructor's path; it does
 * not append to it. The shared base URL is joined afterwards. Reuse renderer functions for
 * nested resources rather than stacking path bindings. A fragment in the returned path moves to
 * the compiled request's `hash`, so the query still goes before it.
 * Renderer or path-encoding exceptions become {@link InvalidRequest}; schema failures remain
 * `SchemaError` values.
 */
export const path = <S extends Schema.Top>(
  contract: S,
  render: (value: S["Encoded"], encode: UrlEncoding.Service["path"]) => string,
) => {
  const encode = Inputs.encoder(contract, Schema.encodeEffect(contract));
  return <I, E, R>(
    self: Request<I, E, R>,
  ): Request<
    I & { readonly path: Input<S> },
    E | Schema.SchemaError | InvalidRequest,
    R | S["EncodingServices"] | S["DecodingServices"]
  > =>
    construct(
      self.declaration,
      Effect.fnUntraced(function* (
        input: I & { readonly path: Input<S> },
        draft: Draft,
      ) {
        if (draft.unbound.has("path")) return yield* self.prepare(input, draft);
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
 * The body is encoded once per operation evaluation. Its encoder supplies `Content-Type` and
 * `Content-Length`; multipart metadata is supplied by the transport. A value the request declares
 * for either field wins, before or after this binding, and {@link removeHeader} stops the automatic
 * value. Neither changes the encoded bytes.
 *
 * Any method can carry a body, and the library adds no check of its own. A client can refuse the
 * request: `fetch` does so for GET and HEAD, which surfaces as a transport failure.
 */
export const body =
  <A, E2, R2>(codec: Body.Encoder<A, E2, R2>) =>
  <I, E, R>(
    self: Request<I, E, R>,
  ): Request<I & { readonly body: A }, E | E2, R | R2> =>
    construct(
      self.declaration,
      Effect.fnUntraced(function* (
        input: I & { readonly body: A },
        draft: Draft,
      ) {
        if (draft.unbound.has("body")) return yield* self.prepare(input, draft);
        const encoded = yield* codec.encode(input.body);
        const prepared = yield* self.prepare(input, draft);
        return {
          ...prepared,
          request: applyDeclaredBodyFields(
            HttpClientRequest.setBody(prepared.request, encoded),
            prepared,
          ),
        };
      }),
    );

/**
 * A request's input once {@link unbind} has cleared a group: the same, without that property.
 *
 * @remarks
 * An input left with no properties becomes `unknown`, so `undefined` satisfies it.
 */
export type Unbound<I, K extends Group> = K extends keyof I
  ? [keyof Omit<I, K>] extends [never]
    ? unknown
    : Omit<I, K>
  : I;

/**
 * Remove a group's earlier bindings, their input and the shape they state.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const paged = Request.get("https://api.example.test/things").pipe(
 *   Request.query(Schema.Struct({ page: Schema.NumberFromString })),
 * );
 * const sorted = paged.pipe(
 *   Request.unbind("query"),
 *   Request.query(Schema.Struct({ sort: Schema.String })),
 * );
 * // Input: { query: { sort: "name" } }; URL query: ?sort=name
 * ```
 *
 * @remarks
 * Takes `"path"`, `"query"`, `"headers"` or `"body"`, and affects only bindings before it. To replace
 * a binding, unbind the group and bind again. Raw declarations stay, and go out unchecked once no
 * schema states the group's shape. A constructor path and query are declarations, so they stay too.
 *
 * Other steps stay as well. A {@link mapEffect} that reads the removed input receives `undefined`
 * for it. After {@link mapInput}, the binding is skipped, but the mapped input keeps whatever the
 * mapping requires. The request's error and service types keep what the removed bindings added.
 */
export const unbind =
  <K extends Group>(group: K) =>
  <I, E, R>(self: Request<I, E, R>): Request<Unbound<I, K>, E, R> =>
    construct(
      {
        ...self.declaration,
        headerShapes: group === "headers" ? [] : self.declaration.headerShapes,
        queryShapes: group === "query" ? [] : self.declaration.queryShapes,
        conflicts: self.declaration.conflicts.filter(
          ([owner]) => owner !== group,
        ),
      },
      (input, draft) =>
        self.prepare(input as I, {
          ...draft,
          unbound: new Set([...draft.unbound, group]),
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
  <E, R>(self: Request<I, E, R>): Request<I2, E, R> =>
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
 * callbacks in `pipe` infer their input from the request. This is the deliberate way around a
 * group's schemas: what it edits on the native request is outside their check.
 */
export const mapEffect =
  <I, E2, R2>(
    f: (
      request: HttpClientRequest.HttpClientRequest,
      input: I,
    ) => Effect.Effect<HttpClientRequest.HttpClientRequest, E2, R2>,
  ) =>
  <E, R, I2 extends I = I>(
    self: Request<I, E, R> | Request<I2, E, R>,
  ): Request<I2, E | E2, R | R2> =>
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
 *
 * @remarks
 * `request.url` holds the joined URL and its query. A fragment is in `request.hash`, as written.
 */
export interface Compiled {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly headerLines: Transport.Lines;
  /** Lowercase header names the request removed, so the library adds no automatic value. */
  readonly removedHeaders: ReadonlySet<string>;
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
        // An empty fragment counts, and the options of `make` would skip it.
        declaration.hash === undefined
          ? native
          : HttpClientRequest.setHash(native, declaration.hash),
        Transport.toHeaders(headerLines),
      ),
      headerLines,
      bareKeys: new Set(),
      queryText: new Map(),
      declaredQuery: new Set(),
      removedHeaders: declaration.removedHeaders,
      unbound: new Set(),
    },
    declaration.query.flatMap((field) =>
      Fields.resolve([field]).map(
        ([key, value]) => [key, value, field[2]] as const,
      ),
    ),
  );
};

/**
 * Render query entries in order. Written text stays as it is, and each run of entries between it
 * goes through the encoder. With no entries at all, the encoder still has its say.
 */
const renderQuery = (draft: Draft, encoding: UrlEncoding.Service): string => {
  const parts: Array<string> = [];
  let run: Array<readonly [string, string | null]> = [];
  const endRun = () => {
    const rendered = run.length === 0 ? "" : encoding.query(run);
    if (rendered !== "") parts.push(rendered);
    run = [];
  };
  for (const param of draft.request.urlParams.params) {
    const written = draft.queryText.get(param);
    if (written !== undefined) {
      endRun();
      parts.push(written);
    } else {
      run.push([param[0], queryValue(draft, param)]);
    }
  }
  endRun();
  return parts.length === 0 ? encoding.query([]) : parts.join("&");
};

const finalize = (
  draft: Draft,
  declaration: Declaration,
  encoding: UrlEncoding.Service,
): Compiled => {
  const { request } = draft;
  const [base, baseFragment] = splitFragment(declaration.baseUrl);
  const [target, targetFragment] = splitFragment(request.url);
  const [url, joinFragment] = splitFragment(encoding.join(base, target));
  const search = renderQuery(draft, encoding);
  const separator = url.includes("?") ? "&" : "?";
  const compiled = HttpClientRequest.makeWith(
    request.method,
    search !== ""
      ? `${url}${separator}${search}`
      : declaration.emptyQuery && separator === "?"
        ? `${url}?`
        : url,
    UrlParams.empty,
    Option.orElse(request.hash, () =>
      Option.fromUndefinedOr(targetFragment ?? baseFragment ?? joinFragment),
    ),
    request.headers,
    request.body,
  );
  return {
    request: compiled,
    headerLines: Transport.reconcile(draft.headerLines, compiled.headers),
    removedHeaders: draft.removedHeaders,
  };
};

/** Why a request's fields cannot be built against their schemas, by name and never by value. */
const fieldProblems = (
  declaration: Declaration,
  draft: Draft,
): ReadonlyArray<string> =>
  (
    [
      [
        "query",
        draft.request.urlParams.params.map(([name]) => name),
        declaration.queryShapes,
        foldQuery,
      ],
      [
        "headers",
        draft.headerLines.map(([name]) => name),
        declaration.headerShapes,
        foldHeader,
      ],
    ] as const
  ).flatMap(([group, names, shapes, fold]) => {
    const conflicts = declaration.conflicts
      .filter(([owner]) => owner === group)
      .map(([, name]) => name);
    const stray = Shapes.outside(names, shapes, fold);
    return [
      ...(conflicts.length === 0
        ? []
        : [
            `A schema bound to the ${group} group always writes these names, so a raw edit could never reach the client: ${listNames(conflicts)}. Supply the value as input, set it with Request.mapInput, or use Request.unbind("${group}") first.`,
          ]),
      ...(stray.length === 0
        ? []
        : [
            `No schema bound to the ${group} group allows these declared names: ${listNames(stray)}. Add them to a schema, remove them, or use Request.unbind("${group}") first.`,
          ]),
    ];
  });

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
 * any services used by the input schemas or preparation. A declared field that does not fit the
 * schemas bound to its group fails here with {@link InvalidRequest}, whatever the input. Use
 * {@link materialize} when only the native request is needed.
 */
export const compile = Effect.fnUntraced(function* <I, E, R>(
  self: Request<I, E, R>,
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
  const problems = fieldProblems(self.declaration, initial);
  if (problems.length > 0)
    return yield* new InvalidRequest({ message: problems.join(" ") });
  const draft = yield* self.prepare(input, initial);
  return yield* Effect.try({
    try: () => finalize(draft, self.declaration, encoding),
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
export const materialize = <I, E, R>(
  self: Request<I, E, R>,
  input: I,
): Effect.Effect<HttpClientRequest.HttpClientRequest, E | InvalidRequest, R> =>
  Effect.map(compile(self, input), (compiled) => compiled.request);
