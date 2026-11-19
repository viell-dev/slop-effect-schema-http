import { Effect } from "effect";
import { HttpBody } from "effect/http";
import { type Box, isBox, stateOf } from "./object-brand.js";
import {
  BodyWriteError,
  checkedBody,
  extraArrayField,
  type Path,
} from "./writer-error.js";

const { isRawJSON } = JSON as JSON & {
  isRawJSON?: (value: unknown) => boolean;
};

type Container = Record<string, unknown>;

/** A prototype with nothing on its chain, for copies when the standard prototypes offer `toJSON`. */
const bare = Object.create(null) as object;

const isIndex = (name: string) => String(Number(name) >>> 0) === name;

/**
 * How to make copies the final write treats as it treats the caller's own plain values.
 *
 * @remarks
 * Copies are ordinary objects and arrays where possible. Recent engines write those with an
 * iterative fast path that has no depth limit, and give it up for objects without the standard
 * prototype, so a prototype-free copy would fail at a depth the caller's own objects reach. A
 * standard prototype that offers `toJSON` would run it again on a copy, so copies then lose their
 * prototype. A field an assignment would not create, such as `__proto__`, or `toString` under a
 * frozen `Object.prototype`, is defined instead.
 */
function copies() {
  const defined = new Set<string>();
  let indexed = false;
  for (const prototype of [Object.prototype, Array.prototype])
    for (const name of Object.getOwnPropertyNames(prototype)) {
      indexed ||= isIndex(name);
      if (prototype !== Object.prototype) continue;
      const field = Object.getOwnPropertyDescriptor(prototype, name);
      if (
        field !== undefined &&
        (!("value" in field) || field.writable !== true)
      )
        defined.add(name);
    }
  return {
    bareObjects: "toJSON" in Object.prototype,
    bareArrays: "toJSON" in Array.prototype || indexed,
    defined,
  };
}

const isObject = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** JSON's conversion of a boxed number or string, with caller conversions left unguarded. */
function toPrimitive(value: object, hint: "number" | "string"): unknown {
  const exotic: unknown = Reflect.get(value, Symbol.toPrimitive);
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== "function") return value;
    const result: unknown = Reflect.apply(exotic, value, [hint]);
    return isObject(result) ? value : result;
  }
  for (const name of hint === "string"
    ? ["toString", "valueOf"]
    : ["valueOf", "toString"]) {
    const method: unknown = Reflect.get(value, name);
    if (typeof method !== "function") continue;
    const result: unknown = Reflect.apply(method, value, []);
    if (!isObject(result)) return result;
  }
  return value;
}

/** Whether an own symbol field supplies a value: enumerable, and not `undefined` when read. */
const supplies = (source: object, field: symbol): boolean =>
  Object.prototype.propertyIsEnumerable.call(source, field) &&
  Reflect.get(source, field) !== undefined;

/** The array length JSON reads, as `ToLength` gives it. */
function lengthOf(array: ReadonlyArray<unknown>): number {
  const length = Math.trunc(Number(array.length));
  return Number.isNaN(length) || length < 0 ? 0 : length;
}

/** Positions of a string box are its characters, not fields JSON would drop. */
const isStringPosition = (key: string, length: number) => {
  const position = Number(key);
  return (
    Number.isInteger(position) &&
    position >= 0 &&
    position < length &&
    String(position) === key
  );
};

/** An open container: the value being read, its copy, and the next field or position to fill. */
class Frame {
  next = 0;
  constructor(
    readonly source: object,
    readonly target: unknown[] | Container,
    readonly fields: ReadonlyArray<string> | undefined,
    readonly end: number,
    readonly name: string | number,
    readonly parent: Frame | undefined,
    readonly depth: number,
  ) {}
}

/**
 * Read a value the way native JSON does, once, and copy what it would write.
 *
 * @remarks
 * Every getter, proxy trap and `toJSON` runs here, in the native order: a field's value is read
 * and written before the next field is read. The copy holds only primitives and plain data
 * objects and arrays, as {@link copies} makes them, so the native writer that serializes it runs
 * no caller code and reaches the depth it reaches for the caller's own plain values. The traversal
 * keeps its own stack, so it adds no depth limit, an exception thrown while it runs came from
 * caller code, and an exception from the native writer is the engine's.
 */
