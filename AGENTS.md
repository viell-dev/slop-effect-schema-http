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
  XML parsers (saxes, imported only through `saxes.js`, whose `saxes.d.ts` says why; Chromium's
  `DOMParser`), and `corpus/` holds the edge-case documents the readers are compared with them on
  (EXT-3 to EXT-5). When a reader disagrees with an independent parser, fix the consumer's reader
  and keep the case in the corpus, or record the disagreement and its reason in the case and the
  catalogue; never fix a backend from the consumer side.
- `src/values/`: value-convention schemas shared across areas, with round-trip tests.
- `src/scenarios/`: server-backed tests, one file per area.
- `src/app/`: the single-page app of the app lane (EXT-7), consumer code in plain DOM.
  `vite.app.config.ts` builds it into `.app/`, which Git ignores.
- `recordings/`: raw HTTP exchanges recorded from real server software, one directory per set with
  its Dockerfile, the program or configuration it serves, `set.json` and `manifest.json`;
  [recordings/README.md](./recordings/README.md) describes them. `scripts/record.mjs`
  (`npm run record -- <set>`) makes a set again in Docker, on demand and never in CI. Never edit a
  `.http` file by hand: re-record it, and review the diff.
- `src/conformance/`: backend-side tests that hold each imitating backend to its recordings, with
  their helpers (EXT-6a to EXT-6e). The `replay` backend serves recordings to consumer tests.
  `readers.node.test.ts` holds the backend side's regression cases for the store's and the
  gateway's XML readers and the store's bundle writer, beside the consumer side's corpora
  (EXT-3 to EXT-5).

## Rules

- **Black-box backends.** A backend is reachable only through its HTTP interface.
  - Backend code imports only Node built-ins, modules inside `src/backends/`, and
    `src/harness/server.ts` or `route.ts`. It implements its own formats, conversions and checks,
    never sharing a schema, codec, helper or constant table with the consumer side, so a bug cannot
    cancel itself out across both.
  - Tests configure a backend only through its JSON options.
  - `npm run check` enforces both directions with `scripts/boundaries.mjs`, which resolves every
    import, through `package.json` `imports` and `tsconfig.json` `paths` aliases too: a backend's
    against that allowlist, consumer code's and scenarios' against any backend, any harness module
    except `lane.ts` and `#lane`, and the conformance tests, and the conformance tests' against any
    backend, any such harness module and any consumer code. A `#…` specifier that resolves to
    nothing, or an undeclared package, fails the check. `scripts/boundaries.test.mjs` tests the
    script in `npm run check`; extend it when the resolution changes. `npm run lint` flags common
    cases too, by specifier text only.
- **Separate authorship.** The import rule keeps the code apart; this rule keeps the authors'
  knowledge apart, so that one misreading of a format cannot end up on both sides and cancel out.
  - A backend is written from the catalogue and its service page.
  - Consumer code, consumer-side format helpers and their tests are written from the service page,
    the catalogue and observed HTTP behaviour.
  - Each side is written in a separate agent context; the consumer side's author does not open
    `src/backends/`.
  - A change to observable behaviour updates the service page in the same pull request.
  - Pull requests record which context wrote which side, in a line or heading of the description
    that starts with "Authorship", such as `## Authorship`. On a pull request that changes
    `src/backends/`, `src/conformance/`, `services/` or consumer code, CI's
    `scripts/authorship.mjs` fails without one; editing the description runs it again. It checks
    that the statement is there, not that it is true.
  - The rule applies to new work; code written before it is not rewritten under it.
  - `scripts/boundaries.mjs` also checks that every backend entry point links an existing page in
    `services/` with a `Service documentation: services/<page>.md` line.
  - The conformance tests in `src/conformance/` belong to the backend side. A backend that imitates
    recorded software keeps its conformance tests passing: fix a difference in the backend and its
    service page, or keep it, pin it in the test and explain it in the service page's "Recordings"
    section and the catalogue. Mask only values that change with every run, and name each mask.
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

## Verification and delivery

Follow [README.md](./README.md#running-the-suite) for setup, commands, lane selection, reports, and
coverage limits. Keep every library import at the package root except in `*.packed.test.ts` files,
which may use subpaths. Keep `tsconfig.packed.json`'s aliases equal to `tsconfig.json`'s without the
library's; `npm run check` enforces it.

Give the app no alias for the library, and change `src/app` only as an application would use the
library. Its build must resolve the installed package's `dist/`, as the README describes.

Use a task branch from `hostile-servers-test` and deliver a pull request targeting it. Follow the
library's public [contribution guide](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#pull-requests)
for review and PR evidence, and its [label rules](https://github.com/viell-dev/slop-effect-schema-http/blob/main/CONTRIBUTING.md#issues-and-labels).
