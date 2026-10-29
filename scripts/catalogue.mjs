// Check CATALOGUE.md against the tests: every entry has a known status, and every entry marked
// "tested" has at least one test whose title carries its ID, such as `[AUTH-3]`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalogue = readFileSync(join(root, "CATALOGUE.md"), "utf8");
const statuses = new Set(["pending", "tested", "limit", "defect"]);

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".test.ts")) files.push(path);
  }
};
walk(join(root, "src"));
const tests = files.map((file) => readFileSync(file, "utf8")).join("\n");

const entries = [...catalogue.matchAll(/^- \*\*([A-Z]+-\d+[a-z]?)\*\*/gm)];
const problems = [];
const tally = {};
entries.forEach((match, index) => {
  const id = match[1];
  const end = entries[index + 1]?.index ?? catalogue.length;
  const status = /Status:\s+(\w+)/.exec(catalogue.slice(match.index, end))?.[1];
  if (status === undefined || !statuses.has(status))
    problems.push(`${id}: missing or unknown status (${status})`);
  else tally[status] = (tally[status] ?? 0) + 1;
  if (status === "tested" && !tests.includes(`[${id}]`))
    problems.push(`${id}: marked tested, but no test title carries [${id}]`);
});

const ids = entries.map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
for (const id of new Set(duplicates))
  problems.push(`${id}: listed more than once`);

console.log(
  `catalogue: ${ids.length} entries (${Object.entries(tally)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ")})`,
);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
