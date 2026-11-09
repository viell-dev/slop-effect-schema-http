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
import * as Groups from "./internal/group.js";
import * as Shapes from "./internal/shape.js";
import * as Transport from "./Transport.js";
import * as UrlEncoding from "./UrlEncoding.js";

/**
 * Request preparation failed before dispatch.
 *
 * @remarks
 * Covers computed-field failures, URL-rendering and {@link mapBaseUrl} exceptions, a path value
 * that does not encode to one value, and fields that do not fit the schemas bound to their group.
 * Schema failures of the caller's input remain separate `SchemaError` values.
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
 * Use with {@link setHeader}. A value is text or a function that supplies it, as in
 * {@link FieldValue}.
 */
export type HeaderFields = Readonly<Record<string, FieldValue | undefined>>;

/**
 * Query fields declared together: what a query schema may encode to, or a function.
 *
 * @remarks
 * Use with {@link setQuery}. Numbers, bigints and booleans become text, a `Date` becomes ISO text,
 * `null` is a bare key, an array repeats the name, and `undefined` removes the name's declarations.
 * A function supplies one such value during preparation, written the same way, and `undefined`
 * from it declares nothing, as in {@link FieldValue}. Fields apply in the object's key order, in
 * which JavaScript puts integer-like keys first.
 */
