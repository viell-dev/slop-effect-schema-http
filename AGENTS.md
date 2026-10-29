# Agent instructions

Read [README.md](./README.md) for the purpose and run path, and [CATALOGUE.md](./CATALOGUE.md) for
the scenarios. The library's own design, which these tests are judged against, is
[docs/design.md on main](https://github.com/viell-dev/slop-effect-schema-http/blob/main/docs/design.md).

## Layout

- `src/harness/`: the loopback server and router used by backends, the client providers, the two
  lanes behind `#lane` (`lane.node.ts`, `lane.browser.ts` with its control server), the browser
  lane's same-origin proxy (`proxy.ts`), and the app lane's setup, which builds the app and serves
  it with that proxy (`app-setup.ts`). Change these only when a scenario needs it, and keep them
  backend-neutral.
- `services/`: one page per hostile service, as its owners would publish it for integrators:
  endpoints, formats, value conventions, errors, and the history of each quirk (who introduced it,
  when, and why nobody can remove it), with the JSON options a test can set in a separate "Test
  options" section.
- `src/backends/<area>`: the synthetic servers. Their comments are notes about the implementation;
  each entry point links its service page, which documents the behaviour.
- `src/clients/<area>`: the consumer's contracts and schemas for that backend, written only against
  the library's public API (`viell-effect-schema-http`), Effect, and `src/formats`.
- `src/formats/`: consumer-side format helpers (XML, CSV and the like). The library offers no
  format-specific support, and the suite must not need any. `independent.ts` wraps the independent
  XML parsers (saxes, Chromium's `DOMParser`), and `corpus/` holds the edge-case documents the
  readers are compared with them on (EXT-3 to EXT-5). When a reader disagrees with an independent
  parser, fix the consumer's reader and keep the case in the corpus, or record the disagreement and
  its reason in the case and the catalogue; never fix a backend from the consumer side.
- `src/values/`: value-convention schemas shared across areas, with round-trip tests.
- `src/scenarios/`: server-backed tests, one file per area.
- `src/app/`: the single-page app of the app lane (EXT-7), consumer code in plain DOM.
  `vite.app.config.ts` builds it into `.app/`, which Git ignores.

## Rules

- **Black-box backends.** A backend is reachable only through its HTTP interface.
  - Backend code imports only Node built-ins, modules inside `src/backends/`, and
    `src/harness/server.ts` or `route.ts`. It implements its own formats, conversions and checks,
    never sharing a schema, codec, helper or constant table with the consumer side, so a bug cannot
    cancel itself out across both.
  - Tests configure a backend only through its JSON options.
  - `npm run check` enforces both directions with `scripts/boundaries.mjs`, which resolves every
    import, through `package.json` `imports` and `tsconfig.json` `paths` aliases too: a backend's
    against that allowlist, and consumer code's and scenarios' against any backend and any harness
    module except `lane.ts` and `#lane`. A `#…` specifier that resolves to nothing, or an
    undeclared package, fails the check. `scripts/boundaries.test.mjs` tests the script in
    `npm run check`; extend it when the resolution changes. `npm run lint` flags common cases too,
    by specifier text only.
- **Separate authorship.** The import rule keeps the code apart; this rule keeps the authors'
  knowledge apart, so that one misreading of a format cannot end up on both sides and cancel out.
  - A backend is written from the catalogue and its service page.
  - Consumer code, consumer-side format helpers and their tests are written from the service page,
    the catalogue and observed HTTP behaviour.
  - Each side is written in a separate agent context; the consumer side's author does not open
    `src/backends/`.
  - A change to observable behaviour updates the service page in the same pull request.
  - Pull requests record which context wrote which side.
  - The rule applies to new work; code written before it is not rewritten under it.
  - `scripts/boundaries.mjs` also checks that every backend entry point links an existing page in
    `services/` with a `Service documentation: services/<page>.md` line.
- **Two lanes.** Every scenario runs in Node and in Chromium (Vitest browser mode), to show that the
  library works in a static single-page app as well as in Node.
  - Tests import `lane` from `#lane` and start backends by name with `lane.backend(name, options)`.
    Backends always run in Node. The browser lane reaches them through a control server, with CORS
    answered by the harness unless the test asks for the backend's own.
  - Options must be plain JSON.
  - Consumer code (`src/clients`, `src/values`, `src/formats`, `src/scenarios`, `src/app`) uses
    only Web-standard APIs: no `node:*`, `Buffer` or `process`.
  - A test that needs Node itself goes in a `*.node.test.ts` file, with a comment saying why. A test
    about the browser itself, such as a page's CORS or the same-origin proxy, goes in a
    `*.browser.test.ts` file, which runs only in the browser project, with a comment saying why.
  - A test of the built app goes in a `*.app.test.ts` file, which runs only in the app lane: Node
    drives the page with Playwright's Chromium and starts backends with `lane.backend`, and the
    page reaches them through the proxy on its own origin. Its catalogue entry says `Lane: app`, so
    only `npm run app` checks it. Synchronize on `backend.arrived(n)` and on page state, such as
    Playwright's waits for an element or a status text, never on sleeps.
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
  `npm run check` verifies.
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
fnm use                           # or nvm use; Node.js version from .nvmrc, with its bundled npm
npm ci
npm run library                   # fetch the library source at the commit in library-ref
npx playwright install chromium   # once, for the browser lane
npm run check                     # TypeScript (incl. type-level tests), Prettier, catalogue, boundaries
npm run lint                      # Oxlint
npm test                          # each lane as its own run, then the catalogue against their results
npm run library:pack              # build, pack and install the library at library-ref (packed lane)
npm run packed                    # Node lane, catalogue and tsc against the installed package
npm run app                       # build src/app against the installed package, drive it, catalogue
```

`.npmrc` sets `ignore-scripts=true`; keep it, and review any dependency that needs an install script
before adding an exception. It also skips `pre` and `post` scripts, so do not add them.

`npm test` runs `test:node`, `test:browser` and `test:catalogue` in turn; each lane writes a JUnit
report to `artifacts/`, and CI runs the same three scripts. For part of the suite, use
`npx vitest run <file> --project node` (or `browser`).

The source lanes are the default. Run `npm run library:pack` and `npm run packed` as well after
moving `library-ref`, or when a change touches how the suite imports the library, its subpaths or
its types; CI runs them after the source lanes. The packed lane is the Node lane against the
installed package, and `tsconfig.packed.json` type-checks the suite against its declarations
without `skipLibCheck`. README's "The packed lane" says what it covers. Only the packed lane runs
and type-checks `*.packed.test.ts` files, which may import package subpaths; keep every other
import of the library to its root, which both lanes resolve. Keep `tsconfig.packed.json`'s aliases
equal to `tsconfig.json`'s without the library's; `npm run check` enforces it.

The app lane needs the installed package too; CI runs it after the packed lane. Its setup builds
`src/app` on every run, so a test never drives a stale build, and the build fails unless the library
comes from the installed package's `dist/`. Give the app no alias for the library, and change
`src/app` only as an application would use the library. README's "The app lane" says what it
covers.

Deliver changes through pull requests into `hostile-servers-test`.
