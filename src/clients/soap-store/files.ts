import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { EntityTag, UploadReceipt } from "../../values/soap-store.js";
import { rejected } from "./common.js";

/**
 * The store's file endpoints: a multipart upload with a label, a raw upload with the file name in
 * the query string, and a multipart bundle whose parts are files read asynchronously inside the
 * schema. Everything here uses Web-standard `FormData`, `Blob` and `File`.
 */

const NonBlank = Schema.String.check(
  Schema.makeFilter(
    (value: string) => value.trim() !== "" || "must not be blank",
  ),
);

export const UploadInput = Schema.Struct({
  label: NonBlank,
  file: Schema.Struct({
    name: Schema.NonEmptyString,
    type: Schema.String,
    bytes: Schema.Uint8Array,
  }),
});
export type UploadInput = typeof UploadInput.Type;

const issue = (cause: unknown, input: unknown, options: object) =>
  new SchemaIssue.InvalidValue(
    { message: cause instanceof Error ? cause.message : String(cause) },
    input,
    options,
  );

/** Copy into an `ArrayBuffer`-backed array, which `Blob` and `File` accept in every lane. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes);

const entriesOf = (
  form: FormData,
  names: ReadonlyArray<string>,
): ReadonlyArray<FormDataEntryValue> => {
  const keys = [...form.keys()];
  if (
    keys.length !== names.length ||
    names.some((name) => !keys.includes(name))
  )
    throw new Error(
      `expected the parts ${names.join(", ")}, found ${keys.join(", ")}`,
    );
  return names.map((name) => form.get(name)!);
};

const fileOf = (entry: FormDataEntryValue, name: string): File => {
  if (typeof entry === "string") throw new Error(`${name} is not a file part`);
  return entry;
};

/**
 * The upload form: a `label` field and a `file` part. Decoding, which only round trips use, awaits
 * the file's bytes; it refuses other parts and a label sent as a file.
 */
export const UploadForm = Schema.instanceOf(FormData).pipe(
  Schema.decodeTo(
    UploadInput,
    SchemaTransformation.transformEffect<typeof UploadInput.Encoded, FormData>({
      decode: (form, options) =>
        Effect.tryPromise({
          try: async () => {
            const [label, file] = entriesOf(form, ["label", "file"]);
            if (typeof label !== "string")
              throw new Error("label is not a text field");
            const part = fileOf(file!, "file");
            return {
              label,
              file: {
                name: part.name,
                type: part.type,
                bytes: new Uint8Array(await part.arrayBuffer()),
              },
            };
          },
          catch: (cause) => issue(cause, form, options),
        }),
      encode: (input) =>
        Effect.sync(() => {
          const form = new FormData();
          form.append("label", input.label);
          form.append(
            "file",
            new Blob([own(input.file.bytes)], { type: input.file.type }),
            input.file.name,
          );
          return form;
        }),
    }),
  ),
);

export const Uploaded = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  label: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  etag: EntityTag,
});

/** `POST /upload` with the form; the transport chooses the multipart boundary. */
export const upload = (origin: string) =>
  Operation.make(
    Request.post("upload").pipe(
      Request.baseUrl(origin),
      Request.body(Body.formData.pipe(Body.encodeSchema(UploadForm))),
      Request.mapInput((input: UploadInput) => ({ body: input })),
    ),
    Response.status(
      201,
      Body.jsonSchema(Uploaded).pipe(
        Body.map((uploaded) => ({ _tag: "Uploaded", ...uploaded }) as const),
      ),
    ).pipe(
      Response.orElse(Response.status(400, rejected("Rejected"))),
      Response.orElse(Response.status(409, rejected("Conflict"))),
      Response.orElse(Response.status(415, rejected("UnsupportedMediaType"))),
    ),
  );

/** `POST /upload/raw?name=…` with the bytes, answered by a one-line receipt. */
export const uploadRaw = (origin: string) =>
  Operation.make(
    Request.post("upload/raw").pipe(
      Request.baseUrl(origin),
      Request.query(Schema.Struct({ name: Schema.NonEmptyString })),
      Request.body(Body.bytes),
      Request.mapInput(
        (input: { readonly name: string; readonly bytes: Uint8Array }) => ({
          query: { name: input.name },
          body: input.bytes,
        }),
      ),
    ),
    Response.status(
      200,
      Body.text.pipe(
        Body.schema(UploadReceipt),
        Body.map((receipt) => ({ _tag: "Receipt", ...receipt }) as const),
      ),
    ).pipe(
      Response.orElse(Response.status(400, rejected("Rejected"))),
      Response.orElse(Response.status(409, rejected("Conflict"))),
      Response.orElse(Response.status(415, rejected("UnsupportedMediaType"))),
    ),
  );

export const BundleMetadata = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  title: Schema.String,
  contentType: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  etag: EntityTag,
  modified: Schema.String,
});

export const Bundle = Schema.Struct({
  metadata: BundleMetadata,
  fileName: Schema.NonEmptyString,
  contentType: Schema.String,
  content: Schema.Uint8Array,
});
export type Bundle = typeof Bundle.Type;

/**
 * A bundle: a `metadata` part (a JSON file) and a `content` part. Reading either part is
 * asynchronous, and the awaiting happens here, inside the schema. The metadata part's own file name
 * is not kept; encoding writes `metadata.json`.
 */
export const BundleFromFormData = Schema.instanceOf(FormData).pipe(
  Schema.decodeTo(
    Bundle,
    SchemaTransformation.transformEffect<typeof Bundle.Encoded, FormData>({
      decode: (form, options) =>
        Effect.tryPromise({
          try: async () => {
            const [metadata, content] = entriesOf(form, [
              "metadata",
              "content",
            ]).map((entry, index) =>
              fileOf(entry, index === 0 ? "metadata" : "content"),
            );
            if (metadata!.type !== "application/json")
              throw new Error(`metadata is ${metadata!.type}, not JSON`);
            return {
              metadata: JSON.parse(await metadata!.text()) as never,
              fileName: content!.name,
              contentType: content!.type,
              content: new Uint8Array(await content!.arrayBuffer()),
            };
          },
          catch: (cause) => issue(cause, form, options),
        }),
      encode: (bundle) =>
        Effect.sync(() => {
          const form = new FormData();
          form.append(
            "metadata",
            new File([JSON.stringify(bundle.metadata)], "metadata.json", {
              type: "application/json",
            }),
          );
          form.append(
            "content",
            new File([own(bundle.content)], bundle.fileName, {
              type: bundle.contentType,
            }),
          );
          return form;
        }),
    }),
  ),
);

/** `GET /bundle/<id>`, decoded from multipart form data. */
export const bundle = (origin: string) =>
  Operation.make(
    Request.get("bundle").pipe(
      Request.baseUrl(origin),
      Request.path(
        Schema.NonEmptyString,
        (id, encode) => `bundle/${encode(id)}`,
      ),
      Request.mapInput((id: string) => ({ path: id })),
    ),
    Response.status(
      200,
      Body.formData.pipe(
        Body.schema(BundleFromFormData),
        Body.map((value) => ({ _tag: "Bundle", ...value }) as const),
      ),
    ).pipe(Response.orElse(Response.status(404, rejected("Missing")))),
  );
