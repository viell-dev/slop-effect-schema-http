// Node drives the production bundle in Chromium. The same consumer cases run in the source
// and packed lanes; the app sends them through its own origin's proxy.
import { afterAll, beforeAll, inject, it } from "@effect/vitest";
import { Effect } from "effect";
import { chromium, type Browser } from "playwright";
import { lane } from "#lane";
import { wireCases } from "../clients/post-release-wire.js";
import { assertWireCase } from "./post-release-wire-assertions.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

for (const [id, rows] of Object.entries(wireCases)) {
  for (const [index, row] of rows.entries()) {
    it.live(`[EXT-56] [EXT-${id}] ${row.name}`, () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const page = yield* Effect.acquireRelease(
          Effect.promise(() => browser.newPage()),
          (opened) => Effect.promise(() => opened.close()),
        );
        const url = new URL("/wire.html", inject("app"));
        url.searchParams.set("api", backend.origin);
        url.searchParams.set("group", id);
        url.searchParams.set("case", String(index));
        const result = yield* Effect.promise(async () => {
          await page.goto(url.href);
          await page.waitForFunction(
            () => Boolean(document.querySelector("#result")?.textContent),
            undefined,
            { timeout: 4_000 },
          );
          const text = await page.locator("#result").textContent();
          return JSON.parse(text ?? "") as {
            tag: string;
            message?: string;
            cause?: string;
          };
        });
        assertWireCase(row.expected, result, yield* backend.ledger);
      }),
    );
  }
}