export type QueryFields = Readonly<
  Record<
    string,
    | UrlEncoding.QueryValue
    | ReadonlyArray<UrlEncoding.QueryValue>
    | (() => UrlEncoding.QueryValue)
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
 * encoded again, with no error. The type retains whole constructor and encoded input shapes,
 * including nested aliases in objects, lists, tuples and classes. Mixing by field stays one level
 * deep in the type; it does not recursively rebuild nested fields.
 * When both names of a renamed field are supplied, the decoded name still wins; give one name.
 *
 * A helper accepting `Input` must handle both shapes, including nested encoded names. A helper
 * meant for decoded names only should declare that input shape explicitly and can supply it through
 * a named input mapping. Retaining an opaque value's encoded type does not force encoded reading
 * of its contents: the schema's own reading and constructor priority still apply. Decoded contents
 * give an opaque value such as a `Schema.ReadonlyMap` a predictable decoded route.
 *
 * Stable plain root data, finite closed object/union names, a successful whole constructor and
 * strict encoding can establish an encoded-only field overwritten by a default after a typed
 * strict read failure. Additional whole decoding then validates that input. If the actual winning
 * route instead ends in fieldwise construction after failed whole decoding, at the root or through
 * root union members, the same successful strict output proof retains the original refusal. This
 * does not replay decoding or reconstruct input. Default and writer effects can run before refusal;
 * other constructor and decoder choices keep their existing priority.
 * Ambiguous names, open/opaque/class or suspended/iterable groups, inherited/accessor fields and
 * changing input remain outside this proof, as do later member-constructor and unsupported recovery
 * routes. Successful initial whole construction also permits a nested proof through finite closed,
 * untransformed objects, parent unions and dense array/tuple positions. Array indices/length must
 * be stable own data with ordinary/null prototype and matching original strict-output length.
 * Every declaring parent member must use the same field
 * schema; stable own-data links must reach the same encoded-only field actually written by the
 * original strict writer. Whole decoding can repeat checks/services, refuse valid mixed-side input
 * or give shared-type fields their encoded meaning. Construction is not replayed. Distinct field
 * declarations, sparse/accessor/inherited/subclass/custom-iterator/changing arrays, array-shaped
 * parent union members, opaque/suspended/transformed parents and unsupported member/fieldwise paths
 * remain outside this extension (issue #170). Use decoded names
 * or a validated decoded mapping there. The Request guide describes the bounds and migration.
 *
 * Under a union, a member that keeps every field wins over an earlier one that would strip one, on
 * both sides and at any depth. A field no member can keep beside the others is a `SchemaError` that
 * names it, because the types allow that value and any member would lose a field the schema states.
 * A key no member states is stripped, as a struct strips it, and so is a key the tag has ruled out.
 * A required literal tag can choose by its decoded or encoded name. Both views must rule a member
 * out before its fields go; a constructor default is not guessed to make that choice.
 * A key set to `undefined` is no field, and an accessor on a class is one, as it is to a struct. In a
 * header or query group, a field a schema stacked with the union takes is not lost. Inside text given
 * as text, a `Schema.ReadonlyMap`, a `Schema.Option` or a declaration with no struct behind it, the
 * schema's own reading applies.
 *
 * A direct closed struct can recover an otherwise-refused nested field through constructor-only
 * validation beside an opaque declaration. The original parent and output remain strictly
 * validated, and complete preservation is required. Already successful calls keep their original
 * path; new attempts can repeat effects or fail. Encoded-side recovery and unstable field evidence
 * remain outside this bounded route.
 */
export type Input<S extends Schema.Top> = Inputs.Input<S>;

/**
 * The whole input of a request: the object its call takes, assembled from its bindings.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const listThings = Request.get("https://api.example.test/things").pipe(
 *   Request.query(Schema.Struct({ sort: Schema.String })),
 *   Request.headers(Schema.Struct({ authorization: Schema.String })),
 * );
 * type ListInput = Request.InputOf<typeof listThings>;
 * const withToken = listThings.pipe(
 *   Request.mapInput(
 *     (input: Omit<ListInput, "headers">): ListInput => ({
 *       ...input,
 *       headers: { authorization: "Bearer token" },
 *     }),
 *   ),
 * );
 * // Input: { query: { sort: "name" } }
 * ```
 *
 * @remarks
 * This takes a request, and {@link Input} takes a schema. `Input` is what one binding takes, such
 * as the value under `query`, and this is the object that holds them all, which is what
 * {@link mapInput} has to return. A query or header key is optional when that binding's `Input`
 * accepts `{}`; stacked bindings intersect their contributions. `Operation.InputOf` gives the
 * same for an operation.
 */
export type InputOf<R> =
  R extends Request<infer I, unknown, unknown> ? I : never;

/**
 * The method, URL and raw fields from which request preparation starts.
 *
 * @remarks
 * This is a low-level extension type. Prefer {@link make} and the request combinators.
 */
export interface Declaration {
  /** The HTTP method, passed on as written. */
  readonly method: string;
  /** The constructor's path or URL, without its query and fragment. */
  readonly url: string;
  /** The fragment written in the constructor, without its `#`. */
  readonly hash: string | undefined;
  /**
   * The base URL as text, or an Effect that supplies it during preparation. The request's own error
   * and service types carry what that Effect needs. {@link mapBaseUrl} always leaves an Effect.
   */
  readonly baseUrl: string | Effect.Effect<string, unknown, unknown>;
  /** The raw header declarations, in order. */
  readonly headers: Fields.Fields;
  /** The raw query declarations, in order, including entries written in the constructor. */
  readonly query: Fields.Fields<string | null>;
  /** The constructor wrote a `?` with nothing after it, which holds no entries. */
  readonly emptyQuery: boolean;
  /** Lowercase header names the request removed, so the library adds no automatic value. */
  readonly removedHeaders: ReadonlySet<string>;
  /** The schemas bound to the header group, which together state its shape. */
  readonly headerShapes: ReadonlyArray<Shape>;
  /** The schemas bound to the query group, which together state its shape. */
  readonly queryShapes: ReadonlyArray<Shape>;
  /** Raw edits, after a schema, of a name it always writes, which could never reach the client. */
  readonly conflicts: ReadonlyArray<
    readonly [group: "query" | "headers", name: string]
  >;
}

/**
 * What one header or query schema says about its group: the names it allows, whether it allows
 * others, the names it always writes, and whether a union in it can lose a field.
 *
 * @remarks
 * This is a low-level extension type, read from the schema's encoded side and its fields' own
 * encodings when it is bound. Header names are lowercase.
 */
export type Shape = Shapes.Shape;

/**
 * What the schemas stacked on a group have told each other during preparation.
 *
 * @remarks
 * This is a low-level extension type. A field a union would lose is not lost if another schema in
 * the group took it, and `settled` is never an answer to that: a schema can allow a name it did not
 * take. Optional `certificates` records actual claims per applied binding, allowing a union to
 * replace its claim without removing another binding's evidence. Custom drafts with only `fields`
 * and `settled` keep the earlier behavior and skip union recovery.
 */
export type Taken = Shapes.Taken;

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
  /**
   * What the schemas stacked on the query group took from the caller, and which raw values are
   * theirs to settle. `undefined` where the group needs no record, because no stacked schema can lose
   * a field.
   */
  readonly takenQuery: Taken | undefined;
  /** The same for the header group, as in {@link takenQuery}. */
  readonly takenHeaders: Taken | undefined;
  /** Raw names edited after each binding, recorded before that binding prepares its input. */
  readonly editedFields: ReadonlyMap<Shape, ReadonlySet<string>>;
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
  /** What preparation starts from. */
  readonly declaration: Declaration;
  /** Apply the request's bindings and transforms to a draft, with the call's input. */
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

/** A written empty segment is text with no name, so it is not a field a schema could allow. */
const isEmptySegment = (draft: Draft, param: UrlParam): boolean =>
  draft.queryText.get(param) === "";

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
 * with {@link baseUrl}, and {@link path} adds to it, so `""` starts a path written whole in a
 * template. Custom method strings pass through unchanged.
 *
 * A constructor query is passed to the client as written until something edits that entry, so
 * `?a=1;b=2`, `?q=a+b` and `?a=%41` keep their spelling, as do empty `&` segments and a lone `?`.
 * Each entry also has a form-decoded name and value, which {@link setQuery} and {@link removeQuery}
 * compare against. An entry that is edited, or added, is rendered through `UrlEncoding.query`. An
 * entry under a name a {@link query} schema allows goes through that schema, and one under a name
 * no bound schema allows is an incompatible shape. A written empty segment has no name, so it is
 * not a field, and it stays as written.
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
 * Set the shared origin and fixed path prefix for a request, as text or from an Effect.
 *
 * @example
 * ```ts
 * import { Request } from "viell-effect-schema-http";
 * const api = Request.baseUrl("https://api.example.test/api/v1");
 * const users = Request.get("/users").pipe(api);
 * const teams = Request.get("/teams").pipe(api);
 * ```
 *
 * @example
 * ```ts
 * import { Context, Effect } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * class ApiHost extends Context.Service<ApiHost, string>()("app/ApiHost") {}
 * const discovered = Effect.gen(function* () {
 *   const host = yield* ApiHost;
 *   return `https://${host}/api/v1`;
 * });
 * const users = Request.get("/users").pipe(Request.baseUrl(discovered));
 * // The request needs ApiHost, as it would need any other service.
 * ```
 *
 * @remarks
 * The base is joined after path preparation. With the default URL policy, an absolute request
 * URL bypasses it; a leading `/` on a relative path keeps the base's prefix. Calling this again
 * replaces the base, rather than appending to it, and {@link mapBaseUrl} extends it. Keep query
 * fields in request combinators. A fragment in the base is taken off before joining and used if the
 * request has none of its own.
 *
 * An Effect supplies a location that is not known when the request is defined, from a service or a
 * `Config` value, say. Its failures and services join the request's type, so leaving out a service
 * is a compile error. It runs once per evaluation, after the input is encoded and before any
 * attempt, so every retry uses the same base. Its failure is returned as it is, before anything is
 * sent, and a retry policy does not repeat it. What it supplies is treated exactly as text would
 * be, including by a replaced `UrlEncoding.join`.
 *
 * A location that must change between attempts belongs in `Operation.make`'s `transformClient`. A
 * base that is replaced never runs, though the request's types keep what it added.
 */
export const baseUrl =
  <E2 = never, R2 = never>(url: string | Effect.Effect<string, E2, R2>) =>
  <I, E, R>(self: Request<I, E, R>): Request<I, E | E2, R | R2> =>
    construct({ ...self.declaration, baseUrl: url }, self.prepare);

/** A request's base URL as an Effect, whichever form it was declared in. */
const resolveBaseUrl = ({ baseUrl: url }: Declaration) =>
  typeof url === "string" ? Effect.succeed(url) : url;

/**
 * Change the base URL, whether it is text or an Effect, to extend a prefix or swap part of it.
 *
 * @example
 * ```ts
 * import { Request } from "viell-effect-schema-http";
 * const api = Request.baseUrl("https://api.example.test/api/v1");
 * const toAdmin = (url: string) => `${url}/admin`;
 * const admin = Request.mapBaseUrl(toAdmin);
 * const listUsers = Request.get("/users").pipe(api, admin);
 * // https://api.example.test/api/v1/admin/users
 * ```
 *
 * @remarks
 * Use it where a request holds a base you cannot read, as an imported definition does, or one that
 * is not known yet. `f` runs during preparation, once per evaluation, and receives the base as it
 * stands at this step, so `""` where none is set. That is the whole text, including any query or
 * fragment in it, and what `f` returns is joined exactly as a base from {@link baseUrl} would be. A
 * later {@link baseUrl} replaces the result. An exception from `f` is an {@link InvalidRequest}.
 */
export const mapBaseUrl =
  (f: (url: string) => string): Edit =>
  (self) =>
    construct(
      {
        ...self.declaration,
        baseUrl: Effect.flatMap(resolveBaseUrl(self.declaration), (url) =>
          Effect.try({
            try: () => f(url),
            catch: (cause) =>
              new InvalidRequest({
                message: "Failed to map the request's base URL",
                cause,
              }),
          }),
        ),
      },
      self.prepare,
    );

/** Header names compare without case; each line keeps the spelling it was given. */
const foldHeader: Fields.Fold = (name) => name.toLowerCase();

/** Query names compare exactly. */
const foldQuery: Fields.Fold = (name) => name;

/** A raw edit: a request's fields change, and its input, errors and services stay. */
type Edit = <I, E, R>(self: Request<I, E, R>) => Request<I, E, R>;

/** Copy provenance for this evaluation; a binding snapshots it before earlier steps run. */
const editing = (
  draft: Draft,
  shapes: ReadonlyArray<Shape>,
  names: ReadonlyArray<string>,
  fold: Fields.Fold,
): Draft =>
  shapes.length === 0
    ? draft
    : {
        ...draft,
        editedFields: new Map([
          ...draft.editedFields,
          ...shapes.map(
            (shape) =>
              [
                shape,
                new Set([
                  ...(draft.editedFields.get(shape) ?? []),
                  ...names.map(fold),
                ]),
              ] as const,
          ),
        ]),
      };

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
      (input, draft) =>
        self.prepare(
          input,
          editing(draft, self.declaration.headerShapes, edited, foldHeader),
        ),
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
      (input, draft) =>
        self.prepare(
          input,
          editing(draft, self.declaration.queryShapes, names, foldQuery),
        ),
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
 * A direct struct's schema-supplied optional field is also refused when this preparation
 * supplies and encodes it after the caller leaves it out, as {@link headers} describes.
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
 * A schema-supplied optional field can also put it back and be refused, as {@link headers}
 * describes.
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
 * Set a raw query field, replacing entries with the same case-sensitive name, or set several from
 * an object.
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
 * A direct struct's schema-supplied optional field is also refused when this preparation
 * supplies and encodes it after the caller leaves it out, as {@link query} describes.
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
              ? [() => UrlEncoding.queryEntries([[name, entry()]])[0]?.[1]]
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
 * Uses the same value rules as {@link setQuery}, and a bound {@link query} schema checks it the
 * same way.
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
 * A schema-supplied optional field can also put it back and be refused, as {@link query}
 * describes.
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
    message: `The ${group} group cannot be built against its schema with these declared values: ${listNames(defaults.map(([name]) => name))}.`,
  });

/** Names only, and only those that would go: what the schema kept fits it. */
const lostFields = (
  group: string,
  names: ReadonlyArray<string>,
): InvalidRequest =>
  new InvalidRequest({
    message: `The ${group} group cannot be built against its schema: with the rest of the group, these fields would be lost: ${listNames(names)}.`,
  });

/** Names only: schema preparation supplied the caller's omitted fields and wrote them. */
const preparationConflict = (group: string, names: ReadonlyArray<string>) =>
  new InvalidRequest({
    message: `Schema preparation supplied and wrote these omitted ${group} fields, so a later raw edit would be lost: ${listNames(names)}. Supply the value as input, set it with Request.mapInput, or use Request.unbind("${group}") first.`,
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

/** A query or header binding needs its key only when its input cannot be an empty object. */
type GroupInput<K extends "query" | "headers", A> =
  Record<never, never> extends A
    ? { readonly [P in K]?: A }
    : { readonly [P in K]: A };

/**
 * Bind a schema to the call's `{ headers }` input.
 *
 * @remarks
 * When {@link Input} accepts `{}`, the `headers` key is optional, as with an all-optional struct
 * or a union with one such member. An absent or `undefined` group is read as `{}` and still goes
 * through the schema, including its refinements and constructor defaults. Other explicit values,
 * including `null`, are validated as given. With exact optional property types, an explicit
 * `undefined` still has to fit `Input`. Stacked schemas allow omission only when each one does;
 * a raw default does not make a required group optional. The invocation object is still required.
 *
 * In a direct struct, schema preparation can supply an omitted optional field. A raw edit after
 * that binding is an {@link InvalidRequest} when successful preparation writes an own enumerable
 * data property with a non-`undefined` value under that name in a non-iterable record. This reads
 * the preparation's result without repeating schema work. A finite union of closed structs has
 * the same omission proof when no group node has an encoding. Transformed groups also qualify
 * when their decoded and encoded shapes are closed structs or finite unions of closed structs,
 * the ordinary or null-prototype caller object has no own keys of any kind and no endpoint name
 * exists on its prototype chain. Only an edited, declared encoded string name is checked.
 * Nonempty transformed groups, classes, open/suspended alternatives and iterable output remain
 * outside the additional proof.
 *
 * The input is an {@link Input} of the schema. Encoding produces ordered header lines. The schema
 * states the shape of the group, whatever the order of the calls: once any schema is bound, every
 * header the request declares must be a name some schema allows. A raw header under such a name
 * is a default: what the schema writes replaces it, and otherwise it goes through the schema,
 * which writes its value, spelling and order. An omitted optional field therefore leaves the
 * default in place. A raw header under a name no schema allows is an {@link InvalidRequest} before
 * anything is sent. A record or `Schema.StructWithRest` allows any name. Names compare without
 * case.
 *
 * Under a union, the defaults and what the schema wrote have to fit one member together. A field
 * that would be lost otherwise is an {@link InvalidRequest}, which names that field. The caller's
 * own value is read before that, as {@link Input} describes.
 *
 * Header schemas stack: a second one adds its fields, and together they state the shape. A field
 * one of them takes stays with it, whatever a union beside it leaves out. Use {@link unbind} to
 * start again.
 *
 * If an eligible anyOf union would otherwise refuse uncovered root fields, it can retry the whole
 * union with each member first, using the complete original input. Recovery needs actual sibling
 * claims for remaining losses and preserves every previously certified name. Annotations are kept;
 * union-parent checks, context and encoding, transformed/open/iterable members, nested losses and
 * joint backtracking are excluded. Successful reads do not retry. Recovery adds at most one
 * whole-union read per other member; those attempts can repeat schema effects and can fail.
 *
 * A field the schema produces wins over an automatic `Accept`, `Content-Type` or `Content-Length`,
 * whether the schema is bound before or after the body, and so does a default. An optional field
 * left out with no default declares nothing, so the automatic value still applies.
 *
 * Header values are text, so a schema writes its own. A query schema can encode to a `Date`, but
 * HTTP date headers are not ISO text, and `Schema.DateTimeUtcFromHttpDate` writes them.
 */
export const headers = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, Transport.HeaderInput, unknown, unknown>,
>(
  contract: S,
) => {
  const read = Inputs.reader(contract, Schema.encodeEffect(contract));
  const recover = Groups.recovery(contract);
  const { shape, settle, taken, candidates, filled } = Shapes.bind(
    contract,
    foldHeader,
  );
  return <I, E, R>(
    self: Request<I, E, R>,
  ): Request<
    I & GroupInput<"headers", Input<S>>,
    E | Schema.SchemaError | InvalidRequest,
    R | S["EncodingServices"] | S["DecodingServices"]
  > => {
    const token = {};
    return construct(
      {
        ...self.declaration,
        headerShapes: [...self.declaration.headerShapes, shape],
      },
      Effect.fnUntraced(function* (
        input: I & GroupInput<"headers", Input<S>>,
        draft: Draft,
      ) {
        if (draft.unbound.has("headers"))
          return yield* self.prepare(input, draft);
        const value = (
          input.headers === undefined ? {} : input.headers
        ) as Input<S>;
        const edited = candidates(value, draft.editedFields.get(shape));
        let { output, lost: lostFromInput } = yield* read(value);
        let conflicts = filled(edited, output);
        const own = draft.takenHeaders && taken(value, output, lostFromInput);
        let prepared = yield* self.prepare(
          input,
          own === undefined
            ? draft
            : {
                ...draft,
                takenHeaders: Shapes.taking(draft.takenHeaders, own, token),
              },
        );
        if (lostFromInput.length > 0) {
          const recovered = yield* recover(
            value,
            { output, lost: lostFromInput },
            prepared.takenHeaders,
            token,
            taken,
          );
          if (recovered !== undefined) {
            ({ output, lost: lostFromInput } = recovered.reading);
            conflicts = filled(edited, output);
            prepared = { ...prepared, takenHeaders: recovered.taken };
          }
          yield* Inputs.refuseLost(
            contract,
            lostFromInput,
            prepared.takenHeaders?.fields,
          );
        }
        if (conflicts.length > 0)
          return yield* preparationConflict("headers", conflicts);
        const names = Shapes.written(output, foldHeader);
        const elsewhere = Shapes.others(
          shape,
          prepared.takenHeaders,
          foldHeader,
        );
        const defaults = prepared.headerLines.filter(
          ([name]) =>
            !names.has(foldHeader(name)) &&
            !elsewhere.has(foldHeader(name)) &&
            Shapes.allows(shape, foldHeader(name)),
        );
        const settled = yield* Effect.mapError(settle(output, defaults), () =>
          misfit("header", defaults),
        );
        // A field the schema does not write back would be lost, as a union member can lose one.
        const lost = Shapes.lost(output, defaults, settled, foldHeader);
        if (lost.length > 0) return yield* lostFields("header", lost);
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
};

/**
 * Bind a schema to the call's `{ query }` input.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const search = Request.get("https://api.example.test/users").pipe(
 *   Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
 * );
 * // Input: { query: { page: 2 } }; URL query: ?page=2
 * ```
 *
 * @remarks
 * When {@link Input} accepts `{}`, the `query` key is optional, as with an all-optional struct
 * or a union with one such member. An absent or `undefined` group is read as `{}` and still goes
 * through the schema, including its refinements and constructor defaults. Other explicit values,
 * including `null`, are validated as given. With exact optional property types, an explicit
 * `undefined` still has to fit `Input`. Stacked schemas allow omission only when each one does;
 * a raw default does not make a required group optional. The invocation object is still required.
 *
 * In a direct struct, schema preparation can supply an omitted optional field. A raw edit after
 * that binding is an {@link InvalidRequest} when successful preparation writes an own enumerable
 * data property with a non-`undefined` value under that name in a non-iterable record. This reads
 * the preparation's result without repeating schema work. A finite union of closed structs has
 * the same omission proof when no group node has an encoding. Transformed groups also qualify
 * when their decoded and encoded shapes are closed structs or finite unions of closed structs,
 * the ordinary or null-prototype caller object has no own keys of any kind and no endpoint name
 * exists on its prototype chain. Only an edited, declared encoded string name is checked.
 * Nonempty transformed groups, classes, open/suspended alternatives and iterable output remain
 * outside the additional proof.
 *
 * The input is an {@link Input} of the schema. The schema encodes to `UrlEncoding.QueryInput` and
 * states the shape of the group, whatever the order of the calls: once any schema is bound, every
 * query field the request declares must be a name some schema allows. A raw entry under such a
 * name is a default, including one written in the constructor: what the schema writes replaces
 * it, and otherwise it goes through the schema, which writes its value and order. An omitted
 * optional field therefore leaves the default in place. A raw entry under a name no schema allows
 * is an {@link InvalidRequest} before anything is sent. A record, `Schema.StructWithRest` or a list
 * of pairs allows any name.
 *
 * Under a union, the defaults and what the schema wrote have to fit one member together. A field
 * that would be lost otherwise is an {@link InvalidRequest}, which names that field. The caller's
 * own value is read before that, as {@link Input} describes.
 *
 * A field can encode to a `Date`, which is written as ISO text. Text under a field that encodes to
 * a number, boolean, bigint or `Date` is read as one first, and a single value under a list field
 * fits it. Date text is read as `Schema.DateFromString` reads it. The check is as strict as the
 * schema. A `?` in a base URL or path output is text in the URL, not a field, so it is outside this
 * check.
 *
 * Query schemas stack: a second one adds its fields, and together they state the shape. A field one
 * of them takes stays with it, whatever a union beside it leaves out. Use {@link unbind} to start
 * again, and {@link mapInput} to supply a required field's value.
 *
 * If an eligible anyOf union would otherwise refuse uncovered root fields, it can retry the whole
 * union with each member first, using the complete original input. Recovery needs actual sibling
 * claims for remaining losses and preserves every previously certified name. Annotations are kept;
 * union-parent checks, context and encoding, transformed/open/iterable members, nested losses and
 * joint backtracking are excluded. Successful reads do not retry. Recovery adds at most one
 * whole-union read per other member; those attempts can repeat schema effects and can fail.
 */
