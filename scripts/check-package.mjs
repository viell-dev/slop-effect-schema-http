import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import console from "node:console";
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = readJson(join(repository, "package.json"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run test:package");

const temporaryRoot = realpathSync(tmpdir());
const consumer = mkdtempSync(
  join(temporaryRoot, "effect-schema-http-package-"),
);
let passed = false;

const run = (args, cwd = consumer) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
};

try {
  console.log("Packing the built library and checking its file list...");
  const [packed] = JSON.parse(
    run(
      [
        npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        consumer,
      ],
      repository,
    ),
  );
  const files = new Set(packed.files.map((file) => file.path));
  for (const file of files) {
    assert.match(
      file,
      /^(?:dist\/|src\/|README\.md$|package\.json$|LICENSE(?:\.md|\.txt)?$)/,
      `Unexpected package content: ${file}`,
    );
    assert.doesNotMatch(
      file,
      /(?:^|\/)(?:tests?|__tests__|docs|scripts|fixtures)(?:\/|$)|\.(?:test|spec)\./,
      `Development content in package: ${file}`,
    );
  }
  for (const file of [
    "README.md",
    "dist/main.js",
    "dist/main.d.ts",
    "src/main.ts",
  ]) {
    assert.ok(
      files.has(file),
      `Missing package content: ${file}; run npm run build first`,
    );
  }

  // Check every declared target, including the package.json subpath.
  const checkTarget = (target) => {
    if (typeof target === "string") {
      assert.ok(target.startsWith("./"), `Nonlocal export target: ${target}`);
      assert.ok(files.has(target.slice(2)), `Missing export target: ${target}`);
    } else {
      assert.ok(
        target && typeof target === "object",
        "Unsupported export target",
      );
      for (const value of Object.values(target)) checkTarget(value);
    }
  };
  for (const target of Object.values(manifest.exports)) checkTarget(target);

  // Pin the consumer tools and peer to the versions actually installed by npm ci.
  const version = (name) =>
    readJson(join(repository, "node_modules", name, "package.json")).version;
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [manifest.name]: `file:./${packed.filename}`,
        effect: version("effect"),
      },
      devDependencies: {
        typescript: version("typescript"),
        "@types/node": version("@types/node"),
      },
    }),
  );
  console.log("Installing the tarball into an isolated temporary consumer...");
  run([npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const installed = join(consumer, "node_modules", manifest.name);
  assert.ok(
    !lstatSync(installed).isSymbolicLink(),
    "Expected an unpacked tarball, not a link",
  );
  const installedManifest = readJson(join(installed, "package.json"));
  assert.deepEqual(installedManifest.exports, manifest.exports);
  assert.equal(installedManifest.version, manifest.version);

  for (const file of ["consumer.ts", "runtime.mjs"]) {
    copyFileSync(
      join(repository, "fixtures", "package", file),
      join(consumer, file),
    );
  }
  // These imports also make every subpath's declarations part of the type-check.
  const exportImports = Object.keys(manifest.exports).map((subpath, index) => {
    assert.ok(
      !subpath.includes("*"),
      "Add a concrete consumer for wildcard exports",
    );
    const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
    return subpath.endsWith(".json")
      ? `export { default as Export${index} } from ${JSON.stringify(specifier)} with { type: "json" };`
      : `export * as Export${index} from ${JSON.stringify(specifier)};`;
  });
  writeFileSync(join(consumer, "exports.ts"), exportImports.join("\n"));
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        target: "ES2022",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        declaration: true,
        noEmitOnError: true,
        resolveJsonModule: true,
        verbatimModuleSyntax: true,
        types: ["node"],
        outDir: "dist",
      },
      include: ["consumer.ts", "exports.ts"],
    }),
  );
  console.log(
    "Type-checking declarations and emitting a consumer declaration...",
  );
  run([
    join(consumer, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.json",
  ]);
  assert.ok(
    readFileSync(join(consumer, "dist", "consumer.d.ts"), "utf8").includes(
      "getItem",
    ),
  );
  console.log("Importing every export and executing the compiled consumer...");
  console.log(run([join(consumer, "runtime.mjs")]).trim());
  passed = true;
} finally {
  if (passed) {
    // Only remove the temporary directory created above, with no redirected target.
    assert.equal(dirname(consumer), temporaryRoot);
    assert.equal(resolve(realpathSync(consumer)), resolve(consumer));
    rmSync(consumer, { recursive: true });
  } else {
    console.error(`Failed consumer retained at ${consumer}`);
  }
}
