import type { Route } from "../../harness/route.js";

/** Plain JSON options of this part of the business API. */
export interface Options {}

/** Routes of this part of the business API, with fresh state per call. */
export const routes = (options?: Options): ReadonlyArray<Route> => {
  void options;
  return [];
};
