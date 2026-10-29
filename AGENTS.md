# Agent instructions

Read [README.md](./README.md) for scope and current limitations, and
[CONTRIBUTING.md](./CONTRIBUTING.md) for development, verification, labels, and release
prerequisites.

- Use a task branch from `main` and deliver changes through a pull request. Never bypass branch
  protection or rewrite shared history. Prefer rebasing and fast-forward integration; GitHub's
  rebase merge is the hosted equivalent when the branch is current.
- Keep the package private and its version a SemVer prerelease until release preparation is assigned
  and its prerequisites are satisfied. Do not infer release readiness from the version.
- Keep public documentation self-contained. Put reproducible evidence, material decisions, and
  remaining work in issues and pull requests.
- Review the complete diff after required checks pass. Separate agent review is proportionate to
  risk; an ordinary documentation or repository setup change can use deliberate author review.
