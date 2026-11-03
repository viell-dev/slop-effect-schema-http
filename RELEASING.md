# Releasing

The first-stable goal is the existing finite-body API, ESM, Node.js 24 on Windows/Linux and Chromium
Fetch with Effect 4. [Issue #2](https://github.com/viell-dev/slop-effect-schema-http/issues/2)
records the owner's release direction and qualification. Compatible fixes use `0.1.x`; breaking API
changes require `0.2.0` and migration guidance. Tags have no `v` prefix.

`0.1.0-rc.1` is published on GitHub and npm. Routine CI and release qualification publish nothing;
publication is a separate, authorized step. The first stable release keeps the candidate's current
API and behavior, with documentation and release metadata updates. Its final owner documentation
review is tracked in [#67](https://github.com/viell-dev/slop-effect-schema-http/issues/67), and
publication setup and authorization in
[#68](https://github.com/viell-dev/slop-effect-schema-http/issues/68).

## Prepare a candidate

1. Review open issues, PRs, failed checks and the [dependency
   overview](https://github.com/viell-dev/slop-effect-schema-http/issues/41). Reproduce reported
   defects and record their dispositions. Keep required checks intact.
2. In a task branch, set the same version in `package.json` and both root entries of
   `package-lock.json`. Update the matching section in `CHANGELOG.md`, release status and
   installation commands in README and the documentation, and version-pinned API/example links.
   `scripts/check-doc-links.mjs` checks version agreement. Keep `private` absent. For a new minor
   release, write or update `docs/release-notes/X.Y.md` with the capabilities and changes consumers
   will notice, examples and any migration steps. Patch releases update that article when they
   change the consumer experience. Keep maintenance details in the changelog and link the release
   article from its version entry; do not publish a draft as a completed release.
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
   gh workflow run release.yml --ref main -f version=0.1.0
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

Create the release at the qualified full commit SHA with the tested assets and consumer release
notes introducing the release article and relevant changes. Link the detailed changelog rather than
copying its maintenance log. Supply explicit version, target and prerelease state. The notes link
the qualification PR/run, remaining limits and any pending review. After stable qualification and
authorization, for example:

```sh
gh release create 0.1.0 ./artifacts/0.1.0/* --target COMMIT \
  --title 0.1.0 --prerelease=false --latest --notes-file release-notes.md
```

Replace COMMIT with the qualified full SHA. For a prerelease, use its version and set
`--prerelease --latest=false`. Before creating a release, verify that neither its tag nor release
exists. `gh release create` uploads the assets to a draft before publishing them. Never replace
published assets or move a published tag. No repository immutability setting is required by this
procedure.

Download the public assets into a fresh directory and verify their checksums, version and manifest.
From the matching checkout, verify the downloaded tarball directly:

```sh
npm run test:package -- --tarball /absolute/path/to/viell-effect-schema-http-0.1.0.tgz
```

The command checks the exact downloaded bytes, declarations, exports and runnable example. Record
the release URL, tag target and checksum. Deploy the release documentation below and verify it.

## First npm publication and trusted publishing

The RC bootstrap and trusted-publisher setup are complete. [Issue
#68](https://github.com/viell-dev/slop-effect-schema-http/issues/68) records the owner's
confirmation and the verified registry installation. Do not upload `0.1.0-rc.1` again. Its `rc` and
`latest` tags are intentionally unchanged during bootstrap; stable publication advances `latest`.

### Publish a qualified version

Use **Publish qualified npm package** (`publish.yml`) on `main`. Supply the successful qualification
run for that exact current commit. The workflow downloads the already-tested Linux tarball, checks
its manifest and checksums, and chooses `rc`/`beta`/`alpha` for a prerelease or `latest` for stable.
It never rebuilds the package.

First dispatch with `publish=false` to verify the producer and dry-run publication. This publishes
nothing and does not prove that OIDC authentication works. An existing version may be rejected even
in npm's dry run; never treat that as permission to replace it.

Before actual publication, resolve the release review in #67 and the authorization in #68. The
repository variable `NPM_PUBLISH_ENABLED` must then be `true`; dispatch with `publish=true`. The
workflow publishes through OIDC with provenance and verifies registry integrity and provenance
against the artifact, commit and workflow. It does not create a GitHub release or deploy docs.

Install the published exact version in a fresh empty-cache consumer. Run the release's
`release-check.mjs` and `npm audit signatures`, inspect dist-tags, and compare registry integrity
with the manifest. Signature verification complements the workflow's provenance-content check.
Finish the GitHub release and documentation deployment for the same commit.

### Maintain the trust configuration

The npm trusted publisher must match these values:

| Setting           | Required value                          |
| ----------------- | --------------------------------------- |
| Provider          | GitHub Actions on GitHub-hosted runners |
| Owner             | `viell-dev`                             |
| Repository        | `slop-effect-schema-http`               |
| Workflow filename | `publish.yml`                           |
| Environment       | `npm-release`                           |
| Permission        | Direct publication with `npm publish`   |

Keep the GitHub environment restricted to the named `main` branch. Use the repository's pinned
Node/npm versions, package 2FA, and no bypass-2FA tokens. Do not add a long-lived npm token to
GitHub. See [npm's trusted-publishing guide](https://docs.npmjs.com/trusted-publishers/) when
changing the account configuration; the owner performs changes requiring their identity or second
factor.

### Bootstrap reference

For a new registry package, npm requires the package to exist before its trusted publisher can be
configured. Bootstrap by having the owner publish the verified candidate tarball interactively under
an explicit prerelease tag, then configure trust and verify registry bytes and installation. A local
upload has no GitHub OIDC provenance. This step is already complete for this package; its commands
and evidence are retained in #68.

The exact-artifact and trust approach follows [Markdown Tools' release
guide](https://github.com/viell-dev/slop-markdown-tools/blob/main/RELEASING.md#publication-prerequisites).
Its workflow filename, immutable-release setting and product-specific test matrix are not this
project's configuration. This project's release-review scope is recorded in #67.

## Promote RC to stable

The candidate contains the intended public API and behavior. Complete the documentation work and the
owner's final read-through in #67 before proceeding. That is the owner-selected human checkpoint for
this first release; no human runtime testing or code review is claimed.
[CONTRIBUTING](./CONTRIBUTING.md#before-a-release) records its scope and the automated evidence.

For `0.1.0`, update package and lockfile versions, the changelog, README and site installation
commands, release status, source links, and any versioned examples together. Move the Unreleased
documentation entry into the stable entry and retain the RC's publication history. Replace
bootstrap-specific tag guidance with the stable channel's actual state. Keep the version prerelease
until the review prerequisites are satisfied.

Record the RC-to-stable diff and reuse independent implementation review only where its assumptions
still hold. Run fresh exact-commit qualification: the stable package, documentation comments and
release metadata produce different bytes. Do not relabel the RC tarball or move its tag.

Documentation-only improvements do not require another RC. If a correctness fix changes behavior or
the public API, fix and requalify it and use another RC when needed. Evaluate ergonomic additions
for a later release rather than expanding this candidate's feature set.

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
