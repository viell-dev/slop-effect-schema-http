import { router, textReply } from "../harness/route.js";
import type { Handler } from "../harness/server.js";

/**
 * A neutral backend for harness smoke tests, not part of the catalogue.
 *
 * - `GET /text` answers `ok` as text.
 * - `GET /scopes` answers 400 unless the request carries exactly one `X-Scope` value per line, and
 *   replies with two repeated `X-Scope` lines.
 * - `GET /hold` never answers; it ends only when the client goes away.
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
