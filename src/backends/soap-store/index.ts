import { router } from "../../harness/route.js";
import type { Handler } from "../../harness/server.js";
import * as Dav from "./dav.js";
import * as Files from "./files.js";
import * as Soap from "./soap.js";
import { type SeedDocument, Store } from "./store.js";

/**
 * DocVault, the SOAP document store. Each call creates fresh state. One `Store` backs the three
 * route groups: `soap.ts` (the SOAP endpoint, its metadata and the download servlet), `dav.ts` (the
 * WebDAV view) and `files.ts` (uploads and bundles). `xml.ts` is the store's own XML reader and
 * writer, and `wire.ts` its header, query and plain-text helpers.
 *
 * Service documentation: services/soap-store.md
 */

/** The test options, documented under "Test options" in the service page. */
export interface Options {
  readonly documents?: ReadonlyArray<SeedDocument> | undefined;
  readonly collections?: ReadonlyArray<string> | undefined;
  readonly clock?: string | undefined;
  readonly failStore?:
    | {
        readonly names?: ReadonlyArray<string> | undefined;
        readonly calls?: ReadonlyArray<number> | undefined;
      }
    | undefined;
  readonly latency?: Readonly<Record<string, number>> | undefined;
  readonly hold?: ReadonlyArray<string> | undefined;
}

export type { SeedDocument };

export const handler = (options: Options = {}): Handler => {
  const clock = options.clock;
  const now =
    clock === undefined ? () => new Date() : () => new Date(Date.parse(clock));
  const store = new Store(
    now,
    options.documents ?? [],
    options.collections ?? ["archive", "templates"],
  );
  return router([
    ...Soap.routes(store, options),
    ...Dav.routes(store, now()),
    ...Files.routes(store),
  ]);
};
