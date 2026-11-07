/**
 * EXT-18: the path rules of #82 and #104 at real services, in both lanes. The library's own tests
 * state each rule; these show what a consumer meets at the other end: what a client does with the
 * text it was given, and what a server then makes of it. Each case asserts what the client received
 * as well as what arrived, so a change in the library cannot hide behind one in the platform.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Request,
  Response,
  UrlEncoding,
} from "viell-effect-schema-http";
import * as Ops from "../clients/business/operations.js";
import { watching } from "../clients/received.js";
import type { Backend } from "../harness/lane.js";

const token = "path-rules-token";

const tasks = [
  {
    title: "Close the October ledger",
    assigneeId: "a.lind",
    priority: 2,
    due: null,
    notes: null,
    done: false,
    created: 1_700_000_000_000,
  },
];

const start = () => lane.backend("business", { operations: { token, tasks } });

const connect = (backend: Backend): Ops.Connection => ({
  baseUrl: `${backend.origin}/v2`,
  credential: () => token,
});

/** Whatever a server answers, so that a test can read the status of a 404 like any other. */
const answered = Response.when(() => true, Response.tag("Answer", Body.text));

/** Send one request through `fetch`, and return what the client received and what arrived. */
const sent = <I, E>(
  backend: Backend,
  request: Request.Request<I, E>,
  input: I,
) =>
  Effect.gen(function* () {
    const watched = watching();
    const before = (yield* backend.ledger).length;
    const answer = yield* Operation.make(request, answered, {
      transformClient: watched.last,
    })
      .execute(input)
      .pipe(Effect.provide(lane.fetchClient));
    const arrived = (yield* backend.ledger).slice(before);
    return {
      status: answer.metadata.status,
      body: answer.value,
      received: watched.received.map(({ url }) => url),
      arrived: arrived.map(({ target }) => target),
    };
  });

const id = Request.pathValue("id");

