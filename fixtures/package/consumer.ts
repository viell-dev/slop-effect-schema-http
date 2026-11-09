import { Context, Effect, Schema, SchemaTransformation } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";

const itemId = Request.pathValue("id");

export const getItem = Operation.make(
  Request.get("https://api.test/items").pipe(Request.path`/${itemId}`),
  Response.status(
    200,
    Body.json.pipe(Body.schema(Schema.Struct({ id: Schema.Number }))),
  ),
  { policy: Policy.none },
);

export const getItemId = (id: string) =>
  getItem.execute({ path: { id } }).pipe(Effect.map((item) => item.id));

// A renderer has to keep its schema's types through the declarations too.
export const getFolder = Request.get("https://api.test/files").pipe(
  Request.path(Schema.String, (folder, encode) => `/${encode(folder)}/`),
);

// Both sides must survive a partly renamed schema in the installed declarations.
const Filters = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
    Schema.withConstructorDefault(Effect.succeed(25)),
  ),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const filtered = Request.get("https://api.test/filtered").pipe(
  Request.query(Schema.Union([Filters])),
);
export const encodedFilters: Request.Input<typeof Filters> = {
  page_size: "05",
};
export const compileEncodedFilters = () =>
  Request.compile(filtered, { query: { page_size: "05" } });
export const compileDecodedFilters = () =>
  Request.compile(filtered, { query: { limit: 5 } });
export const compileInvalidEncodedFilters = () =>
  Request.compile(filtered, { query: { page_size: "many" } });
export const compileOmittedFilters = () =>
  Request.compile(filtered, { query: {} });

const Cursor = Schema.Struct({ cursor: Schema.String });
const paged = Request.get("https://api.test/paged").pipe(
  Request.query(Schema.Union([Filters, Cursor])),
  Request.query(Cursor),
);
export const compileStackedEncodedFilters = () =>
  Request.compile(paged, { query: { page_size: "05", cursor: "next" } });

const Exchanged = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("a"),
    limit: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ limit: "page_size" })),
  Schema.Struct({
    kind: Schema.Literal("b"),
    page_size: Schema.optionalKey(Schema.String),
  }).pipe(Schema.encodeKeys({ page_size: "limit" })),
]);
const exchanged = Request.get("https://api.test/exchanged").pipe(
  Request.query(Exchanged),
);
export const compileExchangedFirst = () =>
  Request.compile(exchanged, { query: { kind: "a", page_size: "05" } });
export const compileExchangedSecond = () =>
  Request.compile(exchanged, { query: { kind: "b", limit: "07" } });

class Token {
  private readonly value = "token";
  read() {
    return this.value;
  }
}
const NativeToken = Schema.declare(
  (input): input is Token => input instanceof Token,
);
const WireToken = Schema.declare(
  (input): input is Token & { readonly hint?: string } =>
    input instanceof Token,
);
const TokenCodec = WireToken.pipe(
  Schema.decodeTo(
    NativeToken,
    SchemaTransformation.transform({
      decode: (input) => input,
      encode: (input) => input,
    }),
  ),
);
export const nominalInput: Request.Input<typeof TokenCodec> = new Token();

// https://github.com/viell-dev/slop-effect-schema-http/issues/172
const NestedFields = Schema.Struct({
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ limit: "page_size" }));
const Nested = Schema.Struct({ filter: NestedFields });
export const nestedRequest = Request.get("https://api.test/nested").pipe(
  Request.path(Nested, (value) => `/${value.filter.page_size ?? ""}`),
);
export const nestedInput: Request.Input<typeof Nested> = {
  filter: { page_size: "05" },
};
export const compileNestedEncoded = () =>
  Request.compile(nestedRequest, { path: nestedInput });
export const compileNestedDecoded = () =>
  Request.compile(nestedRequest, { path: { filter: { limit: "05" } } });
