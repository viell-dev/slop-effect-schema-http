import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const npm = process.env.npm_execpath;
assert.ok(npm, "Run with npm run release:prepare");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(
  git("status", "--porcelain", "--untracked-files=all"),
  "",
  "Commit the complete candidate before preparing it",
);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
assert.match(manifest.version, /^0\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/);
assert.notEqual(manifest.private, true);
assert.equal(manifest.version, lock.version);
assert.equal(manifest.version, lock.packages[""].version);
assert.ok(
  readFileSync("CHANGELOG.md", "utf8").includes(`## ${manifest.version}`),
);
const commit = git("rev-parse", "HEAD");
const output = join("artifacts", manifest.version);
assert.ok(
  !existsSync(output),
  `Inspect and move the previous ${output} before regenerating assets`,
);

// Clear only this checkout's generated directory; never follow a link to another tree.
const dist = resolve("dist");
if (existsSync(dist)) {
  assert.ok(!lstatSync(dist).isSymbolicLink());
  assert.equal(resolve(realpathSync(dist)), dist);
  rmSync(dist, { recursive: true });
}
const run = (...args) =>
  execFileSync(process.execPath, [npm, ...args], { stdio: "inherit" });
for (const script of [
  "check",
  "lint",
  "build",
  "test",
  "test:release",
  "docs:examples",
  "docs:build",
])
  run("run", script);
run("audit", "--audit-level=moderate");
run("run", "test:package", "--", "--out-dir", output);
run(
  "run",
  "test:package",
  "--",
  "--tarball",
  join(output, `${manifest.name}-${manifest.version}.tgz`),
  "--effect",
  "4.0.7",
);
run(
  "run",
  "test:package",
  "--",
  "--tarball",
  join(output, `${manifest.name}-${manifest.version}.tgz`),
  "--typescript",
  "7.0.2",
);
assert.equal(git("rev-parse", "HEAD"), commit);
assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
console.log(
  `Prepared ${manifest.version} at ${commit}. Nothing published. Run the separate hostile lanes before release.`,
);
