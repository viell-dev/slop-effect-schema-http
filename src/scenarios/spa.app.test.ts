// The single-page app in `src/app` (EXT-7), built and driven as a user meets it. This file runs only
// in the app project (`npm run app:test`), whose global setup builds the app with Vite in
// production mode against the packed library and serves the build with the same-origin proxy. It
// needs Node to drive Chromium through Playwright, and starts the backends with the Node lane; the
// page reaches them only through the proxy on its own origin.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  inject,
  it,
} from "@effect/vitest";
import { Effect } from "effect";
import { type Browser, chromium, type Page } from "playwright";
import { lane } from "#lane";
import * as Services from "../clients/flows/services.js";
import {
  type Backend,
  header,
  pathOf,
  type Recorded,
} from "../harness/lane.js";

/** The business API's token. The app ships the service's default; the test sets it explicitly. */
const TOKEN = "ops-token-2016";

/** Tasks for the search page: "ledger" finds two, "archive" one. */
const tasks = [
  {
    title: "Reconcile the October ledger",
    assigneeId: "u-ada",
    priority: 2,
    due: null,
    notes: null,
    done: false,
    created: 1_698_796_800_000,
  },
  {
    title: "Archive the ledger exports",
    assigneeId: "u-grace",
    priority: 4,
    due: null,
    notes: "Moved to cold storage",
    done: true,
    created: 1_696_118_400_000,
  },
  {
    title: "Renew the support contract",
    assigneeId: "u-alan",
    priority: 3,
    due: null,
    notes: null,
    done: false,
    created: 1_697_500_000_000,
  },
];

/** The business API with a search for "ledger" that is held until its client goes away. */
const business = () =>
  lane.backend("business", {
    operations: { token: TOKEN, tasks, searchLatency: { ledger: 5_000 } },
  });

const LEDGER = "/v2/search?q=ledger";
const ARCHIVE = "/v2/search?q=archive";

/** The page's address for a route, with the API's origin in the `api` parameter the app reads. */
const appUrl = (
  backend: Backend,
  path: string,
  query: Readonly<Record<string, string>> = {},
): string => {
  const url = new URL(path, inject("app"));
  url.searchParams.set("api", backend.origin);
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value);
  return url.href;
};

let browser: Browser | undefined;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

/**
 * Installed in every page before the app's own script: records each state of the search page's
 * status line and result list, in order, so a test sees everything a page showed, not only what it
 * shows at the end.
 */
const recordShown = () => {
  const shown: Array<string> = [];
  Object.assign(window, { shown });
  new MutationObserver(() => {
    const status = document.querySelector('[role="status"]');
    if (status === null) return;
    const items = Array.from(
      document.querySelectorAll('[aria-label="Results"] li'),
      (item) => item.textContent,
    );
    const state = [status.textContent, ...items].join(" | ");
    if (shown.at(-1) !== state) shown.push(state);
  }).observe(document, { subtree: true, childList: true, characterData: true });
};

/**
 * A fresh browser context and page for one test, closed with the test's scope. Uncaught errors and
 * console errors on the page are collected, and each test expects none.
 */
const openPage = Effect.acquireRelease(
  Effect.promise(async () => {
    if (browser === undefined) throw new Error("Chromium did not start");
    const context = await browser.newContext();
    // Every wait on the page is bounded, well inside the test's own timeout.
    context.setDefaultTimeout(5_000);
    await context.addInitScript(recordShown);
    const page = await context.newPage();
    const errors: Array<string> = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    return { context, page, errors };
  }),
  ({ context }) => Effect.promise(() => context.close()),
);

const step = <A>(action: () => Promise<A>) => Effect.promise(action);

/** Wait until the page's status line reads exactly `text`. */
const statusIs = (page: Page, text: string) =>
  step(() =>
    page.waitForFunction(
      (expected) =>
        document.querySelector('[role="status"]')?.textContent === expected,
      text,
    ),
  );

const results = (page: Page) =>
  step(() =>
    page
      .getByRole("list", { name: "Results" })
      .getByRole("listitem")
      .allTextContents(),
  );

const shown = (page: Page) =>
  step(() =>
    page.evaluate(() => (window as unknown as { shown: Array<string> }).shown),
  );

const searchFor = (page: Page, text: string) =>
  step(async () => {
    const box = page.getByRole("searchbox", { name: "Search tasks" });
    await box.fill(text);
    await box.press("Enter");
  });

/** Mark the current document, to tell later whether the page is still the same document. */
const mark = (page: Page) =>
  step(() =>
    page.evaluate(() => {
      Object.assign(window, { marked: true });
    }),
  );
const marked = (page: Page) =>
  step(() => page.evaluate(() => "marked" in window));

/** The service's own record of searches whose client went away, once it has noticed `count`. */
const abandoned = (backend: Backend, count: number) =>
  Services.abandoned({
    baseUrl: `${backend.origin}/v2`,
    credential: () => undefined,
  })
    .execute(count)
    .pipe(
      Effect.map((record) => record.abandoned),
      Effect.provide(lane.fetchClient),
    );

const searchesOf = (ledger: ReadonlyArray<Recorded>) =>
  ledger.filter((recorded) => pathOf(recorded) === "/v2/search");

