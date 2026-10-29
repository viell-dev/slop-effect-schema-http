/**
 * EXT-7: a small single-page app over the business API's task search, built by Vite in production
 * mode against the packed library and served as static files by a server that also hosts the
 * same-origin proxy, as a deployed app reaches an API without CORS through its own server.
 *
 * The API's origin is read from the `api` query parameter of the URL the page was loaded from,
 * because the suite starts each backend on an ephemeral port. Every in-app link carries it on.
 * The page calls only its own origin; `proxyBase` turns the API's origin into the proxy's path.
 */
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { proxyBase } from "../clients/browser/proxy.js";
import type * as Ops from "../clients/business/operations.js";
import { about, element, home, misconfigured, notFound } from "./pages.js";
import * as Router from "./router.js";
import { searchPage } from "./search.js";

/**
 * The business API's bearer token. The app ships the service's documented default, as a deployed
 * app ships a public client key in its bundle; the tests start the service with that default.
 */
const TOKEN = "ops-token-2016";

/** The API's origin from the `api` parameter, if it is an `http:` origin. */
const apiOrigin = (url: URL): string | undefined => {
  const value = url.searchParams.get("api");
  if (value === null || !URL.canParse(value)) return undefined;
  const parsed = new URL(value);
  return parsed.protocol === "http:" && value === parsed.origin
    ? parsed.origin
    : undefined;
};

const api = apiOrigin(new URL(location.href));

/** An in-app link that keeps the API's origin. */
const link = (path: string): string => {
  const url = new URL(path, location.origin);
  if (api !== undefined) url.searchParams.set("api", api);
  return `${url.pathname}${url.search}`;
};

const nav = document.querySelector("nav");
const outlet = document.querySelector("main");
if (nav === null || outlet === null)
  throw new Error("index.html lacks its nav or main element");

const sections = [
  ["/", "Home"],
  ["/search", "Search"],
  ["/about", "About"],
] as const;
nav.append(
  ...sections.flatMap(([path, name]) => [
    element("a", { href: link(path) }, name),
    " ",
  ]),
);

const route = (url: URL): Router.View => {
  if (api === undefined) return misconfigured;
  const connection: Ops.Connection = {
    baseUrl: `${proxyBase(api)}/v2`,
    credential: () => TOKEN,
  };
  switch (url.pathname) {
    case "/":
      return home(link);
    case "/search":
      return searchPage(connection);
    case "/about":
      return about;
    default:
      return notFound;
  }
};

Effect.runFork(
  Router.run(route, outlet).pipe(Effect.provide(FetchHttpClient.layer)),
);
