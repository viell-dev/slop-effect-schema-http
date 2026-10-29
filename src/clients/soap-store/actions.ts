import { Data, Effect, Schema } from "effect";
import { Operation, Request, Response } from "viell-effect-schema-http";
import * as Xml from "../../formats/xml.js";
import { EntityTag } from "../../values/soap-store.js";
import { action, Namespace, type Protocol, Soap11 } from "./soap.js";
import {
  childElements,
  count,
  enter,
  expect,
  fields,
  leaf,
  mapping,
  text,
} from "./xml.js";

/**
 * The store's SOAP actions. Every action except `LockDocument` answers HTTP 200 and reports its
 * outcome in `<FaultCode>`, where zero means success, so its result is a union decided by the body:
 * the action's success or {@link Refused}. `LockDocument` uses real SOAP faults under HTTP 500 and
 * declares one more response rule.
 */

/** A nonzero `FaultCode` with its `FaultString`. */
export const Refused = Schema.TaggedStruct("Refused", {
  code: Schema.Int.check(
    Schema.makeFilter((code: number) => code !== 0 || "a refusal is nonzero"),
  ),
  message: Schema.String,
});
export type Refused = typeof Refused.Type;

const Size = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DocumentInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  title: Schema.String,
  contentType: Schema.String,
  size: Size,
  etag: EntityTag,
  /** xsd:dateTime as the store writes it; not interpreted. */
  modified: Schema.String,
});
export type DocumentInfo = typeof DocumentInfo.Type;

const infoNames = [
  "Id",
  "Name",
  "Title",
  "ContentType",
  "Size",
  "ETag",
  "Modified",
] as const;

type InfoEncoded = typeof DocumentInfo.Encoded;

const readInfo = (
  found: Readonly<Record<(typeof infoNames)[number], Xml.Element>>,
): InfoEncoded => ({
  id: text(found.Id),
  name: text(found.Name),
  title: text(found.Title),
  contentType: text(found.ContentType),
  size: count(found.Size),
  etag: text(found.ETag),
  modified: text(found.Modified),
});

const writeInfo = (info: InfoEncoded): ReadonlyArray<Xml.Element> => [
  leaf("Id", info.id),
  leaf("Name", info.name),
  leaf("Title", info.title),
  leaf("ContentType", info.contentType),
  leaf("Size", String(info.size)),
  leaf("ETag", info.etag),
  leaf("Modified", info.modified),
];

/** An action payload element `{store namespace}name` declaring its own default namespace. */
const payload = (
  element: Xml.Element,
  name: string,
): Readonly<Record<string, never>> => {
  expect(element, enter(element), Namespace, name);
  return {};
};

const code = (element: Xml.Element): number => {
  const value = text(element);
  if (!/^(0|-?[1-9]\d{0,9})$/.test(value))
    throw new Error(`FaultCode is not an integer: ${value}`);
  return Number(value);
};

/**
 * A 2003-style result: `<NameResponse><NameResult>` holding `FaultCode` and `FaultString`, then the
 * success fields when the code is zero. A refusal carries no other field. The `FaultString` of a
 * success is informational and not kept; encoding writes `OK`.
 */
const result = <S extends Schema.Top>(
  name: string,
  success: S,
  body: {
    readonly required: ReadonlyArray<string>;
    readonly optional?: ReadonlyArray<string>;
    readonly read: (
      found: Readonly<Record<string, Xml.Element | undefined>>,
    ) => S["Encoded"];
    readonly write: (value: S["Encoded"]) => ReadonlyArray<Xml.Element>;
  },
) =>
  mapping(Schema.Union([success, Refused]), {
    decode: (element) => {
      payload(element, `${name}Response`);
      const inner = fields(element, [`${name}Result`])[`${name}Result`]!;
      const head = fields(
        inner,
        ["FaultCode", "FaultString"],
        [...body.required, ...(body.optional ?? [])],
      );
      const value = code(head["FaultCode"]!);
      if (value !== 0) {
        fields(inner, ["FaultCode", "FaultString"]);
        return {
          _tag: "Refused",
          code: value,
          message: text(head["FaultString"]!),
        } satisfies typeof Refused.Encoded;
      }
      const found = fields(
        inner,
        ["FaultCode", "FaultString", ...body.required],
        body.optional ?? [],
      );
      return body.read(found);
    },
    encode: (value) => {
      const refused = value as typeof Refused.Encoded | S["Encoded"];
      const children =
        (refused as { readonly _tag?: unknown })._tag === "Refused"
          ? [
              leaf("FaultCode", String((refused as Refused).code)),
              leaf("FaultString", (refused as Refused).message),
            ]
          : [
              leaf("FaultCode", "0"),
              leaf("FaultString", "OK"),
              ...body.write(refused as S["Encoded"]),
            ];
      return Xml.element(
        `${name}Response`,
        { xmlns: Namespace },
        Xml.element(`${name}Result`, {}, ...children),
      );
    },
  });

