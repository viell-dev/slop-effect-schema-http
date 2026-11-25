# Agent instructions

Read [README.md](./README.md) for the purpose, the records each exchange produces and the run path.
The projects' own documentation is what the tests are judged against: the library's
[guides](https://viell-dev.github.io/slop-effect-schema-http/) and
[design](https://github.com/viell-dev/slop-effect-schema-http/blob/main/docs/design.md), Warded's
[guides](https://viell-dev.github.io/slop-warded-router/) and rustdoc, and the Warded Server's
[guides](https://viell-dev.github.io/slop-warded-server/).

## Scope

- This suite tests the two projects against each other. It never changes either one, or the
  server. Work on the suite stays in this branch; a finding about a project becomes an issue in that
  project's repository, and its repair is separate work there.
- It covers what the library can declare in a request head and what Warded can match there. Bodies,
  response formats and hostile services belong to the hostile suite on `hostile-servers-test`.
- Every test serves both purposes: what the library sent, and what Warded made of it. Assert the
  records that show each, not only the decoded result.

## Rules

- **Warded's own routing.** The host builds each condition with the `warded` function it is named
  after, and adds no routing rule of its own. The exceptions are the conditions Warded leaves to
  applications: the host condition, copied unchanged from Warded's guide to custom matchers, and the
  `filter` predicates. Keep `Router::select` in the recorder and the dispatch check in `send`, so
  that every exchange compares them.
- **The library's public API.** Tests use only the library's package root, Effect, and the
  harness. Do not work around the library or edit `.library/`.
- **Real sockets.** Every request goes over a socket to a table opened in the test's own scope.
- **Mismatches.** When either project behaves contrary to its documentation, or the two disagree
  in a way neither documents:
  - pin what was observed, with a comment that says why and links the issue;
  - open the issue in the repository that owns the behaviour, with a synthetic reproduction, the
    three commits, the provider and protocol, and the four records of the exchange;
  - never weaken an assertion, skip a case or change a value until it passes.
- **Per provider.** Do not assume one client behaves like another. Where providers differ, the test
  states each one's behaviour, as measured, with the reason in a comment.
- **Time.** Use `it.live`, and keep real waits bounded.

## Verification and delivery

Follow [README.md](./README.md#running-the-suite). Run `npm run check`, `npm run lint` and
`npm test` before a pull request, and run the host's checks when `host/` changes.

Use a task branch from `warded-test` and deliver a pull request targeting it. Follow the library's
[contribution guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#pull-requests)
for review and pull request evidence, and its label rules.
