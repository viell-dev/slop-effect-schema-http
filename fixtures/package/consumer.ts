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