export const query = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, UrlEncoding.QueryInput, unknown, unknown>,
>(
  contract: S,
) => {
  const read = Inputs.reader(contract, Schema.encodeEffect(contract));
  const recover = Groups.recovery(contract);
  const { shape, settle, taken, candidates, filled } = Shapes.bind(
    contract,
    foldQuery,
  );
  return <I, E, R>(
    self: Request<I, E, R>,
  ): Request<
    I & GroupInput<"query", Input<S>>,
    E | Schema.SchemaError | InvalidRequest,
    R | S["EncodingServices"] | S["DecodingServices"]
  > => {
    const token = {};
    return construct(
      {
        ...self.declaration,
        queryShapes: [...self.declaration.queryShapes, shape],
      },
      Effect.fnUntraced(function* (
        input: I & GroupInput<"query", Input<S>>,
        draft: Draft,
      ) {
        if (draft.unbound.has("query"))
          return yield* self.prepare(input, draft);
        const value = (
          input.query === undefined ? {} : input.query
        ) as Input<S>;
        const edited = candidates(value, draft.editedFields.get(shape));
        let { output, lost: lostFromInput } = yield* read(value);
        let conflicts = filled(edited, output);
        const own = draft.takenQuery && taken(value, output, lostFromInput);
        let prepared = yield* self.prepare(
          input,
          own === undefined
            ? draft
            : {
                ...draft,
                takenQuery: Shapes.taking(draft.takenQuery, own, token),
              },
        );
        if (lostFromInput.length > 0) {
          const recovered = yield* recover(
            value,
            { output, lost: lostFromInput },
            prepared.takenQuery,
            token,
            taken,
          );
          if (recovered !== undefined) {
            ({ output, lost: lostFromInput } = recovered.reading);
            conflicts = filled(edited, output);
            prepared = { ...prepared, takenQuery: recovered.taken };
          }
          yield* Inputs.refuseLost(
            contract,
            lostFromInput,
            prepared.takenQuery?.fields,
          );
        }
        if (conflicts.length > 0)
          return yield* preparationConflict("query", conflicts);
        const names = Shapes.written(output, foldQuery);
        const elsewhere = Shapes.others(shape, prepared.takenQuery, foldQuery);
        const defaults = prepared.request.urlParams.params
          .filter(
            (param) =>
              prepared.declaredQuery.has(param) &&
              !isEmptySegment(prepared, param) &&
              !names.has(param[0]) &&
              !elsewhere.has(param[0]) &&
              Shapes.allows(shape, param[0]),
          )
          .map((param) => [param[0], queryValue(prepared, param)] as const);
        const settled = yield* Effect.mapError(settle(output, defaults), () =>
          misfit("query", defaults),
        );
        // A field the schema does not write back would be lost, as a union member can lose one.
        const lost = Shapes.lost(output, defaults, settled, foldQuery);
        if (lost.length > 0) return yield* lostFields("query", lost);
        return replaceQuery(
          prepared,
          UrlEncoding.queryEntries(settled),
          new Set([...names, ...defaults.map(([name]) => name)]),
        );
      }),
    );
  };
};

