// Regression tests for scripts/boundaries.mjs, run in `npm run check`. Each case writes a small
// tree with the suite's layout into a temporary directory, changes it, and runs the check on it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("boundaries.mjs", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "boundaries-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

/** A tree that passes: each file imports what its side may. */
const files = {
  "library/main.ts": "export const library = 1;\n",
  "src/backends/store/xml.ts": "export const parse = (text: string) => text;\n",
  "src/backends/store/index.ts":
    'import { createServer } from "node:http";\nimport { serve } from "../../harness/server.js";\nimport { parse } from "./xml.js";\n',
  "src/harness/server.ts": "export const serve = 1;\n",
  "src/harness/control.ts": "export const control = 1;\n",
  "src/harness/lane.ts": "export const header = 1;\n",
  "src/harness/lane.node.ts": "export const lane = 1;\n",
  "src/clients/store.ts":
    'import { Schema } from "effect";\nimport { library } from "viell-effect-schema-http";\nimport { parse } from "../formats/xml.js";\n',
  "src/formats/xml.ts": "export const parse = (text: string) => text;\n",
  "src/values/store.ts": "export const value = 1;\n",
  "src/scenarios/store.test.ts":
    'import { lane } from "#lane";\nimport { header } from "../harness/lane.js";\n',
  "src/scenarios/store.node.test.ts": 'import { connect } from "node:net";\n',
};

let fixtures = 0;

/** Write the tree with extra files and aliases, run the check, and return its refusals. */
const run = ({ extra = {}, imports, paths = {} } = {}) => {
  const root = join(workspace, String(fixtures++));
  const tree = {
    ...files,
    ...extra,
    "package.json": JSON.stringify({
      name: "fixture",
      private: true,
      type: "module",
      ...(imports === undefined ? {} : { imports }),
      devDependencies: { effect: "0.0.0" },
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        paths: {
          "viell-effect-schema-http": ["./library/main.ts"],
          "#lane": ["./src/harness/lane.node.ts"],
          ...paths,
        },
      },
    }),
  };
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = spawnSync(process.execPath, [script, root], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    problems: result.stderr.split(/\r?\n/).filter((line) => line !== ""),
  };
};

const BACKEND =
  "a backend may import only Node built-ins, src/backends/, and src/harness/server.ts or route.ts";
const OVER_HTTP = "consumer code reaches backends only over HTTP";

describe("boundaries.mjs", () => {
  it("passes the tree as written", () => {
    assert.deepEqual(run(), { status: 0, problems: [] });
  });

  it("follows a package.json imports alias from consumer code into a backend", () => {
    assert.deepEqual(
      run({
        imports: { "#review-backend": "./src/backends/store/xml.ts" },
        extra: {
          "src/clients/review.ts": 'export { parse } from "#review-backend";\n',
        },
      }),
      {
        status: 1,
        problems: [
          `src/clients/review.ts: imports #review-backend (src/backends/store/xml.ts): ${OVER_HTTP}`,
        ],
      },
    );
  });

  it("follows tsconfig.json paths, patterns and every condition of an imports entry", () => {
    assert.deepEqual(
      run({
        paths: { "@store/*": ["./src/backends/store/*"] },
        imports: {
          "#formats/*": {
            browser: "./src/formats/*.ts",
            default: "./src/backends/store/*.ts",
          },
        },
        extra: {
          "src/values/review.ts":
            'import type { parse } from "@store/xml.js";\nexport const load = () => import("#formats/xml");\n',
        },
      }),
      {
        status: 1,
        problems: [
          `src/values/review.ts: imports @store/xml.js (src/backends/store/xml.ts): ${OVER_HTTP}`,
          `src/values/review.ts: imports #formats/xml (src/backends/store/xml.ts): ${OVER_HTTP}`,
        ],
      },
    );
  });

  it("follows aliases from backends too, and refuses #lane, the library and packages there", () => {
    assert.deepEqual(
      run({
        paths: { "@harness/*": ["./src/harness/*.ts"] },
        imports: { "#formats": "./src/formats/xml.ts" },
        extra: {
          "src/backends/store/review.ts": [
            'import { serve } from "@harness/server";',
            'import { control } from "@harness/control";',
            'import { parse } from "#formats";',
            'import { lane } from "#lane";',
            'import { library } from "viell-effect-schema-http";',
            'import { Schema } from "effect";',
            "",
          ].join("\n"),
        },
      }),
      {
        status: 1,
        problems: [
          `src/backends/store/review.ts: imports @harness/control (src/harness/control.ts): ${BACKEND}`,
          `src/backends/store/review.ts: imports #formats (src/formats/xml.ts): ${BACKEND}`,
          `src/backends/store/review.ts: imports #lane: ${BACKEND}`,
          `src/backends/store/review.ts: imports viell-effect-schema-http: ${BACKEND}`,
          `src/backends/store/review.ts: imports effect: ${BACKEND}`,
        ],
      },
    );
  });

  it("refuses a # specifier that resolves to nothing, and an undeclared package", () => {
    assert.deepEqual(
      run({
        imports: { "#missing": "./src/clients/missing.ts" },
        extra: {
          "src/clients/review.ts": [
            'import "#nowhere";',
            'import "#missing";',
            'import "#lane/extra";',
            'import "review-backend";',
            "",
          ].join("\n"),
        },
      }),
      {
        status: 1,
        problems: [
          "src/clients/review.ts: cannot resolve #nowhere: neither package.json imports nor tsconfig.json paths maps it",
          "src/clients/review.ts: cannot resolve #missing: its alias names no existing file or package",
          "src/clients/review.ts: cannot resolve #lane/extra: neither package.json imports nor tsconfig.json paths maps it",
          "src/clients/review.ts: cannot resolve review-backend: review-backend is not a declared dependency, a Node built-in, or an alias",
        ],
      },
    );
  });

  it("classifies an alias by what it names: a Node built-in stays a built-in", () => {
    assert.deepEqual(
      run({
        imports: { "#net": "node:net" },
        extra: {
          "src/clients/review.ts": 'import "#net";\n',
          "src/scenarios/review.node.test.ts": 'import "#net";\n',
        },
      }),
      {
        status: 1,
        problems: [
          "src/clients/review.ts: imports #net (node:net): a Node built-in, but this code also runs in a browser",
        ],
      },
    );
  });

  it("picks between equal-prefix imports patterns as Node does: the longer key wins", () => {
    assert.deepEqual(
      run({
        imports: {
          // `#a/xml.ts` loads the backend; `#b/xml.ts` loads a format helper.
          "#a/*": "./src/clients/*",
          "#a/*.ts": "./src/backends/store/*.ts",
          "#b/*": "./src/backends/store/*",
          "#b/*.ts": "./src/formats/*.ts",
        },
        extra: {
          "src/clients/review.ts": 'import "#a/xml.ts";\nimport "#b/xml.ts";\n',
        },
      }),
      {
        status: 1,
        problems: [
          `src/clients/review.ts: imports #a/xml.ts (src/backends/store/xml.ts): ${OVER_HTTP}`,
        ],
      },
    );
  });

  it("falls back to package lookup when no tsconfig.json paths candidate exists, as TypeScript does", () => {
    assert.deepEqual(run({ paths: { "*": ["./src/generated/*"] } }), {
      status: 0,
      problems: [],
    });
  });
});
