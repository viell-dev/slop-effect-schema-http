import {
  Effect,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { HttpBody } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as Xml from "../../formats/xml.js";
import { AllowList, EntityTag } from "../../values/soap-store.js";
import { bytesAs, rejected } from "./common.js";
import {
  attempt,
  childElements,
  count,
  Element,
  ElementFromBytes,
  enter,
  expect,
  fields,
  resolve,
  type Scope,
  text,
} from "./xml.js";

/**
 * The store's WebDAV view, `/dav/documents/`. Methods are plain strings (`PROPFIND`, `MKCOL`) and
 * statuses plain numbers (207, 412, 428, 415, 405): nothing about them needs special support.
 */

const DAV = "DAV:";

/** A document in a multistatus listing. */
export const DavDocument = Schema.Struct({
  href: Schema.NonEmptyString,
  /** The last path segment of the href, percent-decoded. */
  name: Schema.NonEmptyString,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: Schema.String,
  etag: EntityTag,
  /** An HTTP-date as the store writes it; not interpreted. */
  lastModified: Schema.String,
});
export type DavDocument = typeof DavDocument.Type;

const required = [
  "getcontentlength",
  "getcontenttype",
  "getetag",
  "getlastmodified",
] as const;

const isDav = (element: Xml.Element, scope: Scope, local: string) =>
  Xml.localName(element.name) === local &&
  resolve(element.name, enter(element, scope)) === DAV;

const listing = (
  root: Xml.Element,
): ReadonlyArray<typeof DavDocument.Encoded> => {
  const scope = enter(root);
  expect(root, scope, DAV, "multistatus");
  const documents: Array<typeof DavDocument.Encoded> = [];
  for (const response of childElements(root)) {
    const inner = enter(response, scope);
    expect(response, inner, DAV, "response");
    const parts = childElements(response);
    const hrefs = parts.filter((part) => isDav(part, inner, "href"));
    const propstats = parts.filter((part) => isDav(part, inner, "propstat"));
    if (hrefs.length !== 1 || hrefs.length + propstats.length !== parts.length)
      throw new Error("a response holds one href and its propstats");
    const found = new Map<string, Xml.Element>();
    for (const propstat of propstats) {
      const { prop, status } = fields(propstat, ["prop", "status"]);
      const line = text(status);
      if (line.startsWith("HTTP/1.1 404 ")) continue;
      if (line !== "HTTP/1.1 200 OK")
        throw new Error(`unexpected propstat status ${line}`);
      const propScope = enter(prop, enter(propstat, inner));
      for (const property of childElements(prop))
        if (
          resolve(property.name, enter(property, propScope)) === DAV &&
          !found.has(Xml.localName(property.name))
        )
          found.set(Xml.localName(property.name), property);
    }
    const type = found.get("resourcetype");
    if (type === undefined) throw new Error("a response lacks resourcetype");
    const kinds = childElements(type);
    // Collections are skipped: the listing is of documents.
    if (kinds.some((kind) => isDav(kind, inner, "collection"))) continue;
    if (kinds.length > 0)
      throw new Error(`unknown resource type <${kinds[0]!.name}>`);
    for (const name of required)
      if (!found.has(name)) throw new Error(`a document lacks ${name}`);
    const href = text(hrefs[0]!);
    documents.push({
      href,
      name: decodeURIComponent(href.slice(href.lastIndexOf("/") + 1)),
      size: count(found.get("getcontentlength")!),
      contentType: text(found.get("getcontenttype")!),
      etag: text(found.get("getetag")!),
      lastModified: text(found.get("getlastmodified")!),
    });
  }
  return documents;
};

/**
 * A multistatus listing reduced to its documents. Decode-only: the listing drops the collections
 * and the properties they lack, so it cannot be written back as the multistatus it came from.
 */
export const Listing = Element.pipe(
  Schema.decodeTo(Schema.Array(DavDocument), {
    decode: SchemaGetter.transformEffect((root: Xml.Element, options) =>
      attempt(() => listing(root), root, options),
    ),
    encode: SchemaGetter.forbidden(
      () =>
        "a document listing drops the collections and their 404 propstats, so it cannot be written back as a multistatus",
    ),
  }),
);

const allprop = `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>`;

/** The `allprop` request body; the codec owns its XML content type. */
const allpropBody = Body.encoder<"allprop">(() =>
  Effect.sync(() => HttpBody.text(allprop, "application/xml; charset=utf-8")),
);

const collectionPath = (
  collection: string,
  encode: (value: string) => string,
) =>
  collection === "" ? "dav/documents/" : `dav/documents/${encode(collection)}/`;

/** `PROPFIND` with `Depth: 1` on a collection (`""` for the root), listing its documents. */
export const propfind = (origin: string) =>
  Operation.make(
    Request.make("PROPFIND", "dav/documents/").pipe(
      Request.baseUrl(origin),
      Request.setHeader("Depth", "1"),
      Request.path(Schema.String, collectionPath),
      Request.body(allpropBody),
      Request.mapInput((collection: string) => ({
        path: collection,
        body: "allprop" as const,
      })),
    ),
    Response.status(
      207,
      bytesAs("text/xml").pipe(
        Body.schema(ElementFromBytes.pipe(Schema.decodeTo(Listing))),
      ),
    ),
  );

const IfNoneMatch = Schema.Struct({
  ifNoneMatch: Schema.optionalKey(EntityTag),
}).pipe(Schema.encodeKeys({ ifNoneMatch: "if-none-match" }));

export const Content = Schema.TaggedStruct("Content", {
  bytes: Schema.Uint8Array,
  contentType: Schema.String,
  etag: EntityTag,
});

export const NotModified = Schema.TaggedStruct("NotModified", {
  etag: EntityTag,
});

/** Decode a response's headers (and bytes) with a schema whose encoded side is a plain record. */
const fromHeaders = <S extends Schema.Top>(
  schema: S,
  read: (
    headers: Readonly<Record<string, string | undefined>>,
    bytes: Uint8Array,
  ) => unknown,
  consume: "bytes" | "drain",
) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return Body.decoder((response) =>
    Effect.flatMap(
      consume === "bytes"
        ? Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer))
        : Effect.as(Body.empty.decode(response), new Uint8Array()),
      (bytes) => decode(read(response.headers, bytes)),
    ),
  );
};

