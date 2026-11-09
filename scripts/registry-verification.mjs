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
    timeoutMs = 300_000,
    intervalMs = 5_000,
  } = {},
) {
  const started = now();
  const deadline = started + timeoutMs;
  const phases = [];
  const context = () => {
    const current = now();
    const elapsed = Math.round(current - started);
    const history = phases.map(
      (phase) =>
        `${phase.name}: ${phase.attempts} attempt${phase.attempts === 1 ? "" : "s"}, last HTTP ${phase.status ?? "none"}, ${Math.round((phase.finished ?? current) - phase.started)}ms`,
    );
    return `${history.join("; ")}; shared ${elapsed}/${timeoutMs}ms elapsed, ${Math.max(0, Math.floor(deadline - current))}ms remaining`;
  };
  const expired = () =>
    `Registry visibility deadline expired; rerun verification without republishing (${context()})`;
  async function visibleJson(url, name) {
    const phase = {
      name,
      started: now(),
      attempts: 0,
      status: undefined,
      finished: undefined,
    };
    phases.push(phase);
    while (true) {
      const remaining = deadline - now();
      if (!(remaining > 0)) assert.fail(expired());
      phase.attempts++;
      let response;
      try {
        response = await fetch(url, {
          signal: globalThis.AbortSignal.timeout(
            Math.max(1, Math.min(10_000, Math.ceil(remaining))),
          ),
        });
        phase.status = response.status;
        if (response.status === 200) {
          const value = await response.json();
          phase.finished = now();
          return value;
        }
        await response.body?.cancel();
      } catch (cause) {
        throw new Error(
          `Registry ${name} request failed: ${url} (${context()})`,
          { cause },
        );
      }
      if (response.status !== 404)
        assert.equal(
          response.status,
          404,
          `Registry request failed: ${url} (${context()})`,
        );
      const delay = Math.min(intervalMs, deadline - now());
      if (!(delay > 0)) assert.fail(expired());
      await sleep(delay);
    }
  }
  const published = await visibleJson(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`,
    "version metadata",
  );
  assert.equal(published.dist.integrity, manifest.integrity);
  assert.equal(published.dist.shasum, manifest.shasum);
  if (repository !== undefined) {
    assert.ok(repository, "Missing GitHub repository");
    assert.ok(published.dist.attestations?.url, "Missing npm provenance");
    // Cryptographic verification is separately required via npm audit signatures.
    const attestations = await visibleJson(
      published.dist.attestations.url,
      "attestations",
    );
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
