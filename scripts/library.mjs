// Write the library at the commit in `library-ref` (or the LIBRARY_REF environment variable) into
// `.library/`, using only Git.
//
// - `npm run library` writes the commit's `src` tree and package.json, and the suite imports the
//   library from that source. No dependencies are installed under `.library/`, so the library's
//   imports of `effect` resolve to this suite's copy.
// - `npm run library:pack` (`--pack`) does the same, then writes the whole commit into
//   `.library/build/`, installs its locked dependencies there with `npm ci`, builds it with
//   `npm run build` and packs it with `npm pack` into `.library/viell-effect-schema-http.tgz`. It
//   installs that tarball into this suite's node_modules with `npm install --no-save`, beside the
//   suite's own `effect` as its peer, for the packed lane. `.library/PACKED` records the commit, the
//   requested ref and the tarball's integrity, which the packed lane checks against node_modules.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIBRARY = "viell-effect-schema-http";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, ".library");
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 1 << 26,
  });

const pack = process.argv.includes("--pack");

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

/** Write the commit's files under `paths` (all of them when none) that `keep` accepts into `into`. */
const extract = (into, paths = [], keep = () => true) => {
  const entries = git("ls-tree", "-r", "-z", commit, "--", ...paths)
    .toString()
    .split("\0")
    .filter((entry) => entry !== "");
  let written = 0;
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (!keep(path)) continue;
    // A link or a submodule would need more than its blob; the library has neither.
    if (type !== "blob" || mode === "120000")
      throw new Error(`${path}: cannot write a ${mode} ${type} entry`);
    const destination = join(into, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, git("cat-file", "blob", object));
    written++;
  }
  return written;
};

rmSync(target, { recursive: true, force: true });
const files = extract(
  target,
  ["src", "package.json"],
  (path) => !path.endsWith(".test.ts"),
);
writeFileSync(join(target, "REF"), `${commit}\n${requested}\n`);

const library = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
const suite = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
console.log(
  `library ${library.name}@${library.version} at ${commit}: ${files} files`,
);
console.log(
  `effect: library peer ${library.peerDependencies?.effect}, suite ${suite.devDependencies.effect}`,
);

if (pack) {
  // Run the npm that runs this script, as a fresh command: npm passes its own configuration and
  // this package's details to scripts in `npm_*` variables, which must not reach the library's
  // build. Install scripts stay off, as in this suite's .npmrc.
  const cli = process.env.npm_execpath;
  if (cli === undefined)
    throw new Error(
      "Run `npm run library:pack`, so the script knows which npm to use.",
    );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)),
  );
  const npm = (cwd, ...args) =>
    execFileSync(process.execPath, [cli, ...args, "--ignore-scripts"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });

  const build = join(target, "build");
  const tree = extract(build);
  console.log(`build: ${tree} files of ${commit} in .library/build`);
  process.stdout.write(npm(build, "ci", "--no-audit", "--no-fund"));
  process.stdout.write(npm(build, "run", "build"));
  const [packed] = JSON.parse(
    npm(build, "pack", "--json", "--pack-destination", target),
  );
  if (packed.name !== LIBRARY)
    throw new Error(`packed ${packed.name}, expected ${LIBRARY}`);
  const tarball = `${LIBRARY}.tgz`;
  renameSync(join(target, packed.filename), join(target, tarball));
  writeFileSync(
    join(target, "PACKED"),
    `${commit}\n${requested}\n${packed.integrity}\n`,
  );
  console.log(
    `packed ${packed.id}: ${packed.files.length} files, ${packed.size} bytes, ${packed.integrity}`,
  );

  process.stdout.write(
    npm(
      root,
      "install",
      "--no-save",
      "--no-audit",
      "--no-fund",
      `./.library/${tarball}`,
    ),
  );
  const installed = JSON.parse(
    readFileSync(join(root, "node_modules", ".package-lock.json"), "utf8"),
  ).packages?.[`node_modules/${LIBRARY}`];
  if (installed?.integrity !== packed.integrity)
    throw new Error(
      `node_modules/${LIBRARY} has integrity ${installed?.integrity}, not the packed ${packed.integrity}`,
    );
  console.log(
    `installed ${packed.id} into node_modules from .library/${tarball}`,
  );
}
