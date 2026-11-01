# Releasing

The first-stable goal is the existing finite-body API, ESM, Node.js 24 on Windows/Linux and Chromium
Fetch with Effect 4. [Issue #2](https://github.com/viell-dev/slop-effect-schema-http/issues/2)
records the owner's release direction and qualification. Compatible fixes use `0.1.x`; breaking API
changes require `0.2.0` and migration guidance. Tags have no `v` prefix.

`0.1.0-rc.1` is a GitHub-only candidate. No command in CI or the qualification workflow publishes
anything. Removing `private` makes the artifact publishable; it does not authorize npm publication.

## Prepare a candidate

1. Review open issues, PRs, failed checks and the [dependency
   overview](https://github.com/viell-dev/slop-effect-schema-http/issues/41). Reproduce reported
   defects and record their dispositions. Keep required checks intact.
2. In a task branch, set the same version in `package.json` and both root entries of
   `package-lock.json`. Update the matching section in `docs/changelog.md`, release status and
   installation commands in README and the documentation, and version-pinned API/example links.
   `scripts/check-doc-links.mjs` checks version agreement. Keep `private` absent.
3. Run the ordinary checks in CONTRIBUTING, then review the complete diff. Obtain an independent
   deep review covering the implementation, changes since the previous release, compatibility,
   package, examples, docs, release tooling and remaining defects. Record the reviewed commit,
   findings and limits in the PR. Follow up on material fixes.
4. Commit the complete candidate. From a clean checkout with `.nvmrc` selected and `npm ci`
   complete:

   ```sh
   npm run release:prepare
   ```

   This clears only the local generated `dist/`, then runs type/format/lint checks, a fresh build,
   behavior/socket tests, executable docs, the site/link checks, and a moderate-or-higher dependency
   audit. It packs once, installs that tarball into an isolated consumer with Effect 4.1.1, verifies
   strict declarations and every export, and executes the synthetic example. It then installs and
   verifies the **same bytes** with the Effect 4.0.7 peer floor and a TypeScript 7.0.2 consumer. No
   package or release is published.

   Outputs are under `artifacts/VERSION/`: the `.tgz`, `SHA256SUMS`, `manifest.json` (file list,
   integrity, source commit and tool versions), and `release-check.mjs`. Existing output is refused;
   inspect and move it before regenerating. A failed consumer is retained and its path printed.
5. Merge through a PR after required CI and review pass. Main must remain protected, including
   administrators. Never bypass checks to release.
6. Run **Release qualification** (`release.yml`) on `main` with the exact version:

   ```sh
   gh workflow run release.yml --ref main -f version=0.1.0-rc.1
   ```

   Require the whole run to succeed at the exact merged commit. It repeats candidate preparation on
   Linux and Windows, and checks all four hostile-suite lanes on Linux against that same library
   SHA: Node source, Chromium source, packed Node/declarations and the built Chromium app. The suite
   is pinned to a reviewed commit in the workflow and stays in its independent history. Review and
   advance that pin when suite changes are needed. Its package build is independently qualified; the
   isolated consumers qualify the actual release tarball.

   Retain the Actions run and results in the release PR. Pending, skipped or failing required work
   is not release evidence. A subsequent code or tooling change requires fresh qualification.
7. Download `candidate-ubuntu-latest` from that successful run. Use its tarball for publication; do
   not rebuild it. `candidate-windows-latest` and `hostile-suite-results` are supporting evidence.
   Check the manifest's source commit, package identity/version, complete assets, and `SHA256SUMS`.

## Publish on GitHub

Create the release at the qualified full commit SHA with the tested assets and the changelog entry
as release notes. Supply explicit version, target and prerelease state. The notes link the
qualification PR/run, remaining limits and any pending human test. For the initial RC:

```sh
gh release create 0.1.0-rc.1 ./artifacts/0.1.0-rc.1/* --target COMMIT \
  --title 0.1.0-rc.1 --prerelease --latest=false --notes-file release-notes.md
```

Before the command, verify that neither the tag nor release exists. `gh release create` uploads the
assets to a draft before publishing them. Never replace published assets or move a published tag. No
repository immutability setting is required by this procedure.

Download the public assets into a fresh directory and verify their checksums, version and manifest.
From the matching checkout, verify the downloaded tarball directly:

```sh
npm run test:package -- --tarball /absolute/path/to/viell-effect-schema-http-0.1.0-rc.1.tgz
```

The command checks the exact downloaded bytes, declarations, exports and runnable example. Record
the release URL, tag target and checksum. Deploy the release documentation below and verify it.

## First npm publication and trusted publishing

The recommended bootstrap is to publish the **verified RC tarball**, under the explicit npm `rc`
tag, once the owner chooses to do so. The package must exist before npm accepts a trusted publisher
([npm prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)). Do not
publish a placeholder package or use `latest` for a prerelease. Inspect the actual dist-tags after
bootstrap; `rc` should identify the candidate, with `latest` reserved for stable publication.

The owner signs in to their npm account with 2FA and publishes the downloaded, verified artifact:

```sh
npm login
npm publish ./viell-effect-schema-http-0.1.0-rc.1.tgz --ignore-scripts --access public --tag rc
npm dist-tag ls viell-effect-schema-http
```

This local bootstrap has no GitHub OIDC provenance; checksum and registry integrity verification
still apply. Do not request a long-lived npm secret in GitHub. After bootstrap, the owner configures
the package's trusted publisher with GitHub owner `viell-dev`, repository `slop-effect-schema-http`,
workflow **`publish.yml`**, environment **`npm-release`**, and direct publish permission. These
names differ from Markdown Tools' workflow. Enable package 2FA and disallow bypass-2FA tokens.
Follow [npm's current instructions](https://docs.npmjs.com/trusted-publishers/).

Agents configure `npm-release` to allow only the named `main` branch and keep
`NPM_PUBLISH_ENABLED=false` until trust and the owner request are resolved. The first stable also
requires [the human usability
report](https://github.com/viell-dev/slop-effect-schema-http/issues/67).

After those prerequisites, **Publish qualified npm package** (`publish.yml`) can publish routine
authorized versions. Supply the successful qualification run ID for the exact current `main` commit.
Leave `publish=false` first to validate the producer, download and checksum the existing Linux
artifact, and dry-run npm publication. This publishes nothing. An already published version may be
rejected even in npm's dry run; do not treat that as permission to replace it.

For actual publication, set the repository variable to `true` and dispatch with `publish=true`. The
workflow uses OIDC to publish the tested tarball with provenance, selects `rc`/`beta`/`alpha` from a
prerelease version or `latest` from a stable one, and checks registry integrity and provenance
against the tarball, commit and workflow. It does not create a GitHub release or deploy docs.

After npm publication, install the published exact version in a fresh empty-cache consumer and run
the downloaded `release-check.mjs` and `npm audit signatures`. Check dist-tags and compare registry
integrity with the manifest. This cryptographic verification complements the workflow's provenance
content check. Then finish the GitHub release and documentation steps for the same commit.

The bootstrap/trust pattern and artifact checks are informed by [Markdown Tools' release
guide](https://github.com/viell-dev/slop-markdown-tools/blob/main/RELEASING.md#publication-prerequisites).
Its immutable-release setting, product-specific test matrix and human-testing exception do not apply
here.

## Promote RC to stable

The candidate is intended to contain the final public API and behavior. Once publication setup and
the human report are complete, `0.1.0` should need only a version, status, installation/channel and
changelog update. Record the RC-to-stable diff and why the human evidence remains representative.
Re-run exact-commit qualification for the stable artifact; a version bump produces different bytes.
If new blockers require behavior changes, fix and requalify them, and publish a new RC when needed.
Do not re-label the RC tarball as stable or move its tag.

## Release documentation and corrections

Dispatch **Release documentation** (`pages.yml`) on `main` after the GitHub release exists, with
`tag=VERSION`. It accepts only the newest stable GitHub release, or newest candidate before stable.
It builds the tag's source and deploys through `github-pages`; normal main pushes only check docs.
Verify public navigation, assets, `library-version` and `documentation-commit` against the build.

For a current-release documentation error, create a task branch from its tag and change only
`docs/`. Deliver it through a PR into a protected `site-VERSION` branch rooted at the tag. Keep the
same package version, preserve the correction on main as appropriate, then dispatch `pages.yml` with
that release tag and the full correction commit in `correction`. The workflow requires tag ancestry
and refuses changed paths outside `docs/`. Record the deployed commit without moving the software
tag. Use the same procedure for another correction; the next release deploys its own docs.

## Partial failure and recovery

- A preparation failure publishes nothing. Preserve failed logs, fix the cause, and qualify anew.
- A draft GitHub release can be completed at the verified target. If publication succeeded, do not
  rerun creation or replace bytes. Download and verify the existing assets.
- If npm succeeded but verification failed, run only
  `node scripts/verify-registry.mjs artifacts/VERSION/manifest.json` and the fresh-consumer checks.
  In GitHub, preserve `GITHUB_ACTIONS=true` and `GITHUB_REPOSITORY` to require provenance too. Never
  rerun the publish step for an existing version. A temporary registry propagation delay is handled
  by rerunning verification, not another upload.
- If npm succeeded but GitHub failed, recover the original qualified artifact from Actions, verify
  registry integrity, and finish only GitHub and Pages. If published bytes are wrong, release a new
  version; never edit a published tarball, move its tag, or make update versions go backwards.
- A Pages failure does not invalidate the package. Fix/retry the verified release or a scoped docs
  correction, then verify the live version and commit. Keep the prior deployment until success.
