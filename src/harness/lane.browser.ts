import { Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { Client, Lane } from "./lane.js";

/**
 * The browser lane: the consumer runs in Chromium and uses the page's own `fetch`. The trace headers
 * would make every request need a preflight, so they are off, as the library's recipe for browsers
 * recommends.
 */
const fetch: Client = {
  name: "fetch",
  layer: Layer.merge(
    FetchHttpClient.layer,
    Layer.succeed(HttpClient.TracerPropagationEnabled, false),
  ),
  reaches: ["plain", "http", "https"],
};

export const lane: Lane = {
  name: "browser",
  clients: [fetch],
  fetch,
  lines: undefined,
  raw: undefined,
};
