import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const temporaryRoot = realpathSync(tmpdir());
const temporary = mkdtempSync(join(temporaryRoot, "schema-http-release-gate-"));
const script = fileURLToPath(
  new URL("./check-qualification.mjs", import.meta.url),
);
const qualified = {
  id: 123,
  repository: { full_name: "example/library" },
  path: ".github/workflows/release.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: "a".repeat(40),
  status: "completed",
  conclusion: "success",
};

test("only the successful exact-commit qualification producer admits publication", (t) => {
  t.after(() => {
    assert.equal(dirname(temporary), temporaryRoot);
    assert.equal(resolve(realpathSync(temporary)), resolve(temporary));
    rmSync(temporary, { recursive: true });
  });
  const file = join(temporary, "run.json");
  const check = (run) => {
    writeFileSync(file, JSON.stringify(run));
    return spawnSync(process.execPath, [script, file], {
      encoding: "utf8",
      env: {
        ...process.env,
        QUALIFICATION_RUN: "123",
        GITHUB_REPOSITORY: "example/library",
        GITHUB_SHA: "a".repeat(40),
      },
    });
  };
  const valid = check(qualified);
  assert.equal(valid.status, 0, valid.stderr);
  for (const change of [
    { id: 124 },
    { repository: { full_name: "fork/library" } },
    { path: ".github/workflows/ci.yml" },
    { event: "pull_request" },
    { head_branch: "task-branch" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
  ]) {
    const rejected = check({ ...qualified, ...change });
    assert.equal(rejected.status, 1, JSON.stringify(change));
    assert.match(rejected.stderr, /AssertionError/);
  }
});
