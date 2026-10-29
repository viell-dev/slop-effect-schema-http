import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { proxyMiddleware } from "./proxy.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The built app's origin, `http://127.0.0.1:<port>`, provided by the app project's setup. */
    readonly app: string;
  }
}

/**
 * Global setup of the app project (`npm run app:test`): build the single-page app in `src/app`,
 * then serve it the way such an app is deployed, as static files from a server that also hosts the
 * same-origin proxy of `proxy.ts`. The tests drive it with Playwright's Chromium and start backends
 * themselves; the page reaches them only through the proxy on its own origin.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(root, ".app");
const assets = join(output, "assets");

/**
 * Build as `vite build --config vite.app.config.ts` does from a shell, in its own process: this
 * one runs with Vitest's `NODE_ENV=test`, under which Vite would not make a production build.
 */
const build = (): void => {
  const { NODE_ENV: _testing, ...env } = process.env;
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--config",
      join(root, "vite.app.config.ts"),
      "--mode",
      "production",
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  if (!existsSync(join(output, "index.html")))
    throw new Error("the app's build wrote no .app/index.html");
};

const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** The file of the build that a request path names, if any. */
const fileFor = async (pathname: string): Promise<string | undefined> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const path = resolve(output, `.${decoded}`);
  if (!path.startsWith(output + sep)) return undefined;
  const found = await stat(path).catch(() => undefined);
  return found?.isFile() === true ? path : undefined;
};

/**
 * Static hosting as a single-page app needs it: the file a path names, or else, for a path without
 * an extension, the app's `index.html`, so a route that is loaded directly or reloaded is rendered
 * by the app's own router. Hashed assets are cached for good and the page is revalidated, as a
 * deployment would serve them.
 */
const serveStatic = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const { pathname } = new URL(request.url ?? "/", "http://placeholder");
  const file =
    (await fileFor(pathname)) ??
    (extname(pathname) === "" ? join(output, "index.html") : undefined);
  if (file === undefined) {
    response
      .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      .end("not found\n");
    return;
  }
  response.writeHead(200, {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Cache-Control": file.startsWith(assets + sep)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
};

export default async function setup(project: TestProject) {
  build();
  const server = createServer((request, response) =>
    proxyMiddleware(request, response, () => {
      serveStatic(request, response).catch(() => response.destroy());
    }),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project.provide("app", origin);
  console.log(`Serving the built app from .app/ at ${origin}`);
  return () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
}
