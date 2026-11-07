import assert from "node:assert/strict";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region operations
import { Data, Effect, Schedule, Schema } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";

const Document = Schema.Struct({ id: Schema.Number, name: Schema.String });
const api = Request.baseUrl("https://api.example.test/v1");
const documentId = Request.pathValue("id", Schema.FiniteFromString);

const createDocument = Operation.make(
  Request.post("/documents").pipe(
    api,
    Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
  ),
  Response.status(201, Body.jsonSchema(Document)),
);

const uploadContent = Operation.make(
  Request.put("").pipe(
    api,
    Request.path`/documents/${documentId}/content`,
    Request.body(Body.bytes),
  ),
  Response.status(204, Body.empty),
  { policy: Policy.make(Schedule.recurs(2)) },
);
// #endregion operations

// #region steps
class UploadFailed extends Data.TaggedError("UploadFailed")<{
  readonly documentId: number;
  readonly cause: unknown;
}> {}

const createThenUpload = Effect.fn("createThenUpload")(function* (
  name: string,
  content: Uint8Array,
) {
  const document = yield* createDocument.execute({ body: { name } });
  yield* uploadContent
    .execute({ path: { id: document.id }, body: content })
    .pipe(
      Effect.mapError(
        (cause) => new UploadFailed({ documentId: document.id, cause }),
      ),
    );
  return document;
});
// #endregion steps

// #region resume
const finishUpload = (id: number, content: Uint8Array) =>
  uploadContent.execute({ path: { id }, body: content });
// #endregion resume

const server = (uploadStatuses: ReadonlyArray<number>) => {
  const seen: Array<string> = [];
  const statuses = [...uploadStatuses];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      seen.push(`${request.method} ${request.url}`);
      return HttpClientResponse.fromWeb(
        request,
        request.method === "POST"
          ? new globalThis.Response('{"id":7,"name":"report"}', {
              status: 201,
            })
          : new globalThis.Response(null, { status: statuses.shift() ?? 204 }),
      );
    }),
  );
  return {
    seen,
    provided: Effect.provideService(HttpClient.HttpClient, client),
  };
};
const content = new TextEncoder().encode("synthetic");
const created = "POST https://api.example.test/v1/documents";
const uploaded = "PUT https://api.example.test/v1/documents/7/content";

const working = server([]);
assert.deepEqual(
  await Effect.runPromise(
    createThenUpload("report", content).pipe(working.provided),
  ),
  { id: 7, name: "report" },
);
assert.deepEqual(working.seen, [created, uploaded]);

// A transient failure repeats only the upload. The document is created once.
const flaky = server([503]);
await Effect.runPromise(
  createThenUpload("report", content).pipe(flaky.provided),
);
assert.deepEqual(flaky.seen, [created, uploaded, uploaded]);

// A failure that outlasts the retries names what already exists, and the upload can be finished.
const failing = server([500, 500, 500]);
const failure = await Effect.runPromise(
  Effect.flip(createThenUpload("report", content)).pipe(failing.provided),
);
assert.ok(failure instanceof UploadFailed);
assert.equal(failure.documentId, 7);
assert.deepEqual(failing.seen, [created, uploaded, uploaded, uploaded]);
await Effect.runPromise(
  finishUpload(failure.documentId, content).pipe(failing.provided),
);
assert.equal(failing.seen.filter((line) => line === created).length, 1);