// StoreDocument

export const StoreInput = Schema.Struct({
  name: Schema.NonEmptyString,
  title: Schema.String,
  contentType: Schema.NonEmptyString,
  content: Schema.Uint8ArrayFromBase64,
});
export type StoreInput = typeof StoreInput.Type;

export const Stored = Schema.TaggedStruct("Stored", {
  id: Schema.NonEmptyString,
  etag: EntityTag,
});

export const StoreDocument = action(
  "StoreDocument",
  mapping(StoreInput, {
    decode: (element) => {
      payload(element, "StoreDocument");
      const found = fields(element, [
        "Name",
        "Title",
        "ContentType",
        "Content",
      ]);
      return {
        name: text(found.Name),
        title: text(found.Title),
        contentType: text(found.ContentType),
        content: text(found.Content),
      };
    },
    encode: (input) =>
      Xml.element(
        "StoreDocument",
        { xmlns: Namespace },
        leaf("Name", input.name),
        leaf("Title", input.title),
        leaf("ContentType", input.contentType),
        leaf("Content", input.content),
      ),
  }),
  result("StoreDocument", Stored, {
    required: ["DocumentId", "ETag"],
    read: (found) => ({
      _tag: "Stored" as const,
      id: text(found["DocumentId"]!),
      etag: text(found["ETag"]!),
    }),
    write: (stored) => [
      leaf("DocumentId", stored.id),
      leaf("ETag", stored.etag),
    ],
  }),
);

// FetchDocument

export const ById = Schema.Struct({ id: Schema.NonEmptyString });

const byId = (name: string) =>
  mapping(ById, {
    decode: (element) => {
      payload(element, name);
      return { id: text(fields(element, ["Id"]).Id) };
    },
    encode: (input) =>
      Xml.element(name, { xmlns: Namespace }, leaf("Id", input.id)),
  });

export const Fetched = Schema.TaggedStruct("Fetched", {
  document: Schema.Struct({
    ...DocumentInfo.fields,
    content: Schema.Uint8ArrayFromBase64,
  }),
});

export const FetchDocument = action(
  "FetchDocument",
  byId("FetchDocument"),
  result("FetchDocument", Fetched, {
    required: ["Document"],
    read: (found) => {
      const document = fields(found["Document"]!, [...infoNames, "Content"]);
      return {
        _tag: "Fetched" as const,
        document: { ...readInfo(document), content: text(document.Content) },
      };
    },
    write: (fetched) => [
      Xml.element(
        "Document",
        {},
        ...writeInfo(fetched.document),
        leaf("Content", fetched.document.content),
      ),
    ],
  }),
);

// ListDocuments

export const Listed = Schema.TaggedStruct("Listed", {
  documents: Schema.Array(DocumentInfo),
});

const info = (element: Xml.Element): InfoEncoded => {
  if (Xml.localName(element.name) !== "DocumentInfo")
    throw new Error(`expected <DocumentInfo>, found <${element.name}>`);
  return readInfo(fields(element, infoNames));
};

const infoElement = (value: InfoEncoded): Xml.Element =>
  Xml.element("DocumentInfo", {}, ...writeInfo(value));

/**
 * Three shapes for one list: no `<Documents>` for zero items, the single item wrapped in `<Item>`,
 * and many items listed directly. `<Count>` must agree. Any other combination is refused, including
 * an empty `<Documents>` and an unwrapped single item.
 */
export const ListDocuments = action(
  "ListDocuments",
  mapping(Schema.Struct({ prefix: Schema.String }), {
    decode: (element) => {
      payload(element, "ListDocuments");
      return { prefix: text(fields(element, ["Prefix"]).Prefix) };
    },
    encode: (input) =>
      Xml.element(
        "ListDocuments",
        { xmlns: Namespace },
        leaf("Prefix", input.prefix),
      ),
  }),
  result("ListDocuments", Listed, {
    required: ["Count"],
    optional: ["Documents"],
    read: (found) => {
      const expected = count(found["Count"]!);
      const list = found["Documents"];
      if (expected === 0) {
        if (list !== undefined)
          throw new Error("an empty list omits <Documents>");
        return { _tag: "Listed" as const, documents: [] };
      }
      if (list === undefined)
        throw new Error(`<Count> is ${expected} but <Documents> is missing`);
      const items = childElements(list);
      if (expected === 1) {
        const wrapper = fields(list, ["Item"]).Item;
        const single = childElements(wrapper);
        if (single.length !== 1)
          throw new Error("<Item> wraps exactly one <DocumentInfo>");
        return { _tag: "Listed" as const, documents: [info(single[0]!)] };
      }
      if (items.length !== expected)
        throw new Error(
          `<Count> is ${expected} but ${items.length} are listed`,
        );
      return { _tag: "Listed" as const, documents: items.map(info) };
    },
    write: (listed) => {
      const items = listed.documents.map(infoElement);
      return [
        leaf("Count", String(items.length)),
        ...(items.length === 0
          ? []
          : items.length === 1
            ? [Xml.element("Documents", {}, Xml.element("Item", {}, items[0]!))]
            : [Xml.element("Documents", {}, ...items)]),
      ];
    },
  }),
);