/** A renderer: what to add to the path, from the encoded value and the path-value encoder. */
type PathRenderer<A> = (
  value: A,
  encode: UrlEncoding.Service["path"],
) => string;

/** Put text after the path so far, exactly as written. */
const extendPath = (draft: Draft, text: string): Draft => ({
  ...draft,
  request: HttpClientRequest.setUrl(
    draft.request,
    `${draft.request.url}${text}`,
  ),
});

/** Add to the path what `render` makes of the encoded `{ path }` input. */
const bindPath =
  <In, A, E2, R2>(
    encode: (input: In) => Effect.Effect<A, E2, R2>,
    render: PathRenderer<A>,
  ) =>
  <I, E, R>(
    self: Request<I, E, R>,
  ): Request<I & { readonly path: In }, E | E2 | InvalidRequest, R | R2> =>
    construct(
      self.declaration,
      Effect.fnUntraced(function* (
        input: I & { readonly path: In },
        draft: Draft,
      ) {
        if (draft.unbound.has("path")) return yield* self.prepare(input, draft);
        const encoded = yield* encode(input.path);
        const encoding = yield* UrlEncoding.UrlEncoding;
        const prepared = yield* self.prepare(input, draft);
        const added = yield* Effect.try({
          try: () => render(encoded, encoding.path),
          catch: (cause) =>
            new InvalidRequest({
              message: "Failed to render the request path",
              cause,
            }),
        });
        return extendPath(prepared, added);
      }),
    );

