import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { commitOfTag, gh, startedDirectly } from "./check-live.mjs";

// The step of publish.yml that runs only after a real upload and passes only once the registry
// serves the qualified bytes. A dry run skips it. Its run, job and title otherwise look the same
// as a real publication's: all of them report success.
export const verifiedStep = "Verify the published package";

/**
 * Decide what a finished publish.yml run means for the site, returning `{ tag }` to deploy that
 * release or `{ reason }` to leave the site as it is. A publication that cannot be matched to its
 * release throws, so that the site going stale shows as a failed run.
 */
export function selectPublishedRelease({ run: id, repository, github }) {
  const run = github(`repos/${repository}/actions/runs/${id}`);
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.path, ".github/workflows/publish.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "main");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  const { jobs } = github(`repos/${repository}/actions/runs/${id}/jobs`);
  const step = jobs
    .find((job) => job.name === "publish")
    ?.steps.find((candidate) => candidate.name === verifiedStep);
  assert.ok(
    step,
    `publish.yml has no "${verifiedStep}" step in its publish job`,
  );
  if (step.conclusion !== "success") {
    return { reason: `Run ${id} published nothing; the site stays as it is.` };
  }
  const { content } = github(
    `repos/${repository}/contents/package.json?ref=${run.head_sha}`,
  );
  const { version } = JSON.parse(Buffer.from(content, "base64").toString());
  if (version.includes("-")) {
    return {
      reason: `${version} is a prerelease; the site keeps describing the newest stable release.`,
    };
  }
  const tagCommit = commitOfTag(github, repository, version);
  assert.ok(
    tagCommit,
    `npm has ${version}, but its tag does not exist. Create the GitHub release, then dispatch this workflow with tag=${version}.`,
  );
  assert.equal(
    tagCommit,
    run.head_sha,
    `The tag ${version} is not the commit npm published. Find out which is right before deploying its documentation.`,
  );
  return { tag: version };
}

if (startedDirectly(import.meta.url)) {
  const { tag, reason } = selectPublishedRelease({
    run: process.env.PUBLISH_RUN,
    repository: process.env.GITHUB_REPOSITORY,
    github: gh,
  });
  console.log(reason ?? `Deploying the documentation of ${tag}.`);
  if (tag) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
}
