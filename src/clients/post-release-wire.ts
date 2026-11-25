/** Consumer contracts for the neutral echo probe, exercised from source and from the built app. */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { type HttpClient, UrlParams } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

type Send = (
  origin: string,
) => Effect.Effect<unknown, unknown, HttpClient.HttpClient>;
type WireSchema = Schema.Top &
  Schema.ConstraintCodec<unknown, unknown, never, never>;

const response = Response.status(404, Body.text);
const Empty = Schema.Struct({});
const Open = Schema.Record(Schema.String, Schema.Unknown);
const secret = "private-fixture-value";
const privateFixtureValue = () => secret;
const substitute = () => ["substituted"];
const Filter = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

// Unknown values at these boundaries model JavaScript callers of the public API.
const body =
  <A, E>(encoder: Body.Encoder<A, E>, input: () => unknown): Send =>
  (origin) =>
    Operation.make(
      Request.post(`${origin}/x`).pipe(Request.body(encoder)),
      response,
    ).execute({ body: input() as A });

const json = <S extends WireSchema>(schema: S, input: () => unknown) =>
  body(Body.jsonSchema(schema), input);

const path =
  <S extends WireSchema>(schema: S, input: () => unknown): Send =>
  (origin) =>
    Operation.make(
      Request.get(`${origin}/x`).pipe(
        Request.path(
          schema,
          (value, encode) => `/${encode(JSON.stringify(value))}`,
        ),
      ),
      response,
    ).execute({ path: input() as Request.Input<S> });

type Group = "query" | "headers";
const groups = ["query", "headers"] as const;
const group =
  (kind: Group, schema: WireSchema, input: () => unknown): Send =>
  (origin) => {
    const request = Request.get(`${origin}/x`);
    const value = input() as never;
    return kind === "query"
      ? Operation.make(
          request.pipe(Request.query(schema as never)),
          response,
        ).execute({ query: value })
      : Operation.make(
          request.pipe(Request.headers(schema as never)),
          response,
        ).execute({ headers: value });
  };

export type Wire = {
  readonly method: "GET" | "POST";
  readonly target: string;
  readonly body?: string | ReadonlyArray<number> | undefined;
  readonly headers?: ReadonlyArray<readonly [string, string]> | undefined;
  readonly multipartFields?: ReadonlyArray<readonly [string, string]>;
};

type Refusal = {
  readonly tag: "HttpBodyError" | "InvalidRequest" | "SchemaError";
  readonly field: string;
  readonly omitted?: string | ReadonlyArray<string> | undefined;
};

export type WireCase = {
  readonly name: string;
  readonly send: Send;
  readonly expected: Wire | Refusal;
};

const sent = (name: string, send: Send, expected: Wire): WireCase => ({
  name,
  send,
  expected,
});

const refused = (
  name: string,
  send: Send,
  tag: Refusal["tag"],
  field: string,
  omitted?: Refusal["omitted"],
): WireCase => ({ name, send, expected: { tag, field, omitted } });

const get = (target = "/x", headers?: Wire["headers"]): Wire => ({
  method: "GET",
  target,
  headers,
});
const post = (value: Wire["body"]): Wire => ({
  method: "POST",
  target: "/x",
  body: value,
});
const segment = (text: string) => get(`/x/${encodeURIComponent(text)}`);
const fieldOnWire = (kind: Group, value: string) =>
  kind === "query"
    ? get(`/x?x-value=${value}`)
    : get("/x", [["x-value", value]]);

const Form = Body.formData.pipe(Body.encodeSchema(Schema.fromFormData(Empty)));
const urlEncoded = <S extends WireSchema>(schema: S) =>
  Body.encoder((params: URLSearchParams) =>
    Body.urlEncoded.encode(UrlParams.fromInput(params)),
  ).pipe(Body.encodeSchema(Schema.fromURLSearchParams(schema)));
const SearchParams = urlEncoded(Empty);
const withMixedSibling = <S extends WireSchema>(item: S) =>
  Schema.Struct({ n: Schema.FiniteFromString, item });
const invalidFilter = () => ({ limit: secret });
const mixed = (item: unknown) => ({ n: 1, item });

const DecodingFilter = Schema.Struct({
  limit: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("25")),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));

