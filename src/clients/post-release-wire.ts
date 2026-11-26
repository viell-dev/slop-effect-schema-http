/** Consumer contracts for the neutral echo probe, exercised from source and from the built app. */
import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";
import type { HttpClient } from "effect/http";
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
const limit = Schema.optionalKey(Schema.FiniteFromString).pipe(
  Schema.withConstructorDefault(Effect.succeed(25)),
);
const Filter = Schema.Struct({ limit }).pipe(
  Schema.encodeKeys({ limit: "page_size" }),
);

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
  readonly message?: string;
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

const malformedPair = (
  kind: Group,
  name: string,
  input: () => unknown,
  index: number,
  omitted?: Refusal["omitted"],
): WireCase => {
  const label = kind === "headers" ? "header" : "query";
  const field = `The field pair at $[${index}] must be a two-position array with a string name`;
  return {
    name,
    send: group(kind, Empty, input),
    expected: {
      tag: "InvalidRequest",
      field,
      message: `The ${label} schema must encode a field record or field pairs: ${field}`,
      omitted,
    },
  };
};

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
  Body.urlEncoded.pipe(Body.encodeSchema(Schema.fromURLSearchParams(schema)));
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

class Counted extends Schema.Class<Counted>("Counted")({ a: Schema.String }) {
  readonly reads = 1;
}

const CountedRoot = Schema.Struct({ limit, counted: Counted }).pipe(
  Schema.encodeKeys({ limit: "page_size" }),
);
class UnionHolder extends Schema.Class<UnionHolder>("UnionHolder")({
  item: Schema.Union([Filter, Counted]),
}) {
  readonly reads = 1;
}
class NestedClass extends Schema.Class<NestedClass>("NestedClass")({
  row: Named,
}) {}
class ListHolder extends Schema.Class<ListHolder>("ListHolder")({
  item: Schema.Union([Open, Names]),
}) {}
class UndefinedOnly {
  readonly z = undefined;
}

const groupWire = (
  kind: Group,
  pairs: ReadonlyArray<readonly [string, string]>,
) =>
  kind === "query"
    ? get(`/x?${pairs.map(([name, value]) => `${name}=${value}`).join("&")}`)
    : get(
        "/x",
        pairs.toSorted(([name], [other]) => name.localeCompare(other)),
      );

