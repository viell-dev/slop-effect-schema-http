import type { Reply } from "../../harness/server.js";

/** A parsed `Content-Type`: the lowercased type and its parameters, unquoted. */
export interface MediaType {
  readonly type: string;
  readonly parameters: ReadonlyMap<string, string>;
}

const parameter =
  /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]*)/g;

export const mediaType = (value: string | undefined): MediaType => {
  if (value === undefined) return { type: "", parameters: new Map() };
  const semicolon = value.indexOf(";");
  const parameters = new Map<string, string>();
  if (semicolon >= 0)
    for (const [, key, raw] of value.slice(semicolon).matchAll(parameter))
      parameters.set(
        key!.toLowerCase(),
        raw!.startsWith('"') ? raw!.slice(1, -1).replace(/\\(.)/g, "$1") : raw!,
      );
  return {
    type: (semicolon < 0 ? value : value.slice(0, semicolon))
      .trim()
      .toLowerCase(),
    parameters,
  };
};

/** A plain-text reply, the only error format the 2009 front controller knows. */
export const plain = (
  status: number,
  message: string,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply => ({
  status,
  lines: [["Content-Type", "text/plain"], ...lines],
  body: `${message}\r\n`,
});

const component = (part: string): string =>
  decodeURIComponent(part.replace(/\+/g, " "));

/** The raw query of a target as `[key, value | null]` pairs; `null` is a bare key. */
export const rawQuery = (
  target: string,
): ReadonlyArray<readonly [string, string | null]> => {
  const start = target.indexOf("?");
  if (start < 0) return [];
  return target
    .slice(start + 1)
    .split("&")
    .filter((segment) => segment !== "")
    .map((segment) => {
      const equals = segment.indexOf("=");
      return equals < 0
        ? [component(segment), null]
        : [
            component(segment.slice(0, equals)),
            component(segment.slice(equals + 1)),
          ];
    });
};
