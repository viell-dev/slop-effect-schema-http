/**
 * The consumer's contracts for the CGI reporting gateway. Requests are cold descriptions without a
 * base URL; the operation factories take the gateway's origin. Every protected endpoint takes the
 * session, or the SSO token the gateway accepts in its place, as a `session` query parameter in the
 * operation's input.
 *
 * - `session.ts`: login (AUTH-2), the pipe balance report (ERR-1c) and the legacy `rpt.exe` path
 *   (STAT-10).
 * - `extract.ts`: the month-end extract (PAY-4c) and its HEAD probe (STAT-6).
 * - `accounts.ts`: the CSV export and German import (HDR-5d, PAY-4b, PAY-5).
 * - `rpc.ts`: XML-RPC (ERR-1b, PAY-3b, PAY-8).
 * - `digest.ts`: the Digest-protected audit report (AUTH-7, RET-4).
 */
export * as Accounts from "./accounts.js";
export * as Digest from "./digest.js";
export * as Extract from "./extract.js";
export * as Pipe from "./pipe.js";
export * as Rpc from "./rpc.js";
export * as Session from "./session.js";