function snapshot(input: unknown): unknown {
  let top: Frame | undefined;
  let active: Set<object> | undefined;
  const { bareObjects, bareArrays, defined } = copies();

  const refuse = (
    key: string | number,
    explanation: string,
    field?: PropertyKey,
  ): never => {
    const path: PropertyKey[] = field === undefined ? [] : [field];
    if (top !== undefined) path.unshift(key);
    for (let frame = top; frame?.parent !== undefined; frame = frame.parent)
      path.unshift(frame.name);
    throw new BodyWriteError("JSON", path as Path, explanation);
  };

  const open = (
    source: object,
    target: unknown[] | Container,
    fields: ReadonlyArray<string> | undefined,
    end: number,
    key: string | number,
  ) => {
    const depth = top === undefined ? 0 : top.depth + 1;
    if (active !== undefined) {
      if (active.has(source))
        return refuse(key, "contains a circular reference");
    } else {
      for (let frame = top; frame !== undefined; frame = frame.parent)
        if (frame.source === source)
          return refuse(key, "contains a circular reference");
      // Deep values switch from a scan of the open containers to a set.
      if (depth >= 32) {
        active = new Set();
        for (let frame = top; frame !== undefined; frame = frame.parent)
          active.add(frame.source);
      }
    }
    active?.add(source);
    top = new Frame(source, target, fields, end, key, top, depth);
    return target;
  };

  const object = (source: object, key: string | number): unknown => {
    if (Array.isArray(source)) {
      const length = lengthOf(source);
      if (length > 0xffffffff)
        return refuse(key, "has a length no array can hold");
      const extra = extraArrayField(source, length);
      if (extra !== undefined)
        return refuse(key, "cannot encode an extra array field", extra);
      const target: unknown[] = [];
      if (bareArrays) Object.setPrototypeOf(target, null);
      return open(source, target, undefined, length, key);
    }
    const fields = Object.keys(source);
    // A raw JSON value is a frozen object whose one field is its text.
    if (fields.length === 1 && fields[0] === "rawJSON" && isRawJSON?.(source))
      return source;
    const symbols = Object.getOwnPropertySymbols(source);
    // Classify before reading any symbol field, so each one is read at most once.
    const state = stateOf(source, fields.length === 0 && symbols.length === 0);
    if (state !== undefined && !isBox(state))
      return refuse(key, "cannot encode " + state);
    if (state !== undefined) return unbox(source, state, fields, symbols, key);
    const symbol = symbols.find((field) => supplies(source, field));
    if (symbol !== undefined)
      return refuse(key, "cannot encode a symbol field name", symbol);
    const target = (bareObjects ? Object.create(bare) : {}) as Container;
    return open(source, target, fields, fields.length, key);
  };

  const unbox = (
    source: object,
    box: Box,
    fields: ReadonlyArray<string>,
    symbols: ReadonlyArray<symbol>,
    key: string | number,
  ): unknown => {
    if (box === "BigInt") return refuse(key, "cannot encode a bigint");
    if (box === "Symbol") return refuse(key, "cannot encode a boxed symbol");
    const kind = "a boxed " + box.toLowerCase();
    const extra =
      fields.find(
        (field) =>
          box !== "String" ||
          !isStringPosition(field, (source as { length: number }).length),
      ) ??
      // The conversion of a boxed number or string reads its own `Symbol.toPrimitive`.
      symbols.find(
        (field) =>
          (box === "Boolean" || field !== Symbol.toPrimitive) &&
          supplies(source, field),
      );
    if (extra !== undefined)
      return refuse(key, `cannot encode a field of ${kind}`, extra);
    if (box === "Boolean") return Boolean.prototype.valueOf.call(source);
    const primitive = toPrimitive(
      source,
      box === "String" ? "string" : "number",
    );
    if (isObject(primitive) || typeof primitive === "symbol")
      return refuse(key, "cannot convert " + kind);
    if (box === "String") return String(primitive);
    if (typeof primitive === "bigint")
      return refuse(key, "cannot convert " + kind);
    const number = Number(primitive);
    return Number.isFinite(number)
      ? number
      : refuse(key, "must be a finite number");
  };

  const read = (value: unknown, key: string | number, inArray: boolean) => {
    if (isObject(value) || typeof value === "bigint") {
      const toJSON: unknown =
        typeof value === "bigint"
          ? Reflect.get(Object(value), "toJSON", value)
          : (value as { readonly toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function")
        value = Reflect.apply(toJSON, value, [String(key)]);
    }
    switch (typeof value) {
      case "string":
      case "boolean":
        return value;
      case "number":
        return Number.isFinite(value)
          ? value
          : refuse(key, "must be a finite number");
      case "undefined":
        return inArray
          ? refuse(key, "cannot encode undefined in an array")
          : undefined;
      case "object":
        return value === null ? null : object(value, key);
      default:
        return refuse(key, "cannot encode a " + typeof value);
    }
  };

  const output = read(input, "", false);
  while (top !== undefined) {
    const frame = top;
    const index = frame.next;
    if (index === frame.end) {
      active?.delete(frame.source);
      top = frame.parent;
      continue;
    }
    frame.next = index + 1;
    const source = frame.source as Record<PropertyKey, unknown>;
    const fields = frame.fields;
    if (fields === undefined) {
      (frame.target as unknown[])[index] = read(source[index], index, true);
    } else {
      const field = fields[index]!;
      const value = read(source[field], field, false);
      if (value === undefined) continue;
      if (bareObjects || !defined.has(field))
        (frame.target as Container)[field] = value;
      else
        Object.defineProperty(frame.target, field, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
  }
  return output;
}

/** The JSON writer shared by `Body.json`, composed JSON encoders and `Body.jsonSchema`. */
export const encode = (value: unknown) =>
  Effect.flatMap(
    checkedBody(() => snapshot(value)),
    (output) =>
      // Caller code ran in the snapshot. A throw here comes from the engine, such as its depth limit.
      Effect.try({
        try: () =>
          HttpBody.text(JSON.stringify(output) ?? "", "application/json"),
        catch: (cause) => {
          const error = new HttpBody.HttpBodyError({
            reason: { _tag: "JsonError" },
            cause,
          });
          error.message =
            "JSON body could not be written: " +
            (cause instanceof Error ? cause.message : String(cause));
          return error;
        },
      }),
  );
