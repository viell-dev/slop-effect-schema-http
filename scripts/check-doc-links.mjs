import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import process from "node:process";

const root = resolve("docs/.vitepress/dist");
const base = "/slop-effect-schema-http/";
const origin = "https://docs.example.test";
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const read = (path) => readFileSync(path, "utf8");
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

const manifest = JSON.parse(read("package.json"));
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
  "docs/changelog.md",
]) {
  assert.ok(
    read(file).includes(manifest.version),
    `Update the release version in ${file}`,
  );
}
const effect = JSON.parse(read("node_modules/effect/package.json"));
const gettingStarted = read("docs/getting-started.md");
assert.ok(
  gettingStarted.includes(`${manifest.name}-${manifest.version}.tgz`),
  "Update the documented tarball filename for this package version",
);
assert.ok(
  gettingStarted.includes(`effect@${effect.version}`),
  "Update the documented tested Effect version",
);
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
console.log(
  `Documentation checked: ${pages.length} pages, ${links} internal links/assets, anchors and package facts.`,
);
