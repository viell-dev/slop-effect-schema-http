/**
 * Encode and decode finite HTTP bodies, with optional schema validation.
 */
export * as Body from "./http/Body.js";
/**
 * Share or replace work for one scoped user interaction.
 */
export * as Interaction from "./concurrency/Interaction.js";
/**
 * Pair request and response contracts and execute them through an Effect HTTP client.
 */
export * as Operation from "./http/Operation.js";
/**
 * Configure operation retries, delays and attempt timeouts.
 */
export * as Policy from "./http/Policy.js";
/**
 * Describe outgoing requests and bind typed application input.
 */
export * as Request from "./http/Request.js";
/**
 * Select and decode accepted responses using status and metadata.
 */
export * as Response from "./http/Response.js";
/**
 * Preserve individual header lines through a supporting HTTP provider.
 */
export * as Transport from "./http/Transport.js";
/**
 * Customize path escaping, query rendering and base-URL joining.
 */
export * as UrlEncoding from "./http/UrlEncoding.js";
