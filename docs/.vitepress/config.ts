import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly version: string;
  readonly description: string;
};
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim() !== "";
const repository = "https://github.com/viell-dev/slop-effect-schema-http";

export default defineConfig({
  title: "Effect Schema HTTP",
  description: manifest.description,
  lang: "en-US",
  base: "/slop-effect-schema-http/",
  ignoreDeadLinks: false,
  head: [
    [
      "meta",
      {
        name: "documentation-commit",
        content: `${commit}${dirty ? "-dirty" : ""}`,
      },
    ],
    ["meta", { name: "library-version", content: manifest.version }],
  ],
  themeConfig: {
    nav: [
      { text: "Get started", link: "/getting-started" },
      { text: "Usage", link: "/usage" },
      { text: "API", link: "/api" },
      { text: manifest.version, link: "/versions" },
    ],
    sidebar: [
      { text: "Overview", link: "/" },
      { text: "Install and get started", link: "/getting-started" },
      { text: "Describe and execute a request", link: "/usage" },
      { text: "API modules", link: "/api" },
      { text: "Design", link: "/design" },
      { text: "Limits and recovery", link: "/limits" },
      { text: "Change history", link: "/changelog" },
      { text: "Versions and contributing", link: "/versions" },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repository }],
    editLink: { pattern: `${repository}/edit/main/docs/:path` },
    outline: [2, 3],
    footer: {
      message: `${manifest.version} · <a href="${repository}/blob/main/LICENSE">MIT license</a>`,
      copyright: "Agent-maintained. The code is not human-reviewed.",
    },
  },
});
