/**
 * The cross-service consumer: one application that talks to all five services, written only
 * against the library's public API, Effect, and the other areas' consumer contracts.
 *
 * - `Credentials`: one opaque token, three placements, late-bound (AUTH-1).
 * - `Search`: the task search box as an interaction (APP-1).
 * - `Saga`: the month-end saga with compensation (APP-2).
 * - `Translate`: translations between the services' schemas (APP-3).
 * - `Portal`: the portal facade, the document store's JSON-to-SOAP proxy.
 * - `Services`: the flows' own operations against the other areas' services.
 */
export * as Credentials from "./credentials.js";
export * as Portal from "./portal.js";
export * as Saga from "./saga.js";
export * as Search from "./search.js";
export * as Services from "./services.js";
export * as Translate from "./translate.js";
