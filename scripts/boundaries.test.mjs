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

/** The store backend's entry point, without its service page link. */
const STORE =
  'import { createServer } from "node:http";\nimport { serve } from "../../harness/server.js";\nimport { parse } from "./xml.js";\n';

/** A tree that passes: each file imports what its side may, and the backend links its page. */
const files = {
  "library/main.ts": "export const library = 1;\n",
  "services/store.md": "# The store\n",
  "src/backends/echo.ts": "export const handler = 1;\n",
  "src/backends/store/xml.ts": "export const parse = (text: string) => text;\n",
  "src/backends/store/index.ts": `/**\n * Service documentation: services/store.md\n */\n${STORE}`,
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
  "src/app/main.ts":
    'import { Effect } from "effect";\nimport { parse } from "../formats/xml.js";\n',
  "src/conformance/wire.ts": 'import { readFileSync } from "node:fs";\n',
  "src/conformance/store.node.test.ts":
    'import { lane } from "#lane";\nimport { Effect } from "effect";\nimport { readFileSync } from "node:fs";\nimport { header } from "../harness/lane.js";\nimport { send } from "./wire.js";\n',
};

let fixtures = 0;

/**
 * Write the tree with extra files, aliases and a `tsconfig.packed.json` if given, run the check,
 * and return its refusals.
 */
const run = ({ extra = {}, imports, paths = {}, packed } = {}) => {
  const root = join(workspace, String(fixtures++));
  const tree = {
    ...files,
    ...extra,
    ...(packed === undefined
      ? {}
      : { "tsconfig.packed.json": JSON.stringify(packed) }),
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

  it("checks the single-page app as consumer code: no backend, Node-side harness or built-in", () => {
    assert.deepEqual(
      run({
        extra: {
          "src/app/review.ts": [
            'import { parse } from "../backends/store/xml.js";',
            'import { control } from "../harness/control.js";',
            'import { readFile } from "node:fs";',
            'import { header } from "../harness/lane.js";',
            "",
          ].join("\n"),
        },
      }),
      {
        status: 1,
        problems: [
          `src/app/review.ts: imports ../backends/store/xml.js (src/backends/store/xml.ts): ${OVER_HTTP}`,
          "src/app/review.ts: imports ../harness/control.js (src/harness/control.ts): consumer code may use only src/harness/lane.ts and #lane of the harness",
          "src/app/review.ts: imports node:fs: a Node built-in, but this code also runs in a browser",
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

  it("keeps the conformance tests apart from backends, Node-side harness modules and consumer code", () => {
    assert.deepEqual(
      run({
        extra: {
          "src/conformance/review.node.test.ts": [
            'import { parse } from "../backends/store/xml.js";',
            'import { control } from "../harness/control.js";',
            'import { parse as read } from "../formats/xml.js";',
            'import { value } from "../values/store.js";',
            "",
          ].join("\n"),
          "src/scenarios/review.node.test.ts":
            'import { send } from "../conformance/wire.js";\n',
        },
      }),
      {
        status: 1,
        problems: [
          "src/scenarios/review.node.test.ts: imports ../conformance/wire.js (src/conformance/wire.ts): the conformance tests are backend-side",
          "src/conformance/review.node.test.ts: imports ../backends/store/xml.js (src/backends/store/xml.ts): conformance tests reach backends only over HTTP",
          "src/conformance/review.node.test.ts: imports ../harness/control.js (src/harness/control.ts): conformance tests may use only src/harness/lane.ts and #lane of the harness",
          "src/conformance/review.node.test.ts: imports ../formats/xml.js (src/formats/xml.ts): conformance tests are backend-side and share nothing with the consumer side",
          "src/conformance/review.node.test.ts: imports ../values/store.js (src/values/store.ts): conformance tests are backend-side and share nothing with the consumer side",
        ],
      },
    );
  });

  it("refuses a backend entry point whose service page link was removed", () => {
    assert.deepEqual(
      run({
        extra: {
          "src/backends/store/index.ts": STORE,
          "src/backends/clock.ts": "export const handler = 1;\n",
        },
      }),
      {
        status: 1,
        problems: [
          'src/backends/clock.ts: links no service page; add a "Service documentation: services/<page>.md" line',
          'src/backends/store/index.ts: links no service page; add a "Service documentation: services/<page>.md" line',
        ],
      },
    );
  });

  it("refuses a link to a missing page, or to a page spelt with other letter cases", () => {
    assert.deepEqual(
      run({
        extra: {
          "src/backends/clock.ts":
            "// Service documentation: services/clock.md\nexport const handler = 1;\n",
          "src/backends/store/xml.ts":
            "// Service documentation: services/Store.md\nexport const parse = (text: string) => text;\n",
        },
      }),
      {
        status: 1,
        problems: [
          "src/backends/clock.ts: links services/clock.md, which does not exist",
          "src/backends/store/xml.ts: links services/Store.md, which does not exist",
        ],
      },
    );
  });

  it("accepts a tsconfig.packed.json whose paths, through extends, only drop the library's", () => {
    assert.deepEqual(
      run({
        packed: {
          extends: "./tsconfig.json",
          compilerOptions: {
            paths: { "#lane": ["./src/harness/lane.node.ts"] },
          },
        },
      }),
      { status: 0, problems: [] },
    );
  });

  it("refuses a tsconfig.packed.json that keeps the library's alias or changes another", () => {
    const refusal = {
      status: 1,
      problems: [
        "tsconfig.packed.json: its paths must be tsconfig.json's without viell-effect-schema-http, from the same base",
      ],
    };
    // Inherited unchanged, the library's alias would type-check the packed lane against source.
    assert.deepEqual(run({ packed: { extends: "./tsconfig.json" } }), refusal);
    // An alias only the packed configuration knows would escape this check.
    assert.deepEqual(
      run({
        packed: {
          extends: "./tsconfig.json",
          compilerOptions: {
            paths: {
              "#lane": ["./src/harness/lane.node.ts"],
              "@store/*": ["./src/backends/store/*"],
            },
          },
        },
      }),
      refusal,
    );
  });
});
