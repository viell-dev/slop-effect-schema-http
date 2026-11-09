import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { assertEffectFloor } from "./check-effect-floor.mjs";

// #193: use the real release graph, including platform-specific optional tool binaries.
const before = {
  manifest: JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  ),
  lock: JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url)),
  ),
};
const floor = before.manifest.peerDependencies.effect.slice(1);
const selected = () => {
  const after = globalThis.structuredClone(before);
  for (const name of ["effect", "@effect/vitest"]) {
    after.manifest.devDependencies[name] = floor;
    after.lock.packages[""].devDependencies[name] = floor;
    after.lock.packages[`node_modules/${name}`] = {
      version: floor,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${floor}.tgz`,
      integrity: "sha512-floor-fixture",
      dev: true,
    };
  }
  return after;
};

test("accept the saved Effect floor without changing the surrounding lockfile", () => {
  assert.equal(assertEffectFloor(before, selected()), floor);
});

test("reject the observed unrelated Vite/Rolldown upgrades", () => {
  const after = selected();
  after.lock.packages["node_modules/vite"].version = "8.3.7";
  after.lock.packages["node_modules/rolldown"].version = "1.2.18";
  assert.throws(() => assertEffectFloor(before, after), /unrelated/);
});

test("reject changed integrity even when an unrelated tool keeps its version", () => {
  const after = selected();
  after.lock.packages["node_modules/rolldown"].integrity = "sha512-changed";
  assert.throws(() => assertEffectFloor(before, after), /unrelated/);
});

test("reject an added nested Effect instead of silently widening the floor policy", () => {
  const after = selected();
  after.lock.packages["node_modules/vitest/node_modules/effect"] = {
    version: floor,
  };
  assert.throws(() => assertEffectFloor(before, after), /unrelated/);
});

test("reject removal of an unrelated platform-specific optional binary", () => {
  const after = selected();
  delete after.lock.packages["node_modules/@rolldown/binding-win32-x64-msvc"];
  assert.throws(() => assertEffectFloor(before, after), /unrelated/);
});

test("reject a helper that does not match the selected peer floor", () => {
  const after = selected();
  after.lock.packages["node_modules/@effect/vitest"].version = "999.0.0";
  assert.throws(() => assertEffectFloor(before, after), /@effect\/vitest/);
});

test("reject a no-save floor install whose root declarations still request the current peer", () => {
  const after = selected();
  after.manifest = globalThis.structuredClone(before.manifest);
  after.lock.packages[""] = globalThis.structuredClone(
    before.lock.packages[""],
  );
  assert.throws(() => assertEffectFloor(before, after), /unrelated/);
});

test("reject unrelated manifest and top-level lockfile changes", () => {
  for (const change of [
    (after) => {
      after.manifest.peerDependencies.effect = "^4.1.2";
    },
    (after) => {
      after.lock.lockfileVersion = 2;
    },
  ]) {
    const after = selected();
    change(after);
    assert.throws(() => assertEffectFloor(before, after), /unrelated/);
  }
});

test("require a reviewed floor policy when the supported peer-range shape changes", () => {
  const changed = globalThis.structuredClone(before);
  changed.manifest.peerDependencies.effect = ">=4.0.7";
  assert.throws(
    () => assertEffectFloor(changed, selected()),
    /peer range changes/,
  );
});
