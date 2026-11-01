# Versions and contributing

## Documentation version policy

The current site describes unreleased `main`. Its navigation reads the package version directly from
the manifest, and each built page records the documentation commit in a `documentation-commit` meta
tag. Local builds with uncommitted changes carry a `-dirty` suffix. Published documentation comes
from a clean, verified `main` commit.

Once a supported installable release exists, the public default documentation must describe that
release. Unreleased behavior must be labeled explicitly. That transition is part of [release
preparation](https://github.com/viell-dev/slop-effect-schema-http/issues/2), including the
distribution channel, supported environments, compatibility policy and first-stable goal.

Correct current documentation through a pull request and a new documentation deployment, recording
the documentation commit. Do not move a software tag to correct documentation. A docs deployment
does not publish a package or satisfy the human usability gate for a stable release.

## Contribute or verify a change

The [contribution
guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md) owns setup,
tests, labels, review and release prerequisites. Required pull-request checks build the library and
this site, run the typed executable example, validate internal page links and anchors, and exercise
behavior, sockets and the isolated package.

Documentation source is in `docs/`; it is excluded from the package. VitePress 2 is currently a
prerelease and is pinned exactly. Dependency install scripts remain disabled. For a proposed API
change, explain the consumer problem and compare it with [Design](./design.md) before treating
existing implementation behavior as a promise.