describe(`paths at a real service (${lane.name})`, () => {
  it.live(
    "[EXT-18a] a template and a renderer ask for the same task, and the service answers both",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const at = Ops.at(connect(backend));
        const template = Request.get("").pipe(at, Request.path`/tasks/${id}`);
        const renderer = Request.get("").pipe(
          at,
          Request.path(
            Schema.String,
            (value, encode) => `/tasks/${encode(value)}`,
          ),
        );
        const fromTemplate = yield* sent(backend, template, {
          path: { id: "T-1001" },
        });
        const fromRenderer = yield* sent(backend, renderer, {
          path: "T-1001",
        });
        expect(fromTemplate.status).toBe(200);
        expect(fromTemplate.arrived).toEqual(["/v2/tasks/T-1001"]);
        expect(fromRenderer).toEqual(fromTemplate);
      }),
  );

  for (const [value, segment] of [
    ["a/b c", "a%2Fb%20c"],
    ["ä", "%C3%A4"],
    ["100%", "100%25"],
    ["?q#f", "%3Fq%23f"],
  ] as const)
    it.live(
      `[EXT-18a] ${JSON.stringify(value)} stays one segment in both forms, and arrives as ${segment}`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("echo", undefined, {
            listener: "socket",
          });
          const base = Request.baseUrl(backend.origin);
          const template = yield* sent(
            backend,
            Request.get("/x").pipe(base, Request.path`/${id}/y`),
            { path: { id: value } },
          );
          const renderer = yield* sent(
            backend,
            Request.get("/x").pipe(
              base,
              Request.path(
                Schema.String,
                (text, encode) => `/${encode(text)}/y`,
              ),
            ),
            { path: value },
          );
          expect(template.arrived).toEqual([`/x/${segment}/y`]);
          expect(renderer).toEqual(template);
        }),
    );

  it.live(
    "[EXT-18b] a child adds to its parent, and each reads its own resource",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const customer = Request.get("/customers").pipe(
          Request.baseUrl(`${backend.origin}/v1`),
          Request.path`/${id}`,
        );
        const preferences = customer.pipe(Request.path`/preferences`);
        const input = { path: { id: "1001" } };
        const child = yield* sent(backend, preferences, input);
        const parent = yield* sent(backend, customer, input);
        expect(child.arrived).toEqual(["/v1/customers/1001/preferences"]);
        expect(child.status).toBe(200);
        expect(parent.arrived).toEqual(["/v1/customers/1001"]);
        expect(parent.status).toBe(200);
        expect(parent.body).toContain('"customer"');
        expect(child.body).not.toContain('"customer"');
      }),
  );

  it.live(
    "[EXT-18b] each level adds a value of its own, and one input carries both to the wire",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const year = Request.pathValue("year", Schema.FiniteFromString);
        const parent = Request.get("/archive").pipe(
          Request.baseUrl(backend.origin),
          Request.path`/${year}`,
        );
        const child = parent.pipe(Request.path`/entries/${id}`);
        const { arrived } = yield* sent(backend, child, {
          path: { year: 2026, id: "a b" },
        });
        expect(arrived).toEqual(["/archive/2026/entries/a%20b"]);
      }),
  );

  it.live(
    "[EXT-18b] a variant replaces a whole path with Request.unbind and Request.setPath",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const task = Request.get("/tasks").pipe(
          Ops.at(connect(backend)),
          Request.path`/${id}/history`,
        );
        const everything = task.pipe(
          Request.unbind("path"),
          Request.setPath("/tasks/history"),
        );
        const one = yield* sent(backend, task, { path: { id: "T-1001" } });
        const all = yield* sent(backend, everything, undefined);
        expect(one.arrived).toEqual(["/v2/tasks/T-1001/history"]);
        expect(all.arrived).toEqual(["/v2/tasks/history"]);
        expect(all.status).toBe(200);
      }),
  );

  for (const [constructor, added, target] of [
    ["/things/42", ":archive", "/things/42:archive"],
    ["/report", ".json", "/report.json"],
    ["/users", "42", "/users42"],
    ["/odata", "/Customers('O'Brien')", "/odata/Customers('O'Brien')"],
    ["/fetch", "/https://other.test/x", "/fetch/https://other.test/x"],
  ] as const)
    it.live(
      `[EXT-18c] ${constructor} and ${added} are joined exactly, as ${target}`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("echo", undefined, {
            listener: "socket",
          });
          const { arrived } = yield* sent(
            backend,
            Request.get(constructor).pipe(
              Request.baseUrl(backend.origin),
              Request.path(Schema.String, (text) => text),
            ),
            { path: added },
          );
          expect(arrived).toEqual([target]);
        }),
    );

  it.live(
    "[EXT-18c] an apostrophe in a value needs no encoding, so it closes the quote around it",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const { arrived } = yield* sent(
          backend,
          Request.get("/odata").pipe(
            Request.baseUrl(backend.origin),
            Request.path`/Customers('${id}')`,
          ),
          { path: { id: "O'Brien" } },
        );
        expect(arrived).toEqual(["/odata/Customers('O'Brien')"]);
      }),
  );

  it.live(
    "[EXT-18c] a ? in a template is URL text: a value after it is encoded, and a declared query goes after it",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const { arrived } = yield* sent(
          backend,
          Request.get("/x").pipe(
            Request.baseUrl(backend.origin),
            Request.path`?y=${id}`,
            Request.setQuery("z", "1 2"),
          ),
          { path: { id: "a b" } },
        );
        expect(arrived).toEqual(["/x?y=a%20b&z=1%202"]);
      }),
  );

  it.live(
    "[EXT-18c] a whole URL after an empty constructor bypasses the base, and one in the constructor takes a template",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const whole = new URL(`${backend.origin}/v1/regions`);
        const bypassing = yield* sent(
          backend,
          Request.get("").pipe(
            Request.baseUrl("http://elsewhere.test/v9"),
            Request.path(Schema.URLFromString, (href) => href),
          ),
          { path: whole },
        );
        const added = yield* sent(
          backend,
          Request.get(`${backend.origin}/v1`).pipe(Request.path`/regions`),
          undefined,
        );
        expect(bypassing.arrived).toEqual(["/v1/regions"]);
        expect(bypassing.status).toBe(200);
        expect(added).toEqual(bypassing);
      }),
  );

  it.live(
    "[EXT-18c] with a base URL, a query alone belongs in the constructor, because a template gets a / from the join",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("soap-store");
        const base = Request.baseUrl(`${backend.origin}/soap`);
        const inConstructor = yield* sent(
          backend,
          Request.get("?wsdl").pipe(base),
          undefined,
        );
        const inTemplate = yield* sent(
          backend,
          Request.get("").pipe(base, Request.path`?wsdl`),
          undefined,
        );
        expect(inConstructor.arrived).toEqual(["/soap?wsdl"]);
        expect(inConstructor.status).toBe(200);
        expect(inTemplate.arrived).toEqual(["/soap/?wsdl"]);
        expect(inTemplate.status).toBe(404);
      }),
  );

  it.live(
    "[EXT-18a] a value takes either side of its schema, and the path carries what the schema writes",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const year = Request.pathValue("year", Schema.FiniteFromString);
        const request = Request.get("/archive").pipe(
          Request.baseUrl(backend.origin),
          Request.path`/${year}`,
        );
        const decoded = yield* sent(backend, request, { path: { year: 2026 } });
        const encoded = yield* sent(backend, request, {
          path: { year: "2026.0" },
        });
        expect(decoded.arrived).toEqual(["/archive/2026"]);
        expect(encoded.arrived).toEqual(["/archive/2026"]);
      }),
  );

  it.live(
    "[EXT-18d] a constructor's trailing slash and a piece's leading one give //, which fetch keeps and the /v2 gateway merges",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { received, arrived, status } = yield* sent(
          backend,
          Request.get("/tasks/").pipe(
            Ops.at(connect(backend)),
            Request.path`/${id}`,
          ),
          { path: { id: "T-1001" } },
        );
        expect(received).toEqual([`${backend.origin}/v2/tasks//T-1001`]);
        expect(arrived).toEqual(["/v2/tasks//T-1001"]);
        expect(status).toBe(200);
      }),
  );

  it.live("[EXT-18d] /v1 has no gateway, and answers // with 404", () =>
    Effect.gen(function* () {
      const backend = yield* lane.backend("business");
      const { arrived, status } = yield* sent(
        backend,
        Request.get("/customers/").pipe(
          Request.baseUrl(`${backend.origin}/v1`),
          Request.path`/${id}`,
        ),
        { path: { id: "1001" } },
      );
      expect(arrived).toEqual(["/v1/customers//1001"]);
      expect(status).toBe(404);
    }),
  );

  it.live("[EXT-18d] the WebDAV view answers // with 404 too", () =>
    Effect.gen(function* () {
      const backend = yield* lane.backend("soap-store");
      const { arrived, status } = yield* sent(
        backend,
        Request.make("PROPFIND", "/dav/").pipe(
          Request.baseUrl(backend.origin),
          Request.setHeader("Depth", "1"),
          Request.path`/documents/`,
        ),
        undefined,
      );
      expect(arrived).toEqual(["/dav//documents/"]);
      expect(status).toBe(404);
    }),
  );

  it.live(
    "[EXT-18e] real nginx merges the slashes of a template, and answers the task's history",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("replay", {
          exchanges: ["nginx-paths/task-slashes"],
        });
        const { arrived, status } = yield* sent(
          backend,
          Request.get("/v2//tasks///").pipe(
            Request.baseUrl(backend.origin),
            Request.path`${id}//history`,
          ),
          { path: { id: "T-1001" } },
        );
        expect(arrived).toEqual(["/v2//tasks///T-1001//history"]);
        expect(status).toBe(200);
      }),
  );

  it.live(
    "[EXT-18f] a trailing slash is kept, and the same service answers each spelling differently",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const at = Ops.at(connect(backend));
        const bare = yield* sent(
          backend,
          Request.get("/tasks").pipe(at),
          undefined,
        );
        const slashed = yield* sent(
          backend,
          Request.get("/tasks").pipe(at, Request.path`/`),
          undefined,
        );
        expect(bare.arrived).toEqual(["/v2/tasks"]);
        expect(bare.status).toBe(200);
        expect(slashed.arrived).toEqual(["/v2/tasks/"]);
        expect(slashed.status).toBe(404);
      }),
  );

  it.live(
    "[EXT-18f] the WebDAV collection exists only with its trailing slash, so a template ends in one",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("soap-store");
        const documents = Request.make("PROPFIND", "/dav/documents").pipe(
          Request.baseUrl(backend.origin),
          Request.setHeader("Depth", "1"),
        );
        const bare = yield* sent(backend, documents, undefined);
        const collection = yield* sent(
          backend,
          documents.pipe(Request.path`/`),
          undefined,
        );
        expect(bare.arrived).toEqual(["/dav/documents"]);
        expect(bare.status).toBe(404);
        expect(collection.arrived).toEqual(["/dav/documents/"]);
        expect(collection.status).toBe(207);
      }),
  );

  it.live(
    "[EXT-18g] a value of .. leaves the customer: fetch resolves it after the client received it, and /v1/regions answers 200",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const { received, arrived, status, body } = yield* sent(
          backend,
          Request.get("/customers").pipe(
            Request.baseUrl(`${backend.origin}/v1`),
            Request.path`/${id}/regions`,
          ),
          { path: { id: ".." } },
        );
        expect(received).toEqual([`${backend.origin}/v1/customers/../regions`]);
        expect(arrived).toEqual(["/v1/regions"]);
        expect(status).toBe(200);
        expect(body).toContain('"regions"');
      }),
  );

  it.live(
    "[EXT-18g] a value of . disappears: fetch resolves it after the client received it",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const { received, arrived, status } = yield* sent(
          backend,
          Request.get("").pipe(
            Request.baseUrl(`${backend.origin}/v1`),
            Request.path`/${id}/regions`,
          ),
          { path: { id: "." } },
        );
        expect(received).toEqual([`${backend.origin}/v1/./regions`]);
        expect(arrived).toEqual(["/v1/regions"]);
        expect(status).toBe(200);
      }),
  );

  for (const [value, segment] of [
    ["%2e%2e", "%252e%252e"],
    ["../..", "..%2F.."],
    [".. ", "..%20"],
  ] as const)
    it.live(
      `[EXT-18h] ${JSON.stringify(value)} is encoded into a literal segment, which fetch leaves alone`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("business");
          const { received, arrived, status } = yield* sent(
            backend,
            Request.get("/customers").pipe(
              Request.baseUrl(`${backend.origin}/v1`),
              Request.path`/${id}/regions`,
            ),
            { path: { id: value } },
          );
          const target = `/v1/customers/${segment}/regions`;
          expect(received).toEqual([`${backend.origin}${target}`]);
          expect(arrived).toEqual([target]);
          expect(status).toBe(404);
        }),
    );

  it.live(
    "[EXT-18i] an empty value at the end leaves a trailing slash, which is not the list",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { arrived, status } = yield* sent(
          backend,
          Request.get("/tasks").pipe(
            Ops.at(connect(backend)),
            Request.path`/${id}`,
          ),
          { path: { id: "" } },
        );
        expect(arrived).toEqual(["/v2/tasks/"]);
        expect(status).toBe(404);
      }),
  );

  it.live(
    "[EXT-18i] an empty value in the middle leaves //, which the /v2 gateway merges into another resource",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const { arrived, status, body } = yield* sent(
          backend,
          Request.get("/tasks").pipe(
            Ops.at(connect(backend)),
            Request.path`/${id}/history`,
          ),
          { path: { id: "" } },
        );
        expect(arrived).toEqual(["/v2/tasks//history"]);
        expect(status).toBe(200);
        expect(body).toContain('"events"');
      }),
  );

  it.live(
    "[EXT-18j] a schema on the value refuses .. and an empty value before anything is sent",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const segment = Request.pathValue(
          "id",
          Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
        );
        const guarded = Operation.make(
          Request.get("/customers").pipe(
            Request.baseUrl(`${backend.origin}/v1`),
            Request.path`/${segment}/preferences`,
          ),
          answered,
        );
        for (const value of ["..", ""]) {
          const error = yield* Effect.flip(
            guarded
              .execute({ path: { id: value } })
              .pipe(Effect.provide(lane.fetchClient)),
          );
          expect(Schema.isSchemaError(error)).toBe(true);
        }
        expect(yield* backend.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-18j] a replaced path encoder refuses .. for every value at once, as Request.InvalidRequest with nothing sent",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const noDotSegments = UrlEncoding.layer({
          ...UrlEncoding.defaults,
          path: (value) => {
            if (value === "." || value === "..")
              throw new Error("a dot segment");
            return UrlEncoding.defaults.path(value);
          },
        });
        const error = yield* Effect.flip(
          Operation.make(
            Request.get("/customers").pipe(
              Request.baseUrl(`${backend.origin}/v1`),
              Request.path`/${id}/regions`,
            ),
            answered,
          )
            .execute({ path: { id: ".." } })
            .pipe(
              Effect.provide(lane.fetchClient),
              Effect.provide(noDotSegments),
            ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(yield* backend.ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-18k] a label left in the constructor of a whole-URL renderer reaches nothing: Node refuses it, and Chromium asks the page's own origin",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("business");
        const stale = Operation.make(
          Request.get("{location}").pipe(
            Request.path(Schema.URLFromString, (href) => href),
          ),
          answered,
        );
        const exit = yield* stale
          .execute({ path: new URL(`${backend.origin}/v1/regions`) })
          .pipe(Effect.provide(lane.fetchClient), Effect.exit);
        expect(yield* backend.ledger).toEqual([]);
        if (lane.name === "node") {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(String(exit)).toContain("InvalidUrl");
        } else {
          // The text is a relative URL to a page, so the page's own server answers it, with no
          // error and nothing to tell the caller that the service was never asked.
          expect(Exit.isSuccess(exit)).toBe(true);
        }
      }),
  );

  it.live(
    "[EXT-18l] a definition still written the old way asks for the wrong URL, and a declared 404 reads as an ordinary answer",
    () =>
      Effect.gen(function* () {
        const backend = yield* start();
        const stale = Operation.make(
          Request.get("tasks").pipe(
            Ops.at(connect(backend)),
            Request.path(
              Schema.String,
              (task, encode) => `tasks/${encode(task)}`,
            ),
          ),
          Response.status(200, Response.tag("Task", Body.json)).pipe(
            Response.orElse(
              Response.status(404, Response.tag("NotFound", Body.json)),
            ),
          ),
        );
        const result = yield* stale
          .execute({ path: "T-1001" })
          .pipe(Effect.provide(lane.fetchClient));
        expect(result._tag).toBe("NotFound");
        expect((yield* backend.ledger).map(({ target }) => target)).toEqual([
          "/v2/taskstasks/T-1001",
        ]);
      }),
  );
});
