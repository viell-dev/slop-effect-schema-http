import { Predicate } from "effect";
import { extraArrayField, textPath, WriterError } from "./writer-error.js";

export type Pair = readonly [string, unknown];

export interface RecordFields {
  readonly kind: "record";
  readonly entries: ReadonlyArray<Pair>;
  readonly record: object;
  readonly definedDataFields: ReadonlySet<string>;
  readonly symbols: ReadonlyArray<symbol> | undefined;
}

export type Reading =
  | RecordFields
  | { readonly kind: "pairs"; readonly entries: ReadonlyArray<Pair> };

class MalformedPair extends WriterError {}

export const isMalformedPair = (error: WriterError): error is MalformedPair =>
  error instanceof MalformedPair;

const readPair = (pair: unknown, index: number): Pair => {
  const name: unknown =
    Array.isArray(pair) && pair.length === 2 ? pair[0] : undefined;
  if (!Array.isArray(pair) || typeof name !== "string")
    throw new MalformedPair(
      `The field pair at ${textPath([index])} must be a two-position array with a string name`,
    );
  const extra = extraArrayField(pair, 2);
  if (extra !== undefined)
    throw new MalformedPair(
      `The field pair ${JSON.stringify(name)} has an extra array field at ${textPath([extra])}`,
    );
  return [name, pair[1]];
};

const readRecord = (input: object, iterator: unknown): RecordFields => {
  const entries: Pair[] = [];
  const record = {};
  const definedDataFields = new Set<string>();
  let symbols: symbol[] | undefined;
  // Function outputs supply wire fields, but no generated-field evidence, as in 0.18.0.
  const canProveGeneratedFields = typeof input === "object";
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.enumerable !== true) continue;
    if (typeof key === "string") {
      const value: unknown = Reflect.get(input, key);
      entries.push([key, value]);
      Object.defineProperty(record, key, { value, enumerable: true });
      if (
        canProveGeneratedFields &&
        "value" in descriptor &&
        descriptor.value !== undefined
      )
        definedDataFields.add(key);
    } else {
      // Keep symbols visible to schema settlement. The writer decides whether it can send them.
      (symbols ??= []).push(key);
      if (key === Symbol.iterator) {
        Object.defineProperty(record, key, {
          value: iterator,
          enumerable: true,
        });
      } else {
        let value: unknown;
        let read = false;
        Object.defineProperty(record, key, {
          enumerable: true,
          get: () => {
            if (!read) {
              value = Reflect.get(input, key);
              read = true;
            }
            return value;
          },
        });
      }
    }
  }
  return { kind: "record", entries, record, definedDataFields, symbols };
};

const invalidIterator = () =>
  new MalformedPair(
    "A field pairs iterable must return an iterator with a callable next method",
  );

/** Validate protocol results while preserving the caller's receiver and iterator cleanup. */
const checkedIterator = (iterator: unknown): Iterator<unknown> => {
  if (!Predicate.isObjectKeyword(iterator)) throw invalidIterator();
  const next: unknown = Reflect.get(iterator, "next");
  if (typeof next !== "function") throw invalidIterator();
  return {
    next() {
      const result: unknown = Reflect.apply(next, iterator, []);
      if (!Predicate.isObjectKeyword(result))
        throw new MalformedPair(
          "A field pairs iterator must return an object from next",
        );
      return result as IteratorResult<unknown>;
    },
    return() {
      const close: unknown = Reflect.get(iterator, "return");
      return typeof close === "function"
        ? (Reflect.apply(close, iterator, []) as IteratorResult<unknown>)
        : { done: true, value: undefined };
    },
  };
};

/** Read one output. The record-only route leaves arrays and iterables unread during recovery. */
export function read(input: object): Reading;
export function read(input: object, mode: "record"): RecordFields | undefined;
export function read(input: object, mode?: "record"): Reading | undefined {
  if (Array.isArray(input)) {
    if (mode === "record") return undefined;
    const entries: Pair[] = [];
    const length = input.length;
    const extra = extraArrayField(input, length);
    if (extra !== undefined)
      throw new MalformedPair(
        `The field pairs list has an extra array field at ${textPath([extra])}`,
      );
    for (let index = 0; index < length; index++)
      entries.push(readPair(input[index], index));
    return { kind: "pairs", entries };
  }
  const iterator: unknown = Reflect.get(input, Symbol.iterator);
  if (typeof iterator === "function") {
    if (mode === "record") return undefined;
    const iterable = {
      [Symbol.iterator]: () =>
        checkedIterator(Reflect.apply(iterator, input, [])),
    };
    return { kind: "pairs", entries: Array.from(iterable, readPair) };
  }
  return readRecord(input, iterator);
}
