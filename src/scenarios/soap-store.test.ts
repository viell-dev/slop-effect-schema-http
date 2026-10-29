import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Effect,
  type Layer,
  Schedule,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { lane } from "#lane";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import {
  Actions,
  Files,
  Soap,
  WebDav,
  Wsdl,
  XmlSchema,
} from "../clients/soap-store/index.js";
import * as Xml from "../formats/xml.js";
import {
  bodyText,
  header,
  headerValues,
  type Json,
  type Recorded,
} from "../harness/lane.js";

/**
 * The SOAP document store, driven through the consumer's contracts in both lanes. Fixture values
 * come from here and reach the backend as JSON options; everything else is learned over HTTP.
 */

const fixture = {
  documents: [
    {
      name: "contract-acme.pdf",
      title: "Rahmenvertrag ACME",
      contentType: "application/pdf",
      text: "%PDF-1.4 contract",
      modified: "2026-09-01T08:00:00Z",
    },
    {
      name: "invoice-2026-09.pdf",
      title: "Rechnung September 2026",
      contentType: "application/pdf",
      text: "%PDF-1.4 invoice 09",
      modified: "2026-09-30T17:00:00Z",
    },
    {
      name: "invoice-2026-10.pdf",
      title: "Rechnung Oktober 2026",
      contentType: "application/pdf",
      text: "%PDF-1.4 invoice 10",
      modified: "2026-10-28T17:00:00Z",
    },
    {
      name: "Prüfbericht.txt",
      title: "Prüfbericht für Café Größe – 5 €",
      contentType: "text/plain",
      text: "Prüfung bestanden.\n",
      modified: "2026-10-01T09:30:00Z",
    },
  ],
  collections: ["archive", "templates"],
  clock: "2026-10-29T12:00:00Z",
} as const;

/** Start the store with the fixture, plus any switches a test needs. */
const start = (options: { readonly [key: string]: Json } = {}) =>
  lane.backend("soap-store", { ...fixture, ...options });

const NS = "urn:docvault:store:2003";
const SOAP11 = "http://schemas.xmlsoap.org/soap/envelope/";
const SOAP12 = "http://www.w3.org/2003/05/soap-envelope";

/** Narrow a tagged value, failing the test when the tag differs. */
const as = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A,
  tag: T,
): Extract<A, { readonly _tag: T }> => {
  expect(value._tag).toBe(tag);
  return value as Extract<A, { readonly _tag: T }>;
};

const encoder = new TextEncoder();

/** ISO-8859-1 by hand: one code point per byte. */
const latin1 = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const base64 = (bytes: Uint8Array): string => btoa(latin1(bytes));

/** The local name of the element inside a recorded SOAP request's Body. */
const bodyElement = (recorded: Recorded): string => {
  const envelope = Xml.parse(bodyText(recorded));
  const body = Xml.child(envelope, "Body");
  return Xml.localName(Xml.elements(body)[0]!.name);
};

type Client = Layer.Layer<HttpClient.HttpClient>;

/** The id of a seeded document, learned through ListDocuments. */
const idOf = (origin: string, name: string, client: Client) =>
  Actions.operations(origin)
    .listDocuments.execute({ body: { prefix: name } })
    .pipe(
      Effect.provide(client),
      Effect.map((listed) => {
        const found = as(listed, "Listed").documents.find(
          (document) => document.name === name,
        );
        expect(found).toBeDefined();
        return found!.id;
      }),
    );

/**
 * A hand-written SOAP request: the text goes out as UTF-8 under the given content type, bypassing
 * the consumer's XML writer, so the store's own reader is what decides. A 200 is read as bytes and
 * the front controller's plain-text 400 as its reason.
 */
const rawSoap = (request: Request.Request<unknown>, contentType: string) =>
  Operation.make(
    request.pipe(
      Request.body(
        Body.encoder((text: string) =>
          Effect.succeed(HttpBody.text(text, contentType)),
        ),
      ),
    ),
    Response.status(200, Response.tag("Answered", Body.bytes)).pipe(
      Response.orElse(Response.status(400, Response.tag("Refused", Body.text))),
    ),
  );

/** A hand-written SOAP 1.1 request with the given `SOAPAction` value. */
const rawSoap11 = (origin: string, soapAction: string) =>
  rawSoap(
    Request.post("soap").pipe(
      Request.baseUrl(origin),
      Request.setHeader("SOAPAction", soapAction),
    ),
    "text/xml; charset=utf-8",
  );

/** A hand-written SOAP 1.2 request with the given `action` content-type parameter. */
const rawSoap12 = (origin: string, action: string) =>
  rawSoap(
    Request.post("soap").pipe(Request.baseUrl(origin)),
    `application/soap+xml; charset=utf-8; action="${action}"`,
  );

