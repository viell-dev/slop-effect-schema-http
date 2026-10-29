/**
 * What a browser would conclude from a CORS preflight answer. Node enforces none of this, so a Node
 * consumer can only read the answers and predict the browser's verdict; the browser lane checks
 * the prediction against a real browser. The rules follow the Fetch standard's CORS check and
 * CORS-preflight fetch, reduced to what this service's answers exercise.
 */
import type { CorsAnswer } from "./schemas.js";

/** Request headers a script cannot set; the browser owns them. */
const forbidden = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

const safelistedContentTypes = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
];

/** Whether a header line needs no preflight (a CORS-safelisted request header). */
const safelisted = (name: string, value: string): boolean => {
  if (name === "accept" || name === "accept-language") return true;
  if (name === "content-language") return true;
  if (name === "content-type")
    return safelistedContentTypes.includes(
      value.split(";")[0]!.trim().toLowerCase(),
    );
  return false;
};

/**
 * The header names a browser would list in `Access-Control-Request-Headers` for a request with
 * these lines: lowercased, deduplicated and sorted, without forbidden or safelisted headers.
 */
export const requestedHeaders = (
  lines: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<string> =>
  Array.from(
    new Set(
      lines
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .filter(
          ([name, value]) =>
            !forbidden.has(name) &&
            !name.startsWith("proxy-") &&
            !name.startsWith("sec-") &&
            !safelisted(name, value),
        )
        .map(([name]) => name),
    ),
  ).toSorted();

export interface Intent {
  readonly origin: string;
  readonly method: string;
  readonly headers: ReadonlyArray<string>;
  /** Whether the request carries credentials (`credentials: "include"`). */
  readonly credentials: boolean;
}

/** The browser's verdict: allowed when `reasons` is empty. */
export interface Verdict {
  readonly allowed: boolean;
  readonly reasons: ReadonlyArray<string>;
}

const simpleMethods = ["GET", "HEAD", "POST"];

/** Predict whether a browser would send the actual request after this preflight answer. */
export const verdict = (
  status: number,
  answer: CorsAnswer,
  intent: Intent,
): Verdict => {
  const reasons: Array<string> = [];
  if (status < 200 || status > 299)
    reasons.push(`preflight status ${status} is not ok`);
  if (answer.allowOrigin === undefined)
    reasons.push("no Access-Control-Allow-Origin");
  else if (
    answer.allowOrigin !== intent.origin &&
    !(answer.allowOrigin === "*" && !intent.credentials)
  )
    reasons.push(`origin ${answer.allowOrigin} is not ${intent.origin}`);
  if (intent.credentials && answer.allowCredentials !== "true")
    reasons.push("credentials not allowed");
  const methods = answer.allowMethods ?? [];
  if (
    !simpleMethods.includes(intent.method) &&
    !methods.includes(intent.method) &&
    !(methods.includes("*") && !intent.credentials)
  )
    reasons.push(`method ${intent.method} not allowed`);
  const allowed = (answer.allowHeaders ?? []).map((name) => name.toLowerCase());
  for (const name of intent.headers) {
    const wildcard =
      allowed.includes("*") && !intent.credentials && name !== "authorization";
    if (!allowed.includes(name) && !wildcard)
      reasons.push(`header ${name} not allowed`);
  }
  return { allowed: reasons.length === 0, reasons };
};
