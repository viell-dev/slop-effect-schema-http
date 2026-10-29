# Effect Schema HTTP: hostile-API integration suite

This branch holds a server-backed integration suite for
[Effect Schema HTTP](https://github.com/viell-dev/slop-effect-schema-http). Five synthetic backends
reproduce the conventions of real APIs that a client does not control: an identity provider, a SOAP
document store, a JSON business API, a CGI reporting gateway, and a notification service. Each one
carries decades of plausible historical accidents. The suite checks that one consumer can talk to
all of them through the library's public API, without escaping it.

Agents write and maintain this suite. Its code is not human-reviewed.

## Why a separate branch

The backends are deliberately heavy, so they stay out of the library's `main` branch. This branch
has its own history and never merges into `main`. Each run tests a specific library commit, which
the suite fetches from this repository.

The scenario catalogue and acceptance criteria are tracked in
[issue #4](https://github.com/viell-dev/slop-effect-schema-http/issues/4). Changes to the suite
arrive through pull requests into this branch.
