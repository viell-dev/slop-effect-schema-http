import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";

// Retry visibility alone; malformed data, integrity failures and provenance failures are terminal.
export async function verifyRegistry(
  manifest,
  {
    repository,
    fetch = globalThis.fetch,
    sleep = setTimeout,
    now = () => performance.now(),
    timeoutMs = 180_000,
    intervalMs = 5_000,
  } = {},
) {
  const deadline = now() + timeoutMs;
  async function visibleJson(url) {
    while (true) {
      const remaining = deadline - now();
      assert.ok(
        remaining > 0,
        "Registry visibility deadline expired; rerun verification without republishing",
      );
      const response = await fetch(url, {
        signal: globalThis.AbortSignal.timeout(
          Math.max(1, Math.min(10_000, Math.ceil(remaining))),
        ),
      });
      if (response.status === 200) return response.json();
      await response.body?.cancel();
      assert.equal(response.status, 404, `Registry request failed: ${url}`);
      const delay = Math.min(intervalMs, deadline - now());
      assert.ok(
        delay > 0,
        "Registry visibility deadline expired; rerun verification without republishing",
      );
      await sleep(delay);
    }
  }
  const published = await visibleJson(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`,
  );
  assert.equal(published.dist.integrity, manifest.integrity);
  assert.equal(published.dist.shasum, manifest.shasum);
  if (repository !== undefined) {
    assert.ok(repository, "Missing GitHub repository");
    assert.ok(published.dist.attestations?.url, "Missing npm provenance");
    // Cryptographic verification is separately required via npm audit signatures.
    const attestations = await visibleJson(published.dist.attestations.url);
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
      repository: `https://github.com/${repository}`,
      path: ".github/workflows/publish.yml",
    });
    assert.ok(
      build.resolvedDependencies.some(
        (dependency) =>
          dependency.uri ===
            `git+https://github.com/${repository}@refs/heads/main` &&
          dependency.digest.gitCommit === manifest.sourceCommit,
      ),
    );
  }
}
