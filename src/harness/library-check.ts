import { existsSync, readFileSync } from "node:fs";
import type { TestProject } from "vitest/node";

const root = new URL("../../", import.meta.url);
const LIBRARY = "viell-effect-schema-http";

/**
 * Stop the run, saying why. The error's stack is the reason alone: Vitest cannot print an error
 * thrown from a global setup whose stack it maps itself ("code.charCodeAt is not a function").
 */
const refuse = (reason: string): never => {
  const error = new Error(reason);
  error.stack = `Error: ${reason}`;
  throw error;
};

/** The library ref the run claims to test: LIBRARY_REF, or the commit in `library-ref`. */
const requested = () =>
  (
    process.env["LIBRARY_REF"] ??
    readFileSync(new URL("library-ref", root), "utf8")
  ).trim();

/** The lines of a record that `npm run library` wrote under `.library/`. */
const record = (name: string, missing: string) => {
  const path = new URL(`.library/${name}`, root);
  if (!existsSync(path)) refuse(missing);
  return readFileSync(path, "utf8").split("\n");
};

/** Refuse a missing or stale `.library/src`, which the node and browser projects import. */
const checkSource = () => {
  const [commit = "", fetchedFor = ""] = record(
    "REF",
    "The library source is missing. Run `npm run library` first.",
  );
  if (fetchedFor !== requested())
    refuse(
      `.library holds ${fetchedFor} (${commit}), but ${requested()} is requested. Run \`npm run library\` again.`,
    );
  console.log(`Testing ${LIBRARY} at ${commit}`);
};

/**
 * Refuse a missing or stale package in node_modules, which the packed project imports. It must be
 * the tarball `npm run library:pack` packed for the requested ref, as npm's record of the
 * installed tree shows by the tarball's integrity.
 */
const checkPackage = () => {
  const [commit = "", packedFor = "", integrity = ""] = record(
    "PACKED",
    "The packed library is missing. Run `npm run library:pack` first.",
  );
  if (packedFor !== requested())
    refuse(
      `.library holds a package packed for ${packedFor} (${commit}), but ${requested()} is requested. Run \`npm run library:pack\` again.`,
    );
  const tree = new URL("node_modules/.package-lock.json", root);
  const installed: unknown = existsSync(tree)
    ? JSON.parse(readFileSync(tree, "utf8")).packages?.[
        `node_modules/${LIBRARY}`
      ]?.integrity
    : undefined;
  if (installed !== integrity)
    refuse(
      `node_modules holds ${installed === undefined ? "no" : `a different (${String(installed)})`} ${LIBRARY}, not the one packed at ${commit} (${integrity}). Run \`npm run library:pack\` again.`,
    );
  console.log(`Testing the packed ${LIBRARY} at ${commit} (${integrity})`);
};

/**
 * Vitest global setup: refuse to run against a missing or stale library, so a run never reports
 * results for a different library commit than the one it claims to test. The project named
 * "packed" imports the installed package; the others import the fetched source.
 */
export default function setup(project: TestProject): void {
  if (project.name === "packed") checkPackage();
  else checkSource();
}
