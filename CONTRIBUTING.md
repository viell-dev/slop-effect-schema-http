# Contributing

This project is an agent-maintained library for consumer-owned HTTP contracts. Read the
[README](./README.md) before proposing changes. Requests are assessed for fit and long-term
maintenance cost; a filed request is not a commitment to implement it.

## Development and verification

Clone the repository for source development:

```sh
git clone https://github.com/viell-dev/slop-effect-schema-http.git
cd slop-effect-schema-http
```

Use the Node.js version in [.nvmrc](./.nvmrc) with the npm it bundles. From the checkout, select it
with `fnm use` or `nvm use`. [package.json](./package.json) declares the required npm version and
available scripts. Install with `npm ci`, which installs exactly what `package-lock.json` records,
then run the required checks:

```sh
npm ci
npm run check
npm run lint
npm run build
npm test
npm run test:release
npm run test:package
```

- `npm run check`: TypeScript and formatting checks, including the type-level assertions in tests.
- `npm run lint`: Oxlint, ESLint, and Markdown linting.
- `npm run build`: JavaScript and declaration output in `dist/`.
- `npm test`: Vitest behavior tests.
- `npm run test:release`: reject invalid qualification producers/artifacts, exercise bounded
  registry visibility recovery and terminal integrity/provenance failures, check the read-only
  workflow, the handover from publication to the site, that release preparation refuses a stale
  tested version, and every comparison `npm run check-live` makes, against synthetic surfaces.
- `npm run test:package`: verify the built tarball in an isolated consumer; run the build first.
- `npm run format`: apply the configured formatters.

CI requires these verification commands on Linux, plus the documentation checks below, as its
`checks` job. Its `node-26` job repeats the build, `npm test` and `npm run test:package` on the
newest Node.js 26, and is required too. For code changes, reproduce the reported behavior first and
add a meaningful test at the layer that exposes it.

`.npmrc` sets `ignore-scripts=true`, so no dependency's install script runs. Keep it: none of the
current dependencies needs one, and a new dependency that does needs a review of what the script
does before an exception is added. The setting also skips `pre` and `post` scripts, so do not add
those to `package.json`. Add or update a dependency with `npm install`, commit `package-lock.json`
with `package.json`, and check that `npm ci` still succeeds from a clean checkout.

