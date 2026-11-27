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
- It covers two things. **Request heads:** what the library can declare in a request head, and
  what Warded can match there. **Services built on Warded, as the library sees them:** route tables
  in [`src/apis/`](./src/apis/) shaped like real APIs, whose handlers answer the way real services
  do, and what the library decodes or refuses of those answers.
- A service table can use whatever a Warded handler sends: any status from 100 to 999, error
  shapes that differ by status or by the layer that answers, repeated fields such as `Set-Cookie`,
  extension methods, routing on forwarded headers, JSONP callbacks, `;` query separators,
  challenges, redirects, slow or endless bodies, and a `Content-Encoding` that does not match the
  body. Each table, and each of its routes and replies, says which real-world convention it
  imitates. Names, ids and data are synthetic, and no real service is named.
- The hostile suite on `hostile-servers-test` keeps what Hyper does not let a handler write, which
  its own servers can: truncated or reset replies, malformed status lines, header-name case, and no
  reply at all. It also keeps the breadth of its service imitations, with their bodies and formats;
  a table here rebuilds a convention where Warded's side of it is part of the test.
- Every test serves both purposes: what the library sent, and what Warded made of it. Assert the
  records that show each, not only the decoded result. A test of a service table also asserts what
  the library decoded or refused, and the status the handler answered.

## Rules

- **Warded's own routing.** The host builds each condition with the `warded` function it is named
  after, and adds no routing rule of its own. The exceptions are the conditions Warded leaves to
  applications: the host condition, copied unchanged from Warded's guide to custom matchers, and the
  `filter` predicates. Keep `Router::select` in the recorder and the dispatch check in `send`, so
  that every exchange compares them.
- **Handlers.** A target answers what its table gives it: a fixed reply, or a lookup by one of its
  decoded captures, the way an application reads a record by its id. A handler never decides which
  route runs.
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
