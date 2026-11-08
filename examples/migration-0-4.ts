import assert from "node:assert/strict";
// #region imports
import { Effect, Schema, SchemaTransformation } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
// #endregion imports
import { HttpClient, HttpClientResponse } from "effect/http";

const things = "https://api.example.test/things";
const urlOf = async <I, E>(request: Request.Request<I, E>, input: I) =>
  (await Effect.runPromise(Request.compile(request, input))).request.url;

// #region omittable
const list = Operation.make(
  Request.get(things).pipe(
    Request.query(
      Schema.Struct({ limit: Schema.optionalKey(Schema.FiniteFromString) }),
    ),
    Request.headers(
      Schema.Struct({ "x-trace": Schema.optionalKey(Schema.String) }),
    ),
  ),
  Response.status(204, Body.empty),
);
const noFilters = list.execute({});
// The same request as list.execute({ query: {}, headers: {} }).
// #endregion omittable
let dispatches = 0;
const client = HttpClient.make((request) =>
  Effect.sync(() => {
    dispatches += 1;
    assert.equal(request.url, things);
    return HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(null, { status: 204 }),
    );
  }),
);
await Effect.runPromise(
  noFilters.pipe(Effect.provideService(HttpClient.HttpClient, client)),
);
assert.equal(dispatches, 1);

// #region optional-constraint
interface HeaderInput {
  readonly headers?: { readonly authorization?: string };
}
// #endregion optional-constraint
const preserveHeaderInput = <I extends HeaderInput, E, R>(
  request: Request.Request<I, E, R>,
) => request;
const audit = Request.get(things).pipe(
  Request.query(Schema.Struct({ period: Schema.String })),
  Request.headers(
    Schema.Struct({ authorization: Schema.optionalKey(Schema.String) }),
  ),
);
assert.equal(
  await urlOf(preserveHeaderInput(audit), { query: { period: "2026-11" } }),
  `${things}?period=2026-11`,
);
const requiredHeaderInput = <
  I extends { readonly headers: { readonly authorization?: string } },
  E,
  R,
>(
  request: Request.Request<I, E, R>,
) => request;
// @ts-expect-error: an optional header group does not meet this generic helper's old constraint.
void requiredHeaderInput(audit);

// #region constructor-default
const Limited = Schema.Struct({
  limit: Schema.optionalKey(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed("25")),
  ),
});
const limited = Request.get(things).pipe(Request.query(Limited));
const ineffectiveEdit = limited.pipe(Request.setQuery("limit", "5"));
// With query: {}, 0.3 sent ?limit=25 and silently lost the edit.
// In 0.4 this preparation fails with Request.InvalidRequest.
// #endregion constructor-default
const invalid = await Effect.runPromise(
  Effect.flip(Request.compile(ineffectiveEdit, { query: {} })),
);
assert.ok(invalid instanceof Request.InvalidRequest);
assert.match(invalid.message, /limit/);
assert.equal(await urlOf(limited, { query: {} }), `${things}?limit=25`);

// #region change-default
const withFive = (query: { readonly limit?: string }) => ({
  query: { limit: "5", ...query },
});
const fiveByDefault = limited.pipe(Request.mapInput(withFive));
// Input: {}; URL query: ?limit=5. Input: { limit: "10" }; URL query: ?limit=10.
// #endregion change-default
assert.equal(await urlOf(fiveByDefault, {}), `${things}?limit=5`);
assert.equal(await urlOf(fiveByDefault, { limit: "10" }), `${things}?limit=10`);

// #region transformed-tag
const ConvertedTag = Schema.Literal("wire").pipe(
  Schema.decodeTo(
    Schema.Literal("decoded"),
    SchemaTransformation.transform({
      decode: () => "decoded" as const,
      encode: () => "wire" as const,
    }),
  ),
);
const Tagged = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("wire") }).pipe(
    Schema.encodeKeys({ kind: "k" }),
  ),
  Schema.Struct({
    kind: Schema.Union([ConvertedTag, Schema.Literal("other")]),
    x: Schema.String,
  }).pipe(Schema.encodeKeys({ kind: "k" })),
]);
const tagged = Request.get(things).pipe(Request.query(Tagged));
// Input: { query: { kind: "wire", x: "kept" } }.
// 0.3 sent ?k=wire; 0.4 sends ?k=wire&x=kept.
// #endregion transformed-tag
assert.equal(
  await urlOf(tagged, { query: { kind: "wire", x: "kept" } }),
  `${things}?k=wire&x=kept`,
);

// #region narrow-input
const onlyKind = (input: { readonly kind: "wire"; readonly x: string }) => ({
  query: { kind: input.kind },
});
const justTheTag = tagged.pipe(Request.mapInput(onlyKind));
// Input: { kind: "wire", x: "kept" }; URL query: ?k=wire.
// #endregion narrow-input
assert.equal(
  await urlOf(justTheTag, { kind: "wire", x: "kept" }),
  `${things}?k=wire`,
);
