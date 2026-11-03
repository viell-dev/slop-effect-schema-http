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
          { text: "Limits and recovery", link: "/limits" },
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
      { text: manifest.version, link: "/versions" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Describe and execute a request", link: "/usage" },
          { text: "Limits and recovery", link: "/limits" },
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
        text: "About",
        items: [
          { text: "Design contract", link: "/design" },
          { text: "Versions", link: "/versions" },
          { text: "Change history", link: "/changelog" },
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
