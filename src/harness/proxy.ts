import {
  type IncomingMessage,
  request as forward,
  type ServerResponse,
} from "node:http";
import type { Plugin } from "vitest/config";

/**
 * The same-origin proxy of the browser lane. A static single-page app escapes a service's CORS by
 * calling a path on its own origin that a server-side proxy forwards to the service. Here the
 * page's origin is Vitest's browser server, and this middleware is that proxy:
 *
 *     <page origin>/__proxy/<host>:<port>/<path and query>  ->  http://<host>:<port>/<path and query>
 *
 * It serves only its own page and loopback backends, so the browser server never becomes an open
 * proxy: a target outside `127.0.0.0/8` is not proxied (the request passes to the next middleware),
 * and a request whose `Host` is not a loopback name, or whose `Origin` is another origin, is refused
 * with `403` before anything is forwarded. The proxy runs ahead of Vite's own middleware, including
 * its CORS middleware. It is deliberately minimal. What the backend sees differs from what the page
 * sent in exactly these ways:
 *
 * - **Request target.** The `/__proxy/<host>:<port>` prefix is removed; the rest of the target is
 *   forwarded byte for byte, without decoding or normalizing.
 * - **`Host`.** Its value becomes `<host>:<port>`, in the line's original position and spelling.
 * - **Hop-by-hop lines.** `Connection`, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`,
 *   `Transfer-Encoding`, `Upgrade` and any line named in `Connection` belong to the page's
 *   connection and are not forwarded. Node's client opens one connection per request and adds its
 *   own `Connection: close` after the forwarded lines. The body is buffered and forwarded whole,
 *   so a body that arrived chunked is sent with `Content-Length` instead.
 * - **Nothing is added.** No `Forwarded`, `X-Forwarded-*` or `Via` line. Every other line,
 *   including `Origin`, `Referer`, `Cookie`, `Sec-Fetch-*` and trace headers, is forwarded in its
 *   original order, spelling and repetition.
 *
 * On the way back, the status code, status text, header lines and body pass through unchanged,
 * except the hop-by-hop lines above, which the browser server writes for its own connection. In
 * particular the proxy adds no CORS headers, because a same-origin response needs none, and it
 * rewrites neither `Set-Cookie` nor `Location`:
 *
 * - a cookie set through the proxy is stored for the page's host with the backend's `Path`, so it
 *   is first-party to the page and is sent with every later same-origin request, including those
 *   proxied to other backends;
 * - a relative `Location` resolves against the page's origin, outside the proxy prefix.
 *
 * Differences the backend can observe but the proxy does not cause come from the browser itself:
 * the call is now same-origin, so there is no preflight, `Origin` is sent only on non-GET requests,
 * `Sec-Fetch-Site` is `same-origin`, and cookies come from the page origin's jar.
 *
 * If the backend cannot be reached, the proxy answers `502 Bad Gateway` with a `text/plain` body
 * naming the cause. A page that aborts its request closes the forwarded request too, so the
 * backend observes the abort.
 */

const target =
  /^\/__proxy\/(?<host>127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})):(?<port>\d{1,5})(?<rest>[/?].*)?$/;

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type Lines = ReadonlyArray<readonly [string, string]>;

const pairs = (raw: ReadonlyArray<string>): Lines => {
  const lines: Array<readonly [string, string]> = [];
  for (let index = 0; index + 1 < raw.length; index += 2)
    lines.push([raw[index]!, raw[index + 1]!]);
  return lines;
};

/** Drop hop-by-hop lines, including those the `Connection` line names. */
const endToEnd = (lines: Lines): Lines => {
  const named = new Set(
    lines
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(","))
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
  return lines.filter(([name]) => {
    const lower = name.toLowerCase();
    return !hopByHop.has(lower) && !named.has(lower);
  });
};

const collect = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const flat = (lines: Lines): Array<string> =>
  lines.flatMap(([name, value]) => [name, value]);

const loopbackName = /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/**
 * The proxy serves only its own page: the `Host` must be a loopback name, which stops DNS
 * rebinding, and an `Origin`, when present, must be that same origin, which stops other sites from
 * sending blind requests to loopback services through it. Neither check changes what is forwarded.
 */
const refuse = (request: IncomingMessage): string | undefined => {
  const host = request.headers.host ?? "";
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return `refused Host ${JSON.stringify(host)}`;
  }
  if (!loopbackName.test(hostname))
    return `refused Host ${JSON.stringify(host)}`;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`)
    return `refused cross-origin request from ${origin}`;
  return undefined;
};

/**
 * Connect-style middleware: forward `/__proxy/<host>:<port>/…` requests and pass every other
 * request to `next`.
 */
export const proxyMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void => {
  const match = target.exec(request.url ?? "");
  if (match?.groups === undefined) {
    next();
    return;
  }
  const { host, port, rest } = match.groups as {
    readonly host: string;
    readonly port: string;
    readonly rest?: string;
  };
  const refusal = refuse(request);
  if (refusal !== undefined) {
    response.writeHead(403, "Forbidden", [
      "Content-Type",
      "text/plain; charset=utf-8",
    ]);
    response.end(`proxy: ${refusal}\n`);
    return;
  }
  const authority = `${host}:${port}`;
  const path =
    rest === undefined ? "/" : rest.startsWith("?") ? `/${rest}` : rest;
  const lines = endToEnd(pairs(request.rawHeaders)).map(
    ([name, value]) =>
      [name, name.toLowerCase() === "host" ? authority : value] as const,
  );
  void (async () => {
    const body = await collect(request);
    const framed =
      body.length === 0 ||
      lines.some(([name]) => name.toLowerCase() === "content-length");
    const upstream = forward({
      host,
      port: Number(port),
      method: request.method,
      path,
      headers: flat(
        framed ? lines : [...lines, ["Content-Length", String(body.length)]],
      ),
      setHost: false,
      agent: false,
    });
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    upstream.on("response", (answer) => {
      response.writeHead(
        answer.statusCode ?? 502,
        answer.statusMessage ?? "",
        flat(endToEnd(pairs(answer.rawHeaders))),
      );
      answer.pipe(response);
    });
    upstream.on("error", (cause) => {
      // After the page went away, or once the answer has started, there is nobody to tell.
      if (response.destroyed || response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, "Bad Gateway", [
        "Content-Type",
        "text/plain; charset=utf-8",
      ]);
      response.end(`proxy: ${authority} unreachable: ${cause.message}\n`);
    });
    upstream.end(body.length > 0 ? body : undefined);
  })().catch(() => response.destroy());
};

/**
 * The Vite plugin that installs {@link proxyMiddleware} in the browser server. It goes to the front
 * of the middleware stack, ahead of Vite's own CORS middleware, which would otherwise add `Vary` and
 * `Access-Control-Allow-Origin` to proxied responses.
 */
export const sameOriginProxy = (): Plugin => ({
  name: "hostile-suite:same-origin-proxy",
  configureServer: (server) => {
    server.middlewares.stack.unshift({ route: "", handle: proxyMiddleware });
  },
});