/** Each search the service received, and whether its client closed it before the answer. */
const searches = (ledger: ReadonlyArray<Recorded>) =>
  searchesOf(ledger).map((recorded) => [recorded.target, recorded.aborted]);

describe("the built single-page app (EXT-7)", () => {
  it.live(
    "[EXT-7a] a route mounts the search, which starts its interaction; navigating away disposes it, and the service records the abort",
    () =>
      Effect.gen(function* () {
        const backend = yield* business();
        const { page, errors } = yield* openPage;
        yield* step(() =>
          page.goto(appUrl(backend, "/search", { q: "ledger" })),
        );
        // The page is the production build: one hashed module script from `assets/`.
        expect(
          yield* step(() =>
            page.locator('script[type="module"]').getAttribute("src"),
          ),
        ).toMatch(/^\/assets\/index-[\w-]+\.js$/);
        // The route mounted the search page, whose interaction sent the link's search.
        yield* backend.arrived(1);
        yield* statusIs(page, "Searching for “ledger”…");
        yield* mark(page);

        yield* step(() => page.getByRole("link", { name: "About" }).click());
        yield* step(() =>
          page.getByRole("heading", { name: "About" }).waitFor(),
        );
        expect(new URL(page.url()).pathname).toBe("/about");
        // Still the same document: the app navigated, so no page unload closed the request.
        expect(yield* marked(page)).toBe(true);
        expect(yield* abandoned(backend, 1)).toEqual([
          { route: "search", target: LEDGER },
        ]);
        expect(searches(yield* backend.ledger)).toEqual([[LEDGER, true]]);
        // The page called its own origin, and the proxy forwarded the call with the service's Host.
        const sent = searchesOf(yield* backend.ledger)[0]?.lines ?? [];
        expect(header(sent, "authorization")).toBe(`Bearer ${TOKEN}`);
        expect(header(sent, "sec-fetch-site")).toBe("same-origin");
        expect(header(sent, "host")).toBe(new URL(backend.origin).host);

        // Back mounts the search page again from its URL, with a new interaction; forward disposes
        // that one too. The record's own request is the second to arrive.
        yield* step(() => page.goBack());
        yield* backend.arrived(3);
        yield* statusIs(page, "Searching for “ledger”…");
        yield* step(() => page.goForward());
        yield* step(() =>
          page.getByRole("heading", { name: "About" }).waitFor(),
        );
        expect(yield* abandoned(backend, 2)).toEqual([
          { route: "search", target: LEDGER },
          { route: "search", target: LEDGER },
        ]);
        expect(searches(yield* backend.ledger)).toEqual([
          [LEDGER, true],
          [LEDGER, true],
        ]);
        expect(yield* marked(page)).toBe(true);
        expect(errors).toEqual([]);
      }),
  );

  it.live(
    "[EXT-7b] a second search while the first is in flight aborts the first on the wire, and only the second result is shown",
    () =>
      Effect.gen(function* () {
        const backend = yield* business();
        const { page, errors } = yield* openPage;
        yield* step(() => page.goto(appUrl(backend, "/search")));
        yield* statusIs(page, "Enter a search.");
        yield* searchFor(page, "ledger");
        yield* backend.arrived(1);
        yield* searchFor(page, "archive");
        yield* statusIs(page, "1 result for “archive”");
        expect(yield* results(page)).toEqual(["Archive the ledger exports"]);
        expect(yield* abandoned(backend, 1)).toEqual([
          { route: "search", target: LEDGER },
        ]);
        expect(searches(yield* backend.ledger)).toEqual([
          [LEDGER, true],
          [ARCHIVE, false],
        ]);
        // Everything the page showed, in order: the superseded search never rendered a result.
        expect(yield* shown(page)).toEqual([
          "Enter a search.",
          "Searching for “ledger”…",
          "Searching for “archive”…",
          "1 result for “archive” | Archive the ledger exports",
        ]);
        expect(errors).toEqual([]);
      }),
  );

  it.live(
    "[EXT-7c] a reload starts clean: the earlier page's search in flight is closed, and the new page asks again for its own",
    () =>
      Effect.gen(function* () {
        const backend = yield* business();
        const { page, errors } = yield* openPage;
        yield* step(() =>
          page.goto(appUrl(backend, "/search", { q: "archive" })),
        );
        yield* statusIs(page, "1 result for “archive”");
        yield* searchFor(page, "ledger");
        yield* backend.arrived(2);
        yield* mark(page);

        yield* step(() => page.reload());
        yield* statusIs(page, "1 result for “archive”");
        // A new document, which showed nothing of the earlier one's.
        expect(yield* marked(page)).toBe(false);
        expect(yield* shown(page)).toEqual([
          "Searching for “archive”…",
          "1 result for “archive” | Archive the ledger exports",
        ]);
        // The earlier page's search did not outlive it: the browser closed it as the page unloaded.
        expect(yield* abandoned(backend, 1)).toEqual([
          { route: "search", target: LEDGER },
        ]);
        // The new page sent the search the earlier one had retained a result for, and nothing else.
        expect(searches(yield* backend.ledger)).toEqual([
          [ARCHIVE, false],
          [LEDGER, true],
          [ARCHIVE, false],
        ]);
        expect(errors).toEqual([]);
      }),
  );
});
