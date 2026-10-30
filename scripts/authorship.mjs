// Check that a pull request which changes either side of the suite says which agent context wrote
// which side (AGENTS.md, "Separate authorship"): its description needs a line or heading that starts
// with "Authorship", such as `## Authorship` or `**Authorship.** …`. The rule is a matter of
// process; this check only makes a missing statement visible.
//
// CI runs it on pull requests, with the description in the PR_BODY environment variable, and
// compares the merge commit with its first parent, the base. Pass file paths as arguments to check
// them instead (`scripts/authorship.test.mjs` does).
//
// Usage: `PR_BODY=… node scripts/authorship.mjs [changed file…]`
import { execFileSync } from "node:child_process";

/** The paths each side owns; a change under any of them needs the statement. */
const SIDES = {
  backend: ["src/backends/", "src/conformance/", "services/"],
  consumer: [
    "src/clients/",
    "src/formats/",
    "src/values/",
    "src/scenarios/",
    "src/app/",
  ],
};

/** A line or heading that starts with "Authorship", after Markdown's heading, list or bold marks. */
const STATEMENT =
  /^[ \t>]*(?:#{1,6}[ \t]+|[-*+][ \t]+)?(?:\*\*|__)?Authorship\b/im;

const changed = (
  process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], {
        encoding: "utf8",
      }).split(/\r?\n/)
).filter((path) => path !== "");

const touched = Object.entries(SIDES)
  .filter(([, prefixes]) =>
    changed.some((path) => prefixes.some((prefix) => path.startsWith(prefix))),
  )
  .map(([side]) => side);

if (touched.length === 0) {
  console.log("authorship: no backend-side or consumer-side file changed");
  process.exit(0);
}
if (STATEMENT.test(process.env.PR_BODY ?? "")) {
  console.log(
    `authorship: the ${touched.join(" and ")} side changed, and the description states the authorship`,
  );
  process.exit(0);
}
console.error(
  `authorship: this pull request changes the ${touched.join(" and ")} side, but its description ` +
    'has no line or heading starting with "Authorship". Say which agent context wrote which side ' +
    '(AGENTS.md, "Separate authorship"), then edit the description; editing it runs the check again.',
);
process.exit(1);
