# Agent instructions

Read [README.md](./README.md) for the purpose and run path, and [CATALOGUE.md](./CATALOGUE.md) for
the scenarios. The library's own design, which these tests are judged against, is
[docs/design.md on main](https://github.com/viell-dev/slop-effect-schema-http/blob/main/docs/design.md).

## Layout

- `src/harness/`: the loopback server (`serve`), the router, and the two client providers. Change
  these only when a scenario needs it, and keep them backend-neutral.
- `src/backends/<area>`: the synthetic servers. Each documents its deliberately incompatible
  conventions in comments that say who introduced each quirk and why nobody can remove it.
- `src/clients/<area>`: the consumer's contracts and schemas for that backend, written only against
  the library's public API (`viell-effect-schema-http`), Effect, and `src/formats`.
- `src/formats/`: consumer-side format helpers (XML, CSV and the like). The library offers no
  format-specific support, and the suite must not need any.
- `src/values/`: value-convention schemas shared across areas, with round-trip tests.
- `src/scenarios/`: server-backed tests, one file per area.

## Rules

- **Real sockets only.** Every scenario dispatches over HTTP to a server started with `serve` in the
  test's own scope, so each test gets fresh state. Do not replace the transport with an in-memory
  client.
- **Assert the wire.** Check what the server received from `server.ledger`: method, target, header
  lines, body bytes and request counts. Do not rely only on the decoded value.
- **Distinguish failures.** Pre-dispatch validation, server rejection, decode errors, timeouts,
  unexpected responses and explicit fallbacks are different outcomes; assert which one occurred.
- **Providers.**
  - `linesLayer` preserves header lines, follows no redirects and keeps no cookies.
  - `fetchClient` is Effect's Fetch provider.
  - When cookies, redirects or caching matter, state the provider and its settings in the test.
  - Do not assume behaviour carries over between Node and a browser.
- **Verify fixtures.** Check what the fixture really sends, such as 204 bodies, `Location` forms
  and duplicate parameters, before encoding an assumption into a test.
- **Time.** Use `it.live`, and keep real waits bounded: a few seconds per test at most. Synchronize
  on `server.arrived(n)` and the handler's abort signal, not on sleeps.
- **Round trips.** Every transform that claims to encode gets a round-trip test and negative cases
  that reject looser or invalid spellings. A deliberately lossy or one-way mapping states its loss,
  and its reverse fails with a reason.
- **Types.** Type-level guarantees use `expectTypeOf` and `@ts-expect-error`, which
  `corepack pnpm check` verifies.
- **Traceability.** Start each test title with its catalogue ID, such as `[AUTH-3]`, and update the
  entry's status in `CATALOGUE.md`.
- **Mismatches.** If the library cannot express a scenario without escaping its API, or behaves
  contrary to its design, do not edit `.library`, work around the library, or weaken an assertion.
  - Write a test titled "currently …" that pins the observed behaviour.
  - Mark the catalogue entry as a suspected defect, with the evidence.
  - Use an expected-failure test only when the intended behaviour is documented in the library's
    design page or doc comments.

## Commands

```sh
fnm use                      # or nvm use; Node.js version from .nvmrc
corepack pnpm install --frozen-lockfile
corepack pnpm library        # fetch the library source at the commit in library-ref
corepack pnpm check          # TypeScript (including type-level tests) and Prettier
corepack pnpm lint           # Oxlint
corepack pnpm test           # the suite
```

Deliver changes through pull requests into `hostile-servers-test`.
