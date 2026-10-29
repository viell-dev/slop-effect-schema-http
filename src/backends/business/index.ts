import { router } from "../../harness/route.js";
import type { Handler } from "../../harness/server.js";
import * as Envelopes from "./envelopes.js";
import * as Operations from "./operations.js";

/**
 * The JSON business API: one service that grew by accretion, so its envelope conventions
 * (`envelopes.ts`) and its operational behaviour (`operations.ts`) come from different eras and
 * teams. Each call creates fresh state.
 */
export const handler = (): Handler =>
  router([...Envelopes.routes(), ...Operations.routes()]);
