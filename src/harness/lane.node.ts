import { NodeHttpClient } from "@effect/platform-node";
import { Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { inject } from "vitest";
import type { Client, Lane } from "./lane.js";
import { linesLayer, rawLayer } from "./providers.js";

const ca = inject("certificate");

/**
 * Effect adds `b3` and `traceparent` to every request by default. They would appear in every head
 * and wire record without being anything either project chose, so every provider here turns them
 * off, as the library's recipe for browsers does.
 */
const quiet = (layer: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.merge(layer, Layer.succeed(HttpClient.TracerPropagationEnabled, false));

const fetch: Client = {
  name: "fetch",
  // Node's `fetch` trusts the certificate through `tls.setDefaultCACertificates`, in node-setup.ts.
  layer: quiet(FetchHttpClient.layer),
  reaches: ["plain", "http", "https"],
};
const lines: Client = {
  name: "lines",
  layer: quiet(linesLayer),
  reaches: ["plain", "http"],
};

/** The Node lane: every provider, with the host's certificate trusted. */
export const lane: Lane = {
  name: "node",
  clients: [
    fetch,
    // Undici 8 negotiates HTTP/2 over TLS unless `allowH2` is false, so over HTTPS this is the
    // lane's HTTP/2 client.
    {
      name: "undici",
      layer: quiet(NodeHttpClient.layerUndiciOptions({ connect: { ca } })),
      reaches: ["plain", "http", "https"],
    },
    {
      name: "node-http",
      layer: quiet(NodeHttpClient.layerNodeHttpOptions({ ca })),
      reaches: ["plain", "http", "https"],
    },
    lines,
  ],
  fetch,
  lines,
  raw: (origin, options) => quiet(rawLayer(origin, options)),
};
