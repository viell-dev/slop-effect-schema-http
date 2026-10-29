import { router } from "../../harness/route.js";
import type { Handler } from "../../harness/server.js";
import * as Dav from "./dav.js";
import * as Files from "./files.js";
import * as Soap from "./soap.js";
import { type SeedDocument, Store } from "./store.js";

/**
 * DocVault, a SOAP document store ported from a 2003 in-house platform. Each call creates fresh
 * state. The quirks are documented next to the code that implements them: `soap.ts` (the SOAP
 * endpoint, its metadata and the download servlet), `dav.ts` (the WebDAV view) and `files.ts`
 * (uploads and bundles).
 *
 * ## Endpoints
 *
 * - `POST /soap`: SOAP 1.1 (`text/xml` with a quoted `SOAPAction`) or SOAP 1.2
 *   (`application/soap+xml` with an `action` parameter), namespace `urn:docvault:store:2003`,
 *   action URIs `urn:docvault:store:2003#<Action>`. Actions: `StoreDocument`, `FetchDocument`,
 *   `ListDocuments`, `LockDocument`.
 * - `GET /soap?wsdl` (the WSDL) and `GET /soap?wsdl=types` (its schema part).
 * - `GET /soap/download`: a GET carrying a SOAP 1.1 `DownloadDocument` envelope.
 * - `/dav/documents/…`: WebDAV with PROPFIND, GET, HEAD, PUT, DELETE, MKCOL and OPTIONS.
 * - `POST /upload` (multipart), `POST /upload/raw?name=…` (raw bytes), `GET /bundle/<id>`.
 *
 * ## For the cross-service flows
 *
 * - **Store bytes:** `StoreDocument` with `<Name>`, `<Title>`, `<ContentType>` and `<Content>`
 *   (base64) answers `<FaultCode>0</FaultCode>`, `<DocumentId>` and `<ETag>`. A name that exists
 *   answers fault code 1002 inside HTTP 200. The document also appears at
 *   `/dav/documents/<name>`, where its ETag guards WebDAV writes.
 * - **Fetch bytes:** `FetchDocument` with `<Id>` answers `<Document>` with the metadata and
 *   `<Content>` (base64); an unknown id answers fault code 1001 inside HTTP 200.
 * - **Failure point:** `failStore` makes `StoreDocument` answer fault code 5003 ("Storage backend
 *   unavailable") inside HTTP 200, without storing, for the listed names or 1-based call numbers.
 * - **Latency and interruption:** `latency` delays an action's reply; `hold` keeps an action open
 *   until the client disconnects. Both end early when the client aborts.
 *
 * All options are plain JSON so a browser-side test can pass them to a Node process.
 */
export interface Options {
  /** Documents present at start. Defaults to none. */
  readonly documents?: ReadonlyArray<SeedDocument> | undefined;
  /** Subcollections under `/dav/documents/`. Defaults to `["archive", "templates"]`. */
  readonly collections?: ReadonlyArray<string> | undefined;
  /** A fixed clock as ISO 8601, for modification times and lock expiry. Defaults to real time. */
  readonly clock?: string | undefined;
  /** `StoreDocument` answers fault code 5003 for these names or 1-based call numbers. */
  readonly failStore?:
    | {
        readonly names?: ReadonlyArray<string> | undefined;
        readonly calls?: ReadonlyArray<number> | undefined;
      }
    | undefined;
  /** Milliseconds to wait before answering, per action name (including `DownloadDocument`). */
  readonly latency?: Readonly<Record<string, number>> | undefined;
  /** Action names that never answer; the request stays open until the client disconnects. */
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
