import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Embedded, executable documentation sources. Runners, release-check.mjs and production files
// deliberately stay outside this allowlist. Review additions with their snippet and execution path.
const examples = new Set([
  "examples/overview.ts",
  "examples/quickstart.ts",
  "examples/usage.ts",
  "examples/opaque-neighbor.ts",
  "examples/union-annotations.ts",
  ...Array.from(
    { length: 15 },
    (_, index) => `examples/migration-0-${index + 2}.ts`,
  ),
  ...[
    "body",
    "interaction",
    "operation",
    "policy",
    "request",
    "response",
    "transport",
    "url-encoding",
  ].map((name) => `examples/modules/${name}.ts`),
  ...[
    "adjust-a-definition",
    "api-vocabulary",
    "counted-list",
    "create-then-upload",
    "cross-origin",
    "definition-defaults",
    "fetch-options",
    "find-the-api",
    "fixed-credentials",
    "id-from-location",
    "second-prefix",
    "shared-errors",
  ].map((name) => `examples/recipes/${name}.ts`),
]);

/** A canonical repository path that may change without changing the installed release. */
export function isDocumentationSource(path) {
  return (
    typeof path === "string" &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    (path.startsWith("docs/") || examples.has(path))
  );
}

/** Apply one policy to local git paths and GitHub's comparison filenames, including rename sources. */
export function assertDocumentationPaths(paths) {
  for (const path of paths) {
    assert.ok(isDocumentationSource(path), `Non-documentation change: ${path}`);
  }
}

/** Verify a correction with trusted main-branch code before checking out its source for the build. */
export function verifyDocumentationCorrection(
  tag,
  correction,
  git = (args) => execFileSync("git", args, { encoding: "utf8" }),
) {
  assert.match(tag, /^0\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/);
  if (!correction) return;
  assert.match(
    correction,
    /^[0-9a-f]{40}$/,
    "Correction must be a complete commit SHA",
  );
  const release = `refs/tags/${tag}`;
  git(["merge-base", "--is-ancestor", release, correction]);
  // No rename detection: both the old and new path must be permitted.
  const paths = git([
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    release,
    correction,
  ])
    .split("\0")
    .filter(Boolean);
  assertDocumentationPaths(paths);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const tag = process.env.RELEASE_TAG;
  if (tag) verifyDocumentationCorrection(tag, process.env.CORRECTION_REF);
}
