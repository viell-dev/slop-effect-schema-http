import assert from "node:assert/strict";
import console from "node:console";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.argv[2];
const entries = readdirSync(root);
assert.equal(entries.length, 1, "Expected one version directory");
const version = entries[0];
assert.match(version, /^0\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/);
const path = join(root, version, "manifest.json");
const manifest = JSON.parse(readFileSync(path, "utf8"));
assert.equal(manifest.version, version);
assert.equal(manifest.name, "viell-effect-schema-http");
assert.equal(manifest.filename, `${manifest.name}-${version}.tgz`);
assert.equal(manifest.sourceCommit, process.env.SOURCE_COMMIT);
console.log(path);