export const compileNestedBody = () =>
  Request.compile(
    Request.post("https://api.test/nested").pipe(
      Request.body(Body.jsonSchema(Nested)),
    ),
    { body: { filter: { page_size: "05" } } },
  );
const nestedList = Request.get("https://api.test/nested").pipe(
  Request.path(
    Schema.Array(NestedFields),
    (value) => `/${value[0]?.page_size}`,
  ),
);
export const compileNestedList = () =>
  Request.compile(nestedList, { path: [{ page_size: "05" }] });
const nestedTuple = Request.get("https://api.test/nested").pipe(
  Request.path(
    Schema.Tuple([NestedFields, Schema.String]),
    (value) => `/${value[0].page_size}/${value[1]}`,
  ),
);
export const compileNestedTuple = () =>
  Request.compile(nestedTuple, { path: [{ page_size: "05" }, "x"] });
class NestedClass extends Schema.Class<NestedClass>("PackedNestedClass")({
  filter: NestedFields,
}) {}
class BrandedNestedClass extends Schema.Class<
  BrandedNestedClass,
  { readonly PackedNested: unique symbol }
>("PackedBrandedNestedClass")({ filter: NestedFields }) {}
export const compileNestedClass = () =>
  Request.compile(
    Request.get("https://api.test/nested").pipe(
      Request.path(BrandedNestedClass, (value) => `/${value.filter.page_size}`),
    ),
    { path: { filter: { page_size: "05" } } },
  );
export const nestedClassConstructor: Request.Input<typeof NestedClass> = {
  filter: { limit: "05" },
};
const NestedToken = Schema.Struct({ token: TokenCodec });
export const nestedNominalInput: Request.Input<typeof NestedToken> = {
  token: new Token(),
};
const nestedMap = Request.get("https://api.test/nested").pipe(
  Request.path(
    Schema.Struct({ options: Schema.ReadonlyMap(Schema.String, NestedFields) }),
    (value) => `/${value.options.get("page")?.page_size}`,
  ),
);
export const nestedMapEncoded: Request.InputOf<typeof nestedMap> = {
  path: { options: new Map([["page", { term: "x", page_size: "05" }]]) },
};
export const compileNestedMap = () =>
  Request.compile(nestedMap, {
    path: { options: new Map([["page", { term: "x", limit: "05" }]]) },
  });
const correlatedFields = {
  common: Schema.optionalKey(Schema.String),
  term: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
};
const CorrelatedNested = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("a"),
    filter: Schema.Struct(correlatedFields).pipe(
      Schema.encodeKeys({ term: "search_a", limit: "page_size" }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("b"),
    filter: Schema.Struct(correlatedFields).pipe(
      Schema.encodeKeys({ term: "search_b", limit: "page_size" }),
    ),
  }),
]);
const correlatedNested = Request.get("https://api.test/nested").pipe(
  Request.path(CorrelatedNested, (value) =>
    value.kind === "a"
      ? `/a/${value.filter.search_a}`
      : `/b/${value.filter.search_b}`,
  ),
);
export const compileCorrelatedNested = () =>
  Request.compile(correlatedNested, {
    path: { kind: "a", filter: { search_a: "x", page_size: "05" } },
  });

export const bindNested = <S extends Schema.Top>(schema: S) =>
  Request.get("https://api.test/nested").pipe(
    Request.path(schema, () => "/generic"),
  );
export const compileGenericNested = () =>
  Request.compile(bindNested(Nested), {
    path: { filter: { page_size: "05" } },
  });
class NestedDecode extends Context.Service<NestedDecode, string>()(
  "packed/NestedDecode",
) {}
class NestedEncode extends Context.Service<NestedEncode, string>()(
  "packed/NestedEncode",
) {}
const ServiceText = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => Effect.as(NestedDecode, value),
      encode: (value) => Effect.as(NestedEncode, value),
    }),
  ),
);
const ServiceNested = Schema.Struct({
  filter: Schema.Struct({
    term: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(ServiceText),
  }).pipe(Schema.encodeKeys({ limit: "page_size" })),
});
export const compileNestedWithServices = () =>
  Request.compile(bindNested(ServiceNested), {
    path: { filter: { page_size: "05" } },
  }).pipe(
    Effect.provideService(NestedDecode, "decode"),
    Effect.provideService(NestedEncode, "encode"),
  );

