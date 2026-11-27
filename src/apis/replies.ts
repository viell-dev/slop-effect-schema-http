/** Reply builders that the service tables share. */
import type { Reply } from "../harness/routes.js";

/** Header lines in the order a handler writes them. */
export type Lines = ReadonlyArray<readonly [string, string]>;

/** A JSON answer. */
export const json = (
  status: number,
  value: unknown,
  headers: Lines = [],
): Reply => ({
  status,
  headers: [["content-type", "application/json"], ...headers],
  body: JSON.stringify(value),
});
