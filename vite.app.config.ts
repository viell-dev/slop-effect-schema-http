import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * The production build of the single-page app in `src/app` (EXT-7), into `.app/`. The app project's
 * global setup (`src/harness/app-setup.ts`) runs it as `vite build --config vite.app.config.ts`
 * before every run of the app's tests, then serves the output.
 *
 * There is no alias for the library: `viell-effect-schema-http` resolves as in any application, to
 * the package `npm run library:pack` installed in node_modules, through its `exports` map.
 */

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIBRARY = "viell-effect-schema-http";

/**
 * Refuse a bundle that does not take the library from the installed package's emitted files: one
 * without it, or with the fetched source in `.library/` or the package's own `src`.
 */
const packedLibrary = (): Plugin => ({
  name: "hostile-suite:packed-library",
  apply: "build",
  generateBundle(_options, bundle) {
    const modules = Object.values(bundle)
      .flatMap((file) => (file.type === "chunk" ? file.moduleIds : []))
      .map((id) => id.replaceAll("\\", "/"));
    const packed = modules.filter((id) =>
      id.includes(`/node_modules/${LIBRARY}/dist/`),
    );
    const elsewhere = modules.filter(
      (id) =>
        id.includes("/.library/") ||
        (id.includes(`/node_modules/${LIBRARY}/`) && !packed.includes(id)),
    );
    if (packed.length === 0 || elsewhere.length > 0)
      this.error(
        `the app must bundle ${LIBRARY} from node_modules/${LIBRARY}/dist/ alone; it bundled ${packed.length} modules from there and also ${elsewhere.join(", ") || "nothing else"}`,
      );
    console.log(
      `${LIBRARY}: ${packed.length} modules bundled from node_modules/${LIBRARY}/dist/`,
    );
  },
});

export default defineConfig({
  root: at("./src/app"),
  publicDir: false,
  // The app reads its configuration from the page's URL, never from `.env` files.
  envDir: false,
  build: { outDir: at("./.app"), emptyOutDir: true },
  plugins: [packedLibrary()],
});