// A consumer must retain a path value's type after declaration emit.
// @ts-expect-error The path value requires a string.
getItem.execute({ path: { id: 123 } });

// A request's and an operation's input have to be nameable after declaration emit.
export type FolderInput = Request.InputOf<typeof getFolder>;
export type ItemInput = Operation.InputOf<typeof getItem>;
export const itemInput: ItemInput = { path: { id: "a" } };

// A transform held in an exported variable has to be nameable in a declaration.
export const firstFive = Request.setQuery("limit", "5");
export const asText = Response.replace(200, Body.text);
export const withoutMissing = Response.remove(404);
export const toCount = Operation.map(
  (items: ReadonlyArray<string>) => items.length,
);
export const noRetries = Operation.mapOptions(() => ({ policy: Policy.none }));
const text = Response.status(200, Body.text);

export const withNoContent = Operation.mapResponse((response: typeof text) =>
  response.pipe(Response.orElse(Response.status(204, Body.empty))),
);
export const textOrNothing = Operation.make(
  Request.get("https://api.test/text"),
  text,
).pipe(withNoContent);
export const removeKey = <K extends Response.Key>(key: K) =>
  Response.remove(key);

const Names = Body.jsonSchema(Schema.Array(Schema.String));

export const listNames = Operation.make(
  Request.get("https://api.test/names?limit=25"),
  Response.status(200, Names).pipe(
    Response.orElse(Response.status(404, Names)),
  ),
);
export const countNames = listNames.pipe(toCount);
export const countFewNames = countNames.pipe(
  Operation.mapRequest(firstFive),
  Operation.mapResponse(withoutMissing),
  noRetries,
);
export const listText = countNames.pipe(
  Operation.unmap,
  Operation.mapResponse(asText),
);

// Never called: the compiler refuses each of these through the emitted declarations.
export const refused = () => {
  // @ts-expect-error Nested encoded values retain their value type.
  Request.compile(nestedRequest, { path: { filter: { page_size: 5 } } });
  // @ts-expect-error Unknown nested names remain a compile error.
  Request.compile(nestedRequest, { path: { filter: { absent: "05" } } });
  // @ts-expect-error A nested alias does not make its containing field optional.
  Request.compile(nestedRequest, { path: {} });
  // @ts-expect-error Nested tuple input retains its second member.
  Request.compile(nestedTuple, { path: [{ page_size: "05" }] });
  const mismatched: Request.Input<typeof CorrelatedNested> = {
    kind: "a",
    // @ts-expect-error The discriminant preserves the nested encoded alias's member.
    filter: { search_b: "x", page_size: "05" },
  };
  const nestedForged: Request.Input<typeof NestedToken> = {
    // @ts-expect-error Whole-side retention cannot erase a nested private identity.
    token: { read: () => "forged" },
  };
  void [mismatched, nestedForged];
  // @ts-expect-error Opaque sides retain their private class identity.
  const forged: Request.Input<typeof TokenCodec> = { read: () => "forged" };
  void forged;
  // @ts-expect-error The encoded alias requires text, not a decoded number.
  Request.compile(filtered, { query: { page_size: 5 } });
  // @ts-expect-error A response the mapping was not written for needs Operation.unmap.
  countNames.pipe(Operation.mapResponse(asText));
  // @ts-expect-error This contract has no 500 case.
  listNames.parts?.response.pipe(Response.remove(500));
  // @ts-expect-error An operation sealed with fromEffect has no parts.
  Operation.fromEffect(listNames.execute).pipe(Operation.mapRequest(firstFive));
};
