export type Pair = readonly [string, unknown];

export interface RecordFields {
  readonly kind: "record";
  readonly entries: ReadonlyArray<Pair>;
  readonly record: object;
  readonly definedDataFields: ReadonlySet<string>;
}

export type Reading =
  | RecordFields
  | { readonly kind: "pairs"; readonly entries: ReadonlyArray<Pair> };

class MalformedPair extends TypeError {
  constructor() {
    super("A field pair must be a two-position array with a string name");
  }
}

export const isMalformedPair = (error: unknown): error is TypeError =>
  error instanceof MalformedPair;

const readPair = (pair: unknown): Pair => {
  if (!Array.isArray(pair) || pair.length !== 2) throw new MalformedPair();
  const name: unknown = pair[0];
  if (typeof name !== "string") throw new MalformedPair();
  return [name, pair[1]];
};

const readRecord = (input: object, iterator: unknown): RecordFields => {
  const entries: Pair[] = [];
  const record = {};
  const definedDataFields = new Set<string>();
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.enumerable !== true) continue;
    if (typeof key === "string") {
      const value: unknown = Reflect.get(input, key);
      entries.push([key, value]);
      Object.defineProperty(record, key, { value, enumerable: true });
      if (
        typeof input === "object" &&
        "value" in descriptor &&
        descriptor.value !== undefined
      )
        definedDataFields.add(key);
    } else {
      // Symbol fields are visible to schema settlement, but never become wire entries.
      Object.defineProperty(
        record,
        key,
        key === Symbol.iterator
          ? { value: iterator, enumerable: true }
          : { get: (): unknown => Reflect.get(input, key), enumerable: true },
      );
    }
  }
  return { kind: "record", entries, record, definedDataFields };
};

/** Read one output. The record-only route leaves arrays and iterables unread during recovery. */
export function read(input: object): Reading;
export function read(input: object, mode: "record"): RecordFields | undefined;
export function read(input: object, mode?: "record"): Reading | undefined {
  if (Array.isArray(input)) {
    if (mode === "record") return undefined;
    const entries: Pair[] = [];
    const length = input.length;
    for (let index = 0; index < length; index++)
      entries.push(readPair(input[index]));
    return { kind: "pairs", entries };
  }
  const iterator: unknown = Reflect.get(input, Symbol.iterator);
  if (typeof iterator === "function") {
    if (mode === "record") return undefined;
    const iterable = {
      [Symbol.iterator]: () =>
        Reflect.apply(iterator, input, []) as Iterator<unknown>,
    };
    return { kind: "pairs", entries: Array.from(iterable, readPair) };
  }
  return readRecord(input, iterator);
}
