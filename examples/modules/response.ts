import assert from "node:assert/strict";
import { Effect } from "effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
// #region imports
import { Schema } from "effect";
import { Body, Response } from "viell-effect-schema-http";
// #endregion imports

// #region simple
const user = Body.jsonSchema(
  Schema.Struct({ id: Schema.Number, name: Schema.String }),
);
const found = Response.status(200, user);
// A 200 response must contain a JSON user. Other statuses do not match.
// #endregion simple

// #region alternatives
const result = Response.status(200, Response.tag("Found", user)).pipe(
  Response.orElse(Response.status(404, Response.tag("Missing", Body.empty))),
);
// Success is { _tag: "Found", value: { id, name }, metadata }
// or { _tag: "Missing", value: undefined, metadata }.
// #endregion alternatives

// #region metadata
const plainText = Response.when(
  (metadata) =>
    metadata.status === 200 &&
    metadata.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
      "text/plain",
  Body.text,
);
// #endregion metadata

// #region fallback
const withOther = result.pipe(
  Response.orElse(Response.when(() => true, Response.tag("Other", Body.text))),
);
// The last case returns the body of any otherwise-unmatched response as text.
// #endregion fallback

// #region replace
const summary = Body.jsonSchema(Schema.Struct({ id: Schema.Number }));
const asSummary = Response.replace(200, Response.tag("Summary", summary));

const summaryResult = result.pipe(asSummary);
// A 200 is now { _tag: "Summary", value: { id }, metadata }, and the 404 case is unchanged.
// `result` still decodes a whole user, and Found has left the new contract's type.
// #endregion replace

// #region remove
const noMissing = Response.remove(404);

const foundOnly = result.pipe(noMissing);
// A 404 now falls through, here to UnexpectedResponse.
// #endregion remove

// #region key
const serverError = Response.when(
  (metadata) => metadata.status >= 500,
  Response.tag("Server", Body.text),
  { key: "server" },
);
const withServerError = result.pipe(Response.orElse(serverError));

const ignoreServerBody = Response.replace(
  "server",
  Response.tag("Server", Body.empty),
);
const lighter = withServerError.pipe(ignoreServerBody);
// #endregion key

const native = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
) =>
  HttpClientResponse.fromWeb(
    HttpClientRequest.get("https://api.example.test/users/42"),
    new globalThis.Response(body, { status, headers }),
  );
assert.deepEqual(
  await Effect.runPromise(
    Response.decode(found, native(200, '{"id":42,"name":"Ada"}')),
  ),
  { id: 42, name: "Ada" },
);
assert.equal(
  (await Effect.runPromise(Response.decode(result, native(404, ""))))._tag,
  "Missing",
);
assert.equal(
  (await Effect.runPromise(Response.decode(withOther, native(418, "tea"))))
    ._tag,
  "Other",
);
assert.equal(
  await Effect.runPromise(
    Response.decode(
      plainText,
      native(200, "ready", { "content-type": "text/plain; charset=utf-8" }),
    ),
  ),
  "ready",
);
assert.equal(
  (
    await Effect.runPromise(
      Response.decode(summaryResult, native(200, '{"id":42}')),
    )
  )._tag,
  "Summary",
);
assert.equal(
  (await Effect.runPromise(Response.decode(summaryResult, native(404, ""))))
    ._tag,
  "Missing",
);
assert.equal(
  (
    await Effect.runPromise(
      Response.decode(result, native(200, '{"id":42,"name":"Ada"}')),
    )
  )._tag,
  "Found",
);
assert.equal(
  (
    await Effect.runPromise(
      Response.decode(foundOnly, native(404, "")).pipe(
        Effect.catchTag("UnexpectedResponse", (error) =>
          Effect.succeed({ _tag: error._tag }),
        ),
      ),
    )
  )._tag,
  "UnexpectedResponse",
);
assert.equal(
  (await Effect.runPromise(Response.decode(lighter, native(503, "down"))))._tag,
  "Server",
);
assert.deepEqual(summaryResult.accepts, ["application/json"]);
assert.deepEqual(lighter.accepts, ["application/json"]);
const mismatch = await Effect.runPromise(
  Response.decode(withOther, native(200, '{"id":"wrong","name":"Ada"}')).pipe(
    Effect.catchTag("DecodeError", () =>
      Effect.succeed("decode failed" as const),
    ),
  ),
);
assert.equal(mismatch, "decode failed");
