import assert from "node:assert/strict";
// #region imports
import { Effect, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  Body,
  Operation,
  Request,
  Response,
  Transport,
} from "viell-effect-schema-http";
// #endregion imports

// #region views
const lines = Transport.entries({ "X-Tag": ["math", "computing"] });
// [["X-Tag", "math"], ["X-Tag", "computing"]]
const headers = Transport.toHeaders(lines);
// headers["x-tag"] === "math, computing"
// #endregion views
assert.deepEqual(lines, [
  ["X-Tag", "math"],
  ["X-Tag", "computing"],
]);
assert.equal(headers["x-tag"], "math, computing");

// #region provider
let observed: Transport.Lines = [];
const provider = HttpClient.make((request) =>
  Effect.gen(function* () {
    const outgoing = yield* Transport.headerLines(request);
    // A real provider sends outgoing with its native HTTP API here.
    observed = outgoing;
    const response = HttpClientResponse.fromWeb(
      request,
      new globalThis.Response("ready"),
    );
    // This fixture supplies known lines; a real provider uses the lines it received.
    return Transport.withResponseHeaders(response, [
      ["X-Reply", "one"],
      ["X-Reply", "two"],
    ]);
  }),
);
const read = Operation.make(
  Request.get("https://api.example.test/health").pipe(
    Request.appendHeader("X-Tag", "math"),
    Request.appendHeader("X-Tag", "computing"),
  ),
  Response.status(200, Response.tag("Ready", Body.text)),
);
const reply = await Effect.runPromise(
  read
    .execute(undefined)
    .pipe(Effect.provideService(HttpClient.HttpClient, provider)),
);
// reply.metadata.headerLines is Some([["X-Reply", "one"], ["X-Reply", "two"]]).
// #endregion provider
assert.deepEqual(
  observed.filter(([name]) => name === "x-tag"),
  [
    ["x-tag", "math"],
    ["x-tag", "computing"],
  ],
);
assert.deepEqual(Option.getOrThrow(reply.metadata.headerLines), [
  ["X-Reply", "one"],
  ["X-Reply", "two"],
]);
