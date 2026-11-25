import assert from "node:assert/strict";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
// #region imports
import { Data, Effect, Schema } from "effect";
import { Body, Request, Response } from "viell-effect-schema-http";
// #endregion imports

// #region json
const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
const userBody = Body.jsonSchema(User);
const createUser = Request.post("https://api.example.test/users").pipe(
  Request.body(userBody),
);
const createdUser = Response.status(201, userBody);
// Pass { body: { id: 42, name: "Ada" } } when executing createUser.
// A matching 201 response decodes to { id: number, name: string }.
// #endregion json
const compiled = await Effect.runPromise(
  Request.compile(createUser, { body: { id: 42, name: "Ada" } }),
);
const response = HttpClientResponse.fromWeb(
  compiled.request,
  new globalThis.Response(JSON.stringify({ id: 42, name: "Ada" }), {
    status: 201,
  }),
);
assert.deepEqual(
  await Effect.runPromise(Response.decode(createdUser, response)),
  {
    id: 42,
    name: "Ada",
  },
);

// #region text-schema
const countDecoder = Body.text.pipe(Body.schema(Schema.FiniteFromString));
const countEncoder = Body.text.pipe(Body.encodeSchema(Schema.FiniteFromString));
// The decoder reads "42" as the number 42; the encoder writes 42 as text "42".
// #endregion text-schema
const countResponse = HttpClientResponse.fromWeb(
  HttpClientRequest.get("https://api.example.test/count"),
  new globalThis.Response("42"),
);
assert.equal(await Effect.runPromise(countDecoder.decode(countResponse)), 42);
const countBody = await Effect.runPromise(countEncoder.encode(42));
assert.equal(countBody._tag, "Uint8Array");
if (countBody._tag === "Uint8Array")
  assert.equal(new TextDecoder().decode(countBody.body), "42");

// #region url-encoded
const TokenRequest = Schema.Struct({
  grantType: Schema.Literal("client_credentials"),
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
}).pipe(Schema.encodeKeys({ grantType: "grant_type" }));
const requestToken = Request.post("https://auth.example.test/token").pipe(
  Request.body(Body.urlEncoded.pipe(Body.encodeSchema(TokenRequest))),
);
// Pass { body: { grantType: "client_credentials", scope: ["read", "write"] } }.
// The body is grant_type=client_credentials&scope=read&scope=write.
// #endregion url-encoded
const token = await Effect.runPromise(
  Request.compile(requestToken, {
    body: { grantType: "client_credentials", scope: ["read", "write"] },
  }),
);
assert.equal(token.request.body._tag, "Uint8Array");
if (token.request.body._tag === "Uint8Array")
  assert.equal(
    new TextDecoder().decode(token.request.body.body),
    "grant_type=client_credentials&scope=read&scope=write",
  );

// #region free-form
const Note = Schema.Struct({ title: Schema.String, meta: Schema.Any });
const createNote = Request.post("https://api.example.test/notes").pipe(
  Request.body(Body.jsonSchema(Note)),
);
// { title: "a", meta: { at: new Date(0) } } sends
// {"title":"a","meta":{"at":"1970-01-01T00:00:00.000Z"}}.
// { title: "a", meta: { tags: new Set(["x"]) } } fails before dispatch with
// HttpBodyError: JSON body at $["meta"]["tags"] cannot encode Set
// #endregion free-form
const note = await Effect.runPromise(
  Request.compile(createNote, {
    body: { title: "a", meta: { at: new Date(0) } },
  }),
);
assert.equal(note.request.body._tag, "Uint8Array");
if (note.request.body._tag === "Uint8Array")
  assert.equal(
    new TextDecoder().decode(note.request.body.body),
    '{"title":"a","meta":{"at":"1970-01-01T00:00:00.000Z"}}',
  );
const refusedNote = await Effect.runPromise(
  Effect.flip(
    Request.compile(createNote, {
      body: { title: "a", meta: { tags: new Set(["x"]) } },
    }),
  ),
);
assert.equal(refusedNote._tag, "HttpBodyError");
assert.equal(
  refusedNote.message,
  'JSON body at $["meta"]["tags"] cannot encode Set',
);
const UnknownNote = Schema.Struct({
  title: Schema.String,
  meta: Schema.Unknown,
});
const strictNote = await Effect.runPromise(
  Effect.flip(
    Request.compile(
      Request.post("https://api.example.test/notes").pipe(
        Request.body(Body.jsonSchema(UnknownNote)),
      ),
      { body: { title: "a", meta: { at: new Date(0) } } },
    ),
  ),
);
assert.equal(strictNote._tag, "SchemaError");
assert.equal(strictNote.message, 'Expected JSON value\n  at ["meta"]');

// #region map
const trimmed = (text: string) => text.trim();

const trimmedText = Body.text.pipe(Body.map(trimmed));
// #endregion map

// #region map-effect
class ServiceBusy extends Data.TaggedError("ServiceBusy")<{
  readonly text: string;
}> {}

const readyOrBusy = Effect.fn("readyOrBusy")(function* (text: string) {
  if (text !== "ready") return yield* new ServiceBusy({ text });
  return text;
});

const readyText = Body.text.pipe(Body.mapEffect(readyOrBusy));
// "ready" decodes to "ready". Other text fails with ServiceBusy.
// #endregion map-effect
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(
        readyText.decode(
          HttpClientResponse.fromWeb(
            HttpClientRequest.get("https://api.example.test/status"),
            new globalThis.Response("busy"),
          ),
        ),
      ),
    )
  )._tag,
  "ServiceBusy",
);
assert.equal(
  await Effect.runPromise(
    trimmedText.decode(
      HttpClientResponse.fromWeb(
        countResponse.request,
        new globalThis.Response(" ready \n"),
      ),
    ),
  ),
  "ready",
);
