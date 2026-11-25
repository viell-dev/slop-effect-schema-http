// Build the Rust host with the locked Warded commits, write its loopback certificate into `.host/`,
// and record which commits and sources it was built from.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostSource } from "./host-source.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = join(root, "host", "Cargo.toml");

// The router must reach the server as the commit under test, not as the crates.io release the
// server pins, so the lock may hold only one `warded`, from Git.
const lock = readFileSync(join(root, "host", "Cargo.lock"), "utf8");
const packages = [
  ...lock.matchAll(
    /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g,
  ),
];
const commits = {};
for (const name of ["warded", "warded-server"]) {
  const found = packages.filter(([, package_]) => package_ === name);
  const [, , version, source] = found[0] ?? [];
  if (found.length !== 1 || !source?.startsWith("git+"))
    throw new Error(
      `host/Cargo.lock must hold one ${name} from Git, not ${found.length}`,
    );
  commits[name] = { version, commit: source.split("#")[1] };
}

const source = hostSource(root);
const messages = execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    manifest,
    "--message-format=json-render-diagnostics",
  ],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 1 << 28,
  },
);
const { executable } = messages
  .split("\n")
  .filter((line) => line.includes('"executable":"'))
  .map((line) => JSON.parse(line))
  .at(-1);
const directory = join(root, ".host");
mkdirSync(directory, { recursive: true });
execFileSync(executable, ["certificate", directory], { stdio: "inherit" });
writeFileSync(
  join(directory, "BUILT"),
  `${JSON.stringify({ executable, source, ...commits }, null, 2)}\n`,
);
for (const [name, { version, commit }] of Object.entries(commits))
  console.log(`${name} ${version} at ${commit}`);
console.log(`host: ${executable}`);
