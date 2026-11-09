import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { isDocumentationSource } from "./documentation-scope.mjs";

// Compare what is published with this checkout, and the published surfaces with each other. It
// only reads: GitHub through an authenticated gh, npm and the deployed site over the network.
//
// - The newest stable GitHub release is package.json's version, its tag is the commit it targets
//   and records, and its assets are complete and agree with each other.
// - npm's latest is that version and its registry integrity matches the GitHub tarball.
// - The deployed site's meta tags name that version and commit, or a documentation correction.
// - GitHub's labels are exactly .github/labels.json.
// - The About description and homepage agree with package.json and the README.
// - Each "currently …" test links an issue that is still open.
//
// A surface behind the newest version has not been published yet, which is normal part-way through
// a release. A surface ahead of it, or the same version with other contents, disagrees.
//
// Exits 0 when everything agrees, 2 when something is only pending, and 1 otherwise.
const guide = (section) => `See "${section}" in RELEASING.md.`;

/** Whether Node started this module. `import.meta.main` would need Node.js 24.2 or later. */
export const startedDirectly = (url) =>
  process.argv[1] !== undefined &&
  pathToFileURL(realpathSync(process.argv[1])).href === url;

/** Read the API through `run`, parsed as JSON. A 404 returns undefined; a caller decides what that means. */
export const githubWith =
  (run) =>
  (...parameters) => {
    try {
      return JSON.parse(run(parameters));
    } catch (error) {
      if (/HTTP 404/.test(error.stderr ?? "")) return undefined;
      throw error;
    }
  };

/** `gh api`. */
export const gh = githubWith((parameters) =>
  execFileSync("gh", ["api", ...parameters], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }),
);

/**
 * The commit a tag names, or undefined for a tag that does not exist. `commits/tags/…` is no use
 * for this: it answers HTTP 422 for a missing tag, and for some that exist. The reference of an
 * annotated tag names a tag object, which names the commit.
 */
export function commitOfTag(github, repository, tag) {
  let target = github(`repos/${repository}/git/ref/tags/${tag}`)?.object;
  while (target?.type === "tag") {
    target = github(`repos/${repository}/git/tags/${target.sha}`)?.object;
  }
  return target?.sha;
}

/** `-z` sorts a stable version after its alpha, beta and rc. */
const versionKey = (version) =>
  version.includes("-") ? version : `${version}-z`;

/** Above zero when `a` is newer. */
export const compareVersions = (a, b) =>
  new Intl.Collator("en", { numeric: true }).compare(
    versionKey(a),
    versionKey(b),
  );

