# Contributing

This project is an unreleased, agent-maintained library for consumer-owned HTTP contracts. Read the
[README](./README.md) before proposing changes. Requests are assessed for fit and long-term
maintenance cost; a filed request is not a commitment to implement it.

## Development and verification

Use `.nvmrc` and the package manager pinned in `package.json`. Install with
`corepack pnpm install --frozen-lockfile`. Existing commands are:

- `corepack pnpm check`: TypeScript and formatting checks.
- `corepack pnpm lint`: Oxlint, ESLint, and Markdown linting.
- `corepack pnpm build`: JavaScript and declaration output in `dist/`.
- `corepack pnpm test`: Vitest behavior tests; currently fails because no tests exist.
- `corepack pnpm format`: apply the configured formatters.

CI currently requires the first three commands on Linux. Runtime behavior and packaged consumer
installation remain unverified. Adding a regression suite and making it a required CI gate is
follow-up work, not a passing or skipped test result. For code changes, reproduce the reported
behavior first and add a meaningful test at the layer that exposes it.

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

Every issue and PR has exactly one `Type:` label and at most one `Status:` label. `Needs: Owner`
identifies an owner-only decision or action; `Needs: Human` identifies work any suitable person can
perform. Use only one `Needs:` label, assign requests to the person being asked, and state what
depends on the answer. Blocked work links its dependency. The catalog in
[.github/labels.json](./.github/labels.json) defines the shared labels and their meanings.

## Before a release

There is no release or publishing workflow yet. Release preparation must settle licensing,
distribution, supported environments, and a stable release goal with the owner. Keep changing
features in alpha; use beta once that goal is feature complete, and RC only for a candidate intended
to become the exact stable release.

Before publication, establish behavior tests, package installation checks, user-facing API examples,
release instructions, change history, and the required documentation site for general use. The
public default documentation describes the latest installable release; label unreleased behavior
explicitly. Verify the exact release commit and complete artifacts before publishing, then verify
downloads and installation. Documentation corrections must not move software tags.

Before the first stable release, a person must install a representative candidate and try the main
library workflow. Agents prepare an installable candidate, synthetic example, numbered tasks and
expected results, and an assigned issue requesting the person's actual usability report. Stable
publication waits for that report and resolution of blockers. Repeat a focused human pass after
substantial API or workflow changes; automated checks and agent review do not satisfy this gate.