/** What a {@link PathValue}'s schema may encode to: one value with an obvious URL text. */
export type PathScalar = string | number | bigint | boolean;

/** A schema that encodes to one {@link PathScalar}, so its value fits in a path. */
export type PathSchema = Schema.Top &
  Schema.ConstraintCodec<unknown, PathScalar, unknown, unknown>;

/**
 * A named value for a {@link path} template.
 *
 * @remarks
 * Declare one with {@link pathValue}. `name` is its field under `path` in the input, and `schema` is
 * what checks and encodes it.
 */
export interface PathValue<
  K extends string = string,
  S extends PathSchema = PathSchema,
> {
  /** The value's field under `path` in the input. */
  readonly name: K;
  /** What checks and encodes the value. */
  readonly schema: S;
}

/**
 * Declare a named value for a {@link path} template.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const customer = Request.pathValue("customer");
 * const calendar = Request.pathValue("calendar", Schema.FiniteFromString);
 * const getCalendar = Request.get("").pipe(
 *   Request.path`/customers/${customer}/calendars/${calendar}`,
 * );
 * // Input: { path: { customer: "a/b", calendar: 7 } }
 * ```
 *
 * @remarks
 * The value arrives under its name in `{ path }`, and without a schema it is a string. A schema has
 * to encode to one {@link PathScalar}, and a value that gets past that type, as under `Schema.Any`,
 * is an {@link InvalidRequest}. The input is an {@link Input} of the schema, so it takes either side.
 * Declare a value once and reuse it across templates and definitions.
 */
