/**
 * The search page: the task search box of APP-1 (`Search.searchBox`), one `Interaction` acquired
 * when the page mounts and closed when the user navigates away.
 *
 * - Each submitted search runs through the interaction, so a new search supersedes the one in
 *   flight: the earlier request is aborted, and its caller ends interrupted without rendering.
 * - The page shows only what the latest search returned. Unmounting interrupts the waiting
 *   callers first, then closes the interaction, which aborts its request.
 * - A `q` parameter in the page's URL is the first search, as a link into the app gives it.
 *   Searches typed afterwards are not written back to the URL.
 */
import { Cause, Effect, FiberSet } from "effect";
import type * as Ops from "../clients/business/operations.js";
import * as Search from "../clients/flows/search.js";
import { element } from "./pages.js";
import type { View } from "./router.js";

const IDLE = "Enter a search.";

export const searchPage = (connection: Ops.Connection): View => ({
  title: "Search",
  mount: (outlet, url) =>
    Effect.gen(function* () {
      const box = yield* Search.searchBox(connection);
      // Acquired after the box, so it closes first: callers stop before their work is aborted.
      const fork = yield* FiberSet.makeRuntime<never>();

      const input = element("input", {
        type: "search",
        name: "q",
        "aria-label": "Search tasks",
      });
      const form = element(
        "form",
        { role: "search" },
        input,
        element("button", { type: "submit" }, "Search"),
      );
      const status = element("p", { role: "status" }, IDLE);
      const results = element("ul", { "aria-label": "Results" });
      outlet.append(element("h1", {}, "Search"), form, status, results);

      const show = (outcome: Search.Outcome): void => {
        switch (outcome._tag) {
          case "Cleared":
            status.textContent = IDLE;
            results.replaceChildren();
            return;
          case "Results": {
            const { query, hits } = outcome.value;
            results.replaceChildren(
              ...hits.map((hit) => element("li", {}, hit.title)),
            );
            status.textContent = `${hits.length} ${hits.length === 1 ? "result" : "results"} for “${query}”`;
            return;
          }
          default:
            status.textContent = `The service refused the search (${outcome._tag}).`;
            results.replaceChildren();
        }
      };

      const search = (text: string): void => {
        status.textContent =
          text.trim() === "" ? IDLE : `Searching for “${text}”…`;
        results.replaceChildren();
        fork(
          box.run(text).pipe(
            Effect.matchCause({
              onSuccess: show,
              onFailure: (cause) => {
                // Superseded by a newer search, or unmounted: the newer state owns the page.
                if (Cause.hasInterruptsOnly(cause)) return;
                status.textContent = "The search failed.";
                console.error(Cause.pretty(cause));
              },
            }),
          ),
        );
      };

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        search(input.value);
      });
      const initial = url.searchParams.get("q");
      if (initial !== null && initial.trim() !== "") {
        input.value = initial;
        search(initial);
      }
    }),
});
