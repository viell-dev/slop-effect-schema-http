import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Json } from "./lane.js";
import type { RawHandler } from "./server.js";

const backends = new URL("../backends/", import.meta.url);
const fixtures = new URL("./fixtures/", import.meta.url);

/**
 * Load a backend's `handler(options)` factory by name. A backend lives at `src/backends/<name>.ts`
 * or `src/backends/<name>/index.ts`; the harness's own test fixtures, which no scenario uses, live at
 * `src/harness/fixtures/<name>.ts`. Node-only: browser tests reach backends through the control
 * server.
 */
export const loadHandler = async (
  name: string,
  options: Json | undefined,
): Promise<RawHandler> => {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`invalid backend name ${JSON.stringify(name)}`);
  const file = [
    new URL(`${name}.ts`, backends),
    new URL(`${name}/index.ts`, backends),
    new URL(`${name}.ts`, fixtures),
  ]
    .map((candidate) => fileURLToPath(candidate))
    .find((path) => existsSync(path));
  if (file === undefined) throw new Error(`no backend named ${name}`);
  // Resolved at run time rather than through a bundler's static map of the directory, so a backend
  // added later is found, and a failure while loading it is reported as itself.
  const module = (await import(/* @vite-ignore */ file)) as {
    readonly handler?: (options?: Json) => RawHandler;
  };
  if (typeof module.handler !== "function")
    throw new Error(`backend ${name} exports no handler factory`);
  return module.handler(options);
};
