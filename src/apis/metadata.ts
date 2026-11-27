/** What the service tables' consumers read from response metadata, shared between them. */
import type { Response } from "viell-effect-schema-http";

/** The media type of a response, without parameters. */
export const mediaType = (info: Response.Metadata): string =>
  (info.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
