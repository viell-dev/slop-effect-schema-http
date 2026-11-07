import assert from "node:assert/strict";
import { FetchHttpClient, HttpClientResponse } from "effect/http";
// #region imports
import { Context, Effect, Option, Schema, SchemaTransformation } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
// #endregion imports

const urlOf = async <I, E>(request: Request.Request<I, E>, input: I) =>
  (await Effect.runPromise(Request.compile(request, input))).request.url;

// The silent change: this compiles, and asks for a different URL than it did on 0.1.
const unchangedDefinition = Request.get("/users").pipe(
  Request.path(Schema.FiniteFromString, (id, encode) => `/users/${encode(id)}`),
);
assert.equal(await urlOf(unchangedDefinition, { path: 42 }), "/users/users/42");

// A label was never part of the URL on 0.1, and now it is.
const renderUser = Request.path(
  Schema.String,
  (id, encode) => `/${encode(id)}`,
);
const labelSeen: Array<string> = [];
const labelClient = Effect.provideService(
  HttpClient.HttpClient,
  HttpClient.make((native, url) => {
    labelSeen.push(url.href);
    return Effect.succeed(
      HttpClientResponse.fromWeb(native, new globalThis.Response("ok")),
    );
  }),
);
const labelled = Operation.make(
  Request.get("{location}").pipe(renderUser),
  Response.status(200, Body.text),
);
const invalidUrl = await Effect.runPromise(
  Effect.flip(labelled.execute({ path: "a" })).pipe(labelClient),
);
assert.ok(invalidUrl._tag === "HttpClientError");
assert.equal(invalidUrl.reason._tag, "InvalidUrlError");
await Effect.runPromise(
  Operation.make(
    Request.get("{location}").pipe(
      Request.baseUrl("https://api.example.test"),
      renderUser,
    ),
    Response.status(200, Body.text),
  )
    .execute({ path: "a" })
    .pipe(labelClient),
);
assert.deepEqual(labelSeen, ["https://api.example.test/%7Blocation%7D/a"]);

// A constructor that carried a query or fragment keeps its path text, with no error.
assert.equal(
  await urlOf(
    Request.get("/elsewhere?lang=de#closing").pipe(
      Request.path(
        Schema.FiniteFromString,
        (id, encode) => `/users/${encode(id)}`,
      ),
    ),
    { path: 42 },
  ),
  "/elsewhere/users/42?lang=de",
);

// #region path-carrier
const getUserInGerman = Request.get("?lang=de#closing").pipe(
  Request.path(Schema.FiniteFromString, (id, encode) => `/users/${encode(id)}`),
);
// /users/42?lang=de, and the fragment stays on the request
// #endregion path-carrier
const carried = await Effect.runPromise(
  Request.compile(getUserInGerman, { path: 42 }),
);
assert.equal(carried.request.url, "/users/42?lang=de");
assert.deepEqual(carried.request.hash, Option.some("closing"));

// #region path-whole
const getUser = Request.get("").pipe(
  Request.path(Schema.FiniteFromString, (id, encode) => `/users/${encode(id)}`),
);
// #endregion path-whole
assert.equal(await urlOf(getUser, { path: 42 }), "/users/42");

// #region path-tail
const getUserUnderUsers = Request.get("/users").pipe(
  Request.path(Schema.FiniteFromString, (id, encode) => `/${encode(id)}`),
);
// #endregion path-tail
assert.equal(await urlOf(getUserUnderUsers, { path: 42 }), "/users/42");

// A trailing slash left in the constructor gives a double slash, with no error.
assert.equal(
  await urlOf(
    Request.get("/users/").pipe(
      Request.path(Schema.FiniteFromString, (id, encode) => `/${encode(id)}`),
    ),
    { path: 42 },
  ),
  "/users//42",
);

// #region path-branch
const listFolder = Request.get("/files").pipe(
  Request.path(Schema.String, (folder, encode) =>
    folder === "" ? "/" : `/${encode(folder)}/`,
  ),
);
// "" gives /files/, and "a b" gives /files/a%20b/
// #endregion path-branch
assert.equal(await urlOf(listFolder, { path: "" }), "/files/");
assert.equal(await urlOf(listFolder, { path: "a b" }), "/files/a%20b/");