export const pathValue: {
  <const K extends string>(name: K): PathValue<K, typeof Schema.String>;
  <const K extends string, S extends PathSchema>(
    name: K,
    schema: S,
  ): PathValue<K, S>;
} = (name: string, schema: PathSchema = Schema.String) =>
  ({ name, schema }) as never;

/** Add fixed text, which needs no input and cannot fail. */
const fixedPath =
  (text: string): Edit =>
  (self) =>
    construct(self.declaration, (input, draft) =>
      draft.unbound.has("path")
        ? self.prepare(input, draft)
        : Effect.map(self.prepare(input, draft), (prepared) =>
            extendPath(prepared, text),
          ),
    );

const isPathScalar = (value: unknown): value is PathScalar =>
  ["string", "number", "bigint", "boolean"].includes(typeof value);

/**
 * Read one value from a `{ path }` input and write it as text.
 *
 * @remarks
 * A struct takes the one field from a `path` that holds others, and names it in an error. An
 * optional key or `Schema.Any` gets past the type of {@link PathSchema}, so the value is checked
 * here rather than written as `undefined` or `[object Object]`.
 */
const pathValueEncoder = ({ name, schema }: PathValue) => {
  const contract = Schema.Struct({ [name]: schema });
  const encode = Inputs.encoder(contract, Schema.encodeEffect(contract));
  return (input: never) =>
    Effect.flatMap(encode(input), ({ [name]: value }) =>
      isPathScalar(value)
        ? Effect.succeed(String(value))
        : Effect.fail(
            new InvalidRequest({
              message: `The path value ${JSON.stringify(name)} did not encode to one value`,
            }),
          ),
    );
};

