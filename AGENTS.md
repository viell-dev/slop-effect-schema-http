# Agent instructions

Read [README.md](./README.md) for the purpose and run path, and [CATALOGUE.md](./CATALOGUE.md) for
the scenarios. The library's own design, which these tests are judged against, is
[docs/design.md on main](https://github.com/viell-dev/slop-effect-schema-http/blob/main/docs/design.md).

## Layout

- `src/harness/`: the loopback server and router used by backends, the client providers, the two
  lanes behind `#lane` (`lane.node.ts`, `lane.browser.ts` with its control server), and the browser
  lane's same-origin proxy (`proxy.ts`). Change these only when a scenario needs it, and keep them
  backend-neutral.
- `src/backends/<area>`: the synthetic servers. Each documents its deliberately incompatible
  conventions in comments that say who introduced each quirk and why nobody can remove it.
- `src/clients/<area>`: the consumer's contracts and schemas for that backend, written only against
  the library's public API (`viell-effect-schema-http`), Effect, and `src/formats`.
- `src/formats/`: consumer-side format helpers (XML, CSV and the like). The library offers no
  format-specific support, and the suite must not need any.
- `src/values/`: value-convention schemas shared across areas, with round-trip tests.
- `src/scenarios/`: server-backed tests, one file per area.

## Rules

- **Black-box backends.** A backend is reachable only through its HTTP interface.
  - Backend code imports only Node built-ins and `src/harness/server.ts` or `route.ts`. It
    implements its own formats, conversions and checks, never sharing a schema, codec, helper or
    constant table with the consumer side, so a bug cannot cancel itself out across both.
  - Tests configure a backend only through its JSON options.
  - `pnpm lint` enforces both directions.
- **Two lanes.** Every scenario runs in Node and in Chromium (Vitest browser mode), to show that the
  library works in a static single-page app as well as in Node.
  - Tests import `lane` from `#lane` and start backends by name with `lane.backend(name, options)`.
    Backends always run in Node. The browser lane reaches them through a control server, with CORS
    answered by the harness unless the test asks for the backend's own.
  - Options must be plain JSON.
  - Consumer code (`src/clients`, `src/values`, `src/formats`, `src/scenarios`) uses only
    Web-standard APIs: no `node:*`, `Buffer` or `process`.
  - A test that needs Node itself goes in a `*.node.test.ts` file, with a comment saying why. A test
    about the browser itself, such as a page's CORS or the same-origin proxy, goes in a
    `*.browser.test.ts` file, which runs only in the browser project, with a comment saying why.
  - Do not extrapolate cookie, redirect or CORS behaviour between the lanes.
  - In the browser lane, a page reaches a backend without CORS through the same-origin proxy at
    `<page origin>/__proxy/<host>:<port>/<path>`. `src/clients/browser/proxy.ts` builds those URLs,
    and `src/harness/proxy.ts` documents what the proxy changes on the wire.
- **Real sockets only.** Every scenario dispatches over HTTP to a backend started in the test's own
  scope, so each test gets fresh state. Do not replace the transport with an in-memory client.
- **Assert the wire.** Check what the backend received from `yield* backend.ledger`: method, target, header
  lines, body bytes and request counts. Do not rely only on the decoded value.
- **Distinguish failures.** Pre-dispatch validation, server rejection, decode errors, timeouts,
  unexpected responses and explicit fallbacks are different outcomes; assert which one occurred.
- **Providers.** `lane.clients` lists the providers available in the current lane.
  - `lane.linesClient` (Node lane only) preserves header lines, follows no redirects and keeps no
    cookies.
  - `lane.fetchClient` is Effect's Fetch provider over the lane's own `fetch`.
  - When cookies, redirects or caching matter, state the provider and its settings in the test.
  - Do not assume behaviour carries over between Node and a browser.
- **Verify fixtures.** Check what the fixture really sends, such as 204 bodies, `Location` forms
  and duplicate parameters, before encoding an assumption into a test.
- **Time.** Use `it.live`, and keep real waits bounded: a few seconds per test at most. Synchronize
  on `backend.arrived(n)`, not on sleeps.
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
corepack pnpm exec playwright install chromium   # once, for the browser lane
corepack pnpm check          # TypeScript (including type-level tests) and Prettier
corepack pnpm lint           # Oxlint
corepack pnpm test           # the suite
```

Deliver changes through pull requests into `hostile-servers-test`.