// #region path-template
const userId = Request.pathValue("userId", Schema.FiniteFromString);
const getUserByTemplate = Request.get("").pipe(Request.path`/users/${userId}`);
// The input is now { path: { userId: 42 } }, not { path: 42 }.
// #endregion path-template
assert.equal(
  await urlOf(getUserByTemplate, { path: { userId: 42 } }),
  "/users/42",
);

// #region path-suffix
const customer = Request.pathValue("customer");
const atCustomer = Request.path`/customers/${customer}`;

const getArchive = Request.get("").pipe(atCustomer, Request.path`/archive`);
const getInvoices = Request.get("").pipe(atCustomer, Request.path`/invoices`);
// #endregion path-suffix
const customerInput = { path: { customer: "a b" } };
assert.equal(
  await urlOf(getArchive, customerInput),
  "/customers/a%20b/archive",
);
assert.equal(
  await urlOf(getInvoices, customerInput),
  "/customers/a%20b/invoices",
);

// Moving to a template changes the input, and the compiler finds each place that used it.
const removeUser = Operation.make(
  Request.del("").pipe(Request.path`/users/${userId}`),
  Response.status(204, Body.empty),
);
// @ts-expect-error A text search for "path:" misses this shorthand, and the compiler does not.
const removeById = (path: number) => removeUser.execute({ path });
assert.equal(typeof removeById, "function");

const removeByNumber = Request.del("").pipe(
  Request.path`/users/${userId}`,
  // @ts-expect-error A stale Request.mapInput still builds the old input.
  Request.mapInput((id: number) => ({ path: id })),
);
assert.equal(typeof removeByNumber, "object");

// A hand-written input type hides its callers. The first error is here, not at the caller.
type StaleInput = { readonly path: number };
const removeWith = (input: StaleInput) =>
  // @ts-expect-error The first round of errors stops at this call.
  removeUser.execute(input);
const staleCaller = () => removeWith({ path: 42 });
assert.equal(typeof staleCaller, "function");

// A scalar renderer stacked with a template makes the input impossible to supply.
const scalarOnTemplate = Operation.make(
  Request.get("").pipe(
    Request.path`/users/${userId}`,
    Request.path(
      Schema.FiniteFromString,
      (id, encode) => `/posts/${encode(id)}`,
    ),
  ),
  Response.status(200, Body.text),
);
// @ts-expect-error No value is both an object and a number.
const impossible = () => scalarOnTemplate.execute({ path: { userId: 42 } });
assert.equal(typeof impossible, "function");

// A renderer with a struct can stack, because each reads its own fields.
assert.equal(
  await urlOf(
    Request.get("").pipe(
      Request.path`/users/${userId}`,
      Request.path(
        Schema.Struct({ postId: Schema.FiniteFromString }),
        ({ postId }, encode) => `/posts/${encode(postId)}`,
      ),
    ),
    { path: { userId: 42, postId: 7 } },
  ),
  "/users/42/posts/7",
);

// A stale scalar that gets past the types fails before anything is sent.
const staleScalar = await Effect.runPromise(
  Effect.flip(Request.compile(getUserByTemplate, { path: 42 } as never)),
);
assert.equal(staleScalar._tag, "SchemaError");
assert.match(staleScalar.message, /Expected object/);

// #region path-stacked
const listPosts = getUser.pipe(
  Request.path(Schema.FiniteFromString, () => "/posts"),
);
// { path: 42 } gives /users/42/posts
// #endregion path-stacked
assert.equal(await urlOf(listPosts, { path: 42 }), "/users/42/posts");

// #region path-replaced
const getProfile = getUser.pipe(
  Request.unbind("path"),
  Request.path(
    Schema.FiniteFromString,
    (id, encode) => `/profiles/${encode(id)}`,
  ),
);
// { path: 42 } gives /profiles/42
// #endregion path-replaced
assert.equal(await urlOf(getProfile, { path: 42 }), "/profiles/42");

// #region path-url
const compiled = await Effect.runPromise(
  Request.compile(getUser, { path: 42 }),
);
console.log(compiled.request.url); // /users/42
// #endregion path-url
assert.equal(compiled.request.url, "/users/42");

