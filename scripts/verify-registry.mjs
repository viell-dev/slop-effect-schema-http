import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
// Direct HTTPS avoids a caller's configured private registry or cached metadata.
const response = await globalThis.fetch(
  `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`,
);
assert.equal(
  response.status,
  200,
  "Registry version not visible yet; rerun verification without republishing",
);
const published = await response.json();
assert.equal(published.dist.integrity, manifest.integrity);
assert.equal(published.dist.shasum, manifest.shasum);
if (process.env.GITHUB_ACTIONS === "true") {
  assert.ok(published.dist.attestations?.url, "Missing npm provenance");
  // npm audit signatures verifies cryptographic signatures in a fresh consumer (RELEASING.md).
  const attestations = await (
    await globalThis.fetch(published.dist.attestations.url)
  ).json();
  const provenance = attestations.attestations.find(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
  );
  assert.ok(provenance, "Missing SLSA provenance");
  const statement = JSON.parse(
    Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString(
      "utf8",
    ),
  );
  const sha512 = Buffer.from(
    manifest.integrity.slice("sha512-".length),
    "base64",
  ).toString("hex");
  assert.ok(
    statement.subject.some((subject) => subject.digest.sha512 === sha512),
  );
  const build = statement.predicate.buildDefinition;
  assert.deepEqual(build.externalParameters.workflow, {
    ref: "refs/heads/main",
    repository: `https://github.com/${process.env.GITHUB_REPOSITORY}`,
    path: ".github/workflows/publish.yml",
  });
  assert.ok(
    build.resolvedDependencies.some(
      (dependency) =>
        dependency.uri ===
          `git+https://github.com/${process.env.GITHUB_REPOSITORY}@refs/heads/main` &&
        dependency.digest.gitCommit === manifest.sourceCommit,
    ),
  );
}
console.log(
  `Registry bytes match qualified ${manifest.name}@${manifest.version}.`,
);
