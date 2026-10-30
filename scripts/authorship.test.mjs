// Tests for scripts/authorship.mjs, run in `npm run check`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("authorship.mjs", import.meta.url));

/** Run the check on these changed files with this description; return its exit status. */
const run = (files, body) =>
  spawnSync(process.execPath, [script, ...files], {
    encoding: "utf8",
    env: { ...process.env, PR_BODY: body },
  }).status;

describe("authorship.mjs", () => {
  it("passes a change to neither side without a statement", () => {
    assert.equal(run(["README.md", "scripts/catalogue.mjs"], ""), 0);
  });

  it("refuses a change to either side without a statement", () => {
    for (const file of [
      "src/backends/gateway/xmlrpc.ts",
      "src/conformance/digest.node.test.ts",
      "services/gateway.md",
      "src/clients/gateway/rpc.ts",
      "src/formats/xml.ts",
      "src/values/business.ts",
      "src/scenarios/gateway.test.ts",
      "src/app/main.ts",
    ])
      assert.equal(run([file], "Part of #32. Fixes the reader."), 1, file);
  });

  it("refuses a description that only mentions authorship in passing", () => {
    assert.equal(
      run(["src/formats/xml.ts"], "Fixes the reader; see the authorship rule."),
      1,
    );
  });

  it("accepts the statement as a heading, a bold lead, a list item or a plain line", () => {
    for (const body of [
      "## Authorship\n\nA consumer-side context wrote this.",
      "### Authorship and review\n\nOne context.",
      "**Authorship.** A consumer-side context wrote this.",
      "- **Authorship:** backend side only.",
      "Authorship: backend side only.",
      "> Authorship: quoted in a callout.",
    ])
      assert.equal(
        run(["src/formats/xml.ts", "src/backends/replay.ts"], body),
        0,
        body,
      );
  });
});
