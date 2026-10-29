/**
 * The consumer's contract for the portal facade, the 2012 WCF JSON front of the document store that
 * the month-end saga publishes through (APP-2, step 5). Written from its observed wire behaviour:
 *
 * - the body wraps the data contract under the operation's parameter name, `document`, with
 *   PascalCase members and the bytes as an array of numbers from 0 to 255;
 * - success is `200` with the result under ASP.NET AJAX's `d` and a `__type` hint;
 * - a failure inside the operation is `500` flagged by `jsonerror: true`, a header rule declared
 *   ahead of everything else; the store's own fault codes arrive inside its message;
 * - a body the formatter cannot read is `400` (or `415` for another content type) with an HTML
 *   page, read for its exception message only.
 */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { EntityTag } from "../../values/soap-store.js";

const issue = (input: unknown, message: string) =>
  new SchemaIssue.InvalidValue({ message }, input);

/** `DataContractJsonSerializer`'s `byte[]`: a JSON array of integers from 0 to 255. */
export const ByteArray = Schema.Array(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
).pipe(
  Schema.decodeTo(
    Schema.Uint8Array,
    SchemaTransformation.transform<Uint8Array, ReadonlyArray<number>>({
      decode: (numbers) => Uint8Array.from(numbers),
      encode: (bytes) => Array.from(bytes),
    }),
  ),
);

/** The document to publish, with the facade's data-contract member names. */
export const Publication = Schema.Struct({
  name: Schema.NonEmptyString,
  title: Schema.String,
  contentType: Schema.NonEmptyString,
  content: ByteArray,
}).pipe(
  Schema.encodeKeys({
    name: "Name",
    title: "Title",
    contentType: "ContentType",
    content: "Content",
  }),
);
export type Publication = typeof Publication.Type;

/** The wrapped body style: the operation's parameter name around the data contract. */
export const PublishBody = Schema.Struct({ document: Publication });

/** The result under `d`, with the serializer's type hint checked rather than ignored. */
export const Published = Schema.Struct({
  d: Schema.Struct({
    __type: Schema.Literal("PublishResult:#DocVault.Portal"),
    DocumentId: Schema.NonEmptyString,
    ETag: EntityTag,
    Name: Schema.NonEmptyString,
  }),
}).pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Published", {
      id: Schema.NonEmptyString,
      etag: Schema.toType(EntityTag),
      name: Schema.NonEmptyString,
    }),
    SchemaTransformation.transform({
      decode: ({ d }) => ({
        _tag: "Published" as const,
        id: d.DocumentId,
        etag: d.ETag,
        name: d.Name,
      }),
      encode: ({ id, etag, name }) => ({
        d: {
          __type: "PublishResult:#DocVault.Portal" as const,
          DocumentId: id,
          ETag: etag,
          Name: name,
        },
      }),
    }),
  ),
);
export type Published = typeof Published.Type;

const StoreFaultType = "DocVault.Portal.StoreFaultException";

/** A store fault the facade relayed: the store's own code and message. */
export const StoreFault = Schema.TaggedStruct("StoreFault", {
  code: Schema.Int,
  message: Schema.String,
});

/** Any other failure inside the facade, by its .NET exception type. */
export const ServiceFault = Schema.TaggedStruct("ServiceFault", {
  type: Schema.NullOr(Schema.String),
  message: Schema.String,
});

const JsonError = Schema.Struct({
  ExceptionDetail: Schema.Null,
  ExceptionType: Schema.NullOr(Schema.String),
  Message: Schema.String,
  StackTrace: Schema.Null,
});

/**
 * `enableWebScript`'s JSON fault body. A relayed store fault reads as `DocVault <code>: <message>`;
 * every other exception type keeps its type and message.
 */
export const Fault = JsonError.pipe(
  Schema.decodeTo(
    Schema.Union([StoreFault, ServiceFault]),
    SchemaTransformation.transformEffect<
      typeof StoreFault.Type | typeof ServiceFault.Type,
      typeof JsonError.Type
    >({
      decode: (body) => {
        if (body.ExceptionType !== StoreFaultType)
          return Effect.succeed({
            _tag: "ServiceFault" as const,
            type: body.ExceptionType,
            message: body.Message,
          });
        const match = /^DocVault (-?\d+): (.*)$/s.exec(body.Message);
        return match === null
          ? Effect.fail(
              issue(
                body,
                "a relayed store fault reads `DocVault <code>: <message>`",
              ),
            )
          : Effect.succeed({
              _tag: "StoreFault" as const,
              code: Number(match[1]),
              message: match[2]!,
            });
      },
      encode: (fault) =>
        Effect.succeed({
          ExceptionDetail: null,
          ExceptionType:
            fault._tag === "StoreFault" ? StoreFaultType : fault.type,
          Message:
            fault._tag === "StoreFault"
              ? `DocVault ${fault.code}: ${fault.message}`
              : fault.message,
          StackTrace: null,
        }),
    }),
  ),
);
export type Fault = typeof Fault.Type;

/**
 * WCF's "Request Error" page, read for its exception message. One-way: the markup is not kept, so
 * a message cannot be encoded back into a page.
 */
export const RequestErrorPage = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (page: string) => {
        const message =
          /The exception message is '([\s\S]*?)'\. See server logs/.exec(
            page,
          )?.[1];
        return message === undefined
          ? Effect.fail(issue(page, "not a WCF Request Error page"))
          : Effect.succeed(
              message
                .replaceAll("&#39;", "'")
                .replaceAll("&lt;", "<")
                .replaceAll("&gt;", ">")
                .replaceAll("&amp;", "&"),
            );
      },
      encode: (message: string) =>
        Effect.fail(
          issue(
            message,
            "one-way: the page's markup is not kept, so a message cannot be encoded back into a page",
          ),
        ),
    }),
  ),
);

/** The facade's responses: the `jsonerror` header rule first, then success, then the formatter. */
export const publishResponse = Response.when(
  (metadata) =>
    metadata.status === 500 && metadata.headers["jsonerror"] === "true",
  Response.tag("Fault", Body.jsonSchema(Fault)),
).pipe(
  Response.orElse(Response.status(200, Body.jsonSchema(Published))),
  Response.orElse(
    Response.when(
      (metadata) => metadata.status === 400 || metadata.status === 415,
      Response.tag(
        "RequestError",
        Body.text.pipe(Body.schema(RequestErrorPage)),
      ),
    ),
  ),
);

/** `POST DocumentService.svc/Publish` on the facade at `origin`. The facade takes no credential. */
export const publish = (origin: string) =>
  Operation.make(
    Request.post("DocumentService.svc/Publish").pipe(
      Request.body(Body.jsonSchema(PublishBody)),
      Request.mapInput((document: Publication) => ({ body: { document } })),
      Request.baseUrl(origin),
    ),
    publishResponse,
  );