/** The "currently …" tests in a test file, with the issues in the comment directly above each. */
export function currentlyTests(text, repository) {
  const lines = text.split(/\r?\n/);
  return Array.from(
    text.matchAll(
      /^[ \t]*(?:it|test)(?:\.\w+)*\(\s*(["'`])(currently\b.*?)\1/gm,
    ),
    (match) => {
      const line = text.slice(0, match.index).split("\n").length;
      let first = line - 1;
      while (first > 0 && /^\s*\/\//.test(lines[first - 1])) first--;
      const comment = lines.slice(first, line - 1).join("\n");
      const link = new RegExp(
        `github\\.com/${repository}/issues/(\\d+)|(?<![\\w/])#(\\d+)\\b`,
        "g",
      );
      const issues = Array.from(comment.matchAll(link), (issue) =>
        Number(issue[1] ?? issue[2]),
      );
      return { line, title: match[2], issues };
    },
  );
}

/**
 * Read every surface and report one entry per comparison, as `{ state, what, detail }`. The state
 * is `ok`, `PENDING`, `DIFFERS`, or `UNREAD` for a surface that could not be read.
 *
 * `read` reads a repository file, `testFiles` lists `{ file, text }`, `github` is `gh`, and `fetch`
 * is the global one.
 */
export async function reconcile({ read, testFiles, github, fetch }) {
  const manifest = JSON.parse(read("package.json"));
  const repository = new URL(
    manifest.repository.url.replace(/^git\+/, ""),
  ).pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "");
  const report = [];
  const add = (state, what, detail) => report.push({ state, what, detail });
  const agree = (what, actual, expected, action) =>
    actual === expected
      ? add("ok", what)
      : add("DIFFERS", what, `is ${actual}, expected ${expected}. ${action}`);
  const surface = async (what, compare) => {
    try {
      await compare();
    } catch (error) {
      const reason = (error.stderr || error.message || `${error}`).trim();
      add(
        "UNREAD",
        what,
        `${reason.split("\n")[0]}. Check the network and gh auth status.`,
      );
    }
  };
  /** The newest release's own surfaces follow it; true when `actual` is that version. */
  const follows = (what, actual, version, behind, ahead) => {
    const order = compareVersions(actual, version);
    if (order < 0) add("PENDING", what, `is ${actual}. ${behind}`);
    if (order > 0) add("DIFFERS", what, `is ${actual}. ${ahead}`);
    if (order === 0) add("ok", `${what} is ${version}`);
    return order === 0;
  };
  const downloadable = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return Buffer.from(await response.arrayBuffer());
  };

  let release;
  let tagCommit;
  let bytes;
  await surface("GitHub release", async () => {
    release = github(`repos/${repository}/releases/latest`);
    if (!release) {
      add(
        "PENDING",
        "GitHub release",
        `no stable release exists yet. ${guide("Publish on GitHub")}`,
      );
      return;
    }
    const version = release.tag_name;
    follows(
      "newest stable GitHub release",
      version,
      manifest.version,
      `package.json's ${manifest.version} is not yet published. ${guide("Publish on GitHub")}`,
      `package.json is older, at ${manifest.version}. Update this checkout from main.`,
    );
    tagCommit = commitOfTag(github, repository, version);
    if (!tagCommit) {
      add(
        "DIFFERS",
        `tag ${version}`,
        "does not exist, although its release does. Restore it at the commit the release's manifest.json records.",
      );
      return;
    }
    agree(
      `release target of ${version}`,
      release.target_commitish,
      tagCommit,
      "A release targets the full commit of its tag. Never move a published tag.",
    );

    const tarball = `${manifest.name}-${version}.tgz`;
    const expected = [
      "SHA256SUMS",
      "manifest.json",
      "release-check.mjs",
      tarball,
    ].toSorted();
    const names = release.assets.map((asset) => asset.name).toSorted();
    if (names.join() !== expected.join()) {
      add(
        "DIFFERS",
        `assets of ${version}`,
        `are ${names.join(", ")}, expected ${expected.join(", ")}. Add what is missing from the qualified artifact; never replace a published asset.`,
      );
      return;
    }
    add("ok", `assets of ${version}`);
    const asset = (name) =>
      downloadable(
        release.assets.find((entry) => entry.name === name)
          .browser_download_url,
      );
    bytes = await asset(tarball);
    const checker = await asset("release-check.mjs");
    const sums = (await asset("SHA256SUMS")).toString("utf8");
    const record = JSON.parse((await asset("manifest.json")).toString("utf8"));
    const expectedSums = [
      [tarball, bytes],
      ["release-check.mjs", checker],
    ]
      .map(
        ([name, content]) =>
          `${createHash("sha256").update(content).digest("hex")}  ${name}`,
      )
      .toSorted();
    // The producer records these two assets. Compare complete rows so missing, duplicate,
    // malformed or extra entries cannot hide behind one valid package checksum.
    const actualSums = sums
      .replaceAll("\r\n", "\n")
      .replace(/\n$/, "")
      .split("\n")
      .toSorted();
    if (
      actualSums.length === expectedSums.length &&
      actualSums.every((line, index) => line === expectedSums[index])
    )
      add("ok", `SHA256SUMS of ${version}`);
    else
      add(
        "DIFFERS",
        `SHA256SUMS of ${version}`,
        `must contain exactly one correct SHA-256 entry each for ${tarball} and release-check.mjs. If the published bytes are wrong, release a new version.`,
      );
    const correct =
      "The assets of a release come from one qualification; if they do not, release a new version.";
    agree(`manifest version of ${version}`, record.version, version, correct);
    agree(
      `manifest source commit of ${version}`,
      record.sourceCommit,
      tagCommit,
      correct,
    );
    agree(
      `manifest integrity of ${version}`,
      record.integrity,
      integrityOf(bytes),
      correct,
    );
  });

  await surface("npm", async () => {
    if (!release) return;
    const version = release.tag_name;
    const response = await fetch(
      `https://registry.npmjs.org/-/package/${manifest.name}/dist-tags`,
    );
    if (response.status === 404) {
      add("PENDING", "npm", `nothing is published. ${guide("Publish to npm")}`);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from npm`);
    const { latest } = await response.json();
    const current = follows(
      "npm latest",
      latest,
      version,
      `${version} is not yet published to npm. ${guide("Publish to npm")}`,
      `That is newer than the newest GitHub release, ${version}. ${guide("Partial failure and recovery")}`,
    );
    if (!current || !bytes) return;
    const published = await fetch(
      `https://registry.npmjs.org/${manifest.name}/${version}`,
    );
    if (!published.ok) throw new Error(`HTTP ${published.status} from npm`);
    agree(
      `npm integrity metadata of ${version}`,
      (await published.json()).dist.integrity,
      integrityOf(bytes),
      "npm and the GitHub release must offer the same tarball; if they do not, release a new version.",
    );
  });

  await surface("deployed site", async () => {
    if (!release) return;
    const version = release.tag_name;
    const response = await fetch(manifest.homepage);
    if (response.status === 404) {
      add(
        "PENDING",
        "deployed site",
        `nothing is deployed at ${manifest.homepage}. ${guide("Release documentation and corrections")}`,
      );
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from the site`);
    const html = await response.text();
    const meta = (name) =>
      new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1];
    const siteVersion = meta("library-version");
    const siteCommit = meta("documentation-commit");
    if (!siteVersion || !siteCommit) {
      add(
        "DIFFERS",
        "deployed site",
        `lacks the library-version or documentation-commit meta tag. Redeploy it. ${guide("Release documentation and corrections")}`,
      );
      return;
    }
    const current = follows(
      "deployed site",
      siteVersion,
      version,
      `The documentation of ${version} is not yet deployed. ${guide("Release documentation and corrections")}`,
      `That is newer than the newest GitHub release, ${version}. Redeploy the release.`,
    );
    if (!current || !tagCommit) return;
    if (siteCommit === tagCommit) {
      add("ok", `deployed site's commit is the tag of ${version}`);
      return;
    }
    const comparison = github(
      `repos/${repository}/compare/${tagCommit}...${siteCommit}`,
    );
    const outside = (comparison?.files ?? [])
      .flatMap((file) => [file.filename, file.previous_filename])
      .filter((path) => path && !isDocumentationSource(path));
    // GitHub truncates comparison file lists at 300. A missing or potentially truncated list
    // cannot prove that every changed file is documentation.
    if (
      comparison?.status === "ahead" &&
      Array.isArray(comparison.files) &&
      comparison.files.length > 0 &&
      comparison.files.length < 300 &&
      outside.length === 0
    )
      add("ok", `deployed site's commit corrects the docs of ${version}`);
    else
      add(
        "DIFFERS",
        "deployed site's commit",
        `is ${siteCommit}, neither the tag of ${version} (${tagCommit}) nor a documentation-only correction of it. Redeploy the release. ${guide("Release documentation and corrections")}`,
      );
  });

  await surface("labels", () => {
    const expected = JSON.parse(read(".github/labels.json"));
    const live = new Map(
      github("--paginate", "--slurp", `repos/${repository}/labels`)
        .flat()
        .map((label) => [label.name, label]),
    );
    const before = report.length;
    for (const { name, color, description } of expected) {
      const label = live.get(name);
      live.delete(name);
      if (!label)
        add("DIFFERS", `label ${name}`, "is missing on GitHub. Create it.");
      else if (label.color !== color || label.description !== description)
        add(
          "DIFFERS",
          `label ${name}`,
          `is ${label.color} "${label.description}" on GitHub, expected ${color} "${description}". Update whichever is wrong.`,
        );
    }
    for (const name of live.keys())
      add(
        "DIFFERS",
        `label ${name}`,
        "is on GitHub but not in .github/labels.json. Add it to the file, or delete it on GitHub after moving any items that use it.",
      );
    if (report.length === before) add("ok", `${expected.length} labels`);
  });

  await surface("repository About", () => {
    const about = github(`repos/${repository}`);
    const readme = read("README.md");
    agree(
      "About homepage",
      about.homepage,
      manifest.homepage,
      "Set it in the repository's About settings.",
    );
    if (readme.includes(manifest.homepage))
      add("ok", "README links the homepage");
    else
      add(
        "DIFFERS",
        "README",
        `does not link the homepage, ${manifest.homepage}. Update its documentation links.`,
      );
    const description = about.description ?? "";
    if (description.startsWith(`${manifest.description}.`))
      add("ok", "About description opens with package.json's");
    else
      add(
        "DIFFERS",
        "About description",
        `is "${description}", which does not open with "${manifest.description}.". Update whichever is wrong.`,
      );
    if (
      description.includes("Agent-maintained") &&
      readme.includes("Agents write and maintain this project")
    )
      add("ok", "About description and README say who maintains the project");
    else
      add(
        "DIFFERS",
        "maintainer statement",
        'the README must say "Agents write and maintain this project" and the About description "Agent-maintained". Update whichever lacks it.',
      );
  });

  await surface("currently tests", () => {
    const states = new Map();
    const state = (issue) => {
      if (!states.has(issue))
        states.set(
          issue,
          github(`repos/${repository}/issues/${issue}`)?.state ?? "missing",
        );
      return states.get(issue);
    };
    let open = 0;
    for (const { file, text } of testFiles()) {
      for (const { line, title, issues } of currentlyTests(text, repository)) {
        const what = `${file}:${line} "${title}"`;
        if (issues.length === 0)
          add(
            "DIFFERS",
            what,
            "links no issue. Add a comment directly above it linking the issue that decides the behavior.",
          );
        else if (issues.some((issue) => state(issue) === "open")) open++;
        else
          add(
            "DIFFERS",
            what,
            `links ${issues.map((issue) => `#${issue} (${state(issue)})`).join(", ")}. Settle the behavior and retitle the test, or link the issue that now owns it.`,
          );
      }
    }
    add("ok", `${open} "currently" tests link an open issue`);
  });
  return report;
}

const integrityOf = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** 1 for anything that disagrees or could not be read, 2 for only pending, otherwise 0. */
export const exitCodeOf = (report) => {
  const states = new Set(report.map((entry) => entry.state));
  if (states.has("DIFFERS") || states.has("UNREAD")) return 1;
  return states.has("PENDING") ? 2 : 0;
};

/** A file's text, relative to the repository root once the script has moved there. */
const readText = (path) => readFileSync(path, "utf8");

if (startedDirectly(import.meta.url)) {
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  const report = await reconcile({
    read: readText,
    testFiles: () =>
      execFileSync("git", ["ls-files", "*.test.ts"], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((file) => ({ file, text: readText(file) })),
    github: gh,
    fetch: (url) =>
      globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(30_000) }),
  });
  for (const { state, what, detail } of report) {
    console.log(`${state.padEnd(7)}  ${what}${detail ? `: ${detail}` : ""}`);
  }
  process.exitCode = exitCodeOf(report);
  console.log(
    [
      "The published surfaces agree.",
      "The published surfaces disagree, or could not all be read.",
      "Nothing disagrees, but a release is not yet fully published.",
    ][process.exitCode],
  );
}
