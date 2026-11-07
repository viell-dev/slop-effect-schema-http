import { Effect, Schema } from "effect";
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

// A consumer must retain a path value's type after declaration emit.
// @ts-expect-error The path value requires a string.
getItem.execute({ path: { id: 123 } });

// A transform held in an exported variable has to be nameable in a declaration.
export const firstFive = Request.setQuery("limit", "5");
export const asText = Response.replace(200, Body.text);
export const withoutMissing = Response.remove(404);
export const toCount = Operation.map(
  (items: ReadonlyArray<string>) => items.length,
);
export const noRetries = Operation.mapOptions(() => ({ policy: Policy.none }));

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
  // @ts-expect-error A response the mapping was not written for needs Operation.unmap.
  countNames.pipe(Operation.mapResponse(asText));
  // @ts-expect-error This contract has no 500 case.
  listNames.parts?.response.pipe(Response.remove(500));
  // @ts-expect-error An operation sealed with fromEffect has no parts.
  Operation.fromEffect(listNames.execute).pipe(Operation.mapRequest(firstFive));
};
