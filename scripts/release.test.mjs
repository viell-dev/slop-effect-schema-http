import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { githubWith } from "./check-live.mjs";
import {
  selectPublishedRelease,
  verifiedStep,
} from "./select-published-release.mjs";
import {
  checkTestedVersions,
  matrixSections,
  testedStatements,
} from "./tested-versions.mjs";

const temporaryRoot = realpathSync(tmpdir());
const temporary = mkdtempSync(join(temporaryRoot, "schema-http-release-gate-"));
const script = fileURLToPath(
  new URL("./check-qualification.mjs", import.meta.url),
);
const qualified = {
  id: 123,
  repository: { full_name: "example/library" },
  path: ".github/workflows/release.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: "a".repeat(40),
  status: "completed",
  conclusion: "success",
};

test("only the successful exact-commit qualification producer admits publication", (t) => {
  t.after(() => {
    assert.equal(dirname(temporary), temporaryRoot);
    assert.equal(resolve(realpathSync(temporary)), resolve(temporary));
    rmSync(temporary, { recursive: true });
  });
  const file = join(temporary, "run.json");
  const check = (run) => {
    writeFileSync(file, JSON.stringify(run));
    return spawnSync(process.execPath, [script, file], {
      encoding: "utf8",
      env: {
        ...process.env,
        QUALIFICATION_RUN: "123",
        GITHUB_REPOSITORY: "example/library",
        GITHUB_SHA: "a".repeat(40),
      },
    });
  };
  const valid = check(qualified);
  assert.equal(valid.status, 0, valid.stderr);
  for (const change of [
    { id: 124 },
    { repository: { full_name: "fork/library" } },
    { path: ".github/workflows/ci.yml" },
    { event: "pull_request" },
    { head_branch: "task-branch" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
  ]) {
    const rejected = check({ ...qualified, ...change });
    assert.equal(rejected.status, 1, JSON.stringify(change));
    assert.match(rejected.stderr, /AssertionError/);
  }
});

const publication = {
  id: 456,
  repository: { full_name: "example/library" },
  path: ".github/workflows/publish.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: "a".repeat(40),
  status: "completed",
  conclusion: "success",
};
function select({
  run,
  conclusion = "success",
  version = "1.2.3",
  tag = { type: "commit", sha: "a".repeat(40) },
  annotation,
}) {
  const base = "repos/example/library";
  const responses = {
    [`${base}/actions/runs/456`]: { ...publication, ...run },
    [`${base}/actions/runs/456/jobs`]: {
      jobs: [
        {
          name: "publish",
          steps: [{ name: verifiedStep, conclusion }],
        },
      ],
    },
    [`${base}/contents/package.json?ref=${"a".repeat(40)}`]: {
      content: Buffer.from(JSON.stringify({ version })).toString("base64"),
    },
    ...(tag && { [`${base}/git/ref/tags/${version}`]: { object: tag } }),
    ...(annotation && { [`${base}/git/tags/${tag.sha}`]: annotation }),
  };
  return selectPublishedRelease({
    run: 456,
    repository: "example/library",
    github: githubWith(([path]) => {
      if (path in responses) return JSON.stringify(responses[path]);
      // What gh does with a failed request: it exits with the status on stderr.
      throw Object.assign(new Error(`Command failed: gh api ${path}`), {
        stderr: path.includes("/commits/tags/")
          ? "gh: No commit found for SHA: tags/9.9.9 (HTTP 422)\n"
          : "gh: Not Found (HTTP 404)\n",
      });
    }),
  });
}

test("the site follows a verified stable publication and nothing else", () => {
  assert.deepEqual(select({}), { tag: "1.2.3" });
  // A dry run succeeds with this step skipped, and only the step tells it from a real publication.
  assert.match(select({ conclusion: "skipped" }).reason, /published nothing/);
  assert.match(select({ version: "1.3.0-rc.1" }).reason, /is a prerelease/);
  for (const run of [
    { repository: { full_name: "fork/library" } },
    { path: ".github/workflows/ci.yml" },
    { event: "push" },
    { head_branch: "task-branch" },
    { status: "in_progress" },
    { conclusion: "failure" },
  ]) {
    assert.throws(
      () => select({ run }),
      /AssertionError|Expected/,
      JSON.stringify(run),
    );
  }
});

test("a verified publication that cannot be matched to its release fails loudly", () => {
  assert.throws(
    () => select({ tag: null }),
    /its tag does not exist.*dispatch this workflow/,
  );
  assert.throws(
    () => select({ tag: { type: "commit", sha: "b".repeat(40) } }),
    /not the commit npm published/,
  );
});

test("an annotated tag is followed to the commit npm published", () => {
  const tag = { type: "tag", sha: "c".repeat(40) };
  assert.deepEqual(
    select({
      tag,
      annotation: { object: { type: "commit", sha: "a".repeat(40) } },
    }),
    { tag: "1.2.3" },
  );
  assert.throws(
    () =>
      select({
        tag,
        annotation: { object: { type: "commit", sha: "b".repeat(40) } },
      }),
    /not the commit npm published/,
  );
});

test("a renamed verification step fails instead of silently leaving the site stale", () => {
  const base = "repos/example/library/actions/runs/456";
  assert.throws(
    () =>
      selectPublishedRelease({
        run: 456,
        repository: "example/library",
        github: (path) =>
          path === base
            ? publication
            : { jobs: [{ name: "publish", steps: [{ name: "Renamed" }] }] },
      }),
    /has no "Verify the published package" step/,
  );
});

const workflowFile = (name) =>
  readFileSync(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf8",
  );
const permissionsOf = (workflow) =>
  Array.from(
    workflow.matchAll(/^ +([a-z-]+): (read|write)$/gm),
    ([, scope, access]) => `${scope}: ${access}`,
  );

test("publication hands over to the documentation workflow", () => {
  const publish = workflowFile("publish.yml");
  const pages = workflowFile("pages.yml");
  const name = /^name: (.+)$/m.exec(publish)[1];
  assert.ok(
    pages.includes(
      `workflow_run:\n    workflows: [${name}]\n    types: [completed]\n    branches: [main]\n`,
    ),
    "pages.yml must follow publish.yml by its workflow name, on main",
  );
  assert.match(pages, /workflow_dispatch:\n {4}inputs:\n {6}tag:/);
  assert.match(pages, /correction:/);
  assert.match(pages, /node scripts\/select-published-release\.mjs/);
  assert.match(
    pages,
    /needs: resolve\n {4}if: needs\.resolve\.outputs\.tag != ''/,
  );
  assert.match(pages, /deploy:\n {4}needs: build/);
  assert.ok(
    publish.includes(
      `- name: ${verifiedStep}\n        if: \${{ inputs.publish }}\n`,
    ),
    "The step pages.yml reads must run only for a real publication",
  );
  assert.match(
    publish,
    new RegExp(
      `- name: Publish to npm[^]*npm publish "\\./\\$TARBALL" --ignore-scripts[^]*- name: ${verifiedStep}`,
    ),
    "Verification must follow the upload",
  );
});

test("the handover gives neither workflow a new write permission", () => {
  assert.deepEqual(permissionsOf(workflowFile("pages.yml")), [
    "contents: read",
    "contents: read",
    "actions: read",
    "pages: write",
    "id-token: write",
  ]);
  assert.deepEqual(permissionsOf(workflowFile("publish.yml")), [
    "contents: read",
    "actions: read",
    "contents: read",
    "actions: read",
    "id-token: write",
  ]);
  assert.doesNotMatch(workflowFile("publish.yml"), /gh workflow run/);
  const pages = workflowFile("pages.yml");
  assert.ok(
    pages.indexOf("pages: write") > pages.indexOf("  deploy:"),
    "Only the deployment job receives Pages and OIDC permissions",
  );
});

// A checkout with documents that state what its files say, whatever the versions are today, so
// that a dependency update cannot fail these tests.
function testedFixture(t) {
  const root = mkdtempSync(join(temporaryRoot, "schema-http-tested-versions-"));
  t.after(() => rmSync(root, { recursive: true }));
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".nvmrc",
    "CHANGELOG.md",
    "package-lock.json",
    "package.json",
    "scripts/prepare-release.mjs",
    "scripts/tested-versions.mjs",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  mkdirSync(join(root, "docs"));
  const { statements } = testedStatements(root);
  const write = (file, addition = "") =>
    writeFileSync(
      join(root, file),
      `${matrixSections[file]}\n\n${statements[file].join(". ")}.\n${addition}`,
    );
  for (const file of Object.keys(statements)) write(file);
  return { root, write };
}

test("release preparation refuses a tested version the documents no longer state", (t) => {
  const { root } = testedFixture(t);
  const tools = mkdtempSync(join(temporaryRoot, "schema-http-fake-npm-"));
  t.after(() => rmSync(tools, { recursive: true }));
  const npm = join(tools, "npm.mjs");
  const calls = join(tools, "calls.txt");
  writeFileSync(
    npm,
    `import fs from "node:fs";
fs.appendFileSync(process.env.NPM_CALLS, process.argv.slice(2).join(" ") + "\\n");
`,
  );
  const commit = () => {
    const identity = [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.test",
    ];
    const git = (...args) =>
      execFileSync("git", [...identity, ...args], { cwd: root, stdio: "pipe" });
    git("init", "--quiet");
    git("add", "--all");
    git("commit", "--quiet", "--no-gpg-sign", "--message", "candidate");
  };
  const prepare = () =>
    spawnSync(process.execPath, [join(root, "scripts/prepare-release.mjs")], {
      encoding: "utf8",
      env: { ...process.env, npm_execpath: npm, NPM_CALLS: calls },
    });

  commit();
  const agreed = prepare();
  assert.equal(agreed.status, 0, agreed.stderr);
  assert.match(readFileSync(calls, "utf8"), /^run check\n/);

  rmSync(calls);
  const file = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(file, "utf8"));
  lock.packages["node_modules/effect"].version = "999.0.0";
  writeFileSync(file, JSON.stringify(lock));
  commit();
  const stale = prepare();
  assert.equal(stale.status, 1);
  assert.match(
    stale.stderr,
    /Update the tested versions in docs\/limits\.md: expected "Effect [\d.]+ and 999\.0\.0"/,
  );
  assert.ok(!existsSync(calls), "The comparison comes before anything else");
});