// #region shape-allow
const search = Request.get("https://api.example.test/search?lang=en").pipe(
  Request.setHeader("authorization", "Bearer token"),
  Request.query(
    Schema.Struct({ q: Schema.String, lang: Schema.optional(Schema.String) }),
  ),
  Request.headers(
    Schema.Struct({
      authorization: Schema.optional(Schema.String),
      "x-trace": Schema.String,
    }),
  ),
);
// ?q=ada&lang=en, with authorization and x-trace
// #endregion shape-allow
const searched = await Effect.runPromise(
  Request.compile(search, {
    query: { q: "ada" },
    headers: { "x-trace": "t1" },
  }),
);
assert.equal(
  searched.request.url,
  "https://api.example.test/search?q=ada&lang=en",
);
assert.equal(searched.request.headers["x-trace"], "t1");
assert.ok(searched.request.headers["authorization"] !== undefined);

// #region shape-remove
const searchAsBefore = Request.get("https://api.example.test/search").pipe(
  Request.query(Schema.Struct({ q: Schema.String })),
  Request.headers(Schema.Struct({ "x-trace": Schema.String })),
);
// ?q=ada with x-trace, which is what 0.1 sent
// #endregion shape-remove
assert.equal(
  (
    await Effect.runPromise(
      Request.compile(searchAsBefore, {
        query: { q: "ada" },
        headers: { "x-trace": "t1" },
      }),
    )
  ).request.url,
  "https://api.example.test/search?q=ada",
);

// The unmigrated definition compiles and fails when it is prepared.
const unmigrated = Request.get("https://api.example.test/search?lang=en").pipe(
  Request.query(Schema.Struct({ q: Schema.String })),
);
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(Request.compile(unmigrated, { query: { q: "ada" } })),
    )
  )._tag,
  "InvalidRequest",
);

// #region helper-annotation
const inEnglish = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(Request.setHeader("accept-language", "en"));
// #endregion helper-annotation
assert.equal(
  (await Effect.runPromise(Request.compile(inEnglish(Request.get("/x")), {})))
    .request.headers["accept-language"],
  "en",
);

const noBodyOnGet = Operation.make(
  Request.get("https://api.example.test/report").pipe(Request.body(Body.text)),
  Response.status(200, Body.text),
);
// #region get-body
const report = noBodyOnGet.execute({ body: "synthetic" }).pipe(
  Effect.catchTag("HttpClientError", () => Effect.succeed("refused")),
  Effect.provide(FetchHttpClient.layer),
);
// #endregion get-body
assert.equal(await Effect.runPromise(report), "refused");

// #region header-automatic
const sendJson = Request.post("https://api.example.test/things").pipe(
  Request.body(Body.json),
);
// content-type: application/json, supplied by the body
// #endregion header-automatic
const automatic = await Effect.runPromise(
  Request.compile(sendJson, { body: { a: 1 } }),
);
assert.equal(automatic.request.headers["content-type"], "application/json");
const declared = await Effect.runPromise(
  Request.compile(
    sendJson.pipe(
      Request.setHeader("content-type", "application/vnd.example+json"),
    ),
    { body: { a: 1 } },
  ),
);
assert.equal(
  declared.request.headers["content-type"],
  "application/vnd.example+json",
);

// A removal that did nothing on 0.1 now stops the automatic Accept.
const acceptSeen: Array<string | undefined> = [];
const recordAccept = Effect.provideService(
  HttpClient.HttpClient,
  HttpClient.make((native) => {
    acceptSeen.push(native.headers["accept"]);
    return Effect.succeed(
      HttpClientResponse.fromWeb(native, new globalThis.Response("ok")),
    );
  }),
);
await Effect.runPromise(
  Operation.make(
    Request.get("https://api.example.test/x"),
    Response.status(200, Body.text),
  )
    .execute(undefined)
    .pipe(recordAccept),
);
await Effect.runPromise(
  Operation.make(
    Request.get("https://api.example.test/x").pipe(
      Request.removeHeader("accept"),
    ),
    Response.status(200, Body.text),
  )
    .execute(undefined)
    .pipe(recordAccept),
);
assert.deepEqual(acceptSeen, ["text/plain", undefined]);

// #region query-declared
const findAda = Request.get("/search").pipe(
  Request.setQuery("q", "Ada Lovelace"),
);
// /search?q=Ada%20Lovelace
// #endregion query-declared
assert.equal(await urlOf(findAda, undefined), "/search?q=Ada%20Lovelace");
assert.equal(
  await urlOf(Request.get("/search?q=Ada Lovelace"), undefined),
  "/search?q=Ada Lovelace",
);
for (const written of ["/x?a=1;b=2", "/x?q=a+b", "/x?a=1&&b=2", "/x?"]) {
  assert.equal(await urlOf(Request.get(written), undefined), written);
}

