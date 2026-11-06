import { Context, Layer } from "effect";

/**
 * Ordered decoded query entries, including repeated names.
 *
 * @remarks
 * `null` is a bare key (`?preview`); `""` is an empty value (`?preview=`).
 */
export type Query = ReadonlyArray<readonly [string, string | null]>;

/**
 * A scalar query value before conversion to URL text.
 *
 * @remarks
 * `null` keeps a bare key and `undefined` omits an entry. Other values are converted to strings.
 */
export type QueryValue = string | number | bigint | boolean | null | undefined;

/**
 * A record or iterable of query pairs accepted as a schema's encoded output.
 *
 * @remarks
 * Array values expand to repeated entries. Use ordered pairs to control order across names.
 */
export type QueryInput =
  | Readonly<Record<string, QueryValue | ReadonlyArray<QueryValue>>>
  | Iterable<readonly [string, QueryValue | ReadonlyArray<QueryValue>]>;

/**
 * Expand query input into ordered decoded entries, preserving repetitions.
 *
 * @example
 * ```ts
 * import { UrlEncoding } from "viell-effect-schema-http";
 * const entries = UrlEncoding.queryEntries({ tag: ["one", "two"], preview: null });
 * // [["tag", "one"], ["tag", "two"], ["preview", null]]
 * ```
 *
 * @remarks
 * Omits `undefined`, keeps `null`, and converts other scalar values to strings. URL escaping
 * happens later through the query renderer.
 */
export const queryEntries = (input: QueryInput): Query => {
  const entries =
    Symbol.iterator in input ? Array.from(input) : Object.entries(input);
  return entries.flatMap(
    ([key, value]): Array<readonly [string, string | null]> =>
      (Array.isArray(value) ? value : [value]).flatMap((entry: QueryValue) =>
        entry === undefined
          ? []
          : [[key, entry === null ? null : String(entry)] as const],
      ),
  );
};

/**
 * Functions that render path values, query entries and the final request URL.
 *
 * @remarks
 * The default policy is available without setup. Provide {@link layer} to replace it for a
 * service that needs another URL representation.
 */
export interface Service {
  /** Escape one dynamic path value; the renderer supplies separators between values. */
  readonly path: (value: string) => string;
  /**
   * Render ordered query entries without a leading `?`.
   *
   * @remarks
   * Text written in a request's constructor stays as written and is not passed here. Where it
   * stands between other entries, each run of them is rendered by a separate call, keeping the
   * order of the query. A request with no entries gets one call with an empty array.
   */
  readonly query: (entries: Query) => string;
  /**
   * Combine the base origin/prefix and the request's rendered path or absolute URL.
   *
   * @remarks
   * Both arrive without a fragment. A fragment in the result is moved after the query.
   */
  readonly join: (base: string, path: string) => string;
}

const absolute = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * Percent-encode path values and query fields, and join a base URL with a request path.
 *
 * @remarks
 * Uses `encodeURIComponent`, preserving bare keys, empty values, repetition and order.
 * An absolute request URL bypasses the base. Otherwise joining removes one boundary slash from
 * each side before inserting `/`. Dot segments and empty path values are not normalized here;
 * the HTTP provider's later URL processing may normalize them.
 */
export const defaults: Service = {
  path: encodeURIComponent,
  query: (entries) =>
    entries
      .map(([key, value]) =>
        value === null
          ? encodeURIComponent(key)
          : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&"),
  join: (base, path) => {
    if (base === "" || absolute.test(path)) return path;
    if (path === "") return base;
    return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  },
};

/**
 * The Effect context reference used to render request URLs.
 *
 * @remarks
 * Uses {@link defaults} unless replaced. The value is read during request preparation.
 */
export const UrlEncoding: Context.Reference<Service> =
  Context.Reference<Service>("viell-effect-schema-http/UrlEncoding", {
    defaultValue: () => defaults,
  });

/**
 * Supply an alternative URL-rendering policy through an Effect layer.
 *
 * @remarks
 * Provide it around request compilation or operation execution. Renderer exceptions become
 * `Request.InvalidRequest`. Provider URL processing still applies after library rendering.
 */
export const layer = (service: Service): Layer.Layer<never> =>
  Layer.succeed(UrlEncoding, service);
