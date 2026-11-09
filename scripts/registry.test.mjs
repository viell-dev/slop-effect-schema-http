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

const { AbortSignal, DOMException, Response, structuredClone } = globalThis;

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
    advance: (duration) => {
      elapsed += duration;
    },
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
test("#184 later attestations can follow metadata that consumed about 161 seconds", async () => {
  const h = harness([
    ...Array.from({ length: 31 }, () => new Response(null, { status: 404 })),
    {
      status: 200,
      json: async () => {
        h.advance(5_853);
        return published;
      },
    },
    ...Array.from({ length: 7 }, () => new Response(null, { status: 404 })),
    Response.json(attest(statement)),
  ]);
  await verifyRegistry(manifest, {
    ...h.options,
    timeoutMs: undefined,
    intervalMs: undefined,
  });
  assert.equal(h.options.now(), 195_853);
  assert.equal(h.calls.length, 40);
  assert.equal(h.delays.length, 38);
  assert.ok(h.delays.every((delay) => delay === 5_000));
});

test("#184 the default five-minute deadline is shared, with no extra request", async () => {
  const h = harness([
    ...Array.from({ length: 32 }, () => new Response(null, { status: 404 })),
    {
      status: 200,
      json: async () => {
        h.advance(853);
        return published;
      },
    },
    ...Array.from({ length: 60 }, () => new Response(null, { status: 404 })),
  ]);
  await assert.rejects(
    verifyRegistry(manifest, {
      ...h.options,
      timeoutMs: undefined,
      intervalMs: undefined,
    }),
    (error) => {
      assert.match(
        error.message,
        /attestations: 28 attempts, last HTTP 404, 139147ms/,
      );
      assert.match(
        error.message,
        /shared 300000\/300000ms elapsed, 0ms remaining/,
      );
      return true;
    },
  );
  assert.equal(h.calls.length, 61);
  assert.equal(h.options.now(), 300_000);
  assert.equal(h.delays.at(-1), 4_147);
});

test("#184 default requests keep the ten-second and remaining-budget caps", async (t) => {
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (duration) => {
    timeouts.push(duration);
    return new globalThis.AbortController().signal;
  });
  const h = harness([
    ...Array.from({ length: 59 }, () => new Response(null, { status: 404 })),
    {
      status: 200,
      json: async () => {
        h.advance(1_500);
        return published;
      },
    },
    Response.json(attest(statement)),
  ]);
  await verifyRegistry(manifest, {
    ...h.options,
    timeoutMs: undefined,
    intervalMs: undefined,
  });
  assert.equal(h.options.now(), 296_500);
  assert.equal(h.calls.length, 61);
  assert.ok(timeouts.slice(0, -2).every((duration) => duration === 10_000));
  assert.deepEqual(timeouts.slice(-2), [5_000, 3_500]);
});

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

test("#176 a version visibility deadline identifies attempts and consumed budget", async () => {
  const h = harness(
    Array.from({ length: 3 }, () => new Response(null, { status: 404 })),
  );
  await assert.rejects(verifyRegistry(manifest, h.options), (error) => {
    assert.match(error.message, /Registry visibility deadline expired/);
    assert.match(
      error.message,
      /version metadata: 3 attempts, last HTTP 404, 12ms/,
    );
    assert.match(error.message, /shared 12\/12ms elapsed, 0ms remaining/);
    assert.doesNotMatch(error.message, /attestations:/);
    return true;
  });
  assert.deepEqual(h.delays, [5, 5, 2]);
  assert.equal(h.calls.length, 3);
});

test("#176 an attestation deadline distinguishes time spent waiting for the version", async () => {
  const h = harness([
    new Response(null, { status: 404 }),
    Response.json(published),
    new Response(null, { status: 404 }),
    new Response(null, { status: 404 }),
  ]);
  await assert.rejects(verifyRegistry(manifest, h.options), (error) => {
    assert.match(
      error.message,
      /version metadata: 2 attempts, last HTTP 200, 5ms/,
    );
    assert.match(error.message, /attestations: 2 attempts, last HTTP 404, 7ms/);
    assert.match(error.message, /shared 12\/12ms elapsed, 0ms remaining/);
    return true;
  });
  assert.deepEqual(h.delays, [5, 5, 2]);
  assert.equal(h.calls.length, 4);
});

test("#176 the version response can consume the budget before attestations start", async () => {
  const h = harness([
    {
      status: 200,
      json: async () => {
        h.advance(12);
        return published;
      },
    },
  ]);
  await assert.rejects(verifyRegistry(manifest, h.options), (error) => {
    assert.match(
      error.message,
      /version metadata: 1 attempt, last HTTP 200, 12ms/,
    );
    assert.match(
      error.message,
      /attestations: 0 attempts, last HTTP none, 0ms/,
    );
    assert.match(error.message, /shared 12\/12ms elapsed, 0ms remaining/);
    return true;
  });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
});

test("#176 request and response-body timeouts retain their cause without retrying", async () => {
  for (const phase of ["version metadata", "attestations"]) {
    const cause = new DOMException("fixture timed out", "TimeoutError");
    const h = harness(
      phase === "attestations"
        ? [
            Response.json(published),
            {
              status: 200,
              json: async () => {
                h.advance(7);
                throw cause;
              },
            },
          ]
        : [],
    );
    if (phase === "version metadata")
      h.options.fetch = async (url) => {
        h.calls.push(url);
        h.advance(7);
        throw cause;
      };
    await assert.rejects(verifyRegistry(manifest, h.options), (error) => {
      assert.equal(error.cause, cause);
      assert.match(
        error.message,
        new RegExp(`Registry ${phase} request failed`),
      );
      assert.match(error.message, /shared 7\/12ms elapsed, 5ms remaining/);
      assert.match(
        error.message,
        phase === "attestations"
          ? /attestations: 1 attempt, last HTTP 200, 7ms/
          : /version metadata: 1 attempt, last HTTP none, 7ms/,
      );
      return true;
    });
    assert.equal(h.calls.length, phase === "attestations" ? 2 : 1);
    assert.deepEqual(h.delays, []);
  }
});

test("#176 a non-visibility HTTP failure includes its phase and stays terminal", async () => {
  const h = harness([
    Response.json(published),
    new Response(null, { status: 503 }),
  ]);
  await assert.rejects(verifyRegistry(manifest, h.options), (error) => {
    assert.match(error.message, /Registry request failed/);
    assert.match(error.message, /attestations: 1 attempt, last HTTP 503, 0ms/);
    return true;
  });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.delays, []);
});

test("#176 discarding a response can fail without losing request context", async () => {
  const cause = new DOMException("discard interrupted", "AbortError");
  const h = harness([
    {
      status: 404,
      body: {
        cancel: async () => {
          h.advance(4);
          throw cause;
        },
      },
    },
  ]);
  await assert.rejects(verifyRegistry(manifest, h.options), (error) => {
    assert.equal(error.cause, cause);
    assert.match(
      error.message,
      /version metadata: 1 attempt, last HTTP 404, 4ms/,
    );
    assert.match(error.message, /shared 4\/12ms elapsed, 8ms remaining/);
    return true;
  });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
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
