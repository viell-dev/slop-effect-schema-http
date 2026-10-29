/** The app's static pages, and the one DOM helper every view uses. */
import { Effect } from "effect";
import type { View } from "./router.js";

/** An element with attributes and children. */
export const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
  ...children: ReadonlyArray<Node | string>
): HTMLElementTagNameMap[K] => {
  const created = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    created.setAttribute(name, value);
  created.append(...children);
  return created;
};

const page = (
  title: string,
  ...content: ReadonlyArray<() => Node | string>
): View => ({
  title,
  mount: (outlet) =>
    Effect.sync(() =>
      outlet.append(
        element("h1", {}, title),
        ...content.map((render) => render()),
      ),
    ),
});

export const home = (link: (path: string) => string): View =>
  page("Tasks", () =>
    element(
      "p",
      {},
      "Find the team's tasks on the ",
      element("a", { href: link("/search") }, "search page"),
      ".",
    ),
  );

export const about = page("About", () =>
  element(
    "p",
    {},
    "This app searches the business API's tasks through its own server's proxy.",
  ),
);

export const notFound = page("Not found", () =>
  element("p", {}, "No page has this address."),
);

/** Shown for every route when the page's URL does not say where the API is. */
export const misconfigured = page("Not configured", () =>
  element(
    "p",
    {},
    "Open this app with the business API's origin in the api query parameter, such as ?api=http://127.0.0.1:8080.",
  ),
);
