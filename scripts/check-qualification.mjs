import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";

const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(String(run.id), process.env.QUALIFICATION_RUN);
assert.equal(run.repository.full_name, process.env.GITHUB_REPOSITORY);
assert.equal(run.path, ".github/workflows/release.yml");
assert.equal(run.event, "workflow_dispatch");
assert.equal(run.head_branch, "main");
assert.equal(run.head_sha, process.env.GITHUB_SHA);
assert.equal(run.status, "completed");
assert.equal(run.conclusion, "success");
