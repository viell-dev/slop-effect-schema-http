// What the host is built from. `npm run host` records its hash with the build, and the test setup
// refuses a build whose sources have changed since.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} root The suite's directory. @returns {string} */
export const hostSource = (root) => {
  const hash = createHash("sha256");
  const files = ["host/Cargo.toml", "host/Cargo.lock", "rust-toolchain.toml"];
  for (const name of readdirSync(join(root, "host", "src")).toSorted())
    files.push(`host/src/${name}`);
  for (const file of files)
    hash
      .update(`${file}\0`)
      .update(readFileSync(join(root, file)))
      .update("\0");
  return hash.digest("hex");
};
