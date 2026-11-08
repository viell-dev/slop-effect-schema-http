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
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "Describe and execute a request", link: "/usage" },
          { text: "Recipes", link: "/recipes" },
        ],
      },
      {
        text: "Modules",
        items: [
          { text: "Overview", link: "/api" },
          { text: "Request", link: "/modules/request" },
          { text: "Body", link: "/modules/body" },
          { text: "Response", link: "/modules/response" },
          { text: "Operation", link: "/modules/operation" },
          { text: "Policy", link: "/modules/policy" },
          { text: "Interaction", link: "/modules/interaction" },
          { text: "UrlEncoding", link: "/modules/url-encoding" },
          { text: "Transport", link: "/modules/transport" },
        ],
      },
      {
        text: "Details",
        items: [
          { text: "Limits and recovery", link: "/limits" },
          { text: "Design contract", link: "/design" },
        ],
      },
      { text: manifest.version, link: "/versions" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Describe and execute a request", link: "/usage" },
          { text: "Recipes", link: "/recipes" },
        ],
      },
      {
        text: "Modules",
        items: [
          { text: "Overview", link: "/api" },
          { text: "Request", link: "/modules/request" },
          { text: "Body", link: "/modules/body" },
          { text: "Response", link: "/modules/response" },
          { text: "Operation", link: "/modules/operation" },
          { text: "Policy", link: "/modules/policy" },
          { text: "Interaction", link: "/modules/interaction" },
          { text: "UrlEncoding", link: "/modules/url-encoding" },
          { text: "Transport", link: "/modules/transport" },
        ],
      },
      {
        text: "Details",
        items: [
          { text: "Limits and recovery", link: "/limits" },
          { text: "Design contract", link: "/design" },
        ],
      },
      {
        text: "Releases and project",
        items: [
          { text: "Versions", link: "/versions" },
          { text: "What's in 0.4", link: "/release-notes/0.4" },
          { text: "What's in 0.3", link: "/release-notes/0.3" },
          { text: "What's in 0.2", link: "/release-notes/0.2" },
          { text: "What's in 0.1", link: "/release-notes/0.1" },
          { text: "Detailed changelog", link: "/changelog" },
          { text: "Development and source", link: "/development" },
        ],
      },
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
