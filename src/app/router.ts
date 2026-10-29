/**
 * The app's history-API router. Each view lives in a Scope of its own, from the navigation that
 * mounts it to the next one: navigating away closes the scope, which releases whatever the view
 * acquired, such as an interaction and the request it has in flight.
 *
 * A click on a link to the app's own origin and the browser's back and forward buttons navigate
 * within the page. A reload, or a link elsewhere, loads a new page, which starts from nothing.
 */
import { Effect, Queue, type Scope } from "effect";
import type { HttpClient } from "effect/http";

export interface View {
  readonly title: string;
  /**
   * Render into the empty outlet for `url`, acquiring what the view needs in the view's scope.
   * Event handlers may keep running work in that scope until it closes.
   */
  readonly mount: (
    outlet: HTMLElement,
    url: URL,
  ) => Effect.Effect<void, never, Scope.Scope | HttpClient.HttpClient>;
}

/** Turn clicks on in-app links, and history traversal, into navigations. */
const listen = (navigations: Queue.Queue<URL>): void => {
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (link === null || link.target !== "" || link.hasAttribute("download"))
      return;
    const url = new URL(link.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    if (url.href === location.href) return;
    history.pushState(null, "", url);
    Queue.offerUnsafe(navigations, url);
  });
  window.addEventListener("popstate", () => {
    Queue.offerUnsafe(navigations, new URL(location.href));
  });
};

/** Mount the view for `url` in a scope of its own; close it when the next navigation arrives. */
const mountUntilNext = (
  view: View,
  url: URL,
  outlet: HTMLElement,
  navigations: Queue.Queue<URL>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      document.title = `${view.title} · Tasks`;
      outlet.replaceChildren();
      yield* view.mount(outlet, url);
      return yield* Queue.take(navigations);
    }),
  );

/** Run the router for the life of the page. */
export const run = (
  route: (url: URL) => View,
  outlet: HTMLElement,
): Effect.Effect<never, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const navigations = yield* Queue.unbounded<URL>();
    listen(navigations);
    let url = new URL(location.href);
    for (;;) url = yield* mountUntilNext(route(url), url, outlet, navigations);
  });
