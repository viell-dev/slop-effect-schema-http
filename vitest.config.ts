import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, defineProject } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The library source at the commit in refs.json, fetched by `npm run library`. Its imports of
// `effect` resolve to this suite's copy, so both share one installed version.
const library = at("./.library/src/main.ts");
const timeouts = { testTimeout: 20_000, hookTimeout: 20_000 };

/** A port that is free on loopback for TCP and UDP, for the browser's HTTP/3 listener. */
const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port: bound } = server.address() as { port: number };
        server.close(() => resolve(bound));
      });
    });
    const free = await new Promise<boolean>((resolve) => {
      const socket = createSocket("udp4");
      socket.once("error", () => resolve(false));
      socket.bind(port, "127.0.0.1", () => socket.close(() => resolve(true)));
    });
    if (free) return port;
  }
};

const spki = (() => {
  try {
    return readFileSync(at("./.host/spki.txt"), "utf8").trim();
  } catch {
    return "";
  }
})();

export default defineConfig(async () => {
  const quicPort = await freePort();
  const node = defineProject({
    resolve: {
      alias: {
        "viell-effect-schema-http": library,
        "#lane": at("./src/harness/lane.node.ts"),
      },
    },
    test: {
      name: "node",
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.browser.test.ts"],
      environment: "node",
      globalSetup: ["./src/harness/setup.ts"],
      setupFiles: ["./src/harness/node-setup.ts"],
      provide: { quicPort },
      ...timeouts,
    },
  });
  const browser = defineProject({
    resolve: {
      alias: {
        "viell-effect-schema-http": library,
        "#lane": at("./src/harness/lane.browser.ts"),
      },
    },
    test: {
      name: "browser",
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.node.test.ts"],
      globalSetup: ["./src/harness/setup.ts"],
      provide: { quicPort },
      browser: {
        enabled: true,
        // Chromium accepts the host's certificate by the hash of its key, the way the Warded
        // Server's HTTP/3 guide describes, and uses HTTP/3 on the one port the HTTP/3 tests serve.
        provider: playwright({
          launchOptions: {
            args: [
              `--ignore-certificate-errors-spki-list=${spki}`,
              `--origin-to-force-quic-on=127.0.0.1:${quicPort}`,
            ],
          },
        }),
        headless: true,
        instances: [{ browser: "chromium" }],
      },
      ...timeouts,
    },
  });
  return { test: { projects: [node, browser] } };
});
