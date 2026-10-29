import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { sameOriginProxy } from "./src/harness/proxy.js";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The library source at the commit in `library-ref`, fetched by `npm run library`. Its imports of
// `effect` resolve to this suite's copy, so both share one installed version.
const library = at("./.library/src/main.ts");
const timeouts = { testTimeout: 20_000, hookTimeout: 20_000 };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "viell-effect-schema-http": library,
            "#lane": at("./src/harness/lane.node.ts"),
          },
        },
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          // Tests about the browser itself (CORS, the same-origin proxy) are named
          // `*.browser.test.ts` and run only in the browser project.
          exclude: ["src/**/*.browser.test.ts"],
          environment: "node",
          globalSetup: ["./src/harness/library-check.ts"],
          ...timeouts,
        },
      },
      {
        resolve: {
          alias: {
            "viell-effect-schema-http": library,
            "#lane": at("./src/harness/lane.browser.ts"),
          },
        },
        // The test page's origin is this project's browser server; the proxy makes backends
        // reachable from it without CORS, at `/__proxy/<host>:<port>/<path>`.
        plugins: [sameOriginProxy()],
        test: {
          name: "browser",
          include: ["src/**/*.test.ts"],
          // Tests that need Node itself (sockets, the line-preserving provider) are named
          // `*.node.test.ts`; every other test also runs in the browser.
          exclude: ["src/**/*.node.test.ts"],
          globalSetup: [
            "./src/harness/library-check.ts",
            "./src/harness/browser-setup.ts",
          ],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
          ...timeouts,
        },
      },
    ],
  },
});
