import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { pathToFileURL, URL } from "node:url";
import process from "node:process";

const root = resolve("docs/.vitepress/dist");
const base = "/slop-effect-schema-http/";
const origin = "https://docs.example.test";
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const read = (path) => readFileSync(path, "utf8");
const manifest = JSON.parse(read("package.json"));
const decode = (value) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
const pages = readdirSync(root, { recursive: true }).filter((path) =>
  path.endsWith(".html"),
);
const ids = new Map();
let links = 0;
assert.ok(
  pages.includes("index.html"),
  "Documentation build is missing its home page",
);

for (const page of pages) {
  const file = resolve(root, page);
  const html = read(file);
  ids.set(
    file,
    new Set(
      Array.from(html.matchAll(/\bid=["']([^"']*)["']/g), (match) =>
        decode(match[1]),
      ),
    ),
  );
}
for (const page of pages) {
  const html = read(resolve(root, page));
  const provenance = html.match(
    /name="documentation-commit" content="([0-9a-f]{40})(?:-dirty)?"/,
  );
  assert.ok(provenance, `Missing documentation provenance: ${page}`);
  assert.equal(
    provenance[1],
    commit,
    `Documentation commit disagrees with checkout: ${page}`,
  );
  assert.equal(
    /name="library-version" content="([^"]*)"/.exec(html)?.[1],
    manifest.version,
    `The library-version meta tag disagrees with package.json: ${page}`,
  );
  if (process.env.GITHUB_ACTIONS === "true") {
    assert.doesNotMatch(
      html,
      /content="[0-9a-f]{40}-dirty"/,
      "CI documentation must identify a clean commit",
    );
  }
  const pageUrl = new URL(base + page.split(sep).join("/"), origin);
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']*)["']/g)) {
    const url = new URL(decode(match[1]), pageUrl);
    if (url.origin !== origin) continue;
    assert.ok(
      url.pathname.startsWith(base),
      `Link escapes the site base in ${page}: ${url.pathname}`,
    );
    let target = resolve(
      root,
      decodeURIComponent(url.pathname.slice(base.length)),
    );
    if (url.pathname.endsWith("/")) target = resolve(target, "index.html");
    if (!existsSync(target) && !extname(target) && existsSync(`${target}.html`))
      target += ".html";
    if (existsSync(target) && statSync(target).isDirectory())
      target = resolve(target, "index.html");
    assert.ok(
      !relative(root, target).startsWith(".."),
      `Link escapes the build directory: ${page}`,
    );
    assert.ok(
      existsSync(target),
      `Broken internal link in ${page}: ${url.pathname}`,
    );
    if (url.hash && ids.has(target)) {
      assert.ok(
        ids.get(target).has(decodeURIComponent(url.hash.slice(1))),
        `Broken anchor in ${page}: ${url.pathname}${url.hash}`,
      );
    }
    links++;
  }
}

assert.equal(
  new URL(manifest.homepage).pathname,
  base,
  "Package homepage and site base must agree",
);
assert.notEqual(manifest.private, true, "Release packages must be publishable");
assert.match(
  manifest.version,
  /^0\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/,
  "Expected the documented pre-1.0 version policy",
);
const lock = JSON.parse(read("package-lock.json"));
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);
for (const file of [
  "README.md",
  "docs/index.md",
  "docs/versions.md",
  "docs/api.md",
  "CHANGELOG.md",
  `docs/release-notes/${manifest.version.split(".").slice(0, 2).join(".")}.md`,
]) {
  assert.ok(
    read(file).includes(manifest.version),
    `Update the release version in ${file}`,
  );
}
assert.ok(
  read("docs/versions.md").includes(`${manifest.name}-${manifest.version}.tgz`),
  "Update the documented tarball filename for this package version",
);
// The paragraph that tells a reader which release is current, not a version anywhere on the page.
for (const file of ["README.md", "docs/index.md", "docs/versions.md"]) {
  const status = read(file)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " "))
    .filter((paragraph) => /^`\d+\.\d+\.\d+\S*` is /.test(paragraph));
  assert.equal(
    status.length,
    1,
    `Expected one release status paragraph, opening with the version, in ${file}`,
  );
  const stage = manifest.version.includes("-") ? "" : "the current ";
  assert.ok(
    status[0].startsWith(`\`${manifest.version}\` is ${stage}`),
    `Update the release status paragraph in ${file}`,
  );
  for (const [, tag] of status[0].matchAll(/\/releases\/tag\/([^)\s]+)/g)) {
    assert.equal(
      tag,
      manifest.version,
      `Update the release link in the status paragraph of ${file}`,
    );
  }
}
const installSpecifier = manifest.version.includes("-")
  ? `${manifest.name}@${manifest.version}`
  : manifest.name;