/** A conditional GET: 200 with the bytes, or 304 when `ifNoneMatch` still matches. */
export const read = (origin: string) =>
  Operation.make(
    Request.get("dav/documents/").pipe(
      Request.baseUrl(origin),
      Request.headers(IfNoneMatch),
      Request.path(
        Schema.NonEmptyString,
        (name, encode) => `dav/documents/${encode(name)}`,
      ),
      Request.mapInput(
        (input: {
          readonly name: string;
          readonly ifNoneMatch?: EntityTag;
        }) => ({
          path: input.name,
          headers:
            input.ifNoneMatch === undefined
              ? {}
              : { ifNoneMatch: input.ifNoneMatch },
        }),
      ),
    ),
    Response.status(
      200,
      fromHeaders(
        Content,
        (headers, bytes) => ({
          _tag: "Content",
          bytes,
          contentType: headers["content-type"],
          etag: headers["etag"],
        }),
        "bytes",
      ),
    ).pipe(
      Response.orElse(
        Response.status(
          304,
          fromHeaders(
            NotModified,
            (headers) => ({ _tag: "NotModified", etag: headers["etag"] }),
            "drain",
          ),
        ),
      ),
      Response.orElse(Response.status(404, rejected("Missing"))),
    ),
  );

/**
 * The validator of a write. `Replace` sends `If-Match` with the tag, `Create` sends
 * `If-None-Match: *`, and `Unconditional` sends neither, which the store refuses with 428.
 */
export const Condition = Schema.Union([
  Schema.TaggedStruct("Replace", { etag: EntityTag }),
  Schema.TaggedStruct("Create", {}),
  Schema.TaggedStruct("Unconditional", {}),
]);
export type Condition = typeof Condition.Type;