const stacked =
  (
    kind: Group,
    [first, second]: readonly [WireSchema, WireSchema],
    input: () => unknown,
  ): Send =>
  (origin) => {
    const request = Request.get(`${origin}/x`);
    return kind === "query"
      ? Operation.make(
          request.pipe(
            Request.query(first as never),
            Request.query(second as never),
          ),
          response,
        ).execute({ query: input() as never })
      : Operation.make(
          request.pipe(
            Request.headers(first as never),
            Request.headers(second as never),
          ),
          response,
        ).execute({ headers: input() as never });
  };

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
    malformedPair(
      kind,
      `${kind} refuses a three-cell pair at its position`,
      () => [["x-value", secret, "third"]],
      0,
      [secret, "x-value"],
    ),
    malformedPair(
      kind,
      `${kind} refuses a non-array iterable entry at its position`,
      () => new Set(["ab"]),
      0,
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
    malformedPair(
      kind,
      `${kind} refuses a numeric pair at its position`,
      () => [1],
      0,
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
      "the header writer refuses a non-text value and names the field",
      group("headers", NamedOrEmpty, () => ({
        a: "x",
        "x-value": { note: secret },
      })),
      "InvalidRequest",
      'The header field "x-value" must have a string value',
      secret,
    ),
  ],
  "57a": [
    ...(
      [
        [
          "root class sibling",
          CountedRoot,
          (page_size: string) => ({ page_size, counted: { a: "x" } }),
          '{"page_size":"5","counted":{"a":"x"}}',
          '["page_size"]',
        ],
        [
          "class field sibling",
          Schema.Struct({ item: Filter, counted: Counted }),
          (page_size: string) => ({ item: { page_size }, counted: { a: "x" } }),
          '{"item":{"page_size":"5"},"counted":{"a":"x"}}',
          '["item"]["page_size"]',
        ],
        [
          "record",
          Schema.Record(Schema.String, Filter),
          (page_size: string) => ({ row: { page_size } }),
          '{"row":{"page_size":"5"}}',
          '["row"]["page_size"]',
        ],
        [
          "suspension",
          Schema.suspend(() => Filter),
          (page_size: string) => ({ page_size }),
          '{"page_size":"5"}',
          '["page_size"]',
        ],
        [
          "list",
          Schema.Array(Filter),
          (page_size: string) => [{ page_size }],
          '[{"page_size":"5"}]',
          '[0]["page_size"]',
        ],
        [
          "union",
          Schema.Union([Filter, Schema.Struct({ cursor: Schema.String })]),
          (page_size: string) => ({ page_size }),
          '{"page_size":"5"}',
          '["page_size"]',
        ],
      ] as const satisfies ReadonlyArray<
        readonly [
          string,
          WireSchema,
          (alias: string) => unknown,
          string,
          string,
        ]
      >
    ).flatMap(([name, schema, input, bytes, field]) => [
      sent(
        `JSON ${name} keeps the encoded alias`,
        json(schema, () => input("05")),
        post(bytes),
      ),
      refused(
        `JSON ${name} refuses an invalid alias`,
        json(schema, () => input("many")),
        "SchemaError",
        field,
      ),
    ]),
    sent(
      "JSON omitted root alias takes the constructor default",
      json(CountedRoot, () => ({ counted: { a: "x" } })),
      post('{"page_size":"25","counted":{"a":"x"}}'),
    ),
    refused(
      "JSON agreeing root names refuse",
      json(Filter, () => ({ limit: 5, page_size: "5" })),
      "SchemaError",
      '["page_size"]',
    ),
  ],
  "57b": [
    refused(
      "JSON decoding default cannot replace invalid root input",
      json(DecodingFilter, () => ({ limit: "x" })),
      "SchemaError",
      '["limit"]',
    ),
    refused(
      "JSON decoding default cannot replace invalid list input",
      json(Schema.Array(DecodingFilter), () => [{ limit: "x" }]),
      "SchemaError",
      '[0]["limit"]',
    ),
    refused(
      "JSON decoding default cannot replace valid decoded list input beside an omission",
      json(Schema.Array(DecodingFilter), () => [{ limit: 5 }, {}]),
      "SchemaError",
      '[0]["limit"]',
    ),
    sent(
      "JSON decoding default list control keeps a decoded value",
      json(Schema.Array(DecodingFilter), () => [{ limit: 5 }]),
      post('[{"page_size":"5"}]'),
    ),
    ...groups.flatMap((kind) => [
      sent(
        `${kind} encodes a valid alias`,
        group(kind, Filter, () => ({ page_size: "05" })),
        groupWire(kind, [["page_size", "5"]]),
      ),
      refused(
        `${kind} refuses an invalid alias despite a constructor default`,
        group(kind, Filter, () => ({ page_size: "many" })),
        "SchemaError",
        '["page_size"]',
      ),
      refused(
        `${kind} refuses an invalid decoded name despite a decoding default`,
        group(kind, DecodingFilter, () => ({ limit: "x" })),
        "SchemaError",
        '["limit"]',
      ),
    ]),
  ],
  "58": groups.flatMap((kind) =>
    [false, true].flatMap((reverse) => {
      const order = reverse ? "sibling first" : "sibling last";
      const sibling = Schema.Struct({ page_size: Schema.String });
      const side = Schema.Struct({ a: Schema.String });
      const canLose = Schema.Union([
        side,
        Schema.Struct({ page_size: Schema.FiniteFromString }),
      ]);
      const canReplace = Schema.Union([Filter, side]);
      const bind = (schema: WireSchema, input: () => unknown) =>
        stacked(kind, reverse ? [sibling, schema] : [schema, sibling], input);
      return [
        sent(
          `${kind} ${order} leaves a field to its sibling when it writes nothing in its place`,
          bind(canLose, () => ({
            a: "x",
            page_size: "many",
          })),
          groupWire(
            kind,
            reverse
              ? [
                  ["page_size", "many"],
                  ["a", "x"],
                ]
              : [
                  ["a", "x"],
                  ["page_size", "many"],
                ],
          ),
        ),
        refused(
          `${kind} ${order} cannot substitute a default for the sibling's field`,
          bind(canReplace, () => ({ page_size: "many" })),
          "SchemaError",
          '["page_size"]',
        ),
      ];
    }),
  ),
  "59": [
    sent(
      "a class instance beside a struct that would strip it is written through its class, beside a class-valued sibling",
      json(
        Schema.Struct({
          item: Schema.Union([Filter, Counted]),
          counted: Counted,
        }),
        () => ({
          item: new Counted({ a: "item" }),
          counted: new Counted({ a: "sibling" }),
        }),
      ),
      post('{"item":{"a":"item"},"counted":{"a":"sibling"}}'),
    ),
    sent(
      "Effect constructs the holder with the defaulted struct member before preparation",
      json(UnionHolder, () => {
        const holder = new UnionHolder({ item: new Counted({ a: "item" }) });
        if (
          holder.item instanceof Counted ||
          holder.item.limit !== 25 ||
          Object.keys(holder.item).length !== 1
        ) {
          throw new Error("Expected the holder constructor to choose Filter");
        }
        return holder;
      }),
      post('{"item":{"page_size":"25"}}'),
    ),
    sent(
      "a struct field writes a Counted instance beside Filter through its class",
      json(Schema.Struct({ item: Schema.Union([Filter, Counted]) }), () => ({
        item: new Counted({ a: "item" }),
      })),
      post('{"item":{"a":"item"}}'),
    ),
    sent(
      "a later open member does not take a class value the first member holds",
      json(
        Schema.Struct({
          item: Schema.Union([Counted, Schema.Unknown]),
          counted: Counted,
        }),
        () => ({
          item: new Counted({ a: "item" }),
          counted: new Counted({ a: "sibling" }),
        }),
      ),
      post('{"item":{"a":"item"},"counted":{"a":"sibling"}}'),
    ),
  ],
  "60": [
    refused(
      "open JSON record refuses a Map before rebuilding it",
      json(Open, () => new Map([["a", 1]])),
      "SchemaError",
      "The schema cannot keep the content of this value",
    ),
    refused(
      "ObjectKeyword JSON root refuses a Date before rebuilding it",
      json(Schema.ObjectKeyword, () => new Date(0)),
      "SchemaError",
      "The schema cannot keep the content of this value",
    ),
    refused(
      "nested ObjectKeyword refuses a Map",
      json(Schema.Struct({ row: Schema.ObjectKeyword }), () => ({
        row: new Map([["a", 1]]),
      })),
      "SchemaError",
      '["row"]',
    ),
    refused(
      "open record inside a JSON list refuses a URL",
      json(Schema.Array(Open), () => [new URL("https://example.test/x")]),
      "SchemaError",
      "[0]",
    ),
    ...groups.map((kind) =>
      refused(
        `${kind} open record refuses a Date`,
        group(
          kind,
          Schema.Record(Schema.String, Schema.String),
          () => new Date(0),
        ),
        "SchemaError",
        "The schema cannot keep the content of this value",
      ),
    ),
    sent(
      "open JSON record still writes an instance with fields",
      json(Open, () => new Counted({ a: "x" })),
      post('{"a":"x","reads":1}'),
    ),
  ],
  "61": [
    refused(
      "a JSON list refusal names only the innermost lost field",
      json(
        Schema.Struct({
          item: Schema.Array(DecodingFilter),
          n: Schema.FiniteFromString,
        }),
        () => ({ item: [{ limit: "x" }], n: 1 }),
      ),
      "SchemaError",
      '["item"][0]["limit"]',
      ['at ["item"]\n', 'at ["item"][0]\n'],
    ),
    malformedPair(
      "query",
      "malformed query pair refuses at the second position",
      () => [["a", "ok"], ["b"]],
      1,
    ),
  ],
  "62": [
    sent(
      "undefined-only instance beside Void and an empty struct stays an object",
      json(
        Schema.Union([
          Schema.Struct({ a: Schema.optionalKey(Schema.String) }),
          Schema.Void,
          Empty,
        ]),
        () => new UndefinedOnly(),
      ),
      post("{}"),
    ),
    sent(
      "Void before a suspended class leaves the populated value to it",
      json(Schema.Union([Schema.Void, Schema.suspend(() => Counted)]), () => ({
        a: "x",
      })),
      post('{"a":"x"}'),
    ),
    sent(
      "Void before String leaves a scalar string to String",
      json(Schema.Union([Schema.Void, Schema.String]), () => "hello"),
      post('"hello"'),
    ),
    refused(
      "a scalar in a Void field refuses at that field",
      json(Schema.Struct({ ack: Schema.Void }), () => ({ ack: 5 })),
      "SchemaError",
      'Expected void\n  at ["ack"]',
    ),
    ...(
      [
        ["number", () => 5],
        ["Date", () => new Date(0)],
        ["Map", () => new Map()],
      ] as const
    ).map(([name, input]) =>
      refused(
        `standalone Void refuses a ${name}`,
        json(Schema.Void, input),
        "SchemaError",
        "Expected void",
      ),
    ),
    refused(
      "a scalar union cannot discard a populated list through Void",
      json(Schema.Union([Schema.String, Schema.Void]), () => ["kept"]),
      "SchemaError",
      "Expected void",
    ),
    refused(
      "standalone Void cannot discard a hidden populated cell",
      json(Schema.Void, () => Object.defineProperty([], 0, { value: "kept" })),
      "SchemaError",
      "Expected void",
    ),
    sent(
      "an empty struct after Void keeps a populated object",
      json(Schema.Union([Schema.Void, Empty]), () => ({ tag: "kept" })),
      post('{"tag":"kept"}'),
    ),
    refused(
      "a renamed encoded field cannot lose a populated value through Void",
      json(
        Schema.Struct({ item: Schema.Void }).pipe(
          Schema.encodeKeys({ item: "wire" }),
        ),
        () => ({ wire: { a: "kept" } }),
      ),
      "SchemaError",
      '["wire"]',
    ),
    sent(
      "a suspended encoded member beside Void preserves its alias",
      json(Schema.Union([Schema.Void, Schema.suspend(() => Filter)]), () => ({
        page_size: "05",
      })),
      post('{"page_size":"5"}'),
    ),
    ...(
      [
        ["Unknown", Schema.Unknown],
        ["Any", Schema.Any],
        ["ObjectKeyword", Schema.ObjectKeyword],
        ["empty struct", Empty],
      ] as const
    ).map(([name, member]) =>
      sent(
        `${name} retains list items' nested keys beside a class`,
        json(Schema.Array(Schema.Union([NestedClass, member])), () => [
          { row: { a: "x", extra: "kept" } },
        ]),
        post('[{"row":{"a":"x","extra":"kept"}}]'),
      ),
    ),
  ],
  "63": [
    sent(
      "path list beside a class and record uses the list member",
      path(Schema.Union([Counted, Open, Names]), () => [
        { a: "x", extra: "not stated by list" },
      ]),
      segment('[{"a":"x"}]'),
    ),
    sent(
      "class field list beside a record uses the list member",
      json(ListHolder, () => ({
        item: [{ a: "x", extra: "not stated by list" }],
      })),
      post('{"item":[{"a":"x"}]}'),
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
