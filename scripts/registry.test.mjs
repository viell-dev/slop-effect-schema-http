import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { verifyRegistry } from "./registry-verification.mjs";

const { AbortSignal, Response, structuredClone } = globalThis;

const manifest = {
  name: "viell-effect-schema-http",
  version: "0.1.0",
  integrity: "sha512-YWJj",
  shasum: "sha1",
  sourceCommit: "a".repeat(40),
};
const published = {
  dist: {
    integrity: manifest.integrity,
    shasum: manifest.shasum,
    attestations: { url: "https://registry.npmjs.org/attestations" },
  },
};
const statement = {
  subject: [{ digest: { sha512: "616263" } }],
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          ref: "refs/heads/main",
          repository: "https://github.com/example/library",
          path: ".github/workflows/publish.yml",
        },
      },
      resolvedDependencies: [
        {
          uri: "git+https://github.com/example/library@refs/heads/main",
          digest: { gitCommit: manifest.sourceCommit },
        },
      ],
    },
  },
};
const attest = (value) => ({
  attestations: [
    {
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify(value)).toString("base64"),
        },
      },
    },
  ],
});
function harness(responses) {
  let elapsed = 0;
  const calls = [];
  const delays = [];
  return {
    calls,
    delays,
    options: {
      repository: "example/library",
      timeoutMs: 12,
      intervalMs: 5,
      now: () => elapsed,
      sleep: async (delay) => {
        delays.push(delay);
        elapsed += delay;
      },
      fetch: async (url, { signal }) => {
        assert.ok(signal instanceof AbortSignal);
        calls.push(url);
        const response = responses.shift();
        assert.ok(response, "Unexpected extra request");
        return response;
      },
    },
  };
}
test("#78 waits for version and attestation visibility within one deadline", async () => {
  const h = harness([
    new Response(null, { status: 404 }),
    Response.json(published),
    new Response(null, { status: 404 }),
    Response.json(attest(statement)),
  ]);
  await verifyRegistry(manifest, h.options);
  assert.deepEqual(h.delays, [5, 5]);
  assert.equal(h.calls.length, 4);
});
test("#78 repeated 404s stop at the deadline without another request", async () => {
  const h = harness(
    Array.from({ length: 3 }, () => new Response(null, { status: 404 })),
  );
  await assert.rejects(verifyRegistry(manifest, h.options), /deadline expired/);
  assert.deepEqual(h.delays, [5, 5, 2]);
  assert.equal(h.calls.length, 3);
});
test("#78 attestation retries use the time left after version propagation", async () => {
  const h = harness([
    new Response(null, { status: 404 }),
    Response.json(published),
    new Response(null, { status: 404 }),
    new Response(null, { status: 404 }),
  ]);
  await assert.rejects(verifyRegistry(manifest, h.options), /deadline expired/);
  assert.deepEqual(h.delays, [5, 5, 2]);
  assert.equal(h.calls.length, 4);
});
test("#78 failures other than visibility never trigger retries", async () => {
  const wrongWorkflow = structuredClone(statement);
  wrongWorkflow.predicate.buildDefinition.externalParameters.workflow.path =
    ".github/workflows/other.yml";
  const wrongSource = structuredClone(statement);
  wrongSource.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
    "b".repeat(40);
  const wrongDigest = structuredClone(statement);
  wrongDigest.subject[0].digest.sha512 = "00";
  for (const responses of [
    [new Response(null, { status: 403 })],
    [new Response(null, { status: 503 })],
    [new Response("invalid JSON")],
    [Response.json({ dist: { ...published.dist, integrity: "wrong" } })],
    [Response.json({ dist: { ...published.dist, shasum: "wrong" } })],
    [
      Response.json({
        dist: { integrity: manifest.integrity, shasum: manifest.shasum },
      }),
    ],
    [Response.json(published), Response.json({ attestations: [] })],
    ...[wrongWorkflow, wrongSource, wrongDigest].map((value) => [
      Response.json(published),
      Response.json(attest(value)),
    ]),
  ]) {
    const h = harness(responses);
    await assert.rejects(verifyRegistry(manifest, h.options));
    assert.deepEqual(h.delays, []);
  }
});
test("#78 recovery validates the original artifact identity and commit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "registry-artifact-"));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, manifest.version));
  const path = join(root, manifest.version, "manifest.json");
  const check = (value) => {
    writeFileSync(path, JSON.stringify(value));
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./check-verification-artifact.mjs", import.meta.url),
        ),
        root,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SOURCE_COMMIT: manifest.sourceCommit },
      },
    );
  };
  const valid = { ...manifest, filename: "viell-effect-schema-http-0.1.0.tgz" };
  assert.equal(check(valid).status, 0);
  for (const change of [
    { name: "other" },
    { version: "0.2.0" },
    { filename: "other.tgz" },
    { sourceCommit: "b".repeat(40) },
  ]) {
    assert.equal(check({ ...valid, ...change }).status, 1);
  }
});
test("#78 recovery workflow has read-only permissions and no publication command", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/verify-publication.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /contents: read\s+actions: read/);
  assert.doesNotMatch(workflow, /\bwrite\b|npm publish|NPM_PUBLISH_ENABLED/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /check-qualification\.mjs/);
  assert.match(workflow, /candidate-ubuntu-latest/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/);
  assert.match(workflow, /node scripts\/verify-registry\.mjs/);
});