for (const file of ["README.md", "docs/getting-started.md"]) {
  const specifiers = Array.from(
    read(file).matchAll(/^(?:npm install|pnpm add|yarn add) (\S+)/gm),
    (match) => match[1],
  );
  assert.ok(specifiers.length > 0, `Missing the install command in ${file}`);
  for (const specifier of specifiers) {
    assert.equal(
      specifier,
      installSpecifier,
      `Use the explicit prerelease or unversioned stable install command in ${file}`,
    );
  }
  assert.ok(
    read(file).includes(manifest.peerDependencies.effect),
    `Update the documented Effect peer range in ${file}`,
  );
}
const api = read("docs/api.md");
for (const subpath of Object.keys(manifest.exports)) {
  if (subpath !== "." && !subpath.endsWith(".json")) {
    const name = subpath.slice(2);
    assert.ok(
      api.includes(`[${name}](`),
      `Missing API module documentation: ${subpath}`,
    );
    const slug = name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const guide = read(`docs/modules/${slug}.md`);
    const source = manifest.exports[subpath].types
      .replace("./dist/", "src/")
      .replace(/\.d\.ts$/, ".ts");
    assert.ok(
      guide.includes(`/blob/${manifest.version}/${source}`),
      `Update the version-pinned source reference in the ${name} guide`,
    );
  }
}

// Every built page is in the site navigation, or deliberately left out of it here.
const unlisted = new Set([
  "/404", // VitePress's own error page.
]);
const { default: site } = await import(
  pathToFileURL(resolve("docs/.vitepress/config.ts")).href
);
const navigation = new Set();
const collectLinks = (items) => {
  for (const item of items) {
    if (item.link) navigation.add(item.link);
    collectLinks(item.items ?? []);
  }
};
collectLinks(site.themeConfig.nav);
collectLinks(site.themeConfig.sidebar);
for (const page of pages) {
  const path = page.split(sep).join("/");
  const route = `/${path.replace(/(?:index)?\.html$/, "")}`;
  assert.notEqual(
    navigation.has(route),
    unlisted.has(route),
    `Add ${route} to the site navigation, or list it as deliberately unlisted, not both`,
  );
}

// The commands the procedures name, and the workflows, inputs and jobs they point to.
const workflow = (name) => read(`.github/workflows/${name}`);
const workflows = new Map(
  readdirSync(".github/workflows").map((name) => [name, workflow(name)]),
);
for (const file of ["CONTRIBUTING.md", "RELEASING.md"]) {
  const text = read(file);
  const prose = text.replace(/\s+/g, " ");
  for (const [, run, test] of text.matchAll(
    /\bnpm (?:run ([\w:-]+)|(test)\b)/g,
  )) {
    assert.ok(
      Object.hasOwn(manifest.scripts, run ?? test),
      `${file} names a missing npm script: ${run ?? test}`,
    );
  }
  for (const [path] of text.matchAll(/\bscripts\/[\w.-]+/g)) {
    assert.ok(existsSync(path), `${file} names a missing script: ${path}`);
  }
  for (const [, name] of text.matchAll(/`([\w-]+\.yml)`/g)) {
    assert.ok(workflows.has(name), `${file} names a missing workflow: ${name}`);
  }
  for (const [, title, name] of prose.matchAll(
    /\*\*([^*]+)\*\* \(`([\w-]+\.yml)`\)/g,
  )) {
    assert.equal(
      /^name: (.+)$/m.exec(workflows.get(name))?.[1],
      title,
      `${file} gives ${name} another name`,
    );
  }
  for (const [, name, options] of text.matchAll(
    /gh workflow run ([\w-]+\.yml)((?:\\\n|.)*)/g,
  )) {
    assert.ok(workflows.has(name), `${file} runs a missing workflow: ${name}`);
    for (const [, input] of options.matchAll(/-f (\w+)=/g)) {
      assert.match(
        workflows.get(name),
        new RegExp(`^ {6}${input}:$`, "m"),
        `${file} passes ${name} a missing input: ${input}`,
      );
    }
  }
  for (const [, job] of prose.matchAll(/`([\w-]+)` job\b/g)) {
    assert.ok(
      [...workflows.values()].some((content) =>
        new RegExp(`^ {2}${job}:$`, "m").test(content),
      ),
      `${file} names a missing workflow job: ${job}`,
    );
  }
}
const required = /```sh\n(npm ci\n[\s\S]*?)```/.exec(
  read("CONTRIBUTING.md"),
)?.[1];
assert.ok(required, "Missing the required checks in CONTRIBUTING.md");
const checksJob = /^ {2}checks:\n(?:(?: {3}.*)?\n)*/m.exec(
  workflow("ci.yml"),
)?.[0];
assert.ok(checksJob, "Missing the checks job in ci.yml");
for (const command of [
  ...required.trim().split("\n"),
  "npm run docs:examples",
  "npm run docs:build",
]) {
  assert.ok(
    checksJob.includes(`- run: ${command}\n`),
    `CONTRIBUTING.md says CI requires a command its checks job does not run: ${command}`,
  );
}
console.log(
  `Documentation checked: ${pages.length} pages, ${links} internal links/assets, anchors, package facts, navigation and named commands.`,
);
