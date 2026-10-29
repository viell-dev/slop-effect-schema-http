import { router } from "../../harness/route.js";
import type { Handler } from "../../harness/server.js";
import * as Envelopes from "./envelopes.js";
import * as Operations from "./operations.js";

/** Plain JSON options, as a browser test can send them. */
type Options = Parameters<typeof Envelopes.routes>[0] extends infer E
  ? Parameters<typeof Operations.routes>[0] extends infer O
    ? { readonly envelopes?: E; readonly operations?: O }
    : never
  : never;

/**
 * The JSON business API: one service that grew by accretion, so its envelope conventions
 * (`envelopes.ts`, under `/v1/`) and its operational behaviour (`operations.ts`, under `/v2/`) come
 * from different eras and teams. Each call creates fresh state. Options are plain JSON, split by
 * part.
 */
export const handler = (options?: Options): Handler =>
  router([
    ...Envelopes.routes(options?.envelopes),
    ...Operations.routes(options?.operations),
  ]);
