# Agent instructions

Read [README.md](./README.md) for scope and current limitations, and
[CONTRIBUTING.md](./CONTRIBUTING.md) for development, verification, labels, and release
prerequisites.

- Use a task branch from `main` and deliver changes through a pull request. Never bypass branch
  protection or rewrite shared history. Prefer rebasing and fast-forward integration; GitHub's
  rebase merge is the hosted equivalent when the branch is current.
- Change the version only in release preparation, which RELEASING.md owns. While the package remains
  `0.x`, compatible fixes raise the patch number and breaking changes raise the minor number. The
  package is publishable, so do not infer readiness from the version.
- Keep public documentation self-contained. Put reproducible evidence, material decisions, and
  remaining work in issues and pull requests.
- Follow CONTRIBUTING's documentation rules across API docblocks, examples, README, module guides
  and release instructions. Check the whole affected reader journey when an API or release fact
  changes.
- Review the complete diff after required checks pass. Separate agent review is proportionate to
  risk; an ordinary documentation or repository setup change can use deliberate author review.
