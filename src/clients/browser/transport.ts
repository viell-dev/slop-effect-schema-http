/**
 * The transport settings a consumer's requests run under, read from the Effect context rather than
 * restated. Cookie and credential behaviour belongs to the transport and differs between Node and a
 * browser, so a test records these settings before asserting what the transport did with cookies.
 */
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";

export interface TransportSettings {
  /** The `HttpClient` provider, such as `fetch` or `lines`. */
  readonly provider: string;
  /** Fetch's credentials mode as `FetchHttpClient.RequestInit` sets it, or why there is none. */
  readonly credentials: string;
  /** The caller's own notes: the lane, a cookie jar, a hand-set `Cookie`, the route taken. */
  readonly [note: string]: string;
}

const fetchDefault = "unset: Fetch's default, same-origin";

/** Describe the settings in effect for `provider`, adding the caller's notes. */
export const transportSettings = (
  provider: string,
  notes: Readonly<Record<string, string>> = {},
): Effect.Effect<TransportSettings> =>
  Effect.map(Effect.serviceOption(FetchHttpClient.RequestInit), (init) => ({
    provider,
    credentials:
      provider !== "fetch"
        ? "not applicable: the provider has no credentials mode"
        : Option.match(init, {
            onNone: () => fetchDefault,
            onSome: (value) => value.credentials ?? fetchDefault,
          }),
    ...notes,
  }));