/** A SOAP envelope of the given version around a payload written exactly as given. */
const envelope = (namespace: string, payload: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${namespace}">` +
  `<soap:Body>${payload}</soap:Body></soap:Envelope>`;

/** A ListDocuments payload in the given default namespace, or in none. */
const listIn = (namespace: string | undefined) =>
  `<ListDocuments${namespace === undefined ? "" : ` xmlns="${namespace}"`}><Prefix/></ListDocuments>`;

/** A StoreDocument envelope around a title written exactly as given. */
const storeEnvelope = (name: string, title: string) =>
  envelope(
    SOAP11,
    `<StoreDocument xmlns="${NS}"><Name>${name}</Name><Title>${title}</Title>` +
      `<ContentType>text/plain</ContentType><Content>eA==</Content></StoreDocument>`,
  );

describe(`soap-store (${lane.name})`, () => {
  describe("fault codes inside HTTP 200", () => {
    for (const [client, layer] of lane.clients)
      it.live(
        `[ERR-1a] stores and fetches a document, reading FaultCode 0 as success (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const soap = Actions.operations(backend.origin);
            const content = encoder.encode("Quartalsbericht Q3\n");
            const stored = as(
              yield* soap.storeDocument
                .execute({
                  body: {
                    name: "q3.txt",
                    title: "Quartalsbericht",
                    contentType: "text/plain",
                    content,
                  },
                })
                .pipe(Effect.provide(layer)),
              "Stored",
            );
            expect(stored.etag.weak).toBe(false);
            const fetched = as(
              yield* soap.fetchDocument
                .execute({ body: { id: stored.id } })
                .pipe(Effect.provide(layer)),
              "Fetched",
            );
            expect(fetched.document).toEqual({
              id: stored.id,
              name: "q3.txt",
              title: "Quartalsbericht",
              contentType: "text/plain",
              size: content.length,
              etag: stored.etag,
              modified: "2026-10-29T12:00:00Z",
              content,
            });
            const ledger = yield* backend.ledger;
            expect(ledger).toHaveLength(2);
            const [store, fetch] = ledger;
            for (const recorded of [store!, fetch!]) {
              expect(recorded.method).toBe("POST");
              expect(recorded.target).toBe("/soap");
              expect(header(recorded.lines, "content-type")).toBe(
                "text/xml; charset=utf-8",
              );
            }
            expect(bodyText(store!)).toContain(
              `<Content>${base64(content)}</Content>`,
            );
            expect(bodyText(fetch!)).toContain(`<Id>${stored.id}</Id>`);
          }),
      );

    it.live(
      "[ERR-1a] a missing document and a duplicate name arrive as HTTP 200 with nonzero fault codes",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const soap = Actions.operations(backend.origin);
          // The contracts declare only status 200, so a Refused value was decoded from a 200 body.
          const missing = as(
            yield* soap.fetchDocument
              .execute({ body: { id: "DOC-999999" } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Refused",
          );
          expect(missing).toEqual({
            _tag: "Refused",
            code: 1001,
            message: "No document with id DOC-999999",
          });
          const duplicate = as(
            yield* soap.storeDocument
              .execute({
                body: {
                  name: "contract-acme.pdf",
                  title: "Copy",
                  contentType: "application/pdf",
                  content: encoder.encode("%PDF-1.4 copy"),
                },
              })
              .pipe(Effect.provide(lane.fetchClient)),
            "Refused",
          );
          expect(duplicate.code).toBe(1002);
          expect(yield* backend.ledger).toHaveLength(2);
        }),
    );

    it.live(
      "[ERR-1a] the failStore switch refuses chosen names and calls with fault code 5003, storing nothing",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({
            failStore: { names: ["broken.pdf"], calls: [3] },
          });
          const soap = Actions.operations(backend.origin);
          const store = (name: string) =>
            soap.storeDocument
              .execute({
                body: {
                  name,
                  title: name,
                  contentType: "application/pdf",
                  content: encoder.encode(`%PDF-1.4 ${name}`),
                },
              })
              .pipe(Effect.provide(lane.fetchClient));
          expect(as(yield* store("broken.pdf"), "Refused").code).toBe(5003);
          as(yield* store("first.pdf"), "Stored");
          expect(as(yield* store("third.pdf"), "Refused")).toEqual({
            _tag: "Refused",
            code: 5003,
            message: "Storage backend unavailable; the document was not stored",
          });
          const listed = as(
            yield* soap.listDocuments
              .execute({ body: { prefix: "" } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Listed",
          );
          // The store orders names by UTF-16 code unit, so upper case sorts first.
          expect(listed.documents.map((document) => document.name)).toEqual([
            "Prüfbericht.txt",
            "contract-acme.pdf",
            "first.pdf",
            "invoice-2026-09.pdf",
            "invoice-2026-10.pdf",
          ]);
        }),
    );

    it.live(
      "[ERR-1a] refusedAsFailure moves a nonzero fault code into the failure channel",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const fetchDocument = Actions.refusedAsFailure(
            Actions.operations(backend.origin).fetchDocument,
          );
          const error = yield* fetchDocument
            .execute({ body: { id: "DOC-999999" } })
            .pipe(Effect.provide(lane.fetchClient), Effect.flip);
          expect(as(error, "StoreRefused").code).toBe(1001);
          const id = yield* idOf(
            backend.origin,
            "contract-acme.pdf",
            lane.fetchClient,
          );
          const fetched = yield* fetchDocument
            .execute({ body: { id } })
            .pipe(Effect.provide(lane.fetchClient));
          expect(fetched.document.name).toBe("contract-acme.pdf");
        }),
    );

    it.live(
      "[ERR-1a] a held store fails as the caller's timeout, not as a fault code, and the store sees the abort",
      () =>
        Effect.gen(function* () {
          const backend = yield* start({ hold: ["StoreDocument"] });
          const error = yield* Actions.operations(backend.origin)
            .storeDocument.execute({
              body: {
                name: "late.pdf",
                title: "Late",
                contentType: "application/pdf",
                content: encoder.encode("%PDF-1.4 late"),
              },
            })
            .pipe(
              Effect.provide(lane.fetchClient),
              Effect.timeout("300 millis"),
              Effect.flip,
            );
          expect(error._tag).toBe("TimeoutError");
          const aborted = yield* backend.ledger.pipe(
            Effect.map((ledger) => ledger[0]?.aborted === true),
            Effect.repeat({
              schedule: Schedule.spaced("25 millis"),
              until: (seen) => seen,
              times: 100,
            }),
          );
          expect(aborted).toBe(true);
        }),
    );
  });

  describe("outcome types", () => {
    type Ops = ReturnType<typeof Actions.operations>;
    type Outcome<K extends keyof Ops> = Effect.Success<
      ReturnType<Ops[K]["execute"]>
    >;

    it("[ERR-1a] a body-level refusal shares the success union, so reading a document needs narrowing", () => {
      expectTypeOf<Outcome<"fetchDocument">["_tag"]>().toEqualTypeOf<
        "Fetched" | "Refused"
      >();
      const title = (outcome: Outcome<"fetchDocument">) => {
        // @ts-expect-error a Refused outcome has no document
        void outcome.document;
        return outcome._tag === "Fetched"
          ? outcome.document.title
          : outcome.message;
      };
      expect(title({ _tag: "Refused", code: 1001, message: "missing" })).toBe(
        "missing",
      );
    });

    it("[ERR-6] only LockDocument's union holds SOAP faults: one more rule", () => {
      expectTypeOf<Outcome<"lockDocument">["_tag"]>().toEqualTypeOf<
        "Locked" | "LockConflict" | "DocumentNotFound" | "SoapFault"
      >();
      expectTypeOf<Outcome<"storeDocument">["_tag"]>().toEqualTypeOf<
        "Stored" | "Refused"
      >();
    });
  });

  describe("the one action with real SOAP faults", () => {
    for (const [client, layer] of lane.clients)
      it.live(
        `[ERR-6] LockDocument answers a conflict with a SOAP fault under HTTP 500, read by its one extra rule (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const soap = Actions.operations(backend.origin);
            const id = yield* idOf(backend.origin, "contract-acme.pdf", layer);
            const lock = (owner: string, target = id) =>
              soap.lockDocument
                .execute({ body: { id: target, owner, seconds: 60 } })
                .pipe(Effect.provide(layer));
            const locked = as(yield* lock("alice"), "Locked");
            expect(locked.owner).toBe("alice");
            expect(locked.expires).toBe("2026-10-29T12:01:00Z");
            expect(as(yield* lock("bob"), "LockConflict")).toEqual({
              _tag: "LockConflict",
              code: "Receiver",
              message: `Document ${id} is locked by alice`,
              heldBy: "alice",
              expires: "2026-10-29T12:01:00Z",
            });
            expect(
              as(yield* lock("bob", "DOC-999999"), "DocumentNotFound"),
            ).toEqual({
              _tag: "DocumentNotFound",
              code: "Sender",
              message: "No document with id DOC-999999",
              id: "DOC-999999",
            });
            const locks = (yield* backend.ledger).slice(1);
            expect(locks).toHaveLength(3);
            for (const recorded of locks)
              expect(headerValues(recorded.lines, "soapaction")).toEqual([
                `"${NS}#LockDocument"`,
              ]);
          }),
      );

    it.live(
      "[ERR-6] the default classifier retries the mapped 500 fault; a classifier for the special case sends once",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const origin = backend.origin;
          const id = yield* idOf(origin, "contract-acme.pdf", lane.fetchClient);
          const request = Soap.Soap11.request(Actions.LockDocument).pipe(
            Request.baseUrl(origin),
          );
          const responses = Actions.lockResponses(Soap.Soap11);
          as(
            yield* Operation.make(request, responses)
              .execute({ body: { id, owner: "alice", seconds: 60 } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Locked",
          );
          // Policy.transient classifies status 500 as transient even when a rule mapped it.
          const retried = yield* Operation.make(request, responses, {
            policy: Policy.make(Schedule.recurs(2)),
          })
            .execute({ body: { id, owner: "bob", seconds: 60 } })
            .pipe(Effect.provide(lane.fetchClient));
          as(retried, "LockConflict");
          expect(yield* backend.ledger).toHaveLength(2 + 3);
          const once = yield* Operation.make(request, responses, {
            policy: Policy.make(Schedule.recurs(2), {
              while: (reason) =>
                reason._tag === "Failure" && Policy.transient(reason),
            }),
          })
            .execute({ body: { id, owner: "bob", seconds: 60 } })
            .pipe(Effect.provide(lane.fetchClient));
          as(once, "LockConflict");
          expect(yield* backend.ledger).toHaveLength(2 + 3 + 1);
        }),
    );
  });

  describe("WebDAV statuses and methods", () => {
    for (const [client, layer] of lane.clients)
      it.live(
        `[STAT-7] PROPFIND travels as a method string with Depth: 1 and its 207 multistatus decodes (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const documents = yield* WebDav.propfind(backend.origin)
              .execute("")
              .pipe(Effect.provide(layer));
            expect(documents.map((document) => document.name)).toEqual([
              "Prüfbericht.txt",
              "contract-acme.pdf",
              "invoice-2026-09.pdf",
              "invoice-2026-10.pdf",
            ]);
            const report = documents[0]!;
            expect(report).toMatchObject({
              href: "/dav/documents/Pr%C3%BCfbericht.txt",
              size: encoder.encode("Prüfung bestanden.\n").length,
              contentType: "text/plain",
              lastModified: "Thu, 01 Oct 2026 09:30:00 GMT",
            });
            const [recorded, ...rest] = yield* backend.ledger;
            expect(rest).toEqual([]);
            expect(recorded!.method).toBe("PROPFIND");
            expect(recorded!.target).toBe("/dav/documents/");
            expect(headerValues(recorded!.lines, "depth")).toEqual(["1"]);
            expect(header(recorded!.lines, "content-type")).toBe(
              "application/xml; charset=utf-8",
            );
            expect(bodyText(recorded!)).toContain("<D:allprop/>");
          }),
      );

    it.live(
      "[STAT-7] 428, 412 and 415 are ordinary declared statuses of a WebDAV write",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const write = WebDav.write(backend.origin);
          const content = as(
            yield* WebDav.read(backend.origin)
              .execute({ name: "contract-acme.pdf" })
              .pipe(Effect.provide(lane.fetchClient)),
            "Content",
          );
          const put = (condition: WebDav.Condition, contentType: string) =>
            write
              .execute({
                name: "contract-acme.pdf",
                contentType,
                bytes: encoder.encode("%PDF-1.4 revised"),
                condition,
              })
              .pipe(Effect.provide(lane.fetchClient));
          as(
            yield* put({ _tag: "Unconditional" }, "application/pdf"),
            "PreconditionRequired",
          );
          as(
            yield* put(
              { _tag: "Replace", etag: { weak: false, opaque: "stale" } },
              "application/pdf",
            ),
            "PreconditionFailed",
          );
          expect(
            as(
              yield* put({ _tag: "Replace", etag: content.etag }, "image/png"),
              "UnsupportedMediaType",
            ).reason,
          ).toMatch(/^Unsupported Media Type image\/png/);
          const [, unconditional, stale, png] = yield* backend.ledger;
          expect(unconditional!.method).toBe("PUT");
          expect(header(unconditional!.lines, "if-match")).toBeUndefined();
          expect(header(unconditional!.lines, "if-none-match")).toBeUndefined();
          expect(headerValues(stale!.lines, "if-match")).toEqual(['"stale"']);
          expect(header(png!.lines, "content-type")).toBe("image/png");
        }),
    );

    it.live(
      "[STAT-7] MKCOL on an existing collection answers 405 with an Allow list read through a header schema",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const mkcol = WebDav.mkcol(backend.origin);
          expect(
            yield* mkcol
              .execute("archive")
              .pipe(Effect.provide(lane.fetchClient)),
          ).toEqual({
            _tag: "MethodNotAllowed",
            allow: ["OPTIONS", "PROPFIND"],
          });
          as(
            yield* mkcol
              .execute("drafts")
              .pipe(Effect.provide(lane.fetchClient)),
            "Forbidden",
          );
          const ledger = yield* backend.ledger;
          expect(ledger.map(({ method, target }) => [method, target])).toEqual([
            ["MKCOL", "/dav/documents/archive/"],
            ["MKCOL", "/dav/documents/drafts/"],
          ]);
        }),
    );
  });

  describe("a GET with a SOAP body", () => {
    for (const [client, layer] of lane.clients)
      it.live(
        `[STAT-12] the documented GET download with a SOAP body is refused before dispatch (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const download = Operation.make(
              Request.get("soap/download").pipe(
                Request.baseUrl(backend.origin),
                Request.setHeader(
                  "SOAPAction",
                  `"${Actions.DownloadDocument.uri}"`,
                ),
                Request.body(Soap.Soap11.body(Actions.DownloadDocument)),
              ),
              Response.status(200, Body.bytes),
            );
            const error = yield* download
              .execute({ body: { id: "DOC-000001" } })
              .pipe(Effect.provide(layer), Effect.flip);
            expect(as(error, "InvalidRequest").message).toBe(
              "GET cannot carry a request body",
            );
            expect(yield* backend.ledger).toEqual([]);
          }),
      );

    it.live(
      "[STAT-12] POST does not reach the download servlet either: 405 with Allow: GET",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const error = yield* Operation.make(
            Request.post("soap/download").pipe(
              Request.baseUrl(backend.origin),
              Request.setHeader(
                "SOAPAction",
                `"${Actions.DownloadDocument.uri}"`,
              ),
              Request.body(Soap.Soap11.body(Actions.DownloadDocument)),
            ),
            Response.status(200, Body.bytes),
          )
            .execute({ body: { id: "DOC-000001" } })
            .pipe(Effect.provide(lane.fetchClient), Effect.flip);
          const unexpected = as(error, "UnexpectedResponse");
          expect(unexpected.metadata.status).toBe(405);
          expect(unexpected.metadata.headers["allow"]).toBe("GET");
          expect(yield* backend.ledger).toHaveLength(1);
        }),
    );
  });

  describe("content types and encodings", () => {
    it.live(
      "[HDR-5e] SOAP 1.1 replies are Latin-1 bytes under a charset-less text/xml; UTF-8 text decoding corrupts them silently",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const origin = backend.origin;
          const id = yield* idOf(origin, "Prüfbericht.txt", lane.fetchClient);
          const request = Soap.Soap11.request(Actions.FetchDocument).pipe(
            Request.baseUrl(origin),
          );
          const fetch = <A, E>(decoder: Body.Decoder<A, E>) =>
            Operation.make(request, Response.status(200, decoder))
              .execute({ body: { id } })
              .pipe(Effect.provide(lane.fetchClient));
          const title = "Prüfbericht für Café Größe – 5 €";

          // The fixture as sent: no charset, ISO-8859-1 bytes, references above U+00FF.
          const raw = yield* fetch(Response.tag("Raw", Body.bytes));
          expect(raw.metadata.headers["content-type"]).toBe("text/xml");
          const text = latin1(raw.value);
          expect(text).toMatch(
            /^<\?xml version="1.0" encoding="ISO-8859-1"\?>/,
          );
          expect(text).toContain(
            "<Title>Prüfbericht für Café Größe &#8211; 5 &#8364;</Title>",
          );
          expect(raw.value).toContain(0xfc);

          // Text decoding as UTF-8 succeeds and replaces every Latin-1 letter: an invisible failure.
          const lenient = as(
            yield* fetch(
              Body.text.pipe(
                Body.schema(
                  XmlSchema.ElementFromText.pipe(
                    Schema.decodeTo(
                      Soap.Soap11.envelope(Actions.FetchDocument.output),
                    ),
                  ),
                ),
              ),
            ),
            "Fetched",
          );
          expect(lenient.document.title).toBe(
            "Pr�fbericht f�r Caf� Gr��e – 5 €",
          );

          // A strict UTF-8 decoder that ignores the declaration fails visibly instead.
          const StrictUtf8 = Schema.Uint8Array.pipe(
            Schema.decodeTo(
              Schema.String,
              SchemaTransformation.transformEffect({
                decode: (bytes, options) =>
                  Effect.try({
                    try: () =>
                      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                    catch: () =>
                      new SchemaIssue.InvalidValue(
                        { message: "not UTF-8" },
                        bytes,
                        options,
                      ),
                  }),
                encode: (value) => Effect.succeed(encoder.encode(value)),
              }),
            ),
          );
          const strict = yield* fetch(
            Body.bytes.pipe(
              Body.schema(
                StrictUtf8.pipe(
                  Schema.decodeTo(XmlSchema.ElementFromText),
                  Schema.decodeTo(
                    Soap.Soap11.envelope(Actions.FetchDocument.output),
                  ),
                ),
              ),
            ),
          ).pipe(Effect.flip);
          expect(as(strict, "DecodeError").metadata.status).toBe(200);

          // Reading the declaration recovers the text exactly.
          const exact = as(
            yield* Actions.operations(origin)
              .fetchDocument.execute({ body: { id } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Fetched",
          );
          expect(exact.document.title).toBe(title);
          expect(yield* backend.ledger).toHaveLength(5);
        }),
    );

    it.live(
      "[PAY-4a] reads ISO-8859-1 from the reply's own declaration, character references included",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const listed = as(
            yield* Actions.operations(backend.origin)
              .listDocuments.execute({ body: { prefix: "Prüf" } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Listed",
          );
          expect(
            listed.documents.map(({ name, title }) => [name, title]),
          ).toEqual([["Prüfbericht.txt", "Prüfbericht für Café Größe – 5 €"]]);
          // The request went out as UTF-8 and said so.
          const [recorded] = yield* backend.ledger;
          expect(header(recorded!.lines, "content-type")).toBe(
            "text/xml; charset=utf-8",
          );
          expect(latin1(recorded!.body)).toContain("<Prefix>PrÃ¼f</Prefix>");
        }),
    );

    it.live(
      "[PAY-4a] the store refuses characters XML does not allow, raw or as references, with plain-text 400",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const titles = ["A\u0000B", "A&#0;B", "A&#x1F;B", "A&#xFFFE;B"];
          for (const [index, title] of titles.entries()) {
            const refused = as(
              yield* rawSoap11(backend.origin, `"${NS}#StoreDocument"`)
                .execute({ body: storeEnvelope(`bad-${index}.txt`, title) })
                .pipe(Effect.provide(lane.fetchClient)),
              "Refused",
            );
            expect(refused.value).toMatch(/^Malformed XML: /);
          }
          // The raw NUL really went out, and nothing was stored.
          const ledger = yield* backend.ledger;
          expect(ledger).toHaveLength(titles.length);
          expect(ledger[0]!.body).toContain(0);
          const listed = as(
            yield* Actions.operations(backend.origin)
              .listDocuments.execute({ body: { prefix: "bad-" } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Listed",
          );
          expect(listed.documents).toEqual([]);
        }),
    );

    it.live(
      "[PAY-4a] a title XML cannot carry is refused by the consumer before dispatch",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          for (const title of ["A\u0000B", "A\u{FFFE}B", "A\uD800B"]) {
            const error = yield* Actions.operations(backend.origin)
              .storeDocument.execute({
                body: {
                  name: "nul.txt",
                  title,
                  contentType: "text/plain",
                  content: encoder.encode("x"),
                },
              })
              .pipe(Effect.provide(lane.fetchClient), Effect.flip);
            expect(error._tag).toBe("SchemaError");
            expect(String(error)).toContain("cannot be written in XML");
          }
          expect(yield* backend.ledger).toEqual([]);
        }),
    );

    it.live(
      "[PAY-4a] the store reads a title's line ends as LF, and a carriage return written as a reference survives the round trip",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const soap = Actions.operations(backend.origin);
          const stored = as(
            yield* rawSoap11(backend.origin, `"${NS}#StoreDocument"`)
              .execute({
                body: storeEnvelope("lines.txt", "Zeile 1\r\nZeile 2\rZeile 3"),
              })
              .pipe(Effect.provide(lane.fetchClient)),
            "Answered",
          );
          expect(latin1(stored.value)).toContain("<FaultCode>0</FaultCode>");
          const id = yield* idOf(backend.origin, "lines.txt", lane.fetchClient);
          const fetched = as(
            yield* soap.fetchDocument
              .execute({ body: { id } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Fetched",
          );
          expect(fetched.document.title).toBe("Zeile 1\nZeile 2\nZeile 3");

          // Through the consumer, a CR is written as a reference, stored, and sent back as one.
          const kept = as(
            yield* soap.storeDocument
              .execute({
                body: {
                  name: "cr.txt",
                  title: "A\r\nB",
                  contentType: "text/plain",
                  content: encoder.encode("x"),
                },
              })
              .pipe(Effect.provide(lane.fetchClient)),
            "Stored",
          );
          const raw = yield* Operation.make(
            Soap.Soap11.request(Actions.FetchDocument).pipe(
              Request.baseUrl(backend.origin),
            ),
            Response.status(200, Body.bytes),
          )
            .execute({ body: { id: kept.id } })
            .pipe(Effect.provide(lane.fetchClient));
          expect(latin1(raw)).toContain("<Title>A&#xD;\nB</Title>");
          const back = as(
            yield* soap.fetchDocument
              .execute({ body: { id: kept.id } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Fetched",
          );
          expect(back.document.title).toBe("A\r\nB");
          const ledger = yield* backend.ledger;
          expect(bodyText(ledger[3]!)).toContain("<Title>A&#13;\nB</Title>");
        }),
    );

    for (const [client, layer] of lane.clients)
      it.live(
        `[HDR-5f] SOAP 1.2 carries the action in the codec's content type and sends no SOAPAction (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const soap = Actions.operations(backend.origin, Soap.Soap12);
            const content = encoder.encode("Kosten: 5 €\n");
            const stored = as(
              yield* soap.storeDocument
                .execute({
                  body: {
                    name: "kosten.txt",
                    title: "Kosten – 5 €",
                    contentType: "text/plain",
                    content,
                  },
                })
                .pipe(Effect.provide(layer)),
              "Stored",
            );
            const fetched = as(
              yield* soap.fetchDocument
                .execute({ body: { id: stored.id } })
                .pipe(Effect.provide(layer)),
              "Fetched",
            );
            expect(fetched.document.title).toBe("Kosten – 5 €");
            expect(fetched.document.content).toEqual(content);
            as(
              yield* soap.lockDocument
                .execute({
                  body: { id: stored.id, owner: "alice", seconds: 60 },
                })
                .pipe(Effect.provide(layer)),
              "Locked",
            );
            const conflict = as(
              yield* soap.lockDocument
                .execute({ body: { id: stored.id, owner: "bob", seconds: 60 } })
                .pipe(Effect.provide(layer)),
              "LockConflict",
            );
            expect(conflict.code).toBe("Receiver");
            const ledger = yield* backend.ledger;
            expect(ledger.map(bodyElement)).toEqual([
              "StoreDocument",
              "FetchDocument",
              "LockDocument",
              "LockDocument",
            ]);
            for (const recorded of ledger) {
              expect(headerValues(recorded.lines, "soapaction")).toEqual([]);
              expect(headerValues(recorded.lines, "content-type")).toEqual([
                `application/soap+xml; charset=utf-8; action="${NS}#${bodyElement(recorded)}"`,
              ]);
              expect(bodyText(recorded)).toContain(`xmlns:env="${SOAP12}"`);
            }
          }),
      );

    for (const [client, layer] of lane.clients)
      it.live(
        `[HDR-5f] a Content-Type declaration does not relabel a SOAP 1.1 body as SOAP 1.2 (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const relabelled = Operation.make(
              Request.post("soap").pipe(
                Request.baseUrl(backend.origin),
                Request.setHeader(
                  "Content-Type",
                  `application/soap+xml; charset=utf-8; action="${NS}#FetchDocument"`,
                ),
                Request.body(Soap.Soap11.body(Actions.FetchDocument)),
              ),
              Response.status(200, Soap.Soap12.decoder(Actions.FetchDocument)),
            );
            const error = yield* relabelled
              .execute({ body: { id: "DOC-000001" } })
              .pipe(Effect.provide(layer), Effect.flip);
            // The codec's text/xml went out, so the store read SOAP 1.1 without a SOAPAction.
            expect(as(error, "UnexpectedResponse").metadata.status).toBe(400);
            const [recorded] = yield* backend.ledger;
            expect(headerValues(recorded!.lines, "content-type")).toEqual([
              "text/xml; charset=utf-8",
            ]);
            expect(bodyText(recorded!)).toContain(`xmlns:soap="${SOAP11}"`);
          }),
      );
  });

  describe("SOAPAction", () => {
    for (const [client, layer] of lane.clients)
      it.live(
        `[HDR-6] every action declares one quoted SOAPAction naming its body element (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const soap = Actions.operations(backend.origin);
            const stored = as(
              yield* soap.storeDocument
                .execute({
                  body: {
                    name: "memo.txt",
                    title: "Memo",
                    contentType: "text/plain",
                    content: encoder.encode("memo"),
                  },
                })
                .pipe(Effect.provide(layer)),
              "Stored",
            );
            yield* soap.fetchDocument
              .execute({ body: { id: stored.id } })
              .pipe(Effect.provide(layer));
            yield* soap.listDocuments
              .execute({ body: { prefix: "memo" } })
              .pipe(Effect.provide(layer));
            yield* soap.lockDocument
              .execute({ body: { id: stored.id, owner: "alice", seconds: 5 } })
              .pipe(Effect.provide(layer));
            const ledger = yield* backend.ledger;
            expect(ledger.map(bodyElement)).toEqual([
              "StoreDocument",
              "FetchDocument",
              "ListDocuments",
              "LockDocument",
            ]);
            for (const recorded of ledger)
              expect(headerValues(recorded.lines, "soapaction")).toEqual([
                `"${NS}#${bodyElement(recorded)}"`,
              ]);
          }),
      );

    it.live(
      "[HDR-6] the front controller refuses a missing, unquoted or mismatched SOAPAction with plain-text 400",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const fetchWith = (
            frame: (
              request: Request.Request<unknown>,
            ) => Request.Request<unknown>,
          ) =>
            Operation.make(
              Request.post("soap").pipe(
                Request.baseUrl(backend.origin),
                frame,
                Request.body(Soap.Soap11.body(Actions.FetchDocument)),
              ),
              Response.status(200, Soap.Soap11.decoder(Actions.FetchDocument)),
            )
              .execute({ body: { id: "DOC-000001" } })
              .pipe(Effect.provide(lane.fetchClient), Effect.flip);
          for (const frame of [
            (request: Request.Request<unknown>) => request,
            Request.setHeader("SOAPAction", `${NS}#FetchDocument`),
            Request.setHeader("SOAPAction", `"${NS}#StoreDocument"`),
          ]) {
            const error = yield* fetchWith(frame);
            const unexpected = as(error, "UnexpectedResponse");
            expect(unexpected.metadata.status).toBe(400);
            expect(unexpected.metadata.headers["content-type"]).toBe(
              "text/plain",
            );
          }
          // Declaring the 400 shows what the controller says.
          const reason = yield* Operation.make(
            Request.post("soap").pipe(
              Request.baseUrl(backend.origin),
              Request.setHeader("SOAPAction", `${NS}#FetchDocument`),
              Request.body(Soap.Soap11.body(Actions.FetchDocument)),
            ),
            Response.status(400, Body.text),
          )
            .execute({ body: { id: "DOC-000001" } })
            .pipe(Effect.provide(lane.fetchClient));
          expect(reason).toMatch(/^SOAPAction must be a quoted string/);
          const ledger = yield* backend.ledger;
          expect(
            ledger.map((recorded) =>
              headerValues(recorded.lines, "soapaction"),
            ),
          ).toEqual([
            [],
            [`${NS}#FetchDocument`],
            [`"${NS}#StoreDocument"`],
            [`${NS}#FetchDocument`],
          ]);
        }),
    );
  });

  describe("repeated SOAPAction lines", () => {
    it.live(
      "[HDR-6] fetch joins two SOAPAction lines into one value, which the controller refuses as unquoted",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const reason = yield* Operation.make(
            Request.post("soap").pipe(
              Request.baseUrl(backend.origin),
              Request.appendHeader("SOAPAction", `"${NS}#FetchDocument"`),
              Request.appendHeader("SOAPAction", `"${NS}#FetchDocument"`),
              Request.body(Soap.Soap11.body(Actions.FetchDocument)),
            ),
            Response.status(400, Body.text),
          )
            .execute({ body: { id: "DOC-000001" } })
            .pipe(Effect.provide(lane.fetchClient));
          expect(reason).toMatch(/^SOAPAction must be a quoted string/);
          const [recorded] = yield* backend.ledger;
          expect(headerValues(recorded!.lines, "soapaction")).toEqual([
            `"${NS}#FetchDocument", "${NS}#FetchDocument"`,
          ]);
        }),
    );
  });

  describe("payload shapes", () => {
    it.live(
      "[PAY-3a] ListDocuments decodes zero, one wrapped and many items",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const list = (prefix: string) =>
            Actions.operations(backend.origin)
              .listDocuments.execute({ body: { prefix } })
              .pipe(
                Effect.provide(lane.fetchClient),
                Effect.map((listed) =>
                  as(listed, "Listed").documents.map(({ name }) => name),
                ),
              );
          expect(yield* list("memo")).toEqual([]);
          expect(yield* list("contract")).toEqual(["contract-acme.pdf"]);
          expect(yield* list("invoice")).toEqual([
            "invoice-2026-09.pdf",
            "invoice-2026-10.pdf",
          ]);
          // The three shapes as sent, read as text: their markup is ASCII.
          const raw = (prefix: string) =>
            Operation.make(
              Soap.Soap11.request(Actions.ListDocuments).pipe(
                Request.baseUrl(backend.origin),
              ),
              Response.status(200, Body.text),
            )
              .execute({ body: { prefix } })
              .pipe(Effect.provide(lane.fetchClient));
          const zero = yield* raw("memo");
          expect(zero).toContain("<Count>0</Count></ListDocumentsResult>");
          expect(zero).not.toContain("<Documents");
          expect(yield* raw("contract")).toContain(
            "<Count>1</Count><Documents><Item><DocumentInfo>",
          );
          expect(yield* raw("invoice")).toContain(
            "<Count>2</Count><Documents><DocumentInfo>",
          );
        }),
    );

    it.live(
      "[PAY-3a] an operation outside the store's namespace is refused, even when SOAPAction names the same namespace",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const attempts = [
            // The same wrong namespace in both places.
            rawSoap11(backend.origin, `"urn:wrong#ListDocuments"`).execute({
              body: envelope(SOAP11, listIn("urn:wrong")),
            }),
            rawSoap12(backend.origin, "urn:wrong#ListDocuments").execute({
              body: envelope(SOAP12, listIn("urn:wrong")),
            }),
            // No namespace at all, with an action naming none or the store's.
            rawSoap11(backend.origin, `"#ListDocuments"`).execute({
              body: envelope(SOAP11, listIn(undefined)),
            }),
            rawSoap11(backend.origin, `"${NS}#ListDocuments"`).execute({
              body: envelope(SOAP11, listIn(undefined)),
            }),
            // A neighbouring revision of the store's namespace.
            rawSoap11(
              backend.origin,
              `"urn:docvault:store:2009#ListDocuments"`,
            ).execute({
              body: envelope(SOAP11, listIn("urn:docvault:store:2009")),
            }),
          ];
          const reasons: Array<string> = [];
          for (const attempt of attempts)
            reasons.push(
              as(
                yield* attempt.pipe(Effect.provide(lane.fetchClient)),
                "Refused",
              ).value,
            );
          // The controller's plain-text reasons end with CRLF.
          expect(reasons).toEqual(
            ["urn:wrong", "urn:wrong", "", "", "urn:docvault:store:2009"].map(
              (namespace) =>
                `The body element {${namespace}}ListDocuments is not an operation of ${NS}\r\n`,
            ),
          );
          expect(yield* backend.ledger).toHaveLength(attempts.length);
        }),
    );

    it.live(
      "[PAY-3a] any prefix bound to the store's namespace dispatches, wherever the binding is declared",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const listed = Schema.decodeEffect(
            Soap.Soap11.document(Actions.ListDocuments.output),
          );
          const payloads = [
            `<d:ListDocuments xmlns:d="${NS}"><d:Prefix>contract</d:Prefix></d:ListDocuments>`,
            `<store:ListDocuments xmlns:store="${NS}"><Prefix>contract</Prefix></store:ListDocuments>`,
          ];
          for (const payload of payloads) {
            const answered = as(
              yield* rawSoap11(backend.origin, `"${NS}#ListDocuments"`)
                .execute({ body: envelope(SOAP11, payload) })
                .pipe(Effect.provide(lane.fetchClient)),
              "Answered",
            );
            const result = as(yield* listed(answered.value), "Listed");
            expect(result.documents.map((document) => document.name)).toEqual([
              "contract-acme.pdf",
            ]);
          }
          // A binding declared on the Envelope reaches the payload inside the Body.
          const inherited =
            `<?xml version="1.0" encoding="utf-8"?>` +
            `<soap:Envelope xmlns:soap="${SOAP11}" xmlns:dv="${NS}"><soap:Body>` +
            `<dv:ListDocuments><dv:Prefix>contract</dv:Prefix></dv:ListDocuments>` +
            `</soap:Body></soap:Envelope>`;
          const answered = as(
            yield* rawSoap11(backend.origin, `"${NS}#ListDocuments"`)
              .execute({ body: inherited })
              .pipe(Effect.provide(lane.fetchClient)),
            "Answered",
          );
          expect(
            as(yield* listed(answered.value), "Listed").documents,
          ).toHaveLength(1);
        }),
    );

    it.live(
      "[PAY-3a] a depth-1 multistatus lists the collection and its subcollections, which the listing skips",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const raw = yield* Operation.make(
            Request.make("PROPFIND", `${backend.origin}/dav/documents/`).pipe(
              Request.setHeader("Depth", "1"),
            ),
            Response.status(207, Response.tag("Raw", Body.text)),
          )
            .execute(undefined)
            .pipe(Effect.provide(lane.fetchClient));
          expect(raw.metadata.headers["content-type"]).toBe(
            'text/xml; charset="utf-8"',
          );
          expect(raw.value.match(/<D:collection\/>/g)).toHaveLength(3);
          expect(raw.value).toContain(
            "<D:href>/dav/documents/archive/</D:href>",
          );
          const propfind = WebDav.propfind(backend.origin);
          expect(
            (yield* propfind.execute("").pipe(Effect.provide(lane.fetchClient)))
              .length,
          ).toBe(4);
          expect(
            yield* propfind
              .execute("archive")
              .pipe(Effect.provide(lane.fetchClient)),
          ).toEqual([]);
          const targets = (yield* backend.ledger).map(({ target }) => target);
          expect(targets).toEqual([
            "/dav/documents/",
            "/dav/documents/",
            "/dav/documents/archive/",
          ]);
        }),
    );

    it.live(
      "[PAY-3a] the WSDL names every client action's URI in both bindings",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const description = as(
            yield* Wsdl.metadata(backend.origin)
              .execute(null)
              .pipe(Effect.provide(lane.fetchClient)),
            "Description",
          );
          expect(description.targetNamespace).toBe(NS);
          const actions = [
            Actions.StoreDocument,
            Actions.FetchDocument,
            Actions.ListDocuments,
            Actions.LockDocument,
          ].map(({ name, uri }) => ({ name, soapAction: uri }));
          expect(
            description.ports.map(({ version, address, operations }) => ({
              version,
              address,
              operations,
            })),
          ).toEqual([
            {
              version: "1.1",
              address: `${backend.origin}/soap`,
              operations: actions,
            },
            {
              version: "1.2",
              address: `${backend.origin}/soap`,
              operations: actions,
            },
          ]);
        }),
    );

    for (const [client, layer] of lane.clients)
      it.live(
        `[PAY-6] uploads a FormData with a Blob and a label (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
            const uploaded = as(
              yield* Files.upload(backend.origin)
                .execute({
                  label: "Grüße zum Quartal",
                  file: {
                    name: "Grüße 2026.pdf",
                    type: "application/pdf",
                    bytes,
                  },
                })
                .pipe(Effect.provide(layer)),
              "Uploaded",
            );
            expect(uploaded).toMatchObject({
              name: "Grüße 2026.pdf",
              label: "Grüße zum Quartal",
              size: 6,
            });
            const [recorded] = yield* backend.ledger;
            const contentType = header(recorded!.lines, "content-type") ?? "";
            const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(
              contentType,
            )?.[1];
            expect(boundary).toBeDefined();
            const body = latin1(recorded!.body);
            expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
            expect(body).toContain(
              'Content-Disposition: form-data; name="label"\r\n\r\nGrÃ¼Ã\u009fe zum Quartal\r\n',
            );
            expect(body).toContain(
              'Content-Disposition: form-data; name="file"; filename="GrÃ¼Ã\u009fe 2026.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF\u0000ÿ\r\n',
            );
            const stored = as(
              yield* WebDav.read(backend.origin)
                .execute({ name: "Grüße 2026.pdf" })
                .pipe(Effect.provide(layer)),
              "Content",
            );
            expect(stored.bytes).toEqual(bytes);
            expect(stored.etag).toEqual(uploaded.etag);
          }),
      );

    it.live(
      "[PAY-6] a blank label is refused by the input schema before dispatch",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const error = yield* Files.upload(backend.origin)
            .execute({
              label: "   ",
              file: {
                name: "blank.pdf",
                type: "application/pdf",
                bytes: encoder.encode("%PDF"),
              },
            })
            .pipe(Effect.provide(lane.fetchClient), Effect.flip);
          expect(error._tag).toBe("SchemaError");
          expect(yield* backend.ledger).toEqual([]);
        }),
    );

    for (const [client, layer] of lane.clients)
      it.live(
        `[PAY-6] reads a multipart bundle whose parts are awaited inside the schema (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const id = yield* idOf(backend.origin, "Prüfbericht.txt", layer);
            const bundle = Files.bundle(backend.origin);
            const found = as(
              yield* bundle.execute(id).pipe(Effect.provide(layer)),
              "Bundle",
            );
            expect(found.metadata).toEqual({
              id,
              name: "Prüfbericht.txt",
              title: "Prüfbericht für Café Größe – 5 €",
              contentType: "text/plain",
              size: encoder.encode("Prüfung bestanden.\n").length,
              etag: found.metadata.etag,
              modified: "2026-10-01T09:30:00Z",
            });
            expect(found.fileName).toBe("Prüfbericht.txt");
            expect(found.contentType).toBe("text/plain");
            expect(found.content).toEqual(
              encoder.encode("Prüfung bestanden.\n"),
            );
            as(
              yield* bundle.execute("DOC-999999").pipe(Effect.provide(layer)),
              "Missing",
            );
            const ledger = yield* backend.ledger;
            expect(ledger.slice(1).map(({ target }) => target)).toEqual([
              `/bundle/${id}`,
              "/bundle/DOC-999999",
            ]);
            expect(header(ledger[1]!.lines, "accept")).toContain(
              "multipart/form-data",
            );
          }),
      );

    for (const [client, layer] of lane.clients)
      it.live(
        `[PAY-7] uploads raw bytes with the file name in the query and decodes the one-line receipt (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const bytes = new Uint8Array([
              0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x00, 0xff,
            ]);
            const upload = Files.uploadRaw(backend.origin);
            const receipt = as(
              yield* upload
                .execute({ name: "Scan 2026 Größe.pdf", bytes })
                .pipe(Effect.provide(layer)),
              "Receipt",
            );
            expect(receipt.size).toBe(bytes.length);
            const stored = as(
              yield* WebDav.read(backend.origin)
                .execute({ name: "Scan 2026 Größe.pdf" })
                .pipe(Effect.provide(layer)),
              "Content",
            );
            expect(stored).toEqual({
              _tag: "Content",
              bytes,
              contentType: "application/pdf",
              etag: receipt.etag,
            });
            as(
              yield* upload
                .execute({ name: "Scan 2026 Größe.pdf", bytes })
                .pipe(Effect.provide(layer)),
              "Conflict",
            );
            const [recorded] = yield* backend.ledger;
            expect(recorded!.method).toBe("POST");
            expect(recorded!.target).toBe(
              "/upload/raw?name=Scan%202026%20Gr%C3%B6%C3%9Fe.pdf",
            );
            expect(header(recorded!.lines, "content-type")).toBe(
              "application/octet-stream",
            );
            expect(recorded!.body).toEqual(bytes);
          }),
      );
  });

  describe("query strings", () => {
    for (const [client, layer] of lane.clients)
      it.live(
        `[QRY-1] ?wsdl and ?wsdl= are different requests (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const metadata = Wsdl.metadata(backend.origin);
            const description = as(
              yield* metadata.execute(null).pipe(Effect.provide(layer)),
              "Description",
            );
            expect(description.name).toBe("DocVault");
            expect(
              yield* metadata.execute("").pipe(Effect.provide(layer)),
            ).toEqual({ _tag: "NoSuchPart", reason: "No WSDL part named ''" });
            // A query string in the URL keeps the bare key as well.
            const fromUrl = yield* Operation.make(
              Request.get(`${backend.origin}/soap?wsdl`),
              Response.status(200, Body.text),
            )
              .execute(undefined)
              .pipe(Effect.provide(layer));
            expect(fromUrl).toContain("<wsdl:definitions");
            expect((yield* backend.ledger).map(({ target }) => target)).toEqual(
              ["/soap?wsdl", "/soap?wsdl=", "/soap?wsdl"],
            );
          }),
      );

    for (const [client, layer] of lane.clients)
      it.live(
        `[QRY-1] currently, client middleware that appends a URL parameter re-serialises the query and ?wsdl becomes ?wsdl= (#24); editing the URL text keeps it (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const described = (
              transformClient: (
                client: HttpClient.HttpClient,
              ) => HttpClient.HttpClient,
            ) =>
              Operation.make(
                Request.get(`${backend.origin}/soap?wsdl`),
                Response.when(() => true, Body.text),
                { transformClient },
              )
                .execute(undefined)
                .pipe(Effect.provide(layer));
            // Effect builds the dispatch URL with URLSearchParams when a request carries
            // parameters, which writes the whole query again as form data.
            const byParameter = yield* described(
              HttpClient.mapRequest(
                HttpClientRequest.appendUrlParam("client", "suite"),
              ),
            );
            const byText = yield* described(
              HttpClient.mapRequest((request) =>
                HttpClientRequest.setUrl(
                  request,
                  `${request.url}&client=suite`,
                ),
              ),
            );
            expect(byParameter).not.toContain("<wsdl:definitions");
            expect(byText).toContain("<wsdl:definitions");
            expect((yield* backend.ledger).map(({ target }) => target)).toEqual(
              ["/soap?wsdl=&client=suite", "/soap?wsdl&client=suite"],
            );
          }),
      );

    it.live(
      "[QRY-1] ?wsdl=types names the schema part, which the WSDL contract refuses as a decode error",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const error = yield* Wsdl.metadata(backend.origin)
            .execute("types")
            .pipe(Effect.provide(lane.fetchClient), Effect.flip);
          const decode = as(error, "DecodeError");
          expect(decode.metadata.status).toBe(200);
          expect(String(decode.cause)).toContain("definitions");
          expect((yield* backend.ledger)[0]!.target).toBe("/soap?wsdl=types");
        }),
    );
  });

  describe("entity tags", () => {
    for (const [client, layer] of lane.clients)
      it.live(
        `[RET-3] If-None-Match with the current ETag yields 304 and no body (${client})`,
        () =>
          Effect.gen(function* () {
            const backend = yield* start();
            const read = WebDav.read(backend.origin);
            const first = as(
              yield* read
                .execute({ name: "invoice-2026-09.pdf" })
                .pipe(Effect.provide(layer)),
              "Content",
            );
            expect(first.bytes).toEqual(encoder.encode("%PDF-1.4 invoice 09"));
            expect(
              yield* read
                .execute({
                  name: "invoice-2026-09.pdf",
                  ifNoneMatch: first.etag,
                })
                .pipe(Effect.provide(layer)),
            ).toEqual({ _tag: "NotModified", etag: first.etag });
            as(
              yield* read
                .execute({
                  name: "invoice-2026-09.pdf",
                  ifNoneMatch: { weak: false, opaque: "older" },
                })
                .pipe(Effect.provide(layer)),
              "Content",
            );
            const [plain, conditional, stale] = yield* backend.ledger;
            expect(header(plain!.lines, "if-none-match")).toBeUndefined();
            expect(headerValues(conditional!.lines, "if-none-match")).toEqual([
              `"${first.etag.opaque}"`,
            ]);
            expect(headerValues(stale!.lines, "if-none-match")).toEqual([
              '"older"',
            ]);
          }),
      );

    it.live(
      "[RET-3] validators guard writes: 201 to create, 204 to replace, 412 for a replaced or weak tag, 428 without one",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const write = WebDav.write(backend.origin);
          const put = (condition: WebDav.Condition, text: string) =>
            write
              .execute({
                name: "notes.txt",
                contentType: "text/plain",
                bytes: encoder.encode(text),
                condition,
              })
              .pipe(Effect.provide(lane.fetchClient));
          const created = as(yield* put({ _tag: "Create" }, "v1"), "Created");
          as(yield* put({ _tag: "Create" }, "again"), "PreconditionFailed");
          const replaced = as(
            yield* put({ _tag: "Replace", etag: created.etag }, "v2"),
            "Replaced",
          );
          expect(replaced.etag).not.toEqual(created.etag);
          as(
            yield* put({ _tag: "Replace", etag: created.etag }, "lost update"),
            "PreconditionFailed",
          );
          as(
            yield* put(
              { _tag: "Replace", etag: { ...replaced.etag, weak: true } },
              "weak",
            ),
            "PreconditionFailed",
          );
          as(
            yield* put({ _tag: "Unconditional" }, "blind"),
            "PreconditionRequired",
          );
          const current = as(
            yield* WebDav.read(backend.origin)
              .execute({ name: "notes.txt" })
              .pipe(Effect.provide(lane.fetchClient)),
            "Content",
          );
          expect(current).toEqual({
            _tag: "Content",
            bytes: encoder.encode("v2"),
            contentType: "text/plain",
            etag: replaced.etag,
          });
          const ledger = yield* backend.ledger;
          expect(
            ledger
              .slice(0, 6)
              .map((recorded) => [
                header(recorded.lines, "if-match") ?? null,
                header(recorded.lines, "if-none-match") ?? null,
              ]),
          ).toEqual([
            [null, "*"],
            [null, "*"],
            [`"${created.etag.opaque}"`, null],
            [`"${created.etag.opaque}"`, null],
            [`W/"${replaced.etag.opaque}"`, null],
            [null, null],
          ]);
        }),
    );

    it.live(
      "[RET-3] the ETag StoreDocument returns guards the same document's WebDAV write",
      () =>
        Effect.gen(function* () {
          const backend = yield* start();
          const soap = Actions.operations(backend.origin);
          const stored = as(
            yield* soap.storeDocument
              .execute({
                body: {
                  name: "shared.txt",
                  title: "Shared",
                  contentType: "text/plain",
                  content: encoder.encode("soap"),
                },
              })
              .pipe(Effect.provide(lane.fetchClient)),
            "Stored",
          );
          const replaced = as(
            yield* WebDav.write(backend.origin)
              .execute({
                name: "shared.txt",
                contentType: "text/plain",
                bytes: encoder.encode("dav"),
                condition: { _tag: "Replace", etag: stored.etag },
              })
              .pipe(Effect.provide(lane.fetchClient)),
            "Replaced",
          );
          const fetched = as(
            yield* soap.fetchDocument
              .execute({ body: { id: stored.id } })
              .pipe(Effect.provide(lane.fetchClient)),
            "Fetched",
          );
          expect(fetched.document.etag).toEqual(replaced.etag);
          expect(fetched.document.content).toEqual(encoder.encode("dav"));
        }),
    );
  });
});