test("only the current matrix has to match; a history keeps what it recorded", (t) => {
  const { root, write } = testedFixture(t);
  // Captured, because this fixture has no suite commit, and in CI a printed note would announce
  // on every run that the comparison was skipped.
  const notes = [];
  const check = () =>
    checkTestedVersions(root, (note) => {
      notes.push(note);
    });
  const recorded = "Qualified on Effect 1.2.3 and TypeScript 1.2.3.\n";
  write("RELEASING.md", `\n## Release history\n\n${recorded}`);
  check();
  assert.match(notes[0], /Skipped the Playwright version/);
  write("RELEASING.md", recorded);
  assert.throws(
    check,
    /RELEASING\.md states Effect 1\.2\.3, which is not a tested version/,
  );
  writeFileSync(join(root, "RELEASING.md"), "# Another layout\n");
  assert.throws(check, /Missing the section "## Prepare a candidate"/);
});

test("a dependency update cannot fail the ordinary documentation check", () => {
  assert.doesNotMatch(
    readFileSync(new URL("./check-doc-links.mjs", import.meta.url), "utf8"),
    /node_modules\/|tested-versions/,
  );
});

test("qualification has the history the Playwright comparison reads", () => {
  // Without it the comparison would skip, with a note, in the one place it has to run.
  assert.match(
    workflowFile("release.yml"),
    /candidate:(?:(?!\n {2}\w)[^])*?fetch-depth: 0(?:(?!\n {2}\w)[^])*?npm run release:prepare/,
  );
});
