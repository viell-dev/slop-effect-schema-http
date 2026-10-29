import { existsSync, readFileSync } from "node:fs";

/**
 * Stop the run, saying why. The error's stack is the reason alone: Vitest cannot print an error
 * thrown from a global setup whose stack it maps itself ("code.charCodeAt is not a function").
 */
const refuse = (reason: string): never => {
  const error = new Error(reason);
  error.stack = `Error: ${reason}`;
  throw error;
};

/**
 * Vitest global setup: refuse to run against a missing or stale library checkout, so a run never
 * reports results for a different library commit than the one it claims to test.
 */
export default function setup(): void {
  const root = new URL("../../", import.meta.url);
  const fetched = new URL(".library/REF", root);
  if (!existsSync(fetched))
    refuse("The library source is missing. Run `npm run library` first.");
  const requested = (
    process.env["LIBRARY_REF"] ??
    readFileSync(new URL("library-ref", root), "utf8")
  ).trim();
  const [commit = "", fetchedFor = ""] = readFileSync(fetched, "utf8").split(
    "\n",
  );
  if (fetchedFor !== requested)
    refuse(
      `.library holds ${fetchedFor} (${commit}), but ${requested} is requested. Run \`npm run library\` again.`,
    );
  console.log(`Testing viell-effect-schema-http at ${commit}`);
}
