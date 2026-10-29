import type { Json } from "./lane.js";
import type { Handler } from "./server.js";

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
  let module: { readonly handler?: (options?: Json) => Handler };
  try {
    module = await import(`../backends/${name}.ts`);
  } catch {
    module = await import(`../backends/${name}/index.ts`);
  }
  if (typeof module.handler !== "function")
    throw new Error(`backend ${name} exports no handler factory`);
  return module.handler(options);
};
