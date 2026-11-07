import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  compareVersions,
  currentlyTests,
  exitCodeOf,
  githubWith,
  reconcile,
} from "./check-live.mjs";

const { Response } = globalThis;
const repository = "example/library";
const commit = "a".repeat(40);
const tarball = "library-1.2.3.tgz";
const bytes = Buffer.from("the qualified package");
const digest = (name, encoding) =>
  createHash(name).update(bytes).digest(encoding);
const integrity = `sha512-${digest("sha512", "base64")}`;
const label = { name: "Type: Bug", color: "d73a4a", description: "Wrong." };
const pinned = `// https://github.com/${repository}/issues/7\nit("currently keeps it", () => {});\n`;

/** Where a test's release asset is served. */
const assetUrl = (name) => `https://github.test/${name}`;

/** Report entries in these states, for the exit code. */
const inStates = (...states) => states.map((state) => ({ state }));

/** Run a script directly, with no gh or git on the path. */
const startScript = (script, env = {}) =>
  spawnSync(
    process.execPath,
    [fileURLToPath(new URL(script, import.meta.url))],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "", Path: "", ...env },
    },
  );

// A published world in which every surface agrees. Each test changes one thing.
function world() {
  const manifest = {
    name: "library",
    version: "1.2.3",
    description: "A library",
    homepage: "https://example.test/library/",
    repository: { url: `git+https://github.com/${repository}.git` },
  };
  const release = {
    tag_name: "1.2.3",
    target_commitish: commit,
    assets: [tarball, "SHA256SUMS", "manifest.json", "release-check.mjs"].map(
      (name) => ({ name, browser_download_url: assetUrl(name) }),
    ),
  };
  return {
    manifest,
    readme: `Agents write and maintain this project. ${manifest.homepage}`,
    labels: [label],
    tests: { "src/a.test.ts": pinned },
    api: {
      [`repos/${repository}/releases/latest`]: release,
      [`repos/${repository}/git/ref/tags/1.2.3`]: {
        object: { type: "commit", sha: commit },
      },
      [`repos/${repository}`]: {
        homepage: manifest.homepage,
        description: "A library. Agent-maintained TypeScript library.",
      },
      [`repos/${repository}/labels`]: [[label]],
      [`repos/${repository}/issues/7`]: { state: "open" },
    },
    web: {
      [assetUrl(tarball)]: new Response(bytes),
      [assetUrl("SHA256SUMS")]: new Response(
        `${digest("sha256", "hex")}  ${tarball}\n`,
      ),
      [assetUrl("manifest.json")]: Response.json({
        version: "1.2.3",
        sourceCommit: commit,
        integrity,
      }),
      "https://registry.npmjs.org/-/package/library/dist-tags": Response.json({
        latest: "1.2.3",
      }),
      "https://registry.npmjs.org/library/1.2.3": Response.json({
        dist: { integrity },
      }),
      [manifest.homepage]: new Response(site("1.2.3", commit)),
    },
  };
}
function site(version, documented) {
  return `<head><meta name="documentation-commit" content="${documented}"><meta name="library-version" content="${version}"></head>`;
}
const check = ({ manifest, readme, labels, tests, api, web }) =>
  reconcile({
    read: (path) =>
      ({
        "package.json": JSON.stringify(manifest),
        "README.md": readme,
        ".github/labels.json": JSON.stringify(labels),
      })[path],
    testFiles: () =>
      Object.entries(tests).map(([file, text]) => ({ file, text })),
    github: githubWith((parameters) => {
      const path = parameters.at(-1);
      const value = api[path];
      if (value instanceof Error) throw value;
      if (value !== undefined) return JSON.stringify(value);
      // What gh does with a failed request: it exits with the status on stderr.
      throw Object.assign(new Error(`Command failed: gh api ${path}`), {
        stderr: path.includes("/commits/tags/")
          ? "gh: No commit found for SHA: tags/1.2.3 (HTTP 422)\n"
          : "gh: Not Found (HTTP 404)\n",
      });
    }),
    fetch: async (url) => web[url] ?? new Response(null, { status: 404 }),
  });
