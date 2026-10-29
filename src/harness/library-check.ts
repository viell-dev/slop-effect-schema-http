import { existsSync, readFileSync } from "node:fs";

/**
 * Vitest global setup: refuse to run against a missing or stale library checkout, so a run never
 * reports results for a different library commit than the one it claims to test.
 */
export default function setup(): void {
  const root = new URL("../../", import.meta.url);
  const fetched = new URL(".library/REF", root);
  if (!existsSync(fetched))
    throw new Error(
      "The library source is missing. Run `npm run library` first.",
    );
  const requested = (
    process.env["LIBRARY_REF"] ??
    readFileSync(new URL("library-ref", root), "utf8")
  ).trim();
  const [commit = "", fetchedFor = ""] = readFileSync(fetched, "utf8").split(
    "\n",
  );
  if (fetchedFor !== requested)
    throw new Error(
      `.library holds ${fetchedFor} (${commit}), but ${requested} is requested. Run \`npm run library\` again.`,
    );
  console.log(`Testing viell-effect-schema-http at ${commit}`);
}
