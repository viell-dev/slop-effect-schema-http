/**
 * Methods: the library's method helpers and `Request.make` against Warded's method conditions.
 *
 * Warded compares the method exactly, case included, and `get()` does not match HEAD. The library
 * passes any method string to the client. Fetch uppercases the six methods the Fetch standard
 * normalizes (DELETE, GET, HEAD, OPTIONS, POST, PUT) and passes the rest as given; other clients
 * make their own choices, which the tests pin per provider.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { bodyText } from "../harness/evidence.js";
import { cases, serve } from "../harness/matrix.js";
import {
  and,
  del,
  exactPath,
  get,
  head,
  method,
  options,
  patch,
  post,
  put,
  query,
  route,
  trace,
} from "../harness/routes.js";
import { only, send } from "../harness/send.js";

const at = exactPath("/m");
const table = {
  routes: [
    route("get", and(get(), at)),
    route("head", and(head(), at)),
    route("post", and(post(), at)),
    route("put", and(put(), at)),
    route("patch", and(patch(), at)),
    route("delete", and(del(), at)),
    route("options", and(options(), at)),
    route("query", and(query(), at)),
    route("trace", and(trace(), at)),
    route("propfind", and(method("PROPFIND"), at)),
    route("lowercase-purge", and(method("purge"), at)),
    route("any-other", at),
  ],
};

/** The route a request reached, read from the exchange: a HEAD response has no body to decode. */
const routeOf = (request: Request.Request<unknown>) =>
  Operation.make(
    request,
    Response.when(() => true, Body.empty),
  );

/**
 * What each provider sends for a method name written in lowercase. Effect's Fetch client and Node's
 * `fetch` normalize only the Fetch standard's six; `node:http`, which the node-http and lines
 * providers use, uppercases every method; undici's `request` sends what it is given.
 */
const sentAs = (provider: string, written: string): string => {
  const normalized = ["delete", "get", "head", "options", "post", "put"];
  if (provider === "node-http" || provider === "lines")
    return written.toUpperCase();
  if (provider === "fetch" && normalized.includes(written))
    return written.toUpperCase();
  return written;
};

const methodRoutes: Record<string, string> = {
  GET: "get",
  HEAD: "head",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  OPTIONS: "options",
  QUERY: "query",
  PROPFIND: "propfind",
  purge: "lowercase-purge",
};

describe("methods", () => {
  for (const { client, listener, title } of cases()) {
    it.live(`${title}: each method helper reaches its method's route`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const reached = (request: Request.Request<unknown>) =>
          send(routes, listener, client, routeOf(request), undefined).pipe(
            Effect.map((sent) => only(sent).dispatched?.route),
          );
        expect(yield* reached(Request.get("/m"))).toBe("get");
        // GET alone does not include HEAD.
        expect(yield* reached(Request.head("/m"))).toBe("head");
        expect(yield* reached(Request.post("/m"))).toBe("post");
        expect(yield* reached(Request.put("/m"))).toBe("put");
        expect(yield* reached(Request.patch("/m"))).toBe("patch");
        expect(yield* reached(Request.del("/m"))).toBe("delete");
        expect(yield* reached(Request.options("/m"))).toBe("options");
        expect(yield* reached(Request.make("QUERY", "/m"))).toBe("query");
        expect(yield* reached(Request.make("PROPFIND", "/m"))).toBe("propfind");
      }).pipe(Effect.scoped),
    );

    it.live(`${title}: a method's case is what the client sends`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const seen: Record<string, string | undefined> = {};
        const reached: Record<string, string | undefined> = {};
        const expected: Record<string, string> = {};
        const expectedRoute: Record<string, string> = {};
        for (const written of ["get", "patch", "propfind", "purge", "query"]) {
          const sent = yield* send(
            routes,
            listener,
            client,
            routeOf(Request.make(written, "/m")),
            undefined,
          );
          const exchange = only(sent);
          seen[written] = exchange.seen.method;
          reached[written] = exchange.dispatched?.route;
          expected[written] = sentAs(client.name, written);
          expectedRoute[written] =
            methodRoutes[sentAs(client.name, written)] ?? "any-other";
        }
        expect(seen).toEqual(expected);
        expect(reached).toEqual(expectedRoute);
      }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a body never takes part in selection, and reaches the route whole`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const search = Operation.make(
            Request.make("QUERY", "/m").pipe(Request.body(Body.text)),
            Response.when(() => true, Body.text),
          );
          const sent = yield* send(routes, listener, client, search, {
            body: "select * where name = 'Ada'",
          });
          const exchange = only(sent);
          expect(exchange.dispatched?.route).toBe("query");
          expect(bodyText(exchange.dispatched)).toBe(
            "select * where name = 'Ada'",
          );
        }).pipe(Effect.scoped),
    );

    it.live(`${title}: TRACE and a body on GET`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const tracing = yield* send(
          routes,
          listener,
          client,
          routeOf(Request.make("TRACE", "/m")),
          undefined,
        );
        const withBody = yield* send(
          routes,
          listener,
          client,
          Operation.make(
            Request.get("/m").pipe(Request.body(Body.text)),
            Response.when(() => true, Body.text),
          ),
          { body: "in a GET" },
        );
        if (client.name === "fetch") {
          // Fetch refuses both before sending anything.
          expect(tracing.exchanges).toEqual([]);
          expect(tracing.outcome).toMatchObject({ kind: "failure" });
          expect(withBody.exchanges).toEqual([]);
          expect(withBody.outcome).toMatchObject({ kind: "failure" });
        } else {
          expect(only(tracing).dispatched?.route).toBe("trace");
          expect(only(withBody).dispatched?.route).toBe("get");
          expect(bodyText(only(withBody).dispatched)).toBe("in a GET");
        }
      }).pipe(Effect.scoped),
    );
  }
});
