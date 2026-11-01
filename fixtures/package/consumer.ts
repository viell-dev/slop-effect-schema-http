import { Effect, Schema } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";

export const getItem = Operation.make(
  Request.get("https://api.test/items").pipe(
    Request.path(
      Schema.String,
      (id, encode) => `https://api.test/items/${encode(id)}`,
    ),
  ),
  Response.status(
    200,
    Body.json.pipe(Body.schema(Schema.Struct({ id: Schema.Number }))),
  ),
  { policy: Policy.none },
);

export const getItemId = (id: string) =>
  getItem.execute({ path: id }).pipe(Effect.map((item) => item.id));

// A consumer must retain the path schema's application type after declaration emit.
// @ts-expect-error The path schema requires a string.
getItem.execute({ path: 123 });
