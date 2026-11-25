import type { SchemaAST } from "effect";

/**
 * Where preparation can establish what a caller gave, so a reading and a relaxed write account for
 * it. Elsewhere a value reads and writes as Effect reads and writes it.
 *
 * @remarks
 * Plain data is a list whose prototype is `Array.prototype` or `null`, or an object whose prototype
 * is `Object.prototype` or `null`, holding only own data properties, none named after an
 * `Object.prototype` member. Symbol keys, keys that are not enumerable, frozen objects and a list's
 * own named properties are all plain data. A proxy cannot be told from its target, so one over plain
 * data is plain data too, and its traps run. A value held behind an accessor, a class instance, and a
 * name every object has are facts that Effect 4.0.7 and 4.1.4 read differently, and that preparation
 * would otherwise have to guess.
 */

/** The names every object has: `Object.prototype`'s members, and `__proto__`. */
const prototypeNames = new Set<PropertyKey>(
  Reflect.ownKeys(Object.prototype),
).add("__proto__");

const isPrototypeName = (key: PropertyKey): boolean =>
  prototypeNames.has(typeof key === "number" ? String(key) : key);

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

/** A list, or an object of no class, whose own properties are all data and none every object has. */
const isPlainHere = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  const list = Array.isArray(value);
  if (
    list
      ? prototype !== Array.prototype && prototype !== null
      : prototype !== Object.prototype && prototype !== null
  )
    return false;
  for (const key of Reflect.ownKeys(value)) {
    if (list && key === "length") continue;
    if (isPrototypeName(key)) return false;
    if (!("value" in Object.getOwnPropertyDescriptor(value, key)!))
      return false;
  }
  return true;
};

/** Whether a value is plain data here, not counting what it holds. A primitive is. */
export const isPlainData = (value: unknown): boolean =>
  !isObject(value) || isPlainHere(value);

const stated = new WeakMap<SchemaAST.AST, boolean>();

/**
 * Whether a schema states a field or a wire name named after an `Object.prototype` member where it
 * reads a value. That takes in a union's members, a suspended schema and every step of an encoding,
 * which all read the same value.
 */
export const statesPrototypeName = (ast: SchemaAST.AST): boolean => {
  const known = stated.get(ast);
  if (known !== undefined) return known;
  // Only the answer for `ast` is kept: inside a recursive schema a node's answer depends on where
  // the walk entered it. A schema met again states nothing new.
  const seen = new Set<SchemaAST.AST>();
  const visit = (node: SchemaAST.AST): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.encoding?.some(({ to }) => visit(to)) === true) return true;
    switch (node._tag) {
      case "Objects":
        return node.propertySignatures.some(({ name }) =>
          isPrototypeName(name),
        );
      case "Union":
        return node.types.some(visit);
      case "Suspend":
        return visit(node.thunk());
      default:
        return false;
    }
  };
  const found = visit(ast);
  stated.set(ast, found);
  return found;
};
