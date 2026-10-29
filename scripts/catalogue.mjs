// Check CATALOGUE.md against the tests: every entry has a known status, and every entry marked
// "tested" has evidence.
//
// - `node scripts/catalogue.mjs` (in `npm run check`) reads the test sources: an entry marked
//   "tested" needs a test whose title carries its ID, such as `[AUTH-3]`. It is fast, and it runs
//   nothing.
// - `node scripts/catalogue.mjs --results <junit.xml>...` (in `npm test` and CI, after the lanes)
//   reads the JUnit reports of the runs instead. Each report needs at least one passed test, and an
//   entry marked "tested" needs a passed, not skipped, test carrying its ID in at least one lane.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalogue = readFileSync(join(root, "CATALOGUE.md"), "utf8");
const statuses = new Set(["pending", "tested", "limit", "defect"]);

const entries = [...catalogue.matchAll(/^- \*\*([A-Z]+-\d+[a-z]?)\*\*/gm)];
const problems = [];
const tally = {};
const tested = [];
entries.forEach((match, index) => {
  const id = match[1];
  const end = entries[index + 1]?.index ?? catalogue.length;
  const status = /Status:\s+(\w+)/.exec(catalogue.slice(match.index, end))?.[1];
  if (status === undefined || !statuses.has(status))
    problems.push(`${id}: missing or unknown status (${status})`);
  else tally[status] = (tally[status] ?? 0) + 1;
  if (status === "tested") tested.push(id);
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

const results = process.argv.indexOf("--results");
if (results < 0) {
  // Source mode: the test titles as written.
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
  for (const id of tested)
    if (!tests.includes(`[${id}]`))
      problems.push(`${id}: marked tested, but no test title carries [${id}]`);
} else {
  // Results mode: the tests as executed, from each lane's JUnit report.
  const reports = process.argv.slice(results + 1);
  if (reports.length === 0)
    problems.push("--results needs at least one JUnit report");
  const entity = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  const unescape = (text) =>
    text.replace(
      /&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi,
      (whole, hex, dec, name) =>
        hex !== undefined
          ? String.fromCodePoint(Number.parseInt(hex, 16))
          : dec !== undefined
            ? String.fromCodePoint(Number(dec))
            : (entity[name] ?? whole),
    );
  const passedIn = new Map(tested.map((id) => [id, []]));
  const lanes = [];
  for (const report of reports) {
    const lane = basename(report, ".xml").replace(/^junit-/, "");
    if (!existsSync(report)) {
      problems.push(`${report}: no such JUnit report`);
      continue;
    }
    const xml = readFileSync(report, "utf8");
    let passed = 0;
    let skipped = 0;
    let failed = 0;
    for (const [, attributes, , body = ""] of xml.matchAll(
      /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g,
    )) {
      const name = unescape(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? "");
      if (/<(failure|error)\b/.test(body)) failed++;
      else if (/<skipped\b/.test(body)) skipped++;
      else {
        passed++;
        for (const id of tested)
          if (name.includes(`[${id}]`) && !passedIn.get(id).includes(lane))
            passedIn.get(id).push(lane);
      }
    }
    lanes.push(
      `${lane} ${passed} passed, ${skipped} skipped, ${failed} failed`,
    );
    if (passed === 0) problems.push(`${report}: no passed test in this lane`);
  }
  const both = [...passedIn.values()].filter(
    (found) => found.length === reports.length,
  ).length;
  console.log(
    `results: ${lanes.join("; ")}; ${both} of ${tested.length} tested entries passed in every lane`,
  );
  for (const [id, found] of passedIn)
    if (found.length === 0)
      problems.push(
        `${id}: marked tested, but no passed test carries [${id}] in ${reports.join(", ")}`,
      );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