/** Bind a template: each value goes through its own schema, and its text stays as written. */
const templatePath = (
  text: TemplateStringsArray,
  values: ReadonlyArray<PathValue>,
) => {
  const encoders = values.map(pathValueEncoder);
  return encoders.length === 0
    ? fixedPath(text.raw[0]!)
    : bindPath(
        (input: never) => Effect.forEach(encoders, (encode) => encode(input)),
        (encoded, encode) =>
          encoded.reduce(
            (added, value, index) =>
              `${added}${encode(value)}${text.raw[index + 1]!}`,
            text.raw[0]!,
          ),
      );
};

const isTemplate = (
  value: TemplateStringsArray | Schema.Top,
): value is TemplateStringsArray => Array.isArray(value);

/** Bind a renderer: it receives its schema's encoded value and the path-value encoder. */
const renderedPath = <S extends Schema.Top>(
  contract: S,
  render: PathRenderer<S["Encoded"]>,
) => bindPath(Inputs.encoder(contract, Schema.encodeEffect(contract)), render);

/**
 * Add to the request's path, from a template or from a renderer.
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const customer = Request.pathValue("customer");
 * const calendar = Request.pathValue("calendar", Schema.FiniteFromString);
 * const getCalendar = Request.get("").pipe(
 *   Request.baseUrl("https://api.example.test/v1"),
 *   Request.path`/customers/${customer}/calendars/${calendar}`,
 * );
 * // Input: { path: { customer: "a/b", calendar: 7 } }
 * // URL: https://api.example.test/v1/customers/a%2Fb/calendars/7
 * ```
 *
 * @example
 * ```ts
 * import { Schema } from "effect";
 * import { Request } from "viell-effect-schema-http";
 * const listFolder = Request.get("/files").pipe(
 *   Request.path(Schema.String, (folder, encode) =>
 *     folder === "" ? "/" : `/${folder.split("/").map(encode).join("/")}/`,
 *   ),
 * );
 * // Input: { path: "a b/c" }; URL: /files/a%20b/c/
 * ```
 *
 * @remarks
 * The path is the constructor's path followed by what each `path` call adds, in order, joined
 * exactly as written. The library adds no `/` and removes none, so `/users` and `42` make
 * `/users42`, and `/users/` and `/42` make `/users//42`. The base URL is joined afterwards. A `?` or
 * `#` in the text is URL syntax, so a `#` starts the fragment for all that follows it. A fragment
 * moves to the compiled request's `hash`, so the query still goes before it. The result is passed
 * to the client as written, and the client may rewrite or refuse it.
 *
 * Use a template when the path has a fixed shape. Only a {@link pathValue} can go in one, so each
 * value has its schema and always goes through the active `UrlEncoding` path encoder, and a run-time
 * string is a compile error. A template with no values adds fixed text. The text is used as written
 * and never parsed, so a backslash is a backslash and not an escape. Stacked templates add their
 * fields to one `path` input, and a name used more than once gets the same value.
 *
 * Use a renderer when the shape of the path depends on the value, such as a value holding several
 * segments or a whole URL. It receives the schema-encoded value and the active path-value encoder,
 * and escaping each dynamic value is up to it. The value under `path` is an {@link Input} of the
 * schema, so a scalar schema takes a scalar and a struct takes its fields. A scalar is one value for
 * the whole `path`, so it does not stack with another scalar of a different type or with a template.
 *
 * Encoding does not make a value safe. A `/` in a value cannot add a segment, but `..` and an empty
 * string have nothing to encode, and the client may resolve a dot segment. Constrain a value from a
 * user in its schema.
 *
 * {@link unbind} removes what earlier calls added, and {@link setPath} replaces the constructor's
 * text. Renderer or path-encoding exceptions become {@link InvalidRequest}; schema failures remain
 * `SchemaError` values.
 */
