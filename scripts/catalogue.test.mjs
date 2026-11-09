// Exercise the result gate with complete synthetic reports, without running a service or browser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("./catalogue.mjs", import.meta.url));
const catalogue = readFileSync(join(root, "CATALOGUE.md"), "utf8");
const entries = [...catalogue.matchAll(/^- \*\*([A-Z]+-\d+[a-z]?)\*\*/gm)];
const ordinary = [];
const app = [];
for (const [index, entry] of entries.entries()) {
  const section = catalogue.slice(
    entry.index,
    entries[index + 1]?.index ?? catalogue.length,
  );
  if (!/Status:\s+tested\b/.test(section)) continue;
  (/\bLane:\s+app\b/.test(section) ? app : ordinary).push(entry[1]);
}
assert.ok(
  ordinary.length > 0 && app.length > 0,
  "Fixtures need ordinary and dedicated-lane entries",
);

const temporaryRoot = realpathSync(tmpdir());
const workspace = mkdtempSync(join(temporaryRoot, "schema-http-catalogue-"));
assert.equal(dirname(workspace), temporaryRoot);
after(() => rmSync(workspace, { recursive: true }));
let fixtures = 0;

const report = (ids, extra = "") =>
  `<testsuites><testsuite>${ids.map((id) => `<testcase name="[${id}] passing control"/>`).join("")}${extra}</testsuite></testsuites>`;

/** Each report name supplies its lane, as it does in the real test commands. */
const run = (reports) => {
  const directory = join(workspace, String(++fixtures));
  mkdirSync(directory);
  const paths = reports.map(([lane, xml]) => {
    const path = join(directory, `junit-${lane}.xml`);
    writeFileSync(path, xml);
    return path;
  });
  const result = spawnSync(process.execPath, [script, "--results", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
};

test("complete ordinary reports pass without the app-only entries", () => {
  const result = run([["node", report(ordinary)]]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 skipped, 0 failed/);
});

test("a dedicated app report passes without ordinary-lane entries", () => {
  const result = run([["app", report(app)]]);
  assert.equal(result.status, 0, result.stderr);
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/199
for (const [element, reason] of [
  ["skipped", "skipped"],
  ["failure", "failed"],
  ["error", "failed"],
]) {
  test(`a passing same-ID control cannot hide a selected ${element} case`, () => {
    const selected = `<testcase name="[${ordinary[0]}] required regression"><${element}/></testcase>`;
    const result = run([["node", report(ordinary, selected)]]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      new RegExp(`unexpected ${reason} test count: 1`),
    );
  });
}

test("another passing lane cannot hide a selected skipped case", () => {
  const selected = `<testcase name="[${ordinary[0]}] required regression"><skipped/></testcase>`;
  const result = run([
    ["node", report(ordinary)],
    ["browser", report(ordinary, selected)],
  ]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /junit-browser\.xml: unexpected skipped test count: 1/,
  );
});

test("an empty selected report is refused", () => {
  const result = run([["node", report([])]]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no passed test in this lane/);
});

test("an omitted dedicated-lane case still needs its own passing evidence", () => {
  const result = run([["app", report(app.slice(1))]]);
  assert.equal(result.status, 1);
  assert.ok(
    result.stderr.includes(`${app[0]}: marked tested, but no passed test`),
  );
});
