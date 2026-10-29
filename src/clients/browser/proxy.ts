/**
 * The page's side of the same-origin proxy. A single-page app whose services cannot all be called
 * across origins sends some calls to a path on its own origin, where a server-side proxy forwards
 * them. In the browser lane that proxy is part of the test page's server: it forwards
 * `<page origin>/__proxy/<host>:<port>/<path>` to `http://<host>:<port>/<path>` and documents what
 * it changes on the wire. Nothing here is library support: CORS belongs to the transport, and the
 * consumer chooses per service or per endpoint which origin to call.
 *
 * Two ways to route a call through the proxy, which differ in what the client middleware sees:
 *
 * - {@link proxyBase} as the service's base URL. Every layer of the consumer, including request
 *   signing, sees the proxied URL, so a signature over the request path covers the page's path,
 *   not the one the service receives.
 * - {@link routeThroughProxy} as the outermost client middleware. Everything before it sees the
 *   service's own URL, and only the transport is redirected to the proxy.
 */
import { HttpClient, HttpClientRequest } from "effect/http";

/** The page origin's base URL that reaches `origin` (`http://<host>:<port>`) through the proxy. */
export const proxyBase = (
  origin: string,
  page: string = globalThis.location.origin,
): string => `${page}/__proxy/${new URL(origin).host}`;

/**
 * Client middleware that sends requests for `origin` to the proxy instead, leaving other requests
 * alone. `HttpClient.mapRequest` appends its function, so as the outermost middleware this runs
 * after every other request transformation, such as per-attempt signing.
 */
export const routeThroughProxy =
  (origin: string, page: string = globalThis.location.origin) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
    HttpClient.mapRequest(client, (request) =>
      request.url === origin ||
      request.url.startsWith(`${origin}/`) ||
      request.url.startsWith(`${origin}?`)
        ? HttpClientRequest.setUrl(
            request,
            `${proxyBase(origin, page)}${request.url.slice(origin.length)}`,
          )
        : request,
    );
