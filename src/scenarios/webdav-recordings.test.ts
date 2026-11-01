/**
 * The consumer against real mod_dav responses (#47), through fresh replay backends and real
 * sockets. No backend implementation or conformance helper is used, in Node or Chromium.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpBody } from "effect/http";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { WebDav, XmlSchema } from "../clients/soap-store/index.js";
import { AllowList } from "../values/soap-store.js";
import { bodyText, header } from "../harness/lane.js";

const ROOT = "/dav/documents/";
const FILE = `${ROOT}report.txt`;
const ETAG = '"11-6103c9e4a1000"';
const strongTag = { weak: false, opaque: "11-6103c9e4a1000" };
const utf8 = new TextEncoder();
const allprop =
  '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
const properties =
  '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:R="urn:recording:missing"><D:prop><D:resourcetype/><D:displayname/><D:getcontentlength/><D:getcontenttype/><D:getetag/><D:getlastmodified/><R:missing/></D:prop></D:propfind>';
const xmlBody = Body.encoder((xml: string) =>
  Effect.succeed(HttpBody.text(xml, "application/xml; charset=utf-8")),
);
const listingBody = Body.decoder(
  (response) => Body.bytes.decode(response),
  "text/xml",
).pipe(
  Body.schema(XmlSchema.ElementFromBytes.pipe(Schema.decodeTo(WebDav.Listing))),
);

// Expected document values are read from the real multistatus, including its href spelling/order.
// Three collection responses are skipped; unknown and 404 properties do not become documents.
const documents = [
  {
    href: `${ROOT}Caf%c3%a9%20&%20notes.txt`,
    name: "Café & notes.txt",
    size: 6,
    contentType: "text/plain",
    etag: { weak: false, opaque: "6-6103c9e4a1000" },
    lastModified: "Wed, 31 Jan 2024 12:00:00 GMT",
  },
  {
    href: FILE,
    name: "report.txt",
    size: 17,
    contentType: "text/plain",
    etag: strongTag,
    lastModified: "Wed, 31 Jan 2024 12:00:00 GMT",
  },
];

const replay = (names: ReadonlyArray<string>) =>
  lane.backend("replay", {
    exchanges: names.map((name) => `httpd-dav/${name}`),
  });
const narrow = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

describe(`real mod_dav recordings (${lane.name})`, () => {
  for (const [provider, client] of lane.clients) {
    it.live(
      `[PAY-3a] ${provider}: the ordinary PROPFIND contract decodes Apache's allprop listing and skips collections`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["allprop-depth1"]);
          expect(yield* WebDav.propfind(backend.origin).execute("")).toEqual(
            documents,
          );
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("PROPFIND");
          expect(ledger[0]!.target).toBe(ROOT);
          expect(header(ledger[0]!.lines, "depth")).toBe("1");
          expect(header(ledger[0]!.lines, "accept")).toBe("text/xml");
          expect(bodyText(ledger[0]!)).toBe(allprop);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    it.live(
      `[STAT-7] ${provider}: the same listing decoder accepts quoted charset and skips real 404 propstats`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["props-depth1"]);
          // Request the exact recorded property set, retaining the production listing decoder.
          const operation = Operation.make(
            Request.make("PROPFIND", `${backend.origin}${ROOT}`).pipe(
              Request.setHeader("Depth", "1"),
              Request.body(xmlBody),
            ),
            Response.status(207, Response.tag("Listing", listingBody)),
          );
          const outcome = yield* operation.execute({ body: properties });
          expect(outcome.metadata.headers["content-type"]).toBe(
            'text/xml; charset="utf-8"',
          );
          expect(outcome.value).toEqual(documents);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("PROPFIND");
          expect(ledger[0]!.target).toBe(ROOT);
          expect(header(ledger[0]!.lines, "depth")).toBe("1");
          expect(header(ledger[0]!.lines, "content-type")).toBe(
            "application/xml; charset=utf-8",
          );
          expect(bodyText(ledger[0]!)).toBe(properties);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    for (const [name, target, methods] of [
      [
        "options-collection",
        ROOT,
        [
          "OPTIONS",
          "GET",
          "HEAD",
          "POST",
          "DELETE",
          "TRACE",
          "PROPFIND",
          "PROPPATCH",
          "COPY",
          "MOVE",
          "LOCK",
          "UNLOCK",
        ],
      ],
      [
        "options-document",
        FILE,
        [
          "OPTIONS",
          "GET",
          "HEAD",
          "POST",
          "DELETE",
          "TRACE",
          "PROPFIND",
          "PROPPATCH",
          "COPY",
          "MOVE",
          "PUT",
          "LOCK",
          "UNLOCK",
        ],
      ],
      [
        "options-unmapped",
        `${ROOT}new.txt`,
        ["OPTIONS", "MKCOL", "PUT", "LOCK"],
      ],
    ] as const) {
      it.live(
        `[STAT-7] ${provider}: ${name} decodes Apache's actual Allow method tokens`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay([name]);
            const allowed = Body.decoder((response) =>
              Body.empty
                .decode(response)
                .pipe(
                  Effect.andThen(
                    Schema.decodeUnknownEffect(AllowList)(
                      response.headers["allow"],
                    ),
                  ),
                ),
            );
            const operation = Operation.make(
              Request.make("OPTIONS", `${backend.origin}${target}`),
              Response.status(200, Response.tag("Options", allowed)),
            );
            const outcome = yield* operation.execute(undefined);
            expect(outcome.value).toEqual(methods);
            expect(outcome.metadata.headers["dav"]).toBe(
              "1,2, <http://apache.org/dav/propset/fs/1>",
            );
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(1);
            expect(ledger[0]!.method).toBe("OPTIONS");
            expect(ledger[0]!.target).toBe(target);
            expect(ledger[0]!.body).toHaveLength(0);
          }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
      );
    }

    it.live(
      `[STAT-7] ${provider}: MKCOL decodes Apache's recorded 405 Allow list without assuming OPTIONS has the same list`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["mkcol-existing"]);
          expect(yield* WebDav.mkcol(backend.origin).execute("")).toEqual({
            _tag: "MethodNotAllowed",
            allow: ["TRACE"],
          });
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("MKCOL");
          expect(ledger[0]!.target).toBe(ROOT);
          expect(ledger[0]!.body).toHaveLength(0);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    it.live(
      `[RET-3] ${provider}: the GET contract reads real bytes and reuses the strong ETag for a bodyless 304`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["get-document", "get-not-modified"]);
          const read = WebDav.read(backend.origin);
          const first = narrow(
            yield* read.execute({ name: "report.txt" }),
            "Content",
          );
          expect(first).toEqual({
            _tag: "Content",
            bytes: utf8.encode("synthetic report\n"),
            contentType: "text/plain",
            etag: strongTag,
          });
          expect(
            yield* read.execute({
              name: "report.txt",
              ifNoneMatch: first.etag,
            }),
          ).toEqual({ _tag: "NotModified", etag: strongTag });
          const ledger = yield* backend.ledger;
          expect(ledger.map(({ method, target }) => [method, target])).toEqual([
            ["GET", FILE],
            ["GET", FILE],
          ]);
          expect(header(ledger[0]!.lines, "if-none-match")).toBeUndefined();
          expect(header(ledger[1]!.lines, "if-none-match")).toBe(ETAG);
          expect(ledger.every(({ body }) => body.length === 0)).toBe(true);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    it.live(
      `[RET-3] ${provider}: a wildcard condition also returns a bodyless recorded 304`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["get-not-modified-wildcard"]);
          const operation = Operation.make(
            Request.get(`${backend.origin}${FILE}`).pipe(
              Request.setHeader("If-None-Match", "*"),
            ),
            Response.status(304, Response.tag("NotModified", Body.empty)),
          );
          const outcome = yield* operation.execute(undefined);
          expect(outcome.value).toBeUndefined();
          expect(outcome.metadata.headers["etag"]).toBe(ETAG);
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("GET");
          expect(ledger[0]!.target).toBe(FILE);
          expect(header(ledger[0]!.lines, "if-none-match")).toBe("*");
          expect(ledger[0]!.body).toHaveLength(0);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );

    for (const [name, etag] of [
      ["put-stale", { weak: false, opaque: "stale" }],
      ["put-weak", { weak: true, opaque: "11-6103c9e4a1000" }],
    ] as const) {
      it.live(
        `[RET-3] ${provider}: ${name} maps the real 412 and drains its HTML reason`,
        () =>
          Effect.gen(function* () {
            const backend = yield* replay([name]);
            const outcome = yield* WebDav.write(backend.origin).execute({
              name: "report.txt",
              contentType: "text/plain",
              bytes: utf8.encode("replacement\n"),
              condition: { _tag: "Replace", etag },
            });
            expect(narrow(outcome, "PreconditionFailed").reason).toContain(
              "412 Precondition Failed",
            );
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(1);
            expect(ledger[0]!.method).toBe("PUT");
            expect(ledger[0]!.target).toBe(FILE);
            expect(header(ledger[0]!.lines, "if-match")).toBe(
              name === "put-weak" ? `W/${ETAG}` : '"stale"',
            );
            expect(header(ledger[0]!.lines, "content-type")).toBe("text/plain");
            expect(bodyText(ledger[0]!)).toBe("replacement\n");
          }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
      );
    }

    it.live(
      `[STAT-7] ${provider}: the missing-Depth refusal is Apache's recorded HTML 403`,
      () =>
        Effect.gen(function* () {
          const backend = yield* replay(["finite-depth"]);
          const operation = Operation.make(
            Request.make("PROPFIND", `${backend.origin}${ROOT}`).pipe(
              Request.body(xmlBody),
            ),
            Response.status(403, Body.text),
          );
          expect(yield* operation.execute({ body: allprop })).toContain(
            'Depth of "infinity"',
          );
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.method).toBe("PROPFIND");
          expect(ledger[0]!.target).toBe(ROOT);
          expect(header(ledger[0]!.lines, "depth")).toBeUndefined();
          expect(bodyText(ledger[0]!)).toBe(allprop);
        }).pipe(Effect.provide(client), Effect.timeout("3 seconds")),
    );
  }
});
