import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Compare the tested versions the documents state with the files that set them.
//
// Those statements record what a release was qualified on, so release preparation compares them,
// not every pull request: a routine dependency update merges without a release and cannot edit
// prose. Between releases the documents keep describing the last qualification.

// The section of each document that describes the current matrix. Anything outside it, such as a
// release history, keeps the versions it recorded.
export const matrixSections = {
  "docs/limits.md": "## Compatibility and scope",
  "CONTRIBUTING.md": "## Development and verification",
  "RELEASING.md": "## Prepare a candidate",
};

const sectionOf = (text, heading) => {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `Missing the section "${heading}"`);
  const sameOrHigher = new RegExp(`^#{1,${heading.indexOf(" ")}} `);
  const end = lines.findIndex(
    (line, index) => index > start && sameOrHigher.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
};

/** What each document must state, and the versions it may state, for the checkout at `root`. */
export function testedStatements(root = ".") {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const workflow = (name) => read(`.github/workflows/${name}`);
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const prepare = read("scripts/prepare-release.mjs");
  const preparedWith = (option) =>
    new RegExp(`"--${option}",\\s*"([^"]+)"`).exec(prepare)?.[1];
  const nodeVersion = read(".nvmrc").trim();
  const newestNodes = new Set(
    ["ci.yml", "release.yml"].flatMap((name) =>
      Array.from(
        workflow(name).matchAll(/node-version: "(\d+)"/g),
        (match) => match[1],
      ),
    ),
  );
  assert.equal(
    newestNodes.size,
    1,
    "CI and release qualification must test the same newest Node.js major",
  );
  const [newestNode] = newestNodes;
  const effectFloor = preparedWith("effect");
  const consumerCompiler = preparedWith("typescript");
  assert.equal(
    manifest.peerDependencies.effect,
    `^${effectFloor}`,
    "Release preparation must test the floor of the Effect peer range",
  );
  const effect = lock.packages["node_modules/effect"].version;
  const compiler = lock.packages["node_modules/typescript"].version;

  // The pin is on the suite's own branch, which a shallow checkout does not have.
  const suiteCommit = /ref: ([0-9a-f]{40})/.exec(workflow("release.yml"))?.[1];
  assert.ok(suiteCommit, "Missing the hostile suite's pin in release.yml");
  let playwright;
  if (
    spawnSync("git", ["cat-file", "-e", `${suiteCommit}^{commit}`], {
      cwd: root,
    }).status === 0
  ) {
    const suite = JSON.parse(
      execFileSync("git", ["show", `${suiteCommit}:package-lock.json`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    playwright = suite.packages["node_modules/playwright"].version;
  }
  const testedNode = `Node.js ${nodeVersion} and the newest Node.js ${newestNode}`;
  const testedEffect = `Effect ${effectFloor} and ${effect}`;
  return {
    suiteCommit,
    statements: {
      "docs/limits.md": [
        `Node.js ${nodeVersion.split(".")[0]} or ${newestNode} on Windows or Linux`,
        testedNode,
        testedEffect,
        `strict TypeScript consumers using ${compiler} and ${consumerCompiler}`,
        `\`${manifest.engines.node}\``,
      ],
      "CONTRIBUTING.md": [
        testedNode,
        testedEffect,
        `TypeScript ${compiler} and ${consumerCompiler} consumers`,
        `effect@${effect}`,
        `remains TypeScript ${compiler}`,
        `consumers with TypeScript ${consumerCompiler}`,
        ...(playwright ? [`Playwright ${playwright}`] : []),
      ],
      "RELEASING.md": [
        `consumer with Effect ${effect}`,
        `Effect ${effectFloor} peer floor`,
        `TypeScript ${consumerCompiler} consumer`,
        `newest Node.js ${newestNode}`,
      ],
    },
    versions: {
      "Node.js": [nodeVersion],
      Effect: [effectFloor, effect],
      TypeScript: [compiler, consumerCompiler],
      Playwright: playwright ? [playwright] : undefined,
    },
  };
}

/** Throw if a document's current matrix disagrees with the files that set it. */
export function checkTestedVersions(root = ".") {
  const { statements, suiteCommit, versions } = testedStatements(root);
  if (!versions.Playwright) {
    const prefix = process.env.GITHUB_ACTIONS === "true" ? "::notice::" : "";
    console.log(
      `${prefix}Skipped the Playwright version: the hostile suite commit ${suiteCommit} is not in this checkout.`,
    );
  }
  for (const [file, phrases] of Object.entries(statements)) {
    const text = sectionOf(
      readFileSync(join(root, file), "utf8"),
      matrixSections[file],
    ).replace(/\s+/g, " ");
    for (const phrase of phrases) {
      assert.ok(
        text.includes(phrase),
        `Update the tested versions in ${file}: expected "${phrase}"`,
      );
    }
    // A version left behind in another sentence of the same section.
    for (const [, tool, ...stated] of text.matchAll(
      /\b(Node\.js|Effect|TypeScript|Playwright) (\d+\.\d+\.\d+)(?: and (\d+\.\d+\.\d+))?/g,
    )) {
      for (const version of stated.filter(Boolean)) {
        assert.ok(
          versions[tool]?.includes(version) ?? true,
          `${file} states ${tool} ${version}, which is not a tested version`,
        );
      }
    }
  }
}