const findings = (report) =>
  report.filter((entry) => entry.state !== "ok").map((entry) => entry.state);
/** One changed world reports one problem, of this state, matching this description. */
async function expectOne(change, state, pattern) {
  const published = world();
  change(published);
  const report = await check(published);
  assert.deepEqual(findings(report), [state], JSON.stringify(report, null, 2));
  const { what, detail } = report.find((entry) => entry.state !== "ok");
  assert.match(`${what}: ${detail}`, pattern);
}

test("a fully published release agrees with itself", async () => {
  const report = await check(world());
  assert.deepEqual(findings(report), []);
  assert.equal(exitCodeOf(report), 0);
});

test("a surface behind the newest version is not yet published", async () => {
  await expectOne(
    (w) => (w.manifest.version = "1.3.0"),
    "PENDING",
    /is 1\.2\.3.*1\.3\.0 is not yet published/,
  );
  await expectOne(
    (w) => {
      w.web["https://registry.npmjs.org/-/package/library/dist-tags"] =
        Response.json({ latest: "1.2.2" });
    },
    "PENDING",
    /npm latest: is 1\.2\.2.*not yet published to npm/,
  );
  await expectOne(
    (w) => {
      delete w.web["https://registry.npmjs.org/-/package/library/dist-tags"];
    },
    "PENDING",
    /npm: nothing is published/,
  );
  await expectOne(
    (w) => {
      w.web[w.manifest.homepage] = new Response(site("1.2.2", "b".repeat(40)));
    },
    "PENDING",
    /deployed site: is 1\.2\.2.*not yet deployed/,
  );
  await expectOne(
    (w) => {
      delete w.web[w.manifest.homepage];
    },
    "PENDING",
    /deployed site: nothing is deployed/,
  );
});

test("no stable release at all is pending, and stops the comparisons that need it", async () => {
  const published = world();
  delete published.api[`repos/${repository}/releases/latest`];
  const report = await check(published);
  assert.deepEqual(findings(report), ["PENDING"]);
  assert.equal(exitCodeOf(report), 2);
});

