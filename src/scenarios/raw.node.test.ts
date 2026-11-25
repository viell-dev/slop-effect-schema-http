/**
 * Requests that only the raw provider sends: the library's composed URL written to a socket as it
 * is, with no URL parser in between. Node-only, because it opens its own sockets.
 *
 * The library promises to pass these on, and Warded promises to match what the HTTP stack
 * delivers. Between them is the server's HTTP parser, which may refuse or reshape a request; where
 * it does, the test says so.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { lane } from "#lane";
import { serve } from "../harness/matrix.js";
import {
  and,
  connect,
  exactPath,
  get,
  host,
  method,
  options,
  path,
  route,
  version,
} from "../harness/routes.js";
import { collect, only, operation, send } from "../harness/send.js";

const raw = lane.raw!;

const table = {
  routes: [
    route("dots", exactPath("/a/../b")),
    route("b", exactPath("/b")),
    route("user", path("/users/{id}")),
    route("braces", path("/templates/{{name}}")),
    route("asterisk", and(options(), exactPath("*"))),
    route("vhost", and(exactPath("/vhost"), host("localhost"))),
    route("http/1.0", and(exactPath("/v"), version("HTTP/1.0"))),
    route("http/1.1", and(exactPath("/v"), version("HTTP/1.1"))),
    route("lowercase-get", and(exactPath("/m"), method("get"))),
    route("get", and(exactPath("/m"), get())),
    route("fragment", exactPath("/frag")),
    route("utf-8", exactPath("/café")),
    route("connect", connect()),
  ],
};

const id = Request.pathValue("id", Schema.String);

describe("raw requests", () => {
  for (const listener of ["plain", "http"] as const) {
    const via = (routes: {
      readonly origins: Record<typeof listener, string>;
    }) => raw(routes.origins[listener]);

    it.live(
      `${listener}: dot segments and braces reach the router as written`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const dotted = yield* send(
            routes,
            listener,
            via(routes),
            operation(Request.get("/a/../b")),
            undefined,
          );
          expect(only(dotted).seen.path).toBe("/a/../b");
          expect(dotted.outcome).toMatchObject({ route: "dots" });
          // A path value of `..` is one capture, which the server's Params extractor decodes as `..`.
          const getUser = operation(
            Request.get("").pipe(Request.path`/users/${id}`),
          );
          const up = yield* send(routes, listener, via(routes), getUser, {
            path: { id: ".." },
          });
          expect(up.outcome).toMatchObject({
            route: "user",
            captures: { id: ".." },
          });
          expect(only(up).dispatched?.params).toEqual({ Ok: { id: ".." } });
          const braces = yield* send(
            routes,
            listener,
            via(routes),
            operation(Request.get("/templates/{name}")),
            undefined,
          );
          expect(braces.outcome).toMatchObject({ route: "braces" });
        }).pipe(Effect.scoped),
    );

    it.live(`${listener}: an asterisk and an absolute-form target`, () =>
      Effect.gen(function* () {
        const routes = yield* serve(table);
        const layer = via(routes);
        const asterisk = yield* collect(
          routes,
          Operation.make(
            Request.make("OPTIONS", "*"),
            Response.when(() => true, Body.text),
          )
            .execute(undefined)
            .pipe(Effect.provide(layer)),
        );
        expect(asterisk.wire.map((request) => request.target)).toEqual(["*"]);
        expect(only(asterisk).seen.path).toBe("*");
        expect(only(asterisk).dispatched?.route).toBe("asterisk");

        // An absolute-form target names another host than the Host field, and the URI wins.
        const port = new URL(routes.origins[listener]).port;
        const absolute = yield* collect(
          routes,
          operation(Request.get(`http://localhost:${port}/vhost`))
            .execute(undefined)
            .pipe(Effect.provide(layer)),
        );
        expect(absolute.wire.map((request) => request.target)).toEqual([
          `http://localhost:${port}/vhost`,
        ]);
        expect(absolute.outcome).toMatchObject({ route: "vhost" });
      }).pipe(Effect.scoped),
    );

    it.live(
      `${listener}: the protocol and the method's case are the route's to read`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const at = (protocol: string) =>
            send(
              routes,
              listener,
              raw(routes.origins[listener], { protocol }),
              operation(Request.get("/v")),
              undefined,
            );
          expect((yield* at("HTTP/1.0")).outcome).toMatchObject({
            route: "http/1.0",
          });
          expect((yield* at("HTTP/1.1")).outcome).toMatchObject({
            route: "http/1.1",
          });
          const lowercase = yield* send(
            routes,
            listener,
            via(routes),
            operation(Request.make("get", "/m")),
            undefined,
          );
          expect(lowercase.wire.map((request) => request.method)).toEqual([
            "get",
          ]);
          expect(lowercase.outcome).toMatchObject({ route: "lowercase-get" });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${listener}: what the server's HTTP parser does with a fragment, UTF-8 and CONNECT`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          // The parser keeps the path and drops the fragment, so no route can see it.
          const fragment = yield* send(
            routes,
            listener,
            via(routes),
            operation(Request.get("/frag#section")),
            undefined,
          );
          expect(fragment.wire.map((request) => request.target)).toEqual([
            "/frag#section",
          ]);
          expect(only(fragment).seen.uri).toBe("/frag");
          expect(fragment.outcome).toMatchObject({ route: "fragment" });

          // Raw UTF-8 in the target is text to the router, which `exact_path` compares as written.
          const utf8 = yield* send(
            routes,
            listener,
            via(routes),
            operation(Request.get("/café")),
            undefined,
          );
          expect(utf8.wire.map((request) => request.target)).toEqual([
            "/caf\u00c3\u00a9",
          ]);
          expect(utf8.outcome).toMatchObject({ route: "utf-8" });

          // An authority-form CONNECT has no path, and `connect()` alone matches it.
          const tunnel = yield* collect(
            routes,
            Operation.make(
              Request.make("CONNECT", "localhost:443"),
              Response.when(() => true, Body.text),
            )
              .execute(undefined)
              .pipe(Effect.provide(via(routes))),
          );
          expect(tunnel.wire.map((request) => request.target)).toEqual([
            "localhost:443",
          ]);
          expect(only(tunnel).seen).toMatchObject({
            uri: "localhost:443",
            path: "",
          });
          expect(only(tunnel).dispatched?.route).toBe("connect");

          // A space ends the target, and the parser refuses the request before any route runs.
          const space = yield* send(
            routes,
            listener,
            via(routes),
            operation(Request.get("/a b")),
            undefined,
          );
          expect(space.wire.map((request) => request.target)).toEqual(["/a b"]);
          expect(space.exchanges).toEqual([]);
          expect(space.outcome).toMatchObject({
            kind: "answered",
            status: 400,
          });
        }).pipe(Effect.scoped),
    );
  }
});
