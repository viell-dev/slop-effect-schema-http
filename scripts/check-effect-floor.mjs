import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

// #193: floor qualification varies Effect and its helpers, not the surrounding toolchain.
export function assertEffectFloor(before, after) {
  const floor = /^\^(4\.\d+\.\d+)$/.exec(
    before.manifest.peerDependencies.effect,
  )?.[1];
  assert.ok(
    floor,
    "Review the floor policy when the Effect peer range changes",
  );
  const expected = globalThis.structuredClone(before);
  for (const name of ["effect", "@effect/vitest"]) {
    expected.manifest.devDependencies[name] = floor;
    expected.lock.packages[""].devDependencies[name] = floor;
    const path = `node_modules/${name}`;
    assert.equal(
      after.lock.packages[path]?.version,
      floor,
      `Floor qualification must select ${name}@${floor}`,
    );
    expected.lock.packages[path] = after.lock.packages[path];
  }
  assert.deepEqual(
    after,
    expected,
    "Floor qualification changed unrelated manifest or lockfile data; review the dependency graph before changing this policy",
  );
  return floor;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = { manifest: "package.json", lock: "package-lock.json" };
  const read = (contents) =>
    Object.fromEntries(
      Object.entries(files).map(([key, path]) => [
        key,
        JSON.parse(contents(path)),
      ]),
    );
  const before = read((path) =>
    execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  const after = read((path) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
  );
  const floor = assertEffectFloor(before, after);
  console.log(
    `Effect ${floor} floor selected; all unrelated tooling remains locked.`,
  );
}
