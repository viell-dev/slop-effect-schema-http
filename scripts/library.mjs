// Write the library's `src` tree and package.json at the commit in `library-ref` (or the
// LIBRARY_REF environment variable) into `.library/`, using only Git. The suite then imports the
// library from source. No dependencies are installed under `.library/`, so the library's imports of
// `effect` resolve to this suite's copy.
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
  process.env.LIBRARY_REF ?? readFileSync(join(root, "library-ref"), "utf8")
).trim();
if (requested === "") throw new Error("library-ref is empty");

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
const files = git(
  "ls-tree",
  "-r",
  "--name-only",
  "-z",
  commit,
  "--",
  "src",
  "package.json",
)
  .toString()
  .split("\0")
  .filter((path) => path !== "" && !path.endsWith(".test.ts"));
for (const path of files) {
  const destination = join(target, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, git("show", `${commit}:${path}`));
}
writeFileSync(join(target, "REF"), `${commit}\n${requested}\n`);

const library = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
const suite = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
console.log(
  `library ${library.name}@${library.version} at ${commit}: ${files.length} files`,
);
console.log(
  `effect: library peer ${library.peerDependencies?.effect}, suite ${suite.devDependencies.effect}`,
);