export const path: {
  (text: TemplateStringsArray): Edit;
  <const V extends readonly [PathValue, ...ReadonlyArray<PathValue>]>(
    text: TemplateStringsArray,
    ...values: V
  ): <I, E, R>(
    self: Request<I, E, R>,
  ) => Request<
    I & {
      readonly path: {
        readonly [P in V[number] as P["name"]]: Input<P["schema"]>;
      };
    },
    E | Schema.SchemaError | InvalidRequest,
    | R
    | V[number]["schema"]["EncodingServices"]
    | V[number]["schema"]["DecodingServices"]
  >;
  <S extends Schema.Top>(
    contract: S,
    render: (
      value: S["Encoded"],
      encode: UrlEncoding.Service["path"],
    ) => string,
  ): <I, E, R>(
    self: Request<I, E, R>,
  ) => Request<
    I & { readonly path: Input<S> },
    E | Schema.SchemaError | InvalidRequest,
    R | S["EncodingServices"] | S["DecodingServices"]
  >;
} = (
  first: TemplateStringsArray | Schema.Top,
  ...rest: ReadonlyArray<PathValue> | readonly [PathRenderer<never>]
) =>
  (isTemplate(first)
    ? templatePath(first, rest as ReadonlyArray<PathValue>)
    : renderedPath(first, rest[0] as PathRenderer<unknown>)) as never;

/**
 * Replace the constructor's path, leaving every {@link path} binding in place.
 *
 * @example
 * ```ts
 * import { Request } from "viell-effect-schema-http";
 * const id = Request.pathValue("id");
 * const current = Request.get("/things").pipe(Request.path`/${id}`);
 * const legacy = current.pipe(Request.setPath("/legacy/things"));
 * // Input: { path: { id: "a" } }; URL: /legacy/things/a
 * ```
 *
 * @remarks
 * Only the path changes. A constructor's query and fragment stay, and a `?` or `#` in this text is
 * URL text, as it is in {@link path}. To replace a whole path, use {@link unbind} and this together.
 */
export const setPath =
  (url: string): Edit =>
  (self) =>
    construct({ ...self.declaration, url }, self.prepare);

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
 *   Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
 * );
 * const sorted = paged.pipe(
 *   Request.unbind("query"),
 *   Request.query(Schema.Struct({ sort: Schema.String })),
 * );
 * // Input: { query: { sort: "name" } }; URL query: ?sort=name
 * ```
 *
 * @remarks
 * Takes `"path"`, `"query"`, `"headers"` or `"body"`, and affects only bindings before it. To
 * replace a binding, unbind the group and bind again. Raw declarations stay, and go out unchecked
 * once no schema states the group's shape. A constructor path and query are declarations, so they
 * stay too. For `"path"`, the text of earlier {@link path} calls goes with their values, and
 * {@link setPath} is what changes the constructor's path.
 *
 * Other steps stay as well. A {@link mapEffect} finds the removed property `undefined`, and where
 * no other input is left the whole input is `undefined`, so reading the property there is a defect.
 * After {@link mapInput}, the binding is skipped, but the mapped input keeps whatever the mapping
 * requires. The request's error and service types keep what the removed bindings added.
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
 * runs during preparation; a thrown exception is a defect. It returns the request's whole input,
 * which {@link InputOf} names.
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
  /** The native request, with its URL and query joined. */
  readonly request: HttpClientRequest.HttpClientRequest;
  /** The header lines, in the spelling they were written with. */
  readonly headerLines: Transport.Lines;
  /** Lowercase header names the request removed, so the library adds no automatic value. */
  readonly removedHeaders: ReadonlySet<string>;
}

/** A record to start from where a schema in the group can lose a field to another one. */
const takenRecord = (shapes: ReadonlyArray<Shape>): Taken | undefined =>
  shapes.length > 1 && shapes.some(({ chooses }) => chooses)
    ? {
        fields: new Set(),
        certificates: new Map(),
        settled: new Set(
          shapes.flatMap(({ chooses, names }) =>
            chooses ? [] : Array.from(names),
          ),
        ),
      }
    : undefined;

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
      takenQuery: takenRecord(declaration.queryShapes),
      takenHeaders: takenRecord(declaration.headerShapes),
      editedFields: new Map(),
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
  baseText: string,
  encoding: UrlEncoding.Service,
): Compiled => {
  const { request } = draft;
  const [base, baseFragment] = splitFragment(baseText);
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
        draft.request.urlParams.params
          .filter((param) => !isEmptySegment(draft, param))
          .map(([name]) => name),
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
 * Each evaluation resolves computed fields, encodes input and resolves the base URL once, in that
 * order. The returned Effect requires any services used by the input schemas, preparation or the
 * base URL. A declared field that does not fit the schemas bound to its group fails here with
 * {@link InvalidRequest}, whatever the input. Use {@link materialize} when only the native request
 * is needed.
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
  // Only `baseUrl` and `mapBaseUrl` set an Effect, and what it needs is already in `E` and `R`.
  const baseText = yield* resolveBaseUrl(self.declaration) as Effect.Effect<
    string,
    E | InvalidRequest,
    R
  >;
  return yield* Effect.try({
    try: () => finalize(draft, self.declaration, baseText, encoding),
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
