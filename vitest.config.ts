import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The library source at the commit in `library-ref`, fetched by `pnpm library`. Its imports of
      // `effect` resolve to this suite's copy, so both share one installed version.
      "viell-effect-schema-http": fileURLToPath(
        new URL("./.library/src/main.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/harness/library-check.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
