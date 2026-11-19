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
const dateText = (value: object): string | undefined => {
  let time: number;
  try {
    time = Date.prototype.getTime.call(value);
  } catch {
    return undefined;
  }
  return Number.isNaN(time)
    ? "Invalid Date"
    : Date.prototype.toISOString.call(value);
};

export const queryScalar = (
  name: string,
  value: unknown,
): string | null | undefined => {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "object": {
      const text = dateText(value);
      if (text !== undefined) return text;
      break;
    }
  }
  throw new InvalidQueryValue(name);
};

export const queryEntries = ({ entries }: Reading): Query => {
  const query: Array<readonly [string, string | null]> = [];
  for (const [name, value] of entries) {
    const write = (entry: unknown) => {
      const text = queryScalar(name, entry);
      if (text !== undefined) query.push([name, text]);
    };
    if (Array.isArray(value)) forEachValue(value, write);
    else write(value);
  }
  return query;
};

class InvalidHeaderValue extends TypeError {
  constructor() {
    super("A header line must have a string value");
  }
}

export const isInvalidHeaderValue = (error: unknown): error is TypeError =>
  error instanceof InvalidHeaderValue;

const headerLine = (
  name: string,
  value: unknown,
): readonly [string, string] => {
  if (typeof value !== "string") throw new InvalidHeaderValue();
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
