/**
 * Paths: what the library composes, and what Warded's `exact_path` and `path` conditions see of it.
 *
 * The library joins path text exactly and escapes each path value with `encodeURIComponent`. Warded
 * compares the path the HTTP stack delivered, byte for byte, and captures raw text. So every value
 * the library puts in one template slot should arrive as one capture whose decoding is the value,
 * whatever the value holds, unless a client's URL parser changes the path on the way.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
import { cases, serve } from "../harness/matrix.js";
import { and, exactPath, get, path, post, route } from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";

const table = {
  routes: [
    route("orders", and(get(), exactPath("/orders"))),
    route("orders-slash", and(get(), exactPath("/orders/"))),
    route("user", and(get(), path("/users/{id}"))),
    route("post", and(get(), path("/users/{id}/posts/{post}"))),
    route("image", and(get(), path("/media/{name}.png"))),
    route("file", and(get(), path("/files/{*rest}"))),
    route("archive", and(post(), path("/things/{id}:archive"))),
    route("double-slash", and(get(), exactPath("/a//b"))),
    route("b", and(get(), exactPath("/b"))),
    route("admin", and(get(), exactPath("/admin"))),
    route("prefixed", and(get(), exactPath("/api/v1/users"))),
    route("braces", and(get(), path("/templates/{{name}}"))),
    route("encoded-braces", and(get(), exactPath("/templates/%7Bname%7D"))),
  ],
};

const id = Request.pathValue("id", Schema.String);
const getUser = operation(Request.get("").pipe(Request.path`/users/${id}`));

/**
 * One value for every printable ASCII character, and some longer ones: each should be one capture.
 * `.` and `..` are left out here, because a URL parser resolves them as dot segments; the dot
 * segment tests below cover them.
 */
const values = [
  ...Array.from({ length: 0x7f - 0x20 }, (_, index) =>
    String.fromCharCode(0x20 + index),
  ).filter((character) => character !== "."),
  "42",
  "a b/c",
  "café",
  "日本語",
  "😀",
  "%41",
  "%",
  "a%2Fb",
  "?x=1#y",
  "...",
  "a.b",
  "-1",
  "\t",
  "\u0000",
  "\u007f",
];

