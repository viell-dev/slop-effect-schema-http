import { router } from "../../harness/route.js";
import type { Handler } from "../../harness/server.js";
import * as Envelopes from "./envelopes.js";
import * as Operations from "./operations.js";

/** The test options, documented under "Test options" in the service page. */
type Options = Parameters<typeof Envelopes.routes>[0] extends infer E
  ? Parameters<typeof Operations.routes>[0] extends infer O
    ? { readonly envelopes?: E; readonly operations?: O }
    : never
  : never;

/**
 * The JSON business API: the `/v1/` routes of `envelopes.ts` and the `/v2/` routes of
 * `operations.ts` on one router, each configured by its own member of the options. Each call
 * creates fresh state.
 *
 * Service documentation: services/business.md
 */
export const handler = (options?: Options): Handler =>
  router([
    ...Envelopes.routes(options?.envelopes),
    ...Operations.routes(options?.operations),
  ]);
