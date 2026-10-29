import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Json } from "./lane.js";
import type { Handler } from "./server.js";

const backends = new URL("../backends/", import.meta.url);

/**
 * Load a backend's `handler(options)` factory by name. A backend lives at `src/backends/<name>.ts`
 * or `src/backends/<name>/index.ts`. Node-only: browser tests reach backends through the control
 * server.
 */
export const loadHandler = async (
  name: string,
  options: Json | undefined,
): Promise<Handler> => {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`invalid backend name ${JSON.stringify(name)}`);
  const file = [`${name}.ts`, `${name}/index.ts`]
    .map((candidate) => fileURLToPath(new URL(candidate, backends)))
    .find((path) => existsSync(path));
  if (file === undefined) throw new Error(`no backend named ${name}`);
  // Resolved at run time rather than through a bundler's static map of the directory, so a backend
  // added later is found, and a failure while loading it is reported as itself.
  const module = (await import(/* @vite-ignore */ file)) as {
    readonly handler?: (options?: Json) => Handler;
  };
  if (typeof module.handler !== "function")
    throw new Error(`backend ${name} exports no handler factory`);
  return module.handler(options);
};
