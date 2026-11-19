import { Effect } from "effect";
import { HttpBody } from "effect/http";

const validationErrors = new WeakSet<object>();

class InvalidJson extends TypeError {
  constructor(message: string) {
    super(message);
    validationErrors.add(this);
  }
  static is(error: unknown): error is InvalidJson {
    return (
      typeof error === "object" && error !== null && validationErrors.has(error)
    );
  }
}

const numberValue = Number.prototype.valueOf;
const bigintValue = BigInt.prototype.valueOf;
// Node supplies non-observable brand tests. The fallback also works without Node globals.
const boxed = globalThis.process?.getBuiltinModule?.("node:util")?.types;

// Intrinsic valueOf reads the native brand even on reparented or cross-realm boxes.
const hasBrand = (
  value: object,
  read: (this: object) => number | bigint,
): boolean => {
  try {
    read.call(value);
    return true;
  } catch {
    return false;
  }
};

function segment(array: boolean | undefined, key: string | symbol): string {
  return typeof key === "symbol"
    ? "[" + String(key) + "]"
    : "[" + (array ? key : JSON.stringify(key)) + "]";
}

const stringify = (input: unknown): string | undefined => {
  const parents: object[] = [];
  const names: string[] = [];
  const arrays: boolean[] = [];
  let deep: WeakSet<object> | undefined;

  function unwind(holder: object) {
    while (parents.length > 0 && parents[parents.length - 1] !== holder) {
      const parent = parents.pop()!;
      deep?.delete(parent);
    }
  }

  function refuse(position: string | symbol, reason: string): never {
    let path = "$";
    for (let index = 1; index < parents.length; index++)
      path += segment(arrays[index - 1], names[index]!);
    if (parents.length > 0)
      path += segment(arrays[parents.length - 1], position);
    throw new InvalidJson("JSON body at " + path + " " + reason);
  }

  function checkSymbols(value: object) {
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (
        Object.prototype.propertyIsEnumerable.call(value, key) &&
        Reflect.get(value, key) !== undefined
      )
        refuse(key, "cannot encode a symbol field name");
    }
  }

  // The native traversal reads each position and applies toJSON before calling the replacer.
  return JSON.stringify(input, function (this: object, key, value: unknown) {
    if (value === null) return value;
    switch (typeof value) {
      case "string":
      case "boolean":
        return value;
      case "number":
        if (Number.isFinite(value)) return value;
        unwind(this);
        return refuse(key, "must be a finite number");
      case "undefined":
        unwind(this);
        if (parents.length === 0 || !arrays[parents.length - 1]) return value;
        return refuse(key, "cannot encode undefined in an array");
      case "object": {
        unwind(this);
        const array = Array.isArray(value);
        const maybeBox =
          !array && (boxed === undefined || boxed.isBoxedPrimitive(value));
        if (
          maybeBox &&
          (boxed?.isBigIntObject(value) ?? hasBrand(value, bigintValue))
        )
          return refuse(key, "cannot encode a bigint");
        const unboxNumber =
          maybeBox &&
          (boxed?.isNumberObject(value) ?? hasBrand(value, numberValue));
        if (deep?.has(value) ?? parents.includes(value))
          return refuse(key, "contains a circular reference");
        if (parents.length === 32 && deep === undefined)
          deep = new WeakSet(parents);
        if (deep !== undefined) deep.add(value);
        names[parents.length] = key;
        arrays[parents.length] = array;
        parents.push(value);
        checkSymbols(value);
        if (!unboxNumber) return value;
        // Match JSON's ToNumber, including any caller-defined conversion.
        const number = +(value as unknown as number);
        if (Number.isFinite(number)) return number;
        unwind(this);
        return refuse(key, "must be a finite number");
      }
      default:
        unwind(this);
        return refuse(key, "cannot encode a " + typeof value);
    }
  });
};
export const encode = (value: unknown) =>
  Effect.try({
    try: () => HttpBody.text(stringify(value) ?? "", "application/json"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      if (!InvalidJson.is(cause)) return Effect.die(cause);
      const error = new HttpBody.HttpBodyError({
        reason: { _tag: "JsonError" },
        cause,
      });
      error.message = cause.message;
      return Effect.fail(error);
    }),
  );