// LockDocument

export const LockInput = Schema.Struct({
  id: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
});

export const Locked = Schema.TaggedStruct("Locked", {
  token: Schema.NonEmptyString,
  owner: Schema.String,
  expires: Schema.String,
});

/** `LockDocument`, the one action with real SOAP faults. Its result has no `FaultCode`. */
export const LockDocument = action(
  "LockDocument",
  mapping(LockInput, {
    decode: (element) => {
      payload(element, "LockDocument");
      const found = fields(element, ["Id", "Owner", "Seconds"]);
      return {
        id: text(found.Id),
        owner: text(found.Owner),
        seconds: count(found.Seconds),
      };
    },
    encode: (input) =>
      Xml.element(
        "LockDocument",
        { xmlns: Namespace },
        leaf("Id", input.id),
        leaf("Owner", input.owner),
        leaf("Seconds", String(input.seconds)),
      ),
  }),
  mapping(Locked, {
    decode: (element) => {
      payload(element, "LockDocumentResponse");
      const inner = fields(element, ["LockDocumentResult"]).LockDocumentResult;
      const found = fields(inner, ["LockToken", "Owner", "Expires"]);
      return {
        _tag: "Locked" as const,
        token: text(found.LockToken),
        owner: text(found.Owner),
        expires: text(found.Expires),
      };
    },
    encode: (locked) =>
      Xml.element(
        "LockDocumentResponse",
        { xmlns: Namespace },
        Xml.element(
          "LockDocumentResult",
          {},
          leaf("LockToken", locked.token),
          leaf("Owner", locked.owner),
          leaf("Expires", locked.expires),
        ),
      ),
  }),
);

/** The `DownloadDocument` envelope the download servlet reads from the body of a GET. */
export const DownloadDocument = {
  uri: `${Namespace}#DownloadDocument`,
  input: byId("DownloadDocument"),
};

/** One SOAP action as an operation against the store at `origin`. */
export const operation = <In, Out>(
  origin: string,
  soap: Protocol,
  definition: {
    readonly input: Schema.Codec<In, Xml.Element>;
    readonly output: Schema.Codec<Out, Xml.Element>;
    readonly name: string;
    readonly uri: string;
  },
) =>
  Operation.make(
    soap.request(definition).pipe(Request.baseUrl(origin)),
    Response.status(200, soap.decoder(definition)),
  );

/** `LockDocument`'s rules: success, then the one extra rule for real faults under HTTP 500. */
export const lockResponses = (soap: Protocol) =>
  Response.status(200, soap.decoder(LockDocument)).pipe(
    Response.orElse(Response.status(500, soap.faultDecoder)),
  );

/** The SOAP operations of the store at `origin`, in one protocol version. */
export const operations = (origin: string, soap: Protocol = Soap11) => ({
  storeDocument: operation(origin, soap, StoreDocument),
  fetchDocument: operation(origin, soap, FetchDocument),
  listDocuments: operation(origin, soap, ListDocuments),
  lockDocument: Operation.make(
    soap.request(LockDocument).pipe(Request.baseUrl(origin)),
    lockResponses(soap),
  ),
});

/** A nonzero `FaultCode`, moved into the failure channel. */
export class StoreRefused extends Data.TaggedError("StoreRefused")<{
  readonly code: number;
  readonly message: string;
}> {}

/** Move {@link Refused} results into the failure channel as {@link StoreRefused}. */
export const refusedAsFailure = <I, A, E, R>(
  self: Operation.Operation<I, A | Refused, E, R>,
): Operation.Operation<I, Exclude<A, Refused>, E | StoreRefused, R> =>
  self.pipe(
    Operation.mapEffect((value: A | Refused) =>
      (value as { readonly _tag?: unknown })._tag === "Refused"
        ? Effect.fail(
            new StoreRefused({
              code: (value as Refused).code,
              message: (value as Refused).message,
            }),
          )
        : Effect.succeed(value as Exclude<A, Refused>),
    ),
  );
