import type { Lines } from "../Transport.js";
import type { Query } from "../UrlEncoding.js";
import type { Reading } from "./field-pairs.js";

/** Expand present positions, including inherited positions, as array map would. */
const forEachValue = (
  values: ReadonlyArray<unknown>,
  write: (value: unknown) => void,
): void => {
  const length = values.length;
  for (let index = 0; index < length; index++)
    if (index in values) write(values[index]);
};

const queryText = (value: unknown): string =>
  value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : String(value);

export const queryEntries = ({ entries }: Reading): Query => {
  const query: Array<readonly [string, string | null]> = [];
  for (const [name, value] of entries) {
    const write = (entry: unknown) => {
      if (entry !== undefined)
        query.push([name, entry === null ? null : queryText(entry)]);
    };
    if (Array.isArray(value)) forEachValue(value, write);
    else write(value);
  }
  return query;
};

const headerLine = (
  name: string,
  value: unknown,
): readonly [string, string] => {
  if (typeof value !== "string")
    throw new TypeError("A header line must have a string value");
  return [name, value];
};

export const headerEntries = ({ kind, entries }: Reading): Lines => {
  if (kind === "pairs")
    return entries.map(([name, value]) => headerLine(name, value));
  const lines: Array<readonly [string, string]> = [];
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      forEachValue(value, (entry) => lines.push(headerLine(name, entry)));
    else lines.push(headerLine(name, value));
  }
  return lines;
};
