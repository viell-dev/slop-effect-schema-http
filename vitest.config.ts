import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, defineProject } from "vitest/config";
import { sameOriginProxy } from "./src/harness/proxy.js";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The library source at the commit in `library-ref`, fetched by `npm run library`. Its imports of
// `effect` resolve to this suite's copy, so both share one installed version.
const library = at("./.library/src/main.ts");
const nodeLane = at("./src/harness/lane.node.ts");
const timeouts = { testTimeout: 20_000, hookTimeout: 20_000 };

const node = defineProject({
  resolve: {
    alias: {
      "viell-effect-schema-http": library,
      "#lane": nodeLane,
    },
  },
  test: {
    name: "node",
    include: ["src/**/*.test.ts"],
    // Tests about the browser itself (CORS, the same-origin proxy) are named
    // `*.browser.test.ts` and run only in the browser project; tests of the packed package are
    // named `*.packed.test.ts` and run only in the packed project.
    exclude: ["src/**/*.browser.test.ts", "src/**/*.packed.test.ts"],
    environment: "node",
    globalSetup: ["./src/harness/library-check.ts"],
    ...timeouts,
  },
});

// The Node lane against the package `npm run library:pack` installed into node_modules. Without the
// library's alias, `viell-effect-schema-http` resolves as an application's import does, through the
// package's `exports` map, and the package's own imports of `effect` find this suite's copy as its
// peer. The global setup checks the installed package instead of `.library/src`.
const packed = defineProject({
  resolve: { alias: { "#lane": nodeLane } },
  test: {
    ...node.test,
    name: "packed",
    exclude: ["src/**/*.browser.test.ts"],
  },
});

const browser = defineProject({
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
    // `*.node.test.ts`; every other test except the packed ones also runs in the browser.
    exclude: ["src/**/*.node.test.ts", "src/**/*.packed.test.ts"],
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
});

// `--mode packed` (`npm run packed:test`) runs only the packed project; the browser lane always
// imports the library from source.
export default defineConfig(({ mode }) => ({
  test: { projects: mode === "packed" ? [packed] : [node, browser] },
}));
