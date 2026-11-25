/**
 * Route tables, written as the host builds them. Each condition is named after the function of
 * `warded` it calls (`get`, `path`, `header_eq`, `Offers::selected`, …), so a table reads as the
 * Rust it stands for; `host/src/condition.rs` turns it into those calls.
 */

export type Condition =
  | {
      readonly is:
        | "get"
        | "head"
        | "post"
        | "put"
        | "patch"
        | "delete"
        | "options"
        | "connect"
        | "trace"
        | "query"
        | "secured_post"
        | "secured_get_and_head";
    }
  | { readonly is: "method"; readonly method: string }
  | { readonly is: "version"; readonly version: HttpVersion }
  | { readonly is: "secured" | "unsecure"; readonly unknown_as_miss: boolean }
  | { readonly is: "exact_path"; readonly path: string }
  | { readonly is: "path"; readonly pattern: string }
  | {
      readonly is: "header_eq" | "header_any_eq";
      readonly name: string;
      readonly value: string;
    }
  | { readonly is: "header_present"; readonly name: string }
  | { readonly is: "param_pair"; readonly key: string; readonly value: string }
  | { readonly is: "param_present"; readonly key: string }
  | {
      readonly is: "accepts_media_type" | "accepts_encoding";
      readonly offer: string;
    }
  | {
      readonly is: "accepts_language";
      readonly offer: string;
      readonly mode: LanguageMode;
    }
  | {
      readonly is: "selected";
      readonly offers: string;
      readonly offer: string;
      readonly invalid_is_error: boolean;
    }
  | { readonly is: "host"; readonly host: string }
  | { readonly is: "and" | "or"; readonly of: ReadonlyArray<Condition> }
  | { readonly is: "not"; readonly of: Condition }
  | {
      readonly is: "filter";
      readonly of: Condition;
      readonly capture: string;
      readonly test: "number" | "username";
    };

export type HttpVersion = "HTTP/1.0" | "HTTP/1.1" | "HTTP/2" | "HTTP/3";
export type LanguageMode = "lookup" | "basic_filter";

export const get = (): Condition => ({ is: "get" });
export const head = (): Condition => ({ is: "head" });
export const post = (): Condition => ({ is: "post" });
export const put = (): Condition => ({ is: "put" });
export const patch = (): Condition => ({ is: "patch" });
export const del = (): Condition => ({ is: "delete" });
export const options = (): Condition => ({ is: "options" });
export const connect = (): Condition => ({ is: "connect" });
export const trace = (): Condition => ({ is: "trace" });
export const query = (): Condition => ({ is: "query" });
export const method = (name: string): Condition => ({
  is: "method",
  method: name,
});
export const version = (name: HttpVersion): Condition => ({
  is: "version",
  version: name,
});
/** `secured()`, or `secured().unknown_as_miss()`. */
export const secured = (unknownAsMiss = false): Condition => ({
  is: "secured",
  unknown_as_miss: unknownAsMiss,
});
/** `unsecure()`, or `unsecure().unknown_as_miss()`. */
export const unsecure = (unknownAsMiss = false): Condition => ({
  is: "unsecure",
  unknown_as_miss: unknownAsMiss,
});
export const securedPost = (): Condition => ({ is: "secured_post" });
export const securedGetAndHead = (): Condition => ({
  is: "secured_get_and_head",
});
export const exactPath = (text: string): Condition => ({
  is: "exact_path",
  path: text,
});
export const path = (pattern: string): Condition => ({ is: "path", pattern });
/** Header values are bytes; each character here stands for one, from U+0000 to U+00FF. */
export const headerEq = (name: string, value: string): Condition => ({
  is: "header_eq",
  name,
  value,
});
export const headerAnyEq = (name: string, value: string): Condition => ({
  is: "header_any_eq",
  name,
  value,
});
export const headerPresent = (name: string): Condition => ({
  is: "header_present",
  name,
});
export const paramPair = (key: string, value: string): Condition => ({
  is: "param_pair",
  key,
  value,
});
export const paramPresent = (key: string): Condition => ({
  is: "param_present",
  key,
});
export const acceptsMediaType = (offer: string): Condition => ({
  is: "accepts_media_type",
  offer,
});
export const acceptsEncoding = (offer: string): Condition => ({
  is: "accepts_encoding",
  offer,
});
export const acceptsLanguage = (
  offer: string,
  mode: LanguageMode,
): Condition => ({
  is: "accepts_language",
  offer,
  mode,
});
/** `offers.selected(offer)` for an offer set the table declares under `offers`. */
export const selected = (
  offers: string,
  offer: string,
  invalidIsError = false,
): Condition => ({
  is: "selected",
  offers,
  offer,
  invalid_is_error: invalidIsError,
});
/** The `host` condition from Warded's guide to custom matchers. */
export const host = (name: string): Condition => ({ is: "host", host: name });
export const and = (...of: ReadonlyArray<Condition>): Condition => ({
  is: "and",
  of,
});
export const or = (...of: ReadonlyArray<Condition>): Condition => ({
  is: "or",
  of,
});
export const not = (of: Condition): Condition => ({ is: "not", of });
/** `of.filter(|captures| captures.get(capture).is_some_and(test))`. */
export const filter = (
  of: Condition,
  capture: string,
  test: "number" | "username",
): Condition => ({ is: "filter", of, capture, test });

export interface Reply {
  readonly status: number;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly body?: string;
}

/** A selected target. Without a reply, it answers 200 with `{ route, captures }` as JSON. */
export interface Target {
  readonly name: string;
  readonly reply?: Reply;
}

export interface Route extends Target {
  readonly when: Condition;
}

export type OfferSet =
  | {
      readonly field: "media_types" | "encodings";
      readonly values: ReadonlyArray<string>;
    }
  | {
      readonly field: "languages";
      readonly values: ReadonlyArray<string>;
      readonly mode: LanguageMode;
    };

export interface Definition {
  readonly routes: ReadonlyArray<Route>;
  /** `Router::fallback`. Without one, a miss is Warded's empty 404. */
  readonly fallback?: Target;
  /** Offer sets that `selected` conditions share, by name. */
  readonly offers?: Readonly<Record<string, OfferSet>>;
}

export const route = (name: string, when: Condition, reply?: Reply): Route =>
  reply === undefined ? { name, when } : { name, when, reply };
