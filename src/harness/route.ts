import {
  type Context,
  type Handler,
  path,
  type Received,
  type Reply,
} from "./server.js";

/** A route: a method (or `*`), a path pattern, and its handler. Named groups become `params`. */
export interface Route {
  readonly method: string;
  readonly path: string | RegExp;
  readonly handle: (
    request: Received,
    context: Context & { readonly params: Readonly<Record<string, string>> },
  ) => Reply | Promise<Reply>;
}

/** A JSON reply with the given status and extra raw lines. */
export const json = (
  status: number,
  value: unknown,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply => ({
  status,
  lines: [["Content-Type", "application/json"], ...lines],
  body: JSON.stringify(value),
});

/** A text reply with an explicit content type, which may lie about the body. */
export const textReply = (
  status: number,
  body: string | Uint8Array,
  contentType: string,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply => ({
  status,
  lines: [["Content-Type", contentType], ...lines],
  body,
});

/**
 * Dispatch to the first route whose method and path match. An unmatched path answers 404 and a
 * matched path with another method answers 405 with Allow, as a plain server would.
 */
export const router =
  (routes: ReadonlyArray<Route>, fallback?: Handler): Handler =>
  (request, context) => {
    const target = path(request);
    const allowed: Array<string> = [];
    for (const route of routes) {
      const match =
        typeof route.path === "string"
          ? route.path === target
            ? {}
            : undefined
          : route.path.exec(target)?.groups;
      const matched =
        typeof route.path === "string"
          ? route.path === target
          : route.path.test(target);
      if (!matched) continue;
      if (route.method !== "*" && route.method !== request.method) {
        allowed.push(route.method);
        continue;
      }
      return route.handle(request, { ...context, params: match ?? {} });
    }
    if (fallback !== undefined) return fallback(request, context);
    if (allowed.length > 0)
      return textReply(405, "Method Not Allowed", "text/plain", [
        ["Allow", allowed.join(", ")],
      ]);
    return textReply(404, "Not Found", "text/plain");
  };
