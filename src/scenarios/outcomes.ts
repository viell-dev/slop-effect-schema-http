/**
 * Failure-only diagnostics for scenarios that compare outcome lists (#232). An outcome is an
 * object whose `kind` says what an operation did, such as `{ kind: "success", value }` or
 * `{ kind: "failure", error }`. `toMatchObject` leaves out of its diff every key the expected object
 * does not name, so an unexpected failure shows only `kind: "failure"`, without its error. These
 * helpers put each outcome that is not a success, with its tag, message and cause chain, into the
 * assertion's message, which Vitest prints only when the assertion fails. They change no expected
 * value and no comparison.
 */
import { expect } from "@effect/vitest";

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (value: object, key: string) => {
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
};

/** One line per link of an error's chain: its tag and message, then its `reason` or `cause`. */
export const chain = (error: unknown): ReadonlyArray<string> => {
  const links: Array<string> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && links.length < 10 && !seen.has(current)) {
    seen.add(current);
    if (!isObject(current)) {
      links.push(String(current));
      break;
    }
    const tag =
      stringField(current, "_tag") ??
      (current instanceof Error ? current.name : undefined) ??
      Object.prototype.toString.call(current);
    const message = stringField(current, "message");
    links.push(
      message === undefined || message === "" ? tag : `${tag}: ${message}`,
    );
    // An `HttpClientError` keeps what went wrong in `reason`, which has the platform's `cause`.
    current = isObject(current.reason) ? current.reason : current.cause;
  }
  return links;
};

const detailOf = (outcome: Record<PropertyKey, unknown>): string => {
  if ("error" in outcome) return chain(outcome.error).join("\n    <- cause: ");
  const name = typeof outcome.name === "string" ? outcome.name : undefined;
  const message =
    typeof outcome.message === "string" ? outcome.message : undefined;
  return [name, message].filter((part) => part !== undefined).join(": ");
};

/**
 * Every outcome in `value` that is not a success, with where it is and what it was, or `undefined`
 * when there is none. It looks through arrays and plain objects, not into errors.
 */
export const explain = (value: unknown): string | undefined => {
  const found: Array<string> = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, path: string, depth: number) => {
    if (!isObject(node) || seen.has(node) || depth > 8) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) =>
        visit(item, `${path}[${index}]`, depth + 1),
      );
      return;
    }
    const prototype: unknown = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return;
    const kind = node.kind;
    if (typeof kind === "string" && kind !== "success") {
      const detail = detailOf(node);
      found.push(
        `${path || "outcome"}: ${kind}${detail === "" ? "" : ` ${detail}`}`,
      );
      return;
    }
    for (const [key, item] of Object.entries(node))
      visit(item, path === "" ? key : `${path}.${key}`, depth + 1);
  };
  visit(value, "", 0);
  return found.length === 0
    ? undefined
    : `outcomes other than success:\n  ${found.join("\n  ")}\n`;
};

/** `expect(value)`, with `explain(value)` as the message a failed assertion prints. */
export const expectOutcomes = <T>(value: T) => expect(value, explain(value));
