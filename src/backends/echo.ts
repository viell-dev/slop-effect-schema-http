import { router, textReply } from "../harness/route.js";
import type { Handler } from "../harness/server.js";

/**
 * The harness's neutral probe for smoke tests and catalogue scenarios that assert the ledger.
 * Probe documentation: README.md#the-neutral-echo-probe.
 *
 * - `GET /text` answers `ok` as text.
 * - `GET /scopes` answers 400 if an `X-Scope` line contains a comma; otherwise it answers `ok`
 *   with two repeated `X-Scope` lines, even when no request scope is present.
 * - `GET /hold` never answers; it ends only when the client goes away.
 * - Other paths, including `GET /x` and `POST /x`, use the router's 404 text `Not Found` fallback.
 */
export const handler = (): Handler =>
  router([
    {
      method: "GET",
      path: "/text",
      handle: () => textReply(200, "ok", "text/plain"),
    },
    {
      method: "GET",
      path: "/scopes",
      handle: (request) => {
        const scopes = request.lines.filter(
          ([name]) => name.toLowerCase() === "x-scope",
        );
        return scopes.some(([, value]) => value.includes(","))
          ? textReply(400, "one scope per line", "text/plain")
          : textReply(200, "ok", "text/plain", [
              ["X-Scope", "a"],
              ["X-Scope", "b"],
            ]);
      },
    },
    {
      method: "GET",
      path: "/hold",
      handle: (_, context) =>
        new Promise((resolve) =>
          context.signal.addEventListener("abort", () =>
            resolve({ status: 499 }),
          ),
        ),
    },
  ]);
