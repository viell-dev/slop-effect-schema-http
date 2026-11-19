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

class InvalidQueryValue extends TypeError {
  constructor(name: string) {
    super(
      `The query field ${JSON.stringify(name)} must encode a scalar value or a list of scalar values`,
    );
  }
}

export const isInvalidQueryValue = (error: unknown): error is TypeError =>
  error instanceof InvalidQueryValue;

/** Read the native Date brand, including dates from another realm. */
const isDate = (value: object): value is Date => {
  try {
    Date.prototype.getTime.call(value);
    return true;
  } catch {
    return false;
  }
};

const queryText = (name: string, value: unknown): string => {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "object":
      if (value !== null && isDate(value))
        return Number.isNaN(value.getTime())
          ? String(value)
          : value.toISOString();
  }
  throw new InvalidQueryValue(name);
};

export const queryEntries = ({ entries }: Reading): Query => {
  const query: Array<readonly [string, string | null]> = [];
  for (const [name, value] of entries) {
    const write = (entry: unknown) => {
      if (entry !== undefined)
        query.push([name, entry === null ? null : queryText(name, entry)]);
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
