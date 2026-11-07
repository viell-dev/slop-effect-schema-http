# Releasing

This guide takes a version from preparation to publication. `VERSION` stands for the exact version
being released, without a `v`, and `X.Y` for its first two numbers.

Compatible fixes raise the patch number and breaking changes raise the minor number. A breaking
release needs migration guidance in its release article. Tags have no `v` prefix. A version normally
goes straight to stable; [use a prerelease](#use-a-prerelease) when a build has to be tried first.

Routine CI and release qualification publish nothing; publication is a separate, authorized step. A
release runs in this order:

1. [Prepare and qualify a candidate](#prepare-a-candidate).
2. [Publish it on GitHub](#publish-on-github).
3. [Publish the same bytes to npm](#publish-to-npm).
4. [Deploy its documentation](#release-documentation-and-corrections).

## Prepare a candidate

1. Review open issues, PRs, failed checks and the [dependency
   overview](https://github.com/viell-dev/slop-effect-schema-http/issues/41). Reproduce reported
   defects and record their dispositions. Keep required checks intact.
2. In a task branch, set the same version in `package.json` and both root entries of
   `package-lock.json`. Keep `private` absent. Then update everything that names the release:

   - **`CHANGELOG.md`:** turn `## Unreleased` into `## VERSION — DATE`, and link the release article
     from that entry. `npm run release:prepare` refuses a version with no matching heading.
   - **`docs/release-notes/X.Y.md`:** for a new minor release, write or update the article with the
     capabilities and changes consumers will notice, examples and migration steps for every breaking
     change. Patch releases update it when they change the consumer experience. Keep maintenance
     details in the changelog. Remove any wording that says the release is not published yet, and do
     not publish a draft as a completed release.
   - **`docs/.vitepress/config.ts`:** add a new article to the sidebar.
   - **Release status:** README, `docs/index.md`, `docs/api.md` and `docs/versions.md`, including
     the tarball names, download links and checksum examples in `docs/versions.md`.
   - **Source links:** the version-pinned `blob/VERSION` link at the end of each module guide.
   - **Hostile suite:** the commit pinned in `.github/workflows/release.yml`, when this release
     needs suite changes. A breaking release usually does. Suite changes reach the
     `hostile-servers-test` branch through their own pull request first.

   `scripts/check-doc-links.mjs` checks version agreement across these files. Stable onboarding
   keeps unversioned installation commands such as `npm install viell-effect-schema-http`, in every
   package-manager tab; exact versions belong in artifact verification and historical instructions.
   The user guides assume an existing project with a compatible Effect peer.

3. Run the ordinary checks in CONTRIBUTING, then review the complete diff. Obtain an independent
   deep review covering the implementation, changes since the previous release, compatibility,
   package, examples, docs, release tooling and remaining defects. Substantial changes to the API or
   main workflow also need the [agent usability review](./CONTRIBUTING.md#before-a-release), which
   works from a packed build, so nothing has to be published for it. Record the reviewed commit,
   findings and limits in the PR. Follow up on material fixes.
4. Commit the complete candidate. From a clean checkout with `.nvmrc` selected and `npm ci`
   complete:

   ```sh
   npm run release:prepare
   ```

   This clears only the local generated `dist/`, then runs type/format/lint checks, a fresh build,
   behavior/socket tests, executable docs, the site/link checks, and a moderate-or-higher dependency
   audit. It packs once, installs that tarball into an isolated consumer with Effect 4.1.2, verifies
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
   gh workflow run release.yml --ref main -f version=VERSION
   ```

   Require the whole run to succeed at the exact merged commit. It repeats candidate preparation on
   Linux and Windows, and checks all four hostile-suite lanes on Linux against that same library
   SHA: Node source, Chromium source, packed Node/declarations and the built Chromium app. The suite
   is pinned to a reviewed commit in the workflow and stays in its independent history. Its package
   build is independently qualified; the isolated consumers qualify the actual release tarball.

   Retain the Actions run and results in the release PR. Pending, skipped or failing required work
   is not release evidence. A subsequent code or tooling change requires fresh qualification.
7. Download `candidate-ubuntu-latest` from that successful run. Use its tarball for publication; do
   not rebuild it. `candidate-windows-latest` and `hostile-suite-results` are supporting evidence.
   Check the manifest's source commit, package identity/version, complete assets, and `SHA256SUMS`.

## Publish on GitHub

Create the release at the qualified full commit SHA with the tested assets and consumer release
notes introducing the release article and relevant changes. Link the detailed changelog rather than
copying its maintenance log. Supply explicit version, target and prerelease state. The notes link
the qualification PR/run, remaining limits and any pending review. After qualification and
authorization, for example:

```sh
gh release create VERSION ./artifacts/VERSION/* --target COMMIT \
  --title VERSION --prerelease=false --latest --notes-file release-notes.md
```

Replace COMMIT with the qualified full SHA. For a prerelease, use its version and set
`--prerelease --latest=false`. Before creating a release, verify that neither its tag nor release
exists. `gh release create` uploads the assets to a draft before publishing them. Never replace
published assets or move a published tag. No repository immutability setting is required by this
procedure.

Download the public assets into a fresh directory and verify their checksums, version and manifest.
From the matching checkout, verify the downloaded tarball directly:

```sh
npm run test:package -- --tarball /absolute/path/to/viell-effect-schema-http-VERSION.tgz
```

The command checks the exact downloaded bytes, declarations, exports and runnable example. Record
the release URL, tag target and checksum.

## Publish to npm

The package exists on npm and its trusted publisher is configured, so publication needs only the
workflow below. [Issue #68](https://github.com/viell-dev/slop-effect-schema-http/issues/68) records
that setup. Do not upload `0.1.0-rc.1` again; the `rc` tag retains that candidate. A stable
publication advances `latest`.

### Publish a qualified version

Use **Publish qualified npm package** (`publish.yml`) on `main`. Supply the successful qualification
run for that exact current commit. The workflow downloads the already-tested Linux tarball, checks
its manifest and checksums, and chooses `rc`/`beta`/`alpha` for a prerelease or `latest` for stable.
It never rebuilds the package.

Registry verification waits up to three minutes for HTTP 404 visibility delays from the version or
attestation endpoint, sharing one deadline. Requests have a ten-second timeout capped by the
remaining deadline. Other HTTP failures, malformed responses and integrity/provenance mismatches
fail immediately. A successful upload followed by a verification failure must never be republished.

First dispatch with `publish=false` to verify the producer and dry-run publication. This publishes
nothing and does not prove that OIDC authentication works. An existing version may be rejected even
in npm's dry run; never treat that as permission to replace it.

Before actual publication, verify that the release PR records the review and qualification, and that
publication is authorized. The repository variable `NPM_PUBLISH_ENABLED` must be `true`; dispatch
with `publish=true`. The workflow publishes through OIDC with provenance and verifies registry
integrity and provenance against the artifact, commit and workflow. It does not create a GitHub
release or deploy docs.

Install the published exact version in a fresh empty-cache consumer. Run the release's
`release-check.mjs` and `npm audit signatures`, inspect dist-tags, and compare registry integrity
with the manifest. Signature verification complements the workflow's provenance-content check. Then
deploy the documentation for the same commit.

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

## Use a prerelease

Use a prerelease when a build has to be installed before its release is final, for example so that
someone can try it. Give it a SemVer prerelease version, such as `-rc.1`, and follow the same
preparation, qualification and publication steps. The GitHub release sets
`--prerelease --latest=false`, npm publishes it under its own tag, and installation commands name
its exact version. The public site keeps describing the newest stable release.

To promote a candidate, set the stable version and update the same surfaces as any release, moving
the Unreleased entry into the stable one and retaining the candidate's publication history.

Record the candidate-to-stable diff and reuse independent implementation review only where its
assumptions still hold. Run fresh exact-commit qualification: the stable package, documentation
comments and release metadata produce different bytes. Do not relabel the candidate's tarball or
move its tag.

Documentation-only improvements do not require another candidate. If a correctness fix changes
behavior or the public API, fix and requalify it and use another candidate when needed. Evaluate
ergonomic additions for a later release rather than expanding this candidate's feature set.

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
- If npm succeeded but verification failed, dispatch **Verify existing npm publication**
  (`verify-publication.yml`) on `main`, supplying the original successful `qualification_run` and
  full `source_commit`. For example, the first stable release can be verified with:

  ```sh
  gh workflow run verify-publication.yml --ref main \
    -f qualification_run=41742659434 \
    -f source_commit=506562e81589bb6624963bb08d95a19207021455
  ```

  This read-only workflow checks that the commit belongs to main's history, validates the original
  qualification producer, downloads its exact Linux artifact, checks identity and checksums, then
  verifies registry integrity and provenance. It supports an older qualified commit after main has
  advanced. It contains no publication step or write/OIDC permission. Expired qualification
  artifacts make this path fail; do not substitute rebuilt bytes. Locally, verify the retained
  qualified artifact with `node scripts/verify-registry.mjs artifacts/VERSION/manifest.json`; set
  `GITHUB_ACTIONS=true` and `GITHUB_REPOSITORY` to require provenance too. Complete fresh-consumer
  and `npm audit signatures` checks separately. Never rerun the publish job for an existing version.
- If npm succeeded but GitHub failed, recover the original qualified artifact from Actions, verify
  registry integrity, and finish only GitHub and Pages. If published bytes are wrong, release a new
  version; never edit a published tarball, move its tag, or make update versions go backwards.
- A Pages failure does not invalidate the package. Fix/retry the verified release or a scoped docs
  correction, then verify the live version and commit. Keep the prior deployment until success.

## Release history

`0.1.0` was the first stable release, retaining the API and behavior of `0.1.0-rc.1` with completed
documentation and release metadata. Its goal was the finite-body API, ESM, Node.js 24 on
Windows/Linux and Chromium Fetch with Effect 4. [Issue
#2](https://github.com/viell-dev/slop-effect-schema-http/issues/2) records the owner's release
direction and qualification. The owner completed the final documentation review and authorized
continuation on 2026-11-04 in [#67](https://github.com/viell-dev/slop-effect-schema-http/issues/67),
which was the owner-selected human checkpoint for that release; no human runtime testing or code
review is claimed. Publication setup and execution are recorded in
[#68](https://github.com/viell-dev/slop-effect-schema-http/issues/68).