// Both union members can read the title. Only the first declares meta, and its codec cannot
// encode a string containing a space. The error deliberately reports only what's wrong.
const Word = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: Effect.succeed,
      encode: (value) =>
        value.includes(" ")
          ? Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "Expected a single word" },
                value,
              ),
            )
          : Effect.succeed(value),
    }),
  ),
);
const Title = Schema.Struct({ title: Schema.String });
const Coded = Schema.Struct({ title: Schema.String, meta: Word });
const CodedOrTitle = Schema.Union([Coded, Title]);
const note = () => ({ title: "draft", meta: `${secret} phrase` });

const Named = Schema.Struct({ a: Schema.String });
const NamedOrEmpty = Schema.Union([Named, Empty]);
const Names = Schema.Array(Named);
const HiddenOrOpen = Schema.Union([Names, Schema.Unknown]);

export const wireCases = {
  "52a": groups.flatMap((kind) => [
    sent(
      `${kind} reads pair positions instead of the caller iterator`,
      group(kind, Empty, () =>
        Object.defineProperty([["x-value", "positional"]], Symbol.iterator, {
          value: function* () {
            yield ["x-value", "substituted"];
          },
        }),
      ),
      fieldOnWire(kind, "positional"),
    ),
    sent(
      `${kind} consumes a one-shot iterator once`,
      group(kind, Empty, () => new Map([["x-value", "once"]]).entries()),
      fieldOnWire(kind, "once"),
    ),
    sent(
      `${kind} reads repeat positions without the caller's mapping methods`,
      group(kind, Empty, () => {
        const values = ["a", "b"];
        Object.defineProperties(values, {
          map: { value: substitute },
          flatMap: { value: substitute },
          [Symbol.iterator]: {
            value: function* () {
              yield "substituted";
            },
          },
        });
        return { "x-value": values };
      }),
      fieldOnWire(kind, kind === "query" ? "a&x-value=b" : "a, b"),
    ),
  ]),
  "52b": groups.flatMap((kind) => [
    refused(
      `currently ${kind} refuses a three-cell pair without identifying it`,
      group(kind, Empty, () => [["x-value", secret, "third"]]),
      "InvalidRequest",
      "A field pair must be a two-position array with a string name",
      [secret, "x-value"],
    ),
    refused(
      `currently ${kind} refuses a non-array iterable entry without identifying it`,
      group(kind, Empty, () => new Set(["ab"])),
      "InvalidRequest",
      "A field pair must be a two-position array with a string name",
    ),
    refused(
      `${kind} refuses a defined enumerable non-callable iterator`,
      group(kind, Empty, () => ({
        "x-value": "ok",
        [Symbol.iterator]: secret,
      })),
      "InvalidRequest",
      "Symbol.iterator",
      secret,
    ),
    refused(
      `currently ${kind} refuses a numeric pair without identifying its position`,
      group(kind, Empty, () => [1]),
      "InvalidRequest",
      "A field pair must be a two-position array with a string name",
    ),
    sent(
      `${kind} reads a record with a non-enumerable non-callable iterator`,
      group(kind, Empty, () =>
        Object.defineProperty({ "x-value": "ok" }, Symbol.iterator, {
          value: secret,
        }),
      ),
      fieldOnWire(kind, "ok"),
    ),
  ]),
  "52c": [
    ...(
      [
        ["object", () => ({ note: secret })],
        ["function", () => privateFixtureValue],
        ["symbol", () => Symbol(secret)],
        ["nested list", () => [[secret]]],
      ] as const
    ).map(([name, value]) =>
      refused(
        `query refuses the ${name} value`,
        group("query", Empty, () => ({ "x-value": value() })),
        "InvalidRequest",
        "x-value",
        name === "function" ? [secret, "privateFixtureValue"] : secret,
      ),
    ),
    sent(
      "query writes a scalar list",
      group("query", Empty, () => ({
        "x-value": [null, false, 2n, new Date(0)],
      })),
      get(
        "/x?x-value&x-value=false&x-value=2&x-value=1970-01-01T00%3A00%3A00.000Z",
      ),
    ),
  ],
  "53a": [
    refused(
      "JSON schema writer refuses NaN",
      json(Empty, () => ({ v: NaN })),
      "HttpBodyError",
      '["v"]',
      "NaN",
    ),
    refused(
      "JSON writer refuses a nested function",
      body(Body.json, () => ({
        v: [privateFixtureValue],
      })),
      "HttpBodyError",
      '["v"][0]',
      "privateFixtureValue",
    ),
    refused(
      "JSON writer refuses a symbol value",
      body(Body.json, () => ({ v: Symbol(secret) })),
      "HttpBodyError",
      '["v"]',
      secret,
    ),
    refused(
      "JSON writer refuses a Map",
      body(Body.json, () => ({ v: new Map([["k", secret]]) })),
      "HttpBodyError",
      '["v"]',
      secret,
    ),
    refused(
      "composed JSON writer checks the result of toJSON",
      body(Body.json.pipe(Body.encodeSchema(Empty)), () => ({
        v: [{ toJSON: () => undefined }],
      })),
      "HttpBodyError",
      '["v"][0]',
    ),
    refused(
      "JSON writer refuses an enumerable symbol field",
      body(Body.json, () => ({ v: { [Symbol("hidden")]: secret } })),
      "HttpBodyError",
      "Symbol(hidden)",
      secret,
    ),
    refused(
      "JSON record schema refuses a symbol field it would strip",
      json(Open, () => ({ [Symbol("hidden")]: secret, keep: "ok" })),
      "SchemaError",
      "Symbol(hidden)",
      secret,
    ),
    sent(
      "JSON writer keeps toJSON results, invalid Date null, plain objects and instances",
      body(Body.json, () => {
        class Label {
          readonly name = "instance";
        }
        return {
          converted: { toJSON: () => ({ label: "converted" }) },
          invalid: new Date(NaN),
          plain: { enabled: true, omitted: undefined },
          instance: new Label(),
        };
      }),
      post(
        '{"converted":{"label":"converted"},"invalid":null,"plain":{"enabled":true},"instance":{"name":"instance"}}',
      ),
    ),
  ],
  "53b": [
    refused(
      "URL-encoded record writer refuses null",
      body(Body.urlEncoded, () => ({ v: null, keep: "yes" })),
      "HttpBodyError",
      '["v"]',
    ),
    refused(
      "URL-encoded schema writer refuses an undefined list cell",
      body(SearchParams, () => ({ v: ["ok", undefined] })),
      "HttpBodyError",
      '["v"][1]',
    ),
    refused(
      "multipart schema writer refuses a number",
      body(Form, () => ({ meta: { v: 74317 }, keep: "yes" })),
      "HttpBodyError",
      '["meta"]["v"]',
      "74317",
    ),
    sent(
      "URL-encoded schema writer sends repeated names and skips empty containers",
      body(SearchParams, () => ({ k: ["a b", "c+d"], empty: [], object: {} })),
      post("k=a+b&k=c%2Bd"),
    ),
    sent(
      "URL-encoded record writer sends scalar fields",
      body(Body.urlEncoded, () => ({ v: "a b" })),
      post("v=a+b"),
    ),
    sent(
      "multipart schema writer sends repeated names and skips empty containers",
      body(Form, () => ({ k: ["a", "b"], empty: [], object: {} })),
      {
        ...post(undefined),
        multipartFields: [
          ["k", "a"],
          ["k", "b"],
        ],
      },
    ),
  ],
  "53c": [
    refused(
      "text writer refuses an object",
      body(Body.text, () => ({ v: secret })),
      "HttpBodyError",
      "Text body at $ must be a string",
      secret,
    ),
    refused(
      "bytes writer refuses a string",
      body(Body.bytes, () => secret),
      "HttpBodyError",
      "Bytes body at $ must be a Uint8Array",
      secret,
    ),
    refused(
      "empty writer refuses a supplied value",
      body(Body.empty, () => secret),
      "HttpBodyError",
      "Empty body at $ must have no value",
      secret,
    ),
    sent(
      "text writer sends UTF-8",
      body(Body.text, () => "räksmörgås"),
      post("räksmörgås"),
    ),
    sent(
      "bytes writer sends arbitrary octets",
      body(Body.bytes, () => Uint8Array.of(0, 255, 128)),
      post([0, 255, 128]),
    ),
    sent(
      "empty writer sends zero bytes",
      body(Body.empty, () => undefined),
      post(""),
    ),
  ],
  "53d": [
    refused(
      "query writer refuses an own field beside value-list positions",
      group("query", Empty, () => ({
        "x-value": Object.assign(["ok"], { extra: secret }),
      })),
      "InvalidRequest",
      "extra",
      secret,
    ),
    refused(
      "header writer refuses an own field beside pair positions",
      group("headers", Empty, () => [
        Object.assign(["x-value", "ok"], { extra: secret }),
      ]),
      "InvalidRequest",
      "extra",
      secret,
    ),
    refused(
      "header writer refuses an enumerable symbol field",
      group("headers", Empty, () => ({
        "x-value": "ok",
        [Symbol("hidden")]: secret,
      })),
      "InvalidRequest",
      "Symbol(hidden)",
      secret,
    ),
    sent(
      "header writer sends its ordinary record",
      group("headers", Empty, () => ({ "x-value": "ok" })),
      fieldOnWire("headers", "ok"),
    ),
  ],
  "54a": [
    refused(
      "fieldwise JSON list refuses an invalid decoded name",
      json(withMixedSibling(Schema.Array(Filter)), () =>
        mixed([invalidFilter()]),
      ),
      "SchemaError",
      '["item"][0]["limit"]',
      secret,
    ),
    refused(
      "fieldwise path tuple refuses an invalid encoded name",
      path(withMixedSibling(Schema.Tuple([Schema.String, Filter])), () => ({
        n: "1",
        item: ["fixed", { page_size: secret }],
      })),
      "SchemaError",
      '["item"][1]["page_size"]',
      secret,
    ),
    refused(
      "fieldwise JSON record refuses an invalid decoded name",
      json(withMixedSibling(Schema.Record(Schema.String, Filter)), () =>
        mixed({ row: invalidFilter() }),
      ),
      "SchemaError",
      '["item"]["row"]["limit"]',
      secret,
    ),
    refused(
      "control: fieldwise JSON union refuses an invalid encoded name",
      json(
        withMixedSibling(
          Schema.Union([
            Filter,
            Schema.Struct({ cursor: Schema.optionalKey(Schema.String) }),
          ]),
        ),
        () => mixed({ page_size: secret }),
      ),
      "SchemaError",
      '["item"]["page_size"]',
      secret,
    ),
    refused(
      "fieldwise JSON refuses both names of a field",
      json(
        Schema.Struct({
          n: Schema.FiniteFromString,
          m: Schema.FiniteFromString,
          item: Filter,
        }),
        () => ({
          n: 1,
          m: "2",
          item: { limit: 5, page_size: "03" },
        }),
      ),
      "SchemaError",
      '["item"]["page_size"]',
      "03",
    ),
    refused(
      "fieldwise JSON refuses a value a decoding default would replace",
      json(withMixedSibling(DecodingFilter), () => mixed(invalidFilter())),
      "SchemaError",
      '["item"]["limit"]',
      secret,
    ),
    sent(
      "fieldwise JSON keeps a mixed-side encoded list alias",
      json(withMixedSibling(Schema.Array(Filter)), () =>
        mixed([{ page_size: "05" }]),
      ),
      post('{"n":"1","item":[{"page_size":"5"}]}'),
    ),
    sent(
      "fieldwise JSON writes a valid decoded list and its omitted default",
      json(withMixedSibling(Schema.Array(Filter)), () =>
        mixed([{ limit: 5 }, {}]),
      ),
      post('{"n":"1","item":[{"page_size":"5"},{"page_size":"25"}]}'),
    ),
    sent(
      "fieldwise JSON still fills an omitted decoding default",
      json(withMixedSibling(DecodingFilter), () => mixed({})),
      post('{"n":"1","item":{"page_size":"25"}}'),
    ),
  ],
  "54b": [
    refused(
      "JSON write fallback cannot drop metadata with Void beside the selected member",
      json(
        Schema.Union([
          Schema.Struct({ title: Schema.String, meta: Schema.Unknown }),
          Schema.Void,
          Title,
        ]),
        () => ({ title: "draft", meta: new Date(0) }),
      ),
      "SchemaError",
      '["meta"]',
      "1970-01-01",
    ),
    refused(
      "nested JSON write fallback cannot drop metadata",
      json(Schema.Struct({ note: CodedOrTitle }), () => ({ note: note() })),
      "SchemaError",
      '["note"]["meta"]',
      secret,
    ),
    refused(
      "query write fallback cannot drop metadata",
      group("query", CodedOrTitle, note),
      "SchemaError",
      '["meta"]',
      secret,
    ),
    refused(
      "form write fallback cannot drop metadata before URL encoding",
      body(urlEncoded(CodedOrTitle), note),
      "SchemaError",
      '["meta"]',
      secret,
    ),
    refused(
      "path write fallback cannot drop metadata",
      path(CodedOrTitle, note),
      "SchemaError",
      '["meta"]',
      secret,
    ),
    sent(
      "query writes with the member that keeps metadata",
      group("query", CodedOrTitle, () => ({ title: "draft", meta: "word" })),
      get("/x?title=draft&meta=word"),
    ),
    sent(
      "path writes a title when no metadata was supplied",
      path(CodedOrTitle, () => ({ title: "draft" })),
      segment('{"title":"draft"}'),
    ),
  ],
  "55a": [
    sent(
      "path list member ignores fields stated only by an inapplicable record",
      path(Schema.Struct({ rows: Schema.Union([Open, Names]) }), () => ({
        rows: [{ a: "first", extra: "ignored" }],
      })),
      segment('{"rows":[{"a":"first"}]}'),
    ),
    sent(
      "JSON object member ignores an index stated only by an inapplicable tuple",
      json(
        Schema.Union([
          Schema.Tuple([Named]),
          Schema.Struct({ title: Schema.String }),
        ]),
        () => ({ title: "draft", 0: { a: "ignored" } }),
      ),
      post('{"title":"draft"}'),
    ),
  ],
  "55b": [
    sent(
      "JSON empty member keeps nested keys",
      json(Schema.Union([Schema.Struct({ row: Named }), Empty]), () => ({
        row: { a: "x", z: 1 },
      })),
      post('{"row":{"a":"x","z":1}}'),
    ),
    sent(
      "path empty member keeps the decoded name alongside an extra key",
      path(Schema.Union([Filter, Empty]), () => ({ limit: 5, tag: "x" })),
      segment('{"limit":5,"tag":"x"}'),
    ),
    sent(
      "query empty member keeps the decoded name alongside an extra key",
      group("query", Schema.Union([Filter, Empty]), () => ({
        limit: 5,
        tag: "x",
      })),
      get("/x?limit=5&tag=x"),
    ),
    sent(
      "header empty member keeps all supplied header lines",
      group("headers", NamedOrEmpty, () => ({ a: "x", "x-value": "kept" })),
      get("/x", [
        ["a", "x"],
        ["x-value", "kept"],
      ]),
    ),
    refused(
      "JSON writer refuses a non-finite value kept by an empty member",
      json(NamedOrEmpty, () => ({ a: "x", z: Infinity })),
      "HttpBodyError",
      '["z"]',
      "Infinity",
    ),
    sent(
      "JSON stated member still sends its wire name when it keeps every field",
      json(Schema.Union([Filter, Empty]), () => ({ limit: 5 })),
      post('{"page_size":"5"}'),
    ),
  ],
  "55c": (["non-enumerable", "inherited"] as const).map((visibility) =>
    sent(
      `path list beside an open member keeps its ${visibility} cell when rebuilt`,
      path(HiddenOrOpen, () => {
        const input = [{ a: "first" }, { a: "last", absent: undefined }];
        if (visibility === "non-enumerable") {
          Object.defineProperty(input, 0, { enumerable: false });
        } else {
          const prototype = Object.create(Array.prototype, {
            0: { value: input[0] },
          });
          Reflect.deleteProperty(input, 0);
          Object.setPrototypeOf(input, prototype);
        }
        return input;
      }),
      segment('[{"a":"first"},{"a":"last"}]'),
    ),
  ),
  "55d": [
    refused(
      "currently the header writer refuses a non-text value without naming the field",
      group("headers", NamedOrEmpty, () => ({
        a: "x",
        "x-value": { note: secret },
      })),
      "InvalidRequest",
      "A header line must have a string value",
      [secret, "x-value"],
    ),
  ],
} satisfies Record<string, ReadonlyArray<WireCase>>;

export const outcome = (send: Send, origin: string) =>
  Effect.result(send(origin)).pipe(
    Effect.map((result) => {
      if (result._tag === "Success") return { tag: "Success" };
      const error = result.failure;
      const cause: unknown = error instanceof Error ? error.cause : undefined;
      return {
        tag: Schema.isSchemaError(error)
          ? "SchemaError"
          : typeof error === "object" && error !== null && "_tag" in error
            ? String(error._tag)
            : "UnknownFailure",
        message: error instanceof Error ? error.message : String(error),
        ...(cause instanceof Error ? { cause: cause.message } : {}),
      };
    }),
  );