Disabling install scripts is this repository's development and verification policy, not a library
installation requirement. Consumer commands use ordinary `npm install`; the library needs no
installation script. See npm's [ignore-scripts
documentation](https://docs.npmjs.com/cli/v11/using-npm/config#ignore-scripts) for the option's
behavior.

The root `overrides` entry replaces minimatch 10 with 11.0.1 in development tools to address
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). It crosses the tools'
declared major-version range; the required checks validate this repository's usage. Remove it when
ESLint, `@eslint/config-array` and `@typescript-eslint/typescript-estree` all resolve a patched
version without it, then rerun the checks and `npm audit`. mdrefine already asks for 11.0.1.
[#49](https://github.com/viell-dev/slop-effect-schema-http/issues/49) records the compatibility
evidence; [#41](https://github.com/viell-dev/slop-effect-schema-http/issues/41) tracks dependency
follow-up.

The development compiler remains TypeScript 6.0.3 because current typescript-eslint 8.72.1 requires
`>=4.8.4 <6.1.0`; TypeScript 7's native compiler does not provide its required programmatic API.
Release preparation separately checks strict package consumers with TypeScript 7.0.2.
[#69](https://github.com/viell-dev/slop-effect-schema-http/issues/69) records the resolution failure
and reconsideration trigger. Keep compatible peer installation; do not force the development
compiler past the lint tools' supported range.

### Behavior tests

Module tests sit beside their module as `src/**/*.test.ts` and use `@effect/vitest`. Shared fixtures
live in `test/support.ts`. Its synthetic provider builds an `HttpClient` with `HttpClient.make`,
records each dispatch (request, composed URL, header lines, abort signal), and answers with Web
`Response` objects. Tests therefore run through Effect's real client wrapper without a network. Use
`it.effect` with `TestClock` for retry delays and timeouts. Use deferreds or explicit start signals,
not sleeps, to order concurrent work.

Write tests against documented intent: the doc comments in the source and
[docs/design.md](./docs/design.md). A change to a design decision updates that page in the same pull
request. Behavior the code happens to have is not a promise. A test that records it without design
backing is titled "currently …" and links an issue where the behavior is decided.

A confirmed defect gets an issue and two tests, each with a comment linking the issue. An ordinary
test pins the exact current outcome, and a test of the intended behavior is marked
`it.effect.fails`. The marker keeps CI green while the defect is open, but `.fails` accepts any
failure, so the ordinary test proves the expected failure comes from the defect rather than an
unrelated error. Fixing the defect fails both tests: delete the pin and remove the marker.

Use an expected-failure test only when the intended behavior is documented or the owner decided it.
If the intended behavior is a design question, write only the "currently …" pin and open a
discussion issue. Do not encode the answer as a test. Pin a type-level limitation with
`@ts-expect-error` and a linked issue. Do not weaken an assertion to make a test pass.

The module tests cover every module, including request encoding, response selection and decoding,
retry policies, timeouts, cancellation, and interactions. They check the library's own header-line
normalization and Effect's parsing of synthetic responses. They do not exercise Fetch, browsers,
real servers, or packaged installation.

### Socket regressions

`src/http/Operation.socket.test.ts` runs in the ordinary `npm test` command and required CI. It
checks Node Fetch's followed/manual redirects, cookies with and without an explicit Effect jar,
multipart boundary/body agreement, repeated request and response lines and header-name spelling
through a small `node:http` provider, constructor query text, a dropped fragment, kept slashes and
resolved dot segments in a path, a declared or removed `Content-Type`, a declared `Content-Length`
Effect's Fetch client takes off, Fetch's refusal of a GET body and of a method such as `TRACE`,
carriage returns and line feeds kept off the wire, and socket closure when an in-progress buffered
or stream body read is interrupted.

`test/socket.ts` starts fresh servers on ephemeral `127.0.0.1` ports and closes their connections at
scope exit. Its line-preserving client is a GET-only test control, not a supported transport. Tests
use `it.live`, explicit body-read and peer-close signals, and bounded deadlines. The peer must close
before server cleanup runs; cleanup cannot satisfy the interruption assertion. No external service,
credentials, sleeps, or browser installation is needed.

These small transport regressions test the current library commit on every pull request. The
separate hostile suite retains service formats, realistic workflows and browser policy. Run its
relevant source lanes against the task commit when changing URL/header handling, body codecs,
response selection, client middleware, attempt scopes, retries, or Effect versions. Run the packed
lane for package/export/build changes and the app lane for bundled-browser integration changes.
Before a release, run all its lanes against the exact candidate commit and record their results.

### Packed-package verification

After building, `npm run test:package` packs the library with the pinned npm and checks the file
list and every declared export target. The package includes `dist/`, source files for declaration
maps, README, license, and package metadata; tests, tooling configuration, and documentation source
stay out. It installs that tarball in a temporary consumer outside the checkout, with the currently
installed Effect peer, TypeScript, and Node type versions pinned exactly. Dependency install scripts
remain disabled.

The consumer emits JavaScript and declarations with strict checking and `skipLibCheck: false`,
including imports of every declared subpath and transforms held in exported variables, whose types a
declaration has to be able to name. It imports the package root and each subpath at runtime, then
executes a schema-backed operation and a derived variant through a synthetic client. The fixtures
are in `fixtures/package/`. Successful runs remove the temporary consumer; failed runs retain it and
print its path for diagnosis. This checks Node ESM consumption at the selected versions, not a
published registry install, bundler, browser, or compatibility matrix.

For a manual installation in another project, run `npm pack` after the build and install the printed
tarball filename with npm in that project, together with a compatible Effect peer. Rebuild, repack
and reinstall after source changes. A local build is distinct from a checksummed release artifact;
use the release's exact bytes when verifying a published candidate.

### Verify a published candidate

For release verification, download the tarball, `SHA256SUMS` and `release-check.mjs` from the
version's [GitHub release](https://github.com/viell-dev/slop-effect-schema-http/releases). The
[Versions guide](./docs/versions.md#install-a-github-release-tarball) gives complete checksum
comparisons. On Linux, its command checks both downloaded assets; in PowerShell, run its comparison
once for the tarball and once with `$archive = "release-check.mjs"`.

In an empty directory with those verified files, run this, with `VERSION` replaced by the exact
version:

```sh
npm init -y
npm install --ignore-scripts ./viell-effect-schema-http-VERSION.tgz effect@4.1.2
node release-check.mjs
```

The checker prints successful decoding, invalid input rejected before dispatch, invalid response
data reported as `DecodeError`, and `Release check passed`. The disabled install scripts follow the
verification policy above. This checks a supplied artifact without building from source; the
[release procedure](./RELEASING.md) owns the full qualification and publication workflow.

### Hostile-server integration tests

The separate [`hostile-servers-test`
branch](https://github.com/viell-dev/slop-effect-schema-http/tree/hostile-servers-test) tests the
public API over real sockets against synthetic backends. It has its own history and never merges
into `main`; suite changes use task branches and pull requests targeting that branch.

Follow its
[README](https://github.com/viell-dev/slop-effect-schema-http/blob/hostile-servers-test/README.md#running-the-suite)
for setup, choosing the library commit under test, and running the Node, Chromium, packed-package,
and built-app lanes. Its
[catalogue](https://github.com/viell-dev/slop-effect-schema-http/blob/hostile-servers-test/CATALOGUE.md)
maps scenarios to tests, observed limits, and defect issues. Coverage is specific to the tested
commit, provider, and lane; do not extrapolate cookie, redirect, header, or CORS behavior between
platforms. The packed lane uses the suite's dependencies; the isolated consumer check above verifies
the package separately from that suite.

The current release matrix uses Node.js 24.22.2 and the newest Node.js 26 on Windows/Linux, Effect
4.0.7 and 4.1.2, TypeScript 6.0.3 and 7.0.2 consumers, and Chromium supplied by Playwright 1.65.0.
Playwright is test infrastructure, not a consumer dependency. The checked-out suite lockfile and
release workflow own the exact tool versions; record them with qualification evidence when updating
the matrix. These versions say what the last release was qualified on, so a routine dependency
update leaves them alone. `npm run release:prepare` compares them with `package.json`,
`package-lock.json`, `.nvmrc`, its own options, the workflows and the suite's lockfile at its pin,
and refuses a disagreement. It skips the Playwright version, with a note, in a checkout without that
commit; release qualification fetches the history that has it.

## Documentation site

User pages teach the installed package: explain what a feature does, show the smallest useful
example and its result, then add common options and composition. Put advanced behavior and edge
cases under named subheadings after the common path. Define terms when first needed and link Effect
concepts to its v4 guides. Each public module has a guide under `docs/modules/`; source signature
links supplement those guides. Keep existing page addresses usable when reorganizing.

Read the guides in sidebar order, including their next-page links. Each successive introduction
should teach a new task instead of replaying the same example. Put user tasks first, including
recipes, then modules, then limits and detailed behavior, followed by versions, release articles and
development links. Keep candidate verification and source-build procedures here rather than in
onboarding.

Lead with the main workflow: define once, adjust where it is used. Hold a transform in a named
variable or map once per change, use `flow` only to define a composed function with a name, and use
a plain arrow function where that is simplest. Show generators where an operation runs. Each recipe
keeps its code in `examples/recipes/`, one file each, and checks its failure cases as well as its
results.

Apply the same progression to public API docblocks: a useful one-sentence summary, a small
`@example` where it teaches usage, then detailed behavior under `@remarks`. Document every public
export, including package-root namespaces. Write examples with public package imports so the checks
exercise the installed API. The build retains these comments in TypeScript declarations for editor
help. Keep source comments, module guides, README, examples and the design contract consistent;
changing a comment does not silently change the API's promised behavior.

Document ownership follows the reader's task: Request/Body teach ordinary bindings;
`docs/schema-input.md` owns detailed constructor/encoded reading and preservation/default bounds;
`docs/schema-groups.md` owns declaration/default/stacking rules; Limits owns runtime compatibility
and recovery; Design owns architectural invariants; release articles own chronological deltas. Keep
editor docblocks self-contained for the common rule and material failure caveats, then link the
reference instead of repeating every proof condition. When a rule changes, review its owning
reference, affected task example, editor comment, active caveat and migration together. Preserve
existing URLs/anchors with short onward links when moving details.

README provides purpose, a small example, installation and navigation. The site describes the
behavior of the version it documents. Release articles under `docs/release-notes/` explain what
changes for consumers, with examples and migration links where useful. Start with what input or
action changes, its previous result and the decisive new condition. Identify a typing-only repair,
an extension of an existing runtime repair, or a separate defect before explaining proof mechanics.
A shared running example must name what changed between releases. Keep the current article visible,
and put older articles in the collapsed archive and release-history index. `CHANGELOG.md` records
the complete history, including maintenance, and `docs/changelog.md` includes that one source. Keep
compatibility requirements and versioned install commands where readers need them. This guide owns
development and verification procedures; RELEASING owns publication and deployment; issues and PRs
own investigations and delivery evidence. Do not copy those procedures or progress narratives into
user pages or AGENTS.md.

VitePress `2.0.0-alpha.21` is pinned exactly; it is a prerelease. The public default site describes
the newest stable installable release, or the newest GitHub candidate before stable. See the public
[version policy](./docs/versions.md) and [release procedure](./RELEASING.md) for deployment and
current-release corrections.

From the root, after the library build, run:

```sh
npm run docs:examples
npm run docs:build
npm run docs:dev
```

The first command type-checks `examples/**/*.ts` without `skipLibCheck`, checks public summaries
against generated declarations, requires a docblock on every member of a public interface, resolves
every `{@link}`, and type-checks every `@example` and standalone Markdown TypeScript block. A
Markdown fence the compiler does not see fails unless `scripts/check-doc-examples.mjs` lists it with
a reason. It then executes all three introductory guides, the current migration examples, all eight
module examples and every recipe through the built package's public entry points. The pages import
their code regions directly. Examples use synthetic clients and make no external requests; runtime
assertions verify the shown results. When changing onboarding, also copy its displayed snippets into
a fresh consumer of the published version and run the documented commands without a checkout.
`docs:build` builds the static site, fails on VitePress dead links or missing snippets, and checks
rendered internal pages, assets, anchors and package facts. Those facts include the rendered
`library-version`, the release status paragraphs, every install command, that each page is in the
site navigation or deliberately unlisted, and that the commands, workflows, inputs and jobs named in
this guide and RELEASING exist. External links are reviewed separately. `docs:dev` starts the local
development server; `docs:preview` serves the production build on `127.0.0.1`. It uses the Vite
preview server shipped with VitePress because this pinned VitePress version's own preview command
ignores the host option. Keep development and preview servers on loopback.

Required pull-request CI runs the example and site build with read-only permissions. Main pushes
verify changes without deploying unreleased documentation. The separate `pages.yml` workflow runs
after a verified stable npm publication, or by hand for recovery and corrections. It validates a
published tag or a documentation-only descendant, builds it, and deploys through the main-only
`github-pages` environment. Only its deployment job receives Pages/OIDC permissions.

Each page contains `documentation-commit` and `library-version` meta tags. Local dirty builds carry
`-dirty`; CI rejects that marker. Record and verify the deployed commit and Actions run. Keep
software tags in place when correcting documentation. No package publication occurs in this
workflow. Current-release corrections may include the embedded TypeScript example modules allowed by
[`scripts/documentation-scope.mjs`](./scripts/documentation-scope.mjs), with the examples checked
against the unchanged library release. Example runners, distributed release assets and production
source remain outside this route; [RELEASING](./RELEASING.md#release-documentation-and-corrections)
owns the procedure.

## Pull requests

Create a task branch from `main` and submit a pull request. Main requires pull requests, passing CI,
and resolved review conversations, including for administrators. Keep dependencies locked and follow
the existing formatter and lint configuration. Do not commit `dist/` or `node_modules/`. Prefer
rebasing and fast-forward integration; use GitHub's rebase merge when merging through the host.
Delete completed task branches.

After checks pass, review the complete diff and consider behavior the checks do not cover. The PR
records commands, results, platform and versions, evidence limits, material design choices, linked
follow-up issues, and whether a separate reviewer was warranted. Do not broaden the assignment to
unrelated findings; record and triage them separately. Use synthetic examples without credentials or
private data.

## Issues and labels

Report a defect with the [bug report
form](https://github.com/viell-dev/slop-effect-schema-http/issues/new?template=bug_report.yml), and
a vulnerability as [SECURITY.md](./SECURITY.md) describes.

Every issue and PR has exactly one `Type:` label and at most one `Status:` label. `Needs: Owner`
identifies an owner-only decision or action; `Needs: Human` identifies work any suitable person can
perform. Use only one `Needs:` label, assign requests to the person being asked, and state what
depends on the answer. Blocked work links its dependency. The catalog in
[.github/labels.json](./.github/labels.json) defines the shared labels and their meanings.

## Before a release

Follow [RELEASING.md](./RELEASING.md). While the package remains `0.x`, compatible fixes raise the
patch number and breaking changes raise the minor number, with migration guidance in the release
article. Every publication needs its own qualification; a publishable package does not establish
release readiness.

Every release needs exact-commit checks, isolated installation, all hostile lanes, an independent
deep review, verified artifacts and public documentation. A release may use prior review evidence
for unchanged code, with scope and limits recorded. Fix material findings and independently review
the affected changes; no review substitutes for required checks.

Agents own functional verification and investigation of reproducible defects. The human release
checkpoint assesses whether the documentation and workflow are understandable; it is not a request
to find bugs missed by tests or agent review.

The owner set that checkpoint on 2026-11-06 in
[#92](https://github.com/viell-dev/slop-effect-schema-http/issues/92): substantial changes to the
API or main workflow get an agent usability review instead of a human use pass. A separate agent
with fresh context works through the changed API and guides as a new user would and reports what is
confusing or awkward. The release pull request records the result. This is not evidence of human
use. The owner may still comment on what they notice while reading the documentation; treat those
comments as consumer reports, not as a step a release waits for. Reconsider this scope when the
owner has time to use the library themselves.

Routine fixes may reuse relevant evidence, with its limits recorded. No review changes the required
automated gates.

`0.1.0` was the first stable release. Its agreed goal was the finite-body API, ESM, Node 24 on
Windows/Linux and Chromium Fetch with Effect 4, and the [release
tracker](https://github.com/viell-dev/slop-effect-schema-http/issues/2) owns its evidence. For that
release only, the owner chose and completed a final documentation read-through as the checkpoint on
2026-11-04, recorded in [#67](https://github.com/viell-dev/slop-effect-schema-http/issues/67). It
replaced the earlier hands-on request. It did not establish human runtime testing or code review;
the substitute functional evidence was automated consumer, package, socket and hostile-suite
qualification plus independent agent review.
