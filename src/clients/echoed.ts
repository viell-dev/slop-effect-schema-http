/**
 * The declarations of EXT-12 to EXT-16, sent to the neutral `echo` helper. They live here so that
 * the raw client in the Node lane and `fetch` in both lanes send the very same request. `echo`
 * answers their paths with 404 and the text `Not Found`, so each declares that, which also makes
 * `text/plain` their automatic `Accept`. Each takes the client middleware to apply last, so that a
 * test can see what the client received, and leaves the client itself to the caller.
 */
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const notFound = Response.status(404, Body.text);

/** Client middleware to apply last. */
export type Last = (client: HttpClient.HttpClient) => HttpClient.HttpClient;

/** A declaration, ready to send to the `echo` at an origin. */
export type Declared = (
  origin: string,
  last: Last,
) => Effect.Effect<string, unknown, HttpClient.HttpClient>;

const declared =
  <I, E>(
    build: (origin: string) => Request.Request<I, E>,
    input: I,
  ): Declared =>
  (origin, last) =>
    Operation.make(build(origin), notFound, { transformClient: last }).execute(
      input,
    );

const get = (origin: string) => Request.get(`${origin}/shape`);
const post = (origin: string) => Request.post(`${origin}/shape`);
const text = Request.body(Body.text);
const hello = { body: "hello" };

const weird = "application/weird";
const mapped = "application/mapped";

/** `Request.mapEffect` setting the content type on the native request. */
const nativeContentType = Request.mapEffect(
  (request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientRequest.setHeader(request, "content-type", mapped),
    ),
);

const OptionalFields = Schema.Struct({
  accept: Schema.optional(Schema.String),
  "content-type": Schema.optional(Schema.String),
});

/** What EXT-12 and EXT-13 declare, by their shared letter. */
export const automatic = {
  a: declared((origin) => post(origin).pipe(text), hello),
  b: declared(
    (origin) => get(origin).pipe(Request.removeHeader("accept")),
    undefined,
  ),
  bComputed: declared(
    (origin) =>
      get(origin).pipe(
        Request.removeHeader("accept"),
        Request.setHeader("accept", () => undefined),
      ),
    undefined,
  ),
  c: declared(
    (origin) => get(origin).pipe(Request.setHeader("accept", "text/weird")),
    undefined,
  ),
  d: declared(
    (origin) => get(origin).pipe(Request.setHeader("accept", "")),
    undefined,
  ),
  e: declared(
    (origin) =>
      get(origin).pipe(
        Request.headers(Schema.Struct({ accept: Schema.String })),
      ),
    { headers: { accept: "text/schema" } },
  ),
  f: declared(
    (origin) => post(origin).pipe(text, Request.headers(OptionalFields)),
    {
      ...hello,
      headers: {},
    },
  ),
  gBefore: declared(
    (origin) =>
      post(origin).pipe(Request.setHeader("Content-Type", weird), text),
    hello,
  ),
  gAfter: declared(
    (origin) =>
      post(origin).pipe(text, Request.setHeader("Content-Type", weird)),
    hello,
  ),
  gLines: declared(
    (origin) =>
      post(origin).pipe(
        Request.appendHeader("content-type", "application/one"),
        Request.appendHeader("Content-Type", "application/two"),
        text,
      ),
    hello,
  ),
  hBefore: declared(
    (origin) =>
      post(origin).pipe(
        Request.headers(Schema.Struct({ "Content-Type": Schema.String })),
        text,
      ),
    { ...hello, headers: { "Content-Type": weird } },
  ),
  hAfter: declared(
    (origin) =>
      post(origin).pipe(
        text,
        Request.headers(Schema.Struct({ "Content-Type": Schema.String })),
      ),
    { ...hello, headers: { "Content-Type": weird } },
  ),
  i: declared(
    (origin) => post(origin).pipe(text, Request.removeHeader("content-type")),
    hello,
  ),
  j: declared(
    (origin) =>
      post(origin).pipe(
        text,
        Request.removeHeader("content-type", "text/plain"),
      ),
    hello,
  ),
  k: declared(
    (origin) =>
      post(origin).pipe(
        Request.setHeader("content-type", weird),
        Request.body(Body.empty),
      ),
    { body: undefined },
  ),
  lDefault: declared(
    (origin) => post(origin).pipe(Request.body(Body.formData)),
    {
      body: multipart(),
    },
  ),
  lDeclared: declared(
    (origin) =>
      post(origin).pipe(
        Request.setHeader("content-type", "multipart/form-data"),
        Request.body(Body.formData),
      ),
    { body: multipart() },
  ),
  m: declared(
    (origin) =>
      post(origin).pipe(
        Request.setHeader("content-type", weird),
        text,
        nativeContentType,
      ),
    hello,
  ),
  nReplaced: declared(
    (origin) => post(origin).pipe(nativeContentType, text),
    hello,
  ),
  nKept: declared(
    (origin) =>
      post(origin).pipe(
        nativeContentType,
        Request.removeHeader("content-type"),
        text,
      ),
    hello,
  ),
  o: declared(
    (origin) =>
      get(origin).pipe(
        Request.removeHeader("accept"),
        Request.setHeader("accept", "text/late"),
      ),
    undefined,
  ),
  pRequired: declared(
    (origin) =>
      get(origin).pipe(
        Request.headers(Schema.Struct({ accept: Schema.String })),
        Request.removeHeader("accept"),
      ),
    { headers: { accept: "text/schema" } },
  ),
  pBefore: declared(
    (origin) =>
      get(origin).pipe(
        Request.removeHeader("accept"),
        Request.headers(Schema.Struct({ accept: Schema.String })),
      ),
    { headers: { accept: "text/schema" } },
  ),
  pOmitted: declared(
    (origin) =>
      get(origin).pipe(
        Request.headers(OptionalFields),
        Request.removeHeader("accept"),
      ),
    { headers: {} },
  ),
  pPassed: declared(
    (origin) =>
      get(origin).pipe(
        Request.headers(OptionalFields),
        Request.removeHeader("accept"),
      ),
    { headers: { accept: "text/schema" } },
  ),
  q: declared(
    (origin) =>
      post(origin).pipe(text, Request.setHeader("Content-Length", "3")),
    hello,
  ),
  r: declared(
    (origin) =>
      post(origin).pipe(text, Request.setHeader("Content-Length", "10")),
    hello,
  ),
  s: declared(
    (origin) =>
      post(origin).pipe(text, Request.setHeader("content-length", "")),
    hello,
  ),
  t: declared(
    (origin) => post(origin).pipe(text, Request.removeHeader("content-length")),
    hello,
  ),
  u: ((origin, last) =>
    Operation.make(get(origin), notFound, {
      transformClient: (client) =>
        last(
          HttpClient.mapRequest(
            client,
            HttpClientRequest.removeHeader("accept"),
          ),
        ),
    }).execute(undefined)) satisfies Declared,
};