describe("paths", () => {
  for (const { client, listener, title } of cases()) {
    it.live(
      `${title}: each path value is one capture, and decodes to the value`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const failures: Array<string> = [];
          for (const value of values) {
            const sent = yield* send(routes, listener, client, getUser, {
              path: { id: value },
            });
            const exchange = only(sent);
            const expected = encodeURIComponent(value);
            if (
              sent.outcome.kind !== "routed" ||
              sent.outcome.route !== "user" ||
              sent.outcome.captures["id"] !== expected ||
              exchange.seen.path !== `/users/${expected}` ||
              JSON.stringify(exchange.dispatched?.params) !==
                JSON.stringify({ Ok: { id: value } })
            )
              failures.push(
                `${JSON.stringify(value)}: ${JSON.stringify({ outcome: sent.outcome, path: exchange.seen.path, params: exchange.dispatched?.params })}`,
              );
          }
          expect(failures).toEqual([]);
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: exact paths keep their trailing slash, case and repeated slashes`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const at = (text: string) =>
            send(
              routes,
              listener,
              client,
              operation(Request.get(text)),
              undefined,
            );
          expect((yield* at("/orders")).outcome).toMatchObject({
            route: "orders",
          });
          expect((yield* at("/orders/")).outcome).toMatchObject({
            route: "orders-slash",
          });
          expect((yield* at("/Orders")).outcome).toMatchObject({
            kind: "answered",
            status: 404,
          });
          expect((yield* at("/a//b")).outcome).toMatchObject({
            route: "double-slash",
          });
          // A percent escape in written path text stays an escape: `/%61dmin` is not `/admin`.
          const escaped = yield* at("/%61dmin");
          expect(escaped.outcome).toMatchObject({
            kind: "answered",
            status: 404,
          });
          expect(only(escaped).seen.path).toBe("/%61dmin");
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: a URL parser resolves dot segments before Warded sees the path`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const dotted = yield* send(
            routes,
            listener,
            client,
            operation(Request.get("/a/../b")),
            undefined,
          );
          expect(only(dotted).seen.path).toBe("/b");
          expect(dotted.outcome).toMatchObject({ route: "b" });
          // The same happens to a path value: `..` has nothing to encode.
          const up = yield* send(routes, listener, client, getUser, {
            path: { id: ".." },
          });
          expect(only(up).seen.path).toBe("/");
          const here = yield* send(routes, listener, client, getUser, {
            path: { id: "." },
          });
          expect(only(here).seen.path).toBe("/users/");
          expect(here.outcome).toMatchObject({ kind: "answered", status: 404 });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: templates, renderers and base prefixes reach the patterns they mirror`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const postId = Request.pathValue("post", Schema.FiniteFromString);
          const getPost = operation(
            Request.get("").pipe(
              Request.path`/users/${id}`,
              Request.path`/posts/${postId}`,
            ),
          );
          expect(
            (yield* send(routes, listener, client, getPost, {
              path: { id: "ada", post: 7 },
            })).outcome,
          ).toEqual({
            kind: "routed",
            route: "post",
            captures: { id: "ada", post: "7" },
          });

          const name = Request.pathValue("name", Schema.String);
          const image = operation(
            Request.get("").pipe(Request.path`/media/${name}.png`),
          );
          expect(
            (yield* send(routes, listener, client, image, {
              path: { name: "logo v2" },
            })).outcome,
          ).toEqual({
            kind: "routed",
            route: "image",
            captures: { name: "logo%20v2" },
          });

          // A renderer for a value with several segments, against a catch-all.
          const folder = Request.path(
            Schema.Array(Schema.String),
            (segments, encode) =>
              segments.map((segment) => `/${encode(segment)}`).join(""),
          );
          const file = operation(Request.get("/files").pipe(folder));
          const sent = yield* send(routes, listener, client, file, {
            path: ["css", "site map.css"],
          });
          expect(sent.outcome).toEqual({
            kind: "routed",
            route: "file",
            captures: { rest: "css/site%20map.css" },
          });
          expect(only(sent).dispatched?.params).toEqual({
            Ok: { rest: "css/site map.css" },
          });

          // A custom verb after a value, as in `/things/42:archive`.
          const archive = operation(
            Request.post("").pipe(Request.path`/things/${id}:archive`),
          );
          expect(
            (yield* send(routes, listener, client, archive, {
              path: { id: "42" },
            })).outcome,
          ).toEqual({
            kind: "routed",
            route: "archive",
            captures: { id: "42" },
          });

          // A relative base with a prefix, joined to the path with one slash.
          const users = operation(
            Request.get("/users").pipe(Request.baseUrl("/api/v1/")),
          );
          const prefixed = yield* send(
            routes,
            listener,
            client,
            users,
            undefined,
          );
          expect(only(prefixed).seen.path).toBe("/api/v1/users");
          expect(prefixed.outcome).toMatchObject({ route: "prefixed" });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: braces in a written path are percent-encoded on the way`,
      () =>
        Effect.gen(function* () {
          // `{{name}}` in a pattern is the literal text `{name}`, and the library passes `{name}` on
          // as written. The URL parser in front of every one of these clients encodes `{` and `}`,
          // so the literal route is never reached; its percent-encoded twin is. Warded's guide does
          // not say so yet: https://github.com/viell-dev/slop-warded-router/issues/44.
          const routes = yield* serve(table);
          const sent = yield* send(
            routes,
            listener,
            client,
            operation(Request.get("/templates/{name}")),
            undefined,
          );
          expect(only(sent).seen.path).toBe("/templates/%7Bname%7D");
          expect(sent.outcome).toMatchObject({ route: "encoded-braces" });
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: an empty path value leaves an empty segment, which no parameter matches`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          const sent = yield* send(routes, listener, client, getUser, {
            path: { id: "" },
          });
          expect(only(sent).seen.path).toBe("/users/");
          expect(sent.outcome).toMatchObject({ kind: "answered", status: 404 });
        }).pipe(Effect.scoped),
    );
  }
});
