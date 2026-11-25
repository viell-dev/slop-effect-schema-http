// Write the library at the commit in refs.json (or the LIBRARY_REF environment variable) into
// `.library/`, using only Git: the commit's `src` tree and package.json. No dependencies are
// installed there, so the library's imports of `effect` resolve to this suite's copy.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, ".library");
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 1 << 26,
  });

const requested = (
  process.env.LIBRARY_REF ??
  JSON.parse(readFileSync(join(root, "refs.json"), "utf8")).library
).trim();
if (requested === "") throw new Error("no library ref");

let commit;
try {
  commit = git("rev-parse", "--verify", "--quiet", `${requested}^{commit}`)
    .toString()
    .trim();
} catch {
  // A shallow CI checkout of this branch does not contain library commits; fetch the one needed.
  git("fetch", "--quiet", "--depth=1", "origin", requested);
  commit = git("rev-parse", "--verify", "FETCH_HEAD^{commit}")
    .toString()
    .trim();
}

rmSync(target, { recursive: true, force: true });
const entries = git("ls-tree", "-r", "-z", commit, "--", "src", "package.json")
  .toString()
  .split("\0")
  .filter((entry) => entry !== "");
let files = 0;
for (const entry of entries) {
  const tab = entry.indexOf("\t");
  const [mode, type, object] = entry.slice(0, tab).split(" ");
  const path = entry.slice(tab + 1);
  if (path.endsWith(".test.ts")) continue;
  if (type !== "blob" || mode === "120000")
    throw new Error(`${path}: cannot write a ${mode} ${type} entry`);
  const destination = join(target, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, git("cat-file", "blob", object));
  files++;
}
writeFileSync(join(target, "REF"), `${commit}\n${requested}\n`);
const library = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
console.log(
  `library ${library.name}@${library.version} at ${commit}: ${files} files`,
);
