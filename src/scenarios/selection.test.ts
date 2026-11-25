/**
 * Selection: definitions and their variants on the client side against ordered routes on the
 * server side.
 *
 * Both projects work the same way: a definition is a reusable value that a caller adjusts without
 * changing it, and a route table is an ordered list whose first complete match wins. So each
 * adjustment a variant makes should move the request to the route that declares it, the original
 * should stay where it was, and a route that fails on any one condition should let the next one
 * try. A condition that cannot be evaluated is different: it stops selection.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Operation, Request } from "viell-effect-schema-http";
import { cases, serve } from "../harness/matrix.js";
import {
  and,
  exactPath,
  filter,
  get,
  headerEq,
  not,
  or,
  paramPair,
  paramPresent,
  path,
  route,
  secured,
} from "../harness/routes.js";
import { only, operation, send } from "../harness/send.js";
import type { Table } from "../harness/table.js";

const things = exactPath("/things");
const table = {
  routes: [
    route("export", and(get(), things, paramPair("format", "csv"))),
    route("french", and(get(), things, headerEq("accept-language", "fr"))),
    // Declared before the literal route below, so it takes `/things/archive` too.
    route("by-id", and(get(), filter(path("/things/{id}"), "id", "number"))),
    route(
      "by-name",
      and(get(), filter(path("/things/{id}"), "id", "username")),
    ),
    route("archive", and(get(), exactPath("/things/archive"))),
    route("not-draft", and(get(), things, not(paramPresent("draft")))),
    route("list", and(get(), things)),
  ],
  fallback: { name: "fallback" },
};

const listThings = operation(Request.get("/things"));
const id = Request.pathValue("id", Schema.String);
const getThing = operation(Request.get("").pipe(Request.path`/things/${id}`));

describe("selection", () => {
  for (const { client, listener, title } of cases()) {
    const reach = <I, A, E, R>(
      routes: Table,
      definition: Operation.Operation<I, A, E, R>,
      input: I,
    ) =>
      send(routes, listener, client, definition, input).pipe(
        Effect.map((sent) => only(sent).dispatched?.route),
      );

    it.live(
      `${title}: each variant reaches the route that declares its change`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          expect(yield* reach(routes, listThings, undefined)).toBe("not-draft");
          const exported = listThings.pipe(
            Operation.mapRequest(Request.setQuery("format", "csv")),
          );
          expect(yield* reach(routes, exported, undefined)).toBe("export");
          const french = listThings.pipe(
            Operation.mapRequest(Request.setHeader("accept-language", "fr")),
          );
          expect(yield* reach(routes, french, undefined)).toBe("french");
          const drafts = listThings.pipe(
            Operation.mapRequest(Request.setQuery("draft", null)),
          );
          expect(yield* reach(routes, drafts, undefined)).toBe("list");
          // A variant of a variant, and then removing what the first one added.
          const back = exported.pipe(
            Operation.mapRequest(Request.removeQuery("format")),
          );
          expect(yield* reach(routes, back, undefined)).toBe("not-draft");
          // None of that changed the original.
          expect(yield* reach(routes, listThings, undefined)).toBe("not-draft");
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: refined captures fall through, and order decides overlaps`,
      () =>
        Effect.gen(function* () {
          const routes = yield* serve(table);
          expect(yield* reach(routes, getThing, { path: { id: "42" } })).toBe(
            "by-id",
          );
          expect(
            yield* reach(routes, getThing, { path: { id: "alice_7" } }),
          ).toBe("by-name");
          // `archive` is a username, so the earlier pattern route wins over the literal one.
          expect(
            yield* reach(routes, getThing, { path: { id: "archive" } }),
          ).toBe("by-name");
          // Neither refinement holds, and no route matches: the fallback runs, with no selection.
          const neither = yield* send(routes, listener, client, getThing, {
            path: { id: "-1" },
          });
          expect(only(neither).verdict).toEqual({ is: "missed" });
          expect(only(neither).dispatched).toMatchObject({
            route: "fallback",
            index: null,
          });
          // A path variant replaces the templates' text with a literal path.
          const archive = getThing.pipe(
            Operation.mapRequest((request) =>
              request.pipe(
                Request.unbind("path"),
                Request.setPath("/things/archive"),
              ),
            ),
          );
          expect(yield* reach(routes, archive, undefined)).toBe("by-name");
        }).pipe(Effect.scoped),
    );

    it.live(
      `${title}: an error stops selection, and \`or\` does not hide it`,
      () =>
        Effect.gen(function* () {
          const failing = yield* serve({
            routes: [
              route(
                "secured-or-get",
                and(exactPath("/e"), or(secured(), get())),
              ),
              route("get", and(exactPath("/e"), get())),
            ],
          });
          const sent = yield* send(
            failing,
            listener,
            client,
            operation(Request.get("/e")),
            undefined,
          );
          if (listener === "plain") {
            expect(only(sent).verdict).toMatchObject({ is: "failed" });
            expect(sent.outcome).toMatchObject({
              kind: "answered",
              status: 500,
            });
          } else {
            expect(only(sent).dispatched?.route).toBe("secured-or-get");
          }
        }).pipe(Effect.scoped),
    );
  }
});