test("published surfaces that contradict each other disagree", async () => {
  for (const [change, pattern] of [
    [(w) => (w.manifest.version = "1.2.2"), /older, at 1\.2\.2/],
    [
      (w) => {
        w.api[`repos/${repository}/git/ref/tags/1.2.3`].object.sha = "b".repeat(
          40,
        );
        w.web[assetUrl("manifest.json")] = Response.json({
          version: "1.2.3",
          sourceCommit: "b".repeat(40),
          integrity,
        });
        w.web[w.manifest.homepage] = new Response(
          site("1.2.3", "b".repeat(40)),
        );
      },
      /release target of 1\.2\.3/,
    ],
    [
      (w) => {
        delete w.api[`repos/${repository}/git/ref/tags/1.2.3`];
      },
      /tag 1\.2\.3: does not exist/,
    ],
    [
      (w) => w.api[`repos/${repository}/releases/latest`].assets.pop(),
      /assets of 1\.2\.3/,
    ],
    [
      (w) => {
        w.web[assetUrl("SHA256SUMS")] = new Response("0  other\n");
      },
      /SHA256SUMS of 1\.2\.3/,
    ],
    [
      (w) => {
        w.web[assetUrl("manifest.json")] = Response.json({
          version: "1.2.3",
          sourceCommit: "b".repeat(40),
          integrity,
        });
      },
      /manifest source commit/,
    ],
    [
      (w) => {
        w.web[assetUrl("manifest.json")] = Response.json({
          version: "1.2.2",
          sourceCommit: commit,
          integrity,
        });
      },
      /manifest version/,
    ],
    [
      (w) => {
        w.web[assetUrl("manifest.json")] = Response.json({
          version: "1.2.3",
          sourceCommit: commit,
          integrity: "sha512-other",
        });
      },
      /manifest integrity/,
    ],
    [
      (w) => {
        w.web["https://registry.npmjs.org/-/package/library/dist-tags"] =
          Response.json({ latest: "1.3.0" });
      },
      /npm latest: is 1\.3\.0.*newer than the newest GitHub release/,
    ],
    [
      (w) => {
        w.web["https://registry.npmjs.org/library/1.2.3"] = Response.json({
          dist: { integrity: "sha512-other" },
        });
      },
      /npm bytes of 1\.2\.3/,
    ],
    [
      (w) => {
        w.web[w.manifest.homepage] = new Response(site("1.3.0", commit));
      },
      /deployed site: is 1\.3\.0.*newer/,
    ],
    [
      (w) => {
        w.web[w.manifest.homepage] = new Response("<head></head>");
      },
      /lacks the library-version/,
    ],
    [
      (w) => {
        w.web[w.manifest.homepage] = new Response(
          site("1.2.3", `${commit}-dirty`),
        );
      },
      /neither the tag/,
    ],
    [
      (w) => {
        const corrected = "b".repeat(40);
        w.web[w.manifest.homepage] = new Response(site("1.2.3", corrected));
        w.api[`repos/${repository}/compare/${commit}...${corrected}`] = {
          status: "ahead",
          files: [{ filename: "docs/a.md" }, { filename: "src/a.ts" }],
        };
      },
      /neither the tag/,
    ],
    [
      (w) => {
        w.api[`repos/${repository}/labels`][0][0] = {
          ...label,
          color: "000000",
        };
      },
      /label Type: Bug: is 000000/,
    ],
    [
      (w) => {
        w.api[`repos/${repository}/labels`] = [[]];
      },
      /label Type: Bug: is missing on GitHub/,
    ],
    [
      (w) => {
        w.api[`repos/${repository}/labels`][0].push({
          ...label,
          name: "javascript",
        });
      },
      /label javascript: is on GitHub but not in/,
    ],
    [
      (w) => {
        w.api[`repos/${repository}`].homepage = "https://other.test/";
      },
      /About homepage/,
    ],
    [
      (w) => {
        w.readme = "Agents write and maintain this project.";
      },
      /README: does not link the homepage/,
    ],
    [
      (w) => {
        w.api[`repos/${repository}`].description =
          "Something else. Agent-maintained.";
      },
      /About description: is/,
    ],
    [
      (w) => {
        w.api[`repos/${repository}`].description = "A library. By a person.";
      },
      /maintainer statement/,
    ],
    [
      (w) => {
        w.readme = w.manifest.homepage;
      },
      /maintainer statement/,
    ],
    [
      (w) => {
        w.api[`repos/${repository}/issues/7`].state = "closed";
      },
      /src\/a\.test\.ts:2 "currently keeps it": links #7 \(closed\)/,
    ],
    [
      (w) => {
        delete w.api[`repos/${repository}/issues/7`];
      },
      /links #7 \(missing\)/,
    ],
    [
      (w) => {
        w.tests["src/a.test.ts"] = `it("currently keeps it", () => {});`;
      },
      /links no issue/,
    ],
  ]) {
    await expectOne(change, "DIFFERS", pattern);
  }
});

test("an annotated tag is followed to its commit", async () => {
  const published = world();
  const tagObject = "c".repeat(40);
  published.api[`repos/${repository}/git/ref/tags/1.2.3`].object = {
    type: "tag",
    sha: tagObject,
  };
  published.api[`repos/${repository}/git/tags/${tagObject}`] = {
    object: { type: "commit", sha: commit },
  };
  assert.deepEqual(findings(await check(published)), []);
});