// #region fragment-provider
const targetOf = (native: HttpClientRequest.HttpClientRequest) =>
  Option.match(native.hash, {
    onNone: () => native.url,
    onSome: (fragment) => `${native.url}#${fragment}`,
  });
// #endregion fragment-provider
assert.equal(
  targetOf(
    (await Effect.runPromise(Request.compile(Request.get("/page#top"), {})))
      .request,
  ),
  "/page#top",
);
const withQuery = await Effect.runPromise(
  Request.compile(
    Request.get("").pipe(
      Request.path(Schema.String, (value) => `/users/${value}#top`),
      Request.setQuery("f", "xml"),
    ),
    { path: "1" },
  ),
);
assert.equal(targetOf(withQuery.request), "/users/1?f=xml#top");

// #region schema-top
const asJson = <S extends Schema.Top>(schema: S) => Body.jsonSchema(schema);
// #endregion schema-top
assert.equal(asJson(Schema.String).mediaType, "application/json");

// #region services-schema
class Tenant extends Context.Service<Tenant, string>()("app/Tenant") {}
const Tenanted = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (wire: string) => Effect.map(Tenant, (id) => `${id}:${wire}`),
      encode: (value: string) => Effect.succeed(value),
    }),
  ),
);
const scoped = Request.get("/things").pipe(
  Request.query(Schema.Struct({ who: Tenanted })),
);
// #endregion services-schema
// #region services
const scopedThings = Request.compile(scoped, { query: { who: "me" } }).pipe(
  Effect.provideService(Tenant, "t1"),
);
// Needs the schema's decoding services too.
// #endregion services
assert.equal(
  (await Effect.runPromise(scopedThings)).request.url,
  "/things?who=me",
);

const legacy = false as boolean;
const body = Body.text;
// #region contract-one
const contract = Response.status(legacy ? 200 : 201, body);
// #endregion contract-one
assert.equal(
  typeof Operation.make(Request.get("/x"), contract).execute,
  "function",
);

// #region base-map
const usersRequest = Request.get("/users").pipe(
  Request.baseUrl("https://api.example.test"),
);
const toAdmin = (url: string) => `${url}/admin`;
const adminUsers = usersRequest.pipe(Request.mapBaseUrl(toAdmin));
// #endregion base-map
assert.equal(
  await urlOf(adminUsers, undefined),
  "https://api.example.test/admin/users",
);

// #region transform-client-function
const withLabel = (self: HttpClient.HttpClient, label = "default") =>
  HttpClient.mapRequest(self, HttpClientRequest.setHeader("x-label", label));
// #endregion transform-client-function
// #region transform-client
const health = Operation.make(
  Request.get("https://api.example.test/health"),
  Response.status(200, Body.text),
  { transformClient: (client) => withLabel(client) },
);
// #endregion transform-client
const labels: Array<unknown> = [];
const recordLabel = Effect.provideService(
  HttpClient.HttpClient,
  HttpClient.make((native) => {
    labels.push(native.headers["x-label"]);
    return Effect.succeed(
      HttpClientResponse.fromWeb(native, new globalThis.Response("ok")),
    );
  }),
);
await Effect.runPromise(health.execute(undefined).pipe(recordLabel));
assert.deepEqual(labels, ["default"]);
// Passed as it is, the function takes the attempt number for its label.
const numbered = Operation.make(
  Request.get("https://api.example.test/health"),
  Response.status(200, Body.text),
  { transformClient: withLabel as never },
);
await Effect.runPromise(numbered.execute(undefined).pipe(recordLabel));
assert.deepEqual(labels, ["default", 1]);

const spelled = await Effect.runPromise(
  Request.compile(
    Request.get("/x").pipe(Request.setHeader("X-API-Key", "secret")),
    undefined,
  ),
);
// #region header-lines
const apiKey = spelled.headerLines.find(
  ([name]) => name.toLowerCase() === "x-api-key",
);
// #endregion header-lines
assert.deepEqual(apiKey, ["X-API-Key", "secret"]);