const ConditionRecord = Schema.Struct({
  "if-match": Schema.optionalKey(Schema.String),
  "if-none-match": Schema.optionalKey(Schema.String),
});

/**
 * A {@link Condition} as request header fields. Decoding refuses both fields together, and an
 * `If-None-Match` other than `*`, which this client never sends on a write.
 */
export const ConditionHeaders = ConditionRecord.pipe(
  Schema.decodeTo(
    Condition,
    SchemaTransformation.transformEffect<
      typeof Condition.Encoded,
      typeof ConditionRecord.Type
    >({
      decode: (record, options) => {
        const ifMatch = record["if-match"];
        const ifNoneMatch = record["if-none-match"];
        if (ifMatch !== undefined && ifNoneMatch === undefined)
          return Effect.succeed({ _tag: "Replace" as const, etag: ifMatch });
        if (ifMatch === undefined && ifNoneMatch === "*")
          return Effect.succeed({ _tag: "Create" as const });
        if (ifMatch === undefined && ifNoneMatch === undefined)
          return Effect.succeed({ _tag: "Unconditional" as const });
        return Effect.fail(
          new SchemaIssue.InvalidValue(
            { message: "not a write condition this client sends" },
            record,
            options,
          ),
        );
      },
      encode: (condition) =>
        Effect.succeed(
          condition._tag === "Replace"
            ? { "if-match": condition.etag }
            : condition._tag === "Create"
              ? { "if-none-match": "*" }
              : {},
        ),
    }),
  ),
);

/** A PUT body: the bytes under their own content type, which the codec sets. */
const typedBytes = Body.encoder(
  (value: { readonly contentType: string; readonly bytes: Uint8Array }) =>
    Effect.sync(() => HttpBody.uint8Array(value.bytes, value.contentType)),
);

const validator = <const Tag extends string>(tag: Tag) =>
  fromHeaders(
    Schema.TaggedStruct(tag, { etag: EntityTag }),
    (headers) => ({ _tag: tag, etag: headers["etag"] }),
    "drain",
  );

/** A conditional PUT with every answer the store gives it declared. */
export const write = (origin: string) =>
  Operation.make(
    Request.put("dav/documents/").pipe(
      Request.baseUrl(origin),
      Request.headers(ConditionHeaders),
      Request.path(
        Schema.NonEmptyString,
        (name, encode) => `dav/documents/${encode(name)}`,
      ),
      Request.body(typedBytes),
      Request.mapInput(
        (input: {
          readonly name: string;
          readonly contentType: string;
          readonly bytes: Uint8Array;
          readonly condition: Condition;
        }) => ({
          path: input.name,
          headers: input.condition,
          body: { contentType: input.contentType, bytes: input.bytes },
        }),
      ),
    ),
    Response.status(201, validator("Created")).pipe(
      Response.orElse(Response.status(204, validator("Replaced"))),
      Response.orElse(Response.status(412, rejected("PreconditionFailed"))),
      Response.orElse(Response.status(428, rejected("PreconditionRequired"))),
      Response.orElse(Response.status(415, rejected("UnsupportedMediaType"))),
    ),
  );

const AllowHeader = Schema.Struct({ allow: AllowList });

/** `MKCOL`, which the store's fixed layout refuses: 405 with `Allow` where something exists. */
export const mkcol = (origin: string) =>
  Operation.make(
    Request.make("MKCOL", "dav/documents/").pipe(
      Request.baseUrl(origin),
      Request.path(Schema.String, collectionPath),
      Request.mapInput((collection: string) => ({ path: collection })),
    ),
    Response.status(
      201,
      Body.empty.pipe(Body.map(() => ({ _tag: "Created" }) as const)),
    ).pipe(
      Response.orElse(
        Response.status(
          405,
          fromHeaders(
            AllowHeader,
            (headers) => ({ allow: headers["allow"] }),
            "drain",
          ).pipe(
            Body.map(
              ({ allow }) => ({ _tag: "MethodNotAllowed", allow }) as const,
            ),
          ),
        ),
      ),
      Response.orElse(Response.status(403, rejected("Forbidden"))),
    ),
  );