test("a documentation-only correction of the release is accepted", async () => {
  const published = world();
  const corrected = "b".repeat(40);
  published.web[published.manifest.homepage] = new Response(
    site("1.2.3", corrected),
  );
  published.api[`repos/${repository}/compare/${commit}...${corrected}`] = {
    status: "ahead",
    files: [{ filename: "docs/a.md" }],
  };
  assert.deepEqual(findings(await check(published)), []);
});

test("a surface that cannot be read is neither agreement nor pending", async () => {
  const published = world();
  published.api[`repos/${repository}/labels`] = new Error("HTTP 500");
  const report = await check(published);
  assert.deepEqual(findings(report), ["UNREAD"]);
  assert.equal(exitCodeOf(report), 1);
});

test("the exit code separates a disagreement from a release in progress", () => {
  assert.equal(exitCodeOf(inStates("ok")), 0);
  assert.equal(exitCodeOf(inStates("ok", "PENDING")), 2);
  assert.equal(exitCodeOf(inStates("PENDING", "DIFFERS")), 1);
  assert.equal(exitCodeOf(inStates("PENDING", "UNREAD")), 1);
});

test("versions order numerically, with a stable version after its prereleases", () => {
  for (const [older, newer] of [
    ["0.9.0", "0.10.0"],
    ["0.2.0", "0.2.1"],
    ["0.2.0-rc.1", "0.2.0"],
    ["0.2.0-rc.2", "0.2.0-rc.10"],
    ["0.2.0-alpha.1", "0.2.0-beta.1"],
    ["0.2.0-beta.1", "0.2.0-rc.1"],
    ["0.2.0", "0.3.0-alpha.1"],
  ]) {
    assert.ok(compareVersions(older, newer) < 0, `${older} < ${newer}`);
    assert.ok(compareVersions(newer, older) > 0, `${newer} > ${older}`);
  }
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
});

test("a currently test is found in each form the suite writes it", () => {
  const link = `https://github.com/${repository}/issues`;
  const found = currentlyTests(
    [
      `// ${link}/1`,
      `it("currently one line", () => {});`,
      "",
      "// Explained at length",
      `// ${link}/2`,
      `  it.effect(`,
      `    "currently on its own line",`,
      `    () => {},`,
      `  );`,
      "",
      `// #3`,
      `it.live.fails('currently quoted otherwise', () => {});`,
      "",
      `// https://github.com/other/library/issues/4`,
      `it("currently about another project", () => {});`,
      "",
      `// ${link}/5`,
      "",
      `it("currently apart from its comment", () => {});`,
      "",
      `it("is not one, currently", () => {});`,
    ].join("\n"),
    repository,
  );
  assert.deepEqual(
    found.map(({ title, issues }) => [title, issues]),
    [
      ["currently one line", [1]],
      ["currently on its own line", [2]],
      ["currently quoted otherwise", [3]],
      ["currently about another project", []],
      ["currently apart from its comment", []],
    ],
  );
});

test("each script runs when started directly, on every Node.js that engines allows", () => {
  // With no gh or git on the path nothing can be read, so this needs no network. A script that did
  // not recognize that it was started would print nothing and exit 0.
  const live = startScript("./check-live.mjs");
  assert.equal(live.status, 1, live.stderr);
  assert.match(live.stdout, /UNREAD +GitHub release/);
  const selection = startScript("./select-published-release.mjs", {
    PUBLISH_RUN: "1",
    GITHUB_REPOSITORY: repository,
  });
  assert.equal(selection.status, 1);
  assert.match(selection.stderr, /ENOENT/);
  // These pass on the pinned Node.js either way; import.meta.main needs 24.2, and engines allows 24.0.
  for (const script of ["./check-live.mjs", "./select-published-release.mjs"]) {
    assert.doesNotMatch(
      readFileSync(new URL(script, import.meta.url), "utf8"),
      /^if \(import\.meta\.main\)/m,
    );
  }
});