/** A form with one field. A function, so that this module builds nothing at load beyond it. */
function multipart(): FormData {
  const form = new FormData();
  form.set("field", "value");
  return form;
}

/** What EXT-14 declares, by its letter. */
export const spelling = {
  a: declared(
    (origin) => get(origin).pipe(Request.setHeader("X-API-Key", "v")),
    undefined,
  ),
  b: declared(
    (origin) =>
      get(origin).pipe(
        Request.appendHeader("X-Multi", "a"),
        Request.appendHeader("x-multi", "b"),
      ),
    undefined,
  ),
  c: declared(
    (origin) =>
      get(origin).pipe(
        Request.setHeader("x-thing", "1"),
        Request.setHeader("X-Other", "2"),
        Request.setHeader("X-Thing", "3"),
      ),
    undefined,
  ),
  d: declared(
    (origin) =>
      get(origin).pipe(
        Request.setHeader("X-Thing", "1"),
        Request.removeHeader("x-THING"),
      ),
    undefined,
  ),
  e: declared(
    (origin) =>
      get(origin).pipe(
        Request.headers(Schema.Struct({ "X-API-Key": Schema.String })),
      ),
    { headers: { "X-API-Key": "v" } },
  ),
  f: declared(
    (origin) =>
      get(origin).pipe(
        Request.setHeader("X-API-KEY", "v"),
        Request.headers(
          Schema.Struct({ "X-Api-Key": Schema.optional(Schema.String) }),
        ),
      ),
    { headers: {} },
  ),
  g: ((origin, last) =>
    Operation.make(
      get(origin).pipe(
        Request.setHeader("X-Thing", "1"),
        Request.setHeader("X-Other", "2"),
      ),
      notFound,
      {
        transformClient: (client) =>
          last(
            HttpClient.mapRequest(
              client,
              HttpClientRequest.setHeader("X-Thing", "3"),
            ),
          ),
      },
    ).execute(undefined)) satisfies Declared,
};

/** `written` in the constructor of a GET on `echo`, with an optional edit after it. */
const writtenAs = (
  written: string,
  edit: (request: Request.Request<unknown>) => Request.Request<unknown> = (
    request,
  ) => request,
): Declared =>
  declared((origin) => edit(Request.get(`${origin}${written}`)), undefined);

/** What EXT-15 and EXT-16 declare, by their shared letter: #102's table, then its rule on names. */
export const written = {
  a: writtenAs("/x?a=1;b=2"),
  b: writtenAs("/x?a=1&&b=2"),
  c: writtenAs("/x?"),
  d: writtenAs("/x?q=a+b"),
  e: writtenAs("/x?a=%41&wsdl"),
  f: writtenAs("/x?a=%41&b=1;2", Request.setQuery("a", "new value")),
  g: writtenAs("/x?", Request.setQuery("b", "1")),
  h: writtenAs("/x?a=1&", Request.setQuery("b", "1")),
  i: writtenAs("/x?a+b=1&c=%32", Request.setQuery("a b", "2")),
};
