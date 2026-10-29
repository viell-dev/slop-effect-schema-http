import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { inject } from "vitest";
import type { Backend, Lane, Recorded } from "./lane.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The control server's URL, provided by the browser project's global setup. */
    readonly control: string;
  }
}

const control = (path: string, init?: RequestInit) =>
  Effect.promise(async () => {
    const response = await fetch(`${inject("control")}${path}`, init);
    if (!response.ok)
      throw new Error(
        `control ${path}: ${response.status} ${await response.text()}`,
      );
    return response.status === 204
      ? undefined
      : ((await response.json()) as unknown);
  });

const bytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

/**
 * The browser lane: the consumer runs in Chromium and uses the browser's own `fetch`, so CORS,
 * forbidden headers, cookies and redirects behave as they would in a static single-page app.
 * Backends run in Node behind the control server.
 */
export const lane: Lane = {
  name: "browser",
  backend: (name, options, start) =>
    Effect.acquireRelease(
      control("/backends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, options, cors: start?.cors ?? "harness" }),
      }).pipe(
        Effect.map((started) => {
          const { id, origin } = started as {
            readonly id: string;
            readonly origin: string;
          };
          const backend: Backend & { readonly id: string } = {
            id,
            origin,
            ledger: control(`/backends/${id}/ledger`).pipe(
              Effect.map((entries) =>
                (
                  entries as ReadonlyArray<
                    Omit<Recorded, "body"> & { readonly body: string }
                  >
                ).map((entry) => ({ ...entry, body: bytes(entry.body) })),
              ),
            ),
            arrived: (count) =>
              Effect.asVoid(control(`/backends/${id}/arrived?count=${count}`)),
          };
          return backend;
        }),
      ),
      (backend) =>
        Effect.ignore(control(`/backends/${backend.id}`, { method: "DELETE" })),
    ),
  clients: [["fetch", FetchHttpClient.layer]],
  fetchClient: FetchHttpClient.layer,
  linesClient: undefined,
};
