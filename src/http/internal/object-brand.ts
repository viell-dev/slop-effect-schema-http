/**
 * Recognize objects whose content is not in their own enumerable fields.
 *
 * @remarks
 * The standard tag (`Object.prototype.toString`) classifies most values without running anything
 * that can throw. It is only a hint: a prototype change removes the tag of a `BigInt` box, a
 * collection or a binary buffer, and `Symbol.toStringTag` can replace any tag. So an object
 * whose tag says nothing, and that has no fields of its own or carries a tag property, is checked
 * by brand. Node's `util.types` reads the brand directly. Elsewhere, `structuredClone` copies a
 * cloneable built-in with its brand, which a throwing brand test would otherwise find at several
 * times the cost; throwing tests remain for the few objects it cannot clone.
 */

const types = globalThis.process?.getBuiltinModule?.("node:util")?.types;
const tagOf = Object.prototype.toString;

/** A boxed primitive. JSON writes its primitive and ignores its fields. */
export type Box = "Number" | "String" | "Boolean" | "BigInt" | "Symbol";

const boxBrands: Readonly<Record<Box, (this: object) => unknown>> = {
  Number: Number.prototype.valueOf,
  String: String.prototype.valueOf,
  Boolean: Boolean.prototype.valueOf,
  BigInt: BigInt.prototype.valueOf,
  Symbol: Symbol.prototype.valueOf,
};

const isBoxName = (name: string): name is Box => Object.hasOwn(boxBrands, name);

const hasBrand = (read: (this: object) => unknown, value: object): boolean => {
  try {
    Reflect.apply(read, value, []);
    return true;
  } catch {
    return false;
  }
};

/** Built-ins and platform types whose state is internal, by their standard tag. */
const internalState = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "RegExp",
  "Error",
  "Date",
  "Promise",
  "URLSearchParams",
  "FormData",
  "Headers",
  "Blob",
  "File",
  "Map Iterator",
  "Set Iterator",
  "Array Iterator",
  "String Iterator",
  "RegExp String Iterator",
  "Iterator Helper",
  "Generator",
  "AsyncGenerator",
]);

const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag,
)!.get!;

/** The intrinsic view name, which no prototype change or tag property alters. */
const viewName = (value: ArrayBufferView): string =>
  (Reflect.apply(typedArrayName, value, []) as string | undefined) ??
  "DataView";

const blobSize =
  typeof Blob === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;

/** Whether a value is a platform `Blob`, including a `File`, from any realm. */
export const isBlob = (value: unknown): value is Blob =>
  typeof value === "object" &&
  value !== null &&
  blobSize !== undefined &&
  hasBrand(blobSize, value);

/** Whether a value is a `Uint8Array`, including a Node `Buffer` or one from another realm. */
export const isBytes = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) &&
  Reflect.apply(typedArrayName, value, []) === "Uint8Array";

function nodeBox(value: object): Box | undefined {
  if (!types!.isBoxedPrimitive(value)) return undefined;
  if (types!.isNumberObject(value)) return "Number";
  if (types!.isStringObject(value)) return "String";
  if (types!.isBooleanObject(value)) return "Boolean";
  if (types!.isBigIntObject(value)) return "BigInt";
  return "Symbol";
}

function nodeState(value: object): string | undefined {
  const node = types!;
  if (node.isMap(value)) return "Map";
  if (node.isSet(value)) return "Set";
  if (node.isWeakMap(value)) return "WeakMap";
  if (node.isWeakSet(value)) return "WeakSet";
  if (node.isAnyArrayBuffer(value)) return "ArrayBuffer";
  if (node.isRegExp(value)) return "RegExp";
  if (node.isNativeError(value)) return "Error";
  if (node.isDate(value)) return "Date";
  if (node.isPromise(value)) return "Promise";
  if (node.isMapIterator(value)) return "Map Iterator";
  if (node.isSetIterator(value)) return "Set Iterator";
  if (node.isGeneratorObject(value)) return "Generator";
  // A Node Blob carries a defined symbol field, so it never reaches this check without its tag.
  return undefined;
}

type Brand = readonly [string, (this: object) => unknown];

const hasMethod = (
  name: string,
  method: string,
  argument: unknown,
): Brand[] => {
  const constructor: unknown = Reflect.get(globalThis, name);
  const prototype: unknown =
    typeof constructor === "function" ? constructor.prototype : undefined;
  const read: unknown =
    typeof prototype === "object" && prototype !== null
      ? Reflect.get(prototype, method)
      : undefined;
  return typeof read === "function"
    ? [
        [
          name,
          function (this: object) {
            return Reflect.apply(read, this, [argument]) as unknown;
          },
        ],
      ]
    : [];
};

/** Brand tests for the objects `structuredClone` refuses. Each throws for any other object. */
const uncloneable: ReadonlyArray<Brand> = [
  ["Symbol", Symbol.prototype.valueOf],
  ...hasMethod("WeakMap", "has", {}),
  ...hasMethod("WeakSet", "has", {}),
  ...hasMethod("Headers", "has", "a"),
  ...hasMethod("URLSearchParams", "has", "a"),
  ...hasMethod("FormData", "has", "a"),
];

const boxes: ReadonlyArray<Brand> = Object.entries(boxBrands);

const brandOf = (
  value: object,
  brands: ReadonlyArray<Brand>,
): string | undefined =>
  brands.find(([, brand]) => hasBrand(brand, value))?.[0];

/** Classify a fieldless object without Node's brand helpers. */
function portableState(value: object): string | undefined {
  if (typeof structuredClone !== "function")
    return brandOf(value, [...boxes, ...uncloneable]);
  try {
    // A clone keeps the brand of a cloneable built-in, and a plain object clones as a plain one.
    const name = tagOf.call(structuredClone(value)).slice(8, -1);
    return name === "Object" ? undefined : name;
  } catch {
    // A symbol box, a weak collection, some platform objects and proxies cannot be cloned.
    return brandOf(value, uncloneable);
  }
}

/**
 * What an object holds outside its own enumerable fields.
 *
 * @param fieldless - The object has no own field a writer reads, so nothing but a brand test can
 * tell an ordinary empty object from a built-in whose tag was hidden.
 * @returns A box name, the kind of a value whose state is internal, or `undefined` for an object
 * whose content is its fields.
 */
export function stateOf(
  value: object,
  fieldless: boolean,
): Box | string | undefined {
  if (ArrayBuffer.isView(value)) return viewName(value);
  const tag = tagOf.call(value);
  if (tag !== "[object Object]") {
    const name = tag.slice(8, -1);
    if (internalState.has(name)) return name;
    if (
      isBoxName(name) &&
      (types === undefined
        ? hasBrand(boxBrands[name], value)
        : nodeBox(value) === name)
    )
      return name;
  }
  // Only a prototype change or a tag property hides the standard tag of a built-in. A changed
  // prototype also leaves a BigInt or symbol box with fields of its own looking ordinary.
  if (!fieldless && !(Symbol.toStringTag in value)) return undefined;
  if (types !== undefined) return nodeBox(value) ?? nodeState(value);
  if (fieldless) return portableState(value);
  // With fields of its own, only a box is checked: JSON then writes its primitive, not the fields.
  return brandOf(value, boxes);
}

/** Whether a kind from {@link stateOf} is a boxed primitive. */
export const isBox = (kind: string | undefined): kind is Box =>
  kind !== undefined && isBoxName(kind);
